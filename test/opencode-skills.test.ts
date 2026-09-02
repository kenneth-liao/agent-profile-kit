import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  OPENCODE_CONFIG_PATH,
  OPENCODE_HOST_VERSION,
  OPENCODE_HOST_VERSION_WITH_INVOCATION,
  OPENCODE_MINIMUM_CLI_VERSION,
  OPENCODE_PROJECT_SKILLS_ROOT,
  parseOpenCodeCliVersion,
  planOpenCodeProject,
  probeOpenCodeMachineCapability,
} from "../adapters/opencode.js";
import {
  planClaudeProject,
} from "../adapters/claude.js";
import { planAntigravityProject } from "../adapters/antigravity.js";
import { planCodexProject } from "../adapters/codex.js";
import { planPiProject } from "../adapters/pi.js";
import {
  SHARED_SKILL_DISCOVERY_REQUIREMENT,
  SHARED_SKILLS_DISCOVERY_ROOT,
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
  formatLifecycleJson,
  formatLifecycleReport,
} from "../cli/presentation.js";
import {
  reportBlockers,
  reportDesired,
  reportItems,
  reportOutputs,
} from "./support/reconciliation-report.js";
import {
  blockerWording,
  OPENCODE_CONFIG_OCCUPIED_REMEDY,
} from "../cli/blocker-wording.js";
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

function skill(id: string, path: string): Skill {
  return { dependencies: [], id, modelInvocation: "allowed", path };
}

