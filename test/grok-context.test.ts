import { afterAll, describe, expect, test } from "bun:test";
import { OWNERSHIP_STATE_SCHEMA_VERSION } from "../schemas/ownership-state.js";
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
  inferGrokClaudeRulesEnabledFromOutputs,
  inspectGrokProject,
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
import { statusApplication, uninstallApplication } from "../installer/commands.js";
import { parseLocalConfiguration } from "../schemas/local-configuration.js";
import { installerErrorSentence } from "../cli/error-wording.js";
import { flatInlineText } from "../cli/inline-content.js";

/** Parse Local Configuration and return its presentation-owned rejection sentence. */
function localConfigurationRejectionSentence(source: string, path = "config.yaml"): string {
  try {
    parseLocalConfiguration(source, path);
  } catch (error) {
    const typed = installerErrorSentence(error);
    if (typed !== undefined) return flatInlineText(typed);
    if (error instanceof Error) return error.message;
  }
  throw new Error("expected parseLocalConfiguration to reject the source");
}
import {
  reportBlockers,
  reportDesired,
  reportItems,
} from "./support/reconciliation-report.js";
import { blockerWording } from "../cli/blocker-wording.js";

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
    `id: coding\ncontext: [team-rules]\nskills: [${(options.skills ?? []).join(", ")}]\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

function inspectJson(
  claudeRulesEnabled: boolean,
  options: { readonly omitSkills?: boolean; readonly skills?: unknown } = {},
): string {
  const document: Record<string, unknown> = {
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
  };
  if (!options.omitSkills) {
    document.skills = options.skills ?? [];
  }
  return JSON.stringify(document);
}

function installFakeGrok(
  home: string,
  options: {
    readonly version?: string;
    readonly claudeRulesEnabled?: boolean;
    readonly inspectBody?: string;
    readonly inspectExit?: number;
    readonly inspectStderr?: string;
  } = {},
): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const version = options.version ?? "0.2.111";
  const body = options.inspectBody ?? inspectJson(options.claudeRulesEnabled ?? true);
  const exit = options.inspectExit ?? 0;
  const stderrLine = options.inspectStderr
    ? `echo ${JSON.stringify(options.inspectStderr)} >&2\n`
    : "";
  // Hermetic stub: version + inspect --json only.
  writeFileSync(
    join(bin, "grok"),
    `#!/bin/sh
if [ "$1" = "version" ]; then
  echo "grok ${version} (fake) [stable]"
  exit 0
fi
if [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then
  ${stderrLine}cat <<'EOF'
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
  claudeSkillsEnabled: true,
  cursorSkillsEnabled: true,
  skills: [],
  skillsDisabledNames: [],
  skillsExtraPaths: [],
  skillsIgnorePaths: [],
  version: "0.2.111",
});

