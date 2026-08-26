import { join } from "node:path";
import type { Skill } from "../schemas/skill.js";
import type { CompleteHostAdapter } from "./adapter-contract.js";
export { OPENCODE_ADAPTER_VERSION } from "./host-catalog.js";
import { type ContextModuleSource } from "./context-envelope.js";
import { capabilityFailure, isAdapterCapabilityError } from "./capability.js";
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
  AdapterProjectPlan,
  ProposedProjectOutput,
} from "./project-plan.js";

/** Capability Contract for OpenCode shared Skills. */
export const OPENCODE_HOST_VERSION = "native-project-shared-skills-v1";

/** Minimum OpenCode version verified for native shared Skill discovery. */
export const OPENCODE_MINIMUM_CLI_VERSION = "1.18.23";

/** OpenCode native project Skill discovery root. */
export const OPENCODE_PROJECT_SKILLS_ROOT = SHARED_SKILLS_DISCOVERY_ROOT;

export type OpenCodeProjectPlan = AdapterProjectPlan;

export interface OpenCodeCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
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

/** Reject OpenCode versions that cannot discover native project Skills. */
export function assertOpenCodeCliVersionSupported(version: string): void {
  if (compareCoreSemanticVersions(version, OPENCODE_MINIMUM_CLI_VERSION) < 0) {
    throw capabilityFailure(
      "opencode",
      `OpenCode ${version} does not support native project Skills (requires ${OPENCODE_MINIMUM_CLI_VERSION}+)`,
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
  readonly requireSkills?: boolean;
}): Readonly<Record<string, boolean>> {
  return {
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
  options: { readonly requireSkills?: boolean } = {},
): Promise<void> {
  if (options.requireSkills) {
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
}

/** Prove the OpenCode executable and project surfaces needed by the selected Profile. */
export async function assertOpenCodeProjectCapability(
  project: string,
  options: OpenCodeCapabilityOptions = {},
): Promise<void> {
  await probeOpenCodeMachineCapability(options);
  await assertOpenCodeProjectSurface(project, options);
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

/** Pure OpenCode Adapter planner for portable Skills. */
export async function planOpenCodeProject(
  _profileId: string,
  modules: readonly ContextModuleSource[] = [],
  skills: readonly Skill[] = [],
  options: { readonly materials?: AdapterPlanningMaterials } = {},
): Promise<OpenCodeProjectPlan> {
  if (modules.length > 0) {
    throw capabilityFailure(
      "opencode",
      "OpenCode does not support Profile Context",
      "remove Context from the selected Profile or do not select OpenCode for this Project",
    );
  }
  const disabledSkill = skills.find((skill) => skill.modelInvocation === "disabled");
  if (disabledSkill) {
    throw capabilityFailure(
      "opencode",
      `OpenCode does not support disabled model invocation for Skill '${disabledSkill.id}'`,
      "change the Skill's model-invocation policy to allowed or do not select OpenCode for this Project",
    );
  }
  const materials = options.materials ?? DEFAULT_ADAPTER_PLANNING_MATERIALS;
  const outputs = await skillOutputs(skills, materials);
  return {
    host: "opencode",
    hostVersion: OPENCODE_HOST_VERSION,
    outputs,
    setupSteps: [],
  };
}

export const opencodeAdapter = {
  host: "opencode",
  async planProject(input, services) {
    const requireContext = input.resolvedContexts.length > 0;
    const requireSkills = input.resolvedSkills.length > 0;
    const disabledSkill = input.resolvedSkills.find(
      (skill) => skill.modelInvocation === "disabled",
    );
    const capabilityFailures: unknown[] = [];

    if (requireContext) {
      capabilityFailures.push(
        capabilityFailure(
          "opencode",
          "OpenCode does not support Profile Context",
          "remove Context from the selected Profile or do not select OpenCode for this Project",
        ),
      );
    }
    if (disabledSkill) {
      capabilityFailures.push(
        capabilityFailure(
          "opencode",
          `OpenCode does not support disabled model invocation for Skill '${disabledSkill.id}'`,
          "change the Skill's model-invocation policy to allowed or do not select OpenCode for this Project",
        ),
      );
    }

    if (input.checkHostCapability) {
      try {
        await services.probeMachineCapability(
          openCodeMachineRequirements({ requireSkills }),
          () => probeOpenCodeMachineCapability({
            ...(input.env === undefined ? {} : { env: input.env }),
            requireSkills,
          }),
        );
        await assertOpenCodeProjectSurface(input.project, {
          requireSkills,
        });
      } catch (error) {
        capabilityFailures.push(error);
      }
    }

    let plan: AdapterProjectPlan | undefined;
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
      if (!capabilityFailures.some((existing) => isAdapterCapabilityError(existing) && existing.message === error.message)) {
        capabilityFailures.push(error);
      }
    }

    return { capabilityFailures, diagnostics: [], plan };
  },
} satisfies CompleteHostAdapter;
