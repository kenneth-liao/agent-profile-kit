import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { ingestDefaultWorkspace } from "../installer/ingest-workspace.js";
import {
  validateWorkspaceStructure,
  WORKSPACE_ARTIFACT_DIRECTORIES,
  workspacePath,
} from "../installer/workspace.js";
import { WORKSPACE_MANIFEST } from "../schemas/workspace-manifest.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-structure-"));
  temporaryDirectories.push(home);
  return home;
}

function writeManifestOnlyWorkspace(home: string): string {
  const path = workspacePath(home);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "workspace.yaml"), WORKSPACE_MANIFEST);
  return path;
}

const UNDELIVERED_ARTIFACT_DIRECTORIES = ["agents", "hooks", "tools"] as const;

describe("delivered Workspace scaffolding", () => {
  test("init scaffolds exactly the delivered artifact directories and no others", async () => {
    const home = isolatedHome();
    const created = await initializeWorkspace(home);

    expect(created.outcome).toBe("created");
    for (const directory of WORKSPACE_ARTIFACT_DIRECTORIES) {
      expect(existsSync(join(created.path, directory, ".gitkeep"))).toBe(true);
    }
    for (const directory of UNDELIVERED_ARTIFACT_DIRECTORIES) {
      expect(existsSync(join(created.path, directory))).toBe(false);
    }
  });

  test("init leaves pre-existing undelivered artifact directories untouched and validate passes", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);
    for (const directory of UNDELIVERED_ARTIFACT_DIRECTORIES) {
      mkdirSync(join(path, directory), { recursive: true });
      writeFileSync(join(path, directory, "legacy.txt"), "user material\n");
    }
    const before = readdirSync(path).sort();

    const result = await initializeWorkspace(home);

    expect(result.workspaceScaffolded).toBe(false);
    expect(readdirSync(path).sort()).toEqual(before);
    for (const directory of UNDELIVERED_ARTIFACT_DIRECTORIES) {
      expect(readFileSync(join(path, directory, "legacy.txt"), "utf8")).toBe(
        "user material\n",
      );
    }
    await expect(validateWorkspaceStructure(path)).resolves.toBeUndefined();
  });

  test("a Workspace whose undelivered artifact entry is a file still validates", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);
    writeFileSync(join(path, "agents"), "not a directory\n");

    await expect(validateWorkspaceStructure(path)).resolves.toBeUndefined();
  });
});

