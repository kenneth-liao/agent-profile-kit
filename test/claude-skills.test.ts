import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_CONTEXT_RULE_PATH,
  CLAUDE_SKILLS_DISCOVERY_ROOT,
  planClaudeProject,
} from "../adapters/claude.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { readInstallationState } from "../installer/installation-state.js";
import { uninstallApplication } from "../installer/commands.js";
import type { Skill } from "../schemas/skill.js";

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

function writeSkillPackage(
  root: string,
  files: Readonly<Record<string, { readonly bytes: string; readonly mode?: number }>>,
): void {
  for (const [relativePath, entry] of Object.entries(files)) {
    const path = join(root, relativePath);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, entry.bytes, { mode: entry.mode ?? 0o644 });
    if (entry.mode !== undefined) chmodSync(path, entry.mode);
  }
}

function skill(id: string, path: string): Skill {
  return { dependencies: [], id, modelInvocation: "allowed", path };
}

function enableCodexHooks(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

async function workspaceWithSkills(
  home: string,
  project: string,
  hosts: readonly string[],
  skills: ReadonlyArray<{
    readonly id: string;
    readonly body?: string;
    readonly dependencies?: readonly string[];
    readonly path?: string;
    readonly scriptMode?: number;
  }>,
  selectedSkills: readonly string[],
): Promise<void> {
  await initializeWorkspace(home);
  enableCodexHooks(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  for (const entry of skills) {
    const relative = entry.path ?? entry.id;
    const skillRoot = join(workspace, "skills", relative);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      entry.body ??
        `---\nname: ${entry.id}\ndescription: Skill ${entry.id}.\n---\n\n# ${entry.id}\n`,
    );
    if (entry.scriptMode !== undefined) {
      const script = join(skillRoot, "scripts", "run.sh");
      mkdirSync(join(skillRoot, "scripts"), { recursive: true });
      writeFileSync(script, `#!/bin/sh\necho ${entry.id}\n`);
      chmodSync(script, entry.scriptMode);
    }
    if (entry.dependencies) {
      writeFileSync(
        join(skillRoot, "agent-profile-kit.yaml"),
        `dependencies:\n${entry.dependencies.map((id) => `  - type: skill\n    id: ${id}\n`).join("")}`,
      );
    }
  }
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    `id: coding\ncontext: [team-rules]\nskills: [${selectedSkills.join(", ")}]\nagents: []\nhooks: []\ntools: []\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

describe("Claude project Skill packages", () => {
  test("plans each resolved Skill under .claude/skills/<Artifact ID> with bytes and modes preserved and sidecars omitted", async () => {
    const source = temporaryDirectory("apk-claude-skill-source-");
    writeSkillPackage(source, {
      "SKILL.md": {
        bytes: "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
        mode: 0o644,
      },
      "scripts/run.sh": {
        bytes: "#!/bin/sh\necho review\n",
        mode: 0o755,
      },
      "agent-profile-kit.yaml": {
        bytes: "dependencies: []\n",
        mode: 0o644,
      },
    });
    const binaryAsset = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x41]);
    mkdirSync(join(source, "assets"), { recursive: true });
    writeFileSync(join(source, "assets", "glyph.bin"), binaryAsset);

    const plan = await planClaudeProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skill("review-pr", source),
    ]);

    // Pin the public Capability Contract string recorded for Claude Skills + rules.
    expect(plan.hostVersion).toBe("native-project-unscoped-rules-skills-v1");
    expect(plan.outputs.some((output) => output.path === CLAUDE_CONTEXT_RULE_PATH)).toBe(true);
    const packageOutput = plan.outputs.find(
      (output) =>
        output.type === "directory" &&
        output.path === `${CLAUDE_SKILLS_DISCOVERY_ROOT}/review-pr`,
    );
    expect(packageOutput).toBeDefined();
    if (!packageOutput || packageOutput.type !== "directory") {
      throw new Error("expected Skill package directory output");
    }
    const skillMd = packageOutput.members.find((member) => member.path === "SKILL.md");
    const script = packageOutput.members.find((member) => member.path === "scripts/run.sh");
    const asset = packageOutput.members.find((member) => member.path === "assets/glyph.bin");
    expect(skillMd).toMatchObject({ mode: 0o644, path: "SKILL.md", type: "file" });
    expect(Buffer.from((skillMd as { bytes: string | Uint8Array }).bytes).toString("utf8")).toBe(
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    expect(script).toMatchObject({ mode: 0o755, path: "scripts/run.sh", type: "file" });
    expect(packageOutput.members.some((member) => member.path === "scripts" && member.type === "directory"))
      .toBe(true);
    expect(asset?.type).toBe("file");
    expect(Buffer.from((asset as { bytes: Uint8Array }).bytes)).toEqual(binaryAsset);
    expect(packageOutput.members.some((member) => member.path === "agent-profile-kit.yaml")).toBe(
      false,
    );
  });

  test("resolves direct and transitive Skills once, installs by Artifact ID, and omits unselected Skills", async () => {
    const home = temporaryDirectory("apk-claude-skill-home-");
    const project = temporaryDirectory("apk-claude-skill-project-");
    await workspaceWithSkills(
      home,
      project,
      ["claude"],
      [
        { id: "shared-base", path: "library/shared-base" },
        {
          id: "left-skill",
          path: "group/left-skill",
          dependencies: ["shared-base"],
        },
        {
          id: "right-skill",
          path: "group/right-skill",
          dependencies: ["shared-base"],
        },
        {
          id: "top-skill",
          path: "group/top-skill",
          dependencies: ["left-skill", "right-skill"],
          scriptMode: 0o755,
        },
        { id: "unselected-skill", path: "other/unselected-skill" },
      ],
      ["top-skill"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected installation");
    const skillPaths = installation.outputs
      .filter((output) => output.type === "directory")
      .map((output) => output.path)
      .sort();
    expect(skillPaths).toEqual([
      ".claude/skills/left-skill",
      ".claude/skills/right-skill",
      ".claude/skills/shared-base",
      ".claude/skills/top-skill",
    ]);

    const sharedResolved = installation.resolvedProfile.artifacts.find(
      (artifact) => artifact.reference.id === "shared-base",
    );
    expect(sharedResolved?.inclusionReasons.length).toBeGreaterThanOrEqual(2);

    const preview = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 2,
    });
    expect(preview.items.some((item) => item.kind === "addition")).toBe(true);
    expect(
      preview.outputs.some((item) =>
        item.kind === "addition" && item.path === ".claude/skills/top-skill"
      ),
    ).toBe(true);
    expect(preview.desired[0]?.resolvedArtifacts.some((artifact) => artifact.id === "top-skill")).toBe(
      true,
    );
    const sharedReasons = preview.desired[0]?.resolvedArtifacts.find(
      (artifact) => artifact.id === "shared-base",
    )?.inclusionReasons ?? [];
    expect(sharedReasons.length).toBeGreaterThanOrEqual(2);
    // Preview formats each path step as "type:id" already.
    const reasonPaths = sharedReasons.map((reason) => reason.path.join(" -> "));
    expect(reasonPaths.some((path) => path.includes("skill:left-skill"))).toBe(true);
    expect(reasonPaths.some((path) => path.includes("skill:right-skill"))).toBe(true);

    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, ".claude", "skills", "top-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "shared-base", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "unselected-skill"))).toBe(false);
    expect(existsSync(join(project, ".claude", "skills", "top-skill", "agent-profile-kit.yaml"))).toBe(
      false,
    );
    expect(statSync(join(project, ".claude", "skills", "top-skill", "scripts", "run.sh")).mode & 0o777)
      .toBe(0o755);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);

    const state = await readInstallationState(home);
    const manifest = state.installations[0];
    expect(manifest?.hostVersions.claude).toBe("native-project-unscoped-rules-skills-v1");
    expect(manifest?.resolvedArtifacts.map((artifact) => artifact.reference.id).sort()).toEqual([
      "left-skill",
      "right-skill",
      "shared-base",
      "team-rules",
      "top-skill",
    ]);
    const shared = manifest?.resolvedArtifacts.find(
      (artifact) => artifact.reference.id === "shared-base",
    );
    expect(shared?.inclusionReasons.length).toBeGreaterThanOrEqual(2);
  });

  test("reorganizing a Skill Workspace path without changing Artifact ID keeps installed identity", async () => {
    const home = temporaryDirectory("apk-claude-skill-relocate-home-");
    const project = temporaryDirectory("apk-claude-skill-relocate-project-");
    await workspaceWithSkills(
      home,
      project,
      ["claude"],
      [{ id: "review-pr", path: "engineering/review-pr" }],
      ["review-pr"],
    );
    const first = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, first.installations);

    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    mkdirSync(join(workspace, "skills", "moved", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "moved", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Skill review-pr.\n---\n\n# review-pr\n",
    );
    rmSync(join(workspace, "skills", "engineering"), { recursive: true, force: true });

    const second = await buildDesiredState(home, { checkHostCapability: false });
    const skillOutput = second.installations[0]?.outputs.find(
      (output) => output.path === ".claude/skills/review-pr",
    );
    expect(skillOutput?.type).toBe("directory");
    const preview = await previewReconciliation(second.installations, await readInstallationState(home));
    expect(
      preview.outputs.find((item) => item.path === ".claude/skills/review-pr")?.kind,
    ).toBe("unchanged");
  });

  test("unowned colliding Host-visible Skill package blocks preflight without adopting it", async () => {
    const home = temporaryDirectory("apk-claude-skill-collision-home-");
    const project = temporaryDirectory("apk-claude-skill-collision-project-");
    await workspaceWithSkills(home, project, ["claude"], [{ id: "review-pr" }], ["review-pr"]);
    mkdirSync(join(project, ".claude", "skills", "review-pr"), { recursive: true });
    writeFileSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"), "foreign skill\n");
    mkdirSync(join(project, ".claude", "skills", "other-user-skill"), { recursive: true });
    writeFileSync(join(project, ".claude", "skills", "other-user-skill", "SKILL.md"), "keep me\n");
    writeFileSync(join(project, "CLAUDE.md"), "project-owned\n");
    mkdirSync(join(project, ".claude", "rules"), { recursive: true });
    writeFileSync(join(project, ".claude", "rules", "team.md"), "existing team rule\n");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const preview = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 2,
    });
    expect(preview.blockers.some((blocker) =>
      blocker.message.includes(".claude/skills/review-pr") &&
      blocker.message.toLowerCase().includes("unowned")
    )).toBe(true);
    expect(readFileSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"), "utf8")).toBe(
      "foreign skill\n",
    );
    expect(existsSync(join(project, ".claude", "skills", "other-user-skill", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, ".claude", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
  });

  test("Context and Skills share one installation lifecycle; deselection removes only proven packages", async () => {
    const home = temporaryDirectory("apk-claude-skill-lifecycle-home-");
    const project = temporaryDirectory("apk-claude-skill-lifecycle-project-");
    writeFileSync(join(project, "CLAUDE.md"), "project-owned instructions\n");
    mkdirSync(join(project, ".claude", "rules"), { recursive: true });
    writeFileSync(join(project, ".claude", "rules", "team.md"), "existing team rule\n");
    mkdirSync(join(project, ".claude", "skills", "foreign-skill"), { recursive: true });
    writeFileSync(join(project, ".claude", "skills", "foreign-skill", "SKILL.md"), "leave me\n");
    await workspaceWithSkills(
      home,
      project,
      ["claude"],
      [
        { id: "review-pr" },
        { id: "write-notes" },
      ],
      ["review-pr", "write-notes"],
    );
    const first = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, first.installations);
    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "write-notes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);
    expect(readFileSync(join(project, ".claude", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );
    expect(readFileSync(join(project, ".claude", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );

    const current = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(current.items.some((item) => item.kind === "current")).toBe(true);

    rmSync(join(project, ".claude", "skills", "write-notes"), { recursive: true, force: true });
    const missing = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(missing.items.some((item) => item.kind === "missing output")).toBe(true);
    expect(missing.outputs.some((item) =>
      item.path === ".claude/skills/write-notes" ||
      item.path.startsWith(".claude/skills/write-notes/")
    )).toBe(true);
    mkdirSync(join(project, ".claude", "skills", "write-notes"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "skills", "write-notes", "SKILL.md"),
      "---\nname: write-notes\ndescription: Skill write-notes.\n---\n\n# write-notes\n",
    );

    writeFileSync(
      join(project, ".claude", "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Skill review-pr.\n---\n\n# drifted\n",
    );
    const drifted = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(drifted.items.some((item) => item.kind === "drifted output")).toBe(true);
    writeFileSync(
      join(project, ".claude", "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Skill review-pr.\n---\n\n# review-pr\n",
    );

    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "workspace", "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Skill review-pr.\n---\n\n# updated source\n",
    );
    const stale = await buildDesiredState(home, { checkHostCapability: false });
    const stalePreview = await previewReconciliation(
      stale.installations,
      await readInstallationState(home),
    );
    expect(stalePreview.items.some((item) => item.kind === "stale source")).toBe(true);
    await applyReconciliation(home, stale.installations);
    expect(readFileSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "updated source",
    );

    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "workspace", "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [write-notes]\nagents: []\nhooks: []\ntools: []\n",
    );
    const deselected = await buildDesiredState(home, { checkHostCapability: false });
    const deselectPreview = await previewReconciliation(
      deselected.installations,
      await readInstallationState(home),
    );
    expect(deselectPreview.outputs.some((item) =>
      item.kind === "removal" &&
      (item.path === ".claude/skills/review-pr" || item.path.startsWith(".claude/skills/review-pr/"))
    )).toBe(true);
    await applyReconciliation(home, deselected.installations);
    expect(existsSync(join(project, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".claude", "skills", "write-notes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);
    expect(readFileSync(join(project, ".claude", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );

    expect(await uninstallApplication(home)).toBe(1);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".claude", "skills", "write-notes"))).toBe(false);
    expect(readFileSync(join(project, ".claude", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned instructions\n");
    expect(readFileSync(join(project, ".claude", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
  });

  test("combined Codex/Claude Hosts install Host-native Skill trees in one Manifest transaction", async () => {
    const home = temporaryDirectory("apk-claude-skill-combined-home-");
    const project = temporaryDirectory("apk-claude-skill-combined-project-");
    writeFileSync(join(project, "CLAUDE.md"), "project-owned\n");
    writeFileSync(join(project, "AGENTS.md"), "repository-owned\n");
    await workspaceWithSkills(
      home,
      project,
      ["codex", "claude"],
      [
        { id: "base-skill" },
        { id: "review-pr", dependencies: ["base-skill"], scriptMode: 0o755 },
      ],
      ["review-pr"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected installation");
    expect(installation.binding.hosts).toEqual(["claude", "codex"]);
    const skillPaths = installation.outputs
      .filter((output) => output.type === "directory")
      .map((output) => output.path)
      .sort();
    expect(skillPaths).toEqual([
      ".agents/skills/base-skill",
      ".agents/skills/review-pr",
      ".claude/skills/base-skill",
      ".claude/skills/review-pr",
    ]);
    expect(installation.outputs.some((output) => output.path === CLAUDE_CONTEXT_RULE_PATH)).toBe(true);
    expect(installation.outputs.some((output) => output.path === ".codex/hooks.json")).toBe(true);

    const preview = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 2,
    });
    expect(preview.blockers).toEqual([]);
    await applyReconciliation(home, desired.installations);

    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "base-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "base-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);

    const state = await readInstallationState(home);
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.hosts).toEqual(["claude", "codex"]);
    expect(state.installations[0]?.resolvedArtifacts.map((a) => a.reference.id).sort()).toEqual([
      "base-skill",
      "review-pr",
      "team-rules",
    ]);

    expect(await uninstallApplication(home)).toBe(1);
    expect(existsSync(join(project, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
  });
});
