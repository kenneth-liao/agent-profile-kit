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
  INSTALLATION_MARKER,
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
  REPOSITORY_EXCLUSION_SECTION_MISSING,
  REPOSITORY_EXCLUSION_TARGET_UNPROVEN,
  repositoryExclusionContributionBlocker,
  repositoryExclusionTargetUnprovenBlocker,
  TEMPORARY_INSTALLATION_CONFLICT,
  TEMPORARY_INSTALLATION_REMOVAL,
  temporaryInstallationConflictBlocker,
  temporaryInstallationRemovalBlocker,
} from "../installer/blockers.js";
import { statusApplication } from "../installer/commands.js";
import {
  gitExclusionBlockers,
  missingContributionRepairEligibility,
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
import {
  formatInstallationMarker,
} from "../schemas/installation-manifest.js";
import {
  OWNERSHIP_STATE_LIMITS,
  type OwnershipState,
} from "../schemas/ownership-state.js";
import {
  reportBlockers,
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
    schemaVersion: 6,
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
    expect(machine.schemaVersion).toBe(9);
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
    const manifest = manifestFor(installation, installationId);
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

  test("a moved installation with a missing Git exclusion contribution stays blocked", async () => {
    const repository = gitRepository("apkit-evidence-moved-");
    const home = await prepareHome(repository);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const installationId = "moved-installation-id";
    const previousRoot = temporaryDirectory("apkit-evidence-moved-old-");
    const manifest = { ...manifestFor(installation, installationId), project: previousRoot };
    mkdirSync(join(repository, ".agent-profile-kit"), { recursive: true });
    writeFileSync(
      join(repository, ".agent-profile-kit", "installation.json"),
      formatInstallationMarker({ installationId, schemaVersion: 1 }),
    );
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
    expect(lifecycleExitCode(report)).toBe(2);
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
      `${canonicalProject} Git exclusion contribution for Installation ID ${installationId} ` +
        `targets ${wrongTarget}, expected ${expectedTarget}`,
    );
    expect(blocker.affectedItems).toEqual([
      { kind: "path", value: wrongTarget },
      { kind: "path", value: expectedTarget },
    ]);
  });

  test("occupied planned output emits structured project-scoped evidence", async () => {
    const project = temporaryDirectory("apkit-evidence-occupied-");
    const home = await prepareHome(project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "hooks.json"), "occupied\n");

    const conflicts = await desiredOutputConflicts(installation, undefined, "temporary-id");
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

  test("a malformed Installation Marker emits structured project-scoped evidence", async () => {
    const project = temporaryDirectory("apkit-evidence-marker-");
    const home = await prepareHome(project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    mkdirSync(join(project, ".agent-profile-kit"), { recursive: true });
    writeFileSync(join(project, ".agent-profile-kit", "installation.json"), "not a marker\n");

    const report = await previewReconciliation(desired.installations, emptyState());

    const marker = requireDefined(
      reportBlockers(report).find(
        (blocker) => isStructuredBlocker(blocker) && blocker.kind === INSTALLATION_MARKER,
      ),
      "a structured installation-marker blocker",
    );
    expect(marker).toMatchObject({
      kind: INSTALLATION_MARKER,
      project: canonicalProject,
      scope: "project",
    });
    // Plain value checks: asymmetric matchers in toMatchObject replace the
    // matched properties on the shared blocker, corrupting later JSON reads.
    for (const field of ["problem", "remedy", "requirement"] as const) {
      expect(typeof marker[field]).toBe("string");
      expect(marker[field].length).toBeGreaterThan(0);
    }
    expect(marker.message).toContain("is malformed");
    expect(lifecycleExitCode(report)).toBe(2);
  });

  test("drifted generated output emits structured project-scoped ownership evidence", async () => {
    const project = temporaryDirectory("apkit-evidence-drift-");
    const home = await prepareHome(project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    const installationId = "evidence-installation-id";
    const manifest = manifestFor(installation, installationId);
    mkdirSync(join(project, ".agent-profile-kit"), { recursive: true });
    writeFileSync(
      join(project, ".agent-profile-kit", "installation.json"),
      formatInstallationMarker({ installationId, schemaVersion: 1 }),
    );
    for (const output of installation.outputs) {
      const destination = join(canonicalProject, output.path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, "drifted content\n");
    }
    const state: OwnershipState = {
      ...emptyState(),
      receipts: [manifest],
    };

    const report = await previewReconciliation(desired.installations, state);

    const ownership = requireDefined(
      reportBlockers(report).find(
        (blocker) => isStructuredBlocker(blocker) && blocker.kind === INSTALLATION_OWNERSHIP,
      ),
      "a structured installation-ownership blocker",
    );
    expect(ownership).toMatchObject({
      kind: INSTALLATION_OWNERSHIP,
      project: canonicalProject,
      scope: "project",
    });
    // Plain value checks: asymmetric matchers in toMatchObject replace the
    // matched properties on the shared blocker, corrupting later JSON reads.
    for (const field of ["problem", "remedy", "requirement"] as const) {
      expect(typeof ownership[field]).toBe("string");
      expect(ownership[field].length).toBeGreaterThan(0);
    }
    expect(ownership.message).toMatch(/^Cannot sync the generated file:/);
    expect(ownership.message).toContain("will not overwrite your edit");
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

  test("a missing recorded exclusion section during retirement emits structured Project evidence", async () => {
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
    const blocker = requireDefined(
      reportBlockers(report).find(
        (candidate) =>
          isStructuredBlocker(candidate) &&
          candidate.kind === REPOSITORY_EXCLUSION_SECTION_MISSING,
      ),
      "a structured repository-exclusion-section-missing blocker",
    );
    expect(blocker).toMatchObject({ project: realpathSync(repository), scope: "project" });
    expect(blocker.message).toBe(
      ".git/info/exclude is missing its Agent Profile Kit exclusion section; " +
        "intentional-deletion retirement requires the recorded section to be present",
    );
    expect(blocker.affectedItems).toEqual([{ kind: "path", value: exclude }]);
    expect(lifecycleExitCode(report)).toBe(2);
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
