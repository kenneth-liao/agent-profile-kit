import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];

/**
 * Parse the minimum Node major from package.json engines.node.
 * package.json is the sole supported-runtime home; this gate must not hardcode a major.
 * Supported forms: ">=MAJOR", ">=MAJOR.MINOR", ">=MAJOR.MINOR.PATCH" (optional whitespace after >=).
 */
function minimumNodeMajorFromEngines(enginesNode: unknown): { major: number; range: string } {
  if (typeof enginesNode !== "string" || enginesNode.trim() === "") {
    throw new Error("package.json engines.node must be a non-empty string");
  }
  const range = enginesNode.trim();
  const match = /^(?:>=\s*)(\d+)(?:\.\d+)?(?:\.\d+)?$/.exec(range);
  if (!match?.[1]) {
    throw new Error(
      `package.json engines.node '${range}' cannot be interpreted by the release-candidate Node probe; use '>=MAJOR' (optionally with .MINOR or .MINOR.PATCH)`,
    );
  }
  const major = Number(match[1]);
  if (!Number.isInteger(major) || major < 1) {
    throw new Error(`package.json engines.node '${range}' has an invalid major version`);
  }
  return { major, range };
}

/**
 * Resolve a real Node.js executable for packed-CLI execution.
 * Never fall back to process.execPath under bun test — that would exercise Bun, not the declared runtime (ADR-0008).
 * Override with NODE_BINARY when the supported Node is not first on PATH.
 */
function resolveNodeBinary(minimumMajor: number, enginesRange: string): string {
  const candidates = process.env.NODE_BINARY ? [process.env.NODE_BINARY] : ["node"];

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      [
        "-e",
        "process.stdout.write(JSON.stringify({execPath:process.execPath,node:process.versions.node,bun:process.versions.bun??null}))",
      ],
      { encoding: "utf8" },
    );
    if (probe.status !== 0 || !probe.stdout.trim()) continue;
    let identity: { execPath: string; node: string; bun: string | null };
    try {
      identity = JSON.parse(probe.stdout.trim()) as typeof identity;
    } catch {
      continue;
    }
    // Bun can shadow `node` on PATH; the published package must run on Node.js.
    if (identity.bun !== null) continue;
    const major = Number(identity.node.split(".")[0]);
    if (!Number.isFinite(major) || major < minimumMajor) {
      throw new Error(
        `Resolved Node ${identity.node} at ${identity.execPath} is below package engines.node '${enginesRange}'; set NODE_BINARY to a supported Node executable`,
      );
    }
    return identity.execPath;
  }

  throw new Error(
    `No Node.js executable satisfying package engines.node '${enginesRange}' found for packed-CLI release-candidate gates; install Node or set NODE_BINARY`,
  );
}

let packageRoot = "";
let packageArchive = "";
let cliPath = "";
let packageVersion = "";
let nodeBinary = "";
let minimumNodeMajor = 0;
let enginesNodeRange = "";

beforeAll(() => {
  const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    engines?: { node?: unknown };
  };
  const requirement = minimumNodeMajorFromEngines(rootManifest.engines?.node);
  minimumNodeMajor = requirement.major;
  enginesNodeRange = requirement.range;
  nodeBinary = resolveNodeBinary(minimumNodeMajor, enginesNodeRange);

  execFileSync("bun", ["run", "build"], { cwd: repositoryRoot, stdio: "inherit" });
  const packageDirectory = mkdtempSync(join(tmpdir(), "agent-profile-kit-rc-pack-"));
  const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-rc-packed-"));
  temporaryDirectories.push(packageDirectory, extracted);

  const packOutput = execFileSync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--json", "--pack-destination", packageDirectory],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const metadata = JSON.parse(packOutput.slice(packOutput.lastIndexOf("\n[") + 1)) as readonly [
    { readonly filename: string; readonly name?: string; readonly version?: string },
  ];
  packageArchive = join(packageDirectory, metadata[0]!.filename);
  execFileSync("tar", ["-xzf", packageArchive, "-C", extracted]);
  packageRoot = join(extracted, "package");
  const packedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
    engines?: { node?: unknown };
  };
  packageVersion = packedManifest.version;
  // Packed engines must match the repository source of truth used for the Node probe.
  const packedRequirement = minimumNodeMajorFromEngines(packedManifest.engines?.node);
  if (packedRequirement.major !== minimumNodeMajor || packedRequirement.range !== enginesNodeRange) {
    throw new Error(
      `Packed package engines.node '${packedRequirement.range}' does not match repository engines.node '${enginesNodeRange}'`,
    );
  }
  cliPath = join(packageRoot, "dist", "cli.js");
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-rc-home-"));
  temporaryDirectories.push(home);
  return home;
}

