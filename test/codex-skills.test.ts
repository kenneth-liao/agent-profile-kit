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
import { planCodexProject } from "../adapters/codex.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { readInstallationState } from "../installer/installation-state.js";
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
    `id: coding\ncontext: [team-rules]\nskills: [${selectedSkills.join(", ")}]\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
  );
}

describe("Codex project Skill packages", () => {
  test("plans each resolved Skill under .agents/skills/<Artifact ID> with bytes and modes preserved and sidecars omitted", async () => {
    const source = temporaryDirectory("apk-skill-source-");
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

    const plan = await planCodexProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skill("review-pr", source),
    ]);

    const packageOutput = plan.outputs.find(
      (output) => output.type === "directory" && output.path === ".agents/skills/review-pr",
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
    expect(plan.outputs.some((output) => output.path === ".agent-profile-kit/codex/context.md")).toBe(
      true,
    );
    expect(plan.setupSteps).toEqual([
      {
        consequence: "Declining the hook prevents Profile Context from loading.",
        kind: "approval-required",
        message: "Review and approve the generated SessionStart hook when Codex asks.",
        output: ".codex/hooks.json",
        provenance: "transition",
      },
      {
        consequence: "Profile Context does not load until the project is trusted.",
        kind: "trust-required",
        message: "Trust the bound project in Codex.",
        provenance: "standing",
      },
    ]);
  });

  test("keeps non-Git launch paths typed for the presentation boundary", async () => {
    const plan = await planCodexProject(
      "coding",
      [{ id: "team-rules", content: "rules\n" }],
      [],
      { requiresBoundRootLaunch: true },
    );

    expect(plan.setupSteps).toContainEqual({
      consequence: "Launching from a descendant prevents Profile Context from loading.",
      kind: "launch-constraint",
      message: "Launch Codex from the exact bound project root:",
      path: "bound-project",
      provenance: "standing",
    });
  });

  test("resolves direct and transitive Skills once for diamond deps, installs by Artifact ID, and omits unselected Skills", async () => {
    const home = temporaryDirectory("apk-skill-home-");
    const project = temporaryDirectory("apk-skill-project-");
    await workspaceWithSkills(
      home,
      project,
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
      ".agents/skills/left-skill",
      ".agents/skills/right-skill",
      ".agents/skills/shared-base",
      ".agents/skills/top-skill",
    ]);

    const sharedResolved = installation.resolvedProfile.artifacts.find(
      (artifact) => artifact.reference.id === "shared-base",
    );
    expect(sharedResolved?.inclusionReasons.length).toBeGreaterThanOrEqual(2);

    const preview = await previewReconciliation(desired.installations, {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      temporaryInstallations: [],
      schemaVersion: 5,
    });
    expect(preview.desired[0]?.resolvedArtifacts.some((artifact) => artifact.id === "top-skill")).toBe(
      true,
    );
    expect(
      preview.desired[0]?.resolvedArtifacts.find((artifact) => artifact.id === "shared-base")
        ?.inclusionReasons.length,
    ).toBeGreaterThanOrEqual(2);

    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, ".agents", "skills", "top-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "shared-base", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "unselected-skill"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "top-skill", "agent-profile-kit.yaml"))).toBe(
      false,
    );
    expect(statSync(join(project, ".agents", "skills", "top-skill", "scripts", "run.sh")).mode & 0o777)
      .toBe(0o755);

    const state = await readInstallationState(home);
    const manifest = state.installations[0];
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
    const home = temporaryDirectory("apk-skill-relocate-home-");
    const project = temporaryDirectory("apk-skill-relocate-project-");
    await workspaceWithSkills(
      home,
      project,
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
      (output) => output.path === ".agents/skills/review-pr",
    );
    expect(skillOutput?.type).toBe("directory");
    const preview = await previewReconciliation(second.installations, await readInstallationState(home));
    expect(
      preview.outputs.find((item) => item.path === ".agents/skills/review-pr")?.kind,
    ).toBe("unchanged");
  });

  test("unowned exact planned Skill destination blocks preflight without adoption", async () => {
    const home = temporaryDirectory("apk-skill-collision-home-");
    const project = temporaryDirectory("apk-skill-collision-project-");
    await workspaceWithSkills(home, project, [{ id: "review-pr" }], ["review-pr"]);
    mkdirSync(join(project, ".agents", "skills", "review-pr"), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"), "foreign skill\n");
    mkdirSync(join(project, ".agents", "skills", "other-user-skill"), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", "other-user-skill", "SKILL.md"), "keep me\n");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const preview = await previewReconciliation(desired.installations, {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      temporaryInstallations: [],
      schemaVersion: 5,
    });
    expect(preview.blockers.some((blocker) =>
      blocker.message.includes(".agents/skills/review-pr") &&
      blocker.message.toLowerCase().includes("unowned")
    )).toBe(true);
    expect(readFileSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"), "utf8")).toBe(
      "foreign skill\n",
    );
    expect(existsSync(join(project, ".agents", "skills", "other-user-skill", "SKILL.md"))).toBe(true);
  });

  test("changing only a Skill dependency edge refreshes Manifest inclusion reasons", async () => {
    const home = temporaryDirectory("apk-skill-dep-hash-home-");
    const project = temporaryDirectory("apk-skill-dep-hash-project-");
    await workspaceWithSkills(
      home,
      project,
      [
        { id: "shared-base" },
        { id: "mid-skill", dependencies: ["shared-base"] },
        { id: "top-skill", dependencies: ["mid-skill"] },
      ],
      ["top-skill"],
    );
    const first = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, first.installations);
    const before = await readInstallationState(home);
    const beforeShared = before.installations[0]?.resolvedArtifacts.find(
      (artifact) => artifact.reference.id === "shared-base",
    );
    expect(beforeShared?.inclusionReasons).toHaveLength(1);

    // Redundant direct edge: package bytes and resolved Artifact IDs stay the same,
    // but shared-base gains a second inclusion reason path.
    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "workspace", "skills", "top-skill", "agent-profile-kit.yaml"),
      "dependencies:\n  - type: skill\n    id: mid-skill\n  - type: skill\n    id: shared-base\n",
    );
    const second = await buildDesiredState(home, { checkHostCapability: false });
    expect(second.installations[0]?.sourceHash).not.toBe(first.installations[0]?.sourceHash);
    const preview = await previewReconciliation(second.installations, before);
    expect(preview.items.some((item) => item.kind === "stale source")).toBe(true);
    await applyReconciliation(home, second.installations);
    const after = await readInstallationState(home);
    const afterShared = after.installations[0]?.resolvedArtifacts.find(
      (artifact) => artifact.reference.id === "shared-base",
    );
    expect(afterShared?.inclusionReasons.length).toBeGreaterThanOrEqual(2);
  });

  test("Context and Skills share one installation lifecycle; deselection removes only proven packages", async () => {
    const home = temporaryDirectory("apk-skill-lifecycle-home-");
    const project = temporaryDirectory("apk-skill-lifecycle-project-");
    await workspaceWithSkills(
      home,
      project,
      [
        { id: "review-pr" },
        { id: "write-notes" },
      ],
      ["review-pr", "write-notes"],
    );
    const first = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, first.installations);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "write-notes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);

    const current = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(current.items.some((item) => item.kind === "current")).toBe(true);

    rmSync(join(project, ".agents", "skills", "write-notes"), { recursive: true, force: true });
    const missing = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(missing.items.some((item) => item.kind === "repairable missing output")).toBe(true);
    expect(missing.outputs.some((item) =>
      item.kind === "repair" && item.path === ".agents/skills/write-notes"
    )).toBe(true);
    // Restore owned package contents so later drift/stale cases exercise a complete installation.
    mkdirSync(join(project, ".agents", "skills", "write-notes"), { recursive: true });
    writeFileSync(
      join(project, ".agents", "skills", "write-notes", "SKILL.md"),
      "---\nname: write-notes\ndescription: Skill write-notes.\n---\n\n# write-notes\n",
    );

    writeFileSync(
      join(project, ".agents", "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Skill review-pr.\n---\n\n# drifted\n",
    );
    const drifted = await previewReconciliation(first.installations, await readInstallationState(home));
    expect(drifted.items.some((item) => item.kind === "drifted output")).toBe(true);
    writeFileSync(
      join(project, ".agents", "skills", "review-pr", "SKILL.md"),
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
    expect(readFileSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "updated source",
    );

    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "workspace", "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [write-notes]\n",
    );
    const deselected = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, deselected.installations);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "write-notes", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
  });
});
