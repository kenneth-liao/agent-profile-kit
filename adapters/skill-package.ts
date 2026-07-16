import { join, posix } from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";

import type { ModelInvocationPolicy, Skill } from "../schemas/skill.js";
import type {
  ProposedDirectoryFileMember,
  ProposedDirectoryMember,
  ProposedProjectDirectoryOutput,
} from "./project-plan.js";

/** Agent Profile Kit-only Skill sidecars are never projected into Host discovery. */
export const SKILL_PACKAGE_SIDECAR = "agent-profile-kit.yaml";

/** Hosts that receive portable Skill package projection. */
export type SkillPackageHost = "claude" | "codex";

/** Codex Skill metadata path for Host-native invocation policy. */
export const CODEX_SKILL_OPENAI_YAML = "agents/openai.yaml";

/**
 * Semantic requirement attached when a Skill disables implicit model invocation.
 * Selected Hosts must preserve this effect or reject installation.
 * Claude and Codex Capability Contracts for this release both satisfy it.
 */
export const DISABLED_MODEL_INVOCATION_REQUIREMENT =
  "Host prevents implicit model invocation while retaining explicit user invocation";

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

function readAllowImplicitInvocation(
  document: Record<string, unknown>,
  skillId: string,
): boolean | undefined {
  if (!("policy" in document)) return undefined;
  const policy = document.policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error(
      `Skill '${skillId}' ${CODEX_SKILL_OPENAI_YAML} policy must be a YAML mapping`,
    );
  }
  const mapping = policy as Record<string, unknown>;
  if (!("allow_implicit_invocation" in mapping)) return undefined;
  const value = mapping.allow_implicit_invocation;
  if (typeof value !== "boolean") {
    throw new Error(
      `Skill '${skillId}' ${CODEX_SKILL_OPENAI_YAML} policy.allow_implicit_invocation must be a boolean`,
    );
  }
  return value;
}

/**
 * Coalesce or reject Codex-native invocation policy against the trusted Skill policy.
 * Equivalent policies coalesce; conflicting authorities fail before writes.
 */
export function coalesceCodexInvocationPolicy(
  skillId: string,
  modelInvocation: ModelInvocationPolicy,
  existingOpenAiYaml: string | undefined,
): { readonly action: "leave"; readonly bytes?: string } | { readonly action: "write"; readonly bytes: string } {
  let document: Record<string, unknown> = {};
  let existingAllow: boolean | undefined;
  if (existingOpenAiYaml !== undefined) {
    document = requireMapping(
      parseYaml(existingOpenAiYaml, `Skill '${skillId}' ${CODEX_SKILL_OPENAI_YAML}`),
      `Skill '${skillId}' ${CODEX_SKILL_OPENAI_YAML}`,
    );
    existingAllow = readAllowImplicitInvocation(document, skillId);
  }

  if (modelInvocation === "disabled") {
    if (existingAllow === true) {
      throw new Error(
        `Skill '${skillId}' has conflicting model-invocation authorities: canonical policy is disabled but ${CODEX_SKILL_OPENAI_YAML} sets policy.allow_implicit_invocation: true`,
      );
    }
    if (existingAllow === false && existingOpenAiYaml !== undefined) {
      return { action: "leave", bytes: existingOpenAiYaml };
    }
    const policy =
      typeof document.policy === "object" && document.policy !== null && !Array.isArray(document.policy)
        ? { ...(document.policy as Record<string, unknown>) }
        : {};
    policy.allow_implicit_invocation = false;
    document.policy = policy;
    return { action: "write", bytes: `${stringify(document).trimEnd()}\n` };
  }

  // allowed: never introduce a Host restriction; conflict if source already disables implicit invocation
  if (existingAllow === false) {
    throw new Error(
      `Skill '${skillId}' has conflicting model-invocation authorities: canonical policy is allowed but ${CODEX_SKILL_OPENAI_YAML} sets policy.allow_implicit_invocation: false`,
    );
  }
  if (existingOpenAiYaml === undefined) {
    return { action: "leave" };
  }
  return { action: "leave", bytes: existingOpenAiYaml };
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

/**
 * Enumerate portable Skill package members for Host installation.
 * Preserves source file bytes and modes; omits Agent Profile Kit sidecars.
 */
export async function skillPackageMembers(
  skill: Skill,
): Promise<readonly ProposedDirectoryMember[]> {
  const members: ProposedDirectoryMember[] = [];

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : posix.join(prefix, entry.name);
      if (
        relativePath === SKILL_PACKAGE_SIDECAR ||
        relativePath.startsWith(`${SKILL_PACKAGE_SIDECAR}/`)
      ) {
        continue;
      }
      const absolutePath = join(directory, entry.name);
      const mode = (await lstat(absolutePath)).mode & 0o7777;
      if (entry.isDirectory()) {
        members.push({ mode, path: relativePath, type: "directory" });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        members.push({
          // Exact package bytes — keep binary assets lossless through install.
          bytes: await readFile(absolutePath),
          mode,
          path: relativePath,
          type: "file",
        });
        continue;
      }
      throw new Error(
        `Skill '${skill.id}' contains unsupported entry '${relativePath}'; only regular files and directories are installable`,
      );
    }
  }

  try {
    await visit(skill.path, "");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`Skill '${skill.id}' package path is missing: ${skill.path}`);
    }
    throw error;
  }
  return members.sort((left, right) => left.path.localeCompare(right.path));
}

