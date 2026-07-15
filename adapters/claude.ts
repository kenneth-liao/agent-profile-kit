import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";

import type { Skill } from "../schemas/skill.js";
import { composeContextEnvelope, type ContextModuleSource } from "./context-envelope.js";
import type {
  AdapterProjectPlan,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";
import { planSkillPackageDirectory } from "./skill-package.js";

const execFileAsync = promisify(execFile);

export const CLAUDE_ADAPTER_VERSION = "claude-project-v1";

/**
 * Capability-contract token recorded in Installation Manifest host_versions after
 * the installed Claude CLI is proven to support unscoped project rules and native
 * project Skill discovery under `.claude/skills/`.
 *
 * Evidence: Claude Code 2.0.64+ loads recursive `.claude/rules/`; project Skills
 * under `.claude/skills/` are available on that same floor and earlier. Preflight
 * therefore records one contract for both Claude project outputs.
 */
export const CLAUDE_HOST_VERSION = "native-project-unscoped-rules-skills-v1";

/**
 * Minimum Claude Code CLI version that preserves the Claude project Capability Contract.
 * Evidence: Anthropic Claude Code changelog — `.claude/rules/` added in 2.0.64;
 * that floor already includes native project Skill package discovery.
 */
export const CLAUDE_MINIMUM_CLI_VERSION = "2.0.64";

/** Owned unscoped Claude project rule path (no paths frontmatter). */
export const CLAUDE_CONTEXT_RULE_PATH = posix.join(
  ".claude",
  "rules",
  "agent-profile-kit.md",
);

/** Claude native project Skill discovery root. */
export const CLAUDE_SKILLS_DISCOVERY_ROOT = posix.join(".claude", "skills");

export type ClaudeProjectPlan = AdapterProjectPlan;

export interface ClaudeCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable version probe for tests; defaults to `claude --version`. */
  readonly resolveVersion?: () => Promise<string>;
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
 * Reject Claude Code CLI releases that cannot preserve unscoped project-rule Context.
 */
export function assertClaudeCliVersionSupported(version: string): void {
  if (compareSemver(version, CLAUDE_MINIMUM_CLI_VERSION) < 0) {
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
 * Reject project surfaces or Host installs that cannot host an unscoped `.claude/rules` rule.
 * Authentication, trust, approvals, plugins, and sessions are never inspected or written.
 */
export async function assertClaudeProjectCapability(
  project: string,
  options: ClaudeCapabilityOptions = {},
): Promise<void> {
  const version = await resolveClaudeCliVersion(options);
  assertClaudeCliVersionSupported(version);

  const claudePath = join(project, ".claude");
  const rulesPath = join(project, ".claude", "rules");
  const claudeKind = await pathKind(claudePath);
  if (claudeKind !== "missing" && claudeKind !== "directory") {
    throw new Error(
      `Claude project surface cannot host unscoped rules: ${claudePath} is a ${claudeKind}, not a directory`,
    );
  }
  const rulesKind = await pathKind(rulesPath);
  if (rulesKind !== "missing" && rulesKind !== "directory") {
    throw new Error(
      `Claude project surface cannot host unscoped rules: ${rulesPath} is a ${rulesKind}, not a directory`,
    );
  }
}

function contextRule(
  profileId: string,
  modules: readonly ContextModuleSource[],
): ProposedProjectFileOutput {
  return {
    // Unscoped rule: no YAML paths frontmatter, so Claude re-injects after compaction.
    bytes: composeContextEnvelope(profileId, modules),
    mode: 0o644,
    path: CLAUDE_CONTEXT_RULE_PATH,
    requirements: [
      "Claude loads unscoped project rule as additive Profile Context",
      "Claude re-injects unscoped rules after compaction",
    ],
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
        planSkillPackageDirectory(skill, CLAUDE_SKILLS_DISCOVERY_ROOT, [
          "Claude discovers Skill package through native project .claude/skills",
        ]),
      ),
  );
  const outputs: ProposedProjectOutput[] = [
    contextRule(profileId, modules),
    ...skillOutputs,
  ];
  return {
    host: "claude",
    hostVersion: CLAUDE_HOST_VERSION,
    outputs,
  };
}
