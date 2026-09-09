/**
 * The interactive bind command (US-051, US-053; US-033 selection-flow clause;
 * bind clauses of US-052, US-055–056; DEC-030–033, DEC-035; TEST-001, TEST-016,
 * TEST-019): prompts fire only on an interactive input stream and only for the
 * missing required Profile and Host arguments; a fully specified bind never
 * prompts; a completed flow prints the equivalent fully specified command;
 * cancellation records no configuration change; non-interactive missing
 * requirements remain errors.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { runBindCommand } from "../cli/bind-command.js";
import { PROFILE_EXPLANATION_SENTENCE } from "../cli/receipts.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-bind-test-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(prefix = "agent-profile-kit-bind-project-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
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

/** Remove the scaffolded example material, leaving an empty Workspace. */
function removeScaffoldedExample(home: string): void {
  rmSync(join(workspacePath(home), "profiles", "example.yaml"), { force: true });
  rmSync(join(workspacePath(home), "context", "example-context.md"), { force: true });
}

/** A fake interactive input stream: the prompt seam reads TTY evidence from it. */
function fakeInteractiveInput(): PassThrough & { isTTY: true } {
  const stream = new PassThrough() as PassThrough & { isTTY: true };
  stream.isTTY = true;
  return stream;
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

/** Versioned Host stubs whose output each Adapter's version resolver accepts. */
const HOST_STUB_VERSIONS: Readonly<Record<string, string>> = {
  antigravity: "agy 1.1.13 (fake)",
  claude: "2.1.0 (Claude Code)",
  codex: "codex-cli 0.145.0",
  opencode: "opencode 1.18.23 (fake)",
  pi: "pi 0.84.2",
};

/** A controlled PATH containing versioned stubs for the given Hosts plus system sh. */
function pathWithHosts(home: string, hosts: readonly string[]): NodeJS.ProcessEnv {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  for (const host of hosts) {
    const version = HOST_STUB_VERSIONS[host];
    if (version === undefined) throw new Error(`no controlled stub output for host '${host}'`);
    const executable = host === "antigravity" ? "agy" : host;
    writeFileSync(
      join(bin, executable),
      `#!/bin/sh
if [ "$#" -eq 0 ] || [ "$1" = "--version" ] || [ "$1" = "version" ]; then
  echo "${version}"
  exit 0
fi
echo "unexpected invocation: $*" >&2
exit 1
`,
    );
    execFileSync("chmod", ["+x", join(bin, executable)]);
  }
  return { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
}

/** Strip ANSI styling and collapse whitespace, so assertions stay structural. */
function plain(text: string): string {
  return text
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ");
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

interface StartedBind {
  readonly pending: Promise<{ exitCode: 0 | 1; streams: CapturedStreams }>;
  readonly streams: CapturedStreams;
}

/** Start the bind command without awaiting it, so tests can script the input. */
function startBind(
  home: string,
  arguments_: readonly string[],
  input: Readable,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): StartedBind {
  const streams = capturedStreams();
  const pending = runBindCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
  }).then((outcome) => ({ exitCode: outcome.exitCode, streams }));
  return { pending, streams };
}

describe("interactive bind prompts for missing required arguments", () => {
  test("asks for a missing Profile and Hosts, records the binding, and prints the equivalent command", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const { pending, streams } = startBind(home, [], input, {
      cwd: projectPath,
      env: pathWithHosts(home, ["codex"]),
    });

    await waitForOutput(streams.humanText, "Which Profile?");
    input.write("\r");
    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    input.write("\x1b[B\x1b[B \r");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const human = plain(streams.humanText());
    const explanationAt = human.indexOf(PROFILE_EXPLANATION_SENTENCE);
    const profileQuestionAt = human.indexOf("Which Profile?");
    expect(explanationAt).toBeGreaterThanOrEqual(0);
    expect(profileQuestionAt).toBeGreaterThan(explanationAt);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain(`project: ${realpathSync(projectPath)}`);
    expect(config).toContain("profile: coding");
    expect(config).toContain("- codex");
    expect(human).toContain(`apkit bind coding ${projectPath} --host codex`);
  }, 20_000);

  test("selects a later Profile through the shared select seam", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeProfile(home, "ops");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const { pending, streams } = startBind(home, [], input, {
      cwd: projectPath,
      env: pathWithHosts(home, ["codex"]),
    });

    await waitForOutput(streams.humanText, "Which Profile?");
    // Workspace profiles sort coding, example, ops: move down twice to ops,
    // then toggle the codex Host.
    input.write("\x1b[B\x1b[B\r");
    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    input.write("\x1b[B\x1b[B \r");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: ops");
    expect(streams.humanText()).toContain(`apkit bind ops ${projectPath} --host codex`);
  }, 20_000);

  test("prompts only for Hosts when the Profile argument is given", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const { pending, streams } = startBind(home, ["coding"], input, {
      cwd: projectPath,
      env: pathWithHosts(home, ["codex"]),
    });

    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    input.write("\x1b[B\x1b[B \r");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const human = plain(streams.humanText());
    expect(human).not.toContain(PROFILE_EXPLANATION_SENTENCE);
    expect(readFileSync(configPath(home), "utf8")).toContain(
      `project: ${realpathSync(projectPath)}`,
    );
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
    expect(human).toContain(`apkit bind coding ${projectPath} --host codex`);
  }, 20_000);
});

