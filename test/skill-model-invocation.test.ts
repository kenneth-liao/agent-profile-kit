import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  assertClaudeCliVersionSupported,
  assertClaudeProjectCapability,
  emitClaudeSkillMarkdown,
  planClaudeProject,
  CLAUDE_HOST_VERSION,
  CLAUDE_HOST_VERSION_WITH_INVOCATION,
  CLAUDE_MINIMUM_CLI_VERSION,
} from "../adapters/claude.js";
import {
  assertCodexCliVersionSupportsDisabledModelInvocation,
  assertCodexProjectCapability,
  coalesceCodexInvocationPolicy,
  planCodexProject,
  CODEX_HOST_VERSION,
  CODEX_HOST_VERSION_WITH_INVOCATION,
  CODEX_MINIMUM_CLI_VERSION_FOR_DISABLED_MODEL_INVOCATION,
} from "../adapters/codex.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { parseSkill, type Skill } from "../schemas/skill.js";

const SKILL_PATH = "skills/to-spec/SKILL.md";
const SOURCE_PATH = "/tmp/workspace/skills/to-spec";

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

function skillAt(
  path: string,
  modelInvocation: Skill["modelInvocation"] = "allowed",
): Skill {
  return { dependencies: [], id: "to-spec", modelInvocation, path };
}

const DISABLED_BODY =
  "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n  author: maintainer\n---\n\n# To spec\n";

