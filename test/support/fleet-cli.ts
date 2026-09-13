import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runProcess,
  type ExecutorOptions,
  type ProcessResult,
} from "../../process/process-executor.js";
import {
  extractPackageArchive,
  obtainPackageArchive,
  packageArchiveRepositoryRoot,
  packedCliNodeExecutable,
} from "./package-archive.js";

export type FleetProcessExecutor = typeof runProcess;

/**
 * The candidate CLI path every fleet qualification launch executes, resolved
 * through the canonical package consumer boundary: the invocation's prepared
 * or supplied archive is obtained through `obtainPackageArchive` and extracted
 * once into a private directory this module owns. There is no repository
 * bundle fallback: a fleet launch always executes the candidate it was given,
 * so a deliberately different `dist/cli.js` in the repository cannot be
 * executed, and supplied archives work when the repository build output is
 * absent.
 */
interface ResolvedCandidateCli {
  readonly cliPath: string;
  /** The private extraction directory this module owns until release. */
  readonly directory: string;
}

let resolvedCandidate: ResolvedCandidateCli | null = null;
let resolutionInFlight: Promise<ResolvedCandidateCli> | null = null;
/**
 * The extraction lifetime's generation: a release advances it, so an in-flight
 * resolution from an ended lifetime can never repopulate the cache and no
 * subsequent caller can resolve into a released candidate.
 */
let lifetimeGeneration = 0;

async function resolveCandidateCli(): Promise<ResolvedCandidateCli> {
  const archive = await obtainPackageArchive(
    packageArchiveRepositoryRoot(),
    "agent-profile-kit-fleet-cli-",
  );
  let directory: string | undefined;
  let resolved: ResolvedCandidateCli | undefined;
  const failures: unknown[] = [];
  try {
    directory = mkdtempSync(join(tmpdir(), "agent-profile-kit-fleet-cli-extracted-"));
    await extractPackageArchive(archive.path, directory);
    resolved = { cliPath: realpathSync(join(directory, "package", "dist", "cli.js")), directory };
  } catch (error) {
    failures.push(error);
  }
  try { archive.cleanup(); } catch (error) { failures.push(error); }
  if (failures.length > 0) {
    if (directory !== undefined) {
      try { rmSync(directory, { recursive: true, force: true }); }
      catch (error) { failures.push(error); }
    }
    throw new AggregateError(failures, failures.map(String).join("; "));
  }
  return resolved!;
}

/**
 * The candidate CLI path for fleet launches, resolved once per lifetime: the
 * first call obtains and extracts the invocation archive, later calls reuse
 * it, a failed resolution cleans its extraction directory and resets the
 * in-flight promise so a retry is possible without leaking temporary state,
 * and a resolution whose lifetime was released while it ran completes without
 * repopulating the cache (the release owns that result's cleanup).
 */
export async function resolveFleetCliPath(): Promise<string> {
  if (resolvedCandidate !== null) return resolvedCandidate.cliPath;
  if (resolutionInFlight === null) {
    const myGeneration = lifetimeGeneration;
    resolutionInFlight = (async () => {
      try {
        const resolved = await resolveCandidateCli();
        // Only the current lifetime may cache: a resolution that raced a
        // release must never hand its (about-to-be-removed) directory to a
        // later caller through the cache.
        if (myGeneration === lifetimeGeneration) {
          resolvedCandidate = resolved;
        }
        return resolved;
      } finally {
        if (myGeneration === lifetimeGeneration) {
          resolutionInFlight = null;
        }
      }
    })();
  }
  return (await resolutionInFlight).cliPath;
}

/**
 * Release the resolved candidate's extraction directory and end the current
 * lifetime. A resolution still in flight is awaited first and its product is
 * removed by this release, so no extraction directory outlives the released
 * lifetime; the awaiting caller of that ended resolution receives its path
 * but the cache is never repopulated — its launch fails loudly instead of
 * silently reusing a released candidate. The fleet qualification file calls
 * this from `afterAll` so the extraction lifetime is owned and released
 * deterministically per run process (each supervised stress run is a fresh
 * process, so nothing crosses runs).
 */