describe("optional Workspace scaffolding after initialization", () => {
  test("a Workspace containing only a valid workspace.yaml validates successfully", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);

    await expect(validateWorkspaceStructure(path)).resolves.toBeUndefined();
  });

  test("missing artifact directories are ingested as empty categories", async () => {
    const home = isolatedHome();
    writeManifestOnlyWorkspace(home);

    const workspace = await ingestDefaultWorkspace(home);

    expect(workspace.contexts.size).toBe(0);
    expect(workspace.profiles.size).toBe(0);
    expect(workspace.skills.size).toBe(0);
  });

  test("a partial Workspace ingests present artifacts without requiring other categories", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);
    mkdirSync(join(path, "context"));
    mkdirSync(join(path, "profiles"));
    writeFileSync(
      join(path, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    writeFileSync(
      join(path, "profiles", "coding.yaml"),
      "id: coding\ncontext:\n  - team-rules\nskills: []\n",
    );

    const workspace = await ingestDefaultWorkspace(home);

    expect(workspace.contexts.has("team-rules")).toBe(true);
    expect(workspace.profiles.has("coding")).toBe(true);
    expect(workspace.skills.size).toBe(0);
  });

  test("obsolete Profile placeholders fail with actionable migration guidance", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);
    mkdirSync(join(path, "profiles"));
    writeFileSync(
      join(path, "profiles", "legacy.yaml"),
      "id: legacy\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );

    await expect(ingestDefaultWorkspace(home)).rejects.toThrow(
      "Profile profiles/legacy.yaml no longer supports fields: agents, hooks, tools. Remove these obsolete Profile fields; earlier releases allowed them only as empty placeholders",
    );
  });

  test("present malformed artifacts still fail at their ingestion boundary", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);
    mkdirSync(join(path, "context"));
    writeFileSync(join(path, "context", "broken.md"), "no frontmatter\n");

    await expect(ingestDefaultWorkspace(home)).rejects.toThrow(/Context Module|frontmatter|id/i);
  });

  test("a present artifact path that is not a directory is a structural error", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);
    writeFileSync(join(path, "skills"), "not a directory\n");

    await expect(validateWorkspaceStructure(path)).rejects.toThrow(
      /'skills' must be a directory/,
    );
  });

  test("a dangling category symlink is a structural error, not an empty category", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);
    symlinkSync(join(path, "does-not-exist"), join(path, "skills"));

    await expect(validateWorkspaceStructure(path)).rejects.toThrow(
      /'skills'.*(dangling|broken|symlink|directory)/i,
    );
  });

  test("a category symlink that resolves to a directory remains valid", async () => {
    const home = isolatedHome();
    const path = writeManifestOnlyWorkspace(home);
    const realSkills = join(home, "real-skills");
    mkdirSync(realSkills);
    symlinkSync(realSkills, join(path, "skills"));

    await expect(validateWorkspaceStructure(path)).resolves.toBeUndefined();
  });

  test("a malformed, missing, or unsupported workspace.yaml fails fast", async () => {
    const home = isolatedHome();
    const path = workspacePath(home);
    mkdirSync(path, { recursive: true });

    await expect(validateWorkspaceStructure(path)).rejects.toThrow(
      /missing required file 'workspace\.yaml'/,
    );

    writeFileSync(join(path, "workspace.yaml"), "not: valid: yaml: [\n");
    await expect(validateWorkspaceStructure(path)).rejects.toThrow(
      /invalid YAML|correct workspace\.yaml/i,
    );

    writeFileSync(join(path, "workspace.yaml"), "schema_version: 99\n");
    await expect(validateWorkspaceStructure(path)).rejects.toThrow(
      /Unsupported Workspace schema version 99/,
    );
  });

  test("init creates the full scaffold and re-init leaves a minimal valid Workspace unchanged", async () => {
    const home = isolatedHome();
    const created = await initializeWorkspace(home);
    const path = created.path;

    expect(created.outcome).toBe("created");
    for (const directory of WORKSPACE_ARTIFACT_DIRECTORIES) {
      expect(existsSync(join(path, directory, ".gitkeep"))).toBe(true);
    }
    expect(existsSync(join(path, "README.md"))).toBe(true);
    expect(existsSync(join(path, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(path, ".gitignore"))).toBe(true);
    expect(readFileSync(join(path, "workspace.yaml"), "utf8")).toBe(WORKSPACE_MANIFEST);
    expect(readFileSync(join(path, "profiles", "example.yaml"), "utf8")).toBe(
      "id: example\ncontext:\n  - example-context\nskills: []\n",
    );

    // Replace the full scaffold with a minimal Manifest-only Workspace.
    rmSync(path, { recursive: true, force: true });
    writeManifestOnlyWorkspace(home);
    const before = readdirSync(path).sort();

    const reinit = await initializeWorkspace(home);

    expect(reinit.outcome).toBe("unchanged");
    expect(readdirSync(path).sort()).toEqual(before);
    expect(existsSync(join(path, "README.md"))).toBe(false);
    expect(existsSync(join(path, "profiles"))).toBe(false);
  });

  test("symlinked valid Workspaces retain initialization and validation behavior", async () => {
    const home = isolatedHome();
    const realWorkspace = join(home, "real-workspace");
    mkdirSync(realWorkspace, { recursive: true });
    writeFileSync(join(realWorkspace, "workspace.yaml"), WORKSPACE_MANIFEST);

    const applicationRoot = join(home, ".agents", "agent-profile-kit");
    mkdirSync(applicationRoot, { recursive: true });
    symlinkSync(realWorkspace, join(applicationRoot, "workspace"));

    await expect(validateWorkspaceStructure(workspacePath(home))).resolves.toBeUndefined();
    const reinit = await initializeWorkspace(home);
    // Config is missing, so init may create config.yaml while leaving the Workspace tree alone.
    expect(["created", "unchanged"]).toContain(reinit.outcome);
    expect(readdirSync(realWorkspace).sort()).toEqual(["workspace.yaml"]);
    expect(existsSync(join(realWorkspace, "profiles"))).toBe(false);
  });
});
