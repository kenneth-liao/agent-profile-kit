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
import { isAdapterCapabilityError } from "../adapters/capability.js";
import {
  assertOpenCodeCliVersionSupported,
  assertOpenCodeProjectCapability,
  assertOpenCodeProjectSurface,
  OPENCODE_ADAPTER_VERSION,
  OPENCODE_CONFIG_OCCUPIED_REMEDY,
  OPENCODE_CONFIG_PATH,
  OPENCODE_CONTEXT_PATH,
  OPENCODE_CONTEXT_REQUIREMENTS,
  OPENCODE_HOST_VERSION,
  OPENCODE_MINIMUM_CLI_VERSION,
  OPENCODE_PROJECT_SKILLS_ROOT,
  parseOpenCodeCliVersion,
  planOpenCodeProject,
  probeOpenCodeMachineCapability,
} from "../adapters/opencode.js";
import { composeContextEnvelope } from "../adapters/context-envelope.js";
import {
  SHARED_SKILL_DISCOVERY_REQUIREMENT,
} from "../adapters/shared-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { readInstallationState } from "../installer/installation-state.js";
import type { Skill } from "../schemas/skill.js";
import {
  reportBlockers,
  reportItems,
  reportOutputs,
} from "./support/reconciliation-report.js";

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

function skill(id: string, path: string): Skill {
  return { dependencies: [], id, modelInvocation: "allowed", path };
}

describe("OpenCode Context Adapter planning", () => {
  test("plans composed Context document, JSONC config, and transition launch-constraint setup step for Context-bearing Profile", async () => {
    const source = temporaryDirectory("apk-opencode-ctx-src-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review PR.\n---\n\n# Review\n",
    );

    const modules = [
      { id: "team-rules", content: "Always write tests first.\n" },
      { id: "coding-style", content: "Prefer immutable data structures.\n" },
    ];

    const plan = await planOpenCodeProject("engineering", modules, [skill("review-pr", source)]);

    expect(plan.host).toBe("opencode");
    expect(plan.hostVersion).toBe(OPENCODE_HOST_VERSION);

    // Outputs include config file, Context document, and Skill package
    const outputPaths = plan.outputs.map((output) => output.path).sort();
    expect(outputPaths).toEqual([
      ".agent-profile-kit/opencode/context.md",
      ".agents/skills/review-pr",
      ".opencode/opencode.jsonc",
    ]);

    // Context document output verification
    const contextOutput = plan.outputs.find(
      (output) => output.path === OPENCODE_CONTEXT_PATH,
    );
    if (!contextOutput || contextOutput.type !== "file") {
      throw new Error("expected Context file output");
    }
    expect(contextOutput.mode).toBe(0o644);
    expect(contextOutput.origins).toEqual([
      { id: "team-rules", type: "context" },
      { id: "coding-style", type: "context" },
    ]);
    const expectedContextBytes = composeContextEnvelope("engineering", modules);
    expect(contextOutput.bytes).toBe(expectedContextBytes);
    expect(contextOutput.bytes).toContain("# Agent Profile Kit Context");
    expect(contextOutput.bytes).toContain("Profile: engineering");
    expect(contextOutput.bytes).toContain("<!-- Context Module: team-rules -->");
    expect(contextOutput.bytes).toContain("<!-- Context Module: coding-style -->");

    // OpenCode JSONC configuration output verification
    const configOutput = plan.outputs.find(
      (output) => output.path === OPENCODE_CONFIG_PATH,
    );
    if (!configOutput || configOutput.type !== "file") {
      throw new Error("expected config file output");
    }
    expect(configOutput.mode).toBe(0o644);
    expect(configOutput.origins).toEqual([
      { id: "team-rules", type: "context" },
      { id: "coding-style", type: "context" },
    ]);

    const parsedConfig = JSON.parse(configOutput.bytes as string) as {
      $schema?: string;
      instructions?: readonly string[];
    };
    expect(parsedConfig.$schema).toBe("https://opencode.ai/config.json");
    expect(parsedConfig.instructions).toEqual([".agent-profile-kit/opencode/context.md"]);

    // Transition-provenance launch-constraint setup step
    expect(plan.setupSteps).toEqual([
      {
        consequence:
          "A running OpenCode session keeps its previously loaded configuration until restarted.",
        kind: "launch-constraint",
        message: "Restart OpenCode to load changed configuration.",
        output: OPENCODE_CONFIG_PATH,
        provenance: "transition",
      },
    ]);
  });

  test("plans no configuration file or Context document for Skills-only Profile", async () => {
    const source = temporaryDirectory("apk-opencode-skills-only-src-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review PR.\n---\n\n# Review\n",
    );

    const plan = await planOpenCodeProject("engineering", [], [skill("review-pr", source)]);

    expect(plan.outputs.map((output) => output.path)).toEqual([
      ".agents/skills/review-pr",
    ]);
    expect(plan.setupSteps).toEqual([]);
    expect(
      plan.outputs.some((output) => output.path.startsWith(".opencode")),
    ).toBe(false);
    expect(
      plan.outputs.some((output) => output.path.startsWith(".agent-profile-kit/opencode")),
    ).toBe(false);
  });
});

