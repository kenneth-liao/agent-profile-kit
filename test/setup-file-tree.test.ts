/**
 * Setup adds only the missing parts of the Workspace structure to an explicit
 * folder (spec #593 #599, TEST-003 rows without a TTY): packed-CLI runs with
 * file-tree snapshots (paths, bytes, modes) before and after setup. Any
 * change beyond the added required parts fails, invalid material is refused
 * with nothing added, and nothing is written outside the named path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { parse } from "yaml";

import { fileTree } from "./support/file-tree.js";
import {
  controlledEnvironment,
  controlledPath,
  controlledToolPath,
} from "./support/controlled-environment.js";
import {
  TEST_CHILD_DEADLINE_MS,
  expectExitCode,
  runProcess,
} from "../process/process-executor.js";
import { obtainPackageArchive, extractPackageArchive } from "./support/package-archive.js";
import {
  defaultFileSystem,
  type LocalConfigurationFileSystem,
} from "../installer/local-configuration-publication.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { WORKSPACE_MANIFEST } from "../schemas/workspace-manifest.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];
let packageArchiveCleanup = (): void => undefined;
let cliPath = "";

const MANIFEST_SNAPSHOT =
  `file workspace.yaml 100644 ${Buffer.from(WORKSPACE_MANIFEST).toString("hex")}`;
const REQUIRED_PARTS = ["dir context 40755", "dir profiles 40755", "dir skills 40755", MANIFEST_SNAPSHOT];

beforeAll(async () => {
  const archive = await obtainPackageArchive(repositoryRoot, "agent-profile-kit-setup-pack-");
  packageArchiveCleanup = archive.cleanup;
  const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-setup-packed-"));
  temporaryDirectories.push(extracted);
  await extractPackageArchive(archive.path, extracted);
  cliPath = join(extracted, "package", "dist", "cli.js");
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  packageArchiveCleanup();
});

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-setup-home-"));
  temporaryDirectories.push(home);
  return home;
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

async function runCli(home: string, cwd: string | undefined, ...arguments_: string[]) {
  return runProcess({
    executable: controlledToolPath("node"),
    arguments_: [cliPath, ...arguments_],
    ...(cwd === undefined ? {} : { cwd }),
    environment: controlledEnvironment({ home, path: controlledPath(home) }),
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI",
  });
}

/** The named folder is the only new entry among its siblings after setup. */
function expectOnlyNamedSiblingAdded(parent: string, named: string): void {
  const after = readdirSync(parent).sort();
  expect(after).toContain(named);
  expect(after.some((entry) => entry.startsWith(".workspace-init-"))).toBe(false);
}

/** One Profile + Context pair that satisfies the current Workspace contract. */
function writeValidMaterial(workspace: string): void {
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  writeFileSync(join(workspace, "profiles", "coding.yaml"), "context: [team-rules]\nskills: []\n");
}

