import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

import { WORKSPACE_SCHEMA_VERSION } from "../schemas/workspace-manifest.js";
import {
  installContextOnlyCodex,
  nodeInstallationFileSystem,
  updateContextOnlyCodex,
} from "../installer/install.js";
import { workspaceGitProvenance } from "../installer/git-provenance.js";
import { uninstallContextOnlyCodex } from "../installer/uninstall.js";
import { withCodexLifecycleLock } from "../installer/codex-lifecycle-lock.js";
import { type ContextOnlyCodexPlan } from "../installer/plan.js";
import {
  codexSkillLibraryPath,
  planCodexSkillLibrary,
  syncCodexSkillLibrary,
} from "../installer/codex-skill-library.js";
import { ingestWorkspace } from "../installer/ingest-workspace.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = join(repositoryRoot, "dist", "cli.js");
const packageManifest = (
  JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    readonly os?: readonly string[];
    readonly version: string;
  }
);
const temporaryDirectories: string[] = [];

beforeAll(() => {
  execFileSync("bun", ["run", "build"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
});

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function isolatedHome(prefix = "agent-profile-kit-test-"): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(home);
  return home;
}

function runCli(home: string, ...arguments_: string[]) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function runCliWithEnvironment(
  home: string,
  environment: NodeJS.ProcessEnv,
  ...arguments_: string[]
) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, ...environment, HOME: home },
  });
}

function runCliFromDirectory(
  home: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
  ...arguments_: string[]
) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...environment, HOME: home },
  });
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function writeContextOnlyProfile(home: string): void {
  const workspace = workspacePath(home);
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\n---\nAlways preserve the project boundary.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
  );
}

function writeProfileWithSkill(home: string): void {
  const workspace = workspacePath(home);
  writeContextOnlyProfile(home);
  const skill = join(workspace, "skills", "review-pr");
  mkdirSync(skill);
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: review-pr\ndescription: Review a pull request. Use when asked to review code changes.\n---\n\n# Review a pull request\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills:\n  - review-pr\nagents: []\nhooks: []\ntools: []\n",
  );
}

function emptySkillLibraryPlan(home: string) {
  return {
    additions: [],
    changes: [],
    destination: codexSkillLibraryPath(home),
    home,
    removals: [],
    skills: new Map(),
    workspaceInputHash: `sha256:${createHash("sha256")
      .update(
        JSON.stringify({ skills: [], workspace_schema_version: WORKSPACE_SCHEMA_VERSION }),
      )
      .digest("hex")}`,
  } as const;
}

function runCliAsync(home: string, ...arguments_: string[]) {
  return new Promise<{ status: number | null; stderr: string; stdout: string }>(
    (resolvePromise, rejectPromise) => {
      const child = spawn(
        process.env.NODE_BINARY ?? "node",
        [cliPath, ...arguments_],
        {
          env: { ...process.env, HOME: home },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", rejectPromise);
      child.on("close", (status) => resolvePromise({ status, stderr, stdout }));
    },
  );
}

function runCliAsyncWithEnvironment(
  home: string,
  environment: NodeJS.ProcessEnv,
  ...arguments_: string[]
) {
  return new Promise<{ status: number | null; stderr: string; stdout: string }>(
    (resolvePromise, rejectPromise) => {
      const child = spawn(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
        env: { ...process.env, ...environment, HOME: home },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", rejectPromise);
      child.on("close", (status) => resolvePromise({ status, stderr, stdout }));
    },
  );
}

describe("agent-profile-kit guide", () => {
  test("a user can read the bundled human authoring guide", () => {
    const result = runCli(isolatedHome(), "guide");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# Agent Profile Kit Workspace guide");
    expect(result.stdout).toContain("Review personal content before publishing");
    expect(result.stdout).toContain(
      "~/.agents/agent-profile-kit/workspace/",
    );
    expect(result.stdout).toContain(
      `Workspace schema version is ${WORKSPACE_SCHEMA_VERSION}`,
    );
  });

  test("an agent can read the bundled Workspace authoring workflow", () => {
    const result = runCli(isolatedHome(), "guide", "--agent");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("# Agent Profile Kit agent workflow");
    expect(result.stdout).toContain(
      "Read this guide first. Then inspect the Workspace:",
    );
    expect(result.stdout).toContain("Elicit the user's needs");
    expect(result.stdout).toContain("Do not install anything without direction");
    expect(result.stdout).toContain("workspace.yaml");
    expect(result.stdout).toContain(
      `schema version is ${WORKSPACE_SCHEMA_VERSION}`,
    );
  });
});

interface PackageMetadata {
  readonly filename: string;
  readonly files: readonly { readonly mode: number; readonly path: string }[];
  readonly name: string;
  readonly version: string;
}

function packPackage(destination: string): {
  readonly archive: string;
  readonly metadata: PackageMetadata;
} {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync(
    "npm",
    ["pack", "--silent", "--json", "--pack-destination", destination],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: join(destination, "npm-cache"),
        npm_config_update_notifier: "false",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`npm pack failed: ${result.stderr}`);
  }

  const jsonStart = result.stdout.lastIndexOf("\n[");
  const packageMetadata = result.stdout.slice(jsonStart < 0 ? 0 : jsonStart + 1);
  const [metadata] = JSON.parse(packageMetadata) as [PackageMetadata];
  return { archive: join(destination, metadata.filename), metadata };
}

async function listTree(root: string): Promise<string[]> {
  const entries: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath);
      entries.push(entry.isDirectory() ? `${path}/` : path);
      if (entry.isDirectory()) await visit(absolutePath);
    }
  }

  await visit(root);
  return entries.sort();
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath);
      const stats = statSync(absolutePath);
      snapshot[path] = entry.isDirectory()
        ? `directory:${stats.mtimeMs}`
        : `file:${stats.mtimeMs}:${readFileSync(absolutePath).toString("base64")}`;
      if (entry.isDirectory()) await visit(absolutePath);
    }
  }

  await visit(root);
  return snapshot;
}

