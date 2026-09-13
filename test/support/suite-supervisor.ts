import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess, type ProcessResult } from "../../process/process-executor.js";

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
/**
 * Measured default policy, selected from retained measurement rather than a
 * test-count floor or a universal speed target: on the development baseline
 * (macOS 26.6.2, arm64, Bun 1.4.0, 2026-09-13) an explicit focused selection
 * of the intended non-fleet corpus (all 90 non-fleet test files, 1911 tests)
 * completed in 366.3s through this supervisor, and the fleet file (11 tests)
 * in 17.8s. The per-run default is ~1.6x that measured corpus duration: it
 * bounds a hung or stalled run, not a completion target. Containment is
 * reachable-state arithmetic: measured CI setup before the test step is
 * ≈7–9s on the macos-15 runner (PR #553 check run), so one exhausted 600s
 * run plus setup stays well inside CI's 15-minute job ceiling and the
 * supervisor's bounded timeout — not the job clock — owns a hung run. The
 * stress aggregate is coherent by construction — every one of the sequential
 * runs may use its full per-run deadline inside the aggregate. Final
 * equivalent-corpus completion evidence is the integrated-qualification
 * ticket's obligation (#552), not this default.
 */
export const DEFAULT_PER_RUN_DEADLINE_MS = 600_000;
/** A stress run completes after this many sequential green runs. */
export const DEFAULT_MAX_RUNS = 10;
/** Aggregate stress deadline, coherent with the per-run default by construction. */
export const DEFAULT_AGGREGATE_DEADLINE_MS = DEFAULT_MAX_RUNS * DEFAULT_PER_RUN_DEADLINE_MS;
/**
 * Node timers wrap delays above 2^31−1 ms down to 1 ms, so a larger finite
 * budget would fire immediately instead of bounding the run. Budgets above
 * this timer-safe ceiling are rejected, never silently truncated.
 */
export const MAX_BUDGET_MS = 2_147_483_647;
/** Optional CLI override of the per-run deadline; every mode accepts it. */
export const PER_RUN_DEADLINE_ENV = "APKIT_TEST_PER_RUN_DEADLINE_MS";
/** Optional CLI override of the stress aggregate deadline; stress mode only. */
export const AGGREGATE_DEADLINE_ENV = "APKIT_TEST_AGGREGATE_DEADLINE_MS";
/** Optional CLI override of the stress run count; stress mode only. */
export const MAX_RUNS_ENV = "APKIT_TEST_MAX_RUNS";
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

/** The one resolved, validated budget contract for a supervised invocation. */
export interface BudgetPolicy {
  readonly mode: SuiteMode;
  readonly perRunDeadlineMs: number;
  readonly aggregateDeadlineMs: number;
  readonly maxRuns: number;
}

/**
 * Validate every budget and resolve the effective policy. Overrides are
 * finite positive integers at or below the timer-safe ceiling (a larger
 * finite value would wrap to a 1 ms timer), stress budgets stay coherent
 * (the aggregate can complete at least one full run), and a run count is a
 * positive safe integer. Single-run modes accept only a per-run deadline:
 * an aggregate or run-count override there names a policy the invocation
 * can never deliver, so it is rejected as unsupported.
 */
export function resolveSuitePolicy(options: SuiteSupervisorOptions): BudgetPolicy {
  if (!isMode(options.mode)) {
    throw new Error(`suite supervisor mode must be full, focused, or stress, got '${options.mode}'`);
  }
  const mode = options.mode;
  const perRunDeadlineMs = options.perRunDeadlineMs ?? DEFAULT_PER_RUN_DEADLINE_MS;
  assertBudget(perRunDeadlineMs, "perRunDeadlineMs", PER_RUN_DEADLINE_ENV);
  if (mode !== "stress") {
    if (options.aggregateDeadlineMs !== undefined) {
      throw new Error(
        `suite supervisor aggregateDeadlineMs (from ${AGGREGATE_DEADLINE_ENV}) is not supported for ${mode} mode: a ${mode} invocation is one run bounded by perRunDeadlineMs`,
      );
    }
    if (options.maxRuns !== undefined) {
      throw new Error(
        `suite supervisor maxRuns (from ${MAX_RUNS_ENV}) is not supported for ${mode} mode: a ${mode} invocation is one run bounded by perRunDeadlineMs`,
      );
    }
    return { mode, perRunDeadlineMs, aggregateDeadlineMs: perRunDeadlineMs, maxRuns: 1 };
  }
  const aggregateDeadlineMs = options.aggregateDeadlineMs ?? DEFAULT_AGGREGATE_DEADLINE_MS;
  assertBudget(aggregateDeadlineMs, "aggregateDeadlineMs", AGGREGATE_DEADLINE_ENV);
  if (aggregateDeadlineMs < perRunDeadlineMs) {
    throw new Error(
      `suite supervisor stress aggregate deadline (aggregateDeadlineMs / ${AGGREGATE_DEADLINE_ENV}) (${aggregateDeadlineMs}) must be >= per-run deadline (perRunDeadlineMs / ${PER_RUN_DEADLINE_ENV}) (${perRunDeadlineMs})`,
    );
  }
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  if (
    !Number.isFinite(maxRuns) ||
    !Number.isInteger(maxRuns) ||
    maxRuns <= 0 ||
    maxRuns > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `suite supervisor maxRuns (from ${MAX_RUNS_ENV}) must be a positive safe integer, got ${maxRuns}`,
    );
  }
  return { mode, perRunDeadlineMs, aggregateDeadlineMs, maxRuns };
}

