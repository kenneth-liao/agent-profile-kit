import { join, posix } from "node:path";
import type { Skill } from "../schemas/skill.js";
import type { CompleteHostAdapter } from "./adapter-contract.js";
export { OPENCODE_ADAPTER_VERSION } from "./host-catalog.js";
import { type ContextModuleSource } from "./context-envelope.js";
import {
  capabilityFailure,
  isAdapterCapabilityError,
  type AdapterCapabilityError,
} from "./capability.js";
import { invokeExecutable } from "./services/executable.js";
import { classifyFileSystemEntry } from "./services/project-surface.js";
import {
  compareCoreSemanticVersions,
  normalizeCoreSemanticVersion,
} from "./services/semantic-version.js";
import {
  DEFAULT_ADAPTER_PLANNING_MATERIALS,
  type AdapterPlanningMaterials,
} from "./skill-package.js";
import {
  planSharedSkillPackageDirectory,
  SHARED_SKILLS_DISCOVERY_ROOT,
  SHARED_SKILL_DISCOVERY_REQUIREMENT,
} from "./shared-skill.js";
import type {
  AdapterHostSetupStep,
  AdapterProjectPlan,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";

/** Capability Contract for OpenCode native project instructions and shared Skills. */
export const OPENCODE_HOST_VERSION = "native-project-instructions-skills-v1";

/** Minimum OpenCode version verified for native shared Skill discovery. */
export const OPENCODE_MINIMUM_CLI_VERSION = "1.18.23";

/** OpenCode native project Skill discovery root. */
export const OPENCODE_PROJECT_SKILLS_ROOT = SHARED_SKILLS_DISCOVERY_ROOT;

/** Owned OpenCode JSONC configuration file path (project-relative). */
export const OPENCODE_CONFIG_PATH = posix.join(".opencode", "opencode.jsonc");

/** Owned composed Profile Context path for OpenCode (project-relative). */
export const OPENCODE_CONTEXT_PATH = posix.join(
  ".agent-profile-kit",
  "opencode",
  "context.md",
);

export const OPENCODE_CONTEXT_REQUIREMENTS = [
  "OpenCode loads Profile Context through owned configuration instruction reference",
  "OpenCode instruction content remains subordinate to repository-owned instructions",
] as const;

export const OPENCODE_CONFIG_REQUIREMENTS = [
  "OpenCode loads Profile Context through owned configuration instruction reference",
] as const;

export const OPENCODE_CONFIG_OCCUPIED_REMEDY =
  "move authored OpenCode configuration to opencode.json or .opencode/opencode.json, " +
  "or change the Project Binding or Host selection so Agent Profile Kit does not plan output at that path, then retry";

export type OpenCodeProjectPlan = AdapterProjectPlan;

export interface OpenCodeCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly requireContext?: boolean;
  readonly requireSkills?: boolean;
  readonly resolveVersion?: () => Promise<string>;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Parse the leading semver from `opencode --version` output. */
export function parseOpenCodeCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw capabilityFailure(
      "opencode",
      `OpenCode version is unreadable from '${source.trim()}'`,
      `install OpenCode ${OPENCODE_MINIMUM_CLI_VERSION}+ and ensure \`opencode --version\` works before checking status or applying the Profile`,
    );
  }
  return normalizeCoreSemanticVersion(match[1]!, match[2]!, match[3]!);
}

/** Reject OpenCode versions that cannot discover native project instructions or Skills. */
export function assertOpenCodeCliVersionSupported(version: string): void {
  if (compareCoreSemanticVersions(version, OPENCODE_MINIMUM_CLI_VERSION) < 0) {
    throw capabilityFailure(
      "opencode",
      `OpenCode ${version} does not support native project instructions or Skills (requires ${OPENCODE_MINIMUM_CLI_VERSION}+)`,
      "upgrade OpenCode before checking status or applying the Profile",
    );
  }
}

async function resolveOpenCodeCliVersion(
  options: OpenCodeCapabilityOptions,
): Promise<string> {
  if (options.resolveVersion) return parseOpenCodeCliVersion(await options.resolveVersion());
  try {
    const { stdout, stderr } = await invokeExecutable("opencode", ["--version"], {
      env: options.env ?? process.env,
      timeoutMs: 10_000,
    });
    return parseOpenCodeCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw capabilityFailure(
        "opencode",
        "OpenCode was not found on PATH",
        `install OpenCode ${OPENCODE_MINIMUM_CLI_VERSION}+ and ensure \`opencode --version\` works before checking status or applying the Profile`,
      );
    }
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stdout || stderr) {
        try {
          return parseOpenCodeCliVersion(`${stdout}\n${stderr}`);
        } catch {
          // Fall through to generic capability failure below.
        }
      }
    }
    throw capabilityFailure(
      "opencode",
      `OpenCode version could not be detected (${error instanceof Error ? error.message : String(error)})`,
      `install OpenCode ${OPENCODE_MINIMUM_CLI_VERSION}+ before checking status or applying the Profile`,
    );
  }
}

