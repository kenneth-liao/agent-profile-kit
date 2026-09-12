/**
 * Configure Profile membership through the CLI (ticket #500, spec #491
 * US-009/US-005): one `configure profile` command with explicit and
 * interactive input modes feeding the same validated operation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Writable } from "node:stream";

import { runConfigureCommand } from "../cli/configure-command.js";
import { runInstallCommand } from "../cli/install-command.js";
import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { ingestSelectedWorkspace } from "../installer/local-configuration.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-configure-home-"));
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

function writeConfig(home: string, workspace: string): void {
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspace}\nbindings: []\n`,
  );
}

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills: []\n",
  );
  writeConfig(home, workspacePath(home));
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
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
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
      throw new Error(`timed out waiting for output fragment: ${fragment}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("explicit configure profile", () => {
  test("a fully specified invocation with --auto-confirm writes membership and prints its equivalent", async () => {
    const home = await setupHome();
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "team-rules", "--skill", "review-pr", "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(join(workspacePath(home), "profiles", "coding.yaml"), "utf8")).toContain(
      "review-pr",
    );
    const receipt = plain(streams.humanText());
    expect(receipt).toContain("apkit configure profile coding");
    expect(receipt).toContain("--context team-rules");
    expect(receipt).toContain("--skill review-pr");
    expect(receipt).toContain("apkit update");
  });

  test("an explicit single-category update leaves the omitted category unchanged", async () => {
    const home = await setupHome();
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--skill", "review-pr", "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(0);
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const workspace = await ingestSelectedWorkspace(home);
    expect(workspace.profiles.get("coding")!.context).toEqual(["team-rules"]);
    expect(workspace.profiles.get("coding")!.skills).toEqual(["review-pr"]);
    // The equivalent echoes the unchanged category in full: it stays executable.
    const receipt = plain(streams.humanText());
    expect(receipt).toContain("--context team-rules");
    expect(receipt).toContain("--skill review-pr");
    expect(readFileSync(profileFile, "utf8")).toContain("review-pr");
  });

  test("a non-interactive invocation without --auto-confirm refuses with the runnable equivalent", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "team-rules", "--skill", "review-pr"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(profileFile, "utf8")).toBe(before);
    const diagnostic = plain(streams.errorText());
    expect(diagnostic).toContain("needs explicit confirmation");
    expect(diagnostic).toContain("apkit configure profile coding");
    expect(diagnostic).toContain("--auto-confirm");
  });

  test("missing non-interactive inputs refuse without guessing", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");

    const nameless = capturedStreams();
    const namelessOutcome = await runConfigureCommand({
      home,
      arguments: ["profile", "--context", "team-rules", "--auto-confirm"],
      stdout: nameless.output as Writable & { isTTY?: boolean },
      stderr: nameless.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(namelessOutcome.exitCode).toBe(1);
    expect(plain(nameless.errorText())).toContain("requires a Profile name");

    const memberless = capturedStreams();
    const memberlessOutcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--auto-confirm"],
      stdout: memberless.output as Writable & { isTTY?: boolean },
      stderr: memberless.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(memberlessOutcome.exitCode).toBe(1);
    expect(plain(memberless.errorText())).toContain("at least one of --context");
    expect(readFileSync(profileFile, "utf8")).toBe(before);
  });

  test("unknown selections fail validation before the confirmation gate", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "nope", "--skill", "review-pr"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(profileFile, "utf8")).toBe(before);
    const diagnostic = plain(streams.errorText());
    expect(diagnostic).toContain("nope");
    expect(diagnostic).toContain("Available Context Modules");
    expect(diagnostic).not.toContain("needs explicit confirmation");
  });

  test("--json success uses the versioned lifecycle envelope", async () => {
    const home = await setupHome();
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "team-rules", "--skill", "review-pr", "--auto-confirm", "--json"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(0);
    const payload = JSON.parse(streams.humanText());
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe("configure");
    expect(payload.outcome).toBe("clean");
    expect(payload.profile).toBe("coding");
    expect(payload.changed).toBe(true);
    expect(payload.previous).toEqual({ context: ["team-rules"], skills: [] });
    expect(payload.membership).toEqual({ context: ["team-rules"], skills: ["review-pr"] });
    expect(payload.equivalent).toContain("apkit configure profile coding");
    expect(payload.equivalent).toContain("--auto-confirm");
    // Machine output carries no human receipt.
    expect(streams.errorText()).toBe("");
  });

  test("--json refusals use the versioned lifecycle error envelope", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "team-rules", "--skill", "review-pr", "--json"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(profileFile, "utf8")).toBe(before);
    const payload = JSON.parse(streams.humanText());
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe("configure");
    expect(payload.outcome).toBe("error");
    expect(typeof payload.error).toBe("string");
    expect(payload.globalBlockers).toBeUndefined();
    expect(streams.errorText()).toBe("");
  });

  test("--json parse errors use the versioned envelope", async () => {
    const home = await setupHome();
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--host", "codex", "--json"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(1);
    const payload = JSON.parse(streams.humanText());
    expect(payload.schemaVersion).toBe(1);
    expect(payload.command).toBe("configure");
    expect(payload.outcome).toBe("error");
    expect(typeof payload.error).toBe("string");
    expect(streams.errorText()).toBe("");
  });
});

/** Snapshot every regular file under a directory as relative path → bytes. */
function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        snapshot.set(relative, readFileSync(absolute, "utf8"));
      }
    }
  };
  walk(root, "");
  return snapshot;
}

