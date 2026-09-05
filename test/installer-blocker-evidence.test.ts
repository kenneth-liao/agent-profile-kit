import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";

import {
  formatLifecycleJson,
  lifecycleExitCode,
  lifecycleStatusDocument,
} from "../cli/presentation.js";
import { blockerWording, humanBlockerWording } from "../cli/blocker-wording.js";
import { flatInlineText } from "../cli/inline-content.js";
import {
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
  type StateReadFailureFact,
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
} from "../schemas/canonical.js";
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
    // The Installer-classified oversize failure crosses as a typed fact and
    // every sentence is composed by presentation.
    expect(blocker.stateFailure).toEqual({
      case: "oversize-state",
      limitBytes: OWNERSHIP_STATE_LIMITS.maxBytes,
    });
    expect(blocker.detail).toBeUndefined();
    expect(blocker.project).toBeUndefined();
    expect("problem" in blocker).toBe(false);
    expect(blocker.affectedItems).toEqual([{ kind: "path", value: statePath }]);

    const wording = blockerWording(blocker);
    const humanWording = humanBlockerWording(blocker);
    expect(wording.problem).toBe(
      `Installation State exceeds the ${OWNERSHIP_STATE_LIMITS.maxBytes} byte limit`,
    );
    expect(wording.remedy).toBe("Restore or repair the Installation State file, then retry");
    expect(flatInlineText(humanWording.remedy)).toBe(
      "Restore or repair the installation record file, then retry. Run apkit status to retry.",
    );
    for (const term of [/Installation State/i]) {
      expect(flatInlineText(humanWording.problem)).not.toMatch(term);
      expect(flatInlineText(humanWording.requirement)).not.toMatch(term);
      expect(flatInlineText(humanWording.remedy)).not.toMatch(term);
    }

    const human = lifecycleStatusDocument(report);
    expect(human.filter((node) => node.kind === "heading").map((node) => node.text)).toContain("Global blockers:");
    expect(human.filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(1);
    const verbose = lifecycleStatusDocument(report, { verbose: true });
    expect(verbose.filter((node) => node.kind === "heading").map((node) => node.text)).toContain("Blockers:");
    const blockersAt = verbose.findIndex((node) => node.kind === "heading" && node.text === "Blockers:");
    const nextSection = verbose.findIndex((node, index) => index > blockersAt && node.kind === "heading");
    expect(verbose.slice(blockersAt + 1, nextSection).filter((node) => node.kind === "list-item")).toHaveLength(1);

    const machine = JSON.parse(formatLifecycleJson("status", report)) as {
      readonly globalBlockers: readonly Record<string, unknown>[];
      readonly projects: readonly {
        readonly state: { readonly kind: string; readonly reason?: string };
      }[];
      readonly schemaVersion: number;
    };
    expect(machine.schemaVersion).toBe(14);
    expect(machine.projects[0]!.state).toEqual({
      kind: "malformed ownership state",
      reason: `Installation State exceeds the ${OWNERSHIP_STATE_LIMITS.maxBytes} byte limit`,
    });
    // The machine payload keeps its field shape; the message/problem values are
    // presentation-composed from the typed fact.
    expect(machine.globalBlockers).toEqual([{
      kind: INSTALLATION_STATE_UNREADABLE,
      scope: "global",
      message: `Installation State exceeds the ${OWNERSHIP_STATE_LIMITS.maxBytes} byte limit`,
      problem: `Installation State exceeds the ${OWNERSHIP_STATE_LIMITS.maxBytes} byte limit`,
      requirement: "Lifecycle commands require readable Installation State",
      remedy: "Restore or repair the Installation State file, then retry",
      affectedItems: [{ kind: "path", value: statePath }],
    }]);
    expect(lifecycleExitCode(report)).toBe(2);
  });

  test("blocker builders emit complete typed-fact evidence without prose", () => {
    const stateBlocker = normalizeBlocker(installationStateUnreadableBlocker({
      detail: "EACCES: permission denied",
      statePath: "/home/state/manifest.yaml",
    }));
    expect(stateBlocker).toMatchObject({
      detail: "EACCES: permission denied",
      kind: INSTALLATION_STATE_UNREADABLE,
      scope: "global",
    });
    expect(stateBlocker.project).toBeUndefined();
    expect(stateBlocker.affectedItems).toEqual([{ kind: "path", value: "/home/state/manifest.yaml" }]);
    expect(blockerWording(stateBlocker).problem).toBe("EACCES: permission denied");

    const occupied = normalizeBlocker(occupiedOutputBlocker({
      occupied: { case: "drifted-output" },
      path: ".codex/hooks.json",
      project: "/p",
    }));
    expect(occupied).toMatchObject({
      kind: OCCUPIED_OUTPUT,
      occupied: { case: "drifted-output" },
      project: "/p",
      scope: "project",
    });
    expect(occupied.affectedItems).toEqual([{ kind: "path", value: ".codex/hooks.json" }]);
    expect(blockerWording(occupied).problem).toBe(
      ".codex/hooks.json is occupied by unowned or drifted output",
    );

    const ownership = normalizeBlocker(installationOwnershipBlocker({
      action: "verify",
      failure: { case: "type-mismatch", expected: "file", output: ".codex/hooks.json" },
      project: "/p",
    }));
    expect(ownership).toMatchObject({
      action: "verify",
      failure: { case: "type-mismatch", expected: "file", output: ".codex/hooks.json" },
      kind: INSTALLATION_OWNERSHIP,
      project: "/p",
      scope: "project",
    });
    expect(blockerWording(ownership).problem).toBe(
      "Cannot verify generated-file ownership: owned output .codex/hooks.json is not a file",
    );

    const conflict = normalizeBlocker(temporaryInstallationConflictBlocker({
      project: "/p",
      temporaryInstallationId: "temp-1",
    }));
    expect(conflict).toMatchObject({
      kind: TEMPORARY_INSTALLATION_CONFLICT,
      project: "/p",
      scope: "project",
    });
    expect(conflict.affectedItems).toEqual([{ kind: "installation-id", value: "temp-1" }]);
    expect(blockerWording(conflict).problem).toBe(
      "An active Temporary Profile Installation already owns generated files (temp-1)",
    );
    expect(flatInlineText(humanBlockerWording(conflict).problem)).toBe(
      "An active temporary Profile already owns generated files (temp-1)",
    );

    const unproven = normalizeBlocker(occupiedOutputBlocker({
      occupied: { case: "occupied-parent", occupation: "symlink" },
      path: ".codex/second.json",
      project: "/p",
    }));
    expect(unproven.project).toBe("/p");
    expect(unproven.affectedItems).toEqual([{ kind: "path", value: ".codex/second.json" }]);
    expect(blockerWording(unproven).problem).toBe(
      ".codex/second.json is an occupied symlink parent path",
    );

    const removal = temporaryInstallationRemovalBlocker({
      failure: { case: "symlink-output", output: ".agents/skills/review-pr" },
      outputs: [".agents/skills/review-pr"],
      project: "/p",
    });
    expect(normalizeBlocker(removal)).toMatchObject({
      failure: { case: "symlink-output", output: ".agents/skills/review-pr" },
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
    expect(occupied).toMatchObject({
      occupied: { case: "drifted-output" },
      scope: "project",
      project: canonicalProject,
    });
    expect(blockerWording(occupied).message).toBe(
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
      kind: "update",
      path: ".agent-profile-kit/codex/context.md",
      project: expect.any(String),
    });
    expect(reportOutputs(report)).not.toContainEqual({
      kind: "update",
      path: ".codex/hooks.json",
      project: expect.any(String),
    });
  });

  test("residual ownership Blocker evidence stays provenance-neutral", () => {
    const ownership = normalizeBlocker(installationOwnershipBlocker({
      action: "verify",
      failure: {
        case: "unsafe-parent",
        output: ".codex/hooks.json",
        parent: "/p/.codex is a symlink parent",
      },
      project: "/p",
    }));
    const wording = blockerWording(ownership);
    expect(wording.problem).not.toMatch(/your edit/i);
    expect(wording.remedy).not.toMatch(/Move the change into the Workspace/i);
    expect(wording.message).not.toMatch(/your edit/i);
    expect(wording.message).not.toMatch(/Move the change into the Workspace/i);
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
    const blocker = normalizeBlocker(blockers[0]!);
    expect(blocker).toMatchObject({
      kind: TEMPORARY_INSTALLATION_CONFLICT,
      project: canonicalProject,
      scope: "project",
    });
    expect(blocker.affectedItems).toEqual([]);
    expect(blockerWording(blocker).problem).toBe(
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
