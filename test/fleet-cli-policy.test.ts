import { describe, expect, test } from "bun:test";

import {
  FLEET_CHILD_DEADLINE_MS,
  FLEET_CLI_PATH,
  runFleetCli,
  runFleetCliWithExplicitPath,
} from "./support/fleet-cli.js";
import {
  TEST_CHILD_DEADLINE_MS,
  type ExecutorOptions,
  type ProcessResult,
} from "./support/process-executor.js";

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

  test("runFleetCli launches the packed CLI under the fleet deadline, not the fast-suite deadline", async () => {
    const records: ExecutorOptions[] = [];
    const result = await runFleetCli("home-dir", "path-dir", ["apply", "--all", "--json"], recordingExecutor(records));
    expect(result.kind).toBe("exit");
    expect(records).toHaveLength(1);
    const launch = records[0]!;
    expect(launch.deadlineMs).toBe(FLEET_CHILD_DEADLINE_MS);
    expect(launch.deadlineMs).not.toBe(TEST_CHILD_DEADLINE_MS);
    expect(launch.arguments_).toEqual([FLEET_CLI_PATH, "apply", "--all", "--json"]);
    expect(launch.environment?.HOME).toBe("home-dir");
    expect(launch.environment?.PATH).toBe("path-dir");
  });

  test("runFleetCliWithExplicitPath launches the packed CLI under the fleet deadline, not the fast-suite deadline", async () => {
    const records: ExecutorOptions[] = [];
    const result = await runFleetCliWithExplicitPath("home-dir", "path-dir", ["status", "--all", "--json"], recordingExecutor(records));
    expect(result.kind).toBe("exit");
    expect(records).toHaveLength(1);
    const launch = records[0]!;
    expect(launch.deadlineMs).toBe(FLEET_CHILD_DEADLINE_MS);
    expect(launch.deadlineMs).not.toBe(TEST_CHILD_DEADLINE_MS);
    expect(launch.arguments_).toEqual([FLEET_CLI_PATH, "status", "--all", "--json"]);
    expect(launch.environment?.HOME).toBe("home-dir");
    expect(launch.environment?.PATH).toBe("path-dir");
  });
});