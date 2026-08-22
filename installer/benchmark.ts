import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";

import {
  applyApplication,
  statusApplication,
  validateApplication,
} from "./commands.js";

/**
 * Warm-run benchmark evidence for the fleet-wide synchronization journey.
 *
 * The parent fleet-synchronization spec (DEC-021) requires real-machine warm
 * samples recorded as release evidence without becoming timing gates in
 * heterogeneous CI. This module runs the lifecycle command layer in-process
 * against a prepared isolated fleet, measures deterministic elapsed samples,
 * and renders a markdown record. The companion qualification test asserts the
 * structural shape of the record (finite positive samples, one table per
 * command) rather than any hardware-dependent threshold.
 */

export type LifecycleBenchmarkCommand = "validate" | "status" | "apply";

/** One measured warm sample of one lifecycle command. */
export interface LifecycleBenchmarkSample {
  readonly command: LifecycleBenchmarkCommand;
  readonly elapsedMs: number;
}

export interface LifecycleBenchmarkResult {
  readonly samples: readonly LifecycleBenchmarkSample[];
}

export interface LifecycleBenchmarkOptions {
  /**
   * Commands to sample, in record order. Defaults to the representative
   * authoritative `status` and `apply` journey.
   */
  readonly commands?: readonly LifecycleBenchmarkCommand[];
  /**
   * PATH supplied to lifecycle command capability probes so they resolve
   * against controlled stubs without mutating process-global environment.
   */
  readonly path?: string;
  /**
   * Number of measured samples per command. Defaults to 3.
   */
  readonly runCount?: number;
  /**
   * Shared Skill Artifact ID to mutate before each `status` and `apply`
   * sample, so those samples measure the motivating "one shared Skill changed"
   * re-sync workload instead of a steady-state no-op. `status` samples always
   * run against the current fleet.
   */
  readonly mutateSkill?: string;
}

const DEFAULT_COMMANDS: readonly LifecycleBenchmarkCommand[] = [
  "status",
  "apply",
];

/** Path of the shared Skill's canonical SKILL.md within the isolated Workspace. */
function skillMarkdownPath(home: string, skillId: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace", "skills", skillId, "SKILL.md");
}

/**
 * Run one warm sample of a lifecycle command against the prepared HOME. A
 * `mutateSkill` change is applied immediately before the sample so the command
 * measures real shared-change work; the command itself restores the fleet to
 * current when it writes.
 */
async function sampleCommand(
  home: string,
  command: LifecycleBenchmarkCommand,
  mutateSkill: string | undefined,
  mutation: number,
  env: NodeJS.ProcessEnv | undefined,
): Promise<number> {
  if (mutateSkill !== undefined && (command === "status" || command === "apply")) {
    appendFileSync(
      skillMarkdownPath(home, mutateSkill),
      `\nBenchmark mutation ${mutation}.\n`,
    );
  }
  const started = performance.now();
  if (command === "validate") await validateApplication(home);
  else if (command === "status") {
    await statusApplication(home, env === undefined ? {} : { env });
  } else {
    await applyApplication(home, env === undefined ? {} : { env });
  }
  return performance.now() - started;
}

/**
 * Benchmark warm lifecycle runs against an already-prepared isolated fleet.
 *
 * One unmeasured `status` warm-up runs first so OS page caches are warm, then
 * each requested command is sampled {@link LifecycleBenchmarkOptions.runCount}
 * times. The returned samples are ordered by command then run, which is the
 * deterministic record order rendered by {@link formatBenchmarkMarkdown}.
 */
export async function benchmarkWarmRuns(
  home: string,
  options: LifecycleBenchmarkOptions = {},
): Promise<LifecycleBenchmarkResult> {
  const commands = options.commands ?? DEFAULT_COMMANDS;
  const runCount = options.runCount ?? 3;
  if (!Number.isInteger(runCount) || runCount < 1) {
    throw new Error(`Benchmark run count must be a positive integer, got ${runCount}`);
  }
  if (commands.length === 0) {
    throw new Error("Benchmark requires at least one command to sample");
  }
  const env = options.path === undefined
    ? undefined
    : { ...process.env, PATH: options.path };
  const samples: LifecycleBenchmarkSample[] = [];
  await statusApplication(home, env === undefined ? {} : { env });
  let mutation = 0;
  for (const command of commands) {
    for (let index = 0; index < runCount; index += 1) {
      mutation += 1;
      samples.push({
        command,
        elapsedMs: await sampleCommand(home, command, options.mutateSkill, mutation, env),
      });
    }
  }
  return { samples };
}

interface MarkdownContext {
  /** Human description of the benchmarked fleet, e.g. "isolated 12-Project fleet". */
  readonly fixtureDescription: string;
  /** Optional baseline note naming the pre-optimization measurements. */
  readonly baselineNote?: string;
}

/** Mean, minimum, and maximum over one command's samples, in seconds. */
function summarize(
  command: LifecycleBenchmarkCommand,
  result: LifecycleBenchmarkResult,
): { readonly max: number; readonly mean: number; readonly min: number } {
  const samples = result.samples
    .filter((sample) => sample.command === command)
    .map((sample) => sample.elapsedMs / 1000);
  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  return { max: Math.max(...samples), mean, min: Math.min(...samples) };
}

/**
 * Render one markdown qualification record for the benchmark result. The table
 * is structural evidence: command, run count, mean/min/max seconds. No
 * hardware-dependent threshold is asserted anywhere; the numbers are recorded
 * for comparison against the parent spec's observed baseline.
 */
export function formatBenchmarkMarkdown(
  result: LifecycleBenchmarkResult,
  context: MarkdownContext,
): string {
  const commands = [...new Set(result.samples.map((sample) => sample.command))];
  const rows = commands
    .map((command) => {
      const { max, mean, min } = summarize(command, result);
      const runs = result.samples.filter((sample) => sample.command === command).length;
      return `| ${command} | ${runs} | ${mean.toFixed(3)} | ${min.toFixed(3)} | ${max.toFixed(3)} |`;
    })
    .join("\n");
  const baseline = context.baselineNote === undefined ? "" : `\n\nBaseline: ${context.baselineNote}.`;
  return [
    "## Fleet synchronization warm-run benchmark",
    "",
    `Fixture: ${context.fixtureDescription}. Warm runs through the lifecycle command layer in-process;`,
    "samples are release evidence, not CI timing gates.",
    "",
    "| Command | Runs | Mean (s) | Min (s) | Max (s) |",
    "|---|---|---|---|---|",
    rows,
    baseline,
    "",
  ].join("\n");
}
