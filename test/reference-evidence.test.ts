import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import type { WorkspaceIngestionErrorFact } from "../installer/tool-errors.js";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "apkit-reference-evidence-"));
}

function scaffoldWorkspace(home: string): string {
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  mkdirSync(join(workspace, "context"), { recursive: true });
  mkdirSync(join(workspace, "skills", "deploy"), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
  writeFileSync(join(workspace, "profiles", "coding.yaml"), "id: coding\ncontext: []\nskills: []\n");
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

describe("Workspace reference-repair evidence (US-025/026, DEC-017)", () => {
  test("a Profile reference to a missing Context Module names file, invalid value, and available names", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      writeFileSync(
        join(workspace, "profiles", "broken.yaml"),
        "id: broken\ncontext:\n  - no-such-context\nskills: []\n",
      );
      expect(await ingestionFact(workspace)).toEqual({
        kind: "missing-context-reference",
        profile: "broken",
        contextId: "no-such-context",
        file: "profiles/broken.yaml",
        available: ["team-rules"],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a Profile reference to a missing Skill names file, invalid value, and available names", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      writeFileSync(
        join(workspace, "profiles", "broken.yaml"),
        "id: broken\ncontext: []\nskills:\n  - no-such-skill\n",
      );
      expect(await ingestionFact(workspace)).toEqual({
        kind: "missing-skill-reference",
        profile: "broken",
        skillId: "no-such-skill",
        file: "profiles/broken.yaml",
        available: ["deploy"],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a Context Module dependency to a missing artifact names the declaring file", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      writeFileSync(
        join(workspace, "context", "team-rules.md"),
        "---\nid: team-rules\ndependencies:\n  - type: context\n    id: no-such-context\n---\n\n# Team rules\n",
      );
      expect(await ingestionFact(workspace)).toEqual({
        kind: "missing-dependency-reference",
        label: "Context Module",
        id: "no-such-context",
        file: "context/team-rules.md",
        available: ["team-rules"],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a Skill sidecar dependency to a missing artifact names the declaring sidecar file", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      writeFileSync(
        join(workspace, "skills", "deploy", "agent-profile-kit.yaml"),
        "dependencies:\n  - type: context\n    id: no-such-context\n",
      );
      expect(await ingestionFact(workspace)).toEqual({
        kind: "missing-dependency-reference",
        label: "Context Module",
        id: "no-such-context",
        file: "skills/deploy/agent-profile-kit.yaml",
        available: ["team-rules"],
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
