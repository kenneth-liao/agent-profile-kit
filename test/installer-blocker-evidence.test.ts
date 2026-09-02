import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";

import {
  formatLifecycleJson,
  formatLifecycleReport,
  lifecycleExitCode,
} from "../cli/presentation.js";
import {
  blockerMessage,
  INSTALLATION_OWNERSHIP,
  INSTALLATION_STATE_UNREADABLE,
  installationOwnershipBlocker,
  installationStateUnreadableBlocker,
  isStructuredBlocker,
  normalizeBlocker,
  OCCUPIED_OUTPUT,
  occupiedOutputBlocker,
  TEMPORARY_INSTALLATION_CONFLICT,
  TEMPORARY_INSTALLATION_REMOVAL,
  temporaryInstallationConflictBlocker,
  temporaryInstallationRemovalBlocker,
} from "../installer/blockers.js";
import { statusApplication } from "../installer/commands.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { readInstallationState } from "../installer/installation-state.js";
import { buildDesiredState, stateManifestPath } from "../installer/project-plan.js";
import {
  applyReconciliation,
  desiredOutputConflicts,
  manifestFor,
  previewReconciliation,
} from "../installer/reconcile.js";
import { projectConflictBlockers } from "../installer/temporary-installation.js";
import { createLifecycleOwnershipInspectionContext } from "../installer/lifecycle-ownership-inspection.js";
import {
  compareCanonicalStrings,
} from "../schemas/installation-manifest.js";
import {
  OWNERSHIP_STATE_LIMITS,
  type OwnershipState,
  OWNERSHIP_STATE_SCHEMA_VERSION,
} from "../schemas/ownership-state.js";
import {
  reportBlockers,
  reportItems,
  reportOutputs,
} from "./support/reconciliation-report.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function gitRepository(prefix: string): string {
  const repository = temporaryDirectory(prefix);
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  return realpathSync(repository);
}