async function workspaceWithSkills(
  home: string,
  project: string,
  skills: ReadonlyArray<{
    readonly id: string;
    readonly body?: string;
    readonly dependencies?: readonly string[];
    readonly path?: string;
    readonly scriptMode?: number;
  }>,
  selectedSkills: readonly string[],
  hosts: readonly string[] = ["opencode"],
): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  for (const entry of skills) {
    const relative = entry.path ?? entry.id;
    const skillRoot = join(workspace, "skills", relative);
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      entry.body ??
        `---\nname: ${entry.id}\ndescription: Skill ${entry.id}.\n---\n\n# ${entry.id}\n`,
    );
    if (entry.scriptMode !== undefined) {
      const script = join(skillRoot, "scripts", "run.sh");
      mkdirSync(join(skillRoot, "scripts"), { recursive: true });
      writeFileSync(script, `#!/bin/sh\necho ${entry.id}\n`);
      chmodSync(script, entry.scriptMode);
    }
  }
  writeFileSync(
    join(workspace, "profiles", "engineering.yaml"),
    `id: engineering\ncontext: []\nskills: [${selectedSkills.join(", ")}]\n`,
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [${hosts.join(", ")}]\n`,
  );
}

describe("OpenCode Adapter capabilities and version probing", () => {
  test("parses leading semver from opencode --version output", () => {
    expect(parseOpenCodeCliVersion("1.18.23")).toBe("1.18.23");
    expect(parseOpenCodeCliVersion("opencode 1.18.23")).toBe("1.18.23");
    expect(parseOpenCodeCliVersion("opencode version 1.19.0 (release)")).toBe("1.19.0");
    expect(parseOpenCodeCliVersion("1.18.23-beta.1")).toBe("1.18.23");
    expect(parseOpenCodeCliVersion("\n  1.18.24\n")).toBe("1.18.24");

    expect(() => parseOpenCodeCliVersion("no version here")).toThrow(
      /OpenCode version is unreadable from 'no version here'/i,
    );
    try {
      parseOpenCodeCliVersion("unreadable output");
    } catch (error) {
      expect(isAdapterCapabilityError(error)).toBe(true);
      if (isAdapterCapabilityError(error)) {
        expect(error.host).toBe("opencode");
        expect(error.affectedItems).toEqual([{ kind: "host", value: "opencode" }]);
        expect(error.remedy).toContain(OPENCODE_MINIMUM_CLI_VERSION);
      }
    }
  });

  test("asserts OpenCode version against verified floor 1.18.23", () => {
    expect(() => assertOpenCodeCliVersionSupported("1.18.23")).not.toThrow();
    expect(() => assertOpenCodeCliVersionSupported("1.18.24")).not.toThrow();
    expect(() => assertOpenCodeCliVersionSupported("1.19.0")).not.toThrow();
    expect(() => assertOpenCodeCliVersionSupported("2.0.0")).not.toThrow();

    expect(() => assertOpenCodeCliVersionSupported("1.18.22")).toThrow(
      `OpenCode 1.18.22 does not support native project instructions or Skills (requires ${OPENCODE_MINIMUM_CLI_VERSION}+)`,
    );
    try {
      assertOpenCodeCliVersionSupported("0.9.0");
    } catch (error) {
      expect(isAdapterCapabilityError(error)).toBe(true);
      if (isAdapterCapabilityError(error)) {
        expect(error.host).toBe("opencode");
        expect(error.problem).toBe(
          `OpenCode 0.9.0 does not support native project instructions or Skills (requires ${OPENCODE_MINIMUM_CLI_VERSION}+)`,
        );
        expect(error.remedy).toBe("upgrade OpenCode before checking status or applying the Profile");
      }
    }
  });

  test("probes OpenCode machine capability using injected version resolver", async () => {
    const version = await probeOpenCodeMachineCapability({
      resolveVersion: async () => "opencode 1.18.23\n",
    });
    expect(version).toBe("1.18.23");

    await expect(
      probeOpenCodeMachineCapability({
        resolveVersion: async () => "opencode 1.18.22\n",
      }),
    ).rejects.toThrow(/does not support native project instructions or Skills/i);
  });

  test("rejects with capability failure when OpenCode executable is missing on PATH", async () => {
    await expect(
      probeOpenCodeMachineCapability({ env: { PATH: "" } }),
    ).rejects.toThrow(/OpenCode was not found on PATH/i);
  });

  test("rejects project surface when .agents or .agents/skills is not a directory", async () => {
    const project = temporaryDirectory("apk-opencode-surface-");
    await expect(
      assertOpenCodeProjectSurface(project, { requireSkills: true }),
    ).resolves.toBeUndefined();

    const badAgents = temporaryDirectory("apk-opencode-bad-agents-");
    writeFileSync(join(badAgents, ".agents"), "not a directory\n");
    await expect(
      assertOpenCodeProjectSurface(badAgents, { requireSkills: true }),
    ).rejects.toThrow(/is a file, not a directory/i);

    const badSkills = temporaryDirectory("apk-opencode-bad-skills-");
    mkdirSync(join(badSkills, ".agents"), { recursive: true });
    writeFileSync(join(badSkills, ".agents", "skills"), "not a directory\n");
    await expect(
      assertOpenCodeProjectSurface(badSkills, { requireSkills: true }),
    ).rejects.toThrow(/is a file, not a directory/i);
  });

  test("asserts OpenCode project capability combining machine probe and surface check", async () => {
    const project = temporaryDirectory("apk-opencode-cap-");
    await expect(
      assertOpenCodeProjectCapability(project, {
        requireSkills: true,
        resolveVersion: async () => "1.18.23",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("OpenCode Skills planning", () => {
  test("plans selected Skill packages through qualified shared projection without configuration", async () => {
    const source = temporaryDirectory("apk-opencode-plan-src-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );

    const plan = await planOpenCodeProject("engineering", [], [skill("review-pr", source)]);

    expect(plan.host).toBe("opencode");
    expect(plan.hostVersion).toBe(OPENCODE_HOST_VERSION);
    expect(plan.outputs).toHaveLength(1);
    expect(plan.outputs[0]?.path).toBe(".agents/skills/review-pr");
    expect(plan.outputs[0]?.requirements).toContain(SHARED_SKILL_DISCOVERY_REQUIREMENT);
    expect(plan.setupSteps).toEqual([]);
  });

  test("produces identical shared Skill package shape and bytes as Codex, Antigravity, and Pi", async () => {
    const source = temporaryDirectory("apk-opencode-shared-bytes-");
    const skillContent =
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review PR\n";
    const scriptContent = "#!/bin/sh\necho review\n";
    writeSkillPackage(source, {
      "SKILL.md": { bytes: skillContent, mode: 0o644 },
      "scripts/run.sh": { bytes: scriptContent, mode: 0o755 },
    });

    const canonicalSkill = skill("review-pr", source);
    const opencodePlan = await planOpenCodeProject("engineering", [], [canonicalSkill]);
    const codexPlan = await planCodexProject("engineering", [], [canonicalSkill]);
    const antigravityPlan = await planAntigravityProject("engineering", [], [canonicalSkill]);
    const piPlan = await planPiProject("engineering", [], [canonicalSkill]);

    const opencodePkg = opencodePlan.outputs[0];
    const codexPkg = codexPlan.outputs[0];
    const antigravityPkg = antigravityPlan.outputs[0];
    const piPkg = piPlan.outputs[0];

    expect(opencodePkg?.path).toBe(".agents/skills/review-pr");
    expect(codexPkg?.path).toBe(".agents/skills/review-pr");
    expect(antigravityPkg?.path).toBe(".agents/skills/review-pr");
    expect(piPkg?.path).toBe(".agents/skills/review-pr");

    if (
      opencodePkg?.type !== "directory" ||
      codexPkg?.type !== "directory" ||
      antigravityPkg?.type !== "directory" ||
      piPkg?.type !== "directory"
    ) {
      throw new Error("expected directory outputs");
    }

    expect(opencodePkg.members).toEqual(codexPkg.members);
    expect(opencodePkg.members).toEqual(antigravityPkg.members);
    expect(opencodePkg.members).toEqual(piPkg.members);
  });


  test("plans disabled-invocation Skill as an Artifact-ID-keyed deny rule that leaves native explicit activation available", async () => {
    const source = temporaryDirectory("apk-opencode-dis-src-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy production.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Deploy\n",
    );

    const disabledSkill: Skill = {
      dependencies: [],
      id: "deploy",
      modelInvocation: "disabled",
      path: source,
    };

    const plan = await planOpenCodeProject("engineering", [], [disabledSkill]);

    expect(plan.host).toBe("opencode");
    expect(plan.hostVersion).toBe(OPENCODE_HOST_VERSION_WITH_INVOCATION);

    const outputPaths = plan.outputs.map((output) => output.path).sort();
    expect(outputPaths).toEqual([
      ".agents/skills/deploy",
      ".opencode/opencode.jsonc",
    ]);

    const configOutput = plan.outputs.find((output) => output.path === OPENCODE_CONFIG_PATH);
    if (!configOutput || configOutput.type !== "file") {
      throw new Error("expected config file output");
    }
    expect(configOutput.mode).toBe(0o644);
    expect(configOutput.origins).toEqual([{ id: "deploy", type: "skill" }]);
    expect(configOutput.requirements).toEqual([
      "OpenCode blocks model-selected Skill loading while native Skill commands remain available for explicit activation",
    ]);
    const parsedConfig = JSON.parse(configOutput.bytes as string) as {
      $schema?: string;
      instructions?: readonly string[];
      permission?: {
        skill?: Record<string, string>;
      };
    };
    expect(parsedConfig.$schema).toBe("https://opencode.ai/config.json");
    expect(parsedConfig.instructions).toBeUndefined();
    expect(parsedConfig.permission).toBeDefined();
    expect(parsedConfig.permission?.skill).toEqual({
      deploy: "deny",
    });

    expect(JSON.stringify(parsedConfig)).not.toContain("ask");

    // Package output checks
    const pkg = plan.outputs.find((o) => o.path === ".agents/skills/deploy");
    if (!pkg || pkg.type !== "directory") throw new Error("expected directory output");
    const skillMd = pkg.members.find((m) => m.path === "SKILL.md");
    expect(skillMd?.type).toBe("file");
    if (skillMd?.type === "file") {
      expect(String(skillMd.bytes)).toContain("disable-model-invocation: true");
    }

    // Host setup steps
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

  test("omits permission rules for allowed-invocation Skills and orders multiple disabled Skills deterministically", async () => {
    const allowedSource = temporaryDirectory("apk-opencode-allowed-src-");
    writeFileSync(
      join(allowedSource, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review PR.\n---\n\n# Review\n",
    );

    const zebraSource = temporaryDirectory("apk-opencode-zebra-src-");
    writeFileSync(
      join(zebraSource, "SKILL.md"),
      "---\nname: zebra-deploy\ndescription: Zebra Deploy.\n---\n\n# Zebra\n",
    );

    const alphaSource = temporaryDirectory("apk-opencode-alpha-src-");
    writeFileSync(
      join(alphaSource, "SKILL.md"),
      "---\nname: alpha-deploy\ndescription: Alpha Deploy.\n---\n\n# Alpha\n",
    );

    const skills: Skill[] = [
      { dependencies: [], id: "review-pr", modelInvocation: "allowed", path: allowedSource },
      { dependencies: [], id: "zebra-deploy", modelInvocation: "disabled", path: zebraSource },
      { dependencies: [], id: "alpha-deploy", modelInvocation: "disabled", path: alphaSource },
    ];

    const plan = await planOpenCodeProject("engineering", [], skills);

    expect(plan.hostVersion).toBe(OPENCODE_HOST_VERSION_WITH_INVOCATION);
    const configOutput = plan.outputs.find((output) => output.path === OPENCODE_CONFIG_PATH);
    if (!configOutput || configOutput.type !== "file") {
      throw new Error("expected config file output");
    }

    const parsedConfig = JSON.parse(configOutput.bytes as string) as {
      permission?: {
        skill?: Record<string, string>;
      };
    };

    expect(parsedConfig.permission?.skill).toEqual({
      "alpha-deploy": "deny",
      "zebra-deploy": "deny",
    });
    // Allowed skill produces no permission rule
    expect(parsedConfig.permission?.skill?.["review-pr"]).toBeUndefined();

    // Verify deterministic key ordering in serialized JSON
    const keys = Object.keys(parsedConfig.permission?.skill ?? {});
    expect(keys).toEqual(["alpha-deploy", "zebra-deploy"]);
  });

  test("plans instructions and permission rules together in OpenCode config for Context + disabled Skills Profile", async () => {
    const source = temporaryDirectory("apk-opencode-ctx-dis-src-");
    writeFileSync(
      join(source, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy production.\n---\n\n# Deploy\n",
    );

    const modules = [{ id: "team-rules", content: "Always follow conventions.\n" }];
    const skills: Skill[] = [
      { dependencies: [], id: "deploy", modelInvocation: "disabled", path: source },
    ];

    const plan = await planOpenCodeProject("engineering", modules, skills);

    expect(plan.hostVersion).toBe(OPENCODE_HOST_VERSION_WITH_INVOCATION);
    const configOutput = plan.outputs.find((output) => output.path === OPENCODE_CONFIG_PATH);
    if (!configOutput || configOutput.type !== "file") {
      throw new Error("expected config file output");
    }

    const parsedConfig = JSON.parse(configOutput.bytes as string) as {
      $schema?: string;
      instructions?: readonly string[];
      permission?: { skill?: Record<string, string> };
    };

    expect(parsedConfig.$schema).toBe("https://opencode.ai/config.json");
    expect(parsedConfig.instructions).toEqual([".agent-profile-kit/opencode/context.md"]);
    expect(parsedConfig.permission?.skill).toEqual({ deploy: "deny" });
    expect(configOutput.origins).toEqual([
      { id: "team-rules", type: "context" },
      { id: "deploy", type: "skill" },
    ]);
  });

  test("asserts distinct Capability Contracts across all four combinations of Context presence and explicit-only requirement", async () => {
    const allowedSource = temporaryDirectory("apk-opencode-cap-allowed-");
    writeFileSync(
      join(allowedSource, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review PR.\n---\n\n# Review\n",
    );
    const disabledSource = temporaryDirectory("apk-opencode-cap-disabled-");
    writeFileSync(
      join(disabledSource, "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy.\n---\n\n# Deploy\n",
    );

    const allowedSkill: Skill = {
      dependencies: [],
      id: "review-pr",
      modelInvocation: "allowed",
      path: allowedSource,
    };
    const disabledSkill: Skill = {
      dependencies: [],
      id: "deploy",
      modelInvocation: "disabled",
      path: disabledSource,
    };
    const contextModule = { id: "rules", content: "Context content.\n" };

    // 1. Context: false, Disabled: false -> OPENCODE_HOST_VERSION
    const plan1 = await planOpenCodeProject("engineering", [], [allowedSkill]);
    expect(plan1.hostVersion).toBe(OPENCODE_HOST_VERSION);

    // 2. Context: true, Disabled: false -> OPENCODE_HOST_VERSION
    const plan2 = await planOpenCodeProject("engineering", [contextModule], [allowedSkill]);
    expect(plan2.hostVersion).toBe(OPENCODE_HOST_VERSION);

    // 3. Context: false, Disabled: true -> OPENCODE_HOST_VERSION_WITH_INVOCATION
    const plan3 = await planOpenCodeProject("engineering", [], [disabledSkill]);
    expect(plan3.hostVersion).toBe(OPENCODE_HOST_VERSION_WITH_INVOCATION);

    // 4. Context: true, Disabled: true -> OPENCODE_HOST_VERSION_WITH_INVOCATION
    const plan4 = await planOpenCodeProject("engineering", [contextModule], [disabledSkill]);
    expect(plan4.hostVersion).toBe(OPENCODE_HOST_VERSION_WITH_INVOCATION);
  });
});

describe("OpenCode lifecycle: status and apply", () => {
  test("reconciles allowed-invocation Skills-only Profile for OpenCode and records receipt", async () => {
    const home = temporaryDirectory("apk-opencode-life-home-");
    const project = temporaryDirectory("apk-opencode-life-project-");
    await workspaceWithSkills(
      home,
      project,
      [{ id: "review-pr" }, { id: "deploy" }],
      ["review-pr", "deploy"],
      ["opencode"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(1);
    const installation = desired.installations[0]!;

    expect(installation.profile.skills).toEqual(["review-pr", "deploy"]);
    expect(installation.outputs.map((output) => output.path).sort()).toEqual([
      ".agents/skills/deploy",
      ".agents/skills/review-pr",
    ]);
    expect(installation.setupSteps).toEqual([]);

    const applied = await applyReconciliation(home, desired.installations);
    expect(reportBlockers(applied.receipt)).toEqual([]);

    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);

    const state = await readInstallationState(home);
    const receipt = state.receipts[0];
    if (!receipt) throw new Error("expected receipt");

    expect(receipt.hosts.opencode).toEqual({
      adapterVersion: OPENCODE_ADAPTER_VERSION,
      capabilityContract: OPENCODE_HOST_VERSION,
    });

    const status = await previewReconciliation(desired.installations, state);
    expect(reportItems(status).some((item) => item.kind === "current")).toBe(true);
    expect(reportBlockers(status)).toEqual([]);
  });

  test("coalesces shared .agents/skills package across multi-Host binding with OpenCode", async () => {
    const home = temporaryDirectory("apk-opencode-multi-home-");
    const project = temporaryDirectory("apk-opencode-multi-project-");
    await workspaceWithSkills(
      home,
      project,
      [{ id: "review-pr" }],
      ["review-pr"],
      ["antigravity", "codex", "opencode", "pi"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;

    // Package is planned once under .agents/skills/review-pr
    expect(installation.outputs.map((output) => output.path)).toEqual([
      ".agents/skills/review-pr",
    ]);

    const applied = await applyReconciliation(home, desired.installations);
    expect(reportBlockers(applied.receipt)).toEqual([]);

    const state = await readInstallationState(home);
    const receipt = state.receipts[0]!;

    expect(receipt.hosts.antigravity).toBeDefined();
    expect(receipt.hosts.codex).toBeDefined();
    expect(receipt.hosts.opencode).toEqual({
      adapterVersion: OPENCODE_ADAPTER_VERSION,
      capabilityContract: OPENCODE_HOST_VERSION,
    });
    expect(receipt.hosts.pi).toBeDefined();
  });

  test("reconciles disabled-invocation Skills Profile, commits config and package bytes, and records receipt", async () => {
    const home = temporaryDirectory("apk-opencode-dis-life-home-");
    const project = temporaryDirectory("apk-opencode-dis-life-proj-");

    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    mkdirSync(join(workspace, "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy production.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Deploy\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [deploy]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [opencode]\n`,
    );

    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
    });

    expect(desired.installations).toHaveLength(1);
    const installation = desired.installations[0]!;
    expect(installation.capabilityWarnings).toEqual([]);
    expect(installation.outputs.map((o) => o.path).sort()).toEqual([
      ".agents/skills/deploy",
      ".opencode/opencode.jsonc",
    ]);

    const applied = await applyReconciliation(home, desired.installations);
    expect(reportBlockers(applied.receipt)).toEqual([]);

    // File on disk assertions
    const configFile = join(project, ".opencode", "opencode.jsonc");
    expect(existsSync(configFile)).toBe(true);
    const configContent = JSON.parse(readFileSync(configFile, "utf8")) as {
      $schema?: string;
      permission?: { skill?: Record<string, string> };
    };
    expect(configContent.$schema).toBe("https://opencode.ai/config.json");
    expect(configContent.permission?.skill).toEqual({ deploy: "deny" });

    const skillFile = join(project, ".agents", "skills", "deploy", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, "utf8")).toContain("disable-model-invocation: true");

    // Receipt assertion
    const state = await readInstallationState(home);
    const receipt = state.receipts[0];
    if (!receipt) throw new Error("expected receipt");
    expect(receipt.hosts.opencode).toEqual({
      adapterVersion: OPENCODE_ADAPTER_VERSION,
      capabilityContract: OPENCODE_HOST_VERSION_WITH_INVOCATION,
    });
    expect(receipt.outputs.some((o) => o.path === ".opencode/opencode.jsonc")).toBe(true);

    const status = await previewReconciliation(desired.installations, state);
    expect(reportItems(status).some((item) => item.kind === "current")).toBe(true);
    expect(reportBlockers(status)).toEqual([]);
  });

  test("adding a disabled-invocation Skill to a previously recorded baseline installation changes receipt equality and produces pending re-application", async () => {
    const home = temporaryDirectory("apk-opencode-trans-home-");
    const project = temporaryDirectory("apk-opencode-trans-proj-");

    await workspaceWithSkills(
      home,
      project,
      [{ id: "review-pr" }],
      ["review-pr"],
      ["opencode"],
    );

    const initialDesired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initialDesired.installations);

    const initialState = await readInstallationState(home);
    expect(initialState.receipts[0]?.hosts.opencode?.capabilityContract).toBe(OPENCODE_HOST_VERSION);

    // Initial status is current
    const initialStatus = await previewReconciliation(initialDesired.installations, initialState);
    expect(reportItems(initialStatus).some((item) => item.kind === "current")).toBe(true);

    // Add a disabled-invocation Skill to Workspace and Profile
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    mkdirSync(join(workspace, "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy production.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Deploy\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [review-pr, deploy]\n",
    );

    const updatedDesired = await buildDesiredState(home, { checkHostCapability: false });
    const intermediateState = await readInstallationState(home);

    // Receipt equality changed -> reports stale source / pending re-application
    const pendingStatus = await previewReconciliation(updatedDesired.installations, intermediateState);
    expect(reportItems(pendingStatus).some((item) => item.kind === "stale source")).toBe(true);

    // Re-apply successfully
    const reApplied = await applyReconciliation(home, updatedDesired.installations);
    expect(reportBlockers(reApplied.receipt)).toEqual([]);

    const updatedState = await readInstallationState(home);
    expect(updatedState.receipts[0]?.hosts.opencode?.capabilityContract).toBe(
      OPENCODE_HOST_VERSION_WITH_INVOCATION,
    );

    const finalStatus = await previewReconciliation(updatedDesired.installations, updatedState);
    expect(reportItems(finalStatus).some((item) => item.kind === "current")).toBe(true);
  });

  test("blocks with occupied-output when claimed config slot is occupied during disabled-skill reconciliation", async () => {
    const home = temporaryDirectory("apk-opencode-dis-occ-home-");
    const project = temporaryDirectory("apk-opencode-dis-occ-proj-");

    mkdirSync(join(project, ".opencode"), { recursive: true });
    const userConfig = "{\n  \"model\": \"custom-user\"\n}\n";
    writeFileSync(join(project, ".opencode", "opencode.jsonc"), userConfig);

    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    mkdirSync(join(workspace, "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy production.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Deploy\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [deploy]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [opencode]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const state = await readInstallationState(home);
    const status = await previewReconciliation(desired.installations, state);
    const blockers = reportBlockers(status);

    const occupiedBlocker = blockers.find((b) =>
      b.affectedItems.some((i) => i.value === ".opencode/opencode.jsonc"),
    );
    if (!occupiedBlocker) throw new Error("expected occupied output blocker for .opencode/opencode.jsonc");
    expect(occupiedBlocker.kind).toBe("occupied-output");
    expect(blockerWording(occupiedBlocker).remedy).toBe(OPENCODE_CONFIG_OCCUPIED_REMEDY);

    await expect(
      applyReconciliation(home, desired.installations),
    ).rejects.toThrow(/Apply blocked before writes/);

    expect(readFileSync(join(project, ".opencode", "opencode.jsonc"), "utf8")).toBe(userConfig);
    expect(existsSync(join(project, ".agents"))).toBe(false);
  });
});

