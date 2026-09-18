/**
 * Real-PTY qualification for the interactive Workspace setup flow (ticket
 * #603, TEST-002, TEST-003 TTY rows). The injectable-stream tests
 * (`test/init-command.test.ts`) prove the flow's decisions and write
 * behavior; these tests prove keyboard behavior (y/n answers, cancel) and
 * 100/60-column rendering through a genuine pseudo-terminal allocated by
 * `test/support/pty-controller.py` (pty.fork).
 *
 * Synchronization rule (#542): input is sent only after the required prompt
 * state is OBSERVED — the transcript offset is captured immediately before
 * each triggering write, and each wait matches only content appended after
 * it. The confirmation must be observed before accepting, so a stale render
 * can never consume an answer.
 *
 * Rendering the setup screens for principal review (#610): the same harness
 * renders them interactively —
 *
 *     python3 test/support/pty-controller.py /tmp/init-transcript.log 100 30 \
 *       bun test/support/searchable-pty-driver.ts init <home> <cwd>
 *
 * The transcript log then holds the location question and confirmation
 * screens exactly as rendered at the given column width (60 for the narrow
 * pass). The driver modes: `init <home> <cwd>` (no path: the location
 * question) and `init <home> <cwd> <path...>` (confirmation only).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { plain, startPtySession, squash } from "./support/pty-session.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-init-pty-home-"));
  temporaryDirectories.push(home);
  return home;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

/** A long current folder under the isolated home, so its display spelling
 * is a long home-relative path (`~/projects/<long name>`, ISC-24.2). */
function longCurrentFolder(home: string): string {
  const cwd = join(home, "projects", "a-very-long-workspace-folder-name-for-the-confirmation-screens");
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function displaySpelling(cwd: string, home: string): string {
  return `~/${cwd.slice(home.length + 1)}`;
}

/** The current-folder flow: choose the current folder and confirm (y, y). */
async function acceptCurrentFolder(
  columns: number,
): Promise<{ readonly home: string; readonly cwd: string; readonly transcript: string }> {
  const home = isolatedHome();
  const cwd = longCurrentFolder(home);
  const session = await startPtySession(["init", home, cwd], columns);
  temporaryDirectories.push(session.runDirectory);
  try {
    await session.waitForTranscript("Current folder:");
    expect(squash(session.transcript())).toContain(squash(displaySpelling(cwd, home)));
    const chooseOffset = session.transcriptLength();
    session.write("y");
    await session.waitForTranscript("stored in and loaded from", { after: chooseOffset });
    const confirmOffset = session.transcriptLength();
    session.write("y");
    await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    return { home, cwd, transcript: session.transcript() };
  } finally {
    await session.close();
  }
}

describe("interactive Workspace setup under a real PTY (#603, TEST-002)", () => {
  test("accepting the current folder at 100 columns initializes at the confirmed folder", async () => {
    const { home, cwd, transcript } = await acceptCurrentFolder(100);

    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(true);
    for (const directory of ["context", "skills", "profiles"]) {
      expect(existsSync(join(cwd, directory))).toBe(true);
    }
    // The full path is shown in both screens and the receipt — the resolved
    // absolute folder is recorded (ISC-26) and displayed home-relative
    // (ISC-24.2), never elided.
    const spelling = displaySpelling(cwd, home);
    expect(squash(transcript)).toContain(squash(`Current folder: ${spelling}`));
    expect(squash(transcript)).toContain(squash(`stored in and loaded from ${spelling}.`));
    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${cwd}`);
  }, 120_000);

  test("the confirmation renders the full long home-relative path at 60 columns", async () => {
    const { home, cwd, transcript } = await acceptCurrentFolder(60);

    const spelling = displaySpelling(cwd, home);
    // No eliding: the full path — every segment — survives at the narrow
    // width (the `…` the prompt dependency draws beside an answered question
    // is not path eliding).
    expect(squash(transcript)).toContain(squash(`Current folder: ${spelling}`));
    expect(squash(transcript)).toContain(squash(`stored in and loaded from ${spelling}.`));
    expect(transcript).not.toMatch(new RegExp(`${spelling.slice(0, 20)}…`));
  }, 120_000);

  test("declining the confirmation at 60 columns writes nothing and exits neutrally", async () => {
    const home = isolatedHome();
    const cwd = longCurrentFolder(home);
    writeFileSync(join(cwd, "notes.txt"), "user material\n");
    const session = await startPtySession(["init", home, cwd], 60, { expectedExitCode: 0 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Current folder:");
      const chooseOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("stored in and loaded from", { after: chooseOffset });
      const confirmOffset = session.transcriptLength();
      session.write("n");
      const { text } = await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
      expect(plain(text)).toContain("Setup declined; nothing was initialized or created");
    } finally {
      await session.close();
    }

    // Declining adds nothing: the file tree and Local Configuration match
    // the starting state (ISC-27.3, ISC-24.1).
    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(false);
    expect(existsSync(configPath(home))).toBe(false);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("user material\n");
  }, 120_000);

  test("Ctrl-C at the confirmation cancels with nothing written", async () => {
    const home = isolatedHome();
    const cwd = longCurrentFolder(home);
    const session = await startPtySession(["init", home, cwd], 100, { expectedExitCode: 1 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Current folder:");
      const chooseOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("Set up this folder as your Workspace?", { after: chooseOffset });
      const cancelOffset = session.transcriptLength();
      session.write("\x03");
      const { text } = await session.waitForTranscript("RESULTexitCode=1", { after: cancelOffset });
      expect(plain(text)).toContain("init was cancelled; nothing was initialized or created");
    } finally {
      await session.close();
    }

    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(false);
    expect(existsSync(configPath(home))).toBe(false);
  }, 120_000);

  test("init <path> under a PTY confirms the given path without the location question", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome();
    const workspace = join(cwd, "named-folder");
    const session = await startPtySession(["init", home, cwd, workspace], 100);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("stored in and loaded from");
      // The location question never appears: the path was given.
      expect(session.transcript()).not.toContain("Use the current folder as your Workspace?");
      // The typed (missing) folder is created by setup, as the confirmation
      // states.
      expect(plain(session.transcript())).toContain("The folder does not exist yet; setup will create it.");
      const confirmOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    } finally {
      await session.close();
    }

    expect(existsSync(join(workspace, "workspace.yaml"))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain("workspace: ");
  }, 120_000);
});