describe("OpenCode Context project surface capability", () => {
  test("passes project surface preflight when surfaces are clean or missing", async () => {
    const project = temporaryDirectory("apk-opencode-ctx-surface-ok-");
    await expect(
      assertOpenCodeProjectSurface(project, { requireContext: true, requireSkills: true }),
    ).resolves.toBeUndefined();
  });

  test("rejects when .opencode is a file instead of a directory", async () => {
    const project = temporaryDirectory("apk-opencode-bad-opencode-");
    writeFileSync(join(project, ".opencode"), "not a directory\n");

    await expect(
      assertOpenCodeProjectSurface(project, { requireContext: true }),
    ).rejects.toThrow(/OpenCode project surface cannot host outputs: .* is a file, not a directory/i);
  });

  test("rejects when .agent-profile-kit is a file instead of a directory", async () => {
    const project = temporaryDirectory("apk-opencode-bad-apk-");
    writeFileSync(join(project, ".agent-profile-kit"), "not a directory\n");

    await expect(
      assertOpenCodeProjectSurface(project, { requireContext: true }),
    ).rejects.toThrow(/OpenCode project surface cannot host Context: .* is a file, not a directory/i);
  });

  test("rejects when .agent-profile-kit/opencode is a file instead of a directory", async () => {
    const project = temporaryDirectory("apk-opencode-bad-apk-opencode-");
    mkdirSync(join(project, ".agent-profile-kit"), { recursive: true });
    writeFileSync(join(project, ".agent-profile-kit", "opencode"), "not a directory\n");

    await expect(
      assertOpenCodeProjectSurface(project, { requireContext: true }),
    ).rejects.toThrow(/OpenCode project surface cannot host Context: .* is a file, not a directory/i);
  });

  test("fails Context-only version probe below floor with instructions or Skills message", async () => {
    await expect(
      probeOpenCodeMachineCapability({
        requireContext: true,
        requireSkills: false,
        resolveVersion: async () => "opencode 1.18.22\n",
      }),
    ).rejects.toThrow(/OpenCode 1.18.22 does not support native project instructions or Skills/i);
  });

  test("asserts OpenCode project capability combining machine probe and Context surface checks", async () => {
    const project = temporaryDirectory("apk-opencode-cap-combined-");
    await expect(
      assertOpenCodeProjectCapability(project, {
        requireContext: true,
        requireSkills: true,
        resolveVersion: async () => "1.18.23",
      }),
    ).resolves.toBeUndefined();
  });
});

