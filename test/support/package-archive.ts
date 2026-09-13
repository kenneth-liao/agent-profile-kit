import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TEST_CHILD_DEADLINE_MS,
  describeProcessResult,
  runProcess,
  type ExecutorOptions,
  type ProcessResult,
} from "../../process/process-executor.js";
import {
  PACKAGE_REQUEST_CHANNEL_ENV,
  PACKAGE_REQUEST_WAIT_ENV,
  requestInvocationPackage,
} from "./package-request-channel.js";
import {
  InvalidProvenanceError,
  createPackageCandidate,
  readPackageIdentityRecord,
  removePathBounded,
  UNSUPERVISED_CANDIDATE_DEADLINE_MS,
  type PackageIdentityRecord,
} from "./package-identity.js";



/**
 * The canonical consumer boundary for the invocation package candidate:
 * consumers obtain the supervised invocation's prepared archive through
 * `obtainPackageArchive` and extract it through `extractPackageArchive`; the
 * command text for bounded preparation stages is single-homed here and shared
 * by the supervisor's invocation preparation and the unsupervised fallback.
 */

export const PREPARED_PACKAGE_ARCHIVE_ENV = "APKIT_TEST_PACKAGE_ARCHIVE";

/**
 * Set by the suite supervisor on every canonically supervised child (injected
 * test-seam commands are never marked). A supervised consumer that finds no
 * prepared archive while this marker is set has hit a supervisor defect and
 * must fail loudly instead of building silently.
 */
export const SUPERVISED_INVOCATION_ENV = "APKIT_TEST_SUPERVISED_INVOCATION";

/**
 * The repository root the unsupervised fallback builds and packs in: this
 * module's own repository. Canonical invocations prepare through the suite
 * supervisor, so this root matters only for a direct unsupervised run.
 */
export function packageArchiveRepositoryRoot(): string {
  return resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

export interface PackageArchive {
  readonly path: string;
  readonly cleanup: () => void;
}

/**
 * One pack stage's product: the archive filename plus the files it actually
 * packed (paths relative to the package root, files only, JSON-safe). The
 * packed-input guard consumes this list, not archive text, so NUL-safe and
 * newline-containing paths cannot corrupt it.
 */
export interface PackedArchive {
  readonly filename: string;
  readonly files: readonly string[];
}

/**
 * One bounded preparation stage's inputs. `deadlineMs` is the remaining share
 * of the caller's single finite preparation budget (stages consume remaining
 * time, never each a fresh full budget); `signal` carries the caller's abort
 * so a cancelled invocation stops its preparation children.
 */
export interface PackageStageContext {
  readonly repositoryRoot: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal | undefined;
}

export interface PackageArchiveCommands {
  readonly build: (stage: PackageStageContext) => Promise<void>;
  readonly createScriptDisabledArchive: (
    stage: PackageStageContext,
    destination: string,
  ) => Promise<PackedArchive>;
}

export interface PackageArchiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly commands?: PackageArchiveCommands;
}

/**
 * Single homes for the bounded preparation stage commands, shared by the
 * supervisor's invocation preparation and the unsupervised fallback. The
 * build runs under the pinned Bun executable running the process (`bun run
 * build`); the pack is script-disabled so the prepared archive is exactly the
 * packed build output.
 */
export function packageBuildStage(repositoryRoot: string, deadlineMs: number): ExecutorOptions {
  return {
    executable: process.execPath,
    arguments_: ["run", "build"],
    cwd: repositoryRoot,
    deadlineMs,
    commandLabel: BUILD_STAGE_LABEL,
  };
}

export function packagePackStage(
  repositoryRoot: string,
  destination: string,
  deadlineMs: number,
): ExecutorOptions {
  return {
    executable: "npm",
    arguments_: ["pack", "--silent", "--ignore-scripts", "--json", "--pack-destination", destination],
    cwd: repositoryRoot,
    deadlineMs,
    commandLabel: PACK_STAGE_LABEL,
  };
}

/** A bounded preparation or extraction stage that did not exit green. */
export class PackagePreparationStageError extends Error {
  readonly stage: string;
  readonly result: ProcessResult;

  constructor(stage: string, result: ProcessResult) {
    super(`${stage} failed — ${describeProcessResult(result)}`);
    this.name = "PackagePreparationStageError";
    this.stage = stage;
    this.result = result;
  }
}

function assertStageExit(commandLabel: string, result: ProcessResult): void {
  if (result.kind === "exit" && result.exitCode === 0) return;
  throw new PackagePreparationStageError(commandLabel, result);
}

