import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { isAdapterCapabilityError } from "../adapters/capability.js";
import { parseLocalConfiguration } from "../schemas/local-configuration.js";
import {
  ANTIGRAVITY_ADAPTER_VERSION,
  ANTIGRAVITY_CONTEXT_RULES_ROOT,
  ANTIGRAVITY_HOST_VERSION,
  ANTIGRAVITY_HOST_VERSION_WITH_CONTEXT_AND_SKILLS,
  ANTIGRAVITY_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION,
  ANTIGRAVITY_HOST_VERSION_WITH_INVOCATION,
  ANTIGRAVITY_HOST_VERSION_WITH_SKILLS,
  ANTIGRAVITY_MINIMUM_CLI_VERSION,
  ANTIGRAVITY_RULE_CHARACTER_LIMIT,
  assertAntigravityCliVersionSupported,
  assertAntigravityProjectCapability,
  assertAntigravityProjectSurface,
  parseAntigravityCliVersion,
  planAntigravityProject,
  probeAntigravityMachineCapability,
} from "../adapters/antigravity.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Antigravity Context Adapter", () => {
  test("accepts antigravity in canonical Host order", () => {
    const parsed = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: engineering\n    hosts: [pi, antigravity, claude, antigravity]\n",
      "config.yaml",
    );

    expect(parsed.bindings[0]?.hosts).toEqual(["antigravity", "claude", "pi"]);
  });

  test("normalizes agy versions and rejects malformed or too-old capability evidence", async () => {
    expect(parseAntigravityCliVersion("agy 1.1.13")).toBe("1.1.13");
    expect(parseAntigravityCliVersion("agy 1.2.0-alpha.1")).toBe("1.2.0");
    expect(await probeAntigravityMachineCapability({ resolveVersion: async () => "agy 1.1.14" })).toBe("1.1.14");
    expect(() => parseAntigravityCliVersion("agy version unavailable")).toThrow(
      /version is unreadable/i,
    );
    expect(() => assertAntigravityCliVersionSupported("1.1.12")).toThrow(
      new RegExp(`requires ${ANTIGRAVITY_MINIMUM_CLI_VERSION}\\+`),
    );
  });

  test("blocks one oversized Context Module instead of truncating it", async () => {
    let error: unknown;
    try {
      await planAntigravityProject("engineering", [{
        id: "oversized",
        content: "x".repeat(ANTIGRAVITY_RULE_CHARACTER_LIMIT),
      }], []);
    } catch (caught) {
      error = caught;
    }

    expect(isAdapterCapabilityError(error)).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/exceeding the 12000-character limit/i);
    expect((error as Error).message).not.toMatch(/truncat/i);
  });

  test("does not invent output or trust guidance for an empty Context plan", async () => {
    const plan = await planAntigravityProject("engineering", [], []);
    expect(plan.outputs).toEqual([]);
    expect(plan.setupSteps).toEqual([]);
  });

  test("splits total Context above the limit while preserving module boundaries", async () => {
    const modules = [
      { id: "first", content: "a".repeat(7_000) },
      { id: "second", content: "b".repeat(7_000) },
    ];
    const plan = await planAntigravityProject("engineering", modules, []);

    expect(plan.outputs).toHaveLength(3);
    expect(plan.outputs.every((output) => output.type === "file" && output.bytes.length <= ANTIGRAVITY_RULE_CHARACTER_LIMIT)).toBe(true);
    const first = plan.outputs[1];
    const second = plan.outputs[2];
    if (!first || first.type !== "file" || !second || second.type !== "file") throw new Error("expected module rules");
    expect(first.bytes).toContain(`<!-- Context Module: first -->\n${"a".repeat(7_000)}`);
    expect(second.bytes).toContain(`<!-- Context Module: second -->\n${"b".repeat(7_000)}`);
  });

  test("plans selected Skills through the qualified shared project surface", async () => {
    const source = temporaryDirectory("apkit-antigravity-skill-source-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );

    const plan = await planAntigravityProject("engineering", [], [{
      dependencies: [],
      id: "review-pr",
      modelInvocation: "allowed",
      path: source,
    }]);

    expect(plan.hostVersion).toBe(ANTIGRAVITY_HOST_VERSION_WITH_SKILLS);
    expect(plan.outputs.map((output) => output.path)).toEqual([
      ".agents/skills/review-pr",
    ]);
    const skill = plan.outputs[0];
    expect(skill?.type).toBe("directory");
    if (!skill || skill.type !== "directory") throw new Error("expected shared Skill package");
    expect(skill.members.map((member) => member.path)).toContain("SKILL.md");
  });

  test("plans selected Skills alongside Context at the desired-state boundary", async () => {
    const home = temporaryDirectory("apkit-antigravity-skills-home-");
    const project = temporaryDirectory("apkit-antigravity-skills-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    mkdirSync(join(workspace, "skills", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    writeFileSync(
      join(workspace, "context", "rules.md"),
      "---\nid: rules\ndependencies: []\n---\nKeep repository instructions authoritative.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [rules]\nskills: [review-pr]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [antigravity]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.capabilityWarnings).toEqual([]);
    expect(desired.installations[0]?.outputs.map((output) => output.path)).toContain(
      ".agents/skills/review-pr",
    );
  });

  test("records distinct Context and invocation Capability Contracts for shared Skills", async () => {
    const allowedSource = temporaryDirectory("apkit-antigravity-combined-skill-");
    writeFileSync(
      join(allowedSource, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    const allowed = await planAntigravityProject(
      "engineering",
      [{ id: "rules", content: "Keep project rules authoritative.\n" }],
      [{ dependencies: [], id: "review-pr", modelInvocation: "allowed", path: allowedSource }],
    );
    expect(allowed.hostVersion).toBe(ANTIGRAVITY_HOST_VERSION_WITH_CONTEXT_AND_SKILLS);

    const disabledSource = temporaryDirectory("apkit-antigravity-disabled-skill-");
    writeFileSync(
      join(disabledSource, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Review\n",
    );
    const disabled = await planAntigravityProject(
      "engineering",
      [{ id: "rules", content: "Keep project rules authoritative.\n" }],
      [{ dependencies: [], id: "review-pr", modelInvocation: "disabled", path: disabledSource }],
    );
    expect(disabled.hostVersion).toBe(ANTIGRAVITY_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION);
    const disabledPackage = disabled.outputs.find((output) => output.path === ".agents/skills/review-pr");
    if (!disabledPackage || disabledPackage.type !== "directory") throw new Error("expected shared Skill package");
    const skill = disabledPackage.members.find((member) => member.path === "SKILL.md");
    const policy = disabledPackage.members.find((member) => member.path === "agents/openai.yaml");
    expect(skill?.type).toBe("file");
    expect(policy?.type).toBe("file");
    if (skill?.type === "file") expect(String(skill.bytes)).toContain("disable-model-invocation: true");
    if (policy?.type === "file") expect(String(policy.bytes)).toContain("allow_implicit_invocation: false");
  });

  test("attributes contradictory shared policy to the Antigravity consumer", async () => {
    const source = temporaryDirectory("apkit-antigravity-policy-conflict-");
    mkdirSync(join(source, "agents"), { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    writeFileSync(
      join(source, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: true\n",
    );

    let error: unknown;
    try {
      await planAntigravityProject("engineering", [], [{
        dependencies: [],
        id: "review-pr",
        modelInvocation: "disabled",
        path: source,
      }]);
    } catch (caught) {
      error = caught;
    }
    expect(isAdapterCapabilityError(error)).toBe(true);
    if (isAdapterCapabilityError(error)) {
      expect(error.host).toBe("antigravity");
      expect(error.affectedItems[0]).toEqual({ kind: "host", value: "antigravity" });
      expect(error.message).toContain("conflicting model-invocation authorities");
    }
  });

  test("attributes a non-file shared policy path to the Antigravity consumer", async () => {
    const source = temporaryDirectory("apkit-antigravity-policy-directory-");
    mkdirSync(join(source, "agents", "openai.yaml"), { recursive: true });
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );

    let error: unknown;
    try {
      await planAntigravityProject("engineering", [], [{
        dependencies: [],
        id: "review-pr",
        modelInvocation: "allowed",
        path: source,
      }]);
    } catch (caught) {
      error = caught;
    }

    expect(isAdapterCapabilityError(error)).toBe(true);
    if (isAdapterCapabilityError(error)) {
      expect(error.host).toBe("antigravity");
      expect(error.affectedItems[0]).toEqual({ kind: "host", value: "antigravity" });
      expect(error.message).toContain("must be backed by a regular file");
    }
  });

  test("records the shared invocation contract for a disabled Skills-only Profile", async () => {
    const source = temporaryDirectory("apkit-antigravity-disabled-skills-only-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    const plan = await planAntigravityProject("engineering", [], [{
      dependencies: [],
      id: "review-pr",
      modelInvocation: "disabled",
      path: source,
    }]);
    expect(plan.hostVersion).toBe(ANTIGRAVITY_HOST_VERSION_WITH_INVOCATION);
  });

  test("normalizes shared invocation policy failures as Antigravity project Blockers", async () => {
    const home = temporaryDirectory("apkit-antigravity-policy-blocker-home-");
    const project = temporaryDirectory("apkit-antigravity-policy-blocker-project-");
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
      join(workspace, "profiles", "skills.yaml"),
      "id: skills\ncontext: []\nskills: [review-pr]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: skills\n    hosts: [antigravity]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    expect(installation?.outputs).toEqual([]);
    expect(installation?.capabilityWarnings).toHaveLength(1);
    expect(installation?.capabilityWarnings[0]).toMatchObject({
      host: "antigravity",
      warning: {
        copyableValues: [
          "antigravity",
          realpathSync(join(skillRoot, "agents", "openai.yaml")),
        ],
      },
    });
  });

  test("rejects rule indexes that would sort after earlier modules", async () => {
    const modules = Array.from({ length: 100 }, (_, index) => ({
      id: `module-${index}`,
      content: "module\n",
    }));

    await expect(planAntigravityProject("engineering", modules, [])).rejects.toThrow(
      /rule sequence.*cannot preserve stable lexical order/i,
    );
  });

  test("checks only required Context surfaces and rejects files or symlinks", async () => {
    const project = temporaryDirectory("apkit-antigravity-surface-project-");
    await expect(
      assertAntigravityProjectCapability(project, {
        requireContext: true,
        resolveVersion: async () => "1.1.13",
      }),
    ).resolves.toBeUndefined();

    writeFileSync(join(project, ".agents"), "repository material\n");
    await expect(assertAntigravityProjectSurface(project, { requireContext: true })).rejects.toThrow(
      /\.agents.*file.*directory/i,
    );
    rmSync(join(project, ".agents"));
    mkdirSync(join(project, ".agents"));
    writeFileSync(join(project, ".agents", "rules"), "repository material\n");
    await expect(assertAntigravityProjectSurface(project, { requireContext: true })).rejects.toThrow(
      /\.agents\/rules.*file.*directory/i,
    );
    rmSync(join(project, ".agents", "rules"));
    const target = temporaryDirectory("apkit-antigravity-surface-target-");
    symlinkSync(target, join(project, ".agents", "rules"));
    await expect(assertAntigravityProjectSurface(project, { requireContext: true })).rejects.toThrow(
      /\.agents\/rules.*symlink.*directory/i,
    );

    // A Context-free check does not inspect surfaces that this plan does not need.
    await expect(assertAntigravityProjectSurface(project, { requireContext: false })).resolves.toBeUndefined();

    const skillsProject = temporaryDirectory("apkit-antigravity-skills-surface-project-");
    await expect(
      assertAntigravityProjectCapability(skillsProject, {
        requireContext: false,
        requireSkills: true,
        resolveVersion: async () => "1.1.13",
      }),
    ).resolves.toBeUndefined();
    writeFileSync(join(skillsProject, ".agents"), "repository material\n");
    await expect(
      assertAntigravityProjectSurface(skillsProject, {
        requireContext: false,
        requireSkills: true,
      }),
    ).rejects.toThrow(/\.agents.*file.*directory/i);
    rmSync(join(skillsProject, ".agents"));
    mkdirSync(join(skillsProject, ".agents"));
    writeFileSync(join(skillsProject, ".agents", "skills"), "repository material\n");
    await expect(
      assertAntigravityProjectSurface(skillsProject, {
        requireContext: false,
        requireSkills: true,
      }),
    ).rejects.toThrow(/\.agents\/skills.*file.*directory/i);
  });

  test("plans Antigravity Context through the ordinary desired-state boundary", async () => {
    const home = temporaryDirectory("apkit-antigravity-desired-home-");
    const project = temporaryDirectory("apkit-antigravity-desired-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "rules.md"),
      "---\nid: rules\ndependencies: []\n---\nKeep repository instructions authoritative.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [antigravity]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    expect(installation?.binding.hosts).toEqual(["antigravity"]);
    expect(installation?.adapterVersion).toBe(ANTIGRAVITY_ADAPTER_VERSION);
    expect(installation?.hostVersions.antigravity).toBe(ANTIGRAVITY_HOST_VERSION);
    expect(installation?.outputs.map((output) => output.path)).toEqual([
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-000-envelope.md`,
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-010-rules.md`,
    ]);
  });

  test("normalizes an oversized rule into a structured project Blocker before writes", async () => {
    const home = temporaryDirectory("apkit-antigravity-oversized-home-");
    const project = temporaryDirectory("apkit-antigravity-oversized-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "oversized.md"),
      `---\nid: oversized\ndependencies: []\n---\n${"x".repeat(ANTIGRAVITY_RULE_CHARACTER_LIMIT)}\n`,
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [oversized]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [antigravity]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.outputs).toEqual([]);
    expect(desired.installations[0]?.capabilityWarnings[0]?.warning.message).toContain(
      "exceeding the 12000-character limit",
    );
  });

  test("plans one always-on envelope and one complete rule per Context Module", async () => {
    const plan = await planAntigravityProject("engineering", [
      { id: "communication", content: "Prefer concise communication.\n" },
      { id: "engineering", content: "Use safe changes.\n" },
    ], []);

    expect(plan.host).toBe("antigravity");
    expect(plan.hostVersion).toBe(ANTIGRAVITY_HOST_VERSION);
    expect(plan.outputs.map((output) => output.path)).toEqual([
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-000-envelope.md`,
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-010-communication.md`,
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-020-engineering.md`,
    ]);
    expect(plan.setupSteps).toEqual([{
      consequence: "The Profile does not load until the project is trusted.",
      kind: "trust-required",
      message: "Trust the bound project in Antigravity.",
      provenance: "standing",
    }]);

    for (const [index, output] of plan.outputs.entries()) {
      expect(output.type).toBe("file");
      if (output.type !== "file") continue;
      expect(output.bytes.length).toBeLessThanOrEqual(ANTIGRAVITY_RULE_CHARACTER_LIMIT);
      expect(output.bytes).toContain("trigger: always_on");
      if (index === 0) {
        expect(output.bytes).toContain("Profile: engineering");
        expect(output.bytes).toContain("Repository-owned project instructions");
      }
    }

    const communication = plan.outputs[1];
    if (!communication || communication.type !== "file") throw new Error("expected communication rule");
    expect(communication.bytes).toContain("<!-- Context Module: communication -->");
    expect(communication.bytes).toContain("Prefer concise communication.\n<!-- End Context Module: communication -->");
    expect(communication.origins).toEqual([{ id: "communication", type: "context" }]);
  });
});
