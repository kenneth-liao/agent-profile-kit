/**
 * The `install` command (ticket #494, spec #491 US-001/US-006/US-007/US-008,
 * DEC-001/DEC-002/DEC-004–DEC-006): one action records the Project's desired
 * selection and installs/verifies the generated output. Public `bind` is
 * retired. Missing interactive pickers belong to #495: missing Profile/Hosts
 * remain errors on every input stream in this slice.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { runInstallCommand } from "../cli/install-command.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-test-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(prefix = "agent-profile-kit-install-project-"): string {
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

/** A non-interactive input stream: the command must never prompt on it. */
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

interface StartedInstall {
  readonly pending: Promise<{ exitCode: 0 | 1 | 2; streams: CapturedStreams }>;
  readonly streams: CapturedStreams;
}

/** Start the install command without awaiting it, so tests can script the input. */
function startInstall(
  home: string,
  arguments_: readonly string[],
  input: Readable,
  options: { readonly cwd?: string } = {},
): StartedInstall {
  const streams = capturedStreams();
  const pending = runInstallCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }).then((outcome) => ({ exitCode: outcome.exitCode, streams }));
  return { pending, streams };
}

async function setupHome(profile = "coding"): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  writeProfile(home, profile);
  writeConfig(home, workspacePath(home));
  return home;
}

