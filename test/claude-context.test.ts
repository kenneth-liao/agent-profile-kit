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
import { parse } from "yaml";

import {
  assertClaudeProjectCapability,
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_CONTEXT_RULE_PATH,
  CLAUDE_HOST_VERSION,
  planClaudeProject,
} from "../adapters/claude.js";
import { composeContextEnvelope } from "../adapters/context-envelope.js";
import { CODEX_ADAPTER_VERSION, CODEX_HOST_VERSION } from "../adapters/codex.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { readInstallationState } from "../installer/installation-state.js";
import {
  adapterVersionFor,
  buildDesiredState,
} from "../installer/project-plan.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { uninstallApplication } from "../installer/commands.js";
import { parseLocalConfiguration } from "../schemas/local-configuration.js";

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

function enableCodexHooks(home: string): void {
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

async function writeContextWorkspace(
  home: string,
  project: string,
  hosts: readonly string[],
  options: {
    readonly skills?: readonly string[];
    readonly body?: string;
  } = {},
): Promise<void> {
  await initializeWorkspace(home);
  enableCodexHooks(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    `---\nid: team-rules\ndependencies: []\n---\n${options.body ?? "Always preserve the project boundary.\n"}`,
  );
  for (const skillId of options.skills ?? []) {
    const skillRoot = join(workspace, "skills", skillId);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---\nname: ${skillId}\ndescription: Skill ${skillId}.\n---\n\n# ${skillId}\n`,
    );
  }
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    `id: coding\ncontext: [team-rules]\nskills: [${(options.skills ?? []).join(", ")}]\nagents: []\nhooks: []\ntools: []\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 1\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

describe("Claude Context Local Configuration", () => {
  test("accepts Claude-only and combined Codex/Claude Host selections and rejects duplicates and unknowns", () => {
    const claudeOnly = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [claude]\n",
      "config.yaml",
    );
    expect(claudeOnly.bindings[0]?.hosts).toEqual(["claude"]);

    const combined = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [codex, claude]\n",
      "config.yaml",
    );
    expect(combined.bindings[0]?.hosts).toEqual(["codex", "claude"]);

    expect(() =>
      parseLocalConfiguration(
        "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [claude, claude]\n",
        "config.yaml",
      ),
    ).toThrow("must not contain a Host more than once");

    expect(() =>
      parseLocalConfiguration(
        "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [cursor]\n",
        "config.yaml",
      ),
    ).toThrow("unsupported Agent Host 'cursor'");
  });
});

describe("Claude Adapter planner", () => {
  test("returns unscoped owned rule using the canonical Context envelope", async () => {
    const modules = [{ id: "team-rules", content: "Always preserve the project boundary.\n" }];
    const plan = await planClaudeProject("coding", modules);

    expect(plan.host).toBe("claude");
    expect(plan.hostVersion).toBe(CLAUDE_HOST_VERSION);
    expect(plan.outputs).toHaveLength(1);
    const output = plan.outputs[0];
    expect(output?.type).toBe("file");
    expect(output?.path).toBe(CLAUDE_CONTEXT_RULE_PATH);
    if (output?.type !== "file") throw new Error("expected file output");
    expect(output.bytes).toBe(composeContextEnvelope("coding", modules));
    expect(String(output.bytes)).not.toMatch(/^---\n/);
    expect(String(output.bytes)).not.toContain("paths:");
    expect(String(output.bytes)).toContain("Profile: coding");
    expect(String(output.bytes)).toContain("Repository-owned project instructions");
    expect(String(output.bytes)).toContain("<!-- Context Module: team-rules -->");
  });

  test("rejects Skills until Claude Skill delivery is supported", async () => {
    await expect(planClaudeProject("coding", [], { skillCount: 1 })).rejects.toThrow(
      "Claude Skill delivery is not supported yet",
    );
  });

  test("rejects non-directory .claude or .claude/rules project surfaces", async () => {
    const project = temporaryDirectory("apk-claude-surface-");
    writeFileSync(join(project, ".claude"), "not a directory\n");
    await expect(assertClaudeProjectCapability(project)).rejects.toThrow(
      "is a file, not a directory",
    );

    const project2 = temporaryDirectory("apk-claude-rules-file-");
    mkdirSync(join(project2, ".claude"));
    writeFileSync(join(project2, ".claude", "rules"), "not a directory\n");
    await expect(assertClaudeProjectCapability(project2)).rejects.toThrow(
      `${join(project2, ".claude", "rules")} is a file, not a directory`,
    );
  });
});

describe("Claude-only Profile Installation lifecycle", () => {
  test("installs unscoped Context rule, preserves Host state, and uninstalls owned output only", async () => {
    const home = temporaryDirectory("apk-claude-home-");
    const project = temporaryDirectory("apk-claude-project-");
    writeFileSync(join(project, "CLAUDE.md"), "project-owned instructions\n");
    mkdirSync(join(project, ".claude", "rules"), { recursive: true });
    writeFileSync(join(project, ".claude", "rules", "team.md"), "existing team rule\n");
    writeFileSync(join(project, ".claude", "settings.json"), '{"permissions":{}}\n');
    await writeContextWorkspace(home, project, ["claude"]);

    const desired = await buildDesiredState(home);
    expect(desired.installations).toHaveLength(1);
    const installation = desired.installations[0]!;
    expect(installation.binding.hosts).toEqual(["claude"]);
    expect(installation.hostVersions).toEqual({ claude: CLAUDE_HOST_VERSION });
    expect(installation.adapterVersion).toBe(CLAUDE_ADAPTER_VERSION);
    expect(installation.outputs.map((output) => output.path)).toEqual([CLAUDE_CONTEXT_RULE_PATH]);
    expect(installation.outputs.some((output) => output.path.includes("codex"))).toBe(false);

    const preview = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 2,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.desired[0]?.outputs).toContain(CLAUDE_CONTEXT_RULE_PATH);
    expect(preview.desired[0]?.context).toContain("# Agent Profile Kit Context");
    expect(preview.desired[0]?.context).toContain("Profile: coding");
    expect(preview.desired[0]?.context).toContain("<!-- Context Module: team-rules -->");
    expect(preview.desired[0]?.context).toBe(composeContextEnvelope("coding", [
      { id: "team-rules", content: "Always preserve the project boundary.\n" },
    ]));

    const report = await applyReconciliation(home, desired.installations);
    expect(report.items).toContainEqual({ kind: "addition", project });

    const rulePath = join(project, CLAUDE_CONTEXT_RULE_PATH);
    const rule = readFileSync(rulePath, "utf8");
    expect(rule).toBe(composeContextEnvelope("coding", [
      { id: "team-rules", content: "Always preserve the project boundary.\n" },
    ]));
    expect(rule).not.toMatch(/^---\n/);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned instructions\n");
    expect(readFileSync(join(project, ".claude", "rules", "team.md"), "utf8")).toBe("existing team rule\n");
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe('{"permissions":{}}\n');

    const state = await readInstallationState(home);
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.hosts).toEqual(["claude"]);
    expect(state.installations[0]?.hostVersions).toEqual({ claude: CLAUDE_HOST_VERSION });
    expect(state.installations[0]?.adapterVersion).toBe(CLAUDE_ADAPTER_VERSION);
    expect(state.installations[0]?.outputs.map((output) => output.path).sort()).toEqual([
      ".agent-profile-kit/installation.json",
      CLAUDE_CONTEXT_RULE_PATH,
    ].sort());

    const current = await buildDesiredState(home);
    const status = await previewReconciliation(current.installations, state);
    expect(status.items).toContainEqual({ kind: "current", project });

    expect(await uninstallApplication(home)).toBe(1);
    expect(existsSync(rulePath)).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned instructions\n");
    expect(readFileSync(join(project, ".claude", "rules", "team.md"), "utf8")).toBe("existing team rule\n");
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).toBe('{"permissions":{}}\n');
  });

  test("fails capability preflight when .claude is a file without writing", async () => {
    const home = temporaryDirectory("apk-claude-blocked-home-");
    const project = temporaryDirectory("apk-claude-blocked-project-");
    writeFileSync(join(project, ".claude"), "occupied\n");
    await writeContextWorkspace(home, project, ["claude"]);

    const desired = await buildDesiredState(home);
    expect(desired.installations[0]?.blockers.some((blocker) =>
      blocker.includes("is a file, not a directory")
    )).toBe(true);

    const report = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 2,
    });
    expect(report.blockers.some((blocker) => blocker.message.includes("is a file, not a directory"))).toBe(true);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit"))).toBe(false);
  });

  test("reports drift when the owned Claude rule is modified", async () => {
    const home = temporaryDirectory("apk-claude-drift-home-");
    const project = temporaryDirectory("apk-claude-drift-project-");
    await writeContextWorkspace(home, project, ["claude"]);
    const desired = await buildDesiredState(home);
    await applyReconciliation(home, desired.installations);

    writeFileSync(join(project, CLAUDE_CONTEXT_RULE_PATH), "tampered\n");
    const state = await readInstallationState(home);
    const status = await previewReconciliation(
      (await buildDesiredState(home)).installations,
      state,
    );
    expect(status.items.some((item) => item.kind === "drifted output")).toBe(true);
  });
});

describe("Combined Codex and Claude Profile Installation", () => {
  test("produces one normalized installation with both Hosts and host versions", async () => {
    const home = temporaryDirectory("apk-combined-home-");
    const project = temporaryDirectory("apk-combined-project-");
    writeFileSync(join(project, "CLAUDE.md"), "project-owned\n");
    writeFileSync(join(project, "AGENTS.md"), "repository-owned\n");
    await writeContextWorkspace(home, project, ["codex", "claude"]);

    const desired = await buildDesiredState(home);
    const installation = desired.installations[0]!;
    expect(installation.binding.hosts).toEqual(["codex", "claude"]);
    expect(installation.hostVersions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      codex: CODEX_HOST_VERSION,
    });
    expect(installation.adapterVersion).toBe(
      adapterVersionFor(["claude", "codex"]),
    );
    expect(installation.adapterVersion).toBe(
      [CLAUDE_ADAPTER_VERSION, CODEX_ADAPTER_VERSION].sort().join("+"),
    );
    const paths = installation.outputs.map((output) => output.path).sort();
    expect(paths).toEqual([
      ".agent-profile-kit/codex/context.md",
      ".claude/rules/agent-profile-kit.md",
      ".codex/hooks.json",
    ].sort());

    const report = await applyReconciliation(home, desired.installations);
    expect(report.items).toContainEqual({ kind: "addition", project });

    const claudeRule = readFileSync(join(project, CLAUDE_CONTEXT_RULE_PATH), "utf8");
    const codexContext = readFileSync(
      join(project, ".agent-profile-kit", "codex", "context.md"),
      "utf8",
    );
    expect(claudeRule).toBe(codexContext);
    expect(claudeRule).toContain("<!-- Context Module: team-rules -->");
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");

    const state = await readInstallationState(home);
    const manifest = state.installations[0]!;
    expect(manifest.hosts).toEqual(["codex", "claude"]);
    expect(manifest.hostVersions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      codex: CODEX_HOST_VERSION,
    });
    expect(manifest.adapterVersion).toBe(installation.adapterVersion);
    expect(manifest.outputs.map((output) => output.path)).toEqual(
      expect.arrayContaining([
        CLAUDE_CONTEXT_RULE_PATH,
        ".agent-profile-kit/codex/context.md",
        ".codex/hooks.json",
        ".agent-profile-kit/installation.json",
      ]),
    );

    // YAML round-trip of multi-host Manifest fields.
    const raw = parse(readFileSync(
      join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml"),
      "utf8",
    )) as {
      installations: Array<{
        adapter_version: string;
        hosts: string[];
        host_versions: Record<string, string>;
      }>;
    };
    expect(raw.installations[0]?.hosts).toEqual(["codex", "claude"]);
    expect(raw.installations[0]?.host_versions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      codex: CODEX_HOST_VERSION,
    });
    expect(raw.installations[0]?.adapter_version).toBe(installation.adapterVersion);

    expect(await uninstallApplication(home)).toBe(1);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
  });

  test("fails before writes when Claude is selected and the Profile includes Skills", async () => {
    const home = temporaryDirectory("apk-claude-skills-home-");
    const project = temporaryDirectory("apk-claude-skills-project-");
    await writeContextWorkspace(home, project, ["claude"], { skills: ["review-pr"] });

    await expect(buildDesiredState(home, { checkHostCapability: false })).rejects.toThrow(
      "Claude Skill delivery is not supported yet",
    );
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills"))).toBe(false);
  });

  test("fails before writes when combined Hosts select Skills until Claude Skill delivery exists", async () => {
    const home = temporaryDirectory("apk-combined-skills-home-");
    const project = temporaryDirectory("apk-combined-skills-project-");
    await writeContextWorkspace(home, project, ["codex", "claude"], { skills: ["review-pr"] });

    await expect(buildDesiredState(home, { checkHostCapability: false })).rejects.toThrow(
      "Claude Skill delivery is not supported yet",
    );
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
  });
});
