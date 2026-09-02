import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  buildDesiredState,
  stateManifestPath,
  type DesiredState,
} from "../installer/project-plan.js";
import {
  applyReconciliation,
  nodeFileSystem,
  previewReconciliation,
  type ReconciliationReport,
} from "../installer/reconcile.js";
import { readInstallationState } from "../installer/installation-state.js";
import type { LifecycleOwnershipInspection } from "../installer/lifecycle-ownership-inspection.js";
import type { LifecycleGitInspection } from "../installer/lifecycle-git-inspection.js";
import {
  createProjectReadScheduler,
  DEFAULT_PROJECT_CONCURRENCY,
} from "../installer/project-scheduler.js";
import { OWNERSHIP_STATE_SCHEMA_VERSION, type OwnershipState } from "../schemas/ownership-state.js";
import {
  reportBlockers,
  reportDesired,
  reportItems,
  reportOutputs,
  reportRepositoryExclusions,
  reportWarnings,
} from "./support/reconciliation-report.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function gitRepository(prefix: string): string {
  const path = temporaryDirectory(prefix);
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
  return path;
}

function writeSkill(workspace: string, id: string): void {
  const skillRoot = join(workspace, "skills", id);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${id}\ndescription: Skill ${id}.\n---\n\n# ${id}\n`,
  );
}

/** Mixed Host sets for the 12-Project fleet: Git and plain, single and multi-Host. */
const FLEET_HOSTS: readonly (readonly string[])[] = [
  ["codex"], ["codex"], ["codex"],
  ["codex", "claude"], ["codex", "claude"], ["codex", "claude"],
  ["codex", "pi"], ["codex", "pi"], ["codex", "pi"],
  ["codex", "claude", "grok", "pi"],
  ["codex", "claude", "grok", "pi"],
  ["codex", "claude", "grok", "pi"],
];

