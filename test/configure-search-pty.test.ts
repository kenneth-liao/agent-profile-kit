/**
 * Real-PTY qualification for configure membership choices (ticket #500,
 * TEST-003). The injectable-stream tests prove the flow; this test proves
 * keyboard behavior (typing, toggle, submit) and rendering width through a
 * genuine pseudo-terminal allocated by `test/support/pty-controller.py`
 * (pty.fork) — never callbacks alone. In particular it proves the
 * preselected-across-filter behavior in this instantiation: a selected
 * member filtered out of view stays selected on submit.
 *
 * Synchronization rule (#542): input is sent only after the required
 * prompt/redraw state is OBSERVED — the transcript offset is captured
 * immediately before each triggering write, filter Enter waits for the
 * filter echo ("Filtered results for: <input>"), toggles for the selected-
 * marker redraw (◉) — never a fixed settle delay.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContextModule } from "../installer/create-context-module.js";
import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { startPtySession, squash } from "./support/pty-session.js";

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

describe("interactive configure under a real PTY", () => {
  test("filtered pickers keep preselected membership and keyboard submit saves", async () => {
    const home = await setupHome();
    const session = await startPtySession(["configure", home, "coding"], 80);
    temporaryDirectories.push(session.runDirectory);
    try {
      // Current membership is shown before the pickers open.
      await session.waitForTranscript("Current membership of reusable Profile 'coding'");
      // Filter the Context picker so the selected member leaves the view,
      // then submit with Enter: the hidden selection persists.
      await session.waitForTranscript("Which Context Modules?");
      const contextFilterOffset = session.transcriptLength();
      session.write("extra");
      await session.waitForTranscript("Filtered results for: extra", { after: contextFilterOffset });
      const contextEnterOffset = session.transcriptLength();
      session.write("\r");
      // Skills picker: filter, observe the filter echo, observe the toggle
      // marker on the match, then submit.
      await session.waitForTranscript("Which Skills?", { after: contextEnterOffset });
      const skillsFilterOffset = session.transcriptLength();
      session.write("review");
      await session.waitForTranscript("Filtered results for: review", { after: skillsFilterOffset });
      const toggleOffset = session.transcriptLength();
      session.write(" ");
      await session.waitForTranscript("◉review-pr", { after: toggleOffset });
      const skillsEnterOffset = session.transcriptLength();
      session.write("\r");
      // The pre-save statement names the reusable Profile; confirm.
      await session.waitForTranscript("Reusable Profile 'coding'", { after: skillsEnterOffset });
      await session.waitForTranscript("(y/N)", { after: skillsEnterOffset });
      const confirmOffset = session.transcriptLength();
      session.write("y\r");
      await session.waitForTranscript("RESULT exitCode=0", { after: confirmOffset });
    } finally {
      await session.close();
    }

    const profile = readFileSync(join(workspacePath(home), "profiles", "coding.yaml"), "utf8");
    // The hidden preselected member survived filtering; typing the filter
    // never selected the visible-but-untoggled match.
    expect(profile).toContain("team-rules");
    expect(profile).not.toContain("extra-rules");
    expect(profile).toContain("review-pr");
    const text = squash(session.transcript());
    expect(text).toContain("apkitconfigureprofilecoding");
    expect(text).toContain("apkitupdate");
  });
});