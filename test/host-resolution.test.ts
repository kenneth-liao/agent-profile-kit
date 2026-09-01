import { afterAll, describe, expect, test } from "bun:test";
import { OWNERSHIP_STATE_SCHEMA_VERSION } from "../schemas/ownership-state.js";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { statusApplication } from "../installer/commands.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { applyReconciliation, previewReconciliation } from "../installer/reconcile.js";
import {
  reportBlockers,
  reportItems,
  reportWarnings,
} from "./support/reconciliation-report.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function hostCapabilityEnv(): NodeJS.ProcessEnv {
  const bin = temporaryDirectory("apk-host-resolution-bin-");
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.145.0'\n");
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
  chmodSync(join(bin, "codex"), 0o755);
  chmodSync(join(bin, "claude"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

function writeSkill(root: string, skillId: string): string {
  const packagePath = join(root, skillId);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: ${skillId} Skill.\n---\n\n# ${skillId}\n`,
  );
  return packagePath;
}

async function workspaceWithSkill(
  home: string,
  project: string,
  hosts: readonly string[],
): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeSkill(join(workspace, "skills"), "review-pr");
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext: []\nskills: [review-pr]\n",
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

describe("Host Resolution", () => {
  test("preview and apply allow Codex and Claude same-identity personal Skills", async () => {
    const home = temporaryDirectory("apk-host-resolution-home-");
    const project = temporaryDirectory("apk-host-resolution-project-");
    await workspaceWithSkill(home, project, ["codex", "claude"]);
    const codexGlobal = writeSkill(join(home, ".agents", "skills"), "review-pr");
    const claudeGlobal = writeSkill(join(home, ".claude", "skills"), "review-pr");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const preview = await previewReconciliation(desired.installations, {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
    });
    expect(reportBlockers(preview)).toEqual([]);
    expect(reportWarnings(preview)).toEqual([]);

    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(codexGlobal, "SKILL.md"), "utf8")).toContain("name: review-pr");
    expect(readFileSync(join(claudeGlobal, "SKILL.md"), "utf8")).toContain("name: review-pr");
  });

  test("status stays current when same-identity Host material appears later", async () => {
    const home = temporaryDirectory("apk-host-resolution-status-home-");
    const project = temporaryDirectory("apk-host-resolution-status-project-");
    await workspaceWithSkill(home, project, ["codex", "claude"]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);

    writeSkill(join(home, ".codex", "skills"), "review-pr");
    writeSkill(join(home, ".claude", "skills"), "review-pr");

    const status = await statusApplication(home, { env: hostCapabilityEnv() });
    expect(reportBlockers(status)).toEqual([]);
    expect(reportWarnings(status)).toEqual([]);
    expect(reportItems(status).some((item) => item.project === project && item.kind === "current")).toBe(
      true,
    );
  });
});
