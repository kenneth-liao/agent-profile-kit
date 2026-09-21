/**
 * Observable PTY synchronization qualification (#542, TEST-004, US-003).
 * Through the real pty-controller and the real prompt dependency:
 *
 * - the named delayed-output condition (the async searchable filter resolving
 *   after input) is induced causally by gating the REAL exported product
 *   filter (`searchableSuggest`) behind a fixture-owned release file outside
 *   the PTY — no timing assumptions, one run per scenario;
 * - premature Enter (sent while the gate is closed, so the filter is
 *   provably unresolved) submits the stale highlight;
 * - observing the actual resolved render before Enter yields the intended
 *   result;
 * - an abrupt abort terminates the executor-owned controller AND the owned
 *   PTY child through the controller's TERM kill+reap lifecycle, with
 *   evidence in the transcript.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runProcess, expectExitCode } from "../process/process-executor.js";

import { startPtySession } from "./support/pty-session.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixturePaths(): { readonly releaseFile: string; readonly pidFile: string } {
  const directory = mkdtempSync(join(tmpdir(), "agent-profile-kit-pty-gate-"));
  temporaryDirectories.push(directory);
  return { releaseFile: join(directory, "release"), pidFile: join(directory, "driver.pid") };
}

/** Wait until a file exists and return its trimmed content. */
async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
    if (Date.now() > deadline) throw new Error(`file never appeared: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Poll until the pid is gone; throws with retained evidence if it survives. */
async function expectPidGone(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) return;
    if (Date.now() > deadline) {
      throw new Error(`${label} (pid ${pid}) still alive after abrupt abort`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("observable PTY synchronization (#542)", () => {
  test("an abrupt abort terminates the controller and the owned PTY child", async () => {
    const { releaseFile, pidFile } = fixturePaths();
    const session = await startPtySession(["gated-select", releaseFile, pidFile], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      const driverPid = Number(await waitForFile(pidFile));
      expect(driverPid).toBeGreaterThan(0);
      expect(session.controllerPid).toBeGreaterThan(0);

      // The gated driver blocks forever (no release file), so termination
      // must come from the cleanup lifecycle, not a natural exit.
      await session.waitForTranscript("Which Profile?");
      const result = await session.terminate();

      expect(result.kind).toBe("cancelled");
      expect(result.cleanupFailed).toBe(false);
      // The repaired controller kills and reaps the owned PTY child on TERM
      // and records the evidence in the transcript.
      const transcript = session.transcript();
      expect(transcript).toContain("PTY-CONTROLLER-TERMINATED");
      await expectPidGone(session.controllerPid, "pty controller");
      await expectPidGone(driverPid, "PTY driver child");
    } finally {
      await session.close();
    }
  });
});

describe("owned-child lifecycle contract (#542 review)", () => {
  test("SIGTERM between kernel reap and ownership publication never signals the reaped PID", async () => {
    const { pidFile } = fixturePaths();
    const result = await runProcess({
      executable: "python3",
      arguments_: [join(import.meta.dir, "support/pty-controller-syscall-probe.py"),
        join(import.meta.dir, "support/pty-controller.py"), pidFile],
      deadlineMs: 2000,
      commandLabel: "PTY injected syscall ownership proof",
    });
    expectExitCode(result, 0);
  });

  test("reaping between PTY chunks still drains the final buffered output", async () => {
    const { pidFile } = fixturePaths();
    const result = await runProcess({
      executable: "python3",
      arguments_: [join(import.meta.dir, "support/pty-controller-drain-probe.py"),
        join(import.meta.dir, "support/pty-controller.py"), pidFile],
      deadlineMs: 2000,
      commandLabel: "PTY injected buffered-output proof",
    });
    expectExitCode(result, 0);
    expect(readFileSync(pidFile, "utf8")).toContain("first chunk\nFINAL buffered chunk\n");
  });

  test("a natural child exit propagates its status with no post-reap signal", async () => {
    const { releaseFile, pidFile } = fixturePaths();
    const session = await startPtySession(["gated-select", releaseFile, pidFile], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      await waitForFile(pidFile);
      await session.waitForTranscript("Which Profile?");
      const before = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("RESULT", { after: before });
      const teardown = await session.close();
      // The controller exits promptly after the child: the drain window is
      // one finite 0.5s pass, never a stall into the 5s abort backstop.
      expect(teardown.kind).toBe("exit");
      expect(teardown.exitCode).toBe(0);
      expect(teardown.durationMs).toBeLessThan(5000);
      const transcript = session.transcript();
      // The child's own outcome is propagated (never a false 0), and the
      // real signal-attempt counter remains zero on the natural path.
      expect(transcript).toContain("PTY-CONTROLLER-EXIT status=0 signals=0");
      expect(transcript).not.toContain("PTY-CONTROLLER-TERMINATED");
      expect(existsSync(releaseFile)).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("close rejects an unexpected normal nonzero driver exit", async () => {
    const session = await startPtySession(["unknown-driver"], 80);
    temporaryDirectories.push(session.runDirectory);
    await expect(session.close()).rejects.toThrow("exitCode=2");
  });

  test("the watchdog is real seconds: bounded child termination with enforced evidence", async () => {
    const { releaseFile, pidFile } = fixturePaths();
    const session = await startPtySession(["gated-select", releaseFile, pidFile], 80, {
      watchdogMs: 2000,
    });
    temporaryDirectories.push(session.runDirectory);
    const startedAt = Date.now();
    const driverPid = Number(await waitForFile(pidFile));
    await session.waitForTranscript("Which Profile?");
    // The blocked child is killed and reaped at the (short) watchdog; the
    // controller records the marker and exits 124 — well under any timeout.
    await session.waitForTranscript("PTY-CONTROLLER-WATCHDOG");
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(2000);
    expect(elapsed).toBeLessThan(8000);
    // Enforced teardown: a watchdog outcome cannot pass qualification.
    let contractError: Error | undefined;
    try {
      await session.close();
    } catch (error) {
      contractError = error as Error;
    }
    expect(contractError).toBeDefined();
    expect(contractError!.message).toContain("exitCode=124");
    expect(contractError!.message).toContain("PTY-CONTROLLER-WATCHDOG");
    await expectPidGone(driverPid, "PTY driver child");
  });

  test("a failed wait stays the primary error when close() also rejects the teardown (#632)", async () => {
    const { releaseFile, pidFile } = fixturePaths();
    const session = await startPtySession(["gated-select", releaseFile, pidFile], 80, {
      watchdogMs: 2000,
    });
    temporaryDirectories.push(session.runDirectory);
    const driverPid = Number(await waitForFile(pidFile));
    await session.waitForTranscript("PTY-CONTROLLER-WATCHDOG");
    // The shape every real-PTY test has: the wait throws in `try`, then
    // close() throws the teardown contract error in `finally`.
    let reported: Error | undefined;
    try {
      try {
        await session.waitForTranscript("fragment-that-never-arrives", { deadlineMs: 200 });
      } finally {
        await session.close();
      }
    } catch (error) {
      reported = error as Error;
    }
    expect(reported).toBeDefined();
    expect(reported!.message).toContain("timed out waiting for PTY fragment: fragment-that-never-arrives");
    // The teardown outcome is carried, not dropped.
    expect(reported!.message).toContain("exitCode=124");
    expect(reported!.message).toContain("expected no watchdog firing");
    expect(reported!.message.indexOf("timed out waiting for PTY fragment"))
      .toBeLessThan(reported!.message.indexOf("teardown contract violated"));
    expect((reported!.cause as Error).message).toContain("teardown contract violated");
    await expectPidGone(driverPid, "PTY driver child");
  });
});

describe("named delayed-output condition — causal discrimination (#542, TEST-004)", () => {
  test("premature Enter with the filter provably unresolved submits the stale highlight", async () => {
    const { releaseFile, pidFile } = fixturePaths();
    const session = await startPtySession(["gated-select", releaseFile, pidFile], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      await waitForFile(pidFile);
      // No input before the active question: wait for the prompt render.
      await session.waitForTranscript("Which Profile?");
      const before = session.transcriptLength();
      session.write("writ");
      await session.waitForTranscript("…writ", { after: before });
      // Enter while the gate stays closed: the filter is causally unresolved
      // (the release file is never created), so the pre-filter highlight
      // submits. No timing assumption — the gate cannot open.
      const enterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("RESULT", { after: enterOffset });
      const text = session.transcript();
      expect(text).toContain('RESULT "coding"');
      expect(existsSync(releaseFile)).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("input sent only after the observed resolved render yields the intended result", async () => {
    const { releaseFile, pidFile } = fixturePaths();
    const session = await startPtySession(["gated-select", releaseFile, pidFile], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      await waitForFile(pidFile);
      // No input before the active question: wait for the prompt render.
      await session.waitForTranscript("Which Profile?");
      const before = session.transcriptLength();
      session.write("writ");
      await session.waitForTranscript("…writ", { after: before });
      // Open the gate, then synchronize on the OBSERVED resolved render
      // (the real dependency's `›writ` reduced-list redraw) before Enter.
      writeFileSync(releaseFile, "release");
      await session.waitForTranscript("›writ", { after: before });
      const enterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("RESULT", { after: enterOffset });
      const text = session.transcript();
      expect(text).toContain('RESULT "writing"');
      expect(text).not.toContain('RESULT "coding"');
    } finally {
      await session.close();
    }
  });
});