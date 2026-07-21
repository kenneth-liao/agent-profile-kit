import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectClaudeGlobalSkillOverlaps } from "../adapters/claude.js";
import { detectCodexGlobalSkillOverlaps } from "../adapters/codex.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { statusApplication } from "../installer/commands.js";
import { applyReconciliation, previewReconciliation } from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";

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

function writeGlobalSkill(
  root: string,
  skillId: string,
  body?: string,
  options: { readonly directoryName?: string } = {},
): string {
  const directoryName = options.directoryName ?? skillId;
  const packagePath = join(root, directoryName);
  mkdirSync(packagePath, { recursive: true });
  writeFileSync(
    join(packagePath, "SKILL.md"),
    body ??
      `---\nname: ${skillId}\ndescription: Global skill ${skillId}.\n---\n\n# ${skillId}\n`,
  );
  return packagePath;
}

function enableCodexHooks(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

async function workspaceWithSkill(
  home: string,
  project: string,
  hosts: readonly string[],
  skillId: string,
): Promise<void> {
  await initializeWorkspace(home);
  enableCodexHooks(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  const skillRoot = join(workspace, "skills", skillId);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: Skill ${skillId}.\n---\n\n# ${skillId}\n`,
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    `id: coding\ncontext: [team-rules]\nskills: [${skillId}]\nagents: []\nhooks: []\ntools: []\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts:\n${hosts.map((host) => `      - ${host}`).join("\n")}\n`,
  );
}

describe("Codex global Skill overlap detection", () => {
  test("blocks when a selected Artifact ID is present under ~/.agents/skills", async () => {
    const home = temporaryDirectory("apk-global-agents-");
    const globalPath = writeGlobalSkill(join(home, ".agents", "skills"), "review-pr");
    const blockers = await detectCodexGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("Codex");
    expect(blockers[0]).toContain("review-pr");
    expect(blockers[0]).toContain(globalPath);
    expect(blockers[0]).toContain(join("/tmp/demo-project", ".agents", "skills", "review-pr"));
    expect(blockers[0]).toMatch(/remove or relocate/i);
  });

  test("blocks when a selected Artifact ID is present under ~/.codex/skills", async () => {
    const home = temporaryDirectory("apk-global-codex-");
    const globalPath = writeGlobalSkill(join(home, ".codex", "skills"), "review-pr");
    const blockers = await detectCodexGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain(globalPath);
  });

  test("uses Host-visible frontmatter name rather than directory basename alone", async () => {
    const home = temporaryDirectory("apk-global-identity-");
    writeGlobalSkill(join(home, ".agents", "skills"), "review-pr", undefined, {
      directoryName: "legacy-folder",
    });
    const blockers = await detectCodexGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("review-pr");
    expect(blockers[0]).toContain("legacy-folder");
  });

  test("blocks identical-byte global packages and global symlinks into the Workspace", async () => {
    const home = temporaryDirectory("apk-global-bytes-");
    const workspaceSkill = join(home, "workspace-skill");
    mkdirSync(workspaceSkill, { recursive: true });
    const body = "---\nname: review-pr\ndescription: Same bytes.\n---\n\n# Review\n";
    writeFileSync(join(workspaceSkill, "SKILL.md"), body);
    writeGlobalSkill(join(home, ".agents", "skills"), "review-pr", body);
    mkdirSync(join(home, ".codex", "skills"), { recursive: true });
    symlinkSync(workspaceSkill, join(home, ".codex", "skills", "review-pr"));

    const blockers = await detectCodexGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers.length).toBeGreaterThanOrEqual(2);
    expect(blockers.some((message) => message.includes(join(home, ".agents", "skills", "review-pr")))).toBe(
      true,
    );
    expect(blockers.some((message) => message.includes("->") || message.includes(workspaceSkill))).toBe(
      true,
    );
  });

  test("missing roots and unrelated global Skills neither warn nor block", async () => {
    const home = temporaryDirectory("apk-global-quiet-");
    writeGlobalSkill(join(home, ".agents", "skills"), "other-skill");
    // Readable package without Host-visible name cannot collide with a selected ID.
    mkdirSync(join(home, ".codex", "skills", "junk-package"), { recursive: true });
    writeFileSync(join(home, ".codex", "skills", "junk-package", "SKILL.md"), "# no frontmatter\n");
    const blockers = await detectCodexGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers).toEqual([]);
  });

  test("unreadable global root fails closed when absence cannot be proven", async () => {
    const home = temporaryDirectory("apk-global-unreadable-");
    const root = join(home, ".agents", "skills");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o000);
    try {
      const blockers = await detectCodexGlobalSkillOverlaps(home, ["review-pr"], {
        project: "/tmp/demo-project",
      });
      expect(blockers.length).toBeGreaterThanOrEqual(1);
      expect(blockers[0]).toContain(root);
      expect(blockers[0]).toMatch(/cannot be inspected|prove absence/i);
    } finally {
      chmodSync(root, 0o755);
    }
  });
});

