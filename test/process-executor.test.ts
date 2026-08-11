import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeProcessResult,
  expectExitCode,
  runProcess,
} from "./support/process-executor.js";

const shell = "sh";

function shFixture(
  script: string,
  options: { readonly deadlineMs?: number; readonly input?: string } = {},
) {
  return runProcess({
    executable: shell,
    arguments_: ["-c", script],
    deadlineMs: options.deadlineMs ?? 2000,
    ...(options.input === undefined ? {} : { input: options.input }),
    commandLabel: "sh fixture",
  });
}

/**
 * Prove a pid is no longer a live process at this instant. The executor only
 * settles cleanup once its group-empty probe passes, so this check must hold
 * immediately on resolution — a post-resolution poll would mask cleanup that
 * finished after `runProcess` returned.
 */
function expectProcessGone(pid: number, label: string): void {
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  expect(alive, `${label} (pid ${pid}) must already be gone when runProcess resolves`).toBe(false);
}

/**
 * Reject a live process while accepting either an absent PID or a terminated
 * process awaiting macOS process-table reaping. The bounded ps invocation is
 * an independent oracle for the executor's process-group cleanup result.
 */
function expectProcessNotLive(pid: number, label: string): void {
  const inspection = spawnSync("ps", ["-o", "state=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
  });
  if (inspection.error !== undefined) {
    throw new Error(`${label} (pid ${pid}) state inspection failed: ${inspection.error.message}`);
  }
  const state = inspection.stdout.trim();
  if (inspection.status === 1 && state === "") return;
  if (inspection.status !== 0) {
    throw new Error(
      `${label} (pid ${pid}) state inspection exited ${String(inspection.status)}: ${inspection.stderr.trim()}`,
    );
  }
  if (!state.startsWith("Z")) {
    throw new Error(`${label} (pid ${pid}) is still live (state ${state || "unknown"})`);
  }
}