describe("agent-profile-kit init", () => {
  test("a user with no Workspace receives an empty, structurally valid Workspace", async () => {
    const home = isolatedHome();
    const result = runCli(home, "init");
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Initialized Agent Profile Kit Workspace");
    expect(result.stdout).toContain("agent-profile-kit guide");
    expect(result.stdout).toContain(
      "Agent prompt: Run agent-profile-kit guide --agent, then help me create the smallest useful Profile.",
    );
    expect(result.stdout).toContain("git init");
    expect(result.stdout).toContain("Review personal content before publishing");
    expect(statSync(workspace).isDirectory()).toBe(true);
    expect(await listTree(workspace)).toEqual([
      ".gitignore",
      "AGENTS.md",
      "README.md",
      "agents/",
      "agents/.gitkeep",
      "context/",
      "context/.gitkeep",
      "hooks/",
      "hooks/.gitkeep",
      "profiles/",
      "profiles/.gitkeep",
      "skills/",
      "skills/.gitkeep",
      "tools/",
      "tools/.gitkeep",
      "workspace.yaml",
    ]);
    expect(readFileSync(join(workspace, "workspace.yaml"), "utf8")).toBe(
      "schema_version: 1\n",
    );
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe(
      "# Agent Profile Kit Workspace\n\n" +
        "This Workspace is the canonical source for your Agent Profile Kit material.\n\n" +
        "Run `agent-profile-kit guide` for current authoring guidance.\n",
    );
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toBe(
      "# Agent Profile Kit Workspace\n\n" +
        "Before editing this Workspace, run `agent-profile-kit guide --agent` and follow the current agent-oriented authoring guidance.\n",
    );
    expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(
      ".DS_Store\n",
    );
  });

  test("optional Git setup works when the Workspace path contains shell metacharacters", () => {
    const home = isolatedHome("agent profile-$`'\"-");
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");

    const result = runCli(home, "init");
    const cdLine = result.stdout
      .split("\n")
      .find((line) => line.startsWith("  cd "));
    expect(cdLine).toBeDefined();

    const shellResult = spawnSync("/bin/sh", ["-c", `${cdLine?.trim()}\npwd`], {
      encoding: "utf8",
    });

    expect(shellResult.status, shellResult.stderr).toBe(0);
    expect(shellResult.stdout.trim()).toBe(workspace);
  });

  test("a user can repeat initialization without changing a valid Workspace", async () => {
    const home = isolatedHome();
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    expect(runCli(home, "init").status).toBe(0);
    const before = await snapshotTree(workspace);

    const result = runCli(home, "init");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Workspace already initialized");
    expect(result.stdout).toContain("unchanged");
    expect(await snapshotTree(workspace)).toEqual(before);
  });

  test("a valid Workspace reached through the fixed path by symlink is unchanged", async () => {
    const sourceHome = isolatedHome();
    expect(runCli(sourceHome, "init").status).toBe(0);
    const sourceWorkspace = join(
      sourceHome,
      ".agents",
      "agent-profile-kit",
      "workspace",
    );
    const before = await snapshotTree(sourceWorkspace);
    const home = isolatedHome();
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    mkdirSync(applicationRoot, { recursive: true });
    symlinkSync(sourceWorkspace, join(applicationRoot, "workspace"));

    const result = runCli(home, "init");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Workspace already initialized");
    expect(await snapshotTree(sourceWorkspace)).toEqual(before);
  });

  test("an empty Workspace symlink target is rejected clearly without modification", async () => {
    const target = mkdtempSync(join(tmpdir(), "agent-profile-kit-target-"));
    temporaryDirectories.push(target);
    const before = await snapshotTree(target);
    const home = isolatedHome();
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    mkdirSync(applicationRoot, { recursive: true });
    symlinkSync(target, join(applicationRoot, "workspace"));

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("symlink target is empty");
    expect(result.stderr).toContain("remove the symlink and run init");
    expect(await snapshotTree(target)).toEqual(before);
  });

  test("a dangling Workspace symlink fails with safe remediation guidance", () => {
    const home = isolatedHome();
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    const workspace = join(applicationRoot, "workspace");
    mkdirSync(applicationRoot, { recursive: true });
    symlinkSync(join(home, "missing-workspace"), workspace);

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Workspace symlink target does not exist");
    expect(result.stderr).toContain("remove the symlink or restore its target");
    expect(lstatSync(workspace).isSymbolicLink()).toBe(true);
  });

  test("a user with an existing empty Workspace directory receives a valid Workspace", () => {
    const home = isolatedHome();
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    mkdirSync(workspace, { recursive: true });

    const result = runCli(home, "init");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Initialized Agent Profile Kit Workspace");
    expect(readFileSync(join(workspace, "workspace.yaml"), "utf8")).toBe(
      "schema_version: 1\n",
    );
  });

  test("concurrent initialization converges on one valid Workspace", async () => {
    for (const startsWithEmptyDirectory of [false, true]) {
      const home = isolatedHome();
      if (startsWithEmptyDirectory) {
        mkdirSync(join(home, ".agents", "agent-profile-kit", "workspace"), {
          recursive: true,
        });
      }

      const results = await Promise.all(
        Array.from({ length: 8 }, () => runCliAsync(home, "init")),
      );

      expect(results.map(({ status }) => status)).toEqual(Array(8).fill(0));
      expect(
        results.filter(({ stdout }) =>
          stdout.includes("Initialized Agent Profile Kit Workspace"),
        ),
      ).toHaveLength(1);
      expect(
        results.filter(({ stdout }) =>
          stdout.includes("Workspace already initialized"),
        ),
      ).toHaveLength(7);
      expect(
        statSync(
          join(
            home,
            ".agents",
            "agent-profile-kit",
            "workspace",
            "workspace.yaml",
          ),
        ).isFile(),
      ).toBe(true);
    }
  });

  test("a non-empty unrecognized directory is rejected without modifying any entry", async () => {
    const home = isolatedHome();
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, ".DS_Store"), "Finder metadata\n");
    const before = await snapshotTree(workspace);

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("non-empty");
    expect(result.stderr).toContain("not an Agent Profile Kit Workspace");
    expect(await snapshotTree(workspace)).toEqual(before);
  });

  test("an incomplete recognized Workspace fails clearly without being repaired", async () => {
    const home = isolatedHome();
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    expect(runCli(home, "init").status).toBe(0);
    rmSync(join(workspace, "tools"), { recursive: true });
    const before = await snapshotTree(workspace);

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Workspace is incomplete");
    expect(result.stderr).toContain("tools");
    expect(await snapshotTree(workspace)).toEqual(before);
  });

  test("a Workspace Manifest path with the wrong kind fails clearly", async () => {
    const home = isolatedHome();
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    mkdirSync(join(workspace, "workspace.yaml"), { recursive: true });
    const before = await snapshotTree(workspace);

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("'workspace.yaml' must be a file");
    expect(result.stderr).not.toContain("EISDIR");
    expect(await snapshotTree(workspace)).toEqual(before);
  });

  test("an unsupported Workspace schema version fails with migration guidance", async () => {
    const home = isolatedHome();
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    expect(runCli(home, "init").status).toBe(0);
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 2\n");
    const before = await snapshotTree(workspace);

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unsupported Workspace schema version 2");
    expect(result.stderr).toContain("supports version 1");
    expect(await snapshotTree(workspace)).toEqual(before);
  });

  test("a non-integer Workspace schema version is reported as malformed", () => {
    const home = isolatedHome();
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    expect(runCli(home, "init").status).toBe(0);
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version:\n");

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Workspace Manifest schema_version must be a positive integer",
    );
    expect(result.stderr).not.toContain("migration");
  });

  test("a malformed Workspace Manifest fails with an actionable error", async () => {
    const home = isolatedHome();
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    expect(runCli(home, "init").status).toBe(0);
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: [\n");
    const before = await snapshotTree(workspace);

    const result = runCli(home, "init");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Workspace Manifest is invalid YAML");
    expect(await snapshotTree(workspace)).toEqual(before);
  });

  test("unsupported arguments fail before creating a Workspace", () => {
    const home = isolatedHome();

    const result = runCli(home, "init", "--force");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: agent-profile-kit init");
    expect(
      existsSync(join(home, ".agents", "agent-profile-kit", "workspace")),
    ).toBe(false);
  });

  test("a user can initialize a Workspace through the packed npm executable without installing it globally", () => {
    const home = isolatedHome();
    const { archive, metadata } = packPackage(join(home, "package"));

    expect(metadata.name).toBe("agent-profile-kit");
    expect(metadata.version).toBe(packageManifest.version);
    expect(packageManifest.os).toEqual(["darwin"]);
    expect(metadata.files.map(({ path }) => path).sort()).toEqual([
      "README.md",
      "dist/cli.js",
      "docs/guides/agent-workflow.md",
      "docs/guides/workspace.md",
      "package.json",
    ]);
    expect(metadata.files.find(({ path }) => path === "dist/cli.js")?.mode).toBe(
      0o755,
    );

    const result = spawnSync(
      "npm",
      [
        "exec",
        "--yes",
        "--offline",
        `--package=${archive}`,
        "--",
        "agent-profile-kit",
        "init",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          npm_config_cache: join(home, "npm-cache"),
          npm_config_update_notifier: "false",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Initialized Agent Profile Kit Workspace");
    expect(
      statSync(join(home, ".agents", "agent-profile-kit", "workspace")).isDirectory(),
    ).toBe(true);

    const humanGuideResult = spawnSync(
      "npm",
      [
        "exec",
        "--yes",
        "--offline",
        `--package=${archive}`,
        "--",
        "agent-profile-kit",
        "guide",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          npm_config_cache: join(home, "npm-cache"),
          npm_config_update_notifier: "false",
        },
      },
    );

    expect(humanGuideResult.status, humanGuideResult.stderr).toBe(0);
    expect(humanGuideResult.stdout).toContain(
      "# Agent Profile Kit Workspace guide",
    );

    const guideResult = spawnSync(
      "npm",
      [
        "exec",
        "--yes",
        "--offline",
        `--package=${archive}`,
        "--",
        "agent-profile-kit",
        "guide",
        "--agent",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          npm_config_cache: join(home, "npm-cache"),
          npm_config_update_notifier: "false",
        },
      },
    );

    expect(guideResult.status, guideResult.stderr).toBe(0);
    expect(guideResult.stdout).toContain("# Agent Profile Kit agent workflow");
  });
});

