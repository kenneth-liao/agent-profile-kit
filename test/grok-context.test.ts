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

import { CLAUDE_CONTEXT_RULE_PATH, CLAUDE_HOST_VERSION } from "../adapters/claude.js";
import { CODEX_ADAPTER_VERSION, CODEX_HOST_VERSION } from "../adapters/codex.js";
import { composeContextEnvelope } from "../adapters/context-envelope.js";
import {
  assertGrokCliVersionSupported,
  assertGrokProjectCapability,
  GROK_ADAPTER_VERSION,
  GROK_CONTEXT_RULE_PATH,
  GROK_HOST_VERSION,
  GROK_MINIMUM_CLI_VERSION,
  parseGrokCliVersion,
  parseGrokInspectClaudeRulesEnabled,
  planGrokProject,
  resolveGrokContextRulePath,
} from "../adapters/grok.js";
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

function inspectJson(claudeRulesEnabled: boolean): string {
  return JSON.stringify({
    grokVersion: "0.2.111",
    externalCompat: {
      remoteSettingsLoaded: false,
      cells: [
        {
          vendor: "claude",
          surface: "rules",
          enabled: claudeRulesEnabled,
          source: "default",
        },
      ],
    },
    projectInstructions: [],
  });
}

function installFakeGrok(
  home: string,
  options: {
    readonly version?: string;
    readonly claudeRulesEnabled?: boolean;
    readonly inspectBody?: string;
    readonly inspectExit?: number;
  } = {},
): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const version = options.version ?? "0.2.111";
  const body = options.inspectBody ?? inspectJson(options.claudeRulesEnabled ?? true);
  const exit = options.inspectExit ?? 0;
  // Hermetic stub: version + inspect --json only.
  writeFileSync(
    join(bin, "grok"),
    `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "grok ${version} (fake) [stable]"
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then
  cat <<'EOF'
${body}
EOF
  exit ${exit}
fi
echo "unexpected grok invocation: $*" >&2
exit 2
`,
  );
  chmodSync(join(bin, "grok"), 0o755);
  return bin;
}

const supportedGrokInspection = async () => ({
  claudeRulesEnabled: true,
  version: "0.2.111",
});

