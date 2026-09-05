import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";

import type { Skill } from "../schemas/skill.js";
import type { CompleteHostAdapter } from "./adapter-contract.js";
export { ANTIGRAVITY_ADAPTER_VERSION } from "./host-catalog.js";
import {
  composeContextModuleBoundary,
  type ContextModuleSource,
} from "./context-envelope.js";
import {
  caughtCapabilityFailure,
  capabilityFailure,
  isAdapterCapabilityError,
  versionFloorCapabilityFailure,
  type AdapterCapabilityFailure,
} from "./capability.js";
import {
  DEFAULT_ADAPTER_PLANNING_MATERIALS,
  skillsRequireDisabledModelInvocation,
  type AdapterPlanningMaterials,
} from "./skill-package.js";
import {
  planSharedSkillPackageDirectory,
  SHARED_SKILL_DISCOVERY_REQUIREMENT,
  SHARED_SKILLS_DISCOVERY_ROOT,
} from "./shared-skill.js";
import {
  identifierPart,
  type AdapterHostSetupStep,
  type AdapterProjectPlan,
  type ProposedProjectFileOutput,
  type ProposedProjectOutput,
} from "./project-plan.js";

const execFileAsync = promisify(execFile);

/** Capability Contract for complete always-on project Context rules. */
export const ANTIGRAVITY_HOST_VERSION = "native-project-always-on-rules-v1";
/** Capability Contract for shared Skills without Antigravity Context rules. */
export const ANTIGRAVITY_HOST_VERSION_WITH_SKILLS = "native-project-shared-skills-v1";
/** Capability Contract for Antigravity Context plus shared Skills. */
export const ANTIGRAVITY_HOST_VERSION_WITH_CONTEXT_AND_SKILLS =
  "native-project-always-on-rules-shared-skills-v1";
/** Capability Contract for shared Skills that remain explicit-only. */
export const ANTIGRAVITY_HOST_VERSION_WITH_INVOCATION =
  "native-project-shared-skills-invocation-v1";
/** Capability Contract for Antigravity Context plus explicit-only shared Skills. */
export const ANTIGRAVITY_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION =
  "native-project-always-on-rules-shared-skills-invocation-v1";
export const ANTIGRAVITY_MINIMUM_CLI_VERSION = "1.1.13";
export const ANTIGRAVITY_RULE_CHARACTER_LIMIT = 12_000;
export const ANTIGRAVITY_CONTEXT_RULES_ROOT = posix.join(".agents", "rules");
/** Antigravity's native project Skill discovery root. */
export const ANTIGRAVITY_SKILLS_DISCOVERY_ROOT = SHARED_SKILLS_DISCOVERY_ROOT;
export const ANTIGRAVITY_CONTEXT_REQUIREMENTS = [
  "Antigravity loads always-on Profile Context from native project .agents/rules",
  "Antigravity rule content remains subordinate to repository-owned instructions",
] as const;

const ANTIGRAVITY_RULE_FRONTMATTER = "---\ntrigger: always_on\n---\n\n";
const ANTIGRAVITY_RULE_PREFIX = "agent-profile-kit";
const ANTIGRAVITY_RULE_SEQUENCE_WIDTH = 3;

export type AntigravityProjectPlan = AdapterProjectPlan;

