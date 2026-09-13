/**
 * Real-PTY qualification for searchable install choices (ticket #495,
 * TEST-003). The injectable-stream tests prove the flow; these tests prove
 * keyboard behavior (typing, arrows, toggle, submit, cancel) and rendering
 * width through a genuine pseudo-terminal allocated by
 * `test/support/pty-controller.py` (pty.fork) — never callbacks alone.
 *
 * Synchronization rule (#542): input is sent only after the required
 * prompt/redraw state is OBSERVED — the transcript offset is captured
 * immediately before each triggering write, and each wait matches only
 * content appended after it. Filter-text Enter waits for the filter-
 * resolution render (`›<typed>` + reduced list), arrows for the pointer or
 * highlight redraw, toggles for the selected-marker redraw — never a fixed
 * settle delay. The upstream type-ahead race (filter text and Enter in one
 * chunk can submit the pre-filter highlight) is why Enter must observe the
 * resolution; that race itself is out of scope for this seam.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { plain, startPtySession, squash } from "./support/pty-session.js";

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

describe("searchable prompts under a real PTY", () => {
  test("typing filters the single choice and Enter selects the match", async () => {
    const session = await startPtySession(["select"], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Profile?");
      const filterOffset = session.transcriptLength();
      session.write("writ");
      // Enter only after the OBSERVED filter-resolution render (the `›` + typed
      // value redraw with the reduced list) — pending renders show `…` and the
      // stale full list.
      await session.waitForTranscript("›writ", { after: filterOffset });
      const enterOffset = session.transcriptLength();
      session.write("\r");
      const { text } = await session.waitForTranscript('"value":"writing"', { after: enterOffset });
      expect(squash(text)).toContain('"value":"writing"');
    } finally {
      await session.close();
    }
  });

  test("arrow navigation with Space toggles and Enter submits the multi choice", async () => {
    const session = await startPtySession(["multi"], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Agent Hosts?");
      // Each arrow is observed through the highlight redraw (the underlined
      // row is styling — raw matching preserves the ANSI evidence).
      const firstArrowOffset = session.transcriptLength();
      session.write("\x1b[B");
      await session.waitForTranscript("\x1b[36m\x1b[4mcodex", { after: firstArrowOffset, raw: true });
      const secondArrowOffset = session.transcriptLength();
      session.write("\x1b[B");
      await session.waitForTranscript("\x1b[36m\x1b[4mpi", { after: secondArrowOffset, raw: true });
      const toggleOffset = session.transcriptLength();
      session.write(" ");
      // The selected marker (◉) next to the highlighted title is the toggle
      // redraw; unselected rows render ◯.
      await session.waitForTranscript("◉pi", { after: toggleOffset });
      const enterOffset = session.transcriptLength();
      session.write("\r");
      const { text } = await session.waitForTranscript('"values":["pi"]', { after: enterOffset });
      expect(squash(text)).toContain('"values":["pi"]');
    } finally {
      await session.close();
    }
  });
  test("arrow navigation highlights and Enter selects the single choice", async () => {
    const session = await startPtySession(["select"], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Profile?");
      const arrowOffset = session.transcriptLength();
      session.write("\x1b[B");
      // The pointer (❯) re-emitted before the newly highlighted title is the
      // arrow redraw.
      await session.waitForTranscript("❯ops", { after: arrowOffset });
      const enterOffset = session.transcriptLength();
      session.write("\r");
      const { text } = await session.waitForTranscript('"value":"ops"', { after: enterOffset });
      expect(squash(text)).toContain('"value":"ops"');
    } finally {
      await session.close();
    }
  });
});

describe("guided install under a real PTY", () => {
  test("a bare install at 60 columns names the target and installs the picked selection", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const session = await startPtySession(["install", home, projectPath], 60);
    temporaryDirectories.push(session.runDirectory);
    try {
      // The bare install names its current-directory Project target first by
      // the shortest-unambiguous identity this view renders (US-013), even
      // wrapped at 60 columns.
      const target = await session.waitForTranscript(basename(projectPath));
      expect(squash(target.text)).toContain(basename(projectPath));
      await session.waitForTranscript("Which Profile?");
      const filterOffset = session.transcriptLength();
      session.write("cod");
      await session.waitForTranscript("›cod", { after: filterOffset });
      const profileEnterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("Which Agent Hosts?", { after: profileEnterOffset });
      const hostFilterOffset = session.transcriptLength();
      session.write("codex");
      await session.waitForTranscript("Filtered results for: codex", { after: hostFilterOffset });
      const toggleOffset = session.transcriptLength();
      session.write(" ");
      await session.waitForTranscript("◉codex", { after: toggleOffset });
      const hostEnterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("(y/N)", { after: hostEnterOffset });
      const confirmOffset = session.transcriptLength();
      session.write("y\r");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
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
    const session = await startPtySession(["install", home, projectPath], 80, { expectedExitCode: 1 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Profile?");
      const cancelOffset = session.transcriptLength();
      session.write("\x03");
      const { text } = await session.waitForTranscript("RESULTexitCode=1", { after: cancelOffset });
      expect(plain(text)).toContain("cancelled");
      const teardown = await session.close();
      // The driver's own nonzero outcome propagates through the controller —
      // never a false 0 (INT-B-1).
      expect(teardown.exitCode).toBe(1);
    } finally {
      await session.close();
    }

    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });
});