import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";

import {
  TEST_CHILD_DEADLINE_MS,
  describeProcessResult,
  runProcess,
  type ProcessResult,
} from "../../process/process-executor.js";
import { enumerateTestCorpus, TEST_CORPUS_ROOT } from "./corpus-inventory.js";
import { parseBunJunitEvidence } from "./junit-evidence.js";
import {
  PackagePreparationStageError,
  PREPARED_PACKAGE_ARCHIVE_ENV,
  preparedPackageArchive,
  removePathBounded,
  SUPERVISED_INVOCATION_ENV,
  supervisedInvocationActive,
  systemPackageArchiveCommands,
  type PackageArchiveCommands,
} from "./package-archive.js";
import {
  createPackageRequestChannel,
  filedPackageRequests,
  PACKAGE_REQUEST_CHANNEL_ENV,
  PACKAGE_REQUEST_WAIT_ENV,
  publishPackageChannelResponse,
  removePackageChannel,
  type PackageRequestChannel,
} from "./package-request-channel.js";
import {
  InvalidProvenanceError,
  UnsupportedSourceError,
  UnstableSourceError,
  createPackageCandidate,
  validateSuppliedPackageCandidate,
} from "./package-identity.js";

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

/** Minimum Bun watchdog; a supervised runner grants at least its preparation budget. */
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
/** Fleet-scale regressions excluded from the fast suite's required selection. */
export const FAST_SUITE_PATH_IGNORE_PATTERNS = ["test/fleet-qualification.test.ts"] as const;
/**
 * The runner's structured execution evidence, retained per supervised run and
 * parsed fail-closed by `test/support/junit-evidence.ts`. Its per-file
 * executed/skipped/failure counts are the completion evidence for required
 * selection: a green exit without parseable evidence is never a complete
 * qualification.
 */
export function junitEvidencePath(logDir: string, runNumber: number): string {
  return join(logDir, `run-${runNumber}.junit.xml`);
}
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
  /**
   * Required-selection completion evidence, present only when the canonical
   * runner ran and the run exited green: coverage gates are evaluated on green
   * exits, where they are the only remaining defense against a misleading
   * pass. Absent on injected test-seam commands and non-green runs.
   */
  readonly coverage?: SelectionCoverage;
}

/** Whether one green run's observed execution matched the required selection. */
export interface SelectionCoverage {
  readonly status: "complete" | "incomplete";
  readonly executedFiles: number;
  readonly skippedTests: number;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  /** Why the run cannot be complete qualification, when status is incomplete. */
  readonly reason?: string;
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
  /**
   * Working directory for the supervised child. It is also the corpus base:
   * the test-corpus policy is anchored at `<cwd>/test`. Defaults to the
   * supervisor process's working directory (the package root for canonical
   * scripts).
   */
  readonly cwd?: string;
  /** Passed through to the bounded executor for timeout cleanup. */
  readonly cleanupGraceMs?: number;
  /** Called as each run completes, before the next run starts. */
  readonly onRunComplete?: (run: SupervisedRun) => void;
  /**
   * Test seam: replace the bounded package preparation commands (for example
   * an injected command pair that produces a real tarball). Canonical
   * invocations always run the system build and pack stages.
   */
  readonly packageCommands?: PackageArchiveCommands;
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
function budgetOverride(
  environment: NodeJS.ProcessEnv,
  environmentName: string,
  unit: string,
): number | undefined {
  const raw = environment[environmentName];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `suite supervisor ${environmentName} must be a positive decimal integer ${unit}, got '${raw}'`,
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
  const perRunDeadlineMs = budgetOverride(process.env, PER_RUN_DEADLINE_ENV, "number of milliseconds");
  const aggregateDeadlineMs =
    mode === "stress"
      ? budgetOverride(process.env, AGGREGATE_DEADLINE_ENV, "number of milliseconds")
      : undefined;
  const maxRuns = mode === "stress" ? budgetOverride(process.env, MAX_RUNS_ENV, "run count") : undefined;
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
  /** Invocation-package preparation evidence for this invocation. */
  readonly preparation: PreparationEvidence;
}

/**
 * One invocation's package preparation evidence. Preparation is lazy and
 * supervisor-owned: the status resolves by the end of the invocation —
 * prepared (one fresh immutable candidate was built and packed on the first
 * actual consumer request), supplied (an operator-supplied archive passed
 * through with zero preparation), none (no consumer requested the package),
 * failed (the requested preparation failed; diagnostics retained in
 * `preparation.log`), or interrupted (the abort signal stopped a preparation
 * that a consumer had requested). `requests` counts the consumer requests the
 * channel received, so a green invocation with `requests: 0` is the proof
 * that no consumer executed. The prepared candidate's directory — recorded in
 * `candidateDirectory` — is removed after the invocation through the bounded
 * executor with its duration reported; supplied archives are never touched.
 * `childCleanupFailed`/`childCleanupDurationMs` carry a preparation child's
 * own bounded cleanup evidence separately from the directory cleanup's.
 */
export interface PreparationEvidence {
  readonly status: "prepared" | "supplied" | "none" | "failed" | "interrupted";
  readonly requests: number;
  readonly durationMs: number;
  readonly cleanupDurationMs: number;
  readonly cleanupFailed: boolean;
  readonly archivePath?: string;
  readonly candidateDirectory?: string;
  readonly failure?: string;
  readonly cleanupFailure?: string;
  readonly childCleanupFailed?: boolean;
  readonly childCleanupDurationMs?: number;
  /** Retained stage output for a failed or interrupted preparation. */
  readonly diagnostics?: string;
}

/** The filename of a failed or interrupted preparation's retained diagnostics. */
export const PREPARATION_LOG_FILENAME = "preparation.log";

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
  bunArguments: readonly string[] | undefined,
  canonicalRunner: boolean,
  preparedArchivePath: string | undefined,
  suppliedArchivePath: string | undefined,
  channel: PackageRequestChannel | null,
  runDeadlineMs: number,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment };
  delete childEnvironment[DIAGNOSTICS_DIR_ENV];
  // Budget overrides shape the supervisor, not the child runner; stripping
  // them keeps a test from accidentally reading invocation policy.
  delete childEnvironment[PER_RUN_DEADLINE_ENV];
  delete childEnvironment[AGGREGATE_DEADLINE_ENV];
  delete childEnvironment[MAX_RUNS_ENV];
  // Only canonically supervised children carry the supervised-invocation
  // marker: an injected test-seam command manages its own execution and must
  // not claim supervision (nor inherit an ambient marker from a nesting
  // supervised run).
  delete childEnvironment[SUPERVISED_INVOCATION_ENV];
  if (canonicalRunner) {
    childEnvironment[SUPERVISED_INVOCATION_ENV] = "1";
  }
  // The archive and channel environment is written explicitly, never
  // inherited: a child of a nested invocation must not receive the parent
  // invocation's candidate or channel as if they were this invocation's own,
  // and an operator-supplied archive is passed through untouched (its bytes
  // are never rewritten or removed here).
  delete childEnvironment[PREPARED_PACKAGE_ARCHIVE_ENV];
  delete childEnvironment[PACKAGE_REQUEST_CHANNEL_ENV];
  delete childEnvironment[PACKAGE_REQUEST_WAIT_ENV];
  if (preparedArchivePath !== undefined) {
    childEnvironment[PREPARED_PACKAGE_ARCHIVE_ENV] = preparedArchivePath;
  } else if (suppliedArchivePath !== undefined) {
    childEnvironment[PREPARED_PACKAGE_ARCHIVE_ENV] = suppliedArchivePath;
  } else if (canonicalRunner && channel !== null) {
    childEnvironment[PACKAGE_REQUEST_CHANNEL_ENV] = channel.directory;
    childEnvironment[PACKAGE_REQUEST_WAIT_ENV] = String(runDeadlineMs);
  }
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