async function runInstall(
  home: string,
  arguments_: readonly string[],
  input: PassThrough,
  options: { readonly cwd?: string } = {},
): Promise<{ exitCode: 0 | 1 | 2; streams: CapturedStreams }> {
  const streams = capturedStreams();
  const outcome = await runInstallCommand({
    home,
    arguments: arguments_,
    stdout: streams.output as Writable & { isTTY?: boolean },
    stderr: streams.stderr as Writable & { isTTY?: boolean },
    input,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  return { exitCode: outcome.exitCode, streams };
}

describe("install argument refusals happen before any write", () => {
  test("non-interactive install without --auto-confirm refuses with the runnable remedy", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    const streams = capturedStreams();

    const outcome = await runInstallCommand({
      home,
      arguments: ["coding", projectPath, "--host", "codex"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("--auto-confirm");
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("bindings: []");
  });

  test("missing Profile remains an error on every input stream", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    const streams = capturedStreams();

    const outcome = await runInstallCommand({
      home,
      arguments: ["--host", "codex", "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
      cwd: projectPath,
    });

    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("Profile");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
  });

  test("missing Hosts remain an error on every input stream", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();
    const streams = capturedStreams();

    const outcome = await runInstallCommand({
      home,
      arguments: ["coding", projectPath, "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });

    expect(outcome.exitCode).toBe(1);
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
  });
});

describe("explicit install records the selection and installs output in one action", () => {
  test("explicit install records the selection and installs verified output in one action", async () => {
    const home = isolatedHome();
    await initializeWorkspace(home);
    writeProfile(home, "coding");
    writeConfig(home, workspacePath(home));
    const projectPath = projectDirectory();

    const { exitCode, streams } = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(0);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("profile: coding");
    expect(config).toContain("- codex");
    const installed = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    expect(readFileSync(installed, "utf8")).toContain("Always preserve the project boundary.");
    expect(plain(streams.humanText())).toContain("coding");
  });
});

describe("install general confirmation", () => {
  test("an interactive yes answer installs after showing the proposed scope", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    expect(plain(streams.humanText())).toContain("coding");
    expect(plain(streams.humanText())).toContain("codex");
    input.write("y\n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
    expect(readFileSync(
      join(projectPath, ".agent-profile-kit", "codex", "context.md"),
      "utf8",
    )).toContain("Always preserve the project boundary.");
  });

  test("an explicit no declines with zero writes", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    input.write("n\n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("you answered no");
    // A declined install is a retained cancellation (DEC-008), so its
    // detail route follows the diagnostic on stderr (ADR-0040).
    expect(plain(streams.errorText())).toContain("Details: apkit details");
    expect(plain(streams.humanText())).not.toContain("Details:");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("the default answer declines with zero writes", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    input.write("\n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("default answer no");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("cancellation aborts with zero writes", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    input.end();
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("cancelled");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("--auto-confirm answers an interactive general confirmation without prompting", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const input = fakeInteractiveInput();
    input.end();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      input,
    );
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(plain(streams.humanText())).not.toContain("(y/N)");
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
  });

  test("interactive --json without --auto-confirm refuses instead of prompting", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const { exitCode, streams } = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--json"],
      fakeInteractiveInput(),
    );

    expect(exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("--auto-confirm");
    expect(readFileSync(configPath(home), "utf8")).toContain("bindings: []");
  });

});

describe("install changed-file consent", () => {
  async function setupInstalled(): Promise<{
    home: string;
    projectPath: string;
    outputPath: string;
  }> {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const installed = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(installed.exitCode).toBe(0);
    const outputPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(outputPath, "hand-edited by the user\n");
    return { home, projectPath, outputPath };
  }

  test("re-install over drifted output reviews the change and accepts replacement", async () => {
    const { home, projectPath, outputPath } = await setupInstalled();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    await waitForOutput(streams.humanText, "Changed generated files:");
    expect(plain(streams.humanText())).toContain("context.md");
    input.write("y\n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("Always preserve the project boundary.");
  });

  test("the shared diff view grants no consent until yes is answered", async () => {
    const { home, projectPath, outputPath } = await setupInstalled();
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    await waitForOutput(streams.humanText, "Changed generated files:");
    input.write("d\n");
    await waitForOutput(streams.humanText, "Current on-disk versus planned:");
    input.write("y\n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("Always preserve the project boundary.");
  });

  test("--auto-confirm alone never authorizes replacement: refusal with zero writes", async () => {
    const { home, projectPath, outputPath } = await setupInstalled();

    const { exitCode, streams } = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(1);
    const error = plain(streams.errorText());
    expect(error).toContain("--replace-changed");
    expect(error).toContain("apkit install");
    expect(readFileSync(outputPath, "utf8")).toBe("hand-edited by the user\n");
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
  });

  test("--auto-confirm with --replace-changed permits replacement non-interactively", async () => {
    const { home, projectPath, outputPath } = await setupInstalled();

    const { exitCode } = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm", "--replace-changed"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain("Always preserve the project boundary.");
  });

  test("removal from a changed Host selection needs --remove-changed", async () => {
    const { home, projectPath } = await setupInstalled();
    const codexOutput = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    const claudeOutput = join(projectPath, ".claude", "rules", "agent-profile-kit.md");

    const refused = await runInstall(
      home,
      ["coding", projectPath, "--host", "claude", "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(refused.exitCode).toBe(1);
    expect(plain(refused.streams.errorText())).toContain("--remove-changed");
    expect(readFileSync(codexOutput, "utf8")).toBe("hand-edited by the user\n");
    expect(readFileSync(configPath(home), "utf8")).toContain("- codex");

    const permitted = await runInstall(
      home,
      ["coding", projectPath, "--host", "claude", "--auto-confirm", "--remove-changed"],
      nonInteractiveInput(),
    );
    expect(permitted.exitCode).toBe(0);
    expect(existsSync(codexOutput)).toBe(false);
    expect(readFileSync(claudeOutput, "utf8")).toContain("Always preserve the project boundary.");
    expect(readFileSync(configPath(home), "utf8")).toContain("- claude");
  });
});

describe("install failures report truthfully", () => {
  test("a publication failure keeps the previous selection and prints the retry", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const configurationDirectory = join(home, ".agents", "agent-profile-kit");
    const { chmodSync } = await import("node:fs");
    chmodSync(configurationDirectory, 0o555);
    try {
      const { exitCode, streams } = await runInstall(
        home,
        ["coding", projectPath, "--host", "codex", "--auto-confirm"],
        nonInteractiveInput(),
      );

      expect(exitCode).toBe(1);
      const error = plain(streams.errorText());
      expect(error).toContain("install failed");
      expect(error).toContain("To retry");
      expect(error).toContain("apkit install");
    } finally {
      chmodSync(configurationDirectory, 0o755);
    }
    expect(readFileSync(configPath(home), "utf8")).not.toContain("profile: coding");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("an unreadable configuration fails closed before any prompt or write", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    writeFileSync(configPath(home), "schema_version: [unclosed\n");
    const before = readFileSync(configPath(home), "utf8");
    const input = fakeInteractiveInput();
    input.end();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    expect(plain(streams.humanText())).not.toContain("(y/N)");
    expect(readFileSync(configPath(home), "utf8")).toBe(before);
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("declining the changed-output review aborts with the runnable command", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const installed = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(installed.exitCode).toBe(0);
    const outputPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(outputPath, "hand-edited by the user\n");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    await waitForOutput(streams.humanText, "Changed generated files:");
    input.write("n\n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    const error = plain(streams.errorText());
    expect(error).toContain("you answered no");
    expect(error).toContain("apkit install");
    expect(error).toContain("--auto-confirm");
    expect(error).toContain("--replace-changed");
    expect(readFileSync(outputPath, "utf8")).toBe("hand-edited by the user\n");
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
  });

  test("an occupied destination blocks before any write with its remedy", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const outputPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    mkdirSync(join(projectPath, ".agent-profile-kit", "codex"), { recursive: true });
    writeFileSync(outputPath, "foreign bytes the user owns\n");

    const { exitCode, streams } = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(exitCode).not.toBe(0);
    expect(plain(streams.humanText())).toContain("install blocked before any write");
    // The Blocker fired in the prospective review, before any publication:
    // nothing was published, so there is no recovery to report.
    expect(plain(streams.humanText())).not.toContain("previous selection");
    expect(readFileSync(outputPath, "utf8")).toBe("foreign bytes the user owns\n");
    expect(readFileSync(configPath(home), "utf8")).not.toContain("profile: coding");
  });

  test("a commit-time byte move stops as stale with the selection restored", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const installed = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );
    expect(installed.exitCode).toBe(0);
    const outputPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(outputPath, "hand-edited by the user\n");
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    input.write("y\n");
    await waitForOutput(streams.humanText, "Changed generated files:");
    // Move the reviewed bytes after the review but before the commit.
    writeFileSync(outputPath, "moved again before commit\n");
    input.write("y\n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(1);
    const error = plain(streams.errorText());
    expect(error).toContain("changed during confirmation");
    expect(error).toContain("previous selection was restored");
    expect(error).toContain("apkit install");
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
    expect(readFileSync(outputPath, "utf8")).toBe("moved again before commit\n");
  });

  test("an unknown Profile is refused before any write", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();

    const { exitCode, streams } = await runInstall(
      home,
      ["missing", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("missing");
    expect(readFileSync(configPath(home), "utf8")).not.toContain("profile: missing");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("an unsupported Host is refused before any write", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();

    const { exitCode, streams } = await runInstall(
      home,
      ["coding", projectPath, "--host", "gemini", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("gemini");
    expect(readFileSync(configPath(home), "utf8")).not.toContain("profile: coding");
  });

  test("a missing Project directory is refused before any write", async () => {
    const home = await setupHome();
    const missing = join(projectDirectory(), "no-such-project");

    const { exitCode } = await runInstall(
      home,
      ["coding", missing, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(1);
    expect(readFileSync(configPath(home), "utf8")).not.toContain("profile: coding");
  });
});

describe("install changed-installation scope", () => {
  test("a changed installation shows the previous-to-new scope before confirmation", async () => {
    const home = await setupHome("coding");
    writeProfile(home, "ops");
    const projectPath = projectDirectory();
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: ops\n    hosts:\n      - claude\n`,
    );
    const input = fakeInteractiveInput();
    const { pending, streams } = startInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      input,
    );

    await waitForOutput(streams.humanText, "(y/N)");
    const proposed = plain(streams.humanText());
    expect(proposed).toContain("ops → coding");
    expect(proposed).toContain("claude → codex");
    input.write("y\n");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
  });
});

describe("install completed-operation detail route (US-011, DEC-007, ADR-0040)", () => {
  test("a successful install prints the retained-operation route once", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();

    const { exitCode, streams } = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(0);
    const text = plain(streams.humanText());
    expect(text).toContain("Details: apkit details");
    expect(text.split("Details: apkit details")).toHaveLength(2);
  });

  test("an unchanged install still prints the route for its retained no-op entry", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();

    expect((await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    )).exitCode).toBe(0);
    const unchanged = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm"],
      nonInteractiveInput(),
    );

    expect(unchanged.exitCode).toBe(0);
    const text = plain(unchanged.streams.humanText());
    expect(text).toContain("Installation unchanged for");
    expect(text).toContain("Details: apkit details");
  });

  test("a pre-write refusal prints no detail route", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();

    const { exitCode, streams } = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(1);
    expect(plain(streams.humanText())).not.toContain("Details:");
    expect(plain(streams.errorText())).not.toContain("Details:");
  });

  test("machine JSON stays parseable and carries no human route", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();

    const { exitCode, streams } = await runInstall(
      home,
      ["coding", projectPath, "--host", "codex", "--auto-confirm", "--json"],
      nonInteractiveInput(),
    );

    expect(exitCode).toBe(0);
    expect(() => JSON.parse(plain(streams.humanText()))).not.toThrow();
    expect(plain(streams.humanText())).not.toContain("Details: apkit details");
  });
});
