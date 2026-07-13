import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
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

function runCli(home: string, ...arguments_: string[]) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    encoding: "utf8",
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
        source: `schema_version: 1\nbindings:\n  - project: ${first}\n    profile: coding\n    hosts: [claude]\n`,
        message: "unsupported Agent Host 'claude'",
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
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toHaveProperty("installation_id");
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
    const uninstall = runCli(home, "uninstall");

    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain("malformed ownership state");
    expect(status.stdout).toContain("schema_version must be 2");
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
    expect(result.stdout).toContain(`${first}: addition`);
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

  test("Profiles selecting Skills fail before project writes", () => {
    const home = isolatedHome();
    initialize(home);
    const projectPath = project();
    writeContextProfile(home);
    mkdirSync(join(workspacePath(home), "skills", "review-pr"));
    writeFileSync(join(workspacePath(home), "skills", "review-pr", "SKILL.md"), "---\nname: review-pr\ndescription: Review code.\n---\n\nReview.\n");
    writeFileSync(join(workspacePath(home), "profiles", "coding.yaml"), "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n");
    bind(home, projectPath);
    const result = runCli(home, "apply");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("selects Skills");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex"))).toBe(false);
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
});
