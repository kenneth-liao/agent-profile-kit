import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { WORKSPACE_SCHEMA_VERSION } from "../schemas/workspace-manifest.js";
import {
  installContextOnlyCodex,
  nodeInstallationFileSystem,
  updateContextOnlyCodex,
} from "../installer/install.js";
import { workspaceGitProvenance } from "../installer/git-provenance.js";
import { type ContextOnlyCodexPlan } from "../installer/plan.js";

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
    expect(result.stdout).toBe("Status: missing installation\n");
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
    expect(result.stdout).toBe("Status: malformed Manifest\n");
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
    const codexInvocation = join(home, "codex-invoked");
    writeFileSync(
      join(bin, "codex"),
      `#!/bin/sh\nprintf invoked > ${JSON.stringify(codexInvocation)}\nexit 1\n`,
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
    expect(result.stdout).toBe("Status: current\n");
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
    expect(drifted.stdout).toBe("Status: drifted output\n");
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
      "Status: current\n",
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
      "Status: stale source\n",
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
      "Status: stale source, drifted output\n",
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
      schema_version: 1,
      profile_id: "coding",
      host_id: "codex",
      host_version: "codex-cli 0.test",
      adapter_version: packageManifest.version,
      engine_version: packageManifest.version,
      selected_artifacts: { context: ["team-rules"] },
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
    writeContextOnlyProfile(home);
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
    expect(arguments_).toContain('--config\nmodel_reasoning_effort = "high"\n');
    expect(arguments_).toContain("--model\no3\nnative task\n");
    expect(readFileSync(join(globalCodex, "config.toml"), "utf8")).toBe(
      globalConfig,
    );
    expect(readFileSync(join(project, ".codex", "config.toml"), "utf8")).toBe(
      projectConfig,
    );
  });
});
