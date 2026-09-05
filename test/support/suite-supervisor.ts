import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess, type ProcessResult } from "./process-executor.js";

/**
 * One repository-owned command surface for bounded focused, full, and repeated
 * stress verification. Every mode supervises Bun test runs through the shared
 * bounded process executor: each run is a process-group leader with a finite
 * per-run deadline, and stress adds a sequential aggregate deadline. On
 * timeout, interruption, or failure the complete process group is cleaned up,
 * and each run retains one structured diagnostic log. Consumers invoke the
 * canonical package scripts; timeout values and repetition policy live here.
 */

export type SuiteMode = "full" | "focused" | "stress";

/** Bun's per-test timeout; the single canonical policy value. */
export const PER_TEST_TIMEOUT_MS = 10_000;
/** Outer deadline for one full-suite run (five minutes). */
export const DEFAULT_PER_RUN_DEADLINE_MS = 300_000;
/** Aggregate deadline for a stress run (25 minutes). */
export const DEFAULT_AGGREGATE_DEADLINE_MS = 1_500_000;
/** A stress run completes after this many sequential green runs. */
export const DEFAULT_MAX_RUNS = 10;
/** Fleet-scale regressions excluded from the fast suite's deadline. */
export const FAST_SUITE_PATH_IGNORE_PATTERNS = ["test/fleet-qualification.test.ts"] as const;
/** Optional canonical CLI input for an explicit diagnostics directory. */
export const DIAGNOSTICS_DIR_ENV = "APKIT_TEST_DIAGNOSTICS_DIR";
/**
 * Bun's explicit local snapshot-update workflow is the runner's own
 * `--update-snapshots` flag. Bun does not expose that mode to the tests it
 * runs, so the supervisor marks the child environment when it forwards the
 * flag; the golden atomicity gate reads this marker to allow committed
 * baseline creation. CI never passes the flag and never sets the marker.
 */
export const UPDATE_SNAPSHOTS_FLAG = "--update-snapshots";
export const UPDATE_SNAPSHOTS_ENV = "APKIT_TEST_UPDATE_SNAPSHOTS";

export interface SupervisedRun {
  readonly runNumber: number;
  readonly result: ProcessResult;
  readonly logPath: string;
}

export interface SuiteSupervisorOptions {
  readonly mode: SuiteMode;
  /** Focused test paths and filters forwarded verbatim to `bun test`. */
  readonly bunArguments?: readonly string[];
  /**
   * Override the supervised suite command. Test injection only; the canonical
   * surface always supervises `bun test`.
   */
  readonly suiteCommand?: readonly [string, ...string[]];
  readonly perRunDeadlineMs?: number;
  readonly aggregateDeadlineMs?: number;
  readonly maxRuns?: number;
  /** Where per-run diagnostic logs are retained (default: under the OS tmpdir). */
  readonly logDir?: string;
  /** Passed through to the bounded executor for timeout cleanup. */
  readonly cleanupGraceMs?: number;
  /** Called as each run completes, before the next run starts. */
  readonly onRunComplete?: (run: SupervisedRun) => void;
}

export interface SuiteSupervisorResult {
  readonly mode: SuiteMode;
  readonly ok: boolean;
  readonly attemptedRuns: number;
  readonly completedRuns: number;
  readonly maxRuns: number;
  readonly runs: readonly SupervisedRun[];
  readonly aggregateDurationMs: number;
  readonly logDir: string;
  readonly firstFailure: SupervisedRun | null;
  /** True when stress exhausted its aggregate budget before or during a run. */
  readonly aggregateExhausted: boolean;
  /** True when the run was interrupted through the abort signal. */
  readonly interrupted: boolean;
}

function isMode(value: string): value is SuiteMode {
  return value === "full" || value === "focused" || value === "stress";
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`suite supervisor ${name} must be a positive finite number, got ${value}`);
  }
}

