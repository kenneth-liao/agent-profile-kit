import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { runProcess } from "./support/process-executor.js";
import {
  PER_TEST_TIMEOUT_MS,
  formatSuiteSummary,
  runSupervisedSuite,
  type SuiteMode,
} from "./support/suite-supervisor.js";

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

  test("keeps fleet-scale regressions out of the fast suite", async () => {
    const logDir = tempDir();
    try {
      const result = await runSupervisedSuite({
        mode: "full",
        suiteCommand: shFixture('printf "%s\n" "$@"', "argv fixture"),
        perRunDeadlineMs: 2000,
        logDir,
      });
      expect(result.ok).toBe(true);
      const argv = result.runs[0]!.result.stdout.trim().split("\n");
      expect(argv).toContain("--path-ignore-patterns");
      const patternIndex = argv.indexOf("--path-ignore-patterns");
      expect(argv[patternIndex + 1]).toBe("test/fleet-qualification.test.ts");
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
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
      // The supervisor owns the per-test timeout policy; user arguments follow untouched.
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

  test("the canonical budgets match the accepted five-minute, 25-minute, and ten-run contract", async () => {
    const {
      DEFAULT_PER_RUN_DEADLINE_MS,
      DEFAULT_AGGREGATE_DEADLINE_MS,
      DEFAULT_MAX_RUNS,
    } = await import("./support/suite-supervisor.js");
    expect(DEFAULT_PER_RUN_DEADLINE_MS).toBe(300_000);
    expect(DEFAULT_AGGREGATE_DEADLINE_MS).toBe(1_500_000);
    expect(DEFAULT_MAX_RUNS).toBe(10);
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
