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
  REPOSITORY_EXCLUSION_INVALID,
  REPOSITORY_EXCLUSION_CONTRIBUTION,
  REPOSITORY_EXCLUSION_TARGET_UNPROVEN,
  repositoryExclusionContributionBlocker,
  repositoryExclusionTargetUnprovenBlocker,
  TEMPORARY_INSTALLATION_CONFLICT,
  TEMPORARY_INSTALLATION_REMOVAL,
  temporaryInstallationConflictBlocker,
  temporaryInstallationRemovalBlocker,
} from "../installer/blockers.js";
import { isRetiringSectionRepair } from "../installer/safe-repair.js";
import { statusApplication } from "../installer/commands.js";
import {
  gitExclusionBlockers,
  missingContributionRepairEligibility,
  movedContributionRepairEligibility,
  staleContributionRepairEligibility,
} from "../installer/git-exclusions.js";
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

    const contributionBlocker = normalizeBlocker(repositoryExclusionContributionBlocker({
      affectedItems: [{ kind: "installation-id", value: "id-1" }],
      message: "/repo is missing its Git exclusion contribution for Installation ID id-1",
    }));
    expect(contributionBlocker).toMatchObject({
      kind: REPOSITORY_EXCLUSION_CONTRIBUTION,
      message: "/repo is missing its Git exclusion contribution for Installation ID id-1",
      scope: "global",
    });
    expect(contributionBlocker.project).toBeUndefined();

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

    const unproven = normalizeBlocker(repositoryExclusionTargetUnprovenBlocker({
      message: "/p Git target cannot be proven: project root is missing",
      project: "/p",
    }));
    expect(unproven).toMatchObject({
      kind: REPOSITORY_EXCLUSION_TARGET_UNPROVEN,
      message: "/p Git target cannot be proven: project root is missing",
      project: "/p",
      scope: "project",
    });
    // Plain value checks: asymmetric matchers in toMatchObject replace the
    // matched properties on the shared blocker, corrupting later JSON reads.
    for (const field of ["problem", "remedy", "requirement"] as const) {
      expect(typeof unproven[field]).toBe("string");
      expect(unproven[field].length).toBeGreaterThan(0);
    }
    expect(unproven.project).toBe("/p");
    expect(unproven.affectedItems).toEqual([{ kind: "path", value: "/p" }]);

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

  test("a missing Git exclusion contribution emits structured global evidence", async () => {
    const repository = gitRepository("apkit-evidence-record-");
    const home = await prepareHome(repository);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    const installationId = "recorded-installation-id";
    // Project Binding scope alone identifies the recorded installation now
    // that the Marker is gone, so an otherwise-current receipt proves an
    // eligible missing-contribution Safe Repair instead of blocking. A stale
    // recorded desired input keeps the receipt from proving the exact
    // contribution, so the missing contribution stays a global blocker.
    const manifest = {
      ...manifestFor(installation, installationId),
      desiredInputDigest: "stale-recorded-source-digest",
    };
    const state: OwnershipState = {
      ...emptyState(),
      receipts: [manifest],
    };

    const report = await previewReconciliation(desired.installations, state);

    const blocker = requireDefined(
      reportBlockers(report).find(
        (candidate) => isStructuredBlocker(candidate) && candidate.kind === REPOSITORY_EXCLUSION_CONTRIBUTION,
      ),
      "a structured repository-exclusion-contribution blocker",
    );
    expect(blocker).toMatchObject({ scope: "global" });
    expect(blocker.project).toBeUndefined();
    expect(blocker.message).toBe(
      `${canonicalProject} is missing its Git exclusion contribution for Installation ID ${installationId}`,
    );
    expect(blocker.affectedItems).toEqual([{ kind: "installation-id", value: installationId }]);
    expect(lifecycleExitCode(report)).toBe(2);

    // Human output keeps the message projection, including the default-view lexicon.
    const human = formatLifecycleReport("status", report);
    expect(human).toContain("Global blockers:");
    expect(human).toContain("missing its Git exclusion contribution");
    const machine = JSON.parse(formatLifecycleJson("status", report)) as {
      readonly globalBlockers: readonly Record<string, unknown>[];
    };
    expect(machine.globalBlockers.some(
      (candidate) => candidate.message === blocker.message
    )).toBe(true);
    expect(machine.globalBlockers.some(
      (candidate) => candidate.kind === REPOSITORY_EXCLUSION_CONTRIBUTION
    )).toBe(true);
    expect(machine.globalBlockers.some((candidate) => candidate.scope === "global")).toBe(true);
    expect(machine.globalBlockers.some((candidate) => (
      candidate.affectedItems as readonly { kind: string; value: string }[]
    ).some((item) => item.kind === "installation-id" && item.value === installationId))).toBe(true);
  });

  test("missing-contribution eligibility distinguishes unreadable bytes from mismatched entries", async () => {
    const repository = gitRepository("apkit-evidence-eligibility-");
    const home = await prepareHome(repository);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const git = requireDefined(installation.gitProject, "a desired Git target");
    const receipt = manifestFor(installation, "eligibility-installation-id");
    const exclude = join(repository, ".git", "info", "exclude");

    writeFileSync(
      exclude,
      "# BEGIN Agent Profile Kit generated paths\n/unowned/entry\n# END Agent Profile Kit generated paths\n",
    );
    const mismatched = await missingContributionRepairEligibility(receipt, git, emptyState());
    expect(mismatched).toEqual({
      cause: "incoherent-exclusion-bytes",
      eligible: false,
    });

    rmSync(exclude);
    symlinkSync(join(repository, "README.md"), exclude);
    const unreadable = await missingContributionRepairEligibility(receipt, git, emptyState());
    expect(unreadable).toEqual({
      cause: "unreadable-exclusion-bytes",
      eligible: false,
    });
  });

  test("stale-contribution eligibility distinguishes stale, current, and unprovable recorded entries", async () => {
    const repository = gitRepository("apkit-evidence-stale-eligibility-");
    const home = await prepareHome(repository);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const git = requireDefined(installation.gitProject, "a desired Git target");
    const exclude = join(repository, ".git", "info", "exclude");
    const staleEntries = ["/unowned/stale"];
    const receipt = {
      ...manifestFor(installation, "stale-eligibility-installation-id"),
      repositoryExclusion: { target: git.excludeFile, entries: staleEntries },
    };
    const state: OwnershipState = { ...emptyState(), receipts: [receipt] };

    writeFileSync(
      exclude,
      "# BEGIN Agent Profile Kit generated paths\n/unowned/stale\n# END Agent Profile Kit generated paths\n",
    );
    const eligible = await staleContributionRepairEligibility(receipt, git, state);
    if (!eligible.eligible) throw new Error("expected an eligible stale-contribution repair");
    expect(eligible.repair).toMatchObject({
      class: "stale-contribution",
      currentEntries: staleEntries,
      installationId: receipt.installationId,
      target: git.excludeFile,
    });
    expect(eligible.repair.entries).toEqual([
      "/.agent-profile-kit/codex/context.md",
      "/.codex/hooks.json",
    ]);

    // A recorded contribution that already equals its receipt's derived entries
    // is not stale, so repeating status stays current.
    const currentReceipt = {
      ...receipt,
      repositoryExclusion: { target: git.excludeFile, entries: [...eligible.repair.entries] },
    };
    const current = await staleContributionRepairEligibility(
      currentReceipt,
      git,
      { ...emptyState(), receipts: [currentReceipt] },
    );
    expect(current).toEqual({ cause: "unchanged-contribution", eligible: false });

    rmSync(exclude);
    const missingSection = await staleContributionRepairEligibility(receipt, git, state);
    expect(missingSection).toEqual({ cause: "incoherent-exclusion-bytes", eligible: false });

    writeFileSync(
      exclude,
      "# BEGIN Agent Profile Kit generated paths\n/unowned/other\n# END Agent Profile Kit generated paths\n",
    );
    const mismatched = await staleContributionRepairEligibility(receipt, git, state);
    expect(mismatched).toEqual({ cause: "incoherent-exclusion-bytes", eligible: false });

    const wrongTarget = await staleContributionRepairEligibility(
      {
        ...receipt,
        repositoryExclusion: { target: join(repository, "other-exclude"), entries: staleEntries },
      },
      git,
      state,
    );
    expect(wrongTarget).toEqual({ cause: "wrong-target", eligible: false });

    rmSync(exclude);
    symlinkSync(join(repository, "README.md"), exclude);
    const unreadable = await staleContributionRepairEligibility(receipt, git, state);
    expect(unreadable).toEqual({ cause: "unreadable-exclusion-bytes", eligible: false });
  });

  test("moved-contribution eligibility distinguishes a provable two-target move from unprovable targets", async () => {
    const repository = gitRepository("apkit-evidence-move-eligibility-");
    const previousRepository = gitRepository("apkit-evidence-move-old-");
    const home = await prepareHome(repository);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const git = requireDefined(installation.gitProject, "a desired Git target");
    const exclude = join(repository, ".git", "info", "exclude");
    const currentTarget = join(previousRepository, ".git", "info", "exclude");
    const current = ["/legacy-owned-entry"];
    const receipt = {
      ...manifestFor(installation, "move-eligibility-installation-id"),
      repositoryExclusion: { entries: current, target: currentTarget },
    };
    const state: OwnershipState = { ...emptyState(), receipts: [receipt] };
    const next = [...new Set(
      receipt.outputs.map((output) => `/${output.path}`),
    )].sort();

    writeFileSync(
      currentTarget,
      "# BEGIN Agent Profile Kit generated paths\n" +
        "/legacy-owned-entry\n" +
        "# END Agent Profile Kit generated paths\n",
    );
    const eligible = await movedContributionRepairEligibility(receipt, git, state);
    if (!eligible.eligible) throw new Error("expected an eligible moved-contribution repair");
    expect(eligible.repair).toEqual({
      class: "moved-contribution",
      current,
      currentTarget,
      installationId: receipt.installationId,
      next,
      nextTarget: git.excludeFile,
    });

    // The new target's entries derive from the live GitProject's own
    // relativeProject — the worktree toplevel for a linked worktree — never
    // from the common-directory exclude root.
    const worktreeGit = {
      commonDirectory: join(repository, ".git"),
      excludeFile: git.excludeFile,
      relativeProject: "app",
      root: temporaryDirectory("apkit-evidence-move-wt-root-"),
    };
    const worktreeEligible = await movedContributionRepairEligibility(receipt, worktreeGit, state);
    if (!worktreeEligible.eligible) {
      throw new Error("expected an eligible linked-worktree moved-contribution repair");
    }
    expect(worktreeEligible.repair.next).toEqual([...new Set(
      receipt.outputs.map((output) => `/app/${output.path}`),
    )].sort());
    expect(worktreeEligible.repair.nextTarget).toBe(git.excludeFile);

    // The old target's owned section must match the recorded union exactly.
    writeFileSync(
      currentTarget,
      "# BEGIN Agent Profile Kit generated paths\n" +
        "/legacy-owned-entry\n" +
        "/unexpected/entry\n" +
        "# END Agent Profile Kit generated paths\n",
    );
    const driftedOld = await movedContributionRepairEligibility(receipt, git, state);
    expect(driftedOld).toEqual({ cause: "incoherent-exclusion-bytes", eligible: false });

    writeFileSync(currentTarget, "unrelated content without an owned section\n");
    const missingOldSection = await movedContributionRepairEligibility(receipt, git, state);
    expect(missingOldSection).toEqual({ cause: "incoherent-exclusion-bytes", eligible: false });

    rmSync(currentTarget);
    symlinkSync(join(previousRepository, "README.md"), currentTarget);
    const unreadableOld = await movedContributionRepairEligibility(receipt, git, state);
    expect(unreadableOld).toEqual({ cause: "unreadable-exclusion-bytes", eligible: false });

    // The new target's owned section must be absent or match its recorded union.
    rmSync(currentTarget);
    writeFileSync(
      currentTarget,
      "# BEGIN Agent Profile Kit generated paths\n" +
        "/.agent-profile-kit/installation.json\n" +
        "/legacy-owned-entry\n" +
        "# END Agent Profile Kit generated paths\n",
    );
    writeFileSync(
      exclude,
      "# BEGIN Agent Profile Kit generated paths\n/unowned/foreign-entry\n# END Agent Profile Kit generated paths\n",
    );
    const driftedNew = await movedContributionRepairEligibility(receipt, git, state);
    expect(driftedNew).toEqual({ cause: "incoherent-exclusion-bytes", eligible: false });

    rmSync(exclude);
    symlinkSync(join(repository, "README.md"), exclude);
    const unreadableNew = await movedContributionRepairEligibility(receipt, git, state);
    expect(unreadableNew).toEqual({ cause: "unreadable-exclusion-bytes", eligible: false });

    // A recorded contribution already at the live target is not a move.
    rmSync(exclude);
    const sameTargetReceipt = {
      ...receipt,
      repositoryExclusion: { entries: next, target: git.excludeFile },
    };
    const sameTarget = await movedContributionRepairEligibility(
      sameTargetReceipt,
      git,
      { ...emptyState(), receipts: [sameTargetReceipt] },
    );
    expect(sameTarget).toEqual({ cause: "wrong-target", eligible: false });
  });

  test("a Git exclusion contribution on the wrong Git target emits structured global evidence", async () => {
    const repository = gitRepository("apkit-evidence-target-");
    const other = gitRepository("apkit-evidence-target-other-");
    const home = await prepareHome(repository);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    const installationId = "recorded-installation-id";
    const manifest = manifestFor(installation, installationId);
    const expectedTarget = join(repository, ".git", "info", "exclude");
    const wrongTarget = join(other, ".git", "info", "exclude");
    const state: OwnershipState = {
      ...emptyState(),
      receipts: [{
        ...manifest,
        repositoryExclusion: {
          entries: ["/nested/.agent-profile-kit/codex/context.md"],
          target: wrongTarget,
        },
      }],
    };

    const report = await previewReconciliation(desired.installations, state);

    const blocker = requireDefined(
      reportBlockers(report).find(
        (candidate) => isStructuredBlocker(candidate) && candidate.kind === REPOSITORY_EXCLUSION_CONTRIBUTION,
      ),
      "a structured repository-exclusion-contribution blocker",
    );
    expect(blocker).toMatchObject({ scope: "global" });
    expect(blocker.message).toBe(
      `${expectedTarget} Git exclusion contribution for Installation ID ${installationId} ` +
        `cannot be moved from ${wrongTarget}: an owned section does not match the ` +
        "recorded entries; restore the recorded section before retrying",
    );
    expect(blocker.affectedItems).toContainEqual(
      { kind: "installation-id", value: installationId },
    );
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

  test("Git exclusion blockers keep canonical deterministic ordering", async () => {
    const parent = temporaryDirectory("apkit-evidence-order-");
    const upperRaw = join(parent, "B");
    const lowerRaw = join(parent, "a");
    for (const directory of [upperRaw, lowerRaw]) {
      mkdirSync(directory);
      execFileSync("git", ["init", "-q", directory]);
      execFileSync("git", ["-C", directory, "config", "user.email", "tests@example.com"]);
      execFileSync("git", ["-C", directory, "config", "user.name", "Agent Profile Kit Tests"]);
      writeFileSync(join(directory, "README.md"), "fixture\n");
      execFileSync("git", ["-C", directory, "add", "README.md"]);
      execFileSync("git", ["-C", directory, "commit", "-qm", "fixture"]);
    }
    const upper = realpathSync(upperRaw);
    const lower = realpathSync(lowerRaw);
    const home = temporaryDirectory("apkit-evidence-order-home-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${join(application, "workspace")}\nbindings:\n` +
        `  - project: ${upper}\n    profile: example\n    hosts: [codex]\n` +
        `  - project: ${lower}\n    profile: example\n    hosts: [codex]\n`,
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const state: OwnershipState = {
      ...emptyState(),
      receipts: desired.installations.map((installation) =>
        manifestFor(installation, `recorded-${basename(installation.binding.canonicalProject)}`),
      ),
    };

    const blockers = await gitExclusionBlockers(state, desired.installations);
    const contributionBlockers = blockers.filter(
      (blocker) => isStructuredBlocker(blocker) && blocker.kind === REPOSITORY_EXCLUSION_CONTRIBUTION,
    );

    // Canonical code-point ordering places the uppercase path before the
    // lowercase path; locale collation would reverse them.
    expect(contributionBlockers).toHaveLength(2);
    expect(contributionBlockers.map((blocker) => blocker.message)).toEqual([
      `${upper} is missing its Git exclusion contribution for Installation ID recorded-B`,
      `${lower} is missing its Git exclusion contribution for Installation ID recorded-a`,
    ]);
  });

  test("an unprovable recorded Git target emits structured Project evidence", async () => {
    const project = gitRepository("apkit-evidence-target-unproven-");
    const home = await prepareHome(project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const installedState = await readInstallationState(home);
    const missingProject = join(home, "vanished-project");
    const state: OwnershipState = {
      ...installedState,
      receipts: installedState.receipts.map((receipt) => ({
        ...receipt,
        project: missingProject,
      })),
    };

    const blockers = await gitExclusionBlockers(state, [], {
      validateRecordedInstallations: true,
    });
    const blocker = requireDefined(
      blockers.find(
        (candidate) =>
          isStructuredBlocker(candidate) && candidate.kind === REPOSITORY_EXCLUSION_TARGET_UNPROVEN,
      ),
      "a structured repository-exclusion-target-unproven blocker",
    );
    expect(blocker).toMatchObject({ project: missingProject, scope: "project" });
    expect(blocker.message).toBe(
      `${missingProject} Git target cannot be proven: project root is missing`,
    );
    expect(blocker.affectedItems).toEqual([{ kind: "path", value: missingProject }]);
  });

  test("a missing recorded exclusion section during retirement emits Safe Repair evidence", async () => {
    const repository = gitRepository("apkit-evidence-retire-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    const home = temporaryDirectory("apkit-evidence-retire-home-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const bindings =
      `  - project: ${repository}\n    profile: example\n    hosts: [codex]\n` +
      `  - project: ${nested}\n    profile: example\n    hosts: [codex]\n`;
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${join(application, "workspace")}\nbindings:\n${bindings}`,
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const exclude = join(repository, ".git", "info", "exclude");
    rmSync(exclude);
    rmSync(nested, { recursive: true });
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${join(application, "workspace")}\nbindings:\n` +
        `  - project: ${repository}\n    profile: example\n    hosts: [codex]\n`,
    );
    const desiredAfter = await buildDesiredState(home, { checkHostCapability: false });
    const state = await readInstallationState(home);

    const report = await previewReconciliation(desiredAfter.installations, state);

    expect(reportBlockers(report)).toEqual([]);
    const retiringProject = requireDefined(
      report.projects.find((project) => project.state.kind === "removal"),
      "a removal Project record for the retiring installation",
    );
    expect(retiringProject.repositoryExclusionRepairs).toHaveLength(1);
    const repair = retiringProject.repositoryExclusionRepairs[0]!;
    expect(repair.class).toBe("retiring-exclusion-section");
    if (!isRetiringSectionRepair(repair)) throw new Error("unexpected repair class");
    expect(repair.target).toBe(`${realpathSync(join(repository, ".git", "info"))}/exclude`);
    expect(repair.entries.length).toBeGreaterThan(0);
    expect(lifecycleExitCode(report)).toBe(0);
  });

  test("a malformed recorded exclusion section emits structured Project evidence", async () => {
    const repository = gitRepository("apkit-evidence-invalid-");
    const home = await prepareHome(repository);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const exclude = join(repository, ".git", "info", "exclude");
    writeFileSync(exclude, "# BEGIN Agent Profile Kit generated paths\nbroken section\n");
    const state = await readInstallationState(home);

    const report = await previewReconciliation(desired.installations, state);
    const blocker = requireDefined(
      reportBlockers(report).find(
        (candidate) =>
          isStructuredBlocker(candidate) && candidate.kind === REPOSITORY_EXCLUSION_INVALID,
      ),
      "a structured repository-exclusion-invalid blocker",
    );
    expect(blocker).toMatchObject({ project: realpathSync(repository), scope: "project" });
    expect(blocker.message).toContain("Agent Profile Kit exclusion section");
    expect(blocker.affectedItems).toEqual([{ kind: "path", value: exclude }]);
    expect(lifecycleExitCode(report)).toBe(2);
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