function validate(options: SuiteSupervisorOptions): void {
  if (!isMode(options.mode)) {
    throw new Error(`suite supervisor mode must be full, focused, or stress, got '${options.mode}'`);
  }
  const perRun = options.perRunDeadlineMs ?? DEFAULT_PER_RUN_DEADLINE_MS;
  assertPositiveFinite(perRun, "perRunDeadlineMs");
  const argumentCount = options.bunArguments?.length ?? 0;
  if (options.mode === "focused" && argumentCount === 0) {
    throw new Error("suite supervisor focused mode requires an explicit test path or filter");
  }
  if (options.mode !== "focused" && argumentCount > 0) {
    throw new Error(`suite supervisor ${options.mode} accepts no test arguments; use focused`);
  }
  if (options.mode === "stress") {
    const aggregate = options.aggregateDeadlineMs ?? DEFAULT_AGGREGATE_DEADLINE_MS;
    assertPositiveFinite(aggregate, "aggregateDeadlineMs");
    if (aggregate < perRun) {
      throw new Error(
        `suite supervisor stress aggregateDeadlineMs (${aggregate}) must be >= perRunDeadlineMs (${perRun})`,
      );
    }
    const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    if (!Number.isInteger(maxRuns) || maxRuns <= 0) {
      throw new Error(`suite supervisor maxRuns must be a positive integer, got ${maxRuns}`);
    }
  }
}

function suiteProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  bunArguments?: readonly string[],
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment[DIAGNOSTICS_DIR_ENV];
  if (bunArguments?.includes(UPDATE_SNAPSHOTS_FLAG) === true) {
    childEnvironment[UPDATE_SNAPSHOTS_ENV] = "1";
  }
  return childEnvironment;
}

function isGreen(result: ProcessResult): boolean {
  return result.kind === "exit" && result.exitCode === 0;
}

function defaultLogDir(mode: SuiteMode): string {
  const logDir = mkdtempSync(join(tmpdir(), `agent-profile-kit-test-${mode}-`));
  // POSIX mkdtemp is private by default; chmod makes the invariant explicit
  // even under an unusually restrictive or platform-specific caller umask.
  chmodSync(logDir, 0o700);
  return logDir;
}

function writeRunLog(
  logDir: string,
  runNumber: number,
  maxRuns: number,
  mode: SuiteMode,
  result: ProcessResult,
): string {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `run-${runNumber}.log`);
  const lines = [
    `=== suite run ${runNumber}/${maxRuns} (${mode}) ===`,
    `command: ${result.commandLabel}`,
    `kind: ${result.kind}`,
    `exitCode: ${result.exitCode ?? "null"}`,
    `signal: ${result.signal ?? "null"}`,
    `timedOut: ${result.timedOut}`,
    `cancelled: ${result.cancelled}`,
    `cleanupFailed: ${result.cleanupFailed}`,
    `error: ${result.error?.message ?? "null"}`,
    `durationMs: ${result.durationMs}`,
    `--- stdout ---`,
    result.stdout,
    `--- stderr ---`,
    result.stderr,
  ];
  writeFileSync(logPath, lines.join("\n") + "\n", { mode: 0o600 });
  return logPath;
}

/**
 * Run one or more supervised suites. `full` and `focused` perform exactly one
 * run; `stress` runs sequentially up to `maxRuns` green runs, stopping at the
 * first failure or timeout. Its final run uses the smaller of the per-run and
 * remaining aggregate budgets, so useful aggregate time is not discarded. On
 * timeout or interruption the bounded executor cleans up the complete child
 * process group before resolving.
 */
