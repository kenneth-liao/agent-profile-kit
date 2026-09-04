import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { MAX_HUMAN_WIDTH, MIN_HUMAN_WIDTH } from "../cli/terminal-presentation.js";
import { obtainPackageArchive } from "./support/package-archive.js";
import {
  TEST_CHILD_DEADLINE_MS,
  expectExitCode,
  runProcess,
  type ProcessResult,
} from "./support/process-executor.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];
let packageArchiveCleanup = (): void => undefined;
let cliPath = join(repositoryRoot, "dist", "cli.js");

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STABLE_UUID = "00000000-0000-4000-8000-000000000000";
const COLOR_TERMINAL_ENVIRONMENT: NodeJS.ProcessEnv = {
  NO_COLOR: undefined,
  TERM: "xterm-256color",
};

beforeAll(() => {
  const archive = obtainPackageArchive(repositoryRoot, "agent-profile-kit-golden-pack-");
  packageArchiveCleanup = archive.cleanup;
  const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-golden-packed-"));
  temporaryDirectories.push(extracted);
  execFileSync("tar", ["-xzf", archive.path, "-C", extracted]);
  cliPath = join(extracted, "package", "dist", "cli.js");
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  packageArchiveCleanup();
});

function isolatedHome(): string {
  const home = mkdtempSync("/tmp/apkit-gldn-");
  temporaryDirectories.push(home);
  return realpathSync(home);
}

function sameLengthPlaceholder(path: string): string {
  const prefix = "/private/tmp/apkit-golden-";
  if (path.length <= prefix.length) return "H".repeat(path.length);
  return `${prefix}${"x".repeat(path.length - prefix.length)}`;
}

function stabilize(text: string, home: string): string {
  const replacements = [...new Set([home, realpathSync(home)])].sort(
    (left, right) => right.length - left.length,
  );
  let next = text;
  for (const path of replacements) {
    next = next.split(path).join(sameLengthPlaceholder(path));
  }
  return next.replace(UUID_PATTERN, STABLE_UUID);
}

function snapshotBody(result: ProcessResult, home: string): string {
  return stabilize(`--- stdout ---\n${result.stdout}--- stderr ---\n${result.stderr}`, home);
}

function expectGolden(name: string, result: ProcessResult, home: string): void {
  expect(snapshotBody(result, home)).toMatchSnapshot(name);
}

function installFakeCodex(home: string, version = "0.145.0"): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
echo "codex-cli ${version}"
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  return bin;
}

function defaultPath(home: string): string {
  return `${installFakeCodex(home)}:${process.env.PATH ?? ""}`;
}

function redirectedEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    PATH: defaultPath(home),
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

async function runCli(
  home: string,
  args: readonly string[],
  cwd?: string,
): Promise<ProcessResult> {
  return runProcess({
    executable: process.env.NODE_BINARY ?? "node",
    arguments_: [cliPath, ...args],
    ...(cwd === undefined ? {} : { cwd }),
    environment: redirectedEnvironment(home),
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI golden",
  });
}

