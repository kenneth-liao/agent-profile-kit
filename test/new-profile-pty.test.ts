/**
 * Real-PTY qualification for guided Profile creation (ticket #675, spec #672
 * US-004, DEC-001, DEC-008, TEST-002).
 *
 * Runs interactive Profile creation under a genuine pseudo-terminal allocated
 * by `test/support/pty-controller.py` (pty.fork) to prove:
 * - Empty Workspace guidance rendering (Screen P1)
 * - Name prompt, settled labels (✔ Name › …), context & skill selection, and receipt (Screens P2-P5)
 * - Keyboard cancellation with Ctrl-C
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContextModule } from "../installer/create-context-module.js";
import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { startPtySession } from "./support/pty-session.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-new-profile-pty-"));
  temporaryDirectories.push(home);
  return home;
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

async function setupEmptyHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  return home;
}

async function setupHomeWithMaterial(): Promise<string> {
  const home = await setupEmptyHome();
  await createContextModule({ home, name: "team-rules" });
  await createSkill({ home, name: "review-pr" });
  return home;
}

describe("guided Profile creation under a real PTY (TEST-002)", () => {
  test("Screen P1: empty Workspace guidance renders and exits 0", async () => {
    const home = await setupEmptyHome();
    const session = await startPtySession(["new", home, "profile"], 100);
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("A Profile needs at least one Context file or Skill");
      await session.waitForTranscript("Put skill folders in");
      await session.waitForTranscript("apkit new context <name>");
      await session.waitForTranscript("Then run apkit new profile again.");
      await session.waitForTranscript("RESULT exitCode=0");
    } finally {
      await session.close();
    }

    const profilesDir = join(workspacePath(home), "profiles");
    expect(readdirSync(profilesDir)).toEqual([]);
  });

  test("Screens P2-P5: guided first Profile creation under real PTY at 100 columns", async () => {
    const home = await setupHomeWithMaterial();
    const session = await startPtySession(["new", home, "profile"], 100);
    temporaryDirectories.push(session.runDirectory);
    try {
      // Screen P2: Concept explanation and name prompt
      await session.waitForTranscript("A Profile groups Context and Skills for one kind of work");
      await session.waitForTranscript("Name your Profile");

      // Type Profile name and submit
      const nameOffset = session.transcriptLength();
      session.write("engineering\r");

      // Screen P3: Settled Name label and Context note + picker
      await session.waitForTranscript("✔ Name › engineering", { after: nameOffset });
      await session.waitForTranscript("Context is loaded in every agent session that uses this Profile.");
      await session.waitForTranscript("Which Context?");

      // Toggle team-rules and submit
      const contextOffset = session.transcriptLength();
      session.write(" ");
      await session.waitForTranscript("1 selected", { after: contextOffset });
      const contextEnterOffset = session.transcriptLength();
      session.write("\r");

      // Screen P4: Settled Context label and Skills note + picker
      await session.waitForTranscript("✔ Context › team-rules", { after: contextEnterOffset });
      await session.waitForTranscript("Agents load Skills only when they need them.");
      await session.waitForTranscript("Which Skills?");

      // Toggle review-pr and submit
      const skillOffset = session.transcriptLength();
      session.write(" ");
      await session.waitForTranscript("1 selected", { after: skillOffset });
      const skillEnterOffset = session.transcriptLength();
      session.write("\r");

      // Screen P5: Settled Skills label and Receipt
      await session.waitForTranscript("✔ Skills › review-pr", { after: skillEnterOffset });
      await session.waitForTranscript("Created the engineering Profile");
      await session.waitForTranscript("Context: team-rules");
      await session.waitForTranscript("Skills: review-pr");
      await session.waitForTranscript("Change it later with apkit configure profile engineering.");
      await session.waitForTranscript("Next: apkit install engineering (run it inside a Project folder)");
      await session.waitForTranscript("RESULT exitCode=0");
    } finally {
      await session.close();
    }

    const profileFile = join(workspacePath(home), "profiles", "engineering.yaml");
    expect(existsSync(profileFile)).toBe(true);
    const content = readFileSync(profileFile, "utf8");
    expect(content).toContain("team-rules");
    expect(content).toContain("review-pr");
  });

  test("cancellation with Ctrl-C writes nothing and exits 1", async () => {
    const home = await setupHomeWithMaterial();
    const session = await startPtySession(["new", home, "profile"], 100, { expectedExitCode: 1 });
    temporaryDirectories.push(session.runDirectory);
    try {
      await session.waitForTranscript("Name your Profile");
      const cancelOffset = session.transcriptLength();
      session.write("\x03");
      await session.waitForTranscript("Profile creation was cancelled; nothing was written.", {
        after: cancelOffset,
      });
      await session.waitForTranscript("RESULT exitCode=1");
    } finally {
      await session.close();
    }

    const profileFile = join(workspacePath(home), "profiles", "engineering.yaml");
    expect(existsSync(profileFile)).toBe(false);
  });
});