describe("runProcess result contract", () => {
  test("process-state cleanup verification rejects a genuinely live process", () => {
    expect(() => expectProcessNotLive(process.pid, "current test process")).toThrow(/still live/);
  });

  test("normal exit reports exitCode, output, and elapsed duration", async () => {
    const result = await shFixture('printf "out"; printf "err" >&2; exit 0');
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(0);
    }
    expect(result.signal).toBeNull();
    expect(result.error).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.commandLabel).toBe("sh fixture");
  });

  test("nonzero exit is represented distinctly", async () => {
    const result = await shFixture("exit 3");
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(3);
    }
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test("signal termination reports the signal instead of a bare null status", async () => {
    const result = await shFixture("kill -TERM $$");
    expect(result.kind).toBe("signal");
    if (result.kind === "signal") {
      expect(result.signal).toBe("SIGTERM");
    }
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test("spawn failure reports the underlying error", async () => {
    const result = await runProcess({
      executable: "/nonexistent/agent-profile-kit-fixture",
      arguments_: [],
      deadlineMs: 2000,
    });
    expect(result.kind).toBe("spawn-error");
    if (result.kind === "spawn-error") {
      expect(result.error.message).toMatch(/ENOENT|no such file/i);
    }
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test("input is delivered on stdin and EOF terminates a reader", async () => {
    const result = await shFixture("cat", { input: "hello stdin\n" });
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(0);
    }
    expect(result.stdout).toBe("hello stdin\n");
  });

  test("a stalled child is terminated at its deadline plus a short grace", async () => {
    const started = Date.now();
    const result = await shFixture("sleep 30", { deadlineMs: 300 });
    const elapsedMs = Date.now() - started;
    expect(result.kind).toBe("timeout");
    expect(result.timedOut).toBe(true);
    expect(result.cleanupFailed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(elapsedMs).toBeLessThan(5000);
  });

  test("timeout kills the whole process group including descendants", async () => {
    const result = await shFixture("sleep 30 & echo child=$!; wait", { deadlineMs: 300 });
    expect(result.kind).toBe("timeout");
    expect(result.cleanupFailed).toBe(false);
    const match = /child=(\d+)/.exec(result.stdout);
    expect(match?.[1]).toBeTruthy();
    expectProcessGone(Number(match![1]), "descendant sleep");
  });

  test("abort cancels the child and cleans up its process group", async () => {
    const controller = new AbortController();
    const resultPromise = runProcess(
      {
        executable: shell,
        arguments_: ["-c", "sleep 30"],
        deadlineMs: 10000,
        commandLabel: "abort fixture",
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 150);
    const result = await resultPromise;
    expect(result.kind).toBe("cancelled");
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.cleanupFailed).toBe(false);
    expect(result.exitCode).toBeNull();
  });

  test("cancellation just before the deadline wins over the deadline", async () => {
    // The child ignores SIGTERM, so cleanup must escalate to SIGKILL and the
    // deadline fires while that cleanup is still running. The first terminal
    // cause (cancellation at ~100ms) must own the result label, not the later
    // deadline: with cleanup grace 250ms the leader only closes after SIGKILL
    // at ~350ms, well past the 300ms deadline.
    const controller = new AbortController();
    const resultPromise = runProcess(
      {
        executable: shell,
        arguments_: ["-c", "trap '' TERM; sleep 30"],
        deadlineMs: 300,
        cleanupGraceMs: 250,
        commandLabel: "cancel-race fixture",
      },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    const result = await resultPromise;
    expect(result.kind).toBe("cancelled");
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.cleanupFailed).toBe(false);
  });

  test("timeout cleanup kills a TERM-resistant descendant that closed inherited pipes", async () => {
    // Leader and descendant are real Node processes: the leader dies on
    // SIGTERM (so its `close` fires) while the descendant ignores SIGTERM and
    // closed its inherited stdio copies. Resolving on the leader's close alone
    // would leak the descendant; the executor must probe the process group and
    // escalate to SIGKILL before settling.
    const fixtureDir = mkdtempSync(join(tmpdir(), "agent-profile-kit-executor-fixture-"));
    try {
      const descendant = join(fixtureDir, "descendant.mjs");
      const leader = join(fixtureDir, "leader.mjs");
      writeFileSync(
        descendant,
        'process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\n',
      );
      writeFileSync(
        leader,
        `import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const descendant = spawn(process.execPath, [fileURLToPath(new URL("./descendant.mjs", import.meta.url))], {
  stdio: "ignore",
});
console.log("child=" + descendant.pid);
setInterval(() => {}, 1000);
`,
      );
      const result = await runProcess({
        executable: process.execPath,
        arguments_: [leader],
        deadlineMs: 300,
        cleanupGraceMs: 100,
        commandLabel: "TERM-resistant descendant fixture",
      });
      expect(result.kind).toBe("timeout");
      // The executor's group-empty probe owns the cleanup result, while the
      // process-state query independently proves that the named descendant is
      // absent or terminated. Unlike kill(pid, 0), it does not misclassify a
      // terminated orphan awaiting macOS process-table reaping as a live leak.
      expect(result.cleanupFailed).toBe(false);
      const match = /child=(\d+)/.exec(result.stdout);
      expect(match?.[1]).toBeTruthy();
      expectProcessNotLive(Number(match![1]), "TERM-resistant descendant");
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("a macOS script PTY command completes through the executor with captured output", async () => {
    const result = await runProcess({
      executable: "script",
      arguments_: ["-q", "/dev/null", "sh", "-c", "echo pty-hello"],
      deadlineMs: 4000,
      commandLabel: "PTY fixture",
    });
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") {
      expect(result.exitCode).toBe(0);
    }
    expect(result.stdout).toContain("pty-hello");
  });

  test("a stalled PTY command and its descendant are terminated within the bounded lifecycle", async () => {
    const result = await runProcess({
      executable: "script",
      arguments_: ["-q", "/dev/null", "sh", "-c", "sleep 30 & echo pty-child=$!; wait"],
      deadlineMs: 300,
      commandLabel: "stalled PTY fixture",
    });
    expect(result.kind).toBe("timeout");
    expect(result.cleanupFailed).toBe(false);
    const match = /pty-child=(\d+)/.exec(result.stdout);
    expect(match?.[1]).toBeTruthy();
    expectProcessGone(Number(match![1]), "PTY descendant sleep");
  });

  test("an invalid deadline is rejected at the boundary", async () => {
    await expect(
      runProcess({ executable: shell, arguments_: ["-c", "true"], deadlineMs: 0 }),
    ).rejects.toThrow(/deadline/);
  });
});

describe("process diagnostics", () => {
  test("describeProcessResult exposes every available evidence field", async () => {
    const timeout = await shFixture("sleep 30", { deadlineMs: 200 });
    const text = describeProcessResult(timeout);
    expect(text).toContain("kind=timeout");
    expect(text).toContain("timedOut");
    expect(text).toContain("stdout=");
    expect(text).toContain("stderr=");
    expect(text).toContain("durationMs=");
    expect(text).toContain("command=sh fixture");
  });

  test("expectExitCode passes on a matching exit and fails with diagnostics otherwise", async () => {
    const ok = await shFixture("exit 0");
    expectExitCode(ok, 0);

    const nonzero = await shFixture("exit 3");
    expect(() => expectExitCode(nonzero, 0, "fixture")).toThrow(/expected exit code 0/);

    const signal = await shFixture("kill -TERM $$");
    expect(() => expectExitCode(signal, 0, "fixture")).toThrow(/signal=SIGTERM/);

    const timeout = await shFixture("sleep 30", { deadlineMs: 150 });
    expect(() => expectExitCode(timeout, 0, "fixture")).toThrow(/kind=timeout|timedOut/);
  });
});
