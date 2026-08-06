import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

import {
  COMMAND_HELP_ALIASES,
  COMMANDS,
  COMMAND_GROUPS,
  HELP_COMMAND,
} from "../cli/command-help.js";
import { TOPIC_GUIDES } from "../cli/guides.js";
import {
  INVENTORY_TOPICS,
  inventoryCommandSyntax,
  inventoryTopicNames,
} from "../cli/inventory-topics.js";
import { INTERNAL_ONLY_DEFAULT_TERMS } from "../cli/presentation.js";
import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { TEMPORARY_INSTALLATION_HOSTS } from "../installer/temporary-installation.js";
import { ENGINE_VERSION } from "../installer/version.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";
import { humanText } from "./support/human-text.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FOCUSED_GUIDE_MAX_LINES = 30;
const temporaryDirectories: string[] = [];
let cliPath = join(repositoryRoot, "dist", "cli.js");
const COLOR_TERMINAL_ENVIRONMENT: NodeJS.ProcessEnv = {
  NO_COLOR: undefined,
  TERM: "xterm-256color",
};

beforeAll(() => {
  execFileSync("bun", ["run", "build"], { cwd: repositoryRoot, stdio: "inherit" });
  const packageDirectory = mkdtempSync(join(tmpdir(), "agent-profile-kit-suite-pack-"));
  const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-suite-packed-"));
  temporaryDirectories.push(packageDirectory, extracted);
  const packOutput = execFileSync(
    "npm",
    ["pack", "--silent", "--json", "--pack-destination", packageDirectory],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const metadata = JSON.parse(packOutput.slice(packOutput.lastIndexOf("\n[") + 1)) as readonly [{ readonly filename: string }];
  execFileSync("tar", ["-xzf", join(packageDirectory, metadata[0]!.filename), "-C", extracted]);
  cliPath = join(extracted, "package", "dist", "cli.js");
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-test-"));
  temporaryDirectories.push(home);
  return home;
}

function project(prefix = "agent-profile-kit-project-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function gitRepository(prefix = "agent-profile-kit-git-"): string {
  const path = project(prefix);
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
  return path;
}

function addWorktree(repository: string, name: string): string {
  const path = project(`agent-profile-kit-${name}-`);
  rmSync(path, { recursive: true });
  execFileSync("git", ["-C", repository, "worktree", "add", "-q", "-b", name, path]);
  return path;
}

/**
 * Default PATH for lifecycle CLI runs: a controlled Codex ≥0.145.0 stub first so
 * Context-bearing preview/apply is hermetic when ambient `codex` is absent (CI).
 * Tests that need a missing/old/broken CLI use `runCliWithPath` with an explicit PATH.
 */
function defaultCliPath(home: string): string {
  return `${installFakeCodex(home)}:${process.env.PATH ?? ""}`;
}

function runCli(home: string, ...arguments_: string[]) {
  return runCliAt(home, undefined, ...arguments_);
}

function runCliAt(home: string, cwd: string | undefined, ...arguments_: string[]) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    encoding: "utf8" as const,
    cwd,
    env: { ...process.env, HOME: home, PATH: defaultCliPath(home) },
  });
}

function runCliWithEnvironment(
  home: string,
  environment: NodeJS.ProcessEnv,
  ...arguments_: string[]
) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    encoding: "utf8" as const,
    env: {
      ...process.env,
      ...environment,
      HOME: home,
      PATH: defaultCliPath(home),
    },
  });
}

function cleanPtyResult(result: {
  readonly status: number | null;
  readonly stdout: string | null;
  readonly stderr: string | null;
}) {
  // macOS `script` records the PTY's typed EOF as a literal `^D` plus erase controls.
  return {
    ...result,
    stdout: (result.stdout ?? "")
      .replace(/^\^D/, "")
      .replace(/[\u0004\u0008]/g, "")
      .replace(/\r/g, ""),
    stderr: (result.stderr ?? "")
      .replace(/^\^D/, "")
      .replace(/[\u0004\u0008]/g, "")
      .replace(/\r/g, ""),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runCliInPty(home: string, columns: number, ...arguments_: string[]) {
  return runCliInPtyWithEnvironment(home, columns, { NO_COLOR: "1" }, ...arguments_);
}

function runCliInPtyWithEnvironment(
  home: string,
  columns: number,
  environment: NodeJS.ProcessEnv,
  ...arguments_: string[]
) {
  const command = [
    `stty cols ${columns};`,
    "exec",
    ...[process.env.NODE_BINARY ?? "node", cliPath, ...arguments_].map(shellQuote),
  ].join(" ");
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...environment,
    COLUMNS: String(columns),
    HOME: home,
    PATH: defaultCliPath(home),
  };
  if (
    Object.prototype.hasOwnProperty.call(environment, "NO_COLOR") &&
    environment.NO_COLOR === undefined
  ) {
    delete childEnvironment.NO_COLOR;
  }
  const result = spawnSync(
    "script",
    ["-q", "/dev/null", "sh", "-c", command],
    {
      encoding: "utf8" as const,
      env: childEnvironment,
    },
  );
  return cleanPtyResult(result);
}

function runCliInPtyWithColumnsFallback(home: string, columns: number, ...arguments_: string[]) {
  // `script` starts this macOS test PTY at zero columns; keep that property
  // explicit so this test exercises the documented COLUMNS fallback.
  const command = [
    "stty cols 0;",
    "exec",
    ...[process.env.NODE_BINARY ?? "node", cliPath, ...arguments_].map(shellQuote),
  ].join(" ");
  const result = spawnSync(
    "script",
    ["-q", "/dev/null", "sh", "-c", command],
    {
      encoding: "utf8" as const,
      env: {
        ...process.env,
        NO_COLOR: "1",
        COLUMNS: String(columns),
        HOME: home,
        PATH: defaultCliPath(home),
      },
    },
  );
  return cleanPtyResult(result);
}

function runCliAsync(
  home: string,
  ...arguments_: string[]
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
      env: { ...process.env, HOME: home, PATH: defaultCliPath(home) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function statePath(home: string): string {
  return join(stateDirectory(home), "manifest.yaml");
}

function stateDirectory(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state");
}

function writeContextProfile(home: string, profile = "coding"): void {
  const workspace = workspacePath(home);
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  writeFileSync(
    join(workspace, "profiles", `${profile}.yaml`),
    `id: ${profile}\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n`,
  );
}

function bind(home: string, projectPath: string, profile = "coding"): void {
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: ${profile}\n    hosts:\n      - codex\n`,
  );
}

function initialize(home: string): void {
  const result = runCli(home, "init");
  expect(result.status, result.stderr).toBe(0);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

function removeScaffoldedExample(home: string): void {
  const workspace = workspacePath(home);
  rmSync(join(workspace, "profiles", "example.yaml"), { force: true });
  rmSync(join(workspace, "context", "example-context.md"), { force: true });
}

/** Put a controlled Claude Code stub first on PATH for Host capability preflight. */
function installFakeClaude(home: string, version = "2.1.0"): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  execFileSync("chmod", ["+x", join(bin, "claude")]);
  return bin;
}

/** Put a controlled Codex CLI stub first on PATH for version capability preflight. */
function installFakeCodex(home: string, version = "0.145.0"): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex-cli ${version}"\n`);
  execFileSync("chmod", ["+x", join(bin, "codex")]);
  return bin;
}

/** Put a controlled Grok CLI stub first on PATH for version + inspect preflight. */
function installFakeGrok(
  home: string,
  options: {
    readonly version?: string;
    readonly claudeRulesEnabled?: boolean;
  } = {},
): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const version = options.version ?? "0.2.111";
  const claudeRulesEnabled = options.claudeRulesEnabled ?? true;
  const inspectBody = JSON.stringify({
    grokVersion: version,
    externalCompat: {
      remoteSettingsLoaded: false,
      cells: [
        {
          vendor: "claude",
          surface: "rules",
          enabled: claudeRulesEnabled,
          source: "default",
        },
      ],
    },
    // Empty inspection output is valid for the controlled Host fixture.
    skills: [],
    projectInstructions: [],
  });
  writeFileSync(
    join(bin, "grok"),
    `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "grok ${version} (fake) [stable]"
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
${inspectBody}
EOF
  exit 0
fi
echo "unexpected grok invocation: $*" >&2
exit 2
`,
  );
  execFileSync("chmod", ["+x", join(bin, "grok")]);
  return bin;
}

function runCliWithPath(
  home: string,
  pathValue: string,
  ...arguments_: string[]
) {
  // Use an absolute Node path so PATH can be restricted for Host capability probes.
  return spawnSync(process.env.NODE_BINARY ?? process.execPath, [cliPath, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: pathValue },
  });
}