function projectMembersForHost(
  skill: Skill,
  host: SkillPackageHost,
  members: readonly ProposedDirectoryMember[],
): readonly ProposedDirectoryMember[] {
  if (host === "claude") {
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

  // codex: preserve SKILL.md; project agents/openai.yaml for invocation policy
  const existingOpenAi = members.find(
    (member): member is ProposedDirectoryFileMember =>
      member.type === "file" && member.path === CODEX_SKILL_OPENAI_YAML,
  );
  const decision = coalesceCodexInvocationPolicy(
    skill.id,
    skill.modelInvocation,
    existingOpenAi === undefined ? undefined : memberBytesAsString(existingOpenAi.bytes),
  );

  if (decision.action === "leave") {
    return members;
  }

  // write: replace or insert openai.yaml; ensure agents/ directory member exists
  const withoutOpenAi = members.filter((member) => member.path !== CODEX_SKILL_OPENAI_YAML);
  const hasAgentsDir = withoutOpenAi.some(
    (member) => member.type === "directory" && member.path === "agents",
  );
  const next: ProposedDirectoryMember[] = [...withoutOpenAi];
  if (!hasAgentsDir) {
    next.push({ mode: 0o755, path: "agents", type: "directory" });
  }
  next.push({
    bytes: decision.bytes,
    mode: existingOpenAi?.mode ?? 0o644,
    path: CODEX_SKILL_OPENAI_YAML,
    type: "file",
  });
  return next.sort((left, right) => left.path.localeCompare(right.path));
}

function skillRequirements(
  skill: Skill,
  host: SkillPackageHost,
  base: readonly string[],
): readonly string[] {
  const requirements = [...base];
  if (skill.modelInvocation === "disabled") {
    requirements.push(DISABLED_MODEL_INVOCATION_REQUIREMENT);
    if (host === "claude") {
      requirements.push("Claude disable-model-invocation frontmatter enforces disabled model invocation");
    } else {
      requirements.push(
        "Codex agents/openai.yaml policy.allow_implicit_invocation enforces disabled model invocation",
      );
    }
  }
  return requirements;
}

/** Plan one complete owned Skill package directory under a Host discovery root. */
export async function planSkillPackageDirectory(
  skill: Skill,
  discoveryRoot: string,
  requirements: readonly string[],
  host: SkillPackageHost,
): Promise<ProposedProjectDirectoryOutput> {
  const sourceMembers = await skillPackageMembers(skill);
  return {
    members: projectMembersForHost(skill, host, sourceMembers),
    mode: 0o755,
    path: posix.join(discoveryRoot, skill.id),
    requirements: skillRequirements(skill, host, requirements),
    type: "directory",
  };
}