describe("interactive bind Host choices (US-053, TEST-016)", () => {
  test("distinguishes detected installed Hosts from absent ones", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const { pending, streams } = startBind(home, ["coding"], input, {
      cwd: projectPath,
      env: pathWithHosts(home, ["codex"]),
    });

    await waitForOutput(streams.humanText, "Which Agent Hosts?");
    const human = plain(streams.humanText());
    expect(human).toContain("codex (installed)");
    const absent = SUPPORTED_HOSTS.filter((host) => host !== "codex");
    expect(human).toContain(`${absent[0]} (not installed)`);

    input.write("\x1b[B\x1b[B \r");
    const { exitCode } = await pending;
    expect(exitCode).toBe(0);
  }, 30_000);
});

describe("fully specified and non-interactive bind never prompt", () => {
  test("a fully specified bind on an interactive stream bypasses prompts entirely", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    // The input ends immediately: a prompt could only cancel, so completion
    // itself proves the fully specified bind never waited for input.
    const input = fakeInteractiveInput();
    input.end();
    const { pending, streams } = startBind(
      home,
      ["coding", "--host", "codex"],
      input,
      { cwd: projectPath },
    );
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain(`project: ${realpathSync(projectPath)}`);
    expect(config).toContain("profile: coding");
    const human = plain(streams.humanText());
    expect(human).not.toContain(PROFILE_EXPLANATION_SENTENCE);
    expect(human).not.toContain("Which Profile?");
    expect(human).not.toContain("Which Agent Hosts?");
  }, 20_000);

  test("non-interactive bind keeps missing-argument errors", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    projectDirectory();

    const noArguments = await startBind(home, [], new PassThrough()).pending;
    expect(noArguments.exitCode).toBe(1);
    expect(noArguments.streams.errorText()).toContain("bind requires a Profile name");

    const noHosts = await startBind(home, ["coding"], new PassThrough()).pending;
    expect(noHosts.exitCode).toBe(1);
    expect(noHosts.streams.errorText()).toContain("--host");
  }, 20_000);
});

describe("cancellation records nothing (US-056, DEC-033)", () => {
  test("cancelling the Profile prompt records no configuration change", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const before = readFileSync(configPath(home), "utf8");
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    // The input ends before the question is asked: cancellation from any cause.
    input.end();
    const { pending, streams } = startBind(home, [], input, { cwd: projectPath });
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(readFileSync(configPath(home), "utf8")).toBe(before);
    expect(streams.errorText()).toContain("cancelled");
  }, 20_000);

  test("cancelling the Host prompt records no configuration change", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const before = readFileSync(configPath(home), "utf8");
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    input.end();
    const { pending } = startBind(home, ["coding"], input, { cwd: projectPath });
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(readFileSync(configPath(home), "utf8")).toBe(before);
  }, 20_000);
});

describe("unpromptable inventories fall back to errors", () => {
  test("an interactive bind with no Profiles to choose from errors instead of prompting", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    removeScaffoldedExample(home);
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    // The input ends immediately: if a prompt fired it could only cancel, so
    // the error path completing is itself the proof.
    const input = fakeInteractiveInput();
    input.end();
    const { pending, streams } = startBind(home, [], input, { cwd: projectPath });
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(streams.humanText()).not.toContain("Which Profile?");
    expect(streams.errorText()).toContain("Profile");
  }, 20_000);
});
