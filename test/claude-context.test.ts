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
  CLAUDE_ADAPTER_VERSION,
  CLAUDE_CONTEXT_RULE_PATH,
  CLAUDE_HOST_VERSION,
  CLAUDE_MINIMUM_CLI_VERSION,
  parseClaudeCliVersion,
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
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

const supportedClaudeVersion = async () => "2.1.0";

describe("Claude Context Local Configuration", () => {
  test("accepts Claude-only and combined Codex/Claude Host selections and normalizes duplicates", () => {
    const claudeOnly = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [claude]\n",
      "config.yaml",
    );
    expect(claudeOnly.bindings[0]?.hosts).toEqual(["claude"]);

    const combined = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [codex, claude]\n",
      "config.yaml",
    );
    // Hosts are a set: authored order is normalized at ingestion.
    expect(combined.bindings[0]?.hosts).toEqual(["claude", "codex"]);

    const reversed = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [claude, codex]\n",
      "config.yaml",
    );
    expect(reversed.bindings[0]?.hosts).toEqual(combined.bindings[0]?.hosts);

    const duplicate = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [claude, claude]\n",
      "config.yaml",
    );
    expect(duplicate.bindings[0]?.hosts).toEqual(["claude"]);

    expect(() =>
      parseLocalConfiguration(
        "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [cursor]\n",
        "config.yaml",
      ),
    ).toThrow("unsupported Agent Host 'cursor'");
  });

  test("accepts version-1 Workspace selections as migration input", () => {
    const without = parseLocalConfiguration(
      "schema_version: 1\nbindings: []\n",
      "config.yaml",
    );
    expect(without.workspace).toBeUndefined();
    expect(without.schemaVersion).toBe(1);

    const withWorkspace = parseLocalConfiguration(
      "schema_version: 1\nworkspace: ~/projects/agent-profile-workspace\nbindings: []\n",
      "config.yaml",
    );
    expect(withWorkspace.workspace).toBe("~/projects/agent-profile-workspace");

    expect(() =>
      parseLocalConfiguration(
        "schema_version: 1\nworkspace: ''\nbindings: []\n",
        "config.yaml",
      ),
    ).toThrow(/workspace must be a non-empty string/);

    expect(() =>
      parseLocalConfiguration(
        "schema_version: 1\nworkspace: ~/projects/agent-profile-workspace\nbindings: []\nextra: true\n",
        "config.yaml",
      ),
    ).toThrow(/does not allow fields: extra/);
  });

  test("requires an explicit Workspace path in version 2 while retaining version 1 as migration input", () => {
    const legacy = parseLocalConfiguration(
      "schema_version: 1\nbindings: []\n",
      "config.yaml",
    );
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.workspace).toBeUndefined();

    const current = parseLocalConfiguration(
      "schema_version: 2\nworkspace: ~/.agents/agent-profile-kit/workspace\nbindings: []\n",
      "config.yaml",
    );
    expect(current.schemaVersion).toBe(2);
    expect(current.workspace).toBe("~/.agents/agent-profile-kit/workspace");

    expect(() =>
      parseLocalConfiguration(
        "schema_version: 2\nbindings: []\n",
        "config.yaml",
      ),
    ).toThrow(/workspace.*required/i);
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

  test("plans Context without Skills when the Profile selects none", async () => {
    const plan = await planClaudeProject("coding", [
      { id: "team-rules", content: "Always preserve the project boundary.\n" },
    ]);
    expect(plan.outputs).toHaveLength(1);
    expect(plan.outputs[0]?.path).toBe(CLAUDE_CONTEXT_RULE_PATH);
  });

  test("rejects non-directory .claude or .claude/rules project surfaces", async () => {
    const project = temporaryDirectory("apk-claude-surface-");
    writeFileSync(join(project, ".claude"), "not a directory\n");
    await expect(
      assertClaudeProjectCapability(project, { resolveVersion: supportedClaudeVersion }),
    ).rejects.toThrow("is a file, not a directory");

    const project2 = temporaryDirectory("apk-claude-rules-file-");
    mkdirSync(join(project2, ".claude"));
    writeFileSync(join(project2, ".claude", "rules"), "not a directory\n");
    await expect(
      assertClaudeProjectCapability(project2, { resolveVersion: supportedClaudeVersion }),
    ).rejects.toThrow(
      `${join(project2, ".claude", "rules")} is a file, not a directory`,
    );
  });

  test("rejects missing, unreadable, and unsupported Claude CLI versions before writes", async () => {
    const project = temporaryDirectory("apk-claude-version-");
    expect(parseClaudeCliVersion("2.1.209 (Claude Code)")).toBe("2.1.209");
    expect(() => parseClaudeCliVersion("not-a-version")).toThrow("unreadable");
    // Evidence-backed boundary: .claude/rules landed in Claude Code 2.0.64.
    expect(CLAUDE_MINIMUM_CLI_VERSION).toBe("2.0.64");
    expect(() => assertClaudeCliVersionSupported("2.0.63")).toThrow(
      `requires ${CLAUDE_MINIMUM_CLI_VERSION}+`,
    );
    expect(() => assertClaudeCliVersionSupported("1.0.0")).toThrow(
      "does not support unscoped project rules",
    );
    assertClaudeCliVersionSupported("2.0.64");
    assertClaudeCliVersionSupported("2.1.0");

    await expect(
      assertClaudeProjectCapability(project, {
        env: { ...process.env, PATH: temporaryDirectory("apk-empty-path-") },
      }),
    ).rejects.toThrow("Claude Code CLI was not found on PATH");

    await expect(
      assertClaudeProjectCapability(project, {
        resolveVersion: async () => "2.0.63",
      }),
    ).rejects.toThrow("does not support unscoped project rules");

    await expect(
      assertClaudeProjectCapability(project, {
        resolveVersion: async () => "2.0.64",
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertClaudeProjectCapability(project, { resolveVersion: supportedClaudeVersion }),
    ).resolves.toBeUndefined();
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

    // Capability version probing is covered separately; lifecycle uses the pure plan path.
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(1);
    const installation = desired.installations[0]!;
    expect(installation.binding.hosts).toEqual(["claude"]);
    expect(installation.hostVersions).toEqual({ claude: CLAUDE_HOST_VERSION });
    expect(installation.adapterVersion).toBe(CLAUDE_ADAPTER_VERSION);
    expect(installation.outputs.map((output) => output.path)).toEqual([CLAUDE_CONTEXT_RULE_PATH]);
    expect(installation.outputs.some((output) => output.path.includes("codex"))).toBe(false);

    const preview = await previewReconciliation(desired.installations, {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      temporaryInstallations: [],
      schemaVersion: 5,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.desired[0]?.hosts).toEqual(["claude"]);
    expect(preview.desired[0]?.outputs).toContain(CLAUDE_CONTEXT_RULE_PATH);
    expect(preview.desired[0]?.context).toContain("# Agent Profile Kit Context");
    expect(preview.desired[0]?.context).toContain("Profile: coding");
    expect(preview.desired[0]?.context).toContain("<!-- Context Module: team-rules -->");
    expect(preview.desired[0]?.context).toBe(composeContextEnvelope("coding", [
      { id: "team-rules", content: "Always preserve the project boundary.\n" },
    ]));

    const report = await applyReconciliation(home, desired.installations);
    expect(report.receipt.items).toContainEqual({ kind: "addition", project });

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

    const current = await buildDesiredState(home, { checkHostCapability: false });
    const status = await previewReconciliation(current.installations, state);
    expect(status.items).toContainEqual({ kind: "current", project });

    expect((await uninstallApplication(home)).projects).toHaveLength(1);
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

    const previousPath = process.env.PATH ?? "";
    const bin = temporaryDirectory("apk-claude-bin-");
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const desired = await buildDesiredState(home);
      expect(desired.installations[0]?.blockers.some((blocker) =>
        blocker.includes("is a file, not a directory")
      )).toBe(true);

      const report = await previewReconciliation(desired.installations, {
        intendedTeardowns: [],
        installations: [],
        repositoryExclusions: [],
        temporaryInstallations: [],
        schemaVersion: 5,
      });
      expect(report.blockers.some((blocker) => blocker.message.includes("is a file, not a directory"))).toBe(true);
      expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
      expect(existsSync(join(project, ".agent-profile-kit"))).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("reports drift when the owned Claude rule is modified", async () => {
    const home = temporaryDirectory("apk-claude-drift-home-");
    const project = temporaryDirectory("apk-claude-drift-project-");
    await writeContextWorkspace(home, project, ["claude"]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);

    writeFileSync(join(project, CLAUDE_CONTEXT_RULE_PATH), "tampered\n");
    const state = await readInstallationState(home);
    const status = await previewReconciliation(
      (await buildDesiredState(home, { checkHostCapability: false })).installations,
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

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    // Hosts normalized at ingestion regardless of authored order [codex, claude].
    expect(installation.binding.hosts).toEqual(["claude", "codex"]);
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
    expect(report.receipt.items).toContainEqual({ kind: "addition", project });

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
    expect(manifest.hosts).toEqual(["claude", "codex"]);
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
    expect(raw.installations[0]?.hosts).toEqual(["claude", "codex"]);
    expect(raw.installations[0]?.host_versions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      codex: CODEX_HOST_VERSION,
    });
    expect(raw.installations[0]?.adapter_version).toBe(installation.adapterVersion);

    expect((await uninstallApplication(home)).projects).toHaveLength(1);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
  });

  test("Claude-only Profile with Skills plans Context and .claude/skills packages together", async () => {
    const home = temporaryDirectory("apk-claude-skills-home-");
    const project = temporaryDirectory("apk-claude-skills-project-");
    await writeContextWorkspace(home, project, ["claude"], { skills: ["review-pr"] });

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const paths = desired.installations[0]?.outputs.map((output) => output.path).sort() ?? [];
    expect(paths).toContain(CLAUDE_CONTEXT_RULE_PATH);
    expect(paths).toContain(".claude/skills/review-pr");
    expect(paths.some((path) => path.startsWith(".agents/skills/"))).toBe(false);
  });

  test("combined Hosts with Skills plan both Host-native Skill trees without fail-closed rejection", async () => {
    const home = temporaryDirectory("apk-combined-skills-home-");
    const project = temporaryDirectory("apk-combined-skills-project-");
    await writeContextWorkspace(home, project, ["codex", "claude"], { skills: ["review-pr"] });

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const paths = desired.installations[0]?.outputs.map((output) => output.path) ?? [];
    expect(paths).toContain(CLAUDE_CONTEXT_RULE_PATH);
    expect(paths).toContain(".claude/skills/review-pr");
    expect(paths).toContain(".agents/skills/review-pr");
    expect(paths).toContain(".codex/hooks.json");
  });
});
