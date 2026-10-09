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
 * it. The required state for a keystroke is the question prompt itself, not
 * a document fragment that renders before it: a keystroke written while the
 * tty is still canonical (before the prompt enables raw mode) is echoed but
 * held in the line buffer and never delivered to the prompt (PR #622
 * INT-FLAKE-1), so every answer waits for its question text first.
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
import { WORKSPACE_MANIFEST } from "../schemas/workspace-manifest.js";

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
    // Each keystroke is gated on its own question prompt being OBSERVED, per
    // the offset-sync contract — never on a document fragment that precedes
    // the prompt: a keystroke written while the tty is still canonical is
    // echoed but never delivered when the prompt switches to raw mode (the
    // PTY-CONTROLLER-WATCHDOG flake root cause, PR #622 INT-FLAKE-1).
    await session.waitForTranscript("Use the current folder as your Workspace?");
    const chooseOffset = session.transcriptLength();
    session.write("y");
    await session.waitForTranscript("stored in and loaded from", { after: chooseOffset });
    await session.waitForTranscript("Set up this folder as your Workspace?", { after: chooseOffset });
    const confirmOffset = session.transcriptLength();
    session.write("y");
    await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    // US-001, DEC-002 (#699): every live question sits one blank line below
    // the text before it — the location question after `Current folder: …`
    // and the confirmation after its bullet list — at every column width,
    // and the blank is never doubled.
    const screen = plain(session.transcript()).replace(/\r/g, "");
    expect(screen).toContain("\n\n❯ Use the current folder as your Workspace?");
    expect(screen).toContain("- profiles/\n\n❯ Set up this folder as your Workspace?");
    expect(screen).not.toContain("\n\n\n❯");
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
  });

  test("the confirmation renders the full long home-relative path at 60 columns", async () => {
    const { home, cwd, transcript } = await acceptCurrentFolder(60);

    const spelling = displaySpelling(cwd, home);
    // No eliding: the full path — every segment — survives at the narrow
    // width (the `…` the prompt dependency draws beside an answered question
    // is not path eliding).
    expect(squash(transcript)).toContain(squash(`Current folder: ${spelling}`));
    expect(squash(transcript)).toContain(squash(`stored in and loaded from ${spelling}.`));
    expect(transcript).not.toMatch(new RegExp(`${spelling.slice(0, 20)}…`));
  });

  test("a long absolute path outside any home appears in full at 60 columns", async () => {
    const home = isolatedHome();
    // Outside the fixture home, so the display spelling is the long
    // absolute path itself (ISC-24.2 names both shapes).
    const outside = mkdtempSync(join(tmpdir(), "agent-profile-kit-init-pty-absolute-"));
    temporaryDirectories.push(outside);
    const cwd = join(outside, "another-very-long-workspace-folder-name-for-the-narrow-column-check");
    mkdirSync(cwd, { recursive: true });
    const session = await startPtySession(["init", home, cwd], 60);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Current folder:");
      expect(squash(session.transcript())).toContain(squash(`Current folder: ${cwd}`));
      await session.waitForTranscript("Use the current folder as your Workspace?");
      const chooseOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("stored in and loaded from", { after: chooseOffset });
      expect(squash(session.transcript())).toContain(squash(`stored in and loaded from ${cwd}.`));
      await session.waitForTranscript("Set up this folder as your Workspace?", { after: chooseOffset });
      const confirmOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    } finally {
      await session.close();
    }
    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${cwd}`);
  });

  test("declining the confirmation at 60 columns writes nothing and exits neutrally", async () => {
    const home = isolatedHome();
    const cwd = longCurrentFolder(home);
    writeFileSync(join(cwd, "notes.txt"), "user material\n");
    const session = await startPtySession(["init", home, cwd], 60, { expectedExitCode: 0 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Use the current folder as your Workspace?");
      const chooseOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("Set up this folder as your Workspace?", { after: chooseOffset });
      const confirmOffset = session.transcriptLength();
      session.write("n");
      const { text } = await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
      expect(plain(text)).toContain("Cancelled. Nothing was changed.");
    } finally {
      await session.close();
    }

    // Declining adds nothing: the file tree and Local Configuration match
    // the starting state (ISC-27.3, ISC-24.1).
    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(false);
    expect(existsSync(configPath(home))).toBe(false);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("user material\n");
  });

  test("Ctrl-C at the confirmation cancels with nothing written", async () => {
    const home = isolatedHome();
    const cwd = longCurrentFolder(home);
    const session = await startPtySession(["init", home, cwd], 100, { expectedExitCode: 1 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Use the current folder as your Workspace?");
      const chooseOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("Set up this folder as your Workspace?", { after: chooseOffset });
      const cancelOffset = session.transcriptLength();
      session.write("\x03");
      const { text } = await session.waitForTranscript("RESULTexitCode=1", { after: cancelOffset });
      expect(plain(text)).toContain("Cancelled. Nothing was changed.");
    } finally {
      await session.close();
    }

    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(false);
    expect(existsSync(configPath(home))).toBe(false);
  });

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
      expect(plain(session.transcript())).toContain("This folder doesn't exist yet. Setup will create it and add:");
      await session.waitForTranscript("Set up this folder as your Workspace?");
      const confirmOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    } finally {
      await session.close();
    }

    expect(existsSync(join(workspace, "workspace.yaml"))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain("workspace: ");
  });

  test("connecting a different Workspace shows current and requested Workspace at 100 columns and connects on confirm (#607)", async () => {
    const home = isolatedHome();
    const wsA = join(home, "first-workspace");
    const wsB = join(home, "second-workspace");
    const writeWorkspace = (ws: string) => {
      mkdirSync(join(ws, "context"), { recursive: true });
      mkdirSync(join(ws, "skills", "test-skill"), { recursive: true });
      mkdirSync(join(ws, "profiles"), { recursive: true });
      writeFileSync(join(ws, "workspace.yaml"), WORKSPACE_MANIFEST);
      writeFileSync(join(ws, "context", "team-rules.md"), "Team rules.\n");
      writeFileSync(
        join(ws, "profiles", "coding.yaml"),
        "context:\n  - team-rules\nskills:\n  - test-skill\n",
      );
      writeFileSync(
        join(ws, "skills", "test-skill", "SKILL.md"),
        '---\nname: "test-skill"\ndescription: Test skill.\n---\n\n# test-skill\n',
      );
    };
    writeWorkspace(wsA);
    writeWorkspace(wsB);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${wsA}\nbindings: []\n`);

    const session = await startPtySession(["init", home, home, wsB], 100);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Current Workspace:");
      expect(plain(session.transcript())).toContain("Current Workspace: ~/first-workspace");
      expect(plain(session.transcript())).toContain("Requested Workspace: ~/second-workspace");
      await session.waitForTranscript("Use this folder as your Workspace?");
      // One blank line before the live question (#699), never two.
      expect(plain(session.transcript()).replace(/\r/g, ""))
        .toContain("\n\n❯ Use this folder as your Workspace?");
      expect(plain(session.transcript()).replace(/\r/g, "")).not.toContain("\n\n\n❯");
      const confirmOffset = session.transcriptLength();
      session.write("y");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    } finally {
      await session.close();
    }

    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${wsB}`);
  });

  test("declining to connect a different Workspace at 60 columns changes nothing and preserves current selection (#607)", async () => {
    const home = isolatedHome();
    const wsA = join(home, "current-long-named-workspace-folder");
    const wsB = join(home, "requested-long-named-workspace-folder");
    const writeWorkspace = (ws: string) => {
      mkdirSync(join(ws, "context"), { recursive: true });
      mkdirSync(join(ws, "skills", "test-skill"), { recursive: true });
      mkdirSync(join(ws, "profiles"), { recursive: true });
      writeFileSync(join(ws, "workspace.yaml"), WORKSPACE_MANIFEST);
      writeFileSync(join(ws, "context", "team-rules.md"), "Team rules.\n");
      writeFileSync(
        join(ws, "profiles", "coding.yaml"),
        "context:\n  - team-rules\nskills:\n  - test-skill\n",
      );
      writeFileSync(
        join(ws, "skills", "test-skill", "SKILL.md"),
        '---\nname: "test-skill"\ndescription: Test skill.\n---\n\n# test-skill\n',
      );
    };
    writeWorkspace(wsA);
    writeWorkspace(wsB);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const initialConfig = `schema_version: 2\nworkspace: ${wsA}\nbindings: []\n`;
    writeFileSync(configPath(home), initialConfig);

    const session = await startPtySession(["init", home, home, wsB], 60, { expectedExitCode: 0 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Current Workspace:");
      expect(squash(session.transcript())).toContain(squash("Current Workspace: ~/current-long-named-workspace-folder"));
      expect(squash(session.transcript())).toContain(squash("Requested Workspace: ~/requested-long-named-workspace-folder"));
      await session.waitForTranscript("Use this folder as your Workspace?");
      // The same one-blank-line rule at 60 columns (#699).
      expect(plain(session.transcript()).replace(/\r/g, ""))
        .toContain("\n\n❯ Use this folder as your Workspace?");
      expect(plain(session.transcript()).replace(/\r/g, "")).not.toContain("\n\n\n❯");
      const confirmOffset = session.transcriptLength();
      session.write("n");
      const { text } = await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
      expect(plain(text)).toContain("Cancelled. Nothing was changed.");
    } finally {
      await session.close();
    }

    expect(readFileSync(configPath(home), "utf8")).toBe(initialConfig);
  });

  test("the setup-routing question sits one blank line below its text at 100 and 60 columns (US-001, DEC-002, #699)", async () => {
    for (const columns of [100, 60]) {
      const home = isolatedHome();
      const workspace = join(home, "valid-workspace");
      mkdirSync(join(workspace, "context"), { recursive: true });
      mkdirSync(join(workspace, "skills", "release-check"), { recursive: true });
      mkdirSync(join(workspace, "profiles"), { recursive: true });
      writeFileSync(join(workspace, "workspace.yaml"), WORKSPACE_MANIFEST);
      writeFileSync(join(workspace, "context", "team-rules.md"), "Team rules.\n");
      writeFileSync(
        join(workspace, "profiles", "coding.yaml"),
        "context:\n  - team-rules\nskills:\n  - release-check\n",
      );
      writeFileSync(
        join(workspace, "skills", "release-check", "SKILL.md"),
        '---\nname: "release-check"\ndescription: Check the release state.\n---\n\n# release-check\n',
      );
      const session = await startPtySession(["init", home, home, workspace], columns);
      temporaryDirectories.push(session.runDirectory);
      try {
        await session.waitForTranscript("This folder already has everything it needs.");
        await session.waitForTranscript("Use this folder as your Workspace?");
        // US-001, DEC-002 (#699): the live routing question sits one blank
        // line below its text, never two.
        const screen = plain(session.transcript()).replace(/\r/g, "");
        expect(screen).toContain(
          "This folder already has everything it needs.\n\n❯ Use this folder as your Workspace?",
        );
        expect(screen).not.toContain("\n\n\n❯");
        const confirmOffset = session.transcriptLength();
        session.write("y");
        await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
      } finally {
        await session.close();
      }

      // The complete Workspace is connected unchanged and routed to install
      // (US-003, frame 28).
      expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${workspace}`);
    }
  });
});
