import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";

import { composeContextEnvelope, type ContextModuleSource } from "./context-envelope.js";
import type { AdapterProjectPlan, ProposedProjectFileOutput } from "./project-plan.js";

export const CLAUDE_ADAPTER_VERSION = "claude-project-v1";
export const CLAUDE_HOST_VERSION = "native-project-unscoped-rules-v1";

/** Owned unscoped Claude project rule path (no paths frontmatter). */
export const CLAUDE_CONTEXT_RULE_PATH = posix.join(
  ".claude",
  "rules",
  "agent-profile-kit.md",
);

export type ClaudeProjectPlan = AdapterProjectPlan;

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

/**
 * Reject project surfaces that cannot host an unscoped `.claude/rules` rule.
 * Authentication, trust, approvals, plugins, and sessions are never inspected or written.
 */
export async function assertClaudeProjectCapability(project: string): Promise<void> {
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
 * Pure Claude Adapter planner for Profile Context.
 * Does not write filesystem state or coordinate with other Adapters.
 */
export async function planClaudeProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  options: { readonly skillCount?: number } = {},
): Promise<ClaudeProjectPlan> {
  if ((options.skillCount ?? 0) > 0) {
    throw new Error(
      "Claude Skill delivery is not supported yet; remove Skills from the Profile or omit the claude Host until Skill installation is available",
    );
  }
  return {
    host: "claude",
    hostVersion: CLAUDE_HOST_VERSION,
    outputs: [contextRule(profileId, modules)],
  };
}
