import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brokenProfileViolations,
  ingestWorkspace,
  ingestWorkspaceToleratingReferenceViolations,
  isProfileReferenceViolation,
} from "../installer/ingest-workspace.js";
import {
  InstallerToolError,
  workspaceViolationPath,
  workspaceViolationToken,
  type WorkspaceViolation,
} from "../installer/tool-errors.js";

/**
 * Lifecycle ingestion tolerates Profile reference violations (spec #593
 * US-007, DEC-009 project scope, #606): the collecting parser (#604) remains
 * the one classification home — `isProfileReferenceViolation` only reuses its
 * `missing-context-reference` and `missing-skill-reference` ingestion facts —
 * and the tolerant boundary splits them from workspace-invalidating
 * violations. Structure and artifact violations keep making the Workspace
 * invalid for every command: the tolerant boundary throws the identical
 * aggregate `workspace-violations` fact strict ingestion throws.
 */

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "apkit-reference-tolerance-"));
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

describe("Profile reference tolerance at the lifecycle ingestion boundary (#606)", () => {
  test("a reference-only-invalid Workspace ingests with grouped broken-Profile facts", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "review");
    writeFileSync(join(workspace, "context", "notes.md"), "Notes.\n");
    writeFileSync(
      join(workspace, "profiles", "broken.yaml"),
      "context:\n  - gone-context\nskills:\n  - review\n  - gone-skill\n",
    );
    writeFileSync(join(workspace, "profiles", "also-broken.yaml"), "context:\n  - also-gone\nskills: []\n");

    const result = await ingestWorkspaceToleratingReferenceViolations(workspace);

    expect(result.brokenProfiles.map(({ profile, file, missingContexts, missingSkills }) => ({
      profile, file, missingContexts, missingSkills,
    }))).toEqual([
      {
        profile: "also-broken",
        file: "profiles/also-broken.yaml",
        missingContexts: ["also-gone"],
        missingSkills: [],
      },
      {
        profile: "broken",
        file: "profiles/broken.yaml",
        missingContexts: ["gone-context"],
        missingSkills: ["gone-skill"],
      },
    ]);
    // Each grouped fact carries its own verbatim #604 facts (#606).
    for (const broken of result.brokenProfiles) {
      expect(broken.referenceViolations.length).toBeGreaterThan(0);
      expect([...broken.referenceViolations].every(isProfileReferenceViolation)).toBe(true);
    }
    expect(brokenProfileViolations(result.brokenProfiles).map(workspaceViolationToken).sort()).toEqual([
      "missing-context-reference",
      "missing-context-reference",
      "missing-skill-reference",
    ]);
    // The lenient Workspace keeps every parsed artifact, broken Profiles included.
    expect([...result.workspace.profiles.keys()].sort()).toEqual(["also-broken", "broken"]);
    expect([...result.workspace.contexts.keys()]).toEqual(["notes"]);
    expect([...result.workspace.skills.keys()]).toEqual(["review"]);
    expect(result.brokenProfiles.every((fact) => fact.missingContexts.length + fact.missingSkills.length > 0)).toBe(true);
    expect([...brokenProfileViolations(result.brokenProfiles)].every(isProfileReferenceViolation)).toBe(true);
  });

  test("a mixed-invalid Workspace throws the identical aggregate violation fact", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "review");
    writeFileSync(join(workspace, "context", "notes.md"), "Notes.\n");
    writeFileSync(
      join(workspace, "profiles", "broken.yaml"),
      "context:\n  - gone-context\nskills:\n  - review\n",
    );
    // A stray file under `context/` is a structure violation (#605).
    writeFileSync(join(workspace, "context", "stray.txt"), "stray\n");

    let thrown: unknown;
    try {
      await ingestWorkspaceToleratingReferenceViolations(workspace);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstallerToolError);
    const fact = (thrown as InstallerToolError).fact;
    if (fact.kind !== "workspace-violations") throw new Error(`expected workspace-violations, got ${fact.kind}`);
    expect(fact.violations.map(workspaceViolationToken).sort()).toEqual([
      "missing-context-reference",
      "stray-context-file",
    ]);
    // Identical to what strict ingestion throws for the same Workspace.
    let strictThrown: unknown;
    try {
      await ingestWorkspace(workspace);
    } catch (error) {
      strictThrown = error;
    }
    expect(strictThrown).toEqual(thrown);
  });

  test("a valid Workspace ingests with no broken Profiles", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "review");
    writeFileSync(join(workspace, "context", "notes.md"), "Notes.\n");
    writeFileSync(
      join(workspace, "profiles", "fine.yaml"),
      "context:\n  - notes\nskills:\n  - review\n",
    );
    const result = await ingestWorkspaceToleratingReferenceViolations(workspace);
    expect(result.brokenProfiles).toEqual([]);
    expect(brokenProfileViolations(result.brokenProfiles)).toEqual([]);
    expect([...result.workspace.profiles.keys()]).toEqual(["fine"]);
  });

  test("empty-Profile shape violations are not reference violations and stay invalidating", async () => {
    const workspace = makeWorkspace();
    writeSkill(workspace, "review");
    writeFileSync(join(workspace, "profiles", "empty.yaml"), "context: []\nskills: []\n");
    await expect(ingestWorkspaceToleratingReferenceViolations(workspace)).rejects.toBeInstanceOf(
      InstallerToolError,
    );
    // The predicate classifies only the two reference kinds (#604 facts).
    const collected = await ingestWorkspaceToleratingReferenceViolations(workspace).catch(
      (error: unknown) => error,
    );
    const fact = (collected as InstallerToolError).fact;
    if (fact.kind !== "workspace-violations") throw new Error(`expected workspace-violations`);
    expect(fact.violations.map(workspaceViolationToken)).toEqual(["profile-without-artifacts"]);
    expect(fact.violations.some(isProfileReferenceViolation)).toBe(false);
  });

  test("the predicate rejects non-reference violations", () => {
    expect(isProfileReferenceViolation({
      via: "ingestion",
      fact: { kind: "leftover-skill-sidecar", file: "skills/review/agent-profile-kit.yaml" },
    })).toBe(false);
    expect(isProfileReferenceViolation({
      via: "ingestion",
      fact: { kind: "missing-context-reference", profile: "p", contextId: "c", file: "profiles/p.yaml", available: [] },
    })).toBe(true);
    expect(isProfileReferenceViolation({
      via: "ingestion",
      fact: { kind: "missing-skill-reference", profile: "p", skillId: "s", file: "profiles/p.yaml", available: [] },
    })).toBe(true);
    const manifest: WorkspaceViolation = {
      via: "manifest",
      detail: { case: "invalid-yaml", path: "workspace.yaml" } as never,
    };
    expect(isProfileReferenceViolation(manifest)).toBe(false);
    expect(workspaceViolationPath({
      via: "ingestion",
      fact: { kind: "missing-context-reference", profile: "p", contextId: "c", file: "profiles/p.yaml", available: [] },
    })).toBe("profiles/p.yaml");
  });
});