describe("setup adds only the missing parts (TEST-003, #599)", () => {
  test("an empty folder receives exactly the four required parts", async () => {
    const home = isolatedHome();
    const destination = join(home, "workspace");
    mkdirSync(destination);
    const before = fileTree(destination);

    const result = await runCli(home, undefined, "init", destination);
    expectExitCode(result, 0);

    expect(fileTree(destination).filter((entry) => !before.includes(entry)).sort())
      .toEqual(REQUIRED_PARTS.slice().sort());
    expect(parse(readFileSync(configPath(home), "utf8"))).toEqual({
      schema_version: 2,
      workspace: destination,
      bindings: [],
    });
  });

  test("a folder with unrelated files keeps every existing entry byte for byte", async () => {
    const home = isolatedHome();
    const destination = join(home, "mixed-folder");
    mkdirSync(destination);
    writeFileSync(join(destination, "NOTES.md"), "user-owned source\n");
    mkdirSync(join(destination, "ideas"));
    writeFileSync(join(destination, "ideas", "idea.txt"), "user-owned idea\n");
    const before = fileTree(destination);

    const result = await runCli(home, undefined, "init", destination);
    expectExitCode(result, 0);

    const after = fileTree(destination);
    for (const entry of before) expect(after).toContain(entry);
    expect(after.filter((entry) => !before.includes(entry)).sort())
      .toEqual(REQUIRED_PARTS.slice().sort());
  });

  test("a Git repository receives the missing parts and Git metadata stays untouched", async () => {
    const home = isolatedHome();
    const destination = join(home, "repo");
    mkdirSync(destination);
    execFileSync("git", ["init", "-q", destination]);
    writeFileSync(join(destination, "README.md"), "fixture\n");
    execFileSync("git", ["-C", destination, "add", "README.md"]);
    execFileSync("git", ["-C", destination, "commit", "-qm", "fixture"]);
    const before = fileTree(destination);

    const result = await runCli(home, undefined, "init", destination);
    expectExitCode(result, 0);

    const after = fileTree(destination);
    for (const entry of before) expect(after).toContain(entry);
    expect(after.filter((entry) => !before.includes(entry)).sort())
      .toEqual(REQUIRED_PARTS.slice().sort());
    controlledPath(home); // materialize the fixture bin before the sibling check
    expectOnlyNamedSiblingAdded(home, "repo");
  });

  test("an incomplete Workspace receives only its missing directories", async () => {
    const home = isolatedHome();
    const destination = join(home, "partial");
    mkdirSync(destination);
    writeFileSync(join(destination, "workspace.yaml"), WORKSPACE_MANIFEST);
    mkdirSync(join(destination, "context"));
    writeValidMaterial(destination);
    const before = fileTree(destination);

    const result = await runCli(home, undefined, "init", destination);
    expectExitCode(result, 0);

    expect(fileTree(destination).filter((entry) => !before.includes(entry)).sort()).toEqual([
      "dir skills 40755",
    ]);
  });

  test("a valid Workspace is connected with no folder writes at all", async () => {
    const home = isolatedHome();
    const destination = join(home, "valid");
    mkdirSync(join(destination, "context"), { recursive: true });
    mkdirSync(join(destination, "skills"));
    mkdirSync(join(destination, "profiles"));
    writeFileSync(join(destination, "workspace.yaml"), WORKSPACE_MANIFEST);
    writeValidMaterial(destination);
    const before = fileTree(destination);

    const result = await runCli(home, undefined, "init", destination);
    expectExitCode(result, 0);

    expect(fileTree(destination)).toEqual(before);
    expect(parse(readFileSync(configPath(home), "utf8")).workspace).toBe(destination);
  });

  test("an invalid folder is refused with its violation, nothing added, no Local Configuration", async () => {
    const cases: readonly { readonly label: string; readonly setup: (workspace: string) => void }[] = [
      {
        label: "broken Profile YAML",
        setup: (workspace) => writeFileSync(join(workspace, "profiles", "broken.yaml"), "context: [\n"),
      },
      {
        label: "invalid manifest",
        setup: (workspace) => writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 99\n"),
      },
      {
        label: "missing Profile reference",
        setup: (workspace) =>
          writeFileSync(join(workspace, "profiles", "lonely.yaml"), "context: [absent]\nskills: []\n"),
      },
    ];
    for (const example of cases) {
      const home = isolatedHome();
      const destination = join(home, "invalid");
      mkdirSync(join(destination, "profiles"), { recursive: true });
      writeFileSync(join(destination, "workspace.yaml"), WORKSPACE_MANIFEST);
      example.setup(destination);
      const before = fileTree(destination);

      const result = await runCli(home, undefined, "init", destination);

      expectExitCode(result, 1, example.label);
      expect(result.stderr).not.toBe("");
      expect(fileTree(destination)).toEqual(before);
      expect(existsSync(configPath(home))).toBe(false);
      expect(existsSync(join(home, ".agents", "agent-profile-kit"))).toBe(false);
    }
  });

  test("an invalid folder without a manifest is refused with no transient write", async () => {
    const home = isolatedHome();
    const destination = join(home, "manifestless-invalid");
    mkdirSync(join(destination, "profiles"), { recursive: true });
    writeFileSync(join(destination, "profiles", "broken.yaml"), "context: [\n");
    const before = fileTree(destination);

    const result = await runCli(home, undefined, "init", destination);

    expectExitCode(result, 1);
    expect(fileTree(destination)).toEqual(before);
    expect(existsSync(configPath(home))).toBe(false);
  });

  test("`init .` records the named folder and a later bare validate from another directory uses it", async () => {
    const home = isolatedHome();
    const cwd = join(home, "elsewhere");
    mkdirSync(cwd);

    const dot = await runCli(home, cwd, "init", ".");
    expectExitCode(dot, 0);
    expect(parse(readFileSync(configPath(home), "utf8")).workspace).toBe(realpathSync(cwd));

    mkdirSync(join(home, "validate-cwd"));
    const validate = await runCli(home, join(home, "validate-cwd"), "validate");
    expectExitCode(validate, 0);
  });

  test("`init <relative path>` records the named folder", async () => {
    const home = isolatedHome();
    const cwd = join(home, "base");
    mkdirSync(join(cwd, "named"), { recursive: true });

    const relative = await runCli(home, cwd, "init", "named");
    expectExitCode(relative, 0);
    expect(parse(readFileSync(configPath(home), "utf8")).workspace).toBe(realpathSync(join(cwd, "named")));

    // Re-running from a different directory stays idempotent on the same folder.
    const again = await runCli(home, home, "init", "base/named");
    expectExitCode(again, 0);
  });

  test("a missing named folder is created when its parent exists; a missing parent is refused", async () => {
    const home = isolatedHome();
    controlledPath(home); // materialize the allowlist bin before the sibling check
    const destination = join(home, "fresh-workspace");
    const parentBefore = readdirSync(home).sort();

    const created = await runCli(home, undefined, "init", destination);
    expectExitCode(created, 0);
    expect(created.stdout).toMatch(/created/i);
    expectOnlyNamedSiblingAdded(home, "fresh-workspace");
    expect(existsSync(join(destination, "workspace.yaml"))).toBe(true);

    const refused = await runCli(home, undefined, "init", join(home, "no-such-parent", "workspace"));
    expectExitCode(refused, 1);
    expect(refused.stderr).toContain("no-such-parent");
    expect(existsSync(join(home, "no-such-parent"))).toBe(false);
    expect(existsSync(configPath(home))).toBe(true); // untouched by the refusal
  });

  test("a non-directory path is reported and nothing is written", async () => {
    const home = isolatedHome();
    const filePath = join(home, "as-file");
    writeFileSync(filePath, "not a directory\n");
    controlledPath(home); // materialize the allowlist bin before the snapshot
    const before = fileTree(home);

    const result = await runCli(home, undefined, "init", filePath);

    expectExitCode(result, 1);
    expect(result.stderr).toMatch(/not a directory/i);
    expect(fileTree(home)).toEqual(before);
  });
});