export async function releaseFleetCliPath(): Promise<void> {
  lifetimeGeneration += 1;
  const resolved = resolvedCandidate;
  resolvedCandidate = null;
  const inFlight = resolutionInFlight;
  resolutionInFlight = null;
  const directory =
    resolved?.directory ?? (await inFlight?.catch(() => undefined))?.directory;
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Attempt every owned fleet cleanup before surfacing the collected failures. */
export async function cleanupFleetResources(cleanups: readonly (() => void | Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, failures.map(String).join("; "));
}

/**
 * One shared fleet child-deadline policy for both packed-CLI launch paths.
 * Fleet tests budget their children in minutes; this deadline is a finite hang
 * bound sized above the fast-suite `TEST_CHILD_DEADLINE_MS` with cleanup
 * headroom inside every enclosing fleet per-test budget, so executor
 * diagnostics and process-group cleanup still surface before Bun aborts a
 * test. A child that finishes earlier keeps its own exit code and output.
 */
export const FLEET_CHILD_DEADLINE_MS = 30_000;

function fleetExecutorOptions(options: {
  readonly home: string;
  readonly pathValue: string;
  readonly arguments_: readonly string[];
  readonly executable: string;
  readonly cliPath: string;
}): ExecutorOptions {
  return {
    executable: options.executable,
    arguments_: [options.cliPath, ...withFleetScope(options.arguments_)],
    environment: { ...process.env, HOME: options.home, PATH: options.pathValue },
    deadlineMs: FLEET_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI",
  };
}

/** Fleet commands without a positional Project run across the whole fleet. */
export function withFleetScope(arguments_: readonly string[]): readonly string[] {
  const [command, ...rest] = arguments_;
  const hasPositional = rest.some((arg) => !arg.startsWith("-"));
  return (command === "update" || command === "status") && !rest.includes("--all") && !hasPositional
    ? [...arguments_, "--all"]
    : arguments_;
}

/** One fleet packed-CLI launch under the shared fleet child-deadline policy. */
export async function runFleetCli(
  home: string,
  pathValue: string,
  arguments_: readonly string[],
  executor: FleetProcessExecutor = runProcess,
): Promise<ProcessResult> {
  return fleetLaunch({
    home,
    pathValue,
    arguments_,
    executable: packedCliNodeExecutable(),
    cliPath: await resolveFleetCliPath(),
  }, executor);
}

/**
 * One fleet packed-CLI launch with a fully controlled PATH (system PATH
 * excluded) so a missing Host stays missing, under the same fleet deadline.
 */
export async function runFleetCliWithExplicitPath(
  home: string,
  pathValue: string,
  arguments_: readonly string[],
  executor: FleetProcessExecutor = runProcess,
): Promise<ProcessResult> {
  return fleetLaunch({
    home,
    pathValue,
    arguments_,
    executable: process.env.NODE_BINARY ?? process.execPath,
    cliPath: await resolveFleetCliPath(),
  }, executor);
}

/**
 * Test seam: one fleet packed-CLI launch whose candidate path is supplied
 * explicitly, so the child-deadline and fleet-scope policy tests prove their
 * policy without resolving the real package seam (and without an environment
 * override). Canonical fleet launches always go through {@link runFleetCli},
 * which resolves the path through the consumer boundary.
 */
export async function runFleetCliWithCandidate(
  home: string,
  pathValue: string,
  cliPath: string,
  arguments_: readonly string[],
  executor: FleetProcessExecutor = runProcess,
): Promise<ProcessResult> {
  return fleetLaunch(
    { home, pathValue, arguments_, executable: packedCliNodeExecutable(), cliPath },
    executor,
  );
}

function fleetLaunch(
  options: {
    readonly home: string;
    readonly pathValue: string;
    readonly arguments_: readonly string[];
    readonly executable: string;
    readonly cliPath: string;
  },
  executor: FleetProcessExecutor,
): Promise<ProcessResult> {
  return executor(fleetExecutorOptions(options));
}
