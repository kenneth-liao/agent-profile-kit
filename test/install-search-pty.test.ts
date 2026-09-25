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
  return join(home, "apkit-workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

async function setupHome(profile = "coding"): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "Always preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", `${profile}.yaml`),
    `context:\n  - team-rules\nskills: []\n`,
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
      await session.waitForTranscript("Which agents?");
      // Each arrow is observed through the highlight redraw (the underlined
      // row is styling — raw matching preserves the ANSI evidence).
      const firstArrowOffset = session.transcriptLength();
      session.write("\x1b[B");
      await session.waitForTranscript("❯◻codex", { after: firstArrowOffset });
      const secondArrowOffset = session.transcriptLength();
      session.write("\x1b[B");
      await session.waitForTranscript("❯◻pi", { after: secondArrowOffset });
      const toggleOffset = session.transcriptLength();
      session.write(" ");
      // The selected marker (◼) next to the highlighted title is the toggle
      // redraw; unselected rows render ◻.
      await session.waitForTranscript("◼pi", { after: toggleOffset });
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
    // Controlled Host detection PATH: none detected, so every choice starts
    // unselected and the toggle is deterministic on any machine.
    const session = await startPtySession(["install", home, projectPath, ""], 60);
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
      await session.waitForTranscript("Which agents?", { after: profileEnterOffset });
      const hostFilterOffset = session.transcriptLength();
      session.write("codex");
      await session.waitForTranscript("› codex", { after: hostFilterOffset });
      const toggleOffset = session.transcriptLength();
      session.write(" ");
      await session.waitForTranscript("◼codex", { after: toggleOffset });
      const hostEnterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("(y/N)", { after: hostEnterOffset });
      const confirmOffset = session.transcriptLength();
      session.write("y\r");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
      // The install pickers settle with their short labels at 60 columns
      // (spec #672 US-005, screens 11–13): `✔ Profile › …` and `✔ Agents › …`,
      // never the full question as the settled label.
      const settled = plain(session.transcript());
      expect(settled).toContain("✔ Profile › coding");
      expect(settled).toContain("✔ Agents › codex");
      expect(settled).not.toContain("Which Profile? ›");
      expect(settled).not.toContain("Which agents? ›");
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
    const session = await startPtySession(["install", home, projectPath, ""], 80, { expectedExitCode: 1 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Profile?");
      const cancelOffset = session.transcriptLength();
      session.write("\x03");
      const { text } = await session.waitForTranscript("RESULTexitCode=1", { after: cancelOffset });
      // Screen 14: the one shared cancellation statement.
      expect(plain(text)).toContain("Cancelled. Nothing was changed.");
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

  test("declining the confirmation changes nothing (TEST-002, spec #677 screen 14)", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const session = await startPtySession(["install", home, projectPath, ""], 100, { expectedExitCode: 1 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Profile?");
      const filterOffset = session.transcriptLength();
      session.write("cod");
      await session.waitForTranscript("›cod", { after: filterOffset });
      const profileEnterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("Which agents?", { after: profileEnterOffset });
      // Nothing is detected here, so nothing is preselected: filter to Codex
      // and toggle it explicitly (deterministic on any machine).
      const hostFilterOffset = session.transcriptLength();
      session.write("codex");
      await session.waitForTranscript("› codex", { after: hostFilterOffset });
      const toggleOffset = session.transcriptLength();
      session.write(" ");
      await session.waitForTranscript("◼codex", { after: toggleOffset });
      const hostEnterOffset = session.transcriptLength();
      session.write("\r");
      // No summary block precedes the confirmation (spec #677 screen 13).
      const { text: confirmation } = await session.waitForTranscript("(y/N)", { after: hostEnterOffset });
      expect(plain(confirmation)).toContain("Install now?");
      expect(plain(confirmation)).not.toContain("Agents:");
      const declineOffset = session.transcriptLength();
      session.write("n\r");
      const { text } = await session.waitForTranscript("RESULTexitCode=1", { after: declineOffset });
      expect(plain(text)).toContain("Cancelled. Nothing was changed.");
      // The declined confirmation settles neutral, never as a success (spec
      // #672 US-005).
      const settled = plain(session.transcript());
      expect(settled).toContain("● Install now? (y/N)");
      expect(settled).not.toContain("✔ Install now?");
    } finally {
      await session.close();
    }

    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("detected Hosts list first, preselect, and mark detected/not found at 60 columns", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const bin = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-pty-detected-bin-"));
    temporaryDirectories.push(bin);
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex-cli 0.145.0"\n`, { mode: 0o755 });
    const session = await startPtySession(["install", home, projectPath, bin], 60);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Which Profile?");
      const filterOffset = session.transcriptLength();
      session.write("cod");
      await session.waitForTranscript("›cod", { after: filterOffset });
      const profileEnterOffset = session.transcriptLength();
      session.write("\r");
      await session.waitForTranscript("Which agents?", { after: profileEnterOffset });
      await session.waitForTranscript("apkit doesn't install the agents themselves.");
      // Focus starts on the first (detected) Host, which is preselected;
      // undetected rows carry the not-found annotation in the same frame.
      await session.waitForTranscript("❯◼codex");
      await session.waitForTranscript("not found");
      await session.waitForTranscript("detected");
      const enterOffset = session.transcriptLength();
      // Submitting immediately keeps only the preselected detected Host. No
      // summary block precedes the confirmation (spec #677 screen 13).
      session.write("\r");
      await session.waitForTranscript("(y/N)", { after: enterOffset });
      const confirmOffset = session.transcriptLength();
      session.write("y\r");
      await session.waitForTranscript("RESULTexitCode=0", { after: confirmOffset });
    } finally {
      await session.close();
    }

    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("- codex");
    expect(config).not.toContain("- antigravity");
    expect(config).not.toContain("- opencode");
  });
});