describe("agent-profile-kit Context-only Codex Profile", () => {
  test("a failed replacement preserves the previous usable Profile Installation", async () => {
    const home = isolatedHome();
    const destination = join(home, "installations", "coding", "codex");
    const profile = {
      id: "coding",
      context: ["team-rules"],
      skills: [],
      agents: [],
      hooks: [],
      tools: [],
    } as const;
    const plan = (context: string): ContextOnlyCodexPlan => ({
      capability: { version: "codex-cli 0.test" },
      context,
      destination,
      engineVersion: "0.test",
      profile,
      skillLibrary: emptySkillLibraryPlan(home),
      workspaceInputHash: `sha256:${"a".repeat(64)}`,
    });
    await installContextOnlyCodex(plan("Previous Context.\n"));
    const before = await snapshotTree(destination);
    const replacement = plan("Replacement Context.\n");
    const failures = [
      {
        name: "generation",
        fileSystem: {
          ...nodeInstallationFileSystem,
          writeFile: async (path: string, source: string) => {
            if (path.endsWith("context.md")) throw new Error("injected generation failure");
            await nodeInstallationFileSystem.writeFile(path, source);
          },
        },
      },
      {
        name: "validation",
        fileSystem: {
          ...nodeInstallationFileSystem,
          readFile: async (path: string) => {
            if (path.includes(".install-") && path.endsWith("context.md")) {
              throw new Error("injected validation failure");
            }
            return nodeInstallationFileSystem.readFile(path);
          },
        },
      },
      {
        name: "Manifest writing",
        fileSystem: {
          ...nodeInstallationFileSystem,
          writeFile: async (path: string, source: string) => {
            if (path.endsWith("installation.yaml")) {
              throw new Error("injected Manifest failure");
            }
            await nodeInstallationFileSystem.writeFile(path, source);
          },
        },
      },
      {
        name: "swap",
        fileSystem: {
          ...nodeInstallationFileSystem,
          rename: async (from: string, to: string) => {
            if (from.includes(".install-") && to === destination) {
              throw new Error("injected swap failure");
            }
            await nodeInstallationFileSystem.rename(from, to);
          },
        },
      },
    ];

    for (const failure of failures) {
      await expect(
        updateContextOnlyCodex(replacement, { fileSystem: failure.fileSystem }),
      ).rejects.toThrow(`injected ${failure.name === "Manifest writing" ? "Manifest" : failure.name} failure`);
      expect(await snapshotTree(destination)).toEqual(before);
    }
    expect(await listTree(join(home, "installations", "coding"))).toEqual([
      "codex/",
      "codex/context.md",
      "codex/installation.yaml",
    ]);
  });

  test("a successful replacement remains usable when backup cleanup fails", async () => {
    const home = isolatedHome();
    const destination = join(home, "installations", "coding", "codex");
    const profile = {
      id: "coding",
      context: ["team-rules"],
      skills: [],
      agents: [],
      hooks: [],
      tools: [],
    } as const;
    const plan = (context: string): ContextOnlyCodexPlan => ({
      capability: { version: "codex-cli 0.test" },
      context,
      destination,
      engineVersion: "0.test",
      profile,
      skillLibrary: emptySkillLibraryPlan(home),
      workspaceInputHash: `sha256:${"a".repeat(64)}`,
    });
    await installContextOnlyCodex(plan("Previous Context.\n"));
    let backupRemovalCount = 0;

    await expect(
      updateContextOnlyCodex(plan("Replacement Context.\n"), {
        fileSystem: {
          ...nodeInstallationFileSystem,
          rm: async (path, options) => {
            if (path.includes(".previous-")) {
              backupRemovalCount += 1;
              if (backupRemovalCount === 2) {
                throw new Error("injected backup cleanup failure");
              }
            }
            await nodeInstallationFileSystem.rm(path, options);
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(readFileSync(join(destination, "context.md"), "utf8")).toBe(
      "Replacement Context.\n",
    );
  });

  test("a staging cleanup failure preserves the original failure as an AggregateError", async () => {
    const home = isolatedHome();
    const destination = join(home, "installations", "coding", "codex");
    const plan: ContextOnlyCodexPlan = {
      capability: { version: "codex-cli 0.test" },
      context: "Context.\n",
      destination,
      engineVersion: "0.test",
      profile: {
        id: "coding",
        context: ["team-rules"],
        skills: [],
        agents: [],
        hooks: [],
        tools: [],
      },
      skillLibrary: emptySkillLibraryPlan(home),
      workspaceInputHash: `sha256:${"a".repeat(64)}`,
    };
    await installContextOnlyCodex(plan);

    try {
      await updateContextOnlyCodex(plan, {
        fileSystem: {
          ...nodeInstallationFileSystem,
          rm: async (path, options) => {
            if (path.includes(".install-")) {
              throw new Error("injected staging cleanup failure");
            }
            await nodeInstallationFileSystem.rm(path, options);
          },
          writeFile: async (path, source) => {
            if (path.endsWith("context.md")) {
              throw new Error("injected generation failure");
            }
            await nodeInstallationFileSystem.writeFile(path, source);
          },
        },
      });
      throw new Error("Expected update to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toHaveLength(2);
      expect((error as AggregateError).message).toContain("could not clean staging output");
    }
  });

  test("a user cannot uninstall an installation whose Manifest has a different identity", async () => {
    const home = isolatedHome();
    const destination = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
    );
    await installContextOnlyCodex({
      capability: { version: "codex-cli 0.test" },
      context: "Context.\n",
      destination,
      engineVersion: "0.test",
      profile: {
        id: "coding",
        context: ["team-rules"],
        skills: [],
        agents: [],
        hooks: [],
        tools: [],
      },
      skillLibrary: emptySkillLibraryPlan(home),
      workspaceInputHash: `sha256:${"a".repeat(64)}`,
    });
    const manifest = join(destination, "installation.yaml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace("profile_id: coding", "profile_id: other"),
    );
    const before = await snapshotTree(destination);

    const result = runCli(home, "uninstall", "--profile", "coding", "--host", "codex");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match requested Codex Profile 'coding'");
    expect(await snapshotTree(destination)).toEqual(before);
  });

  test("a user can remove a verified whole Profile Installation from another directory", async () => {
    const home = isolatedHome();
    const destination = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
    );
    await installContextOnlyCodex({
      capability: { version: "codex-cli 0.test" },
      context: "Context.\n",
      destination,
      engineVersion: "0.test",
      profile: {
        id: "coding",
        context: ["team-rules"],
        skills: [],
        agents: [],
        hooks: [],
        tools: [],
      },
      skillLibrary: emptySkillLibraryPlan(home),
      workspaceInputHash: `sha256:${"a".repeat(64)}`,
    });
    writeFileSync(join(destination, "edited-output.md"), "User edit.\n");
    const project = join(home, "project");
    mkdirSync(project);

    const result = runCliFromDirectory(
      home,
      project,
      {},
      "uninstall",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`Uninstalled Profile at ${destination}\n`);
    expect(existsSync(destination)).toBe(false);
  });

  test("a user can identify a missing Profile Installation from an unrelated directory", () => {
    const home = isolatedHome();
    const project = join(home, "project");
    mkdirSync(project);

    const result = runCliFromDirectory(
      home,
      project,
      {},
      "status",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      "Profile Installation: missing installation\nCodex Skill Library: missing installation\n",
    );
  });

  test("a user can identify a malformed Installation Manifest without reading source or Codex", () => {
    const home = isolatedHome();
    const installation = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
    );
    mkdirSync(installation, { recursive: true });
    writeFileSync(join(installation, "installation.yaml"), "not: a complete Manifest\n");

    const result = runCli(home, "status", "--profile", "coding", "--host", "codex");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "Profile Installation: malformed Manifest\nCodex Skill Library: missing installation\n",
    );
  });

  test("a user can verify a current Profile Installation without invoking Codex", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    expect(
      runCliWithEnvironment(
        home,
        environment,
        "install",
        "--profile",
        "coding",
        "--host",
        "codex",
      ).status,
    ).toBe(0);
    const manifestPath = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
      "installation.yaml",
    );
    const legacyManifest = parse(readFileSync(manifestPath, "utf8")) as {
      selected_artifacts: Record<string, unknown>;
    };
    delete legacyManifest.selected_artifacts.skills;
    writeFileSync(manifestPath, stringify(legacyManifest));
    const codexInvocation = join(home, "codex-invoked");
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(codexInvocation)}\n` +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "status",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      "Profile Installation: current\nCodex Skill Library: current\n",
    );
    expect(existsSync(codexInvocation)).toBe(false);
    chmodSync(
      join(
        home,
        ".agents",
        "agent-profile-kit",
        "installations",
        "coding",
        "codex",
        "context.md",
      ),
      0o600,
    );

    const drifted = runCli(home, "status", "--profile", "coding", "--host", "codex");

    expect(drifted.status, drifted.stderr).toBe(0);
    expect(drifted.stdout).toBe(
      "Profile Installation: drifted output\nCodex Skill Library: current\n",
    );
  });

  test("a user can explicitly update an installed Profile after its source changes", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    expect(
      runCliWithEnvironment(
        home,
        environment,
        "install",
        "--profile",
        "coding",
        "--host",
        "codex",
      ).status,
    ).toBe(0);
    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\n---\nAlways preserve the updated project boundary.\n",
    );
    const profileInstallations = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
    );
    mkdirSync(join(profileInstallations, ".install-interrupted"));
    mkdirSync(join(profileInstallations, ".previous-interrupted"));

    const project = join(home, "unrelated-project");
    mkdirSync(project);
    const result = runCliFromDirectory(home, project, environment, "update");
    const installation = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Updated 1 Profile Installation\n");
    expect(readFileSync(join(installation, "context.md"), "utf8")).toContain(
      "Always preserve the updated project boundary.",
    );
    expect(runCli(home, "status", "--profile", "coding", "--host", "codex").stdout).toBe(
      "Profile Installation: current\nCodex Skill Library: current\n",
    );
  });

  test("an update regenerates every Profile and Host pair represented by a valid Manifest", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const workspace = workspacePath(home);
    writeFileSync(
      join(workspace, "context", "review-rules.md"),
      "---\nid: review-rules\n---\nReview the original Context.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "review.yaml"),
      "id: review\ncontext:\n  - review-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    for (const profile of ["coding", "review"]) {
      expect(
        runCliWithEnvironment(
          home,
          environment,
          "install",
          "--profile",
          profile,
          "--host",
          "codex",
        ).status,
      ).toBe(0);
    }
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\n---\nUpdated coding Context.\n",
    );
    writeFileSync(
      join(workspace, "context", "review-rules.md"),
      "---\nid: review-rules\n---\nUpdated review Context.\n",
    );

    const result = runCliWithEnvironment(home, environment, "update");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("Updated 2 Profile Installations\n");
    for (const { profile, content } of [
      { profile: "coding", content: "Updated coding Context." },
      { profile: "review", content: "Updated review Context." },
    ]) {
      expect(
        readFileSync(
          join(
            home,
            ".agents",
            "agent-profile-kit",
            "installations",
            profile,
            "codex",
            "context.md",
          ),
          "utf8",
        ),
      ).toContain(content);
    }
  });

  test("an explicit update leaves an already-running Codex session untouched", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    const argumentsRecord = join(home, "codex-arguments");
    const pidRecord = join(home, "codex-pid");
    const release = join(home, "release-codex");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "printf '%s\\n' \"$$\" > \"$CODEX_PID_RECORD\"\n" +
        "printf '%s\\n' \"$@\" > \"$CODEX_ARGUMENTS_RECORD\"\n" +
        "while [ ! -f \"$CODEX_RELEASE\" ]; do sleep 0.01; done\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODEX_ARGUMENTS_RECORD: argumentsRecord,
      CODEX_PID_RECORD: pidRecord,
      CODEX_RELEASE: release,
    };
    expect(
      runCliWithEnvironment(
        home,
        environment,
        "install",
        "--profile",
        "coding",
        "--host",
        "codex",
      ).status,
    ).toBe(0);
    const session = spawn(
      process.env.NODE_BINARY ?? "node",
      [
        cliPath,
        "run",
        "--profile",
        "coding",
        "--host",
        "codex",
        "--",
        "native task",
      ],
      { env: { ...process.env, ...environment, HOME: home } },
    );
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const deadline = setTimeout(() => {
          rejectPromise(new Error("Timed out waiting for the controlled Codex session"));
        }, 5_000);
        const poll = setInterval(() => {
          if (!existsSync(pidRecord)) return;
          clearInterval(poll);
          clearTimeout(deadline);
          resolvePromise();
        }, 10);
        session.once("error", rejectPromise);
      });
      const processId = Number(readFileSync(pidRecord, "utf8").trim());
      writeFileSync(
        join(workspacePath(home), "context", "team-rules.md"),
        "---\nid: team-rules\n---\nUpdated Context.\n",
      );

      const update = runCliWithEnvironment(home, environment, "update");

      expect(update.status, update.stderr).toBe(0);
      expect(process.kill(processId, 0)).toBe(true);
      expect(readFileSync(argumentsRecord, "utf8")).toContain(
        "Always preserve the project boundary.",
      );
      expect(readFileSync(argumentsRecord, "utf8")).not.toContain("Updated Context.");
    } finally {
      writeFileSync(release, "");
      await new Promise<void>((resolvePromise) => session.once("close", () => resolvePromise()));
    }
  });

  test("a running Codex session pins its Skill generation through update and blocks final uninstall", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const bin = join(home, "bin");
    const argumentsRecord = join(home, "codex-arguments");
    const started = join(home, "codex-started");
    const release = join(home, "release-codex");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "printf '%s\\n' \"$@\" > \"$CODEX_ARGUMENTS_RECORD\"\n" +
        "printf started > \"$CODEX_STARTED\"\n" +
        "while [ ! -f \"$CODEX_RELEASE\" ]; do sleep 0.01; done\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = {
      CODEX_ARGUMENTS_RECORD: argumentsRecord,
      CODEX_RELEASE: release,
      CODEX_STARTED: started,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    expect(
      runCliWithEnvironment(home, environment, "install", "--profile", "coding", "--host", "codex").status,
    ).toBe(0);
    const library = codexSkillLibraryPath(home);
    const originalGeneration = readlinkSync(library);
    const session = spawn(
      process.env.NODE_BINARY ?? "node",
      [cliPath, "run", "--profile", "coding", "--host", "codex", "--", "task"],
      { env: { ...process.env, ...environment, HOME: home } },
    );
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const deadline = setTimeout(() => rejectPromise(new Error("Timed out waiting for Codex")), 5_000);
        const poll = setInterval(() => {
          if (!existsSync(started)) return;
          clearInterval(poll);
          clearTimeout(deadline);
          resolvePromise();
        }, 10);
        session.once("error", rejectPromise);
      });
      writeFileSync(
        join(workspacePath(home), "skills", "review-pr", "SKILL.md"),
        "---\nname: review-pr\ndescription: Updated while running.\n---\nUpdated.\n",
      );

      expect(runCliWithEnvironment(home, environment, "update").status).toBe(0);
      expect(readlinkSync(library)).not.toBe(originalGeneration);
      expect(readFileSync(argumentsRecord, "utf8")).toContain(originalGeneration);
      const activeUninstall = runCli(
        home,
        "uninstall",
        "--profile",
        "coding",
        "--host",
        "codex",
      );
      expect(activeUninstall.status).toBe(1);
      expect(activeUninstall.stderr).toContain("managed Codex run is active");
      expect(existsSync(originalGeneration)).toBe(true);
      expect(existsSync(library)).toBe(true);
    } finally {
      writeFileSync(release, "");
      await new Promise<void>((resolvePromise) => session.once("close", () => resolvePromise()));
    }
    expect(runCli(home, "uninstall", "--profile", "coding", "--host", "codex").status).toBe(0);
    expect(existsSync(library)).toBe(false);
    expect(existsSync(originalGeneration)).toBe(false);
  });

  test("final uninstall prunes an unlocked lease left by a killed run wrapper", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const bin = join(home, "bin");
    const started = join(home, "codex-started");
    const release = join(home, "release-codex");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "printf started > \"$CODEX_STARTED\"\n" +
        "while [ ! -f \"$CODEX_RELEASE\" ]; do sleep 0.01; done\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = {
      CODEX_RELEASE: release,
      CODEX_STARTED: started,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    expect(
      runCliWithEnvironment(home, environment, "install", "--profile", "coding", "--host", "codex").status,
    ).toBe(0);
    const session = spawn(
      process.env.NODE_BINARY ?? "node",
      [cliPath, "run", "--profile", "coding", "--host", "codex", "--", "task"],
      { env: { ...process.env, ...environment, HOME: home } },
    );
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const deadline = setTimeout(() => rejectPromise(new Error("Timed out waiting for Codex")), 5_000);
        const poll = setInterval(() => {
          if (!existsSync(started)) return;
          clearInterval(poll);
          clearTimeout(deadline);
          resolvePromise();
        }, 10);
        session.once("error", rejectPromise);
      });
      const exited = new Promise<void>((resolvePromise) =>
        session.once("exit", () => resolvePromise()),
      );
      session.kill("SIGKILL");
      await exited;

      const active = runCli(home, "uninstall", "--profile", "coding", "--host", "codex");
      expect(active.status).toBe(1);
      expect(active.stderr).toContain("managed Codex run is active");
    } finally {
      writeFileSync(release, "");
    }
    let uninstall;
    const deadline = Date.now() + 5_000;
    do {
      uninstall = runCli(home, "uninstall", "--profile", "coding", "--host", "codex");
      if (uninstall.status === 0) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    } while (Date.now() < deadline);
    expect(uninstall.status, uninstall.stderr).toBe(0);
    expect(existsSync(codexSkillLibraryPath(home))).toBe(false);
  });

  test("a user can distinguish stale source from drifted generated output", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    expect(
      runCliWithEnvironment(
        home,
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
        "install",
        "--profile",
        "coding",
        "--host",
        "codex",
      ).status,
    ).toBe(0);
    writeFileSync(
      join(workspacePath(home), "context", "team-rules.md"),
      "---\nid: team-rules\n---\nChanged canonical Context.\n",
    );

    expect(runCli(home, "status", "--profile", "coding", "--host", "codex").stdout).toBe(
      "Profile Installation: stale source\nCodex Skill Library: current\n",
    );
    const installedContext = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
      "context.md",
    );
    writeFileSync(installedContext, "Edited generated output.\n");

    expect(runCli(home, "status", "--profile", "coding", "--host", "codex").stdout).toBe(
      "Profile Installation: stale source, drifted output\nCodex Skill Library: current\n",
    );
  });

  test("status distinguishes Profile freshness from shared Codex Skill Library freshness and drift", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const unselected = join(workspacePath(home), "skills", "write-release-notes");
    mkdirSync(unselected);
    writeFileSync(
      join(unselected, "SKILL.md"),
      "---\nname: write-release-notes\ndescription: Write release notes.\n---\nOriginal.\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    expect(
      runCliWithEnvironment(
        home,
        { PATH: `${bin}:${process.env.PATH ?? ""}` },
        "install",
        "--profile",
        "coding",
        "--host",
        "codex",
      ).status,
    ).toBe(0);
    writeFileSync(
      join(unselected, "SKILL.md"),
      "---\nname: write-release-notes\ndescription: Write release notes.\n---\nChanged.\n",
    );

    expect(runCli(home, "status", "--profile", "coding", "--host", "codex").stdout).toBe(
      "Profile Installation: current\nCodex Skill Library: stale source\n",
    );
    writeFileSync(
      join(home, ".agents", "skills", "agent-profile-kit", "review-pr", "SKILL.md"),
      "drifted generated Skill\n",
    );
    expect(runCli(home, "status", "--profile", "coding", "--host", "codex").stdout).toBe(
      "Profile Installation: current\nCodex Skill Library: stale source, drifted output\n",
    );
  });

  test("a user can validate a Context Module and flat Profile without detecting Codex", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    const codexInvocation = join(home, "codex-invoked");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(codexInvocation)}\nexit 1\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "validate",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Workspace valid");
    expect(existsSync(codexInvocation)).toBe(false);
  });

  test("a Profile plan includes a Context Module required by a selected Context Module", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    const workspace = workspacePath(home);
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies:\n  - type: context\n    id: security-rules\n---\nAlways preserve the project boundary.\n",
    );
    writeFileSync(
      join(workspace, "context", "security-rules.md"),
      "---\nid: security-rules\ndependencies:\n  - type: context\n    id: credential-rules\n---\nNever expose credentials.\n",
    );
    writeFileSync(
      join(workspace, "context", "credential-rules.md"),
      "---\nid: credential-rules\n---\nNever record credentials.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "plan",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Resolved Artifacts:");
    expect(result.stdout).toContain(
      "context:credential-rules (required via context:team-rules -> context:security-rules from profile:coding)",
    );
    expect(result.stdout).toContain("<!-- Context Module: credential-rules -->");
  });

  test("a Profile plan explains every inclusion path through a dependency diamond once", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    const workspace = workspacePath(home);
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies:\n  - type: context\n    id: security-rules\n---\nTeam rules.\n",
    );
    writeFileSync(
      join(workspace, "context", "release-rules.md"),
      "---\nid: release-rules\ndependencies:\n  - type: context\n    id: security-rules\n---\nRelease rules.\n",
    );
    writeFileSync(
      join(workspace, "context", "security-rules.md"),
      "---\nid: security-rules\ndependencies:\n  - type: context\n    id: credential-rules\n---\nSecurity rules.\n",
    );
    writeFileSync(
      join(workspace, "context", "credential-rules.md"),
      "---\nid: credential-rules\n---\nCredential rules.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\n  - release-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "plan",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^  context:security-rules /gm)).toHaveLength(1);
    expect(result.stdout).toContain(
      "context:security-rules (required via context:team-rules from profile:coding; required via context:release-rules from profile:coding)",
    );
    expect(result.stdout).toContain(
      "context:credential-rules (required via context:team-rules -> context:security-rules from profile:coding; required via context:release-rules -> context:security-rules from profile:coding)",
    );
  });

  test("invalid dependency relationships fail during Host-independent validation", () => {
    const invalidDependencies = [
      {
        name: "cycle",
        context: "---\nid: team-rules\ndependencies:\n  - type: context\n    id: security-rules\n---\nTeam rules.\n",
        extraContext: "---\nid: security-rules\ndependencies:\n  - type: context\n    id: team-rules\n---\nSecurity rules.\n",
        expected: "Dependency cycle:",
      },
      {
        name: "missing target",
        context: "---\nid: team-rules\ndependencies:\n  - type: context\n    id: missing-rules\n---\nTeam rules.\n",
        expected: "Dependency references missing Context Module 'missing-rules'",
      },
      {
        name: "cross-type target",
        context: "---\nid: team-rules\ndependencies:\n  - type: skill\n    id: shared-rules\n---\nTeam rules.\n",
        extraContext: "---\nid: shared-rules\n---\nContext with the same ID.\n",
        expected: "Dependency references missing Skill 'shared-rules'",
      },
      {
        name: "unsupported type",
        context: "---\nid: team-rules\ndependencies:\n  - type: agent\n    id: reviewer\n---\nTeam rules.\n",
        expected: "type must be one of: context, skill",
      },
    ];

    for (const definition of invalidDependencies) {
      const home = isolatedHome();
      expect(runCli(home, "init").status).toBe(0);
      const workspace = workspacePath(home);
      writeFileSync(join(workspace, "context", "team-rules.md"), definition.context);
      writeFileSync(
        join(workspace, "profiles", "coding.yaml"),
        "id: coding\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
      );
      if (definition.extraContext) {
        writeFileSync(join(workspace, "context", "security-rules.md"), definition.extraContext);
      }

      const result = runCli(home, "validate");

      expect(result.status, `${definition.name}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(definition.expected);
    }
  });

  test("Host-independent validation rejects an invalid unselected Artifact", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    writeFileSync(
      join(workspacePath(home), "context", "unused-rules.md"),
      "---\nid: unused-rules\ndependencies:\n  - type: skill\n    id: missing-skill\n---\nUnused rules.\n",
    );

    const result = runCli(home, "validate");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Dependency references missing Skill 'missing-skill'");
  });

  test("equivalent dependency declarations produce stable resolution order", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    const workspace = workspacePath(home);
    const teamRules = (dependencies: string) =>
      `---\nid: team-rules\ndependencies:\n${dependencies}---\nTeam rules.\n`;
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      teamRules("  - type: context\n    id: release-rules\n  - type: context\n    id: security-rules\n"),
    );
    writeFileSync(join(workspace, "context", "release-rules.md"), "---\nid: release-rules\n---\nRelease rules.\n");
    writeFileSync(join(workspace, "context", "security-rules.md"), "---\nid: security-rules\n---\nSecurity rules.\n");
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    const first = runCliWithEnvironment(home, environment, "plan", "--profile", "coding", "--host", "codex");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      teamRules("  - type: context\n    id: security-rules\n  - type: context\n    id: release-rules\n"),
    );
    const second = runCliWithEnvironment(home, environment, "plan", "--profile", "coding", "--host", "codex");

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });

  test("a user can resolve same-ID Context Modules and Skills as distinct typed Artifacts", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const workspace = workspacePath(home);
    writeFileSync(
      join(workspace, "context", "shared.md"),
      "---\nid: shared\n---\nShared Context.\n",
    );
    const sharedSkill = join(workspace, "skills", "shared");
    mkdirSync(sharedSkill);
    writeFileSync(
      join(sharedSkill, "SKILL.md"),
      "---\nname: shared\ndescription: Shared Skill.\n---\n\n# Shared\n",
    );
    writeFileSync(
      join(workspace, "skills", "review-pr", "agent-profile-kit.yaml"),
      "dependencies:\n  - type: skill\n    id: shared\n",
    );

    const result = runCli(home, "validate");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Workspace valid");
  });

  test("a user can select a standard Skill by its name without detecting Codex", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const bin = join(home, "bin");
    const codexInvocation = join(home, "codex-invoked");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(codexInvocation)}\nexit 1\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "validate",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Workspace valid");
    expect(existsSync(codexInvocation)).toBe(false);
  });

  test("a user can validate standard Skill content with a separate sidecar", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const skill = join(workspacePath(home), "skills", "review-pr");
    mkdirSync(join(skill, "references"));
    writeFileSync(join(skill, "references", "checklist.md"), "# Checklist\n\n- Preserve bytes.\n");
    writeFileSync(join(skill, "agent-profile-kit.yaml"), "orchestration: local-only\n");
    const result = runCli(home, "validate");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Workspace valid");
  });

  test("a Codex Skills plan projects the complete Workspace library and selects only the Profile Skills", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const unselected = join(workspacePath(home), "skills", "write-release-notes");
    mkdirSync(join(unselected, "references"), { recursive: true });
    writeFileSync(
      join(unselected, "SKILL.md"),
      "---\nname: write-release-notes\ndescription: Write release notes from completed work.\n---\n\n# Write release notes\n",
    );
    writeFileSync(join(unselected, "references", "style.md"), "Keep it concise.\n");
    writeFileSync(join(unselected, "agent-profile-kit.yaml"), "orchestration: local-only\n");
    const bin = join(home, "bin");
    const codexInvocation = join(home, "codex-invoked");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(codexInvocation)}\n` +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "plan",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Selected Skills: review-pr");
    expect(result.stdout).toContain("Codex Skill Library:");
    expect(result.stdout).toContain("Projected Skills: review-pr, write-release-notes");
    expect(result.stdout).toContain("Add: review-pr, write-release-notes");
    expect(existsSync(codexInvocation)).toBe(true);
    expect(
      existsSync(
        join(home, ".agents", "agent-profile-kit", "installations", "coding", "codex"),
      ),
    ).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "agent-profile-kit"))).toBe(false);
  });

  test("an Installation Manifest records resolved dependencies and their inclusion reasons", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "agent-profile-kit.yaml"),
      "dependencies:\n  - type: context\n    id: review-rules\n",
    );
    writeFileSync(
      join(workspacePath(home), "context", "review-rules.md"),
      "---\nid: review-rules\n---\nReview every changed line.\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "install",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    const manifest = parse(
      readFileSync(
        join(home, ".agents", "agent-profile-kit", "installations", "coding", "codex", "installation.yaml"),
        "utf8",
      ),
    ) as { resolved_artifacts?: unknown };
    expect(manifest.resolved_artifacts).toEqual([
      {
        type: "context",
        id: "team-rules",
        inclusion_reasons: [{ profile: "coding", path: [] }],
      },
      {
        type: "context",
        id: "review-rules",
        inclusion_reasons: [
          { profile: "coding", path: [{ type: "skill", id: "review-pr" }] },
        ],
      },
      {
        type: "skill",
        id: "review-pr",
        inclusion_reasons: [{ profile: "coding", path: [] }],
      },
    ]);
  });

  test("installation mirrors every Workspace Skill byte-for-byte without sidecars or unrelated global changes", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const workspaceSkill = join(workspacePath(home), "skills", "review-pr");
    mkdirSync(join(workspaceSkill, "scripts"));
    const script = join(workspaceSkill, "scripts", "check.sh");
    writeFileSync(script, "#!/bin/sh\nprintf checked\\n\n");
    chmodSync(script, 0o755);
    writeFileSync(join(workspaceSkill, "agent-profile-kit.yaml"), "orchestration: local-only\n");
    const unselected = join(workspacePath(home), "skills", "write-release-notes");
    mkdirSync(unselected);
    writeFileSync(
      join(unselected, "SKILL.md"),
      "---\nname: write-release-notes\ndescription: Write release notes.\n---\n\n# Notes\n",
    );

    const nativeSkill = join(home, ".agents", "skills", "native-skill");
    mkdirSync(nativeSkill, { recursive: true });
    writeFileSync(
      join(nativeSkill, "SKILL.md"),
      "---\nname: native-skill\ndescription: Existing user Skill.\ncodex-only-field: preserved\n---\n",
    );
    const codexConfig = join(home, ".codex", "config.toml");
    mkdirSync(join(home, ".codex"));
    writeFileSync(codexConfig, "model = \"user-choice\"\n");
    const beforeNative = await snapshotTree(join(home, ".agents", "skills", "native-skill"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "install",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    const library = join(home, ".agents", "skills", "agent-profile-kit");
    expect(await listTree(library)).toEqual([
      ".agent-profile-kit.yaml",
      "review-pr/",
      "review-pr/SKILL.md",
      "review-pr/scripts/",
      "review-pr/scripts/check.sh",
      "write-release-notes/",
      "write-release-notes/SKILL.md",
    ]);
    expect(readFileSync(join(library, "review-pr", "SKILL.md"))).toEqual(
      readFileSync(join(workspaceSkill, "SKILL.md")),
    );
    expect(readFileSync(join(library, "review-pr", "scripts", "check.sh"))).toEqual(
      readFileSync(script),
    );
    expect(statSync(join(library, "review-pr", "scripts", "check.sh")).mode & 0o777).toBe(0o755);
    expect(existsSync(join(library, "review-pr", "agent-profile-kit.yaml"))).toBe(false);
    expect(await snapshotTree(nativeSkill)).toEqual(beforeNative);
    expect(readFileSync(codexConfig, "utf8")).toBe("model = \"user-choice\"\n");
    const manifest = parse(
      readFileSync(
        join(home, ".agents", "agent-profile-kit", "installations", "coding", "codex", "installation.yaml"),
        "utf8",
      ),
    ) as { selected_artifacts: { skills: string[] } };
    expect(manifest.selected_artifacts.skills).toEqual(["review-pr"]);
  });

  test("a later plan reports Codex Skill Library additions, changes, and removals", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const workspace = workspacePath(home);
    const removed = join(workspace, "skills", "old-skill");
    mkdirSync(removed);
    writeFileSync(
      join(removed, "SKILL.md"),
      "---\nname: old-skill\ndescription: An old Skill.\n---\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    expect(
      runCliWithEnvironment(home, environment, "install", "--profile", "coding", "--host", "codex").status,
    ).toBe(0);
    writeFileSync(
      join(workspace, "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review changed code.\n---\nChanged.\n",
    );
    rmSync(removed, { recursive: true });
    const added = join(workspace, "skills", "new-skill");
    mkdirSync(added);
    writeFileSync(
      join(added, "SKILL.md"),
      "---\nname: new-skill\ndescription: A new Skill.\n---\n",
    );

    const result = runCliWithEnvironment(
      home,
      environment,
      "plan",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Add: new-skill");
    expect(result.stdout).toContain("Change: review-pr");
    expect(result.stdout).toContain("Remove: old-skill");
  });

  test("a current plan still reports the complete projected Codex Skill catalog", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const extra = join(workspacePath(home), "skills", "write-release-notes");
    mkdirSync(extra);
    writeFileSync(
      join(extra, "SKILL.md"),
      "---\nname: write-release-notes\ndescription: Write release notes.\n---\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    expect(
      runCliWithEnvironment(home, environment, "install", "--profile", "coding", "--host", "codex").status,
    ).toBe(0);

    const result = runCliWithEnvironment(
      home,
      environment,
      "plan",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Projected Skills: review-pr, write-release-notes");
    expect(result.stdout).toContain("Add: (none)");
    expect(result.stdout).toContain("Change: (none)");
    expect(result.stdout).toContain("Remove: (none)");
  });

  test("a failed Codex Skill Library synchronization preserves the previous complete library", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const workspace = await ingestWorkspace(home);
    const initialPlan = await planCodexSkillLibrary(home, workspace.skills);
    await syncCodexSkillLibrary(initialPlan);
    const library = codexSkillLibraryPath(home);
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Changed review workflow.\n---\nChanged.\n",
    );
    const replacementWorkspace = await ingestWorkspace(home);
    const replacementPlan = await planCodexSkillLibrary(home, replacementWorkspace.skills);
    const before = await snapshotTree(library);
    rmSync(join(workspacePath(home), "skills", "review-pr", "SKILL.md"));

    await expect(syncCodexSkillLibrary(replacementPlan)).rejects.toThrow(
      "Workspace Skills changed after",
    );
    expect(await snapshotTree(library)).toEqual(before);
  });

  test("library updates atomically switch immutable generations and reclaim unreferenced ones", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    let workspace = await ingestWorkspace(home);
    await syncCodexSkillLibrary(await planCodexSkillLibrary(home, workspace.skills));
    const library = codexSkillLibraryPath(home);
    expect(lstatSync(library).isSymbolicLink()).toBe(true);
    const previousGeneration = readlinkSync(library);
    writeFileSync(
      join(workspacePath(home), "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Updated review workflow.\n---\nUpdated.\n",
    );
    workspace = await ingestWorkspace(home);

    await syncCodexSkillLibrary(await planCodexSkillLibrary(home, workspace.skills));

    const currentGeneration = readlinkSync(library);
    expect(currentGeneration).not.toBe(previousGeneration);
    expect(existsSync(previousGeneration)).toBe(false);
    expect(existsSync(currentGeneration)).toBe(true);
    expect(readFileSync(join(library, "review-pr", "SKILL.md"), "utf8")).toContain(
      "Updated.",
    );
  });

  test("a half-created empty Skill Library state directory is claimable", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const state = join(home, ".agents", "agent-profile-kit", "codex-skill-library");
    mkdirSync(state, { recursive: true });
    expect(existsSync(join(state, ".agent-profile-kit-owned"))).toBe(false);

    await syncCodexSkillLibrary(
      await planCodexSkillLibrary(home, (await ingestWorkspace(home)).skills),
    );

    expect(readFileSync(join(state, ".agent-profile-kit-owned"), "utf8")).toBe(
      "agent-profile-kit\n",
    );
    expect(existsSync(codexSkillLibraryPath(home))).toBe(true);
  });

  test("a corrupt unleased generation is restaged on the next sync", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const workspace = await ingestWorkspace(home);
    const plan = await planCodexSkillLibrary(home, workspace.skills);
    await syncCodexSkillLibrary(plan);
    const library = codexSkillLibraryPath(home);
    const generation = readlinkSync(library);
    writeFileSync(join(generation, "review-pr", "SKILL.md"), "corrupted\n");

    await syncCodexSkillLibrary(plan);

    expect(readFileSync(join(library, "review-pr", "SKILL.md"), "utf8")).toContain(
      "Review a pull request",
    );
    expect(readFileSync(join(generation, "review-pr", "SKILL.md"), "utf8")).toContain(
      "Review a pull request",
    );
  });

  test("planning refuses an unowned library destination and a conflicting user Skill before writing", async () => {
    for (const conflict of ["unowned destination", "Skill identity"] as const) {
      const home = isolatedHome();
      expect(runCli(home, "init").status).toBe(0);
      writeProfileWithSkill(home);
      const library = join(home, ".agents", "skills", "agent-profile-kit");
      if (conflict === "unowned destination") {
        mkdirSync(library, { recursive: true });
        writeFileSync(join(library, "user-file.txt"), "preserve me\n");
      } else {
        const existing = join(home, ".agents", "skills", "existing");
        mkdirSync(existing, { recursive: true });
        writeFileSync(
          join(existing, "SKILL.md"),
          "---\nname: review-pr\ndescription: Existing user Skill.\n---\n",
        );
      }
      const root = join(home, ".agents", "skills");
      const before = await snapshotTree(root);

      const result = runCli(home, "plan", "--profile", "coding", "--host", "codex");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        conflict === "unowned destination" ? "Refusing unowned" : "conflicts with an existing Codex Skill",
      );
      expect(await snapshotTree(root)).toEqual(before);
    }
  });

  test("planning detects a conflicting Skill reached through a symlinked discovery directory", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const external = join(home, "external-skills", "conflict");
    mkdirSync(external, { recursive: true });
    writeFileSync(
      join(external, "SKILL.md"),
      "---\nname: review-pr\ndescription: Symlinked existing Skill.\n---\n",
    );
    const discoveryRoot = join(home, ".agents", "skills");
    mkdirSync(discoveryRoot, { recursive: true });
    symlinkSync(join(home, "external-skills"), join(discoveryRoot, "linked"));

    const result = runCli(home, "plan", "--profile", "coding", "--host", "codex");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("conflicts with an existing Codex Skill");
    expect(existsSync(codexSkillLibraryPath(home))).toBe(false);
  });

  test("uninstall keeps the shared library until the final installed Codex Profile is removed", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const workspace = workspacePath(home);
    writeFileSync(
      join(workspace, "context", "review-rules.md"),
      "---\nid: review-rules\n---\nReview carefully.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "review.yaml"),
      "id: review\ncontext:\n  - review-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    for (const profile of ["coding", "review"]) {
      expect(
        runCliWithEnvironment(home, environment, "install", "--profile", profile, "--host", "codex").status,
      ).toBe(0);
    }
    const library = join(home, ".agents", "skills", "agent-profile-kit");

    expect(runCli(home, "uninstall", "--profile", "coding", "--host", "codex").status).toBe(0);
    expect(existsSync(library)).toBe(true);
    expect(runCli(home, "uninstall", "--profile", "review", "--host", "codex").status).toBe(0);
    expect(existsSync(library)).toBe(false);
  });

  test("final uninstall cannot delete the shared library beneath a concurrent Profile install", async () => {
    const home = isolatedHome();
    const makePlan = (profileId: string): ContextOnlyCodexPlan => ({
      capability: { version: "codex-cli 0.test" },
      context: `${profileId} Context.\n`,
      destination: join(
        home,
        ".agents",
        "agent-profile-kit",
        "installations",
        profileId,
        "codex",
      ),
      engineVersion: "0.test",
      profile: {
        id: profileId,
        context: ["team-rules"],
        skills: [],
        agents: [],
        hooks: [],
        tools: [],
      },
      skillLibrary: emptySkillLibraryPlan(home),
      workspaceInputHash: `sha256:${"a".repeat(64)}`,
    });
    await installContextOnlyCodex(makePlan("coding"));
    const review = makePlan("review");
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolvePromise) => {
      releasePublication = resolvePromise;
    });
    let publicationReached!: () => void;
    const atPublication = new Promise<void>((resolvePromise) => {
      publicationReached = resolvePromise;
    });
    const install = installContextOnlyCodex(review, {
      fileSystem: {
        ...nodeInstallationFileSystem,
        rename: async (from, to) => {
          if (from.includes(".install-") && to === review.destination) {
            publicationReached();
            await publicationReleased;
          }
          await nodeInstallationFileSystem.rename(from, to);
        },
      },
    });
    await atPublication;
    const uninstall = uninstallContextOnlyCodex(home, "coding");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    releasePublication();

    await expect(install).resolves.toBeUndefined();
    await expect(uninstall).resolves.toContain("coding/codex");
    expect(existsSync(review.destination)).toBe(true);
    expect(existsSync(codexSkillLibraryPath(home))).toBe(true);
  });

  test("two contenders serialize through a pre-existing kernel lock file", async () => {
    const home = isolatedHome();
    const root = join(home, ".agents", "agent-profile-kit");
    const lock = join(root, ".codex-lifecycle.lock");
    mkdirSync(root, { recursive: true });
    writeFileSync(lock, "left by a terminated process\n");
    let active = 0;
    let maximumActive = 0;
    let executions = 0;
    const operation = () =>
      withCodexLifecycleLock(home, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        executions += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        active -= 1;
      });

    await Promise.all([operation(), operation()]);

    expect(executions).toBe(2);
    expect(maximumActive).toBe(1);
    expect(existsSync(lock)).toBe(true);
  });

  test("a tampered Manifest cannot make Codex load a Skill outside a Context-only Profile Installation", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    const argumentsRecord = join(home, "codex-arguments");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "printf '%s\\n' \"$@\" > \"$CODEX_ARGUMENTS_RECORD\"\n" +
        "exit 23\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = {
      CODEX_ARGUMENTS_RECORD: argumentsRecord,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    expect(
      runCliWithEnvironment(
        home,
        environment,
        "install",
        "--profile",
        "coding",
        "--host",
        "codex",
      ).status,
    ).toBe(0);
    const installation = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
    );
    const project = join(home, "project");
    mkdirSync(project);

    const manifestPath = join(installation, "installation.yaml");
    const manifest = parse(readFileSync(manifestPath, "utf8")) as {
      selected_artifacts: { context: string[]; skills: string[] };
    };
    manifest.selected_artifacts.skills = ["../../outside"];
    writeFileSync(manifestPath, stringify(manifest));

    const unsafe = runCliFromDirectory(
      home,
      project,
      environment,
      "run",
      "--profile",
      "coding",
      "--host",
      "codex",
      "--",
      "native task",
    );

    expect(unsafe.status).toBe(1);
    expect(unsafe.stderr).toContain("selected_artifacts.skills");
    expect(existsSync(argumentsRecord)).toBe(false);
  });

  test("a user can reorganize a Context Module without changing its Artifact ID", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const workspace = workspacePath(home);
    rmSync(join(workspace, "context", "team-rules.md"));
    mkdirSync(join(workspace, "context", "engineering"));
    writeFileSync(
      join(workspace, "context", "engineering", "team-rules.md"),
      "---\nid: team-rules\n---\nAlways preserve the project boundary.\n",
    );

    const result = runCli(home, "validate");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Workspace valid");
  });

  test("a user can reorganize a Skill without changing its Artifact ID or Profile selection", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const workspace = workspacePath(home);
    mkdirSync(join(workspace, "skills", "engineering"));
    renameSync(
      join(workspace, "skills", "review-pr"),
      join(workspace, "skills", "engineering", "pull-request-review"),
    );

    const result = runCli(home, "validate");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Workspace valid");
  });

  test("a user receives ingestion errors for invalid, duplicate, and missing standard Skills", () => {
    const invalidSkills = [
      {
        expected: "selects missing Skill 'missing'",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "profiles", "coding.yaml"),
            "id: coding\ncontext:\n  - team-rules\nskills:\n  - missing\nagents: []\nhooks: []\ntools: []\n",
          ),
      },
      {
        expected: "Skill Artifact ID 'review-pr' is duplicated",
        write: (workspace: string) => {
          const duplicate = join(workspace, "skills", "duplicate");
          mkdirSync(duplicate);
          writeFileSync(
            join(duplicate, "SKILL.md"),
            "---\nname: review-pr\ndescription: A duplicate Skill.\n---\n",
          );
        },
      },
      {
        expected: "Skill skills/review-pr/SKILL.md name must be a lowercase kebab-case Artifact ID",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "skills", "review-pr", "SKILL.md"),
            "---\nname: Review-PR\ndescription: Invalid standard name.\n---\n",
          ),
      },
      {
        expected: "Skill skills/review-pr/SKILL.md sidecar must be a YAML mapping",
        write: (workspace: string) =>
          writeFileSync(join(workspace, "skills", "review-pr", "agent-profile-kit.yaml"), ""),
      },
    ];

    for (const invalid of invalidSkills) {
      const home = isolatedHome();
      expect(runCli(home, "init").status).toBe(0);
      writeProfileWithSkill(home);
      invalid.write(workspacePath(home));

      const result = runCli(home, "validate");

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(invalid.expected);
    }
  });

  test("a user receives structural errors for invalid Context-only Profile definitions", async () => {
    const invalidDefinitions = [
      {
        expected: "must start with YAML frontmatter",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "context", "team-rules.md"),
            "id: team-rules\nnot valid Context\n",
          ),
      },
      {
        expected: "Artifact ID 'team-rules' is duplicated",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "context", "duplicate.md"),
            "---\nid: team-rules\n---\nDuplicate Context.\n",
          ),
      },
      {
        expected: "selects missing Context Module 'missing'",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "profiles", "coding.yaml"),
            "id: coding\ncontext:\n  - missing\nskills: []\nagents: []\nhooks: []\ntools: []\n",
          ),
      },
      {
        expected: "without wildcards",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "profiles", "coding.yaml"),
            "id: coding\ncontext:\n  - team-*\nskills: []\nagents: []\nhooks: []\ntools: []\n",
          ),
      },
      {
        expected: "does not allow fields: inherits",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "profiles", "coding.yaml"),
            "id: coding\ninherits: base\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
          ),
      },
      {
        expected: "does not allow fields: codex",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "profiles", "coding.yaml"),
            "id: coding\ncodex:\n  model: o3\ncontext:\n  - team-rules\nskills: []\nagents: []\nhooks: []\ntools: []\n",
          ),
      },
      {
        expected: "must select at least one Context Module",
        write: (workspace: string) =>
          writeFileSync(
            join(workspace, "profiles", "coding.yaml"),
            "id: coding\ncontext: []\nskills: []\nagents: []\nhooks: []\ntools: []\n",
          ),
      },
    ];

    for (const definition of invalidDefinitions) {
      const home = isolatedHome();
      expect(runCli(home, "init").status).toBe(0);
      const workspace = workspacePath(home);
      writeContextOnlyProfile(home);
      definition.write(workspace);
      const afterMutation = await snapshotTree(workspace);

      const result = runCli(home, "validate");

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(definition.expected);
      expect(await snapshotTree(workspace)).toEqual(afterMutation);
    }
  });

  test("a user cannot use an unsafe Profile ID to address an installation", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);

    const result = runCli(
      home,
      "run",
      "--profile",
      "../outside",
      "--host",
      "codex",
      "--",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Profile id must be a lowercase kebab-case Artifact ID");
    expect(result.stderr).not.toContain("ENOENT");
  });

  test("a user cannot replace selected Context with a whitespace-form Codex override", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);

    const result = runCli(
      home,
      "run",
      "--profile",
      "coding",
      "--host",
      "codex",
      "--",
      "--config",
      'developer_instructions = "replacement"',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "may not override developer_instructions selected by the Profile",
    );
    expect(result.stderr).not.toContain("ENOENT");
  });

  test("a user can preview deterministic Context output without changing Codex or installation state", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const workspace = workspacePath(home);
    writeFileSync(
      join(workspace, "context", "second.md"),
      "---\nid: second\n---\nThis intentionally contradicts the first module.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\n  - second\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    const globalCodex = join(home, ".codex");
    mkdirSync(globalCodex);
    writeFileSync(join(globalCodex, "config.toml"), "model = \"preserved\"\n");
    const beforeGlobalConfig = readFileSync(join(globalCodex, "config.toml"), "utf8");
    const beforeWorkspace = await snapshotTree(workspace);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "plan",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Profile: coding");
    expect(result.stdout).toContain("Capability: supported (codex-cli 0.test)");
    expect(result.stdout).toContain("<!-- Context Module: team-rules -->");
    expect(result.stdout).toContain("Always preserve the project boundary.");
    expect(result.stdout).toContain("<!-- Context Module: second -->");
    expect(result.stdout).toContain("This intentionally contradicts the first module.");
    expect(readFileSync(join(globalCodex, "config.toml"), "utf8")).toBe(
      beforeGlobalConfig,
    );
    expect(await snapshotTree(workspace)).toEqual(beforeWorkspace);
    expect(
      existsSync(
        join(home, ".agents", "agent-profile-kit", "installations", "coding", "codex"),
      ),
    ).toBe(false);
  });

  test("a user is stopped before installation writes when Codex lacks the required Context surface", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli unsupported\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ]; then printf '[]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "install",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "does not support the required per-process developer instructions surface",
    );
    expect(
      existsSync(
        join(home, ".agents", "agent-profile-kit", "installations", "coding", "codex"),
      ),
    ).toBe(false);
  });

  test("a user can install a self-contained Context-only Codex Profile", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "install",
      "--profile",
      "coding",
      "--host",
      "codex",
    );
    const installation = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Installed Profile at ${installation}`);
    expect(await listTree(installation)).toEqual(["context.md", "installation.yaml"]);
    expect(readFileSync(join(installation, "context.md"), "utf8")).toContain(
      "<!-- Context Module: team-rules -->",
    );
    expect(parse(readFileSync(join(installation, "installation.yaml"), "utf8"))).toEqual({
      schema_version: 2,
      profile_id: "coding",
      host_id: "codex",
      host_version: "codex-cli 0.test",
      adapter_version: packageManifest.version,
      engine_version: packageManifest.version,
      selected_artifacts: { context: ["team-rules"], skills: [] },
      resolved_artifacts: [
        {
          type: "context",
          id: "team-rules",
          inclusion_reasons: [{ profile: "coding", path: [] }],
        },
      ],
      outputs: ["context.md"],
      workspace_input_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      output_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  test("a user receives Git provenance for a version-controlled Workspace", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const workspace = workspacePath(home);
    execFileSync("git", ["init"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: workspace });
    execFileSync("git", ["add", "."], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "Workspace"], { cwd: workspace });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);

    const result = runCliWithEnvironment(
      home,
      { PATH: `${bin}:${process.env.PATH ?? ""}` },
      "install",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(
      parse(
        readFileSync(
          join(
            home,
            ".agents",
            "agent-profile-kit",
            "installations",
            "coding",
            "codex",
            "installation.yaml",
          ),
          "utf8",
        ),
      ),
    ).toMatchObject({ git: { commit, dirty: false } });
  });

  test("Git provenance does not inherit a repository that merely contains the Workspace", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    execFileSync("git", ["init"], { cwd: home });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: home });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: home });
    execFileSync("git", ["add", "."], { cwd: home });
    execFileSync("git", ["commit", "-m", "Containing repository"], { cwd: home });

    expect(await workspaceGitProvenance(workspacePath(home))).toBeUndefined();
  });

  test("a user receives clear guidance when an installation already exists", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeContextOnlyProfile(home);
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "exit 1\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    expect(
      runCliWithEnvironment(
        home,
        environment,
        "install",
        "--profile",
        "coding",
        "--host",
        "codex",
      ).status,
    ).toBe(0);
    const installation = join(
      home,
      ".agents",
      "agent-profile-kit",
      "installations",
      "coding",
      "codex",
    );
    const before = await snapshotTree(installation);

    const result = runCliWithEnvironment(
      home,
      environment,
      "install",
      "--profile",
      "coding",
      "--host",
      "codex",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Installation already exists at ${installation}`);
    expect(result.stderr).toContain("agent-profile-kit update");
    expect(result.stderr).not.toContain("EEXIST");
    expect(await snapshotTree(installation)).toEqual(before);
  });

  test("a user can run an installed Profile from their project with native arguments and exit status preserved", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const unselected = join(workspacePath(home), "skills", "write-release-notes");
    mkdirSync(unselected);
    writeFileSync(
      join(unselected, "SKILL.md"),
      "---\nname: write-release-notes\ndescription: Write release notes.\n---\n",
    );
    const nativeSkill = join(home, ".agents", "skills", "native-skill");
    mkdirSync(nativeSkill, { recursive: true });
    writeFileSync(
      join(nativeSkill, "SKILL.md"),
      "---\nname: native-skill\ndescription: Existing user Skill.\n---\n",
    );
    const bin = join(home, "bin");
    const argumentsRecord = join(home, "codex-arguments");
    const directoryRecord = join(home, "codex-directory");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "printf '%s\\n' \"$PWD\" > \"$CODEX_DIRECTORY_RECORD\"\n" +
        "printf '%s\\n' \"$@\" > \"$CODEX_ARGUMENTS_RECORD\"\n" +
        "exit 23\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CODEX_ARGUMENTS_RECORD: argumentsRecord,
      CODEX_DIRECTORY_RECORD: directoryRecord,
    };
    expect(
      runCliWithEnvironment(
        home,
        environment,
        "install",
        "--profile",
        "coding",
        "--host",
        "codex",
      ).status,
    ).toBe(0);
    rmSync(workspacePath(home), { recursive: true });
    const project = join(home, "project");
    mkdirSync(join(project, ".codex"), { recursive: true });
    writeFileSync(join(project, ".codex", "config.toml"), "model = \"project\"\n");
    const globalCodex = join(home, ".codex");
    mkdirSync(globalCodex);
    writeFileSync(join(globalCodex, "config.toml"), "model = \"global\"\n");
    const globalConfig = readFileSync(join(globalCodex, "config.toml"), "utf8");
    const projectConfig = readFileSync(join(project, ".codex", "config.toml"), "utf8");

    const result = runCliFromDirectory(
      home,
      project,
      environment,
      "run",
      "--profile",
      "coding",
      "--host",
      "codex",
      "--",
      "--config",
      'model_reasoning_effort = "high"',
      "--model",
      "o3",
      "native task",
    );

    expect(result.status, result.stderr).toBe(23);
    expect(readFileSync(directoryRecord, "utf8").trim()).toBe(realpathSync(project));
    const arguments_ = readFileSync(argumentsRecord, "utf8");
    expect(arguments_).toContain("developer_instructions=");
    expect(arguments_).toContain("Always preserve the project boundary.");
    expect(arguments_).toContain("review-pr/SKILL.md\",enabled=true");
    expect(arguments_).toContain("write-release-notes/SKILL.md\",enabled=false");
    expect(arguments_).toContain("codex-skill-library/generations/");
    expect(arguments_).not.toContain(join(nativeSkill, "SKILL.md"));
    expect(arguments_).toContain('--config\nmodel_reasoning_effort = "high"\n');
    expect(arguments_).toContain("--model\no3\nnative task\n");
    expect(readFileSync(join(globalCodex, "config.toml"), "utf8")).toBe(
      globalConfig,
    );
    expect(readFileSync(join(project, ".codex", "config.toml"), "utf8")).toBe(
      projectConfig,
    );
  });

  test("run rejects a Skill collision in the native Codex --cd project before launch", () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    writeProfileWithSkill(home);
    const bin = join(home, "bin");
    const invocation = join(home, "codex-invoked");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        `printf invoked > ${JSON.stringify(invocation)}\n`,
    );
    chmodSync(join(bin, "codex"), 0o755);
    const environment = { PATH: `${bin}:${process.env.PATH ?? ""}` };
    expect(
      runCliWithEnvironment(home, environment, "install", "--profile", "coding", "--host", "codex").status,
    ).toBe(0);
    const project = join(home, "conflicting-project");
    const projectSkill = join(project, ".agents", "skills", "review-pr");
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(
      join(projectSkill, "SKILL.md"),
      "---\nname: review-pr\ndescription: Project-local conflict.\n---\n",
    );

    const result = runCliWithEnvironment(
      home,
      environment,
      "run",
      "--profile",
      "coding",
      "--host",
      "codex",
      "--",
      "--cd",
      project,
      "task",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("conflicts with an existing Codex Skill");
    expect(existsSync(invocation)).toBe(false);
  });

  test("concurrent managed Codex runs receive independent Profile Skill filters", async () => {
    const home = isolatedHome();
    expect(runCli(home, "init").status).toBe(0);
    const workspace = workspacePath(home);
    writeContextOnlyProfile(home);
    for (const id of ["skill-one", "skill-two"]) {
      const skill = join(workspace, "skills", id);
      mkdirSync(skill);
      writeFileSync(
        join(skill, "SKILL.md"),
        `---\nname: ${id}\ndescription: ${id} test workflow.\n---\n`,
      );
      writeFileSync(
        join(workspace, "profiles", `${id}.yaml`),
        `id: ${id}\ncontext:\n  - team-rules\nskills:\n  - ${id}\nagents: []\nhooks: []\ntools: []\n`,
      );
    }
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "codex"),
      "#!/bin/sh\n" +
        "if [ \"$1\" = \"--version\" ]; then printf 'codex-cli 0.test\\n'; exit 0; fi\n" +
        "if [ \"$1\" = \"debug\" ] && [ \"$2\" = \"prompt-input\" ]; then printf '[{\\\"role\\\":\\\"developer\\\",\\\"content\\\":[{\\\"type\\\":\\\"input_text\\\",\\\"text\\\":\\\"agent-profile-kit capability probe\\\"}]}]\\n'; exit 0; fi\n" +
        "printf '%s\\n' \"$@\" > \"$CODEX_ARGUMENTS_RECORD\"\n",
    );
    chmodSync(join(bin, "codex"), 0o755);
    const path = `${bin}:${process.env.PATH ?? ""}`;
    for (const profile of ["skill-one", "skill-two"]) {
      expect(
        runCliWithEnvironment(
          home,
          { PATH: path },
          "install",
          "--profile",
          profile,
          "--host",
          "codex",
        ).status,
      ).toBe(0);
    }
    const records = [join(home, "one.args"), join(home, "two.args")];
    const results = await Promise.all(
      ["skill-one", "skill-two"].map((profile, index) =>
        runCliAsyncWithEnvironment(
          home,
          { CODEX_ARGUMENTS_RECORD: records[index], PATH: path },
          "run",
          "--profile",
          profile,
          "--host",
          "codex",
          "--",
          "task",
        ),
      ),
    );
    expect(results.map(({ status }) => status)).toEqual([0, 0]);
    const one = readFileSync(records[0]!, "utf8");
    const two = readFileSync(records[1]!, "utf8");
    expect(one).toContain("skill-one/SKILL.md\",enabled=true");
    expect(one).toContain("skill-two/SKILL.md\",enabled=false");
    expect(two).toContain("skill-one/SKILL.md\",enabled=false");
    expect(two).toContain("skill-two/SKILL.md\",enabled=true");
  });
});