describe("Skill model-invocation policy", () => {
  test("normalizes absence of model-invocation metadata to allowed", () => {
    const skill = parseSkill(
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\n---\n\n# To spec\n",
      SKILL_PATH,
      SOURCE_PATH,
    );
    expect(skill.modelInvocation).toBe("allowed");
    expect(skill.id).toBe("to-spec");
  });

  test("accepts allowed and disabled string values under namespaced metadata", () => {
    const allowed = parseSkill(
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: allowed\n---\n\n# To spec\n",
      SKILL_PATH,
      SOURCE_PATH,
    );
    const disabled = parseSkill(
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# To spec\n",
      SKILL_PATH,
      SOURCE_PATH,
    );
    expect(allowed.modelInvocation).toBe("allowed");
    expect(disabled.modelInvocation).toBe("disabled");
  });

  test("rejects invalid model-invocation types and values at ingestion", () => {
    expect(() =>
      parseSkill(
        "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: maybe\n---\n\n# To spec\n",
        SKILL_PATH,
        SOURCE_PATH,
      ),
    ).toThrow("must be the string 'allowed' or 'disabled'");
    expect(() =>
      parseSkill(
        "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: true\n---\n\n# To spec\n",
        SKILL_PATH,
        SOURCE_PATH,
      ),
    ).toThrow("must be the string 'allowed' or 'disabled'");
  });

  test("preserves unrelated standard metadata while reading model-invocation", () => {
    const skill = parseSkill(DISABLED_BODY, SKILL_PATH, SOURCE_PATH);
    expect(skill.modelInvocation).toBe("disabled");
    // Unrelated metadata is not stripped from source; projection keeps author.
    const projected = emitClaudeSkillMarkdown("to-spec", DISABLED_BODY, "disabled");
    expect(projected).toContain("author: maintainer");
  });

  test("still rejects unknown top-level frontmatter including Claude-native disable-model-invocation", () => {
    expect(() =>
      parseSkill(
        "---\nname: to-spec\ndescription: Turn conversation into a spec.\ndisable-model-invocation: true\n---\n\n# To spec\n",
        SKILL_PATH,
        SOURCE_PATH,
      ),
    ).toThrow("does not allow fields: disable-model-invocation");
  });

  test("Claude Host projection emits disable-model-invocation only when disabled", () => {
    const allowedSource =
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\n---\n\n# To spec\n";
    expect(emitClaudeSkillMarkdown("to-spec", allowedSource, "allowed")).toBe(allowedSource);

    const projected = emitClaudeSkillMarkdown("to-spec", DISABLED_BODY, "disabled");
    expect(projected).toContain("disable-model-invocation: true");
    expect(projected).toContain("agent-profile-kit.model-invocation: disabled");
    expect(projected).toContain("author: maintainer");
    expect(projected).toContain("# To spec");
  });

  test("Codex Host projection coalesces equivalent openai.yaml policy and rejects conflicts", () => {
    const written = coalesceCodexInvocationPolicy("to-spec", "disabled", undefined);
    expect(written.action).toBe("write");
    if (written.action === "write") {
      const document = parse(written.bytes) as { policy: { allow_implicit_invocation: boolean } };
      expect(document.policy.allow_implicit_invocation).toBe(false);
    }

    const existingDisabled =
      "interface:\n  display_name: To Spec\npolicy:\n  allow_implicit_invocation: false\n";
    const leave = coalesceCodexInvocationPolicy("to-spec", "disabled", existingDisabled);
    expect(leave).toEqual({ action: "leave", bytes: existingDisabled });

    expect(() =>
      coalesceCodexInvocationPolicy(
        "to-spec",
        "disabled",
        "policy:\n  allow_implicit_invocation: true\n",
      ),
    ).toThrow("conflicting model-invocation authorities");

    expect(() =>
      coalesceCodexInvocationPolicy(
        "to-spec",
        "allowed",
        "policy:\n  allow_implicit_invocation: false\n",
      ),
    ).toThrow("conflicting model-invocation authorities");

    const leaveAllowed = coalesceCodexInvocationPolicy(
      "to-spec",
      "allowed",
      "interface:\n  display_name: To Spec\n",
    );
    expect(leaveAllowed.action).toBe("leave");

    const existingTrue =
      "interface:\n  display_name: To Spec\npolicy:\n  allow_implicit_invocation: true\n";
    const leaveTrue = coalesceCodexInvocationPolicy("to-spec", "allowed", existingTrue);
    expect(leaveTrue).toEqual({ action: "leave", bytes: existingTrue });
  });

  test("disabled Skill for Claude plans Host SKILL.md restriction without rewriting the Workspace package", async () => {
    const source = temporaryDirectory("apk-mi-claude-");
    writeSkillPackage(source, { "SKILL.md": { bytes: DISABLED_BODY } });
    const plan = await planClaudeProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skillAt(source, "disabled"),
    ]);
    const packageOutput = plan.outputs.find(
      (output) => output.type === "directory" && output.path === ".claude/skills/to-spec",
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
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(DISABLED_BODY);
    expect(packageOutput.requirements.some((item) => item.includes("disable-model-invocation"))).toBe(
      true,
    );
  });

  test("disabled Skill for Codex plans agents/openai.yaml restriction without rewriting the Workspace package", async () => {
    const source = temporaryDirectory("apk-mi-codex-");
    writeSkillPackage(source, {
      "SKILL.md": { bytes: DISABLED_BODY },
      "agents/openai.yaml": {
        bytes: "interface:\n  display_name: To Spec\n",
      },
    });
    const plan = await planCodexProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skillAt(source, "disabled"),
    ]);
    const packageOutput = plan.outputs.find(
      (output) => output.type === "directory" && output.path === ".agents/skills/to-spec",
    );
    expect(packageOutput?.type).toBe("directory");
    if (!packageOutput || packageOutput.type !== "directory") {
      throw new Error("expected Skill package");
    }
    const openAi = packageOutput.members.find((member) => member.path === "agents/openai.yaml");
    expect(openAi?.type).toBe("file");
    if (!openAi || openAi.type !== "file") throw new Error("expected openai.yaml");
    const generated = parse(Buffer.from(openAi.bytes).toString("utf8")) as {
      interface: { display_name: string };
      policy: { allow_implicit_invocation: boolean };
    };
    expect(generated.interface.display_name).toBe("To Spec");
    expect(generated.policy.allow_implicit_invocation).toBe(false);
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(DISABLED_BODY);
    expect(readFileSync(join(source, "agents", "openai.yaml"), "utf8")).toBe(
      "interface:\n  display_name: To Spec\n",
    );
  });

  test("allowed policy does not add Host restriction fields", async () => {
    const source = temporaryDirectory("apk-mi-allowed-");
    const body =
      "---\nname: to-spec\ndescription: Turn conversation into a spec.\nmetadata:\n  agent-profile-kit.model-invocation: allowed\n---\n\n# To spec\n";
    writeSkillPackage(source, { "SKILL.md": { bytes: body } });
    const claude = await planClaudeProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skillAt(source, "allowed"),
    ]);
    const codex = await planCodexProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skillAt(source, "allowed"),
    ]);
    const claudePkg = claude.outputs.find(
      (output) => output.type === "directory" && output.path === ".claude/skills/to-spec",
    );
    const codexPkg = codex.outputs.find(
      (output) => output.type === "directory" && output.path === ".agents/skills/to-spec",
    );
    if (!claudePkg || claudePkg.type !== "directory" || !codexPkg || codexPkg.type !== "directory") {
      throw new Error("expected packages");
    }
    const claudeMd = claudePkg.members.find((member) => member.path === "SKILL.md");
    if (!claudeMd || claudeMd.type !== "file") throw new Error("expected SKILL.md");
    expect(Buffer.from(claudeMd.bytes).toString("utf8")).toBe(body);
    expect(Buffer.from(claudeMd.bytes).toString("utf8")).not.toContain("disable-model-invocation");
    expect(codexPkg.members.some((member) => member.path === "agents/openai.yaml")).toBe(false);
  });

  test("conflicting Codex native policy fails during planning before writes", async () => {
    const source = temporaryDirectory("apk-mi-conflict-");
    writeSkillPackage(source, {
      "SKILL.md": { bytes: DISABLED_BODY },
      "agents/openai.yaml": {
        bytes: "policy:\n  allow_implicit_invocation: true\n",
      },
    });
    await expect(
      planCodexProject("coding", [{ id: "team-rules", content: "rules\n" }], [
        skillAt(source, "disabled"),
      ]),
    ).rejects.toThrow("conflicting model-invocation authorities");
  });

  test("combined Codex/Claude binding applies the same normalized disabled policy to both Host-native trees", async () => {
    const home = temporaryDirectory("apk-mi-combined-home-");
    const project = temporaryDirectory("apk-mi-combined-project-");
    await initializeWorkspace(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    const skillRoot = join(workspace, "skills", "to-spec");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(skillRoot, "SKILL.md"), DISABLED_BODY);
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [to-spec]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 1\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex, claude]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.hostVersions).toEqual({
      claude: CLAUDE_HOST_VERSION_WITH_INVOCATION,
      codex: CODEX_HOST_VERSION_WITH_INVOCATION,
    });
    const preview = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 2,
    });
    expect(preview.blockers).toEqual([]);
    await applyReconciliation(home, desired.installations);

    const claudeSkill = readFileSync(join(project, ".claude", "skills", "to-spec", "SKILL.md"), "utf8");
    expect(claudeSkill).toContain("disable-model-invocation: true");
    expect(claudeSkill).toContain("agent-profile-kit.model-invocation: disabled");
    const codexOpenAi = parse(
      readFileSync(join(project, ".agents", "skills", "to-spec", "agents", "openai.yaml"), "utf8"),
    ) as { policy: { allow_implicit_invocation: boolean } };
    expect(codexOpenAi.policy.allow_implicit_invocation).toBe(false);
    // Canonical Workspace source remains unchanged.
    expect(readFileSync(join(skillRoot, "SKILL.md"), "utf8")).toBe(DISABLED_BODY);
    expect(existsSync(join(skillRoot, "agents", "openai.yaml"))).toBe(false);
  });

  test("allowed Skills keep base Host capability contract tokens", async () => {
    const source = temporaryDirectory("apk-mi-allowed-version-");
    writeSkillPackage(source, {
      "SKILL.md": {
        bytes:
          "---\nname: to-spec\ndescription: Turn conversation into a spec.\n---\n\n# To spec\n",
      },
    });
    const claude = await planClaudeProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skillAt(source, "allowed"),
    ]);
    const codex = await planCodexProject("coding", [{ id: "team-rules", content: "rules\n" }], [
      skillAt(source, "allowed"),
    ]);
    expect(claude.hostVersion).toBe(CLAUDE_HOST_VERSION);
    expect(codex.hostVersion).toBe(CODEX_HOST_VERSION);
  });

  test("capability preflight rejects Host versions that cannot enforce disabled model invocation before writes", async () => {
    expect(() =>
      assertClaudeCliVersionSupported("2.0.63", { requireDisabledModelInvocation: true }),
    ).toThrow("cannot enforce disabled model invocation");
    expect(() => assertClaudeCliVersionSupported(CLAUDE_MINIMUM_CLI_VERSION, {
      requireDisabledModelInvocation: true,
    })).not.toThrow();

    expect(() => assertCodexCliVersionSupportsDisabledModelInvocation("0.71.0")).toThrow(
      "cannot enforce disabled model invocation",
    );
    expect(() =>
      assertCodexCliVersionSupportsDisabledModelInvocation(
        CODEX_MINIMUM_CLI_VERSION_FOR_DISABLED_MODEL_INVOCATION,
      ),
    ).not.toThrow();

    const home = temporaryDirectory("apk-mi-cap-home-");
    const project = temporaryDirectory("apk-mi-cap-project-");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");

    await expect(
      assertCodexProjectCapability(home, project, {
        requireDisabledModelInvocation: true,
        resolveVersion: async () => "0.10.0",
      }),
    ).rejects.toThrow("cannot enforce disabled model invocation");
    await expect(
      assertCodexProjectCapability(home, project, {
        requireDisabledModelInvocation: true,
        resolveVersion: async () => "0.144.0",
      }),
    ).resolves.toBeUndefined();
    // Without disabled Skills, Codex does not require a CLI version probe.
    await expect(assertCodexProjectCapability(home, project)).resolves.toBeUndefined();

    await expect(
      assertClaudeProjectCapability(project, {
        requireDisabledModelInvocation: true,
        resolveVersion: async () => "2.0.63",
      }),
    ).rejects.toThrow("cannot enforce disabled model invocation");
    await expect(
      assertClaudeProjectCapability(project, {
        requireDisabledModelInvocation: true,
        resolveVersion: async () => "2.1.0",
      }),
    ).resolves.toBeUndefined();
  });

  test("end-to-end: unsupported Codex CLI blocks preview and apply before project or state writes", async () => {
    const home = temporaryDirectory("apk-mi-e2e-home-");
    const project = temporaryDirectory("apk-mi-e2e-project-");
    await initializeWorkspace(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    // Old Codex stub that would discover Skills but ignore invocation policy.
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.10.0'\n");
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    chmodSync(join(bin, "codex"), 0o755);
    chmodSync(join(bin, "claude"), 0o755);

    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    mkdirSync(join(workspace, "skills", "to-spec"), { recursive: true });
    writeFileSync(join(workspace, "skills", "to-spec", "SKILL.md"), DISABLED_BODY);
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [to-spec]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 1\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
    );

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    try {
      const desired = await buildDesiredState(home);
      expect(desired.installations[0]?.blockers.some((blocker) =>
        blocker.includes("cannot enforce disabled model invocation"),
      )).toBe(true);
      const preview = await previewReconciliation(desired.installations, {
        installations: [],
        schemaVersion: 2,
      });
      expect(preview.blockers.length).toBeGreaterThan(0);
      expect(existsSync(join(project, ".agents", "skills", "to-spec"))).toBe(false);
      expect(existsSync(join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml"))).toBe(
        false,
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
