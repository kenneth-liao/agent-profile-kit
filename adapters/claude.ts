import { join, posix } from "node:path";

import type { Skill } from "../schemas/skill.js";
import type { CompleteHostAdapter } from "./adapter-contract.js";
export { CLAUDE_ADAPTER_VERSION } from "./host-catalog.js";
import { type ContextModuleSource } from "./context-envelope.js";
import { capabilityFailure } from "./capability.js";
import type {
  AdapterProjectPlan,
  ProposedDirectoryFileMember,
  ProposedDirectoryMember,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";
import { invokeExecutable } from "./services/executable.js";
import { classifyFileSystemEntry } from "./services/project-surface.js";
import {
  compareCoreSemanticVersions,
  normalizeCoreSemanticVersion,
} from "./services/semantic-version.js";
import { emitSharedSkillMarkdown } from "./shared-skill.js";
import {
  DEFAULT_ADAPTER_PLANNING_MATERIALS,
  DISABLED_MODEL_INVOCATION_REQUIREMENT,
  planSkillPackageDirectory,
  skillsRequireDisabledModelInvocation,
  type AdapterPlanningMaterials,
  type SkillPackageProjection,
} from "./skill-package.js";

/**
 * Capability-contract token recorded in Installation Manifest host_versions after
 * the installed Claude CLI is proven to support unscoped project rules and native
 * project Skill discovery under `.claude/skills/`.
 *
 * Evidence: Claude Code 2.0.64+ loads recursive `.claude/rules/`; project Skills
 * under `.claude/skills/` are available on that same floor and earlier. Preflight
 * therefore records one contract for both Claude project outputs when no Skill
 * requires disabled model invocation.
 */
export const CLAUDE_HOST_VERSION = "native-project-unscoped-rules-skills-v1";

/**
 * Capability-contract token when a selected Skill requires disabled model invocation.
 * Proven by the same Claude CLI floor as native Skill discovery, which honors
 * `disable-model-invocation` in project Skill frontmatter.
 *
 * Evidence: Claude Code project Skills (floor 2.0.64+) read standard Skill packages
 * including top-level `disable-model-invocation`; without that Host field the
 * explicit-only policy would be silently ignored.
 */
export const CLAUDE_HOST_VERSION_WITH_INVOCATION =
  "native-project-unscoped-rules-skills-invocation-v1";

/**
 * Minimum Claude Code CLI version that preserves the Claude project Capability Contract.
 * Evidence: Anthropic Claude Code changelog — `.claude/rules/` added in 2.0.64;
 * that floor already includes native project Skill package discovery and
 * `disable-model-invocation` enforcement for installed Skills.
 */
export const CLAUDE_MINIMUM_CLI_VERSION = "2.0.64";

/** Owned unscoped Claude project rule path (no paths frontmatter). */
export const CLAUDE_CONTEXT_RULE_PATH = posix.join(
  ".claude",
  "rules",
  "agent-profile-kit.md",
);

/**
 * Semantic requirements for the owned Claude Context rule.
 * Shared Host consumers (for example Grok Claude-rules compatibility) must plan
 * the same list so Installer normalization can coalesce exact output.
 */
export const CLAUDE_CONTEXT_REQUIREMENTS = [
  "Claude loads unscoped project rule as additive Profile Context",
  "Claude re-injects unscoped rules after compaction",
] as const;

/** Claude native project Skill discovery root. */
export const CLAUDE_SKILLS_DISCOVERY_ROOT = posix.join(".claude", "skills");

export type ClaudeProjectPlan = AdapterProjectPlan;

export interface ClaudeCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * When false, skip unscoped project-rule surface preflight (Skills-only Profiles
   * that plan no Context rule). Defaults to true. CLI floor still applies when
   * disabled model invocation or Context is required.
   */
  readonly requireContext?: boolean;
  /** When true, prove Host can enforce disabled model invocation. */
  readonly requireDisabledModelInvocation?: boolean;
  /** Injectable version probe for tests; defaults to `claude --version`. */
  readonly resolveVersion?: () => Promise<string>;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}


function memberBytesAsString(bytes: string | Uint8Array): string {
  return typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
}

/** Parse the leading semver from `claude --version` output. */
export function parseClaudeCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw capabilityFailure(
      "claude",
      `Claude CLI version is unreadable from '${source.trim()}'`,
      "install a supported Claude Code release",
    );
  }
  return normalizeCoreSemanticVersion(match[1]!, match[2]!, match[3]!);
}

/**
 * Reject Claude Code CLI releases that cannot preserve required Claude surfaces.
 * The same CLI floor covers unscoped project-rule Context, native Skill discovery,
 * and disable-model-invocation; messaging reflects which surface is required.
 */