describe("setup write transaction (unit seams)", () => {
  test("an I/O failure after adding some parts reports exactly what was added", async () => {
    const home = isolatedHome();
    const destination = join(home, "partial-failure");
    mkdirSync(destination);
    writeFileSync(join(destination, "NOTES.md"), "user-owned source\n");

    const failingMkdir: LocalConfigurationFileSystem = {
      ...defaultFileSystem,
      mkdir: (async (
        path: Parameters<typeof defaultFileSystem.mkdir>[0],
        options?: Parameters<typeof defaultFileSystem.mkdir>[1],
      ) => {
        if (path === join(destination, "context")) {
          throw Object.assign(new Error("user-mkdir-failure"), { code: "EACCES" });
        }
        return defaultFileSystem.mkdir(path as never, options as never);
      }) as typeof defaultFileSystem.mkdir,
    };

    let failure: unknown;
    try {
      await initializeWorkspace(home, { workspace: destination, fileSystem: failingMkdir });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InstallerToolError);
    const fact = (failure as InstallerToolError).fact;
    expect(fact.kind).toBe("init-partial-setup");
    expect([...(fact as { added: readonly string[] }).added].sort()).toEqual(["profiles", "workspace.yaml"]);
    expect(existsSync(join(destination, "workspace.yaml"))).toBe(true);
    expect(existsSync(join(destination, "profiles"))).toBe(true);
    expect(existsSync(join(destination, "context"))).toBe(false);
    expect(existsSync(join(destination, "skills"))).toBe(false);
    expect(readFileSync(join(destination, "NOTES.md"), "utf8")).toBe("user-owned source\n");
    expect(existsSync(configPath(home))).toBe(false);
  });

  test("a failure after the parts were added reports the whole written set", async () => {
    const home = isolatedHome();
    const destination = join(home, "then-config-failure");
    // Local Configuration publication fails after the folder transaction
    // completed, so the failure fact reports every written entry in order
    // (spec #593 #599).
    const failingWrite: LocalConfigurationFileSystem = {
      ...defaultFileSystem,
      writeFile: async (path, data, options) => {
        if (path === configPath(home)) {
          throw Object.assign(new Error("user-config-write-failure"), { code: "EACCES" });
        }
        return defaultFileSystem.writeFile(path, data, options);
      },
    };

    let failure: unknown;
    try {
      await initializeWorkspace(home, { workspace: destination, fileSystem: failingWrite });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InstallerToolError);
    const fact = (failure as InstallerToolError).fact;
    expect(fact.kind).toBe("init-partial-setup");
    expect((fact as { added: readonly string[] }).added).toEqual([
      destination,
      "workspace.yaml",
      "profiles",
      "context",
      "skills",
    ]);
    expect(existsSync(join(destination, "workspace.yaml"))).toBe(true);
    expect(existsSync(configPath(home))).toBe(false);
  });
});