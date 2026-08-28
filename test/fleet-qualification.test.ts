import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

import { STATUS_PROGRESS_LABEL } from "../cli/progress.js";
import {
  benchmarkWarmRuns,
  formatBenchmarkMarkdown,
} from "../installer/benchmark.js";
import {
  applyApplication,
  statusApplication,
  validateApplication,
} from "../installer/commands.js";
import {
  createLifecycleInstrumentation,
  type LifecycleInstrumentation,
} from "../installer/qualification-instrumentation.js";
import { createLifecycleGitInspectionContext } from "../installer/lifecycle-git-inspection.js";
import { createLifecycleOwnershipInspectionContext } from "../installer/lifecycle-ownership-inspection.js";
import { createProjectReadScheduler } from "../installer/project-scheduler.js";
import { buildDesiredState, stateManifestPath } from "../installer/project-plan.js";
import {
  applyReconciliation,
  nodeFileSystem,
  previewReconciliation,
} from "../installer/reconcile.js";
import { readInstallationState } from "../installer/installation-state.js";
import { humanText } from "./support/human-text.js";
import { ensureProductionBundle } from "./support/package-archive.js";
import {
  createFleetFixture,
  cleanupFleetFixtures,
  FLEET_HOSTS,
  FLEET_SKILL,
  writeBindings,
  writeSkill,
  type FleetFixture,
} from "./support/fleet-fixture.js";
import {
  TEST_CHILD_DEADLINE_MS,
  expectExitCode,
  runProcess,
} from "./support/process-executor.js";
import {
  reportBlockers,
  reportItems,
} from "./support/reconciliation-report.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];
let cliPath = join(repositoryRoot, "dist", "cli.js");

beforeAll(() => {
  ensureProductionBundle(repositoryRoot);
});