export function assertClaudeCliVersionSupported(
  version: string,
  options: {
    readonly requireContext?: boolean;
    readonly requireDisabledModelInvocation?: boolean;
  } = {},
): void {
  if (compareCoreSemanticVersions(version, CLAUDE_MINIMUM_CLI_VERSION) < 0) {
    if (options.requireDisabledModelInvocation) {
      throw capabilityFailure(
        "claude",
        `Claude CLI ${version} cannot enforce disabled model invocation via disable-model-invocation (requires ${CLAUDE_MINIMUM_CLI_VERSION}+)`,
        "upgrade Claude Code before checking status or applying the Profile",
      );
    }
    if (options.requireContext === false) {
      throw capabilityFailure(
        "claude",
        `Claude CLI ${version} does not support native project Skills (requires ${CLAUDE_MINIMUM_CLI_VERSION}+)`,
        "upgrade Claude Code before checking status or applying the Profile",
      );
    }
    throw capabilityFailure(
      "claude",
      `Claude CLI ${version} does not support unscoped project rules (requires ${CLAUDE_MINIMUM_CLI_VERSION}+)`,
      "upgrade Claude Code before checking status or applying the Profile",
    );
  }
}

async function resolveClaudeCliVersion(
  options: ClaudeCapabilityOptions,
): Promise<string> {
  if (options.resolveVersion) return options.resolveVersion();
  try {
    const { stdout, stderr } = await invokeExecutable("claude", ["--version"], {
      env: options.env ?? process.env,
      timeoutMs: 10_000,
    });
    return parseClaudeCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw capabilityFailure(
        "claude",
        "Claude Code CLI was not found on PATH",
        "install Claude Code and ensure `claude --version` works before checking status or applying the Profile",
      );
    }
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stdout || stderr) {
        try {
          return parseClaudeCliVersion(`${stdout}\n${stderr}`);
        } catch {
          // fall through to generic failure
        }
      }
    }
    throw capabilityFailure(
      "claude",
      `Claude Code CLI version could not be detected (${error instanceof Error ? error.message : String(error)})`,
      "install a supported Claude Code release before checking status or applying the Profile",
    );
  }
}

/**
 * Complete normalized machine-level requirements that affect the Claude CLI
 * probe result. Callers route identical requirement sets through one probe per
 * invocation so distinct sets cannot reuse incompatible evidence.
 */
export function claudeMachineRequirements(options: {
  readonly requireContext?: boolean;
  readonly requireDisabledModelInvocation?: boolean;
}): Readonly<Record<string, boolean>> {
  return {
    requireContext: options.requireContext !== false,
    requireDisabledModelInvocation: options.requireDisabledModelInvocation === true,
  };
}

/**
 * Resolve and validate the Claude CLI version at one machine-level boundary.
 * Runs the `claude --version` executable at most once per unique requirement
 * set per invocation when routed through the invocation-scoped planning
 * context. Returns the normalized core semver or throws a capability failure
 * for missing, unreadable, or outdated Host executables.
 */
export async function probeClaudeMachineCapability(
  options: ClaudeCapabilityOptions,
): Promise<string> {
  const version = await resolveClaudeCliVersion(options);
  assertClaudeCliVersionSupported(version, {
    requireContext: options.requireContext !== false,
    ...(options.requireDisabledModelInvocation
      ? { requireDisabledModelInvocation: true }
      : {}),
  });
  return version;
}

/**
 * Reject Claude project surfaces that cannot host planned outputs. The CLI
 * floor is proven by the machine-level probe; this checks only Project-specific
 * paths and still runs for every affected Project.
 */
export async function assertClaudeProjectSurface(
  project: string,
  options: { readonly requireContext?: boolean } = {},
): Promise<void> {
  const requireContext = options.requireContext !== false;

  // Skills-only and Context-bearing plans both write under `.claude/`.
  const claudePath = join(project, ".claude");
  const claudeKind = await classifyFileSystemEntry(claudePath);
  if (claudeKind !== "missing" && claudeKind !== "directory") {
    const problem =
      `Claude project surface cannot host outputs: ${claudePath} is a ${claudeKind}, not a directory`;
    throw capabilityFailure(
      "claude",
      problem,
      "ensure the Claude project surface is a directory, then retry",
      [{ kind: "path", value: claudePath }],
      problem,
    );
  }

  // Skills-only Profiles do not write unscoped rules; skip the rules surface then.
  if (!requireContext) {
    return;
  }

  const rulesPath = join(project, ".claude", "rules");
  const rulesKind = await classifyFileSystemEntry(rulesPath);
  if (rulesKind !== "missing" && rulesKind !== "directory") {
    const problem =
      `Claude project surface cannot host unscoped rules: ${rulesPath} is a ${rulesKind}, not a directory`;
    throw capabilityFailure(
      "claude",
      problem,
      "ensure the Claude rules surface is a directory, then retry",
      [{ kind: "path", value: rulesPath }],
      problem,
    );
  }
}

