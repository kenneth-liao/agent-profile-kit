import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectWorkspaceViolations,
  ingestWorkspace,
} from "../installer/ingest-workspace.js";
import {
  InstallerToolError,
  workspaceViolationToken,
  type WorkspaceViolation,
} from "../installer/tool-errors.js";

/**
 * Workspace validation collects every violation in one run (spec #593 US-006,
 * DEC-009, #604; TEST-006, ISC-41, ISC-46). The collecting parser is the one
 * ingestion behavior: `ingestWorkspace` keeps its ingest-or-throw contract by
 * throwing one aggregate `workspace-violations` fact carrying the complete
 * collected list, so validate and lifecycle can never disagree about what a
 * Workspace contains. Hidden files are ignored by DEC-008 and are exercised
 * by #605, not here.
 */

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "apkit-violation-collection-"));
  temporaryDirectories.push(workspace);
  mkdirSync(join(workspace, "context"), { recursive: true });
  mkdirSync(join(workspace, "skills"), { recursive: true });
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
  return workspace;
}

function writeSkill(workspace: string, id: string, skillMd?: string): void {
  mkdirSync(join(workspace, "skills", id), { recursive: true });
  writeFileSync(
    join(workspace, "skills", id, "SKILL.md"),
    skillMd ?? `---\nname: ${id}\ndescription: Describes ${id}.\n---\n\n${id} body.\n`,
  );
}

function writeContextFile(workspace: string, relative: string, contents: string): void {
  mkdirSync(join(workspace, "context", join(relative, "..")), { recursive: true });
  writeFileSync(join(workspace, "context", relative), contents);
}

function writeProfileFile(workspace: string, name: string, body: string): void {
  writeFileSync(join(workspace, "profiles", name), body);
}

function tokens(violations: readonly WorkspaceViolation[]): readonly string[] {
  return violations.map(workspaceViolationToken).sort();
}

function violationPaths(violations: readonly WorkspaceViolation[]): readonly string[] {
  return violations
    .map((violation) => ("fact" in violation ? violation.fact : violation.detail))
    .map((fact) => ("path" in fact ? fact.path : "file" in fact ? fact.file : ""))
    .sort();
}

describe("Workspace violation collection (spec #593 DEC-009, #604)", () => {
  test("one run reports every violation across categories", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "healthy-skill");
    writeContextFile(workspace, join("group-a", "topic-01.md"), "Topic body.\n");
    // Violation 1: a Profile carrying an `id` field (#598).
    writeProfileFile(
      workspace,
      "alpha.yaml",
      "id: alpha\ncontext: [group-a/topic-01]\nskills: [healthy-skill]\n",
    );
    // Violation 2: a leftover Skill sidecar (#596).
    writeSkill(workspace, "sidecar-skill");
    writeFileSync(join(workspace, "skills", "sidecar-skill", "agent-profile-kit.yaml"), "context: []\n");

    const collected = await collectWorkspaceViolations(workspace);
    expect(collected.workspace).toBeUndefined();
    expect(collected.violations.map(workspaceViolationToken).sort()).toEqual([
      "leftover-skill-sidecar",
      "workspace-artifact/profile-id-field",
    ]);
    // Each violation names its path.
    expect(violationPaths(collected.violations)).toEqual([
      "profiles/alpha.yaml",
      "skills/sidecar-skill/agent-profile-kit.yaml",
    ]);

    // The ingest-or-throw contract carries the same complete list.
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
        "workspace-artifact/profile-id-field",
      ]);
      expect(fact.workspace).toBe(workspace);
    }
  });

  test("a valid workspace collects nothing and still ingests", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "skill-01");
    writeContextFile(workspace, "topic-01.md", "Topic body.\n");
    writeProfileFile(workspace, "p-one.yaml", "context: [topic-01]\nskills: [skill-01]\n");

    const collected = await collectWorkspaceViolations(workspace);
    expect(collected.violations).toEqual([]);
    expect(collected.workspace).toBeDefined();
    await expect(ingestWorkspace(workspace)).resolves.toBeDefined();
  });
});

