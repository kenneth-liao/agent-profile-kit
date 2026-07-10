import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = join(repositoryRoot, "dist", "cli.js");
const packageVersion = (
  JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    readonly version: string;
  }
).version;
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

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-test-"));
  temporaryDirectories.push(home);
  return home;
}

function runCli(home: string, ...arguments_: string[]) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

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
    expect(result.stdout).toContain("agent-profile-kit guide --agent");
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
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toContain(
      "agent-profile-kit guide",
    );
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain(
      "agent-profile-kit guide --agent",
    );
    expect(readFileSync(join(workspace, ".gitignore"), "utf8")).toBe(
      ".DS_Store\n",
    );
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

  test("initialization removes abandoned staging output without touching live work", () => {
    const home = isolatedHome();
    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    const abandonedStaging = join(applicationRoot, ".workspace-init-abandoned");
    const activeStaging = join(applicationRoot, ".workspace-init-active");
    mkdirSync(abandonedStaging, { recursive: true });
    mkdirSync(activeStaging);
    writeFileSync(join(abandonedStaging, "partial"), "incomplete\n");
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    utimesSync(abandonedStaging, twoDaysAgo, twoDaysAgo);

    const result = runCli(home, "init");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(abandonedStaging)).toBe(false);
    expect(existsSync(activeStaging)).toBe(true);
    expect(
      statSync(join(applicationRoot, "workspace", "workspace.yaml")).isFile(),
    ).toBe(true);
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
    expect(metadata.version).toBe(packageVersion);
    expect(metadata.files.map(({ path }) => path).sort()).toEqual([
      "README.md",
      "dist/cli.js",
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
  });
});
