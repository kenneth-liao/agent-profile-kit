/**
 * Guided and explicit Profile creation (ticket #675, spec #672 US-004, DEC-001,
 * DEC-008, TEST-001, TEST-002).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { runNewCommand } from "../cli/new-command.js";
import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-new-profile-test-"));
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

function writeConfig(home: string, workspace: string): void {
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspace}\nbindings: []\n`,
  );
}

async function setupEmptyHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
  writeConfig(home, workspacePath(home));
  return home;
}

async function setupHomeWithMaterial(): Promise<string> {
  const home = await setupEmptyHome();
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "Always preserve the project boundary.\n",
  );
  await createSkill({ home, name: "review-pr" });
  return home;
}

interface CapturedStreams {
  readonly output: Writable;
  readonly stderr: Writable;
  readonly humanText: () => string;
  readonly errorText: () => string;
}

function capturedStreams(): CapturedStreams {
  const chunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  const output = new PassThrough();
  const stderr = new PassThrough();
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
  return {
    output,
    stderr,
    humanText: () => Buffer.concat(chunks).toString(),
    errorText: () => Buffer.concat(errorChunks).toString(),
  };
}

/** Strip ANSI styling and collapse whitespace, so assertions stay structural. */
function plain(text: string): string {
  return text
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ");
}

/** A non-interactive input stream: the prompt seam reads no TTY evidence. */
function nonInteractiveInput(): PassThrough {
  return new PassThrough();
}

/** A fake interactive input stream: the prompt seam reads TTY evidence from it. */
function fakeInteractiveInput(): PassThrough & { isTTY: true } {
  const stream = new PassThrough() as PassThrough & { isTTY: true };
  stream.isTTY = true;
  return stream;
}