describe("Grok Context Local Configuration", () => {
  test("accepts Grok-only and three-Host bindings, normalizes order, rejects duplicates and unknowns", () => {
    const grokOnly = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [grok]\n",
      "config.yaml",
    );
    expect(grokOnly.bindings[0]?.hosts).toEqual(["grok"]);

    const three = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [grok, codex, claude]\n",
      "config.yaml",
    );
    expect(three.bindings[0]?.hosts).toEqual(["claude", "codex", "grok"]);

    const reversed = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [codex, grok, claude]\n",
      "config.yaml",
    );
    expect(reversed.bindings[0]?.hosts).toEqual(three.bindings[0]?.hosts);

    expect(() =>
      parseLocalConfiguration(
        "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [grok, grok]\n",
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

describe("Grok Adapter planner", () => {
  test("returns unscoped owned rule under .grok/rules using the canonical Context envelope", async () => {
    const modules = [{ id: "team-rules", content: "Always preserve the project boundary.\n" }];
    const plan = await planGrokProject("coding", modules);

    expect(plan.host).toBe("grok");
    expect(plan.hostVersion).toBe(GROK_HOST_VERSION);
    expect(plan.outputs).toHaveLength(1);
    const output = plan.outputs[0];
    expect(output?.type).toBe("file");
    expect(output?.path).toBe(GROK_CONTEXT_RULE_PATH);
    if (output?.type !== "file") throw new Error("expected file output");
    expect(output.bytes).toBe(composeContextEnvelope("coding", modules));
    expect(String(output.bytes)).not.toMatch(/^---\n/);
    expect(String(output.bytes)).toContain("Profile: coding");
    expect(String(output.bytes)).toContain("Repository-owned project instructions");
    expect(String(output.bytes)).toContain("<!-- Context Module: team-rules -->");
  });

  test("selects the Claude rule path when Claude is co-selected and Claude rules are enabled", async () => {
    expect(
      resolveGrokContextRulePath({ claudeCoSelected: true, claudeRulesEnabled: true }),
    ).toBe(CLAUDE_CONTEXT_RULE_PATH);
    expect(
      resolveGrokContextRulePath({ claudeCoSelected: true, claudeRulesEnabled: false }),
    ).toBe(GROK_CONTEXT_RULE_PATH);
    expect(resolveGrokContextRulePath({ claudeCoSelected: false })).toBe(GROK_CONTEXT_RULE_PATH);

    const modules = [{ id: "team-rules", content: "Always preserve the project boundary.\n" }];
    const plan = await planGrokProject("coding", modules, {
      claudeCoSelected: true,
      claudeRulesEnabled: true,
    });
    expect(plan.outputs[0]?.path).toBe(CLAUDE_CONTEXT_RULE_PATH);
    if (plan.outputs[0]?.type !== "file") throw new Error("expected file");
    expect(plan.outputs[0].bytes).toBe(composeContextEnvelope("coding", modules));
  });

  test("rejects non-directory .grok or .grok/rules project surfaces", async () => {
    const project = temporaryDirectory("apk-grok-surface-");
    writeFileSync(join(project, ".grok"), "not a directory\n");
    await expect(
      assertGrokProjectCapability(project, {
        inspect: supportedGrokInspection,
        resolveVersion: async () => "0.2.111",
      }),
    ).rejects.toThrow("is a file, not a directory");

    const project2 = temporaryDirectory("apk-grok-rules-file-");
    mkdirSync(join(project2, ".grok"));
    writeFileSync(join(project2, ".grok", "rules"), "not a directory\n");
    await expect(
      assertGrokProjectCapability(project2, {
        inspect: supportedGrokInspection,
        resolveVersion: async () => "0.2.111",
      }),
    ).rejects.toThrow(`${join(project2, ".grok", "rules")} is a file, not a directory`);
  });

  test("rejects missing, unreadable, unsupported, and malformed Grok CLI/inspect before writes", async () => {
    const project = temporaryDirectory("apk-grok-version-");
    expect(parseGrokCliVersion("grok 0.2.111 (94172f2aa4e5) [stable]")).toBe("0.2.111");
    expect(() => parseGrokCliVersion("not-a-version")).toThrow("unreadable");
    expect(GROK_MINIMUM_CLI_VERSION).toBe("0.2.0");
    expect(() => assertGrokCliVersionSupported("0.1.9")).toThrow(
      `requires ${GROK_MINIMUM_CLI_VERSION}+`,
    );
    assertGrokCliVersionSupported("0.2.0");
    assertGrokCliVersionSupported("0.2.111");

    expect(parseGrokInspectClaudeRulesEnabled(inspectJson(true))).toBe(true);
    expect(parseGrokInspectClaudeRulesEnabled(inspectJson(false))).toBe(false);
    expect(() => parseGrokInspectClaudeRulesEnabled("{")).toThrow("not valid JSON");
    expect(() => parseGrokInspectClaudeRulesEnabled("{}")).toThrow("missing externalCompat");

    await expect(
      assertGrokProjectCapability(project, {
        env: { ...process.env, PATH: temporaryDirectory("apk-empty-path-") },
      }),
    ).rejects.toThrow("Grok CLI was not found on PATH");

    await expect(
      assertGrokProjectCapability(project, {
        resolveVersion: async () => "0.1.0",
      }),
    ).rejects.toThrow("does not support project rules inspection");

    await expect(
      assertGrokProjectCapability(project, {
        resolveVersion: async () => "0.2.111",
        inspect: async () => {
          throw new Error(
            "Grok inspect --json output is not valid JSON; upgrade Grok Build or fix the CLI before previewing or applying the Profile",
          );
        },
      }),
    ).rejects.toThrow("not valid JSON");

    const inspection = await assertGrokProjectCapability(project, {
      resolveVersion: async () => "0.2.111",
      inspect: supportedGrokInspection,
    });
    expect(inspection.claudeRulesEnabled).toBe(true);
  });
});

describe("Grok-only Profile Installation lifecycle", () => {
  test("installs unscoped Context rule, preserves Host/project state, and uninstalls owned output only", async () => {
    const home = temporaryDirectory("apk-grok-home-");
    const project = temporaryDirectory("apk-grok-project-");
    writeFileSync(join(project, "AGENTS.md"), "repository-owned instructions\n");
    mkdirSync(join(project, ".grok", "rules"), { recursive: true });
    writeFileSync(join(project, ".grok", "rules", "team.md"), "existing team rule\n");
    writeFileSync(join(project, ".grok", "config.toml"), "theme = \"dark\"\n");
    await writeContextWorkspace(home, project, ["grok"]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(1);
    const installation = desired.installations[0]!;
    expect(installation.binding.hosts).toEqual(["grok"]);
    expect(installation.hostVersions).toEqual({ grok: GROK_HOST_VERSION });
    expect(installation.adapterVersion).toBe(GROK_ADAPTER_VERSION);
    expect(installation.outputs.map((output) => output.path)).toEqual([GROK_CONTEXT_RULE_PATH]);
    expect(installation.outputs.some((output) => output.path.includes("claude"))).toBe(false);
    expect(installation.outputs.some((output) => output.path.includes("codex"))).toBe(false);

    const preview = await previewReconciliation(desired.installations, {
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 3,
    });
    expect(preview.blockers).toEqual([]);
    expect(preview.desired[0]?.outputs).toContain(GROK_CONTEXT_RULE_PATH);
    expect(preview.desired[0]?.context).toBe(
      composeContextEnvelope("coding", [
        { id: "team-rules", content: "Always preserve the project boundary.\n" },
      ]),
    );

    const report = await applyReconciliation(home, desired.installations);
    expect(report.items).toContainEqual({ kind: "addition", project });

    const rulePath = join(project, GROK_CONTEXT_RULE_PATH);
    const rule = readFileSync(rulePath, "utf8");
    expect(rule).toBe(
      composeContextEnvelope("coding", [
        { id: "team-rules", content: "Always preserve the project boundary.\n" },
      ]),
    );
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned instructions\n");
    expect(readFileSync(join(project, ".grok", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
    expect(readFileSync(join(project, ".grok", "config.toml"), "utf8")).toBe('theme = "dark"\n');

    const state = await readInstallationState(home);
    expect(state.installations).toHaveLength(1);
    expect(state.installations[0]?.hosts).toEqual(["grok"]);
    expect(state.installations[0]?.hostVersions).toEqual({ grok: GROK_HOST_VERSION });
    expect(state.installations[0]?.adapterVersion).toBe(GROK_ADAPTER_VERSION);
    expect(state.installations[0]?.outputs.map((output) => output.path).sort()).toEqual(
      [".agent-profile-kit/installation.json", GROK_CONTEXT_RULE_PATH].sort(),
    );

    const current = await buildDesiredState(home, { checkHostCapability: false });
    const status = await previewReconciliation(current.installations, state);
    expect(status.items).toContainEqual({ kind: "current", project });

    expect(await uninstallApplication(home)).toBe(1);
    expect(existsSync(rulePath)).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned instructions\n");
    expect(readFileSync(join(project, ".grok", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
    expect(readFileSync(join(project, ".grok", "config.toml"), "utf8")).toBe('theme = "dark"\n');
  });

  test("fails capability preflight when .grok is a file without writing", async () => {
    const home = temporaryDirectory("apk-grok-blocked-home-");
    const project = temporaryDirectory("apk-grok-blocked-project-");
    writeFileSync(join(project, ".grok"), "occupied\n");
    await writeContextWorkspace(home, project, ["grok"]);

    const previousPath = process.env.PATH ?? "";
    const bin = installFakeGrok(home);
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const desired = await buildDesiredState(home);
      expect(
        desired.installations[0]?.blockers.some((blocker) =>
          blocker.includes("is a file, not a directory"),
        ),
      ).toBe(true);

      const report = await previewReconciliation(desired.installations, {
        installations: [],
        repositoryExclusions: [],
        schemaVersion: 3,
      });
      expect(
        report.blockers.some((blocker) => blocker.message.includes("is a file, not a directory")),
      ).toBe(true);
      expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
      expect(existsSync(join(project, ".agent-profile-kit"))).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("fails closed before writes when the resolved Profile contains Skills", async () => {
    const home = temporaryDirectory("apk-grok-skills-home-");
    const project = temporaryDirectory("apk-grok-skills-project-");
    await writeContextWorkspace(home, project, ["grok"], { skills: ["review-pr"] });

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(
      desired.installations[0]?.blockers.some((blocker) =>
        blocker.includes("Grok portable Skill delivery is not supported yet"),
      ),
    ).toBe(true);
    const report = await previewReconciliation(desired.installations, {
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 3,
    });
    expect(
      report.blockers.some((blocker) =>
        blocker.message.includes("Grok portable Skill delivery is not supported yet"),
      ),
    ).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit"))).toBe(false);
  });

  test("reports drift when the owned Grok rule is modified", async () => {
    const home = temporaryDirectory("apk-grok-drift-home-");
    const project = temporaryDirectory("apk-grok-drift-project-");
    await writeContextWorkspace(home, project, ["grok"]);
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);

    writeFileSync(join(project, GROK_CONTEXT_RULE_PATH), "tampered\n");
    const state = await readInstallationState(home);
    const status = await previewReconciliation(
      (await buildDesiredState(home, { checkHostCapability: false })).installations,
      state,
    );
    expect(status.items.some((item) => item.kind === "drifted output")).toBe(true);
  });
});

describe("Combined Claude/Grok and three-Host Profile Installation", () => {
  test("coalesces Claude and Grok onto one Context rule when Claude rules are enabled", async () => {
    const home = temporaryDirectory("apk-claude-grok-home-");
    const project = temporaryDirectory("apk-claude-grok-project-");
    writeFileSync(join(project, "CLAUDE.md"), "project-owned\n");
    writeFileSync(join(project, "AGENTS.md"), "repository-owned\n");
    await writeContextWorkspace(home, project, ["claude", "grok"]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    expect(installation.binding.hosts).toEqual(["claude", "grok"]);
    expect(installation.hostVersions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      grok: GROK_HOST_VERSION,
    });
    const paths = installation.outputs.map((output) => output.path).sort();
    expect(paths).toEqual([CLAUDE_CONTEXT_RULE_PATH]);
    expect(installation.outputs[0]?.consumingHosts).toEqual(["claude", "grok"]);
    expect(paths).not.toContain(GROK_CONTEXT_RULE_PATH);

    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
    expect(readFileSync(join(project, CLAUDE_CONTEXT_RULE_PATH), "utf8")).toContain(
      "<!-- Context Module: team-rules -->",
    );
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");

    const state = await readInstallationState(home);
    expect(state.installations[0]?.hosts).toEqual(["claude", "grok"]);
    expect(state.installations[0]?.hostVersions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      grok: GROK_HOST_VERSION,
    });

    expect(await uninstallApplication(home)).toBe(1);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
  });

  test("uses .grok/rules when Claude is co-selected but Claude rules compatibility is disabled", async () => {
    const home = temporaryDirectory("apk-claude-grok-disabled-home-");
    const project = temporaryDirectory("apk-claude-grok-disabled-project-");
    await writeContextWorkspace(home, project, ["claude", "grok"]);

    const previousPath = process.env.PATH ?? "";
    const bin = installFakeGrok(home, { claudeRulesEnabled: false });
    // Claude capability is not under test; skip via checkHostCapability false after
    // probing Grok inspection only through plan options by using pure plans.
    // Drive desired state with capability on so inspect supplies the disabled cell.
    // Provide a Claude stub so Claude capability also passes.
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const desired = await buildDesiredState(home);
      expect(desired.installations[0]?.blockers).toEqual([]);
      const paths = desired.installations[0]?.outputs.map((output) => output.path).sort() ?? [];
      expect(paths).toEqual([CLAUDE_CONTEXT_RULE_PATH, GROK_CONTEXT_RULE_PATH].sort());
      const grokOutput = desired.installations[0]?.outputs.find(
        (output) => output.path === GROK_CONTEXT_RULE_PATH,
      );
      const claudeOutput = desired.installations[0]?.outputs.find(
        (output) => output.path === CLAUDE_CONTEXT_RULE_PATH,
      );
      expect(grokOutput?.consumingHosts).toEqual(["grok"]);
      expect(claudeOutput?.consumingHosts).toEqual(["claude"]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("produces one three-Host installation with Codex, Claude, and Grok outputs", async () => {
    const home = temporaryDirectory("apk-three-host-home-");
    const project = temporaryDirectory("apk-three-host-project-");
    writeFileSync(join(project, "CLAUDE.md"), "project-owned\n");
    writeFileSync(join(project, "AGENTS.md"), "repository-owned\n");
    await writeContextWorkspace(home, project, ["codex", "claude", "grok"]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    expect(installation.binding.hosts).toEqual(["claude", "codex", "grok"]);
    expect(installation.hostVersions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      codex: CODEX_HOST_VERSION,
      grok: GROK_HOST_VERSION,
    });
    expect(installation.adapterVersion).toBe(adapterVersionFor(["claude", "codex", "grok"]));
    expect(installation.adapterVersion).toBe(
      ["claude-project-v1", CODEX_ADAPTER_VERSION, GROK_ADAPTER_VERSION].sort().join("+"),
    );

    const paths = installation.outputs.map((output) => output.path).sort();
    expect(paths).toEqual(
      [
        ".agent-profile-kit/codex/context.md",
        CLAUDE_CONTEXT_RULE_PATH,
        ".codex/hooks.json",
      ].sort(),
    );
    expect(paths).not.toContain(GROK_CONTEXT_RULE_PATH);
    const claudeRule = installation.outputs.find((output) => output.path === CLAUDE_CONTEXT_RULE_PATH);
    expect(claudeRule?.consumingHosts).toEqual(["claude", "grok"]);

    const report = await applyReconciliation(home, desired.installations);
    expect(report.items).toContainEqual({ kind: "addition", project });
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");

    const state = await readInstallationState(home);
    const manifest = state.installations[0]!;
    expect(manifest.hosts).toEqual(["claude", "codex", "grok"]);
    expect(manifest.hostVersions).toEqual({
      claude: CLAUDE_HOST_VERSION,
      codex: CODEX_HOST_VERSION,
      grok: GROK_HOST_VERSION,
    });

    const raw = parse(
      readFileSync(join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml"), "utf8"),
    ) as {
      installations: Array<{
        adapter_version: string;
        hosts: string[];
        host_versions: Record<string, string>;
      }>;
    };
    expect(raw.installations[0]?.hosts).toEqual(["claude", "codex", "grok"]);
    expect(raw.installations[0]?.host_versions.grok).toBe(GROK_HOST_VERSION);

    expect(await uninstallApplication(home)).toBe(1);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
  });
});
