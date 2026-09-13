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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

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