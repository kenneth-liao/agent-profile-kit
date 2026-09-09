/**
 * The interactive init command (US-054; US-045 interactive clauses; init
 * clauses of US-052, US-055–056; DEC-030–035; TEST-001, TEST-017, TEST-019):
 * optional first-Profile guidance fires only on an interactive input stream,
 * collects every flow decision before initialization commits any change, and
 * creates the Profile through the same scaffolding path as `apkit new`. A
 * completed flow prints the equivalent fully specified command; cancellation
 * records no configuration change or generated output.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { runInitCommand } from "../cli/init-command.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { WORKSPACE_MANIFEST } from "../schemas/workspace-manifest.js";

const temporaryDirectories: string[] = [];

function isolatedHome(prefix = "agent-profile-kit-init-test-"): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
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

/** Add existing Workspace material for guided selections beyond the scaffold. */
function writeMaterial(home: string, id: string): void {
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", `${id}.md`),
    `---\nid: ${id}\ndependencies: []\n---\nContent for ${id}.\n`,
  );
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

interface StartedInit {
  readonly pending: Promise<{ exitCode: 0 | 1; streams: CapturedStreams }>;
  readonly streams: CapturedStreams;
}

/** Start the init command without awaiting it, so tests can script the input. */
function startInit(
  home: string,
  arguments_: readonly string[],
  input: Readable,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): StartedInit {
  const streams = capturedStreams();
  const pending = runInitCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
    ...(options.env === undefined ? {} : { env: options.env }),
  }).then((outcome) => ({ exitCode: outcome.exitCode, streams }));
  return { pending, streams };
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

