import { afterAll, describe, expect, test } from "bun:test";
import { OWNERSHIP_STATE_SCHEMA_VERSION } from "../schemas/ownership-state.js";
import { execFileSync } from "node:child_process";
import {

  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterProjectPlan } from "../adapters/project-plan.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import { hasTrackedGitDescendants } from "../installer/git.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  buildDesiredState,
  hashBytes,
  normalizeAdapterPlans,
  type DesiredInstallation,
  type DesiredProjectOutput,
} from "../installer/project-plan.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import {
  proveOwnedInstallation,
  readInstallationState,
  stageProvenInstallationRemoval,
  writeInstallationState,
} from "../installer/installation-state.js";
import {
  reportBlockers,
  reportItems,
  reportOutputs,
} from "./support/reconciliation-report.js";
import { blockerWording } from "../cli/blocker-wording.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    try {
      // Mode 0000 trees are not traversable by chmod -R until parents gain +x.
      execFileSync("chmod", ["-R", "u+rwx", directory]);
    } catch {
      try {
        execFileSync("find", [directory, "-exec", "chmod", "u+rwx", "{}", "+"]);
      } catch {
        // Best-effort: restrictive fixtures must still be removable when possible.
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function skillDirectoryPlan(
  host: SupportedHost = "codex",
  overrides: {
    readonly bytes?: string;
    readonly path?: string;
  } = {},
): AdapterProjectPlan {
  const skillBytes = overrides.bytes ?? "# Demo Skill\n";
  return {
    host,
    hostVersion: `${host}-v1`,
    outputs: [
      {
        members: [
          {
            bytes: skillBytes,
            mode: 0o644,
            path: "SKILL.md",
            type: "file",
          },
          {
            mode: 0o755,
            path: "scripts",
            type: "directory",
          },
          {
            bytes: "#!/bin/sh\necho demo\n",
            mode: 0o755,
            path: "scripts/run.sh",
            type: "file",
          },
        ],
        mode: 0o755,
        origins: [],
        path: overrides.path ?? ".agents/skills/demo-skill",
        requirements: ["Host discovers Skill package"],
        type: "directory",
      },
    ],
    setupSteps: [],
  };
}

async function contextInstallation(
  home: string,
  project: string,
): Promise<DesiredInstallation> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nDirectory ownership context.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext: [team-rules]\nskills: []\n",
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
  );
  const desired = await buildDesiredState(home, { checkHostCapability: false });
  const installation = desired.installations[0];
  if (!installation) throw new Error("expected one desired installation");
  return installation;
}

function withDirectoryOutput(
  installation: DesiredInstallation,
  directory: DesiredProjectOutput,
): DesiredInstallation {
  return {
    ...installation,
    outputs: [...installation.outputs, directory].sort((left, right) =>
      left.path.localeCompare(right.path)
    ),
  };
}

function normalizedDirectory(): DesiredProjectOutput {
  const output = normalizeAdapterPlans([skillDirectoryPlan()])[0];
  if (!output || output.type !== "directory") throw new Error("expected directory output");
  return output;
}