function assertBudget(value: number, name: string, environmentName: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `suite supervisor ${name} (${environmentName}) must be a positive finite integer number of milliseconds, got ${value}`,
    );
  }
  if (value > MAX_BUDGET_MS) {
    throw new Error(
      `suite supervisor ${name} (${environmentName}) ${value} exceeds the ${MAX_BUDGET_MS}ms timer-safe ceiling: a larger finite value would wrap to a 1ms timer instead of bounding the run`,
    );
  }
}

/**
 * Parse one finite-budget override at the CLI boundary. The value must be a
 * decimal integer string; value range, finiteness, and coherence are owned by
 * `resolveSuitePolicy`, so the numeric rule keeps one home and this layer
 * attributes every syntax failure to its variable.
 */
function budgetOverride(environment: NodeJS.ProcessEnv, environmentName: string): number | undefined {
  const raw = environment[environmentName];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `suite supervisor ${environmentName} must be a positive decimal integer number of milliseconds, got '${raw}'`,
    );
  }
  return Number(trimmed);
}

interface PreparedInvocation {
  readonly options: SuiteSupervisorOptions;
  readonly attribution: readonly string[];
}

/**
 * Read the finite-budget overrides for one canonical invocation. Each value
 * must be a decimal integer string; value range, finiteness, coherence, and
 * mode support are owned by `resolveSuitePolicy`, so numeric policy keeps one
 * home and this boundary attributes every syntax failure to its variable.
 */
function supervisedOptionsFromEnvironment(
  mode: SuiteMode,
  bunArguments: readonly string[],
): PreparedInvocation {
  const perRunDeadlineMs = budgetOverride(process.env, PER_RUN_DEADLINE_ENV);
  const aggregateDeadlineMs =
    mode === "stress" ? budgetOverride(process.env, AGGREGATE_DEADLINE_ENV) : undefined;
  const maxRuns = mode === "stress" ? budgetOverride(process.env, MAX_RUNS_ENV) : undefined;
  // Single-run modes accept only a per-run deadline; other budget variables
  // name a policy the invocation can never deliver.
  if (mode !== "stress") {
    for (const unsupported of [AGGREGATE_DEADLINE_ENV, MAX_RUNS_ENV]) {
      if (process.env[unsupported] !== undefined) {
        throw new Error(
          `suite supervisor ${unsupported} is not supported for ${mode} mode: a ${mode} invocation is one run bounded by ${PER_RUN_DEADLINE_ENV}`,
        );
      }
    }
  }
  return {
    options: {
      mode,
      bunArguments,
      ...(perRunDeadlineMs === undefined ? {} : { perRunDeadlineMs }),
      ...(aggregateDeadlineMs === undefined ? {} : { aggregateDeadlineMs }),
      ...(maxRuns === undefined ? {} : { maxRuns }),
    },
    attribution: [
      ...(perRunDeadlineMs === undefined ? [] : [`${PER_RUN_DEADLINE_ENV}=${perRunDeadlineMs}`]),
      ...(
        aggregateDeadlineMs === undefined
          ? []
          : [`${AGGREGATE_DEADLINE_ENV}=${aggregateDeadlineMs}`]
      ),
      ...(maxRuns === undefined ? [] : [`${MAX_RUNS_ENV}=${maxRuns}`]),
    ],
  };
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

function validate(options: SuiteSupervisorOptions): BudgetPolicy {
  const policy = resolveSuitePolicy(options);
  const argumentCount = options.bunArguments?.length ?? 0;
  if (options.mode === "focused" && argumentCount === 0) {
    throw new Error("suite supervisor focused mode requires an explicit test path or filter");
  }
  if (options.mode !== "focused" && argumentCount > 0) {
    throw new Error(`suite supervisor ${options.mode} accepts no test arguments; use focused`);
  }
  return policy;
}

function suiteProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  bunArguments?: readonly string[],
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment[DIAGNOSTICS_DIR_ENV];
  // Budget overrides shape the supervisor, not the child runner; stripping
  // them keeps a test from accidentally reading invocation policy.
  delete childEnvironment[PER_RUN_DEADLINE_ENV];
  delete childEnvironment[AGGREGATE_DEADLINE_ENV];
  delete childEnvironment[MAX_RUNS_ENV];
  if (bunArguments?.includes(UPDATE_SNAPSHOTS_FLAG) === true) {
    childEnvironment[UPDATE_SNAPSHOTS_ENV] = "1";
  }
  return childEnvironment;
}

