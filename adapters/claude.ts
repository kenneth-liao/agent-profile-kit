import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

import type { ModelInvocationPolicy, Skill } from "../schemas/skill.js";
import { composeContextEnvelope, type ContextModuleSource } from "./context-envelope.js";
import type {
  AdapterProjectPlan,
  ProposedDirectoryFileMember,
  ProposedDirectoryMember,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";
import {
  DISABLED_MODEL_INVOCATION_REQUIREMENT,
  planSkillPackageDirectory,
  skillsRequireDisabledModelInvocation,
  type SkillPackageProjection,
} from "./skill-package.js";

const execFileAsync = promisify(execFile);

export const CLAUDE_ADAPTER_VERSION = "claude-project-v1";

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

function parseYaml(source: string, description: string): unknown {
  try {
    return parse(source);
  } catch {
    throw new Error(`${description} is invalid YAML`);
  }
}

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function memberBytesAsString(bytes: string | Uint8Array): string {
  return typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
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

/** Parse the leading semver from `claude --version` output. */
export function parseClaudeCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(
      `Claude CLI version is unreadable from '${source.trim()}'; install a supported Claude Code release`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
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
  if (compareSemver(version, CLAUDE_MINIMUM_CLI_VERSION) < 0) {
    if (options.requireDisabledModelInvocation) {
      throw new Error(
        `Claude CLI ${version} cannot enforce disabled model invocation via disable-model-invocation (requires ${CLAUDE_MINIMUM_CLI_VERSION}+); upgrade Claude Code before previewing or applying the Profile`,
      );
    }
    if (options.requireContext === false) {
      throw new Error(
        `Claude CLI ${version} does not support native project Skills (requires ${CLAUDE_MINIMUM_CLI_VERSION}+); upgrade Claude Code before previewing or applying the Profile`,
      );
    }
    throw new Error(
      `Claude CLI ${version} does not support unscoped project rules (requires ${CLAUDE_MINIMUM_CLI_VERSION}+); upgrade Claude Code before previewing or applying the Profile`,
    );
  }
}

async function resolveClaudeCliVersion(
  options: ClaudeCapabilityOptions,
): Promise<string> {
  if (options.resolveVersion) return options.resolveVersion();
  try {
    const { stdout, stderr } = await execFileAsync("claude", ["--version"], {
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    return parseClaudeCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        "Claude Code CLI was not found on PATH; install Claude Code and ensure `claude --version` works before previewing or applying the Profile",
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
    throw new Error(
      `Claude Code CLI version could not be detected (${error instanceof Error ? error.message : String(error)}); install a supported Claude Code release before previewing or applying the Profile`,
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
  const requireContext = options.requireContext !== false;
  const version = await resolveClaudeCliVersion(options);
  assertClaudeCliVersionSupported(version, {
    requireContext,
    ...(options.requireDisabledModelInvocation
      ? { requireDisabledModelInvocation: true }
      : {}),
  });

  // Skills-only and Context-bearing plans both write under `.claude/`.
  const claudePath = join(project, ".claude");
  const claudeKind = await pathKind(claudePath);
  if (claudeKind !== "missing" && claudeKind !== "directory") {
    throw new Error(
      `Claude project surface cannot host outputs: ${claudePath} is a ${claudeKind}, not a directory`,
    );
  }

  // Skills-only Profiles do not write unscoped rules; skip the rules surface then.
  if (!requireContext) {
    return;
  }

  const rulesPath = join(project, ".claude", "rules");
  const rulesKind = await pathKind(rulesPath);
  if (rulesKind !== "missing" && rulesKind !== "directory") {
    throw new Error(
      `Claude project surface cannot host unscoped rules: ${rulesPath} is a ${rulesKind}, not a directory`,
    );
  }
}

/** Emit Claude Host SKILL.md with disable-model-invocation when policy is disabled. */
export function emitClaudeSkillMarkdown(
  skillId: string,
  source: string,
  modelInvocation: ModelInvocationPolicy,
): string {
  if (modelInvocation === "allowed") return source;

  const delimiter = "---\n";
  if (!source.startsWith(delimiter)) {
    throw new Error(`Skill '${skillId}' SKILL.md must start with YAML frontmatter`);
  }
  const closing = source.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw new Error(`Skill '${skillId}' SKILL.md must close its YAML frontmatter`);
  }
  const header = requireMapping(
    parseYaml(
      source.slice(delimiter.length, closing),
      `Skill '${skillId}' SKILL.md frontmatter`,
    ),
    `Skill '${skillId}' SKILL.md frontmatter`,
  );
  header["disable-model-invocation"] = true;
  const body = source.slice(closing + delimiter.length);
  return `${delimiter}${stringify(header).trimEnd()}\n---\n${body}`;
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
      bytes: emitClaudeSkillMarkdown(
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
): ProposedProjectFileOutput {
  return {
    // Unscoped rule: no YAML paths frontmatter, so Claude re-injects after compaction.
    bytes: composeContextEnvelope(profileId, modules),
    mode: 0o644,
    path: CLAUDE_CONTEXT_RULE_PATH,
    requirements: [...CLAUDE_CONTEXT_REQUIREMENTS],
    type: "file",
  };
}

/**
 * Pure Claude Adapter planner for Profile Context and portable Skills.
 * Does not write filesystem state or coordinate with other Adapters.
 */
export async function planClaudeProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  skills: readonly Skill[] = [],
): Promise<ClaudeProjectPlan> {
  const skillOutputs = await Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSkillPackageDirectory(
          skill,
          CLAUDE_SKILLS_DISCOVERY_ROOT,
          ["Claude discovers Skill package through native project .claude/skills"],
          CLAUDE_SKILL_PROJECTION,
        ),
      ),
  );
  // Omit the unscoped Context rule when the Profile selects no Context Modules.
  // Do not invent an empty Context artifact.
  const outputs: ProposedProjectOutput[] =
    modules.length > 0
      ? [contextRule(profileId, modules), ...skillOutputs]
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
