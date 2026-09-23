/**
 * Shared picker chrome under a real PTY (spec #640 US-004, issue #643,
 * TEST-002). The injectable-stream tests prove the chrome; these tests prove
 * the mandated keyboard set at 100 and 60 columns through a genuine
 * pseudo-terminal (`test/support/pty-controller.py` / `pty.fork`):
 * searching, selection retained across filtering, keyboard navigation, a
 * refused minimum-selection submit, and cancellation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { plain, startPtySession, squash } from "./support/pty-session.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const columns of [100, 60] as const) {
  describe(`shared picker chrome at ${columns} columns`, () => {
    test("searching narrows the list and Enter selects the match", async () => {
      const session = await startPtySession(["select"], columns);
      temporaryDirectories.push(session.runDirectory);
      try {
        await session.waitForTranscript("Which Profile?");
        await session.waitForTranscript("enter select");
        const filterOffset = session.transcriptLength();
        session.write("writ");
        await session.waitForTranscript("› writ", { after: filterOffset });
        const enterOffset = session.transcriptLength();
        session.write("\r");
        const { text } = await session.waitForTranscript('"value":"writing"', { after: enterOffset });
        expect(squash(text)).toContain('"value":"writing"');
        // One control hint, never an Instructions block.
        expect(plain(text)).not.toContain("Instructions");
        expect(plain(text)).not.toContain("Filtered results for:");
      } finally {
        await session.close();
      }
    });

    test("selection is retained across filter changes", async () => {
      const session = await startPtySession(["multi"], columns);
      temporaryDirectories.push(session.runDirectory);
      try {
        await session.waitForTranscript("Which Agent Hosts?");
        // Pick claude first.
        const firstToggle = session.transcriptLength();
        session.write(" ");
        await session.waitForTranscript("1 selected", { after: firstToggle });
        // Filter to pi and pick it too.
        const filterOffset = session.transcriptLength();
        session.write("pi");
        await session.waitForTranscript("› pi", { after: filterOffset });
        const secondToggle = session.transcriptLength();
        session.write(" ");
        await session.waitForTranscript("2 selected", { after: secondToggle });
        // Clear the filter; both picks stay selected.
        const clearOffset = session.transcriptLength();
        session.write("\u007f\u007f");
        await session.waitForTranscript("2 selected", { after: clearOffset });
        const enterOffset = session.transcriptLength();
        session.write("\r");
        const { text } = await session.waitForTranscript('"values":', { after: enterOffset });
        expect(squash(text)).toContain("claude");
        expect(squash(text)).toContain("pi");
      } finally {
        await session.close();
      }
    });

    test("arrow navigation moves the shared focus marker", async () => {
      const session = await startPtySession(["select"], columns);
      temporaryDirectories.push(session.runDirectory);
      try {
        await session.waitForTranscript("Which Profile?");
        const arrowOffset = session.transcriptLength();
        session.write("\x1b[B");
        await session.waitForTranscript("❯ops", { after: arrowOffset });
        const enterOffset = session.transcriptLength();
        session.write("\r");
        const { text } = await session.waitForTranscript('"value":"ops"', { after: enterOffset });
        expect(squash(text)).toContain('"value":"ops"');
      } finally {
        await session.close();
      }
    });

    test("a refused minimum-selection submit stays open until a choice is toggled", async () => {
      const session = await startPtySession(["multi"], columns);
      temporaryDirectories.push(session.runDirectory);
      try {
        await session.waitForTranscript("Which Agent Hosts?");
        // Enter with nothing selected must refuse (min 1) and keep the prompt.
        const refusedOffset = session.transcriptLength();
        session.write("\r");
        await session.waitForTranscript("select at least 1", { after: refusedOffset });
        const toggleOffset = session.transcriptLength();
        session.write(" ");
        await session.waitForTranscript("1 selected", { after: toggleOffset });
        const enterOffset = session.transcriptLength();
        session.write("\r");
        await session.waitForTranscript('"values":', { after: enterOffset });
      } finally {
        await session.close();
      }
    });

    test("Ctrl-C cancels the picker", async () => {
      const session = await startPtySession(["select"], columns);
      temporaryDirectories.push(session.runDirectory);
      try {
        await session.waitForTranscript("Which Profile?");
        const cancelOffset = session.transcriptLength();
        session.write("\x03");
        const { text } = await session.waitForTranscript('"kind":"cancelled"', { after: cancelOffset });
        expect(squash(text)).toContain('"kind":"cancelled"');
      } finally {
        await session.close();
      }
    });
  });
}
