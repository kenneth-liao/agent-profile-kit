import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPiCliVersionSupported,
  assertPiProjectCapability,
  emitPiSkillMarkdown,
  PI_ADAPTER_VERSION,
  PI_CONTEXT_PATH,
  PI_HOST_VERSION,
  PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION,
  PI_HOST_VERSION_WITH_INVOCATION,
  PI_HOST_VERSION_WITH_SKILLS,
  PI_MINIMUM_CLI_VERSION,
  parsePiCliVersion,
  planPiProject,
} from "../adapters/pi.js";
import { composeContextEnvelope } from "../adapters/context-envelope.js";
import { parseLocalConfiguration } from "../schemas/local-configuration.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { applyReconciliation, previewReconciliation } from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { readInstallationState } from "../installer/installation-state.js";
import { uninstallApplication } from "../installer/commands.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeContextWorkspace(
  home: string,
  projects: readonly {
    readonly path: string;
    readonly hosts: readonly string[];
    readonly profile?: string;
  }[],
): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nPreserve the project boundary.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
  );
  const bindings = projects
    .map(
      ({ path, hosts, profile = "coding" }) =>
        `  - project: ${path}\n    profile: ${profile}\n    hosts: [${hosts.join(", ")}]`,
    )
    .join("\n");
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${bindings}\n`,
  );
}

async function writePiSkillWorkspace(
  home: string,
  project: string,
  selectedSkills: readonly string[],
  skills: readonly {
    readonly id: string;
    readonly path: string;
    readonly dependencies?: readonly string[];
    readonly scriptMode?: number;
  }[],
  hosts: readonly string[] = ["pi"],
): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nPreserve the project boundary.\n",
  );
  for (const skill of skills) {
    const root = join(workspace, "skills", skill.path);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "SKILL.md"),
      `---\nname: ${skill.id}\ndescription: ${skill.id} Skill.\n---\n\n# ${skill.id}\n`,
    );
    if (skill.scriptMode !== undefined) {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts", "run.sh"), `#!/bin/sh\necho ${skill.id}\n`);
      chmodSync(join(root, "scripts", "run.sh"), skill.scriptMode);
    }
    if (skill.dependencies !== undefined) {
      writeFileSync(
        join(root, "agent-profile-kit.yaml"),
        `dependencies:\n${skill.dependencies.map((id) => `  - type: skill\n    id: ${id}\n`).join("")}`,
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

describe("Pi Project Binding ingestion", () => {
  test("accepts Pi-only and multi-Host bindings, normalizing order and duplicates", () => {
    const piOnly = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [pi]\n",
      "config.yaml",
    );
    expect(piOnly.bindings[0]?.hosts).toEqual(["pi"]);

    const combined = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [pi, codex, pi, claude, codex]\n",
      "config.yaml",
    );
    expect(combined.bindings[0]?.hosts).toEqual(["claude", "codex", "pi"]);
  });
});

