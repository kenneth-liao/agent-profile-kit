import { join, posix } from "node:path";
import type { Skill } from "../schemas/skill.js";
import type { CompleteHostAdapter } from "./adapter-contract.js";
export { OPENCODE_ADAPTER_VERSION } from "./host-catalog.js";
import { type ContextModuleSource } from "./context-envelope.js";
import {
  caughtCapabilityFailure,
  capabilityFailure,
  isAdapterCapabilityError,
  type AdapterCapabilityError,
  versionFloorCapabilityFailure,
  type AdapterCapabilityFailure,
} from "./capability.js";
import { invokeExecutable } from "./services/executable.js";
import { classifyFileSystemEntry } from "./services/project-surface.js";
import {
  compareCoreSemanticVersions,
  normalizeCoreSemanticVersion,
} from "./services/semantic-version.js";
import {
  DEFAULT_ADAPTER_PLANNING_MATERIALS,
  skillsRequireDisabledModelInvocation,
  type AdapterPlanningMaterials,
} from "./skill-package.js";
import type { SupportedHost } from "./host-catalog.js";
import { CLAUDE_SKILLS_DISCOVERY_ROOT } from "./claude.js";
import {
  planSharedSkillPackageDirectory,
  SHARED_SKILLS_DISCOVERY_ROOT,
  SHARED_SKILL_DISCOVERY_REQUIREMENT,
} from "./shared-skill.js";
import {
  identifierPart,
  type AdapterDiagnosticWarning,
  type AdapterHostSetupStep,
  type AdapterProjectPlan,
  type OutputRemedyKey,
  type ProposedProjectFileOutput,
  type ProposedProjectOutput,
} from "./project-plan.js";

/** Capability Contract for OpenCode native project instructions and shared Skills. */
export const OPENCODE_HOST_VERSION = "native-project-instructions-skills-v1";
/**
 * Capability Contract for OpenCode native project instructions and shared Skills
 * whose generated global rule denies model loading while native Skill commands
 * remain available for explicit activation. User-authored permission overrides
 * and command collisions remain Host Resolution.
 *
 * Evidence: OpenCode 1.18.23 filters globally denied Skills from the model-facing
 * inventory and rejects guessed `skill` tool calls before an approval request,
 * including in auto mode. Its separate native command inventory registers every
 * discovered Skill and expands an explicit `/<Artifact ID>` without the Skill
 * permission path.
 */
export const OPENCODE_HOST_VERSION_WITH_INVOCATION =
  "native-project-instructions-skills-invocation-v1";

/**
 * Minimum OpenCode version verified for native shared Skill discovery, denied
 * model loading, and explicit native Skill command activation.
 */
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

export const OPENCODE_CONFIG_INVOCATION_REQUIREMENTS = [
  "OpenCode blocks model-selected Skill loading while native Skill commands remain available for explicit activation",
] as const;

export const OPENCODE_CONFIG_OCCUPIED_REMEDY_KEY = "opencode-config-occupied" as const satisfies OutputRemedyKey;

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
      "host",
      `OpenCode version is unreadable from '${source.trim()}'`,
      `install OpenCode ${OPENCODE_MINIMUM_CLI_VERSION}+ and ensure \`opencode --version\` works before checking status or applying the Profile`,
    );
  }
  return normalizeCoreSemanticVersion(match[1]!, match[2]!, match[3]!);
}

/** Reject OpenCode versions that cannot discover native project instructions or Skills. */
export function assertOpenCodeCliVersionSupported(version: string): void {
  if (compareCoreSemanticVersions(version, OPENCODE_MINIMUM_CLI_VERSION) < 0) {
    throw versionFloorCapabilityFailure(
      "opencode",
      `OpenCode ${version} does not support native project instructions or Skills (requires ${OPENCODE_MINIMUM_CLI_VERSION}+)`,
      "upgrade OpenCode before checking status or applying the Profile",
      OPENCODE_MINIMUM_CLI_VERSION,
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
        "host",
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
      "host",
      `OpenCode version could not be detected (${error instanceof Error ? error.message : String(error)})`,
      `install OpenCode ${OPENCODE_MINIMUM_CLI_VERSION}+ before checking status or applying the Profile`,
    );
  }
}