export interface AntigravityCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable version probe for tests; defaults to `agy --version`. */
  readonly resolveVersion?: () => Promise<string>;
  /** Whether the selected Profile requires Context rules. Defaults to true. */
  readonly requireContext?: boolean;
  /** Whether the selected Profile requires shared Skills. */
  readonly requireSkills?: boolean;
  /** Whether the selected Skills require explicit-only invocation semantics. */
  readonly requireDisabledModelInvocation?: boolean;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathKind(
  path: string,
): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "missing";
    if (hasErrorCode(error, "ENOTDIR")) return "other";
    throw error;
  }
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/** Parse the leading semver from `agy --version` output. */
export function parseAntigravityCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw capabilityFailure(
      "antigravity",
      "host",
      `Antigravity CLI version is unreadable from '${source.trim()}'`,
      `install Antigravity CLI ${ANTIGRAVITY_MINIMUM_CLI_VERSION}+ and ensure \`agy --version\` works before checking status or applying the Profile`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Reject CLI versions that cannot preserve the selected Antigravity surfaces. */
export function assertAntigravityCliVersionSupported(
  version: string,
  options: Pick<AntigravityCapabilityOptions, "requireContext" | "requireSkills" | "requireDisabledModelInvocation"> = {},
): void {
  if (compareSemver(version, ANTIGRAVITY_MINIMUM_CLI_VERSION) < 0) {
    const capability = options.requireSkills && options.requireContext === false
      ? "native project Skills"
      : options.requireDisabledModelInvocation
        ? "shared disabled-invocation Skill policy"
        : "native project always-on rules";
    throw versionFloorCapabilityFailure(
      "antigravity",
      `Antigravity CLI ${version} does not support ${capability} (requires ${ANTIGRAVITY_MINIMUM_CLI_VERSION}+)`,
      "upgrade Antigravity CLI before checking status or applying the Profile",
      ANTIGRAVITY_MINIMUM_CLI_VERSION,
    );
  }
}

async function resolveAntigravityCliVersion(
  options: AntigravityCapabilityOptions,
): Promise<string> {
  if (options.resolveVersion) return parseAntigravityCliVersion(await options.resolveVersion());
  try {
    const { stdout, stderr } = await execFileAsync("agy", ["--version"], {
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    return parseAntigravityCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw capabilityFailure(
        "antigravity",
        "host",
        "Antigravity CLI was not found on PATH",
        `install Antigravity CLI ${ANTIGRAVITY_MINIMUM_CLI_VERSION}+ and ensure \`agy --version\` works before checking status or applying the Profile`,
      );
    }
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stdout || stderr) {
        try {
          return parseAntigravityCliVersion(`${stdout}\n${stderr}`);
        } catch {
          // Fall through to the generic capability failure below.
        }
      }
    }
    throw capabilityFailure(
      "antigravity",
      "host",
      `Antigravity CLI version could not be detected (${error instanceof Error ? error.message : String(error)})`,
      `install Antigravity CLI ${ANTIGRAVITY_MINIMUM_CLI_VERSION}+ before checking status or applying the Profile`,
    );
  }
}

/** Complete machine-level requirements for the Antigravity CLI probe. */
export function antigravityMachineRequirements(options: {
  readonly requireContext?: boolean;
  readonly requireSkills?: boolean;
  readonly requireDisabledModelInvocation?: boolean;
}): Readonly<Record<string, boolean>> {
  return {
    requireContext: options.requireContext !== false,
    requireDisabledModelInvocation: options.requireDisabledModelInvocation === true,
    requireSkills: options.requireSkills === true,
  };
}

/** Resolve and validate Antigravity CLI capability evidence. */
export async function probeAntigravityMachineCapability(
  options: AntigravityCapabilityOptions = {},
): Promise<string> {
  const version = await resolveAntigravityCliVersion(options);
  assertAntigravityCliVersionSupported(version, options);
  return version;
}

function surfaceFailure(
  project: string,
  path: string,
  kind: string,
  requirement: string,
): ReturnType<typeof capabilityFailure> {
  const problem = `Antigravity project surface cannot host ${requirement}: ${path} is a ${kind}, not a directory`;
  return capabilityFailure(
    "antigravity",
    "project",
    problem,
    `ensure the Antigravity ${requirement} surface is a directory, then retry`,
    [{ kind: "path", value: join(project, path) }],
    [
      `Antigravity project surface cannot host ${requirement}: `,
      identifierPart(path),
      ` is a ${kind}, not a directory`,
    ],
  );
}