afterAll(() => {
  cleanupFleetFixtures();
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-qualification-"));
  temporaryDirectories.push(home);
  return home;
}

/** One isolated packed 12-Project fleet with a shared Profile, Context, Skill. */
function createPackedFleet(home: string): FleetFixture {
  return createFleetFixture(home);
}

function withFleetScope(arguments_: readonly string[]): readonly string[] {
  const [command, ...rest] = arguments_;
  return (command === "apply" || command === "status") && !rest.includes("--all")
    ? [...arguments_, "--all"]
    : arguments_;
}

async function runCli(home: string, pathValue: string, ...arguments_: string[]) {
  return runProcess({
    executable: process.env.NODE_BINARY ?? "node",
    arguments_: [cliPath, ...withFleetScope(arguments_)],
    environment: { ...process.env, HOME: home, PATH: pathValue },
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI",
  });
}

function stripPtyControlArtifacts(text: string): string {
  return text.replace(/^\^D/, "").replace(/[\u0004\u0008]/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** PTY capture that preserves carriage returns for progress-clear assertions. */
async function runCliInPtyRaw(
  home: string,
  columns: number,
  pathValue: string,
  environment: NodeJS.ProcessEnv,
  ...arguments_: string[]
) {
  const command = [
    `stty cols ${columns};`,
    "exec",
    ...[
      process.env.NODE_BINARY ?? "node",
      cliPath,
      ...withFleetScope(arguments_),
    ].map(shellQuote),
  ].join(" ");
  const result = await runProcess({
    executable: "script",
    arguments_: ["-q", "/dev/null", "sh", "-c", command],
    environment: {
      ...process.env,
      ...environment,
      COLUMNS: String(columns),
      HOME: home,
      PATH: pathValue,
    },
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI PTY",
  });
  return {
    ...result,
    stdout: stripPtyControlArtifacts(result.stdout),
    stderr: stripPtyControlArtifacts(result.stderr),
  };
}

/** Count owned outputs of the desired fleet per category (excluding the Marker). */
function ownedOutputCounts(
  desired: readonly { readonly outputs: readonly { readonly type: string }[] }[],
): { readonly directories: number; readonly files: number } {
  let directories = 0;
  let files = 0;
  for (const installation of desired) {
    for (const output of installation.outputs) {
      if (output.type === "directory") directories += 1;
      else files += 1;
    }
  }
  return { directories, files };
}

describe("fleet-wide synchronization qualification", () => {
  test("an isolated 12-Project journey covers a shared Skill update plus a Host addition and verifies the concise expected output", async () => {
    const home = isolatedHome();
    const fixture = createPackedFleet(home);
    const projects = fixture.projects;
    const pathWithHosts = fixture.pathWithHosts;

    // Initial fleet sync: every Project installs the shared Profile.
    const initialApply = await runCli(home, pathWithHosts, "apply", "--json");
    expectExitCode(initialApply, 0);
    const initialJson = JSON.parse(initialApply.stdout) as {
      readonly applied: { readonly projects: readonly unknown[] };
      readonly projects: readonly { readonly state: { readonly kind: string } }[];
    };
    expect(initialJson.applied.projects).toHaveLength(12);
    expect(initialJson.projects).toHaveLength(12);
    expect(initialJson.projects.every((project) => project.state.kind === "current")).toBe(true);
    // Every Project carries its Installation Marker and owned output.
    for (const project of projects) {
      expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(true);
    }

    // The qualification change: one shared Skill update plus a Host addition.
    writeSkill(home, FLEET_SKILL, "# review-pr\n\nReview with stricter checks.\n");
    const withPi = projects[3]!;
    writeBindings(
      home,
      projects.map((path, index) => ({
        project: path,
        hosts: index === 3 ? [...FLEET_HOSTS[index]!, "pi"] : FLEET_HOSTS[index]!,
      })),
    );

    const preview = await runCli(home, pathWithHosts, "status");
    expectExitCode(preview, 0);
    // Differing operation scopes render once without a duplicate aggregate.
    expect(preview.stdout).toStartWith("Updates ready for 12 projects.\n");
    expect(preview.stdout).toContain("+ 1 file addition in");
    expect(preview.stdout).toContain("~ 21 file updates in 12 projects");
    expect(preview.stdout).not.toContain("Project changes:");
    expect(preview.stdout).not.toContain("Projects: 12");
    // Concise fleet output groups only observable operations and affected
    // Projects; it does not infer Workspace artifact or Project Binding causes.
    expect(preview.stdout).not.toContain("Workspace changes:");
    expect(preview.stdout).not.toContain("Skill review-pr");
    expect(preview.stdout).not.toContain("Project Binding");
    // One collapsed next action; no repeated per-Project blocks or zero-value
    // blocker clauses.
    expect(preview.stdout.match(/Next: apkit apply --all/g)).toHaveLength(1);
    expect(preview.stdout.match(/Details: apkit status --all --verbose/g)).toHaveLength(1);
    expect(preview.stdout).not.toContain("Blockers: 0");
    expect(preview.stdout).not.toContain("State: current");

    // Verbose and JSON retain the complete per-Project evidence.
    const verbose = await runCli(home, pathWithHosts, "status", "--verbose");
    expectExitCode(verbose, 0);
    for (const project of projects) expect(verbose.stdout).toContain(project);

    const json = await runCli(home, pathWithHosts, "status", "--json");
    expectExitCode(json, 0);
    const payload = JSON.parse(json.stdout) as {
      readonly projects: readonly { readonly state: { readonly kind: string } }[];
      readonly schemaVersion: number;
    };
    expect(payload.schemaVersion).toBe(9);
    expect(payload.projects).toHaveLength(12);

    // Apply reconciles the fleet and reports the receipt without a repeated
    // current-Project matrix; the resulting state is verified current.
    const apply = await runCli(home, pathWithHosts, "apply");
    expectExitCode(apply, 0);
    expect(apply.stdout).toContain("Apply complete");
    expect(apply.stdout).toContain("Applied:");
    // The receipt repeats the same observable operation summary.
    expect(apply.stdout).toContain("  + 1 generated file addition in");
    expect(apply.stdout).toContain("  ~ 21 generated file updates in 12 projects");
    expect(apply.stdout).not.toContain("Skill review-pr");
    expect(apply.stdout).not.toContain("Project Binding");
    // Invocation-wide readiness appears once, never per Host scope or per Project.
    expect(humanText(apply.stdout).match(/will load the next time you launch/g)).toHaveLength(1);
    expect(humanText(apply.stdout)).toContain(
      humanText("Profile engineering will load the next time you launch a configured Host from a bound Project root."),
    );

    const status = await runCli(home, pathWithHosts, "status");
    expectExitCode(status, 0);
    expect(status.stdout).toBe("All Projects are current (12 Projects)\n");
    // Clean concise status stays quiet: no standing reminder or Project matrix.
    expect(status.stdout).not.toContain("Standing Host setup:");
    expect(status.stdout).not.toContain("Host setup:");
    expect(status.stdout).not.toContain("Project: ");
    expect(status.stdout).not.toContain("Next:");
    // Pi now generates output in the added Project.
    expect(existsSync(join(withPi, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
  }, 120_000);

  test("integrated journeys enforce invocation-scoped operation budgets for unique Profiles, Hosts, Projects, and generated outputs", async () => {
    const home = isolatedHome();
    createPackedFleet(home);

    // Planning budgets: one invocation-scoped instrumentation set is the single
    // reader for the operation counts; each counter fires only on real
    // (cache-miss) work.
    const instrumentation: LifecycleInstrumentation = createLifecycleInstrumentation();
    const gitInspection = createLifecycleGitInspectionContext(instrumentation.git);
    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      gitInspection,
      planningInstrumentation: instrumentation.planning,
      scheduler: createProjectReadScheduler(),
    });

    // Unique Profile budget: one shared Profile resolves, fingerprints, and
    // composes exactly once regardless of the 12 Projects.
    expect(instrumentation.counts.resolveProfile).toBe(1);
    expect(instrumentation.counts.hashWorkspaceInputs).toBe(1);
    expect(instrumentation.counts.readSkillPackage).toBe(1);
    // The shared Context envelope and Antigravity's module-preserving native
    // rules are the two qualified compositions reused across the fleet.
    expect(instrumentation.counts.composeContext).toBe(2);
    // Unique Host budget: Host projections scale with unique Host/topology
    // keys, never with Projects × Hosts (the naive sum is 28).
    const naivePlans = FLEET_HOSTS.reduce((total, hosts) => total + hosts.length, 0);
    expect(naivePlans).toBe(28);
    expect(instrumentation.counts.planHost).toBe(6);
    // Unique Project budget: each Project resolves Git topology once.
    expect(instrumentation.counts.findGitProject).toBe(12);
    expect(desired.installations).toHaveLength(12);

    // Reconciliation budgets require a populated fleet: a fresh-install pass
    // has no owned outputs to prove. Settle, then inspect the steady state.
    await applyReconciliation(home, desired.installations, {
      scheduler: createProjectReadScheduler(),
    });
    const steady = createLifecycleInstrumentation();
    const steadyGit = createLifecycleGitInspectionContext(steady.git);
    const steadyDesired = await buildDesiredState(home, {
      checkHostCapability: false,
      gitInspection: steadyGit,
      planningInstrumentation: steady.planning,
      scheduler: createProjectReadScheduler(),
    });
    const report = await previewReconciliation(
      steadyDesired.installations,
      await readInstallationState(home),
      {
        gitInspection: steadyGit,
        ownershipInspection: createLifecycleOwnershipInspectionContext(steady.ownership),
        scheduler: createProjectReadScheduler(),
      },
    );
    expect(reportBlockers(report)).toEqual([]);
    expect(reportItems(report).every((item) => item.kind === "current")).toBe(true);
    const expected = ownedOutputCounts(steadyDesired.installations);
    expect(expected.files).toBeGreaterThan(0);
    expect(expected.directories).toBeGreaterThan(0);
    // Each owned generated output is inspected once per pass.
    expect(steady.counts.inspectFile).toBe(expected.files);
    expect(steady.counts.inspectDirectory).toBe(expected.directories);
    // One Marker read per Project per pass, shared by identity and ownership.
    expect(steady.counts.inspectMarker).toBe(12);
    // One batched tracked-path query per Git worktree root; the six Git
    // Projects each resolve topology once.
    expect(steady.counts.classifyTrackedPaths).toBe(6);
    expect(steady.counts.findGitProject).toBe(12);
    expect(reportItems(report)).toHaveLength(12);
  });

  test("operation budgets flow through the command layer with Host probes once per unique requirement", async () => {
    const home = isolatedHome();
    const { pathWithHosts } = createPackedFleet(home);
    const instrumentation = createLifecycleInstrumentation();
    const report = await statusApplication(home, {
      env: { ...process.env, PATH: pathWithHosts },
      instrumentation,
    });
    expect(reportBlockers(report)).toEqual([]);
    // One machine-level probe per supported Host requirement set for the
    // Context+Skill Profile.
    expect(instrumentation.counts.probeHostCapability).toBe(5);
    expect(instrumentation.counts.resolveProfile).toBe(1);
    expect(instrumentation.counts.findGitProject).toBe(12);
    expect(reportItems(report)).toHaveLength(12);
  });

  test("apply still performs fresh post-commit verification while writes, state, and receipts stay sequential", async () => {
    const home = isolatedHome();
    createPackedFleet(home);
    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      scheduler: createProjectReadScheduler(),
    });
    // Settle the fleet with a fresh install, then re-sync a shared change so
    // the instrumented apply performs real writes and both inspection passes.
    await applyReconciliation(home, desired.installations, {
      scheduler: createProjectReadScheduler(),
    });
    writeSkill(home, FLEET_SKILL, "# review-pr\n\nReview with stricter checks.\n");

    const instrumentation = createLifecycleInstrumentation();
    const changed = await buildDesiredState(home, {
      checkHostCapability: false,
      gitInspection: createLifecycleGitInspectionContext(instrumentation.git),
      planningInstrumentation: instrumentation.planning,
      scheduler: createProjectReadScheduler(),
    });

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

    const applied = await applyReconciliation(home, changed.installations, {
      fileSystem,
      scheduler: createProjectReadScheduler(),
      createOwnershipInspection: () =>
        createLifecycleOwnershipInspectionContext(instrumentation.ownership),
      createGitInspection: () => createLifecycleGitInspectionContext(instrumentation.git),
    });

    // Project writes never overlap while reads stay concurrent.
    expect(maxWriteInFlight).toBe(1);
    // Post-commit verification re-proves every Project: the preflight and
    // verification passes each inspect every owned file, directory, and Marker.
    const expected = ownedOutputCounts(changed.installations);
    expect(instrumentation.counts.inspectMarker).toBe(24);
    expect(instrumentation.counts.inspectFile).toBe(2 * expected.files);
    expect(instrumentation.counts.inspectDirectory).toBe(2 * expected.directories);
    expect(reportBlockers(applied.resultingState)).toEqual([]);
    expect(reportItems(applied.resultingState).every((item) => item.kind === "current")).toBe(true);
    const state = await readInstallationState(home);
    expect(state.receipts).toHaveLength(12);
  });

  test("a dependency-rich 14-Project publication remains readable across fresh processes", async () => {
    const home = isolatedHome();
    const fixture = createFleetFixture(home, { dependencyRich: true, projectCount: 14 });
    const statePath = stateManifestPath(home);

    expectExitCode(await runCli(home, fixture.pathWithHosts, "apply"), 0);
    const published = readFileSync(statePath, "utf8");
    const stateValue = JSON.parse(published) as {
      receipts: readonly { readonly hosts: Readonly<Record<string, unknown>> }[];
    };
    expect(stateValue.receipts).toHaveLength(14);
    expect(new Set(stateValue.receipts.flatMap((receipt) => Object.keys(receipt.hosts)))).toEqual(
      new Set(["antigravity", "claude", "codex", "grok", "pi"]),
    );
    expect(published).not.toMatch(/(?:^|\s)[&*][a-zA-Z0-9_-]+/m);

    const nextRead = await runCli(home, fixture.pathWithHosts, "status");
    expectExitCode(nextRead, 0);
    expect(nextRead.stdout).toContain("All Projects are current (14 Projects)");
    expectExitCode(await runCli(home, fixture.pathWithHosts, "apply"), 0);
    expect(readFileSync(statePath, "utf8")).toBe(published);
  });

  test("existing delayed progress integrates with the packed fleet without flicker and never emits in non-interactive modes", async () => {
    const home = isolatedHome();
    const { pathWithHosts } = createPackedFleet(home);

    // A genuinely slow inspection on the interactive fleet shows delayed
    // progress cleared immediately before the grouped report.
    const pty = await runCliInPtyRaw(
      home,
      80,
      pathWithHosts,
      { APKIT_TEST_CODEX_DELAY: "1.2", NO_COLOR: "1" },
      "status",
      "--all",
    );
    expectExitCode(pty, 0);
    expect(pty.stdout).toContain(STATUS_PROGRESS_LABEL);
    const reportIndex = pty.stdout.indexOf("Updates ready");
    expect(reportIndex).toBeGreaterThan(-1);
    const beforeReport = pty.stdout.slice(0, reportIndex);
    const afterReport = pty.stdout.slice(reportIndex);
    expect(afterReport).not.toContain(STATUS_PROGRESS_LABEL);
    const lastLabel = beforeReport.lastIndexOf(STATUS_PROGRESS_LABEL);
    expect(lastLabel).toBeGreaterThan(-1);
    expect(beforeReport.slice(lastLabel + STATUS_PROGRESS_LABEL.length)).toMatch(/^\.*\r +\r$/);
    // The concise fleet report follows the clear, not a repeated matrix.
    expect(afterReport).toContain("Updates ready");

    // Redirected and JSON runs stay progress-free even when slow.
    const delayed = await runProcess({
      executable: process.env.NODE_BINARY ?? "node",
      arguments_: [cliPath, "status", "--all"],
      environment: {
        ...process.env,
        APKIT_TEST_CODEX_DELAY: "1.2",
        HOME: home,
        PATH: pathWithHosts,
      },
      deadlineMs: TEST_CHILD_DEADLINE_MS,
      commandLabel: "packed CLI",
    });
    expectExitCode(delayed, 0);
    expect(delayed.stdout).not.toContain(STATUS_PROGRESS_LABEL);
    expect(delayed.stdout).not.toMatch(/\r/);
    expect(delayed.stdout).not.toMatch(/\u001b\[/);

    const json = await runProcess({
      executable: process.env.NODE_BINARY ?? "node",
      arguments_: [cliPath, "status", "--all", "--json"],
      environment: {
        ...process.env,
        APKIT_TEST_CODEX_DELAY: "1.2",
        HOME: home,
        PATH: pathWithHosts,
      },
      deadlineMs: TEST_CHILD_DEADLINE_MS,
      commandLabel: "packed CLI",
    });
    expectExitCode(json, 0);
    expect(json.stdout).not.toContain(STATUS_PROGRESS_LABEL);
    expect(json.stdout).not.toMatch(/\r/);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
  }, 120_000);

  test("representative warm status and apply samples are benchmarked and recorded with the qualification evidence", async () => {
    const home = isolatedHome();
    const { pathWithHosts } = createPackedFleet(home);
    // Warm the fleet to current before measuring.
    const warmup = await runCli(home, pathWithHosts, "apply");
    expectExitCode(warmup, 0);

    const result = await benchmarkWarmRuns(home, {
      mutateSkill: FLEET_SKILL,
      path: pathWithHosts,
      runCount: 2,
    });
    const commands = result.samples.map((sample) => sample.command);
    expect(commands).toEqual(["status", "status", "apply", "apply"]);
    for (const sample of result.samples) {
      expect(Number.isFinite(sample.elapsedMs)).toBe(true);
      expect(sample.elapsedMs).toBeGreaterThan(0);
    }
    const markdown = formatBenchmarkMarkdown(result, {
      fixtureDescription: "isolated 12-Project fleet",
      baselineNote: "parent #193: status ≈ 6.00s, preview ≈ 10.65s pre-optimization",
    });
    expect(markdown).toContain("## Fleet synchronization warm-run benchmark");
    expect(markdown).toContain("| status | 2 |");
    expect(markdown).toContain("| apply | 2 |");
    expect(markdown).toContain("isolated 12-Project fleet");
    expect(markdown).toContain("parent #193");
    // Fail fast on nonsensical sample configurations rather than rendering
    // empty or infinite rows.
    await expect(benchmarkWarmRuns(home, { runCount: 0 })).rejects.toThrow(
      /run count must be a positive integer/,
    );
    await expect(benchmarkWarmRuns(home, { commands: [] })).rejects.toThrow(
      /at least one command/,
    );
  });

  test("validate is part of the same command-layer instrumentation surface", async () => {
    const home = isolatedHome();
    const { pathWithHosts } = createPackedFleet(home);
    const instrumentation = createLifecycleInstrumentation();
    const result = await validateApplication(home, { instrumentation });
    expect(result.bindings).toBe(12);
    expect(instrumentation.counts.resolveProfile).toBe(1);
    expect(instrumentation.counts.findGitProject).toBe(12);

    const statusInstrumentation = createLifecycleInstrumentation();
    const report = await statusApplication(home, {
      env: { ...process.env, PATH: pathWithHosts },
      instrumentation: statusInstrumentation,
    });
    expect(reportBlockers(report)).toEqual([]);
    expect(reportItems(report)).toHaveLength(12);
    expect(statusInstrumentation.counts.resolveProfile).toBe(1);
  });
});
