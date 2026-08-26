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
  OPENCODE_HOST_VERSION,
  OPENCODE_MINIMUM_CLI_VERSION,
  OPENCODE_PROJECT_SKILLS_ROOT,
  parseOpenCodeCliVersion,
  planOpenCodeProject,
  probeOpenCodeMachineCapability,
} from "../adapters/opencode.js";
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
  reportBlockers,
  reportDesired,
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
      `OpenCode 1.18.22 does not support native project Skills (requires ${OPENCODE_MINIMUM_CLI_VERSION}+)`,
    );
    try {
      assertOpenCodeCliVersionSupported("0.9.0");
    } catch (error) {
      expect(isAdapterCapabilityError(error)).toBe(true);
      if (isAdapterCapabilityError(error)) {
        expect(error.host).toBe("opencode");
        expect(error.problem).toBe(
          `OpenCode 0.9.0 does not support native project Skills (requires ${OPENCODE_MINIMUM_CLI_VERSION}+)`,
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
    ).rejects.toThrow(/does not support native project Skills/i);
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

describe("OpenCode allowed-invocation Skills-only planning", () => {
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
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(true);

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
});
