import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";

import { findFormerCommandInvocations } from "./support/current-command-guidance.js";
import {
  cleanupTemporaryDirectories,
  prepareDriftedFleet,
} from "./support/apply-confirmation-fixture.js";
import { installControlledHosts as installAllControlledHosts } from "./support/fleet-fixture.js";
import {
  controlledAllowlistBin,
  controlledEnvironment,
  controlledPath,
  createHostTrapBin,
  hostileAmbient,
} from "./support/controlled-environment.js";
import { humanText } from "./support/human-text.js";
import { fileTree } from "./support/file-tree.js";
import { expectElidedProjectLine } from "./support/project-line.js";
import { obtainPackageArchive, extractPackageArchive } from "./support/package-archive.js";
import {
  TEST_CHILD_DEADLINE_MS,
  expectExitCode,
  runProcess,
  type ProcessResult,
} from "../process/process-executor.js";
import { formatLifecycleJson } from "../cli/presentation.js";
import { applyReconciliation, ApplyDeclinedError } from "../installer/reconcile.js";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";
import { createLifecycleGitInspectionContext } from "../installer/lifecycle-git-inspection.js";
import { createProjectReadScheduler } from "../installer/project-scheduler.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { previewReconciliation } from "../installer/reconcile.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];
let packageArchiveCleanup = (): void => undefined;

/**
 * Parse the declared Node support line from package.json engines.node.
 * package.json is the sole supported-runtime home; this gate must not hardcode a major.
 * Supported forms: ">=MAJOR", ">=MAJOR.MINOR", ">=MAJOR.MINOR.PATCH", each with an
 * optional explicit upper bound "<MAJOR" that keeps the manifest from claiming
 * newer Node lines through an open-ended range (US-007, DEC-010).
 */
function declaredNodeLine(enginesNode: unknown): { major: number; upperMajor: number | null; range: string } {
  if (typeof enginesNode !== "string" || enginesNode.trim() === "") {
    throw new Error("package.json engines.node must be a non-empty string");
  }
  const range = enginesNode.trim();
  const match = /^(?:>=\s*)(\d+)(?:\.\d+)?(?:\.\d+)?(?:\s*<\s*(\d+))?$/.exec(range);
  if (!match?.[1]) {
    throw new Error(
      `package.json engines.node '${range}' cannot be interpreted by the release-candidate Node probe; use '>=MAJOR' (optionally with .MINOR or .MINOR.PATCH, and an explicit '<MAJOR' upper bound)`,
    );
  }
  const major = Number(match[1]);
  if (!Number.isInteger(major) || major < 1) {
    throw new Error(`package.json engines.node '${range}' has an invalid major version`);
  }
  const upperMajor = match[2] === undefined ? null : Number(match[2]);
  if (upperMajor !== null && (!Number.isInteger(upperMajor) || upperMajor <= major)) {
    throw new Error(
      `package.json engines.node '${range}' declares an upper bound that excludes the declared primary line`,
    );
  }
  return { major, upperMajor, range };
}

/**
 * Resolve a real Node.js executable for packed-CLI execution.
 * Never fall back to process.execPath under bun test — that would exercise Bun, not the declared runtime (ADR-0008).
 * Override with NODE_BINARY when the supported Node is not first on PATH.
 */