export async function runSupervisedSuite(
  options: SuiteSupervisorOptions,
  abortSignal?: AbortSignal,
): Promise<SuiteSupervisorResult> {
  validate(options);
  const mode = options.mode;
  const perRun = options.perRunDeadlineMs ?? DEFAULT_PER_RUN_DEADLINE_MS;
  const maxRuns = mode === "stress" ? (options.maxRuns ?? DEFAULT_MAX_RUNS) : 1;
  const aggregate =
    mode === "stress" ? (options.aggregateDeadlineMs ?? DEFAULT_AGGREGATE_DEADLINE_MS) : perRun;
  const logDir = options.logDir ?? defaultLogDir(mode);
  // Canonical scripts run this module under Bun; reuse that exact executable so
  // focused/full/stress runs cannot drift to another PATH entry or lose Bun
  // under a restricted PATH.
  const suiteCommand = options.suiteCommand ?? ([process.execPath, "test"] as const);
  const startedAt = Date.now();
  const runs: SupervisedRun[] = [];
  let interrupted = false;
  let aggregateExhausted = false;

  while (runs.length < maxRuns) {
    if (abortSignal?.aborted === true) {
      interrupted = true;
      break;
    }
    let runDeadline = perRun;
    let aggregateLimitedRun = false;
    if (mode === "stress") {
      const remainingAggregate = aggregate - (Date.now() - startedAt);
      if (remainingAggregate <= 0) {
        aggregateExhausted = true;
        break;
      }
      runDeadline = Math.min(perRun, remainingAggregate);
      aggregateLimitedRun = runDeadline < perRun;
    }
    const runNumber = runs.length + 1;
    const result = await runProcess(
      {
        executable: suiteCommand[0],
        arguments_: [
          ...suiteCommand.slice(1),
          "--timeout",
          String(PER_TEST_TIMEOUT_MS),
          ...(mode === "focused"
            ? []
            : FAST_SUITE_PATH_IGNORE_PATTERNS.flatMap((pattern) => [
                "--path-ignore-patterns",
                pattern,
              ])),
          ...(options.bunArguments ?? []),
        ],
        deadlineMs: runDeadline,
        environment: suiteProcessEnvironment(process.env, options.bunArguments),
        ...(options.cleanupGraceMs === undefined ? {} : { cleanupGraceMs: options.cleanupGraceMs }),
        commandLabel: `suite ${mode} run ${runNumber}/${maxRuns}`,
      },
      abortSignal,
    );
    if (result.cancelled) {
      interrupted = true;
    }
    if (aggregateLimitedRun && result.kind === "timeout") {
      aggregateExhausted = true;
    }
    const logPath = writeRunLog(logDir, runNumber, maxRuns, mode, result);
    const run: SupervisedRun = { runNumber, result, logPath };
    runs.push(run);
    options.onRunComplete?.(run);
    if (!isGreen(result)) {
      break;
    }
  }

  const completedRuns = runs.filter((run) => isGreen(run.result)).length;
  const ok = runs.length === maxRuns && completedRuns === maxRuns;
  const firstFailure = runs.find((run) => !isGreen(run.result)) ?? null;
  return {
    mode,
    ok,
    attemptedRuns: runs.length,
    completedRuns,
    maxRuns,
    runs,
    aggregateDurationMs: Date.now() - startedAt,
    logDir,
    firstFailure,
    aggregateExhausted,
    interrupted,
  };
}