/** Reject required Antigravity project surfaces that are not real directories. */
export async function assertAntigravityProjectSurface(
  project: string,
  options: { readonly requireContext?: boolean; readonly requireSkills?: boolean } = {},
): Promise<void> {
  const requireContext = options.requireContext !== false;
  const requireSkills = options.requireSkills === true;
  if (!requireContext && !requireSkills) return;

  const agentsPath = join(project, ".agents");
  const agentsKind = await pathKind(agentsPath);
  if (agentsKind !== "missing" && agentsKind !== "directory") {
    throw surfaceFailure(
      project,
      ".agents",
      agentsKind,
      requireContext && requireSkills ? "Context and Skills" : requireContext ? "Context" : "Skills",
    );
  }

  if (requireContext) {
    const rulesPath = join(project, ...ANTIGRAVITY_CONTEXT_RULES_ROOT.split("/"));
    const rulesKind = await pathKind(rulesPath);
    if (rulesKind !== "missing" && rulesKind !== "directory") {
      throw surfaceFailure(project, ANTIGRAVITY_CONTEXT_RULES_ROOT, rulesKind, "Context rules");
    }
  }

  if (requireSkills) {
    const skillsPath = join(project, ".agents", "skills");
    const skillsKind = await pathKind(skillsPath);
    if (skillsKind !== "missing" && skillsKind !== "directory") {
      throw surfaceFailure(project, ".agents/skills", skillsKind, "Skills");
    }
  }
}

/** Prove the Antigravity CLI and project surfaces needed by the selected Profile. */
export async function assertAntigravityProjectCapability(
  project: string,
  options: AntigravityCapabilityOptions = {},
): Promise<void> {
  await probeAntigravityMachineCapability(options);
  await assertAntigravityProjectSurface(project, options);
}

function ruleCharacterCount(source: string): number {
  return [...source].length;
}

function rulePath(index: number, moduleId?: string): string {
  const numericSequence = String(index * 10);
  if (numericSequence.length > ANTIGRAVITY_RULE_SEQUENCE_WIDTH) {
    const problem =
      `Antigravity rule sequence '${numericSequence}' cannot preserve stable lexical order within ${ANTIGRAVITY_RULE_SEQUENCE_WIDTH}-digit rule names`;
    throw capabilityFailure(
      "antigravity",
      "project",
      problem,
      "select fewer Context Modules and retry",
      [],
      [
        "Antigravity rule sequence '",
        identifierPart(numericSequence),
        `' cannot preserve stable lexical order within ${ANTIGRAVITY_RULE_SEQUENCE_WIDTH}-digit rule names`,
      ],
    );
  }
  const sequence = numericSequence.padStart(ANTIGRAVITY_RULE_SEQUENCE_WIDTH, "0");
  return posix.join(
    ANTIGRAVITY_CONTEXT_RULES_ROOT,
    `${ANTIGRAVITY_RULE_PREFIX}-${sequence}-${moduleId ?? "envelope"}.md`,
  );
}

function ruleBytes(body: string): string {
  const content = body.endsWith("\n") ? body : `${body}\n`;
  return `${ANTIGRAVITY_RULE_FRONTMATTER}${content}`;
}

function assertRuleSize(path: string, bytes: string): void {
  if (ruleCharacterCount(bytes) <= ANTIGRAVITY_RULE_CHARACTER_LIMIT) return;
  const problem = `Antigravity rule '${path}' is ${ruleCharacterCount(bytes)} characters, exceeding the ${ANTIGRAVITY_RULE_CHARACTER_LIMIT}-character limit`;
  throw capabilityFailure(
    "antigravity",
    "project",
    problem,
    "shorten the selected Context Module so its complete always-on rule fits, then retry",
    [{ kind: "path", value: path }],
    [
      "Antigravity rule '",
      identifierPart(path),
      `' is ${ruleCharacterCount(bytes)} characters, exceeding the ${ANTIGRAVITY_RULE_CHARACTER_LIMIT}-character limit`,
    ],
  );
}

function envelopeOutput(
  profileId: string,
  materials: AdapterPlanningMaterials,
): ProposedProjectFileOutput {
  const path = rulePath(0);
  const bytes = ruleBytes(materials.composeContext(profileId, []));
  assertRuleSize(path, bytes);
  return {
    bytes,
    mode: 0o644,
    origins: [],
    path,
    requirements: [...ANTIGRAVITY_CONTEXT_REQUIREMENTS],
    type: "file",
  };
}

