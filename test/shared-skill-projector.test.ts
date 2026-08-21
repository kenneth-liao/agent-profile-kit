import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { isAdapterCapabilityError } from "../adapters/capability.js";
import {
  coalesceSharedSkillPolicy,
  planSharedSkillPackageDirectory,
  SHARED_SKILL_OPENAI_YAML,
  SHARED_SKILLS_DISCOVERY_ROOT,
} from "../adapters/shared-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
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

function skillAt(path: string, modelInvocation: Skill["modelInvocation"]): Skill {
  return { dependencies: [], id: "review-pr", modelInvocation, path };
}

describe("shared .agents Skill projector", () => {
  test("preserves package members and Codex metadata while adding the stable disabled policy union", async () => {
    const source = temporaryDirectory("apk-shared-skill-disabled-");
    const sourceSkill =
      "---\nname: review-pr\ndescription: Review a pull request.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n  author: maintainer\n---\n\n# Review\n";
    const interfaceYaml =
      "interface:\n  display_name: Review PR\ndependencies:\n  - helper\n";
    const script = "#!/bin/sh\necho review\n";
    writeSkillPackage(source, {
      "SKILL.md": { bytes: sourceSkill, mode: 0o644 },
      "agents/openai.yaml": { bytes: interfaceYaml, mode: 0o600 },
      "scripts/run.sh": { bytes: script, mode: 0o755 },
      "agent-profile-kit.yaml": { bytes: "dependencies: []\n" },
    });

    const output = await planSharedSkillPackageDirectory(
      skillAt(source, "disabled"),
      ["qualified shared Skill package"],
      "codex",
    );

    expect(output.path).toBe(`${SHARED_SKILLS_DISCOVERY_ROOT}/review-pr`);
    expect(output.requirements).toContain(
      "Shared .agents Skill policy prevents implicit invocation in SKILL.md and Codex agents/openai.yaml",
    );
    expect(output.members.some((member) => member.path === "agent-profile-kit.yaml")).toBe(false);

    const skillMember = output.members.find((member) => member.path === "SKILL.md");
    expect(skillMember?.type).toBe("file");
    if (!skillMember || skillMember.type !== "file") throw new Error("expected SKILL.md");
    const generatedSkill = Buffer.from(skillMember.bytes).toString("utf8");
    const generatedFrontmatterEnd = generatedSkill.indexOf("---\n", 4);
    expect(parse(generatedSkill.slice(4, generatedFrontmatterEnd))).toMatchObject({
      name: "review-pr",
      metadata: {
        "agent-profile-kit.model-invocation": "disabled",
        author: "maintainer",
      },
      "disable-model-invocation": true,
    });
    expect(generatedSkill).toContain("# Agent Profile Kit:");

    const openAiMember = output.members.find((member) => member.path === "agents/openai.yaml");
    expect(openAiMember?.type).toBe("file");
    if (!openAiMember || openAiMember.type !== "file") throw new Error("expected openai.yaml");
    const generatedOpenAi = Buffer.from(openAiMember.bytes).toString("utf8");
    expect(parse(generatedOpenAi)).toEqual({
      interface: { display_name: "Review PR" },
      dependencies: ["helper"],
      policy: { allow_implicit_invocation: false },
    });
    expect(generatedOpenAi).toContain("# Agent Profile Kit:");

    const scriptMember = output.members.find((member) => member.path === "scripts/run.sh");
    expect(scriptMember).toMatchObject({ mode: 0o755, type: "file" });
    if (!scriptMember || scriptMember.type !== "file") throw new Error("expected script");
    expect(Buffer.from(scriptMember.bytes).toString("utf8")).toBe(script);
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(sourceSkill);
    expect(readFileSync(join(source, "agents", "openai.yaml"), "utf8")).toBe(interfaceYaml);
  });

  test("rejects malformed, wrong-type, and contradictory Codex policy as one typed authority failure", () => {
    const skill = skillAt("/workspace/skills/review-pr", "disabled");
    const sources = [
      "not: [valid",
      "policy: []\n",
      "policy:\n  allow_implicit_invocation: true\n",
    ];
    for (const source of sources) {
      let caught: unknown;
      try {
        coalesceSharedSkillPolicy({ ...skill, consumerHost: "codex" }, source);
      } catch (error) {
        caught = error;
      }
      expect(isAdapterCapabilityError(caught)).toBe(true);
      if (!isAdapterCapabilityError(caught)) continue;
      expect(caught.message).toContain("canonical Workspace metadata.agent-profile-kit.model-invocation");
      expect(caught.message).toContain(`${SHARED_SKILL_OPENAI_YAML} policy.allow_implicit_invocation`);
      expect(caught.remedy).toContain("Repair the canonical Workspace Skill 'review-pr'");
      expect(caught.affectedItems).toEqual([
        { kind: "host", value: "codex" },
        { kind: "path", value: "/workspace/skills/review-pr/agents/openai.yaml" },
      ]);
    }
  });

  test("turns a Codex policy conflict into one project-scoped blocker before reconciliation", async () => {
    const home = temporaryDirectory("apk-shared-skill-blocker-home-");
    const project = temporaryDirectory("apk-shared-skill-blocker-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    const skillRoot = join(workspace, "skills", "review-pr");
    mkdirSync(join(skillRoot, "agents"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Review\n",
    );
    writeFileSync(
      join(skillRoot, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: []\nskills: [review-pr]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected desired installation");
    expect(installation.outputs.some((output) => output.path === ".agents/skills/review-pr")).toBe(false);
    expect(installation.blockers).toHaveLength(1);
    expect(installation.blockers[0]).toMatchObject({
      affectedItems: [
        { kind: "host", value: "codex" },
        { kind: "path", value: join(realpathSync(skillRoot), "agents", "openai.yaml") },
      ],
      kind: "host-capability",
      project: realpathSync(project),
      scope: "project",
    });
    expect(installation.blockers[0]?.problem).toContain("canonical Workspace metadata.agent-profile-kit.model-invocation");
    expect(installation.blockers[0]?.problem).toContain("agents/openai.yaml policy.allow_implicit_invocation");
    expect(installation.blockers[0]?.remedy).toContain("Repair the canonical Workspace Skill 'review-pr'");
  });

  test("allowed invocation preserves the portable package without generated restrictions", async () => {
    const source = temporaryDirectory("apk-shared-skill-allowed-");
    const sourceSkill =
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n";
    const existingOpenAi =
      "interface:\n  display_name: Review PR\npolicy:\n  allow_implicit_invocation: true\n";
    writeSkillPackage(source, {
      "SKILL.md": { bytes: sourceSkill },
      "agents/openai.yaml": { bytes: existingOpenAi },
    });

    const output = await planSharedSkillPackageDirectory(
      skillAt(source, "allowed"),
      ["qualified shared Skill package"],
      "codex",
    );
    const skillMember = output.members.find((member) => member.path === "SKILL.md");
    const openAiMember = output.members.find((member) => member.path === "agents/openai.yaml");
    if (!skillMember || skillMember.type !== "file") throw new Error("expected SKILL.md");
    if (!openAiMember || openAiMember.type !== "file") throw new Error("expected openai.yaml");
    expect(Buffer.from(skillMember.bytes).toString("utf8")).toBe(sourceSkill);
    expect(Buffer.from(openAiMember.bytes).toString("utf8")).toBe(existingOpenAi);
    expect(output.members.some((member) => member.path === "disable-model-invocation")).toBe(false);
    expect(output.requirements).toEqual(["qualified shared Skill package"]);
  });
});