describe("Claude personal Skill overlap detection", () => {
  test("blocks when a selected Artifact ID exists under ~/.claude/skills", async () => {
    const home = temporaryDirectory("apk-claude-global-");
    const globalPath = writeGlobalSkill(join(home, ".claude", "skills"), "review-pr");
    const blockers = await detectClaudeGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("Claude");
    expect(blockers[0]).toContain("review-pr");
    expect(blockers[0]).toContain(globalPath);
    expect(blockers[0]).toContain(join("/tmp/demo-project", ".claude", "skills", "review-pr"));
  });

  test("directory without SKILL.md is not a Host-visible Skill identity", async () => {
    const home = temporaryDirectory("apk-claude-not-skill-");
    mkdirSync(join(home, ".claude", "skills", "review-pr"), { recursive: true });
    const blockers = await detectClaudeGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers).toEqual([]);
  });

  test("missing personal root and unrelated Skills are quiet", async () => {
    const home = temporaryDirectory("apk-claude-quiet-");
    writeGlobalSkill(join(home, ".claude", "skills"), "other-skill");
    const blockers = await detectClaudeGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers).toEqual([]);
  });

  test("unreadable personal root fails closed when absence cannot be proven", async () => {
    const home = temporaryDirectory("apk-claude-unreadable-");
    const root = join(home, ".claude", "skills");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o000);
    try {
      const blockers = await detectClaudeGlobalSkillOverlaps(home, ["review-pr"], {
        project: "/tmp/demo-project",
      });
      expect(blockers.length).toBeGreaterThanOrEqual(1);
      expect(blockers[0]).toContain(root);
      expect(blockers[0]).toMatch(/cannot be inspected|prove absence/i);
    } finally {
      chmodSync(root, 0o755);
    }
  });

  test("global symlink into the Workspace still blocks", async () => {
    const home = temporaryDirectory("apk-claude-symlink-");
    const workspaceSkill = join(home, "workspace-skill");
    mkdirSync(workspaceSkill, { recursive: true });
    writeFileSync(
      join(workspaceSkill, "SKILL.md"),
      "---\nname: review-pr\ndescription: Linked.\n---\n\n# Review\n",
    );
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    symlinkSync(workspaceSkill, join(home, ".claude", "skills", "review-pr"));
    const blockers = await detectClaudeGlobalSkillOverlaps(home, ["review-pr"], {
      project: "/tmp/demo-project",
    });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain("review-pr");
  });
});

describe("global Skill overlap desired-state preflight", () => {
  test("preview reports overlaps and apply writes nothing", async () => {
    const home = temporaryDirectory("apk-global-preflight-");
    const project = temporaryDirectory("apk-global-project-");
    await workspaceWithSkill(home, project, ["codex"], "review-pr");
    const globalPath = writeGlobalSkill(join(home, ".agents", "skills"), "review-pr");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const preview = await previewReconciliation(desired.installations, {
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 3,
    });
    expect(preview.blockers.length).toBeGreaterThanOrEqual(1);
    expect(preview.blockers.some((blocker) => blocker.message.includes(globalPath))).toBe(true);
    expect(preview.blockers.some((blocker) => blocker.message.includes("review-pr"))).toBe(true);

    await expect(applyReconciliation(home, desired.installations)).rejects.toThrow(/Apply blocked/);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(globalPath)).toBe(true);
    expect(readFileSync(join(globalPath, "SKILL.md"), "utf8")).toContain("name: review-pr");
  });

  test("unselected Hosts and unselected Skills are not inspected as conflicts", async () => {
    const home = temporaryDirectory("apk-global-unselected-");
    const project = temporaryDirectory("apk-global-unselected-project-");
    await workspaceWithSkill(home, project, ["codex"], "review-pr");
    // Claude personal Skill with same ID — Host not selected, so not a conflict.
    writeGlobalSkill(join(home, ".claude", "skills"), "review-pr");
    // Unselected Workspace Skill also present globally under Codex.
    writeGlobalSkill(join(home, ".agents", "skills"), "other-skill");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.blockers ?? []).toEqual([]);
  });

  test("status reports an installation as blocked when global overlap appears later", async () => {
    const home = temporaryDirectory("apk-global-status-");
    const project = temporaryDirectory("apk-global-status-project-");
    await workspaceWithSkill(home, project, ["codex", "claude"], "review-pr");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "review-pr"))).toBe(true);

    writeGlobalSkill(join(home, ".agents", "skills"), "review-pr");
    writeGlobalSkill(join(home, ".claude", "skills"), "review-pr");

    const status = await statusApplication(home);
    expect(status.blockers.length).toBeGreaterThanOrEqual(2);
    expect(status.items.some((item) => item.project === project && item.kind === "blocked")).toBe(
      true,
    );
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(true);
    expect(existsSync(join(home, ".agents", "skills", "review-pr"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "review-pr"))).toBe(true);
  });

  test("Claude-only binding blocks personal Skill overlap before writes", async () => {
    const home = temporaryDirectory("apk-claude-preflight-");
    const project = temporaryDirectory("apk-claude-preflight-project-");
    await workspaceWithSkill(home, project, ["claude"], "review-pr");
    writeGlobalSkill(join(home, ".claude", "skills"), "review-pr");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const preview = await previewReconciliation(desired.installations, {
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 3,
    });
    expect(preview.blockers.some((blocker) => blocker.message.includes("Claude"))).toBe(true);
    await expect(applyReconciliation(home, desired.installations)).rejects.toThrow(/Apply blocked/);
    expect(existsSync(join(project, ".claude", "skills", "review-pr"))).toBe(false);
  });
});
