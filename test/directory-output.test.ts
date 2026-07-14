import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterProjectPlan } from "../adapters/project-plan.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  buildDesiredState,
  hashBytes,
  hashDirectoryMembers,
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
  formatInstallationManifest,
  parseInstallationManifest,
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function skillDirectoryPlan(
  host = "codex",
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
        path: overrides.path ?? ".agents/skills/demo-skill",
        requirements: ["Host discovers Skill package"],
        type: "directory",
      },
    ],
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
    "id: coding\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 1\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
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
  test("Installation Manifest records complete directory ownership and round-trips", () => {
    const directory = normalizedDirectory();
    if (directory.type !== "directory") throw new Error("expected directory");
    const manifest: ProjectInstallationManifest = {
      adapterVersion: "codex-project-v1",
      engineVersion: "0.0.0-test",
      hosts: ["codex"],
      hostVersions: { codex: "native-project-sessionstart-v1" },
      installationId: "11111111-1111-1111-1111-111111111111",
      outputs: [
        {
          hash: directory.hash,
          members: directory.members.map((member) =>
            member.type === "file"
              ? {
                  hash: member.hash,
                  mode: member.mode,
                  path: member.path,
                  type: "file" as const,
                }
              : {
                  mode: member.mode,
                  path: member.path,
                  type: "directory" as const,
                },
          ),
          mode: directory.mode,
          path: directory.path,
          type: "directory",
        },
        {
          hash: hashBytes('{"schema_version":1,"installation_id":"11111111-1111-1111-1111-111111111111"}\n'),
          mode: 0o644,
          path: ".agent-profile-kit/installation.json",
          type: "file",
        },
      ],
      profileId: "coding",
      project: "/tmp/project",
      resolvedArtifacts: [],
      schemaVersion: 2,
      selectedContext: ["team-rules"],
      workspaceInputHash: hashBytes("source"),
    };

    const parsed = parseInstallationManifest(formatInstallationManifest(manifest));
    expect(parsed.outputs.find((output) => output.type === "directory")).toEqual({
      hash: directory.hash,
      members: expect.arrayContaining([
        expect.objectContaining({ path: "SKILL.md", type: "file" }),
        expect.objectContaining({ path: "scripts", type: "directory" }),
        expect.objectContaining({ path: "scripts/run.sh", type: "file" }),
      ]),
      mode: 0o755,
      path: ".agents/skills/demo-skill",
      type: "directory",
    });
    expect(hashDirectoryMembers(directory.members)).toBe(directory.hash);
  });

  test("apply creates an artifact directory transactionally and records ownership hashes", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    const desired = [withDirectoryOutput(base, directory)];

    const report = await applyReconciliation(home, desired);

    expect(report.items).toContainEqual({ kind: "addition", project });
    expect(report.outputs).toContainEqual({
      kind: "addition",
      path: directory.path,
      project,
    });
    expect(readFileSync(join(project, directory.path, "SKILL.md"), "utf8")).toBe("# Demo Skill\n");
    expect(statSync(join(project, directory.path, "scripts", "run.sh")).mode & 0o777).toBe(0o755);
    const state = await readInstallationState(home);
    const owned = state.installations[0]?.outputs.find((output) => output.path === directory.path);
    expect(owned).toMatchObject({
      hash: directory.hash,
      mode: 0o755,
      type: "directory",
    });
    if (owned?.type !== "directory" || directory.type !== "directory") {
      throw new Error("expected directory ownership");
    }
    expect(owned.members).toHaveLength(directory.members.length);
  });

  test("preview distinguishes directory additions, updates, unchanged, and member drift", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-preview-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-preview-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    const desired = [withDirectoryOutput(base, directory)];
    await applyReconciliation(home, desired);

    const current = await previewReconciliation(desired, await readInstallationState(home));
    expect(current.outputs).toContainEqual({
      kind: "unchanged",
      path: directory.path,
      project,
    });

    writeFileSync(join(project, directory.path, "SKILL.md"), "# Drifted\n");
    mkdirSync(join(project, directory.path, "extra"), { recursive: true });
    writeFileSync(join(project, directory.path, "extra", "note.txt"), "unexpected\n");
    rmSync(join(project, directory.path, "scripts", "run.sh"));

    const drifted = await previewReconciliation(desired, await readInstallationState(home));
    expect(drifted.outputs).toContainEqual({
      kind: "drifted member",
      path: `${directory.path}/SKILL.md`,
      project,
    });
    expect(drifted.outputs).toContainEqual({
      kind: "missing member",
      path: `${directory.path}/scripts/run.sh`,
      project,
    });
    expect(drifted.outputs.some((item) =>
      item.kind === "unexpected member" && item.path.startsWith(`${directory.path}/extra`)
    )).toBe(true);
    expect(drifted.blockers.some((blocker) =>
      blocker.message.includes("owned output")
    )).toBe(true);

    const updatedDirectory = normalizeAdapterPlans([
      skillDirectoryPlan("codex", { bytes: "# Updated Skill\n" }),
    ])[0]!;
    const updatedDesired = [withDirectoryOutput(base, updatedDirectory)];
    // Restore owned content so update is not blocked by drift from this fixture.
    writeFileSync(join(project, directory.path, "SKILL.md"), "# Demo Skill\n");
    writeFileSync(join(project, directory.path, "scripts", "run.sh"), "#!/bin/sh\necho demo\n");
    chmodSync(join(project, directory.path, "scripts", "run.sh"), 0o755);
    rmSync(join(project, directory.path, "extra"), { recursive: true, force: true });

    const updatePreview = await previewReconciliation(updatedDesired, await readInstallationState(home));
    expect(updatePreview.outputs).toContainEqual({
      kind: "update",
      path: directory.path,
      project,
    });
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
      { installations: [], schemaVersion: 2 },
    );
    expect(report.blockers.some((blocker) =>
      blocker.message.includes("occupied unowned artifact directory")
    )).toBe(true);
    expect(readFileSync(join(project, directory.path, "SKILL.md"), "utf8")).toBe("foreign\n");
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
      { installations: [], schemaVersion: 2 },
    );
    expect(report.blockers.some((blocker) =>
      blocker.message.includes("occupied") && blocker.message.includes("parent path")
    )).toBe(true);
    expect(existsSync(join(project, directory.path))).toBe(false);
  });

  test("preview reports mode-only directory member drift", async () => {
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
    expect(report.outputs).toContainEqual({
      kind: "drifted member",
      path: `${directory.path}/SKILL.md`,
      project,
    });
    expect(report.blockers.some((blocker) =>
      blocker.message.includes("drifted mode") || blocker.message.includes("unowned or drifted")
    )).toBe(true);
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
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("proven removal deletes an owned artifact directory and blocks when drifted", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-remove-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-remove-project-");
    const base = await contextInstallation(home, project);
    const directory = normalizedDirectory();
    await applyReconciliation(home, [withDirectoryOutput(base, directory)]);
    const state = await readInstallationState(home);
    const installation = state.installations[0]!;

    writeFileSync(join(project, directory.path, "SKILL.md"), "# Drifted for removal\n");
    const driftedProof = await proveOwnedInstallation(installation);
    expect(driftedProof.owned).toBe(false);
    await expect(stageProvenInstallationRemoval(installation)).rejects.toThrow("owned output");

    writeFileSync(join(project, directory.path, "SKILL.md"), "# Demo Skill\n");
    const ownedProof = await proveOwnedInstallation(installation);
    expect(ownedProof.owned).toBe(true);
    const removal = await stageProvenInstallationRemoval(installation);
    await removal.commit();
    expect(existsSync(join(project, directory.path))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);

    await writeInstallationState(home, { installations: [], schemaVersion: 2 });
  });

  test("existing Context-only Codex lifecycle still applies without directory outputs", async () => {
    const home = temporaryDirectory("agent-profile-kit-dir-context-home-");
    const project = temporaryDirectory("agent-profile-kit-dir-context-project-");
    const installation = await contextInstallation(home, project);
    const report = await applyReconciliation(home, [installation]);
    expect(report.items).toContainEqual({ kind: "addition", project });
    expect(readFileSync(join(project, ".agent-profile-kit", "codex", "context.md"), "utf8"))
      .toContain("Directory ownership context.");
    const state = await readInstallationState(home);
    expect(state.installations[0]!.outputs.every((output) => output.type === "file")).toBe(true);
  });
});
