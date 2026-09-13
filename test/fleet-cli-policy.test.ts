import { describe, expect, test } from "bun:test";

import {
  FLEET_CHILD_DEADLINE_MS,
  runFleetCliWithCandidate,
} from "./support/fleet-cli.js";
import {
  TEST_CHILD_DEADLINE_MS,
  type ExecutorOptions,
  type ProcessResult,
} from "../process/process-executor.js";

/** Executor stub that records the launch policy without spawning a child. */
function recordingExecutor(records: ExecutorOptions[]) {
  return async (options: ExecutorOptions): Promise<ProcessResult> => {
    records.push(options);
    return {
      kind: "exit",
      exitCode: 0,
      signal: null,
      error: null,
      timedOut: false,
      cancelled: false,
      cleanupFailed: false,
        cleanupDurationMs: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
      commandLabel: options.commandLabel ?? options.executable,
    };
  };
}

describe("fleet packed-CLI child deadline policy", () => {
  test("the fleet deadline is a finite hang bound above the fast-suite child deadline", () => {
    expect(Number.isFinite(FLEET_CHILD_DEADLINE_MS)).toBe(true);
    expect(FLEET_CHILD_DEADLINE_MS).toBeGreaterThan(TEST_CHILD_DEADLINE_MS);
  });

  test("runFleetCliWithCandidate launches the given candidate under the fleet deadline, not the fast-suite deadline", async () => {
    const records: ExecutorOptions[] = [];
    const result = await runFleetCliWithCandidate(
      "home-dir",
      "path-dir",
      "/fixture-candidate/package/dist/cli.js",
      ["update", "--all", "--json"],
      recordingExecutor(records),
    );
    expect(result.kind).toBe("exit");
    expect(records).toHaveLength(1);
    const launch = records[0]!;
    expect(launch.deadlineMs).toBe(FLEET_CHILD_DEADLINE_MS);
    expect(launch.deadlineMs).not.toBe(TEST_CHILD_DEADLINE_MS);
    // The launch executes the candidate it was given, verbatim.
    expect(launch.arguments_).toEqual([
      "/fixture-candidate/package/dist/cli.js",
      "update",
      "--all",
      "--json",
    ]);
    expect(launch.environment?.HOME).toBe("home-dir");
    expect(launch.environment?.PATH).toBe("path-dir");
  });
});