/** Complete normalized machine-level requirements for the OpenCode probe. */
export function openCodeMachineRequirements(options: {
  readonly requireConfig?: boolean;
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
    readonly requireConfig?: boolean;
    readonly requireContext?: boolean;
    readonly requireSkills?: boolean;
  } = {},
): Promise<void> {
  const requireSkills = options.requireSkills === true;
  const requireContext = options.requireContext !== false;
  const requireConfig = options.requireConfig === true || requireContext;

  if (requireSkills) {
    const agentsPath = join(project, ".agents");
    const agentsKind = await classifyFileSystemEntry(agentsPath);
    if (agentsKind !== "missing" && agentsKind !== "directory") {
      const problem = `OpenCode shared project surface cannot host Skills: ${agentsPath} is a ${agentsKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        "project",
        problem,
        "ensure the shared .agents project surface is a directory, then retry",
        [{ kind: "path", value: agentsPath }],
        [
          "OpenCode shared project surface cannot host Skills: ",
          identifierPart(agentsPath),
          ` is a ${agentsKind}, not a directory`,
        ],
      );
    }
    const skillsPath = join(project, ...OPENCODE_PROJECT_SKILLS_ROOT.split("/"));
    const skillsKind = await classifyFileSystemEntry(skillsPath);
    if (skillsKind !== "missing" && skillsKind !== "directory") {
      const problem = `OpenCode shared project surface cannot host Skills: ${skillsPath} is a ${skillsKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        "project",
        problem,
        "ensure the shared .agents/skills surface is a directory, then retry",
        [{ kind: "path", value: skillsPath }],
        [
          "OpenCode shared project surface cannot host Skills: ",
          identifierPart(skillsPath),
          ` is a ${skillsKind}, not a directory`,
        ],
      );
    }
  }

  if (requireConfig) {
    const opencodePath = join(project, ".opencode");
    const opencodeKind = await classifyFileSystemEntry(opencodePath);
    if (opencodeKind !== "missing" && opencodeKind !== "directory") {
      const problem = `OpenCode project surface cannot host outputs: ${opencodePath} is a ${opencodeKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        "project",
        problem,
        "ensure the .opencode project surface is a directory, then retry",
        [{ kind: "path", value: opencodePath }],
        [
          "OpenCode project surface cannot host outputs: ",
          identifierPart(opencodePath),
          ` is a ${opencodeKind}, not a directory`,
        ],
      );
    }
  }

  if (requireContext) {
    const apkPath = join(project, ".agent-profile-kit");
    const apkKind = await classifyFileSystemEntry(apkPath);
    if (apkKind !== "missing" && apkKind !== "directory") {
      const problem = `OpenCode project surface cannot host Context: ${apkPath} is a ${apkKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        "project",
        problem,
        "ensure the .agent-profile-kit project surface is a directory, then retry",
        [{ kind: "path", value: apkPath }],
        [
          "OpenCode project surface cannot host Context: ",
          identifierPart(apkPath),
          ` is a ${apkKind}, not a directory`,
        ],
      );
    }
    const apkOpenCodePath = join(project, ".agent-profile-kit", "opencode");
    const apkOpenCodeKind = await classifyFileSystemEntry(apkOpenCodePath);
    if (apkOpenCodeKind !== "missing" && apkOpenCodeKind !== "directory") {
      const problem = `OpenCode project surface cannot host Context: ${apkOpenCodePath} is a ${apkOpenCodeKind}, not a directory`;
      throw capabilityFailure(
        "opencode",
        "project",
        problem,
        "ensure the .agent-profile-kit/opencode project surface is a directory, then retry",
        [{ kind: "path", value: apkOpenCodePath }],
        [
          "OpenCode project surface cannot host Context: ",
          identifierPart(apkOpenCodePath),
          ` is a ${apkOpenCodeKind}, not a directory`,
        ],
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
 * Detect unsupported Profile features for the OpenCode Adapter.
 * Returns the list of typed capability failures.
 */
export function openCodeProfileCapabilityFailures(
  _modules: readonly ContextModuleSource[] = [],
  _skills: readonly Skill[] = [],
): readonly AdapterCapabilityError[] {
  return [];
}

/** Reject unsupported Profile features before direct OpenCode planning. */
export function assertOpenCodeProfileSupported(
  modules: readonly ContextModuleSource[] = [],
  skills: readonly Skill[] = [],
): void {
  const [firstFailure] = openCodeProfileCapabilityFailures(modules, skills);
  if (firstFailure) throw firstFailure;
}

function openCodeConfiguration(options: {
  readonly contextPath?: string | undefined;
  readonly disabledSkills?: readonly Skill[] | undefined;
}): string {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };
  if (options.contextPath) {
    config.instructions = [options.contextPath];
  }
  if (options.disabledSkills && options.disabledSkills.length > 0) {
    const sortedSkills = [...options.disabledSkills].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const skillPermissions: Record<string, string> = {};
    for (const skill of sortedSkills) {
      skillPermissions[skill.id] = "deny";
    }
    config.permission = {
      skill: skillPermissions,
    };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
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
  disabledSkills: readonly Skill[] = [],
): ProposedProjectFileOutput {
  const requirements: string[] = [
    ...(modules.length > 0 ? OPENCODE_CONFIG_REQUIREMENTS : []),
    ...(disabledSkills.length > 0 ? OPENCODE_CONFIG_INVOCATION_REQUIREMENTS : []),
  ];
  const origins = [
    ...modules.map((module) => ({ id: module.id, type: "context" as const })),
    ...disabledSkills.map((skill) => ({ id: skill.id, type: "skill" as const })),
  ];
  return {
    bytes: openCodeConfiguration({
      contextPath: modules.length > 0 ? OPENCODE_CONTEXT_PATH : undefined,
      disabledSkills,
    }),
    mode: 0o644,
    origins,
    path: OPENCODE_CONFIG_PATH,
    remedyKey: OPENCODE_CONFIG_OCCUPIED_REMEDY_KEY,
    requirements,
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
  const disabledSkills = skills.filter((skill) => skill.modelInvocation === "disabled");
  const hasConfig = modules.length > 0 || disabledSkills.length > 0;

  const outputs: ProposedProjectOutput[] = [];
  if (hasConfig) {
    outputs.push(configurationOutput(modules, disabledSkills));
  }
  if (modules.length > 0) {
    outputs.push(contextOutput(profileId, modules, materials));
  }
  outputs.push(...packages);

  const setupSteps: readonly AdapterHostSetupStep[] = hasConfig
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

  const hostVersion = skillsRequireDisabledModelInvocation(skills)
    ? OPENCODE_HOST_VERSION_WITH_INVOCATION
    : OPENCODE_HOST_VERSION;

  return {
    host: "opencode",
    hostVersion,
    outputs,
    setupSteps,
  };
}

export const opencodeAdapter = {
  host: "opencode",
  async planProject(input, services) {
    // Profile-policy refusals throw: an Adapter that cannot plan valid output
    // must fail the invocation rather than return a partial plan.
    assertOpenCodeProfileSupported(input.resolvedContexts, input.resolvedSkills);
    const requireContext = input.resolvedContexts.length > 0;
    const requireSkills = input.resolvedSkills.length > 0;
    const requireConfig =
      requireContext || skillsRequireDisabledModelInvocation(input.resolvedSkills);
    const capabilityFailures: AdapterCapabilityFailure[] = [];

    if (input.checkHostCapability) {
      try {
        await services.probeMachineCapability(
          openCodeMachineRequirements({ requireConfig, requireContext, requireSkills }),
          () => probeOpenCodeMachineCapability({
            ...(input.env === undefined ? {} : { env: input.env }),
            requireContext,
            requireSkills,
          }),
        );
      } catch (error) {
        capabilityFailures.push(caughtCapabilityFailure("opencode", "host", error));
      }
      // The Project surface is independent of the CLI probe: an obstructed
      // surface is Project-specific evidence even when the CLI also failed.
      try {
        await assertOpenCodeProjectSurface(input.project, {
          requireConfig,
          requireContext,
          requireSkills,
        });
      } catch (error) {
        capabilityFailures.push(caughtCapabilityFailure("opencode", "project", error));
      }
    }

    const plan = await services.planProjection(
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

    return { capabilityFailures, diagnostics: [], plan };
  },
} satisfies CompleteHostAdapter;