/**
 * Parse `npm pack --json` output (npm may print notices before the array):
 * the packed filename and the files it actually packed (paths relative to the
 * package root, files only) — the guard's authority on the packed input.
 */
export function packedArchiveMetadata(packStdout: string): PackedArchive {
  const output = packStdout.slice(packStdout.indexOf("["));
  const metadata = JSON.parse(output) as readonly [{
    readonly filename: string;
    readonly files?: readonly { readonly path: string }[];
  }];
  if (metadata[0]!.files === undefined) {
    throw new Error(
      "npm pack reported no file list; the packed-input guard requires it, so the pack stage fails closed instead of guarding nothing",
    );
  }
  return {
    filename: metadata[0]!.filename,
    files: metadata[0]!.files.map((file) => file.path),
  };
}

/** Single-homed stage identities: the diagnostic label and the error prefix share them. */
const BUILD_STAGE_LABEL = "package preparation build";
const PACK_STAGE_LABEL = "package preparation pack";

/** The system preparation commands: bounded executor children, one home. */
export const systemPackageArchiveCommands: PackageArchiveCommands = {
  build: async (stage) => {
    const result = await runProcess(
      packageBuildStage(stage.repositoryRoot, stage.deadlineMs),
      stage.signal,
    );
    assertStageExit(BUILD_STAGE_LABEL, result);
  },
  createScriptDisabledArchive: async (stage, destination) => {
    const result = await runProcess(
      packagePackStage(stage.repositoryRoot, destination, stage.deadlineMs),
      stage.signal,
    );
    assertStageExit(PACK_STAGE_LABEL, result);
    return packedArchiveMetadata(result.stdout);
  },
};

/**
 * Hang bound for the unsupervised local fallback's whole create budget
 * (pre-capture, build, pack, post-capture, and the packed-input guard share
 * it, each stage consuming the remaining time). Measured build+pack completes
 * far inside it; the value bounds a hung child, it is not a completion target.
 * Under the canonical supervised commands the supervisor owns the budget.
 */
export const UNSUPERVISED_PREPARATION_DEADLINE_MS = UNSUPERVISED_CANDIDATE_DEADLINE_MS;

export function preparedPackageArchive(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const authoredPath = environment[PREPARED_PACKAGE_ARCHIVE_ENV];
  if (authoredPath === undefined) return null;
  if (!isAbsolute(authoredPath)) {
    throw new Error(`${PREPARED_PACKAGE_ARCHIVE_ENV} must be an absolute path`);
  }

  const canonicalPath = realpathSync(authoredPath);
  if (!lstatSync(canonicalPath).isFile()) {
    throw new Error(`${PREPARED_PACKAGE_ARCHIVE_ENV} must identify a package archive file`);
  }
  return canonicalPath;
}

export function supervisedInvocationActive(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[SUPERVISED_INVOCATION_ENV] === "1";
}

/**
 * A supervised invocation whose consumer found no prepared archive. This is a
 * supervisor defect (missed need derivation or an unregistered consumer), not
 * a consumer problem: building here would turn the defect into silent,
 * repeated per-consumer preparation.
 */
export class SupervisorPreparationDefectError extends Error {
  constructor() {
    super(
      `${SUPERVISED_INVOCATION_ENV} is set but neither a prepared package archive (${PREPARED_PACKAGE_ARCHIVE_ENV}) nor an invocation request channel (${PACKAGE_REQUEST_CHANNEL_ENV}) was delivered: this consumer ran under a supervised invocation that owns no candidate. Building here would silently hide the supervisor defect — deliver the invocation's request channel, or name the consumer's test file explicitly so the invocation prepares its candidate`,
    );
    this.name = "SupervisorPreparationDefectError";
  }
}

/**
 * The supervised consumer's request-wait deadline for one child run: the
 * supervisor derives it from the canonical per-test watchdog and delivers it
 * beside the channel, so one home (the supervisor's policy) owns the number
 * and the child never guesses. A missing or malformed value is a supervisor
 * defect and fails closed rather than guessing a watchdog-sized wait.
 */