describe("agent-profile-kit project-bound lifecycle", () => {
  test("a fresh Workspace includes a bindable example Profile and Context Module", () => {
    const home = isolatedHome();
    const projectPath = project();

    const init = runCli(home, "init");
    expect(init.status, init.stderr).toBe(0);

    const workspace = workspacePath(home);
    expect(readFileSync(join(workspace, "profiles", "example.yaml"), "utf8")).toContain(
      "id: example\n",
    );
    expect(readFileSync(join(workspace, "context", "example-context.md"), "utf8")).toContain(
      "id: example-context\n",
    );

    const bind = runCli(home, "bind", "example", projectPath, "--host", "codex");
    expect(bind.status, bind.stderr).toBe(0);
    expect(bind.stdout).toContain("Profile: example");

    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const preview = runCli(home, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    const apply = runCli(home, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(
      readFileSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"), "utf8"),
    ).toContain("Keep project-specific instructions in the project repository.");
  });

  test("re-running init does not restore a removed example", () => {
    const home = isolatedHome();
    initialize(home);
    const workspace = workspacePath(home);
    const exampleProfile = join(workspace, "profiles", "example.yaml");
    const exampleContext = join(workspace, "context", "example-context.md");
    removeScaffoldedExample(home);

    const result = runCli(home, "init");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(exampleProfile)).toBe(false);
    expect(existsSync(exampleContext)).toBe(false);
  });

  test("init names a next bind command that succeeds with the scaffolded Profile", () => {
    const home = isolatedHome();
    const projectPath = project();

    const init = runCli(home, "init");

    expect(init.status, init.stderr).toBe(0);
    expect(init.stdout).toContain(
      "Next: from the project you want to try, run apkit bind example --host codex",
    );
    const bind = runCliAt(home, projectPath, "bind", "example", "--host", "codex");
    expect(bind.status, bind.stderr).toBe(0);
  });

  test("init creates both canonical inputs and never overwrites either", () => {
    const home = isolatedHome();
    initialize(home);
    const workspace = workspacePath(home);
    const config = configPath(home);
    const originalConfig = `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n# authored\n`;
    writeFileSync(config, originalConfig);
    writeFileSync(join(workspace, "README.md"), "# authored\n");

    const result = runCli(home, "init");

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(originalConfig);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("# authored\n");
  });

  test("validate explains how to recover from removing only half of the scaffolded example", () => {
    const home = isolatedHome();
    initialize(home);
    rmSync(join(workspacePath(home), "context", "example-context.md"));

    const result = runCli(home, "validate");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Profile 'example' selects missing Context Module 'example-context'",
    );
    expect(result.stderr).toContain("Restore the Context Module, or remove or update Profile 'example'");
  });

  test("manifest-only and partial Workspaces validate; re-init does not restore optional scaffolding", () => {
    const home = isolatedHome();
    const workspace = workspacePath(home);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`);

    const minimalValidate = runCli(home, "validate");
    expect(minimalValidate.status, minimalValidate.stderr).toBe(0);
    expect(minimalValidate.stdout).toContain("Workspace and Local Configuration valid");
    expect(minimalValidate.stdout).toContain("0 Profiles, 0 Project Bindings");
    expect(minimalValidate.stdout).toContain("Profiles found: none");
    expect(minimalValidate.stdout).toContain("Hosts bound: none");

    mkdirSync(join(workspace, "context"));
    mkdirSync(join(workspace, "profiles"));
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);

    const partialValidate = runCli(home, "validate");
    expect(partialValidate.status, partialValidate.stderr).toBe(0);
    expect(partialValidate.stdout).toContain("1 Profile");

    for (const entry of ["README.md", "AGENTS.md", ".gitignore", "skills", "agents", "hooks", "tools"]) {
      expect(existsSync(join(workspace, entry))).toBe(false);
    }

    const reinit = runCli(home, "init");
    expect(reinit.status, reinit.stderr).toBe(0);
    expect(reinit.stdout).toMatch(/already initialized|unchanged/i);
    for (const entry of ["README.md", "AGENTS.md", ".gitignore", "skills", "agents", "hooks", "tools"]) {
      expect(existsSync(join(workspace, entry))).toBe(false);
    }
  });

  test("missing bootstrap files do not affect validate, preview, status, apply, or uninstall", () => {
    const home = isolatedHome();
    const workspace = workspacePath(home);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
    mkdirSync(join(workspace, "context"));
    mkdirSync(join(workspace, "profiles"));
    writeContextProfile(home);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const projectPath = project();
    bind(home, projectPath);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    for (const entry of ["README.md", "AGENTS.md", ".gitignore"]) {
      expect(existsSync(join(workspace, entry))).toBe(false);
    }

    for (const command of ["validate", "preview", "status"] as const) {
      const result = runCli(home, command);
      expect(result.status, `${command}: ${result.stderr}`).toBe(0);
    }

    const apply = runCli(home, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(true);

    const uninstall = runCli(home, "uninstall");
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(uninstall.stdout).toContain("Removed proven Agent Profile Kit-owned output");
  });

  test("malformed workspace.yaml still fails validate with actionable guidance", () => {
    const home = isolatedHome();
    initialize(home);
    writeFileSync(join(workspacePath(home), "workspace.yaml"), "schema_version: 99\n");

    const result = runCli(home, "validate");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported Workspace schema version 99");

    writeFileSync(join(workspacePath(home), "workspace.yaml"), "not: valid: yaml: [\n");
    const invalidYaml = runCli(home, "validate");
    expect(invalidYaml.status).toBe(1);
    expect(invalidYaml.stderr).toMatch(/invalid YAML|correct workspace\.yaml/i);

    rmSync(join(workspacePath(home), "workspace.yaml"));
    const missing = runCli(home, "validate");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/missing required file 'workspace\.yaml'/);
  });

  test("symlinked minimal Workspace validates and re-init does not restore scaffolding", () => {
    const home = isolatedHome();
    const realWorkspace = join(home, "real-workspace");
    mkdirSync(realWorkspace, { recursive: true });
    writeFileSync(join(realWorkspace, "workspace.yaml"), "schema_version: 1\n");
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    mkdirSync(applicationRoot, { recursive: true });
    symlinkSync(realWorkspace, join(applicationRoot, "workspace"));
    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`);

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("Workspace and Local Configuration valid");

    const reinit = runCli(home, "init");
    expect(reinit.status, reinit.stderr).toBe(0);
    expect(reinit.stdout).toMatch(/already initialized|unchanged/i);
    expect(readdirSync(realWorkspace).sort()).toEqual(["workspace.yaml"]);
    for (const entry of ["README.md", "profiles", "skills"]) {
      expect(existsSync(join(realWorkspace, entry))).toBe(false);
    }
  });

  test("init records the conventional default Workspace path", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);

    const result = runCli(home, "validate");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("2 Profiles");
    expect(result.stdout).toContain("Profiles found: coding, example");
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${workspacePath(home)}`);
  });

  test("absolute and home-relative configured Workspace paths resolve for validate", () => {
    const home = isolatedHome();
    const custom = join(home, "custom-workspace");
    mkdirSync(join(custom, "context"), { recursive: true });
    mkdirSync(join(custom, "profiles"), { recursive: true });
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(
      join(custom, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nCustom workspace rules.\n",
    );
    writeFileSync(
      join(custom, "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const projectPath = project();
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${custom}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const absolute = runCli(home, "validate");
    expect(absolute.status, absolute.stderr).toBe(0);
    expect(absolute.stdout).toContain("1 Profile");
    expect(existsSync(workspacePath(home))).toBe(false);

    const homeRelative = `~/${custom.slice(home.length + 1)}`;
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${homeRelative}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const relativeHome = runCli(home, "validate");
    expect(relativeHome.status, relativeHome.stderr).toBe(0);
    expect(relativeHome.stdout).toContain("1 Profile");
  });

  test("symlinked configured Workspace aliases keep installation identity across apply and status", () => {
    const home = isolatedHome();
    const realWorkspace = join(home, "real-custom");
    mkdirSync(join(realWorkspace, "context"), { recursive: true });
    mkdirSync(join(realWorkspace, "profiles"), { recursive: true });
    writeFileSync(join(realWorkspace, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(
      join(realWorkspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    writeFileSync(
      join(realWorkspace, "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const link = join(home, "link-custom");
    symlinkSync(realWorkspace, link);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const projectPath = project();
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${link}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );

    expect(realpathSync(link)).toBe(realpathSync(realWorkspace));

    const applyViaLink = runCli(home, "apply");
    expect(applyViaLink.status, applyViaLink.stderr).toBe(0);
    const stateAfterApply = readFileSync(statePath(home), "utf8");

    const statusViaLink = runCli(home, "status");
    expect(statusViaLink.status, statusViaLink.stderr).toBe(0);
    expect(statusViaLink.stdout).toContain("All Projects are current");

    // Change only the authored alias to the realpath spelling of the same tree.
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${realWorkspace}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const statusViaReal = runCli(home, "status");
    expect(statusViaReal.status, statusViaReal.stderr).toBe(0);
    expect(statusViaReal.stdout).toContain("All Projects are current");
    expect(statusViaReal.stdout).not.toContain("stale");

    const applyViaReal = runCli(home, "apply");
    expect(applyViaReal.status, applyViaReal.stderr).toBe(0);
    expect(applyViaReal.stdout).toContain("Apply complete");
    expect(applyViaReal.stdout).toContain("Pending: none");
    // Installation identity/state must not rewrite solely because the authored alias changed.
    expect(readFileSync(statePath(home), "utf8")).toBe(stateAfterApply);

    // Authored spelling appears in failure diagnostics when the target is invalid.
    writeFileSync(join(realWorkspace, "workspace.yaml"), "schema_version: 99\n");
    const bad = runCli(home, "validate");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain(realWorkspace);
  });

  test("invalid configured Workspace paths fail before any writes", () => {
    const home = isolatedHome();
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    mkdirSync(applicationRoot, { recursive: true });
    const projectPath = project();
    const marker = join(projectPath, "must-not-write");
    mkdirSync(projectPath, { recursive: true });

    const cases: { workspace: string; setup?: () => void; pattern: RegExp }[] = [
      { workspace: "./relative-ws", pattern: /absolute path or home-relative/i },
      { workspace: "~/projects/*", pattern: /without wildcards/i },
      { workspace: join(home, "missing-ws"), pattern: /must be an existing directory/i },
      {
        workspace: join(home, "as-file"),
        setup: () => writeFileSync(join(home, "as-file"), "not a directory\n"),
        pattern: /must be an existing directory/i,
      },
      {
        workspace: join(home, "dangling"),
        setup: () => symlinkSync(join(home, "gone"), join(home, "dangling")),
        pattern: /dangling symlink/i,
      },
      {
        workspace: join(home, "empty-ws"),
        setup: () => mkdirSync(join(home, "empty-ws")),
        pattern: /not a valid Agent Profile Kit Workspace|missing required file/i,
      },
      {
        workspace: join(home, "non-ws"),
        setup: () => {
          mkdirSync(join(home, "non-ws"));
          writeFileSync(join(home, "non-ws", "README.md"), "no marker\n");
        },
        pattern: /not a valid Agent Profile Kit Workspace|missing required file/i,
      },
    ];

    for (const example of cases) {
      example.setup?.();
      writeFileSync(
        configPath(home),
        `schema_version: 2\nworkspace: ${example.workspace}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
      );
      const beforeState = existsSync(statePath(home));
      const result = runCli(home, "apply");
      expect(result.status, `${example.workspace}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toMatch(example.pattern);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(statePath(home))).toBe(beforeState);
      expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    }
  });

  test("init with no Local Configuration still bootstraps the default Workspace", () => {
    const home = isolatedHome();
    const result = runCli(home, "init");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(existsSync(configPath(home))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toMatch(/schema_version:\s*2/);
    expect(readFileSync(configPath(home), "utf8")).toContain(`workspace: ${workspacePath(home)}`);
  });

  test("init with an explicit missing Workspace path scaffolds and records that selection", () => {
    const home = isolatedHome();
    const custom = join(home, "custom-workspace");

    const result = runCli(home, "init", custom);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(custom);
    expect(parse(readFileSync(configPath(home), "utf8"))).toEqual({
      schema_version: 2,
      workspace: custom,
      bindings: [],
    });
    expect(existsSync(workspacePath(home))).toBe(false);
    expect(readFileSync(join(custom, "workspace.yaml"), "utf8")).toBe("schema_version: 1\n");
    for (const directory of ["profiles", "context", "skills", "agents", "hooks", "tools"]) {
      expect(existsSync(join(custom, directory, ".gitkeep"))).toBe(true);
    }
    expect(existsSync(join(custom, "README.md"))).toBe(true);
    expect(existsSync(join(custom, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(custom, ".gitignore"))).toBe(true);
  });

  test("init creates missing parent directories for an explicit Workspace destination", () => {
    const home = isolatedHome();
    const custom = join(home, "nested", "custom-workspace");

    const result = runCli(home, "init", custom);

    expect(result.status, result.stderr).toBe(0);
    expect(parse(readFileSync(configPath(home), "utf8")).workspace).toBe(custom);
    expect(existsSync(join(custom, "workspace.yaml"))).toBe(true);
  });

  test("init rejects a Workspace destination reserved by Local Configuration before creating application directories", () => {
    const home = isolatedHome();

    for (const destination of [configPath(home), join(configPath(home), "nested-workspace")]) {
      const result = runCli(home, "init", destination);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/reserved for Local Configuration/i);
      expect(existsSync(join(home, ".agents"))).toBe(false);
    }
  });

  test("init rejects a Workspace root that would contain Local Configuration without mutating its source", () => {
    const home = isolatedHome();
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    const alias = join(home, "application-root-alias");
    mkdirSync(applicationRoot, { recursive: true });
    writeFileSync(join(applicationRoot, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(applicationRoot, "NOTES.md"), "user-owned source\n");
    symlinkSync(applicationRoot, alias);
    const before = readdirSync(applicationRoot).sort();

    for (const destination of [applicationRoot, alias]) {
      const result = runCli(home, "init", destination);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/reserved for Local Configuration/i);
      expect(readdirSync(applicationRoot).sort()).toEqual(before);
      expect(readFileSync(join(applicationRoot, "NOTES.md"), "utf8")).toBe("user-owned source\n");
      expect(existsSync(configPath(home))).toBe(false);
    }
  });

  test("init rejects Workspace paths inside the disposable state tree before writing", () => {
    const cases: readonly {
      readonly authored: (home: string) => string;
      readonly setup: (home: string) => void;
    }[] = [
      {
        authored: (home) => stateDirectory(home),
        setup: () => undefined,
      },
      {
        authored: (home) => join(stateDirectory(home), "nested-workspace"),
        setup: (home) => mkdirSync(stateDirectory(home), { recursive: true }),
      },
      {
        authored: (home) => join(home, "state-alias"),
        setup: (home) => {
          mkdirSync(stateDirectory(home), { recursive: true });
          symlinkSync(stateDirectory(home), join(home, "state-alias"));
        },
      },
      {
        authored: (home) => join(home, "state-alias", "nested-workspace"),
        setup: (home) => {
          mkdirSync(stateDirectory(home), { recursive: true });
          symlinkSync(stateDirectory(home), join(home, "state-alias"));
        },
      },
    ];

    for (const example of cases) {
      const home = isolatedHome();
      example.setup(home);
      const result = runCli(home, "init", example.authored(home));

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/reserved.*state|installation state/i);
      expect(existsSync(configPath(home))).toBe(false);
      expect(existsSync(workspacePath(home))).toBe(false);
      expect(existsSync(join(stateDirectory(home), "nested-workspace", "workspace.yaml"))).toBe(false);
    }
  });

  test("init rejects a configured Workspace root that contains Local Configuration", () => {
    const home = isolatedHome();
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    const alias = join(home, "application-root-alias");
    mkdirSync(applicationRoot, { recursive: true });
    writeFileSync(join(applicationRoot, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(applicationRoot, "NOTES.md"), "user-owned source\n");
    symlinkSync(applicationRoot, alias);
    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${alias}\nbindings: []\n`);
    const configBefore = readFileSync(configPath(home), "utf8");
    const sourceBefore = readdirSync(applicationRoot).sort();

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/reserved.*Local Configuration/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(configBefore);
    expect(readdirSync(applicationRoot).sort()).toEqual(sourceBefore);
    expect(readFileSync(join(applicationRoot, "NOTES.md"), "utf8")).toBe("user-owned source\n");
  });

  test("init rejects a legacy configured Workspace root that contains Local Configuration", () => {
    const home = isolatedHome();
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    const alias = join(home, "application-root-alias");
    mkdirSync(applicationRoot, { recursive: true });
    writeFileSync(join(applicationRoot, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(applicationRoot, "NOTES.md"), "user-owned source\n");
    symlinkSync(applicationRoot, alias);
    writeFileSync(configPath(home), `schema_version: 1\nworkspace: ${alias}\nbindings: []\n`);
    const configBefore = readFileSync(configPath(home), "utf8");
    const sourceBefore = readdirSync(applicationRoot).sort();

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/reserved.*Local Configuration/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(configBefore);
    expect(readdirSync(applicationRoot).sort()).toEqual(sourceBefore);
    expect(existsSync(`${configPath(home)}.lock`)).toBe(false);
  });

  test("init with an explicit valid Workspace adopts it without changing its source", () => {
    const home = isolatedHome();
    const custom = join(home, "existing-workspace");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(custom, "NOTES.md"), "user-owned source\n");
    const before = readdirSync(custom).sort();

    const result = runCli(home, "init", custom);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(custom);
    expect(parse(readFileSync(configPath(home), "utf8"))).toEqual({
      schema_version: 2,
      workspace: custom,
      bindings: [],
    });
    expect(readdirSync(custom).sort()).toEqual(before);
    expect(readFileSync(join(custom, "NOTES.md"), "utf8")).toBe("user-owned source\n");
    expect(existsSync(workspacePath(home))).toBe(false);
  });

  test("init adoption does not recommend the scaffold-only example Profile", () => {
    const home = isolatedHome();
    const custom = join(home, "existing-workspace");
    mkdirSync(join(custom, "profiles"), { recursive: true });
    mkdirSync(join(custom, "context"));
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(
      join(custom, "context", "existing-context.md"),
      "---\nid: existing-context\ndependencies: []\n---\nExisting guidance.\n",
    );
    writeFileSync(
      join(custom, "profiles", "existing.yaml"),
      "id: existing\ncontext: [existing-context]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );

    const result = runCli(home, "init", custom);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("bind example");
    expect(result.stdout).toContain("Next: run apkit validate");
    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
  });

  test("init accepts an explicit home-relative Workspace path", () => {
    const home = isolatedHome();
    const custom = join(home, "home-relative-workspace");
    const authored = "~/home-relative-workspace";

    const result = runCli(home, "init", authored);

    expect(result.status, result.stderr).toBe(0);
    expect(parse(readFileSync(configPath(home), "utf8")).workspace).toBe(authored);
    expect(existsSync(custom)).toBe(true);
    expect(existsSync(workspacePath(home))).toBe(false);
  });

  test("init scaffolds an explicit empty non-symlink Workspace destination", () => {
    const home = isolatedHome();
    const custom = join(home, "empty-workspace");
    mkdirSync(custom);

    const result = runCli(home, "init", custom);

    expect(result.status, result.stderr).toBe(0);
    expect(parse(readFileSync(configPath(home), "utf8")).workspace).toBe(custom);
    expect(readFileSync(join(custom, "workspace.yaml"), "utf8")).toBe("schema_version: 1\n");
    expect(existsSync(join(custom, "profiles", ".gitkeep"))).toBe(true);
    expect(existsSync(workspacePath(home))).toBe(false);
  });

  test("init adopts a valid Workspace through a symlink alias and preserves the authored alias", () => {
    const home = isolatedHome();
    const realWorkspace = join(home, "real-workspace");
    const alias = join(home, "workspace-alias");
    mkdirSync(realWorkspace, { recursive: true });
    writeFileSync(join(realWorkspace, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(realWorkspace, "NOTES.md"), "user-owned source\n");
    symlinkSync(realWorkspace, alias);
    const before = readdirSync(realWorkspace).sort();

    const result = runCli(home, "init", alias);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(realWorkspace);
    expect(parse(readFileSync(configPath(home), "utf8"))).toEqual({
      schema_version: 2,
      workspace: alias,
      bindings: [],
    });
    expect(readdirSync(realWorkspace).sort()).toEqual(before);
    expect(readFileSync(join(realWorkspace, "NOTES.md"), "utf8")).toBe("user-owned source\n");
  });

  test("init rejects an explicit Workspace that conflicts with the configured canonical selection", () => {
    const home = isolatedHome();
    initialize(home);
    const custom = join(home, "other-workspace");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(custom, "NOTES.md"), "user-owned source\n");
    const configBefore = readFileSync(configPath(home), "utf8");
    const sourceBefore = readdirSync(custom).sort();

    const result = runCli(home, "init", custom);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/conflict|already selects|different Workspace/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(configBefore);
    expect(readdirSync(custom).sort()).toEqual(sourceBefore);
    expect(existsSync(workspacePath(home))).toBe(true);
  });

  test("init treats an explicit alias of the configured Workspace as idempotent", () => {
    const home = isolatedHome();
    const realWorkspace = join(home, "real-workspace");
    const alias = join(home, "workspace-alias");
    mkdirSync(realWorkspace, { recursive: true });
    writeFileSync(join(realWorkspace, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(realWorkspace, "NOTES.md"), "user-owned source\n");
    symlinkSync(realWorkspace, alias);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${alias}\nbindings: []\n`);
    const configBefore = readFileSync(configPath(home), "utf8");
    const sourceBefore = readdirSync(realWorkspace).sort();

    const result = runCli(home, "init", realWorkspace);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/already initialized|unchanged/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(configBefore);
    expect(readdirSync(realWorkspace).sort()).toEqual(sourceBefore);
    expect(existsSync(workspacePath(home))).toBe(false);
  });

  test("init rejects invalid explicit Workspace destinations before publishing anything", () => {
    const cases: readonly {
      readonly authored: (home: string) => string;
      readonly setup?: (home: string) => void;
      readonly pattern: RegExp;
    }[] = [
      {
        authored: () => "./relative-workspace",
        pattern: /absolute path or home-relative/i,
      },
      {
        authored: () => "~/projects/*",
        pattern: /without wildcards/i,
      },
      {
        authored: (home) => join(home, "as-file"),
        setup: (home) => writeFileSync(join(home, "as-file"), "not a directory\n"),
        pattern: /not a directory/i,
      },
      {
        authored: (home) => join(home, "dangling"),
        setup: (home) => symlinkSync(join(home, "missing-target"), join(home, "dangling")),
        pattern: /dangling symlink|target does not exist/i,
      },
      {
        authored: (home) => join(home, "empty-symlink"),
        setup: (home) => {
          mkdirSync(join(home, "empty-target"));
          symlinkSync(join(home, "empty-target"), join(home, "empty-symlink"));
        },
        pattern: /symlink target is empty/i,
      },
      {
        authored: (home) => join(home, "invalid-directory"),
        setup: (home) => {
          mkdirSync(join(home, "invalid-directory"));
          writeFileSync(join(home, "invalid-directory", "NOTES.md"), "not a Workspace\n");
        },
        pattern: /non-empty and is not an Agent Profile Kit Workspace/i,
      },
    ];

    for (const example of cases) {
      const home = isolatedHome();
      example.setup?.(home);

      const result = runCli(home, "init", example.authored(home));

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(example.pattern);
      expect(existsSync(configPath(home))).toBe(false);
      expect(existsSync(workspacePath(home))).toBe(false);
    }
  });

  test("init rejects more than one explicit Workspace path", () => {
    const home = isolatedHome();

    const result = runCli(home, "init", join(home, "one"), join(home, "two"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("init accepts at most one Workspace path");
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(false);
  });

  test("concurrent first-time explicit init serializes canonical Workspace selection", async () => {
    const home = isolatedHome();
    const first = join(home, "first-workspace");
    const second = join(home, "second-workspace");

    const results = await Promise.all([
      runCliAsync(home, "init", first),
      runCliAsync(home, "init", second),
    ]);
    const succeeded = results.filter((result) => result.status === 0);
    const failed = results.filter((result) => result.status === 1);

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const selected = parse(readFileSync(configPath(home), "utf8")).workspace;
    expect([first, second]).toContain(selected);
    expect(existsSync(selected)).toBe(true);
    expect([first, second].filter((path) => path !== selected).every((path) => !existsSync(path))).toBe(true);
    expect(failed[0]!.stderr).toMatch(/must be an existing directory|different Workspace|already selects/i);
  });

  test("init does not switch a legacy implicit selection to a different explicit Workspace", () => {
    const home = isolatedHome();
    initialize(home);
    const legacy = "schema_version: 1\n# keep this note\nbindings: []\n";
    writeFileSync(configPath(home), legacy);
    const custom = join(home, "other-workspace");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");

    const result = runCli(home, "init", custom);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/conflict|already selects|different Workspace/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(legacy);
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(readdirSync(custom)).toEqual(["workspace.yaml"]);
  });

  test("init migrates a legacy implicit selection through an equivalent default alias", () => {
    const home = isolatedHome();
    initialize(home);
    const alias = join(home, "default-alias");
    symlinkSync(workspacePath(home), alias);
    const legacy = "schema_version: 1\nbindings: []\n";
    writeFileSync(configPath(home), legacy);
    const workspaceBefore = readdirSync(workspacePath(home)).sort();

    const result = runCli(home, "init", alias);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/migrat/i);
    expect(parse(readFileSync(configPath(home), "utf8"))).toEqual({
      schema_version: 2,
      workspace: alias,
      bindings: [],
    });
    expect(readdirSync(workspacePath(home)).sort()).toEqual(workspaceBefore);
  });

  test("init migrates a legacy custom selection when an explicit alias proves the same Workspace", () => {
    const home = isolatedHome();
    const realWorkspace = join(home, "real-workspace");
    const alias = join(home, "workspace-alias");
    mkdirSync(realWorkspace, { recursive: true });
    writeFileSync(join(realWorkspace, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(realWorkspace, "NOTES.md"), "user-owned source\n");
    symlinkSync(realWorkspace, alias);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const legacy = `schema_version: 1\nworkspace: ${alias}\nbindings: []\n`;
    writeFileSync(configPath(home), legacy);

    const result = runCli(home, "init", realWorkspace);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/migrat/i);
    expect(parse(readFileSync(configPath(home), "utf8"))).toEqual({
      schema_version: 2,
      workspace: alias,
      bindings: [],
    });
    expect(readFileSync(join(realWorkspace, "NOTES.md"), "utf8")).toBe("user-owned source\n");
  });

  test("init migrates a legacy implicit-default configuration without losing authored content", () => {
    const home = isolatedHome();
    initialize(home);
    const legacy = "schema_version: 1\n# keep this note\nbindings: []\n";
    writeFileSync(configPath(home), legacy);

    const result = runCli(home, "init");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/migrat/i);
    const migrated = readFileSync(configPath(home), "utf8");
    expect(migrated).toMatch(/schema_version:\s*2/);
    expect(migrated).toContain(`workspace: ${workspacePath(home)}`);
    expect(migrated).toContain("# keep this note");
    expect(migrated).toContain("bindings: []");
  });

  test("init migrates a legacy custom Workspace without changing its authored path or source", () => {
    const home = isolatedHome();
    const custom = join(home, "custom-workspace");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(custom, "NOTES.md"), "custom source\n");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const projectPath = project();
    const legacy =
      `schema_version: 1\r\n# keep this note\r\nworkspace: ~/custom-workspace\r\nbindings:\r\n` +
      `  - project: ${projectPath}\r\n    profile: coding\r\n    hosts: [codex]\r\n`;
    writeFileSync(configPath(home), legacy);
    chmodSync(configPath(home), 0o600);

    const result = runCli(home, "init");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/migrat/i);
    expect(readFileSync(join(custom, "NOTES.md"), "utf8")).toBe("custom source\n");
    expect(existsSync(workspacePath(home))).toBe(false);
    const migrated = readFileSync(configPath(home), "utf8");
    expect(migrated).toContain("schema_version: 2");
    expect(migrated).toContain("workspace: ~/custom-workspace");
    expect(migrated).toContain(`# keep this note`);
    expect(parse(migrated).bindings).toEqual([
      { project: projectPath, profile: "coding", hosts: ["codex"] },
    ]);
    expect(migrated.split("\n").every((line) => line.endsWith("\r") || line === "")).toBe(true);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);

    const beforeSecondInit = migrated;
    const second = runCli(home, "init");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/already initialized|unchanged/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(beforeSecondInit);
  });

  test("legacy custom Workspace migration validates before publishing configuration", () => {
    const home = isolatedHome();
    const custom = join(home, "broken-custom");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "stray.txt"), "not a Workspace\n");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const legacy = "schema_version: 1\n# keep this note\nworkspace: ~/broken-custom\nbindings: []\n";
    writeFileSync(configPath(home), legacy);

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not a valid Agent Profile Kit Workspace|missing required file/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(legacy);
    expect(readdirSync(custom).sort()).toEqual(["stray.txt"]);
    expect(existsSync(workspacePath(home))).toBe(false);
  });

  test("legacy migration cleans failed staging and preserves the canonical configuration", async () => {
    const home = isolatedHome();
    const custom = join(home, "custom-workspace");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const configuration = configPath(home);
    const legacy = "schema_version: 1\nworkspace: ~/custom-workspace\nbindings: []\n";
    writeFileSync(configuration, legacy);
    const kitDirectory = join(home, ".agents", "agent-profile-kit");
    let temporaryPath: string | undefined;

    const { initializeWorkspace } = await import("../installer/initialize-workspace.js");
    const {
      mkdir,
      readdir,
      readFile,
      rename,
      rm,
      stat,
      unlink,
      writeFile,
    } = await import("node:fs/promises");

    await expect(
      initializeWorkspace(home, {
        fileSystem: {
          mkdir,
          readdir,
          readFile,
          rename,
          rm,
          stat,
          unlink,
          writeFile: async (path, data, options) => {
            const result = await writeFile(path, data, options);
            if (typeof path === "string" && path.endsWith(".tmp")) {
              temporaryPath = path;
              throw new Error("simulated Local Configuration staging failure");
            }
            return result;
          },
        },
      }),
    ).rejects.toThrow(/simulated Local Configuration staging failure/);

    expect(readFileSync(configuration, "utf8")).toBe(legacy);
    expect(existsSync(`${configuration}.lock`)).toBe(false);
    expect(temporaryPath).toBeDefined();
    expect(existsSync(temporaryPath!)).toBe(false);
    expect(readdirSync(kitDirectory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("desired-state and binding-recording commands reject unmigrated configuration without writing", () => {
    const home = isolatedHome();
    initialize(home);
    const legacy = "schema_version: 1\nbindings: []\n";
    writeFileSync(configPath(home), legacy);
    const projectPath = project();
    const beforeWorkspace = readdirSync(workspacePath(home)).sort();

    const commands: readonly (readonly string[])[] = [
      ["validate"],
      ["preview"],
      ["apply"],
      ["status"],
      ["bind", "coding", projectPath, "--host", "codex"],
      ["unbind", projectPath],
    ];
    for (const arguments_ of commands) {
      const result = runCli(home, ...arguments_);
      expect(result.status, `${arguments_.join(" ")}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toMatch(/legacy schema_version 1|run apkit init/i);
    }

    expect(readFileSync(configPath(home), "utf8")).toBe(legacy);
    expect(readdirSync(workspacePath(home)).sort()).toEqual(beforeWorkspace);
    expect(existsSync(statePath(home))).toBe(false);
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("init with a valid custom Workspace reports unchanged and does not mutate it", () => {
    const home = isolatedHome();
    const custom = join(home, "preexisting-workspace");
    mkdirSync(custom, { recursive: true });
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(custom, "NOTES.md"), "user owned\n");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${custom}\nbindings: []\n`,
    );

    const result = runCli(home, "init");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/already initialized|unchanged/i);
    expect(readdirSync(custom).sort()).toEqual(["NOTES.md", "workspace.yaml"]);
    for (const entry of ["README.md", "profiles", "skills", "context"]) {
      expect(existsSync(join(custom, entry))).toBe(false);
    }
    expect(existsSync(workspacePath(home))).toBe(false);
  });

  test("init with an invalid custom Workspace fails without creating or repairing source", () => {
    const home = isolatedHome();
    const custom = join(home, "broken-custom");
    mkdirSync(custom);
    writeFileSync(join(custom, "stray.txt"), "not a workspace\n");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${custom}\nbindings: []\n`,
    );

    const result = runCli(home, "init");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not a valid Agent Profile Kit Workspace|missing required file/i);
    expect(readdirSync(custom).sort()).toEqual(["stray.txt"]);
    expect(existsSync(workspacePath(home))).toBe(false);
  });

  test("bindings resolve Profiles from the configured Workspace", () => {
    const home = isolatedHome();
    const custom = join(home, "bound-workspace");
    mkdirSync(join(custom, "profiles"), { recursive: true });
    mkdirSync(join(custom, "context"), { recursive: true });
    writeFileSync(join(custom, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(
      join(custom, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nFrom custom Workspace.\n",
    );
    writeFileSync(
      join(custom, "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    // Default path has a different Profile set (or is absent).
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const projectPath = project();
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${custom}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("1 Profile, 1 Project Binding");

    const apply = runCli(home, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".codex", "AGENTS.md")) || existsSync(join(projectPath, "AGENTS.md")) || existsSync(join(projectPath, ".agent-profile-kit"))).toBe(true);
  });

  test("validate names the Profiles found and the unique Hosts bound", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    writeFileSync(
      join(workspacePath(home), "profiles", "writing.yaml"),
      "id: writing\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const first = project();
    const second = project();
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${first}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${second}\n    profile: writing\n    hosts: [claude, codex]\n`,
    );

    const result = runCli(home, "validate");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("3 Profiles, 2 Project Bindings");
    expect(result.stdout).toContain("Profiles found: coding, example, writing");
    expect(result.stdout).toContain("Hosts bound: claude, codex");
  });

  test("validate normalizes home-relative project roots and does not invoke Codex", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = join(home, "project");
    mkdirSync(projectPath);
    writeContextProfile(home);
    bind(home, `~/${projectPath.slice(home.length + 1)}`);
    const invoked = join(home, "codex-invoked");
    const bin = join(home, "bin");
    // `bind` already stages a controlled Codex stub under home/bin; overwrite it
    // so validate must not call this trap (validate is capability-free).
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf invoked > ${invoked}\nexit 1\n`);
    execFileSync("chmod", ["+x", join(bin, "codex")]);

    const result = spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, "validate"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Local Configuration valid");
    expect(existsSync(invoked)).toBe(false);
  });

  test("validate rejects empty, relative, wildcard, missing, and unsupported bindings", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const first = project();
    const invalidBindings = [
      {
        source: `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: []\n`,
        message: "hosts must be a non-empty array",
      },
      {
        source: `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ./relative\n    profile: coding\n    hosts: [codex]\n`,
        message: "absolute path or home-relative",
      },
      {
        source: `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ~/projects/*\n    profile: coding\n    hosts: [codex]\n`,
        message: "without wildcards",
      },
      {
        source: `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${join(home, "missing")}\n    profile: coding\n    hosts: [codex]\n`,
        message: "must be an existing directory",
      },
      {
        source: `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: missing\n    hosts: [codex]\n`,
        message: "does not exist in this Workspace",
        detail: "Available Profiles: coding",
      },
      {
        source: `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [cursor]\n`,
        message: "unsupported Agent Host 'cursor'",
      },
    ];

    for (const invalid of invalidBindings) {
      writeFileSync(configPath(home), invalid.source);
      const result = runCli(home, "validate");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(invalid.message);
      if ("detail" in invalid) expect(result.stderr).toContain(invalid.detail);
    }
  });

  test("validate rejects symlink aliases that normalize to one canonical project root", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const realProject = project();
    const alias = join(home, "project-alias");
    symlinkSync(realProject, alias);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${realProject}\n    profile: coding\n    hosts: [codex]\n  - project: ${alias}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "validate");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicate canonical root");
  });

  test("preview reports desired additions without writing project, state, or host configuration", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeFileSync(join(projectPath, "AGENTS.md"), "repository-owned\n");
    writeContextProfile(home);
    bind(home, projectPath);
    const result = runCli(home, "preview", "--verbose");

    expect(result.status, result.stderr).toBe(0);
    expect(humanText(result.stdout)).toContain(humanText(`${projectPath}: addition`));
    expect(result.stdout).toContain("Profile coding");
    expect(result.stdout).toContain("Context Module: team-rules");
    expect(result.stdout).toContain(".codex/hooks.json");
    expect(humanText(result.stdout)).toContain(
      humanText(`Launch Codex from the exact bound project root: ${projectPath}`),
    );
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex"))).toBe(false);
    expect(existsSync(statePath(home))).toBe(false);
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("repository-owned\n");

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).not.toContain("Launch Codex from the exact bound project root:");

    for (const command of ["status", "apply"]) {
      const output = runCli(home, command);
      expect(output.status, output.stderr).toBe(0);
      expect(humanText(output.stdout)).toContain(
        humanText(`Launch Codex from the exact bound project root: ${projectPath}`),
      );
    }
  });

  test("preview leads with a concise ready-to-apply outcome and grouped change counts", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);

    const result = runCli(home, "preview");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.startsWith("Ready to apply\n")).toBe(true);
    expect(result.stdout).toContain("Projects: 1");
    expect(result.stdout).toMatch(/Changes: .*addition/);
    expect(humanText(result.stdout)).toContain(humanText(`Project: ${projectPath}`));
    expect(result.stdout).not.toContain("Desired State:");
    expect(result.stdout).not.toContain("Context:");
  });

  test("status gives an all-current result without enumerating unchanged outputs", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);

    const result = runCli(home, "status");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.startsWith("All Projects are current (1 Project)\n")).toBe(true);
    expect(result.stdout.match(/All Projects are current/g)).toHaveLength(1);
    expect(result.stdout).not.toContain("Changes:");
    expect(result.stdout).not.toContain("No Projects need attention.");
    expect(result.stdout).not.toContain("unchanged generated file");
    expect(result.stdout).not.toContain("Desired State:");
  });

  test("status with no Project Bindings states the condition once and gives discovery next steps", () => {
    const home = isolatedHome();
    initialize(home);

    const result = runCli(home, "status");

    expect(result.status, result.stderr).toBe(0);
    expect(humanText(result.stdout)).toBe(
      humanText(
        "No Projects are configured.\n" +
        "Next: Run apkit list projects to inspect Project Bindings, or apkit bind <profile> --host <host> to configure one.\n",
      ),
    );
    expect(result.stdout.match(/No Projects are configured/g)).toHaveLength(1);
    expect(result.stdout).not.toContain("Projects: 0");
    expect(result.stdout).toContain("apkit list projects");
    expect(result.stdout).toContain("apkit bind <profile> --host <host>");
  });

  test("preview reports only the exact bound repository while summarizing mixed changes", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-presentation-repository-");
    const worktree = addWorktree(repository, "presentation-worktree");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);

    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated presentation Context.\n",
    );
    const result = runCli(home, "preview");

    expect(result.status, result.stderr).toBe(0);
    expect(humanText(result.stdout)).toContain(humanText(`Project: ${repository}`));
    expect(result.stdout).not.toContain(`Project: ${realpathSync(worktree)}`);
    expect(result.stdout).toMatch(/Changes: .*update/);
    expect(result.stdout).not.toContain("Desired State:");
  });

  test("preview treats Codex SessionStart hook configuration as advisory", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    const projectConfig = join(projectPath, ".codex", "config.toml");
    mkdirSync(join(projectPath, ".codex"));

    writeFileSync(join(home, ".codex", "config.toml"), "");
    writeFileSync(projectConfig, "");
    const missing = runCli(home, "preview");
    expect(missing.status, missing.stderr).toBe(0);
    expect(missing.stdout).toContain("Ready to apply");
    expect(missing.stdout).not.toContain("SessionStart hooks are not enabled");

    const secretLikeValue = "sk-test-should-not-leak";
    writeFileSync(join(home, ".codex", "config.toml"), `[features ${secretLikeValue}\n`);
    const malformed = runCli(home, "preview", "--verbose");
    expect(malformed.status, malformed.stderr).toBe(0);
    expect(malformed.stdout).toContain("Warnings:");
    expect(malformed.stdout).toContain("invalid TOML at line 1, column 2");
    expect(malformed.stdout).not.toContain(secretLikeValue);

    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = \"false\"\n");
    const invalidType = runCli(home, "preview", "--verbose");
    expect(invalidType.status, invalidType.stderr).toBe(0);
    expect(invalidType.stdout).toContain("Warnings:");
    expect(invalidType.stdout).toContain("[features].hooks at");
    expect(invalidType.stdout).toContain("must be a boolean");

    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = false\n");
    const disabled = runCli(home, "preview", "--verbose");
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(disabled.stdout).toContain("Warnings:");
    expect(disabled.stdout).toContain("SessionStart hooks are not enabled");
    expect(disabled.stdout).toContain(join(home, ".codex", "config.toml"));
    expect(disabled.stdout).toContain("[features].hooks = true");

    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    writeFileSync(projectConfig, "[features]\nhooks = false\n");
    const projectDisabled = runCli(home, "preview", "--verbose");
    expect(projectDisabled.status, projectDisabled.stderr).toBe(0);
    expect(projectDisabled.stdout).toContain("Warnings:");
    expect(projectDisabled.stdout).toContain(projectConfig);

    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = false\n");
    writeFileSync(projectConfig, "[features]\nhooks = true\n");
    const projectEnabledWithCanonicalSetting = runCli(home, "preview");
    expect(projectEnabledWithCanonicalSetting.status, projectEnabledWithCanonicalSetting.stderr).toBe(0);

    writeFileSync(join(home, ".codex", "config.toml"), "");
    writeFileSync(projectConfig, "[features]\ncodex_hooks = true\n");
    const projectEnabled = runCli(home, "preview");
    expect(projectEnabled.status, projectEnabled.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
  });

  test("default warnings shorten the bound project root from the working directory", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(join(projectPath, ".codex", "config.toml"), "[features]\nhooks = false\n");

    const result = runCliAt(home, projectPath, "preview");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("enabled by .codex/config.toml;");
    expect(result.stdout).not.toContain("./.codex/config.toml");
    expect(result.stdout).not.toContain(projectPath);
  });

  test("verbose diagnostics shorten the bound project root from the working directory", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(join(projectPath, ".codex", "config.toml"), "[features]\nhooks = false\n");

    const result = runCliAt(home, projectPath, "preview", "--verbose");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(".codex/config.toml");
    expect(result.stdout).not.toContain("./.codex/config.toml");
    expect(result.stdout).toContain(".agent-profile-kit/codex/context.md: addition");
    expect(result.stdout).not.toContain("./.agent-profile-kit/codex/context.md");
    expect(result.stdout).not.toContain(projectPath);
    expect(result.stdout).not.toContain(realpathSync(projectPath));
  });

  test("verbose Git exclusions shorten the bound project root from the working directory", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = gitRepository();
    writeContextProfile(home);
    bind(home, projectPath);

    const result = runCliAt(home, projectPath, "preview", "--verbose");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("- .git/info/exclude:");
    expect(result.stdout).not.toContain("./.git/info/exclude");
    expect(result.stdout).not.toContain(projectPath);
    expect(result.stdout).not.toContain(realpathSync(projectPath));
  });

  test("apply and status preserve Codex configuration warnings without blocking installation", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = false\n");

    const apply = runCli(home, "apply", "--verbose");
    expect(apply.status, apply.stderr).toBe(0);
    expect(apply.stdout).toContain("Warnings:");
    expect(apply.stdout).toContain("SessionStart hooks are not enabled");
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(true);

    const status = runCli(home, "status", "--verbose");
    expect(status.status, status.stderr).toBe(0);
    expect(humanText(status.stdout)).toContain(humanText(`${projectPath}: current`));
    expect(status.stdout).toContain("Warnings:");
    expect(status.stdout).toContain("SessionStart hooks are not enabled");
    expect(status.stdout).not.toContain(`${projectPath}: blocked`);
  });

  test("preview reports blockers from every project in one complete preflight", () => {
    const home = isolatedHome();
    initialize(home);
    const first = project("agent-profile-kit-preflight-a-");
    const second = project("agent-profile-kit-preflight-b-");
    writeContextProfile(home);
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = false\n");
    mkdirSync(join(second, ".codex"));
    writeFileSync(join(second, ".codex", "hooks.json"), "occupied\n");
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "preview");

    expect(result.status).toBe(2);
    expect(result.stdout.match(/SessionStart hooks are not enabled/g)).toHaveLength(2);
    expect(result.stdout).toContain(".codex/hooks.json is occupied by unowned or drifted output");
    expect(existsSync(join(first, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(second, ".agent-profile-kit"))).toBe(false);
  });

  test("blocked apply renders one apply report without duplicate stderr blockers", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "repository owned\n");
    writeContextProfile(home);
    bind(home, projectPath);

    const result = runCli(home, "apply");
    const blocker = ".codex/hooks.json is occupied by unowned or drifted output";

    expect(result.status).toBe(2);
    expect(result.stdout.startsWith("Apply blocked\n")).toBe(true);
    expect(result.stdout.split(blocker)).toHaveLength(2);
    expect(humanText(result.stdout)).toContain(
      humanText(`Next:\n- ${projectPath}: Resolve the reported blocker, then run apkit apply again.`),
    );
    expect(result.stderr).toBe("");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("blocked default output does not repeat the working-directory project root", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "repository owned\n");
    writeContextProfile(home);
    bind(home, projectPath);

    const result = runCliAt(home, projectPath, "apply");

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Project: .");
    expect(result.stdout).not.toContain(projectPath);
    expect(result.stdout).not.toContain(realpathSync(projectPath));
  });

  test("preview, apply, and status accept --verbose and --json while rejecting other presentation arguments", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);

    for (const command of ["preview", "apply", "status"] as const) {
      const verbose = runCli(home, command, "--verbose");
      expect(verbose.status, `${command}: ${verbose.stderr}`).toBe(0);
      expect(verbose.stdout).toContain("Desired State:");
      expect(verbose.stdout).toContain("Resolved artifacts:");
      expect(verbose.stdout).toContain("Context:");

      const duplicateVerbose = runCli(home, command, "--verbose", "--verbose");
      expect(duplicateVerbose.status, `${command} duplicate flag: ${duplicateVerbose.stderr}`).toBe(0);
      expect(duplicateVerbose.stderr).toBe("");

      const json = runCli(home, command, "--json");
      expect(json.status, `${command} --json: ${json.stderr}`).toBe(0);
      expect(json.stderr).toBe("");
      const payload = JSON.parse(json.stdout) as {
        readonly command: string;
        readonly schemaVersion: number;
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.command).toBe(command);

      const both = runCli(home, command, "--verbose", "--json");
      expect(both.status, `${command} both flags: ${both.stderr}`).toBe(0);
      expect(JSON.parse(both.stdout)).toMatchObject({ command, schemaVersion: 1 });

      const unsupported = runCli(home, command, "--yaml");
      expect(unsupported.status).toBe(1);
      expect(unsupported.stderr).toContain(`${command} does not accept argument '--yaml'`);
    }
  });

  test("preview, apply, and status share a uniform exit-code matrix for clean, blocked, and tool-error states", () => {
    const cleanHome = isolatedHome();
    initialize(cleanHome);
    const cleanProject = project();
    writeContextProfile(cleanHome);
    bind(cleanHome, cleanProject);
    expect(runCli(cleanHome, "apply").status, "seed apply").toBe(0);

    for (const command of ["preview", "apply", "status"] as const) {
      const clean = runCli(cleanHome, command);
      expect(clean.status, `${command} clean text: ${clean.stderr}`).toBe(0);
      const cleanJson = runCli(cleanHome, command, "--json");
      expect(cleanJson.status, `${command} clean json: ${cleanJson.stderr}`).toBe(0);
      expect(JSON.parse(cleanJson.stdout)).toMatchObject({
        command,
        outcome: "clean",
        schemaVersion: 1,
      });
    }

    const blockedHome = isolatedHome();
    initialize(blockedHome);
    const blockedProject = project();
    mkdirSync(join(blockedProject, ".codex"));
    writeFileSync(join(blockedProject, ".codex", "hooks.json"), "repository owned\n");
    writeContextProfile(blockedHome);
    bind(blockedHome, blockedProject);

    for (const command of ["preview", "apply", "status"] as const) {
      const blocked = runCli(blockedHome, command);
      expect(blocked.status, `${command} blocked text: ${blocked.stderr}`).toBe(2);
      expect(blocked.stdout).toMatch(/Blocker:|blocked/i);
      const blockedJson = runCli(blockedHome, command, "--json");
      expect(blockedJson.status, `${command} blocked json: ${blockedJson.stderr}`).toBe(2);
      const payload = JSON.parse(blockedJson.stdout) as {
        readonly blockers: readonly unknown[];
        readonly outcome: string;
      };
      expect(payload.outcome).toBe("blocked");
      expect(payload.blockers.length).toBeGreaterThan(0);
    }

    const toolErrorHome = isolatedHome();
    // No init: Local Configuration is missing, so desired-state commands fail as tool errors.
    for (const command of ["preview", "apply", "status"] as const) {
      const failed = runCli(toolErrorHome, command);
      expect(failed.status, `${command} tool error: ${failed.stdout}`).toBe(1);
      expect(failed.stderr.length).toBeGreaterThan(0);
      const failedJson = runCli(toolErrorHome, command, "--json");
      expect(failedJson.status, `${command} tool error json: ${failedJson.stderr}`).toBe(1);
      const payload = JSON.parse(failedJson.stdout) as {
        readonly command: string;
        readonly error: string;
        readonly outcome: string;
        readonly schemaVersion: number;
      };
      expect(payload).toMatchObject({
        schemaVersion: 1,
        command,
        outcome: "error",
      });
      expect(payload.error.length).toBeGreaterThan(0);
    }

    // Pending work without blockers exits 0 for every lifecycle command.
    // Gate pending vs current via JSON outcome, not exit code (DEC-024).
    const pendingHome = isolatedHome();
    initialize(pendingHome);
    const pendingProject = project();
    writeContextProfile(pendingHome);
    bind(pendingHome, pendingProject);
    for (const command of ["preview", "status"] as const) {
      const pending = runCli(pendingHome, command, "--json");
      expect(pending.status, `${command} pending: ${pending.stderr}`).toBe(0);
      expect(JSON.parse(pending.stdout)).toMatchObject({
        command,
        outcome: "attention",
        schemaVersion: 1,
      });
    }
    const firstApply = runCli(pendingHome, "apply", "--json");
    expect(firstApply.status, `apply install: ${firstApply.stderr}`).toBe(0);
    expect(JSON.parse(firstApply.stdout)).toMatchObject({
      command: "apply",
      schemaVersion: 1,
    });
    expect(["clean", "attention"]).toContain(
      (JSON.parse(firstApply.stdout) as { readonly outcome: string }).outcome,
    );
  });

  test("apply creates the marker, manifest, composed Context, and native SessionStart hook", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeFileSync(join(projectPath, "AGENTS.md"), "repository-owned\n");
    writeContextProfile(home);
    bind(home, projectPath);
    const preview = runCli(home, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(
      "Review and approve the generated SessionStart hook when Codex asks.",
    );
    expect(humanText(preview.stdout)).toContain(
      humanText(`Launch Codex from the exact bound project root: ${projectPath}`),
    );
    expect(preview.stdout).not.toContain("Trust the bound project in Codex.");
    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.startsWith("Apply complete\n")).toBe(true);
    expect(result.stdout).toContain("State: current");
    expect(result.stdout).not.toContain("State: addition");
    expect(result.stdout).toContain("Applied:");
    expect(result.stdout).toContain("+ .agent-profile-kit/codex/context.md");
    expect(result.stdout).toContain("+ .agent-profile-kit/installation.json");
    expect(result.stdout).toContain("+ .codex/hooks.json");
    expect(result.stdout).toContain(
      "Review and approve the generated SessionStart hook when Codex asks.",
    );
    expect(result.stdout).toContain("Declining the hook prevents Profile Context from loading.");
    expect(result.stdout).toContain("Trust the bound project in Codex.");
    expect(humanText(result.stdout)).toContain(
      humanText(`Launch Codex from the exact bound project root: ${projectPath}`),
    );
    expect(humanText(result.stdout)).toEndWith(
      humanText(
        `After completing the Host setup above, Profile coding becomes active on the next launch ` +
          `of each bound Host (codex) from ${projectPath}.`,
      ),
    );
    expect(result.stdout).not.toContain("Desired State:");
    const contextPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    const hookPath = join(projectPath, ".codex", "hooks.json");
    const markerPath = join(projectPath, ".agent-profile-kit", "installation.json");
    expect(readFileSync(contextPath, "utf8")).toContain("Profile: coding");
    expect(readFileSync(contextPath, "utf8")).toContain("Context Module: team-rules");
    expect(readFileSync(contextPath, "utf8")).toContain("Repository-owned project instructions");
    const hook = JSON.parse(readFileSync(hookPath, "utf8")) as { hooks: { SessionStart: readonly { matcher: string; hooks: readonly { command: string }[] }[] } };
    expect(hook.hooks.SessionStart[0]?.matcher).toBe("startup|clear|compact");
    expect(hook.hooks.SessionStart[0]?.hooks[0]?.command).toContain("git rev-parse --show-toplevel");
    expect(hook.hooks.SessionStart[0]?.hooks[0]?.command).not.toContain(projectPath);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(marker).sort()).toEqual(["installation_id", "schema_version"]);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      schema_version: number;
      installations: Array<{ outputs: Array<{ mode: number; type: string }> }>;
    };
    expect(state.schema_version).toBe(5);
    expect(state).toHaveProperty("temporary_installations");
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]!.outputs.every((output) =>
      output.type === "file" && output.mode === 0o644
    )).toBe(true);
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
    const status = runCli(home, "status");
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout.match(/Codex setup:/g)).toHaveLength(1);
  });

  test("successful apply reports verified current state and a separate apply receipt", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);

    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated canonical Context.\n",
    );

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Applied:");
    expect(result.stdout).toContain("~ .agent-profile-kit/codex/context.md");
    expect(humanText(result.stdout)).toContain(humanText(`Project: ${projectPath}`));
    expect(result.stdout).toContain("State: current");
    expect(result.stdout).not.toContain("State: stale source");
  });

  test("apply receipt work expands only the changed project in a multi-project binding", () => {
    const home = isolatedHome();
    initialize(home);
    const changedProject = project("agent-profile-kit-apply-changed-");
    const untouchedProject = project("agent-profile-kit-apply-untouched-");
    writeContextProfile(home);
    writeFileSync(
      join(workspacePath(home), "profiles", "alternate.yaml"),
      "id: alternate\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${changedProject}\n    profile: coding\n    hosts: [codex]\n  - project: ${untouchedProject}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);

    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${changedProject}\n    profile: alternate\n    hosts: [codex]\n  - project: ${untouchedProject}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(humanText(result.stdout)).toContain(humanText(`Project: ${changedProject}`));
    expect(humanText(result.stdout)).not.toContain(humanText(`Project: ${untouchedProject}`));
  });

  test("verbose apply labels pending and applied work separately", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated canonical Context.\n",
    );

    const result = runCli(home, "apply", "--verbose");

    expect(result.status, result.stderr).toBe(0);
    const pending = result.stdout.indexOf("Pending:");
    const applied = result.stdout.indexOf("Applied:");
    expect(pending).toBeGreaterThanOrEqual(0);
    expect(applied).toBeGreaterThan(pending);
    expect(humanText(result.stdout.slice(pending, applied))).toContain(humanText(`${projectPath}: current`));
    expect(humanText(result.stdout.slice(pending, applied))).not.toContain(humanText(`${projectPath}: stale source`));
    expect(humanText(result.stdout.slice(applied))).toContain(humanText(`${projectPath}: stale source`));
  });

  test("reads schema-v2 installation state for preview and rewrites canonical records on apply", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-state-v2-");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);

    const current = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly unknown[];
    };
    writeFileSync(statePath(home), stringify({
      schema_version: 2,
      installations: current.installations,
    }));

    const preview = runCli(home, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect((parse(readFileSync(statePath(home), "utf8")) as { schema_version: number }).schema_version)
      .toBe(2);

    const applied = runCli(home, "apply");
    expect(applied.status, applied.stderr).toBe(0);
    const migrated = parse(readFileSync(statePath(home), "utf8")) as {
      schema_version: number;
      temporary_installations: readonly unknown[];
      repository_exclusions: readonly {
        target: string;
        contributions: readonly { installation_id: string; entries: readonly string[] }[];
        entries: readonly string[];
      }[];
    };
    expect(migrated.schema_version).toBe(5);
    expect(migrated.temporary_installations).toEqual([]);
    expect(migrated.repository_exclusions).toEqual([{
      target: join(realpathSync(repository), ".git", "info", "exclude"),
      contributions: [{
        installation_id: (current.installations[0] as { installation_id: string }).installation_id,
        entries: ["/.agent-profile-kit/codex/context.md", "/.agent-profile-kit/installation.json", "/.codex/hooks.json"],
      }],
      entries: ["/.agent-profile-kit/codex/context.md", "/.agent-profile-kit/installation.json", "/.codex/hooks.json"],
    }]);
  });

  test("reads schema-v3 installation state and rewrites intended teardown support on apply", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const previous = parse(readFileSync(statePath(home), "utf8")) as Record<string, unknown>;
    previous.schema_version = 3;
    delete previous.intended_teardowns;
    delete previous.temporary_installations;
    writeFileSync(statePath(home), stringify(previous));

    const preview = runCli(home, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect((parse(readFileSync(statePath(home), "utf8")) as { schema_version: number }).schema_version)
      .toBe(3);

    const applied = runCli(home, "apply");
    expect(applied.status, applied.stderr).toBe(0);
    const migrated = parse(readFileSync(statePath(home), "utf8")) as {
      intended_teardowns: readonly unknown[];
      schema_version: number;
      temporary_installations: readonly unknown[];
    };
    expect(migrated.schema_version).toBe(5);
    expect(migrated.intended_teardowns).toEqual([]);
    expect(migrated.temporary_installations).toEqual([]);
  });

  test("apply leaves current installation outputs and state untouched", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const paths = [
      join(projectPath, ".agent-profile-kit", "codex", "context.md"),
      join(projectPath, ".agent-profile-kit", "installation.json"),
      join(projectPath, ".codex", "hooks.json"),
      statePath(home),
    ];
    const before = paths.map((path) => statSync(path).mtimeMs);

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Apply complete");
    expect(result.stdout).toContain("Pending: none");
    expect(result.stdout).toContain("All Projects were already current.");
    expect(result.stdout).toContain("Applied: none");
    expect(result.stdout).not.toContain("becomes active");
    expect(result.stdout).not.toContain("generated file update");
    expect(result.stdout).not.toContain("unchanged generated file");
    expect(paths.map((path) => statSync(path).mtimeMs)).toEqual(before);
  });

  test("an installation created before the command rename stays current without re-apply", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: { engine_version: string }[];
    };
    state.installations[0]!.engine_version = "0.34.1";
    writeFileSync(statePath(home), stringify(state));
    const stateBefore = readFileSync(statePath(home), "utf8");
    const outputPaths = [
      join(projectPath, ".agent-profile-kit", "codex", "context.md"),
      join(projectPath, ".agent-profile-kit", "installation.json"),
      join(projectPath, ".codex", "hooks.json"),
    ];
    const outputTimesBefore = outputPaths.map((path) => statSync(path).mtimeMs);

    const status = runCli(home, "status", "--verbose");
    expect(status.status, status.stderr).toBe(0);
    expect(humanText(status.stdout)).toContain(humanText(`${projectPath}: current`));

    const applied = runCli(home, "apply");
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toContain("Applied: none");
    expect(readFileSync(statePath(home), "utf8")).toBe(stateBefore);
    expect(outputPaths.map((path) => statSync(path).mtimeMs)).toEqual(outputTimesBefore);
  });

  test("preview classifies output additions, updates, removals, and unchanged output without writing", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const contextPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    const before = readFileSync(contextPath, "utf8");

    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated canonical Context.\n",
    );
    const changed = runCli(home, "preview", "--verbose");
    expect(changed.status, changed.stderr).toBe(0);
    expect(humanText(changed.stdout)).toContain(
      humanText(`${projectPath}/.agent-profile-kit/codex/context.md: update`),
    );
    expect(humanText(changed.stdout)).toContain(
      humanText(`${projectPath}/.codex/hooks.json: unchanged`),
    );
    expect(readFileSync(contextPath, "utf8")).toBe(before);

    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`);
    const removed = runCli(home, "preview", "--verbose");
    expect(removed.status, removed.stderr).toBe(0);
    expect(humanText(removed.stdout)).toContain(
      humanText(`${projectPath}/.agent-profile-kit/codex/context.md: removal`),
    );
    expect(existsSync(contextPath)).toBe(true);
  });

  test("nested Git project bindings emit a Git-root-relative Context hook", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = project("agent-profile-kit-git-");
    const projectPath = join(repository, "nested");
    mkdirSync(projectPath);
    execFileSync("git", ["init", "-q", repository]);
    writeContextProfile(home);
    bind(home, projectPath);

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    const hook = JSON.parse(
      readFileSync(join(projectPath, ".codex", "hooks.json"), "utf8"),
    ) as { hooks: { SessionStart: readonly { hooks: readonly { command: string }[] }[] } };
    const command = hook.hooks.SessionStart[0]?.hooks[0]?.command ?? "";
    expect(command).toContain("$root/nested/.agent-profile-kit/codex/context.md");
    const output = spawnSync("sh", ["-c", command], {
      cwd: repository,
      encoding: "utf8",
    });
    expect(output.status, output.stderr).toBe(0);
    expect(output.stdout).toContain("Profile: coding");
  });

  test("predictable occupied project output blocks every binding before any write", () => {
    const home = isolatedHome();
    initialize(home);
    const first = project("agent-profile-kit-conflict-");
    const second = project("agent-profile-kit-conflict-");
    mkdirSync(join(first, ".codex"));
    writeFileSync(join(first, ".codex", "hooks.json"), "repository-owned hook\n");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "apply");

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Apply blocked");
    expect(result.stderr).toBe("");
    expect(existsSync(join(first, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(second, ".agent-profile-kit"))).toBe(false);
    expect(readFileSync(join(first, ".codex", "hooks.json"), "utf8")).toBe("repository-owned hook\n");
  });

  test("preview output is deterministic regardless of Project Binding order", () => {
    const home = isolatedHome();
    initialize(home);
    const first = project("agent-profile-kit-order-a-");
    const second = project("agent-profile-kit-order-b-");
    writeContextProfile(home);
    const configuration = (projects: readonly string[]) =>
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n${projects.map((projectPath) => `  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`).join("")}`;
    writeFileSync(configPath(home), configuration([first, second]));
    const forward = runCli(home, "preview");
    writeFileSync(configPath(home), configuration([second, first]));
    const reverse = runCli(home, "preview");

    expect(forward.status, forward.stderr).toBe(0);
    expect(reverse.status, reverse.stderr).toBe(0);
    expect(reverse.stdout).toBe(forward.stdout);
  });

  test("changing a Profile updates every project bound to its current Workspace form", () => {
    const home = isolatedHome();
    initialize(home);
    const first = project("agent-profile-kit-profile-a-");
    const second = project("agent-profile-kit-profile-b-");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nOne current Workspace form.\n",
    );

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    for (const projectPath of [first, second]) {
      expect(readFileSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"), "utf8"))
        .toContain("One current Workspace form.");
    }
    const state = parse(readFileSync(statePath(home), "utf8")) as { installations: readonly { profile_id: string }[] };
    expect(state.installations.map((installation) => installation.profile_id)).toEqual(["coding", "coding"]);
  });

  test("tracked destinations block even when the tracked file is currently absent", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = join(home, "tracked-project");
    mkdirSync(projectPath);
    execFileSync("git", ["init", "-q", projectPath]);
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "tracked placeholder\n");
    execFileSync("git", ["-C", projectPath, "add", ".codex/hooks.json"]);
    rmSync(join(projectPath, ".codex", "hooks.json"));
    writeContextProfile(home);
    const authoredProject = `~/${projectPath.slice(home.length + 1)}`;
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${authoredProject}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "preview");

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain("Projects: 1");
    expect(humanText(result.stdout)).toContain(humanText(`Project: ${authoredProject}`));
    expect(result.stdout).toContain("Tracked project path '.codex/hooks.json' is repository-owned");
    expect(humanText(result.stdout)).toContain(
      humanText("generated files must be exclusively managed by Agent Profile Kit"),
    );
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);

    const apply = runCli(home, "apply");
    expect(apply.status).toBe(2);
    expect(apply.stdout).toContain("Apply blocked");
    expect(humanText(apply.stdout)).toContain(
      humanText("generated files must be exclusively managed by Agent Profile Kit"),
    );
  });

  test("a Git binding reconciles only its exact root and preserves local exclusions", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository();
    const worktree = addWorktree(repository, "existing-worktree");
    const exclude = execFileSync("git", ["-C", repository, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { encoding: "utf8" }).trim();
    const unrelated = "# repository-local author bytes\n*.scratch\n\n";
    const sharedIgnore = "# shared repository policy\n*.shared\n";
    writeFileSync(exclude, unrelated);
    writeFileSync(join(repository, ".gitignore"), sharedIgnore);
    execFileSync("git", ["-C", repository, "add", ".gitignore"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "shared ignore"]);
    writeContextProfile(home);
    bind(home, repository);

    const preview = runCli(home, "preview", "--verbose");

    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(repository);
    expect(preview.stdout).not.toContain(worktree);

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(repository, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(repository, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(worktree, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(worktree, ".codex"))).toBe(false);
    expect(execFileSync("git", ["-C", repository, "status", "--short"], { encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["-C", worktree, "status", "--short"], { encoding: "utf8" })).toBe("");

    const status = runCli(home, "status", "--verbose");
    expect(status.status, status.stderr).toBe(0);
    expect(humanText(status.stdout)).toContain(humanText(`${repository}: current`));
    expect(status.stdout).not.toContain(worktree);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { project: string }[];
    };
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.project).toBe(realpathSync(repository));
    const installedExclude = readFileSync(exclude, "utf8");
    expect(installedExclude.startsWith(unrelated)).toBe(true);
    expect(installedExclude).toContain("# BEGIN Agent Profile Kit generated paths");
    expect(installedExclude).toContain("/.agent-profile-kit/installation.json");
    expect(installedExclude).toContain("/.codex/hooks.json");
    expect(readFileSync(join(repository, ".gitignore"), "utf8")).toBe(sharedIgnore);
    expect(existsSync(join(repository, ".git", "hooks", "agent-profile-kit"))).toBe(false);

    const laterUnrelated = "# author entry added after installation\n/local-only\n";
    writeFileSync(exclude, `${installedExclude}${laterUnrelated}`);
    expect(runCli(home, "apply").status).toBe(0);
    expect(runCli(home, "uninstall").status).toBe(0);
    expect(readFileSync(exclude, "utf8")).toBe(`${unrelated}${laterUnrelated}`);
    expect(readFileSync(join(repository, ".gitignore"), "utf8")).toBe(sharedIgnore);
  });

  test("shared Git exclusions use one canonical record and retain surviving contributions", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-shared-exclusion-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${nested}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const preview = runCli(home, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain("Git exclusions: 6 entries to add.");
    expect(preview.stdout).not.toContain(join(repository, ".git", "info", "exclude"));

    const verbosePreview = runCli(home, "preview", "--verbose");
    expect(verbosePreview.status, verbosePreview.stderr).toBe(0);
    expect(humanText(verbosePreview.stdout)).toContain(
      humanText(`${join(repository, ".git", "info", "exclude")}: add`),
    );
    expect(verbosePreview.stdout).toContain("/nested/.codex/hooks.json");

    expect(runCli(home, "apply").status).toBe(0);
    const target = join(repository, ".git", "info", "exclude");
    const installed = parse(readFileSync(statePath(home), "utf8")) as {
      repository_exclusions: readonly {
        contributions: readonly { entries: readonly string[]; installation_id: string }[];
        entries: readonly string[];
        target: string;
      }[];
      installations: readonly { installation_id: string; project: string }[];
    };
    expect(installed.repository_exclusions).toHaveLength(1);
    expect(installed.repository_exclusions[0]?.target).toBe(realpathSync(target));
    expect(installed.repository_exclusions[0]?.contributions).toHaveLength(2);
    expect(installed.repository_exclusions[0]?.entries).toEqual([
      "/.agent-profile-kit/codex/context.md",
      "/.agent-profile-kit/installation.json",
      "/.codex/hooks.json",
      "/nested/.agent-profile-kit/codex/context.md",
      "/nested/.agent-profile-kit/installation.json",
      "/nested/.codex/hooks.json",
    ]);

    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const afterRemoval = parse(readFileSync(statePath(home), "utf8")) as {
      repository_exclusions: readonly {
        contributions: readonly unknown[];
        entries: readonly string[];
      }[];
    };
    expect(afterRemoval.repository_exclusions).toHaveLength(1);
    expect(afterRemoval.repository_exclusions[0]?.contributions).toHaveLength(1);
    expect(afterRemoval.repository_exclusions[0]?.entries).toEqual([
      "/.agent-profile-kit/codex/context.md",
      "/.agent-profile-kit/installation.json",
      "/.codex/hooks.json",
    ]);
    expect(readFileSync(target, "utf8")).not.toContain("/nested/");
  });

  test("retires a deleted Git root and removes only its recorded exclusion contribution", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-git-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${nested}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const exclude = join(repository, ".git", "info", "exclude");
    const unrelated = "# unrelated after managed section\n/local-only\n";
    writeFileSync(exclude, `${readFileSync(exclude, "utf8")}${unrelated}`);
    chmodSync(exclude, 0o640);
    rmSync(nested, { recursive: true });

    const unbound = runCli(home, "unbind", nested);

    expect(unbound.status, unbound.stderr).toBe(0);
    const preview = runCli(home, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${nested}: removal`));
    expect(preview.stdout).toContain("/nested/.codex/hooks.json");
    const status = runCli(home, "status", "--verbose");
    expect(status.status, status.stderr).toBe(0);
    expect(humanText(status.stdout)).toContain(humanText(`${nested}: removal`));
    expect(status.stdout).toContain("project intentionally deleted");

    const applied = runCli(home, "apply");

    expect(applied.status, applied.stderr).toBe(0);
    expect(existsSync(repository)).toBe(true);
    expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(nested)).toBe(false);
    expect(readFileSync(exclude, "utf8")).toContain(unrelated);
    expect(readFileSync(exclude, "utf8")).not.toContain("/nested/");
    expect(statSync(exclude).mode & 0o7777).toBe(0o640);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { project: string }[];
      repository_exclusions: readonly { contributions: readonly unknown[] }[];
    };
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.project).toBe(realpathSync(repository));
    expect(state.repository_exclusions[0]?.contributions).toHaveLength(1);
  });

  test("retires one deleted independent project while preserving another installation", () => {
    const home = isolatedHome();
    initialize(home);
    const first = project("agent-profile-kit-retire-independent-first-");
    const second = project("agent-profile-kit-retire-independent-second-");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${first}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    rmSync(first, { recursive: true });

    expect(runCli(home, "unbind", first).status).toBe(0);
    const preview = runCli(home, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${first}: removal`));
    expect(runCli(home, "apply").status).toBe(0);

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { project: string }[];
    };
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.project).toBe(realpathSync(second));
    expect(existsSync(join(second, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("retires a deleted Git root when its exclusion target disappears with the root", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-whole-git-root-");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);
    rmSync(repository, { recursive: true });

    expect(runCli(home, "unbind", repository).status).toBe(0);
    const preview = runCli(home, "preview");
    expect(preview.status, `${preview.stdout}\n${preview.stderr}`).toBe(0);
    expect(preview.stdout).toContain("project intentionally deleted");
    expect(runCli(home, "apply").status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly unknown[];
      repository_exclusions: readonly unknown[];
    };
    expect(state.installations).toHaveLength(0);
    expect(state.repository_exclusions).toHaveLength(0);
  });

  test("retires a deleted linked checkout using its recorded common target", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-linked-root-");
    const worktree = addWorktree(repository, "retire-linked-root");
    writeContextProfile(home);
    bind(home, worktree);
    expect(runCli(home, "apply").status).toBe(0);
    rmSync(worktree, { recursive: true });

    expect(runCli(home, "unbind", worktree).status).toBe(0);
    const preview = runCli(home, "preview");
    expect(preview.status, `${preview.stdout}\n${preview.stderr}`).toBe(0);
    expect(runCli(home, "apply").status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly unknown[];
      repository_exclusions: readonly unknown[];
    };
    expect(state.installations).toHaveLength(0);
    expect(state.repository_exclusions).toHaveLength(0);
  });

  test("blocks a deleted linked checkout when its exclusion record is missing", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-linked-missing-record-");
    const worktree = addWorktree(repository, "retire-linked-missing-record");
    writeContextProfile(home);
    bind(home, worktree);
    expect(runCli(home, "apply").status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { git_project: boolean; project: string }[];
      repository_exclusions: readonly unknown[];
    };
    expect(state.installations[0]?.git_project).toBe(true);
    writeFileSync(
      statePath(home),
      stringify({
        schema_version: 3,
        installations: state.installations,
        repository_exclusions: [],
      }),
    );
    const exclude = join(repository, ".git", "info", "exclude");
    const beforeExclude = readFileSync(exclude);
    rmSync(worktree, { recursive: true });
    expect(runCli(home, "unbind", worktree).status).toBe(0);

    const preview = runCli(home, "preview");

    expect(preview.status).toBe(2);
    expect(preview.stdout).toContain("missing its Git exclusion record");
    expect(readFileSync(exclude).equals(beforeExclude)).toBe(true);
    expect(runCli(home, "apply").status).toBe(2);
  });

  test("blocks intentional-deletion retirement when its exclusion contribution is missing", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-missing-record-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${nested}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { installation_id: string; project: string }[];
      repository_exclusions: { contributions: { installation_id: string }[]; entries: readonly string[] }[];
    };
    const nestedId = state.installations.find((installation) => installation.project === realpathSync(nested))!.installation_id;
    const record = state.repository_exclusions[0]!;
    record.contributions = record.contributions
      .filter((contribution) => contribution.installation_id !== nestedId);
    const remainingEntries = [
      "/.agent-profile-kit/codex/context.md",
      "/.agent-profile-kit/installation.json",
      "/.codex/hooks.json",
    ];
    state.repository_exclusions[0]!.entries = remainingEntries;
    writeFileSync(statePath(home), stringify(state));
    const exclude = join(repository, ".git", "info", "exclude");
    const beforeExclude = readFileSync(exclude);
    rmSync(nested, { recursive: true });
    expect(runCli(home, "unbind", nested).status).toBe(0);

    const preview = runCli(home, "preview");

    expect(preview.status).toBe(2);
    expect(preview.stdout).toContain("missing its Git exclusion record");
    expect(readFileSync(exclude).equals(beforeExclude)).toBe(true);
    expect(runCli(home, "apply").status).toBe(2);
  });

  test("blocks intentional-deletion retirement when its recorded exclusion contribution is modified", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-modified-record-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${nested}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { installation_id: string; project: string }[];
      repository_exclusions: {
        contributions: { entries: readonly string[]; installation_id: string }[];
        entries: readonly string[];
      }[];
    };
    const nestedId = state.installations.find((installation) => installation.project === realpathSync(nested))!.installation_id;
    const record = state.repository_exclusions[0]!;
    record.contributions = record.contributions.map((contribution) =>
      contribution.installation_id === nestedId
        ? { ...contribution, entries: ["/nested/not-generated"] }
        : contribution,
    );
    record.entries = [...new Set(record.contributions.flatMap((contribution) => contribution.entries))].sort();
    writeFileSync(statePath(home), stringify(state));
    rmSync(nested, { recursive: true });
    expect(runCli(home, "unbind", nested).status).toBe(0);

    const preview = runCli(home, "preview");

    expect(preview.status).toBe(2);
    expect(humanText(preview.stdout)).toContain("does not match its recorded installation record contribution");
    expect(runCli(home, "apply").status).toBe(2);
  });

  test("blocks intentional-deletion retirement when the surviving exclusion section is missing", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-missing-exclude-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${nested}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const exclude = join(repository, ".git", "info", "exclude");
    rmSync(exclude);
    rmSync(nested, { recursive: true });

    const unbound = runCli(home, "unbind", nested);

    expect(unbound.status, unbound.stderr).toBe(0);
    const preview = runCli(home, "preview");

    expect(preview.status).toBe(2);
    expect(preview.stdout).toContain("missing its Agent Profile Kit exclusion section");
    const applied = runCli(home, "apply");
    expect(applied.status).toBe(2);
    expect(applied.stdout).toContain("missing its Agent Profile Kit exclusion section");
    expect(applied.stderr).toBe("");
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { project: string }[];
    };
    expect(state.installations).toHaveLength(2);
  });

  test("blocks intentional-deletion retirement when its only exclusion file is missing", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-only-missing-exclude-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    bind(home, nested);
    expect(runCli(home, "apply").status).toBe(0);
    rmSync(join(repository, ".git", "info", "exclude"));
    rmSync(nested, { recursive: true });
    expect(runCli(home, "unbind", nested).status).toBe(0);

    const preview = runCli(home, "preview");

    expect(preview.status).toBe(2);
    expect(preview.stdout).toContain("missing its Agent Profile Kit exclusion section");
    expect(runCli(home, "apply").status).toBe(2);
  });

  test("blocks intentional-deletion retirement when the Git exclusion parent is missing", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-missing-exclude-parent-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    bind(home, nested);
    expect(runCli(home, "apply").status).toBe(0);
    const info = join(repository, ".git", "info");
    rmSync(info, { recursive: true });
    rmSync(nested, { recursive: true });
    expect(runCli(home, "unbind", nested).status).toBe(0);

    const preview = runCli(home, "preview");

    expect(preview.status).toBe(2);
    expect(preview.stdout).toContain("missing its Agent Profile Kit exclusion section");
    expect(runCli(home, "apply").status).toBe(2);
    expect(existsSync(info)).toBe(false);
  });

  test("keeps intentional-deletion retirement retryable when state publication fails", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-retire-state-failure-");
    const nested = join(repository, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${nested}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const exclude = join(repository, ".git", "info", "exclude");
    const beforeExclude = readFileSync(exclude);
    rmSync(nested, { recursive: true });
    expect(runCli(home, "unbind", nested).status).toBe(0);
    const stateDirectory = join(home, ".agents", "agent-profile-kit", "state");
    chmodSync(stateDirectory, 0o555);

    const failed = runCli(home, "apply");

    chmodSync(stateDirectory, 0o755);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Apply failed");
    expect(readFileSync(exclude).equals(beforeExclude)).toBe(true);
    const retained = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly unknown[];
    };
    expect(retained.installations).toHaveLength(2);

    const retry = runCli(home, "apply");

    expect(retry.status, retry.stderr).toBe(0);
    const converged = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly unknown[];
    };
    expect(converged.installations).toHaveLength(1);
    expect(readFileSync(exclude, "utf8")).not.toContain("/nested/");
  });

  test("missing Repository Exclusion Record blocks an existing Git installation before writes", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-missing-record-");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);
    const exclude = join(repository, ".git", "info", "exclude");
    const before = readFileSync(exclude);
    const state = parse(readFileSync(statePath(home), "utf8")) as Record<string, unknown>;
    state.repository_exclusions = [];
    writeFileSync(statePath(home), stringify(state));

    const preview = runCliAt(home, repository, "preview");

    expect(preview.status).toBe(2);
    expect(preview.stdout).toContain("missing its Git exclusion record");
    expect(preview.stdout).not.toContain(repository);
    expect(preview.stdout).not.toContain(realpathSync(repository));
    expect(readFileSync(exclude).equals(before)).toBe(true);
  });

  test("uninstall rejects a Repository Exclusion Record attached to the wrong Git target", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-wrong-record-target-");
    const other = gitRepository("agent-profile-kit-wrong-record-other-");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      repository_exclusions: { target: string }[];
    };
    state.repository_exclusions[0]!.target = join(other, ".git", "info", "exclude");
    writeFileSync(statePath(home), stringify(state));

    const result = runCli(home, "uninstall");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("targets");
    expect(result.stderr).toContain(join(repository, ".git", "info", "exclude"));
    expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("an explicitly bound linked checkout gets its own Profile Installation", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-explicit-root-");
    const worktree = addWorktree(repository, "explicit-linked-worktree");
    writeContextProfile(home);
    writeContextProfile(home, "review");
    const pathWithClaude = `${installFakeClaude(home)}:${process.env.PATH ?? ""}`;
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${worktree}\n    profile: review\n    hosts: [claude]\n`,
    );

    const preview = runCliWithPath(home, pathWithClaude, "preview", "--verbose");

    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${repository}: Profile coding`));
    expect(humanText(preview.stdout)).toContain(humanText(`${worktree}: Profile review`));

    const apply = runCliWithPath(home, pathWithClaude, "apply");

    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(repository, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(repository, ".claude"))).toBe(false);
    expect(existsSync(join(worktree, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(worktree, ".agent-profile-kit", "codex", "context.md"))).toBe(false);

    const status = runCliWithPath(home, pathWithClaude, "status", "--verbose");

    expect(status.status, status.stderr).toBe(0);
    expect(humanText(status.stdout)).toContain(humanText(`${repository}: current`));
    expect(humanText(status.stdout)).toContain(humanText(`${worktree}: current`));
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { hosts: readonly string[]; profile_id: string; project: string }[];
    };
    expect(state.installations).toHaveLength(2);
    expect(state.installations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hosts: ["codex"],
        profile_id: "coding",
        project: realpathSync(repository),
      }),
      expect.objectContaining({
        hosts: ["claude"],
        profile_id: "review",
        project: realpathSync(worktree),
      }),
    ]));
  });

  test("Git exclusion preflight rejects a symlinked info parent without external writes", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-git-info-symlink-");
    const external = project("agent-profile-kit-external-git-info-");
    rmSync(join(repository, ".git", "info"), { recursive: true });
    symlinkSync(external, join(repository, ".git", "info"));
    writeContextProfile(home);
    bind(home, repository);

    const result = runCli(home, "apply");

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Git exclusion parent");
    expect(result.stdout).toContain("must be a real directory");
    expect(result.stderr).toBe("");
    expect(existsSync(join(external, "exclude"))).toBe(false);
    expect(existsSync(join(repository, ".agent-profile-kit"))).toBe(false);
  });

  test("Git discovery rejects a symlinked authored common directory", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-git-common-symlink-");
    const external = project("agent-profile-kit-external-common-");
    const externalGit = join(external, "gitdir");
    execFileSync("mv", [join(repository, ".git"), externalGit]);
    symlinkSync(externalGit, join(repository, ".git"));
    const exclude = join(externalGit, "info", "exclude");
    const before = readFileSync(exclude);
    writeContextProfile(home);
    bind(home, repository);

    const result = runCli(home, "apply");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git common directory");
    expect(result.stderr).toContain("non-directory or symlink component");
    expect(readFileSync(exclude).equals(before)).toBe(true);
    expect(existsSync(join(repository, ".agent-profile-kit"))).toBe(false);
  });

  test("a corrupt Git boundary fails closed instead of becoming a non-Git project", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project("agent-profile-kit-corrupt-git-");
    writeFileSync(join(projectPath, ".git"), "gitdir: /definitely/missing\n");
    writeContextProfile(home);
    bind(home, projectPath);

    const result = runCli(home, "validate");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot inspect Git worktree");
    expect(result.stdout).not.toContain("not a Git worktree");
  });

  test("Git exclusion reconciliation preserves an existing file mode", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-git-exclude-mode-");
    const exclude = join(repository, ".git", "info", "exclude");
    chmodSync(exclude, 0o600);
    writeContextProfile(home);
    bind(home, repository);

    expect(runCli(home, "apply").status).toBe(0);

    expect(statSync(exclude).mode & 0o777).toBe(0o600);
  });

  test("a failed first Git apply restores an originally absent exclusion file", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-absent-exclude-");
    const exclude = join(repository, ".git", "info", "exclude");
    rmSync(exclude);
    writeContextProfile(home);
    bind(home, repository);
    const stateDirectory = join(home, ".agents", "agent-profile-kit", "state");
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o555);

    const result = runCli(home, "apply");

    chmodSync(stateDirectory, 0o755);
    expect(result.status).toBe(1);
    expect(existsSync(exclude)).toBe(false);
    expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("a failed first Git apply removes the exclusion parent it safely created", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-absent-info-");
    const info = join(repository, ".git", "info");
    rmSync(info, { recursive: true });
    writeContextProfile(home);
    bind(home, repository);
    const stateDirectory = join(home, ".agents", "agent-profile-kit", "state");
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o555);

    const result = runCli(home, "apply");

    chmodSync(stateDirectory, 0o755);
    expect(result.status).toBe(1);
    expect(existsSync(info)).toBe(false);
    expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("modified Git exclusion ownership blocks both apply and uninstall", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-modified-exclude-");
    const exclude = join(repository, ".git", "info", "exclude");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);
    writeFileSync(
      exclude,
      readFileSync(exclude).toString("utf8").replace("/.codex/hooks.json", "/unexpected"),
    );

    for (const command of ["apply", "uninstall"] as const) {
      const result = runCli(home, command);
      // apply reports ownership blockers as exit 2; uninstall remains a tool-failure exit 1.
      expect(result.status).toBe(command === "apply" ? 2 : 1);
      expect(humanText(`${result.stdout}${result.stderr}`)).toContain("exclusion section is modified");
      if (command === "apply") expect(result.stderr).toBe("");
      expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(true);
    }
  });

  test("preview and status summarize a pending Git exclusion repair before apply", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-missing-exclude-");
    const exclude = join(repository, ".git", "info", "exclude");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);
    writeFileSync(exclude, "# unrelated local exclusion\n");

    for (const command of ["preview", "status"]) {
      const result = runCli(home, command);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Git exclusions: 3 recorded entries to restore.");
      expect(result.stdout).not.toContain(exclude);
    }

    const repaired = runCli(home, "apply");
    expect(repaired.status, repaired.stderr).toBe(0);
    expect(repaired.stdout).toContain("State: current");
    expect(repaired.stdout).toContain("Applied:");
    expect(repaired.stdout).toContain("Git exclusions: 3 recorded entries restored.");
    expect(repaired.stdout).not.toContain(exclude);
    expect(repaired.stdout).not.toContain("apply will restore");

    writeFileSync(exclude, "# unrelated local exclusion\n");
    const verboseRepaired = runCli(home, "apply", "--verbose");
    expect(verboseRepaired.status, verboseRepaired.stderr).toBe(0);
    expect(verboseRepaired.stdout).not.toContain("apply will restore");
    expect(verboseRepaired.stdout).toContain("restored 3 recorded Repository Exclusion entries");
    expect(readFileSync(exclude, "utf8")).toContain("# BEGIN Agent Profile Kit generated paths");
    expect(runCli(home, "status").stdout).not.toContain("is missing its Agent Profile Kit exclusion section");
  });

  test("a later Git project failure leaves exclusions only for completed Manifest state", () => {
    const home = isolatedHome();
    initialize(home);
    const repositories = [
      gitRepository("agent-profile-kit-partial-git-a-"),
      gitRepository("agent-profile-kit-partial-git-b-"),
    ].sort();
    const first = repositories[0]!;
    const second = repositories[1]!;
    const firstExclude = join(first, ".git", "info", "exclude");
    const secondExclude = join(second, ".git", "info", "exclude");
    const secondBefore = readFileSync(secondExclude);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );
    chmodSync(second, 0o555);

    const failed = runCli(home, "apply");

    chmodSync(second, 0o755);
    expect(failed.status).toBe(1);
    expect(readFileSync(firstExclude, "utf8")).toContain("# BEGIN Agent Profile Kit generated paths");
    expect(readFileSync(secondExclude).equals(secondBefore)).toBe(true);
    expect(existsSync(join(first, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(second, ".agent-profile-kit", "installation.json"))).toBe(false);

    const converged = runCli(home, "apply");
    expect(converged.status, converged.stderr).toBe(0);
    expect(readFileSync(secondExclude, "utf8")).toContain("# BEGIN Agent Profile Kit generated paths");
  });

  test("a failed stale removal retains all same-repository exclusion ownership", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-stale-git-");
    mkdirSync(join(repository, "nested"));
    writeFileSync(join(repository, "nested", ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n  - project: ${join(repository, "nested")}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const exclude = join(repository, ".git", "info", "exclude");
    const before = readFileSync(exclude);
    writeFileSync(join(repository, "nested", ".codex", "hooks.json"), "drifted\n");
    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`);

    const failed = runCli(home, "apply");

    expect(failed.status).toBe(2);
    expect(readFileSync(exclude).equals(before)).toBe(true);
    expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(repository, "nested", ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("status ignores an unbound worktree created after apply", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-later-");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);
    const later = addWorktree(repository, "later-worktree");

    const status = runCli(home, "status", "--verbose");

    expect(status.status, status.stderr).toBe(0);
    expect(humanText(status.stdout)).toContain(humanText(`${repository}: current`));
    expect(status.stdout).not.toContain(later);
    expect(existsSync(join(later, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("a nested Git binding reconciles only its exact nested root", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-nested-");
    mkdirSync(join(repository, "packages", "tool"), { recursive: true });
    writeFileSync(join(repository, "packages", "tool", ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "packages/tool/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested project"]);
    const worktree = addWorktree(repository, "nested-worktree");
    writeContextProfile(home);
    bind(home, join(repository, "packages", "tool"));

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(repository, "packages", "tool", ".agent-profile-kit", "installation.json"))).toBe(true);
    const hook = readFileSync(join(repository, "packages", "tool", ".codex", "hooks.json"), "utf8");
    expect(hook).toContain("packages/tool/.agent-profile-kit/codex/context.md");
    expect(existsSync(join(worktree, "packages", "tool", ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(repository, ".agent-profile-kit"))).toBe(false);
  });

  test("exact-root planning ignores a missing sibling nested path", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-missing-nested-");
    const worktree = addWorktree(repository, "missing-nested-worktree");
    mkdirSync(join(repository, "local-only"));
    writeContextProfile(home);
    bind(home, join(repository, "local-only"));

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(repository, "local-only", ".agent-profile-kit"))).toBe(true);
    expect(existsSync(join(worktree, "local-only"))).toBe(false);
  });

  test("explicit bindings create distinct Profile Installations for checkout roots", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-dedupe-");
    const worktree = addWorktree(repository, "dedupe-worktree");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n  - project: ${worktree}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { project: string }[];
    };
    expect(state.installations).toHaveLength(2);
    expect(state.installations.map((installation) => installation.project).sort()).toEqual([
      realpathSync(repository),
      realpathSync(worktree),
    ].sort());
  });

  test("status distinguishes current, stale source, drifted output, missing output, and malformed ownership", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const current = runCli(home, "status", "--verbose");
    expect(current.status, current.stderr).toBe(0);
    expect(humanText(current.stdout)).toContain(humanText(`${projectPath}: current`));

    writeFileSync(join(workspacePath(home), "context", "team-rules.md"), "---\nid: team-rules\ndependencies: []\n---\nchanged\n");
    expect(humanText(runCli(home, "status", "--verbose").stdout)).toContain(
      humanText(`${projectPath}: stale source`),
    );
    writeFileSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"), "drift\n");
    expect(humanText(runCli(home, "status", "--verbose").stdout)).toContain(
      humanText(`${projectPath}: drifted output`),
    );
    rmSync(join(projectPath, ".codex", "hooks.json"));
    expect(humanText(runCli(home, "status", "--verbose").stdout)).toContain(
      humanText(`${projectPath}: missing output`),
    );
    writeFileSync(join(projectPath, ".agent-profile-kit", "installation.json"), "not json");
    expect(humanText(runCli(home, "status", "--verbose").stdout)).toContain(
      humanText(`${projectPath}: malformed ownership state`),
    );
  });

  test("status reports output permission drift and apply preserves it", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const context = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    chmodSync(context, 0o600);

    const status = runCli(home, "status", "--verbose");
    const applied = runCli(home, "apply");

    expect(status.status, status.stderr).toBe(2);
    expect(humanText(status.stdout)).toContain(humanText(`${projectPath}: drifted output`));
    expect(status.stdout).toContain("mode");
    expect(applied.status).toBe(2);
    expect(applied.stderr).toBe("");
    expect(humanText(applied.stdout)).toContain(humanText("will not overwrite your edit"));
    expect(humanText(applied.stdout)).toContain(humanText("Move the change into the Workspace"));
    expect(humanText(applied.stdout)).toContain(humanText("delete the generated file"));
    expect(statSync(context).mode & 0o777).toBe(0o600);
  });

  test("unexpected members in an owned directory receive the same safe drift remedies", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    const source = join(workspacePath(home), "skills", "review-pr");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\nReview.\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const unexpected = join(projectPath, ".agents", "skills", "review-pr", "notes.md");
    writeFileSync(unexpected, "user note\n");

    const blocked = runCli(home, "apply");

    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toBe("");
    expect(blocked.stdout).toContain("unexpected:");
    expect(humanText(blocked.stdout)).toContain(humanText("will not overwrite your edit"));
    expect(humanText(blocked.stdout)).toContain(humanText("Move the change into the Workspace"));
    expect(humanText(blocked.stdout)).toContain(humanText("delete the unexpected file"));
    expect(humanText(blocked.stdout)).not.toContain(humanText("delete the generated file"));
    expect(readFileSync(unexpected, "utf8")).toBe("user note\n");
  });

  test("drift names both safe recovery routes once and deleting the file restores current state", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const drifted = join(projectPath, ".codex", "hooks.json");
    writeFileSync(drifted, "user edit\n");

    const blocked = runCli(home, "apply");

    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toBe("");
    expect(blocked.stdout.match(/Blocker:/g)).toHaveLength(1);
    expect(humanText(blocked.stdout)).toContain(humanText("will not overwrite your edit"));
    expect(humanText(blocked.stdout)).toContain(humanText("Move the change into the Workspace"));
    expect(humanText(blocked.stdout)).toContain(humanText("delete the generated file"));

    rmSync(drifted);
    const repaired = runCli(home, "apply");
    const current = runCli(home, "status");

    expect(repaired.status, repaired.stderr).toBe(0);
    expect(current.status, current.stderr).toBe(0);
    expect(current.stdout.startsWith("All Projects are current (1 Project)\n")).toBe(true);
    expect(current.stdout).not.toContain("Next:");
  });

  test("status reports a malformed machine-local Installation Manifest without writing", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    writeFileSync(statePath(home), "not: a valid installation state\n");

    const result = runCli(home, "status");
    const apply = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain("Projects: 1");
    expect(result.stdout).toContain("Global blockers:");
    expect(result.stdout).toContain("Installation State");
    expect(result.stdout).toContain("Blockers: 1");
    expect(apply.status).toBe(2);
    expect(apply.stderr).toBe("");
    expect(apply.stdout).toContain("Apply blocked");
    expect(apply.stdout).toContain("Global blockers:");
    expect(apply.stdout).toContain("Installation State");
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
  });

  test("schema-v1 ownership state fails closed without adopting or removing output", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      schema_version: number;
      installations: Array<{ schema_version: number }>;
    };
    state.schema_version = 1;
    for (const installation of state.installations) installation.schema_version = 1;
    writeFileSync(statePath(home), stringify(state));

    const status = runCli(home, "status");
    const apply = runCli(home, "apply");
    const uninstall = runCli(home, "uninstall");

    expect(status.status, status.stderr).toBe(2);
    expect(status.stdout).toContain("schema_version must be 5");
    expect(apply.status).toBe(2);
    expect(apply.stderr).toBe("");
    expect(apply.stdout).toContain("Apply blocked");
    expect(apply.stdout).toContain("schema_version must be 5");
    expect(uninstall.status).toBe(1);
    expect(uninstall.stderr).toContain("schema_version must be 5");
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(true);
  });

  test("status reports a blocked installation deterministically without writing", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "repository owned\n");
    writeContextProfile(home);
    bind(home, projectPath);

    const result = runCli(home, "status");

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout.startsWith("Attention required\n")).toBe(true);
    expect(humanText(result.stdout)).toContain(humanText(`Project: ${projectPath}`));
    expect(result.stdout.match(/Blocker:/g)).toHaveLength(1);
    expect(result.stdout).not.toContain("State:");
    expect(result.stdout).toContain("occupied by unowned or drifted output");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("status keeps a home-relative blocked installation in one Profile Installation group", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = join(home, "home-relative-blocked-project");
    mkdirSync(join(projectPath, ".codex"), { recursive: true });
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "repository owned\n");
    writeContextProfile(home);
    bind(home, "~/home-relative-blocked-project");

    const result = runCli(home, "status");

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain("Projects: 1");
    expect(result.stdout.match(/Project:/g)).toHaveLength(1);
    expect(result.stdout.match(/Blocker:/g)).toHaveLength(1);
  });

  test("concise lifecycle output keeps drift reasons and removal intent visible", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);

    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nChanged concise status Context.\n",
    );
    const drift = runCli(home, "status");
    expect(drift.status, drift.stderr).toBe(0);
    expect(drift.stdout).toContain("State: stale source");
    expect(drift.stdout).toContain("Changes: 1 generated file update");

    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`);
    const removal = runCli(home, "preview");
    expect(removal.status, removal.stderr).toBe(0);
    expect(removal.stdout).toContain("State: removal");
    expect(removal.stdout).toMatch(/Changes: .*generated file removal/);
  });

  test("status attributes blockers by canonical project identity instead of path prefix", () => {
    const home = isolatedHome();
    initialize(home);
    const parent = project("agent-profile-kit-prefix-");
    const first = join(parent, "project");
    const second = join(parent, "project-extra");
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(join(second, ".codex"));
    writeFileSync(join(second, ".codex", "hooks.json"), "occupied\n");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "status", "--verbose");

    expect(result.status, result.stderr).toBe(2);
    expect(humanText(result.stdout)).toContain(
      humanText(`${first}: missing output (Profile Installation is missing)`),
    );
    expect(humanText(result.stdout)).not.toContain(humanText(`${first}: blocked`));
    expect(humanText(result.stdout)).toContain(humanText(`${second}: blocked`));
  });

  test("status rejects a Manifest that omits its Installation Marker output", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{ outputs: Array<{ path: string }> }>;
    };
    state.installations[0]!.outputs = state.installations[0]!.outputs.filter(
      (output) => output.path !== ".agent-profile-kit/installation.json",
    );
    writeFileSync(statePath(home), stringify(state));

    const result = runCli(home, "status");

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toContain("installation record outputs must include the Installation Marker");
    expect(result.stdout).toContain("Blockers: 1");
  });

  test("uninstall refuses to remove drifted output", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "user edit\n");

    const result = runCli(home, "uninstall");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Uninstall blocked");
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(true);
  });

  test("uninstall rejects a symlinked output parent and preserves matching external data", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    const external = project("agent-profile-kit-external-hooks-");
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const hook = readFileSync(join(projectPath, ".codex", "hooks.json"), "utf8");
    rmSync(join(projectPath, ".codex"), { recursive: true });
    writeFileSync(join(external, "hooks.json"), hook);
    symlinkSync(external, join(projectPath, ".codex"));

    const result = runCli(home, "uninstall");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("symlink parent");
    expect(readFileSync(join(external, "hooks.json"), "utf8")).toBe(hook);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("uninstall preflights every project before removal and preserves Workspace and Project Bindings", () => {
    const home = isolatedHome();
    initialize(home);
    const first = project("agent-profile-kit-uninstall-a-");
    const second = project("agent-profile-kit-uninstall-b-");
    writeContextProfile(home);
    const configuration = `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`;
    writeFileSync(configPath(home), configuration);
    expect(runCli(home, "apply").status).toBe(0);
    writeFileSync(join(second, ".codex", "hooks.json"), "drifted\n");

    const result = runCli(home, "uninstall");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Uninstall blocked");
    expect(existsSync(join(first, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(second, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toBe(configuration);
    expect(existsSync(join(workspacePath(home), "profiles", "coding.yaml"))).toBe(true);
  });

  test("uninstall removes only proven output and preserves canonical and unrelated project state", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    const globalCodex = join(home, ".codex");
    mkdirSync(globalCodex, { recursive: true });
    mkdirSync(join(projectPath, ".codex"));
    mkdirSync(join(projectPath, ".agent-profile-kit"));
    writeFileSync(join(globalCodex, "config.toml"), "[features]\nhooks = true\n# global setting\n");
    writeFileSync(join(projectPath, "AGENTS.md"), "repository-owned\n");
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    expect(runCli(home, "uninstall").status).toBe(0);

    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(true);
    expect(existsSync(join(projectPath, ".codex"))).toBe(true);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(configPath(home), "utf8")).toContain(projectPath);
    expect(readFileSync(join(globalCodex, "config.toml"), "utf8")).toBe("[features]\nhooks = true\n# global setting\n");
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
  });

  test("status reports output deliberately removed by uninstall as intended teardown", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    expect(runCli(home, "uninstall").status).toBe(0);

    const result = runCli(home, "status");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Intentionally uninstalled");
    expect(humanText(result.stdout)).toContain(humanText("Project Binding was preserved"));
    expect(result.stdout).not.toContain("Attention required");
    expect(result.stdout).not.toContain("missing output");
    expect(result.stdout).not.toContain("not a safe automatic repair");
    expect(result.stdout).not.toContain("Codex setup:");
  });

  test("uninstall names removed project files, cleaned Git exclusions, and preserved bindings", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = gitRepository("agent-profile-kit-uninstall-receipt-");
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);

    const result = runCli(home, "uninstall");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Removed proven Agent Profile Kit-owned output from 1 Project.");
    expect(result.stdout).not.toMatch(/^Uninstalled\b/m);
    expect(humanText(result.stdout)).toContain(humanText(`Project: ${realpathSync(projectPath)}`));
    expect(result.stdout).toContain("Removed generated paths:");
    expect(result.stdout).toContain("- .agent-profile-kit/codex/context.md");
    expect(result.stdout).toContain("- .agent-profile-kit/installation.json");
    expect(result.stdout).toContain("- .codex/hooks.json");
    expect(result.stdout).toContain("Cleaned Git exclusions:");
    expect(result.stdout).toContain("- /.agent-profile-kit/codex/context.md");
    expect(result.stdout).toContain("Project Bindings preserved.");
  });

  test("uninstall with no installed output states the empty result without removing Projects", () => {
    const home = isolatedHome();
    initialize(home);

    const result = runCli(home, "uninstall");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "No ordinary Agent Profile Kit-owned output is installed.\n\n" +
      "Project Bindings preserved.\n",
    );
    expect(result.stdout).not.toMatch(/(?:Uninstalled|Removed .*Projects?)/i);
  });

  test("apply reinstalls an intended teardown and clears its teardown provenance", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    expect(runCli(home, "uninstall").status).toBe(0);

    const applied = runCli(home, "apply");

    expect(applied.status, applied.stderr).toBe(0);
    expect(runCli(home, "status").stdout).toContain("All Projects are current");
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      intended_teardowns: readonly unknown[];
    };
    expect(state.intended_teardowns).toEqual([]);
  });

  test("a different binding at the same project does not inherit teardown provenance", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    expect(runCli(home, "uninstall").status).toBe(0);
    expect(runCli(home, "unbind", projectPath).status).toBe(0);
    const rebound = runCli(home, "bind", "coding", projectPath, "--host", "claude");
    expect(rebound.status, rebound.stderr).toBe(0);

    const status = runCli(home, "status");

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).not.toContain("Intentionally uninstalled");
    expect(status.stdout).not.toContain("intended teardown");
  });

  test("apply does not recreate an installation after all owned proof disappears", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    rmSync(join(projectPath, ".agent-profile-kit"), { recursive: true });
    rmSync(join(projectPath, ".codex"), { recursive: true });

    const result = runCli(home, "apply");

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("owned output");
    expect(result.stderr).toBe("");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex"))).toBe(false);
  });

  test("apply removes a no-longer-bound installation only when ownership is proven", () => {
    const home = isolatedHome();
    initialize(home);
    const retained = project("agent-profile-kit-retained-");
    const removed = project("agent-profile-kit-removed-");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${retained}\n    profile: coding\n    hosts: [codex]\n  - project: ${removed}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    bind(home, retained);

    const result = runCli(home, "apply", "--verbose");

    expect(result.status, result.stderr).toBe(0);
    expect(humanText(result.stdout)).toContain(humanText(`${removed}: removal`));
    expect(existsSync(join(removed, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(removed, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(retained, ".agent-profile-kit", "installation.json"))).toBe(true);
    const state = parse(readFileSync(statePath(home), "utf8")) as { installations: readonly unknown[] };
    expect(state.installations).toHaveLength(1);
  });

  test("retires an intentionally deleted project after exact-path unbind without a Marker", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project("agent-profile-kit-intentionally-deleted-");
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    rmSync(projectPath, { recursive: true });

    const unbound = runCli(home, "unbind", projectPath);

    expect(unbound.status, unbound.stderr).toBe(0);
    expect(unbound.stdout).toContain("Next: apkit preview && apkit apply");
    const preview = runCli(home, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${projectPath}: removal`));
    expect(preview.stdout).toContain("intentionally deleted");

    const applied = runCli(home, "apply");

    expect(applied.status, applied.stderr).toBe(0);
    expect(existsSync(projectPath)).toBe(false);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly unknown[];
    };
    expect(state.installations).toHaveLength(0);
  });

  test("deleting a bound root without unbind leaves desired state and blocks reconciliation", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project("agent-profile-kit-deleted-still-bound-");
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const configuration = readFileSync(configPath(home), "utf8");
    rmSync(projectPath, { recursive: true });

    const result = runCli(home, "preview");

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/project.*(?:missing|existing)|missing.*project/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(configuration);
  });

  test("restoring an intentionally deleted root requires a new binding and Installation ID", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project("agent-profile-kit-restored-");
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const initial = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { installation_id: string }[];
    };
    const initialId = initial.installations[0]!.installation_id;
    rmSync(projectPath, { recursive: true });
    expect(runCli(home, "unbind", projectPath).status).toBe(0);
    expect(runCli(home, "apply").status).toBe(0);
    mkdirSync(projectPath);

    const rebound = runCli(home, "bind", "coding", projectPath, "--host", "codex");

    expect(rebound.status, rebound.stderr).toBe(0);
    const applied = runCli(home, "apply");
    expect(applied.status, applied.stderr).toBe(0);
    const restored = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { installation_id: string; project: string }[];
    };
    expect(restored.installations).toHaveLength(1);
    expect(restored.installations[0]?.project).toBe(realpathSync(projectPath));
    expect(restored.installations[0]?.installation_id).not.toBe(initialId);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("apply removes a no-longer-desired Adapter output whose recorded hash still proves ownership", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const obsoleteRelative = ".agent-profile-kit/codex/obsolete.txt";
    const obsolete = join(projectPath, obsoleteRelative);
    const bytes = "obsolete owned output\n";
    writeFileSync(obsolete, bytes);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{ outputs: Array<{ hash: string; mode: number; path: string; type: "file" }> }>;
    };
    state.installations[0]!.outputs.push({
      hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      mode: 0o644,
      path: obsoleteRelative,
      type: "file",
    });
    writeFileSync(statePath(home), stringify(state));

    const preview = runCli(home, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${obsolete}: removal`));
    expect(existsSync(obsolete)).toBe(true);

    const applied = runCli(home, "apply");
    expect(applied.status, applied.stderr).toBe(0);
    expect(existsSync(obsolete)).toBe(false);
  });

  test("drift in a stale installation blocks all desired updates and preserves every project", () => {
    const home = isolatedHome();
    initialize(home);
    const retained = project("agent-profile-kit-drift-retained-");
    const removed = project("agent-profile-kit-drift-removed-");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${retained}\n    profile: coding\n    hosts: [codex]\n  - project: ${removed}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const retainedContext = join(retained, ".agent-profile-kit", "codex", "context.md");
    const before = readFileSync(retainedContext, "utf8");
    writeFileSync(join(removed, ".codex", "hooks.json"), "user drift\n");
    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nWould update retained.\n",
    );
    bind(home, retained);

    const result = runCliAt(home, removed, "apply");

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Cannot remove stale Project");
    expect(result.stdout).not.toContain(removed);
    expect(result.stdout).not.toContain(realpathSync(removed));
    expect(result.stderr).toBe("");
    expect(readFileSync(retainedContext, "utf8")).toBe(before);
    expect(readFileSync(join(removed, ".codex", "hooks.json"), "utf8")).toBe("user drift\n");
  });

  test("stale reconciliation rejects a symlinked output parent and preserves matching external data", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    const external = project("agent-profile-kit-external-stale-");
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const hook = readFileSync(join(projectPath, ".codex", "hooks.json"), "utf8");
    rmSync(join(projectPath, ".codex"), { recursive: true });
    writeFileSync(join(external, "hooks.json"), hook);
    symlinkSync(external, join(projectPath, ".codex"));
    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`);

    const result = runCli(home, "apply");

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("symlink parent");
    expect(result.stderr).toBe("");
    expect(readFileSync(join(external, "hooks.json"), "utf8")).toBe(hook);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("apply repairs only a missing marker when remaining outputs prove ownership", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    rmSync(join(projectPath, ".agent-profile-kit", "installation.json"));

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("a repairable missing marker preserves the underlying stale-source status", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    rmSync(join(projectPath, ".agent-profile-kit", "installation.json"));
    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nChanged while marker is repairable.\n",
    );

    const status = runCli(home, "status", "--verbose");

    expect(status.status, status.stderr).toBe(0);
    expect(humanText(status.stdout)).toContain(humanText(`${projectPath}: stale source`));
    expect(humanText(status.stdout)).not.toContain(humanText(`${projectPath}: missing output`));
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("apply repairs a wholly absent owned file from current Workspace source without changing installation identity", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const installed = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { installation_id: string }[];
    };
    const installationId = installed.installations[0]!.installation_id;
    const contextPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    rmSync(contextPath);
    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nCurrent Workspace repair bytes.\n",
    );

    const concise = runCli(home, "preview");
    expect(concise.status, concise.stderr).toBe(0);
    expect(concise.stdout).toContain("Changes: 1 generated file repair");

    for (const command of ["preview", "status"] as const) {
      const result = runCli(home, command, "--verbose");
      expect(result.status, result.stderr).toBe(0);
      expect(humanText(result.stdout)).toContain(humanText(`${projectPath}: repairable missing output`));
      expect(humanText(result.stdout)).toContain(humanText(`${contextPath}: repair`));
      expect(existsSync(contextPath)).toBe(false);
    }

    const applied = runCli(home, "apply");

    expect(applied.status, applied.stderr).toBe(0);
    expect(readFileSync(contextPath, "utf8")).toContain("Current Workspace repair bytes.");
    const repaired = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly { installation_id: string }[];
    };
    expect(repaired.installations[0]!.installation_id).toBe(installationId);
  });

  test("apply repairs a wholly absent owned Skill directory with current Workspace bytes and modes", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    const source = join(workspacePath(home), "skills", "review-pr");
    mkdirSync(join(source, "scripts"), { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\nOriginal.\n",
    );
    writeFileSync(join(source, "scripts", "run.sh"), "#!/bin/sh\necho original\n");
    chmodSync(join(source, "scripts", "run.sh"), 0o755);
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const destination = join(projectPath, ".agents", "skills", "review-pr");
    rmSync(destination, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\nCurrent Workspace.\n",
    );
    writeFileSync(join(source, "scripts", "run.sh"), "#!/bin/sh\necho current\n");
    chmodSync(join(source, "scripts", "run.sh"), 0o700);

    const preview = runCli(home, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${destination}: repair`));
    expect(preview.stdout).not.toContain("missing member");
    expect(preview.stdout).not.toContain("drift item");
    expect(existsSync(destination)).toBe(false);

    const applied = runCli(home, "apply");

    expect(applied.status, applied.stderr).toBe(0);
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toContain("Current Workspace.");
    expect(readFileSync(join(destination, "scripts", "run.sh"), "utf8")).toContain("echo current");
    expect(statSync(join(destination, "scripts", "run.sh")).mode & 0o777).toBe(0o700);
  });

  test("a wholly absent output remains blocking when surviving owned output has drifted", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const missing = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    const drifted = join(projectPath, ".codex", "hooks.json");
    rmSync(missing);
    writeFileSync(drifted, "drifted surviving output\n");

    const preview = runCli(home, "preview", "--verbose");
    const applied = runCli(home, "apply");

    expect(preview.status).toBe(2);
    expect(humanText(preview.stdout)).toContain(humanText(`${projectPath}: missing output`));
    expect(humanText(preview.stdout)).not.toContain(humanText(`${missing}: repair`));
    expect(applied.status).toBe(2);
    expect(applied.stdout).toContain("Apply blocked");
    expect(applied.stderr).toBe("");
    expect(existsSync(missing)).toBe(false);
    expect(readFileSync(drifted, "utf8")).toBe("drifted surviving output\n");
  });

  test("a copied installation identity is rejected while the original remains", () => {
    const home = isolatedHome();
    initialize(home);
    const original = project("agent-profile-kit-copy-");
    const copied = join(home, "copied-project");
    writeContextProfile(home);
    bind(home, original);
    expect(runCli(home, "apply").status).toBe(0);
    execFileSync("cp", ["-R", original, copied]);
    bind(home, copied);

    const result = runCli(home, "apply");

    expect(result.status).toBe(2);
    expect(humanText(result.stdout)).toContain(humanText("copies Installation Marker identity"));
    expect(result.stderr).toBe("");
    expect(readFileSync(join(original, ".agent-profile-kit", "installation.json"), "utf8")).toContain(
      "installation_id",
    );
  });

  test("a machine-state write failure rolls back the current project transaction", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    const stateDirectory = join(home, ".agents", "agent-profile-kit", "state");
    mkdirSync(stateDirectory, { recursive: true });
    chmodSync(stateDirectory, 0o555);

    const failed = runCli(home, "apply");

    chmodSync(stateDirectory, 0o755);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("completed projects");
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
    expect(runCli(home, "apply").status).toBe(0);
  });

  test("a later project failure reports completed, failed, and pending projects and reruns safely", () => {
    const home = isolatedHome();
    initialize(home);
    const first = project("agent-profile-kit-partial-a-");
    const second = project("agent-profile-kit-partial-b-");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n`,
    );
    chmodSync(second, 0o555);

    const failed = runCli(home, "apply");

    chmodSync(second, 0o755);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(`completed projects: ${first}`);
    expect(failed.stderr).toContain(`failed project: ${second}`);
    expect(failed.stderr).toContain("pending projects: (none)");
    expect(existsSync(join(first, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(second, ".agent-profile-kit", "installation.json"))).toBe(false);

    const rerun = runCli(home, "apply");
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(runCli(home, "status").stdout).toContain("All Projects are current");
  });

  test("a moved project carries its marker identity to the new binding", () => {
    const home = isolatedHome();
    initialize(home);
    const original = project("agent-profile-kit-move-");
    const moved = join(home, "moved-project");
    writeContextProfile(home);
    bind(home, original);
    expect(runCli(home, "apply").status).toBe(0);
    execFileSync("mv", [original, moved]);
    bind(home, moved);

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(parse(readFileSync(statePath(home), "utf8")).installations[0].project).toBe(realpathSync(moved));
    expect(existsSync(join(moved, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(original, ".agent-profile-kit"))).toBe(false);
  });

  test("a moved project with edited generated output blocks apply and preserves the edit", () => {
    const home = isolatedHome();
    initialize(home);
    const original = project("agent-profile-kit-move-drift-");
    const moved = join(home, "moved-project");
    writeContextProfile(home);
    bind(home, original);
    expect(runCli(home, "apply").status).toBe(0);
    execFileSync("mv", [original, moved]);
    const edited = join(moved, ".codex", "hooks.json");
    writeFileSync(edited, "user edit after move\n");
    bind(home, moved);

    const result = runCli(home, "apply");

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout.match(/Blocker:/g)).toHaveLength(1);
    expect(humanText(result.stdout)).toContain(humanText("will not overwrite your edit"));
    expect(readFileSync(edited, "utf8")).toBe("user edit after move\n");
  });

  test("a moved Git project carries both Marker and exclusion ownership", () => {
    const home = isolatedHome();
    initialize(home);
    const original = gitRepository("agent-profile-kit-git-move-");
    const moved = join(home, "moved-git-project");
    writeContextProfile(home);
    bind(home, original);
    expect(runCli(home, "apply").status).toBe(0);
    execFileSync("mv", [original, moved]);
    bind(home, moved);

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(parse(readFileSync(statePath(home), "utf8")).installations[0].project).toBe(realpathSync(moved));
    expect(readFileSync(join(moved, ".git", "info", "exclude"), "utf8")).toContain("/.codex/hooks.json");
  });

  test("a moved Git project converges when its destination shares another repository exclusion record", () => {
    const home = isolatedHome();
    initialize(home);
    const original = gitRepository("agent-profile-kit-cross-repo-move-a-");
    const destinationRepository = gitRepository("agent-profile-kit-cross-repo-move-b-");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${original}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${destinationRepository}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);

    const moved = join(destinationRepository, "moved");
    mkdirSync(moved);
    execFileSync("cp", ["-a", join(original, ".agent-profile-kit"), join(moved, ".agent-profile-kit")]);
    execFileSync("cp", ["-a", join(original, ".codex"), join(moved, ".codex")]);
    rmSync(original, { recursive: true, force: true });
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  - project: ${destinationRepository}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${moved}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    const exclude = readFileSync(join(destinationRepository, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/moved/.codex/hooks.json");
    expect(exclude).toContain("/.codex/hooks.json");
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      repository_exclusions: readonly { contributions: readonly unknown[] }[];
    };
    expect(state.repository_exclusions).toHaveLength(1);
    expect(state.repository_exclusions[0]?.contributions).toHaveLength(2);
  });

  test("a nested Git project move transfers exact old exclusions to the Marker-proven new root", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-nested-git-move-");
    const oldProject = join(repository, "old");
    const newProject = join(repository, "new");
    mkdirSync(oldProject);
    writeFileSync(join(oldProject, ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "old/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested fixture"]);
    writeContextProfile(home);
    bind(home, oldProject);
    expect(runCli(home, "apply").status).toBe(0);
    const oldMarker = JSON.parse(
      readFileSync(join(oldProject, ".agent-profile-kit", "installation.json"), "utf8"),
    ) as { installation_id: string };
    execFileSync("mv", [oldProject, newProject]);
    bind(home, newProject);

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    const newMarker = JSON.parse(
      readFileSync(join(newProject, ".agent-profile-kit", "installation.json"), "utf8"),
    ) as { installation_id: string };
    expect(newMarker.installation_id).toBe(oldMarker.installation_id);
    const state = parse(readFileSync(statePath(home), "utf8")) as { installations: Array<{ project: string }> };
    expect(state.installations[0]!.project).toBe(realpathSync(newProject));
    const exclude = readFileSync(join(repository, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/new/.codex/hooks.json");
    expect(exclude).toContain("/new/.agent-profile-kit/installation.json");
    expect(exclude).not.toContain("/old/.codex/hooks.json");
    expect(exclude).not.toContain("/old/.agent-profile-kit/installation.json");
  });

  test("a missing marker at a different root cannot prove a project move", () => {
    const home = isolatedHome();
    initialize(home);
    const original = project("agent-profile-kit-unproven-move-");
    const moved = join(home, "unproven-moved-project");
    writeContextProfile(home);
    bind(home, original);
    expect(runCli(home, "apply").status).toBe(0);
    execFileSync("mv", [original, moved]);
    rmSync(join(moved, ".agent-profile-kit", "installation.json"));
    bind(home, moved);

    const result = runCli(home, "apply");

    expect(result.status).toBe(2);
    expect(humanText(result.stdout)).toContain(
      humanText("restore its Manifest-linked Installation Marker at the new root"),
    );
    expect(result.stderr).toBe("");
    expect(existsSync(join(moved, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("Profiles selecting Skills install portable packages into Codex project discovery", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    mkdirSync(join(workspacePath(home), "skills", "base-skill"));
    writeFileSync(
      join(workspacePath(home), "skills", "base-skill", "SKILL.md"),
      "---\nname: base-skill\ndescription: Shared base skill.\n---\n\nBase.\n",
    );
    mkdirSync(join(workspacePath(home), "skills", "review-pr", "scripts"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\nReview.\n",
    );
    writeFileSync(join(workspacePath(home), "skills", "review-pr", "scripts", "run.sh"), "#!/bin/sh\necho review\n");
    chmodSync(join(workspacePath(home), "skills", "review-pr", "scripts", "run.sh"), 0o755);
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "agent-profile-kit.yaml"),
      "dependencies:\n  - type: skill\n    id: base-skill\n",
    );
    mkdirSync(join(workspacePath(home), "skills", "unselected-skill"));
    writeFileSync(
      join(workspacePath(home), "skills", "unselected-skill", "SKILL.md"),
      "---\nname: unselected-skill\ndescription: Not selected.\n---\n\nSkip.\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    bind(home, projectPath);

    const preview = runCli(home, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(".agents/skills/review-pr");
    expect(preview.stdout).toContain(".agents/skills/base-skill");
    expect(preview.stdout).toContain("skill:review-pr");
    expect(preview.stdout).toContain("skill:base-skill");
    expect(preview.stdout).toContain("via skill:review-pr");
    expect(preview.stdout).not.toContain("unselected-skill");

    const apply = runCli(home, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(readFileSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "Review.",
    );
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "agent-profile-kit.yaml"))).toBe(
      false,
    );
    expect(statSync(join(projectPath, ".agents", "skills", "review-pr", "scripts", "run.sh")).mode & 0o777)
      .toBe(0o755);
    expect(existsSync(join(projectPath, ".agents", "skills", "base-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".agents", "skills", "unselected-skill"))).toBe(false);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(true);

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly {
        resolved_artifacts: readonly { type: string; id: string; inclusion_reasons: readonly unknown[] }[];
      }[];
    };
    const resolved = state.installations[0]?.resolved_artifacts ?? [];
    expect(resolved.map((artifact) => `${artifact.type}:${artifact.id}`).sort()).toEqual([
      "context:team-rules",
      "skill:base-skill",
      "skill:review-pr",
    ]);
    expect(
      resolved.find((artifact) => artifact.id === "base-skill")?.inclusion_reasons.length,
    ).toBeGreaterThanOrEqual(1);

    mkdirSync(join(projectPath, ".agents", "skills", "foreign-skill"), { recursive: true });
    writeFileSync(join(projectPath, ".agents", "skills", "foreign-skill", "SKILL.md"), "leave me\n");
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const deselect = runCli(home, "apply");
    expect(deselect.status, deselect.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".agents", "skills", "base-skill"))).toBe(false);
    expect(readFileSync(join(projectPath, ".agents", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );
  });

  test("packed CLI preserves model-invocation policy across Codex and Claude Hosts", () => {
    const home = isolatedHome();
    initialize(home);
    const claudeBin = installFakeClaude(home);
    installFakeCodex(home);
    const projectPath = project();
    writeContextProfile(home);
    // Absent policy: ordinary name+description Skill still validates and installs as allowed.
    mkdirSync(join(workspacePath(home), "skills", "plain-skill"));
    writeFileSync(
      join(workspacePath(home), "skills", "plain-skill", "SKILL.md"),
      "---\nname: plain-skill\ndescription: Ordinary skill with no model-invocation metadata.\n---\n\n# Plain\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [plain-skill]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts:\n      - codex\n      - claude\n`,
    );
    const pathValue = `${claudeBin}:${process.env.PATH ?? ""}`;
    const absentValidate = runCliWithPath(home, pathValue, "validate");
    expect(absentValidate.status, absentValidate.stderr).toBe(0);
    const absentApply = runCliWithPath(home, pathValue, "apply");
    expect(absentApply.status, absentApply.stderr).toBe(0);
    expect(
      readFileSync(join(projectPath, ".claude", "skills", "plain-skill", "SKILL.md"), "utf8"),
    ).not.toContain("disable-model-invocation");
    expect(
      existsSync(join(projectPath, ".agents", "skills", "plain-skill", "agents", "openai.yaml")),
    ).toBe(false);

    mkdirSync(join(workspacePath(home), "skills", "to-spec"));
    const sourceBody =
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n  author: maintainer\n---\n\n# To spec\n";
    writeFileSync(join(workspacePath(home), "skills", "to-spec", "SKILL.md"), sourceBody);
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [to-spec]\nagents: []\nhooks: []\ntools: []\n",
    );

    const validate = runCliWithPath(home, pathValue, "validate");
    expect(validate.status, validate.stderr).toBe(0);

    const malformedHome = isolatedHome();
    initialize(malformedHome);
    writeContextProfile(malformedHome);
    mkdirSync(join(workspacePath(malformedHome), "skills", "bad-skill"));
    writeFileSync(
      join(workspacePath(malformedHome), "skills", "bad-skill", "SKILL.md"),
      "---\nname: bad-skill\ndescription: Bad policy.\nmetadata:\n  agent-profile-kit.model-invocation: maybe\n---\n\n# Bad\n",
    );
    writeFileSync(
      join(workspacePath(malformedHome), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [bad-skill]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      configPath(malformedHome),
      `schema_version: 2\nworkspace: ${workspacePath(malformedHome)}\nbindings:\n  - project: ${project()}\n    profile: coding\n    hosts:\n      - codex\n`,
    );
    const malformed = runCli(malformedHome, "validate");
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("allowed' or 'disabled");

    const conflictHome = isolatedHome();
    initialize(conflictHome);
    writeContextProfile(conflictHome);
    mkdirSync(join(workspacePath(conflictHome), "skills", "to-spec", "agents"), { recursive: true });
    writeFileSync(
      join(workspacePath(conflictHome), "skills", "to-spec", "SKILL.md"),
      sourceBody,
    );
    writeFileSync(
      join(workspacePath(conflictHome), "skills", "to-spec", "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n",
    );
    writeFileSync(
      join(workspacePath(conflictHome), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [to-spec]\nagents: []\nhooks: []\ntools: []\n",
    );
    const conflictProject = project();
    writeFileSync(
      configPath(conflictHome),
      `schema_version: 2\nworkspace: ${workspacePath(conflictHome)}\nbindings:\n  - project: ${conflictProject}\n    profile: coding\n    hosts:\n      - codex\n`,
    );
    const conflict = runCli(conflictHome, "preview");
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("conflicting model-invocation authorities");
    expect(existsSync(join(conflictProject, ".agents", "skills", "to-spec"))).toBe(false);

    const preview = runCliWithPath(home, pathValue, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    const apply = runCliWithPath(home, pathValue, "apply");
    expect(apply.status, apply.stderr).toBe(0);

    const claudeSkill = readFileSync(
      join(projectPath, ".claude", "skills", "to-spec", "SKILL.md"),
      "utf8",
    );
    expect(claudeSkill).toContain("disable-model-invocation: true");
    const codexPolicy = parse(
      readFileSync(
        join(projectPath, ".agents", "skills", "to-spec", "agents", "openai.yaml"),
        "utf8",
      ),
    ) as { policy: { allow_implicit_invocation: boolean } };
    expect(codexPolicy.policy.allow_implicit_invocation).toBe(false);
    expect(readFileSync(join(workspacePath(home), "skills", "to-spec", "SKILL.md"), "utf8")).toBe(
      sourceBody,
    );

    // Allowed skill: no Host restriction fields.
    writeFileSync(
      join(workspacePath(home), "skills", "to-spec", "SKILL.md"),
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: allowed\n---\n\n# To spec\n",
    );
    const allowedApply = runCliWithPath(home, pathValue, "apply");
    expect(allowedApply.status, allowedApply.stderr).toBe(0);
    expect(
      readFileSync(join(projectPath, ".claude", "skills", "to-spec", "SKILL.md"), "utf8"),
    ).not.toContain("disable-model-invocation");
    expect(existsSync(join(projectPath, ".agents", "skills", "to-spec", "agents", "openai.yaml"))).toBe(
      false,
    );
  });

  test("packed CLI Skills-only Profile validates, applies, and uninstalls without Context machinery", () => {
    const home = isolatedHome();
    // Init still enables hooks for other suites sharing helpers; Skills-only must not require them.
    const result = runCli(home, "init");
    expect(result.status, result.stderr).toBe(0);
    const claudeBin = installFakeClaude(home);
    const pathValue = `${claudeBin}:${process.env.PATH ?? ""}`;
    const projectPath = project();
    const workspace = workspacePath(home);
    mkdirSync(join(workspace, "skills", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: engineering\n    hosts:\n      - codex\n      - claude\n`,
    );

    const emptyHome = isolatedHome();
    expect(runCli(emptyHome, "init").status).toBe(0);
    writeFileSync(
      join(workspacePath(emptyHome), "profiles", "empty.yaml"),
      "id: empty\ncontext: []\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const emptyValidate = runCli(emptyHome, "validate");
    expect(emptyValidate.status).toBe(1);
    expect(emptyValidate.stderr).toMatch(/at least one supported artifact/i);

    const validate = runCliWithPath(home, pathValue, "validate");
    expect(validate.status, validate.stderr).toBe(0);

    const preview = runCliWithPath(home, pathValue, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(".agents/skills/review-pr");
    expect(preview.stdout).toContain(".claude/skills/review-pr");
    expect(preview.stdout).not.toContain(".agent-profile-kit/codex/context.md");
    expect(preview.stdout).not.toContain(".codex/hooks.json");
    expect(preview.stdout).not.toContain(".claude/rules/agent-profile-kit.md");

    const apply = runCliWithPath(home, pathValue, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(apply.stdout).not.toContain("SessionStart hook");
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const status = runCliWithPath(home, pathValue, "status");
    expect(status.status, status.stderr).toBe(0);

    writeFileSync(configPath(home), `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`);
    const uninstall = runCliWithPath(home, pathValue, "apply");
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr"))).toBe(false);
  });

  test("tracked exact planned Codex Skill destinations block preflight", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = gitRepository();
    writeContextProfile(home);
    mkdirSync(join(workspacePath(home), "skills", "review-pr"));
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\nReview.\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    mkdirSync(join(projectPath, ".agents", "skills", "review-pr"), { recursive: true });
    writeFileSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"), "tracked\n");
    execFileSync("git", ["-C", projectPath, "add", ".agents/skills/review-pr/SKILL.md"]);
    execFileSync("git", ["-C", projectPath, "commit", "-qm", "track skill"]);
    bind(home, projectPath);

    const result = runCli(home, "apply");
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Apply blocked");
    expect(result.stdout).toMatch(/tracked|unowned/i);
    expect(result.stderr).toBe("");
    expect(readFileSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"), "utf8")).toBe(
      "tracked\n",
    );
  });

  test("packed CLI Claude-only preview → apply → status → uninstall installs unscoped Context", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeFileSync(join(projectPath, "CLAUDE.md"), "project-owned instructions\n");
    mkdirSync(join(projectPath, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projectPath, ".claude", "rules", "team.md"), "existing team rule\n");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [claude]\n`,
    );
    const bin = installFakeClaude(home);
    // Prefer the stub, keep the rest of PATH for node/git/etc.
    const pathWithClaude = `${bin}:${process.env.PATH ?? ""}`;

    const preview = runCliWithPath(home, pathWithClaude, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${projectPath}: addition`));
    expect(preview.stdout).toContain("Profile coding");
    expect(preview.stdout).toContain("Context Module: team-rules");
    expect(preview.stdout).toContain("# Agent Profile Kit Context");
    expect(preview.stdout).toContain(".claude/rules/agent-profile-kit.md");
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const apply = runCliWithPath(home, pathWithClaude, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    const rule = readFileSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"), "utf8");
    expect(rule).toContain("Profile: coding");
    expect(rule).toContain("Context Module: team-rules");
    expect(rule).not.toMatch(/^---\n/);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(join(projectPath, "CLAUDE.md"), "utf8")).toBe("project-owned instructions\n");
    expect(readFileSync(join(projectPath, ".claude", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );

    const status = runCliWithPath(home, pathWithClaude, "status");
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("All Projects are current");

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{ hosts: string[]; host_versions: Record<string, string> }>;
    };
    expect(state.installations[0]?.hosts).toEqual(["claude"]);
    expect(state.installations[0]?.host_versions.claude).toBe(
      "native-project-unscoped-rules-skills-v1",
    );

    const uninstall = runCliWithPath(home, pathWithClaude, "uninstall");
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(readFileSync(join(projectPath, "CLAUDE.md"), "utf8")).toBe("project-owned instructions\n");
    expect(readFileSync(join(projectPath, ".claude", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
  });

  test("packed CLI Claude preview fails closed when Claude CLI is missing or too old", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [claude]\n`,
    );
    const emptyBin = join(home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    // PATH with only empty-bin so the real Claude is not discoverable.
    const missing = runCliWithPath(home, emptyBin, "preview");
    expect(missing.status).toBe(2);
    expect(`${missing.stdout}${missing.stderr}`).toContain("Claude Code CLI was not found");

    const oldBin = installFakeClaude(home, "2.0.63");
    const old = runCliWithPath(home, `${oldBin}:${process.env.PATH ?? ""}`, "preview");
    expect(old.status).toBe(2);
    expect(old.stdout.startsWith("Cannot apply\n")).toBe(true);
    expect(old.stdout).toContain("does not support unscoped project rules");
    expect(humanText(old.stdout)).toContain(humanText("requires 2.0.64+"));
    expect(old.stdout).toContain("upgrade Claude Code before previewing or applying the Profile");
    expect(old.stderr).toBe("");
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const boundaryBin = installFakeClaude(home, "2.0.64");
    const boundary = runCliWithPath(home, `${boundaryBin}:${process.env.PATH ?? ""}`, "preview", "--verbose");
    expect(boundary.status, boundary.stderr).toBe(0);
    expect(boundary.stdout).toContain(".claude/rules/agent-profile-kit.md");
  });

  test("packed CLI Grok-only preview → apply → status → uninstall installs unscoped Context", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeFileSync(join(projectPath, "AGENTS.md"), "repository-owned instructions\n");
    mkdirSync(join(projectPath, ".grok", "rules"), { recursive: true });
    writeFileSync(join(projectPath, ".grok", "rules", "team.md"), "existing team rule\n");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [grok]\n`,
    );
    const bin = installFakeGrok(home);
    const pathWithGrok = `${bin}:${process.env.PATH ?? ""}`;

    const preview = runCliWithPath(home, pathWithGrok, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${projectPath}: addition`));
    expect(preview.stdout).toContain(".grok/rules/agent-profile-kit.md");
    expect(preview.stdout).toContain("# Agent Profile Kit Context");
    expect(existsSync(join(projectPath, ".grok", "rules", "agent-profile-kit.md"))).toBe(false);

    const apply = runCliWithPath(home, pathWithGrok, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    const rule = readFileSync(join(projectPath, ".grok", "rules", "agent-profile-kit.md"), "utf8");
    expect(rule).toContain("Profile: coding");
    expect(rule).toContain("Context Module: team-rules");
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("repository-owned instructions\n");
    expect(readFileSync(join(projectPath, ".grok", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );

    const status = runCliWithPath(home, pathWithGrok, "status");
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("All Projects are current");

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{ hosts: string[]; host_versions: Record<string, string> }>;
    };
    expect(state.installations[0]?.hosts).toEqual(["grok"]);
    expect(state.installations[0]?.host_versions.grok).toBe("native-project-unscoped-rules-v1");

    const uninstall = runCliWithPath(home, pathWithGrok, "uninstall");
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".grok", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("repository-owned instructions\n");
    expect(readFileSync(join(projectPath, ".grok", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
  });

  test("packed CLI Grok preview fails closed when Grok CLI is missing or the surface is obstructed, and installs Skills when ready", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [grok]\n`,
    );
    const emptyBin = join(home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const missing = runCliWithPath(home, emptyBin, "preview");
    expect(missing.status).toBe(2);
    expect(`${missing.stdout}${missing.stderr}`).toContain("Grok CLI was not found");

    const oldBin = installFakeGrok(home, { version: "0.1.0" });
    const old = runCliWithPath(home, `${oldBin}:${process.env.PATH ?? ""}`, "preview");
    expect(old.status).toBe(2);
    expect(`${old.stdout}${old.stderr}`).toContain("does not support project rules inspection");
    expect(existsSync(join(projectPath, ".grok", "rules", "agent-profile-kit.md"))).toBe(false);

    writeFileSync(join(projectPath, ".grok"), "occupied\n");
    const surfaceBin = installFakeGrok(home);
    const surface = runCliWithPath(home, `${surfaceBin}:${process.env.PATH ?? ""}`, "preview");
    expect(surface.status).toBe(2);
    expect(`${surface.stdout}${surface.stderr}`).toMatch(/\.grok/);
    expect(existsSync(join(projectPath, ".grok", "rules", "agent-profile-kit.md"))).toBe(false);

    rmSync(join(projectPath, ".grok"), { force: true });
    mkdirSync(join(workspacePath(home), "skills", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\nReview.\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    const skillsBin = installFakeGrok(home);
    const skills = runCliWithPath(
      home,
      `${skillsBin}:${process.env.PATH ?? ""}`,
      "preview",
      "--verbose",
    );
    expect(skills.status, `${skills.stdout}${skills.stderr}`).toBe(0);
    expect(skills.stdout).toContain(".grok/skills/review-pr");
    expect(skills.stdout).toContain(".grok/rules/agent-profile-kit.md");

    const skillsApply = runCliWithPath(home, `${skillsBin}:${process.env.PATH ?? ""}`, "apply");
    expect(skillsApply.status, skillsApply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".grok", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".grok", "rules", "agent-profile-kit.md"))).toBe(true);
  });

  test("packed CLI Claude+Grok binding coalesces onto one Context rule path", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeFileSync(join(projectPath, "CLAUDE.md"), "project-owned\n");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [claude, grok]\n`,
    );
    const bin = installFakeGrok(home);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    execFileSync("chmod", ["+x", join(bin, "claude")]);
    const pathWithHosts = `${bin}:${process.env.PATH ?? ""}`;

    const preview = runCliWithPath(home, pathWithHosts, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(".claude/rules/agent-profile-kit.md");
    expect(preview.stdout).not.toContain(".grok/rules/agent-profile-kit.md");

    const apply = runCliWithPath(home, pathWithHosts, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".grok", "rules", "agent-profile-kit.md"))).toBe(false);

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{ hosts: string[]; host_versions: Record<string, string> }>;
    };
    expect(state.installations[0]?.hosts).toEqual(["claude", "grok"]);
    expect(state.installations[0]?.host_versions).toEqual({
      claude: "native-project-unscoped-rules-skills-v1",
      grok: "native-project-unscoped-rules-v1",
    });
  });

  test("Profiles selecting Skills install portable packages into Claude project discovery", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeFileSync(join(projectPath, "CLAUDE.md"), "project-owned instructions\n");
    mkdirSync(join(projectPath, ".claude", "rules"), { recursive: true });
    writeFileSync(join(projectPath, ".claude", "rules", "team.md"), "existing team rule\n");
    mkdirSync(join(projectPath, ".claude", "skills", "foreign-skill"), { recursive: true });
    writeFileSync(join(projectPath, ".claude", "skills", "foreign-skill", "SKILL.md"), "leave me\n");
    writeContextProfile(home);
    mkdirSync(join(workspacePath(home), "skills", "base-skill"));
    writeFileSync(
      join(workspacePath(home), "skills", "base-skill", "SKILL.md"),
      "---\nname: base-skill\ndescription: Shared base skill.\n---\n\nBase.\n",
    );
    mkdirSync(join(workspacePath(home), "skills", "review-pr", "scripts"), { recursive: true });
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\nReview.\n",
    );
    writeFileSync(join(workspacePath(home), "skills", "review-pr", "scripts", "run.sh"), "#!/bin/sh\necho review\n");
    chmodSync(join(workspacePath(home), "skills", "review-pr", "scripts", "run.sh"), 0o755);
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "agent-profile-kit.yaml"),
      "dependencies:\n  - type: skill\n    id: base-skill\n",
    );
    mkdirSync(join(workspacePath(home), "skills", "unselected-skill"));
    writeFileSync(
      join(workspacePath(home), "skills", "unselected-skill", "SKILL.md"),
      "---\nname: unselected-skill\ndescription: Not selected.\n---\n\nSkip.\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [claude]\n`,
    );
    const bin = installFakeClaude(home);
    const pathWithClaude = `${bin}:${process.env.PATH ?? ""}`;

    const preview = runCliWithPath(home, pathWithClaude, "preview", "--verbose");
    expect(preview.status, preview.stderr).toBe(0);
    expect(humanText(preview.stdout)).toContain(humanText(`${projectPath}: addition`));
    expect(preview.stdout).toContain(".claude/skills/review-pr");
    expect(preview.stdout).toContain(".claude/skills/base-skill");
    expect(preview.stdout).toContain(".claude/rules/agent-profile-kit.md");
    expect(preview.stdout).toContain("skill:review-pr");
    expect(preview.stdout).toContain("skill:base-skill");
    expect(preview.stdout).toContain("via skill:review-pr");
    expect(preview.stdout).not.toContain("unselected-skill");
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr"))).toBe(false);

    const apply = runCliWithPath(home, pathWithClaude, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(readFileSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "Review.",
    );
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr", "agent-profile-kit.yaml"))).toBe(
      false,
    );
    expect(statSync(join(projectPath, ".claude", "skills", "review-pr", "scripts", "run.sh")).mode & 0o777)
      .toBe(0o755);
    expect(existsSync(join(projectPath, ".claude", "skills", "base-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "skills", "unselected-skill"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr"))).toBe(false);
    expect(readFileSync(join(projectPath, ".claude", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );
    expect(readFileSync(join(projectPath, "CLAUDE.md"), "utf8")).toBe("project-owned instructions\n");
    expect(readFileSync(join(projectPath, ".claude", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );

    const status = runCliWithPath(home, pathWithClaude, "status");
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("All Projects are current");

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: readonly {
        hosts: string[];
        host_versions: Record<string, string>;
        resolved_artifacts: readonly { type: string; id: string; inclusion_reasons: readonly unknown[] }[];
      }[];
    };
    expect(state.installations[0]?.hosts).toEqual(["claude"]);
    expect(state.installations[0]?.host_versions.claude).toBe(
      "native-project-unscoped-rules-skills-v1",
    );
    const resolved = state.installations[0]?.resolved_artifacts ?? [];
    expect(resolved.map((artifact) => `${artifact.type}:${artifact.id}`).sort()).toEqual([
      "context:team-rules",
      "skill:base-skill",
      "skill:review-pr",
    ]);
    expect(
      resolved.find((artifact) => artifact.id === "base-skill")?.inclusion_reasons.length,
    ).toBeGreaterThanOrEqual(1);

    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const deselectPreview = runCliWithPath(home, pathWithClaude, "preview");
    expect(deselectPreview.status, deselectPreview.stderr).toBe(0);
    expect(deselectPreview.stdout).toMatch(/removal|\.claude\/skills\/review-pr/);
    const deselect = runCliWithPath(home, pathWithClaude, "apply");
    expect(deselect.status, deselect.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "skills", "base-skill"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(readFileSync(join(projectPath, ".claude", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );

    const uninstall = runCliWithPath(home, pathWithClaude, "uninstall");
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(readFileSync(join(projectPath, ".claude", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );
    expect(readFileSync(join(projectPath, "CLAUDE.md"), "utf8")).toBe("project-owned instructions\n");
  });

  test("legacy plan, install, update, and run interfaces are removed", () => {
    const home = isolatedHome();
    for (const command of ["plan", "install", "update", "run"]) {
      const result = runCli(home, command);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`apkit: unknown command '${command}'`);
      expect(result.stderr).toContain("Run apkit --help for available commands.");
      expect(result.stderr).not.toContain("Commands:");
    }
  });

  test("the packed CLI runs the project-bound init contract", () => {
    const packageDirectory = mkdtempSync(join(tmpdir(), "agent-profile-kit-pack-"));
    temporaryDirectories.push(packageDirectory);
    const packOutput = execFileSync(
      "npm",
      ["pack", "--silent", "--json", "--pack-destination", packageDirectory],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const metadata = JSON.parse(packOutput.slice(packOutput.lastIndexOf("\n[") + 1)) as readonly [{ readonly filename: string }];
    const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-packed-"));
    temporaryDirectories.push(extracted);
    execFileSync("tar", ["-xzf", join(packageDirectory, metadata[0]!.filename), "-C", extracted]);
    const home = isolatedHome();
    const result = spawnSync(process.env.NODE_BINARY ?? "node", [join(extracted, "package", "dist", "cli.js"), "init"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(configPath(home))).toBe(true);
  });

  test("packed package ships both maintained guides and the public overview", () => {
    const packageRoot = resolve(cliPath, "..", "..");
    expect(existsSync(join(packageRoot, "docs", "guides", "workspace.md"))).toBe(true);
    expect(existsSync(join(packageRoot, "docs", "guides", "agent-workflow.md"))).toBe(true);
    expect(existsSync(join(packageRoot, "README.md"))).toBe(true);
  });

  test("packed CLI serves the final project-bound human guide", () => {
    const home = isolatedHome();
    const result = runCli(home, "guide", "--full");
    expect(result.status, result.stderr).toBe(0);

    for (const command of ["init", "validate", "preview", "apply", "status", "unbind", "uninstall"]) {
      expect(result.stdout).toContain(`apkit ${command}`);
    }
    expect(result.stdout).toMatch(/unbind.*(?:desired|Project Binding).*uninstall|uninstall.*unbind/is);
    expect(result.stdout).not.toMatch(/apkit (plan|install|update|run)\b/);

    expect(result.stdout).toMatch(/project:\s*(~\/|\/)/);
    expect(result.stdout).toMatch(/profile:\s+\S+/);
    expect(result.stdout).toMatch(/hosts:\s*\n\s*-\s*(codex|claude)/);

    expect(result.stdout).toContain("SessionStart");
    expect(result.stdout).toContain(".agents/skills/");
    expect(result.stdout).toContain(".claude/rules/");
    expect(result.stdout).toContain(".claude/skills/");
    expect(result.stdout).toMatch(/exact bound root/);
    expect(result.stdout).toMatch(/worktree/i);
    expect(result.stdout).toMatch(/repositor(?:y|ies)[- ]owned project instructions|project instructions take precedence/i);
    expect(result.stdout).toMatch(
      /does not (?:launch Hosts or )?manage\s+(?:their\s+)?(?:authentication|trust|approvals|plugins|sessions)/i,
    );
    expect(result.stdout).not.toMatch(
      /Agent Profile Kit manages\s+(?:native\s+)?(?:authentication|trust|approvals|plugins|sessions)/i,
    );

    // Hook enablement defaults on; project hook review/trust remains Host-owned launch prep.
    const defaultHooksIndex = result.stdout.search(/Lifecycle hooks are enabled by\s+default/i);
    const previewIndex = result.stdout.indexOf("apkit preview");
    const applyIndex = result.stdout.indexOf("apkit apply");
    const trustIndex = result.stdout.search(/trust each bound project/i);
    const launchIndex = result.stdout.search(/Before launching\s+Codex/i);
    expect(defaultHooksIndex).toBeGreaterThan(-1);
    expect(previewIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeGreaterThan(-1);
    expect(trustIndex).toBeGreaterThan(-1);
    expect(launchIndex).toBeGreaterThan(-1);
    expect(defaultHooksIndex).toBeLessThan(previewIndex);
    expect(defaultHooksIndex).toBeLessThan(applyIndex);
    expect(trustIndex).toBeGreaterThan(applyIndex);
    expect(Math.abs(trustIndex - launchIndex)).toBeLessThan(120);
  });

  test("guide profile supplies everything a minimal Workspace needs to bind its example", () => {
    const home = isolatedHome();
    const workspace = workspacePath(home);
    mkdirSync(join(workspace, "profiles"), { recursive: true });
    mkdirSync(join(workspace, "context"));
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspace}\nbindings: []\n`,
    );

    const result = runCli(home, "guide", "profile");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n").length).toBeLessThanOrEqual(FOCUSED_GUIDE_MAX_LINES);
    const profile = result.stdout.match(
      /Create `profiles\/example\.yaml`:\n\n```yaml\n([\s\S]*?)```/,
    )?.[1];
    const context = result.stdout.match(
      /Create `context\/example-context\.md`:\n\n```md\n([\s\S]*?)```/,
    )?.[1];
    expect(profile).toBeDefined();
    expect(context).toBeDefined();
    writeFileSync(join(workspace, "profiles", "example.yaml"), profile!);
    writeFileSync(join(workspace, "context", "example-context.md"), context!);

    const bind = runCli(home, "bind", "example", project(), "--host", "codex");
    expect(bind.status, bind.stderr).toBe(0);
  });

  test("guide context returns the short scaffolded Context Module example", () => {
    const home = isolatedHome();
    initialize(home);
    const scaffolded = readFileSync(
      join(workspacePath(home), "context", "example-context.md"),
      "utf8",
    );

    const result = runCli(home, "guide", "context");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n").length).toBeLessThanOrEqual(FOCUSED_GUIDE_MAX_LINES);
    expect(result.stdout).toContain("context/example-context.md");
    expect(result.stdout).toContain(`\`\`\`md\n${scaffolded}\`\`\``);
  });

  test("guide skill returns a short complete Skill example that validates when copied", () => {
    const home = isolatedHome();
    initialize(home);

    const result = runCli(home, "guide", "skill");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.split("\n").length).toBeLessThanOrEqual(FOCUSED_GUIDE_MAX_LINES);
    expect(result.stdout).toContain("skills/example-skill/SKILL.md");
    const example = result.stdout.match(/```md\n([\s\S]*?)```/)?.[1];
    expect(example).toBeDefined();
    const skillDirectory = join(workspacePath(home), "skills", "example-skill");
    mkdirSync(skillDirectory, { recursive: true });
    writeFileSync(join(skillDirectory, "SKILL.md"), example!);

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
  });

  test("bare guide indexes topics while --full and --agent serve maintained guides", () => {
    const home = isolatedHome();
    const packageRoot = resolve(cliPath, "..", "..");

    const human = runCli(home, "guide");
    const full = runCli(home, "guide", "--full");
    const agent = runCli(home, "guide", "--agent");

    expect(human.status, human.stderr).toBe(0);
    expect(full.status, full.stderr).toBe(0);
    expect(agent.status, agent.stderr).toBe(0);
    expect(human.stdout).toContain("apkit guide profile");
    expect(human.stdout).toContain("apkit guide context");
    expect(human.stdout).toContain("apkit guide skill");
    expect(human.stdout).toContain("apkit guide --full");
    expect(human.stdout).toContain("apkit guide --agent");
    expect(human.stdout).toContain("Profiles select it by its");
    expect(human.stdout).toContain("frontmatter `id`.");
    expect(human.stdout).toContain("frontmatter `name`,");
    expect(human.stdout).not.toContain("SessionStart");
    expect(full.stdout).toBe(
      readFileSync(join(packageRoot, "docs", "guides", "workspace.md"), "utf8"),
    );
    expect(agent.stdout).toBe(
      readFileSync(join(packageRoot, "docs", "guides", "agent-workflow.md"), "utf8"),
    );
    expect(existsSync(workspacePath(home))).toBe(false);
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(stateDirectory(home))).toBe(false);
  });

  test("packed CLI serves the final project-bound agent workflow", () => {
    const home = isolatedHome();
    const result = runCli(home, "guide", "--agent");
    expect(result.status, result.stderr).toBe(0);

    expect(result.stdout).not.toMatch(/apkit (plan|install|update|run)\b/);
    expect(result.stdout).toMatch(/Local\s+Configuration/);
    expect(result.stdout).toMatch(/Agents, Hooks, or Tools|Agents, Hooks, and Tools/);
    expect(result.stdout).toMatch(/reject/i);
    expect(result.stdout).toMatch(/do not invent|Ask instead of inventing/i);
    expect(result.stdout).toMatch(/credential/i);
    expect(result.stdout).toMatch(/machine[- ](path|specific)|Host preference/i);
    expect(result.stdout).toMatch(/exact bound root/);
    expect(result.stdout).toMatch(/does not claim that Agent Profile Kit manages|Do not claim that Agent Profile Kit manages/i);
    expect(result.stdout).toMatch(/optional scaffolding|empty categor/i);
    expect(result.stdout).toMatch(/workspace\.yaml/);
    expect(result.stdout).toMatch(/at least one supported artifact|Context is not mandatory|Skills-only/i);
    expect(result.stdout).toMatch(/unselected universal|universal artifact/i);
    expect(result.stdout).toMatch(
      /(?:does not manage|not Agent Profile Kit[-–]owned).{0,80}global|user-managed native global/i,
    );
    expect(result.stdout).toMatch(/Host Resolution/i);
    expect(result.stdout).toMatch(/Output Ownership Conflict/i);
    for (const command of ["validate", "preview", "apply", "status", "unbind", "uninstall"]) {
      expect(result.stdout).toContain(`apkit ${command}`);
    }
  });

  test("packed human guide distinguishes required Manifest from init scaffolding", () => {
    const home = isolatedHome();
    const result = runCli(home, "guide", "--full");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Required structure vs initialization scaffolding|valid Workspace needs only/i);
    expect(result.stdout).toMatch(/workspace\.yaml/);
    expect(result.stdout).toMatch(/empty categor/i);
    expect(result.stdout).toMatch(/README\.md/);
    expect(result.stdout).toMatch(/optional/i);
    expect(result.stdout).toMatch(/0\.16\.1/);
    expect(result.stdout).toMatch(/roll(?:ing|ed)?\s+(?:a\s+)?(?:machine\s+)?back|downgrade|older than 0\.16\.1/i);
    expect(result.stdout).toMatch(/profiles\//);
    expect(result.stdout).toMatch(/at least one supported artifact|Skills-only Profile|no individual category is mandatory/i);
    expect(result.stdout).toMatch(/0\.17\.0/);
    expect(result.stdout).toMatch(
      /Skills-only|before rolling a machine back to a CLI older than 0\.17|convert each Skills-only|stranded/i,
    );
  });

  test("packed human guide separates universal Workspace source ownership from managed delivery", () => {
    const home = isolatedHome();
    const result = runCli(home, "guide", "--full");
    expect(result.status, result.stderr).toBe(0);

    // Workspace may own Profile-selected and unselected universal artifacts as one canonical source.
    expect(result.stdout).toMatch(/universal/i);
    expect(result.stdout).toMatch(/unselected/i);
    expect(result.stdout).toMatch(
      /canonical source|single canonical source|Workspace (?:is|remains|may (?:own|canonically own))/i,
    );
    expect(result.stdout).toMatch(/source ownership and managed delivery/i);

    // v1 does not manage global Host delivery as owned APK state.
    expect(result.stdout).toMatch(
      /does not install, project, synchronize, or remove material in\s+personal\/global/i,
    );
    expect(result.stdout).toMatch(
      /(?:not APK-owned|outside Project Bindings).{0,80}Installation Manifest/is,
    );
    expect(result.stdout).toMatch(
      /never adopt, record as managed output, or mutate those paths/i,
    );
    expect(result.stdout).toMatch(/Host Resolution/i);

    // Bindings select Profile/Hosts; artifacts enter Manifests / managed lifecycle.
    expect(result.stdout).toMatch(
      /Project Binding selects|Bindings select|binding selects/i,
    );
    expect(result.stdout).toMatch(/Installation Manifests and the managed lifecycle/i);

    // User-managed global delivery is permitted without becoming APK-owned state.
    expect(result.stdout).toMatch(/manage native global delivery yourself/i);
    expect(result.stdout).toMatch(/symlinking/i);
    expect(result.stdout).not.toMatch(
      /Agent Profile Kit (?:owns|manages|tracks) (?:your )?global (?:Host )?(?:Skill |delivery)/i,
    );

    // Same-identity native delivery is delegated to the Host.
    expect(result.stdout).toMatch(/may be both universally delivered/i);
    expect(result.stdout).toMatch(/exact planned destination/i);
  });

  test("init bootstrap pointers stay short and name current guide commands", () => {
    const home = isolatedHome();
    initialize(home);
    const readme = readFileSync(join(workspacePath(home), "README.md"), "utf8");
    const agents = readFileSync(join(workspacePath(home), "AGENTS.md"), "utf8");

    expect(readme).toContain("apkit guide");
    expect(readme).toContain("apkit guide --full");
    expect(agents).toContain("apkit guide --agent");
    expect(readme).not.toMatch(/agent-profile-kit (plan|install|update|run)\b/);
    expect(agents).not.toMatch(/agent-profile-kit (plan|install|update|run)\b/);
    expect(readme.trim().split("\n").length).toBeLessThan(12);
    expect(agents.trim().split("\n").length).toBeLessThan(12);
  });

  test("public overview describes project-bound Profiles without migration-era lifecycle terms", () => {
    const packageRoot = resolve(cliPath, "..", "..");
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");

    expect(readme).toMatch(/Profile/i);
    expect(readme).toMatch(/bound project|Project Binding/i);
    expect(readme).toContain("Codex");
    expect(readme).toContain("Claude");
    expect(readme).toContain("apkit apply");
    expect(readme).toContain("apkit guide --full");
    expect(readme).toMatch(/Warnings.{0,80}exit|exit.{0,80}Warnings/is);
    expect(readme).not.toMatch(/agent-profile-kit (plan|install|update|run)\b/);
    expect(readme).not.toMatch(/per-session launcher|global Skill projection|process[- ]overlay/i);
    expect(readme).not.toMatch(/legacy migration input/i);
  });
});

describe("agent-profile-kit unbind (recording-only Project Binding removal)", () => {
  test("unbind without a project argument removes the canonical current working directory binding", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);

    const result = runCliAt(home, projectPath, "unbind");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Removed Project Binding");
    expect(result.stdout).toContain(realpathSync(projectPath));
    expect(result.stdout).toContain("Profile: coding");
    expect(result.stdout).toContain("Hosts: codex");
    expect(result.stdout).toContain(configPath(home));
    expect(result.stdout).not.toContain("Next:");
    expect(result.stdout).not.toContain("apkit apply");
    expect(parse(readFileSync(configPath(home), "utf8")).bindings).toEqual([]);
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("unbind removes a missing project only by exact authored path", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const authored = "~/projects/agent-profile-kit-unbind-missing";
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${authored}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "unbind", authored);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Removed Project Binding");
    expect(result.stdout).toContain("canonical project identity could not be proven");
    expect(result.stdout).toContain(`Local Configuration: ${configPath(home)}`);
    expect(parse(readFileSync(configPath(home), "utf8")).bindings).toEqual([]);
  });

  test("unbind does not infer an alias for a missing authored project path", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const authored = "~/projects/agent-profile-kit-unbind-authored";
    const alias = "~/projects/agent-profile-kit-unbind-alias";
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${authored}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const before = readFileSync(configPath(home), "utf8");

    const result = runCli(home, "unbind", alias);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Project Binding unchanged");
    expect(result.stdout).toContain(alias);
    expect(readFileSync(configPath(home), "utf8")).toBe(before);
  });

  test("unbind rejects malformed or ambiguous Local Configuration without mutation", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const malformed = `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: not-an-array\n`;
    writeFileSync(configPath(home), malformed);

    const malformedResult = runCli(home, "unbind", projectPath);

    expect(malformedResult.status).toBe(1);
    expect(malformedResult.stderr).toMatch(/bindings must be an array/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(malformed);

    const missing = "~/projects/agent-profile-kit-unbind-ambiguous";
    const ambiguous =
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
      `  - project: ${missing}\n    profile: coding\n    hosts: [codex]\n` +
      `  - project: ${missing}\n    profile: coding\n    hosts: [codex]\n`;
    writeFileSync(configPath(home), ambiguous);

    const ambiguousResult = runCli(home, "unbind", missing);

    expect(ambiguousResult.status).toBe(1);
    expect(ambiguousResult.stderr).toMatch(/duplicates missing project path/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(ambiguous);
  });

  test("unbind fails closed with a hand-edit fallback when a Profile is missing", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const source =
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: missing\n    hosts: [codex]\n`;
    writeFileSync(configPath(home), source);

    const result = runCli(home, "unbind", projectPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not exist in this Workspace/i);
    expect(result.stderr).toMatch(/edit Local Configuration directly/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(source);
  });

  test("unbind gives an empty Workspace one recovery for its stale missing Profile", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    const projectPath = project();
    const source =
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: missing\n    hosts: [codex]\n`;
    writeFileSync(configPath(home), source);

    const result = runCli(home, "unbind", projectPath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Profiles exist in the Workspace");
    expect(result.stderr).toMatch(/edit Local Configuration directly/i);
    expect(result.stderr).not.toContain("apkit guide");
    expect(readFileSync(configPath(home), "utf8")).toBe(source);
  });

  test("unbind refuses a direct edit observed before atomic publication", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);
    const configuration = configPath(home);
    const before = readFileSync(configuration, "utf8");

    const { unbindProject } = await import("../installer/unbind-project.js");
    const {
      mkdir,
      readdir,
      readFile,
      rename,
      rm,
      stat,
      unlink,
      writeFile,
    } = await import("node:fs/promises");
    let staged = false;
    await expect(
      unbindProject({
        home,
        project: projectPath,
        fileSystem: {
          mkdir,
          readdir,
          rename,
          rm,
          stat,
          unlink,
          writeFile: async (path, data, options) => {
            const result = await writeFile(path, data, options);
            if (typeof path === "string" && path.includes(".config-") && path.endsWith(".tmp")) {
              staged = true;
            }
            return result;
          },
          readFile: (async (path: string, encoding?: BufferEncoding) => {
            if (path === configuration && staged) {
              await writeFile(configuration, `${before.trimEnd()}\n# external edit before replace\n`);
            }
            return readFile(path, encoding ?? "utf8");
          }) as typeof readFile,
        },
      }),
    ).rejects.toThrow(/changed before unbind publication/i);

    expect(readFileSync(configuration, "utf8")).toContain("# external edit before replace");
    expect(readFileSync(configuration, "utf8")).toContain(projectPath);
  });

  test("unbind leaves Workspace, project output, state, and Host configuration untouched", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);
    const projectOutput = join(projectPath, ".agent-profile-kit");
    mkdirSync(projectOutput, { recursive: true });
    writeFileSync(join(projectOutput, "sentinel"), "project output\n");
    const state = join(home, ".agents", "agent-profile-kit", "state");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "sentinel"), "machine state\n");
    const hostConfig = join(home, ".codex", "config.toml");
    const hostBefore = readFileSync(hostConfig, "utf8");
    const workspaceBefore = readdirSync(workspacePath(home)).sort();

    const result = runCli(home, "unbind", projectPath);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(projectOutput, "sentinel"), "utf8")).toBe("project output\n");
    expect(readFileSync(join(state, "sentinel"), "utf8")).toBe("machine state\n");
    expect(readFileSync(hostConfig, "utf8")).toBe(hostBefore);
    expect(readdirSync(workspacePath(home)).sort()).toEqual(workspaceBefore);
  });

  test("unbind reports no match without rewriting Local Configuration", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const bound = project();
    const other = project();
    bind(home, bound);
    const before = readFileSync(configPath(home), "utf8");

    const result = runCli(home, "unbind", other);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Project Binding unchanged");
    expect(readFileSync(configPath(home), "utf8")).toBe(before);
  });

  test("unbind leaves reconciliation of former output to global preview and apply", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);

    const applied = runCli(home, "apply");
    expect(applied.status, applied.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(true);

    const removed = runCli(home, "unbind", projectPath);
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.stdout).toContain("Next: apkit preview && apkit apply");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(true);

    const preview = runCli(home, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(projectPath);
    expect(preview.stdout).toMatch(/removal/i);

    const reconciled = runCli(home, "apply");
    expect(reconciled.status, reconciled.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
  });

  test("unbind omits reconciliation guidance when uninstall already removed generated output", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    expect(runCli(home, "uninstall").status).toBe(0);

    const result = runCli(home, "unbind", projectPath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Removed Project Binding");
    expect(result.stdout).not.toContain("Next:");
    expect(result.stdout).not.toContain("preview");
    expect(result.stdout).not.toContain("apply");
  });

  test("unbind preserves Local Configuration line endings and file mode", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    writeFileSync(
      configPath(home),
      `schema_version: 2\r\n# keep\r\nworkspace: ${workspacePath(home)}\r\nbindings:\r\n  - project: ${projectPath}\r\n    profile: coding\r\n    hosts: [codex]\r\n`,
    );
    chmodSync(configPath(home), 0o600);

    const result = runCli(home, "unbind", projectPath);

    expect(result.status, result.stderr).toBe(0);
    const source = readFileSync(configPath(home), "utf8");
    expect(source).toContain("\r\n");
    expect(source).toContain("# keep");
    expect(source.split("\n").every((line) => line.endsWith("\r") || line === "")).toBe(true);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
  });

  test("unbind accepts an explicit symlink alias and removes its canonical binding", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const alias = join(home, "project-alias");
    symlinkSync(projectPath, alias, "dir");
    bind(home, projectPath);

    const result = runCli(home, "unbind", alias);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Removed Project Binding for ${projectPath}`);
    expect(result.stdout).toContain("Canonical project:");
    expect(parse(readFileSync(configPath(home), "utf8")).bindings).toEqual([]);
    expect(existsSync(alias)).toBe(true);
  });

  test("unbind preserves flow-style unrelated binding text", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const removed = project();
    const retained = project();
    const source =
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: [{project: ${removed}, profile: coding, hosts: [codex]}, ` +
      `{project: ${retained}, profile: coding, hosts: [claude]}]\n`;
    writeFileSync(configPath(home), source);

    const result = runCli(home, "unbind", removed);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toBe(
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: [{project: ${retained}, profile: coding, hosts: [claude]}]\n`,
    );
  });

  test("unbind resolves an existing home-relative project path", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = join(home, "projects", "home-relative");
    mkdirSync(projectPath, { recursive: true });
    const authored = "~/projects/home-relative";
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${authored}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "unbind", authored);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Removed Project Binding");
    expect(parse(readFileSync(configPath(home), "utf8")).bindings).toEqual([]);
  });

  test("unbind removes one explicit existing binding and preserves unrelated configuration", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const removed = project();
    const retained = project();
    const original =
      `schema_version: 2\n# keep this comment\nworkspace: ${workspacePath(home)}\nbindings:\n` +
      `  # remove this binding note\n  - project: ${removed}\n    profile: coding\n    hosts: [codex]\n` +
      `  # retain this binding note\n  - project: ${retained}\n    profile: coding\n    hosts: [claude]\n`;
    writeFileSync(configPath(home), original);

    const result = runCli(home, "unbind", removed);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Removed Project Binding for ${removed}`);
    expect(result.stdout).toContain("Canonical project:");
    expect(result.stdout).toContain("Profile: coding");
    expect(result.stdout).toContain("Hosts: codex");
    const source = readFileSync(configPath(home), "utf8");
    expect(source).toBe(
      `schema_version: 2\n# keep this comment\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        `  # retain this binding note\n  - project: ${retained}\n    profile: coding\n    hosts: [claude]\n`,
    );
  });
});

describe("agent-profile-kit bind (recording-only Project Binding authoring)", () => {
  test("bind records the canonical cwd when no project argument is supplied", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const before = readFileSync(configPath(home), "utf8");

    const result = runCliAt(home, projectPath, "bind", "coding", "--host", "codex");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Recorded Project Binding for .\n");
    expect(result.stdout).not.toContain(realpathSync(projectPath));
    expect(result.stdout).toContain("Profile: coding");
    expect(result.stdout).toContain("Hosts: codex");
    expect(result.stdout).not.toContain(configPath(home));
    expect(result.stdout).toContain("apkit preview");
    expect(readFileSync(configPath(home), "utf8")).not.toBe(before);
    expect(readFileSync(configPath(home), "utf8")).toContain(realpathSync(projectPath));
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("bind accepts an explicit absolute project path and multi-Host set in canonical order", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();

    const result = runCli(
      home,
      "bind",
      "coding",
      projectPath,
      "--host",
      "codex",
      "--host",
      "claude",
      "--host",
      "pi",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Hosts: claude, codex, pi");
    const source = readFileSync(configPath(home), "utf8");
    expect(source).toContain(`project: ${projectPath}`);
    // Hosts are stored in canonical SUPPORTED_HOSTS order (claude before codex).
    expect(source).toMatch(/hosts:\n\s+- claude\n\s+- codex\n\s+- pi/);

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("1 Project Binding");
  });

  test("bind accepts a home-relative project path and preserves authored spelling", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = join(home, "projects", "sample");
    mkdirSync(projectPath, { recursive: true });
    const relative = "~/projects/sample";

    const result = runCli(home, "bind", "coding", relative, "--host", "codex");

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toContain(`project: ${relative}`);
  });

  test("identical bind is idempotent and does not rewrite Local Configuration", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const first = runCli(home, "bind", "coding", projectPath, "--host", "codex");
    expect(first.status, first.stderr).toBe(0);
    const afterFirst = readFileSync(configPath(home), "utf8");

    const second = runCli(home, "bind", "coding", projectPath, "--host", "codex");
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("unchanged");
    expect(readFileSync(configPath(home), "utf8")).toBe(afterFirst);
  });

  test("conflicting bind for an already-bound canonical root fails without mutation", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home, "coding");
    writeContextProfile(home, "ops");
    const projectPath = project();
    writeFileSync(
      configPath(home),
      `schema_version: 2\n# keep comment\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts:\n      - codex\n`,
    );
    const before = readFileSync(configPath(home), "utf8");

    const result = runCli(home, "bind", "ops", projectPath, "--host", "codex");

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already binds|replace is not supported/i);
    expect(readFileSync(configPath(home), "utf8")).toBe(before);
  });

  test("successful bind preserves unrelated configuration, comments, and bindings", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const existing = project();
    const next = project();
    writeFileSync(
      configPath(home),
      `schema_version: 2\n# keep this comment\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${existing}\n    profile: coding\n    hosts:\n      - codex\n`,
    );

    const result = runCli(home, "bind", "coding", next, "--host", "claude");
    expect(result.status, result.stderr).toBe(0);

    const source = readFileSync(configPath(home), "utf8");
    expect(source).toContain("# keep this comment");
    expect(source).toContain(`workspace: ${workspacePath(home)}`);
    expect(source).toContain(`project: ${existing}`);
    expect(source).toContain(`project: ${next}`);
    expect(source).toMatch(/hosts:\n\s+- claude/);
  });

  test("bind rejects unknown Profile, unsupported Host, missing project, and missing --host", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    writeFileSync(
      join(workspacePath(home), "profiles", "writing.yaml"),
      "id: writing\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const projectPath = project();
    const before = readFileSync(configPath(home), "utf8");

    const unknownProfile = runCli(home, "bind", "missing", projectPath, "--host", "codex");
    expect(unknownProfile.status).toBe(1);
    expect(unknownProfile.stderr).toMatch(/does not exist|profile/i);
    expect(unknownProfile.stderr).toContain("Available Profiles: coding, example, writing");
    expect(unknownProfile.stderr).not.toContain(configPath(home));
    expect(unknownProfile.stderr).not.toContain(realpathSync(workspacePath(home)));

    const badHost = runCli(home, "bind", "coding", projectPath, "--host", "gemini");
    expect(badHost.status).toBe(1);
    expect(badHost.stderr).toMatch(/unsupported Agent Host/i);
    expect(badHost.stderr).toContain("pi");

    const missingProject = runCli(
      home,
      "bind",
      "coding",
      join(home, "no-such-project"),
      "--host",
      "codex",
    );
    expect(missingProject.status).toBe(1);
    expect(missingProject.stderr).toMatch(/existing directory/i);

    const noHost = runCli(home, "bind", "coding", projectPath);
    expect(noHost.status).toBe(1);
    expect(noHost.stderr).toMatch(/--host/i);

    const relative = runCli(home, "bind", "coding", "relative/path", "--host", "codex");
    expect(relative.status).toBe(1);
    expect(relative.stderr).toMatch(/absolute path or home-relative/i);

    expect(readFileSync(configPath(home), "utf8")).toBe(before);
  });

  test("bind turns an empty Workspace missing-Profile error into an authoring next step", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    const projectPath = project();

    const result = runCli(home, "bind", "coding", projectPath, "--host", "codex");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Profiles exist in the Workspace");
    expect(result.stderr).toContain("Run apkit guide profile to learn how to add a Profile");
    expect(result.stderr).not.toContain("Available Profiles:");
  });

  test("bind never touches project output, Installation Manifests, or Host configuration", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const hostConfig = join(home, ".codex", "config.toml");
    const hostBefore = readFileSync(hostConfig, "utf8");
    const workspaceBefore = readdirSync(workspacePath(home)).sort().join("\n");

    const result = runCli(home, "bind", "coding", projectPath, "--host", "codex");
    expect(result.status, result.stderr).toBe(0);

    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex"))).toBe(false);
    expect(existsSync(statePath(home))).toBe(false);
    expect(readFileSync(hostConfig, "utf8")).toBe(hostBefore);
    expect(readdirSync(workspacePath(home)).sort().join("\n")).toBe(workspaceBefore);
  });

  test("bind refuses a direct edit observed by the final source recheck", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const configuration = configPath(home);
    const before = readFileSync(configuration, "utf8");

    const { bindProject } = await import("../installer/bind-project.js");
    const {
      mkdir,
      readdir,
      readFile,
      rename,
      rm,
      stat,
      unlink,
      writeFile,
    } = await import("node:fs/promises");

    // Adversarial: after the replacement is staged, an external editor mutates
    // config.yaml before the pre-rename re-check — publish must fail closed.
    let staged = false;
    await expect(
      bindProject({
        home,
        profile: "coding",
        project: projectPath,
        hosts: ["codex"],
        fileSystem: {
          mkdir,
          readdir,
          rename,
          rm,
          stat,
          unlink,
          writeFile: async (path, data, options) => {
            const result = await writeFile(path, data, options);
            if (typeof path === "string" && path.includes(".config-") && path.endsWith(".tmp")) {
              staged = true;
            }
            return result;
          },
          readFile: (async (path: string, encoding?: BufferEncoding) => {
            if (path === configuration && staged) {
              await writeFile(
                configuration,
                `${before.trimEnd()}\n# external edit before replace\n`,
              );
            }
            return readFile(path, encoding ?? "utf8");
          }) as typeof readFile,
        },
      }),
    ).rejects.toThrow(/changed before bind publication/i);

    expect(readFileSync(configuration, "utf8")).toContain("# external edit before replace");
    expect(readFileSync(configuration, "utf8")).not.toContain(projectPath);
  });

  test("bind validates the pre-replace snapshot so a mid-flight rewrite cannot diverge from the edit model", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    writeContextProfile(home, "ops");
    const projectPath = project();
    const configuration = configPath(home);
    const empty = `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`;
    writeFileSync(configuration, empty);

    const { bindProject } = await import("../installer/bind-project.js");
    const {
      mkdir,
      readdir,
      readFile,
      rename,
      rm,
      stat,
      unlink,
      writeFile,
    } = await import("node:fs/promises");

    // Lie on the first config read (empty model) while the real file already has a
    // conflicting binding; the pre-replace re-check must detect bytes ≠ snapshot.
    const conflicting =
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: ops\n    hosts:\n      - codex\n`;
    writeFileSync(configuration, conflicting);

    let configReads = 0;
    await expect(
      bindProject({
        home,
        profile: "coding",
        project: projectPath,
        hosts: ["codex"],
        fileSystem: {
          mkdir,
          readdir,
          rename,
          rm,
          stat,
          unlink,
          writeFile,
          readFile: (async (path: string, encoding?: BufferEncoding) => {
            if (path === configuration) {
              configReads += 1;
              if (configReads === 1) return empty;
            }
            return readFile(path, encoding ?? "utf8");
          }) as typeof readFile,
        },
      }),
    ).rejects.toThrow(/changed before bind publication/i);

    expect(readFileSync(configuration, "utf8")).toContain("profile: ops");
    expect(readFileSync(configuration, "utf8")).not.toContain("profile: coding");
  });

  test("concurrent binds retain both Project Bindings when one pauses mid-publish", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const first = project();
    const second = project();
    const configuration = configPath(home);

    const { bindProject } = await import("../installer/bind-project.js");
    const {
      mkdir,
      readdir,
      readFile,
      rename,
      rm,
      stat,
      unlink,
      writeFile,
    } = await import("node:fs/promises");

    // Bind A pauses after staging the replacement, while still holding the lock —
    // the canonical path must remain readable and Bind B must wait, not steal.
    let releasePublish: (() => void) | undefined;
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let aReachedPublish = false;

    const bindA = bindProject({
      home,
      profile: "coding",
      project: first,
      hosts: ["codex"],
      fileSystem: {
        mkdir,
        readdir,
        readFile,
        rm,
        stat,
        unlink,
        writeFile,
        rename: async (from, to) => {
          if (to === configuration && !aReachedPublish) {
            aReachedPublish = true;
            await publishGate;
          }
          return rename(from, to);
        },
      },
    });

    // Wait until A has entered publication under the exclusive lock.
    for (let i = 0; i < 200 && !aReachedPublish; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(aReachedPublish).toBe(true);
    // Canonical Local Configuration remains continuously readable mid-publish.
    expect(existsSync(configuration)).toBe(true);
    expect(readFileSync(configuration, "utf8")).toContain("bindings:");

    const bindB = bindProject({
      home,
      profile: "coding",
      project: second,
      hosts: ["claude"],
    });

    // B is waiting on the lock; release A's publish so both can finish.
    await new Promise((resolve) => setTimeout(resolve, 30));
    releasePublish?.();

    const [resultA, resultB] = await Promise.all([bindA, bindB]);
    expect(resultA.outcome).toBe("created");
    expect(resultB.outcome).toBe("created");

    const source = readFileSync(configuration, "utf8");
    expect(source).toContain(first);
    expect(source).toContain(second);
    expect(source).toContain("codex");
    expect(source).toContain("claude");

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("2 Project Bindings");
  });

  test("bind recovers legacy held residue only under exclusive lock ownership", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const configuration = configPath(home);
    const kitDir = join(home, ".agents", "agent-profile-kit");
    const heldPath = join(kitDir, ".config-held-legacy");
    const original = readFileSync(configuration, "utf8");
    writeFileSync(heldPath, original);
    rmSync(configuration);

    const { bindProject } = await import("../installer/bind-project.js");
    // Pre-lock recovery would steal/restore without ownership. Under-lock recovery
    // restores the residue only after exclusive acquisition, then publishes.
    const result = await bindProject({
      home,
      profile: "coding",
      project: projectPath,
      hosts: ["codex"],
    });
    expect(result.outcome).toBe("created");
    expect(existsSync(configuration)).toBe(true);
    expect(readFileSync(configuration, "utf8")).toContain(projectPath);
    expect(existsSync(heldPath)).toBe(false);
  });

  test("bind does not steal a freshly empty lock while ownership is still initializing", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const configuration = configPath(home);
    const lockPath = `${configuration}.lock`;
    // Simulate the pre-fix window: exclusive create without PID body yet.
    writeFileSync(lockPath, "");

    const { bindProject } = await import("../installer/bind-project.js");
    const started = Date.now();
    // Empty locks are live until their age exceeds the timeout. Instant steal
    // (treating empty as dead NaN PID) would finish in a few ms; waiting is required.
    await bindProject({
      home,
      profile: "coding",
      project: projectPath,
      hosts: ["codex"],
      lockTimeoutMs: 150,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
    expect(readFileSync(configuration, "utf8")).toContain(projectPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("concurrent binds serialize under the lock so both Project Bindings are retained", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const first = project();
    const second = project();

    const { bindProject } = await import("../installer/bind-project.js");
    const results = await Promise.all([
      bindProject({ home, profile: "coding", project: first, hosts: ["codex"] }),
      bindProject({ home, profile: "coding", project: second, hosts: ["claude"] }),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["created", "created"]);
    const source = readFileSync(configPath(home), "utf8");
    expect(source).toContain(first);
    expect(source).toContain(second);
    expect(source).toContain("codex");
    expect(source).toContain("claude");

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("2 Project Bindings");
  });

  test("bind recovers from a stale lock left by a dead owner process", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const lockPath = `${configPath(home)}.lock`;
    // PID 1 is not a reliable "dead" process on all systems; use a high unused pid.
    writeFileSync(lockPath, "2147483646\n");

    const result = runCli(home, "bind", "coding", projectPath, "--host", "codex");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Recorded Project Binding");
    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(configPath(home), "utf8")).toContain(projectPath);
  });

  test("bind reports missing Local Configuration before lock acquisition", () => {
    const home = isolatedHome();
    const projectPath = project();
    const result = runCli(home, "bind", "coding", projectPath, "--host", "codex");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Local Configuration is missing/);
    expect(result.stderr).toMatch(/apkit init/);
    expect(result.stderr).not.toMatch(/config\.yaml\.lock/);
  });

  test("bind preserves CRLF line endings in Local Configuration", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    writeFileSync(configPath(home), `schema_version: 2\r\n# keep\r\nworkspace: ${workspacePath(home)}\r\nbindings: []\r\n`);

    const result = runCli(home, "bind", "coding", projectPath, "--host", "codex");
    expect(result.status, result.stderr).toBe(0);

    const source = readFileSync(configPath(home), "utf8");
    expect(source).toContain("\r\n");
    expect(source).toContain("# keep");
    expect(source.split("\n").every((line) => line.endsWith("\r") || line === "")).toBe(true);
  });

  test("bind preserves a hardened Local Configuration file mode", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const configuration = configPath(home);
    chmodSync(configuration, 0o600);

    const result = runCli(home, "bind", "coding", projectPath, "--host", "codex");
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(configuration).mode & 0o777).toBe(0o600);
  });

  test("CLI help lists bind as a recording-only authoring command", () => {
    const home = isolatedHome();
    const result = runCli(home, "bind");
    expect(result.status).toBe(1);
    // Missing profile still names the command-specific usage; unknown commands stay concise.
    const usage = runCli(home, "unknown-command");
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain("Run apkit --help for available commands.");
    expect(usage.stderr).not.toContain("Commands:");
  });
});

describe("responsive lifecycle reports", () => {
  test("packed lifecycle output follows TTY width while pipes and JSON stay deterministic", () => {
    const home = isolatedHome();
    const projectPath = project();
    initialize(home);

    const bindResult = runCli(home, "bind", "example", projectPath, "--host", "codex");
    expect(bindResult.status, bindResult.stderr).toBe(0);

    const narrow = runCliInPty(home, 40, "status");
    const redirectedNarrow = runCliWithEnvironment(home, { COLUMNS: "40" }, "status");
    const redirectedWide = runCliWithEnvironment(home, { COLUMNS: "160" }, "status");
    const json = runCli(home, "status", "--json");
    const jsonNarrow = runCliWithEnvironment(home, { COLUMNS: "40" }, "status", "--json");
    const jsonWide = runCliWithEnvironment(home, { COLUMNS: "160" }, "status", "--json");

    expect(narrow.status, narrow.stderr).toBe(0);
    expect(redirectedNarrow.status, redirectedNarrow.stderr).toBe(0);
    expect(redirectedWide.status, redirectedWide.stderr).toBe(0);
    expect(json.status, json.stderr).toBe(0);
    expect(jsonNarrow.status, jsonNarrow.stderr).toBe(0);
    expect(jsonWide.status, jsonWide.stderr).toBe(0);
    expect(narrow.stdout).not.toBe(redirectedNarrow.stdout);
    expect(redirectedNarrow.stdout).toBe(redirectedWide.stdout);
    expect(narrow.stdout).toContain("\n  Consequence:");
    expect(narrow.stdout).not.toMatch(/\u001b\[/);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(jsonNarrow.stdout).toBe(jsonWide.stdout);

    for (const line of narrow.stdout.split("\n")) {
      const pathLine = line.includes(projectPath);
      if (!pathLine) expect(line.length, `line exceeds TTY width: ${line}`).toBeLessThanOrEqual(40);
    }

    const applied = runCliInPty(home, 40, "apply");
    const clean = runCliInPty(home, 40, "status");
    expect(applied.status, applied.stderr).toBe(0);
    expect(clean.status, clean.stderr).toBe(0);
    expect(applied.stdout).toContain("Apply complete");
    expect(clean.stdout).toContain("All Projects are current");

    const blockedHome = isolatedHome();
    const blockedProject = project();
    initialize(blockedHome);
    const blockedBind = runCli(
      blockedHome,
      "bind",
      "example",
      blockedProject,
      "--host",
      "codex",
    );
    expect(blockedBind.status, blockedBind.stderr).toBe(0);
    mkdirSync(join(blockedProject, ".agent-profile-kit", "codex"), { recursive: true });
    writeFileSync(
      join(blockedProject, ".agent-profile-kit", "codex", "context.md"),
      "user-owned\n",
    );
    const blocked = runCliInPty(blockedHome, 40, "preview");
    expect(blocked.status).toBe(2);
    expect(blocked.stdout).toContain("Cannot apply");
    expect(blocked.stdout).toContain("Blocker:");
    expect(blocked.stdout).toContain("\nNext:\n- ");
  });

  test("colored wrapped output does not style continuation lines as new prose", () => {
    const home = isolatedHome();
    const colored = runCliInPtyWithEnvironment(
      home,
      40,
      COLOR_TERMINAL_ENVIRONMENT,
      "guide",
      "profile",
    );

    expect(colored.status, colored.stderr).toBe(0);
    expect(colored.stdout).toMatch(/\u001b\[/);
    expect(colored.stdout.split("\n").filter((line) => line.includes("\u001b[2m"))).toHaveLength(1);
    expect(colored.stdout).toContain("\u001b[2mA Profile");
  });
});

describe("apkit root help", () => {
  test("--version reports the packaged engine version", () => {
    const home = isolatedHome();
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      readonly version: string;
    };
    const result = runCli(home, "--version");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`${manifest.version}\n`);
  });

  test("bare invocation, --help, -h, and help print identical root help successfully", () => {
    const home = isolatedHome();
    const bare = runCli(home);
    const help = runCli(home, "--help");
    const shortHelp = runCli(home, "-h");
    const helpCommand = runCli(home, "help");
    const nestedLongHelp = runCli(home, HELP_COMMAND, "--help");
    const nestedShortHelp = runCli(home, HELP_COMMAND, "-h");
    const nestedVersion = runCli(home, HELP_COMMAND, "--version");

    for (const result of [bare, help, shortHelp, helpCommand, nestedLongHelp, nestedShortHelp, nestedVersion]) {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
    }
    expect(bare.stdout).toBe(help.stdout);
    expect(shortHelp.stdout).toBe(help.stdout);
    expect(helpCommand.stdout).toBe(help.stdout);
    expect(nestedLongHelp.stdout).toBe(help.stdout);
    expect(nestedShortHelp.stdout).toBe(help.stdout);
    expect(nestedVersion.stdout).toBe(help.stdout);
    expect(bare.stdout.length).toBeGreaterThan(0);
  });

  test("root help lists all supported commands with usable syntax and concise purposes", () => {
    const home = isolatedHome();
    const result = runCli(home, "--help");
    expect(result.status, result.stderr).toBe(0);

    const commandsSection = result.stdout.match(/Commands:\n([\s\S]*?)\n\nProject quick start:/)?.[1];
    expect(commandsSection).toBeDefined();
    const menuLines = commandsSection!.split("\n");
    const commandLines = menuLines.filter((line) =>
      COMMANDS.some((command) => line.trimStart().startsWith(command.syntax)),
    );
    expect(commandLines).toHaveLength(COMMANDS.length);
    for (const command of COMMANDS) {
      const line = commandLines.find((candidate) => new RegExp(`^\\s*${command.name}\\b`).test(candidate));
      expect(line).toBeDefined();
      expect(line).toContain(command.syntax);
      const description = menuLines
        .slice(menuLines.indexOf(line!) + 1)
        .find((candidate) => candidate.startsWith("    "));
      expect(description?.trim().length).toBeGreaterThan(0);
    }
  });

  test("root help groups commands and keeps its two-line menu within the deterministic width", () => {
    const home = isolatedHome();
    const result = runCli(home, "--help");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    let previousIndex = -1;
    for (const [group, label] of COMMAND_GROUPS) {
      const groupIndex = result.stdout.indexOf(`  ${label}`);
      expect(groupIndex).toBeGreaterThan(previousIndex);
      previousIndex = groupIndex;
      for (const command of COMMANDS.filter((candidate) => candidate.group === group)) {
        const syntaxIndex = result.stdout.indexOf(`  ${command.syntax}\n`, previousIndex);
        expect(syntaxIndex).toBeGreaterThan(previousIndex);
        expect(result.stdout.slice(syntaxIndex).split("\n")[1]).toMatch(/^    \S/);
        previousIndex = syntaxIndex;
      }
    }

    for (const line of result.stdout.split("\n")) {
      expect(line.length, `line exceeds deterministic width: ${line}`).toBeLessThanOrEqual(80);
    }
  });

  test("redirected root help ignores ambient COLUMNS and remains deterministic", () => {
    const home = isolatedHome();
    const narrowEnvironment = runCliWithEnvironment(home, { COLUMNS: "40" }, "--help");
    const wideEnvironment = runCliWithEnvironment(home, { COLUMNS: "160" }, "--help");

    expect(narrowEnvironment.status, narrowEnvironment.stderr).toBe(0);
    expect(wideEnvironment.status, wideEnvironment.stderr).toBe(0);
    expect(narrowEnvironment.stdout).toBe(wideEnvironment.stdout);
  });

  test("root help shows the minimal Project flow and points to guide for deeper authoring", () => {
    const home = isolatedHome();
    const result = runCli(home, "--help");
    expect(result.status, result.stderr).toBe(0);

    const initIndex = result.stdout.indexOf("apkit init");
    const bindIndex = result.stdout.indexOf("apkit bind", initIndex + 1);
    const previewIndex = result.stdout.indexOf("apkit preview", bindIndex + 1);
    const applyIndex = result.stdout.indexOf("apkit apply", previewIndex + 1);
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(bindIndex).toBeGreaterThan(initIndex);
    expect(previewIndex).toBeGreaterThan(bindIndex);
    expect(applyIndex).toBeGreaterThan(previewIndex);

    expect(result.stdout).toMatch(/apkit guide/);
    expect(result.stdout).toContain("apkit guide --full");
    expect(result.stdout.toLowerCase()).toMatch(/workspace authoring/);
  });

  test("every command explains its purpose, syntax, examples, writes, and next action", () => {
    const home = isolatedHome();
    const root = runCli(home, "--help");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(root.stdout).not.toMatch(term);

    for (const command of COMMANDS) {
      for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(command.summary).not.toMatch(term);
      const result = runCli(home, command.name, "--help");
      expect(result.status, `${command.name}: ${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`Usage: apkit ${command.syntax}`);
      expect(result.stdout).toMatch(/^Purpose: .+/m);
      expect(result.stdout).toMatch(/^Examples:\n  apkit /m);
      expect(result.stdout).toMatch(/^Writes: .+/m);
      expect(result.stdout).toMatch(/^Next: .+/m);
      for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(result.stdout).not.toMatch(term);

      const rootLine = root.stdout
        .split("\n")
        .find((line) => new RegExp(`^\\s*${command.name}\\b`).test(line));
      expect(rootLine).toBeDefined();
      const purpose = result.stdout.match(/^Purpose: (.+)$/m)?.[1];
      expect(purpose).toBeDefined();
      const rootLines = root.stdout.split("\n");
      const rootLineIndex = rootLines.indexOf(rootLine!);
      const descriptionLines: string[] = [];
      for (const line of rootLines.slice(rootLineIndex + 1)) {
        if (!line.startsWith("    ")) break;
        descriptionLines.push(line.trim());
      }
      const rootDescription = descriptionLines.join(" ");
      expect(rootDescription).toBe(purpose!);
    }
  });

  test("uninstall help describes removing owned output while preserving Projects", () => {
    const home = isolatedHome();
    const root = runCli(home, "--help");
    const focused = runCli(home, "uninstall", "--help");

    expect(root.status, root.stderr).toBe(0);
    expect(focused.status, focused.stderr).toBe(0);
    for (const view of [root.stdout, focused.stdout]) {
      const normalized = view.replace(/\s+/g, " ");
      expect(normalized).toContain("Remove proven Agent Profile Kit-owned output");
      expect(normalized).not.toContain("Remove all Projects");
      expect(normalized).not.toMatch(/Remove(?:d)? (?:one|all|\d+)? ?Projects?\b/i);
    }
  });

  test("focused help accepts help, -h, and --help aliases with identical output", () => {
    const home = isolatedHome();
    expect(COMMAND_HELP_ALIASES).toEqual(["-h", "--help"]);

    for (const command of COMMANDS) {
      const helpCommand = runCli(home, HELP_COMMAND, command.name);

      expect(helpCommand.status, `help ${command.name}: ${helpCommand.stderr}`).toBe(0);
      expect(helpCommand.stderr).toBe("");
      for (const alias of COMMAND_HELP_ALIASES) {
        const aliasHelp = runCli(home, command.name, alias);
        const prefixedAliasHelp = runCli(home, HELP_COMMAND, command.name, alias);
        expect(aliasHelp.status, `${command.name} ${alias}: ${aliasHelp.stderr}`).toBe(0);
        expect(
          prefixedAliasHelp.status,
          `${HELP_COMMAND} ${command.name} ${alias}: ${prefixedAliasHelp.stderr}`,
        ).toBe(0);
        expect(aliasHelp.stderr).toBe("");
        expect(prefixedAliasHelp.stderr).toBe("");
        expect(aliasHelp.stdout).toBe(helpCommand.stdout);
        expect(prefixedAliasHelp.stdout).toBe(helpCommand.stdout);
      }
    }
  });

  test("non-help trailing arguments do not self-suggest a known command", () => {
    const home = isolatedHome();
    const result = runCli(home, HELP_COMMAND, "bind", "unexpected");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("apkit: unknown command 'help'");
    expect(result.stderr).not.toContain("Did you mean: apkit bind?");
  });

  test("focused binding help names Hosts from each command's supported capability set", () => {
    const home = isolatedHome();
    const bindHelp = runCli(home, "help", "bind");
    const temporaryHelp = runCli(home, "install-temp", "-h");

    expect(bindHelp.status, bindHelp.stderr).toBe(0);
    expect(temporaryHelp.status, temporaryHelp.stderr).toBe(0);
    expect(bindHelp.stdout).toContain(`Supported Hosts: ${SUPPORTED_HOSTS.join(", ")}`);
    expect(temporaryHelp.stdout).toContain(
      `Supported Hosts: ${TEMPORARY_INSTALLATION_HOSTS.join(", ")}`,
    );
  });

  test("root quick start points Profile and Host placeholders to discovery routes", () => {
    const home = isolatedHome();
    const result = runCli(home, "--help");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("apkit guide profile");
    expect(result.stdout).toContain("apkit bind --help");
    expect(result.stdout).toContain("apkit bind <profile> --host <host>");
  });

  test("interactive root help adapts to narrow terminals and caps wide prose", () => {
    const home = isolatedHome();
    const clamped = runCliInPty(home, 20, "--help");
    const narrow = runCliInPty(home, 40, "--help");
    const fallback = runCliInPtyWithColumnsFallback(home, 40, "--help");
    const wide = runCliInPty(home, 160, "--help");

    expect(clamped.status, clamped.stderr).toBe(0);
    expect(narrow.status, narrow.stderr).toBe(0);
    expect(fallback.status, fallback.stderr).toBe(0);
    expect(wide.status, wide.stderr).toBe(0);
    expect(clamped.stdout).toBe(narrow.stdout);
    expect(fallback.stdout).toBe(narrow.stdout);
    expect(wide.stdout).not.toBe(narrow.stdout);
    const isUnbreakableSyntax = (line: string) =>
      COMMANDS.some((command) => line.trimStart().startsWith(command.syntax));
    for (const line of clamped.stdout.split("\n")) {
      if (!isUnbreakableSyntax(line)) expect(line.length).toBeLessThanOrEqual(40);
    }
    for (const line of wide.stdout.split("\n")) {
      if (!isUnbreakableSyntax(line)) expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  test("interactive root help adds the compact identity and semantic color while pipes stay plain", () => {
    const home = isolatedHome();
    const piped = runCli(home, "--help");
    const bare = runCliInPtyWithEnvironment(home, 40, COLOR_TERMINAL_ENVIRONMENT);
    const interactive = runCliInPtyWithEnvironment(
      home,
      40,
      COLOR_TERMINAL_ENVIRONMENT,
      "--help",
    );

    expect(piped.status, piped.stderr).toBe(0);
    expect(bare.status, bare.stderr).toBe(0);
    expect(interactive.status, interactive.stderr).toBe(0);
    expect(bare.stdout).toContain(" /__\\ reusable agent material");
    expect(interactive.stdout).toContain("Agent Profile Kit");
    expect(interactive.stdout).toContain(" /__\\ reusable agent material");
    expect(interactive.stdout).toMatch(/\u001b\[/);
    expect(piped.stdout).not.toContain(" /__\\ reusable agent material");
    expect(piped.stdout).not.toMatch(/\u001b\[/);
  });

  test("interactive routine output is styled while NO_COLOR, pipes, errors, and JSON stay plain", () => {
    const home = isolatedHome();
    const interactive = runCliInPtyWithEnvironment(
      home,
      80,
      COLOR_TERMINAL_ENVIRONMENT,
      "list",
      "hosts",
    );
    const noColor = runCliInPtyWithEnvironment(
      home,
      80,
      { NO_COLOR: "1", TERM: "xterm-256color" },
      "list",
      "hosts",
    );
    const piped = runCli(home, "list", "hosts");
    const json = runCli(home, "list", "hosts", "--json");
    const interactiveJson = runCliInPtyWithEnvironment(
      home,
      80,
      COLOR_TERMINAL_ENVIRONMENT,
      "list",
      "hosts",
      "--json",
    );
    const agentGuidePty = runCliInPtyWithEnvironment(
      home,
      80,
      COLOR_TERMINAL_ENVIRONMENT,
      "guide",
      "--agent",
    );
    const interactiveError = runCliInPtyWithEnvironment(
      home,
      80,
      COLOR_TERMINAL_ENVIRONMENT,
      "unknown-command",
    );
    const pipedError = runCli(home, "unknown-command");
    const interactiveErrorOutput = `${interactiveError.stdout}${interactiveError.stderr}`;

    expect(interactive.status, interactive.stderr).toBe(0);
    expect(interactive.stdout).toMatch(/\u001b\[/);
    expect(interactive.stdout).not.toContain(" /__\\ reusable agent material");
    expect(noColor.stdout).not.toMatch(/\u001b\[/);
    expect(piped.stdout).not.toMatch(/\u001b\[/);
    expect(json.status, json.stderr).toBe(0);
    expect(json.stdout).not.toMatch(/\u001b\[/);
    expect(() => JSON.parse(json.stdout)).not.toThrow();
    expect(interactiveJson.status, interactiveJson.stderr).toBe(0);
    expect(interactiveJson.stdout).not.toMatch(/\u001b\[/);
    expect(() => JSON.parse(interactiveJson.stdout)).not.toThrow();
    expect(agentGuidePty.status, agentGuidePty.stderr).toBe(0);
    expect(agentGuidePty.stdout).not.toMatch(/\u001b\[/);
    expect(interactiveError.status).toBe(1);
    expect(interactiveErrorOutput).toMatch(/\u001b\[/);
    expect(interactiveErrorOutput).not.toContain(" /__\\ reusable agent material");
    expect(pipedError.stderr).not.toMatch(/\u001b\[/);
  });

  test("representative human and machine surfaces stay ANSI-free through pipes", () => {
    const invocations: readonly (readonly string[])[] = [
      [],
      ["--version"],
      ["--help"],
      ["help", "status"],
      ["guide"],
      ["guide", "profile"],
      ["guide", "--full"],
      ["guide", "--agent"],
      ["info"],
      ["info", "--json"],
      ["list"],
      ["list", "projects"],
      ["list", "projects", "--json"],
      ["list", "profiles"],
      ["list", "profiles", "--json"],
      ["list", "hosts"],
      ["list", "hosts", "--json"],
      ["list", "temporary"],
      ["list", "temporary", "--json"],
      ["validate"],
      ["preview"],
      ["preview", "--json"],
      ["apply"],
      ["apply", "--json"],
      ["status"],
      ["status", "--json"],
      ["uninstall"],
      ["install-temp"],
      ["remove-temp"],
      ["unknown-command"],
      ...COMMANDS.map((command) => [command.name, "--help"]),
    ];

    for (const arguments_ of invocations) {
      const result = runCli(isolatedHome(), ...arguments_);
      expect(
        `${result.stdout}${result.stderr}`,
        `unexpected ANSI for: apkit ${arguments_.join(" ")}`,
      ).not.toMatch(/\u001b\[/);
    }
  });

  test("focused guides wrap prose at terminal width without splitting examples", () => {
    const home = isolatedHome();

    for (const topic of ["profile", "context", "skill"] as const) {
      const narrow = runCliInPty(home, 40, "guide", topic);
      const wide = runCliInPty(home, 100, "guide", topic);
      const next = TOPIC_GUIDES[topic].next;

      expect(narrow.status, narrow.stderr).toBe(0);
      expect(wide.status, wide.stderr).toBe(0);
      expect(narrow.stdout).not.toBe(wide.stdout);
      expect(narrow.stdout).toContain(AUTHORING_EXAMPLES[topic].contents);
      expect(narrow.stdout).toContain(next);

      let inCodeFence = false;
      for (const line of narrow.stdout.split("\n")) {
        if (/^\s*```/.test(line)) {
          inCodeFence = !inCodeFence;
          continue;
        }
        if (inCodeFence || /^Create `[^`]+`:$/.test(line) || line === next) continue;
        expect(line.length).toBeLessThanOrEqual(40);
      }
    }
  });

  test("the human guide index stays concise and width-aware", () => {
    const home = isolatedHome();
    const narrow = runCliInPty(home, 40, "guide");
    const wide = runCliInPty(home, 100, "guide");

    expect(narrow.status, narrow.stderr).toBe(0);
    expect(wide.status, wide.stderr).toBe(0);
    expect(narrow.stdout).not.toBe(wide.stdout);
    expect(narrow.stdout).not.toContain("SessionStart");
    expect(narrow.stdout.split("\n").length).toBeLessThan(40);
    for (const line of narrow.stdout.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
  });

  test("guide human views use newcomer vocabulary", () => {
    const home = isolatedHome();
    const views = [
      runCli(home, "guide"),
      runCli(home, "guide", "profile"),
      runCli(home, "guide", "context"),
      runCli(home, "guide", "skill"),
    ];

    for (const view of views) {
      expect(view.status, view.stderr).toBe(0);
      for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(view.stdout).not.toMatch(term);
    }
  });

  test("guide help advertises every focused authoring topic", () => {
    const home = isolatedHome();
    const result = runCli(home, "guide", "--help");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Usage: apkit guide [profile|context|skill|--full|--agent]");
    for (const topic of ["profile", "context", "skill"]) {
      expect(result.stdout).toContain(`apkit guide ${topic}`);
    }
    expect(result.stdout).toContain("apkit guide --full");
    expect(result.stdout).toContain("apkit guide --agent");

    const initHelp = runCli(home, "init", "--help");
    expect(initHelp.status, initHelp.stderr).toBe(0);
    expect(initHelp.stdout).toContain("Next: Run apkit guide profile.");
  });

  test("a close unknown command gets one suggestion and a distant one gets concise help", () => {
    const home = isolatedHome();
    const close = runCli(home, "stats");
    const distant = runCli(home, "frobnicate");
    const tied = runCli(home, "inf");
    const unknownHelp = runCli(home, "help", "stats");
    const unknownShortHelp = runCli(home, "stats", "-h");
    const unsafe = runCli(home, "\u001b[2J");

    expect(close.status).toBe(1);
    expect(close.stdout).toBe("");
    expect(close.stderr).toContain("apkit: unknown command 'stats'");
    expect(close.stderr).toContain("Did you mean: apkit status?");
    expect(close.stderr.match(/Did you mean:/g)).toHaveLength(1);
    expect(close.stderr).toContain("Run apkit --help for available commands.");
    expect(close.stderr).not.toContain("Commands:");

    expect(distant.status).toBe(1);
    expect(distant.stdout).toBe("");
    expect(distant.stderr).toContain("apkit: unknown command 'frobnicate'");
    expect(distant.stderr).not.toContain("Did you mean:");
    expect(distant.stderr).toContain("Run apkit --help for available commands.");
    expect(distant.stderr).not.toContain("Commands:");

    expect(tied.status).toBe(1);
    expect(tied.stderr).toContain("apkit: unknown command 'inf'");
    expect(tied.stderr).toContain("Did you mean: apkit info?");
    expect(tied.stderr.match(/Did you mean:/g)).toHaveLength(1);
    expect(tied.stderr).not.toContain("Commands:");

    for (const result of [unknownHelp, unknownShortHelp, unsafe]) {
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Run apkit --help for available commands.");
      expect(result.stderr).not.toContain("Commands:");
      for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(result.stderr).not.toMatch(term);
    }
    expect(unknownHelp.stderr).toContain("apkit: unknown command 'stats'");
    expect(unknownHelp.stderr).toContain("Did you mean: apkit status?");
    expect(unknownShortHelp.stderr).toContain("apkit: unknown command 'stats'");
    expect(unknownShortHelp.stderr).toContain("Did you mean: apkit status?");
    expect(unsafe.stderr).not.toContain("\u001b");
  });

  test("leading-dash values are never consumed as positional arguments", () => {
    const home = isolatedHome();
    const cases = [
      { arguments: ["init", "--workspace"], message: "init does not accept flag '--workspace' as a Workspace path" },
      { arguments: ["bind", "--profile"], message: "bind does not accept flag '--profile' as a Profile" },
      { arguments: ["unbind", "--project"], message: "unbind does not accept flag '--project' as a project path" },
    ] as const;

    for (const example of cases) {
      const result = runCli(home, ...example.arguments);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(example.message);
      expect(result.stderr).toContain(`Usage: apkit ${example.arguments[0]}`);
    }

    const hostValue = runCli(home, "bind", "example", "--host", "--codex");
    expect(hostValue.status).toBe(1);
    expect(hostValue.stderr).toContain("bind --host requires an Agent Host name");
  });

  test("representative invalid arguments exit nonzero, explain the error, and show the relevant command usage", () => {
    const home = isolatedHome();

    const missingProfile = runCli(home, "bind");
    expect(missingProfile.status).toBe(1);
    expect(missingProfile.stderr).toContain("bind requires a Profile Artifact ID");
    expect(missingProfile.stderr).toContain("Usage: apkit bind <profile>");

    const missingHost = runCli(home, "bind", "coding");
    expect(missingHost.status).toBe(1);
    expect(missingHost.stderr).toContain("bind requires at least one --host flag");
    expect(missingHost.stderr).toContain("supported Hosts: claude, codex");
    expect(missingHost.stderr).toContain("Usage: apkit bind <profile>");

    const tooManyInitPaths = runCli(home, "init", "one", "two");
    expect(tooManyInitPaths.status).toBe(1);
    expect(tooManyInitPaths.stderr).toContain("init accepts at most one Workspace path");
    expect(tooManyInitPaths.stderr).toContain("Usage: apkit init [workspace]");
    expect(tooManyInitPaths.stderr).not.toContain("Usage: apkit bind");

    const badLifecycleFlag = runCli(home, "preview", "--yaml");
    expect(badLifecycleFlag.status).toBe(1);
    expect(badLifecycleFlag.stderr).toContain("preview does not accept argument '--yaml'");
    expect(badLifecycleFlag.stderr).toContain("Usage: apkit preview [--verbose] [--json]");

    const badAfterValidLifecycleFlag = runCli(home, "preview", "--verbose", "--yaml");
    expect(badAfterValidLifecycleFlag.status).toBe(1);
    expect(badAfterValidLifecycleFlag.stderr).toContain("preview does not accept argument '--yaml'");
    expect(badAfterValidLifecycleFlag.stderr).toContain("Usage: apkit preview [--verbose] [--json]");

    const badGuideFlag = runCli(home, "guide", "--json");
    expect(badGuideFlag.status).toBe(1);
    expect(badGuideFlag.stderr).toContain("guide does not accept argument '--json'");
    expect(badGuideFlag.stderr).toContain("Usage: apkit guide [profile|context|skill|--full|--agent]");

    const agentAfterTopic = runCli(home, "guide", "profile", "--agent");
    expect(agentAfterTopic.status).toBe(1);
    expect(agentAfterTopic.stderr).toContain("guide does not accept argument '--agent' after topic 'profile'");

    const badValidateFlag = runCli(home, "validate", "--json");
    expect(badValidateFlag.status).toBe(1);
    expect(badValidateFlag.stderr).toContain("validate does not accept argument '--json'");
    expect(badValidateFlag.stderr).toContain("Usage: apkit validate");

    const badUninstallFlag = runCli(home, "uninstall", "--json");
    expect(badUninstallFlag.status).toBe(1);
    expect(badUninstallFlag.stderr).toContain("uninstall does not accept argument '--json'");
    expect(badUninstallFlag.stderr).toContain("Usage: apkit uninstall");

    const tooManyUnbindPaths = runCli(home, "unbind", "one", "two");
    expect(tooManyUnbindPaths.status).toBe(1);
    expect(tooManyUnbindPaths.stderr).toContain("unbind accepts at most one project path");
    expect(tooManyUnbindPaths.stderr).toContain("Usage: apkit unbind [project]");
  });
});

describe("apkit list", () => {
  test("without a topic, prints a self-describing inventory index without configuration", () => {
    const home = isolatedHome();

    const result = runCliWithPath(home, process.env.PATH ?? "", "list");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Inventory topics:");
    for (const topic of INVENTORY_TOPICS) {
      expect(result.stdout).toContain(`apkit list ${topic.name}`);
      expect(result.stdout).toContain(topic.description);
      expect(result.stdout).toContain(`apkit list ${topic.name} --json`);
    }
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("temporary is empty without Installation State and does not initialize application state", () => {
    const home = isolatedHome();

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "temporary");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No Temporary Profile Installations are active.");
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("hosts renders every supported Host in canonical order with temporary support", () => {
    const home = isolatedHome();

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "hosts");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`Hosts (${SUPPORTED_HOSTS.length}):`);
    for (const host of SUPPORTED_HOSTS) expect(result.stdout).toContain(`Host: ${host}`);
    expect(result.stdout).toContain("Temporary Profile Installation: supported");
    expect(result.stdout).toContain("Temporary Profile Installation: not supported");
    expect(result.stdout.indexOf("Host: claude")).toBeLessThan(result.stdout.indexOf("Host: codex"));
    expect(result.stdout.indexOf("Host: codex")).toBeLessThan(result.stdout.indexOf("Host: grok"));
    expect(result.stdout.indexOf("Host: grok")).toBeLessThan(result.stdout.indexOf("Host: pi"));
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("hosts JSON uses canonical capability records without probing Host executables", () => {
    const home = isolatedHome();
    const failingHostBin = join(home, "failing-host-bin");
    mkdirSync(failingHostBin, { recursive: true });
    for (const host of SUPPORTED_HOSTS) {
      const executable = join(failingHostBin, host);
      writeFileSync(executable, "#!/bin/sh\necho 'unexpected Host probe' >&2\nexit 97\n");
      chmodSync(executable, 0o755);
    }

    const result = runCliWithPath(home, failingHostBin, "list", "hosts", "--json");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "list",
      topic: "hosts",
      outcome: "success",
      engineVersion: ENGINE_VERSION,
      hosts: [
        { host: "claude", supportsTemporaryProfileInstallation: true },
        { host: "codex", supportsTemporaryProfileInstallation: true },
        { host: "grok", supportsTemporaryProfileInstallation: false },
        { host: "pi", supportsTemporaryProfileInstallation: false },
      ],
    });
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("temporary inventory does not migrate legacy ordinary installations", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    const ordinaryProject = project("agent-profile-kit-temporary-legacy-");
    bind(home, ordinaryProject);
    expect(runCli(home, "apply").status).toBe(0);

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<Record<string, unknown>>;
    };
    const legacyProject = project("agent-profile-kit-temporary-legacy-broken-");
    writeFileSync(join(legacyProject, ".git"), "not a Git directory\n");
    state.installations[0]!.project = realpathSync(legacyProject);
    writeFileSync(
      statePath(home),
      stringify({ schema_version: 2, installations: state.installations }),
    );
    const stateBefore = readFileSync(statePath(home), "utf8");

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "temporary");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No Temporary Profile Installations are active.");
    expect(readFileSync(statePath(home), "utf8")).toBe(stateBefore);
  });

  test("temporary renders an active identity with a short Project path", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    const temporaryProject = join(home, "projects", "temporary-project");
    mkdirSync(temporaryProject, { recursive: true });

    const install = runCli(
      home,
      "install-temp",
      "coding",
      temporaryProject,
      "--host",
      "codex",
      "--json",
    );
    expect(install.status, install.stderr).toBe(0);
    const receipt = JSON.parse(install.stdout) as { readonly temporaryInstallationId: string };

    const result = runCli(home, "list", "temporary");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Temporary Profile Installations (1):");
    expect(result.stdout).toContain(`Temporary installation: ${receipt.temporaryInstallationId}`);
    expect(result.stdout).toContain("Project: ~/projects/temporary-project");
    expect(result.stdout).toContain("Profile: coding");
    expect(result.stdout).toContain("Host: codex");
  });

  test("temporary JSON preserves canonical identity evidence without inventory writes", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    const temporaryProject = join(home, "projects", "temporary-json-project");
    mkdirSync(temporaryProject, { recursive: true });

    const install = runCli(
      home,
      "install-temp",
      "coding",
      temporaryProject,
      "--host",
      "codex",
      "--json",
    );
    expect(install.status, install.stderr).toBe(0);
    const receipt = JSON.parse(install.stdout) as { readonly temporaryInstallationId: string };
    const configurationBefore = readFileSync(configPath(home), "utf8");
    const stateBefore = readFileSync(statePath(home), "utf8");
    const projectEntriesBefore = readdirSync(temporaryProject).sort();

    const result = runCli(home, "list", "temporary", "--json");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "list",
      topic: "temporary",
      outcome: "success",
      engineVersion: ENGINE_VERSION,
      temporaryInstallations: [{
        host: "codex",
        profileId: "coding",
        project: realpathSync(temporaryProject),
        temporaryInstallationId: receipt.temporaryInstallationId,
      }],
    });
    expect(readFileSync(configPath(home), "utf8")).toBe(configurationBefore);
    expect(readFileSync(statePath(home), "utf8")).toBe(stateBefore);
    expect(readdirSync(temporaryProject).sort()).toEqual(projectEntriesBefore);
  });

  test("temporary inventory excludes removed identities and ordinary Project Bindings", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    const ordinaryProject = join(home, "projects", "ordinary-project");
    const temporaryProject = join(home, "projects", "temporary-project");
    mkdirSync(ordinaryProject, { recursive: true });
    mkdirSync(temporaryProject, { recursive: true });

    const bindResult = runCli(home, "bind", "coding", ordinaryProject, "--host", "codex");
    expect(bindResult.status, bindResult.stderr).toBe(0);
    const applyResult = runCli(home, "apply");
    expect(applyResult.status, applyResult.stderr).toBe(0);
    const install = runCli(
      home,
      "install-temp",
      "coding",
      temporaryProject,
      "--host",
      "codex",
      "--json",
    );
    expect(install.status, install.stderr).toBe(0);
    const receipt = JSON.parse(install.stdout) as { readonly temporaryInstallationId: string };

    const active = runCli(home, "list", "temporary");
    expect(active.status, active.stderr).toBe(0);
    expect(active.stdout).toContain("temporary-project");
    expect(active.stdout).not.toContain("ordinary-project");

    const remove = runCli(home, "remove-temp", receipt.temporaryInstallationId, "--json");
    expect(remove.status, remove.stderr).toBe(0);
    const afterRemoval = runCli(home, "list", "temporary");

    expect(afterRemoval.status, afterRemoval.stderr).toBe(0);
    expect(afterRemoval.stdout).toContain("No Temporary Profile Installations are active.");
    expect(afterRemoval.stdout).not.toContain(receipt.temporaryInstallationId);
    expect(afterRemoval.stdout).not.toContain("ordinary-project");

    const projects = runCli(home, "list", "projects");
    expect(projects.status, projects.stderr).toBe(0);
    expect(projects.stdout).toContain("ordinary-project");
  });

  test("temporary JSON orders active identities by canonical Project", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    const firstProject = join(home, "projects", "alpha-temporary");
    const secondProject = join(home, "projects", "zeta-temporary");
    mkdirSync(firstProject, { recursive: true });
    mkdirSync(secondProject, { recursive: true });

    for (const projectPath of [secondProject, firstProject]) {
      const install = runCli(
        home,
        "install-temp",
        "coding",
        projectPath,
        "--host",
        "codex",
        "--json",
      );
      expect(install.status, install.stderr).toBe(0);
    }

    const result = runCli(home, "list", "temporary", "--json");

    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      readonly temporaryInstallations: readonly { readonly project: string }[];
    };
    expect(payload.temporaryInstallations.map((installation) => installation.project)).toEqual([
      realpathSync(firstProject),
      realpathSync(secondProject),
    ]);
  });

  test("temporary JSON reports malformed Installation State without writing it", () => {
    const home = isolatedHome();
    mkdirSync(stateDirectory(home), { recursive: true });
    const malformed = "not Installation State\n";
    writeFileSync(statePath(home), malformed);

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "temporary", "--json");

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "list",
      topic: "temporary",
      outcome: "error",
      engineVersion: ENGINE_VERSION,
      temporaryInstallations: [],
      error: expect.any(String),
    });
    expect(readFileSync(statePath(home), "utf8")).toBe(malformed);
  });

  test("profiles renders every valid Profile with selected artifact counts in ID order", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "zeta");
    const workspace = workspacePath(home);
    mkdirSync(join(workspace, "skills", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    writeFileSync(
      join(workspace, "profiles", "alpha.yaml"),
      "id: alpha\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(workspace, "profiles", "beta.yaml"),
      "id: beta\ncontext: []\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "profiles");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Profiles (3):");
    expect(result.stdout).toContain("Profile: alpha");
    expect(result.stdout).toContain("Context Modules: 1");
    expect(result.stdout).toContain("Skills: 1");
    expect(result.stdout).toContain("Profile: beta");
    expect(result.stdout).toContain("Profile: zeta");
    expect(result.stdout.indexOf("Profile: alpha")).toBeLessThan(
      result.stdout.indexOf("Profile: beta"),
    );
    expect(result.stdout.indexOf("Profile: beta")).toBeLessThan(
      result.stdout.indexOf("Profile: zeta"),
    );
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("profiles renders an actionable empty Workspace message", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "profiles");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("No Profiles are available.");
    expect(result.stdout).toContain(
      "Next: Add a Profile to the selected Workspace, then run apkit list profiles.",
    );
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("profiles JSON carries the same records without inspecting Projects, state, or Hosts", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    const workspace = workspacePath(home);
    mkdirSync(join(workspace, "skills", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    writeFileSync(
      join(workspace, "profiles", "combined.yaml"),
      "id: combined\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        "  - project: ~/inaccessible-project\n" +
        "    profile: coding\n" +
        "    hosts: [codex]\n",
    );
    mkdirSync(stateDirectory(home), { recursive: true });
    writeFileSync(statePath(home), "not Installation State\n");
    const failingHostBin = join(home, "failing-host-bin");
    mkdirSync(failingHostBin, { recursive: true });
    writeFileSync(
      join(failingHostBin, "codex"),
      "#!/bin/sh\necho 'unexpected Host probe' >&2\nexit 97\n",
    );
    chmodSync(join(failingHostBin, "codex"), 0o755);
    const configuration = readFileSync(configPath(home), "utf8");
    const state = readFileSync(statePath(home), "utf8");

    const result = runCliWithPath(home, failingHostBin, "list", "profiles", "--json");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "list",
      topic: "profiles",
      outcome: "success",
      engineVersion: ENGINE_VERSION,
      profiles: [
        { id: "coding", contextModules: 1, skills: 0 },
        { id: "combined", contextModules: 1, skills: 1 },
      ],
    });
    expect(readFileSync(configPath(home), "utf8")).toBe(configuration);
    expect(readFileSync(statePath(home), "utf8")).toBe(state);
    expect(existsSync(join(home, "inaccessible-project"))).toBe(false);
  });

  test("profiles reads only Workspace selection and ignores malformed Project Bindings", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        "  - project: 42\n" +
        "    profile: []\n" +
        "    hosts: not-a-list\n",
    );

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "profiles", "--json");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "list",
      topic: "profiles",
      outcome: "success",
      profiles: [{ id: "coding", contextModules: 1, skills: 0 }],
    });
  });

  test("profiles fails through the Workspace ingestion boundary without writes", () => {
    const missingHome = isolatedHome();
    const missingHuman = runCliWithPath(missingHome, process.env.PATH ?? "", "list", "profiles");
    const missingMachine = runCliWithPath(
      missingHome,
      process.env.PATH ?? "",
      "list",
      "profiles",
      "--json",
    );

    expect(missingHuman.status).toBe(1);
    expect(missingHuman.stdout).toBe("");
    expect(missingHuman.stderr).toContain("Local Configuration is missing");
    expect(missingMachine.status).toBe(1);
    expect(missingMachine.stderr).toBe("");
    expect(JSON.parse(missingMachine.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "list",
      topic: "profiles",
      outcome: "error",
      engineVersion: ENGINE_VERSION,
      profiles: [],
    });

    const invalidHome = isolatedHome();
    initialize(invalidHome);
    const invalidWorkspace = join(invalidHome, "invalid-workspace");
    mkdirSync(invalidWorkspace, { recursive: true });
    writeFileSync(
      configPath(invalidHome),
      `schema_version: 2\nworkspace: ${invalidWorkspace}\nbindings: []\n`,
    );
    const configuration = readFileSync(configPath(invalidHome), "utf8");
    const invalid = runCliWithPath(
      invalidHome,
      process.env.PATH ?? "",
      "list",
      "profiles",
      "--json",
    );

    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toBe("");
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "list",
      topic: "profiles",
      outcome: "error",
      error: expect.stringContaining("not a valid Agent Profile Kit Workspace"),
      profiles: [],
    });
    expect(readFileSync(configPath(invalidHome), "utf8")).toBe(configuration);
    expect(existsSync(statePath(invalidHome))).toBe(false);

    const missingWorkspaceHome = isolatedHome();
    initialize(missingWorkspaceHome);
    const missingWorkspace = join(missingWorkspaceHome, "missing-workspace");
    writeFileSync(
      configPath(missingWorkspaceHome),
      `schema_version: 2\nworkspace: ${missingWorkspace}\nbindings: []\n`,
    );
    const missingWorkspaceResult = runCliWithPath(
      missingWorkspaceHome,
      process.env.PATH ?? "",
      "list",
      "profiles",
      "--json",
    );

    expect(missingWorkspaceResult.status).toBe(1);
    expect(missingWorkspaceResult.stderr).toBe("");
    expect(JSON.parse(missingWorkspaceResult.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "list",
      topic: "profiles",
      outcome: "error",
      error: expect.stringContaining("must be an existing directory"),
      profiles: [],
    });
    expect(existsSync(statePath(missingWorkspaceHome))).toBe(false);
  });

  test("projects uses the existing Local Configuration error boundary", () => {
    const home = isolatedHome();

    const human = runCliWithPath(home, process.env.PATH ?? "", "list", "projects");
    const machine = runCliWithPath(home, process.env.PATH ?? "", "list", "projects", "--json");

    expect(human.status).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("Local Configuration is missing");
    expect(human.stderr).toContain("run apkit init");
    expect(machine.status).toBe(1);
    expect(machine.stderr).toBe("");
    expect(JSON.parse(machine.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "list",
      topic: "projects",
      outcome: "error",
      engineVersion: ENGINE_VERSION,
      projects: [],
    });
  });

  test("rejects unknown inventory topics with the canonical available set", () => {
    const home = isolatedHome();

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "unknown-topic");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("list does not support topic 'unknown-topic'");
    expect(result.stderr).toContain(`available topics: ${inventoryTopicNames().join(", ")}`);
    expect(result.stderr).toContain(`Usage: apkit ${inventoryCommandSyntax()}`);
  });

  test("projects renders every normalized Project Binding with ordered Hosts", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    const alpha = join(home, "projects", "alpha");
    const beta = join(home, "projects", "beta");
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        "  - project: ~/projects/beta\n" +
        "    profile: coding\n" +
        "    hosts: [pi, codex]\n" +
        "  - project: ~/projects/alpha\n" +
        "    profile: coding\n" +
        "    hosts: [codex, claude]\n",
    );

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "projects");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Projects (2):");
    expect(result.stdout).toContain("Project: ~/projects/alpha");
    expect(result.stdout).toContain("Project: ~/projects/beta");
    expect(result.stdout).toContain("Profile: coding");
    expect(result.stdout).toContain("Hosts: claude, codex");
    expect(result.stdout).toContain("Hosts: codex, pi");
    expect(result.stdout.indexOf("Project: ~/projects/alpha")).toBeLessThan(
      result.stdout.indexOf("Project: ~/projects/beta"),
    );
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("projects keeps invalid bindings visible and sorts by expanded Project path", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    const projectsDirectory = join(home, "projects");
    const existingProject = join(projectsDirectory, "zeta-existing");
    const fileProject = join(projectsDirectory, "charlie-file");
    const danglingProject = join(projectsDirectory, "delta-dangling");
    const duplicateProject = join(projectsDirectory, "echo-duplicate");
    mkdirSync(existingProject, { recursive: true });
    writeFileSync(fileProject, "not a directory\n");
    symlinkSync(join(projectsDirectory, "missing-target"), danglingProject);
    symlinkSync(existingProject, duplicateProject);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        "  - project: ~/projects/alpha-missing\n" +
        "    profile: coding\n" +
        "    hosts: [codex]\n" +
        "  - project: ~/projects/zeta-existing\n" +
        "    profile: coding\n" +
        "    hosts: [claude]\n" +
        "  - project: ~/projects/charlie-file\n" +
        "    profile: coding\n" +
        "    hosts: [pi]\n" +
        "  - project: ~/projects/delta-dangling\n" +
        "    profile: coding\n" +
        "    hosts: [grok]\n" +
        "  - project: ~/projects/echo-duplicate\n" +
        "    profile: coding\n" +
        "    hosts: [codex]\n",
    );

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "projects");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Projects (5):");
    for (const project of [
      "alpha-missing",
      "charlie-file",
      "delta-dangling",
      "echo-duplicate",
      "zeta-existing",
    ]) {
      expect(result.stdout).toContain(`Project: ~/projects/${project}`);
    }
    expect(result.stdout.match(/Problem:/g)).toHaveLength(4);
    expect(result.stdout).toContain("must be an existing directory");
    expect(result.stdout).toContain("dangling symlink");
    expect(result.stdout).toContain("resolves to duplicate canonical root");
    expect(result.stdout.indexOf("Project: ~/projects/alpha-missing")).toBeLessThan(
      result.stdout.indexOf("Project: ~/projects/zeta-existing"),
    );

    const machine = runCliWithPath(home, process.env.PATH ?? "", "list", "projects", "--json");

    expect(machine.status, machine.stderr).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "list",
      topic: "projects",
      outcome: "success",
      engineVersion: ENGINE_VERSION,
      projects: [
        {
          canonicalProject: null,
          project: "~/projects/alpha-missing",
          profile: "coding",
          hosts: ["codex"],
          problem: expect.stringContaining("must be an existing directory"),
        },
        {
          canonicalProject: null,
          project: "~/projects/charlie-file",
          profile: "coding",
          hosts: ["pi"],
          problem: expect.stringContaining("must be an existing directory"),
        },
        {
          canonicalProject: null,
          project: "~/projects/delta-dangling",
          profile: "coding",
          hosts: ["grok"],
          problem: expect.stringContaining("dangling symlink"),
        },
        {
          canonicalProject: null,
          project: "~/projects/echo-duplicate",
          profile: "coding",
          hosts: ["codex"],
          problem: expect.stringContaining("resolves to duplicate canonical root"),
        },
        {
          canonicalProject: realpathSync(existingProject),
          project: "~/projects/zeta-existing",
          profile: "coding",
          hosts: ["claude"],
          problem: null,
        },
      ],
    });
  });

  test("projects JSON uses the same records without probing Hosts or Installation State", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    writeFileSync(join(workspacePath(home), "profiles", "coding.yaml"), "not a Profile\n");
    const projectPath = join(home, "projects", "json-project");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "user-file.txt"), "preserve me\n");
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n` +
        "  - project: ~/projects/json-project\n" +
        "    profile: coding\n" +
        "    hosts: [codex]\n",
    );
    mkdirSync(stateDirectory(home), { recursive: true });
    writeFileSync(statePath(home), "this is intentionally not Installation State\n");
    const failingHostBin = join(home, "failing-host-bin");
    mkdirSync(failingHostBin, { recursive: true });
    writeFileSync(
      join(failingHostBin, "codex"),
      "#!/bin/sh\necho 'unexpected Host probe' >&2\nexit 97\n",
    );
    chmodSync(join(failingHostBin, "codex"), 0o755);
    const configuration = readFileSync(configPath(home), "utf8");
    const state = readFileSync(statePath(home), "utf8");
    const projectEntries = readdirSync(projectPath).sort();

    const result = runCliWithPath(home, failingHostBin, "list", "projects", "--json");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "list",
      topic: "projects",
      outcome: "success",
      engineVersion: ENGINE_VERSION,
      projects: [{
        canonicalProject: realpathSync(projectPath),
        project: "~/projects/json-project",
        profile: "coding",
        hosts: ["codex"],
        problem: null,
      }],
    });
    expect(readFileSync(configPath(home), "utf8")).toBe(configuration);
    expect(readFileSync(statePath(home), "utf8")).toBe(state);
    expect(readdirSync(projectPath).sort()).toEqual(projectEntries);
  });

  test("projects keeps a Project visible after lifecycle status is clean", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home);
    const projectPath = join(home, "projects", "current-project");
    mkdirSync(projectPath, { recursive: true });

    const bindResult = runCli(home, "bind", "coding", projectPath, "--host", "codex");
    expect(bindResult.status, bindResult.stderr).toBe(0);
    const applyResult = runCli(home, "apply");
    expect(applyResult.status, applyResult.stderr).toBe(0);
    const statusResult = runCli(home, "status");
    expect(statusResult.status, statusResult.stderr).toBe(0);
    expect(statusResult.stdout).toContain("All Projects are current");

    const result = runCliWithPath(home, process.env.PATH ?? "", "list", "projects");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Project: ~/projects/current-project");
    expect(result.stdout).toContain("Profile: coding");
    expect(result.stdout).toContain("Hosts: codex");
  });

  test("help distinguishes Project inventory from lifecycle diagnostics", () => {
    const home = isolatedHome();

    const listHelp = runCliWithPath(home, process.env.PATH ?? "", "list", "--help");
    const statusHelp = runCliWithPath(home, process.env.PATH ?? "", "status", "--help");

    expect(listHelp.status, listHelp.stderr).toBe(0);
    expect(statusHelp.status, statusHelp.stderr).toBe(0);
    expect(listHelp.stdout).toContain(`Usage: apkit ${inventoryCommandSyntax()}`);
    expect(listHelp.stdout).toContain("read-only inventory");
    expect(listHelp.stdout).toContain("Project lifecycle diagnostics");
    expect(statusHelp.stdout).toContain("Project lifecycle diagnostics");
    expect(statusHelp.stdout).not.toContain("Project inventory");
  });
});

describe("apkit info", () => {
  test("reports the engine and selected locations without reading or writing other material", () => {
    const home = isolatedHome();
    initialize(home);
    const configuration = readFileSync(configPath(home), "utf8");
    const workspaceManifest = readFileSync(join(workspacePath(home), "workspace.yaml"), "utf8");
    const hostConfiguration = readFileSync(join(home, ".codex", "config.toml"), "utf8");

    const result = runCli(home, "info");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Engine version:");
    expect(result.stdout).toContain("Workspace: ~/.agents/agent-profile-kit/workspace");
    expect(result.stdout).toContain("Local Configuration: ~/.agents/agent-profile-kit/config.yaml");
    expect(result.stdout).toContain("Installation State: ~/.agents/agent-profile-kit/state/manifest.yaml");
    expect(result.stdout).not.toContain("example");
    expect(result.stdout).not.toContain("codex");
    expect(readFileSync(configPath(home), "utf8")).toBe(configuration);
    expect(readFileSync(join(workspacePath(home), "workspace.yaml"), "utf8")).toBe(workspaceManifest);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(hostConfiguration);
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("reports missing configuration without creating application state", () => {
    const home = isolatedHome();

    const result = runCli(home, "info");
    const machine = runCli(home, "info", "--json");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Workspace: Not configured");
    expect(result.stdout).toContain("Local Configuration: ~/.agents/agent-profile-kit/config.yaml");
    expect(result.stdout).toContain("Installation State: ~/.agents/agent-profile-kit/state/manifest.yaml");
    expect(machine.status, machine.stderr).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({
      outcome: "success",
      configurationState: "not-configured",
      workspace: null,
    });
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

  test("reports legacy configuration as migration-required instead of unconfigured", () => {
    const home = isolatedHome();
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(configPath(home), "schema_version: 1\nbindings: []\n");

    const human = runCli(home, "info");
    const machine = runCli(home, "info", "--json");

    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("Workspace: Legacy configuration; run apkit init");
    expect(human.stdout).not.toContain("Workspace: Not configured");
    expect(machine.status, machine.stderr).toBe(0);
    expect(JSON.parse(machine.stdout)).toMatchObject({
      schemaVersion: 1,
      command: "info",
      outcome: "success",
      configurationState: "legacy",
      workspace: null,
      localConfiguration: configPath(home),
      installationState: statePath(home),
    });
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("reports locations without validating or exposing Project Binding content", () => {
    const home = isolatedHome();
    initialize(home);
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: relative-secret-project\n    profile: secret-profile\n    hosts: [unsupported-secret-host]\n`,
    );

    const result = runCli(home, "info");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Workspace: ~/.agents/agent-profile-kit/workspace");
    expect(result.stdout).not.toContain("relative-secret-project");
    expect(result.stdout).not.toContain("secret-profile");
    expect(result.stdout).not.toContain("unsupported-secret-host");
  });

  test("keeps an authored home-relative Workspace spelling in human output", () => {
    const home = isolatedHome();
    const authoredWorkspace = "~/custom-info-workspace";
    const init = runCli(home, "init", authoredWorkspace);
    expect(init.status, init.stderr).toBe(0);

    const result = runCli(home, "info");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Workspace: ~/custom-info-workspace");
  });

  test("emits a deterministic versioned JSON payload with canonical and authored locations", () => {
    const home = isolatedHome();
    const authoredWorkspace = "~/custom-info-json-workspace";
    const init = runCli(home, "init", authoredWorkspace);
    expect(init.status, init.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
      readonly version: string;
    };

    const first = runCli(home, "info", "--json");
    const second = runCli(home, "info", "--json");

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).not.toMatch(/\u001b\[/);
    expect(JSON.parse(first.stdout)).toEqual({
      schemaVersion: 1,
      command: "info",
      outcome: "success",
      engineVersion: manifest.version,
      configurationState: "current",
      workspace: {
        authored: authoredWorkspace,
        canonical: realpathSync(join(home, "custom-info-json-workspace")),
      },
      localConfiguration: configPath(home),
      installationState: statePath(home),
    });
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("returns a versioned JSON error for malformed configuration without writing state", () => {
    const home = isolatedHome();
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(configPath(home), "schema_version: [malformed\n");

    const result = runCli(home, "info", "--json");

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload).toMatchObject({
      schemaVersion: 1,
      command: "info",
      outcome: "error",
      localConfiguration: configPath(home),
      installationState: statePath(home),
      configurationState: "unknown",
    });
    expect(typeof payload.error).toBe("string");
    expect(payload).not.toHaveProperty("workspace");
    expect(existsSync(statePath(home))).toBe(false);
  });

  test("rejects unsupported presentation arguments with info usage", () => {
    const home = isolatedHome();

    const result = runCli(home, "info", "--yaml");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("info does not accept argument '--yaml'");
    expect(result.stderr).toContain("Usage: apkit info [--json]");
    expect(result.stdout).toBe("");
  });
});

describe("apkit temporary Profile installation (Codex)", () => {
  test("install-temp and remove-temp help use the settled temporary-install vocabulary", () => {
    const home = isolatedHome();
    const installHelp = runCli(home, "install-temp", "--help");
    expect(installHelp.status, installHelp.stderr).toBe(0);
    expect(installHelp.stdout).toContain("Install a Profile temporarily into one Project");
    expect(installHelp.stdout).toContain("Usage: apkit install-temp <profile> <project> --host <host> [--json]");
    expect(installHelp.stdout).toContain("Next: Run apkit remove-temp <temporary-installation-id> when finished.");
    expect(installHelp.stdout).toContain("--host claude");
    expect(installHelp.stdout).toContain("--host codex");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) {
      expect(installHelp.stdout).not.toMatch(term);
    }

    const removeHelp = runCli(home, "remove-temp", "--help");
    expect(removeHelp.status, removeHelp.stderr).toBe(0);
    expect(removeHelp.stdout).toContain("Remove one temporary Profile installation");
    expect(removeHelp.stdout).not.toContain("Remove one temporary project");
    expect(removeHelp.stdout).toContain("Usage: apkit remove-temp <temporary-installation-id> [--json]");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) {
      expect(removeHelp.stdout).not.toMatch(term);
    }

    const root = runCli(home);
    expect(root.stdout).toContain("Install a Profile temporarily into one Project");
    expect(root.stdout).toContain("Remove one temporary Profile installation");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) {
      expect(root.stdout).not.toMatch(term);
    }
  });

  test("install-temp / remove-temp complete Codex lifecycle with a versioned receipt and isolation", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    const skillSource = join(workspacePath(home), "skills", "review-pr");
    mkdirSync(skillSource, { recursive: true });
    writeFileSync(
      join(skillSource, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\nReview the change carefully.\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills:\n  - review-pr\nagents: []\nhooks: []\ntools: []\n",
    );
    const tempProject = realpathSync(gitRepository("agent-profile-kit-temp-"));
    const boundProject = realpathSync(gitRepository("agent-profile-kit-bound-"));
    bind(home, boundProject, "coding");
    const applyBound = runCli(home, "apply");
    expect(applyBound.status, applyBound.stderr).toBe(0);

    const configBefore = readFileSync(configPath(home));
    const boundContextBefore = readFileSync(
      join(boundProject, ".agent-profile-kit", "codex", "context.md"),
    );

    const install = runCli(
      home,
      "install-temp",
      "coding",
      tempProject,
      "--host",
      "codex",
      "--json",
    );
    expect(install.status, install.stderr).toBe(0);
    const receipt = JSON.parse(install.stdout) as {
      readonly schemaVersion: number;
      readonly command: string;
      readonly outcome: string;
      readonly temporaryInstallationId: string;
      readonly profileId: string;
      readonly host: string;
      readonly project: string;
      readonly workspaceInputHash: string;
      readonly engineVersion: string;
      readonly adapterVersion: string;
      readonly hostVersion: string;
      readonly outputs: readonly string[];
      readonly repositoryExclusion: { readonly target: string; readonly entries: readonly string[] } | null;
      readonly completionState: string;
      readonly setupSteps: readonly {
        readonly host: string;
        readonly kind: string;
        readonly message: string;
        readonly consequence?: string;
      }[];
      readonly warnings: readonly string[];
    };
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.command).toBe("install-temp");
    expect(receipt.outcome).toBe("success");
    expect(receipt.profileId).toBe("coding");
    expect(receipt.host).toBe("codex");
    expect(receipt.project).toBe(tempProject);
    expect(receipt.completionState).toBe("installed");
    expect(receipt.temporaryInstallationId.length).toBeGreaterThan(0);
    expect(receipt.workspaceInputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.engineVersion).toBeTruthy();
    expect(receipt.adapterVersion).toBeTruthy();
    expect(receipt.hostVersion).toBeTruthy();
    expect(receipt.outputs).toContain(".agent-profile-kit/installation.json");
    expect(receipt.outputs).toContain(".agent-profile-kit/codex/context.md");
    expect(receipt.outputs).toContain(".agents/skills/review-pr");
    expect(receipt.repositoryExclusion).not.toBeNull();
    expect(receipt.repositoryExclusion!.entries).toEqual(
      expect.arrayContaining([
        "/.agent-profile-kit/codex/context.md",
        "/.agent-profile-kit/installation.json",
        "/.agents/skills/review-pr",
        "/.codex/hooks.json",
      ]),
    );
    expect(receipt.setupSteps.some((step) => step.kind === "approval-required")).toBe(true);
    expect(receipt.setupSteps.some((step) => step.kind === "trust-required")).toBe(true);
    expect(receipt.setupSteps.some((step) => /SessionStart hook/i.test(step.message))).toBe(true);
    expect(receipt.setupSteps.some((step) => /Trust the bound project/i.test(step.message))).toBe(true);
    expect(Array.isArray(receipt.warnings)).toBe(true);

    expect(existsSync(join(tempProject, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(tempProject, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(tempProject, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(tempProject, ".agents", "skills", "review-pr", "SKILL.md"), "utf8"))
      .toContain("Review the change carefully.");
    const exclude = join(tempProject, ".git", "info", "exclude");
    const excludeText = readFileSync(exclude, "utf8");
    expect(excludeText).toContain("# BEGIN Agent Profile Kit generated paths");
    expect(excludeText).toContain("/.agents/skills/review-pr");
    expect(existsSync(join(tempProject, ".gitignore"))).toBe(false);

    expect(readFileSync(configPath(home)).equals(configBefore)).toBe(true);
    expect(
      readFileSync(join(boundProject, ".agent-profile-kit", "codex", "context.md")).equals(
        boundContextBefore,
      ),
    ).toBe(true);

    const remove = runCli(home, "remove-temp", receipt.temporaryInstallationId, "--json");
    expect(remove.status, remove.stderr).toBe(0);
    const removed = JSON.parse(remove.stdout) as {
      readonly outcome: string;
      readonly completionState: string;
      readonly temporaryInstallationId: string;
      readonly outputs: readonly string[];
      readonly setupSteps: readonly unknown[];
      readonly warnings: readonly unknown[];
    };
    expect(removed.outcome).toBe("success");
    expect(removed.completionState).toBe("removed");
    expect(removed.temporaryInstallationId).toBe(receipt.temporaryInstallationId);
    expect(removed.outputs).toEqual([]);
    expect(removed.setupSteps).toEqual([]);
    expect(removed.warnings).toEqual([]);
    expect(existsSync(join(tempProject, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(tempProject, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(tempProject, ".agents", "skills", "review-pr"))).toBe(false);
    expect(readFileSync(exclude, "utf8")).not.toContain("# BEGIN Agent Profile Kit generated paths");

    const removeAgain = runCli(home, "remove-temp", receipt.temporaryInstallationId, "--json");
    expect(removeAgain.status, removeAgain.stderr).toBe(0);
    const removedAgain = JSON.parse(removeAgain.stdout) as {
      readonly outcome: string;
      readonly completionState: string;
    };
    expect(removedAgain.outcome).toBe("success");
    expect(removedAgain.completionState).toBe("removed");

    expect(readFileSync(configPath(home)).equals(configBefore)).toBe(true);
    expect(
      readFileSync(join(boundProject, ".agent-profile-kit", "codex", "context.md")).equals(
        boundContextBefore,
      ),
    ).toBe(true);
    // Ordinary Profile Installation remains after temporary lifecycle.
    expect(existsSync(join(boundProject, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("install-temp surfaces Codex Host Setup Steps and hooks-disabled warnings", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    // Override the init-provided hooks-enabled Codex config so warnings fire.
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = false\n");
    const tempProject = realpathSync(gitRepository("agent-profile-kit-temp-warn-"));

    const install = runCli(
      home,
      "install-temp",
      "coding",
      tempProject,
      "--host",
      "codex",
      "--json",
    );
    expect(install.status, install.stderr).toBe(0);
    const receipt = JSON.parse(install.stdout) as {
      readonly warnings: readonly string[];
      readonly setupSteps: readonly {
        readonly kind: string;
        readonly message: string;
        readonly consequence?: string;
      }[];
    };
    expect(receipt.warnings.some((warning) => /hooks are not enabled/i.test(warning))).toBe(true);
    expect(receipt.setupSteps.some((step) => step.kind === "approval-required")).toBe(true);
    expect(receipt.setupSteps.some((step) => step.kind === "trust-required")).toBe(true);
    expect(
      receipt.setupSteps.some((step) =>
        /SessionStart hook/i.test(step.message) &&
        step.consequence !== undefined &&
        /Profile Context/i.test(step.consequence)
      ),
    ).toBe(true);

    const human = runCli(
      home,
      "remove-temp",
      JSON.parse(install.stdout).temporaryInstallationId,
    );
    expect(human.status, human.stderr).toBe(0);

    // Reinstall for human install output with the same hooks warning.
    const humanInstall = runCli(
      home,
      "install-temp",
      "coding",
      tempProject,
      "--host",
      "codex",
    );
    expect(humanInstall.status, humanInstall.stderr).toBe(0);
    expect(humanInstall.stdout).toContain("Installed Profile temporarily");
    expect(humanInstall.stdout).toContain("Warnings:");
    expect(humanInstall.stdout).toMatch(/hooks are not enabled/i);
    expect(humanInstall.stdout).toContain("Codex setup:");
    expect(humanInstall.stdout).toMatch(/SessionStart hook/i);
    expect(humanInstall.stdout).toContain("Trust the bound project in Codex.");
    expect(humanInstall.stdout).toContain(
      "Trust the bound project in Codex.\n" +
        "  Consequence: Profile Context does not load until the project is trusted.",
    );
  });

  test("install-temp rejects unknown Profile, unsupported Host, missing Project, and tracked destinations before writes", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    const projectPath = gitRepository("agent-profile-kit-temp-block-");

    const unknownProfile = runCli(
      home,
      "install-temp",
      "missing-profile",
      projectPath,
      "--host",
      "codex",
      "--json",
    );
    expect(unknownProfile.status).toBe(1);
    expect(JSON.parse(unknownProfile.stdout).outcome).toBe("error");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);

    const unsupportedHost = runCli(
      home,
      "install-temp",
      "coding",
      projectPath,
      "--host",
      "grok",
      "--json",
    );
    expect(unsupportedHost.status).toBe(1);
    expect(JSON.parse(unsupportedHost.stdout).outcome).toBe("error");
    expect(JSON.parse(unsupportedHost.stdout).error).toMatch(
      /does not yet support|supported Hosts: claude, codex/i,
    );

    const missingProject = runCli(
      home,
      "install-temp",
      "coding",
      join(home, "no-such-project"),
      "--host",
      "codex",
      "--json",
    );
    expect(missingProject.status).toBe(1);
    expect(JSON.parse(missingProject.stdout).outcome).toBe("error");

    mkdirSync(join(projectPath, ".agent-profile-kit", "codex"), { recursive: true });
    writeFileSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"), "tracked\n");
    execFileSync("git", ["-C", projectPath, "add", ".agent-profile-kit/codex/context.md"]);
    execFileSync("git", ["-C", projectPath, "commit", "-qm", "track destination"]);

    const tracked = runCli(
      home,
      "install-temp",
      "coding",
      projectPath,
      "--host",
      "codex",
      "--json",
    );
    expect(tracked.status).toBe(2);
    const blocked = JSON.parse(tracked.stdout) as {
      readonly outcome: string;
      readonly blockers: readonly { readonly message: string }[];
    };
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.blockers.some((blocker) => /tracked project path/i.test(blocker.message))).toBe(true);
    // Marker must not be published when blocked.
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("install-temp does not create Project Bindings or invoke global apply side effects", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    const tempProject = gitRepository("agent-profile-kit-temp-only-");
    const otherProject = gitRepository("agent-profile-kit-other-bound-");
    bind(home, otherProject, "coding");
    const configBefore = readFileSync(configPath(home), "utf8");

    const install = runCli(
      home,
      "install-temp",
      "coding",
      tempProject,
      "--host",
      "codex",
      "--json",
    );
    expect(install.status, install.stderr).toBe(0);
    expect(readFileSync(configPath(home), "utf8")).toBe(configBefore);
    expect(parse(configBefore).bindings).toHaveLength(1);
    // Other bound project was never applied; temporary install must not apply it.
    expect(existsSync(join(otherProject, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("remove-temp discards agent modifications inside owned roots and preserves adjacent unowned files", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    const skillSource = join(workspacePath(home), "skills", "review-pr");
    mkdirSync(skillSource, { recursive: true });
    writeFileSync(
      join(skillSource, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\nReview the change carefully.\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills:\n  - review-pr\nagents: []\nhooks: []\ntools: []\n",
    );
    const tempProject = realpathSync(gitRepository("agent-profile-kit-temp-dispose-cli-"));
    writeFileSync(join(tempProject, "user-notes.md"), "keep me\n");

    const install = runCli(
      home,
      "install-temp",
      "coding",
      tempProject,
      "--host",
      "codex",
      "--json",
    );
    expect(install.status, install.stderr).toBe(0);
    const receipt = JSON.parse(install.stdout) as { readonly temporaryInstallationId: string };

    writeFileSync(
      join(tempProject, ".agents", "skills", "review-pr", "SKILL.md"),
      "agent mutated skill\n",
    );
    writeFileSync(
      join(tempProject, ".agents", "skills", "review-pr", "extra.md"),
      "unexpected member\n",
    );
    writeFileSync(join(tempProject, ".agent-profile-kit", "codex", "context.md"), "mutated\n");

    const remove = runCli(home, "remove-temp", receipt.temporaryInstallationId, "--json");
    expect(remove.status, remove.stderr).toBe(0);
    expect(JSON.parse(remove.stdout).completionState).toBe("removed");
    expect(existsSync(join(tempProject, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(tempProject, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(readFileSync(join(tempProject, "user-notes.md"), "utf8")).toBe("keep me\n");
  });

  test("linked worktrees can hold independent temporary installations with contributor-safe exclusions", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    const primary = realpathSync(gitRepository("agent-profile-kit-temp-wt-primary-"));
    const first = realpathSync(addWorktree(primary, "trial-a"));
    const second = realpathSync(addWorktree(primary, "trial-b"));

    const installA = runCli(home, "install-temp", "coding", first, "--host", "codex", "--json");
    const installB = runCli(home, "install-temp", "coding", second, "--host", "codex", "--json");
    expect(installA.status, installA.stderr).toBe(0);
    expect(installB.status, installB.stderr).toBe(0);
    const idA = JSON.parse(installA.stdout).temporaryInstallationId as string;
    const idB = JSON.parse(installB.stdout).temporaryInstallationId as string;
    expect(idA).not.toBe(idB);
    expect(existsSync(join(first, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(second, ".agent-profile-kit", "installation.json"))).toBe(true);

    const removeA = runCli(home, "remove-temp", idA, "--json");
    expect(removeA.status, removeA.stderr).toBe(0);
    expect(existsSync(join(first, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(second, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(readFileSync(join(primary, ".git", "info", "exclude"), "utf8")).toContain(
      "# BEGIN Agent Profile Kit generated paths",
    );

    const removeB = runCli(home, "remove-temp", idB, "--json");
    expect(removeB.status, removeB.stderr).toBe(0);
    expect(existsSync(join(second, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(readFileSync(join(primary, ".git", "info", "exclude"), "utf8")).not.toContain(
      "# BEGIN Agent Profile Kit generated paths",
    );
  });

  test("install-temp rejects a second active temporary installation for the same Project before writes", () => {
    const home = isolatedHome();
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    const tempProject = realpathSync(gitRepository("agent-profile-kit-temp-second-cli-"));

    const first = runCli(home, "install-temp", "coding", tempProject, "--host", "codex", "--json");
    expect(first.status, first.stderr).toBe(0);

    const second = runCli(home, "install-temp", "coding", tempProject, "--host", "codex", "--json");
    expect(second.status).toBe(2);
    const blocked = JSON.parse(second.stdout) as {
      readonly outcome: string;
      readonly blockers: readonly { readonly message: string }[];
    };
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.blockers.some((blocker) => /active Temporary Profile Installation/i.test(blocker.message)))
      .toBe(true);
  });
});

describe("apkit temporary Profile installation (Claude Code parity)", () => {
  function prepareClaudeTempWorkspace(home: string): void {
    initialize(home);
    removeScaffoldedExample(home);
    writeContextProfile(home, "coding");
    const skillSource = join(workspacePath(home), "skills", "review-pr");
    mkdirSync(skillSource, { recursive: true });
    writeFileSync(
      join(skillSource, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\nReview the change carefully.\n",
    );
    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills:\n  - review-pr\nagents: []\nhooks: []\ntools: []\n",
    );
  }

  function runCliWithClaude(home: string, ...arguments_: string[]) {
    const pathValue = `${installFakeClaude(home)}:${installFakeCodex(home)}:${process.env.PATH ?? ""}`;
    return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
      encoding: "utf8" as const,
      env: { ...process.env, HOME: home, PATH: pathValue },
    });
  }

  test("install-temp / remove-temp complete Claude lifecycle with versioned receipt and Claude Adapter outputs", () => {
    const home = isolatedHome();
    prepareClaudeTempWorkspace(home);
    const tempProject = realpathSync(gitRepository("agent-profile-kit-temp-claude-cli-"));
    const boundProject = realpathSync(gitRepository("agent-profile-kit-bound-claude-cli-"));
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${boundProject}\n    profile: coding\n    hosts:\n      - claude\n`,
    );
    const applyBound = runCliWithClaude(home, "apply");
    expect(applyBound.status, applyBound.stderr).toBe(0);
    const configBefore = readFileSync(configPath(home));
    const boundRuleBefore = readFileSync(
      join(boundProject, ".claude", "rules", "agent-profile-kit.md"),
    );

    const install = runCliWithClaude(
      home,
      "install-temp",
      "coding",
      tempProject,
      "--host",
      "claude",
      "--json",
    );
    expect(install.status, install.stderr).toBe(0);
    const receipt = JSON.parse(install.stdout) as {
      readonly schemaVersion: number;
      readonly command: string;
      readonly outcome: string;
      readonly temporaryInstallationId: string;
      readonly profileId: string;
      readonly host: string;
      readonly project: string;
      readonly workspaceInputHash: string;
      readonly engineVersion: string;
      readonly adapterVersion: string;
      readonly hostVersion: string;
      readonly outputs: readonly string[];
      readonly repositoryExclusion: {
        readonly target: string;
        readonly entries: readonly string[];
      } | null;
      readonly completionState: string;
      readonly setupSteps: readonly unknown[];
      readonly warnings: readonly string[];
    };
    expect(receipt.schemaVersion).toBe(1);
    expect(receipt.command).toBe("install-temp");
    expect(receipt.outcome).toBe("success");
    expect(receipt.profileId).toBe("coding");
    expect(receipt.host).toBe("claude");
    expect(receipt.project).toBe(tempProject);
    expect(receipt.completionState).toBe("installed");
    expect(receipt.temporaryInstallationId.length).toBeGreaterThan(0);
    expect(receipt.workspaceInputHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(receipt.engineVersion).toBeTruthy();
    expect(receipt.adapterVersion).toMatch(/claude/i);
    expect(receipt.hostVersion).toMatch(/native-project-unscoped-rules-skills/);
    expect(receipt.outputs).toContain(".agent-profile-kit/installation.json");
    expect(receipt.outputs).toContain(".claude/rules/agent-profile-kit.md");
    expect(receipt.outputs).toContain(".claude/skills/review-pr");
    expect(receipt.outputs).not.toContain(".agent-profile-kit/codex/context.md");
    expect(receipt.repositoryExclusion).not.toBeNull();
    expect(receipt.repositoryExclusion!.entries).toEqual(
      expect.arrayContaining([
        "/.claude/rules/agent-profile-kit.md",
        "/.claude/skills/review-pr",
        "/.agent-profile-kit/installation.json",
      ]),
    );
    expect(Array.isArray(receipt.setupSteps)).toBe(true);
    expect(Array.isArray(receipt.warnings)).toBe(true);

    expect(existsSync(join(tempProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(tempProject, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(tempProject, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(tempProject, ".gitignore"))).toBe(false);
    expect(readFileSync(configPath(home)).equals(configBefore)).toBe(true);
    expect(
      readFileSync(join(boundProject, ".claude", "rules", "agent-profile-kit.md")).equals(
        boundRuleBefore,
      ),
    ).toBe(true);

    const humanInstall = runCliWithClaude(
      home,
      "remove-temp",
      receipt.temporaryInstallationId,
    );
    // Already installed — re-install after remove for human summary, then assert jargon-free.
    expect(humanInstall.status, humanInstall.stderr).toBe(0);
    expect(humanInstall.stdout).toContain("Removed temporary Profile installation");
    expect(humanInstall.stdout).toContain(`Temporary installation: ${receipt.temporaryInstallationId}`);
    expect(humanInstall.stdout).not.toMatch(/Project Binding|reconcil|materializ|cleanup/i);

    const reinstall = runCliWithClaude(
      home,
      "install-temp",
      "coding",
      tempProject,
      "--host",
      "claude",
    );
    expect(reinstall.status, reinstall.stderr).toBe(0);
    expect(reinstall.stdout).toContain("Installed Profile temporarily");
    expect(reinstall.stdout).toContain("Host: claude");
    expect(reinstall.stdout).toContain("Profile: coding");
    expect(reinstall.stdout).not.toMatch(/Project Binding|reconcil|materializ|cleanup/i);
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) {
      expect(reinstall.stdout).not.toMatch(term);
    }
    const reinstallIdMatch = reinstall.stdout.match(/Temporary installation: (\S+)/);
    expect(reinstallIdMatch?.[1]).toBeTruthy();
    const reinstallId = reinstallIdMatch![1]!;

    const remove = runCliWithClaude(home, "remove-temp", reinstallId, "--json");
    expect(remove.status, remove.stderr).toBe(0);
    const removed = JSON.parse(remove.stdout) as {
      readonly outcome: string;
      readonly completionState: string;
      readonly temporaryInstallationId: string;
      readonly host: string;
      readonly outputs: readonly string[];
      readonly setupSteps: readonly unknown[];
      readonly warnings: readonly unknown[];
    };
    expect(removed.outcome).toBe("success");
    expect(removed.completionState).toBe("removed");
    expect(removed.temporaryInstallationId).toBe(reinstallId);
    expect(removed.host).toBe("claude");
    expect(removed.outputs).toEqual([]);
    expect(removed.setupSteps).toEqual([]);
    expect(removed.warnings).toEqual([]);
    expect(existsSync(join(tempProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(tempProject, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(tempProject, ".agent-profile-kit", "installation.json"))).toBe(false);

    const removeAgain = runCliWithClaude(home, "remove-temp", reinstallId, "--json");
    expect(removeAgain.status, removeAgain.stderr).toBe(0);
    expect(JSON.parse(removeAgain.stdout).completionState).toBe("removed");
    expect(JSON.parse(removeAgain.stdout).outcome).toBe("success");

    // Ordinary Claude Profile Installation remains after temporary lifecycle.
    expect(existsSync(join(boundProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(readFileSync(configPath(home)).equals(configBefore)).toBe(true);
  });

  test("Claude and Codex receipts share protocol shape with Host-truthful provenance", () => {
    const home = isolatedHome();
    prepareClaudeTempWorkspace(home);
    const claudeProject = realpathSync(gitRepository("agent-profile-kit-temp-proto-claude-"));
    const codexProject = realpathSync(gitRepository("agent-profile-kit-temp-proto-codex-"));

    const claudeInstall = runCliWithClaude(
      home,
      "install-temp",
      "coding",
      claudeProject,
      "--host",
      "claude",
      "--json",
    );
    const codexInstall = runCliWithClaude(
      home,
      "install-temp",
      "coding",
      codexProject,
      "--host",
      "codex",
      "--json",
    );
    expect(claudeInstall.status, claudeInstall.stderr).toBe(0);
    expect(codexInstall.status, codexInstall.stderr).toBe(0);
    const claude = JSON.parse(claudeInstall.stdout) as Record<string, unknown>;
    const codex = JSON.parse(codexInstall.stdout) as Record<string, unknown>;
    const requiredKeys = [
      "schemaVersion",
      "command",
      "outcome",
      "temporaryInstallationId",
      "profileId",
      "host",
      "project",
      "workspaceInputHash",
      "engineVersion",
      "adapterVersion",
      "hostVersion",
      "outputs",
      "repositoryExclusion",
      "completionState",
      "warnings",
      "setupSteps",
    ] as const;
    for (const key of requiredKeys) {
      expect(claude).toHaveProperty(key);
      expect(codex).toHaveProperty(key);
    }
    expect(claude.schemaVersion).toBe(codex.schemaVersion);
    expect(claude.command).toBe("install-temp");
    expect(codex.command).toBe("install-temp");
    expect(claude.host).toBe("claude");
    expect(codex.host).toBe("codex");
    expect(claude.adapterVersion).not.toBe(codex.adapterVersion);
    expect(claude.hostVersion).not.toBe(codex.hostVersion);
    expect(claude.temporaryInstallationId).not.toBe(codex.temporaryInstallationId);
    expect(claude.profileId).toBe("coding");
    expect(codex.profileId).toBe("coding");
    const claudeOutputs = claude.outputs as readonly string[];
    const codexOutputs = codex.outputs as readonly string[];
    expect(claudeOutputs).toContain(".claude/rules/agent-profile-kit.md");
    expect(claudeOutputs).toContain(".claude/skills/review-pr");
    expect(claudeOutputs).not.toContain(".agent-profile-kit/codex/context.md");
    expect(codexOutputs).toContain(".agent-profile-kit/codex/context.md");
    expect(codexOutputs).toContain(".agents/skills/review-pr");
    expect(codexOutputs).not.toContain(".claude/rules/agent-profile-kit.md");
  });

  test("Claude install-temp exit codes: 0 success, 1 tool error, 2 capability blocker", () => {
    const home = isolatedHome();
    prepareClaudeTempWorkspace(home);
    const projectPath = realpathSync(gitRepository("agent-profile-kit-temp-claude-exits-"));

    const success = runCliWithClaude(
      home,
      "install-temp",
      "coding",
      projectPath,
      "--host",
      "claude",
      "--json",
    );
    expect(success.status).toBe(0);

    const missingProfile = runCliWithClaude(
      home,
      "install-temp",
      "no-such-profile",
      projectPath,
      "--host",
      "claude",
      "--json",
    );
    expect(missingProfile.status).toBe(1);
    expect(JSON.parse(missingProfile.stdout).outcome).toBe("error");

    const invalidInvocation = runCliWithClaude(home, "install-temp", "--json");
    expect(invalidInvocation.status).toBe(1);

    // Capability blocker: old Claude CLI floor.
    const oldBin = installFakeClaude(home, "2.0.63");
    const pathValue = `${oldBin}:${process.env.PATH ?? ""}`;
    const blocked = spawnSync(
      process.env.NODE_BINARY ?? "node",
      [cliPath, "install-temp", "coding", gitRepository("agent-profile-kit-temp-claude-old-"), "--host", "claude", "--json"],
      {
        encoding: "utf8" as const,
        env: { ...process.env, HOME: home, PATH: pathValue },
      },
    );
    expect(blocked.status).toBe(2);
    const payload = JSON.parse(blocked.stdout) as {
      readonly outcome: string;
      readonly blockers: readonly { readonly message: string }[];
    };
    expect(payload.outcome).toBe("blocked");
    expect(payload.blockers.some((blocker) => /Claude CLI|requires 2\.0\.64/i.test(blocker.message)))
      .toBe(true);
  });
});
