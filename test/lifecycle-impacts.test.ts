import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  buildDesiredState,
  stateManifestPath,
  type DesiredInstallation,
} from "../installer/project-plan.js";
import {
  applyReconciliation,
  previewReconciliation,
  type ReconciliationReport,
} from "../installer/reconcile.js";
import {
  readInstallationState,
  writeInstallationState,
} from "../installer/installation-state.js";
import { uninstallApplication } from "../installer/commands.js";
import {
  formatApplyJson,
  formatLifecycleJson,
  formatLifecycleToolErrorJson,
} from "../cli/presentation.js";
import {
  INSTALLATION_MARKER_PATH,
  type InstallationState,
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";

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

async function scaffoldWorkspace(home: string): Promise<string> {
  await initializeWorkspace(home);
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function writeContext(workspace: string, id: string, body: string): void {
  const root = join(workspace, "context", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "CONTEXT.md"), `---\nid: ${id}\ndependencies: []\n---\n${body}\n`);
}

function writeSkill(workspace: string, id: string, body: string): void {
  const root = join(workspace, "skills", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), `---\nname: ${id}\ndescription: ${id}.\n---\n\n${body}\n`);
}

function writeProfile(
  workspace: string,
  id: string,
  context: readonly string[],
  skills: readonly string[],
): void {
  writeFileSync(
    join(workspace, "profiles", `${id}.yaml`),
    `id: ${id}\ncontext: [${context.join(", ")}]\nskills: [${skills.join(", ")}]\nagents: []\nhooks: []\ntools: []\n`,
  );
}

function writeConfig(
  home: string,
  workspace: string,
  bindings: readonly { hosts: readonly string[]; profile: string; project: string }[],
): void {
  const lines = ["schema_version: 2", `workspace: ${workspace}`, `bindings: ${bindings.length === 0 ? "[]" : ""}`];
  for (const binding of bindings) {
    lines.push(
      `  - project: ${binding.project}`,
      `    profile: ${binding.profile}`,
      `    hosts: [${binding.hosts.join(", ")}]`,
    );
  }
  writeFileSync(join(home, ".agents", "agent-profile-kit", "config.yaml"), `${lines.join("\n")}\n`);
}

/** The canonical project identity recorded for the first desired installation. */
function canonicalProject(desired: readonly DesiredInstallation[]): string {
  const installation = desired[0];
  if (!installation) throw new Error("expected at least one desired installation");
  return installation.binding.canonicalProject;
}

/** One shared context + skill Profile bound to one Codex project. */
async function contextAndSkillSetup(
  home: string,
  project: string,
  contextIds: readonly string[] = ["team-rules"],
  skillIds: readonly string[] = ["review-pr"],
): Promise<string> {
  const workspace = await scaffoldWorkspace(home);
  for (const id of contextIds) writeContext(workspace, id, `${id} body.\n`);
  for (const id of skillIds) writeSkill(workspace, id, `${id} body.\n`);
  writeProfile(workspace, "coding", contextIds, skillIds);
  writeConfig(home, workspace, [{ hosts: ["codex"], profile: "coding", project }]);
  return workspace;
}

function legacyManifestValue(manifest: ProjectInstallationManifest): Record<string, unknown> {
  return {
    schema_version: 2,
    installation_id: manifest.installationId,
    project: manifest.project,
    profile_id: manifest.profileId,
    selected_context: manifest.selectedContext,
    resolved_artifacts: manifest.resolvedArtifacts.map((artifact) => ({
      type: artifact.reference.type,
      id: artifact.reference.id,
      inclusion_reasons: artifact.inclusionReasons,
    })),
    hosts: manifest.hosts,
    host_versions: manifest.hostVersions,
    adapter_version: manifest.adapterVersion,
    engine_version: manifest.engineVersion,
    ...(manifest.gitProject === undefined ? {} : { git_project: manifest.gitProject }),
    workspace_input_hash: manifest.workspaceInputHash,
    outputs: manifest.outputs.map((output) =>
      output.type === "file"
        ? { path: output.path, type: output.type, mode: output.mode, hash: output.hash }
        : {
            path: output.path,
            type: output.type,
            mode: output.mode,
            hash: output.hash,
            members: output.members.map((member) =>
              member.type === "file"
                ? { path: member.path, type: member.type, mode: member.mode, hash: member.hash }
                : { path: member.path, type: member.type, mode: member.mode },
            ),
          },
    ),
  };
}

