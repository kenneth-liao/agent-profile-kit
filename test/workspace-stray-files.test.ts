import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectWorkspaceViolations,
  ingestWorkspace,
} from "../installer/ingest-workspace.js";
import {
  InstallerToolError,
  workspaceViolationPath,
  workspaceViolationToken,
  type WorkspaceViolation,
} from "../installer/tool-errors.js";
import { formatWorkspaceIngestionError } from "../cli/error-wording.js";

/**
 * Stray files in the Workspace artifact folders are violations, never silently
 * ignored (spec #593 DEC-008, #605; US-006 ISC-44, US-004; TEST-006):
 *
 * - hidden files and folders (names starting with `.`) are ignored everywhere,
 *   including inside Skill packages, and are never traversed;
 * - under `context/`, every non-hidden entry must be a regular `.md` file;
 * - under `skills/`, every non-hidden entry must belong to a Skill package
 *   (a folder with `SKILL.md`); folders may group Skill packages;
 * - under `profiles/`, every non-hidden file must be a `.yaml` Profile
 *   directly under `profiles/` (`.yml` is not accepted);
 * - symlinks under the three folders are violations and are never followed.
 *
 * Empty folders (no non-hidden files beneath them) violate nothing: DEC-008's
 * rules bind files. Hidden files inside a Skill package stay package content
 * and are still projected to Hosts; filtering them from delivery is out of
 * scope (OOS-007).
 */

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "apkit-stray-files-"));
  temporaryDirectories.push(workspace);
  mkdirSync(join(workspace, "context"), { recursive: true });
  mkdirSync(join(workspace, "skills"), { recursive: true });
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
  return workspace;
}