function moduleOutput(
  module: ContextModuleSource,
  index: number,
): ProposedProjectFileOutput {
  const path = rulePath(index, module.id);
  const bytes = ruleBytes(composeContextModuleBoundary(module));
  assertRuleSize(path, bytes);
  return {
    bytes,
    mode: 0o644,
    origins: [{ id: module.id, type: "context" }],
    path,
    requirements: [
      ...ANTIGRAVITY_CONTEXT_REQUIREMENTS,
      `Antigravity preserves complete Context Module '${module.id}' in one always-on rule`,
    ],
    type: "file",
  };
}

/** Pure Antigravity Adapter planner for Profile Context and shared Skills. */
export async function planAntigravityProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  skills: readonly Skill[],
  options: { readonly materials?: AdapterPlanningMaterials } = {},
): Promise<AntigravityProjectPlan> {
  const materials = options.materials ?? DEFAULT_ADAPTER_PLANNING_MATERIALS;
  const skillOutputs = await Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSharedSkillPackageDirectory(
          skill,
          [SHARED_SKILL_DISCOVERY_REQUIREMENT],
          "antigravity",
          materials,
        ),
      ),
  );
  const outputs: readonly ProposedProjectOutput[] = modules.length === 0
    ? skillOutputs
    : [envelopeOutput(profileId, materials), ...modules.map((module, index) => moduleOutput(module, index + 1)), ...skillOutputs];
  const setupSteps: readonly AdapterHostSetupStep[] = outputs.length > 0
    ? [{
        consequence: "The Profile does not load until the project is trusted.",
        kind: "trust-required",
        message: "Trust the bound project in Antigravity.",
        provenance: "standing",
      }]
    : [];
  const requiresDisabledModelInvocation = skillsRequireDisabledModelInvocation(skills);
  return {
    host: "antigravity",
    hostVersion: skills.length === 0
      ? ANTIGRAVITY_HOST_VERSION
      : requiresDisabledModelInvocation
        ? modules.length > 0
          ? ANTIGRAVITY_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION
          : ANTIGRAVITY_HOST_VERSION_WITH_INVOCATION
        : modules.length > 0
          ? ANTIGRAVITY_HOST_VERSION_WITH_CONTEXT_AND_SKILLS
          : ANTIGRAVITY_HOST_VERSION_WITH_SKILLS,
    outputs,
    setupSteps,
  };
}

export const antigravityAdapter = {
  host: "antigravity",
  async planProject(input, services) {
    const requireContext = input.resolvedContexts.length > 0;
    const requireSkills = input.resolvedSkills.length > 0;
    const requireDisabledModelInvocation = skillsRequireDisabledModelInvocation(
      input.resolvedSkills,
    );
    const capabilityFailures: AdapterCapabilityFailure[] = [];
    if (input.checkHostCapability) {
      try {
        await services.probeMachineCapability(
          antigravityMachineRequirements({
            requireContext,
            requireDisabledModelInvocation,
            requireSkills,
          }),
          () => probeAntigravityMachineCapability({
            ...(input.env === undefined ? {} : { env: input.env }),
            requireContext,
            requireDisabledModelInvocation,
            requireSkills,
          }),
        );
      } catch (error) {
        capabilityFailures.push(caughtCapabilityFailure("antigravity", "host", error));
      }
      // The Project surface is independent of the CLI probe: an obstructed
      // surface is Project-specific evidence even when the CLI also failed.
      try {
        await assertAntigravityProjectSurface(input.project, {
          requireContext,
          requireSkills,
        });
      } catch (error) {
        capabilityFailures.push(caughtCapabilityFailure("antigravity", "project", error));
      }
    }

    // Projection refusals (for example an oversized Context Module) throw: an
    // Adapter that cannot plan valid output must fail the invocation rather
    // than return a partial plan.
    const plan = await services.planProjection(
      {
        host: "antigravity",
        options: {},
        profileId: input.profileId,
        resolvedContexts: input.resolvedContexts,
        resolvedSkills: input.resolvedSkills,
      },
      () => planAntigravityProject(
        input.profileId,
        input.resolvedContexts,
        input.resolvedSkills,
        { materials: services.materials },
      ),
    );

    return { capabilityFailures, diagnostics: [], plan };
  },
} satisfies CompleteHostAdapter;
