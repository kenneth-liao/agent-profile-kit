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

async function resolveCandidateCli(): Promise<ResolvedCandidateCli> {
  const archive = await obtainPackageArchive(
    packageArchiveRepositoryRoot(),
    "agent-profile-kit-fleet-cli-",
  );
  const directory = mkdtempSync(join(tmpdir(), "agent-profile-kit-fleet-cli-extracted-"));
  try {
    await extractPackageArchive(archive.path, directory);
    const cliPath = realpathSync(join(directory, "package", "dist", "cli.js"));
    return { cliPath, directory };
  } catch (error) {
    // An extraction failure leaves no extraction directory behind; the
    // in-flight promise is reset by the caller so a later launch can retry.
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The candidate CLI path for fleet launches, resolved once per process: the
 * first call obtains and extracts the invocation archive, later calls reuse
 * it, and a failed resolution cleans its extraction directory and resets the
 * in-flight promise so a retry is possible without leaking temporary state.
 */
export async function resolveFleetCliPath(): Promise<string> {
  if (resolvedCandidate !== null) return resolvedCandidate.cliPath;
  if (resolutionInFlight === null) {
    resolutionInFlight = (async () => {
      try {
        const resolved = await resolveCandidateCli();
        resolvedCandidate = resolved;
        return resolved;
      } finally {
        resolutionInFlight = null;
      }
    })();
  }
  return (await resolutionInFlight).cliPath;
}

/**
 * Release the resolved candidate's extraction directory and reset the
 * memoization. The fleet qualification file calls this from `afterAll` so the
 * extraction lifetime is owned and released deterministically per run process
 * (each supervised stress run is a fresh process, so nothing crosses runs).
 */
export function releaseFleetCliPath(): void {
  if (resolvedCandidate !== null) {
    rmSync(resolvedCandidate.directory, { recursive: true, force: true });
  }
  resolvedCandidate = null;
  resolutionInFlight = null;
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
    executable: process.env.NODE_BINARY ?? "node",
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
    { home, pathValue, arguments_, executable: process.env.NODE_BINARY ?? "node", cliPath },
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