function resolvePackageRequestWaitDeadline(environment: NodeJS.ProcessEnv): number {
  const authored = environment[PACKAGE_REQUEST_WAIT_ENV];
  if (authored === undefined) {
    throw new Error(
      `${PACKAGE_REQUEST_WAIT_ENV} was not delivered beside the request channel; the supervised invocation must coordinate the consumer's wait with the per-test watchdog`,
    );
  }
  const parsed = Number(authored);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${PACKAGE_REQUEST_WAIT_ENV} must be a positive number of milliseconds, got '${authored}'`);
  }
  return parsed;
}

/**
 * Extract one package archive through the shared bounded executor. One home
 * for the extraction command so every consumer (test files and the fleet
 * launch path) extracts identically.
 */
export async function extractPackageArchive(
  archivePath: string,
  destination: string,
): Promise<void> {
  // The validated extraction boundary: the archive is read exactly once, the
  // record beside it names the digest those bytes must carry, and extraction
  // consumes the staged copy of the verified bytes — so a substitution after
  // validation can never change what a consumer runs. The staged copy lives
  // only inside the extraction, owned and removed by this boundary.
  const bytes = readFileSync(archivePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const record: PackageIdentityRecord = readPackageIdentityRecord(archivePath);
  if (digest !== record.archiveDigest) {
    throw new InvalidProvenanceError(
      "digest-mismatch",
      `the candidate archive's actual bytes (${digest}) do not match its record's artifact digest (${record.archiveDigest}); the archive was substituted or replaced after its record was written`,
    );
  }
  const stagedInput = join(destination, ".validated-archive-input.tgz");
  writeFileSync(stagedInput, bytes);
  try {
    const result = await runProcess({
      executable: "tar",
      arguments_: ["-xzf", stagedInput, "-C", destination],
      deadlineMs: TEST_CHILD_DEADLINE_MS,
      commandLabel: "package archive extraction",
    });
    if (!(result.kind === "exit" && result.exitCode === 0)) {
      throw new PackagePreparationStageError("package archive extraction", result);
    }
  } finally {
    rmSync(stagedInput, { force: true });
  }
}

/**
 * The candidate one supervised child's consumers share, memoized per run
 * process: the first consumer's channel request settles once and every later
 * consumer in the same supervised run reuses it. Not a persistent cache —
 * it lives only inside this run process, the invocation's own cleanup owns
 * the candidate's lifetime, and a caller that passes an explicit environment
 * (a test simulating another invocation) resolves from its own inputs, never
 * from this memo.
 */
let supervisedRunCandidate: string | null = null;

/**
 * Remove one owned directory through the shared bounded executor: cleanup is
 * a bounded child operation like any other, so a stalled filesystem cannot
 * block the supervisor or its signal handling beyond the deadline. A failed
 * removal throws with its captured diagnostics; the caller reports it and
 * never treats it as successful. Single-homed in package-identity; re-exported
 * here for the existing supervisor import path.
 */
export { removePathBounded };

/**
 * Resolve the package archive one consumer executes. Order of authority:
 * an operator-supplied or invocation-prepared archive passes through
 * untouched; under a supervised marker the consumer files one request on the
 * invocation's channel and waits, bounded, for the supervisor's terminal
 * response (lazy preparation on first actual consumption — memoized across
 * the run's consumers); a supervised marker without a channel is a supervisor
 * defect and fails closed; an unsupervised direct run uses the bounded local
 * fallback.
 */
export async function obtainPackageArchive(
  repositoryRoot: string,
  prefix: string,
  options: PackageArchiveOptions = {},
): Promise<PackageArchive> {
  const environment = options.environment ?? process.env;
  const prepared = preparedPackageArchive(environment);
  if (prepared !== null) {
    return { path: prepared, cleanup: () => undefined };
  }
  if (supervisedInvocationActive(environment)) {
    if (options.environment === undefined && supervisedRunCandidate !== null) {
      return { path: supervisedRunCandidate, cleanup: () => undefined };
    }
    const channelDirectory = environment[PACKAGE_REQUEST_CHANNEL_ENV];
    if (channelDirectory === undefined || channelDirectory.length === 0) {
      throw new SupervisorPreparationDefectError();
    }
    const candidate = await requestInvocationPackage(
      channelDirectory,
      resolvePackageRequestWaitDeadline(environment),
    );
    if (options.environment === undefined) supervisedRunCandidate = candidate;
    return { path: candidate, cleanup: () => undefined };
  }
  const commands = options.commands ?? systemPackageArchiveCommands;
  const packageDirectory = mkdtempSync(join(tmpdir(), prefix));
  try {
    const created = await createPackageCandidate({
      repositoryRoot,
      destinationDirectory: packageDirectory,
      deadlineMs: UNSUPERVISED_PREPARATION_DEADLINE_MS,
      signal: undefined,
      commands,
    });
    return {
      path: created.archivePath,
      cleanup: () => rmSync(packageDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(packageDirectory, { recursive: true, force: true });
    throw error;
  }
}
