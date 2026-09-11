/**
 * Real-PTY qualification for searchable install choices (ticket #495,
 * TEST-003). The injectable-stream tests prove the flow; these tests prove
 * keyboard behavior (typing, arrows, toggle, submit, cancel) and rendering
 * width through a genuine pseudo-terminal allocated by
 * `test/support/pty-controller.py` (pty.fork) — never callbacks alone.
 *
 * Key timing rule: filter keystrokes and Enter travel in separate writes
 * with a settle delay between them, matching human typing. The underlying
 * single-select filter resolves asynchronously, so pasting filter text and
 * Enter in one chunk can submit the pre-filter highlight; that upstream
 * type-ahead race is out of scope for this seam.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { PER_TEST_TIMEOUT_MS } from "./support/suite-supervisor.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-pty-home-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-pty-project-"));
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

async function setupHome(profile = "coding"): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", `${profile}.yaml`),
    `id: ${profile}\ncontext:\n  - team-rules\nskills: []\n`,
  );
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  return home;
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
 * controller's own watchdog (30s) kills the driver if the test itself is
 * ever timed out, so no probe can orphan a PTY child.
 */
async function startPty(
  driverArguments: readonly string[],
  columns: number,
): Promise<PtySession> {
  if (Bun.which("python3") === null) {
    throw new Error("PTY tests require python3 for the pty-controller");
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-pty-run-"));
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

describe("searchable prompts under a real PTY", () => {
  test("typing filters the single choice and Enter selects the match", async () => {
    const session = await startPty(["select"], 80);
    try {
      await waitForTranscript(session, "Which Profile?");
      session.write("writ");
      // Settle so the async filter applies before Enter (human timing).
      await sleep(600);
      session.write("\r");
      const text = await waitForTranscript(session, '"value":"writing"');
      expect(squashed(text)).toContain('"value":"writing"');
    } finally {
      await session.close();
    }
  });

  test("arrow navigation with Space toggles and Enter submits the multi choice", async () => {
    const session = await startPty(["multi"], 80);
    try {
      await waitForTranscript(session, "Which Agent Hosts?");
      session.write("\x1b[B");
      await sleep(250);
      session.write("\x1b[B");
      await sleep(250);
      session.write(" ");
      await sleep(300);
      session.write("\r");
      const text = await waitForTranscript(session, '"values":["pi"]');
      expect(squashed(text)).toContain('"values":["pi"]');
    } finally {
      await session.close();
    }
  });
  test("arrow navigation highlights and Enter selects the single choice", async () => {
    const session = await startPty(["select"], 80);
    try {
      await waitForTranscript(session, "Which Profile?");
      session.write("\x1b[B");
      await sleep(400);
      session.write("\r");
      const text = await waitForTranscript(session, '"value":"ops"');
      expect(squashed(text)).toContain('"value":"ops"');
    } finally {
      await session.close();
    }
  });
});

describe("guided install under a real PTY", () => {
  test("a bare install at 60 columns names the target and installs the picked selection", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const session = await startPty(["install", home, projectPath], 60);
    try {
      // The bare install names its current-directory Project target first,
      // even wrapped at 60 columns.
      const target = await waitForTranscript(session, projectPath);
      expect(squashed(target)).toContain(projectPath.replace(/\s+/g, ""));
      await waitForTranscript(session, "Which Profile?");
      session.write("cod");
      await sleep(600);
      session.write("\r");
      await waitForTranscript(session, "Which Agent Hosts?");
      session.write("codex");
      await sleep(600);
      session.write(" ");
      await sleep(300);
      session.write("\r");
      await waitForTranscript(session, "(y/N)");
      session.write("y\r");
      await waitForTranscript(session, "RESULTexitCode=0");
    } finally {
      await session.close();
    }

    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("profile: coding");
    expect(config).toContain("- codex");
    expect(readFileSync(
      join(projectPath, ".agent-profile-kit", "codex", "context.md"),
      "utf8",
    )).toContain("Always preserve the project boundary.");
  });

  test("Ctrl-C during picking cancels with zero lifecycle changes", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const session = await startPty(["install", home, projectPath], 80);
    try {
      await waitForTranscript(session, "Which Profile?");
      session.write("\x03");
      const text = await waitForTranscript(session, "RESULTexitCode=1");
      expect(plain(text)).toContain("cancelled");
    } finally {
      await session.close();
    }

    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });
});
