import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
 * The explicit consumer registry: corpus-relative test-file paths that, when
 * executed in a supervised invocation, consume the invocation package. Need
 * derivation intersects this registry with the derived selection (see
 * `test/support/invocation-candidate.ts`); a supervised run that executes an
 * unregistered consumer without a prepared archive fails closed through the
 * supervised-invocation tripwire, so the registry is maintained, never
 * inferred. Entries are validated against the current corpus inventory on
 * every invocation that applies the registry; a stale entry is a hard error.
 */
export const INVOCATION_PACKAGE_CONSUMERS = [
  "test/cli.test.ts",
  "test/golden-snapshots.test.ts",
  "test/release-boundary.test.ts",
  "test/release-candidate.test.ts",
  "test/fleet-qualification.test.ts",
] as const;

/**
 * The repository root the registry entries are relative to: this module's own
 * repository. The registry describes this corpus only, so a supervisor run
 * over a different corpus base (a fixture) does not apply it.
 */
export function packageArchiveRepositoryRoot(): string {
  return resolve(fileURLToPath(new URL("../..", import.meta.url)));
}

export interface PackageArchive {
  readonly path: string;
  readonly cleanup: () => void;
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
  ) => Promise<string>;
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
    commandLabel: "package preparation build",
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
    commandLabel: "package preparation pack",
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

function assertStageExit(stage: string, result: ProcessResult): void {
  if (result.kind === "exit" && result.exitCode === 0) return;
  throw new PackagePreparationStageError(stage, result);
}

/** Parse `npm pack --json` output (npm may print notices before the array). */
export function packedArchiveFilename(packStdout: string): string {
  const output = packStdout.slice(packStdout.indexOf("["));
  const metadata = JSON.parse(output) as readonly [{ readonly filename: string }];
  return metadata[0]!.filename;
}

/** The system preparation commands: bounded executor children, one home. */
export const systemPackageArchiveCommands: PackageArchiveCommands = {
  build: async (stage) => {
    const result = await runProcess(
      packageBuildStage(stage.repositoryRoot, stage.deadlineMs),
      stage.signal,
    );
    assertStageExit("package build", result);
  },
  createScriptDisabledArchive: async (stage, destination) => {
    const result = await runProcess(
      packagePackStage(stage.repositoryRoot, destination, stage.deadlineMs),
      stage.signal,
    );
    assertStageExit("package pack", result);
    return packedArchiveFilename(result.stdout);
  },
};

/**
 * Hang bound for the unsupervised local fallback's whole build+pack budget
 * (stages consume the remaining share). Measured build+pack completes far
 * inside it; the value bounds a hung child, it is not a completion target.
 * Under the canonical supervised commands the supervisor owns the budget.
 */
export const UNSUPERVISED_PREPARATION_DEADLINE_MS = 120_000;

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
      `${SUPERVISED_INVOCATION_ENV} is set but no prepared package archive exists (${PREPARED_PACKAGE_ARCHIVE_ENV} is unset): the supervised invocation did not prepare the package this consumer needs. This is a suite-supervisor defect — a missed need derivation or a consumer file missing from INVOCATION_PACKAGE_CONSUMERS — and building here would silently hide it`,
    );
    this.name = "SupervisorPreparationDefectError";
  }
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
  const result = await runProcess({
    executable: "tar",
    arguments_: ["-xzf", archivePath, "-C", destination],
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "package archive extraction",
  });
  if (!(result.kind === "exit" && result.exitCode === 0)) {
    throw new PackagePreparationStageError("package archive extraction", result);
  }
}

/**
 * Resolve the package archive one consumer executes. A prepared archive
 * (supervisor injection or an operator-supplied `APKIT_TEST_PACKAGE_ARCHIVE`)
 * is returned untouched with a no-op cleanup: its bytes and lifetime belong
 * to whoever prepared it. Otherwise — an unsupervised direct run — the local
 * fallback builds and packs once through the same bounded preparation stages,
 * owning a fresh private directory that its cleanup removes. Under a
 * supervised marker with no prepared archive the call fails closed: a silent
 * build would hide the supervisor defect.
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
    throw new SupervisorPreparationDefectError();
  }

  const commands = options.commands ?? systemPackageArchiveCommands;
  const packageDirectory = mkdtempSync(join(tmpdir(), prefix));
  try {
    const startedAt = Date.now();
    const stage = (stageDeadline: number): PackageStageContext => {
      if (stageDeadline <= 0) {
        throw new Error(
          `unsupervised package preparation budget (${UNSUPERVISED_PREPARATION_DEADLINE_MS}ms) exhausted before a stage could run`,
        );
      }
      return { repositoryRoot, deadlineMs: stageDeadline, signal: undefined };
    };
    await commands.build(
      stage(UNSUPERVISED_PREPARATION_DEADLINE_MS - (Date.now() - startedAt)),
    );
    const filename = await commands.createScriptDisabledArchive(
      stage(UNSUPERVISED_PREPARATION_DEADLINE_MS - (Date.now() - startedAt)),
      packageDirectory,
    );
    const path = realpathSync(join(packageDirectory, filename));
    return {
      path,
      cleanup: () => rmSync(packageDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(packageDirectory, { recursive: true, force: true });
    throw error;
  }
}