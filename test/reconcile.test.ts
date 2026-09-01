import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostCatalogEntryFor } from "../adapters/host-catalog.js";
import { formatLifecycleJson } from "../cli/presentation.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState, hashBytes } from "../installer/project-plan.js";
import {
  ApplyVerificationError,
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("nested Project reconciliation report", () => {
  test("keeps desired identity, state, output consumers, and evidence in one Project record", async () => {
    const home = temporaryDirectory("agent-profile-kit-nested-report-home-");
    const project = temporaryDirectory("agent-profile-kit-nested-report-project-");
    execFileSync("git", ["init", "--quiet"], { cwd: project });
    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".codex", "hooks.json"), "repository-owned\n");
    execFileSync("git", ["add", ".codex/hooks.json"], { cwd: project });
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nNested report.\n",
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
    const warningValue = join(project, ".codex", "config.toml");
    const installations = desired.installations.map((installation) => ({
      ...installation,
      warnings: [{
        copyableValues: [warningValue],
        message: `Review ${warningValue} before continuing`,
      }],
    }));

    const report = await previewReconciliation(installations, {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: 7,
    });

    expect(Object.keys(report).sort()).toEqual(["globalBlockers", "projects"]);
    expect(report.projects).toHaveLength(1);
    expect(report.projects[0]).toMatchObject({
      canonicalProject: desired.installations[0]!.binding.canonicalProject,
      project,
      desired: {
        hosts: ["codex"],
        profile: "coding",
      },
      state: { kind: "addition" },
      warnings: [{
        copyableValues: [warningValue],
        message: `Review ${warningValue} before continuing`,
      }],
    });
    expect(report.projects[0]!.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        consumingHosts: ["codex"],
        kind: "addition",
      }),
    ]));
    expect(report.projects[0]!.setupSteps.length).toBeGreaterThan(0);
    expect(report.projects[0]!.repositoryExclusions).toHaveLength(1);
    expect(report.projects[0]!.repositoryExclusions[0]!.target).toContain("/info/exclude");

    expect(report.projects[0]!.blockers).toHaveLength(1);
    expect(report.projects[0]!.blockers[0]).toMatchObject({
      affectedItems: [{ kind: "path", value: ".codex/hooks.json" }],
      kind: "output-ownership-conflict",
      scope: "project",
    });
    const json = JSON.parse(formatLifecycleJson("status", report));
    expect(json).toMatchObject({
      schemaVersion: 12,
      command: "status",
      outcome: "blocked",
      globalBlockers: [],
      projects: [{
        canonicalProject: desired.installations[0]!.binding.canonicalProject,
        project,
        state: { kind: "addition" },
        warnings: [{
          copyableValues: [warningValue],
          message: `Review ${warningValue} before continuing`,
        }],
      }],
    });
    expect(json).not.toHaveProperty("installations");
    expect(json).not.toHaveProperty("outputs");
  });
});