async function workspaceWithContextAndSkills(
  home: string,
  project: string,
  contexts: ReadonlyArray<{ readonly id: string; readonly content?: string }>,
  skills: ReadonlyArray<{ readonly id: string; readonly body?: string }>,
  selectedContexts: readonly string[],
  selectedSkills: readonly string[],
  hosts: readonly string[] = ["opencode"],
): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  for (const ctx of contexts) {
    const ctxPath = join(workspace, "context", `${ctx.id}.md`);
    mkdirSync(join(workspace, "context"), { recursive: true });
    const content = ctx.content ?? `# ${ctx.id}\nContext content for ${ctx.id}.\n`;
    const fullContent = content.startsWith("---\n")
      ? content
      : `---\nid: ${ctx.id}\n---\n\n${content}`;
    writeFileSync(ctxPath, fullContent);
  }
  for (const entry of skills) {
    const skillRoot = join(workspace, "skills", entry.id);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      entry.body ??
        `---\nname: ${entry.id}\ndescription: Skill ${entry.id}.\n---\n\n# ${entry.id}\n`,
    );
  }
  writeFileSync(
    join(workspace, "profiles", "engineering.yaml"),
    `id: engineering\ncontext: [${selectedContexts.join(", ")}]\nskills: [${selectedSkills.join(", ")}]\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

describe("OpenCode Context lifecycle: reconciliation, receipt, and conflicts", () => {
  test("reconciles Context and Skills Profile for OpenCode, commits exact bytes, and records whole-file ownership", async () => {
    const home = temporaryDirectory("apk-opencode-life-ctx-home-");
    const project = temporaryDirectory("apk-opencode-life-ctx-proj-");

    await workspaceWithContextAndSkills(
      home,
      project,
      [{ id: "team-rules", content: "---\nid: team-rules\n---\n\n# Rules\nFollow project conventions.\n" }],
      [{ id: "review-pr" }],
      ["team-rules"],
      ["review-pr"],
      ["opencode"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(1);
    const installation = desired.installations[0]!;

    expect(installation.profile.context).toEqual(["team-rules"]);
    expect(installation.profile.skills).toEqual(["review-pr"]);
    expect(installation.outputs.map((output) => output.path).sort()).toEqual([
      ".agent-profile-kit/opencode/context.md",
      ".agents/skills/review-pr",
      ".opencode/opencode.jsonc",
    ]);

    expect(installation.setupSteps).toEqual([
      {
        consequence:
          "A running OpenCode session keeps its previously loaded configuration until restarted.",
        host: "opencode",
        kind: "launch-constraint",
        message: "Restart OpenCode to load changed configuration.",
        output: ".opencode/opencode.jsonc",
        provenance: "transition",
      },
    ]);

    const applied = await applyReconciliation(home, desired.installations);
    expect(reportBlockers(applied.receipt)).toEqual([]);

    // Verify committed files on disk
    const contextFileOnDisk = join(project, ".agent-profile-kit", "opencode", "context.md");
    const configFileOnDisk = join(project, ".opencode", "opencode.jsonc");
    const skillFileOnDisk = join(project, ".agents", "skills", "review-pr", "SKILL.md");
    const markerFileOnDisk = join(project, ".agent-profile-kit", "installation.json");

    expect(existsSync(contextFileOnDisk)).toBe(true);
    expect(existsSync(configFileOnDisk)).toBe(true);
    expect(existsSync(skillFileOnDisk)).toBe(true);
    expect(existsSync(markerFileOnDisk)).toBe(true);

    const contextContent = readFileSync(contextFileOnDisk, "utf8");
    expect(contextContent).toContain("# Agent Profile Kit Context");
    expect(contextContent).toContain("Profile: engineering");
    expect(contextContent).toContain("<!-- Context Module: team-rules -->");
    expect(contextContent).toContain("Follow project conventions.");

    const configContent = readFileSync(configFileOnDisk, "utf8");
    const parsedConfig = JSON.parse(configContent) as {
      $schema?: string;
      instructions?: readonly string[];
    };
    expect(parsedConfig.$schema).toBe("https://opencode.ai/config.json");
    expect(parsedConfig.instructions).toEqual([".agent-profile-kit/opencode/context.md"]);

    // Verify Installation Receipt records whole-file ownership over both files
    const state = await readInstallationState(home);
    const receipt = state.receipts[0];
    if (!receipt) throw new Error("expected receipt");

    expect(receipt.hosts.opencode).toEqual({
      adapterVersion: OPENCODE_ADAPTER_VERSION,
      capabilityContract: OPENCODE_HOST_VERSION,
    });

    const outputPathsInReceipt = receipt.outputs.map((output) => output.path).sort();
    expect(outputPathsInReceipt).toEqual([
      ".agent-profile-kit/opencode/context.md",
      ".agents/skills/review-pr",
      ".opencode/opencode.jsonc",
    ]);

    const contextReceipt = receipt.outputs.find(
      (output) => output.path === ".agent-profile-kit/opencode/context.md",
    );
    expect(contextReceipt?.type).toBe("file");
    expect(contextReceipt?.hash).toBeDefined();

    const configReceipt = receipt.outputs.find(
      (output) => output.path === ".opencode/opencode.jsonc",
    );
    expect(configReceipt?.type).toBe("file");
    expect(configReceipt?.hash).toBeDefined();

    // Verify previewReconciliation (status) is clean and current
    const status = await previewReconciliation(desired.installations, state);
    expect(reportItems(status).some((item) => item.kind === "current")).toBe(true);
    expect(reportBlockers(status)).toEqual([]);
  });

  test("never touches repository-owned instructions or other user OpenCode configuration slots", async () => {
    const home = temporaryDirectory("apk-opencode-untouched-home-");
    const project = temporaryDirectory("apk-opencode-untouched-proj-");

    // Author existing repository instructions and user configuration in other slots
    writeFileSync(join(project, "AGENTS.md"), "# Team Project Instructions\nLive instructions.\n");
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ userCustomKey: "preserved" }, null, 2));
    mkdirSync(join(project, ".opencode"), { recursive: true });
    writeFileSync(
      join(project, ".opencode", "opencode.json"),
      JSON.stringify({ anotherUserSetting: true }, null, 2),
    );

    await workspaceWithContextAndSkills(
      home,
      project,
      [{ id: "team-rules", content: "Profile context content.\n" }],
      [{ id: "review-pr" }],
      ["team-rules"],
      ["review-pr"],
      ["opencode"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);

    // Repository-owned instructions and other slots remain untouched with exact original content
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(
      "# Team Project Instructions\nLive instructions.\n",
    );
    expect(readFileSync(join(project, "opencode.json"), "utf8")).toBe(
      JSON.stringify({ userCustomKey: "preserved" }, null, 2),
    );
    expect(readFileSync(join(project, ".opencode", "opencode.json"), "utf8")).toBe(
      JSON.stringify({ anotherUserSetting: true }, null, 2),
    );

    // Only the claimed slot .opencode/opencode.jsonc is written
    expect(existsSync(join(project, ".opencode", "opencode.jsonc"))).toBe(true);
  });

  test("blocks status and apply with Output Ownership Conflict when claimed slot is occupied by unowned material", async () => {
    const home = temporaryDirectory("apk-opencode-occupied-home-");
    const project = temporaryDirectory("apk-opencode-occupied-proj-");

    // Place unowned file at claimed destination
    mkdirSync(join(project, ".opencode"), { recursive: true });
    const userJsonc = "// User authored opencode.jsonc\n{\n  \"model\": \"custom\"\n}\n";
    writeFileSync(join(project, ".opencode", "opencode.jsonc"), userJsonc);

    await workspaceWithContextAndSkills(
      home,
      project,
      [{ id: "team-rules", content: "Profile context.\n" }],
      [{ id: "review-pr" }],
      ["team-rules"],
      ["review-pr"],
      ["opencode"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const state = await readInstallationState(home);

    const status = await previewReconciliation(desired.installations, state);
    const blockers = reportBlockers(status);
    expect(blockers.length).toBeGreaterThanOrEqual(1);

    const occupiedBlocker = blockers.find((blocker) =>
      blocker.message.includes(".opencode/opencode.jsonc is occupied"),
    );
    if (!occupiedBlocker) {
      throw new Error("expected occupied output blocker for .opencode/opencode.jsonc");
    }
    expect(occupiedBlocker.kind).toBe("occupied-output");
    expect(occupiedBlocker.affectedItems).toEqual([
      { kind: "path", value: ".opencode/opencode.jsonc" },
    ]);
    expect(occupiedBlocker.remedy).toBe(OPENCODE_CONFIG_OCCUPIED_REMEDY);
    expect(occupiedBlocker.remedy).toContain("opencode.json");
    expect(occupiedBlocker.remedy).toContain(".opencode/opencode.json");

    // Apply fails closed before writes
    await expect(
      applyReconciliation(home, desired.installations),
    ).rejects.toThrow(/Apply blocked before writes/);

    // Verify unowned configuration file was NOT overwritten or modified
    expect(readFileSync(join(project, ".opencode", "opencode.jsonc"), "utf8")).toBe(userJsonc);

    // Verify no Context document or Marker was created
    expect(existsSync(join(project, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(project, ".agents"))).toBe(false);

    // Verify no Installation State was committed for this project
    const finalState = await readInstallationState(home);
    expect(finalState.receipts).toEqual([]);
  });

  test("blocks with occupied-output and specific remedy when claimed slot is occupied by a directory", async () => {
    const home = temporaryDirectory("apk-opencode-dir-occ-home-");
    const project = temporaryDirectory("apk-opencode-dir-occ-proj-");

    mkdirSync(join(project, ".opencode", "opencode.jsonc"), { recursive: true });

    await workspaceWithContextAndSkills(
      home,
      project,
      [{ id: "team-rules", content: "Profile context.\n" }],
      [],
      ["team-rules"],
      [],
      ["opencode"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const state = await readInstallationState(home);
    const status = await previewReconciliation(desired.installations, state);
    const blockers = reportBlockers(status);
    const occupiedBlocker = blockers.find((b) =>
      b.affectedItems.some((i) => i.value === ".opencode/opencode.jsonc"),
    );
    if (!occupiedBlocker) throw new Error("expected occupied output blocker for directory");
    expect(occupiedBlocker.kind).toBe("occupied-output");
    expect(occupiedBlocker.remedy).toBe(OPENCODE_CONFIG_OCCUPIED_REMEDY);

    await expect(
      applyReconciliation(home, desired.installations),
    ).rejects.toThrow(/Apply blocked before writes/);
  });

  test("combines OpenCode Context with multi-Host bindings cleanly", async () => {
    const home = temporaryDirectory("apk-opencode-multi-ctx-home-");
    const project = temporaryDirectory("apk-opencode-multi-ctx-proj-");

    await workspaceWithContextAndSkills(
      home,
      project,
      [{ id: "team-rules", content: "Multi-host context.\n" }],
      [{ id: "review-pr" }],
      ["team-rules"],
      ["review-pr"],
      ["antigravity", "codex", "opencode", "pi"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;

    const plannedOutputPaths = installation.outputs.map((output) => output.path).sort();
    expect(plannedOutputPaths).toContain(".agent-profile-kit/opencode/context.md");
    expect(plannedOutputPaths).toContain(".opencode/opencode.jsonc");
    expect(plannedOutputPaths).toContain(".agents/skills/review-pr");
    expect(plannedOutputPaths).toContain(".agents/rules/agent-profile-kit-000-envelope.md");
    expect(plannedOutputPaths).toContain(".pi/APPEND_SYSTEM.md");
    expect(plannedOutputPaths).toContain(".codex/hooks.json");

    const applied = await applyReconciliation(home, desired.installations);
    expect(reportBlockers(applied.receipt)).toEqual([]);

    const state = await readInstallationState(home);
    const receipt = state.receipts[0]!;

    expect(receipt.hosts.opencode).toEqual({
      adapterVersion: OPENCODE_ADAPTER_VERSION,
      capabilityContract: OPENCODE_HOST_VERSION,
    });
    expect(receipt.hosts.antigravity).toBeDefined();
    expect(receipt.hosts.codex).toBeDefined();
    expect(receipt.hosts.pi).toBeDefined();

    expect(existsSync(join(project, ".opencode", "opencode.jsonc"))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "opencode", "context.md"))).toBe(true);
  });

  test("updates Context content cleanly across re-application", async () => {
    const home = temporaryDirectory("apk-opencode-update-ctx-home-");
    const project = temporaryDirectory("apk-opencode-update-ctx-proj-");

    await workspaceWithContextAndSkills(
      home,
      project,
      [{ id: "team-rules", content: "Initial context.\n" }],
      [{ id: "review-pr" }],
      ["team-rules"],
      ["review-pr"],
      ["opencode"],
    );

    const initialDesired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initialDesired.installations);

    const contextPath = join(project, ".agent-profile-kit", "opencode", "context.md");
    expect(readFileSync(contextPath, "utf8")).toContain("Initial context.");

    // Update Context Module in Workspace
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\n---\n\n# Rules\nUpdated context content.\n",
    );

    const updatedDesired = await buildDesiredState(home, { checkHostCapability: false });
    const intermediateState = await readInstallationState(home);

    const status = await previewReconciliation(updatedDesired.installations, intermediateState);
    expect(reportItems(status).some((item) => item.kind === "stale source")).toBe(true);

    const reApplied = await applyReconciliation(home, updatedDesired.installations);
    expect(reportBlockers(reApplied.receipt)).toEqual([]);

    expect(readFileSync(contextPath, "utf8")).toContain("Updated context content.");

    const finalState = await readInstallationState(home);
    const finalStatus = await previewReconciliation(updatedDesired.installations, finalState);
    expect(reportItems(finalStatus).some((item) => item.kind === "current")).toBe(true);
  });
});



