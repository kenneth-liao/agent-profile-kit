import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runProcess,
  TEST_CHILD_DEADLINE_MS,
  type ExecutorOptions,
  type ProcessResult,
} from "./process-executor.js";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The packed CLI bundle every fleet qualification launch executes. */
export const FLEET_CLI_PATH = join(repositoryRoot, "dist", "cli.js");

export type FleetProcessExecutor = typeof runProcess;

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
}): ExecutorOptions {
  return {
    executable: options.executable,
    arguments_: [FLEET_CLI_PATH, ...withFleetScope(options.arguments_)],
    environment: { ...process.env, HOME: options.home, PATH: options.pathValue },
    deadlineMs: FLEET_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI",
  };
}

/** Fleet commands without a positional Project run across the whole fleet. */
export function withFleetScope(arguments_: readonly string[]): readonly string[] {
  const [command, ...rest] = arguments_;
  const hasPositional = rest.some((arg) => !arg.startsWith("-"));
  return (command === "apply" || command === "status") && !rest.includes("--all") && !hasPositional
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
  return executor(
    fleetExecutorOptions({
      home,
      pathValue,
      arguments_,
      executable: process.env.NODE_BINARY ?? "node",
    }),
  );
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
  return executor(
    fleetExecutorOptions({
      home,
      pathValue,
      arguments_,
      executable: process.env.NODE_BINARY ?? process.execPath,
    }),
  );
}