describe("Grok Context Local Configuration", () => {
  test("accepts Grok-only and three-Host bindings and normalizes duplicates", () => {
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

    const duplicate = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [grok, grok]\n",
      "config.yaml",
    );
    expect(duplicate.bindings[0]?.hosts).toEqual(["grok"]);

    expect(
      localConfigurationRejectionSentence(
        "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [cursor]\n",
      ),
    ).toBe(
      "Local Configuration config.yaml bindings[0] hosts[0] unsupported Agent Host 'cursor'; supported Hosts: antigravity, claude, codex, grok, opencode, pi",
    );
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
    expect(String(output.bytes)).not.toContain("<!-- Context Module:");
    expect(plan.setupSteps).toEqual([]);
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
    const plan = await planGrokProject("coding", modules, [], {
      claudeCoSelected: true,
      claudeRulesEnabled: true,
    });
    expect(plan.outputs[0]?.path).toBe(CLAUDE_CONTEXT_RULE_PATH);
    if (plan.outputs[0]?.type !== "file") throw new Error("expected file");
    expect(plan.outputs[0].bytes).toBe(composeContextEnvelope("coding", modules));
    expect(plan.setupSteps).toEqual([{
      kind: "shared-path",
      message:
        `Grok uses Profile Context from Claude's shared rule path: ${CLAUDE_CONTEXT_RULE_PATH}.`,
      provenance: "standing",
    }]);

    const compatibilityDisabled = await planGrokProject("coding", modules, [], {
      claudeCoSelected: true,
      claudeRulesEnabled: false,
    });
    expect(compatibilityDisabled.setupSteps).toEqual([]);
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
            "Grok inspect --json output is not valid JSON; upgrade Grok Build or fix the CLI before checking status or applying the Profile",
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

  test("inspect parses valid stdout even when stderr carries diagnostics", async () => {
    const home = temporaryDirectory("apk-grok-stderr-home-");
    const project = temporaryDirectory("apk-grok-stderr-project-");
    const previousPath = process.env.PATH ?? "";
    const bin = installFakeGrok(home, {
      claudeRulesEnabled: false,
      inspectStderr: "warning: slow config load",
    });
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const inspection = await inspectGrokProject(project, {
        resolveVersion: async () => "0.2.111",
      });
      expect(inspection.claudeRulesEnabled).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("infers applied Claude rules topology from prior installation outputs", () => {
    expect(
      inferGrokClaudeRulesEnabledFromOutputs(
        ["claude", "grok"],
        [CLAUDE_CONTEXT_RULE_PATH, GROK_CONTEXT_RULE_PATH],
      ),
    ).toBe(false);
    expect(
      inferGrokClaudeRulesEnabledFromOutputs(["claude", "grok"], [CLAUDE_CONTEXT_RULE_PATH]),
    ).toBe(true);
    expect(inferGrokClaudeRulesEnabledFromOutputs(["grok"], [GROK_CONTEXT_RULE_PATH])).toBe(
      undefined,
    );
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
    expect(installation.hostVersions.grok).toBe(GROK_HOST_VERSION);
    expect(installation.adapterVersion).toBe(GROK_ADAPTER_VERSION);
    expect(installation.outputs.map((output) => output.path)).toEqual([GROK_CONTEXT_RULE_PATH]);
    expect(installation.outputs.some((output) => output.path.includes("claude"))).toBe(false);
    expect(installation.outputs.some((output) => output.path.includes("codex"))).toBe(false);

    const preview = await previewReconciliation(desired.installations, {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
    });
    expect(reportBlockers(preview)).toEqual([]);
    expect(reportDesired(preview)[0]?.outputs).toContain(GROK_CONTEXT_RULE_PATH);
    expect(reportDesired(preview)[0]?.context).toBe(
      composeContextEnvelope("coding", [
        { id: "team-rules", content: "Always preserve the project boundary.\n" },
      ]),
    );

    const report = await applyReconciliation(home, desired.installations);
    expect(reportItems(report.receipt)).toContainEqual({ kind: "addition", project });

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
    expect(state.receipts).toHaveLength(1);
    expect(Object.keys((state.receipts[0]?.hosts) ?? {})).toEqual(["grok"]);
    expect(state.receipts[0]?.hosts.grok?.capabilityContract).toBe(GROK_HOST_VERSION);
    expect(state.receipts[0]?.hosts.grok?.adapterVersion).toBe(GROK_ADAPTER_VERSION);
    expect(state.receipts[0]?.outputs.map((output) => output.path).sort()).toEqual(
      [GROK_CONTEXT_RULE_PATH],
    );

    const current = await buildDesiredState(home, { checkHostCapability: false });
    const status = await previewReconciliation(current.installations, state);
    expect(reportItems(status)).toContainEqual({ kind: "current", project });

    expect((await uninstallApplication(home)).projects).toHaveLength(1);
    expect(existsSync(rulePath)).toBe(false);
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned instructions\n");
    expect(readFileSync(join(project, ".grok", "rules", "team.md"), "utf8")).toBe(
      "existing team rule\n",
    );
    expect(readFileSync(join(project, ".grok", "config.toml"), "utf8")).toBe('theme = "dark"\n');
  });

  test("reports an occupied .grok surface as a warning and an occupied-output blocker without writing", async () => {
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
        desired.installations[0]?.capabilityWarnings.some((entry) =>
          entry.warning.message.includes("is a file, not a directory"),
        ),
      ).toBe(true);

      const report = await previewReconciliation(desired.installations, {
        receipts: [],
        removedTemporaryInstallationIds: [],
        schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
      });
      // The write itself stays blocked by occupied-output ownership, not by probing.
      expect(
        reportBlockers(report).some((blocker) =>
          blockerWording(blocker).message.includes("is an occupied other parent path"),
        ),
      ).toBe(true);
      expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
      expect(existsSync(join(project, ".agent-profile-kit"))).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("plans resolved Skills under .grok/skills for Grok-only Profiles", async () => {
    const home = temporaryDirectory("apk-grok-skills-home-");
    const project = temporaryDirectory("apk-grok-skills-project-");
    await writeContextWorkspace(home, project, ["grok"], { skills: ["review-pr"] });

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.capabilityWarnings).toEqual([]);
    const skillPaths = desired.installations[0]?.outputs
      .filter((output) => output.type === "directory")
      .map((output) => output.path)
      .sort();
    expect(skillPaths).toEqual([".grok/skills/review-pr"]);
    expect(desired.installations[0]?.outputs.some((output) => output.path === GROK_CONTEXT_RULE_PATH))
      .toBe(true);
    expect(desired.installations[0]?.hostVersions.grok).toBe(
      "native-project-unscoped-rules-skills-v1",
    );

    const report = await previewReconciliation(desired.installations, {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
    });
    expect(reportBlockers(report)).toEqual([]);
    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, ".grok", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(true);
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
    expect(reportItems(status).some((item) => item.kind === "drifted output")).toBe(true);
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
    expect(installation.setupSteps).toContainEqual({
      host: "grok",
      kind: "shared-path",
      message:
        `Grok uses Profile Context from Claude's shared rule path: ${CLAUDE_CONTEXT_RULE_PATH}.`,
      provenance: "standing",
    });

    await applyReconciliation(home, desired.installations);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
    expect(readFileSync(join(project, CLAUDE_CONTEXT_RULE_PATH), "utf8")).toContain(
      "Always preserve the project boundary.",
    );
    expect(readFileSync(join(project, CLAUDE_CONTEXT_RULE_PATH), "utf8")).not.toContain(
      "<!-- Context Module:",
    );
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");

    const state = await readInstallationState(home);
    expect(Object.keys((state.receipts[0]?.hosts) ?? {})).toEqual(["claude", "grok"]);
    expect(state.receipts[0]?.hosts.claude?.capabilityContract).toBe(CLAUDE_HOST_VERSION);
    expect(state.receipts[0]?.hosts.grok?.capabilityContract).toBe(GROK_HOST_VERSION);

    expect((await uninstallApplication(home)).projects).toHaveLength(1);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
  });

  test("uses .grok/rules when Claude is co-selected but Claude rules compatibility is disabled", async () => {
    const home = temporaryDirectory("apk-claude-grok-disabled-home-");
    const project = temporaryDirectory("apk-claude-grok-disabled-project-");
    await writeContextWorkspace(home, project, ["claude", "grok"]);

    const previousPath = process.env.PATH ?? "";
    const bin = installFakeGrok(home, { claudeRulesEnabled: false });
    // Drive desired state with capability on so inspect supplies the disabled cell.
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const desired = await buildDesiredState(home);
      expect(desired.installations[0]?.capabilityWarnings).toEqual([]);
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
      expect(desired.installations[0]?.setupSteps).not.toContainEqual(
        expect.objectContaining({ host: "grok", kind: "shared-path" }),
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("status preserves dual-path topology without probing after compatibility-disabled apply", async () => {
    const home = temporaryDirectory("apk-status-topology-home-");
    const project = temporaryDirectory("apk-status-topology-project-");
    await writeContextWorkspace(home, project, ["claude", "grok"]);

    const previousPath = process.env.PATH ?? "";
    const goodBin = installFakeGrok(home, { claudeRulesEnabled: false });
    writeFileSync(join(goodBin, "claude"), "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    chmodSync(join(goodBin, "claude"), 0o755);
    process.env.PATH = `${goodBin}:${previousPath}`;
    try {
      const desired = await buildDesiredState(home);
      expect(desired.installations[0]?.capabilityWarnings).toEqual([]);
      await applyReconciliation(home, desired.installations);
      expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);
      expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(true);

      // Break inspect so topology inference must come from the applied Manifest
      // alone; status never probes, so it must stay correct without any Host run.
      writeFileSync(
        join(goodBin, "grok"),
        "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then echo 'grok 0.2.111 (fake) [stable]'; exit 0; fi\necho broken >&2; exit 1\n",
      );
      chmodSync(join(goodBin, "grok"), 0o755);

      const status = await statusApplication(home);
      expect(reportBlockers(status)).toEqual([]);
      expect(reportItems(status)).toContainEqual({ kind: "current", project });
      // Topology is preserved from the applied Manifest, not guessed as coalesced,
      // and status resolves it without executing any Agent Host process.
      const after = await buildDesiredState(home, {
        checkHostCapability: false,
        previousInstallations: (await readInstallationState(home)).receipts,
      });
      const paths = after.installations[0]?.outputs.map((output) => output.path).sort() ?? [];
      expect(paths).toEqual([CLAUDE_CONTEXT_RULE_PATH, GROK_CONTEXT_RULE_PATH].sort());
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("validate does not probe Grok when capability checks are disabled", async () => {
    const home = temporaryDirectory("apk-validate-probe-home-");
    const project = temporaryDirectory("apk-validate-probe-project-");
    await writeContextWorkspace(home, project, ["claude", "grok"]);
    const emptyPath = temporaryDirectory("apk-empty-path-");
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = emptyPath;
    try {
      // No Grok/Claude on PATH; validate must remain probe-free.
      const desired = await buildDesiredState(home, { checkHostCapability: false });
      expect(desired.installations[0]?.capabilityWarnings).toEqual([]);
      expect(desired.installations[0]?.outputs.map((output) => output.path)).toEqual([
        CLAUDE_CONTEXT_RULE_PATH,
      ]);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("Context-free Claude+Grok status does not require Grok topology inspection", async () => {
    const home = temporaryDirectory("apk-context-free-status-home-");
    const project = temporaryDirectory("apk-context-free-status-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    // Skills-only Profile: no Context rule topology for Claude or Grok.
    const skillRoot = join(workspace, "skills", "review-pr");
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\n# review-pr\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: []\nskills: [review-pr]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [claude, grok]\n`,
    );

    const emptyPath = temporaryDirectory("apk-empty-path-");
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = emptyPath;
    try {
      const desired = await buildDesiredState(home, {
        checkHostCapability: false,
        // Applied Skills-only installation: no Context rule paths to infer.
        previousInstallations: [
          {
            desiredInputDigest: `sha256:${"0".repeat(64)}`,
            hosts: {
              claude: {
                adapterVersion: "claude-project-v1",
                capabilityContract: "native-project-unscoped-rules-skills-v1",
              },
              grok: {
                adapterVersion: "grok-project-v1",
                capabilityContract: GROK_HOST_VERSION,
              },
            },
            installationId: "test-installation",
            lifetime: "ordinary",
            outputs: [{
              hash: `sha256:${"1".repeat(64)}`,
              mode: 0o755,
              path: ".claude/skills/review-pr",
              type: "directory",
            }],
            profileId: "coding",
            project,
          },
        ],
      });
      expect(desired.installations[0]?.capabilityWarnings).toEqual([]);
      expect(desired.installations[0]?.setupSteps).toEqual([]);
      // Skills-only Claude+Grok plans Skill packages without Context rule topology.
      expect(
        desired.installations[0]?.outputs.some((output) =>
          output.path.includes("rules/agent-profile-kit.md"),
        ),
      ).toBe(false);
      expect(
        desired.installations[0]?.outputs.some((output) => output.path === ".grok/skills/review-pr"),
      ).toBe(true);
      expect(
        desired.installations[0]?.outputs.some((output) => output.path === ".claude/skills/review-pr"),
      ).toBe(true);
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
    expect(reportItems(report.receipt)).toContainEqual({ kind: "addition", project });
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(project, GROK_CONTEXT_RULE_PATH))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");

    const state = await readInstallationState(home);
    const manifest = state.receipts[0]!;
    expect(Object.keys(manifest.hosts)).toEqual(["claude", "codex", "grok"]);
    expect(manifest.hosts.claude?.capabilityContract).toBe(CLAUDE_HOST_VERSION);
    expect(manifest.hosts.codex?.capabilityContract).toBe(CODEX_HOST_VERSION);
    expect(manifest.hosts.grok?.capabilityContract).toBe(GROK_HOST_VERSION);

    const raw = JSON.parse(
      readFileSync(join(home, ".agents", "agent-profile-kit", "state", "manifest.json"), "utf8"),
    ) as { receipts: Array<{ hosts: Record<string, { capability_contract: string }> }> };
    expect(Object.keys(raw.receipts[0]?.hosts ?? {})).toEqual(["claude", "codex", "grok"]);
    expect(raw.receipts[0]?.hosts.grok?.capability_contract).toBe(GROK_HOST_VERSION);

    expect((await uninstallApplication(home)).projects).toHaveLength(1);
    expect(existsSync(join(project, CLAUDE_CONTEXT_RULE_PATH))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(join(project, "CLAUDE.md"), "utf8")).toBe("project-owned\n");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("repository-owned\n");
  });
});
