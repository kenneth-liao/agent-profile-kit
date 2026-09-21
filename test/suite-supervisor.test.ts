import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { runProcess } from "../process/process-executor.js";
import {
  AGGREGATE_DEADLINE_ENV,
  DEFAULT_PER_RUN_DEADLINE_MS,
  DIAGNOSTICS_DIR_ENV,
  MAX_BUDGET_MS,
  MAX_RUNS_ENV,
  PER_RUN_DEADLINE_ENV,
  PER_TEST_TIMEOUT_MS,
  QUALIFICATION_RECORD_FILENAME,
  QUALIFICATION_RECORD_SCHEMA,
  formatSuiteSummary,
  resolveSuitePolicy,
  runSupervisedSuite,
  systemOsVersionProbe,
  systemPackedRuntimeProbe,
  type SuiteMode,
} from "./support/suite-supervisor.js";
import { packedCliNodeExecutable } from "./support/package-archive.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function tempDir(prefix = "apkit-suite-supervisor-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Prove a pid is no longer a live process. The executor only settles cleanup
 * once its group-empty probe passes, so this must hold the instant the
 * supervisor resolves.
 */
function expectProcessGone(pid: number, label: string): void {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive, `${label} (pid ${pid}) must already be gone`).toBe(false);
}

/** One supervised "suite" backed by a shell fixture instead of `bun test`. */
function shFixture(script: string, name = "suite fixture"): readonly [string, ...string[]] {
  return ["sh", "-c", script, name];
}

describe("suite supervisor: full mode", () => {
  test("runs exactly one suite and reports a green run with a retained log", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("exit 0"),
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(result.mode).toBe("full");
      expect(result.ok).toBe(true);
      expect(result.attemptedRuns).toBe(1);
      expect(result.completedRuns).toBe(1);
      expect(result.maxRuns).toBe(1);
      expect(result.interrupted).toBe(false);
      expect(result.aggregateExhausted).toBe(false);
      expect(result.firstFailure).toBeNull();
      expect(result.logDir).toBe(logDir);
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0]!.runNumber).toBe(1);
      expect(result.runs[0]!.result.kind).toBe("exit");
      if (result.runs[0]!.result.kind === "exit") {
        expect(result.runs[0]!.result.exitCode).toBe(0);
      }
      expect(result.aggregateDurationMs).toBeGreaterThanOrEqual(0);
      const log = readFileSync(join(logDir, "run-1.log"), "utf8");
      expect(log).toContain("kind: exit");
      expect(log).toContain("exitCode: 0");
      expect(log).toContain("durationMs:");
      expect(log).toContain("cleanupDurationMs: 0");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("surfaces a nonzero suite exit as a failure", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("exit 3"),
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(1);
      expect(result.completedRuns).toBe(0);
      expect(result.firstFailure?.runNumber).toBe(1);
      expect(result.firstFailure?.result.kind).toBe("exit");
      if (result.firstFailure?.result.kind === "exit") {
        expect(result.firstFailure.result.exitCode).toBe(3);
      }
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("times out a stalled suite and cleans up its complete process group", async () => {
    const logDir = tempDir();
    try {
      const started = Date.now();
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("sleep 30 & echo child=$!; wait"),
        perRunDeadlineMs: 300,
        logDir,
      });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.ok).toBe(false);
      const run = result.runs[0]!;
      expect(run.result.kind).toBe("timeout");
      expect(run.result.cleanupFailed).toBe(false);
      const match = /child=(\d+)/.exec(run.result.stdout);
      expect(match?.[1]).toBeTruthy();
      expectProcessGone(Number(match![1]), "stalled descendant");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  // Fleet exclusion and required selection are proven behaviorally against the
  // real runner in test/suite-selection.test.ts; an argv inspection cannot
  // stand in for runner behavior.
});