describe("guided first-Profile init", () => {
  test("accepts the offer, collects name and selections, and creates the Profile through the scaffolding path", async () => {
    const home = isolatedHome();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("y");
    await waitForOutput(streams.humanText, "What should the Profile be named?");
    input.write("my-profile\r");
    await waitForOutput(streams.humanText, "Which Context Modules?");
    input.write(" \r");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const profileFile = join(workspacePath(home), "profiles", "my-profile.yaml");
    expect(existsSync(configPath(home))).toBe(true);
    expect(existsSync(profileFile)).toBe(true);
    const profile = readFileSync(profileFile, "utf8");
    expect(profile).toContain('id: "my-profile"');
    expect(profile).toContain("- \"example-context\"");
    const human = plain(streams.humanText());
    expect(human).toContain("Created Profile my-profile");
    expect(human).toContain(profileFile);
    expect(human).toContain("Initialized Agent Profile Kit Workspace");
    expect(human).toContain("apkit new profile my-profile --context example-context");
  }, 20_000);

  test("declining the offer initializes normally without creating a Profile", async () => {
    const home = isolatedHome();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(home))).toBe(true);
    expect(existsSync(join(workspacePath(home), "profiles", "example.yaml"))).toBe(true);
    expect(existsSync(join(workspacePath(home), "profiles", "my-profile.yaml"))).toBe(false);
    expect(streams.errorText()).toBe("");
    expect(plain(streams.humanText())).not.toContain("What should the Profile be named?");
  }, 20_000);

  test("cancelling at the offer initializes nothing", async () => {
    const home = isolatedHome();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.end();
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(false);
    expect(plain(streams.errorText())).toContain("init was cancelled; nothing was initialized or created");
  }, 20_000);

  test("cancelling after answering the name initializes nothing", async () => {
    const home = isolatedHome();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("y");
    await waitForOutput(streams.humanText, "What should the Profile be named?");
    input.write("my-profile\r");
    await waitForOutput(streams.humanText, "Which Context Modules?");
    input.end();
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(false);
    expect(plain(streams.errorText())).toContain("init was cancelled; nothing was initialized or created");
  }, 20_000);

  test("non-interactive init never prompts and initializes normally", async () => {
    const home = isolatedHome();
    const input = new PassThrough(); // no TTY evidence: never interactive
    input.end();
    const { pending, streams } = startInit(home, [], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(home))).toBe(true);
    expect(existsSync(join(workspacePath(home), "profiles", "example.yaml"))).toBe(true);
    expect(plain(streams.humanText())).not.toContain("Set up your first Profile now?");
  }, 20_000);

  test("init with an existing Profile never offers the guidance", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home); // scaffolds the example Profile
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(home))).toBe(true);
    const human = plain(streams.humanText());
    expect(human).toContain("already initialized");
    expect(human).not.toContain("Set up your first Profile now?");
  }, 20_000);

  test("an invalid Profile name is refused before any initialization change", async () => {
    const home = isolatedHome();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("y");
    await waitForOutput(streams.humanText, "What should the Profile be named?");
    input.write("My Profile\r");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(false);
  }, 20_000);

  test("offers both categories when both have material and records the combined selection", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    rmSync(join(workspacePath(home), "profiles", "example.yaml"));
    writeMaterial(home, "team-rules");
    mkdirSync(join(workspacePath(home), "skills", "release-check"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "skills", "release-check", "SKILL.md"),
      '---\nname: "release-check"\ndescription: Check the release state.\n---\n\n# release-check\n',
    );
    writeConfig(home, workspacePath(home));
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("y");
    await waitForOutput(streams.humanText, "What should the Profile be named?");
    input.write("my-profile\r");
    await waitForOutput(streams.humanText, "Which Context Modules?");
    input.write("\r"); // no Context selected; both categories are available
    await waitForOutput(streams.humanText, "Which Skills?");
    input.write(" \r"); // select the highlighted Skill
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const profile = readFileSync(join(workspacePath(home), "profiles", "my-profile.yaml"), "utf8");
    expect(profile).toContain('id: "my-profile"');
    expect(profile).toContain("context: []");
    expect(profile).toContain('- "release-check"');
    expect(plain(streams.humanText())).toContain(
      "apkit new profile my-profile --skill release-check",
    );
  }, 20_000);

  test("refuses zero selections before any initialization change", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    rmSync(join(workspacePath(home), "profiles", "example.yaml"));
    writeMaterial(home, "team-rules");
    mkdirSync(join(workspacePath(home), "skills", "release-check"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "skills", "release-check", "SKILL.md"),
      '---\nname: "release-check"\ndescription: Check the release state.\n---\n\n# release-check\n',
    );
    writeConfig(home, workspacePath(home));
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("y");
    await waitForOutput(streams.humanText, "What should the Profile be named?");
    input.write("my-profile\r");
    await waitForOutput(streams.humanText, "Which Context Modules?");
    input.write("\r");
    await waitForOutput(streams.humanText, "Which Skills?");
    input.write("\r");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(join(workspacePath(home), "profiles", "my-profile.yaml"))).toBe(false);
    // The Workspace existed before this invocation; initialization did not run.
    expect(existsSync(join(workspacePath(home), "profiles", ".gitkeep"))).toBe(true);
    expect(plain(streams.errorText())).toContain("Profile");
  }, 20_000);

  test("a Workspace with no Context Modules skips the Context question and records the Skills-only selection", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    rmSync(join(workspacePath(home), "profiles", "example.yaml"));
    rmSync(join(workspacePath(home), "context", "example-context.md"));
    mkdirSync(join(workspacePath(home), "skills", "release-check"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "skills", "release-check", "SKILL.md"),
      '---\nname: "release-check"\ndescription: Check the release state.\n---\n\n# release-check\n',
    );
    writeConfig(home, workspacePath(home));
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("y");
    await waitForOutput(streams.humanText, "What should the Profile be named?");
    input.write("my-profile\r");
    await waitForOutput(streams.humanText, "Which Skills?");
    input.write(" \r");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(plain(streams.humanText())).not.toContain("Which Context Modules?");
    const profile = readFileSync(join(workspacePath(home), "profiles", "my-profile.yaml"), "utf8");
    expect(profile).toContain("context: []");
    expect(profile).toContain('- "release-check"');
    expect(plain(streams.humanText())).toContain("apkit new profile my-profile --skill release-check");
  }, 20_000);

  test("a conflicting explicit Workspace selection never enters guidance", async () => {
    const home = isolatedHome();
    const a = join(home, "workspace-a");
    const b = join(home, "workspace-b");
    await initializeWorkspace(home, { workspace: a }); // Local Configuration selects A
    writeMaterial(a, "team-rules");
    // B is a distinct valid Workspace with selectable material.
    mkdirSync(join(b, "context"), { recursive: true });
    mkdirSync(join(b, "profiles"), { recursive: true });
    writeFileSync(join(b, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(
      join(b, "context", "other.md"),
      "---\nid: other\ndependencies: []\n---\nContent for other.\n",
    );
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [b], input);

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    // Guidance never asked: the known-invalid selection keeps the delivered
    // initialization error (parity with non-interactive behavior).
    expect(failure).toBeInstanceOf(InstallerToolError);
    expect((failure as InstallerToolError).fact.kind).toBe("init-workspace-selection-conflict");
    expect(plain(streams.humanText())).not.toContain("Set up your first Profile now?");
    expect(existsSync(join(a, "profiles", "my-profile.yaml"))).toBe(false);
  }, 20_000);

  test("an explicit Workspace equivalent to the configured selection is eligible for guidance", async () => {
    const home = isolatedHome();
    const workspace = join(home, "configured");
    await initializeWorkspace(home, { workspace }); // Local Configuration selects it
    rmSync(join(workspace, "profiles", "example.yaml"));
    writeMaterial(workspace, "team-rules");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [workspace], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(plain(streams.humanText())).toContain("already initialized");
  }, 20_000);

  test("the scaffolded example Profile name is refused on a fresh destination before any write", async () => {
    const home = isolatedHome();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("y");
    await waitForOutput(streams.humanText, "What should the Profile be named?");
    input.write("example\r");
    await waitForOutput(streams.errorText, "Profile name 'example' is duplicated");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(false);
    expect(plain(streams.errorText())).toContain("Profile name 'example' is duplicated");
  }, 20_000);

  test("the scaffolded example Profile name is refused on an empty destination before any write", async () => {
    const home = isolatedHome();
    const empty = join(home, "empty-destination");
    mkdirSync(empty, { recursive: true });
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [empty], input);

    await waitForOutput(streams.humanText, "Set up your first Profile now?");
    input.write("y");
    await waitForOutput(streams.humanText, "What should the Profile be named?");
    input.write("example\r");
    await waitForOutput(streams.errorText, "Profile name 'example' is duplicated");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(join(empty, "workspace.yaml"))).toBe(false);
    expect(existsSync(configPath(home))).toBe(false);
    expect(plain(streams.errorText())).toContain("Profile name 'example' is duplicated");
  }, 20_000);
});
