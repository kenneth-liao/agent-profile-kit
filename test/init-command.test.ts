/**
 * The interactive init command (US-054; US-045 interactive clauses; init
 * clauses of US-052, US-055–056; DEC-030–035; TEST-001, TEST-017, TEST-019):
 * setup and connection name the Workspace and, when written, Local
 * Configuration, list only the parts actually added, and route the handoff
 * from the resulting content (spec #640 US-002). Setup never creates or
 * guides a first Profile. Cancellation records no configuration change or
 * generated output.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return join(home, "apkit-workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function writeConfig(home: string, workspace: string): void {
  mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspace}\nbindings: []\n`,
  );
}

function writeLegacyConfig(home: string, content: string): string {
  const config = configPath(home);
  mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
  writeFileSync(config, content);
  return config;
}

/** Add existing Workspace material for guided selections beyond the scaffold. */
function writeMaterial(home: string, id: string): void {
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", `${id}.md`),
    `Content for ${id}.\n`,
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
  options: { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string } = {},
): StartedInit {
  const streams = capturedStreams();
  const pending = runInitCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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

/** A fixture destination with material but no Profile (spec #640 US-002). */
function writeMaterialWithoutProfile(home: string): void {
  mkdirSync(join(workspacePath(home), "skills"), { recursive: true });
  writeFileSync(join(workspacePath(home), "workspace.yaml"), WORKSPACE_MANIFEST);
  writeMaterial(home, "team-rules");
  writeConfig(home, workspacePath(home));
}

describe("setup handoff routes from the resulting content (#646, US-002)", () => {
  test("fresh setup with zero Profiles and no Context prints the Context-then-Profile chain and never offers a first Profile", async () => {
    const home = isolatedHome();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [workspacePath(home)], input);

    await waitForOutput(streams.humanText, "stored in and loaded from");
    expect(plain(streams.humanText())).not.toContain("Set up your first Profile now?");
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(home))).toBe(true);
    expect(existsSync(join(workspacePath(home), "profiles", "my-profile.yaml"))).toBe(false);
    const human = plain(streams.humanText());
    // Names the Workspace and Local Configuration when written.
    expect(human).toContain("apkit-workspace");
    expect(human).toContain("config.yaml");
    // Lists only the parts actually missing and added.
    expect(human).toContain("workspace.yaml");
    expect(human).toContain("context/");
    expect(human).toContain("skills/");
    expect(human).toContain("profiles/");
    // Concept sentences stay (spec #645).
    expect(human).toContain("A Profile is a named selection of Context and Skills");
    expect(human).toContain("Context is always-loaded facts");
    // Zero Profiles, no Context: the creation chain (spec #640 US-002).
    expect(human).toContain("apkit new context <context>");
    expect(human).toContain("apkit new profile <name> --context <context>");
    // Setup just validated; never recommend `apkit validate` (US-002).
    expect(human).not.toContain("apkit validate");
    expect(human).not.toContain("Set up your first Profile now?");
  }, 20_000);

  test("zero Profiles with existing Context print only the Profile creation command and name no Context", async () => {
    // First connection of a folder that already has Context and no Profile
    // (DEC-005): the handoff drops the new-context step and names no Context.
    const home = isolatedHome();
    const workspace = join(home, "material");
    mkdirSync(join(workspace, "context"), { recursive: true });
    mkdirSync(join(workspace, "skills"), { recursive: true });
    mkdirSync(join(workspace, "profiles"), { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(workspace, "context", "team-rules.md"), "Team rules.\n");
    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, [workspace], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(join(workspace, "profiles", "my-profile.yaml"))).toBe(false);
    const human = plain(streams.humanText());
    expect(human).not.toContain("Set up your first Profile now?");
    expect(human).not.toContain("apkit new context");
    expect(human).toContain("apkit new profile <name> --context <context>");
    // Never invent or pick an existing Context (US-002).
    expect(human).not.toContain("team-rules");
    expect(human).not.toContain("apkit validate");
  }, 20_000);

  test("one Profile routes to bare install without naming a Profile", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
    writeMaterial(home, "team-rules");
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "context: [team-rules]\nskills: []\n",
    );
    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, [], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const human = plain(streams.humanText());
    expect(human).toContain("already initialized");
    expect(human).not.toContain("apkit validate");
    expect(human).not.toContain("apkit new profile");
  }, 20_000);

  test("connecting a Workspace with zero Profiles and existing Context routes to Profile creation", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    // A has a Profile; B has Context and no Profile.
    mkdirSync(join(wsA, "context"), { recursive: true });
    mkdirSync(join(wsA, "profiles"), { recursive: true });
    mkdirSync(join(wsA, "skills"), { recursive: true });
    writeFileSync(join(wsA, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(wsA, "context", "team-rules.md"), "Team rules.\n");
    writeFileSync(join(wsA, "profiles", "coding.yaml"), "context: [team-rules]\nskills: []\n");
    mkdirSync(join(wsB, "context"), { recursive: true });
    mkdirSync(join(wsB, "profiles"), { recursive: true });
    mkdirSync(join(wsB, "skills"), { recursive: true });
    writeFileSync(join(wsB, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(wsB, "context", "ops-rules.md"), "Ops rules.\n");
    writeConfig(home, wsA);

    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, [wsB], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const human = plain(streams.humanText());
    expect(human).toContain("Connected Agent Profile Kit Workspace");
    expect(human).toContain("apkit new profile <name> --context <context>");
    expect(human).not.toContain("apkit new context");
    expect(human).not.toContain("apkit validate");
    expect(human).not.toContain("ops-rules");
  }, 20_000);

  test("connecting a Workspace with one or more Profiles routes to bare install", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    mkdirSync(join(wsA, "context"), { recursive: true });
    mkdirSync(join(wsA, "profiles"), { recursive: true });
    mkdirSync(join(wsA, "skills"), { recursive: true });
    writeFileSync(join(wsA, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeConfig(home, wsA);
    mkdirSync(join(wsB, "context"), { recursive: true });
    mkdirSync(join(wsB, "profiles"), { recursive: true });
    mkdirSync(join(wsB, "skills"), { recursive: true });
    writeFileSync(join(wsB, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(wsB, "context", "team-rules.md"), "Team rules.\n");
    writeFileSync(join(wsB, "profiles", "one.yaml"), "context: [team-rules]\nskills: []\n");
    writeFileSync(join(wsB, "profiles", "two.yaml"), "context: [team-rules]\nskills: []\n");

    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, [wsB], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const human = plain(streams.humanText());
    expect(human).toContain("Connected Agent Profile Kit Workspace");
    expect(human).toContain("apkit install");
    expect(human).not.toContain("apkit install one");
    expect(human).not.toContain("apkit install two");
    expect(human).not.toContain("apkit new profile");
    expect(human).not.toContain("apkit validate");
  }, 20_000);

  test("a fresh destination without material initializes without any guidance offer", async () => {
    const home = isolatedHome();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [workspacePath(home)], input);

    await waitForOutput(streams.humanText, "stored in and loaded from");
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(home))).toBe(true);
    for (const directory of ["context", "profiles", "skills"]) {
      expect(existsSync(join(workspacePath(home), directory))).toBe(true);
    }
    expect(existsSync(join(workspacePath(home), "profiles", "example.yaml"))).toBe(false);
    expect(plain(streams.humanText())).not.toContain("Set up your first Profile now?");
  }, 20_000);

  test("non-interactive init never prompts and initializes normally", async () => {
    const home = isolatedHome();
    const input = new PassThrough(); // no TTY evidence: never interactive
    input.end();
    const { pending, streams } = startInit(home, [workspacePath(home)], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(home))).toBe(true);
    expect(existsSync(join(workspacePath(home), "profiles", "example.yaml"))).toBe(false);
    expect(plain(streams.humanText())).not.toContain("Set up your first Profile now?");
    expect(plain(streams.humanText())).not.toContain("apkit validate");
  }, 20_000);

  test("declining to connect a different Workspace never enters a Profile offer", async () => {
    const home = isolatedHome();
    const a = join(home, "workspace-a");
    const b = join(home, "workspace-b");
    await initializeWorkspace(home, { workspace: a });
    writeMaterial(a, "team-rules");
    mkdirSync(join(b, "context"), { recursive: true });
    mkdirSync(join(b, "profiles"), { recursive: true });
    mkdirSync(join(b, "skills"), { recursive: true });
    writeFileSync(join(b, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(b, "context", "other.md"), "Content for other.\n");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [b], input);

    await waitForOutput(streams.humanText, "Current Workspace:");
    expect(plain(streams.humanText())).toContain("Requested Workspace:");
    input.write("n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(plain(streams.humanText())).not.toContain("Set up your first Profile now?");
    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${a}`);
  }, 20_000);

});

describe("zero-argument init requires a user-given location", () => {
  async function refusedInit(home: string, arguments_: readonly string[] = []): Promise<InstallerToolError> {
    const input = new PassThrough(); // no TTY evidence
    input.end();
    const { pending } = startInit(home, arguments_, input);
    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InstallerToolError);
    return failure as InstallerToolError;
  }

  test("a fresh home refuses and writes nothing", async () => {
    const home = isolatedHome();
    const failure = await refusedInit(home);
    expect(failure.fact.kind).toBe("init-workspace-path-required");
    // Nothing written anywhere: no application directories, no Workspace, no
    // former default folder (ISC-25.1, AC4).
    expect(existsSync(join(home, ".agents"))).toBe(false);
    expect(existsSync(join(home, "apkit-workspace"))).toBe(false);
  }, 20_000);

  test("a legacy configuration without workspace is never upgraded without a path", async () => {
    const home = isolatedHome();
    const legacy = "schema_version: 1\n# keep this note\nbindings: []\n";
    const config = writeLegacyConfig(home, legacy);
    const failure = await refusedInit(home);
    expect(failure.fact.kind).toBe("init-workspace-path-required");
    // The legacy file is untouched and no default Workspace folder appeared.
    expect(readFileSync(config, "utf8")).toBe(legacy);
    expect(existsSync(join(home, "apkit-workspace"))).toBe(false);
  }, 20_000);

  test("a configured machine still validates its selected Workspace without a path", async () => {
    const home = isolatedHome();
    const workspace = join(home, "configured");
    await initializeWorkspace(home, { workspace }); // Local Configuration selects it
    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, [], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(plain(streams.humanText())).toContain("already initialized");
  }, 20_000);

  test("a legacy configuration without workspace upgrades to the path the user gives, keeps its Project Bindings, and completes the missing directories", async () => {
    const home = isolatedHome();
    const legacy = "schema_version: 1\n# keep this note\nbindings: []\n";
    const config = writeLegacyConfig(home, legacy);
    // A manifest-present folder missing its artifact directories: the legacy
    // upgrade is a first connection at a user-given path, so setup completes
    // them (PR #617 review INT-1).
    const chosen = join(home, "chosen");
    mkdirSync(chosen, { recursive: true });
    writeFileSync(join(chosen, "workspace.yaml"), WORKSPACE_MANIFEST);
    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, ["~/chosen"], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    for (const directory of ["context", "skills", "profiles"]) {
      expect(existsSync(join(chosen, directory))).toBe(true);
    }
    const migrated = readFileSync(config, "utf8");
    expect(migrated).toMatch(/schema_version:\s*2/);
    expect(migrated).toContain("workspace: ~/chosen");
    expect(migrated).toContain("# keep this note");
    expect(migrated).toContain("bindings: []");
    expect(plain(streams.humanText())).toMatch(/migrat/i);
  }, 20_000);

  test("an invalid folder at the user-given path refuses the legacy upgrade before any write", async () => {
    const home = isolatedHome();
    const legacy = "schema_version: 1\nbindings: []\n";
    const config = writeLegacyConfig(home, legacy);
    const chosen = join(home, "chosen");
    mkdirSync(join(chosen, "skills", "broken"), { recursive: true });
    // An invalid Skill frontmatter: the folder can never validate.
    writeFileSync(join(chosen, "skills", "broken", "SKILL.md"), "no frontmatter\n");
    const input = new PassThrough();
    input.end();
    const { pending } = startInit(home, ["~/chosen"], input);
    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(readFileSync(config, "utf8")).toBe(legacy);
    // No missing part was added and no default Workspace folder appeared.
    expect(existsSync(join(chosen, "workspace.yaml"))).toBe(false);
    expect(existsSync(join(chosen, "context"))).toBe(false);
    expect(existsSync(join(home, "apkit-workspace"))).toBe(false);
  }, 20_000);

});

/**
 * Interactive setup asks where the Workspace goes and confirms the chosen
 * folder before any write (spec #593 #603, US-001, US-002, ISC-24.1–24.2,
 * ISC-27.3, ISC-33). The prompt seam drives the flow on injectable streams;
 * `test/init-pty.test.ts` qualifies keyboard behavior and 100/60-column
 * rendering through a real PTY.
 */
/**
 * The TEST-003 TTY rows: one file-tree snapshot of paths, bytes, and modes,
 * so any write beyond the added required parts fails the comparison.
 */
function fileTreeSnapshot(root: string): Map<string, { readonly bytes: string; readonly mode: number }> {
  const snapshot = new Map<string, { readonly bytes: string; readonly mode: number }>();
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        snapshot.set(`${relative}/`, { bytes: "", mode: 0 });
        visit(join(directory, entry.name), relative);
      } else {
        const stats = lstatSync(join(directory, entry.name));
        snapshot.set(relative, {
          bytes: readFileSync(join(directory, entry.name)).toString("base64"),
          mode: stats.mode & 0o777,
        });
      }
    }
  };
  visit(root, "");
  return snapshot;
}

describe("interactive setup asks and confirms the Workspace folder (#603)", () => {
  test("offers the current folder by its full path and initializes at it after confirmation", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome("init-cwd-");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input, { cwd });

    // The location question shows the current folder's full path (ISC-24.2)
    // and nothing is written while it waits (ISC-24.1).
    await waitForOutput(streams.humanText, "Current folder:");
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(false);
    input.write("y");
    await waitForOutput(streams.humanText, "stored in and loaded from");
    // Waiting at the confirmation writes nothing: the file tree and Local
    // Configuration match the starting state (ISC-24.1).
    expect(existsSync(configPath(home))).toBe(false);
    expect(fileTreeSnapshot(cwd).size).toBe(0);
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    // Every missing part was added at the confirmed folder, and the
    // configuration records the resolved absolute folder (ISC-26).
    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(true);
    for (const directory of ["context", "skills", "profiles"]) {
      expect(existsSync(join(cwd, directory))).toBe(true);
    }
    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${cwd}`);
    const human = plain(streams.humanText());
    expect(human).toContain(cwd);
  }, 20_000);

  test("choosing another path prompts for the folder and records the home-relative spelling", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome("init-cwd-");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input, { cwd });

    await waitForOutput(streams.humanText, "Current folder:");
    input.write("n");
    await waitForOutput(streams.humanText, "Which folder should be your Workspace?");
    input.write("~/apkit-workspace\r");
    await waitForOutput(streams.humanText, "Setup will add");
    // The typed folder does not exist yet; setup will create it.
    expect(plain(streams.humanText())).toContain("The folder does not exist yet; setup will create it.");
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(join(home, "apkit-workspace", "workspace.yaml"))).toBe(true);
    // The home-relative spelling is kept in the recording (ADR-0047).
    expect(readFileSync(configPath(home), "utf8")).toContain("workspace: ~/apkit-workspace");
    expect(plain(streams.humanText())).toContain("~/apkit-workspace");
  }, 20_000);

  test("cancelling at the location question writes nothing", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome("init-cwd-");
    const input = fakeInteractiveInput();
    const first = startInit(home, [], input, { cwd });

    await waitForOutput(first.streams.humanText, "Current folder:");
    input.end();
    const { exitCode } = await first.pending;

    expect(exitCode).toBe(1);
    expect(existsSync(configPath(home))).toBe(false);
    expect(fileTreeSnapshot(cwd).size).toBe(0);
    expect(plain(first.streams.errorText())).toContain(
      "Setup was cancelled; nothing was initialized or created.",
    );
    // A plain cancel prints only the neutral statement (US-003, US-010).
    expect(plain(first.streams.errorText())).not.toContain("apkit init");
  }, 20_000);

  test("cancelling at the folder prompt writes nothing", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome("init-cwd-");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input, { cwd });

    await waitForOutput(streams.humanText, "Current folder:");
    input.write("n");
    await waitForOutput(streams.humanText, "Which folder should be your Workspace?");
    input.end();
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(configPath(home))).toBe(false);
    expect(fileTreeSnapshot(cwd).size).toBe(0);
    expect(plain(streams.errorText())).toContain(
      "Setup was cancelled; nothing was initialized or created.",
    );
  }, 20_000);

  test("cancelling at the confirmation writes nothing", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome("init-cwd-");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input, { cwd });

    await waitForOutput(streams.humanText, "Current folder:");
    input.write("y");
    await waitForOutput(streams.humanText, "stored in and loaded from");
    input.end();
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(configPath(home))).toBe(false);
    expect(fileTreeSnapshot(cwd).size).toBe(0);
  }, 20_000);

  test("declining the confirmation writes nothing and exits neutrally", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome("init-cwd-");
    writeFileSync(join(cwd, "notes.txt"), "user material\n");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input, { cwd });

    await waitForOutput(streams.humanText, "Current folder:");
    input.write("y");
    await waitForOutput(streams.humanText, "stored in and loaded from");
    input.write("n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(home))).toBe(false);
    const tree = fileTreeSnapshot(cwd);
    expect(tree.size).toBe(1);
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("user material\n");
    // Declining is a safe, neutral outcome: no error diagnostic on stderr.
    expect(streams.errorText()).toBe("");
  }, 20_000);
});