describe("Pi Adapter", () => {
  test("delegates a same-identity personal Skill to Pi Host Resolution", async () => {
    const home = temporaryDirectory("apk-pi-overlap-home-");
    const project = temporaryDirectory("apk-pi-overlap-project-");
    const personalSkill = join(home, ".pi", "agent", "skills", "review-pr");
    mkdirSync(personalSkill, { recursive: true });
    writeFileSync(
      join(personalSkill, "SKILL.md"),
      "---\nname: review-pr\ndescription: Existing personal Skill.\n---\n\n# Existing\n",
    );

    await expect(
      assertPiProjectCapability(project, {
        home,
        requireContext: false,
        requireSkills: true,
        resolveVersion: async () => "0.82.1",
      }),
    ).resolves.toBeUndefined();
  });

  test("accepts benign global and project Pi settings for Skill delivery", async () => {
    const home = temporaryDirectory("apk-pi-settings-home-");
    const project = temporaryDirectory("apk-pi-settings-project-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "settings.json"),
      '{"theme":"dark","skills":[],"extensions":[],"packages":[]}\n',
    );
    writeFileSync(
      join(project, ".pi", "settings.json"),
      '{"defaultModel":"anthropic/claude-sonnet-4","packages":[{"source":"npm:themes","skills":[],"extensions":[],"themes":["dark.json"]}]}\n',
    );

    await expect(
      assertPiProjectCapability(project, {
        home,
        requireContext: false,
        requireSkills: true,
        resolveVersion: async () => "0.82.1",
      }),
    ).resolves.toBeUndefined();
  });

  test("allows an ordinary Pi extension package alongside project Skills", async () => {
    const home = temporaryDirectory("apk-pi-configured-packages-home-");
    const project = temporaryDirectory("apk-pi-configured-packages-project-");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(
      join(project, ".pi", "settings.json"),
      '{"packages":["npm:@ollama/pi-web-search"]}\n',
    );

    await expect(
      assertPiProjectCapability(project, {
        home,
        requireContext: false,
        requireSkills: true,
        resolveVersion: async () => "0.82.1",
      }),
    ).resolves.toBeUndefined();
  });

  test("Context-only Pi capability does not read or require Skill settings", async () => {
    const home = temporaryDirectory("apk-pi-context-settings-home-");
    const project = temporaryDirectory("apk-pi-context-settings-project-");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), "{not json\n");

    await expect(
      assertPiProjectCapability(project, {
        home,
        requireContext: true,
        requireSkills: false,
        resolveVersion: async () => "0.82.1",
      }),
    ).resolves.toBeUndefined();
  });

  test("plans each allowed Skill under .pi/skills/<Artifact ID> with package bytes, modes, and sidecars preserved", async () => {
    const source = temporaryDirectory("apk-pi-skill-source-");
    mkdirSync(join(source, "scripts"), { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
      { mode: 0o644 },
    );
    writeFileSync(join(source, "scripts", "run.sh"), "#!/bin/sh\necho review\n", { mode: 0o755 });
    chmodSync(join(source, "scripts", "run.sh"), 0o755);
    writeFileSync(join(source, "agent-profile-kit.yaml"), "dependencies: []\n");

    const plan = await planPiProject("coding", [], [
      { dependencies: [], id: "review-pr", modelInvocation: "allowed", path: source },
    ]);

    expect(plan.hostVersion).toBe(PI_HOST_VERSION_WITH_SKILLS);
    expect(plan.outputs.map((output) => output.path)).toEqual([".pi/skills/review-pr"]);
    const output = plan.outputs[0];
    if (!output || output.type !== "directory") throw new Error("expected Skill directory output");
    expect(output.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "SKILL.md", mode: 0o644, type: "file" }),
      expect.objectContaining({ path: "scripts/run.sh", mode: 0o755, type: "file" }),
    ]));
    const skillMarkdown = output.members.find(
      (member) => member.type === "file" && member.path === "SKILL.md",
    );
    if (!skillMarkdown || skillMarkdown.type !== "file") throw new Error("expected Skill markdown");
    expect(Buffer.from(skillMarkdown.bytes).toString("utf8")).toBe(
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    expect(output.members.some((member) => member.path === "agent-profile-kit.yaml")).toBe(false);
  });

  test("projects disabled model invocation into Pi frontmatter while preserving explicit Skill identity", () => {
    const source =
      "---\nname: review-pr\ndescription: Review a pull request.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Review\n";

    expect(emitPiSkillMarkdown("review-pr", source, "allowed")).toBe(source);
    const projected = emitPiSkillMarkdown("review-pr", source, "disabled");

    expect(projected).toContain("name: review-pr");
    expect(projected).toContain("disable-model-invocation: true");
    expect(projected).toContain("agent-profile-kit.model-invocation: disabled");
    expect(projected).toContain("# Review");
    expect(projected).not.toBe(source);
    expect(() =>
      emitPiSkillMarkdown(
        "review-pr",
        source.replace("name: review-pr", "name: another-skill"),
        "disabled",
      ),
    ).toThrow(/canonical Artifact ID/i);
    const crlfBody = "---\r\nname: review-pr\r\ndescription: Review a pull request.\r\n---\r\n# Review\r\n";
    expect(emitPiSkillMarkdown("review-pr", crlfBody, "disabled")).toMatch(/# Review\r\n$/);
    const inlineDelimiter = "---\nname: review-pr\ndescription: Review a pull request.\nlicense: abc---\nfoo: bar\n---\n# Review\n";
    expect(emitPiSkillMarkdown("review-pr", inlineDelimiter, "disabled")).toContain(
      "foo: bar\n---\n# Review\n",
    );
  });

  test("fails closed when Pi invocation projection cannot parse Skill frontmatter", () => {
    expect(() => emitPiSkillMarkdown("review-pr", "not frontmatter\n", "disabled")).toThrow(
      /must start with YAML frontmatter/i,
    );
    expect(() => emitPiSkillMarkdown("review-pr", "---\nname: review-pr\n", "disabled")).toThrow(
      /must close its YAML frontmatter/i,
    );
    expect(() => emitPiSkillMarkdown("review-pr", "---\nname: [\n---\nbody\n", "disabled")).toThrow(
      /frontmatter.*invalid YAML/i,
    );
  });

  test("records invocation-specific Pi Capability Contracts for Skills-only and combined Profiles", async () => {
    const source = temporaryDirectory("apk-pi-invocation-source-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Review\n",
    );
    const disabled = {
      dependencies: [],
      id: "review-pr",
      modelInvocation: "disabled" as const,
      path: source,
    };

    const skillsOnly = await planPiProject("coding", [], [disabled]);
    expect(skillsOnly.hostVersion).toBe(PI_HOST_VERSION_WITH_INVOCATION);
    expect(skillsOnly.setupSteps).toEqual([{
      consequence: "The Profile does not load until the project is trusted.",
      kind: "trust-required",
      message: "Trust the bound project in Pi.",
    }]);
    const skillOutput = skillsOnly.outputs[0];
    if (!skillOutput || skillOutput.type !== "directory") throw new Error("expected Skill directory output");
    const skillMarkdown = skillOutput.members.find(
      (member) => member.type === "file" && member.path === "SKILL.md",
    );
    if (!skillMarkdown || skillMarkdown.type !== "file") throw new Error("expected projected SKILL.md");
    expect(Buffer.from(skillMarkdown.bytes).toString("utf8")).toContain("disable-model-invocation: true");
    expect(skillOutput.requirements).toContain("Host prevents implicit model invocation while retaining explicit user invocation");

    const combined = await planPiProject(
      "coding",
      [{ id: "team-rules", content: "Context\n" }],
      [disabled],
    );
    expect(combined.hostVersion).toBe(PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION);
    expect(combined.outputs.map((output) => output.path)).toEqual([
      PI_CONTEXT_PATH,
      ".pi/skills/review-pr",
    ]);
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).not.toContain("disable-model-invocation: true");
  });

  test("plans only the canonical composed Context at Pi's append-system surface", async () => {
    const modules = [{ id: "team-rules", content: "Preserve the project boundary.\n" }];
    const plan = await planPiProject("coding", modules);

    expect(PI_ADAPTER_VERSION).toBe("pi-project-v1");
    expect(plan.host).toBe("pi");
    expect(plan.hostVersion).toBe(PI_HOST_VERSION);
    expect(plan.outputs).toHaveLength(1);
    const output = plan.outputs[0];
    expect(output?.type).toBe("file");
    expect(output?.path).toBe(PI_CONTEXT_PATH);
    if (output?.type !== "file") throw new Error("expected Pi Context file output");
    expect(output.bytes).toBe(composeContextEnvelope("coding", modules));
    expect(output.requirements).toContain("Pi loads project APPEND_SYSTEM.md as additive system Context");
    expect(plan.setupSteps).toEqual([{
      consequence: "The Profile does not load until the project is trusted.",
      kind: "trust-required",
      message: "Trust the bound project in Pi.",
    }]);

    const contextFree = await planPiProject("coding", []);
    expect(contextFree.outputs).toEqual([]);
    expect(contextFree.setupSteps).toEqual([]);
  });

  test("Pi-only and multi-Host bindings reconcile Context through one Installation lifecycle", async () => {
    const home = temporaryDirectory("apk-pi-lifecycle-home-");
    const piProject = temporaryDirectory("apk-pi-lifecycle-project-");
    const combinedProject = temporaryDirectory("apk-pi-lifecycle-combined-");
    const trustPath = join(home, ".pi", "agent", "trust.json");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(trustPath, `{"${piProject}":true}\n`);
    mkdirSync(join(piProject, ".pi"), { recursive: true });
    writeFileSync(join(piProject, ".pi", "settings.json"), "keep native settings\n");
    await writeContextWorkspace(home, [
      { path: piProject, hosts: ["pi"] },
      { path: combinedProject, hosts: ["claude", "pi", "claude"] },
    ]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(2);
    const piDesired = desired.installations.find((installation) => installation.binding.project === piProject);
    expect(piDesired).toBeDefined();
    expect(piDesired!.adapterVersion).toContain(PI_ADAPTER_VERSION);
    expect(piDesired!.hostVersions.pi).toBe(PI_HOST_VERSION);
    expect(piDesired!.outputs.map((output) => output.path)).toEqual([
      PI_CONTEXT_PATH,
    ]);
    expect(piDesired!.setupSteps).toEqual([{
      host: "pi",
      consequence: "The Profile does not load until the project is trusted.",
      kind: "trust-required",
      message: "Trust the bound project in Pi.",
    }]);

    const applied = await applyReconciliation(home, desired.installations);
    expect(applied.resultingState.blockers).toEqual([]);
    expect(existsSync(join(piProject, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    expect(existsSync(join(combinedProject, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    expect(existsSync(join(combinedProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);

    const state = await readInstallationState(home);
    expect(state.installations).toHaveLength(2);
    const piManifest = state.installations.find((installation) => installation.project === piDesired!.binding.canonicalProject);
    expect(piManifest?.hosts).toEqual(["pi"]);
    expect(piManifest?.hostVersions.pi).toBe(PI_HOST_VERSION);
    expect(piManifest?.outputs.some((output) => output.path === PI_CONTEXT_PATH)).toBe(true);

    writeFileSync(join(piProject, ".pi", "APPEND_SYSTEM.md"), "drifted\n");
    const status = await previewReconciliation(
      (await buildDesiredState(home, { checkHostCapability: false })).installations,
      state,
    );
    expect(status.items.some((item) => item.project === piProject && item.kind === "drifted output")).toBe(true);

    writeFileSync(join(piProject, ".pi", "APPEND_SYSTEM.md"), String(piDesired?.outputs[0]?.type === "file" ? piDesired.outputs[0].bytes : ""));
    await uninstallApplication(home);
    expect(existsSync(join(piProject, ".pi", "APPEND_SYSTEM.md"))).toBe(false);
    expect(readFileSync(join(piProject, ".pi", "settings.json"), "utf8")).toBe("keep native settings\n");
    expect(readFileSync(trustPath, "utf8")).toBe(`{"${piProject}":true}\n`);
    expect(existsSync(join(combinedProject, ".pi", "APPEND_SYSTEM.md"))).toBe(false);
    expect(existsSync(join(combinedProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
  });

  test("resolves direct and transitive Pi Skills once, records reasons, preserves package state, and removes only owned output", async () => {
    const home = temporaryDirectory("apk-pi-skill-lifecycle-home-");
    const project = temporaryDirectory("apk-pi-skill-lifecycle-project-");
    mkdirSync(join(project, ".pi", "skills", "unrelated"), { recursive: true });
    writeFileSync(join(project, ".pi", "skills", "unrelated", "README.md"), "keep\n");
    await writePiSkillWorkspace(home, project, ["top-skill"], [
      { id: "shared-base", path: "library/shared-base" },
      { id: "left-skill", path: "group/left-skill", dependencies: ["shared-base"] },
      { id: "right-skill", path: "group/right-skill", dependencies: ["shared-base"] },
      { id: "top-skill", path: "top-skill", dependencies: ["left-skill", "right-skill"], scriptMode: 0o755 },
      { id: "unselected-skill", path: "other/unselected-skill" },
    ]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected Pi installation");
    expect(installation.blockers).toEqual([]);
    expect(installation.hostVersions.pi).toBe("native-project-append-system-skills-v1");
    expect(installation.outputs.map((output) => output.path)).toEqual([
      ".pi/APPEND_SYSTEM.md",
      ".pi/skills/left-skill",
      ".pi/skills/right-skill",
      ".pi/skills/shared-base",
      ".pi/skills/top-skill",
    ]);
    const shared = installation.resolvedProfile.artifacts.find(
      (artifact) => artifact.reference.id === "shared-base",
    );
    expect(shared?.inclusionReasons).toHaveLength(2);

    await applyReconciliation(home, desired.installations);
    const reapplied = await applyReconciliation(
      home,
      (await buildDesiredState(home, { checkHostCapability: false })).installations,
    );
    expect(reapplied.resultingState.blockers).toEqual([]);
    const topScript = join(project, ".pi", "skills", "top-skill", "scripts", "run.sh");
    expect(readFileSync(topScript, "utf8")).toContain("top-skill");
    expect(statSync(topScript).mode & 0o777).toBe(0o755);
    expect(existsSync(join(project, ".pi", "skills", "top-skill", "agent-profile-kit.yaml"))).toBe(false);
    expect(existsSync(join(project, ".pi", "skills", "unselected-skill"))).toBe(false);
    expect(readFileSync(join(project, ".pi", "skills", "unrelated", "README.md"), "utf8")).toBe("keep\n");

    const state = await readInstallationState(home);
    const manifest = state.installations[0];
    expect(manifest?.hostVersions.pi).toBe("native-project-append-system-skills-v1");
    expect(manifest?.resolvedArtifacts.find((artifact) => artifact.reference.id === "shared-base")?.inclusionReasons).toHaveLength(2);

    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    mkdirSync(join(workspace, "skills", "relocated"), { recursive: true });
    renameSync(
      join(workspace, "skills", "top-skill"),
      join(workspace, "skills", "relocated", "top-skill"),
    );
    const relocated = await buildDesiredState(home, { checkHostCapability: false });
    expect(relocated.installations[0]?.outputs.map((output) => output.path)).toEqual(
      installation.outputs.map((output) => output.path),
    );
    await applyReconciliation(home, relocated.installations);

    writeFileSync(join(project, ".pi", "skills", "top-skill", "SKILL.md"), "drifted\n");
    const drift = await previewReconciliation(
      (await buildDesiredState(home, { checkHostCapability: false })).installations,
      state,
    );
    expect(drift.items.some((item) => item.project === project && item.kind === "drifted output")).toBe(true);
    writeFileSync(
      join(project, ".pi", "skills", "top-skill", "SKILL.md"),
      "---\nname: top-skill\ndescription: top-skill Skill.\n---\n\n# top-skill\n",
    );
    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "workspace", "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [left-skill]\nagents: []\nhooks: []\ntools: []\n",
    );
    const deselected = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, deselected.installations);
    expect(existsSync(join(project, ".pi", "skills", "top-skill"))).toBe(false);
    expect(existsSync(join(project, ".pi", "skills", "right-skill"))).toBe(false);
    expect(existsSync(join(project, ".pi", "skills", "shared-base"))).toBe(true);
    expect(readFileSync(join(project, ".pi", "skills", "unrelated", "README.md"), "utf8")).toBe("keep\n");
  });

  test("combines Pi Skills with another Host through one ownership transaction", async () => {
    const home = temporaryDirectory("apk-pi-multi-host-home-");
    const project = temporaryDirectory("apk-pi-multi-host-project-");
    await writePiSkillWorkspace(
      home,
      project,
      ["review-pr"],
      [{ id: "review-pr", path: "relocated/review-pr" }],
      ["pi", "claude", "pi"],
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.binding.hosts).toEqual(["claude", "pi"]);
    expect(desired.installations[0]?.hostVersions.pi).toBe("native-project-append-system-skills-v1");
    expect(desired.installations[0]?.outputs.map((output) => output.path)).toEqual([
      ".claude/rules/agent-profile-kit.md",
      ".claude/skills/review-pr",
      ".pi/APPEND_SYSTEM.md",
      ".pi/skills/review-pr",
    ]);
    const applied = await applyReconciliation(home, desired.installations);
    expect(applied.resultingState.blockers).toEqual([]);
    const state = await readInstallationState(home);
    expect(state.installations[0]?.hosts).toEqual(["claude", "pi"]);
    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".pi", "skills", "review-pr", "SKILL.md"))).toBe(true);
    await uninstallApplication(home);
    expect(existsSync(join(project, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".pi", "skills", "review-pr"))).toBe(false);
  });

  test("projects disabled-model-invocation Pi Skills through the Installer lifecycle", async () => {
    const home = temporaryDirectory("apk-pi-disabled-home-");
    const project = temporaryDirectory("apk-pi-disabled-project-");
    await writePiSkillWorkspace(home, project, ["review-pr"], [
      { id: "review-pr", path: "review-pr" },
    ]);
    writeFileSync(
      join(home, ".agents", "agent-profile-kit", "workspace", "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Review\n",
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.blockers).toEqual([]);
    expect(desired.installations[0]?.hostVersions.pi).toBe(PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION);
    expect(desired.installations[0]?.outputs.map((output) => output.path)).toEqual([
      PI_CONTEXT_PATH,
      ".pi/skills/review-pr",
    ]);
    expect(existsSync(join(project, ".pi"))).toBe(false);

    await applyReconciliation(home, desired.installations);
    expect(readFileSync(join(project, ".pi", "skills", "review-pr", "SKILL.md"), "utf8")).toContain(
      "disable-model-invocation: true",
    );
    expect(readFileSync(join(home, ".agents", "agent-profile-kit", "workspace", "skills", "review-pr", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation: true",
    );
  });

  test("unowned exact planned Pi Skill destination blocks preflight without adoption", async () => {
    const home = temporaryDirectory("apk-pi-owned-destination-home-");
    const project = temporaryDirectory("apk-pi-owned-destination-project-");
    await writePiSkillWorkspace(home, project, ["review-pr"], [
      { id: "review-pr", path: "review-pr" },
    ]);
    const destination = join(project, ".pi", "skills", "review-pr");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "SKILL.md"), "foreign skill\n");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const preview = await previewReconciliation(desired.installations, {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 4,
    });

    expect(
      preview.blockers.some(
        (blocker) =>
          blocker.message.includes(".pi/skills/review-pr") &&
          blocker.message.toLowerCase().includes("unowned"),
      ),
    ).toBe(true);
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe("foreign skill\n");
  });

  test("Pi Skill selection plans only its binding without touching project or Installation State before apply", async () => {
    const home = temporaryDirectory("apk-pi-skill-home-");
    const project = temporaryDirectory("apk-pi-skill-project-");
    const unrelatedProject = temporaryDirectory("apk-pi-skill-unrelated-project-");
    await writeContextWorkspace(home, [
      { path: project, hosts: ["pi"] },
      { path: unrelatedProject, hosts: ["claude"], profile: "context-only" },
    ]);
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    const skill = join(workspace, "skills", "review-pr");
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(workspace, "profiles", "context-only.yaml"),
      "id: context-only\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(2);
    const piInstallation = desired.installations.find(
      (installation) => installation.binding.project === project,
    );
    expect(piInstallation?.blockers).toEqual([]);
    expect(piInstallation?.outputs.map((output) => output.path)).toEqual([".pi/APPEND_SYSTEM.md", ".pi/skills/review-pr"]);
    const unrelatedInstallation = desired.installations.find(
      (installation) => installation.binding.project === unrelatedProject,
    );
    expect(unrelatedInstallation?.blockers).toEqual([]);
    expect(unrelatedInstallation?.outputs.map((output) => output.path)).toEqual([
      ".claude/rules/agent-profile-kit.md",
    ]);
    expect(existsSync(join(project, ".pi"))).toBe(false);
    expect(existsSync(join(unrelatedProject, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".agents", "agent-profile-kit", "state"))).toBe(false);
  });

  test("status delegates later same-identity Pi material to Host Resolution", async () => {
    const home = temporaryDirectory("apk-pi-status-overlap-home-");
    const project = temporaryDirectory("apk-pi-status-overlap-project-");
    await writePiSkillWorkspace(home, project, ["review-pr"], [
      { id: "review-pr", path: "review-pr" },
    ]);
    const personal = join(home, ".agents", "skills", "foreign-review");
    mkdirSync(personal, { recursive: true });
    writeFileSync(
      join(personal, "SKILL.md"),
      "---\nname: review-pr\ndescription: Existing Skill.\n---\n\n# Existing\n",
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations.find(
      (candidate) => candidate.binding.project === project,
    );
    expect(installation?.blockers).toEqual([]);
    expect(installation?.warnings).toEqual([]);
  });

  test("status delegates later Pi extension settings to Host Resolution", async () => {
    const home = temporaryDirectory("apk-pi-status-settings-home-");
    const project = temporaryDirectory("apk-pi-status-settings-project-");
    await writePiSkillWorkspace(home, project, ["review-pr"], [
      { id: "review-pr", path: "review-pr" },
    ]);
    mkdirSync(join(project, ".pi"), { recursive: true });
    const settingsPath = join(project, ".pi", "settings.json");
    writeFileSync(settingsPath, '{"extensions":["./dynamic.ts"]}\n');

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations.find(
      (candidate) => candidate.binding.project === project,
    );
    expect(installation?.blockers).toEqual([]);
    expect(installation?.warnings).toEqual([]);
    expect(existsSync(join(project, ".pi", "skills", "review-pr"))).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe('{"extensions":["./dynamic.ts"]}\n');
  });

  test("status reports malformed relevant Pi settings as a warning", async () => {
    const home = temporaryDirectory("apk-pi-status-malformed-settings-home-");
    const project = temporaryDirectory("apk-pi-status-malformed-settings-project-");
    await writePiSkillWorkspace(home, project, ["review-pr"], [
      { id: "review-pr", path: "review-pr" },
    ]);
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), "{not json\n");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations.find(
      (candidate) => candidate.binding.project === project,
    );
    expect(installation?.blockers).toEqual([]);
    expect(installation?.warnings.some((warning) => /project settings.*JSON/i.test(warning))).toBe(
      true,
    );
  });

  test("valid symlinked Pi settings remain Host Resolution without false warnings", async () => {
    const home = temporaryDirectory("apk-pi-status-symlinked-settings-home-");
    const project = temporaryDirectory("apk-pi-status-symlinked-settings-project-");
    await writePiSkillWorkspace(home, project, ["review-pr"], [
      { id: "review-pr", path: "review-pr" },
    ]);
    mkdirSync(join(project, ".pi"), { recursive: true });
    const settingsSource = join(home, "pi-settings.json");
    writeFileSync(settingsSource, '{"skills":["!review-pr"],"extensions":["./extension.ts"]}\n');
    symlinkSync(settingsSource, join(project, ".pi", "settings.json"));

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations.find(
      (candidate) => candidate.binding.project === project,
    );
    expect(installation?.blockers).toEqual([]);
    expect(installation?.warnings).toEqual([]);
  });

  test("requires Pi 0.82.1+ and proves project surfaces for disabled model-invocation Skills", async () => {
    const home = temporaryDirectory("apk-pi-capability-home-");
    const project = temporaryDirectory("apk-pi-capability-");
    expect(parsePiCliVersion("pi 0.82.1\n")).toBe("0.82.1");
    expect(() => parsePiCliVersion("not-a-version")).toThrow(/unreadable/i);
    expect(PI_MINIMUM_CLI_VERSION).toBe("0.82.1");
    expect(() => assertPiCliVersionSupported("0.82.0")).toThrow(/requires 0\.82\.1\+/i);
    expect(() =>
      assertPiCliVersionSupported("0.82.0", { requireDisabledModelInvocation: true }),
    ).toThrow(/cannot enforce disabled model invocation/i);
    await expect(
      assertPiProjectCapability(project, { resolveVersion: async () => "0.82.1" }),
    ).resolves.toBeUndefined();

    writeFileSync(join(project, ".pi"), "not a directory\n");
    await expect(
      assertPiProjectCapability(project, { resolveVersion: async () => "0.82.1" }),
    ).rejects.toThrow(/\.pi.*file.*directory/i);

    rmSync(join(project, ".pi"));
    mkdirSync(join(project, ".pi", "APPEND_SYSTEM.md"), { recursive: true });
    await expect(
      assertPiProjectCapability(project, { resolveVersion: async () => "0.82.1" }),
    ).rejects.toThrow(/APPEND_SYSTEM\.md.*directory/i);

    expect(existsSync(join(project, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    await expect(
      assertPiProjectCapability(project, {
        home,
        requireSkills: true,
        resolveVersion: async () => "0.82.1",
      }),
    ).rejects.toThrow(/APPEND_SYSTEM\.md.*directory/i);
    rmSync(join(project, ".pi", "APPEND_SYSTEM.md"), { recursive: true, force: true });
    await expect(
      assertPiProjectCapability(project, {
        home,
        requireSkills: true,
        resolveVersion: async () => "0.82.1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertPiProjectCapability(project, {
        home,
        requireDisabledModelInvocation: true,
        resolveVersion: async () => "0.82.1",
      }),
    ).resolves.toBeUndefined();
    const source = join(home, "disabled-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Review\n",
    );
    await expect(
      planPiProject(
        "coding",
        [{ id: "team-rules", content: "Context\n" }],
        [{ dependencies: [], id: "review-pr", modelInvocation: "disabled", path: source }],
      ),
    ).resolves.toMatchObject({
      hostVersion: PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION,
    });
  });
});
