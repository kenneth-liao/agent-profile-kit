/**
 * Real-PTY qualification for configure membership choices (ticket #500,
 * TEST-003). The injectable-stream tests prove the flow; this test proves
 * keyboard behavior (typing, toggle, submit) and rendering width through a
 * genuine pseudo-terminal allocated by `test/support/pty-controller.py`
 * (pty.fork) — never callbacks alone. In particular it proves the
 * preselected-across-filter behavior in this instantiation: a selected
 * member filtered out of view stays selected on submit.
 *
 * Key timing rule: filter keystrokes and Enter travel in separate writes
 * with a settle delay between them, matching human typing (see
 * install-search-pty.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContextModule } from "../installer/create-context-module.js";
import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { PER_TEST_TIMEOUT_MS } from "./support/suite-supervisor.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-configure-pty-home-"));
  temporaryDirectories.push(home);
  return home;
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

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  await createContextModule({ home, name: "team-rules" });
  await createContextModule({ home, name: "extra-rules" });
  await createSkill({ home, name: "review-pr" });
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills: []\n",
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
  const directory = mkdtempSync(join(tmpdir(), "agent-profile-kit-configure-pty-run-"));
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

describe("interactive configure under a real PTY", () => {
  test("filtered pickers keep preselected membership and keyboard submit saves", async () => {
    const home = await setupHome();
    const session = await startPty(["configure", home, "coding"], 80);
    try {
      // Current membership is shown before the pickers open.
      await waitForTranscript(session, "Current membership of reusable Profile 'coding'");
      // Filter the Context picker so the selected member leaves the view,
      // then submit with Enter: the hidden selection persists.
      await waitForTranscript(session, "Which Context Modules?");
      session.write("extra");
      await sleep(600);
      session.write("\r");
      // Skills picker: filter, Space toggles the match on, Enter submits.
      await waitForTranscript(session, "Which Skills?");
      session.write("review");
      await sleep(600);
      session.write(" ");
      await sleep(300);
      session.write("\r");
      // The pre-save statement names the reusable Profile; confirm.
      await waitForTranscript(session, "Reusable Profile 'coding'");
      await waitForTranscript(session, "(y/N)");
      session.write("y\r");
      await waitForTranscript(session, "RESULT exitCode=0");
    } finally {
      await session.close();
    }

    const profile = readFileSync(join(workspacePath(home), "profiles", "coding.yaml"), "utf8");
    // The hidden preselected member survived filtering; typing the filter
    // never selected the visible-but-untoggled match.
    expect(profile).toContain("team-rules");
    expect(profile).not.toContain("extra-rules");
    expect(profile).toContain("review-pr");
    const text = squashed(session.transcript());
    expect(text).toContain("apkitconfigureprofilecoding");
    expect(text).toContain("apkitupdate");
  });
});