async function fleetWorkspace(options: {
  readonly gitProjectCount?: number;
  readonly home: string;
  readonly hostSets?: readonly (readonly string[])[];
}): Promise<readonly string[]> {
  await initializeWorkspace(options.home);
  mkdirSync(join(options.home, ".codex"), { recursive: true });
  writeFileSync(join(options.home, ".codex", "config.toml"), "[features]\nhooks = true\n");
  const application = join(options.home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  writeSkill(workspace, "review-pr");
  writeSkill(workspace, "ops-run");
  writeFileSync(
    join(workspace, "profiles", "engineering.yaml"),
    "id: engineering\ncontext: [team-rules]\nskills: [review-pr, ops-run]\n",
  );
  const hostSets = options.hostSets ?? [["codex"]];
  const projects: string[] = [];
  const bindingLines: string[] = [];
  for (let index = 0; index < hostSets.length; index += 1) {
    const project = index < (options.gitProjectCount ?? 0)
      ? gitRepository(`apk-concurrency-repo-${index}-`)
      : temporaryDirectory(`apk-concurrency-project-${index}-`);
    projects.push(project);
    bindingLines.push(
      `  - project: ${project}\n    profile: engineering\n` +
        `    hosts: [${hostSets[index]!.join(", ")}]\n`,
    );
  }
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${bindingLines.join("")}`,
  );
  return projects;
}

function emptyState(): OwnershipState {
  return {
    receipts: [],
    removedTemporaryInstallationIds: [],
    schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
  };
}

/** A promise whose settlement is controlled explicitly by the test. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Track how many scheduler tasks have started; wait for a count without sleeps. */
function startWaiter(): {
  readonly started: () => number;
  readonly onTaskStart: () => void;
  readonly waitFor: (count: number) => Promise<void>;
} {
  let started = 0;
  const listeners = new Set<() => void>();
  return {
    started: () => started,
    onTaskStart: () => {
      started += 1;
      for (const listener of [...listeners]) listener();
    },
    waitFor: (count: number) => {
      if (started >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const listener = (): void => {
          if (started >= count) {
            listeners.delete(listener);
            resolve();
          }
        };
        listeners.add(listener);
      });
    },
  };
}

/**
 * A Git inspection whose per-Project topology resolution gates on externally
 * released promises once per Project, recording the peak in-flight count.
 */
function gatedGitInspection(projectCount: number): {
  readonly gates: readonly (() => void)[];
  readonly inspection: LifecycleGitInspection;
  readonly maxInFlight: () => number;
} {
  const gates = Array.from({ length: projectCount }, deferred);
  let inFlight = 0;
  let maxInFlight = 0;
  let call = 0;
  return {
    gates: gates.map((gate) => gate.release),
    inspection: {
      classifyTrackedDestinations: async () => new Set(),
      findGitProject: async () => {
        const gate = gates[call]!;
        call += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate.promise;
        inFlight -= 1;
        return undefined;
      },
      readExcludeSnapshot: async () => ({
        bytes: Buffer.alloc(0),
        exists: true,
        mode: 0o644,
        targetMissing: false,
      }),
    },
    maxInFlight: () => maxInFlight,
  };
}

/**
 * An ownership inspection whose first Marker read per Project gates on an
 * externally released promise, proving reconciliation overlaps independent
 * Project inspections. Later calls for the same Project pass through.
 */
function gatedOwnershipInspection(projectCount: number): {
  readonly gates: readonly (() => void)[];
  readonly inspection: LifecycleOwnershipInspection;
  readonly maxInFlight: () => number;
} {
  const gates: (() => void)[] = [];
  const pending = new Set<string>();
  let inFlight = 0;
  let maxInFlight = 0;
  const gateOnce = (project: string): Promise<void> => {
    if (pending.has(project)) return Promise.resolve();
    pending.add(project);
    const gate = deferred();
    gates.push(gate.release);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return gate.promise.finally(() => {
      inFlight -= 1;
    });
  };
  return {
    gates,
    inspection: {
      inspectOutput: async () => ({ kind: "missing" as const }),
      unsafeParent: async (project: string) => {
        await gateOnce(project);
        return undefined;
      },
    },
    maxInFlight: () => maxInFlight,
  };
}

function canonicalProjects(desired: DesiredState): readonly string[] {
  return desired.installations.map((installation) => installation.binding.canonicalProject);
}

function desiredProjection(desired: DesiredState): unknown {
  return desired.installations.map((installation) => ({
    adapterVersion: installation.adapterVersion,
    canonicalProject: installation.binding.canonicalProject,
    gitRoot: installation.gitProject?.root,
    hostVersions: installation.hostVersions,
    outputs: installation.outputs.map((output) => ({
      hash: output.hash,
      mode: output.mode,
      path: output.path,
      type: output.type,
    })),
    profile: installation.profile.id,
    sourceHash: installation.sourceHash,
    warnings: installation.warnings,
  }));
}

function reportProjection(report: ReconciliationReport): unknown {
  return {
    blockers: reportBlockers(report),
    desired: reportDesired(report).map((installation) => ({
      canonicalProject: installation.canonicalProject,
      hosts: installation.hosts,
      outputs: installation.outputs,
      profile: installation.profile,
      setupSteps: installation.setupSteps,
    })),
    items: reportItems(report),
    outputs: reportOutputs(report),
    repositoryExclusions: reportRepositoryExclusions(report),
    warnings: reportWarnings(report),
  };
}

describe("lifecycle Project concurrency through one shared scheduler", () => {
  test("plans independent Projects with bounded overlap through the shared scheduler", async () => {
    const home = temporaryDirectory("apk-concurrency-plan-overlap-");
    await fleetWorkspace({
      home,
      hostSets: Array.from({ length: 8 }, () => ["codex"]),
    });
    const gated = gatedGitInspection(8);
    const waiter = startWaiter();
    const scheduler = createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY, waiter);

    const desiredPromise = buildDesiredState(home, {
      checkHostCapability: false,
      gitInspection: gated.inspection,
      scheduler,
    });

    // Four Project plans are in flight simultaneously: topology resolution
    // overlaps through the scheduler rather than running one Project at a time.
    await waiter.waitFor(DEFAULT_PROJECT_CONCURRENCY);
    expect(gated.maxInFlight()).toBe(DEFAULT_PROJECT_CONCURRENCY);
    expect(gated.maxInFlight()).toBeGreaterThan(1);

    for (const release of gated.gates) release();
    const desired = await desiredPromise;
    expect(desired.installations).toHaveLength(8);
    expect(canonicalProjects(desired)).toEqual([...canonicalProjects(desired)].sort());
  });

  test("reconciliation overlaps independent Project inspections within the bound", async () => {
    const home = temporaryDirectory("apk-concurrency-reconcile-overlap-");
    await fleetWorkspace({
      home,
      hostSets: Array.from({ length: 8 }, () => ["codex"]),
    });
    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
    });
    // Establish recorded installations so each Project's ownership proof reads
    // through the gated inspection context.
    await applyReconciliation(home, desired.installations);
    const state = await readInstallationState(home);
    const gated = gatedOwnershipInspection(8);
    const waiter = startWaiter();
    const scheduler = createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY, waiter);

    const reportPromise = previewReconciliation(desired.installations, state, {
      ownershipInspection: gated.inspection,
      scheduler,
    });

    await waiter.waitFor(DEFAULT_PROJECT_CONCURRENCY);
    expect(gated.maxInFlight()).toBe(DEFAULT_PROJECT_CONCURRENCY);
    expect(gated.maxInFlight()).toBeGreaterThan(1);

    // Release the first wave; the second wave starts and gates again, and must
    // stay within the bound before both waves complete.
    const firstWave = gated.gates.length;
    for (let index = 0; index < firstWave; index += 1) gated.gates[index]!();
    await waiter.waitFor(8);
    expect(gated.maxInFlight()).toBeLessThanOrEqual(DEFAULT_PROJECT_CONCURRENCY);
    for (let index = firstWave; index < gated.gates.length; index += 1) gated.gates[index]!();
    const report = await reportPromise;
    expect(reportBlockers(report)).toEqual([]);
    expect(reportItems(report)).toHaveLength(8);
    expect(reportItems(report).every((item) =>
      item.kind === "current" || item.kind === "repairable missing output"
    )).toBe(true);
    // Canonical Project ordering is preserved despite concurrent completion.
    expect(reportItems(report).map((item) => item.project)).toEqual(
      [...reportItems(report).map((item) => item.project)].sort(),
    );
  });

  test("one shared scheduler spans planning and reconciliation without drift", async () => {
    const home = temporaryDirectory("apk-concurrency-shared-scheduler-");
    await fleetWorkspace({ home, gitProjectCount: 3, hostSets: FLEET_HOSTS });
    const waiter = startWaiter();
    const scheduler = createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY, waiter);

    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      scheduler,
    });
    const report = await previewReconciliation(desired.installations, emptyState(), {
      scheduler,
    });

    expect(desired.installations).toHaveLength(FLEET_HOSTS.length);
    expect(reportBlockers(report)).toEqual([]);
    expect(reportItems(report)).toHaveLength(FLEET_HOSTS.length);
    // Planning (12) and reconciliation (retirement + per-Project loop) all ran
    // through the same scheduler instance with one fixed bound.
    expect(waiter.started()).toBeGreaterThanOrEqual(24);
    expect(reportItems(report).map((item) => item.project)).toEqual(
      [...reportItems(report).map((item) => item.project)].sort(),
    );
  });

  test("concurrent planning and reconciliation equal the sequential result for a 12-Project fleet", async () => {
    const home = temporaryDirectory("apk-concurrency-equivalence-");
    await fleetWorkspace({ home, gitProjectCount: 3, hostSets: FLEET_HOSTS });

    const concurrent = await buildDesiredState(home, {
      checkHostCapability: false,
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
    });
    const sequential = await buildDesiredState(home, {
      checkHostCapability: false,
      scheduler: createProjectReadScheduler(1),
    });
    expect(desiredProjection(concurrent)).toEqual(desiredProjection(sequential));

    const concurrentReport = await previewReconciliation(
      concurrent.installations,
      emptyState(),
      { scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY) },
    );
    const sequentialReport = await previewReconciliation(
      sequential.installations,
      emptyState(),
      { scheduler: createProjectReadScheduler(1) },
    );
    expect(reportProjection(concurrentReport)).toEqual(reportProjection(sequentialReport));
  });

  test("a read failure during reconciliation propagates and blocks apply writes", async () => {
    const home = temporaryDirectory("apk-concurrency-failure-");
    const projects = await fleetWorkspace({
      home,
      hostSets: [["codex"], ["codex"], ["codex"]],
    });
    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
    });
    await applyReconciliation(home, desired.installations, {
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
    });
    const stateBefore = await readInstallationState(home);

    // A fresh ownership inspection fails one Project's output read during the
    // preflight pass; the failure must propagate before any write.
    const failingProject = desired.installations[0]!.binding.canonicalProject;
    const failure = new Error("injected output inspection failure");
    await expect(applyReconciliation(home, desired.installations, {
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
      createOwnershipInspection: () => {
        const inner: LifecycleOwnershipInspection = {
          unsafeParent: async () => undefined,
          inspectOutput: async (project) => {
            if (project === failingProject) throw failure;
            return { kind: "missing" };
          },
        };
        return inner;
      },
    })).rejects.toThrow("injected output inspection failure");

    // No write happened: recorded state and generated output are untouched.
    expect(await readInstallationState(home)).toEqual(stateBefore);
  });

  test("a Project blocker leaves that Project untouched while healthy writes stay sequential", async () => {
    const home = temporaryDirectory("apk-concurrency-blocker-");
    const projects = await fleetWorkspace({
      home,
      hostSets: [["codex"], ["codex"], ["codex"]],
    });
    // Occupy one Project's Codex hook destination so its preflight is blocked.
    mkdirSync(join(projects[1]!, ".codex"), { recursive: true });
    writeFileSync(join(projects[1]!, ".codex", "hooks.json"), "occupied by the project\n");
    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
    });

    const result = await applyReconciliation(home, desired.installations, {
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
    });

    expect(existsSync(stateManifestPath(home))).toBe(true);
    expect(result.resultingState.projects.find((project) =>
      project.canonicalProject === projects[1]
    )?.blockers.length).toBeGreaterThan(0);
    for (const [index, project] of projects.entries()) {
      const expected = index !== 1;
      expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(expected);
      expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(expected);
    }
  });

  test("apply writes stay sequential while reads run concurrently", async () => {
    const home = temporaryDirectory("apk-concurrency-apply-sequential-");
    const projects = await fleetWorkspace({
      home,
      hostSets: [["codex"], ["codex"], ["codex"], ["codex"]],
    });
    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
    });
    // The sequential preview is the reference reconciliation result.
    const sequentialPreview = await previewReconciliation(
      desired.installations,
      emptyState(),
      { scheduler: createProjectReadScheduler(1) },
    );
    let writeInFlight = 0;
    let maxWriteInFlight = 0;
    const fileSystem = {
      writeFile: (async (path, data, options) => {
        writeInFlight += 1;
        maxWriteInFlight = Math.max(maxWriteInFlight, writeInFlight);
        try {
          await nodeFileSystem.writeFile(path, data, options);
        } finally {
          writeInFlight -= 1;
        }
      }) as typeof nodeFileSystem.writeFile,
    };

    const applied = await applyReconciliation(home, desired.installations, {
      fileSystem,
      scheduler: createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY),
    });

    // The concurrent preflight produces the identical receipt; project writes
    // never overlap even though reads were concurrent.
    expect(reportProjection(applied.receipt)).toEqual(reportProjection(sequentialPreview));
    expect(maxWriteInFlight).toBe(1);
    expect(reportBlockers(applied.resultingState)).toEqual([]);
    expect(reportItems(applied.resultingState).every((item) => item.kind === "current")).toBe(true);
    const state = await readInstallationState(home);
    expect(state.receipts).toHaveLength(projects.length);
  });
});