describe("Typed lifecycle impacts", () => {
  test("a new Project Binding emits one binding addition impact covering every generated path", async () => {
    const home = temporaryDirectory("apk-impacts-new-home-");
    const project = temporaryDirectory("apk-impacts-new-project-");
    await contextAndSkillSetup(home, project);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const state = await readInstallationState(home);

    const report = await previewReconciliation(desired.installations, state);

    expect(report.impacts).toEqual([{
      kind: "binding",
      operation: "addition",
      project: canonicalProject(desired.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [
        ".agent-profile-kit/codex/context.md",
        INSTALLATION_MARKER_PATH,
        ".agents/skills/review-pr",
        ".codex/hooks.json",
      ],
      reason: "Project Binding installs this Profile into the project for the first time",
    }]);
  });

  test("a fully current installation emits no impacts", async () => {
    const home = temporaryDirectory("apk-impacts-current-home-");
    const project = temporaryDirectory("apk-impacts-current-project-");
    await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([]);
  });

  test("a changed Skill is attributed to its canonical Artifact ID when fingerprints prove it", async () => {
    const home = temporaryDirectory("apk-impacts-skill-home-");
    const project = temporaryDirectory("apk-impacts-skill-project-");
    const workspace = await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeSkill(workspace, "review-pr", "Review a pull request.\n\nChanged body.\n");
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "artifact",
      operation: "update",
      project: canonicalProject(desired.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [".agents/skills/review-pr"],
      artifacts: [{ id: "review-pr", type: "skill" }],
      reason: "Workspace artifact content changed",
    }]);
  });

  test("a changed Context Module is attributed to its canonical Artifact ID when fingerprints prove it", async () => {
    const home = temporaryDirectory("apk-impacts-context-home-");
    const project = temporaryDirectory("apk-impacts-context-project-");
    const workspace = await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeContext(workspace, "team-rules", "Team rules body.\n\nChanged rules.\n");
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "artifact",
      operation: "update",
      project: canonicalProject(desired.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [".agent-profile-kit/codex/context.md"],
      artifacts: [{ id: "team-rules", type: "context" }],
      reason: "Workspace artifact content changed",
    }]);
  });

  test("adding a Skill to a Profile emits an artifact addition impact", async () => {
    const home = temporaryDirectory("apk-impacts-add-home-");
    const project = temporaryDirectory("apk-impacts-add-project-");
    const workspace = await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeSkill(workspace, "second", "Second skill body.\n");
    writeProfile(workspace, "coding", ["team-rules"], ["review-pr", "second"]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "artifact",
      operation: "addition",
      project: canonicalProject(desired.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [".agents/skills/second"],
      artifacts: [{ id: "second", type: "skill" }],
      reason: "Workspace artifact added to the Profile",
    }]);
  });

  test("removing a Skill from a Profile emits an artifact removal impact with the removed output path", async () => {
    const home = temporaryDirectory("apk-impacts-remove-home-");
    const project = temporaryDirectory("apk-impacts-remove-project-");
    const workspace = await contextAndSkillSetup(home, project, ["team-rules"], ["review-pr", "second"]);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeProfile(workspace, "coding", ["team-rules"], ["review-pr"]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "artifact",
      operation: "removal",
      project: canonicalProject(desired.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [".agents/skills/second"],
      artifacts: [{ id: "second", type: "skill" }],
      reason: "Workspace artifact removed from the Profile",
    }]);
  });

  test("a multi-source Context envelope preserves the complete proven changed source set", async () => {
    const home = temporaryDirectory("apk-impacts-multi-home-");
    const project = temporaryDirectory("apk-impacts-multi-project-");
    const workspace = await contextAndSkillSetup(home, project, ["team-rules", "team-style"], []);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeContext(workspace, "team-rules", "Team rules body.\n\nChanged rules.\n");
    const oneChanged = await buildDesiredState(home, { checkHostCapability: false });
    const oneReport = await previewReconciliation(
      oneChanged.installations,
      await readInstallationState(home),
    );
    expect(oneReport.impacts[0]?.artifacts).toEqual([{ id: "team-rules", type: "context" }]);

    writeContext(workspace, "team-style", "Team style body.\n\nChanged style.\n");
    const bothChanged = await buildDesiredState(home, { checkHostCapability: false });
    const bothReport = await previewReconciliation(
      bothChanged.installations,
      await readInstallationState(home),
    );
    expect(bothReport.impacts[0]?.artifacts).toEqual([
      { id: "team-rules", type: "context" },
      { id: "team-style", type: "context" },
    ]);
    expect(bothReport.impacts[0]?.kind).toBe("artifact");
    expect(bothReport.impacts[0]?.operation).toBe("update");
  });

  test("adding a Host emits a binding impact for outputs whose source artifacts did not change", async () => {
    const home = temporaryDirectory("apk-impacts-host-home-");
    const project = temporaryDirectory("apk-impacts-host-project-");
    const workspace = await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeConfig(home, workspace, [{ hosts: ["codex", "pi"], profile: "coding", project }]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "binding",
      operation: "addition",
      project: canonicalProject(desired.installations),
      profile: "coding",
      hosts: ["codex", "pi"],
      paths: [".pi/APPEND_SYSTEM.md", ".pi/skills/review-pr"],
      reason: "Project Binding or Host selection added generated output",
    }]);
  });

  test("switching Profiles emits a binding impact instead of artifact edits when fingerprints are unchanged", async () => {
    const home = temporaryDirectory("apk-impacts-profile-home-");
    const project = temporaryDirectory("apk-impacts-profile-project-");
    const workspace = await contextAndSkillSetup(home, project);
    writeContext(workspace, "design-rules", "Design rules body.\n");
    writeProfile(workspace, "design", ["design-rules"], []);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeConfig(home, workspace, [{ hosts: ["codex"], profile: "design", project }]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([
      {
        kind: "binding",
        operation: "update",
        project: canonicalProject(desired.installations),
        profile: "design",
        hosts: ["codex"],
        paths: [".agent-profile-kit/codex/context.md"],
        reason: "Project Binding or Host selection changed generated output",
      },
      {
        kind: "binding",
        operation: "removal",
        project: canonicalProject(desired.installations),
        profile: "design",
        hosts: ["codex"],
        paths: [".agents/skills/review-pr"],
        reason: "Project Binding or Host selection removed generated output",
      },
    ]);
  });

  test("an Adapter version change with relocated output emits an adapter-capability impact", async () => {
    const home = temporaryDirectory("apk-impacts-adapter-home-");
    const project = temporaryDirectory("apk-impacts-adapter-project-");
    await contextAndSkillSetup(home, project, ["team-rules"], []);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    const relocated = (await buildDesiredState(home, { checkHostCapability: false })).installations.map(
      (installation) => ({
        ...installation,
        adapterVersion: "changed-adapter-v2",
        outputs: installation.outputs.map((output) =>
          output.path === ".agent-profile-kit/codex/context.md"
            ? { ...output, path: ".agent-profile-kit/codex/context-v2.md" }
            : output,
        ),
      }),
    );
    const report = await previewReconciliation(relocated, await readInstallationState(home));

    expect(report.impacts).toEqual([
      {
        kind: "adapter-capability",
        operation: "addition",
        project: canonicalProject(initial.installations),
        profile: "coding",
        hosts: ["codex"],
        paths: [".agent-profile-kit/codex/context-v2.md"],
        reason: "Adapter version or Host capability added generated output",
      },
      {
        kind: "adapter-capability",
        operation: "removal",
        project: canonicalProject(initial.installations),
        profile: "coding",
        hosts: ["codex"],
        paths: [".agent-profile-kit/codex/context.md"],
        reason: "Adapter version or Host capability removed generated output",
      },
    ]);
  });

  test("a missing generated output emits a repair impact", async () => {
    const home = temporaryDirectory("apk-impacts-repair-home-");
    const project = temporaryDirectory("apk-impacts-repair-project-");
    await contextAndSkillSetup(home, project, ["team-rules"], []);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    const canonical = canonicalProject(initial.installations);
    rmSync(join(canonical, ".agent-profile-kit", "codex", "context.md"), { force: true });
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "repair",
      operation: "update",
      project: canonical,
      profile: "coding",
      hosts: ["codex"],
      paths: [".agent-profile-kit/codex/context.md"],
      reason: "Owned generated file is missing; apply will recreate it from current Workspace source",
    }]);
  });

  test("an installation with no remaining Project Binding emits an installation-removal impact", async () => {
    const home = temporaryDirectory("apk-impacts-removal-home-");
    const project = temporaryDirectory("apk-impacts-removal-project-");
    const workspace = await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeConfig(home, workspace, []);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "installation-removal",
      operation: "removal",
      project: canonicalProject(initial.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [
        ".agent-profile-kit/codex/context.md",
        INSTALLATION_MARKER_PATH,
        ".agents/skills/review-pr",
        ".codex/hooks.json",
      ],
      reason: "Project Binding no longer selects this project",
    }]);
  });

  test("an intended-teardown reinstall emits a repair impact", async () => {
    const home = temporaryDirectory("apk-impacts-teardown-home-");
    const project = temporaryDirectory("apk-impacts-teardown-project-");
    await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    await uninstallApplication(home);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "repair",
      operation: "addition",
      project: canonicalProject(initial.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [
        ".agent-profile-kit/codex/context.md",
        INSTALLATION_MARKER_PATH,
        ".agents/skills/review-pr",
        ".codex/hooks.json",
      ],
      reason: "Output was removed by uninstall; Project Binding was preserved",
    }]);
  });

  test("a repairable missing Installation Marker emits a metadata-only impact", async () => {
    const home = temporaryDirectory("apk-impacts-marker-home-");
    const project = temporaryDirectory("apk-impacts-marker-project-");
    await contextAndSkillSetup(home, project, ["team-rules"], []);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    const canonical = canonicalProject(initial.installations);
    rmSync(join(canonical, INSTALLATION_MARKER_PATH), { force: true });
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "metadata-only",
      operation: "update",
      project: canonical,
      profile: "coding",
      hosts: ["codex"],
      paths: [],
      reason: "Installation Marker is missing and repairable",
    }]);
  });

  test("a Git project classification change emits a metadata-only impact", async () => {
    const home = temporaryDirectory("apk-impacts-git-home-");
    const project = temporaryDirectory("apk-impacts-git-project-");
    await contextAndSkillSetup(home, project, ["team-rules"], []);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    const state = await readInstallationState(home);
    const crafted: InstallationState = {
      ...state,
      installations: state.installations.map((installation) => ({ ...installation, gitProject: true })),
    };
    await writeInstallationState(home, crafted);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "metadata-only",
      operation: "update",
      project: canonicalProject(initial.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [],
      reason: "Git project classification changed",
    }]);
  });

  test("receipt-only source input changes emit a metadata-only impact", async () => {
    const home = temporaryDirectory("apk-impacts-source-home-");
    const project = temporaryDirectory("apk-impacts-source-project-");
    const workspace = await contextAndSkillSetup(home, project, ["team-rules"], ["review-pr", "second"]);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    // Reordering the Profile selection changes the receipt's normalized inputs
    // without changing artifact fingerprints or generated output.
    writeProfile(workspace, "coding", ["team-rules"], ["second", "review-pr"]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "metadata-only",
      operation: "update",
      project: canonicalProject(initial.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [],
      reason: "Workspace source inputs changed; receipt will be refreshed",
    }]);
  });

  test("legacy receipts without provenance fall back to exact generated paths without path parsing", async () => {
    const home = temporaryDirectory("apk-impacts-legacy-home-");
    const project = temporaryDirectory("apk-impacts-legacy-project-");
    const workspace = await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    const recorded = (await readInstallationState(home)).installations[0]!;
    writeFileSync(
      stateManifestPath(home),
      stringify({
        schema_version: 5,
        intended_teardowns: [],
        installations: [legacyManifestValue(recorded)],
        repository_exclusions: [],
        temporary_installations: [],
      }),
    );

    writeSkill(workspace, "review-pr", "Review a pull request.\n\nChanged body.\n");
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "generated-path",
      operation: "update",
      project: canonicalProject(initial.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [".agents/skills/review-pr"],
      reason: "Exact generated paths changed without a proven source cause",
    }]);
    expect(report.impacts[0]).not.toHaveProperty("artifacts");
  });

  test("legacy output additions preserve their true operation without path parsing", async () => {
    const home = temporaryDirectory("apk-impacts-legacy-add-home-");
    const project = temporaryDirectory("apk-impacts-legacy-add-project-");
    const workspace = await contextAndSkillSetup(home, project, ["team-rules"], ["review-pr"]);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    const recorded = (await readInstallationState(home)).installations[0]!;
    const legacyState = stringify({
      schema_version: 5,
      intended_teardowns: [],
      installations: [legacyManifestValue(recorded)],
      repository_exclusions: [],
      temporary_installations: [],
    });

    writeSkill(workspace, "second", "Second skill body.\n");
    writeProfile(workspace, "coding", ["team-rules"], ["review-pr", "second"]);
    writeFileSync(stateManifestPath(home), legacyState);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "generated-path",
      operation: "addition",
      project: canonicalProject(initial.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [".agents/skills/second"],
      reason: "Exact generated paths added without a proven source cause",
    }]);
    expect(report.impacts[0]).not.toHaveProperty("artifacts");
  });

  test("legacy output removals preserve their true operation without path parsing", async () => {
    const home = temporaryDirectory("apk-impacts-legacy-remove-home-");
    const project = temporaryDirectory("apk-impacts-legacy-remove-project-");
    const workspace = await contextAndSkillSetup(home, project, ["team-rules"], ["review-pr", "second"]);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    const recorded = (await readInstallationState(home)).installations[0]!;
    writeFileSync(
      stateManifestPath(home),
      stringify({
        schema_version: 5,
        intended_teardowns: [],
        installations: [legacyManifestValue(recorded)],
        repository_exclusions: [],
        temporary_installations: [],
      }),
    );

    writeProfile(workspace, "coding", ["team-rules"], ["review-pr"]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([{
      kind: "generated-path",
      operation: "removal",
      project: canonicalProject(initial.installations),
      profile: "coding",
      hosts: ["codex"],
      paths: [".agents/skills/second"],
      reason: "Exact generated paths removed without a proven source cause",
    }]);
    expect(report.impacts[0]).not.toHaveProperty("artifacts");
  });

  test("impacts are deterministically ordered across projects and kinds", async () => {
    const home = temporaryDirectory("apk-impacts-order-home-");
    const first = temporaryDirectory("apk-impacts-order-a-");
    const second = temporaryDirectory("apk-impacts-order-b-");
    const workspace = await contextAndSkillSetup(home, first);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeSkill(workspace, "review-pr", "Review a pull request.\n\nChanged body.\n");
    writeConfig(home, workspace, [
      { hosts: ["codex"], profile: "coding", project: first },
      { hosts: ["codex"], profile: "coding", project: second },
    ]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const report = await previewReconciliation(desired.installations, await readInstallationState(home));

    expect(report.impacts).toEqual([
      expect.objectContaining({ kind: "binding", operation: "addition", project: canonicalProject(
        desired.installations.filter((installation) => installation.binding.project === second),
      ) }),
      expect.objectContaining({
        kind: "artifact",
        operation: "update",
        project: canonicalProject(
          desired.installations.filter((installation) => installation.binding.project === first),
        ),
      }),
    ]);
  });

  test("apply receipt and resulting state derive impacts from the same canonical comparison", async () => {
    const home = temporaryDirectory("apk-impacts-apply-home-");
    const project = temporaryDirectory("apk-impacts-apply-project-");
    const workspace = await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);

    writeSkill(workspace, "review-pr", "Review a pull request.\n\nChanged body.\n");
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    const preview = await previewReconciliation(desired.installations, await readInstallationState(home));
    const result = await applyReconciliation(home, desired.installations);

    expect(result.receipt.impacts).toEqual(preview.impacts);
    expect(result.resultingState.impacts).toEqual([]);
  });
});