describe("Installer-owned artifact-directory outputs", () => {
  test("apply creates an artifact directory transactionally and records ownership hashes", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    const desired = [withDirectoryOutput(base, directory)];

    const report = await applyReconciliation(home, desired);

    expect(reportItems(report.receipt)).toContainEqual({ kind: "addition", project });
    expect(reportOutputs(report.receipt)).toContainEqual({
      kind: "addition",
      path: directory.path,
      project,
    });
    expect(readFileSync(join(project, directory.path, "SKILL.md"), "utf8")).toBe("# Demo Skill\n");
    expect(statSync(join(project, directory.path, "scripts", "run.sh")).mode & 0o777).toBe(0o755);
    const state = await readInstallationState(home);
    const owned = state.receipts[0]?.outputs.find((output) => output.path === directory.path);
    expect(owned).toMatchObject({
      hash: directory.hash,
      mode: 0o755,
      type: "directory",
    });
    if (owned?.type !== "directory" || directory.type !== "directory") {
      throw new Error("expected directory ownership");
    }
    expect(owned).not.toHaveProperty("members");
  });

  test("directory ownership proof uses the aggregate root hash instead of the legacy member tree", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-root-proof-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-root-proof-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    const desired = [withDirectoryOutput(base, directory)];
    await applyReconciliation(home, desired);

    const state = await readInstallationState(home);
    const installation = state.receipts[0]!;
    await writeInstallationState(home, {
      ...state,
      receipts: [{
        ...installation,
        outputs: installation.outputs.map((output) =>
          output.type === "directory" ? { ...output, members: [] } : output
        ),
      }],
    });

    const report = await previewReconciliation(desired, await readInstallationState(home));

    expect(reportBlockers(report)).toEqual([]);
    expect(reportOutputs(report)).toContainEqual({ kind: "unchanged", path: directory.path, project });
    expect(reportOutputs(report)).not.toContainEqual({ kind: "update", path: directory.path, project });
  });

  test("apply drops a wholly absent recorded directory that current Workspace state no longer desires", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-absent-removal-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-absent-removal-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    await applyReconciliation(home, [withDirectoryOutput(base, directory)]);
    rmSync(join(project, directory.path), { recursive: true });

    const preview = await previewReconciliation([base], await readInstallationState(home));
    expect(reportItems(preview)).toContainEqual({
      kind: "update",
      project,
      reason: "desired output changed",
    });
    expect(reportOutputs(preview)).toContainEqual({ kind: "removal", path: directory.path, project });

    await applyReconciliation(home, [base]);
    expect(existsSync(join(project, directory.path))).toBe(false);
    expect((await readInstallationState(home)).receipts[0]?.outputs.some(
      (output) => output.path === directory.path,
    )).toBe(false);
  });

  test("preview distinguishes directory additions, updates, unchanged, and member drift", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-preview-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-preview-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    const desired = [withDirectoryOutput(base, directory)];
    await applyReconciliation(home, desired);

    const current = await previewReconciliation(desired, await readInstallationState(home));
    expect(reportOutputs(current)).toContainEqual({
      kind: "unchanged",
      path: directory.path,
      project,
    });

    writeFileSync(join(project, directory.path, "SKILL.md"), "# Drifted\n");
    mkdirSync(join(project, directory.path, "extra"), { recursive: true });
    writeFileSync(join(project, directory.path, "extra", "note.txt"), "unexpected\n");
    rmSync(join(project, directory.path, "scripts", "run.sh"));

    const drifted = await previewReconciliation(desired, await readInstallationState(home));
    expect(reportOutputs(drifted).filter((item) => item.path === directory.path)).toEqual([{
      kind: "update",
      path: directory.path,
      project,
    }]);
    expect(reportOutputs(drifted).every((item) => !item.path.startsWith(`${directory.path}/`))).toBe(true);
    expect(reportBlockers(drifted)).toEqual([]);
    expect(reportItems(drifted)).toContainEqual({
      kind: "drifted output",
      project,
      reason: directory.path,
    });

    const updatedDirectory = normalizeAdapterPlans([
      skillDirectoryPlan("codex", { bytes: "# Updated Skill\n" }),
    ])[0]!;
    const updatedDesired = [withDirectoryOutput(base, updatedDirectory)];

    const updatePreview = await previewReconciliation(updatedDesired, await readInstallationState(home));
    expect(reportOutputs(updatePreview)).toContainEqual({
      kind: "update",
      path: directory.path,
      project,
    });
  });

  test("identity-proven roots refresh supported member differences and still block unsupported entries", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-root-boundaries-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-root-boundaries-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    const desired = [withDirectoryOutput(base, directory)];
    await applyReconciliation(home, desired);

    async function expectRefreshDrift(): Promise<void> {
      const report = await previewReconciliation(desired, await readInstallationState(home));
      expect(reportOutputs(report).filter((output) => output.kind === "update")).toEqual([{
        kind: "update",
        path: directory.path,
        project,
      }]);
      expect(reportBlockers(report)).toEqual([]);
    }

    const skillPath = join(project, directory.path, "SKILL.md");
    rmSync(skillPath);
    mkdirSync(skillPath);
    await expectRefreshDrift();
    rmSync(skillPath, { recursive: true });
    writeFileSync(skillPath, "# Demo Skill\n");

    const emptyPath = join(project, directory.path, "empty");
    mkdirSync(emptyPath);
    await expectRefreshDrift();
    rmSync(emptyPath, { recursive: true });

    const scriptPath = join(project, directory.path, "scripts", "run.sh");
    rmSync(scriptPath);
    symlinkSync("../SKILL.md", scriptPath);
    const unsupported = await previewReconciliation(desired, await readInstallationState(home));
    expect(reportBlockers(unsupported).some((blocker) =>
      blockerWording(blocker).message.includes("unsupported entry") && blockerWording(blocker).message.includes(directory.path)
    )).toBe(true);
    rmSync(scriptPath);
    writeFileSync(scriptPath, "#!/bin/sh\necho demo\n");
    chmodSync(scriptPath, 0o755);

    chmodSync(join(project, directory.path), 0o700);
    await expectRefreshDrift();
    chmodSync(join(project, directory.path), 0o755);
  });

  test("preflight rejects an occupied unowned artifact directory without adopting it", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-unowned-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-unowned-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    mkdirSync(join(project, directory.path), { recursive: true });
    writeFileSync(join(project, directory.path, "SKILL.md"), "foreign\n");

    const report = await previewReconciliation(
      [withDirectoryOutput(base, directory)],
      { receipts: [], removedTemporaryInstallationIds: [], schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION },
    );
    expect(reportBlockers(report).some((blocker) =>
      blockerWording(blocker).message.includes("occupied unowned artifact directory")
    )).toBe(true);
    expect(readFileSync(join(project, directory.path, "SKILL.md"), "utf8")).toBe("foreign\n");
  });

  test("preflight keeps an owned directory-to-file output transition blocked", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-type-change-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-type-change-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    await applyReconciliation(home, [withDirectoryOutput(base, directory)]);
    const bytes = "replacement file\n";
    const changed: DesiredInstallation = {
      ...base,
      outputs: withDirectoryOutput(base, directory).outputs.map((output) =>
        output.path === directory.path
          ? {
              bytes,
              consumingHosts: ["codex"],
              hash: hashBytes(bytes),
              mode: 0o644,
              origins: [],
              path: directory.path,
              requirements: ["Host reads replacement file"],
              type: "file" as const,
            }
          : output
      ),
    };

    const report = await previewReconciliation([changed], await readInstallationState(home));

    expect(reportBlockers(report)).toHaveLength(1);
    expect(blockerWording(reportBlockers(report)[0]!).message).toContain(
      `${directory.path} is an occupied directory path`,
    );
  });

  test("preflight rejects an unsafe parent for an artifact directory without writing", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-parent-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-parent-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizeAdapterPlans([
      skillDirectoryPlan("codex", { path: ".agents/skills/demo-skill" }),
    ])[0]!;
    writeFileSync(join(project, ".agents"), "not-a-directory\n");

    const report = await previewReconciliation(
      [withDirectoryOutput(base, directory)],
      { receipts: [], removedTemporaryInstallationIds: [], schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION },
    );
    expect(reportBlockers(report).some((blocker) =>
      blockerWording(blocker).message.includes("occupied") && blockerWording(blocker).message.includes("parent path")
    )).toBe(true);
    expect(existsSync(join(project, directory.path))).toBe(false);
  });

  test("preview reports member mode drift at the generated root as non-blocking refresh work", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-mode-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-mode-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    await applyReconciliation(home, [withDirectoryOutput(base, directory)]);
    chmodSync(join(project, directory.path, "SKILL.md"), 0o600);

    const report = await previewReconciliation(
      [withDirectoryOutput(base, directory)],
      await readInstallationState(home),
    );
    expect(reportOutputs(report)).toContainEqual({
      kind: "update",
      path: directory.path,
      project,
    });
    expect(reportBlockers(report)).toEqual([]);
  });

  test("preview reports combined member drift once at the generated root", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-combined-drift-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-combined-drift-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    await applyReconciliation(home, [withDirectoryOutput(base, directory)]);
    const memberPath = `${directory.path}/SKILL.md`;
    writeFileSync(join(project, memberPath), "# Drifted\n");
    chmodSync(join(project, memberPath), 0o600);

    const report = await previewReconciliation(
      [withDirectoryOutput(base, directory)],
      await readInstallationState(home),
    );

    expect(reportOutputs(report).filter((output) =>
      output.kind === "update" && output.path === directory.path
    )).toHaveLength(1);
  });

  test("a host scratch directory under an installed Skill root is non-blocking drift that apply restores", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-scratch-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-scratch-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    const desired = [withDirectoryOutput(base, directory)];
    await applyReconciliation(home, desired);

    // Claude Code atomic-write scratch left inside the installed Skill root.
    mkdirSync(join(project, directory.path, ".cc-writes"), { mode: 0o700 });

    const preview = await previewReconciliation(desired, await readInstallationState(home));
    expect(reportBlockers(preview)).toEqual([]);
    expect(reportOutputs(preview)).toContainEqual({
      kind: "update",
      path: directory.path,
      project,
    });

    const applied = await applyReconciliation(home, desired);
    expect(reportBlockers(applied.resultingState)).toEqual([]);
    expect(reportOutputs(applied.resultingState)).toContainEqual({
      kind: "unchanged",
      path: directory.path,
      project,
    });
    expect(existsSync(join(project, directory.path, ".cc-writes"))).toBe(false);
    expect(readFileSync(join(project, directory.path, "SKILL.md"), "utf8")).toBe("# Demo Skill\n");
  });

  test("a recorded root that becomes a symlink stays blocking and is never followed", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-symlink-root-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-symlink-root-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    await applyReconciliation(home, [withDirectoryOutput(base, directory)]);
    const root = join(project, directory.path);
    const external = temporaryDirectory("agent-profile-kit-dir-symlink-root-external-");
    writeFileSync(join(external, "SKILL.md"), "external\n");
    rmSync(root, { recursive: true });
    symlinkSync(external, root);

    const report = await previewReconciliation(
      [withDirectoryOutput(base, directory)],
      await readInstallationState(home),
    );
    expect(reportBlockers(report).some((blocker) =>
      blocker.kind === "installation-ownership" &&
      blockerWording(blocker).message.includes(directory.path)
    )).toBe(true);
    expect(readFileSync(join(external, "SKILL.md"), "utf8")).toBe("external\n");
  });

  test("apply rolls back a mid-directory publication failure", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-rollback-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-rollback-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    const desired = [withDirectoryOutput(base, directory)];
    await applyReconciliation(home, desired);

    const updatedDirectory = normalizeAdapterPlans([
      skillDirectoryPlan("codex", { bytes: "# Replacement\n" }),
    ])[0]!;
    const updated = [withDirectoryOutput(base, updatedDirectory)];
    const destination = join(project, directory.path);
    const priorSkill = readFileSync(join(destination, "SKILL.md"), "utf8");
    let injected = false;

    await expect(applyReconciliation(home, updated, {
      fileSystem: {
        rename: async (oldPath, newPath) => {
          const source = oldPath.toString();
          const target = newPath.toString();
          if (
            !injected &&
            source.includes(".agent-profile-kit-stage-") &&
            !source.includes(".backup") &&
            (target === destination || target.endsWith(`/${directory.path}`))
          ) {
            injected = true;
            throw new Error("injected directory publication failure");
          }
          await rename(oldPath, newPath);
        },
      },
    })).rejects.toThrow("injected directory publication failure");

    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe(priorSkill);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("proven removal deletes a drifted owned artifact directory without a manual pre-clean", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-remove-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-remove-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    await applyReconciliation(home, [withDirectoryOutput(base, directory)]);
    const state = await readInstallationState(home);
    const installation = state.receipts[0]!;

    writeFileSync(join(project, directory.path, "SKILL.md"), "# Drifted for removal\n");
    const driftedProof = await proveOwnedInstallation(installation);
    expect(driftedProof.owned).toBe(true);
    const removal = await stageProvenInstallationRemoval(installation);
    await removal.commit();
    expect(existsSync(join(project, directory.path))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);

    await writeInstallationState(home, { receipts: [], removedTemporaryInstallationIds: [], schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION });
  });

  test("existing Context-only Codex lifecycle still applies without directory outputs", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-context-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-context-project-");
    const installation = await contextInstallation(home, project);
    const report = await applyReconciliation(home, [installation]);
    expect(reportItems(report.receipt)).toContainEqual({ kind: "addition", project });
    expect(readFileSync(join(project, ".agent-profile-kit", "codex", "context.md"), "utf8"))
      .toContain("Directory ownership context.");
    const state = await readInstallationState(home);
    expect(state.receipts[0]!.outputs.every((output) => output.type === "file")).toBe(true);
  });

  test("apply stages read-only directory roots and nested directories successfully", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-readonly-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-readonly-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizeAdapterPlans([{
      host: "codex",
      hostVersion: "codex-v1",
      outputs: [{
        members: [
          {
            bytes: "# Read-only skill\n",
            mode: 0o644,
            path: "SKILL.md",
            type: "file",
          },
          {
            mode: 0o555,
            path: "scripts",
            type: "directory",
          },
          {
            bytes: "#!/bin/sh\necho demo\n",
            mode: 0o755,
            path: "scripts/run.sh",
            type: "file",
          },
        ],
        mode: 0o555,
        origins: [],
        path: ".agents/skills/readonly-skill",
        requirements: ["Host discovers Skill package"],
        type: "directory",
      }],
      setupSteps: [],
    }])[0]!;

    await applyReconciliation(home, [withDirectoryOutput(base, directory)]);

    expect(statSync(join(project, directory.path)).mode & 0o777).toBe(0o555);
    expect(statSync(join(project, directory.path, "scripts")).mode & 0o777).toBe(0o555);
    expect(readFileSync(join(project, directory.path, "SKILL.md"), "utf8")).toBe("# Read-only skill\n");
    expect(readFileSync(join(project, directory.path, "scripts", "run.sh"), "utf8"))
      .toBe("#!/bin/sh\necho demo\n");
  });

  test("preflight rejects tracked descendants under an artifact-directory destination", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-tracked-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-tracked-project-");
    execFileSync("git", ["init", "-q", project]);
    mkdirSync(join(project, ".agents", "skills", "demo-skill"), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", "demo-skill", "SKILL.md"), "tracked\n");
    execFileSync("git", ["-C", project, "add", ".agents/skills/demo-skill/SKILL.md"]);
    rmSync(join(project, ".agents"), { recursive: true, force: true });
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();

    const report = await previewReconciliation(
      [withDirectoryOutput(base, directory)],
      { receipts: [], removedTemporaryInstallationIds: [], schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION },
    );
    expect(reportBlockers(report).some((blocker) =>
      blockerWording(blocker).message.includes("tracked project path")
    )).toBe(true);
    expect(existsSync(join(project, directory.path))).toBe(false);
  });

  test("machine-state write failure rolls back a restrictive-mode artifact directory", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-state-fail-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-state-fail-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizeAdapterPlans([{
      host: "codex",
      hostVersion: "codex-v1",
      outputs: [{
        members: [
          {
            bytes: "# Restrictive skill\n",
            mode: 0o644,
            path: "SKILL.md",
            type: "file",
          },
          {
            mode: 0o000,
            path: "scripts",
            type: "directory",
          },
          {
            bytes: "#!/bin/sh\necho demo\n",
            mode: 0o000,
            path: "scripts/run.sh",
            type: "file",
          },
        ],
        mode: 0o000,
        origins: [],
        path: ".agents/skills/restrictive-skill",
        requirements: ["Host discovers Skill package"],
        type: "directory",
      }],
      setupSteps: [],
    }])[0]!;
    const stateDirectory = join(home, ".agents", "agent-profile-kit", "state");
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o555);

    await expect(applyReconciliation(home, [withDirectoryOutput(base, directory)]))
      .rejects.toThrow("completed projects");

    chmodSync(stateDirectory, 0o755);
    expect(existsSync(join(project, directory.path))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect((await readInstallationState(home)).receipts).toEqual([]);

    // Rerun converges once machine-local state is writable again.
    await expect(applyReconciliation(home, [withDirectoryOutput(base, directory)]))
      .resolves.toBeDefined();
    const state = await readInstallationState(home);
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]!.outputs.some((output) =>
      output.type === "directory" && output.path === directory.path && output.mode === 0o000
    )).toBe(true);
    // Mode 0000 roots are not searchable; restore owner access before content checks.
    chmodSync(join(project, directory.path), 0o755);
    chmodSync(join(project, directory.path, "scripts"), 0o755);
    expect(readFileSync(join(project, directory.path, "SKILL.md"), "utf8")).toBe("# Restrictive skill\n");
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("hasTrackedGitDescendants fails closed when Git inspection errors", async () => {
    const { realpathSync } = await import("node:fs");
    const project = realpathSync(temporaryDirectory("agent-profile-kit-dir-git-fail-"));
    execFileSync("git", ["init", "-q", project]);
    writeFileSync(join(project, "README.md"), "fixture\n");
    execFileSync("git", ["-C", project, "add", "README.md"]);
    execFileSync("git", ["-C", project, "commit", "-qm", "fixture"]);
    mkdirSync(join(project, "owned"), { recursive: true });
    writeFileSync(join(project, "owned", "member.txt"), "tracked\n");
    execFileSync("git", ["-C", project, "add", "owned/member.txt"]);

    const bin = temporaryDirectory("agent-profile-kit-dir-fake-git-");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif printf '%s' "$*" | grep -q 'ls-files'; then\n  echo "injected ls-files failure" >&2\n  exit 128\nfi\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      await expect(hasTrackedGitDescendants(project, "owned")).rejects.toThrow(
        "Cannot inspect tracked Git descendants under 'owned'",
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