async function prepareHome(project: string): Promise<string> {
  const home = temporaryDirectory("apkit-evidence-home-");
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${join(application, "workspace")}\nbindings:\n` +
      `  - project: ${project}\n    profile: example\n    hosts: [codex]\n`,
  );
  return home;
}

function emptyState(): OwnershipState {
  return {
    receipts: [],
    removedTemporaryInstallationIds: [],
    schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
  };
}

function requireDefined<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`expected ${description}`);
  return value;
}

describe("structured Installer blocker evidence", () => {
  test("out-of-bound Installation State emits one structured global blocker", async () => {
    const project = temporaryDirectory("apkit-evidence-project-");
    const home = await prepareHome(project);
    const statePath = stateManifestPath(home);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `#${"x".repeat(OWNERSHIP_STATE_LIMITS.maxBytes)}\n`);

    const report = await statusApplication(home);

    expect(reportBlockers(report)).toHaveLength(1);
    const blocker = reportBlockers(report)[0]!;
    expect(isStructuredBlocker(blocker)).toBe(true);
    expect(blocker).toMatchObject({
      kind: INSTALLATION_STATE_UNREADABLE,
      scope: "global",
    });
    // Plain value checks: asymmetric matchers in toMatchObject replace the
    // matched properties on the shared blocker, corrupting later JSON reads.
    for (const field of ["problem", "remedy", "requirement"] as const) {
      expect(typeof blocker[field]).toBe("string");
      expect(blocker[field].length).toBeGreaterThan(0);
    }
    expect(blocker.project).toBeUndefined();
    expect(blocker.message).toContain("Installation State");
    expect(blocker.affectedItems).toEqual([{ kind: "path", value: statePath }]);

    const human = formatLifecycleReport("status", report);
    expect(human).toContain("Global blockers:");
    expect(human).toContain(blocker.message);
    const machine = JSON.parse(formatLifecycleJson("status", report)) as {
      readonly globalBlockers: readonly Record<string, unknown>[];
      readonly schemaVersion: number;
    };
    expect(machine.schemaVersion).toBe(13);
    expect(machine.globalBlockers).toEqual([{
      kind: INSTALLATION_STATE_UNREADABLE,
      scope: "global",
      message: blocker.message,
      problem: blocker.problem,
      requirement: "Lifecycle commands require readable Installation State",
      remedy: "Restore or repair the Installation State file, then retry",
      affectedItems: [{ kind: "path", value: statePath }],
    }]);
    expect(lifecycleExitCode(report)).toBe(2);
  });

  test("blocker builders emit complete structured evidence with preserved messages", () => {
    const stateBlocker = normalizeBlocker(installationStateUnreadableBlocker({
      message: "Installation State is unreadable",
      statePath: "/home/state/manifest.yaml",
    }));
    expect(stateBlocker).toMatchObject({
      kind: INSTALLATION_STATE_UNREADABLE,
      message: "Installation State is unreadable",
      scope: "global",
    });
    expect(stateBlocker.project).toBeUndefined();
    expect(stateBlocker.affectedItems).toEqual([{ kind: "path", value: "/home/state/manifest.yaml" }]);

    const occupied = normalizeBlocker(occupiedOutputBlocker({
      message: ".codex/hooks.json is occupied by unowned or drifted output",
      path: ".codex/hooks.json",
      project: "/p",
    }));
    expect(occupied).toMatchObject({
      kind: OCCUPIED_OUTPUT,
      message: ".codex/hooks.json is occupied by unowned or drifted output",
      project: "/p",
      scope: "project",
    });
    expect(occupied.affectedItems).toEqual([{ kind: "path", value: ".codex/hooks.json" }]);

    const ownership = normalizeBlocker(installationOwnershipBlocker({
      message: "Cannot sync the generated file: drifted",
      project: "/p",
    }));
    expect(ownership).toMatchObject({
      kind: INSTALLATION_OWNERSHIP,
      message: "Cannot sync the generated file: drifted",
      project: "/p",
      scope: "project",
    });

    const conflict = normalizeBlocker(temporaryInstallationConflictBlocker({
      message: "An active Temporary Profile Installation already owns generated files (temp-1)",
      project: "/p",
      temporaryInstallationId: "temp-1",
    }));
    expect(conflict).toMatchObject({
      kind: TEMPORARY_INSTALLATION_CONFLICT,
      message: "An active Temporary Profile Installation already owns generated files (temp-1)",
      project: "/p",
      scope: "project",
    });
    expect(conflict.affectedItems).toEqual([{ kind: "installation-id", value: "temp-1" }]);

    const unproven = normalizeBlocker(occupiedOutputBlocker({
      message: ".codex/second.json is occupied by unowned or drifted output",
      path: ".codex/second.json",
      project: "/p",
    }));
    // Plain value checks: asymmetric matchers in toMatchObject replace the
    // matched properties on the shared blocker, corrupting later JSON reads.
    for (const field of ["problem", "remedy", "requirement"] as const) {
      expect(typeof unproven[field]).toBe("string");
      expect(unproven[field].length).toBeGreaterThan(0);
    }
    expect(unproven.project).toBe("/p");
    expect(unproven.affectedItems).toEqual([{ kind: "path", value: ".codex/second.json" }]);

    const removal = temporaryInstallationRemovalBlocker({
      message: "Cannot remove Temporary Profile Installation: Installation Marker is missing",
      outputs: ["/p/.agents/skills/review-pr"],
      project: "/p",
    });
    expect(blockerMessage(removal)).toBe(
      "Cannot remove Temporary Profile Installation: Installation Marker is missing",
    );
    expect(normalizeBlocker(removal)).toMatchObject({
      kind: TEMPORARY_INSTALLATION_REMOVAL,
      project: "/p",
      scope: "project",
    });
  });

  test("occupied planned output emits structured project-scoped evidence", async () => {
    const project = temporaryDirectory("apkit-evidence-occupied-");
    const home = await prepareHome(project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "hooks.json"), "occupied\n");

    const conflicts = await desiredOutputConflicts(
      installation,
      undefined,
      createLifecycleOwnershipInspectionContext(),
    );
    const occupied = requireDefined(
      conflicts
        .map((input) => normalizeBlocker(input, canonicalProject))
        .find((blocker) => isStructuredBlocker(blocker) && blocker.kind === OCCUPIED_OUTPUT),
      "a structured occupied-output blocker",
    );
    expect(occupied).toMatchObject({ scope: "project", project: canonicalProject });
    expect(occupied.message).toBe(
      ".codex/hooks.json is occupied by unowned or drifted output",
    );
    expect(occupied.affectedItems).toEqual([{ kind: "path", value: ".codex/hooks.json" }]);
  });

  test("drifted generated output is non-blocking pending refresh work rather than ownership evidence", async () => {
    const project = temporaryDirectory("apkit-evidence-drift-");
    const home = await prepareHome(project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    const installationId = "evidence-installation-id";
    const manifest = manifestFor(installation, installationId);
    for (const output of installation.outputs) {
      const destination = join(canonicalProject, output.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, "drifted content\n");
    }
    // Keep one recorded root byte-identical to the receipt's recorded hash:
    // it is the continuity anchor that proves the drifted sibling is Agent
    // Profile Kit's own output rather than a different Project's material.
    for (const output of installation.outputs) {
      const destination = join(canonicalProject, output.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, output.path.endsWith("hooks.json") ? (output as { bytes: string }).bytes : "drifted content\n");
    }
    const state: OwnershipState = {
      ...emptyState(),
      receipts: [manifest],
    };

    const report = await previewReconciliation(desired.installations, state);

    // Continuity-anchored drift never blocks and never claims a user edit.
    expect(reportBlockers(report)).toEqual([]);
    expect(reportItems(report)).toContainEqual({
      kind: "drifted output",
      project: expect.any(String),
      reason: ".agent-profile-kit/codex/context.md",
    });
    expect(reportOutputs(report)).toContainEqual({
      kind: "drifted output",
      path: ".agent-profile-kit/codex/context.md",
      project: expect.any(String),
    });
    expect(reportOutputs(report)).not.toContainEqual({
      kind: "drifted output",
      path: ".codex/hooks.json",
      project: expect.any(String),
    });
  });

  test("residual ownership Blocker evidence stays provenance-neutral", () => {
    const ownership = normalizeBlocker(installationOwnershipBlocker({
      message: "Cannot verify generated-file ownership: owned output .codex/hooks.json has unsafe parent: /p/.codex is a symlink parent",
      project: "/p",
    }));
    expect(ownership.problem).not.toMatch(/your edit/i);
    expect(ownership.remedy).not.toMatch(/Move the change into the Workspace/i);
    expect(ownership.remedy).not.toMatch(/your edit/i);
    expect(ownership.message).not.toMatch(/your edit/i);
    expect(ownership.message).not.toMatch(/Move the change into the Workspace/i);
  });

  test("temporary installation conflicts emit structured project-scoped evidence", async () => {
    const project = temporaryDirectory("apkit-evidence-temp-");
    const home = await prepareHome(project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    const manifest = manifestFor(installation, "ordinary-installation-id");
    const state: OwnershipState = {
      ...emptyState(),
      receipts: [manifest],
    };

    const blockers = projectConflictBlockers(state, canonicalProject);

    expect(blockers).toHaveLength(1);
    expect(normalizeBlocker(blockers[0]!)).toMatchObject({
      kind: TEMPORARY_INSTALLATION_CONFLICT,
      message: "Generated files are already managed through a Project Binding; " +
        "remove them before installing a temporary Profile",
      project: canonicalProject,
      scope: "project",
    });
    expect(blockerMessage(blockers[0]!)).toBe(
      "Generated files are already managed through a Project Binding; " +
        "remove them before installing a temporary Profile",
    );
  });

  test("statusApplication emits the structured global blocker for unreadable Installation State", async () => {
    const project = temporaryDirectory("apkit-evidence-preview-state-");
    const home = await prepareHome(project);
    const statePath = stateManifestPath(home);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "not: a valid installation state\n");

    const report = await statusApplication(home);
    const blocker = requireDefined(
      reportBlockers(report).find(
        (candidate) =>
          isStructuredBlocker(candidate) && candidate.kind === INSTALLATION_STATE_UNREADABLE,
      ),
      "a structured installation-state-unreadable blocker",
    );
    expect(blocker).toMatchObject({ kind: INSTALLATION_STATE_UNREADABLE, scope: "global" });
    expect(blocker.project).toBeUndefined();
    expect(blocker.affectedItems).toEqual([{ kind: "path", value: statePath }]);
    expect(lifecycleExitCode(report)).toBe(2);
  });
});