describe("the setup confirmation content and scope (#603)", () => {
  test("lists the missing parts for a folder with unrelated files and adds exactly them", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome("init-cwd-");
    writeFileSync(join(cwd, "notes.txt"), "user material\n");
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src", "app.ts"), "export {};\n");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input, { cwd });

    await waitForOutput(streams.humanText, "Current folder:");
    input.write("y");
    await waitForOutput(streams.humanText, "Setup will add");
    const confirmation = plain(streams.humanText());
    // Every required part is named, in full.
    expect(confirmation).toContain("workspace.yaml");
    expect(confirmation).toContain("context/");
    expect(confirmation).toContain("skills/");
    expect(confirmation).toContain("profiles/");
    // The current folder exists; setup never creates it.
    expect(confirmation).not.toContain("The folder does not exist yet");
    expect(confirmation).toContain(cwd);
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    // Accepting adds every missing part and nothing the contract does not
    // require (ISC-27.1, ISC-27.2).
    expect(existsSync(join(cwd, "workspace.yaml"))).toBe(true);
    for (const directory of ["context", "skills", "profiles"]) {
      expect(existsSync(join(cwd, directory))).toBe(true);
    }
    expect(existsSync(join(cwd, "notes.txt"))).toBe(true);
    expect(existsSync(join(cwd, "src", "app.ts"))).toBe(true);
  }, 20_000);

  test("lists exactly the still-missing parts for an incomplete Workspace and completes it", async () => {
    const home = isolatedHome();
    const chosen = join(home, "chosen");
    mkdirSync(chosen, { recursive: true });
    // A manifest-present folder missing its artifact directories (PR #617
    // review INT-1 shape): the confirmation lists only those directories.
    writeFileSync(join(chosen, "workspace.yaml"), WORKSPACE_MANIFEST);
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [chosen], input);

    await waitForOutput(streams.humanText, "Setup will add");
    const confirmation = plain(streams.humanText());
    expect(confirmation).toContain("context/");
    expect(confirmation).toContain("skills/");
    expect(confirmation).toContain("profiles/");
    expect(confirmation).not.toContain("The folder does not exist yet");
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    for (const directory of ["context", "skills", "profiles"]) {
      expect(existsSync(join(chosen, directory))).toBe(true);
    }
  }, 20_000);

  test("connecting a complete valid Workspace with a TTY adds nothing and changes no files", async () => {
    const home = isolatedHome();
    const workspace = join(home, "valid");
    mkdirSync(join(workspace, "context"), { recursive: true });
    mkdirSync(join(workspace, "skills", "release-check"), { recursive: true });
    mkdirSync(join(workspace, "profiles"), { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(workspace, "context", "team-rules.md"), "Team rules.\n");
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "context:\n  - team-rules\nskills:\n  - release-check\n",
    );
    writeFileSync(
      join(workspace, "skills", "release-check", "SKILL.md"),
      '---\nname: "release-check"\ndescription: Check the release state.\n---\n\n# release-check\n',
    );
    const before = fileTreeSnapshot(workspace);
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [workspace], input);

    // The confirmation states that nothing needs to be added (ISC-33).
    await waitForOutput(streams.humanText, "Nothing needs to be added");
    expect(fileTreeSnapshot(workspace)).toEqual(before);
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${workspace}`);
    // Connecting never changes the Workspace's files (ISC-33).
    expect(fileTreeSnapshot(workspace)).toEqual(before);
    // A first connection at a fully valid folder writes the configuration
    // and nothing else (US-002, ISC-27.2).
    expect(plain(streams.humanText())).toContain("Initialized Agent Profile Kit Workspace at");
    expect(plain(streams.humanText())).toContain("settings:");
    expect(existsSync(join(workspace, "profiles", "example.yaml"))).toBe(false);
  }, 20_000);

  test("an invalid folder is refused with its violation before any prompt or write", async () => {
    const home = isolatedHome();
    const chosen = join(home, "chosen");
    mkdirSync(join(chosen, "skills", "broken"), { recursive: true });
    writeFileSync(join(chosen, "skills", "broken", "SKILL.md"), "no frontmatter\n");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [chosen], input);
    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(existsSync(configPath(home))).toBe(false);
    expect(fileTreeSnapshot(chosen).size).toBeGreaterThan(0);
    expect(existsSync(join(chosen, "workspace.yaml"))).toBe(false);
    expect(existsSync(join(chosen, "context"))).toBe(false);
    expect(plain(streams.humanText())).not.toContain("Set up this folder as your Workspace?");
  }, 20_000);

  test("a legacy configuration without workspace upgrades to the confirmed folder interactively", async () => {
    const home = isolatedHome();
    const config = configPath(home);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const legacy = "schema_version: 1\n# keep this note\nbindings: []\n";
    writeFileSync(config, legacy);
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input);

    await waitForOutput(streams.humanText, "Current folder:");
    input.write("n");
    await waitForOutput(streams.humanText, "Which folder should be your Workspace?");
    input.write("~/chosen\r");
    await waitForOutput(streams.humanText, "stored in and loaded from");
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    for (const directory of ["context", "skills", "profiles"]) {
      expect(existsSync(join(home, "chosen", directory))).toBe(true);
    }
    const migrated = readFileSync(config, "utf8");
    expect(migrated).toMatch(/schema_version:\s*2/);
    expect(migrated).toContain("workspace: ~/chosen");
    expect(migrated).toContain("# keep this note");
    expect(migrated).toContain("bindings: []");
    expect(plain(streams.humanText())).toMatch(/migrat/i);
  }, 20_000);

  test("confirming material without a Profile routes to Profile creation and never offers a first Profile", async () => {
    const home = isolatedHome();
    const workspace = join(home, "material");
    mkdirSync(join(workspace, "context"), { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(workspace, "context", "team-rules.md"), "Team rules.\n");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [workspace], input);

    // Confirmation only (US-001); setup does not create or guide a first
    // Profile (spec #640 US-002, OOS-002).
    await waitForOutput(streams.humanText, "Set up this folder as your Workspace?");
    expect(plain(streams.humanText())).not.toContain("Set up your first Profile now?");
    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(configPath(home))).toBe(true);
    expect(existsSync(join(workspace, "profiles", "my-profile.yaml"))).toBe(false);
    const human = plain(streams.humanText());
    expect(human).not.toContain("Set up your first Profile now?");
    expect(human).toContain("apkit new profile <name> --context <context>");
    expect(human).not.toContain("apkit new context");
    expect(human).not.toContain("apkit validate");
  }, 20_000);

  test("an empty typed folder path is refused before any write", async () => {
    const home = isolatedHome();
    const cwd = isolatedHome("init-cwd-");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [], input, { cwd });

    await waitForOutput(streams.humanText, "Current folder:");
    input.write("n");
    await waitForOutput(streams.humanText, "Which folder should be your Workspace?");
    input.write("\r");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(existsSync(configPath(home))).toBe(false);
    expect(fileTreeSnapshot(cwd).size).toBe(0);
  }, 20_000);
});

describe("connect a different Workspace (#607)", () => {
  function writeWorkspaceMaterial(ws: string, profile = "example"): void {
    mkdirSync(join(ws, "context"), { recursive: true });
    mkdirSync(join(ws, "skills", "test-skill"), { recursive: true });
    mkdirSync(join(ws, "profiles"), { recursive: true });
    writeFileSync(join(ws, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(ws, "context", "team-rules.md"), "Team rules.\n");
    writeFileSync(
      join(ws, "profiles", `${profile}.yaml`),
      `context:\n  - team-rules\nskills:\n  - test-skill\n`,
    );
    writeFileSync(
      join(ws, "skills", "test-skill", "SKILL.md"),
      '---\nname: "test-skill"\ndescription: Test skill.\n---\n\n# test-skill\n',
    );
  }

  test("connecting a different Workspace works without a TTY and keeps every Project Binding", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    writeWorkspaceMaterial(wsA, "coding");
    writeWorkspaceMaterial(wsB, "coding");
    writeConfig(home, wsA);
    // Add Project Bindings in Local Configuration
    const cfg = configPath(home);
    writeFileSync(
      cfg,
      `schema_version: 2\nworkspace: ${wsA}\nbindings:\n  - project: ~/projects/alpha\n    profile: coding\n    hosts:\n      - codex\n  - project: ~/projects/beta\n    profile: coding\n    hosts:\n      - claude\n`,
    );

    const beforeA = fileTreeSnapshot(wsA);
    const beforeB = fileTreeSnapshot(wsB);
    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, [wsB], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    // Config now selects wsB
    const savedConfig = readFileSync(cfg, "utf8");
    expect(savedConfig).toContain(`workspace: ${wsB}`);
    expect(savedConfig).toContain("project: ~/projects/alpha");
    expect(savedConfig).toContain("project: ~/projects/beta");
    // Workspaces are unchanged
    expect(fileTreeSnapshot(wsA)).toEqual(beforeA);
    expect(fileTreeSnapshot(wsB)).toEqual(beforeB);
    expect(plain(streams.humanText())).toContain("Connected Agent Profile Kit Workspace");
  }, 20_000);

  test("interactively, current and requested Workspace are shown before confirmation, and declining changes nothing", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    writeWorkspaceMaterial(wsA, "coding");
    writeWorkspaceMaterial(wsB, "coding");
    writeConfig(home, wsA);
    const cfg = configPath(home);
    const initialConfig = readFileSync(cfg, "utf8");

    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [wsB], input);

    // Shows current and requested Workspace before confirming
    await waitForOutput(streams.humanText, "Current Workspace:");
    const human = plain(streams.humanText());
    expect(human).toContain("~/ws-a");
    expect(human).toContain("Requested Workspace:");
    expect(human).toContain("~/ws-b");
    expect(human).toContain("Set up this folder as your Workspace?");

    // Declining changes nothing
    input.write("n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(readFileSync(cfg, "utf8")).toBe(initialConfig);
    expect(streams.errorText()).toBe("");
    expect(plain(streams.humanText())).toContain("Setup was declined; nothing was initialized or created.");
  }, 20_000);

  test("an invalid requested Workspace is refused with the complete validation report, and Local Configuration is unchanged", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    writeWorkspaceMaterial(wsA, "coding");
    writeConfig(home, wsA);
    const cfg = configPath(home);
    const initialConfig = readFileSync(cfg, "utf8");

    // wsB has multiple violations: broken skill frontmatter AND stray file in context
    mkdirSync(join(wsB, "skills", "broken"), { recursive: true });
    writeFileSync(join(wsB, "skills", "broken", "SKILL.md"), "no frontmatter\n");
    mkdirSync(join(wsB, "context"), { recursive: true });
    writeFileSync(join(wsB, "context", "stray.txt"), "not markdown\n");
    writeFileSync(join(wsB, "workspace.yaml"), WORKSPACE_MANIFEST);

    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [wsB], input);
    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    // Config untouched
    expect(readFileSync(cfg, "utf8")).toBe(initialConfig);
    // Error is workspace-violations with both violations
    const toolError = failure as InstallerToolError;
    expect(toolError.fact.kind).toBe("workspace-violations");
    if (toolError.fact.kind === "workspace-violations") {
      expect(toolError.fact.violations.length).toBeGreaterThanOrEqual(2);
    }
  }, 20_000);

  test("connecting the same Workspace and then a different one leaves every Project Binding unchanged", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    writeWorkspaceMaterial(wsA, "coding");
    writeWorkspaceMaterial(wsB, "coding");
    const cfg = configPath(home);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const bindingsYaml = "bindings:\n  - project: ~/projects/one\n    profile: coding\n    hosts:\n      - codex\n  - project: ~/projects/two\n    profile: coding\n    hosts:\n      - claude\n      - opencode\n";
    writeFileSync(cfg, `schema_version: 2\nworkspace: ${wsA}\n${bindingsYaml}`);

    // Connect same workspace
    const input1 = new PassThrough();
    input1.end();
    const init1 = startInit(home, [wsA], input1);
    expect((await init1.pending).exitCode).toBe(0);
    const afterSame = readFileSync(cfg, "utf8");
    expect(afterSame).toContain("project: ~/projects/one");
    expect(afterSame).toContain("project: ~/projects/two");
    expect(afterSame).toContain("workspace: " + wsA);

    // Connect different workspace
    const input2 = new PassThrough();
    input2.end();
    const init2 = startInit(home, [wsB], input2);
    expect((await init2.pending).exitCode).toBe(0);
    const afterDiff = readFileSync(cfg, "utf8");
    expect(afterDiff).toContain("project: ~/projects/one");
    expect(afterDiff).toContain("project: ~/projects/two");
    expect(afterDiff).toContain("workspace: " + wsB);
  }, 20_000);

  test("after connecting, every Project Binding whose Profile the Workspace lacks is reported with the next action", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    writeWorkspaceMaterial(wsA, "coding");
    // wsB has profile "ops", but lacks "coding" and "missing-prof"
    writeWorkspaceMaterial(wsB, "ops");
    const cfg = configPath(home);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(
      cfg,
      `schema_version: 2\nworkspace: ${wsA}\nbindings:\n  - project: ~/projects/alpha\n    profile: coding\n    hosts:\n      - codex\n  - project: ~/projects/beta\n    profile: missing-prof\n    hosts:\n      - claude\n`,
    );

    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, [wsB], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const human = plain(streams.humanText());
    expect(human).toContain("Project Bindings whose Profile this Workspace lacks");
    expect(human).toContain("~/projects/alpha");
    expect(human).toContain("Profile 'coding' does not exist in this Workspace");
    expect(human).toContain("apkit new profile coding");
    expect(human).toContain("apkit install");
    expect(human).toContain("~/projects/beta");
    expect(human).toContain("Profile 'missing-prof' does not exist in this Workspace");
    expect(human).toContain("apkit new profile missing-prof");
  }, 20_000);

  test("a requested folder with missing parts follows the same add-missing-parts flow as setup", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    writeWorkspaceMaterial(wsA, "coding");
    writeConfig(home, wsA);

    // wsB has only workspace.yaml and context/
    mkdirSync(join(wsB, "context"), { recursive: true });
    writeFileSync(join(wsB, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeFileSync(join(wsB, "context", "team-rules.md"), "Team rules.\n");

    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [wsB], input);

    await waitForOutput(streams.humanText, "Setup will add");
    const human = plain(streams.humanText());
    expect(human).toContain("skills/");
    expect(human).toContain("profiles/");
    expect(human).toContain("Current Workspace:");
    expect(human).toContain("~/ws-a");
    expect(human).toContain("Requested Workspace:");
    expect(human).toContain("~/ws-b");

    input.write("y");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(existsSync(join(wsB, "skills"))).toBe(true);
    expect(existsSync(join(wsB, "profiles"))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${wsB}`);
    const receipt = plain(streams.humanText());
    expect(receipt).not.toContain("Set up your first Profile now?");
    // Zero Profiles and existing Context: Profile creation only.
    expect(receipt).toContain("apkit new profile <name> --context <context>");
    expect(receipt).not.toContain("apkit new context");
    expect(receipt).not.toContain("apkit validate");
  }, 20_000);

  test("legacy migration connecting to a different Workspace reports Project Bindings whose Profile is missing", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    writeWorkspaceMaterial(wsA, "coding");
    // wsB has "ops", but lacks "coding"
    writeWorkspaceMaterial(wsB, "ops");
    const config = writeLegacyConfig(
      home,
      `schema_version: 1\nworkspace: ${wsA}\nbindings:\n  - project: ~/projects/legacy-proj\n    profile: coding\n    hosts:\n      - codex\n`,
    );

    const input = new PassThrough();
    input.end();
    const { pending, streams } = startInit(home, [wsB], input);
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    const human = plain(streams.humanText());
    expect(human).toMatch(/migrat/i);
    expect(human).toContain("Project Bindings whose Profile this Workspace lacks");
    expect(human).toContain("~/projects/legacy-proj");
    expect(human).toContain("Profile 'coding' does not exist in this Workspace");
    expect(human).toContain("apkit new profile coding");
    expect(human).toContain("apkit install");
    const migrated = readFileSync(config, "utf8");
    expect(migrated).toMatch(/schema_version:\s*2/);
    expect(migrated).toContain(`workspace: ${wsB}`);
  }, 20_000);

  test("an interactive user can cancel connecting a different Workspace with Ctrl-C", async () => {
    const home = isolatedHome();
    const wsA = join(home, "ws-a");
    const wsB = join(home, "ws-b");
    writeWorkspaceMaterial(wsA, "coding");
    writeWorkspaceMaterial(wsB, "coding");
    writeConfig(home, wsA);
    const cfg = configPath(home);
    const initialConfig = readFileSync(cfg, "utf8");

    const input = fakeInteractiveInput();
    const { pending, streams } = startInit(home, [wsB], input);

    await waitForOutput(streams.humanText, "Current Workspace:");
    const human = plain(streams.humanText());
    expect(human).toContain("~/ws-a");
    expect(human).toContain("Requested Workspace:");
    expect(human).toContain("~/ws-b");

    input.write("\u0003");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(readFileSync(cfg, "utf8")).toBe(initialConfig);
  }, 20_000);
});

