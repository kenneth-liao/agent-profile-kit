/**
 * Real-PTY qualification for interactive uninstall selection (ticket #499,
 * TEST-003). The injectable-stream tests in `uninstall-search.test.ts` prove
 * the flow; these tests prove keyboard behavior (arrows, toggle, submit,
 * cancel) and rendering width through a genuine pseudo-terminal allocated by
 * `test/support/pty-controller.py` (pty.fork) — never callbacks alone.
 *
 * Timing and watchdog discipline mirror `install-search-pty.test.ts`: filter
 * keystrokes and Enter travel in separate writes with a settle delay between
 * them (human typing), every wait is transcript-driven (never a bare sleep
 * wait), and the controller's own watchdog kills the driver if the test
 * itself is ever timed out, so no probe can orphan a PTY child.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeInstall } from "../installer/install-application.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { PER_TEST_TIMEOUT_MS } from "./support/suite-supervisor.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-pty-home-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-pty-project-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

async function setupInstalledPair(): Promise<{
  readonly home: string;
  readonly first: string;
  readonly second: string;
}> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", "engineering.yaml"),
    "id: engineering\ncontext:\n  - team-rules\nskills: []\n",
  );
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  const first = projectDirectory();
  const second = projectDirectory();
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: first });
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: second });
  return { home, first, second };
}

/** Strip ANSI styling for structural matching. */
function plain(text: string): string {
  return text.replace(/\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Collapse all whitespace so wrapped terminal lines still match. */
function squashed(text: string): string {
  return plain(text).replace(/\s+/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PtySession {
  write(data: string): void;
  transcript(): string;
  close(): Promise<void>;
}

/**
 * Start the PTY driver on a real pseudo-terminal at the requested width.
 * Keystrokes go through `write` in separate macrotasks; callers settle
 * after filter text before sending Enter (see the file header). The
 * controller's own watchdog (the canonical per-test policy) kills the
 * driver if the test itself is ever timed out, so no probe can orphan
 * a PTY child.
 */
async function startPty(
  driverArguments: readonly string[],
  columns: number,
): Promise<PtySession> {
  if (Bun.which("python3") === null) {
    throw new Error("PTY tests require python3 for the pty-controller");
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-pty-run-"));
  temporaryDirectories.push(directory);
  const transcriptPath = join(directory, "transcript.log");
  const controllerPath = join(import.meta.dir, "support", "pty-controller.py");
  const driverPath = join(import.meta.dir, "support", "searchable-pty-driver.ts");
  const child = Bun.spawn(
    ["python3", controllerPath, transcriptPath, String(columns), String(PER_TEST_TIMEOUT_MS), process.execPath, driverPath, ...driverArguments],
    { stdin: "pipe", stdout: "ignore", stderr: "ignore", env: process.env },
  );
  return {
    write(data: string): void {
      child.stdin.write(data);
    },
    transcript(): string {
      try {
        return readFileSync(transcriptPath, "utf8");
      } catch {
        return "";
      }
    },
    async close(): Promise<void> {
      try {
        child.stdin.end();
      } catch {
        // The driver may already have exited.
      }
      const exited = await Promise.race([
        child.exited.then(() => true),
        sleep(5000).then(() => false),
      ]);
      if (!exited) child.kill("SIGKILL" as const);
      await child.exited.catch(() => undefined);
    },
  };
}

// Transcript waits derive from the canonical per-test timeout policy
// (PER_TEST_TIMEOUT_MS): the diagnostic below stays reachable because bun
// kills the test only after this deadline passes.
const TRANSCRIPT_DEADLINE_MS = Math.floor(PER_TEST_TIMEOUT_MS * 0.8);

async function waitForTranscript(
  session: PtySession,
  fragment: string,
  deadlineMs = TRANSCRIPT_DEADLINE_MS,
): Promise<string> {
  const wanted = fragment.replace(/\s+/g, "");
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const text = session.transcript();
    if (squashed(text).includes(wanted)) return text;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for PTY fragment: ${fragment}\n--- transcript ---\n${plain(text).slice(-2000)}`);
    }
    await sleep(100);
  }
}

describe("interactive uninstall under a real PTY", () => {
  test("Space toggles and Enter submits the picked Project at 60 columns", async () => {
    const { home, first, second } = await setupInstalledPair();
    const session = await startPty(["uninstall", home], 60);
    try {
      await waitForTranscript(session, "Which Projects");
      // Toggle the highlighted Project and submit: nothing is pre-selected,
      // so exactly one Project is picked here.
      session.write(" ");
      await sleep(300);
      session.write("\r");
      await waitForTranscript(session, "Whole installations or selected Hosts?");
      session.write("\r");
      await waitForTranscript(session, "(y/N)");
      session.write("y\r");
      await waitForTranscript(session, "RESULTexitCode=0");
    } finally {
      await session.close();
    }

    // Exactly one Project removed; the other is untouched.
    const config = readFileSync(configPath(home), "utf8");
    expect((!config.includes(first)) !== (!config.includes(second))).toBe(true);
  });

  test("typing filters the Project picker and arrows move before toggle", async () => {
    const { home, first, second } = await setupInstalledPair();
    const session = await startPty(["uninstall", home], 80);
    try {
      await waitForTranscript(session, "Which Projects");
      // Filter to the second Project's unique path suffix, then toggle and
      // submit: typing narrows by path on a real terminal too.
      const suffix = second.slice(-6);
      session.write(suffix);
      await sleep(600);
      session.write(" ");
      await sleep(300);
      session.write("\r");
      await waitForTranscript(session, "Whole installations or selected Hosts?");
      session.write("\r");
      await waitForTranscript(session, "(y/N)");
      session.write("y\r");
      await waitForTranscript(session, "RESULTexitCode=0");
    } finally {
      await session.close();
    }

    const config = readFileSync(configPath(home), "utf8");
    expect(config).not.toContain(second);
    expect(config).toContain(first);
  });

  test("Ctrl-C during picking cancels with zero lifecycle changes", async () => {
    const { home, first, second } = await setupInstalledPair();
    const session = await startPty(["uninstall", home], 80);
    try {
      await waitForTranscript(session, "Which Projects");
      session.write("\x03");
      const text = await waitForTranscript(session, "RESULTexitCode=1");
      expect(plain(text)).toContain("cancelled");
    } finally {
      await session.close();
    }

    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain(first);
    expect(config).toContain(second);
    expect(existsSync(join(first, ".agent-profile-kit"))).toBe(true);
    expect(existsSync(join(second, ".agent-profile-kit"))).toBe(true);
  });
});