/**
 * Complete qualification is a typed `exit 0` result. Failed cleanup is never
 * green by construction: the executor's typed results make `cleanupFailed`
 * unrepresentable on `exit` (literal-false field), so a cleanup failure can
 * only appear on timeout/output-limit/cancelled kinds, which this predicate
 * already rejects by kind. No runtime re-check of `cleanupFailed` is added
 * here — that would assert an impossible state and imply `exit` could carry
 * cleanup failure; the typecheck at the executor boundary owns that invariant.
 */
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
  policy: BudgetPolicy,
  result: ProcessResult,
): string {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `run-${runNumber}.log`);
  const lines = [
    `=== suite run ${runNumber}/${policy.maxRuns} (${policy.mode}) ===`,
    `effective-policy: mode=${policy.mode} per-run=${policy.perRunDeadlineMs}ms aggregate=${policy.aggregateDeadlineMs}ms max-runs=${policy.maxRuns}`,
    `command: ${result.commandLabel}`,
    `kind: ${result.kind}`,
    `exitCode: ${result.exitCode ?? "null"}`,
    `signal: ${result.signal ?? "null"}`,
    `timedOut: ${result.timedOut}`,
    `cancelled: ${result.cancelled}`,
    `cleanupFailed: ${result.cleanupFailed}`,
    `cleanupDurationMs: ${result.cleanupDurationMs}`,
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
  const policy = validate(options);
  const mode = policy.mode;
  const perRun = policy.perRunDeadlineMs;
  const maxRuns = policy.maxRuns;
  const aggregate = policy.aggregateDeadlineMs;
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
    const logPath = writeRunLog(logDir, runNumber, policy, result);
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
    case "output-limit":
      return "output limit";
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
  let policy: BudgetPolicy;
  let attribution: readonly string[];
  let options: SuiteSupervisorOptions;
  try {
    // Normalize and validate every CLI input before announcing a run.
    const prepared = supervisedOptionsFromEnvironment(modeArg, bunArguments);
    policy = validate(prepared.options);
    attribution = prepared.attribution;
    explicitDiagnosticsDir = diagnosticsDirFromEnvironment(process.env);
    options = prepared.options;
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
  const overridesText =
    attribution.length > 0 ? `overrides: ${attribution.join(", ")}` : "policy: defaults";
  if (mode === "stress") {
    console.log(
      `suite stress: up to ${policy.maxRuns} runs (per-run deadline ${policy.perRunDeadlineMs}ms, aggregate deadline ${policy.aggregateDeadlineMs}ms, ${overridesText})`,
    );
  } else {
    console.log(
      `suite ${mode}: run 1/1 starting (per-run deadline ${policy.perRunDeadlineMs}ms, ${overridesText})`,
    );
  }

  const result = await runSupervisedSuite(
    {
      ...options,
      ...(explicitDiagnosticsDir === undefined ? {} : { logDir: explicitDiagnosticsDir }),
      onRunComplete: (run) => {
        if (mode === "stress") {
          console.log(
            `suite stress: run ${run.runNumber}/${policy.maxRuns} ${describeOutcome(run.result)} in ${formatSeconds(run.result.durationMs)} — log: ${run.logPath}`,
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
