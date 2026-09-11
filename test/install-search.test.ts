/**
 * Guided install through searchable choices (ticket #495, spec #491 US-001/
 * US-005/US-006, DEC-002/DEC-004): bare interactive `install` names its
 * target, collects only missing Profile/Host choices through searchable
 * pickers, and passes the selected values into the explicit #494 operation.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { runInstallCommand } from "../cli/install-command.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-search-home-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-search-project-"));
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

function writeConfig(home: string, workspace: string): void {
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspace}\nbindings: []\n`,
  );
}

function writeProfile(home: string, name: string): void {
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", `${name}.yaml`),
    `id: ${name}\ncontext:\n  - team-rules\nskills: []\n`,
  );
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

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  writeProfile(home, "coding");
  writeProfile(home, "ops");
  writeConfig(home, workspacePath(home));
  return home;
}

describe("guided install collects only missing choices", () => {
  test("bare interactive install names the target and installs the picked selection", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: [],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    // The bare install names its current-directory Project target first.
    await waitForOutput(streams.humanText, projectPath);
    // Searchable Profile choice: filter and submit.
    await waitForOutput(streams.humanText, "Which Profile?");
    input.write("cod");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    // Searchable Host choices: filter, toggle, submit.
    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    input.write("codex");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    // The proposed scope appears before confirmation.
    await waitForOutput(streams.humanText, "(y/N)");
    const proposed = plain(streams.humanText());
    expect(proposed).toContain("coding");
    expect(proposed).toContain("codex");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("profile: coding");
    expect(config).toContain("- codex");
    expect(readFileSync(
      join(projectPath, ".agent-profile-kit", "codex", "context.md"),
      "utf8",
    )).toContain("Always preserve the project boundary.");
    // Completion prints the executable fully specified equivalent.
    const receipt = plain(streams.humanText());
    expect(receipt).toContain("apkit install coding");
    expect(receipt).toContain("--host codex");
    expect(receipt).toContain("--auto-confirm");
  });
});

describe("guided install skips supplied choices", () => {
  test("a supplied Profile skips its picker and keeps the Host picker", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: ["coding"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    expect(plain(streams.humanText())).not.toContain("Which Profile?");
    input.write("codex");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("profile: coding");
    expect(config).toContain("- codex");
  });

  test("supplied Hosts skip their picker and keep the Profile picker", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: ["--host", "codex"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    await waitForOutput(streams.humanText, "Which Profile?");
    expect(plain(streams.humanText())).not.toContain("Which Agent Hosts?");
    input.write("ops");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "(y/N)");
    const proposed = plain(streams.humanText());
    expect(proposed).toContain("ops");
    expect(proposed).toContain("codex");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: ops");
  });
});

describe("guided install Host defaults", () => {
  test("a new installation starts with nothing checked", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: ["coding"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    // An empty submit is refused (Hosts are required): the picker stays open.
    // Toggling then selects exactly the first Host — proving no silent
    // all-detected default, which would have submitted on the first enter.
    input.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("- antigravity");
    expect(config).not.toContain("- codex");
    // A new installation names no current selection.
    expect(plain(streams.humanText())).not.toContain("Current selection");
  });

  test("an existing installation pre-checks its Hosts", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: ops\n    hosts:\n      - claude\n`,
    );
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: ["coding"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    // The existing Host is pre-checked: submitting immediately keeps it.
    input.write("\r");
    await waitForOutput(streams.humanText, "(y/N)");
    const proposed = plain(streams.humanText());
    expect(proposed).toContain("ops → coding");
    expect(proposed).toContain("claude");
    // The existing selection was shown before any picker opened.
    expect(proposed).toContain("Current selection");
    expect(proposed).toContain("Profile ops");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("profile: coding");
    expect(config).toContain("- claude");
  });
});

describe("guided install cancellation", () => {
  test("cancelling the Profile picker writes nothing", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: [],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    await waitForOutput(streams.humanText, "Which Profile?");
    input.end();
    const outcome = await pending;

    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("cancelled");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("cancelling the Host picker writes nothing", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: ["coding"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    input.end();
    const outcome = await pending;

    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("cancelled");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("declining the confirmation after picking writes nothing", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: [],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    await waitForOutput(streams.humanText, "Which Profile?");
    input.write("cod");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    input.write("codex");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "(y/N)");
    input.write("n\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("you answered no");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });
});

describe("guided install Host detection", () => {
  function stubBin(): string {
    const bin = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-search-bin-"));
    temporaryDirectories.push(bin);
    writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex-cli 0.145.0"\n`, { mode: 0o755 });
    return bin;
  }

  test("detected Hosts carry advisory evidence while undetected Hosts stay selectable", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    // Hermetic PATH: only the codex stub detects, so every label is exact.
    const bin = stubBin();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: ["coding"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: bin },
    });

    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    // Advisory detection is stated up front; the picker titles stay bare
    // Host identities so filtering matches the Host, never the evidence.
    expect(plain(streams.humanText())).toContain("Detected Agent Hosts: codex");
    // An undetected Host remains selectable through the same picker.
    input.write("opencode");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toContain("- opencode");
  });
});

describe("guided install changed-file consent", () => {
  test("a guided reinstall over drifted output authorizes replacement with its echo", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const streams = capturedStreams();
    const installed = await runInstallCommand({
      home,
      arguments: ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: new PassThrough(),
    });
    expect(installed.exitCode).toBe(0);
    const outputPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(outputPath, "hand-edited by the user\n");

    const input = fakeInteractiveInput();
    const guided = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: ["coding", projectPath],
      stdout: guided.output as Writable & { isTTY?: boolean },
      stderr: guided.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    // The existing Host stays pre-checked: submit immediately.
    await waitForOutput(guided.humanText, "Which Agent Hosts?");
    expect(plain(guided.humanText())).not.toContain("Which Profile?");
    input.write("\r");
    await waitForOutput(guided.humanText, "(y/N)");
    input.write("y\n");
    await waitForOutput(guided.humanText, "Changed generated files:");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("Always preserve the project boundary.");
    const receipt = plain(guided.humanText());
    expect(receipt).toContain("--replace-changed");
    expect(receipt).toContain("--auto-confirm");
  });
});

describe("guided install refusals", () => {
  test("missing choices with --json refuse instead of prompting", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const streams = capturedStreams();

    const outcome = await runInstallCommand({
      home,
      arguments: ["--json"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: fakeInteractiveInput(),
      cwd: projectPath,
      env: { PATH: "" },
    });

    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("Profile");
    expect(plain(streams.humanText())).not.toContain("Which Profile?");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
  });
});

describe("guided install with no Profiles", () => {
  test("a Workspace with no Profiles refuses before any write", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    // Remove the scaffolded example Profiles: nothing to choose from.
    rmSync(join(workspacePath(home), "profiles"), { recursive: true, force: true });
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    const streams = capturedStreams();

    const outcome = await runInstallCommand({
      home,
      arguments: [],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: fakeInteractiveInput(),
      cwd: projectPath,
      env: { PATH: "" },
    });

    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("no Profiles");
    expect(plain(streams.humanText())).not.toContain("Which Profile?");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });
});

describe("guided install executable equivalent", () => {
  test("a Project path with spaces echoes as one quoted token", async () => {
    const home = await setupHome();
    const base = projectDirectory();
    const projectPath = join(base, "My Projects", "app");
    mkdirSync(projectPath, { recursive: true });
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: [],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    await waitForOutput(streams.humanText, "Which Profile?");
    input.write("cod");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    input.write("codex");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    // The echoed equivalent must parse as one Project token in a shell:
    // the resolved canonical path, single-quoted.
    expect(plain(streams.humanText())).toContain(`'${realpathSync(projectPath)}'`);
  });
});

describe("guided install DEC-004", () => {
  test("--auto-confirm on a TTY still opens the missing-choice pickers", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const streams = capturedStreams();
    const pending = runInstallCommand({
      home,
      arguments: ["--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
      cwd: projectPath,
      env: { PATH: "" },
    });

    // --auto-confirm answers only the general confirmation: both pickers
    // still open for the missing choices.
    await waitForOutput(streams.humanText, "Which Profile?");
    input.write("cod");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    input.write("codex");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 100));
    input.write("\r");
    const outcome = await pending;

    expect(outcome.exitCode).toBe(0);
    // The general confirmation was answered, never asked.
    expect(plain(streams.humanText())).not.toContain("(y/N)");
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("profile: coding");
    expect(config).toContain("- codex");
  });
});