function writeSkill(workspace: string, id: string): void {
  mkdirSync(join(workspace, "skills", id), { recursive: true });
  writeFileSync(
    join(workspace, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: Describes ${id}.\n---\n\n${id} body.\n`,
  );
}

function writeContextFile(workspace: string, relative: string): void {
  mkdirSync(join(workspace, "context", join(relative, "..")), { recursive: true });
  writeFileSync(join(workspace, "context", relative), "Module body.\n");
}

function writeProfileFile(workspace: string, name: string, body: string): void {
  mkdirSync(join(workspace, "profiles", join(name, "..")), { recursive: true });
  writeFileSync(join(workspace, "profiles", name), body);
}

function seedValidSelection(workspace: string): void {
  writeContextFile(workspace, "notes.md");
  writeSkill(workspace, "good-skill");
  writeProfileFile(workspace, "example.yaml", "context: [notes]\nskills: [good-skill]\n");
}

function tokens(violations: readonly WorkspaceViolation[]): readonly string[] {
  return violations.map(workspaceViolationToken).sort();
}

function paths(violations: readonly WorkspaceViolation[]): readonly string[] {
  return violations.map(workspaceViolationPath).sort();
}

/** Expect exactly one run's worth of violations of the given kinds at the given paths. */
async function expectViolations(
  workspace: string,
  expectedTokens: readonly string[],
  expectedPaths: readonly string[],
): Promise<readonly WorkspaceViolation[]> {
  const collected = await collectWorkspaceViolations(workspace);
  expect(collected.outcome).toBe("invalid");
  if (collected.outcome !== "invalid") throw new Error("expected an invalid collection");
  expect(tokens(collected.violations)).toEqual(expectedTokens);
  expect(paths(collected.violations)).toEqual(expectedPaths);
  return collected.violations;
}

describe("stray-file rejection (spec #593 DEC-008, #605)", () => {
  test("hidden files and folders are ignored everywhere and never traversed", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "good-skill");
    writeContextFile(workspace, "notes.md");
    writeProfileFile(workspace, "example.yaml", "context: [notes]\nskills: [good-skill]\n");
    // Hidden entries at every level, including inside a Skill package and a
    // hidden Skill package, and retired files under hidden folders.
    writeFileSync(join(workspace, ".DS_Store"), "junk");
    writeFileSync(join(workspace, "context", ".hidden.md"), "hidden module\n");
    mkdirSync(join(workspace, "context", ".hid-dir"));
    writeFileSync(join(workspace, "context", ".hid-dir", "notes.txt"), "hidden stray\n");
    mkdirSync(join(workspace, "skills", ".hidden-pkg"));
    writeFileSync(
      join(workspace, "skills", ".hidden-pkg", "SKILL.md"),
      "---\nname: hidden\ndescription: Hidden.\n---\nbody\n",
    );
    writeFileSync(join(workspace, "skills", "good-skill", ".DS_Store"), "junk");
    mkdirSync(join(workspace, "skills", "good-skill", ".hid"));
    writeFileSync(
      join(workspace, "skills", "good-skill", ".hid", "agent-profile-kit.yaml"),
      "context: []\n",
    );
    writeFileSync(join(workspace, "profiles", ".hidden.yaml"), "context: []\nskills: []\n");

    const collected = await collectWorkspaceViolations(workspace);
    expect(collected.outcome).toBe("valid");
  });

  test("a non-hidden non-Markdown file under context/ is a stray with its path and fix", async () => {
    const workspace = makeWorkspace();
    writeContextFile(workspace, "notes.md");
    writeFileSync(join(workspace, "context", "notes.txt"), "not markdown\n");
    const violations = await expectViolations(
      workspace,
      ["stray-context-file"],
      ["context/notes.txt"],
    );
    expect(violations[0]).toMatchObject({ via: "ingestion", fact: { kind: "stray-context-file", file: "context/notes.txt" } });
  });

  test("a nested non-Markdown file under context/ is a stray; a .md sibling parses in the same run", async () => {
    const workspace = makeWorkspace();
    writeContextFile(workspace, join("group", "notes.md"));
    writeFileSync(join(workspace, "context", "group", "plan.rst"), "not markdown\n");
    await expectViolations(workspace, ["stray-context-file"], ["context/group/plan.rst"]);
  });

  test("a file under skills/ outside a Skill package is a stray; package territory stays valid", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "good-skill");
    mkdirSync(join(workspace, "skills", "good-skill", "references"), { recursive: true });
    writeFileSync(join(workspace, "skills", "good-skill", "references", "guide.md"), "resource\n");
    writeFileSync(join(workspace, "skills", "README.md"), "stray\n");
    await expectViolations(workspace, ["stray-skill-file"], ["skills/README.md"]);
  });

  test("a file inside a grouping folder but outside a package is a stray; package groups and empty folders are valid", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "grouped-skill");
    mkdirSync(join(workspace, "skills", "group"));
    writeFileSync(join(workspace, "skills", "group", "notes.md"), "stray\n");
    mkdirSync(join(workspace, "skills", "empty-group"));
    const violations = await expectViolations(
      workspace,
      ["stray-skill-file"],
      ["skills/group/notes.md"],
    );
    expect(violations[0]).toMatchObject({ fact: { kind: "stray-skill-file", file: "skills/group/notes.md" } });
  });

  test("a symlink under skills/ is a stray and is never followed", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "good-skill");
    symlinkSync(join(workspace, "skills", "good-skill"), join(workspace, "skills", "linked-pkg"));
    symlinkSync("../nowhere", join(workspace, "skills", "dangling.md"));
    const violations = await expectViolations(
      workspace,
      ["stray-skill-file", "stray-skill-file"],
      ["skills/dangling.md", "skills/linked-pkg"],
    );
    for (const violation of violations) {
      if (violation.via !== "ingestion" || violation.fact.kind !== "stray-skill-file") {
        throw new Error("expected stray-skill-file facts");
      }
      expect(violation.fact.symlink).toBe(true);
    }
  });

  test("a non-.yaml file directly under profiles/ is a stray, including .yml", async () => {
    const workspace = makeWorkspace();
    seedValidSelection(workspace);
    writeProfileFile(workspace, "legacy.yml", "context: []\nskills: []\n");
    writeProfileFile(workspace, "README.txt", "stray\n");
    await expectViolations(
      workspace,
      ["stray-profile-file", "stray-profile-file"],
      ["profiles/README.txt", "profiles/legacy.yml"],
    );
  });

  test("a non-.yaml file under a profiles/ subfolder is a stray; nested .yaml keeps its kind and an empty subfolder is valid", async () => {
    const workspace = makeWorkspace();
    seedValidSelection(workspace);
    writeProfileFile(workspace, "sub/nested.yaml", "context: []\nskills: []\n");
    writeProfileFile(workspace, "sub/second.yaml", "context: []\nskills: []\n");
    writeProfileFile(workspace, "sub/notes.txt", "stray\n");
    mkdirSync(join(workspace, "profiles", "empty"));
    // Every nested .yaml is named — a moved Profile is never silently
    // ignored (DEC-014, #598; collection extended to all instances #605).
    await expectViolations(
      workspace,
      ["nested-profile", "nested-profile", "stray-profile-file"],
      ["profiles/sub/nested.yaml", "profiles/sub/notes.txt", "profiles/sub/second.yaml"],
    );
  });

  test("a symlink under profiles/ is a stray and is never followed", async () => {
    const workspace = makeWorkspace();
    seedValidSelection(workspace);
    symlinkSync("example.yaml", join(workspace, "profiles", "linked.yaml"));
    symlinkSync("../nowhere", join(workspace, "profiles", "dangling.yaml"));
    await expectViolations(
      workspace,
      ["stray-profile-file", "stray-profile-file"],
      ["profiles/dangling.yaml", "profiles/linked.yaml"],
    );
  });

  test("strays appear in the same single run as every other violation kind", async () => {
    const workspace = makeWorkspace();
    writeContextFile(workspace, "notes.md");
    writeSkill(workspace, "good-skill");
    writeProfileFile(workspace, "example.yaml", "context: [notes]\nskills: [good-skill]\n");
    // Strays in all three folders, plus one existing violation kind per family.
    writeFileSync(join(workspace, "context", "notes.txt"), "stray\n");
    writeFileSync(join(workspace, "skills", "README.md"), "stray\n");
    writeProfileFile(workspace, "legacy.yml", "context: []\nskills: []\n");
    writeSkill(workspace, "sidecar-skill");
    writeFileSync(join(workspace, "skills", "sidecar-skill", "agent-profile-kit.yaml"), "context: []\n");
    writeProfileFile(workspace, "alpha.yaml", "id: alpha\ncontext: [notes]\nskills: [good-skill]\n");

    const collected = await collectWorkspaceViolations(workspace);
    expect(collected.outcome).toBe("invalid");
    if (collected.outcome !== "invalid") throw new Error("expected an invalid collection");
    expect(tokens(collected.violations)).toEqual([
      "leftover-skill-sidecar",
      "stray-context-file",
      "stray-profile-file",
      "stray-skill-file",
      "workspace-artifact/profile-id-field",
    ]);
    expect(paths(collected.violations)).toEqual([
      "context/notes.txt",
      "profiles/alpha.yaml",
      "profiles/legacy.yml",
      "skills/README.md",
      "skills/sidecar-skill/agent-profile-kit.yaml",
    ]);

    // The ingest-or-throw aggregate fact carries the same complete list.
    try {
      await ingestWorkspace(workspace);
      throw new Error("expected ingestWorkspace to reject the workspace");
    } catch (error) {
      expect(error).toBeInstanceOf(InstallerToolError);
      const fact = (error as InstallerToolError).fact;
      expect(fact.kind).toBe("workspace-violations");
      if (fact.kind !== "workspace-violations") throw new Error("expected the aggregate fact");
      expect(fact.violations.map(workspaceViolationToken).sort()).toEqual([
        "leftover-skill-sidecar",
        "stray-context-file",
        "stray-profile-file",
        "stray-skill-file",
        "workspace-artifact/profile-id-field",
      ]);
      expect(fact.workspace).toBe(workspace);
    }
  });
});

describe("stray-file violation wording (spec #593 DEC-008, #605)", () => {
  test("each sentence names its path and the change that fixes it", () => {
    const context = formatWorkspaceIngestionError({ kind: "stray-context-file", file: "context/notes.txt" });
    expect(context).toContain("context/notes.txt");
    expect(context).toContain(".md");

    const skill = formatWorkspaceIngestionError({ kind: "stray-skill-file", file: "skills/README.md" });
    expect(skill).toContain("skills/README.md");
    expect(skill).toContain("Skill package");

    const profile = formatWorkspaceIngestionError({ kind: "stray-profile-file", file: "profiles/legacy.yml" });
    expect(profile).toContain("profiles/legacy.yml");
    expect(profile).toContain(".yaml");
  });

  test("a symlink stray names the link-specific fix", () => {
    const sentence = formatWorkspaceIngestionError({
      kind: "stray-skill-file",
      file: "skills/linked-pkg",
      symlink: true,
    });
    expect(sentence).toContain("never follows links");
  });
});