describe("Typed lifecycle impacts in the machine JSON", () => {
  async function changedSkillReport(
    home: string,
    project: string,
  ): Promise<{ readonly desired: readonly DesiredInstallation[]; readonly report: ReconciliationReport }> {
    const workspace = await contextAndSkillSetup(home, project);
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    writeSkill(workspace, "review-pr", "Review a pull request.\n\nChanged body.\n");
    const desiredState = await buildDesiredState(home, { checkHostCapability: false });
    const report = await previewReconciliation(
      desiredState.installations,
      await readInstallationState(home),
    );
    return { desired: desiredState.installations, report };
  }

  test("preview JSON publishes normalized impacts while retaining flat evidence and schema version 2", async () => {
    const home = temporaryDirectory("apk-impacts-json-home-");
    const project = temporaryDirectory("apk-impacts-json-project-");
    const { report } = await changedSkillReport(home, project);

    const payload = JSON.parse(formatLifecycleJson("preview", report)) as Record<string, unknown>;

    expect(payload.schemaVersion).toBe(2);
    expect(payload.command).toBe("preview");
    expect(payload.impacts).toEqual([{
      kind: "artifact",
      operation: "update",
      project: report.impacts[0]!.project,
      profile: "coding",
      hosts: ["codex"],
      paths: [".agents/skills/review-pr"],
      artifacts: [{ id: "review-pr", type: "skill" }],
      reason: "Workspace artifact content changed",
    }]);
    expect(payload.installations).toHaveLength(1);
    const changedOutput = (payload.outputs as readonly { kind: string; path: string; project: string }[])
      .find((output) => output.kind === "update");
    expect(changedOutput).toEqual({
      kind: "update",
      path: ".agents/skills/review-pr",
      project: report.outputs.find((output) => output.kind === "update")!.project,
    });
    expect(payload.blockers).toEqual([]);
  });

  test("apply JSON carries the receipt impacts under applied and none in the verified resulting state", async () => {
    const home = temporaryDirectory("apk-impacts-applyjson-home-");
    const project = temporaryDirectory("apk-impacts-applyjson-project-");
    const { desired } = await changedSkillReport(home, project);
    const result = await applyReconciliation(home, desired);

    const payload = JSON.parse(formatApplyJson(result)) as {
      readonly applied: { readonly impacts: readonly unknown[] };
      readonly impacts: readonly unknown[];
    };

    expect(payload.impacts).toEqual([]);
    expect(payload.applied.impacts).toEqual([{
      kind: "artifact",
      operation: "update",
      project: result.receipt.impacts[0]!.project,
      profile: "coding",
      hosts: ["codex"],
      paths: [".agents/skills/review-pr"],
      artifacts: [{ id: "review-pr", type: "skill" }],
      reason: "Workspace artifact content changed",
    }]);
  });

  test("tool-error JSON publishes an empty impacts array", () => {
    const payload = JSON.parse(formatLifecycleToolErrorJson("preview", "boom")) as {
      readonly impacts: readonly unknown[];
    };
    expect(payload.impacts).toEqual([]);
  });
});
