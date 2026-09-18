import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import type { WorkspaceIngestionErrorFact } from "../installer/tool-errors.js";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "apkit-sidecar-"));
}

function scaffoldWorkspace(home: string): string {
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  mkdirSync(join(workspace, "context"), { recursive: true });
  mkdirSync(join(workspace, "skills", "deploy"), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "context: []\nskills: [deploy]\n",
  );
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\n\n# Team rules\n",
  );
  writeFileSync(
    join(workspace, "skills", "deploy", "SKILL.md"),
    "---\nname: deploy\ndescription: Deploys the service.\n---\n\nDeploy.\n",
  );
  return workspace;
}

async function ingestionFact(workspace: string): Promise<WorkspaceIngestionErrorFact> {
  try {
    await ingestWorkspace(workspace);
  } catch (error) {
    if (error instanceof InstallerToolError) return error.fact as WorkspaceIngestionErrorFact;
    throw error;
  }
  throw new Error("expected ingestWorkspace to reject the workspace");
}

describe("leftover Skill sidecars (spec #593 DEC-006, #596)", () => {
  test("a leftover sidecar file in a Skill package fails ingestion with its path", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      writeFileSync(
        join(workspace, "skills", "deploy", "agent-profile-kit.yaml"),
        "dependencies:\n  - type: context\n    id: team-rules\n",
      );
      expect(await ingestionFact(workspace)).toEqual({
        kind: "leftover-skill-sidecar",
        file: "skills/deploy/agent-profile-kit.yaml",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a leftover sidecar directory entry in a Skill package also fails ingestion", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      mkdirSync(join(workspace, "skills", "deploy", "agent-profile-kit.yaml"));
      expect(await ingestionFact(workspace)).toEqual({
        kind: "leftover-skill-sidecar",
        file: "skills/deploy/agent-profile-kit.yaml",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a leftover sidecar in a nested Skill package names the nested path", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      mkdirSync(join(workspace, "skills", "grouped", "nested-skill"), { recursive: true });
      writeFileSync(
        join(workspace, "skills", "grouped", "nested-skill", "SKILL.md"),
        "---\nname: nested-skill\ndescription: Nested skill.\n---\n\nNested.\n",
      );
      writeFileSync(
        join(workspace, "skills", "grouped", "nested-skill", "agent-profile-kit.yaml"),
        "dependencies: []\n",
      );
      expect(await ingestionFact(workspace)).toEqual({
        kind: "leftover-skill-sidecar",
        file: "skills/grouped/nested-skill/agent-profile-kit.yaml",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a sidecar in a subdirectory of a Skill package names its nested path", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      mkdirSync(join(workspace, "skills", "deploy", "scripts"), { recursive: true });
      writeFileSync(join(workspace, "skills", "deploy", "scripts", "run.sh"), "#!/bin/sh\ntrue\n");
      writeFileSync(
        join(workspace, "skills", "deploy", "scripts", "agent-profile-kit.yaml"),
        "dependencies: []\n",
      );
      expect(await ingestionFact(workspace)).toEqual({
        kind: "leftover-skill-sidecar",
        file: "skills/deploy/scripts/agent-profile-kit.yaml",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an agent-profile-kit.yaml outside any Skill package is not a sidecar violation", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      // A directory named like the sidecar at the skills root is not inside a
      // Skill package; stray-file handling is #605's scope, so it must not be
      // reported as a leftover sidecar.
      mkdirSync(join(workspace, "skills", "agent-profile-kit.yaml"));
      const ingested = await ingestWorkspace(workspace);
      expect([...ingested.skills.keys()]).toEqual(["deploy"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});