describe("configure never installs", () => {
  test("changing membership leaves installed output, configuration, and state byte-identical", async () => {
    const home = await setupHome();
    const projectPath = mkdtempSync(join(tmpdir(), "agent-profile-kit-configure-project-"));
    temporaryDirectories.push(projectPath);
    const installStreams = capturedStreams();
    const installOutcome = await runInstallCommand({
      home,
      arguments: ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      stdout: installStreams.output as Writable & { isTTY?: boolean },
      stderr: installStreams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
      cwd: projectPath,
      env: { PATH: "" },
    });
    expect(installOutcome.exitCode).toBe(0);

    const homeBefore = snapshotTree(home);
    const projectBefore = snapshotTree(projectPath);
    expect(projectBefore.size).toBeGreaterThan(0);

    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "team-rules", "--skill", "review-pr", "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(outcome.exitCode).toBe(0);

    // Only the Profile definition changed: installed Project output,
    // Local Configuration, Installation State, and history are untouched.
    const homeAfter = snapshotTree(home);
    expect([...homeAfter.keys()].sort()).toEqual([...homeBefore.keys()].sort());
    const profileKey = [...homeBefore.keys()].find((relative) =>
      relative.endsWith("profiles/coding.yaml"),
    );
    expect(profileKey).toBeDefined();
    for (const [relative, bytes] of homeBefore) {
      if (relative === profileKey) continue;
      expect(homeAfter.get(relative)).toBe(bytes);
    }
    expect(homeAfter.get(profileKey!)).not.toBe(homeBefore.get(profileKey!));
    const projectAfter = snapshotTree(projectPath);
    expect([...projectAfter.entries()]).toEqual([...projectBefore.entries()]);
  });
});

describe("configure profile argument errors", () => {
  test("unknown objects, flags, duplicate selections, and extra names fail with usage", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");
    for (const args of [
      ["project", "coding"],
      ["profile", "coding", "--host", "codex"],
      ["profile", "coding", "--context", "team-rules", "--context", "team-rules"],
      ["profile", "coding", "extra", "--context", "team-rules"],
      ["profile", "coding", "--context", "team-rules", "extra"],
    ]) {
      const streams = capturedStreams();
      const outcome = await runConfigureCommand({
        home,
        arguments: args,
        stdout: streams.output as Writable & { isTTY?: boolean },
        stderr: streams.stderr as Writable & { isTTY?: boolean },
        input: nonInteractiveInput(),
      });
      expect(outcome.exitCode).toBe(1);
      expect(plain(streams.errorText())).toContain("Usage");
    }
    // Present-empty flags are valid syntax: emptying the last selected
    // category is refused by validation with the source unchanged.
    const emptied = capturedStreams();
    const emptiedOutcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "--skill", "--auto-confirm"],
      stdout: emptied.output as Writable & { isTTY?: boolean },
      stderr: emptied.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(emptiedOutcome.exitCode).toBe(1);
    expect(plain(emptied.errorText())).toContain("at least one supported artifact");
    expect(readFileSync(profileFile, "utf8")).toBe(before);
  });
});

