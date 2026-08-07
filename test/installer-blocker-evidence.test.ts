import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  REPOSITORY_EXCLUSION_RECORD,
  repositoryExclusionRecordBlocker,
  TEMPORARY_INSTALLATION_CONFLICT,
  TEMPORARY_INSTALLATION_REMOVAL,
  temporaryInstallationConflictBlocker,
  temporaryInstallationRemovalBlocker,
} from "../installer/blockers.js";
import { statusApplication } from "../installer/commands.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState, stateManifestPath } from "../installer/project-plan.js";
import {
  desiredOutputConflicts,
  manifestFor,
  previewReconciliation,
} from "../installer/reconcile.js";
import { projectConflictBlockers } from "../installer/temporary-installation.js";
import {
  canonicalRepositoryExclusionRecord,
  formatInstallationMarker,
  type InstallationState,
} from "../schemas/installation-manifest.js";

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

function emptyState(): InstallationState {
  return {
    intendedTeardowns: [],
    installations: [],
    repositoryExclusions: [],
    schemaVersion: 5,
    temporaryInstallations: [],
  };
}

function requireDefined<T>(value: T | undefined, description: string): T {
  if (value === undefined) throw new Error(`expected ${description}`);
  return value;
}

describe("structured Installer blocker evidence", () => {
  test("unreadable Installation State emits one structured global blocker", async () => {
    const project = temporaryDirectory("apkit-evidence-project-");
    const home = await prepareHome(project);
    const statePath = stateManifestPath(home);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, "not: a valid installation state\n");

    const report = await statusApplication(home);

    expect(report.blockers).toHaveLength(1);
    const blocker = report.blockers[0]!;
    expect(isStructuredBlocker(blocker)).toBe(true);
    expect(blocker).toMatchObject({
      kind: INSTALLATION_STATE_UNREADABLE,
      scope: "global",
      problem: expect.any(String),
      remedy: expect.any(String),
      requirement: expect.any(String),
    });
    expect(blocker.project).toBeUndefined();
    expect(blocker.message).toContain("Installation State");
    expect(blocker.affectedItems).toEqual([{ kind: "path", value: statePath }]);

    const human = formatLifecycleReport("preview", report);
    expect(human).toContain("Global blockers:");
    expect(human).toContain(blocker.message);
    expect(JSON.parse(formatLifecycleJson("preview", report)).blockers).toEqual([
      { message: blocker.message },
    ]);
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

    const recordBlocker = normalizeBlocker(repositoryExclusionRecordBlocker({
      affectedItems: [{ kind: "installation-id", value: "id-1" }],
      message: "/repo is missing its Repository Exclusion Record for Installation ID id-1",
    }));
    expect(recordBlocker).toMatchObject({
      kind: REPOSITORY_EXCLUSION_RECORD,
      message: "/repo is missing its Repository Exclusion Record for Installation ID id-1",
      scope: "global",
    });
    expect(recordBlocker.project).toBeUndefined();

    const occupied = normalizeBlocker(occupiedOutputBlocker({
      message: "/p/.codex/hooks.json is occupied by unowned or drifted output",
      path: ".codex/hooks.json",
      project: "/p",
    }));
    expect(occupied).toMatchObject({
      kind: OCCUPIED_OUTPUT,
      message: "/p/.codex/hooks.json is occupied by unowned or drifted output",
      project: "/p",
      scope: "project",
    });
    expect(occupied.affectedItems).toEqual([{ kind: "path", value: ".codex/hooks.json" }]);

    const ownership = normalizeBlocker(installationOwnershipBlocker({
      message: "Cannot reconcile Profile Installation at /p: drifted",
      project: "/p",
    }));
    expect(ownership).toMatchObject({
      kind: INSTALLATION_OWNERSHIP,
      message: "Cannot reconcile Profile Installation at /p: drifted",
      project: "/p",
      scope: "project",
    });

    const conflict = normalizeBlocker(temporaryInstallationConflictBlocker({
      message: "/p already has an active Temporary Profile Installation (temp-1)",
      project: "/p",
      temporaryInstallationId: "temp-1",
    }));
    expect(conflict).toMatchObject({
      kind: TEMPORARY_INSTALLATION_CONFLICT,
      message: "/p already has an active Temporary Profile Installation (temp-1)",
      project: "/p",
      scope: "project",
    });
    expect(conflict.affectedItems).toEqual([{ kind: "installation-id", value: "temp-1" }]);

    const removal = temporaryInstallationRemovalBlocker({
      message: "Cannot remove Temporary Profile Installation at /p: Installation Marker is missing",
      outputs: ["/p/.agents/skills/review-pr"],
      project: "/p",
    });
    expect(blockerMessage(removal)).toBe(
      "Cannot remove Temporary Profile Installation at /p: Installation Marker is missing",
    );
    expect(normalizeBlocker(removal)).toMatchObject({
      kind: TEMPORARY_INSTALLATION_REMOVAL,
      project: "/p",
      scope: "project",
    });
  });

  test("a missing Repository Exclusion Record emits structured global evidence", async () => {
    const repository = gitRepository("apkit-evidence-record-");
    const home = await prepareHome(repository);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    const installationId = "recorded-installation-id";
    const manifest = manifestFor(installation, installationId);
    const state: InstallationState = {
      ...emptyState(),
      installations: [manifest],
    };

    const report = await previewReconciliation(desired.installations, state);

    const blocker = requireDefined(
      report.blockers.find(
        (candidate) => isStructuredBlocker(candidate) && candidate.kind === REPOSITORY_EXCLUSION_RECORD,
      ),
      "a structured repository-exclusion-record blocker",
    );
    expect(blocker).toMatchObject({ scope: "global" });
    expect(blocker.project).toBeUndefined();
    expect(blocker.message).toBe(
      `${canonicalProject} is missing its Repository Exclusion Record for Installation ID ${installationId}`,
    );
    expect(blocker.affectedItems).toEqual([{ kind: "installation-id", value: installationId }]);
    expect(lifecycleExitCode(report)).toBe(2);

    // Human output keeps the legacy projection, including the default-view lexicon.
    const human = formatLifecycleReport("preview", report);
    expect(human).toContain("Global blockers:");
    expect(human).toContain("missing its Git exclusion record");
    const machineBlockers = JSON.parse(formatLifecycleJson("preview", report)).blockers as readonly {
      readonly message: string;
    }[];
    expect(machineBlockers.some((candidate) => candidate.message === blocker.message)).toBe(true);
  });

  test("a Repository Exclusion Record on the wrong Git target emits structured global evidence", async () => {
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
    const state: InstallationState = {
      ...emptyState(),
      installations: [manifest],
      repositoryExclusions: [
        canonicalRepositoryExclusionRecord(wrongTarget, [
          { entries: ["/nested/.agent-profile-kit/codex/context.md"], installationId },
        ]),
      ],
    };

    const report = await previewReconciliation(desired.installations, state);

    const blocker = requireDefined(
      report.blockers.find(
        (candidate) => isStructuredBlocker(candidate) && candidate.kind === REPOSITORY_EXCLUSION_RECORD,
      ),
      "a structured repository-exclusion-record blocker",
    );
    expect(blocker).toMatchObject({ scope: "global" });
    expect(blocker.message).toBe(
      `${canonicalProject} Repository Exclusion Record for Installation ID ${installationId} ` +
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
      `${join(canonicalProject, ".codex", "hooks.json")} is occupied by unowned or drifted output`,
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
      report.blockers.find(
        (blocker) => isStructuredBlocker(blocker) && blocker.kind === INSTALLATION_MARKER,
      ),
      "a structured installation-marker blocker",
    );
    expect(marker).toMatchObject({
      kind: INSTALLATION_MARKER,
      project: canonicalProject,
      scope: "project",
      problem: expect.any(String),
      remedy: expect.any(String),
      requirement: expect.any(String),
    });
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
    const state: InstallationState = {
      ...emptyState(),
      installations: [manifest],
    };

    const report = await previewReconciliation(desired.installations, state);

    const ownership = requireDefined(
      report.blockers.find(
        (blocker) => isStructuredBlocker(blocker) && blocker.kind === INSTALLATION_OWNERSHIP,
      ),
      "a structured installation-ownership blocker",
    );
    expect(ownership).toMatchObject({
      kind: INSTALLATION_OWNERSHIP,
      project: canonicalProject,
      scope: "project",
      problem: expect.any(String),
      remedy: expect.any(String),
      requirement: expect.any(String),
    });
    expect(ownership.message).toMatch(/^Cannot reconcile Profile Installation at /);
    expect(ownership.message).toContain("will not overwrite your edit");
  });

  test("temporary installation conflicts emit structured project-scoped evidence", async () => {
    const project = temporaryDirectory("apkit-evidence-temp-");
    const home = await prepareHome(project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const canonicalProject = installation.binding.canonicalProject;
    const manifest = manifestFor(installation, "ordinary-installation-id");
    const state: InstallationState = {
      ...emptyState(),
      installations: [manifest],
    };

    const blockers = projectConflictBlockers(state, canonicalProject);

    expect(blockers).toHaveLength(1);
    expect(normalizeBlocker(blockers[0]!)).toMatchObject({
      kind: TEMPORARY_INSTALLATION_CONFLICT,
      message: `${canonicalProject} already has an ordinary Profile Installation; ` +
        "remove it before installing a temporary Profile",
      project: canonicalProject,
      scope: "project",
    });
    expect(blockerMessage(blockers[0]!)).toBe(
      `${canonicalProject} already has an ordinary Profile Installation; ` +
        "remove it before installing a temporary Profile",
    );
  });
});
