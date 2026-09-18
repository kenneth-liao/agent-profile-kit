import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { singleViolation, violationEvidence } from "./support/workspace-violations.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";

/**
 * Profile ingestion keys each Profile by its file name under `profiles/`
 * without `.yaml` (spec #593 DEC-014, #598). Nested folders are not accepted:
 * every `.yaml` under a `profiles/` subdirectory is one violation naming its
 * path, so a moved Profile is never silently ignored.
 */

function scaffoldWorkspace(home: string): string {
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  mkdirSync(join(workspace, "context"), { recursive: true });
  mkdirSync(join(workspace, "skills"), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
  return workspace;
}

function writeMinimalSkill(workspace: string, id: string): void {
  mkdirSync(join(workspace, "skills", id), { recursive: true });
  writeFileSync(
    join(workspace, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: Describes ${id}.\n---\n\n${id} body.\n`,
  );
}

function writeMinimalContext(workspace: string, id: string): void {
  writeFileSync(
    join(workspace, "context", `${id}.md`),
    `${id} body.\n`,
  );
}

async function ingestionFact(workspace: string): Promise<Record<string, unknown>> {
  return violationEvidence(await singleViolation(workspace));
}

async function ingestionMap(workspace: string): Promise<ReadonlyMap<string, string>> {
  const ingested = await ingestWorkspace(workspace);
  return new Map([...ingested.profiles].map(([id, profile]) => [id, profile.path]));
}

describe("Profile ingestion by file name (spec #593 DEC-014, #598)", () => {
  test("profiles without an id field ingest keyed by file name", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-profile-ingest-"));
    try {
      const workspace = scaffoldWorkspace(home);
      writeMinimalContext(workspace, "team-rules");
      writeMinimalSkill(workspace, "review-pr");
      writeFileSync(
        join(workspace, "profiles", "coding.yaml"),
        "context:\n  - team-rules\nskills:\n  - review-pr\n",
      );
      expect(await ingestionMap(workspace)).toEqual(new Map([["coding", "profiles/coding.yaml"]]));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a nested Profile file fails ingestion naming its path", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-profile-ingest-"));
    try {
      const workspace = scaffoldWorkspace(home);
      writeMinimalContext(workspace, "team-rules");
      writeMinimalSkill(workspace, "review-pr");
      mkdirSync(join(workspace, "profiles", "archive"), { recursive: true });
      writeFileSync(
        join(workspace, "profiles", "archive", "old-work.yaml"),
        "context:\n  - team-rules\nskills: []\n",
      );
      expect(await ingestionFact(workspace)).toEqual({
        kind: "nested-profile",
        file: "profiles/archive/old-work.yaml",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a top-level Profile file name that is not a valid Artifact ID fails ingestion", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-profile-ingest-"));
    try {
      const workspace = scaffoldWorkspace(home);
      writeMinimalContext(workspace, "team-rules");
      writeMinimalSkill(workspace, "review-pr");
      writeFileSync(
        join(workspace, "profiles", "Coding_Rules.yaml"),
        "context: []\nskills:\n  - review-pr\n",
      );
      const fact = await ingestionFact(workspace);
      expect(fact).toMatchObject({ case: "profile-file-name", path: "profiles/Coding_Rules.yaml" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