/**
 * Reject project surfaces or Host installs that cannot host Claude project outputs.
 * Every Claude plan shares the `.claude` root (Skills and/or Context). Unscoped-rule
 * surface preflight (`.claude/rules`) runs only when Context is selected.
 * When selected Skills require disabled model invocation, proves the CLI floor that
 * honors `disable-model-invocation` before any project or state write.
 * Authentication, trust, approvals, plugins, and sessions are never inspected or written.
 */
export async function assertClaudeProjectCapability(
  project: string,
  options: ClaudeCapabilityOptions = {},
): Promise<void> {
  await probeClaudeMachineCapability(options);
  await assertClaudeProjectSurface(project, options);
}

/** Claude-owned Skill package projection (Host-native model-invocation mapping). */
export function projectClaudeSkillMembers(
  skill: Skill,
  members: readonly ProposedDirectoryMember[],
): readonly ProposedDirectoryMember[] {
  return members.map((member) => {
    if (member.type !== "file" || member.path !== "SKILL.md") return member;
    const projected: ProposedDirectoryFileMember = {
      ...member,
      bytes: emitSharedSkillMarkdown(
        skill.id,
        memberBytesAsString(member.bytes),
        skill.modelInvocation,
      ),
    };
    return projected;
  });
}

export function claudeSkillRequirements(
  skill: Skill,
  base: readonly string[],
): readonly string[] {
  if (skill.modelInvocation !== "disabled") return base;
  return [
    ...base,
    DISABLED_MODEL_INVOCATION_REQUIREMENT,
    "Claude disable-model-invocation frontmatter enforces disabled model invocation",
  ];
}

const CLAUDE_SKILL_PROJECTION: SkillPackageProjection = {
  projectMembers: projectClaudeSkillMembers,
  requirements: claudeSkillRequirements,
};

function contextRule(
  profileId: string,
  modules: readonly ContextModuleSource[],
  materials: AdapterPlanningMaterials,
): ProposedProjectFileOutput {
  return {
    // Unscoped rule: no YAML paths frontmatter, so Claude re-injects after compaction.
    bytes: materials.composeContext(profileId, modules),
    mode: 0o644,
    origins: modules.map((module) => ({ id: module.id, type: "context" as const })),
    path: CLAUDE_CONTEXT_RULE_PATH,
    requirements: [...CLAUDE_CONTEXT_REQUIREMENTS],
    type: "file",
  };
}

/**
 * Pure Claude Adapter planner for Profile Context and portable Skills.
 * Does not write filesystem state or coordinate with other Adapters.
 */
export const claudeAdapter = {
  host: "claude",
  async planProject(input, services) {
    const requireContext = input.resolvedContexts.length > 0;
    const requireDisabledModelInvocation = skillsRequireDisabledModelInvocation(
      input.resolvedSkills,
    );
    const capabilityFailures: unknown[] = [];
    if (input.checkHostCapability) {
      try {
        const requirements = claudeMachineRequirements({
          requireContext,
          requireDisabledModelInvocation,
        });
        await services.probeMachineCapability(
          requirements,
          () => probeClaudeMachineCapability({
            ...(input.env === undefined ? {} : { env: input.env }),
            requireContext,
            requireDisabledModelInvocation,
          }),
        );
        await assertClaudeProjectSurface(input.project, { requireContext });
      } catch (error) {
        capabilityFailures.push(error);
      }
    }
    const plan = await services.planProjection(
      {
        host: "claude",
        options: {},
        profileId: input.profileId,
        resolvedContexts: input.resolvedContexts,
        resolvedSkills: input.resolvedSkills,
      },
      () => planClaudeProject(
        input.profileId,
        input.resolvedContexts,
        input.resolvedSkills,
        { materials: services.materials },
      ),
    );
    return { capabilityFailures, diagnostics: [], plan };
  },
} satisfies CompleteHostAdapter;

export async function planClaudeProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  skills: readonly Skill[] = [],
  options: { readonly materials?: AdapterPlanningMaterials } = {},
): Promise<ClaudeProjectPlan> {
  const materials = options.materials ?? DEFAULT_ADAPTER_PLANNING_MATERIALS;
  const skillOutputs = await Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSkillPackageDirectory(
          skill,
          CLAUDE_SKILLS_DISCOVERY_ROOT,
          ["Claude discovers Skill package through native project .claude/skills"],
          CLAUDE_SKILL_PROJECTION,
          materials,
        ),
      ),
  );
  // Omit the unscoped Context rule when the Profile selects no Context Modules.
  // Do not invent an empty Context artifact.
  const outputs: ProposedProjectOutput[] =
    modules.length > 0
      ? [contextRule(profileId, modules, materials), ...skillOutputs]
      : [...skillOutputs];
  return {
    host: "claude",
    hostVersion: skillsRequireDisabledModelInvocation(skills)
      ? CLAUDE_HOST_VERSION_WITH_INVOCATION
      : CLAUDE_HOST_VERSION,
    outputs,
    setupSteps: [],
  };
}