describe("OpenCode and Claude duplicate Skill discovery", () => {
  test("produces identical candidate SKILL.md documents across Claude and OpenCode discovery roots for allowed-invocation Skills", async () => {
    const source = temporaryDirectory("apk-opencode-claude-allowed-src-");
    const skillContent =
      "---\nname: review-pr\ndescription: Review pull request.\n---\n\n# Review PR\n";
    writeSkillPackage(source, {
      "SKILL.md": { bytes: skillContent, mode: 0o644 },
    });

    const canonicalSkill = skill("review-pr", source);
    const claudePlan = await planClaudeProject("engineering", [], [canonicalSkill]);
    const opencodePlan = await planOpenCodeProject("engineering", [], [canonicalSkill]);

    const claudePkg = claudePlan.outputs.find((o) => o.path === ".claude/skills/review-pr");
    const opencodePkg = opencodePlan.outputs.find((o) => o.path === ".agents/skills/review-pr");

    if (!claudePkg || claudePkg.type !== "directory" || !opencodePkg || opencodePkg.type !== "directory") {
      throw new Error("expected directory outputs");
    }

    const claudeSkillMd = claudePkg.members.find((m) => m.path === "SKILL.md");
    const opencodeSkillMd = opencodePkg.members.find((m) => m.path === "SKILL.md");

    expect(claudeSkillMd).toBeDefined();
    expect(opencodeSkillMd).toBeDefined();
    if (!claudeSkillMd || claudeSkillMd.type !== "file" || !opencodeSkillMd || opencodeSkillMd.type !== "file") {
      throw new Error("expected SKILL.md file members");
    }
    expect(Buffer.from(claudeSkillMd.bytes).toString("utf8")).toBe(
      Buffer.from(opencodeSkillMd.bytes).toString("utf8"),
    );
    expect(Buffer.from(opencodeSkillMd.bytes).toString("utf8")).toBe(skillContent);
  });

  test("produces identical candidate SKILL.md documents across Claude and OpenCode discovery roots for disabled-invocation Skills", async () => {
    const source = temporaryDirectory("apk-opencode-claude-disabled-src-");
    const authoredSkillContent =
      "---\n# Frontmatter comment\nname: deploy\ndescription: Deploy production safely.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Deploy\n";
    writeSkillPackage(source, {
      "SKILL.md": { bytes: authoredSkillContent, mode: 0o644 },
    });

    const disabledSkill: Skill = {
      dependencies: [],
      id: "deploy",
      modelInvocation: "disabled",
      path: source,
    };

    const claudePlan = await planClaudeProject("engineering", [], [disabledSkill]);
    const opencodePlan = await planOpenCodeProject("engineering", [], [disabledSkill]);

    const claudePkg = claudePlan.outputs.find((o) => o.path === ".claude/skills/deploy");
    const opencodePkg = opencodePlan.outputs.find((o) => o.path === ".agents/skills/deploy");

    if (!claudePkg || claudePkg.type !== "directory" || !opencodePkg || opencodePkg.type !== "directory") {
      throw new Error("expected directory outputs");
    }

    const claudeSkillMd = claudePkg.members.find((m) => m.path === "SKILL.md");
    const opencodeSkillMd = opencodePkg.members.find((m) => m.path === "SKILL.md");

    expect(claudeSkillMd).toBeDefined();
    expect(opencodeSkillMd).toBeDefined();
    if (!claudeSkillMd || claudeSkillMd.type !== "file" || !opencodeSkillMd || opencodeSkillMd.type !== "file") {
      throw new Error("expected SKILL.md file members");
    }
    // Byte-for-byte equality across candidate Skill documents
    expect(Buffer.from(claudeSkillMd.bytes).toString("utf8")).toBe(
      Buffer.from(opencodeSkillMd.bytes).toString("utf8"),
    );
    expect(Buffer.from(opencodeSkillMd.bytes).toString("utf8")).toContain(
      "disable-model-invocation: true",
    );
    expect(Buffer.from(opencodeSkillMd.bytes).toString("utf8")).toContain("name: deploy");
    expect(Buffer.from(opencodeSkillMd.bytes).toString("utf8")).toContain(
      "description: Deploy production safely.",
    );
  });

  test("emits no duplicate-Skill diagnostic when Project selects both Claude and OpenCode with Skills", async () => {
    const home = temporaryDirectory("apk-opencode-claude-warn-home-");
    const project = temporaryDirectory("apk-opencode-claude-warn-proj-");

    await workspaceWithSkills(
      home,
      project,
      [{ id: "review-pr" }, { id: "deploy" }],
      ["review-pr", "deploy"],
      ["claude", "opencode"],
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(1);
    const installation = desired.installations[0]!;

    // Equivalent candidates across the two discovery roots are Host Resolution:
    // no Agent Profile Kit diagnostic and no capability warning.
    expect(installation.warnings).toEqual([]);
    expect(installation.capabilityWarnings).toEqual([]);

    // Both outputs are planned
    const outputPaths = installation.outputs.map((o) => o.path).sort();
    expect(outputPaths).toContain(".claude/skills/deploy");
    expect(outputPaths).toContain(".claude/skills/review-pr");
    expect(outputPaths).toContain(".agents/skills/deploy");
    expect(outputPaths).toContain(".agents/skills/review-pr");
  });

  test("emits no duplicate-discovery warning when Claude and OpenCode are selected without Skills", async () => {
    const home = temporaryDirectory("apk-opencode-claude-ctx-home-");
    const project = temporaryDirectory("apk-opencode-claude-ctx-proj-");

    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    mkdirSync(join(workspace, "context"), { recursive: true });
    writeFileSync(
      join(workspace, "context", "rules.md"),
      "---\nid: rules\n---\n\nAlways follow conventions.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [claude, opencode]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(1);
    const installation = desired.installations[0]!;

    expect(installation.warnings).toEqual([]);
    expect(installation.capabilityWarnings).toEqual([]);
  });

  test("reconciles Claude and OpenCode co-selected binding, applies cleanly, and status reports current without warnings", async () => {
    const home = temporaryDirectory("apk-opencode-claude-life-home-");
    const project = temporaryDirectory("apk-opencode-claude-life-proj-");

    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    mkdirSync(join(workspace, "skills", "deploy"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: Deploy production.\nmetadata:\n  agent-profile-kit.model-invocation: disabled\n---\n\n# Deploy\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [deploy]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [claude, opencode]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.warnings).toEqual([]);
    expect(desired.installations[0]?.capabilityWarnings).toEqual([]);

    // AC 2: Apply succeeds without blocking
    const applied = await applyReconciliation(home, desired.installations);
    expect(reportBlockers(applied.receipt)).toEqual([]);

    // Both discovery roots exist on disk
    expect(existsSync(join(project, ".claude", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "deploy", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".opencode", "opencode.jsonc"))).toBe(true);

    const state = await readInstallationState(home);
    const receipt = state.receipts[0];
    if (!receipt) throw new Error("expected receipt");
    expect(receipt.hosts.claude).toBeDefined();
    expect(receipt.hosts.opencode).toBeDefined();

    // Status reports current with no blockers
    const status = await previewReconciliation(desired.installations, state);
    expect(reportItems(status).some((item) => item.kind === "current")).toBe(true);
    expect(reportBlockers(status)).toEqual([]);
  });

  test("fifteen-Project OpenCode and Claude fixture reports current with no duplicate-Skill warnings across human and machine output", async () => {
    const home = temporaryDirectory("apk-opencode-claude-15-home-");
    const projects = Array.from({ length: 15 }, (_, i) =>
      temporaryDirectory(`apk-opencode-claude-15-proj-${i + 1}-`),
    );

    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    mkdirSync(join(workspace, "skills", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspace, "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review pull requests.\n---\n\n# Review PR\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: []\nskills: [review-pr]\n",
    );

    const bindingsYaml = projects
      .map((project) => `  - project: ${project}\n    profile: engineering\n    hosts: [claude, opencode]`)
      .join("\n");
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${bindingsYaml}\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(15);

    const state = await readInstallationState(home);
    const statusReport = await previewReconciliation(desired.installations, state);

    // 1. Concise human output carries no duplicate-Skill warning.
    const concise = formatLifecycleReport("status", statusReport);
    expect(concise).not.toContain("OpenCode discovers Skills");

    // 2. Verbose human output lists all 15 Projects and no warning.
    const verbose = formatLifecycleReport("status", statusReport, { verbose: true });
    expect(verbose).not.toContain("OpenCode discovers Skills");
    for (const project of projects) {
      expect(verbose).toContain(project);
    }

    // 3. Machine JSON retains 15 separate Project records, each warning-free.
    const json = JSON.parse(formatLifecycleJson("status", statusReport)) as {
      projects: {
        canonicalProject: string;
        warnings: { copyableValues: string[]; kind: string; message: string }[];
      }[];
    };
    expect(json.projects).toHaveLength(15);
    for (const projectRecord of json.projects) {
      expect(projectRecord.warnings).toEqual([]);
    }
  });
});