/** A run is complete only when it is green and its required coverage is complete. */
function runComplete(run: SupervisedRun): boolean {
  return isGreen(run.result) && (run.coverage?.status ?? "complete") === "complete";
}

/** The one resolved runner-identity and selection contract for an invocation. */
export interface PreparedSuiteInvocation {
  readonly policy: BudgetPolicy;
  /** The corpus base directory (the supervised child's working directory). */
  readonly base: string;
  /** Derived corpus selection; null only for injected test-seam commands. */
  readonly plan: SelectionPlan | null;
  /** Invocation-level evidence lines prefixed to every retained run log. */
  readonly runtimeHeader: readonly string[];
}

/** Which corpus files the invocation requires and which policy removes. */
export interface SelectionPlan {
  /** Every corpus test file before the exclusion policy, POSIX-relative to `base`. */
  readonly files: readonly string[];
  /** Required selection, POSIX-relative to the corpus base. */
  readonly selected: readonly string[];
  /** Files removed by the exclusion policy, POSIX-relative to the corpus base. */
  readonly excluded: readonly string[];
  /** Focused arguments that name corpus files; other arguments are filters. */
  readonly named: readonly string[];
  /** True when a focused invocation filters by test name (e.g. `-t`). */
  readonly nameFilterActive: boolean;
}

function corpusBase(options: SuiteSupervisorOptions): string {
  return resolve(options.cwd ?? process.cwd());
}

function normalizeRelativePath(base: string, value: string): string {
  return relative(base, resolve(base, value)).split("\\").join("/");
}

/**
 * One canonical home for the pinned Bun version: package.json `engines.bun`.
 * Local development (this gate) and CI (`setup-bun` with
 * `bun-version-file: package.json`) read the same field, so one edit moves
 * every consumer and the selected Bun cannot drift between them.
 */
export function pinnedBunVersion(): string {
  const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    engines?: { bun?: unknown };
  };
  const pinned = manifest.engines?.bun;
  if (typeof pinned !== "string" || pinned.length === 0) {
    throw new Error(
      "the pinned Bun version is missing from package.json engines.bun; the suite supervisor requires one canonical pin for local development and CI",
    );
  }
  return pinned;
}

/**
 * The supported runner configuration is the pinned Bun version. Any other
 * runner identity is rejected before it can produce a misleading pass: the
 * historical CI runner degenerated required selection under Bun 1.2.17.
 */
export function assertRunnerIsPinnedBun(
  pinned: string,
  runningVersion: string | undefined,
): void {
  if (runningVersion !== pinned) {
    throw new Error(
      `the suite supervisor must run under the pinned Bun ${pinned} (package.json engines.bun), got ${runningVersion ?? "a non-Bun runtime"}; install that exact version to qualify`,
    );
  }
}

/**
 * bunfig.toml `[test]` settings (root/filter/preload) can silently redirect or
 * preload into required selection, so a repository bunfig carrying a test
 * section is rejected before any run; an unparseable bunfig is also rejected
 * because an unreadable configuration cannot be proven harmless. (An ambient
 * home-directory bunfig is controlled-environment isolation territory, not
 * repository selection policy.)
 */
