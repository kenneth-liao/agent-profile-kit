import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { OWNERSHIP_STATE_SCHEMA_VERSION } from "../schemas/ownership-state.js";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import * as actualFsPromises from "node:fs/promises";
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
import {
  readInstallationState,
  stageProvenInstallationRemoval,
  StagedRollbackFailureError,
  writeInstallationState,
} from "../installer/installation-state.js";
import { publishRepositoryExclusions } from "../installer/git-exclusions.js";
import { uninstallApplication } from "../installer/commands.js";

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
      schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
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
      schemaVersion: 14,
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

  test("a wholly absent owned output is ordinary pending update work restored by apply", async () => {
    const home = temporaryDirectory("agent-profile-kit-absent-home-");
    const project = temporaryDirectory("agent-profile-kit-absent-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAbsent output.\n",
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
    const contextPath = join(project, ".agent-profile-kit", "codex", "context.md");
    rmSync(contextPath);

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));
    expect(report.projects[0]!.state).toMatchObject({ kind: "drifted output" });
    expect(report.projects[0]!.blockers).toHaveLength(0);
    expect(report.projects[0]!.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "update", path: ".agent-profile-kit/codex/context.md" }),
    ]));

    const applied = await applyReconciliation(home, desired.installations);
    expect(readFileSync(contextPath, "utf8")).toContain("Absent output.");
    expect(applied.receipt.projects[0]!.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "update", path: ".agent-profile-kit/codex/context.md" }),
    ]));
  });

  test("apply records the replacement of a user-edited generated file as a named write", async () => {
    const home = temporaryDirectory("agent-profile-kit-edited-home-");
    const project = temporaryDirectory("agent-profile-kit-edited-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nEdited replacement.\n",
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
    const contextPath = join(project, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(contextPath, "user edit\n");

    const applied = await applyReconciliation(home, desired.installations);
    expect(readFileSync(contextPath, "utf8")).toContain("Edited replacement.");
    expect(applied.receipt.projects[0]!.state).toMatchObject({ kind: "drifted output" });
    expect(applied.receipt.projects[0]!.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "update", path: ".agent-profile-kit/codex/context.md" }),
    ]));
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
    const firstProject = temporaryDirectory("agent-profile-kit-state-restore-a-");
    const secondProject = temporaryDirectory("agent-profile-kit-state-restore-b-");
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
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n` +
        `  - project: ${firstProject}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${secondProject}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated Context.\n",
    );
    const desired = (await buildDesiredState(home, { checkHostCapability: false })).installations;

    let stateWrites = 0;
    await expect(applyReconciliation(home, desired, {
      writeInstallationState: async (targetHome, state) => {
        stateWrites += 1;
        if (stateWrites >= 2) throw new Error("injected state restore failure");
        await writeInstallationState(targetHome, state);
      },
    })).rejects.toThrow(/Installation State restore failed/);
  });
});

describe("previous-version Marker migration", () => {
  /** One bound Project with the shipped coding Profile and no state written yet. */
  async function prepareLegacyFixture(prefix: string) {
    const home = temporaryDirectory(`${prefix}-home-`);
    const project = temporaryDirectory(`${prefix}-project-`);
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
    return {
      home,
      project,
      application,
      desired: (await buildDesiredState(home, { checkHostCapability: false })).installations,
    };
  }

  function writeToken(project: string, installationId: string): void {
    writeFileSync(
      join(project, ".agent-profile-kit", "installation.json"),
      JSON.stringify({ installation_id: installationId, schema_version: 1 }),
    );
  }

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
    // Marker file on disk, with a previous-version receipt that never recorded
    // the Marker.
    mkdirSync(join(project, ".agent-profile-kit", "codex"), { recursive: true });
    mkdirSync(join(project, "nested"), { recursive: true });
    for (const [path, content] of bytes) {
      mkdirSync(join(project, path, ".."), { recursive: true });
      writeFileSync(join(project, path), content);
    }
    writeFileSync(
      join(project, ".agent-profile-kit", "installation.json"),
      JSON.stringify({ installation_id: "previous-installation-id", schema_version: 1 }),
    );
    const sha256 = (value: string) =>
      `sha256:${createHash("sha256").update(value).digest("hex")}`;
    const previousStateSource = JSON.stringify({
      schema_version: 8,
      receipts: [{
        installation_id: "previous-installation-id",
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
    // Retire the receipt the way unbind does: the removal pass then consumes
    // the retiring record without a desired plan.
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home, project });
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

  test("a legacy token naming a different installation is preserved on apply and uninstall", async () => {
    const { home, project, desired } = await prepareLegacyFixture("agent-profile-kit-legacy-mismatch");
    await applyReconciliation(home, desired);
    // Valid token shape, but its id belongs to no receipt that owns this
    // Project: neither the current-apply sweep nor the removal staging may
    // treat it as cleanup evidence.
    writeToken(project, "some-other-installation");
    const token = join(project, ".agent-profile-kit", "installation.json");

    await applyReconciliation(home, desired);
    expect(readFileSync(token, "utf8")).toContain("some-other-installation");

    // Retire the receipt the way unbind does: the removal pass then consumes
    // the retiring record without a desired plan.
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home, project });
    await applyReconciliation(home, []);
    expect(readFileSync(token, "utf8")).toContain("some-other-installation");
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
  });

  test("a shape-valid legacy token with no previous Receipt is never cleaned up", async () => {
    const { home, project, desired } = await prepareLegacyFixture("agent-profile-kit-legacy-orphan");
    mkdirSync(join(project, ".agent-profile-kit"), { recursive: true });
    writeToken(project, "unclaimed-installation");
    const token = join(project, ".agent-profile-kit", "installation.json");

    // First apply: no previous Receipt exists, so nothing authorizes cleanup.
    await applyReconciliation(home, desired);
    expect(readFileSync(token, "utf8")).toContain("unclaimed-installation");

    // Changed apply: the token id still matches no authoritative Receipt, so
    // the staged transaction preserves it too.
    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "workspace", "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nChanged legacy boundary.\n",
    );
    const changed = (await buildDesiredState(home, { checkHostCapability: false })).installations;
    await applyReconciliation(home, changed);
    expect(readFileSync(token, "utf8")).toContain("unclaimed-installation");
  });

  test("uninstall removes a legacy token that matches its authoritative Receipt", async () => {
    const { home, project, desired } = await prepareLegacyFixture("agent-profile-kit-legacy-match");
    await applyReconciliation(home, desired);
    const receiptId = (await readInstallationState(home)).receipts[0]!.installationId;
    writeToken(project, receiptId);
    const token = join(project, ".agent-profile-kit", "installation.json");

    // Retire the receipt the way unbind does: the removal pass then consumes
    // the retiring record without a desired plan.
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home, project });
    await applyReconciliation(home, []);

    expect(existsSync(token)).toBe(false);
  });
});

