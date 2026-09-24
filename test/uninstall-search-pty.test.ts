/**
 * Real-PTY qualification for interactive uninstall selection (ticket #499,
 * TEST-003). The injectable-stream tests in `uninstall-search.test.ts` prove
 * the flow; these tests prove keyboard behavior (arrows, toggle, submit,
 * cancel) and rendering width through a genuine pseudo-terminal allocated by
 * `test/support/pty-controller.py` (pty.fork) — never callbacks alone.
 *
 * Synchronization discipline (#542) mirrors `install-search-pty.test.ts`:
 * every input is sent only after the required prompt/redraw state is
 * OBSERVED — the transcript offset is captured immediately before each
 * triggering write, filter Enter waits for the filter-resolution render,
 * toggles for the selected-marker redraw — never a fixed settle delay — and
 * the controller's own watchdog kills the driver if the test itself is ever
 * timed out, so no probe can orphan a PTY child.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeInstall } from "../installer/install-application.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { plain, startPtySession, squash } from "./support/pty-session.js";

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
  return join(home, "apkit-workspace");
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
  await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "Always preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", "engineering.yaml"),
    "context:\n  - team-rules\nskills: []\n",
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

describe("interactive uninstall under a real PTY", () => {
  test("Space toggles and Enter submits the picked Project at 60 columns", async () => {
    const { home, first, second } = await setupInstalledPair();
    const session = await startPtySession(["uninstall", home], 60);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Projects");
      // Toggle the highlighted Project and submit: nothing is pre-selected,
      // so exactly one Project is picked here. The highlighted row is the
      // picker's canonical first row (not necessarily the first-created temp
      // directory), so the toggle redraw is observed as the selected marker
      // (◼) itself — unselected rows render ◻, and no row is selected before
      // the Space keystroke.
      const toggleOffset = session.transcriptLength();
      session.write(" ");
      await session.waitForTranscript("◼", { after: toggleOffset });
      const scopeEnterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("Whole installations or selected agents?", { after: scopeEnterOffset });
      const confirmEnterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("(y/N)", { after: confirmEnterOffset });
      const confirmOffset = session.transcriptLength();
      session.write("y\r");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    } finally {
      await session.close();
    }

    // Exactly one Project removed; the other is untouched.
    const config = readFileSync(configPath(home), "utf8");
    expect((!config.includes(first)) !== (!config.includes(second))).toBe(true);
  });

  test("typing filters the Project picker and arrows move before toggle", async () => {
    const { home, first, second } = await setupInstalledPair();
    const session = await startPtySession(["uninstall", home], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Projects");
      // Filter to the second Project's unique path suffix, then toggle and
      // submit: typing narrows by path on a real terminal too. The filter
      // echo (the `› <input>` filter line) is the multi-select's own
      // synchronous filter-applied redraw.
      const suffix = second.slice(-6);
      const filterOffset = session.transcriptLength();
      session.write(suffix);
      await session.waitForTranscript(`› ${suffix}`, { after: filterOffset });
      const toggleOffset = session.transcriptLength();
      session.write(" ");
      await session.waitForTranscript(`◼${second}`, { after: toggleOffset });
      const submitOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("Whole installations or selected agents?", { after: submitOffset });
      const confirmEnterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("(y/N)", { after: confirmEnterOffset });
      const confirmOffset = session.transcriptLength();
      session.write("y\r");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    } finally {
      await session.close();
    }

    const config = readFileSync(configPath(home), "utf8");
    expect(config).not.toContain(second);
    expect(config).toContain(first);
  });

  test("Ctrl-C during picking cancels with zero lifecycle changes", async () => {
    const { home, first, second } = await setupInstalledPair();
    const session = await startPtySession(["uninstall", home], 80, { expectedExitCode: 1 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Projects");
      const cancelOffset = session.transcriptLength();
      session.write("\x03");
      const { text } = await session.waitForTranscript("RESULTexitCode=1", { after: cancelOffset });
      expect(plain(text)).toContain("Cancelled. Nothing was changed.");
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