describe("suite supervisor: focused mode", () => {
  test("forwards every test argument verbatim without shell interpolation", async () => {
    const logDir = tempDir();
    const userArgs = ["-t", "pattern with spaces", "'single-quoted'", "$HOME", "a;b"];
    try {
      const result = await runSupervisedSuite({
        mode: "focused",
        suiteCommand: shFixture('printf "%s\\n" "$@"', "argv fixture"),
        bunArguments: userArgs,
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(result.ok).toBe(true);
      const argv = result.runs[0]!.result.stdout.trim().split("\n");
      // The supervisor owns the per-test timeout policy; user arguments follow
      // untouched. An injected test-seam command manages its own output, so it
      // receives no structured-evidence reporter arguments.
      expect(argv).toEqual(["--timeout", String(PER_TEST_TIMEOUT_MS), ...userArgs]);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("marks the child environment when the explicit snapshot-update workflow is active", async () => {
    const logDir = tempDir();
    const fixture = 'printf "%s" "${APKIT_TEST_UPDATE_SNAPSHOTS:-absent}"';
    try {
      const withFlag = await runSupervisedSuite({
        mode: "focused",
        suiteCommand: shFixture(fixture, "env fixture"),
        bunArguments: ["--update-snapshots", "test/golden-snapshots.test.ts"],
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(withFlag.ok).toBe(true);
      expect(withFlag.runs[0]!.result.stdout).toBe("1");

      const withoutFlag = await runSupervisedSuite({
        mode: "focused",
        suiteCommand: shFixture(fixture, "env fixture"),
        bunArguments: ["test/golden-snapshots.test.ts"],
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(withoutFlag.ok).toBe(true);
      expect(withoutFlag.runs[0]!.result.stdout).toBe("absent");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("suite supervisor: stress mode", () => {
  test("completes after the configured number of green runs", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "stress",
        suiteCommand: shFixture("exit 0"),
        perRunDeadlineMs: 2000,
        aggregateDeadlineMs: 20_000,
        maxRuns: 4,
        logDir,
      });
      expect(result.ok).toBe(true);
      expect(result.attemptedRuns).toBe(4);
      expect(result.completedRuns).toBe(4);
      expect(result.maxRuns).toBe(4);
      expect(result.firstFailure).toBeNull();
      expect(result.aggregateExhausted).toBe(false);
      expect(result.runs).toHaveLength(4);
      for (let i = 0; i < 4; i++) {
        expect(result.runs[i]!.runNumber).toBe(i + 1);
        expect(result.runs[i]!.result.kind).toBe("exit");
        expect(readFileSync(join(logDir, `run-${i + 1}.log`), "utf8")).toContain("kind: exit");
      }
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("stops immediately at the first failing run", async () => {
    const logDir = tempDir();
    const counter = join(logDir, "counter");
    const script = [
      `n=$(cat ${counter} 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `echo $n > ${counter}`,
      '[ "$n" = "2" ] && exit 1',
      "exit 0",
    ].join("\n");
    try {
      const result = await runSupervisedSuite({
        mode: "stress",
        suiteCommand: shFixture(script),
        perRunDeadlineMs: 2000,
        aggregateDeadlineMs: 20_000,
        maxRuns: 5,
        logDir,
      });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(2);
      expect(result.completedRuns).toBe(1);
      expect(result.firstFailure?.runNumber).toBe(2);
      if (result.firstFailure?.result.kind === "exit") {
        expect(result.firstFailure.result.exitCode).toBe(1);
      }
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("stops at the first run that times out", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "stress",
        suiteCommand: shFixture("sleep 30"),
        perRunDeadlineMs: 300,
        aggregateDeadlineMs: 5000,
        maxRuns: 5,
        logDir,
      });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(1);
      expect(result.runs[0]!.result.kind).toBe("timeout");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("uses the remaining aggregate budget to complete the final green run", async () => {
    const logDir = tempDir();
    const counter = join(logDir, "counter");
    const script = [
      `n=$(cat ${counter} 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `echo $n > ${counter}`,
      '[ "$n" = "1" ] && sleep 0.6',
      "exit 0",
    ].join("\n");
    try {
      const result = await runSupervisedSuite({
        mode: "stress",
        suiteCommand: shFixture(script),
        perRunDeadlineMs: 1000,
        aggregateDeadlineMs: 1500,
        maxRuns: 2,
        logDir,
      });
      // Run two starts with less than a full per-run window remaining, but it
      // is quick enough to finish inside the aggregate deadline.
      expect(result.ok).toBe(true);
      expect(result.attemptedRuns).toBe(2);
      expect(result.completedRuns).toBe(2);
      expect(result.aggregateExhausted).toBe(false);
      expect(result.firstFailure).toBeNull();
      expect(result.aggregateDurationMs).toBeLessThanOrEqual(1500);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("times out an active final run at the aggregate deadline", async () => {
    const logDir = tempDir();
    const counter = join(logDir, "counter");
    const script = [
      `n=$(cat ${counter} 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `echo $n > ${counter}`,
      '[ "$n" = "1" ] && sleep 0.4 && exit 0',
      "sleep 30",
    ].join("\n");
    try {
      const result = await runSupervisedSuite({
        mode: "stress",
        suiteCommand: shFixture(script),
        perRunDeadlineMs: 1000,
        aggregateDeadlineMs: 1300,
        maxRuns: 2,
        cleanupGraceMs: 100,
        logDir,
      });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(2);
      expect(result.completedRuns).toBe(1);
      expect(result.aggregateExhausted).toBe(true);
      expect(result.firstFailure?.runNumber).toBe(2);
      expect(result.firstFailure?.result.kind).toBe("timeout");
      expect(result.firstFailure?.result.cleanupFailed).toBe(false);
      expect(result.aggregateDurationMs).toBeLessThanOrEqual(1800);
      expect(readFileSync(result.firstFailure!.logPath, "utf8")).toContain("kind: timeout");
      const summary = formatSuiteSummary(result, null);
      expect(summary).toContain("aggregate deadline reached during run 2/2 (timeout)");
      expect(summary).toContain(`log: ${result.firstFailure!.logPath}`);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("suite supervisor: bounded interruption", () => {
  test("aborting a supervised run cancels the active suite and cleans up its process group", async () => {
    const logDir = tempDir();
    const controller = new AbortController();
    try {
      const promise = runSupervisedSuite(
        {
          mode: "full",
          suiteCommand: shFixture("sleep 30 & echo child=$!; wait"),
          perRunDeadlineMs: 10_000,
          logDir,
        },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 150);
      const result = await promise;
      expect(result.interrupted).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.runs[0]!.result.kind).toBe("cancelled");
      expect(result.runs[0]!.result.cleanupFailed).toBe(false);
      const log = readFileSync(result.runs[0]!.logPath, "utf8");
      expect(log).toContain("kind: cancelled");
      expect(log).toContain("cancelled: true");
      expect(log).toContain("cleanupFailed: false");
      expect(log).toContain("--- stdout ---");
      expect(log).toContain("child=");
      expect(log).toContain("--- stderr ---");
      const match = /child=(\d+)/.exec(result.runs[0]!.result.stdout);
      expect(match?.[1]).toBeTruthy();
      expectProcessGone(Number(match![1]), "aborted descendant");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("suite supervisor: retained diagnostic logs", () => {
  test("distinguish exit, signal, spawn-error, and timeout evidence", async () => {
    const logDir = tempDir();
    try {
      const exit1 = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("exit 1"),
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(exit1.runs[0]!.result.kind).toBe("exit");
      expect(readFileSync(exit1.runs[0]!.logPath, "utf8")).toContain("exitCode: 1");

      const signal = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("kill -TERM $$"),
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(signal.runs[0]!.result.kind).toBe("signal");
      expect(readFileSync(signal.runs[0]!.logPath, "utf8")).toContain("signal: SIGTERM");

      const timeout = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("sleep 30"),
        perRunDeadlineMs: 300,
        logDir,
      });
      expect(timeout.runs[0]!.result.kind).toBe("timeout");
      const timeoutLog = readFileSync(timeout.runs[0]!.logPath, "utf8");
      expect(timeoutLog).toContain("kind: timeout");
      expect(timeoutLog).toContain("timedOut: true");

      const spawn = await runSupervisedSuite({
        mode: "full",
        suiteCommand: ["/nonexistent/agent-profile-kit-suite-command"],
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(spawn.runs[0]!.result.kind).toBe("spawn-error");
      expect(readFileSync(spawn.runs[0]!.logPath, "utf8")).toMatch(/error: .*(ENOENT|no such file)/i);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("default retained diagnostics are private regardless of the caller's umask", async () => {
    const result = await runSupervisedSuite({
      mode: "full",
      suiteCommand: shFixture("exit 0"),
      perRunDeadlineMs: 2000,
    });
    try {
      expect(statSync(result.logDir).mode & 0o777).toBe(0o700);
      expect(statSync(result.runs[0]!.logPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(result.logDir, { recursive: true, force: true });
    }
  });

  test("a real stalled Bun suite is terminated at the per-run deadline with a clean process group", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "focused",
        bunArguments: ["./test/support/fixtures/stall-suite-fixture.ts"],
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(result.ok).toBe(false);
      expect(result.runs[0]!.result.kind).toBe("timeout");
      expect(result.runs[0]!.result.cleanupFailed).toBe(false);
      expect(result.runs[0]!.result.durationMs).toBeLessThan(5000);
      expect(readFileSync(join(logDir, "run-1.log"), "utf8")).toContain("kind: timeout");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});

describe("suite supervisor: boundary validation", () => {
  test("rejects invalid modes and budgets at the boundary", async () => {
    await expect(
      runSupervisedSuite({ mode: "bogus" as SuiteMode, perRunDeadlineMs: 1000 }),
    ).rejects.toThrow(/full, focused, or stress/);
    await expect(
      runSupervisedSuite({ mode: "full", perRunDeadlineMs: 0 }),
    ).rejects.toThrow(/deadline/i);
    await expect(
      runSupervisedSuite({ mode: "full", perRunDeadlineMs: NaN }),
    ).rejects.toThrow(/deadline/i);
    await expect(
      runSupervisedSuite({ mode: "full", perRunDeadlineMs: 1000, bunArguments: ["test/foo.test.ts"] }),
    ).rejects.toThrow(/focused/);
    await expect(
      runSupervisedSuite({
        mode: "focused",
        suiteCommand: shFixture("exit 0"),
        perRunDeadlineMs: 1000,
      }),
    ).rejects.toThrow(/focused.*path.*filter/i);
    await expect(
      runSupervisedSuite({ mode: "stress", perRunDeadlineMs: 5000, aggregateDeadlineMs: 2000 }),
    ).rejects.toThrow(/aggregate/);
    await expect(
      runSupervisedSuite({ mode: "stress", perRunDeadlineMs: 1000, aggregateDeadlineMs: 5000, maxRuns: 0 }),
    ).rejects.toThrow(/runs/i);
  });
});

describe("supervised CLI", () => {
  test("rejects focused mode without an explicit path or filter", async () => {
    const result = await runProcess({
      executable: process.execPath,
      arguments_: ["run", "test/support/suite-supervisor.ts", "focused"],
      deadlineMs: 5000,
      commandLabel: "empty focused CLI",
    });
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).not.toBe(0);
    }
    expect(result.stdout).not.toContain("starting");
    expect(result.stderr).toMatch(/focused.*path.*filter/i);
  });

  test("rejects an empty explicit diagnostics directory before starting", async () => {
    const result = await runProcess({
      executable: process.execPath,
      arguments_: [
        "run",
        "test/support/suite-supervisor.ts",
        "focused",
        "--",
        "./test/process-executor.test.ts",
      ],
      environment: { ...process.env, APKIT_TEST_DIAGNOSTICS_DIR: "" },
      deadlineMs: 5000,
      commandLabel: "empty diagnostics directory CLI",
    });

    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(2);
    }
    expect(result.stdout).not.toContain("starting");
    expect(result.stderr).toContain("APKIT_TEST_DIAGNOSTICS_DIR must name a directory");
  });

  test("runs a focused real Bun suite and prints a concise summary with the retained log", async () => {
    const result = await runProcess({
      executable: process.execPath,
      arguments_: [
        "run",
        "test/support/suite-supervisor.ts",
        "focused",
        "--",
        "./test/process-executor.test.ts",
        "-t",
        "normal exit",
      ],
      environment: { ...process.env, PATH: "/usr/bin:/bin" },
      deadlineMs: 60_000,
      commandLabel: "supervised focused CLI",
    });
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(0);
    }
    expect(result.stdout).toContain("1 run, exit 0");
    const logMatch = /log: (\S+run-1\.log)/.exec(result.stdout);
    expect(logMatch?.[1]).toBeTruthy();
    const log = readFileSync(logMatch![1]!, "utf8");
    expect(log).toContain("normal exit reports");
    expect(log).toContain("kind: exit");
  });

  test("writes complete diagnostics to the explicit canonical directory", async () => {
    const diagnosticsDir = tempDir("apkit-explicit-suite-diagnostics-");
    try {
      const result = await runProcess({
        executable: process.execPath,
        arguments_: [
          "run",
          "test/support/suite-supervisor.ts",
          "focused",
          "--",
          "./test/process-executor.test.ts",
          "-t",
          "normal exit",
        ],
        environment: {
          ...process.env,
          APKIT_TEST_DIAGNOSTICS_DIR: diagnosticsDir,
          PATH: "/usr/bin:/bin",
        },
        deadlineMs: 60_000,
        commandLabel: "explicit diagnostics CLI",
      });

      expect(result.kind).toBe("exit");
      if (result.kind === "exit") {
        expect(result.exitCode).toBe(0);
      }
      expect(result.stdout).toContain(`log: ${join(diagnosticsDir, "run-1.log")}`);
      expect(existsSync(join(diagnosticsDir, QUALIFICATION_RECORD_FILENAME))).toBe(true);
      const log = readFileSync(join(diagnosticsDir, "run-1.log"), "utf8");
      expect(log).toContain("kind: exit");
      expect(log).toContain("cleanupFailed: false");
      expect(log).toContain("--- stdout ---");
      expect(log).toContain("normal exit reports");
      expect(log).toContain("--- stderr ---");
    } finally {
      rmSync(diagnosticsDir, { recursive: true, force: true });
    }
  });

  test("SIGINT during a supervised run cleans up the active Bun process and exits nonzero", async () => {
    const wrapperDir = tempDir("apkit-sigint-wrapper-");
    const wrapper = join(wrapperDir, "interrupt.sh");
    const supervisorOutput = join(wrapperDir, "supervisor.out");
    try {
      writeFileSync(wrapper, [
        "#!/bin/sh",
        `bun run test/support/suite-supervisor.ts focused -- ./test/support/fixtures/stall-suite-fixture.ts >"${supervisorOutput}" 2>&1 &`,
        "sp=$!",
        "sleep 1",
        'kill -INT "$sp"',
        'wait "$sp"',
        "echo supervisor-exit=$?",
        "remaining=$(pgrep -f stall-suite-fixture || true)",
        'echo remaining-procs="$remaining"',
      ].join("\n") + "\n");
      const result = await runProcess({
        executable: "sh",
        arguments_: [wrapper],
        deadlineMs: 30_000,
        commandLabel: "SIGINT wrapper",
      });
      expect(result.kind).toBe("exit");
      if (result.kind === "exit") {
        expect(result.exitCode).toBe(0);
      }
      expect(result.stdout).toContain("supervisor-exit=130");
      // No bun test process running the stall fixture survives the interrupt.
      expect(result.stdout).toContain("remaining-procs=");
      expect(result.stdout).not.toMatch(/remaining-procs=[0-9]/);
      // The interrupted summary is still emitted before the nonzero exit.
      const summary = readFileSync(supervisorOutput, "utf8");
      expect(summary).toContain("interrupted (SIGINT)");
      expect(summary).toContain("1 run");
      expect(summary).toMatch(/log: \S+run-1\.log/);
    } finally {
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  });
});

const focusedCli = (extraArguments: readonly string[]): readonly string[] => [
  "run",
  "test/support/suite-supervisor.ts",
  "focused",
  ...extraArguments,
];

function runSupervisorCli(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  deadlineMs = 60_000,
  innerDiagnosticsDir?: string,
): Promise<Awaited<ReturnType<typeof runProcess>>> {
  const effectiveEnvironment =
    innerDiagnosticsDir === undefined
      ? environment
      : { ...environment, [DIAGNOSTICS_DIR_ENV]: innerDiagnosticsDir };
  return runProcess({
    executable: process.execPath,
    arguments_,
    environment: effectiveEnvironment,
    deadlineMs,
    commandLabel: "supervisor CLI",
  }).then((result) => {
    announceSupervisorFailureEvidence(result, innerDiagnosticsDir);
    return result;
  });
}

/** One evidence section, bounded so the announced block stays far below the
 * executor's per-stream capture budget that retains it. */
function evidenceSection(label: string, content: string, head = false): string {
  const limit = 16_384;
  const bounded =
    content.length <= limit ? content : `${head ? content.slice(0, limit) : content.slice(-limit)}`;
  return `\n--- ${label} ---\n${bounded === "" ? "(empty)" : bounded}`;
}

/**
 * Announce a failing inner supervisor's own evidence on this test process's
 * stderr. The retained artifact a maintainer downloads contains only what
 * the outer supervisor wrote into its diagnostics directory, and a nested
 * test process cannot write there; its captured stderr is what the outer
 * supervisor retains verbatim in the uploaded run-1.log. Announcing here is
 * therefore how a failing supervisor's stderr, exit code, and qualification
 * record reach the artifact, so a failure names its own mechanism instead of
 * surfacing as an unattributable missing summary (issue #566).
 */
function announceSupervisorFailureEvidence(
  result: Awaited<ReturnType<typeof runProcess>>,
  innerDiagnosticsDir: string | undefined,
): void {
  if (result.kind === "exit" && result.exitCode === 0) return;
  try {
    const exitDescription =
      result.kind === "exit" ? `exit ${result.exitCode}` : `kind ${result.kind}`;
    const sections = [
      `supervisor-cli failure evidence: ${exitDescription}`,
      evidenceSection("supervisor stderr", result.stderr),
      evidenceSection("supervisor stdout", result.stdout),
    ];
    if (innerDiagnosticsDir === undefined) {
      sections.push(
        "supervisor qualification record: not retained (no explicit inner diagnostics directory was passed to runSupervisorCli)",
      );
    } else {
      sections.push(
        evidenceSection(
          "supervisor qualification record",
          readSupervisorEvidenceFile(join(innerDiagnosticsDir, QUALIFICATION_RECORD_FILENAME)),
        ),
        evidenceSection(
          "supervisor run-1 log (head)",
          readSupervisorEvidenceFile(join(innerDiagnosticsDir, "run-1.log")),
          true,
        ),
      );
    }
    console.error(sections.join("\n"));
  } catch (announcementError) {
    console.error(
      `supervisor-cli failure evidence could not be announced: ${String(announcementError)}`,
    );
  }
}

function readSupervisorEvidenceFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "(absent — this supervisor never wrote it)";
  }
}

describe("suite supervisor: finite budget override interface", () => {
  test("rejects invalid, nonfinite, and timer-unsafe per-run overrides before launching", async () => {
    for (const value of [
      "abc",
      "NaN",
      "Infinity",
      "-Infinity",
      "-1000",
      "1.5",
      "1e3",
      "0x10",
      "+5",
      "",
      " ",
      "0",
      "2147483648",
      "999999999999999999999",
    ]) {
      const logDir = tempDir();
      try {
        const result = await runSupervisorCli(
          focusedCli(["--", "./test/process-executor.test.ts", "-t", "normal exit"]),
          {
            ...process.env,
            [PER_RUN_DEADLINE_ENV]: value,
            APKIT_TEST_DIAGNOSTICS_DIR: logDir,
          },
        );
        expect(result.kind, `value '${value}' must be rejected as exit`).toBe("exit");
        if (result.kind === "exit") {
          expect(result.exitCode, `value '${value}'`).toBe(2);
        }
        expect(result.stderr, `value '${value}'`).toContain(PER_RUN_DEADLINE_ENV);
        expect(result.stdout, `value '${value}' must not start a run`).not.toContain("starting");
        // Rejection happens before execution: no run log may exist.
        expect(readdirSync(logDir), `value '${value}'`).toEqual([]);
      } finally {
        rmSync(logDir, { recursive: true, force: true });
      }
    }
  });

  test("rejects aggregate and run-count overrides as unsupported outside stress mode", async () => {
    for (const [envName, value] of [
      [AGGREGATE_DEADLINE_ENV, "5000"],
      [MAX_RUNS_ENV, "3"],
    ] as const) {
      for (const mode of ["full", "focused"] as const) {
        const arguments_ =
          mode === "focused"
            ? ["run", "test/support/suite-supervisor.ts", "focused", "--", "./test/process-executor.test.ts", "-t", "normal exit"]
            : ["run", "test/support/suite-supervisor.ts", mode];
        const result = await runSupervisorCli(arguments_, { ...process.env, [envName]: value });
        expect(result.kind, `${mode} ${envName}`).toBe("exit");
        if (result.kind === "exit") {
          expect(result.exitCode, `${mode} ${envName}`).toBe(2);
        }
        expect(result.stderr, `${mode} ${envName}`).toContain(envName);
        expect(result.stderr, `${mode} ${envName}`).toMatch(new RegExp(`not supported for ${mode}`));
        expect(result.stdout, `${mode} ${envName}`).not.toContain("starting");
      }
    }
  });

  test("rejects an incoherent stress budget naming both override variables", async () => {
    const result = await runSupervisorCli(["run", "test/support/suite-supervisor.ts", "stress"], {
      ...process.env,
      [PER_RUN_DEADLINE_ENV]: "5000",
      [AGGREGATE_DEADLINE_ENV]: "1000",
    });
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(2);
    }
    expect(result.stderr).toContain(AGGREGATE_DEADLINE_ENV);
    expect(result.stderr).toContain(PER_RUN_DEADLINE_ENV);
    expect(result.stderr).toMatch(/aggregate/i);
    expect(result.stdout).not.toContain("starting");
  });

  test("prints the effective policy with override attribution and retains it in the run log", async () => {
    const result = await runSupervisorCli(
      focusedCli(["--", "./test/process-executor.test.ts", "-t", "normal exit"]),
      {
        ...process.env,
        PATH: "/usr/bin:/bin",
        [PER_RUN_DEADLINE_ENV]: "600000",
      },
    );
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(0);
    }
    expect(result.stdout).toContain(
      `suite focused: run 1/1 starting (per-run deadline 600000ms, overrides: ${PER_RUN_DEADLINE_ENV}=600000)`,
    );
    const logMatch = /log: (\S+run-1\.log)/.exec(result.stdout);
    expect(logMatch?.[1]).toBeTruthy();
    const log = readFileSync(logMatch![1]!, "utf8");
    expect(log).toContain(
      `effective-policy: mode=focused per-run=600000ms aggregate=600000ms max-runs=1`,
    );
  });

  test("prints the default policy explicitly when no override is supplied", async () => {
    const result = await runSupervisorCli(
      focusedCli(["--", "./test/process-executor.test.ts", "-t", "normal exit"]),
      { ...process.env, PATH: "/usr/bin:/bin" },
    );
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(0);
    }
    expect(result.stdout).toContain(
      `suite focused: run 1/1 starting (per-run deadline ${DEFAULT_PER_RUN_DEADLINE_MS}ms, policy: defaults)`,
    );
  });

  test("exhausts an overridden per-run deadline on a real Bun child and reports incomplete qualification", async () => {
    // An explicit inner diagnostics directory retains the inner supervisor's
    // own run log and qualification record where the failure-announcement
    // helper can read them; without it the supervisor scatters its evidence
    // into a private mkdtemp directory a maintainer can never download.
    const innerDiagnosticsDir = tempDir("apkit-inner-supervisor-diagnostics-");
    const result = await runSupervisorCli(
      focusedCli(["--", "./test/support/fixtures/stall-suite-fixture.ts"]),
      {
        ...process.env,
        PATH: "/usr/bin:/bin",
        [PER_RUN_DEADLINE_ENV]: "500",
      },
      30_000,
      innerDiagnosticsDir,
    );
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).not.toBe(0);
    }
    expect(result.stdout).toContain(
      `suite focused: run 1/1 starting (per-run deadline 500ms, overrides: ${PER_RUN_DEADLINE_ENV}=500)`,
    );
    expect(result.stdout).toContain("failed (timeout)");
    expect(result.stdout).not.toContain("exit 0");
    const logMatch = /log: (\S+run-1\.log)/.exec(result.stdout);
    expect(logMatch?.[1]).toBeTruthy();
    const log = readFileSync(logMatch![1]!, "utf8");
    expect(log).toContain("kind: timeout");
    expect(log).toContain("effective-policy: mode=focused per-run=500ms");
    // The inner supervisor's own record is retained evidence for this test
    // family: it must exist on this path and must represent the timeout as an
    // incomplete qualification, never a complete one (US-001).
    const innerRecordPath = join(innerDiagnosticsDir, QUALIFICATION_RECORD_FILENAME);
    expect(existsSync(innerRecordPath)).toBe(true);
    const innerRecord = JSON.parse(readFileSync(innerRecordPath, "utf8"));
    expect(innerRecord.status).toBe("incomplete");
    expect(innerRecord.runs[0].timedOut).toBe(true);
  });

  test("an unrelated control process survives a supervised timeout cleanup", async () => {
    // A process-group leader independent of the supervised suite: cleanup
    // targets only the suite's own group, so the control process must survive.
    const control = spawn("sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
    try {
      const logDir = tempDir();
      try {
        const result = await runSupervisedSuite({
          mode: "full",
          suiteCommand: shFixture("sleep 30"),
          perRunDeadlineMs: 300,
          logDir,
        });
        expect(result.ok).toBe(false);
        expect(result.runs[0]!.result.kind).toBe("timeout");
        let controlAlive = true;
        try {
          process.kill(control.pid!, 0);
        } catch {
          controlAlive = false;
        }
        expect(controlAlive, `unrelated control process (pid ${control.pid}) must survive`).toBe(true);
      } finally {
        rmSync(logDir, { recursive: true, force: true });
      }
    } finally {
      try {
        process.kill(-control.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  test("budget override variables are stripped from the supervised child environment", async () => {
    // A real child fixture through the real spawn path: with every override
    // variable set on the supervisor process, the child must see none of them.
    const previousPerRun = process.env[PER_RUN_DEADLINE_ENV];
    const previousAggregate = process.env[AGGREGATE_DEADLINE_ENV];
    const previousMaxRuns = process.env[MAX_RUNS_ENV];
    process.env[PER_RUN_DEADLINE_ENV] = "600000";
    process.env[AGGREGATE_DEADLINE_ENV] = "6000000";
    process.env[MAX_RUNS_ENV] = "3";
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture(
          'printf "per-run=%s aggregate=%s max-runs=%s" "${APKIT_TEST_PER_RUN_DEADLINE_MS:-absent}" "${APKIT_TEST_AGGREGATE_DEADLINE_MS:-absent}" "${APKIT_TEST_MAX_RUNS:-absent}"',
          "child environment fixture",
        ),
        perRunDeadlineMs: 2000,
        logDir: tempDir(),
      });
      try {
        expect(result.ok).toBe(true);
        expect(result.runs[0]!.result.stdout.trim()).toBe(
          "per-run=absent aggregate=absent max-runs=absent",
        );
      } finally {
        rmSync(result.logDir, { recursive: true, force: true });
      }
    } finally {
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      };
      restore(PER_RUN_DEADLINE_ENV, previousPerRun);
      restore(AGGREGATE_DEADLINE_ENV, previousAggregate);
      restore(MAX_RUNS_ENV, previousMaxRuns);
    }
  });

  test("library budgets reject nonfinite, non-integer, and timer-unsafe values", async () => {
    await expect(
      runSupervisedSuite({ mode: "full", perRunDeadlineMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(/perRunDeadlineMs/);
    await expect(
      runSupervisedSuite({ mode: "full", perRunDeadlineMs: Number.NaN }),
    ).rejects.toThrow(/perRunDeadlineMs/);
    await expect(
      runSupervisedSuite({ mode: "full", perRunDeadlineMs: 1500.5 }),
    ).rejects.toThrow(/perRunDeadlineMs/);
    await expect(
      runSupervisedSuite({ mode: "full", perRunDeadlineMs: MAX_BUDGET_MS + 1 }),
    ).rejects.toThrow(/timer-safe/);
    await expect(
      runSupervisedSuite({
        mode: "stress",
        perRunDeadlineMs: 1000,
        aggregateDeadlineMs: MAX_BUDGET_MS + 1,
      }),
    ).rejects.toThrow(/aggregateDeadlineMs/);
    await expect(
      runSupervisedSuite({
        mode: "stress",
        perRunDeadlineMs: 1000,
        aggregateDeadlineMs: 5000,
        maxRuns: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).rejects.toThrow(/maxRuns/);
  });

  test("stress with an unbounded run count reports truthful aggregate exhaustion", async () => {
    // Deterministic coordination, not sleep-window racing: the aggregate
    // (500ms) is smaller than the per-run deadline (1000ms), so run one is
    // already aggregate-limited and — because an instant `exit 0` fixture
    // cannot consume its budget — completes green; run two then runs under
    // the remaining aggregate budget and its 30s stall deterministically
    // exceeds it, so the invocation can only report aggregate exhaustion,
    // never a per-run deadline expiry and never silent success. The runner
    // margins are one-sided: run one must finish within 500ms (an instant
    // exit), run two must exceed its remaining budget (a 30s stall).
    const logDir = tempDir();
    const counter = join(logDir, "counter");
    const script = [
      `n=$(cat ${counter} 2>/dev/null || echo 0)`,
      "n=$((n + 1))",
      `echo $n > ${counter}`,
      '[ "$n" = "2" ] && sleep 30',
      "exit 0",
    ].join("\n");
    try {
      const result = await runSupervisedSuite({
        mode: "stress",
        suiteCommand: shFixture(script),
        perRunDeadlineMs: 1000,
        aggregateDeadlineMs: 1000,
        maxRuns: Number.MAX_SAFE_INTEGER,
        cleanupGraceMs: 100,
        logDir,
      });
      expect(result.ok).toBe(false);
      // The invocation ran until the aggregate budget was spent; uncompleted
      // repetition is reported, never silent success. Non-green runs under the
      // aggregate-limited deadline are timeout evidence, not suite failures.
      expect(result.attemptedRuns).toBe(2);
      expect(result.completedRuns).toBe(1);
      expect(result.aggregateExhausted).toBe(true);
      expect(result.runs[0]!.result.kind).toBe("exit");
      expect(result.runs[1]!.result.kind).toBe("timeout");
      expect(result.firstFailure?.runNumber).toBe(2);
      const summary = formatSuiteSummary(result, null);
      expect(summary).toContain("aggregate deadline reached");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("the resolved policy is available to programmatic consumers", () => {
    expect(resolveSuitePolicy({ mode: "full", perRunDeadlineMs: 1234 })).toEqual({
      mode: "full",
      perRunDeadlineMs: 1234,
      aggregateDeadlineMs: 1234,
      maxRuns: 1,
    });
  });
});

describe("suite supervisor: internal errors still reach the reader", () => {
  test("an exceptional finalization still emits its truthful summary on stdout with the cause on stderr", async () => {
    // A caller-supplied diagnostics path that is an existing file cannot host
    // the directory, so the run loop's first evidence write fails into
    // invocationError and finalization throws — the exact completion path
    // where the supervisor previously exited nonzero having printed only its
    // start line, with the cause and any summary nowhere a reader would look
    // (issue #566, CI run 34799974423). No mocks: the real supervisor, the
    // real Bun child, real exit codes and captured streams.
    const blockerFile = join(tempDir("apkit-supervisor-logdir-blocker-"), "logdir");
    writeFileSync(blockerFile, "a file, not a diagnostics directory\n", { mode: 0o600 });
    const result = await runSupervisorCli(
      focusedCli(["--", "./test/process-executor.test.ts", "-t", "normal exit"]),
      { ...process.env, PATH: "/usr/bin:/bin" },
      60_000,
      blockerFile,
    );
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).not.toBe(0);
    }
    // The truthful summary reaches stdout, where the summary contract lives:
    // completion status, cause, and no representation as a complete
    // qualification (US-001).
    expect(result.stdout).toContain("suite focused: failed (internal error: ");
    expect(result.stdout).not.toContain("green");
    // stderr keeps the raw cause for diagnosis.
    expect(result.stderr).toContain("suite supervisor: ");
    expect(result.stderr.length).toBeGreaterThan("suite supervisor: \n".length);
  });
});

/**
 * The qualification record (#539): one compact structured record the supervisor
 * projects from its own canonical outcome and the predecessor identity
 * contract, on every exit path. These tests read the record the supervisor
 * wrote, never an internal helper.
 */
describe("suite supervisor: qualification records", () => {
  const recordPath = (logDir: string): string => join(logDir, QUALIFICATION_RECORD_FILENAME);

  test("a green seam invocation retains a complete record with truthful runtimes", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("exit 0"),
        perRunDeadlineMs: 2000,
        logDir,
        // The macOS version observation is injected: the expected value is
        // exactly what this probe returned — never a label inference.
        osVersionProbe: async () => ({ kind: "observed", version: "14.5.0" }),
      });
      expect(result.ok).toBe(true);
      const record = JSON.parse(readFileSync(recordPath(logDir), "utf8")) as { runs: Array<Record<string, unknown>> } & Record<string, unknown>;
      expect(record.schema).toBe(QUALIFICATION_RECORD_SCHEMA);
      expect(record.mode).toBe("full");
      expect(record.status).toBe("complete");
      expect(record.ok).toBe(true);
      // A seam invocation injects its own command: the record's source identity
      // is the checkout the supervisor ran in (captured at admission), but the
      // runner claim stays the injected fixture — never presented as Bun — and
      // no packed runtime is claimed.
      const source = record.source as Record<string, unknown>;
      expect(record.source).toMatchObject({
        kind: "admitted-source",
      });
      expect(String(source.sourceFingerprint)).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof source.entryCount).toBe("number");
      expect(record.runtime).toEqual({
        supervisor: {
          name: "bun",
          version: process.versions.bun,
          executable: process.execPath,
          platform: process.platform,
          arch: process.arch,
          osVersion: { kind: "observed", version: "14.5.0" },
        },
        suiteRunner: { kind: "injected-fixture", executable: "sh" },
      });
      expect(record.selection).toBeNull();
      expect(record.policy).toEqual({
        perRunDeadlineMs: 2000,
        aggregateDeadlineMs: 2000,
        maxRuns: 1,
      });
      expect(record.runs).toHaveLength(1);
      expect(record.runs[0]).toMatchObject({
        runNumber: 1,
        kind: "exit",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        cleanupFailed: false,
      });
      expect(existsSync((record.runs[0] as Record<string, unknown>).logPath as string)).toBe(true);
      expect(record.attemptedRuns).toBe(1);
      expect(record.completedRuns).toBe(1);
      expect(record.diagnostics).toMatchObject({ logDir });
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("an unavailable macOS version observation marks a green run incomplete with its cause", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("exit 0"),
        perRunDeadlineMs: 2000,
        logDir,
        osVersionProbe: async () => ({ kind: "unavailable", cause: "INJECTED-MACOS-FAULT" }),
      });
      // The run itself still executed: the observation gates completion, not
      // the run loop — but a baseline without its observed macOS identity can
      // never be represented as complete qualification.
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(1);
      const record = JSON.parse(readFileSync(recordPath(logDir), "utf8")) as Record<string, unknown>;
      expect(record.status).toBe("incomplete");
      expect(record.ok).toBe(false);
      expect(record.reason).toContain("the macOS version observation failed: INJECTED-MACOS-FAULT");
      const runtime = record.runtime as { supervisor: Record<string, unknown> };
      expect(runtime.supervisor.osVersion).toEqual({ kind: "unavailable", cause: "INJECTED-MACOS-FAULT" });
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("a failed run is incomplete with its retained run outcome", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("exit 3"),
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(result.ok).toBe(false);
      const record = JSON.parse(readFileSync(recordPath(logDir), "utf8")) as { runs: Array<Record<string, unknown>> } & Record<string, unknown>;
      expect(record.status).toBe("incomplete");
      expect(record.ok).toBe(false);
      expect(record.reason).toContain("exit 3");
      expect(record.runs).toHaveLength(1);
      expect((record.runs[0] as Record<string, unknown>).exitCode).toBe(3);
      expect(record.attemptedRuns).toBe(1);
      expect(record.completedRuns).toBe(0);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("a timed-out run is incomplete with its typed outcome and cleanup duration", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("sleep 30"),
        perRunDeadlineMs: 300,
        logDir,
      });
      expect(result.ok).toBe(false);
      const record = JSON.parse(readFileSync(recordPath(logDir), "utf8")) as { runs: Array<Record<string, unknown>> } & Record<string, unknown>;
      expect(record.status).toBe("incomplete");
      expect(record.ok).toBe(false);
      expect((record.runs[0] as Record<string, unknown>).kind).toBe("timeout");
      expect(typeof (record.runs[0] as Record<string, unknown>).cleanupDurationMs).toBe("number");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("an interruption during a run is recorded as interrupted", async () => {
    const logDir = tempDir();
    const markerDir = tempDir();
    const controller = new AbortController();
    const marker = join(markerDir, "run-started");
    const pending = runSupervisedSuite(
      { mode: "full", suiteCommand: shFixture(`touch '${marker}'; sleep 10`), perRunDeadlineMs: 30_000, logDir },
      controller.signal,
    );
    try {
      // Abort only once run 1's child has observably started: an abort during
      // the admission work before run 1 yields the zero-run record instead.
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });
      const startDeadline = Date.now() + 10_000;
      while (!existsSync(marker)) {
        if (settled) throw new Error("the supervisor settled before run 1 started");
        if (Date.now() > startDeadline) throw new Error("run 1 did not start within 10s");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      const result = await pending;
      expect(result.interrupted).toBe(true);
      const record = JSON.parse(readFileSync(recordPath(logDir), "utf8")) as { runs: Array<Record<string, unknown>> } & Record<string, unknown>;
      expect(record.status).toBe("interrupted");
      expect(record.ok).toBe(false);
      expect((record.runs[0] as Record<string, unknown>).cancelled).toBe(true);
    } finally {
      // Cancel and join the supervisor on every exit path, so it never outlives
      // the directories it writes to. A rejection here already failed the test
      // at `await pending`, or is secondary to the failure being thrown.
      controller.abort();
      await pending.catch(() => {});
      rmSync(logDir, { recursive: true, force: true });
      rmSync(markerDir, { recursive: true, force: true });
    }
  });

  test("an interruption before run 1 still retains an interrupted zero-run record", async () => {
    const logDir = tempDir();
    try {
      const controller = new AbortController();
      controller.abort();
      const result = await runSupervisedSuite(
        { mode: "full", suiteCommand: shFixture("exit 0"), perRunDeadlineMs: 2000, logDir },
        controller.signal,
      );
      expect(result.interrupted).toBe(true);
      expect(result.attemptedRuns).toBe(0);
      const record = JSON.parse(readFileSync(recordPath(logDir), "utf8")) as { runs: Array<Record<string, unknown>> } & Record<string, unknown>;
      expect(record.status).toBe("interrupted");
      expect(record.runs).toHaveLength(0);
      expect(record.attemptedRuns).toBe(0);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("a stress invocation retains its initial failed run without concealing it", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "stress",
        suiteCommand: shFixture("exit 3"),
        perRunDeadlineMs: 2000,
        aggregateDeadlineMs: 10_000,
        maxRuns: 3,
        logDir,
      });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(1);
      const record = JSON.parse(readFileSync(recordPath(logDir), "utf8")) as { runs: Array<Record<string, unknown>> } & Record<string, unknown>;
      expect(record.status).toBe("incomplete");
      expect(record.runs).toHaveLength(1);
      expect((record.runs[0] as Record<string, unknown>).exitCode).toBe(3);
      expect(record.attemptedRuns).toBe(1);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("a failed record publication is retained, not ok, and leaves no misleading record", async () => {
    const logDir = tempDir();
    // A stale record from a reused diagnostics directory must not survive as
    // this invocation's evidence.
    writeFileSync(recordPath(logDir), "{}\n");
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("exit 0"),
        perRunDeadlineMs: 2000,
        logDir,
        onRunComplete: () => chmodSync(logDir, 0o500),
      });
      expect(result.ok).toBe(false);
      expect(result.preparation.cleanupFailed).toBe(true);
      expect(result.preparation.cleanupFailure ?? "").toContain("qualification record");
      expect(existsSync(recordPath(logDir))).toBe(false);
    } finally {
      chmodSync(logDir, 0o700);
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("an exceptional run-loop exit is never a complete record and carries its cause", async () => {
    const logDir = tempDir();
    try {
      const error = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture("exit 0"),
        perRunDeadlineMs: 2000,
        logDir,
        onRunComplete: () => {
          throw new Error("INJECTED-CALLBACK-FAULT");
        },
      }).catch((thrown: unknown) => thrown);
      expect(String(error)).toContain("INJECTED-CALLBACK-FAULT");
      const record = JSON.parse(readFileSync(recordPath(logDir), "utf8")) as Record<string, unknown>;
      // The retained record can never claim a complete qualification for an
      // invocation whose run loop threw — even when the final run was green.
      expect(record.status).toBe("incomplete");
      expect(record.ok).toBe(false);
      expect(record.reason).toContain("INJECTED-CALLBACK-FAULT");
      expect(record.runs).toHaveLength(1);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });

  test("the packed CLI runtime observation observes the canonical packed executable once", async () => {
    const observation = await systemPackedRuntimeProbe({
      executable: packedCliNodeExecutable(),
      deadlineMs: 10_000,
      signal: undefined,
    });
    expect(observation.kind).toBe("probe");
    if (observation.kind === "probe") {
      expect(observation.executable).toBe(packedCliNodeExecutable());
      expect(observation.version).toMatch(/^v?\d+\./);
    }
  });

  test("the macOS version observation observes the actual product version", async () => {
    const observation = await systemOsVersionProbe({ deadlineMs: 10_000, signal: undefined });
    expect(observation.kind).toBe("observed");
    if (observation.kind === "observed") {
      // One bounded read-only child; the recorded version is what the
      // environment answered, never a runner-label inference.
      expect(observation.version).toMatch(/^\d+([.]\d+)*$/);
    }
  });

  test("an aborted macOS version observation retains its typed child evidence", async () => {
    const controller = new AbortController();
    controller.abort();
    const observation = await systemOsVersionProbe({ deadlineMs: 10_000, signal: controller.signal });
    expect(observation.kind).toBe("unavailable");
    if (observation.kind === "unavailable") {
      expect(observation.cancelled).toBe(true);
      expect(typeof observation.childDurationMs).toBe("number");
      expect(typeof observation.childCleanupDurationMs).toBe("number");
      expect(observation.childCleanupFailed).toBe(false);
    }
  });

  test("a failed runtime observation retains the complete typed child evidence and its output tail", async () => {
    const fake = join(tempDir(), "fake-node");
    try {
      // The child emits a large stdout/stderr tail and exits 3: the observation
      // must retain the complete typed evidence, never a truncated description.
      writeFileSync(
        fake,
        "#!/bin/sh\nprintf '%1500s' x | tr ' ' x\necho TAIL-ROOT-CAUSE\necho \"fatal: injected runtime failure\" >&2\nexit 3\n",
      );
      chmodSync(fake, 0o755);
      const observation = await systemPackedRuntimeProbe({ executable: fake, deadlineMs: 10_000, signal: undefined });
      expect(observation.kind).toBe("unavailable");
      if (observation.kind === "unavailable") {
        expect(observation.cause).toContain("exitCode=3");
        expect(observation.diagnostics).toContain("TAIL-ROOT-CAUSE");
        expect(observation.diagnostics).toContain("--- stderr ---");
        expect(observation.diagnostics).toContain("fatal: injected runtime failure");
        expect(observation.childCleanupFailed).toBe(false);
        expect(typeof observation.childCleanupDurationMs).toBe("number");
        expect(typeof observation.childDurationMs).toBe("number");
        expect(observation.cancelled).toBe(false);
      }
    } finally {
      rmSync(fake, { force: true });
    }
  });
});

describe("canonical command surface", () => {
  const read = (path: string): string => readFileSync(join(repositoryRoot, path), "utf8");
  const manifest = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  test("package scripts route every canonical test command through the supervisor", () => {
    expect(manifest.scripts.test).toBe("bun run test/support/suite-supervisor.ts full");
    expect(manifest.scripts["test:focused"]).toBe(
      "bun run test/support/suite-supervisor.ts focused",
    );
    expect(manifest.scripts["test:stress"]).toBe("bun run test/support/suite-supervisor.ts stress");
    expect(manifest.scripts["test:fleet"]).toBe(
      "bun run test/support/suite-supervisor.ts focused test/fleet-qualification.test.ts",
    );
    for (const script of [
      manifest.scripts.test,
      manifest.scripts["test:focused"],
      manifest.scripts["test:stress"],
      manifest.scripts["test:fleet"],
    ]) {
      // Policy (timeouts, repetition) lives only in the supervisor; the runner is never invoked raw.
      expect(script).not.toContain("bun test");
      expect(script).not.toContain("--timeout");
    }
  });

  test("the canonical budgets are the measured, coherent defaults", async () => {
    const {
      DEFAULT_PER_RUN_DEADLINE_MS,
      DEFAULT_AGGREGATE_DEADLINE_MS,
      DEFAULT_MAX_RUNS,
    } = await import("./support/suite-supervisor.js");
    // Measured default: ~1.6x the 366.3s intended non-fleet corpus duration
    // recorded in the supervisor's rationale; a hung run stays bounded.
    expect(DEFAULT_PER_RUN_DEADLINE_MS).toBe(600_000);
    expect(DEFAULT_MAX_RUNS).toBe(10);
    // Coherent by construction: every sequential default stress run fits
    // inside the aggregate, and the product stays within the timer-safe
    // ceiling so the aggregate can never wrap to a 1ms timer.
    expect(DEFAULT_AGGREGATE_DEADLINE_MS).toBe(DEFAULT_MAX_RUNS * DEFAULT_PER_RUN_DEADLINE_MS);
    expect(DEFAULT_AGGREGATE_DEADLINE_MS).toBeLessThanOrEqual(MAX_BUDGET_MS);
  });

  test("CI, release, runbook, and agent guidance invoke only canonical test commands", () => {
    const ci = parse(read(".github/workflows/ci.yml")) as {
      jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const release = parse(read(".github/workflows/release.yml")) as {
      jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const runbook = read("docs/runbooks/github-release.md");
    const agents = read("AGENTS.md");

    const testSteps = (workflow: { jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }> }) =>
      Object.values(workflow.jobs ?? {})
        .flatMap((job) => job.steps ?? [])
        .filter((step) => step.name === "Run test suite");
    for (const step of [...testSteps(ci), ...testSteps(release)]) {
      expect(step.run).toBe("bun run test");
    }

    for (const [name, source] of [
      ["ci.yml", read(".github/workflows/ci.yml")],
      ["release.yml", read(".github/workflows/release.yml")],
      ["github-release.md", runbook],
      ["AGENTS.md", agents],
    ] as const) {
      // No consumer invokes the runner raw or carries a second timeout value.
      expect(source, name).not.toContain("bun test");
      expect(source, name).not.toContain("--timeout");
    }

    expect(runbook).toContain("bun run test");
    expect(agents).toContain("`bun run test`");
    expect(agents).toContain("`bun run test:focused -- <paths-or-filters>`");
    expect(agents).toContain("`bun run test:fleet`");
    expect(agents).toContain("`bun run test:stress`");
    expect(read(".github/workflows/ci.yml")).toContain("bun run test:fleet");
    expect(read(".github/workflows/release.yml")).toContain("bun run test:fleet");
  });
});