function project(prefix = "agent-profile-kit-rc-project-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function gitRepository(prefix = "agent-profile-kit-rc-git-"): string {
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
  const path = project(`agent-profile-kit-rc-${name}-`);
  rmSync(path, { recursive: true });
  execFileSync("git", ["-C", repository, "worktree", "add", "-q", "-b", name, path]);
  return path;
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

function runCli(
  home: string,
  arguments_: readonly string[],
  options: { readonly path?: string } = {},
) {
  return spawnSync(nodeBinary, [cliPath, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      ...(options.path === undefined ? {} : { PATH: options.path }),
    },
  });
}

function enableCodexHooks(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

function installFakeClaude(home: string, version = "2.1.0"): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "${version} (Claude Code)"\n`);
  execFileSync("chmod", ["+x", join(bin, "claude")]);
  return `${bin}:${process.env.PATH ?? ""}`;
}

function writeWorkspaceAuthoring(home: string): void {
  const workspace = workspacePath(home);
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
  );
}

function writeBindings(
  home: string,
  bindings: readonly { readonly project: string; readonly hosts: readonly string[] }[],
): void {
  const body = bindings
    .map(
      (binding) =>
        `  - project: ${binding.project}\n    profile: coding\n    hosts:\n${binding.hosts
          .map((host) => `      - ${host}`)
          .join("\n")}\n`,
    )
    .join("");
  writeFileSync(configPath(home), `schema_version: 1\nbindings:\n${body}`);
}

function filesUnder(root: string): readonly string[] {
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  }

  visit(root);
  return files.sort();
}

describe("project-bound release candidate", () => {
  test("packed CLI execution uses a supported Node.js runtime, not Bun", () => {
    expect(enginesNodeRange).toBe(
      (
        JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
          engines: { node: string };
        }
      ).engines.node,
    );
    expect(minimumNodeMajor).toBeGreaterThanOrEqual(1);
    expect(nodeBinary.length).toBeGreaterThan(0);
    expect(nodeBinary).not.toBe(process.execPath);
    const probe = spawnSync(
      nodeBinary,
      ["-e", "process.stdout.write(JSON.stringify({node:process.versions.node,bun:process.versions.bun??null}))"],
      { encoding: "utf8" },
    );
    expect(probe.status, probe.stderr).toBe(0);
    const identity = JSON.parse(probe.stdout) as { node: string; bun: string | null };
    expect(identity.bun).toBeNull();
    expect(Number(identity.node.split(".")[0])).toBeGreaterThanOrEqual(minimumNodeMajor);
  });

  test("package manifest is the sole engine version and packed provenance matches it", () => {
    const rootManifest = JSON.parse(
      readFileSync(join(repositoryRoot, "package.json"), "utf8"),
    ) as { version: string; workspaces?: unknown };
    expect(rootManifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageVersion).toBe(rootManifest.version);
    expect(rootManifest.workspaces).toBeUndefined();

    for (const directory of ["cli", "adapters", "installer", "schemas"]) {
      expect(existsSync(join(repositoryRoot, directory, "package.json"))).toBe(false);
    }

    const home = isolatedHome();
    expect(runCli(home, ["init"]).status).toBe(0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    const projectPath = project();
    writeBindings(home, [{ project: projectPath, hosts: ["codex"] }]);

    expect(runCli(home, ["apply"]).status).toBe(0);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{ engine_version: string; adapter_version: string }>;
    };
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.engine_version).toBe(packageVersion);
    expect(state.installations[0]?.adapter_version).toBe("codex-project-v1");
  });

  test("installing the package alone changes no Workspace, Local Configuration, project, Git, or Host state", () => {
    const home = isolatedHome();
    const plainProject = project();
    writeFileSync(join(plainProject, "README.md"), "untouched\n");
    const gitProject = gitRepository("agent-profile-kit-rc-install-git-");
    const gitHeadBefore = execFileSync("git", ["-C", gitProject, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const gitStatusBefore = execFileSync("git", ["-C", gitProject, "status", "--porcelain"], {
      encoding: "utf8",
    });

    const packedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      os?: string[];
      files?: string[];
      bin?: Record<string, string>;
    };
    expect(packedManifest.scripts?.postinstall).toBeUndefined();
    expect(packedManifest.scripts?.preinstall).toBeUndefined();
    expect(packedManifest.scripts?.install).toBeUndefined();
    expect(packedManifest.scripts?.prepare).toBeUndefined();
    expect(packedManifest.os).toEqual(["darwin"]);
    expect(packedManifest.files).toEqual(["dist/cli.js", "docs/guides", "README.md"]);
    expect(packedManifest.bin?.["agent-profile-kit"]).toBe("./dist/cli.js");

    // Dry-run inspection of a clean pack does not write under an isolated HOME.
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });

    // Install the packed tarball into a disposable prefix only — not the user HOME.
    const installPrefix = mkdtempSync(join(tmpdir(), "agent-profile-kit-rc-prefix-"));
    temporaryDirectories.push(installPrefix);
    execFileSync("npm", ["install", "--prefix", installPrefix, packageArchive], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
      stdio: "pipe",
    });
    expect(existsSync(join(installPrefix, "node_modules", "agent-profile-kit", "dist", "cli.js")))
      .toBe(true);

    const installedCli = join(installPrefix, "node_modules", "agent-profile-kit", "dist", "cli.js");
    const guide = spawnSync(nodeBinary, [installedCli, "guide"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    expect(guide.status, guide.stderr).toBe(0);

    expect(existsSync(workspacePath(home))).toBe(false);
    expect(existsSync(configPath(home))).toBe(false);
    expect(existsSync(join(home, ".agents", "agent-profile-kit", "state"))).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(readFileSync(join(plainProject, "README.md"), "utf8")).toBe("untouched\n");
    expect(execFileSync("git", ["-C", gitProject, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
      .toBe(gitHeadBefore);
    expect(
      execFileSync("git", ["-C", gitProject, "status", "--porcelain"], { encoding: "utf8" }),
    ).toBe(gitStatusBefore);
  });

  test("packed distribution excludes credentials, runtime state, and removed overlay commands", () => {
    // Exact file allowlist lives only in release-boundary.test.ts.
    const packageText = filesUnder(packageRoot)
      .map((path) => readFileSync(join(packageRoot, path), "utf8"))
      .join("\n");

    expect(packageText).not.toMatch(/BEGIN (RSA |OPENSSH )?PRIVATE KEY|api[_-]?key\s*[:=]/i);
    expect(packageText).not.toMatch(/agent-profile-kit (plan|install|update|run)\b/);
    expect(packageText).not.toMatch(/per-session launcher|global Skill projection|process[- ]overlay/i);
    expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
    expect(existsSync(join(packageRoot, "test"))).toBe(false);
    expect(existsSync(join(packageRoot, ".agents"))).toBe(false);
    expect(existsSync(join(packageRoot, "state"))).toBe(false);
  });

  test("packed CLI acceptance journey covers Codex-only, Claude-only, combined, Git worktree, and non-Git shapes", () => {
    const home = isolatedHome();
    const init = runCli(home, ["init"]);
    expect(init.status, init.stderr).toBe(0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);

    const nonGitCodex = project("agent-profile-kit-rc-nongit-");
    const claudeOnly = project("agent-profile-kit-rc-claude-");
    const combined = project("agent-profile-kit-rc-combined-");
    const gitRoot = gitRepository();
    const existingWorktree = addWorktree(gitRoot, "rc-existing-worktree");
    const pathWithClaude = installFakeClaude(home);

    writeBindings(home, [
      { project: nonGitCodex, hosts: ["codex"] },
      { project: claudeOnly, hosts: ["claude"] },
      { project: combined, hosts: ["codex", "claude"] },
      { project: gitRoot, hosts: ["codex"] },
    ]);

    const validate = runCli(home, ["validate"], { path: pathWithClaude });
    expect(validate.status, validate.stderr).toBe(0);

    const preview = runCli(home, ["preview"], { path: pathWithClaude });
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(nonGitCodex);
    expect(preview.stdout).toContain(claudeOnly);
    expect(preview.stdout).toContain(combined);
    expect(preview.stdout).toContain(realpathSync(gitRoot));
    expect(preview.stdout).toContain(realpathSync(existingWorktree));
    expect(preview.stdout).toContain("Codex must start at the exact bound project root");

    const apply = runCli(home, ["apply"], { path: pathWithClaude });
    expect(apply.status, apply.stderr).toBe(0);

    expect(existsSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(claudeOnly, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(combined, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(combined, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(gitRoot, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "codex", "context.md"))).toBe(
      true,
    );

    const statusCurrent = runCli(home, ["status"], { path: pathWithClaude });
    expect(statusCurrent.status, statusCurrent.stderr).toBe(0);
    expect(statusCurrent.stdout).toMatch(/current/i);

    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated release-candidate Context.\n",
    );
    const staleStatus = runCli(home, ["status"], { path: pathWithClaude });
    expect(staleStatus.status, staleStatus.stderr).toBe(0);
    expect(staleStatus.stdout).toMatch(/stale/i);

    const reapply = runCli(home, ["apply"], { path: pathWithClaude });
    expect(reapply.status, reapply.stderr).toBe(0);
    expect(
      readFileSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"), "utf8"),
    ).toContain("Updated release-candidate Context.");
    expect(
      readFileSync(join(claudeOnly, ".claude", "rules", "agent-profile-kit.md"), "utf8"),
    ).toContain("Updated release-candidate Context.");

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{
        engine_version: string;
        hosts: string[];
        host_versions: Record<string, string>;
        project: string;
      }>;
    };
    expect(state.installations.every((installation) => installation.engine_version === packageVersion))
      .toBe(true);
    const combinedInstallation = state.installations.find((installation) =>
      installation.hosts.includes("claude") && installation.hosts.includes("codex"),
    );
    expect(combinedInstallation?.host_versions.claude).toBe(
      "native-project-unscoped-rules-skills-v1",
    );
    expect(combinedInstallation?.host_versions.codex).toBe("native-project-sessionstart-v1");

    // Binding removal: drop Claude-only and combined; keep non-Git Codex and Git root.
    writeBindings(home, [
      { project: nonGitCodex, hosts: ["codex"] },
      { project: gitRoot, hosts: ["codex"] },
    ]);
    const removeApply = runCli(home, ["apply"], { path: pathWithClaude });
    expect(removeApply.status, removeApply.stderr).toBe(0);
    expect(existsSync(join(claudeOnly, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(combined, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(combined, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(gitRoot, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "codex", "context.md"))).toBe(
      true,
    );

    const uninstall = runCli(home, ["uninstall"], { path: pathWithClaude });
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(gitRoot, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "codex", "context.md"))).toBe(
      false,
    );
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(existsSync(configPath(home))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain(nonGitCodex);
  });

  test("unsupported artifact categories, Host versions, Hosts, and project surfaces fail before writes", () => {
    const home = isolatedHome();
    expect(runCli(home, ["init"]).status).toBe(0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    const projectPath = project();

    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\nagents: [reviewer]\nhooks: []\ntools: []\n",
    );
    writeBindings(home, [{ project: projectPath, hosts: ["codex"] }]);
    const unsupportedAgents = runCli(home, ["apply"]);
    expect(unsupportedAgents.status).toBe(1);
    expect(unsupportedAgents.stderr).toMatch(/agents.*this release does not support/i);
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);

    writeWorkspaceAuthoring(home);
    writeBindings(home, [{ project: projectPath, hosts: ["cursor"] }]);
    const unsupportedHost = runCli(home, ["apply"]);
    expect(unsupportedHost.status).toBe(1);
    expect(unsupportedHost.stderr).toContain("unsupported Agent Host 'cursor'");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);

    writeBindings(home, [{ project: projectPath, hosts: ["claude"] }]);
    const oldClaudePath = (() => {
      const bin = join(home, "old-claude-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "claude"), "#!/bin/sh\necho \"2.0.0 (Claude Code)\"\n");
      execFileSync("chmod", ["+x", join(bin, "claude")]);
      return `${bin}:${process.env.PATH ?? ""}`;
    })();
    const oldClaude = runCli(home, ["apply"], { path: oldClaudePath });
    expect(oldClaude.status).toBe(1);
    expect(`${oldClaude.stdout}${oldClaude.stderr}`).toMatch(
      /does not support unscoped project rules|requires 2\.0\.64/i,
    );
    expect(existsSync(join(projectPath, ".claude"))).toBe(false);

    // Non-directory Host project surface fails closed before writes.
    writeFileSync(join(projectPath, ".claude"), "not a directory\n");
    const goodClaudePath = installFakeClaude(home);
    const surface = runCli(home, ["apply"], { path: goodClaudePath });
    expect(surface.status).toBe(1);
    expect(`${surface.stdout}${surface.stderr}`).toMatch(/\.claude/i);
    expect(readFileSync(join(projectPath, ".claude"), "utf8")).toBe("not a directory\n");
    expect(existsSync(join(projectPath, ".claude", "rules"))).toBe(false);
  });
});