function rejectSilentSelectionConfig(base: string): void {
  const bunfigPath = join(base, "bunfig.toml");
  if (!existsSync(bunfigPath)) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(bunfigPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unsupported test-runner configuration: '${bunfigPath}' does not parse as TOML (${error instanceof Error ? error.message : String(error)}); it could silently change required selection`,
    );
  }
  if (parsed !== null && typeof parsed === "object" && "test" in parsed) {
    throw new Error(
      `unsupported test-runner configuration: '${bunfigPath}' defines a [test] section whose root/filter/preload settings could silently change required selection; move test policy into the suite supervisor`,
    );
  }
}

/**
 * Derive the required selection from the current corpus and the exclusion
 * policy. Full and stress selections are passed to the runner as explicit
 * paths, so exclusion is structural; a zero-selection invocation is rejected
 * before it can start. Focused mode retains explicit selection: only
 * arguments naming corpus files count as named selections; the rest are
 * filters and are never treated as missing coverage.
 */
/**
 * The consumer capability declarations travel with the files that carry them;
 * fixture corpora declare through the same marker module as the repository
 * corpus, so no registry is consulted and no base-identity check is needed.
 */

function deriveSelectionPlan(
  mode: SuiteMode,
  base: string,
  bunArguments?: readonly string[],
): SelectionPlan {
  const inventory = enumerateTestCorpus(base, FAST_SUITE_PATH_IGNORE_PATTERNS);
  if (mode === "focused") {
    // Named selections come from the raw corpus inventory (before the
    // exclusion policy): the canonical fleet run explicitly names the
    // policy-excluded file, and its named-file execution gate must be live.
    const named = (bunArguments ?? [])
      .map((argument) => normalizeRelativePath(base, argument))
      .filter((normalized) => inventory.files.includes(normalized));
    return {
      files: inventory.files,
      selected: inventory.selected,
      excluded: inventory.excluded,
      named,
      // A name filter intentionally selects fewer tests, and bun's junit
      // evidence reports the filter complement as skipped without
      // distinguishing it from test.skip(); only in that case is the skip
      // gate waived (recorded, never silent). Without a filter — including
      // the canonical fleet selection — skips gate strictly.
      nameFilterActive: (bunArguments ?? []).some(
        (argument) => argument === "-t" || argument.startsWith("--test-name-pattern"),
      ),
    };
  }
  if (inventory.selected.length === 0) {
    throw new Error(
      `suite supervisor ${mode} mode: required selection cannot be empty after exclusions (${inventory.excluded.join(", ")})`,
    );
  }
  return {
    files: inventory.files,
    selected: inventory.selected,
    excluded: inventory.excluded,
    named: [],
    nameFilterActive: false,
  };
}

/**
 * Resolve the runner identity, selection configuration, and corpus-derived
 * plan for one invocation before any run starts. Unsupported runner
 * configuration exits before it can produce a misleading pass.
 */
export function prepareSuiteInvocation(options: SuiteSupervisorOptions): PreparedSuiteInvocation {
  const policy = validate(options);
  const base = corpusBase(options);
  if (options.suiteCommand !== undefined) {
    // Test seam only: an injected command is not the runner whose selection is
    // being proven, so identity and selection gates do not apply to it, and
    // it manages its own execution, so no request channel is created for it.
    return {
      policy,
      base,
      plan: null,
      runtimeHeader: [
        `runtime: ${options.suiteCommand[0]} (test seam — pinned-runner identity not asserted)`,
      ],
    };
  }
  assertRunnerIsPinnedBun(pinnedBunVersion(), process.versions.bun);
  rejectSilentSelectionConfig(base);
  const plan = deriveSelectionPlan(policy.mode, base, options.bunArguments);
  return {
    policy,
    base,
    plan,
    runtimeHeader: [
      `runtime: bun ${process.versions.bun} (${process.execPath}) ${process.platform} ${process.arch}`,
      ...(policy.mode === "focused"
        ? [
            `selection: mode=focused explicit-selection named=${plan.named.length}`,
            `selection-named: ${plan.named.join(" ")}`,
          ]
        : [
            `selection: mode=${policy.mode} test-root=${TEST_CORPUS_ROOT} selected=${plan.selected.length} excluded=${plan.excluded.length}`,
            `selection-excluded: ${plan.excluded.join(" ")}`,
          ]),
    ],
  };
}

function selectionCoverage(
  status: "complete" | "incomplete",
  executedFiles: number,
  skippedTests: number,
  missing: readonly string[],
  unexpected: readonly string[],
  reason?: string,
): SelectionCoverage {
  return reason === undefined
    ? { status, executedFiles, skippedTests, missing, unexpected }
    : { status, executedFiles, skippedTests, missing, unexpected, reason };
}

/**
 * Fail closed: missing or unparseable evidence is incompleteness, never
 * executed coverage. Full and stress runs must execute exactly the derived
 * required selection; focused runs must execute every explicitly selected
 * corpus file while never declaring intentional filter selection missing.
 * Skipped required coverage and zero executed coverage are never complete.
 */
function evaluateRunCoverage(
  invocation: PreparedSuiteInvocation,
  junitPath: string,
): SelectionCoverage {
  const plan = invocation.plan;
  if (plan === null) {
    return selectionCoverage("complete", 0, 0, [], []);
  }
  let executed: Set<string>;
  let skippedTests: number;
  let executedTests: number;
  try {
    if (!existsSync(junitPath)) {
      throw new Error("execution evidence was not written");
    }
    const evidence = parseBunJunitEvidence(readFileSync(junitPath, "utf8"));
    executed = new Set(evidence.suites.map((suite) => normalizeRelativePath(invocation.base, suite.file)));
    skippedTests = evidence.suites.reduce((sum, suite) => sum + suite.skipped, 0);
    executedTests = evidence.suites.reduce((sum, suite) => sum + (suite.tests - suite.skipped), 0);
  } catch (error) {
    const reason = `execution evidence missing or unparseable: ${error instanceof Error ? error.message : String(error)}`;
    return selectionCoverage("incomplete", 0, 0, [], [], reason);
  }
  const incomplete = (
    reason: string,
    missing: readonly string[] = [],
    unexpected: readonly string[] = [],
  ): SelectionCoverage =>
    selectionCoverage("incomplete", executed.size, skippedTests, missing, unexpected, reason);
  if (executedTests === 0) {
    return incomplete("zero runnable required selection");
  }
  if (invocation.policy.mode === "focused") {
    const missingNamed = plan.named.filter((path) => !executed.has(path));
    if (missingNamed.length > 0) {
      return incomplete(
        `explicitly selected files without executed evidence: ${missingNamed.join(", ")}`,
        missingNamed,
      );
    }
    if (!plan.nameFilterActive && skippedTests > 0) {
      return incomplete(`skipped required coverage: ${skippedTests}`);
    }
    // A focused invocation's name filters intentionally select fewer tests,
    // and bun's junit evidence reports the filter complement as skipped
    // without distinguishing it from test.skip(). Skip counts under an
    // active name filter are therefore retained as evidence (this record and
    // the junit artifact), never silently waived; focused runs without a
    // name filter — including the canonical fleet selection — and every
    // full/stress run gate skips strictly below.
    return selectionCoverage("complete", executed.size, skippedTests, [], []);
  }
  if (skippedTests > 0) {
    return incomplete(`skipped required coverage: ${skippedTests}`);
  }
  const selected = new Set(plan.selected);
  const missing = plan.selected.filter((path) => !executed.has(path));
  const unexpected = [...executed].filter((path) => !selected.has(path));
  if (missing.length > 0 || unexpected.length > 0) {
    return incomplete(
      `required selection not executed as derived: missing ${missing.join(", ")}; unexpected ${unexpected.join(", ")}`,
      missing,
      unexpected,
    );
  }
  return selectionCoverage("complete", executed.size, skippedTests, missing, unexpected);
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
  invocation: PreparedSuiteInvocation,
  preparation: PreparationEvidence,
  result: ProcessResult,
  coverage?: SelectionCoverage,
): string {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `run-${runNumber}.log`);
  const policy = invocation.policy;
  const coverageLines =
    coverage === undefined
      ? []
      : [
          `coverage: status=${coverage.status} executed=${coverage.executedFiles} skipped=${coverage.skippedTests} missing=${coverage.missing.join(",") || "0"} unexpected=${coverage.unexpected.join(",") || "0"}${
            coverage.reason === undefined ? "" : ` reason: ${coverage.reason}`
          }`,
        ];
  const lines = [
    `=== suite run ${runNumber}/${policy.maxRuns} (${policy.mode}) ===`,
    ...invocation.runtimeHeader,
    `effective-policy: mode=${policy.mode} per-run=${policy.perRunDeadlineMs}ms aggregate=${policy.aggregateDeadlineMs}ms max-runs=${policy.maxRuns}`,
    preparationLogLine(preparation),
    // The lazy model's truth in one line: candidates are prepared on the
    // first actual consumer request, and a green run with `requests=0`
    // exercised no consumer at all.
    `preparation-model: lazy — prepared on the first supervised consumer request; no request means no preparation`,
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
    ...coverageLines,
    `--- stdout ---`,
    result.stdout,
    `--- stderr ---`,
    result.stderr,
  ];
  writeFileSync(logPath, lines.join("\n") + "\n", { mode: 0o600 });
  return logPath;
}

/**
 * The lazy, supervisor-owned package preparation for one invocation. A request
 * channel is owned for the whole invocation; a watcher polls it concurrently
 * with the runs, and the first actual consumer request triggers one bounded
 * preparation — the same build and pack stages through the shared bounded
 * executor, sharing one finite preparation budget (the per-run deadline, or
 * the stress aggregate, whose clock started before any run), honoring the
 * abort signal throughout. The terminal response — success or failure — is
 * published once for every waiting consumer, so a known preparation failure
 * never leaves a consumer polling until timeout. The watcher is closed and
 * its preparation settled before any owned resource is removed.
 */

interface PreparedCandidateOutcome {
  readonly evidence: PreparationEvidence;
  readonly candidateDirectory: string | null;
  readonly archivePath: string | null;
}

/** The bounded stage sequence: one build plus one script-disabled pack. */
async function prepareCandidateStages(
  invocation: PreparedSuiteInvocation,
  options: SuiteSupervisorOptions,
  abortSignal: AbortSignal | undefined,
  startedAt: number,
  budgetMs: number,
): Promise<PreparedCandidateOutcome> {
  const commands = options.packageCommands ?? systemPackageArchiveCommands;
  // Directory creation sits inside the evidence-owning try: a failure to
  // create the candidate directory is a preparation failure with retained
  // diagnostics, never an unstructured throw.
  let candidateDirectory: string | null = null;
  try {
    candidateDirectory = mkdtempSync(join(tmpdir(), "agent-profile-kit-invocation-candidate-"));
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    return {
      evidence: {
        status: "failed",
        requests: 0,
        durationMs: Date.now() - startedAt,
        cleanupDurationMs: 0,
        cleanupFailed: false,
        failure,
        diagnostics: failure,
      },
      candidateDirectory: null,
      archivePath: null,
    };
  }
  // One abort reader for every stage boundary: TS control-flow narrowing does
  // not invalidate across awaits, so each check must read the live signal
  // rather than a value narrowed by an earlier check.
  const preparationAborted = (signal: AbortSignal | undefined): boolean =>
    signal?.aborted === true;
  // Transfer the directory to the invocation owner on every outcome. Only
  // that owner's bounded finally removes it, after all writers have settled.
  const failedOutcome = (
    status: "failed" | "interrupted",
    detail: { failure?: string; diagnostics?: string },
    stageError?: PackagePreparationStageError,
  ): PreparedCandidateOutcome => ({
      candidateDirectory,
      archivePath: null,
      evidence: {
        status,
        requests: 0,
        durationMs: Date.now() - startedAt,
        cleanupDurationMs: 0,
        cleanupFailed: false,
        candidateDirectory,
        ...(stageError === undefined
          ? {}
          : {
              // The preparation child's own bounded cleanup evidence travels
              // separately from the directory cleanup's: a cancelled child
              // whose process group could not be confirmed terminated is
              // visible even though the archive directory was removed.
              childCleanupFailed: stageError.result.cleanupFailed,
              childCleanupDurationMs: stageError.result.cleanupDurationMs,
            }),
        ...detail,
      },
    });
  try {
    // One from-source candidate creator owns the whole bounded stage sequence:
    // pre-capture, fresh build-output replacement, the caller's build and pack
    // stages (injected in tests, the system stages otherwise), digest of the
    // exact packed bytes, post-capture (unequal means unstable source: the
    // candidate is disqualified), the packed-input guard, and the atomic
    // identity record beside the archive — the same creator and record shape
    // supplied candidates are validated against.
    const created = await createPackageCandidate({
      repositoryRoot: invocation.base,
      destinationDirectory: candidateDirectory,
      deadlineMs: budgetMs,
      signal: abortSignal,
      commands,
    });
    return {
      candidateDirectory,
      archivePath: created.archivePath,
      evidence: {
        status: "prepared",
        requests: 0,
        durationMs: Date.now() - startedAt,
        cleanupDurationMs: 0,
        cleanupFailed: false,
        archivePath: created.archivePath,
        candidateDirectory,
      },
    };
  } catch (error) {
    const stageError = error instanceof PackagePreparationStageError ? error : undefined;
    const failure = error instanceof Error ? error.message : String(error);
    const diagnostics =
      stageError !== undefined
        ? [
            `--- ${stageError.stage} result ---`,
            describeProcessResult(stageError.result),
            `childCleanupFailed: ${stageError.result.cleanupFailed}`,
            `childCleanupDurationMs: ${stageError.result.cleanupDurationMs}`,
            "--- stdout ---",
            stageError.result.stdout,
            "--- stderr ---",
            stageError.result.stderr,
          ].join("\n")
        : error instanceof Error && error.stack !== undefined
          ? error.stack
          : failure;
    if (abortSignal?.aborted === true || stageError?.result.cancelled === true) {
      const cause = `interrupted during the ${stageError?.stage ?? "package preparation"} stage`;
      return failedOutcome("interrupted", { failure: cause, diagnostics: `${cause}\n${diagnostics}` }, stageError);
    }
    return failedOutcome("failed", { failure, diagnostics }, stageError);
  }
}

/** One abort-aware sleep for the watcher's poll interval. */
function sleepAbortable(ms: number, abortSignal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** The watcher's poll interval; a request waits at most this long to be seen. */
const REQUEST_POLL_INTERVAL_MS = 100;

/**
 * The supervisor's channel watcher: one pass over the invocation-private
 * channel per interval, preparing the candidate exactly once on the first
 * actual consumer request and publishing one terminal response for every
 * waiting consumer. `stop()` resolves only after the watcher loop has ended
 * and any in-flight preparation has settled, so the caller can remove the
 * channel (and the candidate) with no writer left behind.
 */
interface PackageRequestWatcher {
  /** Current preparation evidence; the final cleanup fields are merged later. */
  readonly evidence: () => PreparationEvidence;
  readonly beginRun: (deadlineMs: number) => void;
  readonly endRun: () => void;
  /** Settles after the loop ends and the preparation (if any) has settled. */
  readonly stop: () => Promise<void>;
}

function watchPackageRequests(
  invocation: PreparedSuiteInvocation,
  channel: PackageRequestChannel,
  options: SuiteSupervisorOptions,
  abortSignal: AbortSignal | undefined,
  startedAt: number,
  onPrepared: (archivePath: string) => void,
): PackageRequestWatcher {
  const preparationController = new AbortController();
  const cancelPreparation = () => preparationController.abort();
  if (abortSignal?.aborted) cancelPreparation();
  else abortSignal?.addEventListener("abort", cancelPreparation, { once: true });
  let runDeadlineAt = startedAt + invocation.policy.perRunDeadlineMs;
  let status: PreparationEvidence["status"] = "none";
  let requests = 0;
  let durationMs = 0;
  let candidateDirectory: string | null = null;
  let archivePath: string | null = null;
  let failure: string | undefined;
  let diagnostics: string | undefined;
  let childCleanupFailed: boolean | undefined;
  let childCleanupDurationMs: number | undefined;
  let responsePublished = false;
  let stopRequested = false;

  const prepareOnce = async (): Promise<void> => {
    const preparedAt = Date.now();
    const outcome = await prepareCandidateStages(
      invocation,
      options,
      preparationController.signal,
      preparedAt,
      Math.max(runDeadlineAt - preparedAt, 1),
    );
    durationMs = outcome.evidence.durationMs;
    candidateDirectory = outcome.candidateDirectory;
    archivePath = outcome.archivePath;
    childCleanupFailed = outcome.evidence.childCleanupFailed;
    childCleanupDurationMs = outcome.evidence.childCleanupDurationMs;
    if (outcome.evidence.status === "prepared" && outcome.archivePath !== null) {
      status = "prepared";
      failure = undefined;
      diagnostics = undefined;
      onPrepared(outcome.archivePath);
      publishPackageChannelResponse(channel.directory, {
        status: "prepared",
        archivePath: outcome.archivePath,
      });
    } else {
      status = outcome.evidence.status;
      failure = outcome.evidence.failure;
      diagnostics = outcome.evidence.diagnostics;
      // Terminal failure is published for every waiting consumer: no
      // consumer ever polls until timeout after a known preparation failure.
      publishPackageChannelResponse(
        channel.directory,
        outcome.evidence.failure === undefined
          ? { status: "failed" }
          : { status: "failed", failure: outcome.evidence.failure },
      );
    }
    responsePublished = true;
  };

  const loop = (async () => {
    while (!stopRequested && abortSignal?.aborted !== true) {
      if (!responsePublished) {
        const filed = filedPackageRequests(channel.directory);
        if (filed.length > 0) {
          requests = Math.max(requests, filed.length);
          await prepareOnce();
          continue;
        }
      }
      await sleepAbortable(REQUEST_POLL_INTERVAL_MS, abortSignal);
    }
  })();
  const settledLoop = loop.catch((error: unknown) => {
    // The watcher must never throw past its own boundary: a watcher defect is
    // recorded as a failed preparation so no consumer can hang waiting.
    status = "failed";
    failure = [failure, String(error)].filter(Boolean).join("; ");
    diagnostics = [diagnostics, error instanceof Error ? error.stack : String(error)].filter(Boolean).join("\n");
    if (!responsePublished) {
      try {
        publishPackageChannelResponse(channel.directory, { status: "failed", failure });
        responsePublished = true;
      } catch {
        // The channel is already gone; consumers cannot wait on it.
      }
    }
  });

  return {
    beginRun: (deadlineMs) => { runDeadlineAt = Date.now() + deadlineMs; },
    endRun: () => {
      if (requests > 0 && status === "none") preparationController.abort();
    },
    evidence: () => ({
      status,
      requests,
      durationMs,
      cleanupDurationMs: 0,
      cleanupFailed: false,
      ...(archivePath === null ? {} : { archivePath }),
      ...(candidateDirectory === null ? {} : { candidateDirectory }),
      ...(failure === undefined ? {} : { failure }),
      ...(childCleanupFailed === undefined ? {} : { childCleanupFailed }),
      ...(childCleanupDurationMs === undefined ? {} : { childCleanupDurationMs }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }),
    stop: async () => {
      stopRequested = true;
      preparationController.abort();
      abortSignal?.removeEventListener("abort", cancelPreparation);
      await settledLoop;
    },
  };
}

/** Retain one failed or interrupted preparation's complete diagnostics. */
function writePreparationLog(logDir: string, evidence: PreparationEvidence): string {
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, PREPARATION_LOG_FILENAME);
  const lines = [
    "=== invocation package preparation ===",
    `status: ${evidence.status}`,
    `requests: ${evidence.requests}`,
    `durationMs: ${evidence.durationMs}`,
    `cleanupDurationMs: ${evidence.cleanupDurationMs}`,
    `cleanupFailed: ${evidence.cleanupFailed}`,
    `childCleanupFailed: ${evidence.childCleanupFailed ?? "null"}`,
    `childCleanupDurationMs: ${evidence.childCleanupDurationMs ?? "null"}`,
    `failure: ${evidence.failure ?? "null"}`,
    ...(evidence.diagnostics === undefined ? [] : ["--- stage output ---", evidence.diagnostics]),
  ];
  writeFileSync(logPath, lines.join("\n") + "\n", { mode: 0o600 });
  return logPath;
}

/** The `preparation:` evidence line shared by every retained run log. */
function preparationLogLine(evidence: PreparationEvidence): string {
  const parts = [
    `status=${evidence.status}`,
    `requests=${evidence.requests}`,
    `durationMs=${evidence.durationMs}`,
    ...(evidence.archivePath === undefined ? [] : [`archive=${evidence.archivePath}`]),
  ];
  return `preparation: ${parts.join(" ")}`;
}

/**
 * Run one or more supervised suites. `full` and `focused` perform exactly one
 * run; `stress` runs sequentially up to `maxRuns` green runs, stopping at the
 * first failure or timeout. Its final run uses the smaller of the per-run and
 * remaining aggregate budgets, so useful aggregate time is not discarded. On
 * timeout or interruption the bounded executor cleans up the complete child
 * process group before resolving. Package preparation is lazy: an
 * invocation-private request channel carries the first actual consumer
 * request to a supervisor-owned preparation, memoized for the whole
 * invocation (including later stress runs), and no consumer request means no
 * preparation at all.
 */
export async function runSupervisedSuite(
  options: SuiteSupervisorOptions,
  abortSignal?: AbortSignal,
  prepared?: PreparedSuiteInvocation,
): Promise<SuiteSupervisorResult> {
  const invocation = prepared ?? prepareSuiteInvocation(options);
  const policy = invocation.policy;
  const mode = policy.mode;
  const perRun = policy.perRunDeadlineMs;
  const maxRuns = policy.maxRuns;
  const aggregate = policy.aggregateDeadlineMs;
  const logDir = options.logDir ?? defaultLogDir(mode);
  // Canonical scripts run this module under Bun; reuse that exact executable so
  // focused/full/stress runs cannot drift to another PATH entry or lose Bun
  // under a restricted PATH.
  const suiteCommand = options.suiteCommand ?? ([process.execPath, "test"] as const);
  // Structured execution evidence is retained next to the run logs; the
  // evidence directory must exist before the child starts.
  mkdirSync(logDir, { recursive: true });
  // The invocation clock covers preparation, runs, and cleanup: every owned
  // stage consumes it, and its exhaustion is incomplete qualification.
  const startedAt = Date.now();

  // An ambient archive is operator-supplied only outside a supervised parent:
  // inside a supervised child (a nested invocation) the ambient archive belongs
  // to the parent invocation, and a nested invocation always owns its own fresh
  // candidate — reusing the parent's archive across the invocation boundary
  // would be exactly the cross-command reuse this design forbids. The parent's
  // archive bytes are never touched either way.
  const ambient = supervisedInvocationActive(process.env)
    ? undefined
    : process.env[PREPARED_PACKAGE_ARCHIVE_ENV];
  let suppliedArchivePath: string | undefined;
  if (ambient !== undefined) {
    try {
      const archivePath = preparedPackageArchive(process.env);
      if (archivePath === null) {
        throw new Error(`${PREPARED_PACKAGE_ARCHIVE_ENV} was set but resolved to nothing`);
      }
      // The provenance gate runs before qualification: a supplied archive
      // qualifies only the source identity its record demonstrably
      // represents, checked here against the consuming checkout — before any
      // consumer can report qualification for a different source.
      await validateSuppliedPackageCandidate(archivePath, {
        repositoryRoot: invocation.base,
        deadlineMs: TEST_CHILD_DEADLINE_MS,
        signal: undefined,
      });
      suppliedArchivePath = archivePath;
    } catch (error) {
      // A malformed or invalid supplied archive is a preparation failure with
      // retained diagnostics; the channel is never created and no consumer
      // can hang or qualify.
      const reason = error instanceof Error ? error.message : String(error);
      const evidence: PreparationEvidence = {
        status: "failed",
        requests: 0,
        durationMs: 0,
        cleanupDurationMs: 0,
        cleanupFailed: false,
        failure: `supplied package archive rejected: ${reason}`,
        diagnostics: `supplied package archive rejected: ${reason}`,
      };
      writePreparationLog(logDir, evidence);
      return {
        mode,
        ok: false,
        attemptedRuns: 0,
        completedRuns: 0,
        maxRuns,
        runs: [],
        aggregateDurationMs: Date.now() - startedAt,
        logDir,
        firstFailure: null,
        aggregateExhausted: false,
        interrupted: false,
        preparation: evidence,
      };
    }
  }

  // Owned resources, acquired before the run loop and released in the finally:
  // the invocation-private request channel and, once a consumer has requested
  // it, the prepared candidate's directory. The archive path the children
  // receive is injected directly once preparation has settled, so later runs
  // (and any consumer in them) never touch the channel again.
  let preparedArchivePath: string | undefined;
  const channel =
    suppliedArchivePath === undefined && invocation.plan !== null
      ? createPackageRequestChannel()
      : null;
  const watcher =
    channel === null
      ? null
      : watchPackageRequests(invocation, channel, options, abortSignal, startedAt, (archivePath) => {
          preparedArchivePath = archivePath;
        });

  const runs: SupervisedRun[] = [];
  let interrupted = false;
  let aggregateExhausted = false;
  let candidateDirectory: string | null = null;
  let cleanupDurationMs = 0;
  let cleanupFailed = false;
  let cleanupFailure: string | undefined;
  let invocationError: unknown;

  try {
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
      const junitPath = junitEvidencePath(logDir, runNumber);
      // A reused diagnostics directory may hold evidence from an earlier
      // invocation; only this run's own evidence may complete it. Deleting the
      // planned path first makes a green run that fails to write evidence fail
      // closed instead of parsing stale files as executed coverage.
      rmSync(junitPath, { force: true });
      // The structured-evidence reporter is part of the canonical selection
      // contract: an injected test-seam command manages its own output, so it
      // receives no reporter arguments.
      const reporterArguments =
        invocation.plan === null
          ? []
          : ["--reporter=junit", `--reporter-outfile=${junitPath}`];
      watcher?.beginRun(runDeadline);
      const result = await runProcess(
        {
          executable: suiteCommand[0],
          arguments_: [
            ...suiteCommand.slice(1),
            "--timeout",
            String(Math.max(PER_TEST_TIMEOUT_MS, runDeadline)),
            ...reporterArguments,
            ...(mode === "focused"
              ? (options.bunArguments ?? [])
              : (invocation.plan?.selected ?? [])),
          ],
          cwd: invocation.base,
          deadlineMs: runDeadline,
          environment: suiteProcessEnvironment(
            process.env,
            options.bunArguments,
            invocation.plan !== null,
            preparedArchivePath,
            suppliedArchivePath,
            channel,
            runDeadline,
          ),
          ...(options.cleanupGraceMs === undefined ? {} : { cleanupGraceMs: options.cleanupGraceMs }),
          commandLabel: `suite ${mode} run ${runNumber}/${maxRuns}`,
        },
        abortSignal,
      );
      watcher?.endRun();
      if (result.cancelled) {
        interrupted = true;
      }
      if (aggregateLimitedRun && result.kind === "timeout") {
        aggregateExhausted = true;
      }
      // Coverage gates defend the only remaining misleading-pass window: a
      // green exit. Non-green runs are already incomplete by their own kind.
      const coverage =
        invocation.plan !== null && isGreen(result)
          ? evaluateRunCoverage(invocation, junitPath)
          : undefined;
      const logPath = writeRunLog(logDir, runNumber, invocation, watcher?.evidence() ?? {
        status: suppliedArchivePath === undefined ? "none" : "supplied",
        requests: 0,
        durationMs: 0,
        cleanupDurationMs: 0,
        cleanupFailed: false,
        ...(suppliedArchivePath === undefined ? {} : { archivePath: suppliedArchivePath }),
      }, result, coverage);
      const run: SupervisedRun = {
        runNumber,
        result,
        logPath,
        ...(coverage === undefined ? {} : { coverage }),
      };
      runs.push(run);
      options.onRunComplete?.(run);
      if (!runComplete(run)) {
        break;
      }
    }
  } catch (error) {
    invocationError = error;
  } finally {
    // Close the watcher first: its preparation (if any) must settle before any
    // owned resource is removed, so nothing is written after its directory is
    // gone. The finally owns cleanup on every exit — run completion, timeout,
    // interruption, and any exception between acquisition and here — and the
    // original error propagates after cleanup with its diagnostics retained.
    if (watcher !== null) {
      await watcher.stop();
      const evidence = watcher.evidence();
      candidateDirectory = evidence.candidateDirectory ?? null;
    }
    // Bounded cleanup of every resource this invocation owned: the prepared
    // candidate's directory and the request channel. Each removal runs through
    // the shared bounded executor against the remaining invocation budget,
    // with a finite floor so an exhausted budget cannot skip cleanup, and
    // every failure is reported, never treated as successful. The retained
    // preparation log is written after removal so diagnostic I/O cannot skip
    // cleanup; stage output is already retained in the watcher evidence.
    const removalTargets = [candidateDirectory, channel?.directory ?? null];
    for (const removalPath of removalTargets) {
      if (removalPath === null) continue;
      const cleanupStartedAt = Date.now();
      const removalDeadlineMs = Math.max((mode === "stress" ? aggregate : perRun) - (cleanupStartedAt - startedAt), TEST_CHILD_DEADLINE_MS);
      try {
        // The removal is bounded by its deadline and deliberately not tied to
        // the invocation's abort signal: an aborted invocation still owns its
        // resources, so cleanup proceeds and only the bounded deadline can
        // stop it. A failed removal is reported, never treated as successful.
        await removePathBounded(removalPath, removalDeadlineMs, undefined);
      } catch (error) {
        cleanupFailed = true;
        cleanupFailure = [cleanupFailure, String(error)].filter(Boolean).join("; ");
      }
      cleanupDurationMs = cleanupDurationMs + (Date.now() - cleanupStartedAt);
    }
    const finalPreparationSnapshot = watcher?.evidence();
    if (finalPreparationSnapshot !== undefined && (finalPreparationSnapshot.status === "failed" || finalPreparationSnapshot.status === "interrupted")) {
      try {
        writePreparationLog(logDir, { ...finalPreparationSnapshot, cleanupDurationMs, cleanupFailed,
          ...(cleanupFailure === undefined ? {} : { cleanupFailure }) });
      } catch (error) {
        cleanupFailed = true;
        cleanupFailure = [cleanupFailure, `preparation diagnostics not written: ${String(error)}`].filter(Boolean).join("; ");
      }
    }
    // The retained run log carries the complete preparation lifecycle,
    // including cleanup evidence.
    if (runs.length > 0 && (cleanupDurationMs > 0 || cleanupFailed)) {
      const lastRunLog = runs[runs.length - 1]!.logPath;
      const cleanupLines = [
        `preparation-cleanup: durationMs=${cleanupDurationMs} failed=${cleanupFailed}`,
        ...(cleanupFailure === undefined ? [] : [`preparation-cleanup-failure: ${cleanupFailure}`]),
      ];
      try {
        writeFileSync(lastRunLog, `${readFileSync(lastRunLog, "utf8")}${cleanupLines.join("\n")}\n`, {
          mode: 0o600,
        });
      } catch (error) {
        // A log-append failure must not mask the original run outcome; the
        // cleanup failure stays reported on the evidence either way.
        cleanupFailed = true;
        cleanupFailure = cleanupFailure ?? `run-log cleanup evidence not appended: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }

  // Final preparation evidence: the watcher's outcome merged with the owned
  // cleanup's evidence.
  const watcherEvidence = watcher?.evidence();
  const finalPreparation: PreparationEvidence = {
    status: watcher === null && suppliedArchivePath !== undefined ? "supplied" : (watcherEvidence?.status ?? "none"),
    requests: watcherEvidence?.requests ?? 0,
    durationMs: watcherEvidence?.durationMs ?? 0,
    cleanupDurationMs,
    cleanupFailed,
    ...(preparedArchivePath === undefined ? {} : { archivePath: preparedArchivePath }),
    ...(suppliedArchivePath === undefined || preparedArchivePath !== undefined
      ? {}
      : { archivePath: suppliedArchivePath }),
    ...(candidateDirectory === null ? {} : { candidateDirectory }),
    ...(watcherEvidence?.failure === undefined ? {} : { failure: watcherEvidence.failure }),
    ...(watcherEvidence?.childCleanupFailed === undefined
      ? {}
      : { childCleanupFailed: watcherEvidence.childCleanupFailed }),
    ...(watcherEvidence?.childCleanupDurationMs === undefined
      ? {}
      : { childCleanupDurationMs: watcherEvidence.childCleanupDurationMs }),
    ...(watcherEvidence?.diagnostics === undefined ? {} : { diagnostics: watcherEvidence.diagnostics }),
    ...(cleanupFailure === undefined ? {} : { cleanupFailure }),
  };
  if (invocationError !== undefined) {
    throw Object.assign(new AggregateError(
      [invocationError, ...(cleanupFailure === undefined ? [] : [new Error(cleanupFailure)])],
      [String(invocationError), cleanupFailure].filter(Boolean).join("; "),
      { cause: invocationError },
    ), { preparation: finalPreparation });
  }
  interrupted ||= finalPreparation.status === "interrupted";
  const completedRuns = runs.filter(runComplete).length;
  // Failed candidate cleanup is never a complete qualification, even when
  // every run was green: a resource the invocation owned could not be freed.
  // The final aggregate check includes the awaited cleanup work: a stress
  // invocation whose last child and cleanup ran past the aggregate is
  // incomplete, with its cleanup diagnostics retained.
  let finalAggregateExhausted = aggregateExhausted;
  if (mode === "stress" && Date.now() - startedAt >= aggregate) {
    finalAggregateExhausted = true;
  }
  const ok =
    runs.length === maxRuns &&
    completedRuns === maxRuns &&
    finalAggregateExhausted === false &&
    cleanupFailed === false &&
    finalPreparation.status !== "failed" &&
    finalPreparation.status !== "interrupted" &&
    finalPreparation.childCleanupFailed !== true;
  const firstFailure = runs.find((run) => !runComplete(run)) ?? null;
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
    aggregateExhausted: finalAggregateExhausted,
    interrupted,
    preparation: finalPreparation,
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

function describeRunOutcome(run: SupervisedRun): string {
  if (run.coverage?.status === "incomplete") {
    return `incomplete required coverage (${run.coverage.reason ?? "unspecified"})`;
  }
  return describeOutcome(run.result);
}

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The invocation's preparation segment for the summary: omitted when nothing
 * was prepared (no need or an injected test-seam command), otherwise one
 * truthful clause — prepared, supplied, or the failure with its log pointer.
 */
function formatPreparationSegment(preparation: PreparationEvidence): string {
  switch (preparation.status) {
    case "none":
      return "";
    case "prepared":
      return `preparation: prepared candidate in ${formatSeconds(preparation.durationMs)}, `;
    case "supplied":
      return "preparation: supplied archive, ";
    case "failed":
      return `preparation: failed (${preparation.failure ?? "unspecified"}) in ${formatSeconds(
        preparation.durationMs,
      )} — preparation log: ${PREPARATION_LOG_FILENAME} — `;
    case "interrupted":
      return `preparation: interrupted in ${formatSeconds(preparation.durationMs)} — preparation log: ${PREPARATION_LOG_FILENAME} — `;
  }
}

export function formatSuiteSummary(
  result: SuiteSupervisorResult,
  interruptedBy: string | null,
): string {
  const duration = formatSeconds(result.aggregateDurationMs);
  if (result.mode === "stress") {
    if (result.runs.length === 0) {
      if (result.preparation.status === "failed") {
        return `suite stress: preparation failed (${result.preparation.failure ?? "unspecified"}) in ${duration} — preparation log: ${PREPARATION_LOG_FILENAME} — logs: ${result.logDir}`;
      }
      if (result.preparation.status === "interrupted" || result.interrupted) {
        return `suite stress: interrupted (${interruptedBy ?? "abort"}) ${result.preparation.status === "interrupted" ? "during preparation" : "before run 1"} in ${duration} — logs: ${result.logDir}`;
      }
      return `suite stress: aggregate deadline reached after 0/${result.maxRuns} runs in ${duration} — logs: ${result.logDir}`;
    }
    if (interruptedBy !== null) {
      return `suite stress: ${formatPreparationSegment(result.preparation)}interrupted (${interruptedBy}) after ${result.attemptedRuns}/${result.maxRuns} runs in ${duration} — logs: ${result.logDir}`;
    }
    if (result.ok) {
      return `suite stress: ${formatPreparationSegment(result.preparation)}${result.completedRuns}/${result.maxRuns} runs green in ${duration} — logs: ${result.logDir}`;
    }
    if (result.aggregateExhausted) {
      const failure = result.firstFailure;
      return failure === null
        ? `suite stress: aggregate deadline reached after ${result.attemptedRuns}/${result.maxRuns} runs in ${duration} — logs: ${result.logDir}`
        : `suite stress: aggregate deadline reached during run ${failure.runNumber}/${result.maxRuns} (${describeRunOutcome(failure)}) in ${duration} — log: ${failure.logPath}`;
    }
    // A failed candidate cleanup fails the invocation even when every run was
    // green, so the failure may carry no incomplete run to point at.
    if (result.preparation.cleanupFailed) {
      return `suite stress: failed (candidate cleanup failed: ${result.preparation.cleanupFailure ?? "unspecified"}) after ${result.completedRuns}/${result.maxRuns} green runs in ${duration} — logs: ${result.logDir}`;
    }
    const failure = result.firstFailure;
    if (failure === null) {
      return `suite stress: ${formatPreparationSegment(result.preparation)}incomplete after ${result.completedRuns}/${result.maxRuns} green runs in ${duration} — logs: ${result.logDir}`;
    }
    return `suite stress: ${formatPreparationSegment(result.preparation)}failed at run ${failure.runNumber}/${result.maxRuns} (${describeRunOutcome(failure)}) in ${duration} — log: ${failure.logPath}`;
  }
  if (result.runs.length === 0) {
    if (result.preparation.status === "failed") {
      return `suite ${result.mode}: preparation failed (${result.preparation.failure ?? "unspecified"}) in ${duration} — preparation log: ${PREPARATION_LOG_FILENAME} — logs: ${result.logDir}`;
    }
    return `suite ${result.mode}: interrupted (${interruptedBy ?? "abort"}) ${result.preparation.status === "interrupted" ? "during preparation" : "before run 1"} in ${duration} — logs: ${result.logDir}`;
  }
  const run = result.runs[0]!;
  // One shape for the cleanup-failure fact across modes: a failed cleanup is
  // the invocation's outcome, whether or not a run also failed.
  const cleanupFailure = result.preparation.cleanupFailed
    ? `candidate cleanup failed: ${result.preparation.cleanupFailure ?? "unspecified"}`
    : null;
  const outcome =
    interruptedBy !== null
      ? `interrupted (${interruptedBy})`
      : result.preparation.cleanupFailed
        ? `failed (${cleanupFailure})`
        : result.ok
          ? describeRunOutcome(run)
          : `failed (${describeRunOutcome(run)})`;
  return `suite ${result.mode}: ${formatPreparationSegment(result.preparation)}1 run, ${outcome} in ${duration} — log: ${run.logPath}`;
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
  let invocation: PreparedSuiteInvocation;
  let attribution: readonly string[];
  let options: SuiteSupervisorOptions;
  try {
    // Normalize and validate every CLI input before announcing a run.
    const prepared = supervisedOptionsFromEnvironment(modeArg, bunArguments);
    attribution = prepared.attribution;
    explicitDiagnosticsDir = diagnosticsDirFromEnvironment(process.env);
    options = prepared.options;
    // Resolve runner identity, selection configuration, and the corpus-derived
    // plan before announcing a run; every rejection here is exit 2.
    invocation = prepareSuiteInvocation(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const policy = invocation.policy;

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
            `suite stress: run ${run.runNumber}/${policy.maxRuns} ${describeRunOutcome(run)} in ${formatSeconds(run.result.durationMs)} — log: ${run.logPath}`,
          );
        }
      },
    },
    controller.signal,
    invocation,
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
