import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
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

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];
let cliPath = join(repositoryRoot, "dist", "cli.js");

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

function runCli(home: string, ...arguments_: string[]) {
  return runCliAt(home, undefined, ...arguments_);
}

function runCliAt(home: string, cwd: string | undefined, ...arguments_: string[]) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    encoding: "utf8" as const,
    cwd,
    env: { ...process.env, HOME: home },
  });
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function statePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml");
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
    `schema_version: 1\nbindings:\n  - project: ${projectPath}\n    profile: ${profile}\n    hosts:\n      - codex\n`,
  );
}

function initialize(home: string): void {
  const result = runCli(home, "init");
  expect(result.status, result.stderr).toBe(0);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

/** Put a controlled Claude Code stub first on PATH for Host capability preflight. */
function installFakeClaude(home: string, version = "2.1.0"): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  execFileSync("chmod", ["+x", join(bin, "claude")]);
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
  test("init creates both canonical inputs and never overwrites either", () => {
    const home = isolatedHome();
    initialize(home);
    const workspace = workspacePath(home);
    const config = configPath(home);
    const originalConfig = "schema_version: 1\nbindings: []\n# authored\n";
    writeFileSync(config, originalConfig);
    writeFileSync(join(workspace, "README.md"), "# authored\n");

    const result = runCli(home, "init");

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(config, "utf8")).toBe(originalConfig);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe("# authored\n");
  });

  test("manifest-only and partial Workspaces validate; re-init does not restore optional scaffolding", () => {
    const home = isolatedHome();
    const workspace = workspacePath(home);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(configPath(home), "schema_version: 1\nbindings: []\n");

    const minimalValidate = runCli(home, "validate");
    expect(minimalValidate.status, minimalValidate.stderr).toBe(0);
    expect(minimalValidate.stdout).toContain("Workspace and Local Configuration valid");

    mkdirSync(join(workspace, "context"));
    mkdirSync(join(workspace, "profiles"));
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);

    const partialValidate = runCli(home, "validate");
    expect(partialValidate.status, partialValidate.stderr).toBe(0);
    expect(partialValidate.stdout).toContain("1 Profiles");

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
    expect(uninstall.stdout).toMatch(/Uninstalled/);
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
    writeFileSync(configPath(home), "schema_version: 1\nbindings: []\n");

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

  test("omitting workspace retains the fixed default Workspace path", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    bind(home, projectPath);

    const result = runCli(home, "validate");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 Profiles");
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).not.toMatch(/^\s*workspace:/m);
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
      `schema_version: 1\nworkspace: ${custom}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const absolute = runCli(home, "validate");
    expect(absolute.status, absolute.stderr).toBe(0);
    expect(absolute.stdout).toContain("1 Profiles");
    expect(existsSync(workspacePath(home))).toBe(false);

    const homeRelative = `~/${custom.slice(home.length + 1)}`;
    writeFileSync(
      configPath(home),
      `schema_version: 1\nworkspace: ${homeRelative}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const relativeHome = runCli(home, "validate");
    expect(relativeHome.status, relativeHome.stderr).toBe(0);
    expect(relativeHome.stdout).toContain("1 Profiles");
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
      `schema_version: 1\nworkspace: ${link}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );

    expect(realpathSync(link)).toBe(realpathSync(realWorkspace));

    const applyViaLink = runCli(home, "apply");
    expect(applyViaLink.status, applyViaLink.stderr).toBe(0);
    const stateAfterApply = readFileSync(statePath(home), "utf8");

    const statusViaLink = runCli(home, "status");
    expect(statusViaLink.status, statusViaLink.stderr).toBe(0);
    expect(statusViaLink.stdout).toContain(`${projectPath}: current`);

    // Change only the authored alias to the realpath spelling of the same tree.
    writeFileSync(
      configPath(home),
      `schema_version: 1\nworkspace: ${realWorkspace}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const statusViaReal = runCli(home, "status");
    expect(statusViaReal.status, statusViaReal.stderr).toBe(0);
    expect(statusViaReal.stdout).toContain(`${projectPath}: current`);
    expect(statusViaReal.stdout).not.toContain("stale");

    const applyViaReal = runCli(home, "apply");
    expect(applyViaReal.status, applyViaReal.stderr).toBe(0);
    expect(applyViaReal.stdout).toContain(`${projectPath}: current`);
    expect(applyViaReal.stdout).not.toMatch(/: (addition|update|removal)\b/);
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
        `schema_version: 1\nworkspace: ${example.workspace}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
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
    expect(readFileSync(configPath(home), "utf8")).toMatch(/schema_version:\s*1/);
    expect(readFileSync(configPath(home), "utf8")).not.toMatch(/^\s*workspace:/m);
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
      `schema_version: 1\nworkspace: ${custom}\nbindings: []\n`,
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
      `schema_version: 1\nworkspace: ${custom}\nbindings: []\n`,
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
      `schema_version: 1\nworkspace: ${custom}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
    );
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("1 Profiles");
    expect(validate.stdout).toContain("1 Project Bindings");

    const apply = runCli(home, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".codex", "AGENTS.md")) || existsSync(join(projectPath, "AGENTS.md")) || existsSync(join(projectPath, ".agent-profile-kit"))).toBe(true);
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
    mkdirSync(bin);
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

  test("validate rejects relative, wildcard, duplicate, missing, and unsupported bindings", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const first = project();
    const invalidBindings = [
      {
        source: `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex, codex]\n`,
        message: "must not contain a Host more than once",
      },
      {
        source: "schema_version: 1\nbindings:\n  - project: ./relative\n    profile: coding\n    hosts: [codex]\n",
        message: "absolute path or home-relative",
      },
      {
        source: "schema_version: 1\nbindings:\n  - project: ~/projects/*\n    profile: coding\n    hosts: [codex]\n",
        message: "without wildcards",
      },
      {
        source: `schema_version: 1\nbindings:\n  - project: ${join(home, "missing")}\n    profile: coding\n    hosts: [codex]\n`,
        message: "must be an existing directory",
      },
      {
        source: `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: missing\n    hosts: [codex]\n`,
        message: "does not exist in Workspace",
      },
      {
        source: `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [cursor]\n`,
        message: "unsupported Agent Host 'cursor'",
      },
    ];

    for (const invalid of invalidBindings) {
      writeFileSync(configPath(home), invalid.source);
      const result = runCli(home, "validate");
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(invalid.message);
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
      `schema_version: 1\nbindings:\n  - project: ${realProject}\n    profile: coding\n    hosts: [codex]\n  - project: ${alias}\n    profile: coding\n    hosts: [codex]\n`,
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
    const result = runCli(home, "preview");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${projectPath}: addition`);
    expect(result.stdout).toContain("Profile coding");
    expect(result.stdout).toContain("Context Module: team-rules");
    expect(result.stdout).toContain(".codex/hooks.json");
    expect(result.stdout).toContain("Codex must start at the exact bound project root");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex"))).toBe(false);
    expect(existsSync(statePath(home))).toBe(false);
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("repository-owned\n");

    for (const command of ["validate", "status", "apply"]) {
      const output = runCli(home, command);
      expect(output.status, output.stderr).toBe(0);
      expect(output.stdout).toContain("Codex must start at the exact bound project root");
    }
  });

  test("preview requires Codex SessionStart hooks to be explicitly enabled", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);

    writeFileSync(join(home, ".codex", "config.toml"), "");
    const missing = runCli(home, "preview");
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("SessionStart hooks are not enabled");
    expect(missing.stdout).toContain("[features].hooks = true");

    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = false\n");
    const disabled = runCli(home, "preview");
    expect(disabled.status).toBe(1);
    expect(disabled.stdout).toContain("SessionStart hooks are not enabled");

    writeFileSync(join(home, ".codex", "config.toml"), "");
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(join(projectPath, ".codex", "config.toml"), "[features]\ncodex_hooks = true\n");
    const projectEnabled = runCli(home, "preview");
    expect(projectEnabled.status, projectEnabled.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
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
      `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "preview");

    expect(result.status).toBe(1);
    expect(result.stdout.match(/SessionStart hooks are not enabled/g)).toHaveLength(2);
    expect(result.stdout).toContain(`${second}/.codex/hooks.json is occupied`);
    expect(existsSync(join(first, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(second, ".agent-profile-kit"))).toBe(false);
  });

  test("apply creates the marker, manifest, composed Context, and native SessionStart hook", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeFileSync(join(projectPath, "AGENTS.md"), "repository-owned\n");
    writeContextProfile(home);
    bind(home, projectPath);
    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    const contextPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    const hookPath = join(projectPath, ".codex", "hooks.json");
    const markerPath = join(projectPath, ".agent-profile-kit", "installation.json");
    expect(readFileSync(contextPath, "utf8")).toContain("Profile: coding");
    expect(readFileSync(contextPath, "utf8")).toContain("Context Module: team-rules");
    expect(readFileSync(contextPath, "utf8")).toContain("Repository-owned project instructions");
    const hook = JSON.parse(readFileSync(hookPath, "utf8")) as { hooks: { SessionStart: readonly { matcher: string; hooks: readonly { command: string }[] }[] } };
    expect(hook.hooks.SessionStart[0]?.matcher).toBe("startup|resume|clear|compact");
    expect(hook.hooks.SessionStart[0]?.hooks[0]?.command).toContain("git rev-parse --show-toplevel");
    expect(hook.hooks.SessionStart[0]?.hooks[0]?.command).not.toContain(projectPath);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(marker).sort()).toEqual(["installation_id", "schema_version"]);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      schema_version: number;
      installations: Array<{ outputs: Array<{ mode: number; type: string }> }>;
    };
    expect(state.schema_version).toBe(2);
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]!.outputs.every((output) =>
      output.type === "file" && output.mode === 0o644
    )).toBe(true);
    expect(readFileSync(join(projectPath, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
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
    expect(result.stdout).toContain(`${projectPath}: current`);
    expect(paths.map((path) => statSync(path).mtimeMs)).toEqual(before);
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
    const changed = runCli(home, "preview");
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.stdout).toContain(`${projectPath}/.agent-profile-kit/codex/context.md: update`);
    expect(changed.stdout).toContain(`${projectPath}/.codex/hooks.json: unchanged`);
    expect(readFileSync(contextPath, "utf8")).toBe(before);

    writeFileSync(configPath(home), "schema_version: 1\nbindings: []\n");
    const removed = runCli(home, "preview");
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(`${projectPath}/.agent-profile-kit/codex/context.md: removal`);
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
      `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "apply");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Apply blocked before writes");
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
      `schema_version: 1\nbindings:\n${projects.map((projectPath) => `  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`).join("")}`;
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
      `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
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
    const projectPath = project("agent-profile-kit-tracked-");
    execFileSync("git", ["init", "-q", projectPath]);
    mkdirSync(join(projectPath, ".codex"));
    writeFileSync(join(projectPath, ".codex", "hooks.json"), "tracked placeholder\n");
    execFileSync("git", ["-C", projectPath, "add", ".codex/hooks.json"]);
    rmSync(join(projectPath, ".codex", "hooks.json"));
    writeContextProfile(home);
    bind(home, projectPath);

    const result = runCli(home, "preview");

    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("tracked");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
  });

  test("apply expands a Git binding to every existing worktree and preserves local exclusions", () => {
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

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    for (const root of [repository, worktree]) {
      expect(existsSync(join(root, ".agent-profile-kit", "installation.json"))).toBe(true);
      expect(existsSync(join(root, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
      expect(existsSync(join(root, ".codex", "hooks.json"))).toBe(true);
      expect(execFileSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" })).toBe("");
    }
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

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git exclusion parent");
    expect(result.stderr).toContain("must be a real directory");
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

    for (const command of ["apply", "uninstall"]) {
      const result = runCli(home, command);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("exclusion section is modified");
      expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(true);
    }
  });

  test("preview and status warn before apply repairs a missing Git exclusion section", () => {
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
      expect(result.stdout).toContain("is missing its Agent Profile Kit exclusion section");
    }

    const repaired = runCli(home, "apply");
    expect(repaired.status, repaired.stderr).toBe(0);
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
      `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
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
      `schema_version: 1\nbindings:\n  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n  - project: ${join(repository, "nested")}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    const exclude = join(repository, ".git", "info", "exclude");
    const before = readFileSync(exclude);
    writeFileSync(join(repository, "nested", ".codex", "hooks.json"), "drifted\n");
    writeFileSync(configPath(home), "schema_version: 1\nbindings: []\n");

    const failed = runCli(home, "apply");

    expect(failed.status).toBe(1);
    expect(readFileSync(exclude).equals(before)).toBe(true);
    expect(existsSync(join(repository, ".agent-profile-kit", "installation.json"))).toBe(true);
    expect(existsSync(join(repository, "nested", ".agent-profile-kit", "installation.json"))).toBe(true);
  });

  test("status reports a worktree created after apply as a missing Profile Installation", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-later-");
    writeContextProfile(home);
    bind(home, repository);
    expect(runCli(home, "apply").status).toBe(0);
    const later = addWorktree(repository, "later-worktree");

    const status = runCli(home, "status");

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${later}: missing output (Profile Installation is missing)`);
    expect(existsSync(join(later, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("a nested Git binding maps the same existing directory into every worktree", () => {
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
    for (const root of [repository, worktree]) {
      expect(existsSync(join(root, "packages", "tool", ".agent-profile-kit", "installation.json"))).toBe(true);
      const hook = readFileSync(join(root, "packages", "tool", ".codex", "hooks.json"), "utf8");
      expect(hook).toContain("packages/tool/.agent-profile-kit/codex/context.md");
    }
    expect(existsSync(join(repository, ".agent-profile-kit"))).toBe(false);
  });

  test("a missing nested binding directory in any existing worktree blocks before writes", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-missing-nested-");
    const worktree = addWorktree(repository, "missing-nested-worktree");
    mkdirSync(join(repository, "local-only"));
    writeContextProfile(home);
    bind(home, join(repository, "local-only"));

    const result = runCli(home, "apply");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Git worktree ${realpathSync(worktree)} is missing bound project directory 'local-only'`);
    expect(existsSync(join(repository, "local-only", ".agent-profile-kit"))).toBe(false);
  });

  test("a symlinked nested binding ancestor in another worktree cannot escape the checkout", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-nested-escape-");
    mkdirSync(join(repository, "packages", "tool"), { recursive: true });
    writeFileSync(join(repository, "packages", "tool", ".keep"), "fixture\n");
    execFileSync("git", ["-C", repository, "add", "packages/tool/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested project"]);
    const worktree = addWorktree(repository, "nested-escape-worktree");
    const external = project("agent-profile-kit-nested-external-");
    mkdirSync(join(external, "tool"));
    rmSync(join(worktree, "packages"), { recursive: true });
    symlinkSync(external, join(worktree, "packages"));
    writeContextProfile(home);
    bind(home, join(repository, "packages", "tool"));

    const result = runCli(home, "apply");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has non-directory or symlink component 'packages'");
    expect(existsSync(join(external, "tool", ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(repository, "packages", "tool", ".agent-profile-kit"))).toBe(false);
  });

  test("worktree expansion deduplicates checkout roots reached by another binding", () => {
    const home = isolatedHome();
    initialize(home);
    const repository = gitRepository("agent-profile-kit-dedupe-");
    const worktree = addWorktree(repository, "dedupe-worktree");
    writeContextProfile(home);
    writeFileSync(
      configPath(home),
      `schema_version: 1\nbindings:\n  - project: ${repository}\n    profile: coding\n    hosts: [codex]\n  - project: ${worktree}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as { installations: readonly unknown[] };
    expect(state.installations).toHaveLength(2);
  });

  test("status distinguishes current, stale source, drifted output, missing output, and malformed ownership", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    bind(home, projectPath);
    expect(runCli(home, "apply").status).toBe(0);
    const current = runCli(home, "status");
    expect(current.status, current.stderr).toBe(0);
    expect(current.stdout).toContain(`${projectPath}: current`);

    writeFileSync(join(workspacePath(home), "context", "team-rules.md"), "---\nid: team-rules\ndependencies: []\n---\nchanged\n");
    expect(runCli(home, "status").stdout).toContain(`${projectPath}: stale source`);
    writeFileSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"), "drift\n");
    expect(runCli(home, "status").stdout).toContain(`${projectPath}: drifted output`);
    rmSync(join(projectPath, ".codex", "hooks.json"));
    expect(runCli(home, "status").stdout).toContain(`${projectPath}: missing output`);
    writeFileSync(join(projectPath, ".agent-profile-kit", "installation.json"), "not json");
    expect(runCli(home, "status").stdout).toContain(`${projectPath}: malformed ownership state`);
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

    const status = runCli(home, "status");
    const applied = runCli(home, "apply");

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${projectPath}: drifted output`);
    expect(status.stdout).toContain("mode");
    expect(applied.status).toBe(1);
    expect(statSync(context).mode & 0o777).toBe(0o600);
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

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("malformed ownership state");
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

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("malformed ownership state");
    expect(status.stdout).toContain("schema_version must be 2");
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain("Apply blocked before writes");
    expect(apply.stderr).toContain("schema_version must be 2");
    expect(uninstall.status).toBe(1);
    expect(uninstall.stderr).toContain("schema_version must be 2");
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

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${projectPath}: blocked`);
    expect(result.stdout).toContain("occupied by unowned or drifted output");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
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
      `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const result = runCli(home, "status");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${first}: missing output (Profile Installation is missing)`);
    expect(result.stdout).not.toContain(`${first}: blocked`);
    expect(result.stdout).toContain(`${second}: blocked`);
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

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("malformed ownership state");
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
    const configuration = `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n`;
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

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("owned output");
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
      `schema_version: 1\nbindings:\n  - project: ${retained}\n    profile: coding\n    hosts: [codex]\n  - project: ${removed}\n    profile: coding\n    hosts: [codex]\n`,
    );
    expect(runCli(home, "apply").status).toBe(0);
    bind(home, retained);

    const result = runCli(home, "apply");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${removed}: removal`);
    expect(existsSync(join(removed, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(removed, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(retained, ".agent-profile-kit", "installation.json"))).toBe(true);
    const state = parse(readFileSync(statePath(home), "utf8")) as { installations: readonly unknown[] };
    expect(state.installations).toHaveLength(1);
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

    const preview = runCli(home, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(`${obsolete}: removal`);
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
      `schema_version: 1\nbindings:\n  - project: ${retained}\n    profile: coding\n    hosts: [codex]\n  - project: ${removed}\n    profile: coding\n    hosts: [codex]\n`,
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

    const result = runCli(home, "apply");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot remove stale Profile Installation");
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
    writeFileSync(configPath(home), "schema_version: 1\nbindings: []\n");

    const result = runCli(home, "apply");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("symlink parent");
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

    const status = runCli(home, "status");

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain(`${projectPath}: stale source`);
    expect(status.stdout).not.toContain(`${projectPath}: missing output`);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
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

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("copies Installation Marker identity");
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
      `schema_version: 1\nbindings:\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n`,
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
    expect(runCli(home, "status").stdout).toContain(`${first}: current`);
    expect(runCli(home, "status").stdout).toContain(`${second}: current`);
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

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("occupied by unowned or drifted output");
    expect(result.stderr).toContain("restore its Manifest-linked Installation Marker at the new root");
    expect(result.stderr).toContain("Apply blocked before writes");
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

    const preview = runCli(home, "preview");
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
      `schema_version: 1\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts:\n      - codex\n      - claude\n`,
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
      `schema_version: 1\nbindings:\n  - project: ${project()}\n    profile: coding\n    hosts:\n      - codex\n`,
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
      `schema_version: 1\nbindings:\n  - project: ${conflictProject}\n    profile: coding\n    hosts:\n      - codex\n`,
    );
    const conflict = runCli(conflictHome, "preview");
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain("conflicting model-invocation authorities");
    expect(existsSync(join(conflictProject, ".agents", "skills", "to-spec"))).toBe(false);

    const preview = runCliWithPath(home, pathValue, "preview");
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
      `schema_version: 1\nbindings:\n  - project: ${projectPath}\n    profile: engineering\n    hosts:\n      - codex\n      - claude\n`,
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

    const preview = runCliWithPath(home, pathValue, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(".agents/skills/review-pr");
    expect(preview.stdout).toContain(".claude/skills/review-pr");
    expect(preview.stdout).not.toContain(".agent-profile-kit/codex/context.md");
    expect(preview.stdout).not.toContain(".codex/hooks.json");
    expect(preview.stdout).not.toContain(".claude/rules/agent-profile-kit.md");

    const apply = runCliWithPath(home, pathValue, "apply");
    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const status = runCliWithPath(home, pathValue, "status");
    expect(status.status, status.stderr).toBe(0);

    writeFileSync(configPath(home), "schema_version: 1\nbindings: []\n");
    const uninstall = runCliWithPath(home, pathValue, "apply");
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr"))).toBe(false);
  });

  test("tracked colliding Codex Skill packages block global preflight", () => {
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
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Apply blocked before writes");
    expect(result.stderr).toMatch(/tracked|unowned/i);
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
      `schema_version: 1\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [claude]\n`,
    );
    const bin = installFakeClaude(home);
    // Prefer the stub, keep the rest of PATH for node/git/etc.
    const pathWithClaude = `${bin}:${process.env.PATH ?? ""}`;

    const preview = runCliWithPath(home, pathWithClaude, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(`${projectPath}: addition`);
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
    expect(status.stdout).toContain(`${projectPath}: current`);

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
      `schema_version: 1\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [claude]\n`,
    );
    const emptyBin = join(home, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    // PATH with only empty-bin so the real Claude is not discoverable.
    const missing = runCliWithPath(home, emptyBin, "preview");
    expect(missing.status).toBe(1);
    expect(`${missing.stdout}${missing.stderr}`).toContain("Claude Code CLI was not found");

    const oldBin = installFakeClaude(home, "2.0.63");
    const old = runCliWithPath(home, `${oldBin}:${process.env.PATH ?? ""}`, "preview");
    expect(old.status).toBe(1);
    expect(`${old.stdout}${old.stderr}`).toContain("does not support unscoped project rules");
    expect(`${old.stdout}${old.stderr}`).toContain("2.0.63");
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const boundaryBin = installFakeClaude(home, "2.0.64");
    const boundary = runCliWithPath(home, `${boundaryBin}:${process.env.PATH ?? ""}`, "preview");
    expect(boundary.status, boundary.stderr).toBe(0);
    expect(boundary.stdout).toContain(".claude/rules/agent-profile-kit.md");
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
      `schema_version: 1\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [claude]\n`,
    );
    const bin = installFakeClaude(home);
    const pathWithClaude = `${bin}:${process.env.PATH ?? ""}`;

    const preview = runCliWithPath(home, pathWithClaude, "preview");
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(`${projectPath}: addition`);
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
    expect(status.stdout).toContain(`${projectPath}: current`);

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
      expect(result.stderr).toContain("Usage: agent-profile-kit");
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
    const result = runCli(home, "guide");
    expect(result.status, result.stderr).toBe(0);

    for (const command of ["init", "validate", "preview", "apply", "status", "uninstall"]) {
      expect(result.stdout).toContain(`agent-profile-kit ${command}`);
    }
    expect(result.stdout).not.toMatch(/agent-profile-kit (plan|install|update|run)\b/);

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

    // Hook enablement is a preflight precondition; project trust is Host-owned launch prep.
    const hooksIndex = result.stdout.indexOf("hooks = true");
    const previewIndex = result.stdout.indexOf("agent-profile-kit preview");
    const applyIndex = result.stdout.indexOf("agent-profile-kit apply");
    const trustIndex = result.stdout.search(/trust each bound project/i);
    const launchIndex = result.stdout.search(/Before launching\s+Codex/i);
    expect(hooksIndex).toBeGreaterThan(-1);
    expect(previewIndex).toBeGreaterThan(-1);
    expect(applyIndex).toBeGreaterThan(-1);
    expect(trustIndex).toBeGreaterThan(-1);
    expect(launchIndex).toBeGreaterThan(-1);
    expect(hooksIndex).toBeLessThan(previewIndex);
    expect(hooksIndex).toBeLessThan(applyIndex);
    expect(trustIndex).toBeGreaterThan(applyIndex);
    expect(Math.abs(trustIndex - launchIndex)).toBeLessThan(120);
  });

  test("packed CLI serves the final project-bound agent workflow", () => {
    const home = isolatedHome();
    const result = runCli(home, "guide", "--agent");
    expect(result.status, result.stderr).toBe(0);

    expect(result.stdout).not.toMatch(/agent-profile-kit (plan|install|update|run)\b/);
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
    expect(result.stdout).toMatch(/#53|fail closed|fail-closed|status.{0,40}blocked/i);
    for (const command of ["validate", "preview", "apply", "status", "uninstall"]) {
      expect(result.stdout).toContain(
        command === "status" || command === "uninstall"
          ? command
          : `agent-profile-kit ${command}`,
      );
    }
  });

  test("packed human guide distinguishes required Manifest from init scaffolding", () => {
    const home = isolatedHome();
    const result = runCli(home, "guide");
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
    const result = runCli(home, "guide");
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
    // Ownership vs observation: status may still report blocked on dual delivery.
    expect(result.stdout).toMatch(
      /status.{0,80}(?:report|blocked)|(?:report|blocked).{0,80}status/is,
    );

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

    // Dual delivery (global + Profile-selected) is prohibited; #53 fail-closed.
    expect(result.stdout).toMatch(/must not be both/i);
    expect(result.stdout).toMatch(/#53/);
    expect(result.stdout).toMatch(/fail closed/i);
  });

  test("init bootstrap pointers stay short and name current guide commands", () => {
    const home = isolatedHome();
    initialize(home);
    const readme = readFileSync(join(workspacePath(home), "README.md"), "utf8");
    const agents = readFileSync(join(workspacePath(home), "AGENTS.md"), "utf8");

    expect(readme).toContain("agent-profile-kit guide");
    expect(agents).toContain("agent-profile-kit guide --agent");
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
    expect(readme).toContain("agent-profile-kit apply");
    expect(readme).not.toMatch(/agent-profile-kit (plan|install|update|run)\b/);
    expect(readme).not.toMatch(/per-session launcher|global Skill projection|process[- ]overlay/i);
    expect(readme).not.toMatch(/legacy migration input/i);
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
    expect(result.stdout).toContain("Recorded Project Binding");
    expect(result.stdout).toContain(realpathSync(projectPath));
    expect(result.stdout).toContain("Profile: coding");
    expect(result.stdout).toContain("Hosts: codex");
    expect(result.stdout).toContain(configPath(home));
    expect(result.stdout).toContain("agent-profile-kit preview");
    expect(result.stdout).toContain("agent-profile-kit apply");
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
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Hosts: claude, codex");
    const source = readFileSync(configPath(home), "utf8");
    expect(source).toContain(`project: ${projectPath}`);
    // Hosts are stored in canonical SUPPORTED_HOSTS order (claude before codex).
    expect(source).toMatch(/hosts:\n\s+- claude\n\s+- codex/);

    const validate = runCli(home, "validate");
    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.stdout).toContain("1 Project Bindings");
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
      `schema_version: 1\n# keep comment\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts:\n      - codex\n`,
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
      `schema_version: 1\n# keep this comment\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${existing}\n    profile: coding\n    hosts:\n      - codex\n`,
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
    const projectPath = project();
    const before = readFileSync(configPath(home), "utf8");

    const unknownProfile = runCli(home, "bind", "missing", projectPath, "--host", "codex");
    expect(unknownProfile.status).toBe(1);
    expect(unknownProfile.stderr).toMatch(/does not exist|profile/i);

    const badHost = runCli(home, "bind", "coding", projectPath, "--host", "gemini");
    expect(badHost.status).toBe(1);
    expect(badHost.stderr).toMatch(/unsupported Agent Host/i);

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

  test("bind fails when Local Configuration changes after the locked snapshot and before publish", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    const configuration = configPath(home);
    const before = readFileSync(configuration, "utf8");

    const { bindProject } = await import("../installer/bind-project.js");
    const {
      mkdir,
      open,
      readFile,
      rename,
      rm,
      stat,
      unlink,
      writeFile,
    } = await import("node:fs/promises");

    let configReads = 0;
    await expect(
      bindProject({
        home,
        profile: "coding",
        project: projectPath,
        hosts: ["codex"],
        fileSystem: {
          mkdir,
          open,
          rename,
          rm,
          stat,
          unlink,
          writeFile,
          readFile: (async (path: string, encoding?: BufferEncoding) => {
            if (path === configuration) {
              configReads += 1;
              // First read is the locked semantic+edit snapshot. Before the
              // pre-publish re-read, an external non-cooperating writer mutates.
              if (configReads === 2) {
                await writeFile(
                  configuration,
                  `${before.trimEnd()}\n# concurrent external edit\n`,
                );
                return readFile(path, encoding ?? "utf8");
              }
            }
            return readFile(path, encoding ?? "utf8");
          }) as typeof readFile,
        },
      }),
    ).rejects.toThrow(/changed during bind/i);

    expect(readFileSync(configuration, "utf8")).toContain("# concurrent external edit");
    expect(readFileSync(configuration, "utf8")).not.toContain(projectPath);
  });

  test("bind validates the exact locked snapshot so a mid-flight rewrite cannot be ingested separately from the edit", async () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    writeContextProfile(home, "ops");
    const projectPath = project();
    const configuration = configPath(home);
    const empty = "schema_version: 1\nbindings: []\n";
    writeFileSync(configuration, empty);

    const { bindProject } = await import("../installer/bind-project.js");
    const {
      mkdir,
      open,
      readFile,
      rename,
      rm,
      stat,
      unlink,
      writeFile,
    } = await import("node:fs/promises");

    // Simulate the old race: after the editable snapshot is taken as empty,
    // the on-disk file gains a conflicting binding. Publish must refuse the
    // empty-based append rather than trusting a later re-ingest.
    let configReads = 0;
    await expect(
      bindProject({
        home,
        profile: "coding",
        project: projectPath,
        hosts: ["codex"],
        fileSystem: {
          mkdir,
          open,
          rename,
          rm,
          stat,
          unlink,
          writeFile,
          readFile: (async (path: string, encoding?: BufferEncoding) => {
            if (path === configuration) {
              configReads += 1;
              if (configReads === 1) {
                return empty;
              }
              // On-disk diverged: different Profile for the same root.
              const conflicting =
                `schema_version: 1\nbindings:\n  - project: ${projectPath}\n    profile: ops\n    hosts:\n      - codex\n`;
              await writeFile(configuration, conflicting);
              return conflicting;
            }
            return readFile(path, encoding ?? "utf8");
          }) as typeof readFile,
        },
      }),
    ).rejects.toThrow(/changed during bind/i);

    expect(readFileSync(configuration, "utf8")).toContain("profile: ops");
    expect(readFileSync(configuration, "utf8")).not.toContain("profile: coding");
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

  test("bind preserves CRLF line endings in Local Configuration", () => {
    const home = isolatedHome();
    initialize(home);
    writeContextProfile(home);
    const projectPath = project();
    writeFileSync(configPath(home), "schema_version: 1\r\n# keep\r\nbindings: []\r\n");

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
    // Missing profile fails; usage path for unknown command:
    const usage = runCli(home, "unknown-command");
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain("bind <profile>");
  });
});