describe("one run reports every co-reportable violation kind (TEST-006, ISC-41)", () => {
  test("the maximal artifact tree reports the complete set", async () => {
    const workspace = makeWorkspace();
    // Healthy material other violations can reference.
    writeSkill(workspace, "skill-ok");
    writeContextFile(workspace, "topic-ok.md", "Topic body.\n");
    // The healthy file at a nested path proves the moved-file fix: the
    // Profile's old flat ID `renamed-topic` suggests `group-a/renamed-topic`.
    writeContextFile(workspace, join("group-a", "renamed-topic.md"), "Body.\n");

    // Context artifact kinds.
    writeContextFile(workspace, "Bad_Segment.md", "Body.\n"); // context-module-file-name
    writeContextFile(workspace, "empty-topic.md", ""); // empty-content

    // Skill artifact kinds — one package per kind.
    writeSkill(workspace, "skill-metadata", "---\nname: skill-metadata\ndescription: d.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\nBody.\n");
    writeSkill(workspace, "skill-flag", "---\nname: skill-flag\ndescription: d.\ndisable-model-invocation: maybe\n---\n\nBody.\n");
    writeSkill(workspace, "skill-yaml", "---\nname: [unclosed\n---\n\nBody.\n");
    writeSkill(workspace, "skill-open", "No frontmatter.\n");
    writeSkill(workspace, "skill-unclosed", "---\nname: skill-unclosed\n");
    writeSkill(workspace, "skill-name", "---\nname: Bad Name\ndescription: d.\n---\n\nBody.\n");
    writeSkill(workspace, "skill-field", "---\nname: skill-field\ndescription: ''\n---\n\nBody.\n");
    writeSkill(workspace, "skill-dup-a", "---\nname: skill-dup\ndescription: d.\n---\n\nBody.\n");
    writeSkill(workspace, "skill-dup-b", "---\nname: skill-dup\ndescription: d.\n---\n\nBody.\n");
    writeSkill(workspace, "skill-sidecar");
    writeFileSync(join(workspace, "skills", "skill-sidecar", "agent-profile-kit.yaml"), "context: []\n");

    // Profile artifact kinds — one file per kind (one parse violation per file).
    writeProfileFile(workspace, "p-id.yaml", "id: p-id\ncontext: []\nskills: []\n");
    writeProfileFile(workspace, "Bad_Name.yaml", "context: []\nskills: []\n");
    writeProfileFile(workspace, "p-yaml.yaml", "context: [unclosed\n");
    writeProfileFile(workspace, "p-unknown.yaml", "context: []\nskills: []\nextra: true\n");
    writeProfileFile(workspace, "p-obsolete.yaml", "agents: []\ncontext: []\nskills: []\n");
    writeProfileFile(workspace, "p-missing.yaml", "context: []\n");
    writeProfileFile(workspace, "p-notarray.yaml", "context: topic-ok\nskills: []\n");
    writeProfileFile(workspace, "p-dupname.yaml", "context: [topic-ok, topic-ok]\nskills: []\n");
    writeProfileFile(workspace, "p-badref-id.yaml", "context: [Bad Ref]\nskills: []\n");
    writeProfileFile(workspace, "p-badref-skill.yaml", "context: []\nskills: [Bad Ref]\n");
    writeProfileFile(workspace, "p-empty.yaml", "context: []\nskills: []\n");
    writeProfileFile(workspace, "p-moved-ref.yaml", "context: [renamed-topic]\nskills: [skill-ok]\n");
    writeProfileFile(workspace, "p-missing-skill.yaml", "context: [topic-ok]\nskills: [skill-ghost]\n");
    mkdirSync(join(workspace, "profiles", "nested"), { recursive: true });
    writeProfileFile(workspace, "nested/p-nested.yaml", "context: []\nskills: []\n");

    const collected = await collectWorkspaceViolations(workspace);
    expect(tokens(collected.violations)).toEqual([
      "duplicate-artifact-name",
      "workspace-artifact/duplicate-name",
      "workspace-artifact/empty-content",
      "workspace-artifact/frontmatter-not-open",
      "workspace-artifact/frontmatter-unclosed",
      "workspace-artifact/invalid-artifact-id",
      "workspace-artifact/invalid-artifact-id",
      "workspace-artifact/invalid-artifact-id",
      "workspace-artifact/invalid-field",
      "workspace-artifact/invalid-model-invocation",
      "workspace-artifact/invalid-yaml",
      "workspace-artifact/invalid-yaml",
      "workspace-artifact/leftover-model-invocation-metadata",
      "leftover-skill-sidecar",
      "missing-context-reference",
      "workspace-artifact/missing-field",
      "missing-skill-reference",
      "nested-profile",
      "workspace-artifact/not-array-of-names",
      "workspace-artifact/obsolete-fields",
      "workspace-artifact/profile-file-name",
      "workspace-artifact/profile-id-field",
      "profile-without-artifacts",
      "workspace-artifact/unknown-fields",
      "workspace-artifact/context-module-file-name",
    ].sort());

    // The moved-file reference names the profile and file; the moved-path
    // suggestion is presentation and is asserted through the CLI report.
    const contextReference = collected.violations.find(
      (violation) => workspaceViolationToken(violation) === "missing-context-reference",
    );
    expect(contextReference).toBeDefined();
    if (contextReference === undefined || !("fact" in contextReference)) {
      throw new Error("expected the collected missing-context-reference fact");
    }
    const fact = contextReference.fact;
    if (fact.kind !== "missing-context-reference") {
      throw new Error("expected the missing-context-reference fact");
    }
    expect(fact.profile).toBe("p-moved-ref");
    expect(fact.contextId).toBe("renamed-topic");
    expect(fact.available).toEqual(["group-a/renamed-topic", "topic-ok"]);
  });

  test("structure and manifest kinds are collected independently of artifacts", async () => {
    // Manifest missing: artifacts still report (setup's write-free would-be
    // validation needs the complete report).
    const missing = makeWorkspace();
    rmSync(join(missing, "workspace.yaml"));
    writeProfileFile(missing, "p-bad.yaml", "context: []\nskills: []\n");
    const missingCollected = await collectWorkspaceViolations(missing);
    expect(tokens(missingCollected.violations)).toEqual([
      "profile-without-artifacts",
      "workspace-missing-manifest",
    ]);

    // Manifest as a directory.
    const notFile = makeWorkspace();
    rmSync(join(notFile, "workspace.yaml"));
    mkdirSync(join(notFile, "workspace.yaml"));
    expect(tokens((await collectWorkspaceViolations(notFile)).violations)).toEqual([
      "workspace-manifest-not-file",
    ]);

    // A dangling category symlink and a category that is a file, in different
    // categories, report together; those categories are not scanned.
    const structure = makeWorkspace();
    rmSync(join(structure, "context"), { recursive: true, force: true });
    symlinkSync(join(structure, "nowhere"), join(structure, "context"));
    rmSync(join(structure, "skills"), { recursive: true, force: true });
    writeFileSync(join(structure, "skills"), "not a directory\n");
    expect(tokens((await collectWorkspaceViolations(structure)).violations)).toEqual([
      "workspace-category-not-directory",
      "workspace-dangling-category",
    ]);

    // Manifest rejection cases, one tree each (mutually exclusive with a
    // valid manifest).
    const cases: Readonly<Record<string, string>> = {
      "workspace-manifest/invalid-yaml": "not: valid: yaml: [\n",
      "workspace-manifest/schema-version-missing": "other: true\n",
      "workspace-manifest/schema-version-not-positive": "schema_version: 0\n",
      "workspace-manifest/unsupported-schema-version": "schema_version: 99\n",
      "workspace-manifest/unknown-fields": "schema_version: 1\nextra: true\n",
    };
    for (const [token, manifest] of Object.entries(cases)) {
      const workspace = makeWorkspace();
      writeFileSync(join(workspace, "workspace.yaml"), manifest);
      expect(tokens((await collectWorkspaceViolations(workspace)).violations), token).toEqual([token]);
    }
  });
});