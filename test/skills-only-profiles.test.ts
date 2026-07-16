import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertClaudeProjectCapability,
  planClaudeProject,
} from "../adapters/claude.js";
import {
  assertCodexProjectCapability,
  planCodexProject,
} from "../adapters/codex.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { ingestDefaultWorkspace } from "../installer/ingest-workspace.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { readInstallationState } from "../installer/installation-state.js";
import type { Skill } from "../schemas/skill.js";
import { workspacePath } from "../installer/workspace.js";

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

function skill(id: string, path: string): Skill {
  return { dependencies: [], id, modelInvocation: "allowed", path };
}

function writeSkill(workspace: string, id: string): void {
  const skillRoot = join(workspace, "skills", id);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${id}\ndescription: Skill ${id}.\n---\n\n# ${id}\n`,
  );
}

async function skillsOnlyWorkspace(
  home: string,
  project: string,
  hosts: readonly string[],
  options: { readonly includeContext?: boolean } = {},
): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeSkill(workspace, "review-pr");
  if (options.includeContext) {
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
  }
  const contextList = options.includeContext ? "[team-rules]" : "[]";
  writeFileSync(
    join(workspace, "profiles", "engineering.yaml"),
    `id: engineering\ncontext: ${contextList}\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 1\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

describe("Skills-only Profiles", () => {
  test("a Skills-only Profile validates when it selects at least one resolvable Skill", async () => {
    const home = temporaryDirectory("apk-skills-only-ingest-");
    await initializeWorkspace(home);
    const workspace = workspacePath(home);
    writeSkill(workspace, "review-pr");
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );

    const ingested = await ingestDefaultWorkspace(home);

    expect(ingested.profiles.get("engineering")?.context).toEqual([]);
    expect(ingested.profiles.get("engineering")?.skills).toEqual(["review-pr"]);
  });

  test("a Profile selecting neither Context nor Skills fails at ingestion as empty", async () => {
    const home = temporaryDirectory("apk-empty-profile-");
    await initializeWorkspace(home);
    const workspace = workspacePath(home);
    writeFileSync(
      join(workspace, "profiles", "empty.yaml"),
      "id: empty\ncontext: []\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );

    await expect(ingestDefaultWorkspace(home)).rejects.toThrow(
      /Profile 'empty' must select at least one supported artifact/i,
    );
  });

  test("Codex Skills-only plans Skill packages without Context snapshot or hooks.json", async () => {
    const source = temporaryDirectory("apk-skills-only-codex-src-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );

    const plan = await planCodexProject("engineering", [], [skill("review-pr", source)]);

    expect(plan.outputs.map((output) => output.path).sort()).toEqual([
      ".agents/skills/review-pr",
    ]);
    expect(plan.outputs.some((output) => output.path === ".agent-profile-kit/codex/context.md")).toBe(
      false,
    );
    expect(plan.outputs.some((output) => output.path === ".codex/hooks.json")).toBe(false);
  });

  test("Claude Skills-only plans Skill packages without the unscoped Context rule", async () => {
    const source = temporaryDirectory("apk-skills-only-claude-src-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );

    const plan = await planClaudeProject("engineering", [], [skill("review-pr", source)]);

    expect(plan.outputs.map((output) => output.path).sort()).toEqual([
      ".claude/skills/review-pr",
    ]);
    expect(
      plan.outputs.some((output) => output.path === ".claude/rules/agent-profile-kit.md"),
    ).toBe(false);
  });

  test("Skills-only Codex does not require SessionStart hooks", async () => {
    const home = temporaryDirectory("apk-skills-only-codex-cap-");
    const project = temporaryDirectory("apk-skills-only-codex-project-");
    // No hooks enabled in config.

    await expect(
      assertCodexProjectCapability(home, project, { requireContext: false }),
    ).resolves.toBeUndefined();

    await expect(assertCodexProjectCapability(home, project)).rejects.toThrow(
      /SessionStart hooks are not enabled/i,
    );
  });

  test("Skills-only Claude validates .claude root but not the unscoped-rule surface", async () => {
    // Skills-only still needs a usable .claude root for .claude/skills/.
    const occupiedRoot = temporaryDirectory("apk-skills-only-claude-root-");
    writeFileSync(join(occupiedRoot, ".claude"), "not a directory\n");
    await expect(
      assertClaudeProjectCapability(occupiedRoot, {
        requireContext: false,
        resolveVersion: async () => "2.0.64",
      }),
    ).rejects.toThrow(/is a file, not a directory/i);

    // Occupied rules path only blocks when Context machinery is required.
    const rulesOccupied = temporaryDirectory("apk-skills-only-claude-rules-");
    mkdirSync(join(rulesOccupied, ".claude"));
    writeFileSync(join(rulesOccupied, ".claude", "rules"), "not a directory\n");
    await expect(
      assertClaudeProjectCapability(rulesOccupied, {
        requireContext: false,
        resolveVersion: async () => "2.0.64",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertClaudeProjectCapability(rulesOccupied, {
        resolveVersion: async () => "2.0.64",
      }),
    ).rejects.toThrow(/is a file, not a directory/i);

    // Skills-only still enforces the native Skill CLI floor.
    await expect(
      assertClaudeProjectCapability(rulesOccupied, {
        requireContext: false,
        resolveVersion: async () => "2.0.63",
      }),
    ).rejects.toThrow(/native project Skills/i);
  });

  test("Skills-only Codex binding applies Skill packages and reports empty Context without inventing Context output", async () => {
    const home = temporaryDirectory("apk-skills-only-codex-life-");
    const project = temporaryDirectory("apk-skills-only-codex-proj-");
    await skillsOnlyWorkspace(home, project, ["codex"]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected installation");

    expect(installation.profile.context).toEqual([]);
    expect(installation.resolvedProfile.contexts).toEqual([]);
    expect(installation.outputs.map((output) => output.path).sort()).toEqual([
      ".agents/skills/review-pr",
    ]);
    expect(installation.warnings.some((warning) => /Context discovery/i.test(warning))).toBe(
      false,
    );

    const applied = await applyReconciliation(home, desired.installations);
    expect(applied.blockers).toEqual([]);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);

    const state = await readInstallationState(home);
    const manifest = state.installations[0];
    if (!manifest) throw new Error("expected installation manifest");
    expect(
      manifest.outputs
        .map((entry) => entry.path)
        .filter((path) => path !== ".agent-profile-kit/installation.json")
        .sort(),
    ).toEqual([".agents/skills/review-pr"]);
    expect(manifest.selectedContext).toEqual([]);

    const status = await previewReconciliation(desired.installations, state);
    expect(status.items.some((item) => item.kind === "current")).toBe(true);
    expect(status.blockers).toEqual([]);
  });

  test("Skills-only Claude binding applies Skill packages without Context rule output", async () => {
    const home = temporaryDirectory("apk-skills-only-claude-life-");
    const project = temporaryDirectory("apk-skills-only-claude-proj-");
    await skillsOnlyWorkspace(home, project, ["claude"]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected installation");
    expect(installation.outputs.map((output) => output.path).sort()).toEqual([
      ".claude/skills/review-pr",
    ]);

    const applied = await applyReconciliation(home, desired.installations);
    expect(applied.blockers).toEqual([]);
    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
  });

  test("combined Host Skills-only binding installs both Skill trees without Context output", async () => {
    const home = temporaryDirectory("apk-skills-only-combined-");
    const project = temporaryDirectory("apk-skills-only-combined-proj-");
    await skillsOnlyWorkspace(home, project, ["claude", "codex"]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected installation");
    expect(installation.outputs.map((output) => output.path).sort()).toEqual([
      ".agents/skills/review-pr",
      ".claude/skills/review-pr",
    ]);

    const applied = await applyReconciliation(home, desired.installations);
    expect(applied.blockers).toEqual([]);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
  });

  test("Context-only Profiles continue to plan Context machinery", async () => {
    const plan = await planCodexProject(
      "coding",
      [{ id: "team-rules", content: "rules\n" }],
      [],
    );
    expect(plan.outputs.some((output) => output.path === ".agent-profile-kit/codex/context.md")).toBe(
      true,
    );
    expect(plan.outputs.some((output) => output.path === ".codex/hooks.json")).toBe(true);

    const claude = await planClaudeProject(
      "coding",
      [{ id: "team-rules", content: "rules\n" }],
      [],
    );
    expect(
      claude.outputs.some((output) => output.path === ".claude/rules/agent-profile-kit.md"),
    ).toBe(true);
  });

  test("combined Context-and-Skills Profiles retain Context envelope and Skill packages", async () => {
    const home = temporaryDirectory("apk-combined-profile-");
    const project = temporaryDirectory("apk-combined-proj-");
    await skillsOnlyWorkspace(home, project, ["codex"], { includeContext: true });
    // Enable hooks so capability path is not the subject of this test.
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected installation");
    const paths = installation.outputs.map((output) => output.path).sort();
    expect(paths).toContain(".agent-profile-kit/codex/context.md");
    expect(paths).toContain(".codex/hooks.json");
    expect(paths).toContain(".agents/skills/review-pr");

    const context = installation.outputs.find(
      (output) => output.path === ".agent-profile-kit/codex/context.md",
    );
    expect(context?.type).toBe("file");
    if (context?.type === "file") {
      expect(String(context.bytes)).toContain("<!-- Context Module: team-rules -->");
    }
  });

  test("Context+Skills dual-Host install drops owned Context outputs when the Profile becomes Skills-only", async () => {
    const home = temporaryDirectory("apk-skills-only-transition-");
    const project = temporaryDirectory("apk-skills-only-transition-proj-");
    await skillsOnlyWorkspace(home, project, ["claude", "codex"], { includeContext: true });
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    let desired = await buildDesiredState(home, { checkHostCapability: false });
    let applied = await applyReconciliation(home, desired.installations);
    expect(applied.blockers).toEqual([]);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(project, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);

    // Drop Context from the same Profile; Skills remain selected.
    writeFileSync(
      join(workspacePath(home), "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );

    desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected installation");
    expect(installation.outputs.map((output) => output.path).sort()).toEqual([
      ".agents/skills/review-pr",
      ".claude/skills/review-pr",
    ]);
    expect(installation.profile.context).toEqual([]);

    const preview = await previewReconciliation(
      desired.installations,
      await readInstallationState(home),
    );
    expect(
      preview.outputs.some(
        (item) =>
          item.path === ".agent-profile-kit/codex/context.md" && item.kind === "removal",
      ),
    ).toBe(true);
    expect(
      preview.outputs.some(
        (item) => item.path === ".codex/hooks.json" && item.kind === "removal",
      ),
    ).toBe(true);
    expect(
      preview.outputs.some(
        (item) =>
          item.path === ".claude/rules/agent-profile-kit.md" && item.kind === "removal",
      ),
    ).toBe(true);

    applied = await applyReconciliation(home, desired.installations);
    expect(applied.blockers).toEqual([]);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(project, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);

    const manifest = (await readInstallationState(home)).installations[0];
    if (!manifest) throw new Error("expected installation manifest");
    expect(manifest.selectedContext).toEqual([]);
    expect(
      manifest.outputs
        .map((entry) => entry.path)
        .filter((path) => path !== ".agent-profile-kit/installation.json")
        .sort(),
    ).toEqual([".agents/skills/review-pr", ".claude/skills/review-pr"]);
  });

  test("Skills-only installations support source Skill updates and uninstall", async () => {
    const home = temporaryDirectory("apk-skills-only-update-");
    const project = temporaryDirectory("apk-skills-only-update-proj-");
    await skillsOnlyWorkspace(home, project, ["codex"]);

    let desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);

    const skillPath = join(
      workspacePath(home),
      "skills",
      "review-pr",
      "SKILL.md",
    );
    writeFileSync(
      skillPath,
      "---\nname: review-pr\ndescription: Updated review skill.\n---\n\n# Updated\n",
    );

    desired = await buildDesiredState(home, { checkHostCapability: false });
    const state = await readInstallationState(home);
    const preview = await previewReconciliation(desired.installations, state);
    expect(preview.items.some((item) => item.kind === "stale source")).toBe(true);
    expect(
      preview.outputs.some(
        (item) => item.path === ".agents/skills/review-pr" && item.kind === "update",
      ),
    ).toBe(true);

    await applyReconciliation(home, desired.installations);
    expect(readFileSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "Updated review skill",
    );

    // Binding removal: empty bindings and reconcile to uninstall.
    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "config.yaml"),
      "schema_version: 1\nbindings: []\n",
    );
    desired = await buildDesiredState(home, { checkHostCapability: false });
    const afterRemoval = await applyReconciliation(home, desired.installations);
    expect(afterRemoval.blockers).toEqual([]);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
  });
});