describe("injected project filesystem failures", () => {
  test("returns the completed receipt when post-commit verification fails", async () => {
    const home = temporaryDirectory("agent-profile-kit-verification-failure-home-");
    const project = temporaryDirectory("agent-profile-kit-verification-failure-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nVerification failure.\n",
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

    let failure: unknown;
    try {
      await applyReconciliation(home, desired.installations, {
        verifyReconciliation: async () => {
          throw new Error("injected verification read failure");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ApplyVerificationError);
    expect((failure as ApplyVerificationError).message).toContain(
      "Apply committed; post-apply verification failed: injected verification read failure",
    );
    expect((failure as ApplyVerificationError).receipt.projects).toContainEqual(
      expect.objectContaining({ project, state: { kind: "addition" } }),
    );
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("rolls back a mid-update failure and reports non-empty completed, failed, and pending sets", async () => {
    const home = temporaryDirectory("agent-profile-kit-injected-home-");
    const first = temporaryDirectory("agent-profile-kit-injected-a-");
    const second = temporaryDirectory("agent-profile-kit-injected-b-");
    const third = temporaryDirectory("agent-profile-kit-injected-c-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nOriginal Context.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${third}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    const initialReport = await applyReconciliation(home, initial.installations);
    expect(initialReport.receipt.projects.find((entry) => entry.project === third)?.canonicalProject)
      .toBe(initial.installations.find((entry) => entry.binding.project === third)?.binding.canonicalProject);
    expect(initialReport.receipt.projects.every((entry) => entry.state.kind === "addition")).toBe(true);
    expect(initialReport.resultingState.projects.every((entry) => entry.state.kind === "current")).toBe(true);
    const obsoleteRelative = ".agent-profile-kit/codex/obsolete.txt";
    const obsolete = join(second, obsoleteRelative);
    const obsoleteBytes = "owned obsolete output\n";
    writeFileSync(obsolete, obsoleteBytes);
    const previousState = await readInstallationState(home);
    await writeInstallationState(home, {
      ...previousState,
      receipts: previousState.receipts.map((installation) =>
        installation.project === initial.installations.find(
          (entry) => entry.binding.project === second,
        )!.binding.canonicalProject
          ? {
              ...installation,
              outputs: [...installation.outputs, {
                hash: hashBytes(obsoleteBytes),
                mode: 0o644,
                path: obsoleteRelative,
                type: "file" as const,
              }],
            }
          : installation
      ),
    });
    const secondContextPath = join(second, ".agent-profile-kit", "codex", "context.md");
    const secondContext = readFileSync(secondContextPath, "utf8");
    const thirdContextPath = join(third, ".agent-profile-kit", "codex", "context.md");
    const thirdContext = readFileSync(thirdContextPath, "utf8");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated Context.\n",
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const firstCanonical = desired.installations.find(
      (installation) => installation.binding.project === first,
    )!.binding.canonicalProject;
    const secondCanonical = desired.installations.find(
      (installation) => installation.binding.project === second,
    )!.binding.canonicalProject;
    const secondCanonicalContextPath = join(
      secondCanonical,
      ".agent-profile-kit",
      "codex",
      "context.md",
    );
    const thirdCanonical = desired.installations.find(
      (installation) => installation.binding.project === third,
    )!.binding.canonicalProject;
    let injected = false;

    await expect(applyReconciliation(home, desired.installations, {
      fileSystem: {
        rename: async (oldPath, newPath) => {
          const source = oldPath.toString();
          const destination = newPath.toString();
          if (
            !injected &&
            source.startsWith(`${secondCanonical}/.agent-profile-kit-stage-`) &&
            destination === secondCanonicalContextPath
          ) {
            injected = true;
            throw new Error("injected mid-update failure");
          }
          await rename(oldPath, newPath);
        },
      },
    })).rejects.toThrow(
      `completed projects: ${firstCanonical}; failed project: ${secondCanonical}; pending projects: ${thirdCanonical}`,
    );
    expect(readFileSync(join(first, ".agent-profile-kit", "codex", "context.md"), "utf8")).toContain("Updated Context.");
    expect(readFileSync(secondContextPath, "utf8")).toBe(secondContext);
    expect(readFileSync(obsolete, "utf8")).toBe(obsoleteBytes);
    expect(readFileSync(thirdContextPath, "utf8")).toBe(thirdContext);

    await expect(applyReconciliation(home, desired.installations)).resolves.toBeDefined();
    for (const project of [first, second, third]) {
      expect(readFileSync(join(project, ".agent-profile-kit", "codex", "context.md"), "utf8"))
        .toContain("Updated Context.");
    }
    expect(existsSync(obsolete)).toBe(false);
  });

  test("reconciles a mode-only desired output change", async () => {
    const home = temporaryDirectory("agent-profile-kit-mode-home-");
    const project = temporaryDirectory("agent-profile-kit-mode-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nMode reconciliation.\n",
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
    await applyReconciliation(home, desired.installations);
    const changed = desired.installations.map((installation) => ({
      ...installation,
      outputs: installation.outputs.map((output) =>
        output.path.endsWith("context.md") ? { ...output, mode: 0o600 } : output
      ),
    }));

    const report = await applyReconciliation(home, changed);

    expect(report.receipt.projects).toContainEqual(expect.objectContaining({
      project,
      state: { kind: "update", reason: "desired output changed" },
    }));
    expect(statSync(join(project, ".agent-profile-kit", "codex", "context.md")).mode & 0o777).toBe(0o600);
    const state = await readInstallationState(home);
    expect(state.receipts[0]!.outputs.find((output) => output.path.endsWith("context.md"))?.mode).toBe(0o600);
  });

  test("a missing-output repair remains retryable across output and Installation State publication failures", async () => {
    const home = temporaryDirectory("agent-profile-kit-repair-failure-home-");
    const project = temporaryDirectory("agent-profile-kit-repair-failure-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nRepair transaction.\n",
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
    await applyReconciliation(home, desired.installations);
    const canonicalProject = desired.installations[0]!.binding.canonicalProject;
    const context = join(canonicalProject, ".agent-profile-kit", "codex", "context.md");
    const originalState = await readInstallationState(home);
    rmSync(context);
    let outputFailureInjected = false;

    await expect(applyReconciliation(home, desired.installations, {
      fileSystem: {
        rename: async (oldPath, newPath) => {
          if (
            !outputFailureInjected &&
            oldPath.toString().startsWith(`${canonicalProject}/.agent-profile-kit-stage-`) &&
            newPath.toString() === context
          ) {
            outputFailureInjected = true;
            throw new Error("injected repair output failure");
          }
          await rename(oldPath, newPath);
        },
      },
    })).rejects.toThrow("injected repair output failure");
    expect(existsSync(context)).toBe(false);
    expect(await readInstallationState(home)).toEqual(originalState);
    await expect(applyReconciliation(home, desired.installations)).resolves.toBeDefined();

    rmSync(context);
    let stateFailureInjected = false;
    await expect(applyReconciliation(home, desired.installations, {
      writeInstallationState: async (targetHome, state) => {
        if (!stateFailureInjected) {
          stateFailureInjected = true;
          throw new Error("injected repair state failure");
        }
        await writeInstallationState(targetHome, state);
      },
    })).rejects.toThrow("injected repair state failure");
    expect(existsSync(context)).toBe(false);
    expect(await readInstallationState(home)).toEqual(originalState);

    await expect(applyReconciliation(home, desired.installations)).resolves.toBeDefined();
    expect(readFileSync(context, "utf8")).toContain("Repair transaction.");
  });

  test("surfaces installation-state restore failures after an apply error", async () => {
    const home = temporaryDirectory("agent-profile-kit-state-restore-home-");
    const project = temporaryDirectory("agent-profile-kit-state-restore-project-");
    execFileSync("git", ["init", "-q", project]);
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nOriginal Context.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated Context.\n",
    );
    const desiredState = await buildDesiredState(home, { checkHostCapability: false });
    const desired = desiredState.installations.map((installation) => ({
      ...installation,
      outputs: installation.outputs.map((output) =>
        output.path.endsWith("context.md")
          ? { ...output, path: ".agent-profile-kit/codex/context-v2.md" }
          : output,
      ),
    }));
    let stateWrites = 0;
    const exclude = join(project, ".git", "info", "exclude");

    await expect(applyReconciliation(home, desired, {
      writeInstallationState: async (targetHome, state) => {
        stateWrites += 1;
        if (stateWrites === 2) throw new Error("injected state restore failure");
        await writeInstallationState(targetHome, state);
        if (stateWrites === 1) writeFileSync(exclude, "concurrent edit\n");
      },
    })).rejects.toThrow(/Installation State restore failed/);
  });
});

describe("previous-version Marker migration", () => {
  test("a leftover Marker from an earlier version is removed by the next apply even when the Project is current", async () => {
    const home = temporaryDirectory("agent-profile-kit-legacy-home-");
    const project = realpathSync(temporaryDirectory("agent-profile-kit-legacy-project-"));
    execFileSync("git", ["init", "-q", project]);
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nLegacy migration boundary.\n",
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
    const installation = desired.installations[0]!;
    const bytes = new Map(desired.installations[0]!.outputs.map((output) => [
      output.path,
      (output as { bytes: string }).bytes,
    ]));
    // Simulate the previous product version: generated output installed and a
    // Marker file on disk, with a v6 receipt that never recorded the Marker.
    mkdirSync(join(project, ".agent-profile-kit", "codex"), { recursive: true });
    mkdirSync(join(project, "nested"), { recursive: true });
    for (const [path, content] of bytes) {
      mkdirSync(join(project, path, ".."), { recursive: true });
      writeFileSync(join(project, path), content);
    }
    writeFileSync(
      join(project, ".agent-profile-kit", "installation.json"),
      JSON.stringify({ installation_id: "v6-installation-id", schema_version: 1 }),
    );
    const sha256 = (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const previousStateSource = JSON.stringify({
      schema_version: 6,
      receipts: [{
        installation_id: "v6-installation-id",
        lifetime: "ordinary",
        project,
        profile_id: "coding",
        desired_input_digest: installation.sourceHash,
        hosts: {
          codex: {
            adapter_version: hostCatalogEntryFor("codex").adapterVersion,
            capability_contract: installation.hostVersions.codex!,
          },
        },
        outputs: [...bytes.entries()].map(([path, content]) => ({
          path,
          type: "file",
          mode: 0o644,
          hash: sha256(content),
        })),
        repository_exclusion: {
          target: join(project, ".git", "info", "exclude"),
          entries: ["/.codex/hooks.json", "/.agent-profile-kit/codex/context.md"],
        },
      }],
      removed_temporary_installation_ids: [],
    }, null, 2);
    mkdirSync(join(application, "state"), { recursive: true });
    writeFileSync(join(application, "state", "manifest.json"), previousStateSource);

    // The migrated receipt makes the Project current: apply must still sweep
    // the leftover ownership-token file from the Project.
    const preview = await previewReconciliation(
      desired.installations,
      await readInstallationState(home),
    );
    expect(preview.projects[0]!.state.kind).toBe("current");

    await applyReconciliation(home, desired.installations);

    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
  });

  test("unknown content at the legacy pathname is never removed by apply or uninstall", async () => {
    const home = temporaryDirectory("agent-profile-kit-legacy-foreign-home-");
    const project = temporaryDirectory("agent-profile-kit-legacy-foreign-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nLegacy foreign bytes.\n",
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
    await applyReconciliation(home, desired.installations);
    const foreign = join(project, ".agent-profile-kit", "installation.json");
    writeFileSync(foreign, "user data unknown to Agent Profile Kit\n");

    // The current-Project migration sweep runs on every apply and must
    // preserve bytes that do not verify as the previous version's token.
    await applyReconciliation(home, desired.installations);
    expect(readFileSync(foreign, "utf8")).toBe("user data unknown to Agent Profile Kit\n");

    // The removal staging must preserve the unknown bytes too while removing
    // the proven owned output.
    await applyReconciliation(home, []);
    expect(readFileSync(foreign, "utf8")).toBe("user data unknown to Agent Profile Kit\n");
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
  });

  test("an Adapter output at the legacy pathname is not swept as a leftover token", async () => {
    const home = temporaryDirectory("agent-profile-kit-legacy-desired-home-");
    const project = temporaryDirectory("agent-profile-kit-legacy-desired-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nLegacy desired-path boundary.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const desiredState = await buildDesiredState(home, { checkHostCapability: false });
    const desired = desiredState.installations.map((installation) => ({
      ...installation,
      outputs: installation.outputs.map((output) =>
        output.path === ".agent-profile-kit/codex/context.md"
          ? { ...output, path: ".agent-profile-kit/installation.json" }
          : output,
      ),
    }));

    await applyReconciliation(home, desired);
    const adapterOutput = join(project, ".agent-profile-kit", "installation.json");
    expect(existsSync(adapterOutput)).toBe(true);

    // The second apply is current and its migration sweep must skip the path:
    // it is a recorded and desired Adapter output, not a leftover token.
    const second = await applyReconciliation(home, desired);
    expect(second.resultingState.projects[0]!.state.kind).toBe("current");
    expect(existsSync(adapterOutput)).toBe(true);
  });
});
