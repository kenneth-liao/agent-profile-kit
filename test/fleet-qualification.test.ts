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

import { PREVIEW_PROGRESS_LABEL } from "../cli/progress.js";
import {
  benchmarkWarmRuns,
  formatBenchmarkMarkdown,
} from "../installer/benchmark.js";
import {
  applyApplication,
  previewApplication,
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
import { buildDesiredState } from "../installer/project-plan.js";
import {
  applyReconciliation,
  nodeFileSystem,
  previewReconciliation,
} from "../installer/reconcile.js";
import { readInstallationState } from "../installer/installation-state.js";
import { INSTALLATION_STATE_SCHEMA_VERSION } from "../schemas/installation-manifest.js";
import { humanText } from "./support/human-text.js";
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

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];
let cliPath = join(repositoryRoot, "dist", "cli.js");

beforeAll(() => {
  execFileSync("bun", ["run", "build"], { cwd: repositoryRoot, stdio: "inherit" });
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

async function runCli(home: string, pathValue: string, ...arguments_: string[]) {
  return runProcess({
    executable: process.env.NODE_BINARY ?? "node",
    arguments_: [cliPath, ...arguments_],
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
    ...[process.env.NODE_BINARY ?? "node", cliPath, ...arguments_].map(shellQuote),
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
      readonly applied: { readonly installations: readonly unknown[] };
      readonly installations: readonly { readonly state: string }[];
    };
    expect(initialJson.applied.installations).toHaveLength(12);
    expect(initialJson.installations).toHaveLength(12);
    expect(initialJson.installations.every((installation) => installation.state === "current")).toBe(
      true,
    );
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

    const preview = await runCli(home, pathWithHosts, "preview");
    expectExitCode(preview, 0);
    // The concise header totals the fleet change once.
    expect(preview.stdout).toContain(
      "Projects: 12 · Changes: 2 generated file additions, 27 generated file updates",
    );
    // The shared Skill change renders once per distinct Host scope (not once
    // per Project), with deterministic file and Project counts.
    expect(preview.stdout).toContain("Workspace changes:");
    expect(preview.stdout).toContain(
      "  ~ Skill review-pr · 4 files in 2 projects · Hosts claude, codex",
    );
    expect(preview.stdout).toContain(
      "  ~ Skill review-pr · 12 files in 3 projects · Hosts claude, codex, grok, pi",
    );
    expect(preview.stdout).toContain(
      "  ~ Skill review-pr · 3 files in 1 project · Hosts claude, codex, pi",
    );
    expect(preview.stdout).toContain(
      "  ~ Skill review-pr · 3 files in 3 projects · Hosts codex",
    );
    expect(preview.stdout).toContain(
      "  ~ Skill review-pr · 6 files in 3 projects · Hosts codex, pi",
    );
    // The Pi Host addition stays a distinct Project Binding change with scope.
    expect(preview.stdout).toContain("Project changes:");
    expect(preview.stdout).toContain(
      "  + Project Binding · 1 file in 1 project · Hosts claude, codex, pi",
    );
    // One collapsed next action; no repeated per-Project blocks or zero-value
    // blocker clauses.
    expect(preview.stdout.match(/Run apkit apply\./g)).toHaveLength(1);
    expect(preview.stdout).not.toContain("Blockers: 0");
    expect(preview.stdout).not.toContain("State: current");

    // Verbose retains the complete per-Project evidence; JSON stays flat.
    const verbose = await runCli(home, pathWithHosts, "preview", "--verbose");
    expectExitCode(verbose, 0);
    for (const project of projects) expect(verbose.stdout).toContain(project);

    const json = await runCli(home, pathWithHosts, "preview", "--json");
    expectExitCode(json, 0);
    const payload = JSON.parse(json.stdout) as {
      readonly impacts: readonly { readonly kind: string; readonly project: string }[];
      readonly installations: readonly { readonly state: string }[];
    };
    expect(payload.impacts.length).toBeGreaterThanOrEqual(12);
    expect(payload.impacts.some((impact) => impact.kind === "binding")).toBe(true);
    expect(payload.installations).toHaveLength(12);

    // Apply reconciles the fleet and reports the receipt without a repeated
    // current-Project matrix; the resulting state is verified current.
    const apply = await runCli(home, pathWithHosts, "apply");
    expectExitCode(apply, 0);
    expect(apply.stdout).toContain("Apply complete");
    expect(apply.stdout).toContain("Applied:");
    // The receipt groups preview-consistent facts: the binding change first,
    // then the shared Skill change per Host scope.
    expect(apply.stdout).toContain(
      "  + Project Binding · 1 file in 1 project · Hosts claude, codex, pi",
    );
    expect(apply.stdout).toContain(
      "  ~ Skill review-pr · 12 files in 3 projects · Hosts claude, codex, grok, pi",
    );
    expect(apply.stdout).toContain(
      "  ~ Skill review-pr · 6 files in 3 projects · Hosts codex, pi",
    );
    expect(apply.stdout).not.toContain("State: current");
    // Grouped readiness appears once per Host scope, never per Project.
    expect(humanText(apply.stdout).match(/becomes active on the next launch/g)).toHaveLength(5);

    const status = await runCli(home, pathWithHosts, "status");
    expectExitCode(status, 0);
    expect(status.stdout).toContain("All Projects are current (12 Projects)");
    // One compact Host-level standing reminder; no per-Project lifecycle blocks.
    expect(status.stdout).toContain("Standing Host setup:");
    expect(status.stdout).not.toContain("Project: ");
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
    expect(instrumentation.counts.composeContext).toBe(1);
    // Unique Host budget: Host projections scale with unique Host/topology
    // keys, never with Projects × Hosts (the naive sum is 27).
    const naivePlans = FLEET_HOSTS.reduce((total, hosts) => total + hosts.length, 0);
    expect(naivePlans).toBe(27);
    expect(instrumentation.counts.planHost).toBe(5);
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
    expect(report.blockers).toEqual([]);
    expect(report.items.every((item) => item.kind === "current")).toBe(true);
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
    expect(report.items).toHaveLength(12);
  });

  test("operation budgets flow through the command layer with Host probes once per unique requirement", async () => {
    const home = isolatedHome();
    const { pathWithHosts } = createPackedFleet(home);
    const originalPath = process.env.PATH;
    process.env.PATH = pathWithHosts;
    try {
      const instrumentation = createLifecycleInstrumentation();
      const report = await previewApplication(home, { instrumentation });
      expect(report.blockers).toEqual([]);
      // One machine-level probe per unique Host requirement set (codex,
      // claude, grok, pi) for the Context+Skill Profile.
      expect(instrumentation.counts.probeHostCapability).toBe(4);
      expect(instrumentation.counts.resolveProfile).toBe(1);
      expect(instrumentation.counts.findGitProject).toBe(12);
      expect(report.items).toHaveLength(12);
    } finally {
      process.env.PATH = originalPath;
    }
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
    expect(applied.resultingState.blockers).toEqual([]);
    expect(applied.resultingState.items.every((item) => item.kind === "current")).toBe(true);
    const state = await readInstallationState(home);
    expect(state.installations).toHaveLength(12);
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
      "preview",
    );
    expectExitCode(pty, 0);
    expect(pty.stdout).toContain(PREVIEW_PROGRESS_LABEL);
    const reportIndex = pty.stdout.indexOf("Ready to apply");
    expect(reportIndex).toBeGreaterThan(-1);
    const beforeReport = pty.stdout.slice(0, reportIndex);
    const afterReport = pty.stdout.slice(reportIndex);
    expect(afterReport).not.toContain(PREVIEW_PROGRESS_LABEL);
    const lastLabel = beforeReport.lastIndexOf(PREVIEW_PROGRESS_LABEL);
    expect(lastLabel).toBeGreaterThan(-1);
    expect(beforeReport.slice(lastLabel + PREVIEW_PROGRESS_LABEL.length)).toMatch(/^\.*\r +\r$/);
    // The concise fleet report follows the clear, not a repeated matrix.
    expect(afterReport).toContain("Ready to apply");

    // Redirected and JSON runs stay progress-free even when slow.
    const delayed = await runProcess({
      executable: process.env.NODE_BINARY ?? "node",
      arguments_: [cliPath, "preview"],
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
    expect(delayed.stdout).not.toContain(PREVIEW_PROGRESS_LABEL);
    expect(delayed.stdout).not.toMatch(/\r/);
    expect(delayed.stdout).not.toMatch(/\u001b\[/);

    const json = await runProcess({
      executable: process.env.NODE_BINARY ?? "node",
      arguments_: [cliPath, "preview", "--json"],
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
    expect(json.stdout).not.toContain(PREVIEW_PROGRESS_LABEL);
    expect(json.stdout).not.toMatch(/\r/);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
  }, 120_000);

  test("representative warm status, preview, and apply samples are benchmarked and recorded with the qualification evidence", async () => {
    const home = isolatedHome();
    const { pathWithHosts } = createPackedFleet(home);
    // Warm the fleet to current before measuring.
    const warmup = await runCli(home, pathWithHosts, "apply");
    expectExitCode(warmup, 0);

    const originalPath = process.env.PATH;
    process.env.PATH = pathWithHosts;
    try {
      const result = await benchmarkWarmRuns(home, {
        mutateSkill: FLEET_SKILL,
        runCount: 2,
      });
      const commands = result.samples.map((sample) => sample.command);
      expect(commands).toEqual(["status", "status", "preview", "preview", "apply", "apply"]);
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
      expect(markdown).toContain("| preview | 2 |");
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
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("validate is part of the same command-layer instrumentation surface", async () => {
    const home = isolatedHome();
    const { pathWithHosts } = createPackedFleet(home);
    const originalPath = process.env.PATH;
    process.env.PATH = pathWithHosts;
    try {
      const instrumentation = createLifecycleInstrumentation();
      const result = await validateApplication(home, { instrumentation });
      expect(result.bindings).toBe(12);
      expect(instrumentation.counts.resolveProfile).toBe(1);
      expect(instrumentation.counts.findGitProject).toBe(12);

      const statusInstrumentation = createLifecycleInstrumentation();
      const report = await statusApplication(home, { instrumentation: statusInstrumentation });
      expect(report.blockers).toEqual([]);
      expect(report.items).toHaveLength(12);
      expect(statusInstrumentation.counts.resolveProfile).toBe(1);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