function stripPtyControlArtifacts(text: string): string {
  return text.replace(/^\^D/, "").replace(/[\u0004\u0008]/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runCliInPty(
  home: string,
  columns: number,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<ProcessResult> {
  const command = [
    `stty cols ${columns};`,
    "exec",
    ...[process.env.NODE_BINARY ?? "node", cliPath, ...args].map(shellQuote),
  ].join(" ");
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...environment,
    COLUMNS: String(columns),
    HOME: home,
    PATH: defaultPath(home),
  };
  if (
    Object.prototype.hasOwnProperty.call(environment, "NO_COLOR") &&
    environment.NO_COLOR === undefined
  ) {
    delete childEnvironment.NO_COLOR;
  }
  const result = await runProcess({
    executable: "script",
    arguments_: ["-q", "/dev/null", "sh", "-c", command],
    environment: childEnvironment,
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI golden PTY",
  });
  return {
    ...result,
    stdout: stripPtyControlArtifacts(result.stdout).replace(/\r/g, ""),
    stderr: stripPtyControlArtifacts(result.stderr).replace(/\r/g, ""),
  };
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function demoProject(home: string, name = "demo"): string {
  const path = join(home, "projects", name);
  mkdirSync(path, { recursive: true });
  return path;
}

function gitProject(home: string, name: string): string {
  const path = demoProject(home, name);
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
  return path;
}

async function initialize(home: string): Promise<void> {
  expectExitCode(await runCli(home, ["init"]), 0);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

async function bindExample(home: string, projectPath: string): Promise<void> {
  expectExitCode(
    await runCli(home, ["bind", AUTHORING_EXAMPLES.profile.id, projectPath, "--host", "codex"]),
    0,
  );
}

async function initializedHome(): Promise<{ home: string; project: string }> {
  const home = isolatedHome();
  await initialize(home);
  return { home, project: demoProject(home) };
}

async function pendingHome(): Promise<{ home: string; project: string }> {
  const prepared = await initializedHome();
  await bindExample(prepared.home, prepared.project);
  return prepared;
}

async function currentHome(): Promise<{ home: string; project: string }> {
  const prepared = await pendingHome();
  expectExitCode(await runCli(prepared.home, ["apply", prepared.project]), 0);
  return prepared;
}

async function blockedHome(): Promise<{ home: string; project: string }> {
  const home = isolatedHome();
  await initialize(home);
  const project = gitProject(home, "blocked");
  mkdirSync(join(project, ".codex"));
  writeFileSync(join(project, ".codex", "hooks.json"), "tracked placeholder\n");
  execFileSync("git", ["-C", project, "add", ".codex/hooks.json"]);
  execFileSync("git", ["-C", project, "commit", "-qm", "track generated path"]);
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${project}\n    profile: ${AUTHORING_EXAMPLES.profile.id}\n    hosts: [codex]\n`,
  );
  return { home, project };
}

test("records the bounded-diff review rule alongside the snapshots", () => {
  const rule = readFileSync(resolve(repositoryRoot, "test/__snapshots__/README.md"), "utf8");
  expect(rule).toMatch(/wrapping/i);
  expect(rule).toMatch(/elid/i);
  expect(rule).toMatch(/alignment/i);
  expect(rule).toMatch(/colour|color/i);
  expect(rule).toMatch(/content change/i);
});

describe("golden snapshots of every human view", () => {
  test("root help", async () => {
    const home = isolatedHome();
    expectGolden("root-help", await runCli(home, ["--help"]), home);
  });

  test("machine help", async () => {
    const home = isolatedHome();
    expectGolden("machine-help", await runCli(home, ["machine", "--help"]), home);
  });

  test("focused command help", async () => {
    const home = isolatedHome();
    expectGolden("focused-command-help", await runCli(home, ["status", "--help"]), home);
  });

  test("unknown command", async () => {
    const home = isolatedHome();
    expectGolden("unknown-command", await runCli(home, ["nosuch"]), home);
  });

  test("unknown machine command", async () => {
    const home = isolatedHome();
    expectGolden("unknown-machine-command", await runCli(home, ["machine", "nosuch"]), home);
  });

  test("guide index", async () => {
    const home = isolatedHome();
    expectGolden("guide-index", await runCli(home, ["guide"]), home);
  });

  test("focused guide", async () => {
    const home = isolatedHome();
    expectGolden("focused-guide", await runCli(home, ["guide", "profile"]), home);
  });

  test("focused guide context", async () => {
    const home = isolatedHome();
    expectGolden("focused-guide-context", await runCli(home, ["guide", "context"]), home);
  });

  test("focused guide skill", async () => {
    const home = isolatedHome();
    expectGolden("focused-guide-skill", await runCli(home, ["guide", "skill"]), home);
  });

  test("full guide", async () => {
    const home = isolatedHome();
    expectGolden("full-guide", await runCli(home, ["guide", "--full"]), home);
  });

  test("agent guide", async () => {
    const home = isolatedHome();
    expectGolden("agent-guide", await runCli(home, ["guide", "--agent"]), home);
  });

  test("info", async () => {
    const { home } = await initializedHome();
    expectGolden("info", await runCli(home, ["info"]), home);
  });

  test("list index", async () => {
    const { home } = await initializedHome();
    expectGolden("list-index", await runCli(home, ["list"]), home);
  });

  test("list projects", async () => {
    const { home } = await pendingHome();
    await bindExample(home, demoProject(home, "other"));
    expectGolden("list-projects", await runCli(home, ["list", "projects"]), home);
  });

  test("list profiles", async () => {
    const { home } = await initializedHome();
    expectGolden("list-profiles", await runCli(home, ["list", "profiles"]), home);
  });

  test("list hosts", async () => {
    const { home } = await initializedHome();
    expectGolden("list-hosts", await runCli(home, ["list", "hosts"]), home);
  });

  test("machine list index", async () => {
    const { home } = await initializedHome();
    expectGolden("machine-list-index", await runCli(home, ["machine", "list"]), home);
  });

  test("machine list temporary", async () => {
    const { home } = await initializedHome();
    expectGolden("machine-list-temporary", await runCli(home, ["machine", "list", "temporary"]), home);
  });

  test("init", async () => {
    const home = isolatedHome();
    expectGolden("init", await runCli(home, ["init"]), home);
  });

  test("bind success", async () => {
    const { home, project } = await initializedHome();
    expectGolden(
      "bind-success",
      await runCli(home, ["bind", AUTHORING_EXAMPLES.profile.id, project, "--host", "codex"]),
      home,
    );
  });

  test("validate", async () => {
    const { home } = await pendingHome();
    expectGolden("validate", await runCli(home, ["validate"]), home);
  });

  test("status current", async () => {
    const { home, project } = await currentHome();
    expectGolden("status-current", await runCli(home, ["status", project]), home);
  });

  test("status pending", async () => {
    const { home, project } = await pendingHome();
    expectGolden("status-pending", await runCli(home, ["status", project]), home);
  });

  test("status blocked", async () => {
    const { home, project } = await blockedHome();
    expectGolden("status-blocked", await runCli(home, ["status", project]), home);
  });

  test("status verbose", async () => {
    const { home, project } = await currentHome();
    expectGolden("status-verbose", await runCli(home, ["status", project, "--verbose"]), home);
  });

  test("status blockers-only", async () => {
    const { home, project } = await blockedHome();
    expectGolden(
      "status-blockers-only",
      await runCli(home, ["status", project, "--blockers-only"]),
      home,
    );
  });

  test("apply receipt", async () => {
    const { home, project } = await pendingHome();
    expectGolden("apply-receipt", await runCli(home, ["apply", project]), home);
  });

  test("apply blocked", async () => {
    const { home, project } = await blockedHome();
    expectGolden("apply-blocked", await runCli(home, ["apply", project]), home);
  });

  test("unbind", async () => {
    const { home, project } = await pendingHome();
    expectGolden("unbind", await runCli(home, ["unbind", project]), home);
  });

  test("uninstall", async () => {
    const { home, project } = await currentHome();
    expectGolden("uninstall", await runCli(home, ["uninstall"]), home);
  });

  test("install-temp", async () => {
    const { home } = await initializedHome();
    const project = gitProject(home, "temporary");
    expectGolden(
      "install-temp",
      await runCli(home, [
        "machine",
        "install-temp",
        AUTHORING_EXAMPLES.profile.id,
        project,
        "--host",
        "codex",
      ]),
      home,
    );
  });

  test("remove-temp", async () => {
    const { home } = await initializedHome();
    const project = gitProject(home, "temporary-remove");
    const installed = await runCli(home, [
      "machine",
      "install-temp",
      AUTHORING_EXAMPLES.profile.id,
      project,
      "--host",
      "codex",
    ]);
    expectExitCode(installed, 0);
    const identity = installed.stdout.match(/^  Temporary installation: (\S+)$/m)?.[1];
    expect(identity).toBeTruthy();
    expectGolden(
      "remove-temp",
      await runCli(home, ["machine", "remove-temp", identity!]),
      home,
    );
  });

  test("blocked temp", async () => {
    const { home } = await initializedHome();
    const project = gitProject(home, "temporary-blocked");
    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".codex", "hooks.json"), "tracked placeholder\n");
    execFileSync("git", ["-C", project, "add", ".codex/hooks.json"]);
    execFileSync("git", ["-C", project, "commit", "-qm", "track generated path"]);
    expectGolden(
      "blocked-temp",
      await runCli(home, [
        "machine",
        "install-temp",
        AUTHORING_EXAMPLES.profile.id,
        project,
        "--host",
        "codex",
      ]),
      home,
    );
  });

  test("unbound-directory error", async () => {
    const { home } = await initializedHome();
    const unbound = demoProject(home, "unbound");
    expectGolden("unbound-directory-error", await runCli(home, ["status", unbound]), home);
  });
});

describe("rendering matrix for a representative subset", () => {
  const cells = [
    { name: "interactive-narrow-nocolor", columns: MIN_HUMAN_WIDTH, environment: { NO_COLOR: "1" } },
    {
      name: "interactive-narrow-color",
      columns: MIN_HUMAN_WIDTH,
      environment: COLOR_TERMINAL_ENVIRONMENT,
    },
    { name: "interactive-wide-nocolor", columns: MAX_HUMAN_WIDTH, environment: { NO_COLOR: "1" } },
    {
      name: "interactive-wide-color",
      columns: MAX_HUMAN_WIDTH,
      environment: COLOR_TERMINAL_ENVIRONMENT,
    },
  ] as const;

  async function matrixSnapshot(
    view: string,
    home: string,
    args: readonly string[],
  ): Promise<void> {
    for (const cell of cells) {
      expectGolden(
        `${view}-${cell.name}`,
        await runCliInPty(home, cell.columns, cell.environment, args),
        home,
      );
    }
  }

  test("root help matrix", async () => {
    const home = isolatedHome();
    await matrixSnapshot("root-help", home, ["--help"]);
  });

  test("info matrix", async () => {
    const { home } = await initializedHome();
    await matrixSnapshot("info", home, ["info"]);
  });

  test("list projects matrix", async () => {
    const { home } = await pendingHome();
    await bindExample(home, demoProject(home, "other"));
    await matrixSnapshot("list-projects", home, ["list", "projects"]);
  });

  test("blocked status matrix", async () => {
    const { home, project } = await blockedHome();
    await matrixSnapshot("status-blocked", home, ["status", project]);
  });

  test("status verbose matrix", async () => {
    const { home, project } = await currentHome();
    await matrixSnapshot("status-verbose", home, ["status", project, "--verbose"]);
  });

  test("unbound error matrix", async () => {
    const { home } = await initializedHome();
    const unbound = demoProject(home, "unbound");
    await matrixSnapshot("unbound-directory-error", home, ["status", unbound]);
  });
});