/** Complete normalized machine-level requirements for the OpenCode probe. */
export function openCodeMachineRequirements(options: {
  readonly requireContext?: boolean;
  readonly requireSkills?: boolean;
}): Readonly<Record<string, boolean>> {
  return {
    requireContext: options.requireContext !== false,
    requireSkills: options.requireSkills === true,
  };
}

/** Resolve and validate OpenCode executable capability evidence. */
export async function probeOpenCodeMachineCapability(
  options: OpenCodeCapabilityOptions = {},
): Promise<string> {
  const version = await resolveOpenCodeCliVersion(options);
  assertOpenCodeCliVersionSupported(version);
  return version;
}

/** Reject OpenCode project surfaces that cannot host planned outputs. */
export async function assertOpenCodeProjectSurface(
  project: string,
  options: {
    readonly requireContext?: boolean;
    readonly requireSkills?: boolean;
  } = {},
): Promise<void> {
  const requireSkills = options.requireSkills === true;
  const requireContext = options.requireContext !== false;

  if (requireSkills) {
    const agentsPath = join(project, ".agents");
    const agentsKind = await classifyFileSystemEntry(agentsPath);
    if (agentsKind !== "missing" && agentsKind !== "directory") {
      const problem = `OpenCode shared project surface cannot host Skills: ${agentsPath} is a ${agentsKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        problem,
        "ensure the shared .agents project surface is a directory, then retry",
        [{ kind: "path", value: agentsPath }],
        problem,
      );
    }
    const skillsPath = join(project, ...OPENCODE_PROJECT_SKILLS_ROOT.split("/"));
    const skillsKind = await classifyFileSystemEntry(skillsPath);
    if (skillsKind !== "missing" && skillsKind !== "directory") {
      const problem = `OpenCode shared project surface cannot host Skills: ${skillsPath} is a ${skillsKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        problem,
        "ensure the shared .agents/skills surface is a directory, then retry",
        [{ kind: "path", value: skillsPath }],
        problem,
      );
    }
  }

  if (requireContext) {
    const opencodePath = join(project, ".opencode");
    const opencodeKind = await classifyFileSystemEntry(opencodePath);
    if (opencodeKind !== "missing" && opencodeKind !== "directory") {
      const problem = `OpenCode project surface cannot host outputs: ${opencodePath} is a ${opencodeKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        problem,
        "ensure the .opencode project surface is a directory, then retry",
        [{ kind: "path", value: opencodePath }],
        problem,
      );
    }
    const apkPath = join(project, ".agent-profile-kit");
    const apkKind = await classifyFileSystemEntry(apkPath);
    if (apkKind !== "missing" && apkKind !== "directory") {
      const problem = `OpenCode project surface cannot host Context: ${apkPath} is a ${apkKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        problem,
        "ensure the .agent-profile-kit project surface is a directory, then retry",
        [{ kind: "path", value: apkPath }],
        problem,
      );
    }
    const apkOpenCodePath = join(project, ".agent-profile-kit", "opencode");
    const apkOpenCodeKind = await classifyFileSystemEntry(apkOpenCodePath);
    if (apkOpenCodeKind !== "missing" && apkOpenCodeKind !== "directory") {
      const problem = `OpenCode project surface cannot host Context: ${apkOpenCodePath} is a ${apkOpenCodeKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        problem,
        "ensure the .agent-profile-kit/opencode project surface is a directory, then retry",
        [{ kind: "path", value: apkOpenCodePath }],
        problem,
      );
    }
  }
}

/** Prove the OpenCode executable and project surfaces needed by the selected Profile. */
export async function assertOpenCodeProjectCapability(
  project: string,
  options: OpenCodeCapabilityOptions = {},
): Promise<void> {
  await probeOpenCodeMachineCapability(options);
  await assertOpenCodeProjectSurface(project, options);
}

/**
 * Detect unsupported Profile features (disabled-invocation Skills)
 * for the OpenCode Adapter. Returns the list of typed capability failures.
 */
export function openCodeProfileCapabilityFailures(
  _modules: readonly ContextModuleSource[] = [],
  skills: readonly Skill[] = [],
): readonly AdapterCapabilityError[] {
  const failures: AdapterCapabilityError[] = [];
  const disabledSkill = skills.find((skill) => skill.modelInvocation === "disabled");
  if (disabledSkill) {
    failures.push(
      capabilityFailure(
        "opencode",
        `OpenCode does not support disabled model invocation for Skill '${disabledSkill.id}'`,
        "change the Skill's model-invocation policy to allowed or do not select OpenCode for this Project",
      ),
    );
  }
  return failures;
}

/** Reject unsupported Profile features before direct OpenCode planning. */
export function assertOpenCodeProfileSupported(
  modules: readonly ContextModuleSource[] = [],
  skills: readonly Skill[] = [],
): void {
  const [firstFailure] = openCodeProfileCapabilityFailures(modules, skills);
  if (firstFailure) throw firstFailure;
}

function openCodeConfiguration(contextPath: string): string {
  return `${JSON.stringify(
    {
      "$schema": "https://opencode.ai/config.json",
      "instructions": [contextPath],
    },
    null,
    2,
  )}\n`;
}

function contextOutput(
  profileId: string,
  modules: readonly ContextModuleSource[],
  materials: AdapterPlanningMaterials,
): ProposedProjectFileOutput {
  return {
    bytes: materials.composeContext(profileId, modules),
    mode: 0o644,
    origins: modules.map((module) => ({ id: module.id, type: "context" as const })),
    path: OPENCODE_CONTEXT_PATH,
    requirements: [...OPENCODE_CONTEXT_REQUIREMENTS],
    type: "file",
  };
}

function configurationOutput(
  modules: readonly ContextModuleSource[],
): ProposedProjectFileOutput {
  return {
    bytes: openCodeConfiguration(OPENCODE_CONTEXT_PATH),
    mode: 0o644,
    origins: modules.map((module) => ({ id: module.id, type: "context" as const })),
    path: OPENCODE_CONFIG_PATH,
    remedy: OPENCODE_CONFIG_OCCUPIED_REMEDY,
    requirements: [...OPENCODE_CONFIG_REQUIREMENTS],
    type: "file",
  };
}

function skillOutputs(
  skills: readonly Skill[],
  materials: AdapterPlanningMaterials,
): Promise<readonly ProposedProjectOutput[]> {
  return Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSharedSkillPackageDirectory(
          skill,
          [SHARED_SKILL_DISCOVERY_REQUIREMENT],
          "opencode",
          materials,
        ),
      ),
  );
}

/** Pure OpenCode Adapter planner for Profile Context and portable Skills. */
export async function planOpenCodeProject(
  profileId: string,
  modules: readonly ContextModuleSource[] = [],
  skills: readonly Skill[] = [],
  options: { readonly materials?: AdapterPlanningMaterials } = {},
): Promise<OpenCodeProjectPlan> {
  assertOpenCodeProfileSupported(modules, skills);
  const materials = options.materials ?? DEFAULT_ADAPTER_PLANNING_MATERIALS;
  const packages = await skillOutputs(skills, materials);
  const outputs: readonly ProposedProjectOutput[] = modules.length > 0
    ? [
        configurationOutput(modules),
        contextOutput(profileId, modules, materials),
        ...packages,
      ]
    : packages;
  const setupSteps: readonly AdapterHostSetupStep[] = modules.length > 0
    ? [
        {
          consequence:
            "A running OpenCode session keeps its previously loaded configuration until restarted.",
          kind: "launch-constraint",
          message: "Restart OpenCode to load changed configuration.",
          output: OPENCODE_CONFIG_PATH,
          provenance: "transition",
        },
      ]
    : [];
  return {
    host: "opencode",
    hostVersion: OPENCODE_HOST_VERSION,
    outputs,
    setupSteps,
  };
}

export const opencodeAdapter = {
  host: "opencode",
  async planProject(input, services) {
    const profileFailures = openCodeProfileCapabilityFailures(
      input.resolvedContexts,
      input.resolvedSkills,
    );
    const requireContext = input.resolvedContexts.length > 0;
    const requireSkills = input.resolvedSkills.length > 0;
    const capabilityFailures: unknown[] = [...profileFailures];

    if (input.checkHostCapability) {
      try {
        await services.probeMachineCapability(
          openCodeMachineRequirements({ requireContext, requireSkills }),
          () => probeOpenCodeMachineCapability({
            ...(input.env === undefined ? {} : { env: input.env }),
            requireContext,
            requireSkills,
          }),
        );
        await assertOpenCodeProjectSurface(input.project, {
          requireContext,
          requireSkills,
        });
      } catch (error) {
        capabilityFailures.push(error);
      }
    }

    let plan: OpenCodeProjectPlan | undefined;
    if (profileFailures.length === 0) {
      try {
        plan = await services.planProjection(
          {
            host: "opencode",
            options: {},
            profileId: input.profileId,
            resolvedContexts: input.resolvedContexts,
            resolvedSkills: input.resolvedSkills,
          },
          () => planOpenCodeProject(
            input.profileId,
            input.resolvedContexts,
            input.resolvedSkills,
            { materials: services.materials },
          ),
        );
      } catch (error) {
        if (!isAdapterCapabilityError(error)) throw error;
        capabilityFailures.push(error);
      }
    }

    return { capabilityFailures, diagnostics: [], plan };
  },
} satisfies CompleteHostAdapter;