describe("uninstall failure safety and exclusion publication races", () => {
  async function prepareGitProject(prefix: string) {
    const home = temporaryDirectory(`${prefix}-home-`);
    const project = temporaryDirectory(`${prefix}-project-`);
    execFileSync("git", ["init", "-q", project]);
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nRules.\n",
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
    return { home, project };
  }

  test("a publish-then-throw state write restores the prior state instead of stranding output", async () => {
    const { home, project } = await prepareGitProject("agent-profile-kit-uninstall-restore-");
    let writeCalls = 0;

    await expect(uninstallApplication(home, {
      writeInstallationState: async (targetHome, state) => {
        writeCalls += 1;
        await writeInstallationState(targetHome, state);
        if (writeCalls === 1) throw new Error("injected post-publish failure");
      },
    })).rejects.toThrow("injected post-publish failure");

    // The staged removals rolled back and the prior state (with its receipt)
    // was restored: no managed output is stranded without ownership evidence.
    const state = await readInstallationState(home);
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]!.project).toBe(realpathSync(project));
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
  });

  test("a concurrent exclude edit during publication is skipped with a warning, never overwritten", async () => {
    const { home, project } = await prepareGitProject("agent-profile-kit-publish-race-");
    const exclude = join(project, ".git", "info", "exclude");
    writeFileSync(exclude, "# unrelated managed-by-user bytes\n");
    const concurrentBytes = "# concurrent author edit\n*.scratch\n";

    const state = await readInstallationState(home);
    const publication = await publishRepositoryExclusions(state, {
      previousState: state,
      beforeWrite: async () => {
        writeFileSync(exclude, concurrentBytes);
      },
    });

    expect(publication.changes).toEqual([]);
    expect(publication.warnings).toHaveLength(1);
    expect(publication.warnings[0]!.message).toContain("changed during exclusion publication");
    expect(readFileSync(exclude, "utf8")).toBe(concurrentBytes);
  });

  describe("uninstall staging rollback fault injection", () => {
    // Passthrough rename with injectable faults: every call delegates to the
    // real node:fs/promises rename unless a fault matches. Faults are cleared
    // after each test, and the wrapper itself is behavior-neutral when empty.
    const renameFaults: { readonly match: (from: string, to: string) => boolean }[] = [];
    // Captured before mock.module so the wrapper delegates to the real
    // function instead of recursing into itself once the export is replaced.
    const realFsRename = actualFsPromises.rename;
    mock.module("node:fs/promises", () => ({
      ...actualFsPromises,
      rename: (from: Parameters<typeof realFsRename>[0], to: Parameters<typeof realFsRename>[1]) => {
        const fromPath = String(from);
        const toPath = String(to);
        if (renameFaults.some(({ match }) => match(fromPath, toPath))) {
          return Promise.reject(
            Object.assign(
              new Error(`EACCES: permission denied, rename '${fromPath}' -> '${toPath}'`),
              { code: "EACCES" },
            ),
          );
        }
        return realFsRename(from, to);
      },
    }));
    afterEach(() => {
      renameFaults.length = 0;
    });

    /** Fail the nth rename of an output into a staging tree under `project`. */
    function failNthStagedMove(project: string, nth: number): void {
      // Receipts record canonical project paths; scope faults against the
      // canonical form so the fault matches the paths the staging code uses.
      const canonical = realpathSync(project);
      let stageMoves = 0;
      renameFaults.push({
        match: (from, to) => {
          if (!to.includes(".agent-profile-kit-remove-") || !from.startsWith(canonical)) return false;
          stageMoves += 1;
          return stageMoves === nth;
        },
      });
    }

    /** Fail every restore rename out of a staging tree under `project`. */
    function failRestoreFromStage(project: string): void {
      const canonical = realpathSync(project);
      renameFaults.push({
        match: (from) =>
          from.startsWith(join(canonical, ".agent-profile-kit-remove-")),
      });
    }

    function retainedStageDirectories(project: string): string[] {
      return readdirSync(project)
        .filter((name) => name.startsWith(".agent-profile-kit-remove-"))
        .map((name) => join(project, name));
    }

    test("a mid-stage failure with confirmed rollback is reported as a kept Project, never a tool error", async () => {
      const { home, project } = await prepareGitProject("agent-profile-kit-uninstall-rollback-ok-");
      failNthStagedMove(project, 2);

      const result = await uninstallApplication(home);

      expect(result.projects).toEqual([]);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0]!.project).toBe(realpathSync(project));
      expect(result.kept[0]!.reason).toContain("EACCES");
      // The confirmed rollback restored every moved root; no staging tree survives.
      const receipt = (await readInstallationState(home)).receipts[0]!;
      for (const output of receipt.outputs) {
        expect(existsSync(join(project, output.path))).toBe(true);
      }
      expect(retainedStageDirectories(project)).toEqual([]);
    });

    test("a mid-stage failure whose restore also fails is a global tool error retaining staged bytes", async () => {
      const { home, project } = await prepareGitProject("agent-profile-kit-uninstall-rollback-ok-");
      const second = temporaryDirectory("agent-profile-kit-uninstall-rollback-fail-project-");
      execFileSync("git", ["init", "-q", second]);
      const application = join(home, ".agents", "agent-profile-kit");
      writeFileSync(
        join(application, "config.yaml"),
        `schema_version: 2\nworkspace: ${join(application, "workspace")}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
      );
      const desired = await buildDesiredState(home, { checkHostCapability: false });
      await applyReconciliation(home, desired.installations);
      failNthStagedMove(second, 2);
      failRestoreFromStage(second);

      const failure: Error = await uninstallApplication(home).then(
        () => expect.unreachable("uninstall was expected to fail with a staged rollback failure") as never,
        (error: unknown) => error as Error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect(failure!.message).toContain("staged output restore failed");
      expect(failure!.message).toContain("Cannot remove Project at");

      // The failing Project keeps its receipt and its staged bytes: the staging
      // tree survives with the moved output inside it.
      const receipts = (await readInstallationState(home)).receipts;
      expect(receipts).toHaveLength(2);
      const failingReceipt = receipts.find((candidate) => candidate.project === realpathSync(second))!;
      const stagedRoot = retainedStageDirectories(second);
      expect(stagedRoot).toHaveLength(1);
      expect(existsSync(join(stagedRoot[0]!, failingReceipt.outputs[0]!.path))).toBe(true);
      expect(existsSync(join(second, failingReceipt.outputs[0]!.path))).toBe(false);
      // The healthy Project staged earlier was rolled back by the same tool error.
      const healthyReceipt = receipts.find((candidate) => candidate.project === realpathSync(project))!;
      for (const output of healthyReceipt.outputs) {
        expect(existsSync(join(project, output.path))).toBe(true);
      }
      expect(retainedStageDirectories(project)).toEqual([]);
    });

    test("stageProvenInstallationRemoval surfaces original and restore failures and retains the staging tree", async () => {
      const { home, project } = await prepareGitProject("agent-profile-kit-uninstall-rollback-ok-");
      const receipt = (await readInstallationState(home)).receipts[0]!;
      failNthStagedMove(project, 2);
      failRestoreFromStage(project);

      const failure: StagedRollbackFailureError = await stageProvenInstallationRemoval(receipt).then(
        () => expect.unreachable("staging was expected to fail with a rollback failure") as never,
        (error: unknown) => error as StagedRollbackFailureError,
      );

      expect(failure).toBeInstanceOf(StagedRollbackFailureError);
      expect(failure!.message).toContain(`Cannot remove Project at ${receipt.project}`);
      expect(failure!.message).toContain("EACCES");
      expect(failure!.message).toContain("staged output restore failed; staged bytes retained at");
      expect(failure!.failures).toHaveLength(1);
      const stagedRoot = retainedStageDirectories(project);
      expect(stagedRoot).toHaveLength(1);
      expect(existsSync(join(stagedRoot[0]!, receipt.outputs[0]!.path))).toBe(true);
    });
  });
});
