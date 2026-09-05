import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
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
  FLEET_CLI_PATH,
  runFleetCli,
  runFleetCliWithExplicitPath,
  withFleetScope,
} from "./support/fleet-cli.js";
import {
  createFleetFixture,
  cleanupFleetFixtures,
  gitRepository,
  installControlledHosts,
  pathWithoutHostStub,
  plainProject,
  workspacePath,
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

async function runCli(home: string, pathValue: string, ...arguments_: string[]) {
  return runFleetCli(home, pathValue, arguments_);
}

/** Packed CLI run with a fully controlled PATH (system PATH excluded) so a missing Host stays missing. */
async function runCliWithExplicitPath(
  home: string,
  pathValue: string,
  ...arguments_: string[]
) {
  return runFleetCliWithExplicitPath(home, pathValue, arguments_);
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
      FLEET_CLI_PATH,
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

/** Count owned outputs of the desired fleet per category. */
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
    expect(payload.schemaVersion).toBe(14);
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
    // Probing is apply-only: status performs no machine-level Host probes.
    expect(instrumentation.counts.probeHostCapability).toBe(0);
    expect(instrumentation.counts.resolveProfile).toBe(1);
    expect(instrumentation.counts.findGitProject).toBe(12);
    expect(reportItems(report)).toHaveLength(12);

    const applyInstrumentation = createLifecycleInstrumentation();
    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: pathWithHosts },
      planningInstrumentation: applyInstrumentation.planning,
      scheduler: createProjectReadScheduler(),
    });
    for (const installation of desired.installations) {
      expect(installation.capabilityWarnings).toEqual([]);
    }
    // One machine-level probe per supported Host requirement set for the
    // Context+Skill Profile during apply's planning.
    expect(applyInstrumentation.counts.probeHostCapability).toBe(5);
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
    // verification passes each inspect every owned file and directory.
    const expected = ownedOutputCounts(changed.installations);
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
  }, 120_000);

  test("delayed progress is cleared on the packed fleet PTY, and non-interactive modes stay progress-free", async () => {
    const home = isolatedHome();
    const { pathWithHosts } = createPackedFleet(home);

    // A deliberately slow Host stub is on PATH; status never launches it, so
    // the report is never delayed by probing. The packed fleet can still
    // exceed the delayed-progress threshold, so interactive progress may be
    // captured and then cleared by CR-overwrite before the concise report.
    const pty = await runCliInPtyRaw(
      home,
      80,
      pathWithHosts,
      { APKIT_TEST_CODEX_DELAY: "1.2", NO_COLOR: "1" },
      "status",
      "--all",
    );
    expectExitCode(pty, 0);
    // The concise fleet report follows. Any delayed progress was cleared by
    // finish()'s CR-overwrite; model the visible content by resolving past
    // that clear sequence (CR + spaces + CR) instead of splitting raw CRLF
    // bytes, which the PTY also inserts for ordinary newlines.
    if (pty.stdout.includes(STATUS_PROGRESS_LABEL)) {
      expect(pty.stdout).toMatch(
        new RegExp(`\\r${STATUS_PROGRESS_LABEL}(?:\\.){0,3}\\r[ ]+\\r`),
      );
    }
    expect(pty.stdout.split(/\r[ ]+\r/).at(-1) ?? "").toContain("Updates ready");

    // Redirected and JSON runs stay progress-free even when slow.
    const delayed = await runProcess({
      executable: process.env.NODE_BINARY ?? "node",
      arguments_: [FLEET_CLI_PATH, "status", "--all"],
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
      arguments_: [FLEET_CLI_PATH, "status", "--all", "--json"],
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
  }, 120_000);

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

interface FsSnapshotEntry {
  type: "file" | "directory" | "symlink" | "other";
  mode: number;
  hash?: string;
  target?: string;
}

function snapshotProjectTree(projectDir: string): Record<string, FsSnapshotEntry> {
  const result: Record<string, FsSnapshotEntry> = {};
  function walk(current: string, rel: string) {
    if (!existsSync(current)) return;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      const entryPath = join(current, entry.name);
      const stat = lstatSync(entryPath);
      if (entry.isSymbolicLink()) {
        result[entryRel] = {
          type: "symlink",
          mode: stat.mode,
          target: readlinkSync(entryPath),
        };
      } else if (entry.isDirectory()) {
        result[entryRel] = {
          type: "directory",
          mode: stat.mode,
        };
        walk(entryPath, entryRel);
      } else if (entry.isFile()) {
        result[entryRel] = {
          type: "file",
          mode: stat.mode,
          hash: createHash("sha256").update(readFileSync(entryPath)).digest("hex"),
        };
      } else {
        result[entryRel] = {
          type: "other",
          mode: stat.mode,
        };
      }
    }
  }
  walk(projectDir, "");
  return result;
}

describe("integrated fleet recovery qualification", () => {
  test("qualifies the complete recovery journey: best-effort exclusion republication, global and project blockers, repeated warnings, focused status and partial apply, and zero unauthorized writes", async () => {
    const home = isolatedHome();
    const workspace = workspacePath(home);
    mkdirSync(workspace, { recursive: true });
    for (const category of ["agents", "context", "hooks", "profiles", "skills", "tools"]) {
      mkdirSync(join(workspace, category), { recursive: true });
    }
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    // Context & Skills
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    writeSkill(home, "review-pr", "# review-pr\n\nReview PR with care.\n");
    writeSkill(home, "deploy-helper", "# deploy-helper\n\nDeploy helper.\n");
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [team-rules]\nskills: [review-pr, deploy-helper]\n",
    );

    const projectA = gitRepository();
    const projectB = gitRepository();
    const projectC = gitRepository();
    const projectD = plainProject();
    const projectE = gitRepository();

    const pathWithHosts = installControlledHosts(home);

    // Initial binding for projectA only, to establish its durable receipt.
    writeBindings(home, [
      { project: projectA, hosts: ["codex"], profile: "engineering" },
    ]);
    const initialApplyA = await runCli(home, pathWithHosts, "apply", projectA);
    expectExitCode(initialApplyA, 0);
    expect(existsSync(join(projectA, ".git", "info", "exclude"))).toBe(true);

    // In projectB (Git), create and track multiple planned output paths across directory prefixes
    // (.claude/rules/, .claude/skills/, .agents/skills/)
    mkdirSync(join(projectB, ".claude", "rules"), { recursive: true });
    mkdirSync(join(projectB, ".claude", "skills", "review-pr"), { recursive: true });
    mkdirSync(join(projectB, ".claude", "skills", "deploy-helper"), { recursive: true });
    mkdirSync(join(projectB, ".agents", "skills", "review-pr"), { recursive: true });
    mkdirSync(join(projectB, ".agents", "skills", "deploy-helper"), { recursive: true });
    writeFileSync(join(projectB, ".claude", "rules", "agent-profile-kit.md"), "# conflicting rule\n");
    writeFileSync(join(projectB, ".claude", "skills", "review-pr", "SKILL.md"), "# conflicting skill 1\n");
    writeFileSync(join(projectB, ".claude", "skills", "deploy-helper", "SKILL.md"), "# conflicting skill 2\n");
    writeFileSync(join(projectB, ".agents", "skills", "review-pr", "SKILL.md"), "# conflicting shared 1\n");
    writeFileSync(join(projectB, ".agents", "skills", "deploy-helper", "SKILL.md"), "# conflicting shared 2\n");
    execFileSync("git", ["-C", projectB, "add", "-f", "."]);
    execFileSync("git", ["-C", projectB, "commit", "-qm", "track planned outputs"]);

    // Create a missing exclusion section on projectA: remove .git/info/exclude
    rmSync(join(projectA, ".git", "info", "exclude"), { force: true });

    const stateManifest = join(home, ".agents", "agent-profile-kit", "state", "manifest.json");
    // Update fleet bindings:
    // projectA: [codex] (missing exclusion section)
    // projectB: [claude, opencode] (Project Blocker with many tracked paths)
    // projectC: [claude, opencode] (Healthy, duplicate skill warning)
    // projectD: [claude, opencode] (Healthy, duplicate skill warning)
    // projectE: [antigravity, codex] (Healthy)
    writeBindings(home, [
      { project: projectA, hosts: ["codex"], profile: "engineering" },
      { project: projectB, hosts: ["claude", "opencode"], profile: "engineering" },
      { project: projectC, hosts: ["claude", "opencode"], profile: "engineering" },
      { project: projectD, hosts: ["claude", "opencode"], profile: "engineering" },
      { project: projectE, hosts: ["antigravity", "codex"], profile: "engineering" },
    ]);

    // 1. Focused status under a Project Blocker
    const focusedStatusGlobalBlocked = await runCli(home, pathWithHosts, "status", "--all", "--blockers-only");
    expectExitCode(focusedStatusGlobalBlocked, 2);
    expect(focusedStatusGlobalBlocked.stdout).not.toContain("Global blockers:");
    expect(focusedStatusGlobalBlocked.stdout).toContain("Blockers:");
    expect(focusedStatusGlobalBlocked.stdout).toContain("These generated paths are tracked by Git");
    expect(focusedStatusGlobalBlocked.stdout).toMatch(/Blockers:\s*1\s*·\s*Affected Projects:\s*1/);
    expect(focusedStatusGlobalBlocked.stdout).not.toContain("Updates ready");
    expect(focusedStatusGlobalBlocked.stdout).not.toContain("Applied:");
    expect(focusedStatusGlobalBlocked.stdout).not.toContain("Host setup:");
    expect(focusedStatusGlobalBlocked.stdout).not.toContain("Standing Host setup:");
    expect(focusedStatusGlobalBlocked.stdout).not.toContain("Warnings:");
    expect(focusedStatusGlobalBlocked.stdout).not.toContain(projectC);
    expect(focusedStatusGlobalBlocked.stdout).not.toContain(projectD);
    expect(focusedStatusGlobalBlocked.stdout).not.toContain(projectE);

    // Material comparison with ordinary verbose
    const verboseGlobalBlocked = await runCli(home, pathWithHosts, "status", "--all", "--verbose");
    expectExitCode(verboseGlobalBlocked, 2);
    expect(focusedStatusGlobalBlocked.stdout.length).toBeLessThan(verboseGlobalBlocked.stdout.length / 2);

    // Determinism
    const repeatFocusedStatus = await runCli(home, pathWithHosts, "status", "--all", "--blockers-only");
    expect(repeatFocusedStatus.stdout).toBe(focusedStatusGlobalBlocked.stdout);

    // Snapshot complete directory trees for Projects A-E, Git exclude files, and Installation State (INT-2)
    const preSnapB = snapshotProjectTree(projectB);
    const preExcludeBContent = readFileSync(join(projectB, ".git", "info", "exclude"), "utf8");

    // 2. Focused partial apply commits healthy Projects, leaves the blocked
    //    Project untouched, and exits with code 2.
    const partialApply = await runCli(home, pathWithHosts, "apply", "--all", "--blockers-only");
    expectExitCode(partialApply, 2);

    // Assert section ordering: committed Apply Receipt evidence forms an ordered prefix before the Blocker section (ADR-0024). The Project key-value renders inline (accepted alignment change).
    const appliedIndex = partialApply.stdout.indexOf("Applied:");
    const freshlyCurrentIndex = partialApply.stdout.indexOf("Freshly current:");
    const projectSectionIndex = partialApply.stdout.indexOf("\n\nProject: ");
    const blockerTextIndex = partialApply.stdout.indexOf("These generated paths are tracked by Git");
    const blockersFooterIndex = partialApply.stdout.indexOf("Blockers: 1 · Affected Projects: 1");

    expect(appliedIndex).toBeGreaterThan(-1);
    expect(freshlyCurrentIndex).toBeGreaterThan(appliedIndex);
    expect(projectSectionIndex).toBeGreaterThan(freshlyCurrentIndex);
    expect(blockerTextIndex).toBeGreaterThan(projectSectionIndex);
    expect(blockersFooterIndex).toBeGreaterThan(blockerTextIndex);

    // Safety prefix contains applied projects made current and excludes blocked project B
    const safetyPrefix = partialApply.stdout.slice(appliedIndex, projectSectionIndex);
    expect(safetyPrefix).toContain(projectA);
    expect(safetyPrefix).toContain(projectC);
    expect(safetyPrefix).toContain(projectD);
    expect(safetyPrefix).toContain(projectE);
    expect(safetyPrefix).not.toContain(projectB);

    // Blocker section after safety prefix contains blocked Project B evidence and footer
    const blockerSection = partialApply.stdout.slice(projectSectionIndex);
    expect(blockerSection).toContain(projectB);
    expect(blockerSection).toContain("These generated paths are tracked by Git");
    expect(blockerSection).toContain("Blockers: 1 · Affected Projects: 1");

    // projectA exclusion publication applied
    expect(existsSync(join(projectA, ".git", "info", "exclude"))).toBe(true);
    expect(readFileSync(join(projectA, ".git", "info", "exclude"), "utf8")).toContain(
      "# BEGIN Agent Profile Kit generated paths",
    );

    // projectC, projectD, projectE healthy outputs applied
    expect(existsSync(join(projectC, ".opencode", "opencode.jsonc"))).toBe(true);
    expect(existsSync(join(projectC, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(projectD, ".opencode", "opencode.jsonc"))).toBe(true);
    expect(existsSync(join(projectE, ".agents", "rules", "agent-profile-kit-000-envelope.md"))).toBe(true);

    // Verify Installation State after partial apply: Project B has no receipt, and unowned generated output was never reconstructed into state (INT-2)
    const stateAfterPartial = JSON.parse(readFileSync(stateManifest, "utf8")) as {
      receipts: { project: string; profile_id: string }[];
    };
    expect(stateAfterPartial.receipts.some((r) => r.project === projectB)).toBe(false);
    expect(stateAfterPartial.receipts.some((r) => r.project === projectA)).toBe(true);
    expect(stateAfterPartial.receipts.some((r) => r.project === projectC)).toBe(true);
    expect(stateAfterPartial.receipts.some((r) => r.project === projectD)).toBe(true);
    expect(stateAfterPartial.receipts.some((r) => r.project === projectE)).toBe(true);

    // projectB untouched: zero Git index changes, no exclusion change, no adoption, no overwrite, no state reconstruction (INT-2)
    expect(existsSync(join(projectB, ".agent-profile-kit"))).toBe(false);
    expect(readFileSync(join(projectB, ".git", "info", "exclude"), "utf8")).toBe(preExcludeBContent);
    expect(preExcludeBContent).not.toContain("Agent Profile Kit");
    expect(snapshotProjectTree(projectB)).toEqual(preSnapB);
    expect(execFileSync("git", ["-C", projectB, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["-C", projectB, "diff", "--cached"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["-C", projectB, "diff"], { encoding: "utf8" })).toBe("");
    expect(readFileSync(join(projectB, ".claude", "rules", "agent-profile-kit.md"), "utf8")).toBe("# conflicting rule\n");
    expect(readFileSync(join(projectB, ".claude", "skills", "review-pr", "SKILL.md"), "utf8")).toBe("# conflicting skill 1\n");

    // 4. Focused verbose includes complete Blocker evidence and exact untracking command
    const focusedVerbose = await runCli(home, pathWithHosts, "status", "--all", "--blockers-only", "--verbose");
    expectExitCode(focusedVerbose, 2);
    expect(focusedVerbose.stdout).toContain("These generated paths are tracked by Git");
    expect(focusedVerbose.stdout).toContain("Requirement:");
    expect(focusedVerbose.stdout).toContain("Remedy:");
    expect(focusedVerbose.stdout).toContain("Scope: Project");
    expect(focusedVerbose.stdout).toContain("Affected path:");
    expect(focusedVerbose.stdout).toContain("git -C");
    expect(focusedVerbose.stdout).toContain("rm -r --cached --");
    expect(focusedVerbose.stdout).toContain(".agents/skills/deploy-helper");
    expect(focusedVerbose.stdout).toContain(".agents/skills/review-pr");
    expect(focusedVerbose.stdout).toContain(".claude/rules/agent-profile-kit.md");
    expect(focusedVerbose.stdout).toContain(".claude/skills/deploy-helper");
    expect(focusedVerbose.stdout).toContain(".claude/skills/review-pr");
    expect(focusedVerbose.stdout).toContain("working files are preserved");

    // Ordinary verbose retains the complete fleet report; equivalent duplicate
    // Skill candidates are Host Resolution and emit no Agent Profile Kit warning.
    const ordinaryVerbose = await runCli(home, pathWithHosts, "status", "--all", "--verbose");
    expectExitCode(ordinaryVerbose, 2);
    for (const p of [projectA, projectB, projectC, projectD, projectE]) {
      expect(ordinaryVerbose.stdout).toContain(p);
    }
    expect(ordinaryVerbose.stdout).not.toContain("OpenCode discovers Skills from both");

    // Machine JSON retains complete fleet report and Project-nested warnings
    const statusJsonResult = await runCli(home, pathWithHosts, "status", "--all", "--json");
    expectExitCode(statusJsonResult, 2);
    const jsonPayload = JSON.parse(statusJsonResult.stdout) as {
      schemaVersion: number;
      outcome: string;
      projects: {
        canonicalProject: string;
        state: { kind: string };
        blockers: { kind: string; message: string; affectedItems: { kind: string; value: string }[] }[];
        warnings: { kind: string; message: string; copyableValues: string[] }[];
      }[];
    };
    expect(jsonPayload.schemaVersion).toBe(14);
    expect(jsonPayload.outcome).toBe("blocked");
    expect(jsonPayload.projects).toHaveLength(5);

    const jsonA = jsonPayload.projects.find((p) => p.canonicalProject === projectA);
    const jsonB = jsonPayload.projects.find((p) => p.canonicalProject === projectB);
    const jsonC = jsonPayload.projects.find((p) => p.canonicalProject === projectC);
    const jsonD = jsonPayload.projects.find((p) => p.canonicalProject === projectD);
    const jsonE = jsonPayload.projects.find((p) => p.canonicalProject === projectE);

    expect(jsonA?.state.kind).toBe("current");
    expect(jsonA?.blockers).toHaveLength(0);

    expect(jsonB?.blockers).toHaveLength(1);
    expect(jsonB?.blockers[0]?.kind).toBe("output-ownership-conflict");
    expect(jsonB?.blockers[0]?.affectedItems.length).toBeGreaterThanOrEqual(5);

    expect(jsonC?.state.kind).toBe("current");
    expect(jsonC?.warnings.some((w) => w.message.includes("OpenCode discovers Skills"))).toBe(false);

    expect(jsonD?.state.kind).toBe("current");
    expect(jsonD?.warnings.some((w) => w.message.includes("OpenCode discovers Skills"))).toBe(false);

    expect(jsonE?.state.kind).toBe("current");

    // 5. Second status after apply: refreshed projects current, blocked project actionable
    const secondStatus = await runCli(home, pathWithHosts, "status", "--all");
    expectExitCode(secondStatus, 2);
    expect(secondStatus.stdout).toContain("Blockers:");
    expect(secondStatus.stdout).toContain(projectB);
    expect(secondStatus.stdout).not.toContain("OpenCode discovers Skills");
  }, 120_000);

  test("a 30-Project fleet recovers a hand-deleted Project's generated roots as ordinary pending work", async () => {
    const home = isolatedHome();
    const fixture = createFleetFixture(home, { projectCount: 30 });
    const projects = fixture.projects;
    const pathWithHosts = fixture.pathWithHosts;

    expectExitCode(await runCli(home, pathWithHosts, "apply"), 0);

    // The spec's headline wedge action: delete one Project's generated roots
    // by hand — the obvious way to "start that one over".
    const damaged = projects[1]!;
    rmSync(join(damaged, ".agent-profile-kit"), { recursive: true });
    rmSync(join(damaged, ".codex"), { recursive: true });

    // status --all stays at exit 0 and reports the damaged Project as pending
    // work, never as a blocker; the other 29 Projects are unaffected.
    const status = await runCli(home, pathWithHosts, "status", "--json");
    expectExitCode(status, 0);
    const statusPayload = JSON.parse(status.stdout) as {
      readonly outcome: string;
      readonly projects: readonly {
        readonly canonicalProject: string;
        readonly state: { readonly kind: string };
        readonly blockers: readonly unknown[];
      }[];
    };
    expect(statusPayload.projects).toHaveLength(30);
    expect(statusPayload.outcome).toBe("attention");
    for (const projectRecord of statusPayload.projects) {
      expect(projectRecord.blockers).toEqual([]);
      if (projectRecord.canonicalProject === damaged) {
        expect(projectRecord.state.kind).toBe("drifted output");
      } else {
        expect(projectRecord.state.kind).toBe("current");
      }
    }

    // apply --all restores the deleted roots at exit 0.
    const apply = await runCli(home, pathWithHosts, "apply");
    expectExitCode(apply, 0);
    expect(apply.stderr).toBe("");
    expect(existsSync(join(damaged, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(damaged, ".codex", "hooks.json"))).toBe(true);

    const settled = await runCli(home, pathWithHosts, "status");
    expectExitCode(settled, 0);
    expect(settled.stdout).toBe("All Projects are current (30 Projects)\n");
  }, 240_000);

  test("a 30-Project fleet with mixed pending, drifted, missing-Host, unprovable-Git-topology, and deleted-generated-roots conditions completes status --all and apply --all at exit 0", async () => {
    const home = isolatedHome();
    const fixture = createFleetFixture(home, { projectCount: 30 });
    const projects = fixture.projects;
    const pathWithHosts = fixture.pathWithHosts;

    // Settle 29 Projects; the 30th binding enters as pending (addition) work.
    const settled = projects.slice(0, 29);
    writeBindings(
      home,
      settled.map((project, index) => ({
        project,
        hosts: FLEET_HOSTS[index % FLEET_HOSTS.length]!,
      })),
    );
    expectExitCode(await runCli(home, pathWithHosts, "apply"), 0);
    const pending = projects[29]!;
    writeBindings(
      home,
      [
        ...settled.map((project, index) => ({
          project,
          hosts: FLEET_HOSTS[index % FLEET_HOSTS.length]!,
        })),
        { project: pending, hosts: FLEET_HOSTS[29 % FLEET_HOSTS.length]! },
      ],
    );

    // Drifted output: one Project's owned file is edited by hand.
    const drifted = projects[1]!;
    const contextPath = join(drifted, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(contextPath, "drift\n");

    // Deleted generated roots on another Project.
    const damaged = projects[2]!;
    rmSync(join(damaged, ".agent-profile-kit"), { recursive: true });
    rmSync(join(damaged, ".codex"), { recursive: true });

    // Unprovable Git topology: one Git Project's common directory is a
    // symlink to an external Git directory.
    const topology = projects[0]!;
    const externalGit = join(topology, "external-gitdir");
    renameSync(join(topology, ".git"), externalGit);
    symlinkSync(externalGit, join(topology, ".git"));
    const exclude = join(externalGit, "info", "exclude");
    const excludeBefore = readFileSync(exclude, "utf8");

    // Missing Host: Pi is selected by 12 of the 30 Projects but its stub is
    // absent from PATH for the status and apply runs below.
    const pathWithoutPi = pathWithoutHostStub(home, "pi");

    // status --all under the missing Host stays at exit 0 with no blockers:
    // none of these conditions is a blocker any more.
    const status = await runCliWithExplicitPath(home, pathWithoutPi, "status", "--all", "--json");
    expectExitCode(status, 0);
    const statusPayload = JSON.parse(status.stdout) as {
      readonly outcome: string;
      readonly projects: readonly {
        readonly canonicalProject: string;
        readonly state: { readonly kind: string };
        readonly blockers: readonly unknown[];
        readonly warnings: readonly { readonly kind: string; readonly message: string }[];
      }[];
    };
    expect(statusPayload.projects).toHaveLength(30);
    expect(statusPayload.outcome).toBe("attention");
    for (const projectRecord of statusPayload.projects) {
      expect(projectRecord.blockers).toEqual([]);
      const expectedKind =
        projectRecord.canonicalProject === pending ? "addition"
        : projectRecord.canonicalProject === drifted || projectRecord.canonicalProject === damaged
          ? "drifted output"
          : "current";
      expect(projectRecord.state.kind).toBe(expectedKind);
    }
    // The unprovable-topology Project carries exactly one topology warning.
    const topologyRecord = statusPayload.projects.find(
      (projectRecord) => projectRecord.canonicalProject === topology,
    );
    expect(
      topologyRecord?.warnings.filter((warning) =>
        warning.message.includes("non-directory or symlink component"),
      ),
    ).toHaveLength(1);

    // apply --all completes at exit 0 and installs generated material for
    // every condition, including the missing Host's Projects.
    const apply = await runCliWithExplicitPath(home, pathWithoutPi, "apply", "--all", "--json");
    expectExitCode(apply, 0);
    expect(apply.stderr).toBe("");
    const applyPayload = JSON.parse(apply.stdout) as {
      readonly projects: readonly {
        readonly canonicalProject: string;
        readonly state: { readonly kind: string };
        readonly blockers: readonly unknown[];
        readonly warnings: readonly { readonly kind: string; readonly message: string }[];
      }[];
    };
    for (const projectRecord of applyPayload.projects) {
      expect(projectRecord.blockers).toEqual([]);
      expect(projectRecord.state.kind).toBe("current");
    }
    // One warning per Host per invocation, and only Pi is missing: the
    // apply payload's Host-attention warnings contain exactly the single
    // expected Pi warning (INT-1), regardless of the 12 Projects that select
    // Pi and with no collateral Host capability warnings.
    const hostAttentionWarnings = applyPayload.projects
      .flatMap((projectRecord) => projectRecord.warnings)
      .filter((warning) => warning.kind === "host-attention");
    expect(hostAttentionWarnings).toHaveLength(1);
    expect(hostAttentionWarnings[0]!.message).toContain("Pi CLI was not found on PATH");

    // Every condition recovered on disk: pending Project installed, drifted
    // file repaired, deleted roots recreated, topology Project still installed
    // with its exclusion target untouched, and Pi material written anyway.
    expect(existsSync(join(pending, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(readFileSync(contextPath, "utf8")).toContain("Always preserve the project boundary.");
    expect(existsSync(join(damaged, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(damaged, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(topology, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(readFileSync(exclude, "utf8")).toBe(excludeBefore);
    const piProject = projects[6]!;
    expect(existsSync(join(piProject, ".pi", "APPEND_SYSTEM.md"))).toBe(true);

    // With the Host restored, the whole fleet is current: no condition left
    // residual pending work or blockers.
    const settledStatus = await runCliWithExplicitPath(home, pathWithHosts, "status", "--all", "--json");
    expectExitCode(settledStatus, 0);
    const settledPayload = JSON.parse(settledStatus.stdout) as {
      readonly outcome: string;
      readonly projects: readonly {
        readonly state: { readonly kind: string };
        readonly blockers: readonly unknown[];
      }[];
    };
    expect(settledPayload.projects).toHaveLength(30);
    expect(settledPayload.outcome).toBe("clean");
    for (const projectRecord of settledPayload.projects) {
      expect(projectRecord.state.kind).toBe("current");
      expect(projectRecord.blockers).toEqual([]);
    }
  }, 240_000);
});
