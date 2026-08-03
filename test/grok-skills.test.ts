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
  CLAUDE_HOST_VERSION,
} from "../adapters/claude.js";
import { CODEX_HOST_VERSION } from "../adapters/codex.js";
import {
  assertGrokCliVersionSupported,
  assertGrokProjectCapability,
  emitGrokSkillMarkdown,
  GROK_CONTEXT_RULE_PATH,
  GROK_HOST_VERSION,
  GROK_HOST_VERSION_WITH_INVOCATION,
  GROK_HOST_VERSION_WITH_SKILLS,
  GROK_MINIMUM_CLI_VERSION,
  GROK_SKILLS_DISCOVERY_ROOT,
  parseGrokSkillsConfigSection,
  planGrokProject,
} from "../adapters/grok.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { readInstallationState } from "../installer/installation-state.js";
import { statusApplication, uninstallApplication } from "../installer/commands.js";
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

function skill(id: string, path: string, modelInvocation: Skill["modelInvocation"] = "allowed"): Skill {
  return { dependencies: [], id, modelInvocation, path };
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
  options: { readonly context?: boolean } = {},
): Promise<void> {
  await initializeWorkspace(home);
  enableCodexHooks(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  const includeContext = options.context !== false;
  if (includeContext) {
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
  }
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
    `id: coding\ncontext: ${includeContext ? "[team-rules]" : "[]"}\nskills: [${selectedSkills.join(", ")}]\nagents: []\nhooks: []\ntools: []\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

describe("Grok project Skill packages", () => {
  test("plans each resolved Skill under .grok/skills/<Artifact ID> with bytes and modes preserved and sidecars omitted", async () => {
    const source = temporaryDirectory("apk-grok-skill-source-");
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

    const plan = await planGrokProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skill("review-pr", source),
    ]);

    expect(plan.hostVersion).toBe(GROK_HOST_VERSION_WITH_SKILLS);
    expect(plan.outputs.some((output) => output.path === GROK_CONTEXT_RULE_PATH)).toBe(true);
    const packageOutput = plan.outputs.find(
      (output) =>
        output.type === "directory" &&
        output.path === `${GROK_SKILLS_DISCOVERY_ROOT}/review-pr`,
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
    expect(asset?.type).toBe("file");
    expect(Buffer.from((asset as { bytes: Uint8Array }).bytes)).toEqual(binaryAsset);
    expect(packageOutput.members.some((member) => member.path === "agent-profile-kit.yaml")).toBe(
      false,
    );
  });

  test("resolves direct and transitive Skills once, installs by Artifact ID, and omits unselected Skills", async () => {
    const home = temporaryDirectory("apk-grok-skill-home-");
    const project = temporaryDirectory("apk-grok-skill-project-");
    await workspaceWithSkills(
      home,
      project,
      ["grok"],
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
      ".grok/skills/left-skill",
      ".grok/skills/right-skill",
      ".grok/skills/shared-base",
      ".grok/skills/top-skill",
    ]);

    const sharedResolved = installation.resolvedProfile.artifacts.find(
      (artifact) => artifact.reference.id === "shared-base",
    );
    expect(sharedResolved?.inclusionReasons.length).toBeGreaterThanOrEqual(2);

    const preview = await previewReconciliation(desired.installations, {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 4,
    });
    expect(preview.blockers).toEqual([]);
    expect(
      preview.outputs.some((item) =>
        item.kind === "addition" && item.path === ".grok/skills/top-skill"
      ),
    ).toBe(true);
    const sharedReasons = preview.desired[0]?.resolvedArtifacts.find(
      (artifact) => artifact.id === "shared-base",
    )?.inclusionReasons ?? [];
    expect(sharedReasons.length).toBeGreaterThanOrEqual(2);
    const reasonPaths = sharedReasons.map((reason) => reason.path.join(" -> "));
    expect(reasonPaths.some((path) => path.includes("skill:left-skill"))).toBe(true);
    expect(reasonPaths.some((path) => path.includes("skill:right-skill"))).toBe(true);

    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, ".grok", "skills", "top-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".grok", "skills", "shared-base", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".grok", "skills", "unselected-skill"))).toBe(false);
    expect(existsSync(join(project, ".grok", "skills", "top-skill", "agent-profile-kit.yaml"))).toBe(
      false,
    );
    expect(statSync(join(project, ".grok", "skills", "top-skill", "scripts", "run.sh")).mode & 0o777)
      .toBe(0o755);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(true);

    const state = await readInstallationState(home);
    const manifest = state.installations[0];
    expect(manifest?.hostVersions.grok).toBe(GROK_HOST_VERSION_WITH_SKILLS);
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
    const home = temporaryDirectory("apk-grok-skill-relocate-home-");
    const project = temporaryDirectory("apk-grok-skill-relocate-project-");
    await workspaceWithSkills(
      home,
      project,
      ["grok"],
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
      (output) => output.path === ".grok/skills/review-pr",
    );
    expect(skillOutput?.type).toBe("directory");
    const preview = await previewReconciliation(second.installations, await readInstallationState(home));
    expect(
      preview.outputs.find((item) => item.path === ".grok/skills/review-pr")?.kind,
    ).toBe("unchanged");
  });

  test("unowned exact planned Skill destination blocks preflight without adoption", async () => {
    const home = temporaryDirectory("apk-grok-skill-collision-home-");
    const project = temporaryDirectory("apk-grok-skill-collision-project-");
    await workspaceWithSkills(home, project, ["grok"], [{ id: "review-pr" }], ["review-pr"]);
    mkdirSync(join(project, ".grok", "skills", "review-pr"), { recursive: true });
    writeFileSync(join(project, ".grok", "skills", "review-pr", "SKILL.md"), "foreign skill\n");
    mkdirSync(join(project, ".grok", "skills", "other-user-skill"), { recursive: true });
    writeFileSync(join(project, ".grok", "skills", "other-user-skill", "SKILL.md"), "keep me\n");
    writeFileSync(join(project, "AGENTS.md"), "project-owned\n");
    mkdirSync(join(project, ".grok", "rules"), { recursive: true });
    writeFileSync(join(project, ".grok", "rules", "team.md"), "existing team rule\n");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const preview = await previewReconciliation(desired.installations, {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 4,
    });
    expect(preview.blockers.some((blocker) =>
      blocker.message.includes(".grok/skills/review-pr") &&
      blocker.message.toLowerCase().includes("unowned")
    )).toBe(true);
    expect(readFileSync(join(project, ".grok", "skills", "review-pr", "SKILL.md"), "utf8")).toBe(
      "foreign skill\n",
    );
    expect(existsSync(join(project, ".grok", "skills", "other-user-skill", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, ".grok", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
  });

  test("Context and Skills share one installation lifecycle; deselection removes only proven packages", async () => {
    const home = temporaryDirectory("apk-grok-skill-lifecycle-home-");
    const project = temporaryDirectory("apk-grok-skill-lifecycle-project-");
    writeFileSync(join(project, "AGENTS.md"), "project-owned instructions\n");
    mkdirSync(join(project, ".grok", "rules"), { recursive: true });
    writeFileSync(join(project, ".grok", "rules", "team.md"), "existing team rule\n");
    mkdirSync(join(project, ".grok", "skills", "foreign-skill"), { recursive: true });
    writeFileSync(join(project, ".grok", "skills", "foreign-skill", "SKILL.md"), "leave me\n");
    await workspaceWithSkills(
      home,
      project,
      ["grok"],
      [
        { id: "review-pr" },
        { id: "write-notes" },
      ],
      ["review-pr", "write-notes"],
    );
    const first = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, first.installations);
    expect(existsSync(join(project, ".grok", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".grok", "skills", "write-notes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(true);
    expect(readFileSync(join(project, ".grok", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );

    const current = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(current.items.some((item) => item.kind === "current")).toBe(true);

    rmSync(join(project, ".grok", "skills", "write-notes"), { recursive: true, force: true });
    const missing = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(missing.items.some((item) => item.kind === "repairable missing output")).toBe(true);
    expect(missing.outputs.some((item) =>
      item.kind === "repair" && item.path === ".grok/skills/write-notes"
    )).toBe(true);
    mkdirSync(join(project, ".grok", "skills", "write-notes"), { recursive: true });
    writeFileSync(
      join(project, ".grok", "skills", "write-notes", "SKILL.md"),
      "---\nname: write-notes\ndescription: Skill write-notes.\n---\n\n# write-notes\n",
    );

    writeFileSync(
      join(project, ".grok", "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Skill review-pr.\n---\n\n# drifted\n",
    );
    const drifted = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(drifted.items.some((item) => item.kind === "drifted output")).toBe(true);
    writeFileSync(
      join(project, ".grok", "skills", "review-pr", "SKILL.md"),
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
    expect(readFileSync(join(project, ".grok", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
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
      (item.path === ".grok/skills/review-pr" || item.path.startsWith(".grok/skills/review-pr/"))
    )).toBe(true);
    await applyReconciliation(home, deselected.installations);
    expect(existsSync(join(project, ".grok", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".grok", "skills", "write-notes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(true);
    expect(readFileSync(join(project, ".grok", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );

    expect((await uninstallApplication(home)).projects).toHaveLength(1);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".grok", "skills", "write-notes"))).toBe(false);
    expect(readFileSync(join(project, ".grok", "skills", "foreign-skill", "SKILL.md"), "utf8")).toBe(
      "leave me\n",
    );
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("project-owned instructions\n");
    expect(readFileSync(join(project, ".grok", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
  });

  test("Skills-only Grok Profile omits Context rule machinery", async () => {
    const home = temporaryDirectory("apk-grok-skills-only-home-");
    const project = temporaryDirectory("apk-grok-skills-only-project-");
    await workspaceWithSkills(
      home,
      project,
      ["grok"],
      [{ id: "review-pr" }],
      ["review-pr"],
      { context: false },
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const paths = desired.installations[0]?.outputs.map((output) => output.path).sort();
    expect(paths).toEqual([".grok/skills/review-pr"]);
    expect(desired.installations[0]?.hostVersions.grok).toBe(GROK_HOST_VERSION_WITH_SKILLS);
    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, ".grok", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
  });

  test("Context-only Grok Profile continues to omit Skill machinery", async () => {
    const home = temporaryDirectory("apk-grok-context-only-home-");
    const project = temporaryDirectory("apk-grok-context-only-project-");
    await workspaceWithSkills(home, project, ["grok"], [{ id: "unselected" }], []);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.hostVersions.grok).toBe(GROK_HOST_VERSION);
    expect(desired.installations[0]?.outputs.map((output) => output.path)).toEqual([
      GROK_CONTEXT_RULE_PATH,
    ]);
  });

  test("combined Codex/Claude/Grok Hosts install Host-native Skill trees in one Manifest transaction", async () => {
    const home = temporaryDirectory("apk-grok-skill-combined-home-");
    const project = temporaryDirectory("apk-grok-skill-combined-project-");
    writeFileSync(join(project, "CLAUDE.md"), "project-owned\n");
    writeFileSync(join(project, "AGENTS.md"), "repository-owned\n");
    await workspaceWithSkills(
      home,
      project,
      ["codex", "claude", "grok"],
      [
        { id: "base-skill" },
        { id: "review-pr", dependencies: ["base-skill"], scriptMode: 0o755 },
      ],
      ["review-pr"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected installation");
    expect(installation.binding.hosts).toEqual(["claude", "codex", "grok"]);
    const skillPaths = installation.outputs
      .filter((output) => output.type === "directory")
      .map((output) => output.path)
      .sort();
    expect(skillPaths).toEqual([
      ".agents/skills/base-skill",
      ".agents/skills/review-pr",
      ".claude/skills/base-skill",
      ".claude/skills/review-pr",
      ".grok/skills/base-skill",
      ".grok/skills/review-pr",
    ]);
    expect(installation.outputs.some((output) => output.path === CLAUDE_CONTEXT_RULE_PATH)).toBe(true);
    expect(installation.hostVersions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      codex: CODEX_HOST_VERSION,
      grok: GROK_HOST_VERSION_WITH_SKILLS,
    });

    const preview = await previewReconciliation(desired.installations, {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 4,
    });
    expect(preview.blockers).toEqual([]);
    await applyReconciliation(home, desired.installations);

    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".grok", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);

    const state = await readInstallationState(home);
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.hosts).toEqual(["claude", "codex", "grok"]);
    expect(state.installations[0]?.resolvedArtifacts.map((a) => a.reference.id).sort()).toEqual([
      "base-skill",
      "review-pr",
      "team-rules",
    ]);

    expect((await uninstallApplication(home)).projects).toHaveLength(1);
    expect(existsSync(join(project, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".grok", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
  });
});

describe("Grok capability and configuration diagnostics", () => {
  test("parses [skills] disabled, ignore, and paths including quoted commas and comments", () => {
    const parsed = parseGrokSkillsConfigSection(`
[cli]
channel = "stable"

[skills]
paths = ["~/team-skills", "/opt/skills", "path,with,commas"] # trailing comment
ignore = [
  "~/team-skills/wip",
  "dir with spaces",
]
disabled = ["noisy-skill", "legacy-helper"]

[compat.claude]
skills = true
`);
    expect(parsed.disabled).toEqual(["legacy-helper", "noisy-skill"]);
    expect(parsed.ignore).toEqual(["dir with spaces", "~/team-skills/wip"]);
    expect(parsed.paths).toEqual(["/opt/skills", "path,with,commas", "~/team-skills"]);
  });

  test("rejects invalid TOML and non-string [skills] arrays fail closed", () => {
    expect(() => parseGrokSkillsConfigSection("[skills\ndisabled = [")).toThrow(
      /invalid TOML/i,
    );
    expect(() =>
      parseGrokSkillsConfigSection("[skills]\ndisabled = \"not-an-array\"\n"),
    ).toThrow(/\[skills\]\.disabled must be an array of strings/);
    expect(() =>
      parseGrokSkillsConfigSection("[skills]\nignore = [1, 2]\n"),
    ).toThrow(/\[skills\]\.ignore must be an array of strings/);
    expect(() =>
      parseGrokSkillsConfigSection("[skills]\npaths = true\n"),
    ).toThrow(/\[skills\]\.paths must be an array of strings/);
    expect(() => parseGrokSkillsConfigSection("skills = []\n")).toThrow(
      /\[skills\] must be a table/,
    );
  });

  test("reports invalid TOML position without echoing configuration source", () => {
    const secretLikeValue = "sk-grok-test-should-not-leak";
    let failure: unknown;
    try {
      parseGrokSkillsConfigSection(`[skills ${secretLikeValue}\n`);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("invalid TOML at line 1, column 2");
    expect(message).not.toContain(secretLikeValue);
  });

  test("Skills capability detection uses version and output surface without inventory inspection", async () => {
    const project = temporaryDirectory("apk-grok-capability-no-inventory-");
    let inspected = false;
    await expect(
      assertGrokProjectCapability(project, {
        inspect: async () => {
          inspected = true;
          throw new Error("effective inventory must not be inspected");
        },
        requireContext: false,
        requireSkills: true,
        resolveVersion: async () => "0.2.111",
      }),
    ).resolves.toBeDefined();
    expect(inspected).toBe(false);
  });

  test("status delegates later plugin Skill identities to Grok Host Resolution", async () => {
    const home = temporaryDirectory("apk-grok-status-plugin-home-");
    const project = temporaryDirectory("apk-grok-status-plugin-project-");
    await workspaceWithSkills(
      home,
      project,
      ["grok"],
      [{ id: "review-pr" }],
      ["review-pr"],
      { context: false },
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);

    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const inspectBody = JSON.stringify({
      grokVersion: "0.2.111",
      externalCompat: {
        cells: [{ vendor: "claude", surface: "rules", enabled: true, source: "default" }],
      },
      skills: [
        {
          name: "review-pr",
          source: {
            type: "plugin",
            plugin_name: "demo",
            path: "/plugins/demo/skills/review-pr/SKILL.md",
          },
          userInvocable: true,
          vendor: "demo",
        },
        {
          name: "review-pr",
          source: {
            type: "project",
            path: join(project, ".grok", "skills", "review-pr", "SKILL.md"),
          },
          userInvocable: true,
        },
      ],
    });
    writeFileSync(
      join(bin, "grok"),
      `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "grok 0.2.111 (fake) [stable]"
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
${inspectBody}
EOF
  exit 0
fi
echo "unexpected grok invocation: $*" >&2
exit 2
`,
    );
    chmodSync(join(bin, "grok"), 0o755);

    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const report = await statusApplication(home);
      expect(report.blockers).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.items.some((item) => item.kind === "current")).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("status does not require a Grok effective Skill inventory", async () => {
    const home = temporaryDirectory("apk-grok-status-missing-inventory-home-");
    const project = temporaryDirectory("apk-grok-status-missing-inventory-project-");
    await workspaceWithSkills(
      home,
      project,
      ["grok"],
      [{ id: "review-pr" }],
      ["review-pr"],
      { context: false },
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);

    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const inspectBody = JSON.stringify({
      grokVersion: "0.2.111",
      externalCompat: {
        cells: [{ vendor: "claude", surface: "rules", enabled: true, source: "default" }],
      },
      // deliberately omit skills
    });
    writeFileSync(
      join(bin, "grok"),
      `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "grok 0.2.111 (fake) [stable]"
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
${inspectBody}
EOF
  exit 0
fi
exit 2
`,
    );
    chmodSync(join(bin, "grok"), 0o755);

    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const report = await statusApplication(home);
      expect(report.blockers).toEqual([]);
      expect(report.items.some((item) => item.kind === "current")).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("status warns when Grok configuration disables planned Skill output", async () => {
    const home = temporaryDirectory("apk-grok-status-disabled-home-");
    const project = temporaryDirectory("apk-grok-status-disabled-project-");
    await workspaceWithSkills(
      home,
      project,
      ["grok"],
      [{ id: "review-pr" }],
      ["review-pr"],
      { context: false },
    );
    mkdirSync(join(home, ".grok"), { recursive: true });
    writeFileSync(
      join(home, ".grok", "config.toml"),
      '[skills]\ndisabled = ["review-pr"]\n',
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.blockers).toEqual([]);
    expect(
      desired.installations[0]?.warnings.some((warning) =>
        /Grok.*review-pr.*disabled.*may not load/i.test(warning),
      ),
    ).toBe(true);
  });
});

describe("Grok Skill model-invocation projection", () => {
  test("rejects CLI versions below the floor when disabled model invocation is required", () => {
    expect(() =>
      assertGrokCliVersionSupported("0.1.9", { requireDisabledModelInvocation: true }),
    ).toThrow(/cannot enforce disabled model invocation/);
    expect(() =>
      assertGrokCliVersionSupported(GROK_MINIMUM_CLI_VERSION, {
        requireDisabledModelInvocation: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertGrokCliVersionSupported("0.1.9", { requireSkills: true }),
    ).toThrow(/does not support native project Skills/);
  });

  test("emits disable-model-invocation only when policy is disabled", () => {
    const allowed =
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\n---\n\n# To spec\n";
    expect(emitGrokSkillMarkdown("to-spec", allowed, "allowed")).toBe(allowed);

    const disabled =
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# To spec\n";
    const projected = emitGrokSkillMarkdown("to-spec", disabled, "disabled");
    expect(projected).toContain("disable-model-invocation: true");
    expect(projected).toContain("agent-profile-kit.model-invocation: disabled");
  });

  test("disabled Skill plans Host SKILL.md restriction and invocation Capability Contract", async () => {
    const source = temporaryDirectory("apk-grok-mi-");
    const body =
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# To spec\n";
    writeSkillPackage(source, { "SKILL.md": { bytes: body } });
    const plan = await planGrokProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skill("to-spec", source, "disabled"),
    ]);
    expect(plan.hostVersion).toBe(GROK_HOST_VERSION_WITH_INVOCATION);
    const packageOutput = plan.outputs.find(
      (output) => output.type === "directory" && output.path === ".grok/skills/to-spec",
    );
    expect(packageOutput?.type).toBe("directory");
    if (!packageOutput || packageOutput.type !== "directory") {
      throw new Error("expected Skill package");
    }
    const skillMd = packageOutput.members.find((member) => member.path === "SKILL.md");
    expect(skillMd?.type).toBe("file");
    if (!skillMd || skillMd.type !== "file") throw new Error("expected SKILL.md");
    const generated = Buffer.from(skillMd.bytes).toString("utf8");
    expect(generated).toContain("disable-model-invocation: true");
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(body);
    expect(packageOutput.requirements.some((item) => item.includes("disable-model-invocation"))).toBe(
      true,
    );
  });
});