function resolveNodeBinary(minimumMajor: number, upperMajor: number | null, enginesRange: string): string {
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
    // The declared upper bound is qualified support, not an open promise: a
    // newer Node line is not claimed (US-007/DEC-010), so packed-CLI gates
    // refuse it instead of silently qualifying an undeclared environment.
    if (upperMajor !== null && major >= upperMajor) {
      throw new Error(
        `Resolved Node ${identity.node} at ${identity.execPath} is outside the declared Node line of package engines.node '${enginesRange}'; set NODE_BINARY to a Node executable on the declared line`,
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
let declaredUpperMajor: number | null = null;
let enginesNodeRange = "";

beforeAll(async () => {
  const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    engines?: { node?: unknown };
  };
  const requirement = declaredNodeLine(rootManifest.engines?.node);
  minimumNodeMajor = requirement.major;
  declaredUpperMajor = requirement.upperMajor;
  enginesNodeRange = requirement.range;
  nodeBinary = resolveNodeBinary(minimumNodeMajor, declaredUpperMajor, enginesNodeRange);

  const archive = await obtainPackageArchive(repositoryRoot, "agent-profile-kit-rc-pack-");
  packageArchive = archive.path;
  packageArchiveCleanup = archive.cleanup;
  const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-rc-packed-"));
  temporaryDirectories.push(extracted);

  await extractPackageArchive(archive.path, extracted);
  packageRoot = join(extracted, "package");
  const packedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
    engines?: { node?: unknown };
  };
  packageVersion = packedManifest.version;
  // Packed engines must match the repository source of truth used for the Node probe.
  const packedRequirement = declaredNodeLine(packedManifest.engines?.node);
  if (
    packedRequirement.major !== minimumNodeMajor ||
    packedRequirement.upperMajor !== declaredUpperMajor ||
    packedRequirement.range !== enginesNodeRange
  ) {
    throw new Error(
      `Packed package engines.node '${packedRequirement.range}' does not match repository engines.node '${enginesNodeRange}'`,
    );
  }
  cliPath = join(packageRoot, "dist", "cli.js");
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  packageArchiveCleanup();
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
  return join(home, "apkit-workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function statePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state", "manifest.json");
}

function withFleetScope(arguments_: readonly string[]): readonly string[] {
  const [command, ...rest] = arguments_;
  const hasPositional = rest.some((arg) => !arg.startsWith("-"));
  return (command === "update" || command === "status") && !rest.includes("--all") && !hasPositional
    ? [...arguments_, "--all"]
    : arguments_;
}

async function runCli(
  home: string,
  arguments_: readonly string[],
  options: { readonly path?: string; readonly deadlineMs?: number; readonly cwd?: string } = {},
) {
  return runProcess({
    executable: nodeBinary,
    arguments_: [cliPath, ...withFleetScope(arguments_)],
    // The controlled fixture environment (issue #541): an explicit PATH when
    // the test selects one, otherwise the fixture's own controlled stubs —
    // never the ambient machine PATH.
    environment: controlledEnvironment({
      home,
      path: options.path ?? installControlledHosts(home),
    }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    deadlineMs: options.deadlineMs ?? TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI",
  });
}

/**
 * Run the packed CLI at its printed default scope: unlike {@link runCli}, no
 * historical `--all` is injected, so a fleet invocation without a positional
 * or filter exercises the delivered default (US-009, DEC-001).
 */
async function runCliDefaultScope(
  home: string,
  arguments_: readonly string[],
  options: { readonly path?: string; readonly deadlineMs?: number; readonly cwd?: string } = {},
) {
  return runProcess({
    executable: nodeBinary,
    arguments_: [cliPath, ...arguments_],
    environment: controlledEnvironment({
      home,
      path: options.path ?? installControlledHosts(home),
    }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    deadlineMs: options.deadlineMs ?? TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI (default scope)",
  });
}

function enableCodexHooks(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

/**
 * Allowlisted executable directory for controlled-Host CLI runs (TEST-016):
 * the canonical controlled allow bin (issue #541) with only `git` beyond its
 * default tools, so no real installed Host CLI can satisfy a probe and
 * detection is exact machine evidence. Spawned by absolute path, the packed
 * CLI itself needs nothing from this directory.
 */
function allowlistBin(home: string): string {
  return controlledAllowlistBin(home, ["git"]);
}

/**
 * A bin directory whose `apkit` is the packed CLI under the supported Node
 * runtime: printed `apkit …` commands execute verbatim through a shell, the
 * way a user's terminal resolves them. The bin is the canonical controlled
 * allow bin (issue #541), so the shim sits beside the allowlisted tools.
 */
function apkitBin(home: string): string {
  const bin = controlledAllowlistBin(home, ["git"]);
  const shim = join(bin, "apkit");
  if (!existsSync(shim)) {
    writeFileSync(shim, `#!/bin/sh\nexec '${nodeBinary}' '${cliPath}' "$@"\n`);
    execFileSync("chmod", ["+x", shim]);
  }
  return bin;
}

/**
 * All six controlled Host CLI stubs under one bin directory, returned as a
 * bare directory (compose it with {@link allowlistBin} for a hermetic PATH).
 */
function installAllHostStubs(home: string): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const stubs: Readonly<Record<string, string>> = {
    agy: 'echo "Antigravity 1.1.13"',
    claude: 'echo "2.1.0 (Claude Code)"',
    codex: 'echo "codex-cli 0.145.0"',
    grok: 'echo "grok 0.2.111 (fake) [stable]"',
    opencode: 'echo "1.18.23"',
    pi: 'echo "pi 0.82.1"',
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    execFileSync("chmod", ["+x", join(bin, name)]);
  }
  return bin;
}

/**
 * Prepend controlled Host CLI stubs on PATH so packed RC gates stay hermetic
 * (no ambient Codex/Claude versions). Complete Context requires Codex ≥0.145.0;
 * disabled model-invocation requires Codex ≥0.99.0. The PATH is composed
 * through the controlled fixture boundary: the stub bin plus the allowlisted
 * non-Host tools, never the ambient machine PATH (issue #541).
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
  const codexVersion = options.codexVersion ?? "0.145.0";
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "${claudeVersion} (Claude Code)"\n`);
  writeFileSync(join(bin, "codex"), `#!/bin/sh\necho "codex-cli ${codexVersion}"\n`);
  const executables = [join(bin, "claude"), join(bin, "codex")];
  if (options.piVersion !== undefined) {
    writeFileSync(join(bin, "pi"), `#!/bin/sh\necho "pi ${options.piVersion}"\n`);
    executables.push(join(bin, "pi"));
  }
  execFileSync("chmod", ["+x", ...executables]);
  return controlledPath(home, { stubBins: [bin] });
}

function installFakeClaude(home: string, version = "2.1.0"): string {
  return installControlledHosts(home, { claudeVersion: version });
}

function writeWorkspaceAuthoring(home: string): void {
  const workspace = workspacePath(home);
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "Always preserve the project boundary.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "context:\n  - team-rules\nskills: []\n",
  );
}

/**
 * Setup no longer scaffolds example material (spec #593 DEC-003, #599);
 * journeys that bind and install the canonical example pair write it
 * explicitly through the single authoring-examples authority.
 */
function writeExampleMaterial(home: string): void {
  const workspace = workspacePath(home);
  writeFileSync(join(workspace, AUTHORING_EXAMPLES.profile.path), AUTHORING_EXAMPLES.profile.contents);
  writeFileSync(join(workspace, AUTHORING_EXAMPLES.context.path), AUTHORING_EXAMPLES.context.contents);
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
  if (options.modelInvocation === "disabled") {
    frontmatter += `disable-model-invocation: true\n`;
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
    `context: [${context.join(", ")}]\nskills: [${skills.join(", ")}]\n`,
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

/** Count non-overlapping occurrences of one exact substring. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Reconstruct the runnable Git remedy command printed inside a tracked-output
 * Blocker row: the remedy renders its command with each path as one quoted
 * atomic token, wrapped across indented lines as needed, so collecting the
 * command's tokens from the stable `git --literal-pathspecs` anchor onward and
 * collapsing whitespace restores the exact command. The anchor is the stable
 * command token, not the surrounding prose (US-021, TEST-010).
 */
function remedyCommand(view: string): string {
  const lines = view.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line.startsWith("git --literal-pathspecs"));
  if (start === -1) {
    throw new Error(`no Git remedy command found in:\n${view}`);
  }
  const pieces = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("'")) break;
    pieces.push(line);
  }
  return pieces.join(" ");
}

/** Apply through the in-process seam and keep the delivered abort errors typed. */
async function abortedApply(apply: () => Promise<unknown>): Promise<unknown> {
  try {
    return await apply();
  } catch (error) {
    if (error instanceof ApplyDeclinedError) return error;
    throw error;
  }
}

describe("project-bound release candidate", () => {
  test("packed CLI execution uses a supported Node.js runtime, not Bun", async () => {
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
    if (declaredUpperMajor !== null) {
      // The qualified upper bound is enforced at the packed boundary: a newer
      // Node line is refused above, never silently qualified (US-007/DEC-010).
      expect(Number(identity.node.split(".")[0])).toBeLessThan(declaredUpperMajor);
    }
  });

  test("package manifest is the sole engine version and ownership receipts omit engine provenance", async () => {
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
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    const projectPath = project();
    writeBindings(home, [{ project: projectPath, hosts: ["codex"] }]);
    const pathWithHosts = installControlledHosts(home);

    expectExitCode(await runCli(home, ["update"], { path: pathWithHosts }), 0);
    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      receipts: Array<{ hosts: { codex: { adapter_version: string } } }>;
    };
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).not.toHaveProperty("engine_version");
    expect(state.receipts[0]?.hosts.codex.adapter_version).toBe("codex-project-v3");
  });

  test("installing the package alone changes no Workspace, Local Configuration, project, Git, or Host state", async () => {
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
      dependencies?: Record<string, string>;
    };
    expect(packedManifest.scripts?.postinstall).toBeUndefined();
    expect(packedManifest.scripts?.preinstall).toBeUndefined();
    expect(packedManifest.scripts?.install).toBeUndefined();
    expect(packedManifest.scripts?.prepare).toBeUndefined();
    expect(packedManifest.os).toEqual(["darwin"]);
    expect(packedManifest.files).toEqual(["dist/cli.js", "docs/guides", "README.md"]);
    expect(packedManifest.bin).toEqual({ apkit: "./dist/cli.js" });
    // Prompt support is bundled into the single CLI file (ADR-0050): the
    // published package carries no runtime dependency to resolve.
    expect(packedManifest.dependencies).toBeUndefined();

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

    const installedCli = join(installPrefix, "node_modules", ".bin", "apkit");
    const guide = await runProcess({
      executable: installedCli,
      arguments_: ["guide"],
      // The npm shim resolves `node` from the child PATH; the allowlist
      // carries the canonical packed-CLI Node (US-007, #541).
      environment: controlledEnvironment({
        home,
        path: controlledPath(home, { tools: ["git", "sleep", "cat", "node"] }),
      }),
      deadlineMs: TEST_CHILD_DEADLINE_MS,
      commandLabel: "installed apkit",
    });
    expectExitCode(guide, 0);

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

  test("the installed packed CLI runs prompt support without external runtime dependency resolution", async () => {
    // Install the packed tarball into a disposable prefix: node_modules then
    // contains only this package, so the bundled prompt dependency (DEC-036)
    // must resolve from the bundle itself, never from an external package.
    const installPrefix = mkdtempSync(join(tmpdir(), "agent-profile-kit-rc-prompt-prefix-"));
    temporaryDirectories.push(installPrefix);
    execFileSync("npm", ["install", "--prefix", installPrefix, packageArchive], {
      encoding: "utf8",
      env: { ...process.env, HOME: isolatedHome() },
      stdio: "pipe",
    });
    expect(existsSync(join(installPrefix, "node_modules", "@inquirer"))).toBe(false);
    const home = isolatedHome();
    const installedCli = join(installPrefix, "node_modules", ".bin", "apkit");
    const runInstalled = (arguments_: readonly string[]) =>
      runProcess({
        executable: installedCli,
        arguments_: [...arguments_],
        // The npm-generated shim resolves `node` from the child PATH, so the
        // allowlist carries the canonical packed-CLI Node (US-007, #541).
        environment: controlledEnvironment({
          home,
          path: controlledPath(home, { tools: ["git", "sleep", "cat", "node"] }),
        }),
        deadlineMs: TEST_CHILD_DEADLINE_MS,
        commandLabel: "installed apkit",
      });

    expectExitCode(await runInstalled(["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    const projectPath = project();
    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "config.yaml"),
      `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts:\n      - codex\n`,
    );
    expectExitCode(await runInstalled(["update"]), 0);
    const contextPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(contextPath, "hand-edited\n");

    // The answering-flag update executes the bundled prompt support end to end.
    const apply = await runInstalled(["update", "--replace-changed"]);
    expectExitCode(apply, 0);
    expect(readFileSync(contextPath, "utf8")).toContain("Always preserve the project boundary.");
  });

  test("packed distribution excludes credentials, runtime state, and removed commands", async () => {
    // Exact file allowlist lives only in release-boundary.test.ts.
    const packageDocuments = filesUnder(packageRoot).map((path) => ({
      path,
      source: readFileSync(join(packageRoot, path), "utf8"),
    }));
    const markdownDocuments = packageDocuments.filter(({ path }) => path.endsWith(".md"));
    const packageText = packageDocuments.map(({ source }) => source).join("\n");

    expect(packageText).not.toMatch(/BEGIN (RSA |OPENSSH )?PRIVATE KEY|api[_-]?key\s*[:=]/i);
    expect(findFormerCommandInvocations(markdownDocuments)).toEqual([]);
    expect(packageText).not.toMatch(/apkit (plan|run)\b/);
    expect(packageText).not.toMatch(/per-session launcher|global Skill projection|process[- ]overlay/i);
    expect(existsSync(join(packageRoot, "node_modules"))).toBe(false);
    expect(existsSync(join(packageRoot, "test"))).toBe(false);
    expect(existsSync(join(packageRoot, ".agents"))).toBe(false);
    expect(existsSync(join(packageRoot, "state"))).toBe(false);
  });

  test("packed CLI acceptance journey covers exact-root and explicit-checkout lifecycles", async () => {
    const home = isolatedHome();
    const init = await runCli(home, ["init", "~/apkit-workspace"]);
    expectExitCode(init, 0);
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

    const validate = await runCli(home, ["validate"], { path: pathWithClaude });
    expectExitCode(validate, 0);

    const preview = await runCli(home, ["status", "--verbose"], { path: pathWithClaude });
    expectExitCode(preview, 0);
    expect(preview.stdout).toContain(nonGitCodex);
    expect(preview.stdout).toContain(claudeOnly);
    expect(preview.stdout).toContain(combined);
    expect(preview.stdout).toContain(gitRoot);
    expect(preview.stdout).not.toContain(existingWorktree);
    expect(humanText(preview.stdout)).toContain(
      humanText(`Launch Codex from the exact bound project root: ${nonGitCodex}`),
    );

    const apply = await runCli(home, ["update"], { path: pathWithClaude });
    expectExitCode(apply, 0);

    expect(existsSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(claudeOnly, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(combined, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(combined, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(gitRoot, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(existingWorktree, ".codex"))).toBe(false);

    const statusCurrent = await runCli(home, ["status", "--verbose"], { path: pathWithClaude });
    expectExitCode(statusCurrent, 0);
    expect(humanText(statusCurrent.stdout)).toContain(humanText(`${gitRoot}: up to date`));
    expect(statusCurrent.stdout).not.toContain(existingWorktree);

    writeBindings(home, [
      { project: nonGitCodex, hosts: ["codex"] },
      { project: claudeOnly, hosts: ["claude"] },
      { project: combined, hosts: ["codex", "claude"] },
      { project: gitRoot, hosts: ["codex"] },
      { project: existingWorktree, profile: "review", hosts: ["claude"] },
    ]);

    const explicitPreview = await runCli(home, ["status", "--verbose"], { path: pathWithClaude });
    expectExitCode(explicitPreview, 0);
    expect(humanText(explicitPreview.stdout)).toContain(
      humanText(`${existingWorktree}: not installed yet`),
    );

    const explicitApply = await runCli(home, ["update"], { path: pathWithClaude });
    expectExitCode(explicitApply, 0);
    expect(existsSync(join(existingWorktree, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "codex", "context.md"))).toBe(false);

    const explicitStatus = await runCli(home, ["status", "--verbose"], { path: pathWithClaude });
    expectExitCode(explicitStatus, 0);
    expect(humanText(explicitStatus.stdout)).toContain(humanText(`${existingWorktree}: up to date`));

    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "Updated release-candidate Context.\n",
    );
    const staleStatus = await runCli(home, ["status"], { path: pathWithClaude });
    expectExitCode(staleStatus, 0);
    expect(staleStatus.stdout).toContain("Ready to update\n- source changed (5): ");

    const reapply = await runCli(home, ["update"], { path: pathWithClaude });
    expectExitCode(reapply, 0);
    expect(
      readFileSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"), "utf8"),
    ).toContain("Updated release-candidate Context.");
    expect(
      readFileSync(join(claudeOnly, ".claude", "rules", "agent-profile-kit.md"), "utf8"),
    ).toContain("Updated release-candidate Context.");

    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      receipts: Array<{
        hosts: Record<string, { capability_contract: string }>;
        project: string;
      }>;
    };
    const combinedInstallation = state.receipts.find((installation) =>
      installation.hosts.claude !== undefined && installation.hosts.codex !== undefined,
    );
    expect(combinedInstallation?.hosts.claude?.capability_contract).toBe(
      "native-project-unscoped-rules-skills-v1",
    );
    expect(combinedInstallation?.hosts.codex?.capability_contract).toBe(
      "native-project-sessionstart-complete-context-v1",
    );

    // Binding removal: drop Claude-only, combined, and the explicit linked checkout.
    writeBindings(home, [
      { project: nonGitCodex, hosts: ["codex"] },
      { project: gitRoot, hosts: ["codex"] },
    ]);
    const removeApply = await runCli(home, ["update"], { path: pathWithClaude });
    expectExitCode(removeApply, 0);
    expect(existsSync(join(claudeOnly, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(combined, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(combined, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(gitRoot, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(existingWorktree, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const uninstall = await runCli(home, ["uninstall", "--all", "--auto-confirm"], { path: pathWithClaude });
    expectExitCode(uninstall, 0);
    expect(existsSync(join(nonGitCodex, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(gitRoot, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(existingWorktree, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(existsSync(configPath(home))).toBe(true);
    // Removed installations are forgotten with their output.
    expect(readFileSync(configPath(home), "utf8")).not.toContain(nonGitCodex);
  }, 15_000);

  test("packed CLI installs Pi Context, records its Capability Contract, and fails closed on unsupported Pi", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
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
    const preview = await runCli(home, ["status"], { path: supportedPath });
    expectExitCode(preview, 0);
    const apply = await runCli(home, ["update"], { path: supportedPath });
    expectExitCode(apply, 0);
    expect(existsSync(join(projectPath, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    expect(existsSync(join(combinedProject, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    expect(existsSync(join(combinedProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      receipts: Array<{
        hosts: Record<string, { adapter_version: string; capability_contract: string }>;
      }>;
    };
    expect(state.receipts).toHaveLength(2);
    const piOnlyInstallation = state.receipts.find((installation) =>
      Object.keys(installation.hosts).length === 1,
    );
    expect(piOnlyInstallation?.hosts.pi?.adapter_version).toBe("pi-project-v2");
    expect(piOnlyInstallation?.hosts.pi?.capability_contract).toBe("native-project-append-system-v1");
    const combinedInstallation = state.receipts.find((installation) =>
      installation.hosts.claude !== undefined,
    );
    expect(combinedInstallation?.hosts.pi?.capability_contract).toBe("native-project-append-system-v1");
    expect(combinedInstallation?.hosts.claude?.capability_contract).toBe("native-project-unscoped-rules-skills-v1");

    const status = await runCli(home, ["status"], { path: supportedPath });
    expectExitCode(status, 0);
    expect(status.stdout).toMatch(/up to date/i);

    writeBindings(home, []);
    const remove = await runCli(home, ["update"], { path: supportedPath });
    expectExitCode(remove, 0);
    expect(existsSync(join(projectPath, ".pi", "APPEND_SYSTEM.md"))).toBe(false);
    expect(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")).toBe("native settings\n");
    expect(existsSync(join(combinedProject, ".pi", "APPEND_SYSTEM.md"))).toBe(false);
    expect(existsSync(join(combinedProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(readFileSync(join(combinedProject, ".pi", "settings.json"), "utf8")).toBe("combined native settings\n");
    expect(readFileSync(trustPath, "utf8")).toBe(`{"${projectPath}":true,"${combinedProject}":false}\n`);

    const unsupportedHome = isolatedHome();
    expectExitCode(await runCli(unsupportedHome, ["init", "~/apkit-workspace"]), 0);
    writeWorkspaceAuthoring(unsupportedHome);
    const unsupportedProject = project("agent-profile-kit-rc-pi-old-");
    writeBindings(unsupportedHome, [{ project: unsupportedProject, hosts: ["pi"] }]);
    const oldPath = installControlledHosts(unsupportedHome, { piVersion: "0.82.0" });
    const oldPreview = await runCli(unsupportedHome, ["status"], { path: oldPath });
    expectExitCode(oldPreview, 0);
    expect(humanText(`${oldPreview.stdout}${oldPreview.stderr}`)).not.toMatch(/requires 0\.82\.1\+/i);
    expect(existsSync(join(unsupportedProject, ".pi"))).toBe(false);

    const missingHome = isolatedHome();
    expectExitCode(await runCli(missingHome, ["init", "~/apkit-workspace"]), 0);
    writeWorkspaceAuthoring(missingHome);
    const missingProject = project("agent-profile-kit-rc-pi-missing-");
    writeBindings(missingHome, [{ project: missingProject, hosts: ["pi"] }]);
    installControlledHosts(missingHome);
    const noPiPath = join(missingHome, "bin");
    const missingPreview = await runCli(missingHome, ["status"], { path: noPiPath });
    expectExitCode(missingPreview, 0);
    expect(`${missingPreview.stdout}${missingPreview.stderr}`).not.toMatch(/Pi CLI was not found/i);
    expect(existsSync(join(missingProject, ".pi"))).toBe(false);
  });

  test("packed CLI installs Pi Skills with the non-invocation Capability Contract", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
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
    const preview = await runCli(home, ["status", "--verbose"], { path: supportedPath });
    expectExitCode(preview, 0);
    expect(preview.stdout).toMatch(/\.agents\/skills\/review-pr|review-pr/i);
    const apply = await runCli(home, ["update"], { path: supportedPath });
    expectExitCode(apply, 0);
    expect(readFileSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "name: review-pr",
    );
    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      receipts: Array<{ hosts: { pi: { capability_contract: string } } }>;
    };
    expect(state.receipts[0]?.hosts.pi.capability_contract)
      .toBe("native-project-append-system-shared-skills-v1");
    expect(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8")).toBe(globalSettings);
    expect(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")).toBe(projectSettings);

    const dynamicSettings = '{"extensions":["./dynamic.ts"]}\n';
    writeFileSync(join(projectPath, ".pi", "settings.json"), dynamicSettings);
    const resolvedStatus = await runCli(home, ["status"], { path: supportedPath });
    expectExitCode(resolvedStatus, 0);
    expect(resolvedStatus.stdout).toContain("All Projects are up to date");
    expect(`${resolvedStatus.stdout}${resolvedStatus.stderr}`).not.toMatch(/dynamic\.ts|blocked/i);
    expect(readFileSync(join(projectPath, ".pi", "settings.json"), "utf8")).toBe(dynamicSettings);
    expect(readFileSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "name: review-pr",
    );
  });

  test("packed CLI migrates an owned Pi Skill package to the shared projection", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    writeWorkspaceAuthoring(home);
    writeSkill(home, "review-pr", { body: "# Review\n" });
    writeProfile(home, "skills-only", { skills: ["review-pr"] });
    const projectPath = project("agent-profile-kit-rc-pi-migration-");
    writeBindings(home, [{ project: projectPath, profile: "skills-only", hosts: ["pi"] }]);
    const supportedPath = installControlledHosts(home, { piVersion: "0.82.1" });

    expectExitCode(await runCli(home, ["update"], { path: supportedPath }), 0);
    const state = await readInstallationState(home);
    const current = state.receipts[0];
    if (!current) throw new Error("expected current Pi receipt");
    const sharedPath = ".agents/skills/review-pr";
    const oldPath = ".pi/skills/review-pr";
    mkdirSync(join(projectPath, ".pi", "skills"), { recursive: true });
    renameSync(
      join(projectPath, ".agents", "skills", "review-pr"),
      join(projectPath, oldPath),
    );
    await writeInstallationState(home, {
      ...state,
      receipts: [{
        ...current,
        hosts: {
          pi: {
            adapterVersion: "pi-project-v1",
            capabilityContract: "native-project-skills-v1",
          },
        },
        outputs: current.outputs.map((output) =>
          output.path === sharedPath ? { ...output, path: oldPath } : output,
        ),
      }],
    });

    const migrated = await runCli(home, ["update"], { path: supportedPath });
    expectExitCode(migrated, 0);
    expect(existsSync(join(projectPath, ".pi", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expectExitCode(await runCli(home, ["update"], { path: supportedPath }), 0);
    expectExitCode(await runCli(home, ["status"], { path: supportedPath }), 0);

    expectExitCode(await runCli(home, ["uninstall", "--all", "--auto-confirm"], { path: supportedPath }), 0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".pi", "skills", "review-pr"))).toBe(false);
  });

  test("packed CLI projects mixed Pi invocation policies with independent Skills-only and combined contracts", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
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
    const preview = await runCli(home, ["status"], { path: supportedPath });
    expectExitCode(preview, 0);
    const apply = await runCli(home, ["update"], { path: supportedPath });
    expectExitCode(apply, 0);

    const generatedSkillsOnly = readFileSync(
      join(skillsOnlyProject, ".agents", "skills", "explicit-skill", "SKILL.md"),
      "utf8",
    );
    const generatedCombined = readFileSync(
      join(combinedProject, ".agents", "skills", "explicit-skill", "SKILL.md"),
      "utf8",
    );
    expect(generatedSkillsOnly).toContain("name: explicit-skill");
    expect(generatedSkillsOnly).toContain("disable-model-invocation: true");
    expect(generatedCombined).toContain("name: explicit-skill");
    expect(generatedCombined).toContain("disable-model-invocation: true");
    expect(readFileSync(join(skillsOnlyProject, ".agents", "skills", "allowed-skill", "SKILL.md"), "utf8")).toContain(
      "name: allowed-skill",
    );
    expect(readFileSync(join(skillsOnlyProject, ".agents", "skills", "allowed-skill", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
    expect(readFileSync(join(workspacePath(home), "skills", "explicit-skill", "SKILL.md"), "utf8")).toBe(
      canonicalSource,
    );

    const state = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      receipts: Array<{
        hosts: Record<string, { capability_contract: string }>;
      }>;
    };
    const skillsOnlyInstallation = state.receipts.find(
      (installation) => Object.keys(installation.hosts).length === 1,
    );
    expect(skillsOnlyInstallation?.hosts.pi?.capability_contract)
      .toBe("native-project-shared-skills-invocation-v1");
    const combinedInstallation = state.receipts.find(
      (installation) => installation.hosts.claude !== undefined,
    );
    expect(combinedInstallation?.hosts.pi?.capability_contract).toBe(
      "native-project-append-system-shared-skills-invocation-v1",
    );

    const unsupportedHome = isolatedHome();
    expectExitCode(await runCli(unsupportedHome, ["init", "~/apkit-workspace"]), 0);
    writeWorkspaceAuthoring(unsupportedHome);
    writeSkill(unsupportedHome, "explicit-skill", { modelInvocation: "disabled" });
    writeProfile(unsupportedHome, "coding", { skills: ["explicit-skill"] });
    const unsupportedProject = project("agent-profile-kit-rc-pi-invocation-old-");
    writeBindings(unsupportedHome, [{ project: unsupportedProject, hosts: ["pi"] }]);
    const oldPath = installControlledHosts(unsupportedHome, { piVersion: "0.82.0" });
    const oldPreview = await runCli(unsupportedHome, ["status"], { path: oldPath });
    expectExitCode(oldPreview, 0);
    expect(humanText(`${oldPreview.stdout}${oldPreview.stderr}`)).not.toMatch(/requires 0\.82\.1\+/i);
    expect(existsSync(join(unsupportedProject, ".pi"))).toBe(false);

    const malformedHome = isolatedHome();
    expectExitCode(await runCli(malformedHome, ["init", "~/apkit-workspace"]), 0);
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
    const malformedPreview = await runCli(malformedHome, ["status"], { path: malformedPath });
    expectExitCode(malformedPreview, 1);
    expect(`${malformedPreview.stdout}${malformedPreview.stderr}`).toMatch(/invalid YAML|frontmatter/i);
    expect(existsSync(join(malformedProject, ".pi"))).toBe(false);
  });

  test("unsupported artifact categories, Host versions, Hosts, and project surfaces fail before writes", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    const projectPath = project();

    writeFileSync(
      join(workspacePath(home), "profiles", "coding.yaml"),
      "context: [team-rules]\nskills: []\nagents: [reviewer]\nhooks: []\ntools: []\n",
    );
    writeBindings(home, [{ project: projectPath, hosts: ["codex"] }]);
    const unsupportedAgents = await runCli(home, ["update"]);
    expectExitCode(unsupportedAgents, 1);
    expect(humanText(unsupportedAgents.stderr)).toMatch(
      /no longer supports fields: agents, hooks, tools.*remove these obsolete Profile fields.*only as empty placeholders/i,
    );
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);

    writeWorkspaceAuthoring(home);
    writeBindings(home, [{ project: projectPath, hosts: ["cursor"] }]);
    const unsupportedHost = await runCli(home, ["update"]);
    expectExitCode(unsupportedHost, 1);
    expect(unsupportedHost.stderr).toContain("unsupported Agent Host 'cursor'");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);

    writeBindings(home, [{ project: projectPath, hosts: ["claude"] }]);
    const oldClaudePath = (() => {
      const bin = join(home, "old-claude-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "claude"), "#!/bin/sh\necho \"2.0.0 (Claude Code)\"\n");
      execFileSync("chmod", ["+x", join(bin, "claude")]);
      return controlledPath(home, { stubBins: [bin] });
    })();
    const oldClaude = await runCli(home, ["update"], { path: oldClaudePath });
    expectExitCode(oldClaude, 0);
    expect(`${oldClaude.stdout}${oldClaude.stderr}`).toMatch(
      /does not support unscoped project rules|requires 2\.0\.64/i,
    );
    expect(readFileSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"), "utf8"))
      .toContain("Always preserve the project boundary.");

    // Non-directory Host project surface stays blocked by occupied-output
    // ownership, not by capability probing.
    rmSync(join(projectPath, ".claude"), { recursive: true, force: true });
    writeFileSync(join(projectPath, ".claude"), "not a directory\n");
    const goodClaudePath = installFakeClaude(home);
    const surface = await runCli(home, ["update"], { path: goodClaudePath });
    expectExitCode(surface, 2);
    expect(`${surface.stdout}${surface.stderr}`).toMatch(/not a regular directory inside the Project/i);
    expect(readFileSync(join(projectPath, ".claude"), "utf8")).toBe("not a directory\n");
    expect(existsSync(join(projectPath, ".claude", "rules"))).toBe(false);
  });

  test("packed CLI translates absent and disabled model-invocation policy for Codex-only, Claude-only, and combined bindings", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    writeSkill(home, "plain-skill", { modelInvocation: "absent" });
    writeSkill(home, "to-spec", { modelInvocation: "disabled" });
    writeProfile(home, "coding", { context: ["team-rules"], skills: ["plain-skill"] });

    const codexOnly = project("agent-profile-kit-rc-mi-codex-");
    const claudeOnly = project("agent-profile-kit-rc-mi-claude-");
    const combined = project("agent-profile-kit-rc-mi-combined-");
    // Controlled Codex stub (≥0.145.0) satisfies Context and disabled invocation floors.
    const pathWithHosts = installControlledHosts(home);

    writeBindings(home, [
      { project: codexOnly, hosts: ["codex"] },
      { project: claudeOnly, hosts: ["claude"] },
      { project: combined, hosts: ["codex", "claude"] },
    ]);

    const absentValidate = await runCli(home, ["validate"], { path: pathWithHosts });
    expectExitCode(absentValidate, 0);
    const absentApply = await runCli(home, ["update"], { path: pathWithHosts });
    expectExitCode(absentApply, 0);

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
    const disabledApply = await runCli(home, ["update"], { path: pathWithHosts });
    expectExitCode(disabledApply, 0);

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

    // Canonical Workspace source is never rewritten: the authored standard
    // field and unrelated metadata stay byte-identical.
    expect(readFileSync(join(workspacePath(home), "skills", "to-spec", "SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: true",
    );
    expect(readFileSync(join(workspacePath(home), "skills", "to-spec", "SKILL.md"), "utf8")).not.toContain(
      "agent-profile-kit.model-invocation",
    );
  });

  test("packed CLI Skills-only Profile covers validate through source update, binding removal, and uninstall without Context machinery", async () => {
    const home = isolatedHome();
    // Skills-only must not require Codex SessionStart hooks configuration.
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    writeSkill(home, "review-pr");
    writeProfile(home, "engineering", { skills: ["review-pr"] });

    const projectPath = project("agent-profile-kit-rc-skills-only-");
    const secondProject = project("agent-profile-kit-rc-skills-only-b-");
    const pathWithClaude = installFakeClaude(home);
    writeBindings(home, [
      { project: projectPath, hosts: ["codex", "claude"], profile: "engineering" },
      { project: secondProject, hosts: ["codex"], profile: "engineering" },
    ]);

    const validate = await runCli(home, ["validate"], { path: pathWithClaude });
    expectExitCode(validate, 0);

    const preview = await runCli(home, ["status", "--verbose"], { path: pathWithClaude });
    expectExitCode(preview, 0);
    expect(preview.stdout).toContain(".agents/skills/review-pr");
    expect(preview.stdout).toContain(".claude/skills/review-pr");
    expect(preview.stdout).not.toContain(".agent-profile-kit/codex/context.md");
    expect(preview.stdout).not.toContain(".codex/hooks.json");
    expect(preview.stdout).not.toContain(".claude/rules/agent-profile-kit.md");

    const apply = await runCli(home, ["update"], { path: pathWithClaude });
    expectExitCode(apply, 0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(secondProject, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(projectPath, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);

    const statusCurrent = await runCli(home, ["status"], { path: pathWithClaude });
    expectExitCode(statusCurrent, 0);
    expect(statusCurrent.stdout).toMatch(/up to date/i);

    // Source update: change Skill body and re-apply.
    writeSkill(home, "review-pr", { body: "# Review updated for release candidate\n" });
    const staleStatus = await runCli(home, ["status"], { path: pathWithClaude });
    expectExitCode(staleStatus, 0);
    expect(staleStatus.stdout).toContain("Ready to update\n- source changed (2): ");
    const reapply = await runCli(home, ["update"], { path: pathWithClaude });
    expectExitCode(reapply, 0);
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
    const removeApply = await runCli(home, ["update"], { path: pathWithClaude });
    expectExitCode(removeApply, 0);
    expect(existsSync(join(secondProject, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);

    const uninstall = await runCli(home, ["uninstall", "--all", "--auto-confirm"], { path: pathWithClaude });
    expectExitCode(uninstall, 0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(projectPath, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(existsSync(configPath(home))).toBe(true);
  });

  test("packed CLI delegates global Skill identities to Codex and Claude Host Resolution", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
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

    const preview = await runCli(home, ["status"], { path: pathWithHosts });
    expectExitCode(preview, 0);
    const previewText = `${preview.stdout}${preview.stderr}`;
    expect(previewText).not.toMatch(/personal\/global Skill|remove or relocate/i);

    const apply = await runCli(home, ["update"], { path: pathWithHosts });
    expectExitCode(apply, 0);

    expect(existsSync(join(codexProject, ".agents", "skills", "review-pr"))).toBe(true);
    expect(existsSync(join(codexAltProject, ".agents", "skills", "review-pr"))).toBe(true);
    expect(existsSync(join(claudeProject, ".claude", "skills", "review-pr"))).toBe(true);
    expect(existsSync(join(codexProject, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(claudeProject, ".claude", "rules"))).toBe(false);

    // Global roots untouched (APK never mutates them).
    expect(readFileSync(join(agentsGlobal, "SKILL.md"), "utf8")).toBe(agentsGlobalBody);
    expect(readFileSync(join(codexGlobal, "SKILL.md"), "utf8")).toBe(codexGlobalBody);
    expect(readFileSync(join(claudeGlobal, "SKILL.md"), "utf8")).toBe(claudeGlobalBody);
    expect(existsSync(join(home, ".agents", "agent-profile-kit", "state", "manifest.json"))).toBe(true);
  });

  test("minimal and partial Workspaces prove optional scaffolding without weakening Manifest or artifact validation", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    const workspace = workspacePath(home);

    // Strip scaffolding to a Manifest-only Workspace.
    for (const name of ["profiles", "context", "skills", "agents", "hooks", "tools", "README.md", "AGENTS.md", ".gitignore"]) {
      rmSync(join(workspace, name), { recursive: true, force: true });
    }
    expect(readdirSync(workspace).sort()).toEqual(["workspace.yaml"]);

    const minimalValidate = await runCli(home, ["validate"]);
    expectExitCode(minimalValidate, 0);
    expect(minimalValidate.stdout).toContain("Workspace and settings valid");

    // Re-init must not restore optional scaffolding.
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
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
      "context: []\nskills: [review-pr]\n",
    );
    expect(existsSync(join(workspace, "context"))).toBe(false);
    expect(existsSync(join(workspace, "agents"))).toBe(false);

    // A partial Workspace validates — dedicated detector: the packed
    // manifest-only/partial validation test (#546, C3).

    // Present malformed artifacts still fail at ingestion (scaffolding optional ≠ validation weak).
    mkdirSync(join(workspace, "skills", "bad-skill"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "bad-skill", "SKILL.md"),
      "---\nname: bad-skill\ndescription: Missing closing frontmatter\n# Bad\n",
    );
    const badArtifact = await runCli(home, ["validate"]);
    expectExitCode(badArtifact, 1);
    expect(`${badArtifact.stdout}${badArtifact.stderr}`).toMatch(/skill|frontmatter|YAML|malformed/i);
    rmSync(join(workspace, "skills", "bad-skill"), { recursive: true, force: true });

    const projectPath = project("agent-profile-kit-rc-partial-");
    writeBindings(home, [
      { project: projectPath, hosts: ["codex"], profile: "engineering" },
    ]);
    const apply = await runCli(home, ["update"]);
    expectExitCode(apply, 0);
    expect(existsSync(join(projectPath, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "codex", "context.md"))).toBe(false);

    // Malformed Manifest still fails closed.
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 999\n");
    const malformed = await runCli(home, ["validate"]);
    expectExitCode(malformed, 1);
    expect(`${malformed.stdout}${malformed.stderr}`).toMatch(/schema|workspace\.yaml|unsupported/i);
  });

  // Guide-content regression moved to the dedicated detectors (#546, C1):
  // the golden full-guide/agent-guide byte baselines and the focused guide
  // tests prove the delivered guide text through the same packed captures.

  test("packed discovery-to-lifecycle acceptance journey covers the complete CLI surface", async () => {
    const home = isolatedHome();

    // Discovery: root help introduces the command surface.
    const help = await runCli(home, ["--help"]);
    expectExitCode(help, 0);
    expect(help.stdout).toContain("First run:");
    expect(help.stdout).toContain("Common commands:");
    expect(help.stdout).toContain("More commands:");

    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);

    // Inventory: supported Hosts and available Profiles from canonical sources.
    const hosts = await runCli(home, ["list", "hosts"]);
    expectExitCode(hosts, 0);
    expect(hosts.stdout).toContain("  codex — installed\n");

    const profiles = await runCli(home, ["list", "profiles"]);
    expectExitCode(profiles, 0);
    expect(profiles.stdout).toContain("Profile: coding");

    // Record every supported Host without installing, then inventory the
    // Project Binding (pending setup preserved for the plan/apply below).
    const projectPath = gitRepository();
    writeBindings(home, [{
      project: projectPath,
      profile: "coding",
      hosts: ["antigravity", "claude", "codex", "grok", "pi"],
    }]);

    const projects = await runCli(home, ["list", "projects"]);
    expectExitCode(projects, 0);
    // The typed Project identity is an atomic path node: it elides in the
    // middle and keeps the tail visible instead of overflowing (DEC-004).
    expectElidedProjectLine(projects.stdout, projectPath);
    expect(projects.stdout).toContain("Profile: coding");

    // Plan and apply with controlled Host CLIs on PATH.
    const pathWithHosts = installAllControlledHosts(home);
    const plannedStatus = await runCli(home, ["status"], { path: pathWithHosts });
    expectExitCode(plannedStatus, 0);
    expect(plannedStatus.stdout).toContain("Ready to update");
    expect(plannedStatus.stdout).toContain("- not installed yet (1):");

    const apply = await runCli(home, ["update"], { path: pathWithHosts });
    expectExitCode(apply, 0);
    expect(apply.stdout).toContain("Update complete");

    const status = await runCli(home, ["status"], { path: pathWithHosts });
    expectExitCode(status, 0);
    expect(status.stdout).toMatch(/All Projects are up to date/);
    const appliedState = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      readonly receipts: readonly { readonly hosts: Readonly<Record<string, unknown>> }[];
    };
    expect(new Set(Object.keys(appliedState.receipts[0]!.hosts))).toEqual(
      new Set(["antigravity", "claude", "codex", "grok", "pi"]),
    );

    // A linked worktree carries an independent Temporary Profile Installation
    // while uninstall removes only the ordinary lifetime and its exclusion contribution.
    const temporaryProject = addWorktree(projectPath, "qualification-temporary");
    const installTemp = await runCli(
      home,
      ["machine", "install-temp", "coding", temporaryProject, "--host", "codex", "--json"],
      { path: pathWithHosts },
    );
    expectExitCode(installTemp, 0);
    const receipt = JSON.parse(installTemp.stdout) as {
      readonly temporaryInstallationId: string;
    };

    const listTemporary = await runCli(home, ["machine", "list", "temporary"], { path: pathWithHosts });
    expectExitCode(listTemporary, 0);
    expect(listTemporary.stdout).toContain(receipt.temporaryInstallationId);

    const uninstall = await runCli(home, ["uninstall", "--all", "--auto-confirm"], { path: pathWithHosts });
    expectExitCode(uninstall, 0);
    expect(existsSync(join(projectPath, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(join(temporaryProject, ".agent-profile-kit", "installation.json"))).toBe(false);
    const temporaryOnlyState = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      readonly receipts: readonly {
        readonly installation_id: string;
        readonly lifetime: string;
        readonly repository_exclusion?: unknown;
      }[];
    };
    expect(temporaryOnlyState.receipts).toEqual([
      expect.objectContaining({
        installation_id: receipt.temporaryInstallationId,
        lifetime: "temporary",
      }),
    ]);
    // Exclusion entries are derived at write time and no longer stored in the receipt.
    expect(temporaryOnlyState.receipts[0]!.repository_exclusion).toBeUndefined();
    const sharedExcludePath = join(realpathSync(projectPath), ".git", "info", "exclude");
    const sharedExcludeAfterUninstall = readFileSync(sharedExcludePath, "utf8");
    expect(sharedExcludeAfterUninstall).toContain("# BEGIN Agent Profile Kit generated paths");

    const removeTemp = await runCli(
      home,
      ["machine", "remove-temp", receipt.temporaryInstallationId, "--json"],
      { path: pathWithHosts },
    );
    expectExitCode(removeTemp, 0);

    const emptyTemporary = await runCli(home, ["machine", "list", "temporary"], { path: pathWithHosts });
    expectExitCode(emptyTemporary, 0);
    expect(emptyTemporary.stdout).toContain("No temporary Profiles are active.");
    const finalState = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      readonly receipts: readonly unknown[];
      readonly removed_temporary_installation_ids: readonly string[];
    };
    expect(finalState.receipts).toEqual([]);
    expect(finalState.removed_temporary_installation_ids).toEqual([
      receipt.temporaryInstallationId,
    ]);
    const sharedExcludeAfterRemoval = readFileSync(sharedExcludePath, "utf8");
    expect(sharedExcludeAfterRemoval).not.toContain("Agent Profile Kit");
  }, 30_000);

  test("packed 12-Project fleet lifecycle produces the canonical sequential reconciliation result", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    // One shared Profile with Context and a Skill so the fleet carries directory
    // and file outputs across mixed Hosts and Git/non-Git Projects.
    writeSkill(home, "review-pr");
    writeProfile(home, "coding", { context: ["team-rules"], skills: ["review-pr"] });

    // 12 Projects: 6 Git + 6 plain, with single- and multi-Host bindings.
    const gitProjects = Array.from({ length: 6 }, (_, index) =>
      gitRepository(`agent-profile-kit-rc-fleet-git-${index}-`),
    );
    const plainProjects = Array.from({ length: 6 }, (_, index) =>
      project(`agent-profile-kit-rc-fleet-plain-${index}-`),
    );
    const bindings = [
      ...gitProjects.map((repo, index) => ({
        hosts: index % 2 === 0 ? ["codex"] : ["codex", "claude"],
        project: repo,
      })),
      ...plainProjects.map((plain, index) => ({
        hosts: index % 3 === 0
          ? ["codex", "pi"]
          : index % 3 === 1
            ? ["codex", "claude"]
            : ["codex", "claude", "pi"],
        project: plain,
      })),
    ];
    writeBindings(home, bindings);
    const pathWithHosts = installControlledHosts(home, { piVersion: "0.82.1" });

    // Preview through the packed CLI (bounded concurrency 4).
    const preview = await runCli(home, ["status", "--json"], { path: pathWithHosts });
    expectExitCode(preview, 0);
    const previewJson = JSON.parse(preview.stdout) as {
      readonly globalBlockers: readonly unknown[];
      readonly projects: readonly {
        readonly canonicalProject: string;
        readonly outputs: readonly unknown[];
        readonly state: { readonly kind: string };
      }[];
    };
    expect(previewJson.globalBlockers).toEqual([]);
    expect(previewJson.projects).toHaveLength(12);
    // Canonical Project ordering is preserved across concurrent completion.
    const canonicalOrder = bindings.map((binding) => realpathSync(binding.project)).sort();
    expect(previewJson.projects.map((project) => project.canonicalProject)).toEqual(canonicalOrder);
    expect(previewJson.projects.every((project) => project.state.kind === "addition")).toBe(true);
    expect(previewJson.projects.flatMap((project) => project.outputs).length).toBeGreaterThan(0);

    // The same fixture reconciled sequentially in-process must produce the
    // identical versioned machine payload: the packed bounded-concurrency result
    // equals the sequential implementation result.
    const gitInspection = createLifecycleGitInspectionContext();
    const sequentialDesired = await buildDesiredState(home, {
      checkHostCapability: false,
      gitInspection,
      scheduler: createProjectReadScheduler(1),
    });
    const sequentialReport = await previewReconciliation(
      sequentialDesired.installations,
      await readInstallationState(home),
      { gitInspection, scheduler: createProjectReadScheduler(1) },
    );
    expect(JSON.parse(formatLifecycleJson("status", sequentialReport))).toEqual(previewJson);

    // Apply once; every Project commits and the resulting state is current.
    const apply = await runCli(home, ["update", "--json"], { path: pathWithHosts });
    expectExitCode(apply, 0);
    const applyJson = JSON.parse(apply.stdout) as {
      readonly applied: { readonly projects: readonly unknown[] };
      readonly projects: readonly { readonly state: { readonly kind: string } }[];
    };
    expect(applyJson.applied.projects).toHaveLength(12);
    expect(applyJson.projects).toHaveLength(12);
    expect(applyJson.projects.every((project) => project.state.kind === "current")).toBe(true);

    const status = await runCli(home, ["status", "--json"], { path: pathWithHosts });
    expectExitCode(status, 0);
    const statusJson = JSON.parse(status.stdout) as {
      readonly projects: readonly { readonly state: { readonly kind: string } }[];
      readonly outcome: string;
    };
    expect(statusJson.outcome).toBe("clean");
    expect(statusJson.projects).toHaveLength(12);
    expect(statusJson.projects.every((project) => project.state.kind === "current")).toBe(true);
  }, 60_000);

  test("the packed integrated daily-loop journey reconciles a mixed multi-cause fleet with narrowing, receipts, cancellation, and non-interactive completion (US-007–008, TEST-003–TEST-014, TEST-021, #461)", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    writeExampleMaterial(home);

    // Six Projects, one per primary cause plus one multi-cause Project: the
    // mixed fleet from TEST-003 with multi-cause and Blocked members (TEST-004).
    const settled = gitRepository("agent-profile-kit-rc-loop-settled-");
    const changed = gitRepository("agent-profile-kit-rc-loop-changed-");
    const missing = project("agent-profile-kit-rc-loop-missing-");
    const source = gitRepository("agent-profile-kit-rc-loop-source-");
    const multi = project("agent-profile-kit-rc-loop-multi-");
    const blocked = gitRepository("agent-profile-kit-rc-loop-blocked-");
    writeBindings(home, [
      { project: settled, profile: "example", hosts: ["codex"] },
      { project: changed, profile: "example", hosts: ["codex"] },
      { project: missing, profile: "example", hosts: ["claude"] },
      { project: source, profile: "example", hosts: ["codex"] },
      { project: multi, profile: "example", hosts: ["codex"] },
      { project: blocked, profile: "example", hosts: ["codex"] },
    ]);
    // Install the whole fleet first; the causes are induced afterwards so the
    // fleet simultaneously carries every state.
    expectExitCode(await runCliDefaultScope(home, ["update"]), 0);

    // Induce each cause (DEC-002's five states plus one Blocked Project):
    // tracked generated files create the ownership Blocker, a hand-edited
    // generated file with a surviving recorded anchor is ordinary drift, a
    // deleted generated file is missing output, a Host rebinding is a source
    // change, and the multi-cause Project carries drifted output AND a source
    // change at once.
    execFileSync("git", ["-C", blocked, "add", "-f", ".agent-profile-kit/codex/context.md", ".codex/hooks.json"]);
    execFileSync("git", ["-C", blocked, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "tracked"]);
    writeFileSync(join(changed, ".agent-profile-kit/codex/context.md"), "hand-edited bytes\n");
    rmSync(join(missing, ".claude/rules/agent-profile-kit.md"));
    writeBindings(home, [
      { project: settled, profile: "example", hosts: ["codex"] },
      { project: changed, profile: "example", hosts: ["codex"] },
      { project: missing, profile: "example", hosts: ["claude"] },
      { project: source, profile: "example", hosts: ["codex", "grok"] },
      { project: multi, profile: "example", hosts: ["codex", "grok"] },
      { project: blocked, profile: "example", hosts: ["codex"] },
    ]);
    writeFileSync(join(multi, ".agent-profile-kit/codex/context.md"), "hand-edited bytes\n");
    const neverInstalled = gitRepository("agent-profile-kit-rc-loop-never-");
    writeBindings(home, [
      { project: settled, profile: "example", hosts: ["codex"] },
      { project: changed, profile: "example", hosts: ["codex"] },
      { project: missing, profile: "example", hosts: ["claude"] },
      { project: source, profile: "example", hosts: ["codex", "grok"] },
      { project: multi, profile: "example", hosts: ["codex", "grok"] },
      { project: blocked, profile: "example", hosts: ["codex"] },
      { project: neverInstalled, profile: "example", hosts: ["codex"] },
    ]);
    // One Git-only PATH for every lifecycle run: no real Host CLI can satisfy
    // a probe, so detection is exact and no advisory warning interferes.
    const gitOnlyPath = allowlistBin(home);

    // The settled Project's generated bytes are the baseline for proving that
    // narrowing never writes an unselected Project (TEST-007).
    const settledBaseline = readFileSync(
      join(settled, ".agent-profile-kit/codex/context.md"),
      "utf8",
    );

    // 1. The default fleet view names every actionable Project exactly once,
    // grouped by primary cause, with the settled Project counted only
    // (US-001–003, US-006, US-016, TEST-003, TEST-004).
    const status = await runCliDefaultScope(home, ["status"], { path: gitOnlyPath });
    expectExitCode(status, 2);
    for (const group of [
      "needs attention (1):",
      "generated files changed (2):",
      "generated files missing (1):",
      "not installed yet (1):",
      "source changed (1):",
      "settled (1)",
    ]) {
      expect(status.stdout).toContain(group);
    }
    // One appearance per Project: group counts plus the settled count account
    // for all seven Projects exactly once, and the settled Project is not
    // listed (TEST-004).
    // The scanning view names each Project by its shortest-unambiguous
    // identity (US-013); the full path stays in verbose and JSON evidence.
    const identity = (project: string): string => basename(project);
    for (const listed of [changed, multi, missing, source, neverInstalled]) {
      expect(countOccurrences(status.stdout, identity(listed))).toBe(1);
    }
    expect(status.stdout).not.toContain(identity(settled));
    expect(status.stdout).toContain("Projects: 7 · Blockers: 1");

    // Fact-once (US-008, TEST-012): the multi-cause Project appears once in
    // the default view under its primary cause, never twice.
    expect(countOccurrences(status.stdout, identity(multi))).toBe(1);
    expect(countOccurrences(status.stdout, "drifted output")).toBe(0);

    // US-007: the actionable composed view offers exactly one primary next
    // action, carrying one runnable command; the Blocker remedy keeps its
    // separate source contract inside the Blocker row, before the Next block.
    const nextBlock = status.stdout.slice(status.stdout.indexOf("Next:"));
    expect(nextBlock).toContain("Resolve the reported blocker");
    expect(countOccurrences(status.stdout, "Next:")).toBe(1);
    expect(nextBlock.split("apkit ").length - 1).toBe(1);
    const remedyIndex = status.stdout.indexOf("Remedy:");
    expect(remedyIndex).toBeGreaterThan(-1);
    expect(remedyIndex).toBeLessThan(status.stdout.indexOf("Next:"));
    expect(remedyCommand(status.stdout)).toContain("git --literal-pathspecs");

    // Verbose diagnostics retain every underlying cause of the multi-cause
    // Project: drifted output beside its affected path plus the source-change
    // cause. Fact-once: every affected output states its source-change cause
    // exactly once — one each for the multi-cause, source-changed, and
    // never-installed Projects' two new outputs — never duplicated (TEST-008,
    // TEST-012).
    const verbose = await runCliDefaultScope(home, ["status", "--verbose"], { path: gitOnlyPath });
    expectExitCode(verbose, 2);
    expect(verbose.stdout).toMatch(
      new RegExp(`${multi.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\n\\s+generated files changed`),
    );
    expect(verbose.stdout).toContain("addition (source changed)");
    expect(countOccurrences(verbose.stdout, "(source changed)")).toBe(4);

    // 2. Narrowing selects exactly the DEC-006 memberships, and human and
    // machine selections agree (US-011, US-061, TEST-007, TEST-021).
    const stale = await runCliDefaultScope(home, ["status", "--stale"], { path: gitOnlyPath });
    expectExitCode(stale, 0);
    for (const selected of [changed, multi, missing, source]) {
      expect(stale.stdout).toContain(identity(selected));
    }
    for (const excluded of [blocked, neverInstalled, settled]) {
      expect(stale.stdout).not.toContain(identity(excluded));
    }
    expect(countOccurrences(stale.stdout, "Next:")).toBe(1);
    expect(stale.stdout).toContain("Next: apkit update --stale");

    const blockedView = await runCliDefaultScope(home, ["status", "--blocked"], { path: gitOnlyPath });
    expectExitCode(blockedView, 2);
    expect(blockedView.stdout).toContain(identity(blocked));
    for (const excluded of [changed, multi, missing, source, neverInstalled, settled]) {
      expect(blockedView.stdout).not.toContain(identity(excluded));
    }

    const staleJson = JSON.parse(
      (await runCliDefaultScope(home, ["status", "--stale", "--json"], { path: gitOnlyPath })).stdout,
    ) as { readonly projects: readonly { readonly canonicalProject: string }[] };
    const blockedJson = JSON.parse(
      (await runCliDefaultScope(home, ["status", "--blocked", "--json"], { path: gitOnlyPath })).stdout,
    ) as { readonly projects: readonly { readonly canonicalProject: string }[] };
    expect(staleJson.projects.map((entry) => entry.canonicalProject).sort()).toEqual(
      [changed, missing, multi, source].map((entry) => realpathSync(entry)).sort(),
    );
    expect(blockedJson.projects.map((entry) => entry.canonicalProject)).toEqual([realpathSync(blocked)]);

    // 3. Narrowed apply writes exactly the selected Projects (TEST-007):
    // non-interactive completion with the explicit answering flag replaces
    // the changed generated files, states the impact once, keeps the approved
    // replacement identities, and prompts nothing (US-007, US-011, DEC-005,
    // TEST-004, ADR-0040). Without the flag the same scope refuses before any
    // write (DEC-005).
    const staleRefused = await runCliDefaultScope(home, ["update", "--stale"], { path: gitOnlyPath });
    expectExitCode(staleRefused, 1);
    expect(staleRefused.stderr).toContain("--replace-changed");
    const staleApply = await runCliDefaultScope(
      home,
      ["update", "--stale", "--replace-changed"],
      { path: gitOnlyPath },
    );
    expectExitCode(staleApply, 0);
    expect(staleApply.stdout).toContain("Update complete");
    expect(humanText(staleApply.stdout)).toMatch(/Updated 4 Projects \(\d+ generated files?\)\./);
    // The approved changed replacements keep their Project identities; the
    // routine restored and source-updated Projects stay a count.
    for (const replaced of [changed, multi]) {
      expect(staleApply.stdout).toContain(replaced);
    }
    expect(staleApply.stdout).not.toContain(missing);
    expect(staleApply.stdout).not.toContain(source);
    // The receipt names the replaced changed generated file without wording
    // that infers who changed it (US-028, TEST-013).
    expect(staleApply.stdout).toContain(".agent-profile-kit/codex/context.md");
    expect(staleApply.stdout).not.toContain("you edited");
    expect(staleApply.stdout).not.toContain("hand-edited");
    expect(staleApply.stdout).not.toContain("Replace changed generated files");
    expect(staleApply.stdout).not.toContain("(y/n)");
    // The narrowed write left every unselected Project unchanged.
    expect(readFileSync(join(settled, ".agent-profile-kit/codex/context.md"), "utf8"))
      .toBe(settledBaseline);
    expect(existsSync(join(neverInstalled, ".agent-profile-kit"))).toBe(false);

    // Resulting state is reported separately from the committed receipt: the
    // four reconciled Projects are current while the excluded ones are not.
    const afterStaleApply = await runCliDefaultScope(home, ["status"], { path: gitOnlyPath });
    expectExitCode(afterStaleApply, 2);
    expect(afterStaleApply.stdout).toContain("needs attention (1):");
    expect(afterStaleApply.stdout).toContain("not installed yet (1):");
    expect(countOccurrences(afterStaleApply.stdout, "settled (5)")).toBe(1);

    // 4. Full-fleet non-interactive apply commits the never-installed Project,
    // leaves the Blocked Project untouched, and still exits 2 (TEST-021).
    const fleetApply = await runCliDefaultScope(home, ["update"], { path: gitOnlyPath });
    expectExitCode(fleetApply, 2);
    expect(fleetApply.stdout).toContain("Update complete");
    expect(humanText(fleetApply.stdout)).toMatch(/Updated 1 Project \(\d+ generated files?\)\./);
    expect(existsSync(join(neverInstalled, ".agent-profile-kit/codex/context.md"))).toBe(true);
    // The Blocked Project was left untouched: its tracked generated files are
    // still on disk and its Installation State stays machine-local.
    expect(existsSync(join(blocked, ".agent-profile-kit/codex/context.md"))).toBe(true);
    expect(existsSync(join(blocked, ".codex/hooks.json"))).toBe(true);

    // 5. The printed Blocker remedy is runnable (US-021, TEST-010): execute
    // the exact untracking command, commit, and the Blocker clears.
    const blockedRemedy = await runCliDefaultScope(home, ["status", "--blocked"], { path: gitOnlyPath });
    execFileSync("git", ["-C", blocked, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "remedy", "--allow-empty"]);
    execFileSync("sh", ["-c", remedyCommand(blockedRemedy.stdout)]);
    execFileSync("git", ["-C", blocked, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "untrack generated files"]);
    expectExitCode(await runCli(home, ["update", blocked], { path: gitOnlyPath }), 0);

    // 6. The wholly settled fleet renders one line and invents no next action
    // (US-004, US-007, TEST-004).
    const settledStatus = await runCliDefaultScope(home, ["status"], { path: gitOnlyPath });
    expectExitCode(settledStatus, 0);
    expect(settledStatus.stdout).toBe("✔ All Projects are up to date (7 Projects)\n");
    expect(settledStatus.stdout).not.toContain("Next:");

    // 7. Whole-invocation cancellation: a cancelled changed-output
    // confirmation aborts before any write, including the healthy pending
    // Project of the same invocation (US-029, US-056, TEST-014) — the
    // predecessor apply-confirmation fixture and seam, consumed as a journey
    // phase rather than reimplemented.
    const driftedFleet = await prepareDriftedFleet("agent-profile-kit-rc-loop-cancel");
    // The explicit answering flag authorizes the replacement without a
    // prompt on the piped harness stream (US-007, DEC-005).
    const interactiveReplacement = await runCli(
      driftedFleet.home,
      ["update", driftedFleet.driftedProject, "--replace-changed"],
    );
    expectExitCode(interactiveReplacement, 0);
    expect(interactiveReplacement.stdout).toContain(".agent-profile-kit/codex/context.md");
    writeFileSync(driftedFleet.driftedOutputPath, driftedFleet.driftedBytes);
    const cancelled = await abortedApply(() =>
      applyReconciliation(driftedFleet.home, driftedFleet.desired, {
        confirmChangedOutputReplacement: () => Promise.resolve("cancelled" as const),
      }));
    expect(cancelled).toBeInstanceOf(ApplyDeclinedError);
    expect(readFileSync(driftedFleet.driftedOutputPath, "utf8")).toBe(driftedFleet.driftedBytes);
    expect(existsSync(join(driftedFleet.healthyProject, ".agent-profile-kit"))).toBe(false);
    cleanupTemporaryDirectories();
  }, 60_000);

  test("the packed newcomer journey completes real material authoring, binding, and update by following only printed actions with present and absent controlled Hosts (US-032–041, US-053, TEST-015, TEST-016, #461)", async () => {
    const home = isolatedHome();
    const firstProject = gitRepository("agent-profile-kit-rc-newcomer2-first-");
    const realProject = gitRepository("agent-profile-kit-rc-newcomer2-real-");
    const absentProject = gitRepository("agent-profile-kit-rc-newcomer2-absent-");
    // Present: claude, codex, opencode. Deliberately absent: antigravity,
    // grok, pi — the allowlist exposes only git, so detection is exact
    // machine evidence (TEST-016).
    const stubBin = join(home, "bin");
    mkdirSync(stubBin, { recursive: true });
    for (const [name, version] of [
      ["codex", "codex-cli 0.145.0"],
      ["claude", "2.1.0 (Claude Code)"],
      ["opencode", "1.18.23"],
    ] as const) {
      writeFileSync(join(stubBin, name), `#!/bin/sh\necho "${version}"\n`);
      execFileSync("chmod", ["+x", join(stubBin, name)]);
    }
    const journeyPath = `${stubBin}:${apkitBin(home)}`;

    // 1. Bare invocation on an uninitialized machine: setup state and one
    // printed next command, not a manual (US-023, US-032, US-035).
    const bare = await runCli(home, [], { path: journeyPath });
    expectExitCode(bare, 0);
    expect(bare.stdout).toContain("Agent Profile Kit is not set up on this machine.");
    const barePlain = bare.stdout.replace(/\n\s+/g, " ");
    expect(barePlain).toContain(
      "Your Workspace is one folder that holds your Profiles, Context, and Skills.",
    );
    expect(barePlain).toContain(
      "One Workspace can serve several Projects, and setup may add those folders and files.",
    );
    expect(barePlain).toContain(
      "A Project is one working folder that receives the installed material.",
    );
    // One recommended setup route leads; the current-folder form is secondary
    // in the same footer (US-001, DEC-003). Commands stay on their own lines.
    expect(bare.stdout).toContain("Next:");
    expect(bare.stdout).toContain("apkit init <path>");
    expect(bare.stdout).toContain("apkit init .");
    expect(bare.stdout.indexOf("apkit init <path>")).toBeLessThan(
      bare.stdout.indexOf("apkit init ."),
    );
    expect(bare.stdout).toContain("Run apkit --help for the full command list.");

    // 2. Follow the printed command: initialization matches the machine.
    const init = await runCli(home, ["init", "~/apkit-workspace"], { path: journeyPath });
    expectExitCode(init, 0);
    expect(init.stdout).toContain("~/apkit-workspace");
    expect(init.stdout).toContain(
      "A Profile is a named selection of Context and Skills suited to a kind of work",
    );
    // Present and absent Hosts: detection names exactly what is installed
    // (US-037) and never invents an absent Host (US-038, TEST-016).
    expect(init.stdout).toContain("Detected Agent Hosts: claude, codex, opencode");
    for (const absentHost of ["antigravity", "grok", "pi"]) {
      expect(init.stdout).not.toContain(`--host ${absentHost}`);
    }
    // Init guidance leaves Host choice to install's searchable choices
    // (spec #491, US-016, ADR-0034) and, with no example material scaffolded
    // (spec #593 DEC-003, #599), points at validate.
    expect(init.stdout.replace(/\n\s+/g, " ")).toContain(
      "Next: run apkit validate",
    );
    expect(init.stdout).not.toContain("--host");

    // 3. Author the canonical example pair, then follow the printed install
    // form, made project-specific the way the printed sentence says. Pipes
    // add --auto-confirm for the interactive general confirmation.
    writeExampleMaterial(home);
    const installExample = await runCli(
      home,
      ["install", "example", firstProject, "--host", "claude", "--auto-confirm"],
      { path: journeyPath },
    );
    expectExitCode(installExample, 0);
    expect(installExample.stdout).toContain("Installed example for");
    expect(installExample.stdout).toContain("Hosts: claude");
    expect(installExample.stdout).toContain("Next: apkit status");
    // US-017 (#515): the first installation offers the optional Host-loading
    // check beside the receipt, phrased as a user action that claims no
    // observed loading.
    expect(installExample.stdout.replace(/\n\s+/g, " ")).toContain(
      "To check that claude loaded Profile example",
    );
    expect(installExample.stdout.replace(/\n\s+/g, " ")).toContain(
      "ask claude what Profile material it loaded",
    );
    // The sentence names the installed Project by the same identity the
    // receipt body carries (US-013): no second spelling appears.
    expect(installExample.stdout).not.toContain("~/");
    expect(installExample.stdout).not.toContain("observed");
    expect(existsSync(join(firstProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);

    // 4. The newcomer works from inside the Project: install already
    // installed it, so status reports current there — no second command.
    const currentStatus = await runCli(
      home,
      ["status", firstProject],
      { path: journeyPath, cwd: firstProject },
    );
    expectExitCode(currentStatus, 0);
    expect(currentStatus.stdout).toContain("is up to date");
    expect(existsSync(join(firstProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    // NOTE (#494/#515): the first-run authoring handoff (US-040) stays an
    // update-report view owned by #509; install now offers the optional
    // Host-loading check (US-017, #515) — pinned below — while the
    // installed-selection report stays compact. First-installation teaching
    // belongs to #509 and re-covers this journey in #517.

    // 5. The newcomer authors real material with the explicit authoring
    // commands (US-040, DEC-024).
    const creationCommands = [
      "apkit new skill summarize-pr",
      "apkit new context project-rules",
      "apkit new profile real-profile --context project-rules --skill summarize-pr",
    ];
    const creations: ProcessResult[] = [];
    for (const command of creationCommands) {
      const creation = await runCli(home, command.split(" ").slice(1), { path: journeyPath });
      expectExitCode(creation, 0);
      creations.push(creation);
    }
    expect(existsSync(join(workspacePath(home), "skills", "summarize-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workspacePath(home), "context", "project-rules.md"))).toBe(true);
    expect(existsSync(join(workspacePath(home), "profiles", "real-profile.yaml"))).toBe(true);
    // The final creation receipt's next action is followable in print: one
    // install command naming the Profile actually created (US-016, #509), the
    // same handoff shape the initialization completion carries (#511).
    expect(creations[2]!.stdout.replace(/\n\s+/g, " ")).toContain(
      "Next: from the project you want to try, run apkit install real-profile",
    );
    // The vague validate-then-prose sentence is gone from the receipt.
    expect(creations[2]!.stdout).not.toContain("install the Profile into a Project");

    // 6. Author the real Profile's content, then follow the printed chain:
    // validate, then install the real Profile (US-044, TEST-017 chain).
    const validate = await runCli(home, ["validate"], { path: journeyPath });
    expectExitCode(validate, 0);
    expect(validate.stdout).toContain("real-profile");
    expect(validate.stdout).toContain("Next: apkit status");
    const installReal = await runCli(
      home,
      ["install", "real-profile", realProject, "--host", "claude", "--auto-confirm"],
      { path: journeyPath },
    );
    expectExitCode(installReal, 0);
    expect(installReal.stdout).toContain("Profile: real-profile");
    expect(existsSync(join(realProject, ".claude", "skills", "summarize-pr", "SKILL.md"))).toBe(true);

    // 7. An absent Host stays advisory: installing a Project on a Host that
    // is not installed warns inline, writes the material, and never changes
    // the exit code (US-017–019, TEST-009, TEST-021).
    const absentInstall = await runCli(
      home,
      ["install", "real-profile", absentProject, "--host", "grok", "--auto-confirm"],
      { path: journeyPath },
    );
    expectExitCode(absentInstall, 0);
    expect(absentInstall.stdout).toContain("Grok");
    expect(absentInstall.stdout).not.toContain("Warnings:");
    expect(existsSync(join(absentProject, ".grok", "rules", "agent-profile-kit.md"))).toBe(true);

    // 8. The journey ends where the user is heading: every touched Project is
    // current, and the bare invocation summarizes the settled fleet.
    const finalStatus = await runCliDefaultScope(home, ["status"], { path: journeyPath });
    expectExitCode(finalStatus, 0);
    expect(finalStatus.stdout).toBe("✔ All Projects are up to date (3 Projects)\n");
    const bareConfigured = await runCli(home, [], { path: journeyPath });
    expectExitCode(bareConfigured, 0);
    expect(bareConfigured.stdout).toContain("3 Projects up to date.");
    expect(bareConfigured.stdout).toContain("Common next steps:");
    expect(bareConfigured.stdout).not.toContain("machine");
  }, 30_000);

  test("one packed newcomer journey proves bare help, init, validate, bind, ready status, changed update, current status, temporary install, the exact printed remove command, and successful removal (TEST-017)", async () => {
    const home = isolatedHome();
    const boundProject = gitRepository("agent-profile-kit-rc-newcomer-git-");
    const temporaryProject = project("agent-profile-kit-rc-newcomer-nongit-");
    // Intended availability is explicit (issue #541, the CI-conditioned
    // TEST-017 failure): all six controlled Host stubs, so the journey's
    // all-six detection expectation is machine evidence of the fixture's
    // selection, never of the runner's ambient Hosts. The `apkit` bin shim
    // precedes the stubs so the journey's printed commands stay executable
    // as printed; one composed controlled PATH, no ambient tail.
    installAllControlledHosts(home);
    const pathWithHosts = controlledPath(home, {
      stubBins: [apkitBin(home), join(home, "bin")],
    });

    // 1. Bare help: discover root command surface and first-run guidance.
    const help = await runCli(home, ["--help"], { path: pathWithHosts });
    expectExitCode(help, 0);
    expect(help.stdout).toContain("First run:\n  apkit init <path>\n  apkit install <profile> --host <host>\n  apkit status\n  apkit update");
    expect(help.stdout).toContain("Common commands:\n  init");
    expect(help.stdout).toContain("More commands:\n  Inventory:");

    // 2. Initialize the user-given Workspace folder and settings; setup
    // adds only the required parts (spec #593 DEC-003, #599, #601).
    const init = await runCli(home, ["init", "~/apkit-workspace"], { path: pathWithHosts });
    expectExitCode(init, 0);
    expect(init.stdout.replace(/\n\s+/g, " ")).toContain("Created the Workspace folder and initialized Agent Profile Kit Workspace and settings at");
    expect(init.stdout).toContain("~/apkit-workspace");
    expect(init.stdout).toContain("A Profile is a named selection of Context and Skills suited to a kind of work");
    expect(init.stdout).toContain("Detected Agent Hosts: antigravity, claude, codex, grok, opencode, pi");
    expect(init.stdout).toContain("Next: run apkit validate");
    expect(existsSync(workspacePath(home))).toBe(true);
    expect(existsSync(configPath(home))).toBe(true);
    enableCodexHooks(home);

    // 3. Validate: check the empty initial state points to authoring.
    const validate = await runCli(home, ["validate"], { path: pathWithHosts });
    expectExitCode(validate, 0);
    expect(validate.stdout).toContain(
      "Workspace and settings valid (0 Profiles, 0 configured Projects)",
    );
    expect(validate.stdout).toContain("Profiles found: none");
    expect(validate.stdout).toContain("Hosts bound: none");
    expect(validate.stdout).toContain("Next: apkit install <profile> --host <host>");

    // 4. Author the canonical example pair, then install it into the
    // configured Git Project in one action (pipes add --auto-confirm for the
    // interactive general confirmation).
    writeExampleMaterial(home);
    const install = await runCli(
      home,
      ["install", "example", boundProject, "--host", "codex", "--auto-confirm"],
      { path: pathWithHosts },
    );
    expectExitCode(install, 0);
    expect(install.stdout).toContain("Installed example for");
    expect(install.stdout).toContain("Profile: example");
    expect(install.stdout).toContain("Hosts: codex");
    expect(install.stdout).toContain("Next: apkit status");
    expect(existsSync(join(boundProject, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(boundProject, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(boundProject, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(existsSync(statePath(home))).toBe(true);

    // 5. Current status: install already installed, so status states that
    // fact once with no next action.
    const currentStatus = await runCli(
      home,
      ["status", boundProject],
      { path: pathWithHosts },
    );
    expectExitCode(currentStatus, 0);
    expect(currentStatus.stdout).toContain("is up to date");
    expect(currentStatus.stdout).not.toContain("Next:");
    expect(currentStatus.stdout).not.toContain("Standing Host setup:");
    expect(currentStatus.stdout).not.toContain("Host setup:");

    // 6. Changed update: drift the installed output, then follow the printed
    // commands. The Details route executes verbatim through a shell (INT-1,
    // RE-1 on #489): the selected Project is a typed path argument rendered
    // through the shared project-scope identity, and a copyable command token
    // is never middle-elided.
    writeFileSync(
      join(boundProject, ".agent-profile-kit", "codex", "context.md"),
      "hand-edited bytes\n",
    );
    const pendingStatus = await runCli(
      home,
      ["status", boundProject],
      { path: pathWithHosts },
    );
    expectExitCode(pendingStatus, 0);
    const nextLine = pendingStatus.stdout.split("\n")
      .find((line) => line.startsWith("Next: apkit update "));
    const detailsLine = pendingStatus.stdout.split("\n")
      .find((line) => line.startsWith("Details: apkit status "));
    for (const line of [nextLine, detailsLine]) {
      expect(line).toBeDefined();
      expect(line!.includes("…")).toBe(false);
      expect(line!.includes(boundProject.split("/").at(-1)!)).toBe(true);
    }
    expect(detailsLine!.endsWith("--verbose")).toBe(true);
    const details = await runProcess({
      executable: realpathSync("/bin/sh"),
      arguments_: ["-c", detailsLine!.replace("Details: ", "")],
      environment: controlledEnvironment({ home, path: pathWithHosts }),
      cwd: boundProject,
      deadlineMs: TEST_CHILD_DEADLINE_MS,
      commandLabel: "printed Details command via shell",
    });
    expectExitCode(details, 0);
    // US-041 (DEC-025, OOS-009): the drifted update states the concrete
    // Project-local action that checks whether the Host loaded the Profile,
    // without claiming Agent Profile Kit observed that loading.
    const refusedDrift = await runCli(home, ["update", boundProject], { path: pathWithHosts });
    expectExitCode(refusedDrift, 1);
    expect(refusedDrift.stderr).toContain("--replace-changed");
    const apply = await runCli(
      home,
      ["update", boundProject, "--replace-changed"],
      { path: pathWithHosts },
    );
    expectExitCode(apply, 0);
    expect(apply.stdout).toContain("Update complete");
    expect(humanText(apply.stdout)).toMatch(/Updated 1 Project \(\d+ generated files?\)\./);
    expect(humanText(apply.stdout)).toContain("Details: apkit details");
    const humanApply = humanText(apply.stdout);
    // US-017 (#515): this drifted update is an ordinary repeated content
    // update — the receipt proves no first delivery — so it offers no
    // optional loading check; the readiness reminder is the short
    // new-session guidance that remains.
    expect(humanApply).not.toContain("To check that ");
    expect(humanApply).toContain(
      "Profile example will load the next time you launch a configured Host from a",
    );
    expect(apply.stdout).not.toContain("already current");
    expect(apply.stdout).not.toContain("Now author your own:");

    // 6b. The authored-material chain (three `new` receipts, the followable
    // validate next action, and the authored-Profile install) is qualified by
    // the sibling present/absent-Hosts newcomer journey above (#546, C2);
    // repeating it here duplicated that evidence at the same packed boundary.

    // 6c. Routine apply: restoring a hand-edited generated file reports the
    // replacement, keeps the readiness reminder, and offers no optional
    // loading check (US-017, #515; DEC-024). The explicit answering flag
    // authorizes the replacement (US-007, DEC-005); without it the scope
    // refuses (DEC-005).
    writeFileSync(
      join(boundProject, ".agent-profile-kit", "codex", "context.md"),
      "hand-edited bytes\n",
    );
    const restoreRefused = await runCli(home, ["update", boundProject], { path: pathWithHosts });
    expectExitCode(restoreRefused, 1);
    expect(restoreRefused.stderr).toContain("--replace-changed");
    const restore = await runCli(
      home,
      ["update", boundProject, "--replace-changed"],
      { path: pathWithHosts },
    );
    expectExitCode(restore, 0);
    expect(humanText(restore.stdout)).toMatch(/Updated 1 Project \(\d+ generated files?\)\./);
    // Discriminating negative against the same output: the routine restore
    // offers no optional loading check (US-017, #515).
    expect(restore.stdout).not.toContain("To check that ");
    expect(humanText(restore.stdout)).toContain(
      "Profile example will load the next time you launch a configured Host from a",
    );
    expect(restore.stdout).not.toContain("Now author your own:");
    expect(restore.stdout).not.toContain("apkit new ");

    // 6d. Routine maintenance: adding a Host to the installed example
    // installs the new outputs in the same action (INT-1, US-040, DEC-024).
    const addHost = await runCli(
      home,
      ["install", "example", boundProject, "--host", "codex", "--host", "claude", "--auto-confirm"],
      { path: pathWithHosts },
    );
    expectExitCode(addHost, 0);
    expect(humanText(addHost.stdout)).toContain("Hosts: codex → claude, codex");
    // US-017 (#515): adding a Host to the installed example offers the
    // optional loading check beside the install receipt.
    expect(humanText(addHost.stdout)).toContain(
      "To check that claude and codex loaded Profile example",
    );
    expect(existsSync(join(boundProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    // A follow-up source change is a routine update: it reconciles both
    // Hosts with the readiness reminder and no loading check.
    writeFileSync(
      join(boundProject, ".agent-profile-kit", "codex", "context.md"),
      "hand-edited bytes\n",
    );
    const maintenance = await runCli(home, ["update", boundProject, "--replace-changed"], { path: pathWithHosts });
    expectExitCode(maintenance, 0);
    expect(humanText(maintenance.stdout)).toMatch(/Updated 1 Project \(\d+ generated files?\)\./);
    expect(maintenance.stdout).not.toContain("To check that ");
    expect(humanText(maintenance.stdout)).toContain(
      "Profile example will load the next time you launch a configured Host from a",
    );
    expect(maintenance.stdout).not.toContain("apkit new ");

    // 7. Current status: clean status states that fact once with no next action.
    const cleanStatus = await runCli(
      home,
      ["status", boundProject],
      { path: pathWithHosts },
    );
    expectExitCode(cleanStatus, 0);
    expect(cleanStatus.stdout).toContain("is up to date");
    expect(cleanStatus.stdout).not.toContain("Next:");
    expect(cleanStatus.stdout).not.toContain("Standing Host setup:");
    expect(cleanStatus.stdout).not.toContain("Host setup:");

    // 8. Temporary install: install temporary Profile to non-Git Project.
    const installTemp = await runCli(
      home,
      ["machine", "install-temp", "example", temporaryProject, "--host", "codex"],
      { path: pathWithHosts },
    );
    expectExitCode(installTemp, 0);
    expect(installTemp.stdout).toContain("Installed temporary Profile");
    expect(installTemp.stdout).toContain("Profile: example");
    expect(installTemp.stdout).toContain("Host: codex");
    expect(installTemp.stdout).toContain("Temporary installation:");
    expect(existsSync(join(temporaryProject, ".agent-profile-kit", "codex", "context.md"))).toBe(true);

    // 9. Exact printed remove command: parse and execute the printed Next command.
    const printed = installTemp.stdout.match(/^Next: (apkit machine remove-temp (\S+))$/m);
    expect(printed?.[2]).toBeTruthy();
    const tempId = printed![2]!;
    expect(tempId).toMatch(/^[0-9a-f-]+$/);

    // 10. Successful removal: execute the exact printed command and verify clean state.
    const removeTemp = await runCli(
      home,
      printed![1]!.split(" ").slice(1),
      { path: pathWithHosts },
    );
    expectExitCode(removeTemp, 0);
    expect(removeTemp.stdout).toContain("Removed temporary Profile");
    expect(removeTemp.stdout).toContain(`Temporary installation: ${tempId}`);
    expect(existsSync(join(temporaryProject, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(temporaryProject, ".agent-profile-kit", "installation.json"))).toBe(false);
  }, 30_000);

  test("Agent Host detection is proven with controlled executables present and absent (TEST-016)", async () => {
    // Every case composes stub bins with an allowlisted bin so no real Host
    // executable on the runner can satisfy a probe; detection is exact.

    // 1. All controlled hosts present: guidance names no Host, even when several are detected
    const allHome = isolatedHome();
    const allBin = installAllHostStubs(allHome);
    const allPath = `${allBin}:${allowlistBin(allHome)}`;
    const allInit = await runCli(allHome, ["init", "~/apkit-workspace"], { path: allPath });
    expectExitCode(allInit, 0);
    expect(allInit.stdout).toContain("Detected Agent Hosts: antigravity, claude, codex, grok, opencode, pi");
    expect(allInit.stdout).toContain("Next: run apkit validate");

    // 2. Single host present (only codex): still no Host in init guidance
    const codexHome = isolatedHome();
    const codexBin = join(codexHome, "bin");
    mkdirSync(codexBin, { recursive: true });
    writeFileSync(
      join(codexBin, "codex"),
      '#!/bin/sh\necho "codex-cli 0.145.0"\n',
    );
    execFileSync("chmod", ["+x", join(codexBin, "codex")]);
    const codexPath = `${codexBin}:${allowlistBin(codexHome)}`;
    const codexInit = await runCli(codexHome, ["init", "~/apkit-workspace"], { path: codexPath });
    expectExitCode(codexInit, 0);
    expect(codexInit.stdout).toContain("Detected Agent Hosts: codex");
    expect(codexInit.stdout).toContain("Next: run apkit validate");
    // Discriminating negative: the old output contained "--host codex" here.
    expect(codexInit.stdout).not.toContain("--host");

    // 3. Single host present (only claude): still no Host in init guidance
    const claudeHome = isolatedHome();
    const claudeBin = join(claudeHome, "bin");
    mkdirSync(claudeBin, { recursive: true });
    writeFileSync(
      join(claudeBin, "claude"),
      '#!/bin/sh\necho "2.1.0 (Claude Code)"\n',
    );
    execFileSync("chmod", ["+x", join(claudeBin, "claude")]);
    const claudePath = `${claudeBin}:${allowlistBin(claudeHome)}`;
    const claudeInit = await runCli(claudeHome, ["init", "~/apkit-workspace"], { path: claudePath });
    expectExitCode(claudeInit, 0);
    expect(claudeInit.stdout).toContain("Detected Agent Hosts: claude");
    expect(claudeInit.stdout.replace(/\s+/g, " ")).toContain("Next: run apkit validate");
    // Discriminating negative: the old output contained "--host claude" here.
    expect(claudeInit.stdout).not.toContain("--host");

    // 4. No supported hosts present: names none and still names the example install action
    // (detection is advisory; undetected Hosts remain selectable install choices)
    const noHostsHome = isolatedHome();
    const emptyBin = join(noHostsHome, "empty-bin");
    mkdirSync(emptyBin, { recursive: true });
    const emptyPath = `${emptyBin}:${allowlistBin(noHostsHome)}`;
    const noHostsInit = await runCli(noHostsHome, ["init", "~/apkit-workspace"], { path: emptyPath });
    expectExitCode(noHostsInit, 0);
    expect(noHostsInit.stdout).toContain("Detected Agent Hosts: none");
    expect(noHostsInit.stdout).toContain("Next: run apkit validate");
    expect(noHostsInit.stdout).not.toContain("--host");
  }, 30_000);

  test("detecting commands never start Host executables on PATH (TEST-011)", async () => {
    // A fake Codex executable that writes a marker and never exits when
    // started: every detecting command must report presence without running
    // it (spec #593, US-009, DEC-012). Detection previously spawned the
    // Host CLI, hung init on SIGTERM-resistant stubs (PROD-001), and wrote
    // Host state files into the user's home.
    const home = isolatedHome();
    const stubBin = join(home, "bin");
    mkdirSync(stubBin, { recursive: true });
    const markerFile = join(home, "started-marker");
    const pidFile = join(home, "stub.pid");
    writeFileSync(
      join(stubBin, "codex"),
      `#!/bin/sh\necho $$ > '${pidFile}'\necho started > '${markerFile}'\n/bin/sleep 30\n`,
    );
    execFileSync("chmod", ["+x", join(stubBin, "codex")]);
    const stubPath = `${stubBin}:${allowlistBin(home)}`;

    // 1. init reports the present executable without starting it.
    const init = await runCli(home, ["init", "~/apkit-workspace"], { path: stubPath });
    expectExitCode(init, 0);
    expect(init.stdout).toContain("Detected Agent Hosts: codex");
    expect(init.stdout).toContain("Next: run apkit validate");
    // Discriminating negative: the old output contained "--host codex" here.
    expect(init.stdout).not.toContain("--host");

    // 2. list hosts is the read-only detecting command: its isolated home
    // and working directory are unchanged and the fake stays silent.
    const cwd = project();
    const homeBefore = fileTree(home);
    const cwdBefore = fileTree(cwd);
    const hosts = await runCli(home, ["list", "hosts"], { path: stubPath, cwd });
    expectExitCode(hosts, 0);
    expect(hosts.stdout).toContain("codex — installed");
    expect(fileTree(home)).toEqual(homeBefore);
    expect(fileTree(cwd)).toEqual(cwdBefore);

    // The SIGTERM-resistant stub group never started: no pid, no marker, no
    // lingering process (the old detection timed out and killed the stub).
    expect(existsSync(markerFile)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  }, 30_000);

  test("bare init after adopting an external aliased Workspace renders the authored alias (TEST-016)", async () => {
    // Adopt a valid Workspace whose symlink target lives outside HOME, so the
    // canonical physical path cannot be home-relative.
    const home = isolatedHome();
    const physical = mkdtempSync(join(tmpdir(), "agent-profile-kit-rc-external-ws-"));
    temporaryDirectories.push(physical);
    const alias = join(home, "workspace-alias");
    symlinkSync(physical, alias);
    writeFileSync(join(physical, "workspace.yaml"), "schema_version: 1\n");
    for (const directory of ["profiles", "context", "skills"]) {
      mkdirSync(join(physical, directory));
    }
    const allowBin = allowlistBin(home);

    const adopt = await runCli(home, ["init", alias], { path: allowBin });
    expectExitCode(adopt, 0);
    expect(adopt.stdout).toContain("~/workspace-alias");

    // Bare unchanged init must carry the effective authored selection from
    // Local Configuration, not the physical target outside HOME.
    const bare = await runCli(home, ["init"], { path: allowBin });
    expectExitCode(bare, 0);
    expect(bare.stdout).toContain("~/workspace-alias");
    expect(bare.stdout).not.toContain(physical);
  }, 30_000);

  test("printed lifecycle commands shell-escape space-containing Project paths and execute exactly as printed (US-007, review RE-1 on #489)", async () => {
    const home = isolatedHome();
    expectExitCode(await runCli(home, ["init", "~/apkit-workspace"]), 0);
    enableCodexHooks(home);
    writeWorkspaceAuthoring(home);
    writeExampleMaterial(home);
    // A Project whose path contains spaces: the copyable Next and Details
    // command arguments must survive the shell that runs them.
    const spacedProject = mkdtempSync(join(tmpdir(), "agent profile kit rc spaced-"));
    temporaryDirectories.push(spacedProject);
    execFileSync("git", ["init", "-q", spacedProject]);
    writeBindings(home, [{ project: spacedProject, profile: "example", hosts: ["codex"] }]);

    // One PATH for the whole case: git for lifecycle inspection plus the
    // packed `apkit` bin shim, so printed commands resolve as printed.
    const gitOnlyPath = apkitBin(home);
    const status = await runCli(home, ["status", spacedProject], { path: gitOnlyPath, cwd: spacedProject });
    expectExitCode(status, 0);
    const nextLine = status.stdout.split("\n").find((line) => line.startsWith("Next: apkit update "))!;
    const detailsLine = status.stdout.split("\n").find((line) => line.startsWith("Details: apkit status "))!;
    // The path argument is one shell-quoted token around the full identity,
    // so the shell hands the Project to apkit as exactly one argument.
    expect(nextLine).toBe(`Next: apkit update '${spacedProject}'`);
    expect(detailsLine).toBe(`Details: apkit status '${spacedProject}' --verbose`);

    // Executing the printed tokens verbatim through a shell: the quoted path
    // survives tokenization and apply receives one argument.
    const shell = realpathSync("/bin/sh");
    const applied = await runProcess({
      executable: shell,
      arguments_: ["-c", nextLine.replace("Next: ", "")],
      environment: controlledEnvironment({ home, path: gitOnlyPath }),
      cwd: spacedProject,
      deadlineMs: TEST_CHILD_DEADLINE_MS,
      commandLabel: "printed Next command via shell",
    });
    expectExitCode(applied, 0);
    expect(applied.stdout).toContain("Update complete");
    expect(existsSync(join(spacedProject, ".agent-profile-kit", "codex", "context.md"))).toBe(true);

    // The Details route executes as printed too.
    const details = await runProcess({
      executable: shell,
      arguments_: ["-c", detailsLine.replace("Details: ", "")],
      environment: controlledEnvironment({ home, path: gitOnlyPath }),
      cwd: spacedProject,
      deadlineMs: TEST_CHILD_DEADLINE_MS,
      commandLabel: "printed Details command via shell",
    });
    expectExitCode(details, 0);
  }, 30_000);

  test("a deliberately partial controlled Host selection stays independent of ambient Host executables and unrelated ambient environment (TEST-004, US-003, #541)", async () => {
    // Deliberate selection: the controlled fixture stubs only claude and
    // codex. agy, grok, opencode, and pi are deliberately unselected: no
    // controlled executable exists for them, and no ambient machine
    // environment may complete their probes (TEST-004, ISC-16).
    const calmHome = isolatedHome();
    const calm = await runCli(calmHome, ["init", "~/apkit-workspace"], {
      path: installControlledHosts(calmHome),
    });
    expectExitCode(calm, 0);
    const calmDetection = calm.stdout
      .split("\n")
      .find((line) => line.startsWith("Detected Agent Hosts:"))!;
    expect(calmDetection).toBeDefined();

    // Hostile ambient window: trap executables stand in for every Host name
    // ahead of the runner's PATH, plus unrelated varied values. A fixture
    // that leaks the ambient PATH resolves an unselected probe into the trap
    // instead of a real installed Host, and the recorded log is the evidence
    // of absence.
    const hostileHome = isolatedHome();
    const traps = createHostTrapBin(hostileHome);
    const hostile = hostileAmbient({
      trapBin: traps.bin,
      logPath: traps.logPath,
      values: { COLUMNS: "7", PAGER: "/nonexistent-agent-profile-kit-pager" },
    });
    try {
      const variedHome = isolatedHome();
      const varied = await runCli(variedHome, ["init", "~/apkit-workspace"], {
        path: installControlledHosts(variedHome),
      });
      expectExitCode(varied, 0);
      expect(
        varied.stdout.split("\n").find((line) => line.startsWith("Detected Agent Hosts:")),
      ).toBe(calmDetection);
      expect(hostile.trapLog(), "no unselected Host-named executable may run").toEqual([]);
    } finally {
      hostile.restore();
    }
  }, 30_000);

  test("the packed release-candidate journey qualifies the three setup starting points end-to-end (TEST-001, TEST-003, TEST-013, OOS-001, #608)", async () => {
    const home = isolatedHome();
    const fixtureRoot = resolve(repositoryRoot, "test", "support", "fixtures", "scattered-sample");
    const fixtureMaterial = join(fixtureRoot, "material");

    // -----------------------------------------------------------------------
    // Fixture verification: sample material follows TEST-013
    // -----------------------------------------------------------------------
    // Instruction files in project folders
    expect(existsSync(join(fixtureMaterial, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(fixtureMaterial, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(fixtureMaterial, "docs", "AGENTS.md"))).toBe(true);
    // Standard Skills in more than one Host folder, including Host-specific frontmatter
    // and Skill Resources (references and scripts)
    expect(existsSync(join(fixtureMaterial, ".claude", "skills", "code-review", "SKILL.md"))).toBe(true);
    expect(existsSync(join(fixtureMaterial, ".agents", "skills", "build-helper", "SKILL.md"))).toBe(true);
    expect(
      existsSync(join(fixtureMaterial, ".agents", "skills", "build-helper", "references", "reference.md")),
    ).toBe(true);
    expect(
      existsSync(join(fixtureMaterial, ".agents", "skills", "build-helper", "scripts", "build.sh")),
    ).toBe(true);
    // Provenance README stays beside material/ (not inside it)
    expect(existsSync(join(fixtureRoot, "README.md"))).toBe(true);
    expect(existsSync(join(fixtureMaterial, "README.md"))).toBe(false);

    // -----------------------------------------------------------------------
    // Starting Point 1: No material
    // -----------------------------------------------------------------------
    const emptyWorkspace = join(home, "workspace-empty");
    const initEmpty = await runCli(home, ["init", emptyWorkspace]);
    expectExitCode(initEmpty, 0);

    // Assert on files on disk: setup adds only missing parts, no extra docs or profiles (ADR-0047, DEC-003)
    expect(existsSync(join(emptyWorkspace, "workspace.yaml"))).toBe(true);
    expect(readFileSync(join(emptyWorkspace, "workspace.yaml"), "utf8")).toBe("schema_version: 1\n");
    expect(existsSync(join(emptyWorkspace, "context"))).toBe(true);
    expect(existsSync(join(emptyWorkspace, "skills"))).toBe(true);
    expect(existsSync(join(emptyWorkspace, "profiles"))).toBe(true);
    expect(readdirSync(emptyWorkspace).sort()).toEqual([
      "context",
      "profiles",
      "skills",
      "workspace.yaml",
    ]);
    expect(readdirSync(join(emptyWorkspace, "context"))).toEqual([]);
    expect(readdirSync(join(emptyWorkspace, "skills"))).toEqual([]);
    expect(readdirSync(join(emptyWorkspace, "profiles"))).toEqual([]);

    // Assert Local Configuration
    expect(existsSync(configPath(home))).toBe(true);
    const configAfterEmpty = parse(readFileSync(configPath(home), "utf8"));
    expect(configAfterEmpty.schema_version).toBe(2);
    expect(configAfterEmpty.workspace).toBe(emptyWorkspace);
    expect(configAfterEmpty.bindings).toEqual([]);

    // Validate empty workspace
    const validateEmpty = await runCli(home, ["validate"]);
    expectExitCode(validateEmpty, 0);
    expect(validateEmpty.stdout).toContain(
      "Workspace and settings valid (0 Profiles, 0 configured Projects)",
    );
    expect(validateEmpty.stdout).toContain("Profiles found: none");

    // -----------------------------------------------------------------------
    // Starting Point 2: Scattered material
    // -----------------------------------------------------------------------
    // OOS-001: apkit never finds, imports, copies or converts scattered material;
    // the test stands in for the user by moving the sample material into the folder.
    const scatteredWorkspace = join(home, "workspace-scattered");
    mkdirSync(join(scatteredWorkspace, "context", "docs"), { recursive: true });
    mkdirSync(join(scatteredWorkspace, "skills"), { recursive: true });

    // Move instruction files into context/
    cpSync(join(fixtureMaterial, "AGENTS.md"), join(scatteredWorkspace, "context", "AGENTS.md"));
    cpSync(join(fixtureMaterial, "CLAUDE.md"), join(scatteredWorkspace, "context", "CLAUDE.md"));
    cpSync(join(fixtureMaterial, "docs", "AGENTS.md"), join(scatteredWorkspace, "context", "docs", "AGENTS.md"));

    // Move skills from host folders into skills/
    cpSync(
      join(fixtureMaterial, ".claude", "skills", "code-review"),
      join(scatteredWorkspace, "skills", "code-review"),
      { recursive: true },
    );
    cpSync(
      join(fixtureMaterial, ".agents", "skills", "build-helper"),
      join(scatteredWorkspace, "skills", "build-helper"),
      { recursive: true },
    );

    // Validate unconnected folder: reports every violation in one run (#604)
    const validateScattered = await runCli(home, ["validate", scatteredWorkspace]);
    expectExitCode(validateScattered, 1);
    const validateOutput = validateScattered.stderr + validateScattered.stdout;
    expect(validateOutput).toContain("missing required file 'workspace.yaml'");
    expect(validateOutput).toContain("context/AGENTS.md");
    expect(validateOutput).toContain("rename the file to context/agents.md");
    expect(validateOutput).toContain("context/CLAUDE.md");
    expect(validateOutput).toContain("rename the file to context/claude.md");
    expect(validateOutput).toContain("context/docs/AGENTS.md");
    expect(validateOutput).toContain("rename the file to context/docs/agents.md");

    // Attempting init before fixing must refuse and perform zero writes (DEC-011, #599)
    const initInvalid = await runCli(home, ["init", scatteredWorkspace]);
    expectExitCode(initInvalid, 1);
    const initOutput = initInvalid.stderr + initInvalid.stdout;
    expect(initOutput).toContain("context/AGENTS.md");
    expect(initOutput).toContain("context/CLAUDE.md");
    expect(initOutput).toContain("context/docs/AGENTS.md");
    // Assert zero writes to scatteredWorkspace
    expect(existsSync(join(scatteredWorkspace, "workspace.yaml"))).toBe(false);
    expect(existsSync(join(scatteredWorkspace, "profiles"))).toBe(false);
    // Local configuration still points to emptyWorkspace
    expect(parse(readFileSync(configPath(home), "utf8")).workspace).toBe(emptyWorkspace);

    // Fix violations driven by validation output
    renameSync(
      join(scatteredWorkspace, "context", "AGENTS.md"),
      join(scatteredWorkspace, "context", "agents.md"),
    );
    renameSync(
      join(scatteredWorkspace, "context", "CLAUDE.md"),
      join(scatteredWorkspace, "context", "claude.md"),
    );
    renameSync(
      join(scatteredWorkspace, "context", "docs", "AGENTS.md"),
      join(scatteredWorkspace, "context", "docs", "agents.md"),
    );

    // Now init and connect without a TTY (#607): adds missing parts (#599)
    const initFixed = await runCli(home, ["init", scatteredWorkspace]);
    expectExitCode(initFixed, 0);
    expect(existsSync(join(scatteredWorkspace, "workspace.yaml"))).toBe(true);
    expect(existsSync(join(scatteredWorkspace, "profiles"))).toBe(true);
    expect(parse(readFileSync(configPath(home), "utf8")).workspace).toBe(scatteredWorkspace);

    // Validate connected Workspace: now valid
    const validateConnected = await runCli(home, ["validate"]);
    expectExitCode(validateConnected, 0);

    // Author a Profile selecting all Context Modules and Skills
    const newProfile = await runCli(home, [
      "new",
      "profile",
      "consolidated",
      "--context",
      "agents",
      "--context",
      "claude",
      "--context",
      "docs/agents",
      "--skill",
      "code-review",
      "--skill",
      "build-helper",
    ]);
    expectExitCode(newProfile, 0);
    expect(existsSync(join(scatteredWorkspace, "profiles", "consolidated.yaml"))).toBe(true);

    // Install into a project: assert every sample Context file and Skill (including resources) is installed
    const boundProject = gitRepository("agent-profile-kit-rc-scattered-proj-");
    const installScattered = await runCli(home, [
      "install",
      "consolidated",
      boundProject,
      "--host",
      "claude",
      "--auto-confirm",
    ]);
    expectExitCode(installScattered, 0);

    // Assert installed Context in project
    const installedRulesPath = join(boundProject, ".claude", "rules", "agent-profile-kit.md");
    expect(existsSync(installedRulesPath)).toBe(true);
    const installedRules = readFileSync(installedRulesPath, "utf8");
    expect(installedRules).toContain("Project Guidelines");
    expect(installedRules).toContain("Claude Instructions");
    expect(installedRules).toContain("Architecture Guidelines");

    // Assert installed Skills in project
    const installedCodeReview = join(boundProject, ".claude", "skills", "code-review", "SKILL.md");
    expect(existsSync(installedCodeReview)).toBe(true);
    expect(readFileSync(installedCodeReview, "utf8")).toContain("user-invocable: true");

    const installedBuildHelper = join(boundProject, ".claude", "skills", "build-helper", "SKILL.md");
    expect(existsSync(installedBuildHelper)).toBe(true);
    const installedRef = join(boundProject, ".claude", "skills", "build-helper", "references", "reference.md");
    expect(existsSync(installedRef)).toBe(true);
    expect(readFileSync(installedRef, "utf8")).toContain("Build Reference");
    const installedScript = join(boundProject, ".claude", "skills", "build-helper", "scripts", "build.sh");
    expect(existsSync(installedScript)).toBe(true);
    expect(readFileSync(installedScript, "utf8")).toContain("build-helper: validating build artifacts");

    // -----------------------------------------------------------------------
    // Starting Point 3: Existing valid Workspace
    // -----------------------------------------------------------------------
    // Starting Point 3 in a fresh isolated home (an uninitialized machine with existing Workspace)
    const existingHome = isolatedHome();
    const existingWorkspace = join(existingHome, "workspace-existing");
    mkdirSync(join(existingWorkspace, "context"), { recursive: true });
    mkdirSync(join(existingWorkspace, "skills", "standard-skill"), { recursive: true });
    mkdirSync(join(existingWorkspace, "profiles"), { recursive: true });
    writeFileSync(join(existingWorkspace, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(existingWorkspace, "context", "standards.md"), "Existing standards.\n");
    writeFileSync(
      join(existingWorkspace, "skills", "standard-skill", "SKILL.md"),
      "---\nname: standard-skill\ndescription: An existing skill.\n---\n\n# Standard Skill\n",
    );
    writeFileSync(
      join(existingWorkspace, "profiles", "standard.yaml"),
      "context:\n  - standards\nskills:\n  - standard-skill\n",
    );

    // Capture file tree snapshot before connecting (TEST-003 constraint)
    const beforeSnapshot = fileTree(existingWorkspace);

    // One command without a TTY connects it (#607)
    const connectExisting = await runCli(existingHome, ["init", existingWorkspace]);
    expectExitCode(connectExisting, 0);

    // Assert Local Configuration selects the existing Workspace
    expect(parse(readFileSync(configPath(existingHome), "utf8")).workspace).toBe(existingWorkspace);

    // Assert zero files changed, added, or deleted in the existing Workspace (TEST-003 constraint)
    const afterSnapshot = fileTree(existingWorkspace);
    expect(afterSnapshot).toEqual(beforeSnapshot);

    // Validate reflects the connected existing workspace
    const validateExisting = await runCli(existingHome, ["validate"]);
    expectExitCode(validateExisting, 0);
    expect(validateExisting.stdout).toContain("Profiles found: standard");

    // Switching an existing configured machine to a different Workspace preserves Project Bindings
    // and reports missing Profile bindings (#607)
    const switchWorkspace = await runCli(home, ["init", existingWorkspace]);
    expectExitCode(switchWorkspace, 0);
    expect(switchWorkspace.stdout).toContain("Project Bindings whose Profile this Workspace lacks");
    expect(switchWorkspace.stdout).toContain("Profile 'consolidated' does not exist in this Workspace");
    const switchedConfig = parse(readFileSync(configPath(home), "utf8"));
    expect(switchedConfig.workspace).toBe(existingWorkspace);
    expect(switchedConfig.bindings.length).toBe(1);
    expect(switchedConfig.bindings[0].project).toBe(boundProject);
  }, 30_000);
});