function describeOutcome(result: ProcessResult): string {
  switch (result.kind) {
    case "exit":
      return `exit ${result.exitCode}`;
    case "signal":
      return `signal ${result.signal}`;
    case "timeout":
      return "timeout";
    case "spawn-error":
      return `spawn error (${result.error.message})`;
    case "cancelled":
      return "cancelled";
  }
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatSuiteSummary(
  result: SuiteSupervisorResult,
  interruptedBy: string | null,
): string {
  const duration = formatSeconds(result.aggregateDurationMs);
  if (result.mode === "stress") {
    if (interruptedBy !== null) {
      return `suite stress: interrupted (${interruptedBy}) after ${result.attemptedRuns}/${result.maxRuns} runs in ${duration} — logs: ${result.logDir}`;
    }
    if (result.ok) {
      return `suite stress: ${result.completedRuns}/${result.maxRuns} runs green in ${duration} — logs: ${result.logDir}`;
    }
    if (result.aggregateExhausted) {
      const failure = result.firstFailure;
      return failure === null
        ? `suite stress: aggregate deadline reached after ${result.attemptedRuns}/${result.maxRuns} runs in ${duration} — logs: ${result.logDir}`
        : `suite stress: aggregate deadline reached during run ${failure.runNumber}/${result.maxRuns} (${describeOutcome(failure.result)}) in ${duration} — log: ${failure.logPath}`;
    }
    const failure = result.firstFailure!;
    return `suite stress: failed at run ${failure.runNumber}/${result.maxRuns} (${describeOutcome(failure.result)}) in ${duration} — log: ${failure.logPath}`;
  }
  const run = result.runs[0]!;
  const outcome =
    interruptedBy !== null
      ? `interrupted (${interruptedBy})`
      : result.ok
        ? describeOutcome(run.result)
        : `failed (${describeOutcome(run.result)})`;
  return `suite ${result.mode}: 1 run, ${outcome} in ${duration} — log: ${run.logPath}`;
}

function diagnosticsDirFromEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  const authored = environment[DIAGNOSTICS_DIR_ENV];
  if (authored === undefined) {
    return undefined;
  }
  if (authored.trim().length === 0) {
    throw new Error(`suite supervisor ${DIAGNOSTICS_DIR_ENV} must name a directory`);
  }
  return resolve(authored);
}

function printSummary(result: SuiteSupervisorResult, interruptedBy: string | null): void {
  console.log(formatSuiteSummary(result, interruptedBy));
}

function signalExitCode(signalName: "SIGINT" | "SIGTERM"): number {
  return 128 + (signalName === "SIGINT" ? 2 : 15);
}

async function main(args: readonly string[]): Promise<number> {
  const [modeArg, ...rest] = args;
  if (modeArg === undefined || !isMode(modeArg)) {
    console.error(`suite supervisor: unknown mode '${modeArg ?? ""}' (expected full | focused | stress)`);
    return 2;
  }
  let bunArguments: readonly string[] = [];
  if (modeArg === "focused") {
    bunArguments = rest[0] === "--" ? rest.slice(1) : rest;
  } else if (rest.length > 0) {
    console.error(`suite supervisor: ${modeArg} accepts no test arguments; use test:focused`);
    return 2;
  }

  let explicitDiagnosticsDir: string | undefined;
  try {
    // Normalize and validate every CLI input before announcing a run.
    validate({ mode: modeArg, bunArguments });
    explicitDiagnosticsDir = diagnosticsDirFromEnvironment(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const controller = new AbortController();
  let interruptedBy: "SIGINT" | "SIGTERM" | null = null;
  const interrupt = (signalName: "SIGINT" | "SIGTERM") => {
    if (interruptedBy === null) {
      interruptedBy = signalName;
      controller.abort();
    }
  };
  process.on("SIGINT", () => interrupt("SIGINT"));
  process.on("SIGTERM", () => interrupt("SIGTERM"));

  const mode = modeArg;
  if (mode === "stress") {
    console.log(
      `suite stress: up to ${DEFAULT_MAX_RUNS} runs (per-run deadline ${DEFAULT_PER_RUN_DEADLINE_MS}ms, aggregate deadline ${DEFAULT_AGGREGATE_DEADLINE_MS}ms)`,
    );
  } else {
    console.log(`suite ${mode}: run 1/1 starting (deadline ${DEFAULT_PER_RUN_DEADLINE_MS}ms)`);
  }

  const result = await runSupervisedSuite(
    {
      mode,
      bunArguments,
      ...(explicitDiagnosticsDir === undefined ? {} : { logDir: explicitDiagnosticsDir }),
      onRunComplete: (run) => {
        if (mode === "stress") {
          console.log(
            `suite stress: run ${run.runNumber}/${DEFAULT_MAX_RUNS} ${describeOutcome(run.result)} in ${formatSeconds(run.result.durationMs)} — log: ${run.logPath}`,
          );
        }
      },
    },
    controller.signal,
  );

  printSummary(result, interruptedBy);
  if (interruptedBy !== null) {
    return signalExitCode(interruptedBy);
  }
  return result.ok ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`suite supervisor: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
