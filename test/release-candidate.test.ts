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

/**
 * Prepend controlled Host CLI stubs on PATH so packed RC gates stay hermetic
 * (no ambient Codex/Claude versions). Disabled model-invocation requires Codex ≥0.99.
 */
function installControlledHosts(
  home: string,
  options: {
    readonly claudeVersion?: string;
    readonly codexVersion?: string;
    readonly piVersion?: string;
  } = {},
): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const claudeVersion = options.claudeVersion ?? "2.1.0";
  const codexVersion = options.codexVersion ?? "0.99.0";
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "${claudeVersion} (Claude Code)"\n`);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex-cli ${codexVersion}"\n`);
  const executables = [join(bin, "claude"), join(bin, "codex")];
  if (options.piVersion !== undefined) {
    writeFileSync(join(bin, "pi"), `#!/bin/sh\necho "pi ${options.piVersion}"\n`);
    executables.push(join(bin, "pi"));
  }
  execFileSync("chmod", ["+x", ...executables]);
  return `${bin}:${process.env.PATH ?? ""}`;
}

function installFakeClaude(home: string, version = "2.1.0"): string {
  return installControlledHosts(home, { claudeVersion: version });
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

function writeSkill(
  home: string,
  skillId: string,
  options: {
    readonly description?: string;
    readonly modelInvocation?: "allowed" | "disabled" | "absent";
    readonly body?: string;
  } = {},
): void {
  const skillRoot = join(workspacePath(home), "skills", skillId);
  mkdirSync(skillRoot, { recursive: true });
  const description = options.description ?? `Skill ${skillId}.`;
  const body = options.body ?? `# ${skillId}\n`;
  let frontmatter = `---\nname: ${skillId}\ndescription: ${description}\n`;
  if (options.modelInvocation === "disabled" || options.modelInvocation === "allowed") {
    frontmatter += `metadata:\n  agent-profile-kit.model-invocation: ${options.modelInvocation}\n`;
  }
  frontmatter += "---\n\n";
  writeFileSync(join(skillRoot, "SKILL.md"), frontmatter + body);
}

function writeProfile(
  home: string,
  profileId: string,
  options: { readonly context?: readonly string[]; readonly skills?: readonly string[] } = {},
): void {
  const context = options.context ?? [];
  const skills = options.skills ?? [];
  writeFileSync(
    join(workspacePath(home), "profiles", `${profileId}.yaml`),
    `id: ${profileId}\ncontext: [${context.join(", ")}]\nskills: [${skills.join(", ")}]\nagents: []\nhooks: []\ntools: []\n`,
  );
}

function writeBindings(
  home: string,
  bindings: readonly {
    readonly project: string;
    readonly hosts: readonly string[];
    readonly profile?: string;
  }[],
): void {
  const body = bindings
    .map(
      (binding) =>
        `  - project: ${binding.project}\n    profile: ${binding.profile ?? "coding"}\n    hosts:\n${binding.hosts
          .map((host) => `      - ${host}`)
          .join("\n")}\n`,
    )
    .join("");
  writeFileSync(
    configPath(home),
    bindings.length === 0
      ? `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`
      : `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n${body}`,
  );
}

function writeGlobalSkill(root: string, skillId: string, body?: string): string {
  const packagePath = join(root, skillId);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    body ??
      `---\nname: ${skillId}\ndescription: Global skill ${skillId}.\n---\n\n# ${skillId}\n`,
  );
  return packagePath;
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

  test("packed CLI acceptance journey covers exact-root and explicit-checkout lifecycles", () => {
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
    writeProfile(home, "review", { context: ["team-rules"] });

    writeBindings(home, [
      { project: nonGitCodex, hosts: ["codex"] },
      { project: claudeOnly, hosts: ["claude"] },
      { project: combined, hosts: ["codex", "claude"] },
      { project: gitRoot, hosts: ["codex"] },
    ]);

    const validate = runCli(home, ["validate"], { path: pathWithClaude });
    expect(validate.status, validate.stderr).toBe(0);

    const preview = runCli(home, ["preview", "--verbose"], { path: pathWithClaude });
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(nonGitCodex);
    expect(preview.stdout).toContain(claudeOnly);
    expect(preview.stdout).toContain(combined);
    expect(preview.stdout).toContain(gitRoot);
    expect(preview.stdout).not.toContain(existingWorktree);
    expect(preview.stdout).toContain("Codex must start at the exact bound project root");

    const apply = runCli(home, ["apply"], { path: pathWithClaude });
    expect(apply.status, apply.stderr).toBe(0);

    expect(existsSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(claudeOnly, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(combined, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(combined, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(gitRoot, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(existingWorktree, ".codex"))).toBe(false);

    const statusCurrent = runCli(home, ["status", "--verbose"], { path: pathWithClaude });
    expect(statusCurrent.status, statusCurrent.stderr).toBe(0);
    expect(statusCurrent.stdout).toContain(`${gitRoot}: current`);
    expect(statusCurrent.stdout).not.toContain(existingWorktree);

    writeBindings(home, [
      { project: nonGitCodex, hosts: ["codex"] },
      { project: claudeOnly, hosts: ["claude"] },
      { project: combined, hosts: ["codex", "claude"] },
      { project: gitRoot, hosts: ["codex"] },
      { project: existingWorktree, profile: "review", hosts: ["claude"] },
    ]);

    const explicitPreview = runCli(home, ["preview", "--verbose"], { path: pathWithClaude });
    expect(explicitPreview.status, explicitPreview.stderr).toBe(0);
    expect(explicitPreview.stdout).toContain(`${existingWorktree}: Profile review`);

    const explicitApply = runCli(home, ["apply"], { path: pathWithClaude });
    expect(explicitApply.status, explicitApply.stderr).toBe(0);
    expect(existsSync(join(existingWorktree, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "codex", "context.md"))).toBe(false);

    const explicitStatus = runCli(home, ["status", "--verbose"], { path: pathWithClaude });
    expect(explicitStatus.status, explicitStatus.stderr).toBe(0);
    expect(explicitStatus.stdout).toContain(`${existingWorktree}: current`);

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

    // Binding removal: drop Claude-only, combined, and the explicit linked checkout.
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
    expect(existsSync(join(existingWorktree, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const uninstall = runCli(home, ["uninstall"], { path: pathWithClaude });
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(gitRoot, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(existsSync(configPath(home))).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).toContain(nonGitCodex);
  }, 15_000);

  test("packed CLI installs Pi Context, records its Capability Contract, and fails closed on unsupported Pi", () => {
    const home = isolatedHome();
    expect(runCli(home, ["init"]).status).toBe(0);
    writeWorkspaceAuthoring(home);
    const projectPath = project("agent-profile-kit-rc-pi-");
    const combinedProject = project("agent-profile-kit-rc-pi-combined-");
    const trustPath = join(home, ".pi", "agent", "trust.json");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(trustPath, `{"${projectPath}":true,"${combinedProject}":false}\n`);
    mkdirSync(join(projectPath, ".pi"), { recursive: true });
    writeFileSync(join(projectPath, ".pi", "settings.json"), "native settings\n");
    mkdirSync(join(combinedProject, ".pi"), { recursive: true });
    writeFileSync(join(combinedProject, ".pi", "settings.json"), "combined native settings\n");
    writeBindings(home, [
      { project: projectPath, hosts: ["pi"] },
      { project: combinedProject, hosts: ["pi", "claude"] },
    ]);

    const supportedPath = installControlledHosts(home, { piVersion: "0.82.1" });
    const preview = runCli(home, ["preview"], { path: supportedPath });
    expect(preview.status, preview.stderr).toBe(0);
    const apply = runCli(home, ["apply"], { path: supportedPath });
    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    expect(existsSync(join(combinedProject, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    expect(existsSync(join(combinedProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{
        hosts: string[];
        host_versions: Record<string, string>;
        adapter_version: string;
      }>;
    };
    expect(state.installations).toHaveLength(2);
    const piOnlyInstallation = state.installations.find((installation) =>
      installation.hosts.length === 1 && installation.hosts[0] === "pi",
    );
    expect(piOnlyInstallation?.adapter_version).toBe("pi-project-v1");
    expect(piOnlyInstallation?.host_versions.pi).toBe("native-project-append-system-v1");
    const combinedInstallation = state.installations.find((installation) =>
      installation.hosts.join(",") === "claude,pi",
    );
    expect(combinedInstallation?.adapter_version).toBe("claude-project-v1+pi-project-v1");
    expect(combinedInstallation?.host_versions.pi).toBe("native-project-append-system-v1");
    expect(combinedInstallation?.host_versions.claude).toBe("native-project-unscoped-rules-skills-v1");

    const status = runCli(home, ["status"], { path: supportedPath });
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toMatch(/current/i);

    writeBindings(home, []);
    const remove = runCli(home, ["apply"], { path: supportedPath });
    expect(remove.status, remove.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".pi", "APPEND_SYSTEM.md"))).toBe(false);
    expect(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")).toBe("native settings\n");
    expect(existsSync(join(combinedProject, ".pi", "APPEND_SYSTEM.md"))).toBe(false);
    expect(existsSync(join(combinedProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(readFileSync(join(combinedProject, ".pi", "settings.json"), "utf8")).toBe("combined native settings\n");
    expect(readFileSync(trustPath, "utf8")).toBe(`{"${projectPath}":true,"${combinedProject}":false}\n`);

    const unsupportedHome = isolatedHome();
    expect(runCli(unsupportedHome, ["init"]).status).toBe(0);
    writeWorkspaceAuthoring(unsupportedHome);
    const unsupportedProject = project("agent-profile-kit-rc-pi-old-");
    writeBindings(unsupportedHome, [{ project: unsupportedProject, hosts: ["pi"] }]);
    const oldPath = installControlledHosts(unsupportedHome, { piVersion: "0.82.0" });
    const oldPreview = runCli(unsupportedHome, ["preview"], { path: oldPath });
    expect(oldPreview.status).toBe(1);
    expect(`${oldPreview.stdout}${oldPreview.stderr}`).toMatch(/Pi CLI.*requires 0\.82\.1\+/i);
    expect(existsSync(join(unsupportedProject, ".pi"))).toBe(false);

    const missingHome = isolatedHome();
    expect(runCli(missingHome, ["init"]).status).toBe(0);
    writeWorkspaceAuthoring(missingHome);
    const missingProject = project("agent-profile-kit-rc-pi-missing-");
    writeBindings(missingHome, [{ project: missingProject, hosts: ["pi"] }]);
    installControlledHosts(missingHome);
    const noPiPath = join(missingHome, "bin");
    const missingPreview = runCli(missingHome, ["preview"], { path: noPiPath });
    expect(missingPreview.status).toBe(1);
    expect(`${missingPreview.stdout}${missingPreview.stderr}`).toMatch(/Pi CLI was not found/i);
    expect(existsSync(join(missingProject, ".pi"))).toBe(false);
  });

  test("packed CLI installs Pi Skills with the non-invocation Capability Contract", () => {
    const home = isolatedHome();
    expect(runCli(home, ["init"]).status).toBe(0);
    writeWorkspaceAuthoring(home);
    writeSkill(home, "review-pr", { body: "# Review\n" });
    writeProfile(home, "coding", { context: ["team-rules"], skills: ["review-pr"] });
    const projectPath = project("agent-profile-kit-rc-pi-skills-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(projectPath, ".pi"), { recursive: true });
    const globalSettings = '{"packages":["npm:team-theme"]}\n';
    const projectSettings =
      '{"packages":[{"source":"npm:team-theme","skills":[],"extensions":[],"themes":["dark.json"]}]}\n';
    writeFileSync(join(home, ".pi", "agent", "settings.json"), globalSettings);
    writeFileSync(join(projectPath, ".pi", "settings.json"), projectSettings);
    writeBindings(home, [{ project: projectPath, hosts: ["pi"] }]);

    const supportedPath = installControlledHosts(home, { piVersion: "0.82.1" });
    const preview = runCli(home, ["preview", "--verbose"], { path: supportedPath });
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toMatch(/\.pi\/skills\/review-pr|review-pr/i);
    const apply = runCli(home, ["apply"], { path: supportedPath });
    expect(apply.status, apply.stderr).toBe(0);
    expect(readFileSync(join(projectPath, ".pi", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "name: review-pr",
    );
    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{
        host_versions: Record<string, string>;
        resolved_artifacts: Array<{ id: string; type: string }>;
      }>;
    };
    expect(state.installations[0]?.host_versions.pi).toBe("native-project-append-system-skills-v1");
    expect(state.installations[0]?.resolved_artifacts.some((artifact) => artifact.id === "review-pr" && artifact.type === "skill")).toBe(true);
    expect(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8")).toBe(globalSettings);
    expect(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")).toBe(projectSettings);

    const dynamicSettings = '{"extensions":["./dynamic.ts"]}\n';
    writeFileSync(join(projectPath, ".pi", "settings.json"), dynamicSettings);
    const blockedStatus = runCli(home, ["status"], { path: supportedPath });
    expect(blockedStatus.status, blockedStatus.stderr).toBe(0);
    expect(`${blockedStatus.stdout}${blockedStatus.stderr}`).toMatch(/Pi Skill project settings.*dynamic\.ts/i);
    expect(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")).toBe(dynamicSettings);
    expect(readFileSync(join(projectPath, ".pi", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "name: review-pr",
    );
  });

  test("packed CLI projects mixed Pi invocation policies with independent Skills-only and combined contracts", () => {
    const home = isolatedHome();
    expect(runCli(home, ["init"]).status).toBe(0);
    writeWorkspaceAuthoring(home);
    writeSkill(home, "allowed-skill", { modelInvocation: "allowed", body: "# Allowed\n" });
    writeSkill(home, "explicit-skill", { modelInvocation: "disabled", body: "# Explicit\n" });
    writeProfile(home, "skills-only", { skills: ["allowed-skill", "explicit-skill"] });
    writeProfile(home, "combined", {
      context: ["team-rules"],
      skills: ["allowed-skill", "explicit-skill"],
    });

    const skillsOnlyProject = project("agent-profile-kit-rc-pi-invocation-skills-only-");
    const combinedProject = project("agent-profile-kit-rc-pi-invocation-combined-");
    writeBindings(home, [
      { project: skillsOnlyProject, profile: "skills-only", hosts: ["pi"] },
      { project: combinedProject, profile: "combined", hosts: ["pi", "claude"] },
    ]);
    const canonicalSource = readFileSync(
      join(workspacePath(home), "skills", "explicit-skill", "SKILL.md"),
      "utf8",
    );

    const supportedPath = installControlledHosts(home, { piVersion: "0.82.1" });
    const preview = runCli(home, ["preview"], { path: supportedPath });
    expect(preview.status, preview.stderr).toBe(0);
    const apply = runCli(home, ["apply"], { path: supportedPath });
    expect(apply.status, apply.stderr).toBe(0);

    const generatedSkillsOnly = readFileSync(
      join(skillsOnlyProject, ".pi", "skills", "explicit-skill", "SKILL.md"),
      "utf8",
    );
    const generatedCombined = readFileSync(
      join(combinedProject, ".pi", "skills", "explicit-skill", "SKILL.md"),
      "utf8",
    );
    expect(generatedSkillsOnly).toContain("name: explicit-skill");
    expect(generatedSkillsOnly).toContain("disable-model-invocation: true");
    expect(generatedCombined).toContain("name: explicit-skill");
    expect(generatedCombined).toContain("disable-model-invocation: true");
    expect(readFileSync(join(skillsOnlyProject, ".pi", "skills", "allowed-skill", "SKILL.md"), "utf8")).toContain(
      "name: allowed-skill",
    );
    expect(readFileSync(join(skillsOnlyProject, ".pi", "skills", "allowed-skill", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
    expect(readFileSync(join(workspacePath(home), "skills", "explicit-skill", "SKILL.md"), "utf8")).toBe(
      canonicalSource,
    );

    const state = parse(readFileSync(statePath(home), "utf8")) as {
      installations: Array<{
        hosts: string[];
        host_versions: Record<string, string>;
      }>;
    };
    const skillsOnlyInstallation = state.installations.find(
      (installation) => installation.hosts.join(",") === "pi",
    );
    expect(skillsOnlyInstallation?.host_versions.pi).toBe("native-project-skills-invocation-v1");
    const combinedInstallation = state.installations.find(
      (installation) => installation.hosts.join(",") === "claude,pi",
    );
    expect(combinedInstallation?.host_versions.pi).toBe(
      "native-project-append-system-skills-invocation-v1",
    );

    const unsupportedHome = isolatedHome();
    expect(runCli(unsupportedHome, ["init"]).status).toBe(0);
    writeWorkspaceAuthoring(unsupportedHome);
    writeSkill(unsupportedHome, "explicit-skill", { modelInvocation: "disabled" });
    writeProfile(unsupportedHome, "coding", { skills: ["explicit-skill"] });
    const unsupportedProject = project("agent-profile-kit-rc-pi-invocation-old-");
    writeBindings(unsupportedHome, [{ project: unsupportedProject, hosts: ["pi"] }]);
    const oldPath = installControlledHosts(unsupportedHome, { piVersion: "0.82.0" });
    const oldPreview = runCli(unsupportedHome, ["preview"], { path: oldPath });
    expect(oldPreview.status).toBe(1);
    expect(`${oldPreview.stdout}${oldPreview.stderr}`).toMatch(/Pi CLI.*requires 0\.82\.1\+/i);
    expect(existsSync(join(unsupportedProject, ".pi"))).toBe(false);

    const malformedHome = isolatedHome();
    expect(runCli(malformedHome, ["init"]).status).toBe(0);
    writeWorkspaceAuthoring(malformedHome);
    writeSkill(malformedHome, "explicit-skill", { modelInvocation: "disabled" });
    writeProfile(malformedHome, "coding", { skills: ["explicit-skill"] });
    writeFileSync(
      join(workspacePath(malformedHome), "skills", "explicit-skill", "SKILL.md"),
      "---\nname: [\n---\n# malformed\n",
    );
    const malformedProject = project("agent-profile-kit-rc-pi-invocation-malformed-");
    writeBindings(malformedHome, [{ project: malformedProject, hosts: ["pi"] }]);
    const malformedPath = installControlledHosts(malformedHome, { piVersion: "0.82.1" });
    const malformedPreview = runCli(malformedHome, ["preview"], { path: malformedPath });
    expect(malformedPreview.status).toBe(1);
    expect(`${malformedPreview.stdout}${malformedPreview.stderr}`).toMatch(/invalid YAML|frontmatter/i);
    expect(existsSync(join(malformedProject, ".pi"))).toBe(false);
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

  test("packed CLI translates absent and disabled model-invocation policy for Codex-only, Claude-only, and combined bindings", () => {
    const home = isolatedHome();
    expect(runCli(home, ["init"]).status).toBe(0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    writeSkill(home, "plain-skill", { modelInvocation: "absent" });
    writeSkill(home, "to-spec", { modelInvocation: "disabled" });
    writeProfile(home, "coding", { context: ["team-rules"], skills: ["plain-skill"] });

    const codexOnly = project("agent-profile-kit-rc-mi-codex-");
    const claudeOnly = project("agent-profile-kit-rc-mi-claude-");
    const combined = project("agent-profile-kit-rc-mi-combined-");
    // Controlled Codex stub (≥0.99) required once disabled model-invocation is selected.
    const pathWithHosts = installControlledHosts(home);

    writeBindings(home, [
      { project: codexOnly, hosts: ["codex"] },
      { project: claudeOnly, hosts: ["claude"] },
      { project: combined, hosts: ["codex", "claude"] },
    ]);

    const absentValidate = runCli(home, ["validate"], { path: pathWithHosts });
    expect(absentValidate.status, absentValidate.stderr).toBe(0);
    const absentApply = runCli(home, ["apply"], { path: pathWithHosts });
    expect(absentApply.status, absentApply.stderr).toBe(0);

    // Absent policy installs as allowed: no Host restriction fields on any binding.
    expect(existsSync(join(codexOnly, ".agents", "skills", "plain-skill", "agents", "openai.yaml"))).toBe(
      false,
    );
    expect(
      readFileSync(join(claudeOnly, ".claude", "skills", "plain-skill", "SKILL.md"), "utf8"),
    ).not.toContain("disable-model-invocation");
    expect(
      readFileSync(join(combined, ".claude", "skills", "plain-skill", "SKILL.md"), "utf8"),
    ).not.toContain("disable-model-invocation");
    expect(existsSync(join(combined, ".agents", "skills", "plain-skill", "agents", "openai.yaml"))).toBe(
      false,
    );

    // Switch to disabled Skill and re-apply for Host-native translation.
    writeProfile(home, "coding", { context: ["team-rules"], skills: ["to-spec"] });
    const disabledApply = runCli(home, ["apply"], { path: pathWithHosts });
    expect(disabledApply.status, disabledApply.stderr).toBe(0);

    const codexPolicy = parse(
      readFileSync(join(codexOnly, ".agents", "skills", "to-spec", "agents", "openai.yaml"), "utf8"),
    ) as { policy: { allow_implicit_invocation: boolean } };
    expect(codexPolicy.policy.allow_implicit_invocation).toBe(false);

    expect(
      readFileSync(join(claudeOnly, ".claude", "skills", "to-spec", "SKILL.md"), "utf8"),
    ).toContain("disable-model-invocation: true");

    const combinedCodexPolicy = parse(
      readFileSync(join(combined, ".agents", "skills", "to-spec", "agents", "openai.yaml"), "utf8"),
    ) as { policy: { allow_implicit_invocation: boolean } };
    expect(combinedCodexPolicy.policy.allow_implicit_invocation).toBe(false);
    expect(
      readFileSync(join(combined, ".claude", "skills", "to-spec", "SKILL.md"), "utf8"),
    ).toContain("disable-model-invocation: true");

    // Canonical Workspace source is never rewritten.
    expect(readFileSync(join(workspacePath(home), "skills", "to-spec", "SKILL.md"), "utf8")).toContain(
      "agent-profile-kit.model-invocation: disabled",
    );
    expect(readFileSync(join(workspacePath(home), "skills", "to-spec", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
  });

  test("packed CLI Skills-only Profile covers validate through source update, binding removal, and uninstall without Context machinery", () => {
    const home = isolatedHome();
    // Skills-only must not require Codex SessionStart hooks configuration.
    expect(runCli(home, ["init"]).status).toBe(0);
    writeSkill(home, "review-pr");
    writeProfile(home, "engineering", { skills: ["review-pr"] });

    const projectPath = project("agent-profile-kit-rc-skills-only-");
    const secondProject = project("agent-profile-kit-rc-skills-only-b-");
    const pathWithClaude = installFakeClaude(home);
    writeBindings(home, [
      { project: projectPath, hosts: ["codex", "claude"], profile: "engineering" },
      { project: secondProject, hosts: ["codex"], profile: "engineering" },
    ]);

    const validate = runCli(home, ["validate"], { path: pathWithClaude });
    expect(validate.status, validate.stderr).toBe(0);

    const preview = runCli(home, ["preview", "--verbose"], { path: pathWithClaude });
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain(".agents/skills/review-pr");
    expect(preview.stdout).toContain(".claude/skills/review-pr");
    expect(preview.stdout).not.toContain(".agent-profile-kit/codex/context.md");
    expect(preview.stdout).not.toContain(".codex/hooks.json");
    expect(preview.stdout).not.toContain(".claude/rules/agent-profile-kit.md");

    const apply = runCli(home, ["apply"], { path: pathWithClaude });
    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(secondProject, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const statusCurrent = runCli(home, ["status"], { path: pathWithClaude });
    expect(statusCurrent.status, statusCurrent.stderr).toBe(0);
    expect(statusCurrent.stdout).toMatch(/current/i);

    // Source update: change Skill body and re-apply.
    writeSkill(home, "review-pr", { body: "# Review updated for release candidate\n" });
    const staleStatus = runCli(home, ["status"], { path: pathWithClaude });
    expect(staleStatus.status, staleStatus.stderr).toBe(0);
    expect(staleStatus.stdout).toMatch(/stale/i);
    const reapply = runCli(home, ["apply"], { path: pathWithClaude });
    expect(reapply.status, reapply.stderr).toBe(0);
    expect(
      readFileSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"), "utf8"),
    ).toContain("updated for release candidate");
    expect(
      readFileSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"), "utf8"),
    ).toContain("updated for release candidate");

    // Binding removal: drop second project only.
    writeBindings(home, [
      { project: projectPath, hosts: ["codex", "claude"], profile: "engineering" },
    ]);
    const removeApply = runCli(home, ["apply"], { path: pathWithClaude });
    expect(removeApply.status, removeApply.stderr).toBe(0);
    expect(existsSync(join(secondProject, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);

    const uninstall = runCli(home, ["uninstall"], { path: pathWithClaude });
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(existsSync(configPath(home))).toBe(true);
  });

  test("packed CLI fails closed on supported-Host global Skill identity collisions without global or project writes", () => {
    const home = isolatedHome();
    expect(runCli(home, ["init"]).status).toBe(0);
    // No Codex hooks: Skills-only Profile must still hit global preflight without Context capability.
    writeSkill(home, "review-pr");
    writeProfile(home, "engineering", { skills: ["review-pr"] });

    const codexProject = join(home, "rc-global-codex");
    mkdirSync(codexProject);
    const codexAltProject = project("agent-profile-kit-rc-global-codex-alt-");
    const claudeProject = project("agent-profile-kit-rc-global-claude-");
    const pathWithHosts = installControlledHosts(home);
    writeBindings(home, [
      { project: "~/rc-global-codex", hosts: ["codex"], profile: "engineering" },
      { project: codexAltProject, hosts: ["codex"], profile: "engineering" },
      { project: claudeProject, hosts: ["claude"], profile: "engineering" },
    ]);

    // All supported personal/global roots: Codex ~/.agents/skills + ~/.codex/skills, Claude ~/.claude/skills.
    const agentsGlobal = writeGlobalSkill(join(home, ".agents", "skills"), "review-pr");
    const codexGlobal = writeGlobalSkill(join(home, ".codex", "skills"), "review-pr");
    const claudeGlobal = writeGlobalSkill(join(home, ".claude", "skills"), "review-pr");
    const agentsGlobalBody = readFileSync(join(agentsGlobal, "SKILL.md"), "utf8");
    const codexGlobalBody = readFileSync(join(codexGlobal, "SKILL.md"), "utf8");
    const claudeGlobalBody = readFileSync(join(claudeGlobal, "SKILL.md"), "utf8");

    const preview = runCli(home, ["preview"], { path: pathWithHosts });
    expect(preview.status).toBe(1);
    const previewText = `${preview.stdout}${preview.stderr}`;
    expect(previewText).toMatch(/review-pr/);
    expect(previewText).toMatch(/Codex personal\/global Skill/);
    expect(previewText).toMatch(/Claude personal\/global Skill/);
    expect(previewText).toContain(agentsGlobal);
    expect(previewText).toContain(codexGlobal);
    expect(previewText).toContain(claudeGlobal);
    expect(previewText).toContain("would conflict with project snapshot at .agents/skills/review-pr");
    expect(previewText).toMatch(/remove or relocate/i);

    const apply = runCli(home, ["apply"], { path: pathWithHosts });
    expect(apply.status).toBe(1);
    expect(`${apply.stdout}${apply.stderr}`).toMatch(/Apply blocked|blocked before writes/i);

    // No project Skill trees written.
    expect(existsSync(join(codexProject, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(codexAltProject, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(claudeProject, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(codexProject, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(claudeProject, ".claude", "rules"))).toBe(false);

    // Global roots untouched (APK never mutates them).
    expect(readFileSync(join(agentsGlobal, "SKILL.md"), "utf8")).toBe(agentsGlobalBody);
    expect(readFileSync(join(codexGlobal, "SKILL.md"), "utf8")).toBe(codexGlobalBody);
    expect(readFileSync(join(claudeGlobal, "SKILL.md"), "utf8")).toBe(claudeGlobalBody);
    expect(existsSync(join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml"))).toBe(
      false,
    );
  });

  test("minimal and partial Workspaces prove optional scaffolding without weakening Manifest or artifact validation", () => {
    const home = isolatedHome();
    expect(runCli(home, ["init"]).status).toBe(0);
    enableCodexHooks(home);
    const workspace = workspacePath(home);

    // Strip scaffolding to a Manifest-only Workspace.
    for (const name of ["profiles", "context", "skills", "agents", "hooks", "tools", "README.md", "AGENTS.md", ".gitignore"]) {
      rmSync(join(workspace, name), { recursive: true, force: true });
    }
    expect(readdirSync(workspace).sort()).toEqual(["workspace.yaml"]);

    const minimalValidate = runCli(home, ["validate"]);
    expect(minimalValidate.status, minimalValidate.stderr).toBe(0);
    expect(minimalValidate.stdout).toContain("Workspace and Local Configuration valid");

    // Re-init must not restore optional scaffolding.
    expect(runCli(home, ["init"]).status).toBe(0);
    expect(readdirSync(workspace).sort()).toEqual(["workspace.yaml"]);

    // Partial Workspace: only profiles + skills present; other categories absent.
    mkdirSync(join(workspace, "skills", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    mkdirSync(join(workspace, "profiles"), { recursive: true });
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    expect(existsSync(join(workspace, "context"))).toBe(false);
    expect(existsSync(join(workspace, "agents"))).toBe(false);

    const partialValidate = runCli(home, ["validate"]);
    expect(partialValidate.status, partialValidate.stderr).toBe(0);
    expect(partialValidate.stdout).toMatch(/1 Profiles|Profiles/);

    // Present malformed artifacts still fail at ingestion (scaffolding optional ≠ validation weak).
    mkdirSync(join(workspace, "skills", "bad-skill"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "bad-skill", "SKILL.md"),
      "---\nname: bad-skill\ndescription: Missing closing frontmatter\n# Bad\n",
    );
    const badArtifact = runCli(home, ["validate"]);
    expect(badArtifact.status).toBe(1);
    expect(`${badArtifact.stdout}${badArtifact.stderr}`).toMatch(/skill|frontmatter|YAML|malformed/i);
    rmSync(join(workspace, "skills", "bad-skill"), { recursive: true, force: true });

    const projectPath = project("agent-profile-kit-rc-partial-");
    writeBindings(home, [
      { project: projectPath, hosts: ["codex"], profile: "engineering" },
    ]);
    const apply = runCli(home, ["apply"]);
    expect(apply.status, apply.stderr).toBe(0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);

    // Malformed Manifest still fails closed.
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 999\n");
    const malformed = runCli(home, ["validate"]);
    expect(malformed.status).toBe(1);
    expect(`${malformed.stdout}${malformed.stderr}`).toMatch(/schema|workspace\.yaml|unsupported/i);
  });

  test("packed human and agent guidance describe pre-v1 policy, Skills-only, universal ownership, and collision remediation", () => {
    const home = isolatedHome();
    const human = runCli(home, ["guide"]);
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/model-invocation|agent-profile-kit\.model-invocation/i);
    expect(human.stdout).toMatch(/disabled|allowed/i);
    expect(human.stdout).toMatch(/Skills-only|at least one supported artifact/i);
    expect(human.stdout).toMatch(/universal/i);
    expect(human.stdout).toMatch(/source ownership and managed delivery/i);
    expect(human.stdout).toMatch(/personal\/global|global Host/i);
    expect(human.stdout).toMatch(/fail closed|#53/i);
    expect(human.stdout).toMatch(/optional scaffolding|valid Workspace needs only/i);
    expect(human.stdout).toMatch(/schema_version: 2/);
    expect(human.stdout).toMatch(/required `workspace`|legacy.*migration/i);

    const agent = runCli(home, ["guide", "--agent"]);
    expect(agent.status, agent.stderr).toBe(0);
    expect(agent.stdout).toMatch(/agent-profile-kit\.model-invocation|model-invocation/i);
    expect(agent.stdout).toMatch(/Skills-only|at least one supported artifact/i);
    expect(agent.stdout).toMatch(/universal|unselected/i);
    expect(agent.stdout).toMatch(/global Skill|personal\/global|#53/i);
    expect(agent.stdout).toMatch(/optional scaffolding|workspace\.yaml/i);
    expect(agent.stdout).toMatch(/explicit Workspace path|legacy.*migration/i);
  });
});