describe("interactive configure profile", () => {
  test("a bare invocation asks the name, shows current membership, and saves after confirmation", async () => {
    const home = await setupHome();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runConfigureCommand({
      home,
      arguments: [],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    // The name picker lists existing Profiles; filter and submit.
    await waitForOutput(streams.humanText, "Which Profile to configure?");
    input.write("cod");
    await sleep(100);
    input.write("\r");
    // Current membership is shown before anything else is asked.
    await waitForOutput(streams.humanText, "Current membership of reusable Profile 'coding'");
    // Context picker preselects the current member: submit unchanged.
    await waitForOutput(streams.humanText, "Which Context Modules?");
    input.write("\r");
    // Skills picker: filter, toggle the Skill on, submit.
    await waitForOutput(streams.humanText, "Which Skills?");
    input.write("review");
    await sleep(100);
    input.write(" ");
    await sleep(100);
    input.write("\r");
    // The pre-save statement names the reusable Profile before confirmation.
    await waitForOutput(streams.humanText, "(y/N)");
    const review = plain(streams.humanText());
    expect(review).toContain("Reusable Profile 'coding'");
    expect(review).toContain("Saves only to the reusable Profile definition");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(join(workspacePath(home), "profiles", "coding.yaml"), "utf8")).toContain(
      "review-pr",
    );
    const receipt = plain(streams.humanText());
    expect(receipt).toContain("apkit configure profile coding");
    expect(receipt).toContain("--skill review-pr");
    expect(receipt).toContain("apkit update");
  });

  test("supplied categories skip their pickers and a decline keeps the source unchanged", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "team-rules", "--skill", "review-pr"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    // Both categories supplied: no picker opens, only the confirmation.
    await waitForOutput(streams.humanText, "(y/N)");
    const review = plain(streams.humanText());
    expect(review).not.toContain("Which Context Modules?");
    expect(review).not.toContain("Which Skills?");
    expect(review).toContain("Reusable Profile 'coding'");
    input.write("n\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(profileFile, "utf8")).toBe(before);
    const diagnostic = plain(streams.errorText());
    expect(diagnostic).toContain("nothing was written (you answered no)");
    expect(diagnostic).toContain("apkit configure profile coding");
    expect(diagnostic).toContain("--auto-confirm");
  });

  test("a hidden preselected member survives filtering and an unchanged request skips confirmation", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runConfigureCommand({
      home,
      arguments: ["profile", "coding"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    // Filter the Context picker so the selected member leaves the view,
    // then submit: the hidden selection persists (495 preselected-across-
    // filter behavior in this instantiation).
    await waitForOutput(streams.humanText, "Which Context Modules?");
    input.write("example");
    await sleep(150);
    input.write("\r");
    // Skills picker: nothing selected yet, submit the empty choice.
    await waitForOutput(streams.humanText, "Which Skills?");
    input.write("\r");
    const outcome = await pending;

    // The resolved membership matches the recorded one, so the flow
    // reports it honestly without prompting or writing.
    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(profileFile, "utf8")).toBe(before);
    const receipt = plain(streams.humanText());
    expect(receipt).toContain("already has exactly this membership");
    expect(receipt).not.toContain("(y/N)");
  });

  test("both modes express the same membership result", async () => {
    const explicitHome = await setupHome();
    const explicitStreams = capturedStreams();
    const explicitOutcome = await runConfigureCommand({
      home: explicitHome,
      arguments: ["profile", "coding", "--context", "team-rules", "--skill", "review-pr", "--auto-confirm"],
      stdout: explicitStreams.output as Writable & { isTTY?: boolean },
      stderr: explicitStreams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(explicitOutcome.exitCode).toBe(0);

    const interactiveHome = await setupHome();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runConfigureCommand({
      home: interactiveHome,
      arguments: ["profile", "coding"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });
    await waitForOutput(streams.humanText, "Which Context Modules?");
    input.write("\r");
    await waitForOutput(streams.humanText, "Which Skills?");
    input.write("review");
    await sleep(100);
    input.write(" ");
    await sleep(100);
    input.write("\r");
    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    const interactiveOutcome = await pending;
    expect(interactiveOutcome.exitCode).toBe(0);

    // The same intent through either mode writes byte-identical Profiles.
    expect(readFileSync(join(workspacePath(interactiveHome), "profiles", "coding.yaml"), "utf8")).toBe(
      readFileSync(join(workspacePath(explicitHome), "profiles", "coding.yaml"), "utf8"),
    );
  });

  test("the default answer declines without writing", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--context", "team-rules", "--skill", "review-pr"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "(y/N)");
    input.write("\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(profileFile, "utf8")).toBe(before);
    expect(plain(streams.errorText())).toContain("nothing was written (default answer no)");
  });

  test("cancelling at a picker writes nothing", async () => {
    const home = await setupHome();
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    const before = readFileSync(profileFile, "utf8");
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runConfigureCommand({
      home,
      arguments: [],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });

    await waitForOutput(streams.humanText, "Which Profile to configure?");
    input.end();
    const outcome = await pending;

    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(profileFile, "utf8")).toBe(before);
    expect(plain(streams.errorText())).toContain("cancelled before any write");
  });
});

describe("configure profile review-cycle pins", () => {
  test("a trailing positional after a single-value flag is the Profile name", async () => {
    const home = await setupHome();
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "--skill", "review-pr", "coding", "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(outcome.exitCode).toBe(0);
    expect(plain(streams.humanText())).toContain("coding");
    const workspace = await ingestSelectedWorkspace(home);
    expect(workspace.profiles.get("coding")!.skills).toEqual(["review-pr"]);
  });

  test("an omitted category keeps authored order in the receipt", async () => {
    const home = await setupHome();
    await createSkill({ home, name: "alpha-skill" });
    mkdirSync(join(workspacePath(home), "context"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "context", "extra-rules.md"),
      "---\nid: extra-rules\ndependencies: []\n---\nExtra.\n",
    );
    const profileFile = join(workspacePath(home), "profiles", "coding.yaml");
    writeFileSync(
      profileFile,
      "id: coding\ncontext:\n  - team-rules\n  - extra-rules\nskills:\n  - review-pr\n",
    );
    const streams = capturedStreams();
    const outcome = await runConfigureCommand({
      home,
      arguments: ["profile", "coding", "--skill", "alpha-skill", "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(outcome.exitCode).toBe(0);
    const text = plain(streams.humanText());
    expect(text).not.toContain("team-rules →");
    expect(text).toContain("review-pr → alpha-skill");
  });
});