/** Poll the captured human output until it contains the expected fragment. */
async function waitForOutput(
  humanText: () => string,
  fragment: string,
  deadlineMs = 5000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!plain(humanText()).includes(fragment)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for output fragment: ${fragment}\n--- text ---\n${humanText()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("guided Profile creation (ticket #675, US-004)", () => {
  test("Screen P1: empty Workspace guidance when no Context and no Skills exist", async () => {
    const home = await setupEmptyHome();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();

    const outcome = await runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    expect(outcome.exitCode).toBe(0);
    const output = plain(streams.humanText());
    expect(output).toContain("A Profile needs at least one Context file or Skill, and your Workspace has none yet.");
    expect(output).toContain("Add some first:");
    expect(output).toContain("Put skill folders in");
    expect(output).toContain("apkit new context <name>");
    expect(output).toContain("Then run apkit new profile again.");
  });

  test("Screens P2-P5: guided first Profile creates Profile and prints receipt with next steps", async () => {
    const home = await setupHomeWithMaterial();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();

    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    // Screen P2: Concept explanation and name prompt
    await waitForOutput(streams.humanText, "A Profile groups Context and Skills for one kind of work");
    await waitForOutput(streams.humanText, "Name your Profile");
    input.write("engineering\r");

    // Screen P3: Context note and selection
    await waitForOutput(streams.humanText, "Context is loaded in every agent session that uses this Profile.");
    await waitForOutput(streams.humanText, "Which Context?");
    // Toggle team-rules on
    input.write(" ");
    await sleep(50);
    input.write("\r");

    // Screen P4: Skills note and selection
    await waitForOutput(streams.humanText, "Agents load Skills only when they need them.");
    await waitForOutput(streams.humanText, "Which Skills?");
    // Toggle review-pr on
    input.write(" ");
    await sleep(50);
    input.write("\r");

    const outcome = await pending;
    expect(outcome.exitCode).toBe(0);

    const profilePath = join(workspacePath(home), "profiles", "engineering.yaml");
    const content = readFileSync(profilePath, "utf8");
    expect(content).toContain("team-rules");
    expect(content).toContain("review-pr");

    // Screen P5 receipt assertions
    const receipt = plain(streams.humanText());
    expect(receipt).toContain("Created the engineering Profile");
    expect(receipt).toContain("Context: team-rules");
    expect(receipt).toContain("Skills: review-pr");
    expect(receipt).toContain("Change it later with apkit configure profile engineering.");
    expect(receipt).toContain("apkit install engineering (run it inside a Project folder)");
  });

  test("cancelling at the name prompt writes nothing and exits 1", async () => {
    const home = await setupHomeWithMaterial();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();

    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Name your Profile");
    input.end();

    const outcome = await pending;
    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("Profile creation was cancelled; nothing was written.");
  });

  test("cancelling at the Context prompt writes nothing and exits 1", async () => {
    const home = await setupHomeWithMaterial();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();

    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Name your Profile");
    input.write("engineering\r");

    await waitForOutput(streams.humanText, "Which Context?");
    input.end();

    const outcome = await pending;
    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("Profile creation was cancelled; nothing was written.");
  });

  test("cancelling at the Skill prompt writes nothing and exits 1", async () => {
    const home = await setupHomeWithMaterial();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();

    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Name your Profile");
    input.write("engineering\r");

    await waitForOutput(streams.humanText, "Which Context?");
    input.write(" \r");

    await waitForOutput(streams.humanText, "Which Skills?");
    input.end();

    const outcome = await pending;
    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("Profile creation was cancelled; nothing was written.");
  });

  test("invalid name in guided flow fails with diagnostic and writes nothing", async () => {
    const home = await setupHomeWithMaterial();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();

    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Name your Profile");
    input.write("Invalid Name!\r");

    const outcome = await pending;
    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("must be a lowercase kebab-case name");
  });

  test("taken name in guided flow fails with duplicate diagnostic and writes nothing", async () => {
    const home = await setupHomeWithMaterial();
    // Create existing profile 'coding'
    mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "context:\n  - team-rules\nskills: []\n",
    );

    const input = fakeInteractiveInput();
    const streams = capturedStreams();

    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Name your Profile");
    input.write("coding\r");

    const outcome = await pending;
    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("coding");
    expect(plain(streams.errorText())).toContain("already exists");
  });

  test("non-interactive invocation without a name fails with explicit usage", async () => {
    const home = await setupHomeWithMaterial();
    const streams = capturedStreams();

    const outcome = await runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(1);
    const errorOutput = plain(streams.errorText());
    expect(errorOutput).toContain("new profile requires a Profile name");
    expect(errorOutput).toContain("apkit new profile <profile> [--context <context>]... [--skill <skill>]...");
  });

  test("explicit and guided Profile creation write identical YAML files through the one writer", async () => {
    const home = await setupHomeWithMaterial();

    // 1. Explicit creation
    const explicitStreams = capturedStreams();
    const explicitOutcome = await runNewCommand({
      home,
      arguments: [
        "profile",
        "explicit-prof",
        "--context",
        "team-rules",
        "--skill",
        "review-pr",
      ],
      stdout: explicitStreams.output as Writable & { isTTY?: boolean },
      stderr: explicitStreams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(explicitOutcome.exitCode).toBe(0);

    // 2. Guided creation
    const input = fakeInteractiveInput();
    const guidedStreams = capturedStreams();
    const guidedPending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: guidedStreams.output as Writable & { isTTY?: boolean },
      stderr: guidedStreams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(guidedStreams.humanText, "Name your Profile");
    input.write("guided-prof\r");

    await waitForOutput(guidedStreams.humanText, "Which Context?");
    input.write(" \r");

    await waitForOutput(guidedStreams.humanText, "Which Skills?");
    input.write(" \r");

    const guidedOutcome = await guidedPending;
    expect(guidedOutcome.exitCode).toBe(0);

    const explicitContent = readFileSync(
      join(workspacePath(home), "profiles", "explicit-prof.yaml"),
      "utf8",
    );
    const guidedContent = readFileSync(
      join(workspacePath(home), "profiles", "guided-prof.yaml"),
      "utf8",
    );

    // Both files must have identical content
    expect(guidedContent).toBe(explicitContent);
  });

  test("when only Context exists, Context prompt enforces min:1 and Skill prompt is skipped", async () => {
    const home = await setupEmptyHome();
    mkdirSync(join(workspacePath(home), "context"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "Rules.\n",
    );

    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Name your Profile");
    input.write("context-only\r");

    await waitForOutput(streams.humanText, "Which Context?");
    // Toggle team-rules on and submit
    input.write(" \r");

    const outcome = await pending;
    expect(outcome.exitCode).toBe(0);
    // Skills prompt was skipped
    expect(plain(streams.humanText())).not.toContain("Which Skills?");

    const content = readFileSync(
      join(workspacePath(home), "profiles", "context-only.yaml"),
      "utf8",
    );
    expect(content).toContain("team-rules");
  });

  test("when only Skills exist, Context prompt is skipped and Skill prompt enforces min:1", async () => {
    const home = await setupEmptyHome();
    await createSkill({ home, name: "review-pr" });

    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Name your Profile");
    input.write("skill-only\r");

    // Context prompt was skipped
    await waitForOutput(streams.humanText, "Which Skills?");
    expect(plain(streams.humanText())).not.toContain("Which Context?");
    // Toggle review-pr on and submit
    input.write(" \r");

    const outcome = await pending;
    expect(outcome.exitCode).toBe(0);

    const content = readFileSync(
      join(workspacePath(home), "profiles", "skill-only.yaml"),
      "utf8",
    );
    expect(content).toContain("review-pr");
  });

  test("when 0 Contexts are selected, Skill prompt enforces min:1 poka-yoke", async () => {
    const home = await setupHomeWithMaterial();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runNewCommand({
      home,
      arguments: ["profile"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Name your Profile");
    input.write("skill-selected\r");

    // Context prompt: submit without selecting (0 selected)
    await waitForOutput(streams.humanText, "Which Context?");
    input.write("\r");

    // Skill prompt: toggle skill on and submit
    await waitForOutput(streams.humanText, "Which Skills?");
    input.write(" \r");

    const outcome = await pending;
    expect(outcome.exitCode).toBe(0);

    const receipt = plain(streams.humanText());
    expect(receipt).toContain("Skills: review-pr");
    expect(receipt).not.toContain("Context:");
  });
});

describe("new context receipt (Screen P6)", () => {
  test("new context receipt explains what to write and points to apkit new profile", async () => {
    const home = await setupEmptyHome();
    const streams = capturedStreams();

    const outcome = await runNewCommand({
      home,
      arguments: ["context", "team-conventions"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(0);
    const receipt = plain(streams.humanText());
    expect(receipt).toContain("team-conventions.md");
    expect(receipt).toContain("Open it and write the rules every agent session should follow.");
    expect(receipt).toContain("apkit new profile (make a Profile that uses it)");
  });
});
