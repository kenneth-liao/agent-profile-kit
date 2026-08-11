import { join, posix } from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";

import type { Skill } from "../schemas/skill.js";
import type { ContextModuleSource } from "./context-envelope.js";
import { composeContextEnvelope } from "./context-envelope.js";
import type {
  ProposedDirectoryMember,
  ProposedProjectDirectoryOutput,
} from "./project-plan.js";

/** Agent Profile Kit-only Skill sidecars are never projected into Host discovery. */
export const SKILL_PACKAGE_SIDECAR = "agent-profile-kit.yaml";

/**
 * Semantic requirement attached when a Skill disables implicit model invocation.
 * Selected Hosts must preserve this effect via Adapter capability preflight or reject.
 */
export const DISABLED_MODEL_INVOCATION_REQUIREMENT =
  "Host prevents implicit model invocation while retaining explicit user invocation";

/** Adapter-owned projection of one portable Skill package into Host-native members and requirements. */
export interface SkillPackageProjection {
  readonly projectMembers: (
    skill: Skill,
    members: readonly ProposedDirectoryMember[],
  ) => readonly ProposedDirectoryMember[];
  readonly requirements: (
    skill: Skill,
    base: readonly string[],
  ) => readonly string[];
}

/**
 * Trusted planning materials shared with Adapters for one lifecycle invocation.
 * Defaults read the filesystem and compose Context directly; an Installer context
 * may supply invocation-scoped reuse without changing Adapter semantics.
 */
export interface AdapterPlanningMaterials {
  readonly composeContext: (
    profileId: string,
    modules: readonly ContextModuleSource[],
  ) => string;
  readonly readSkillPackage: (
    skill: Skill,
  ) => Promise<readonly ProposedDirectoryMember[]>;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Enumerate portable Skill package members for Host installation.
 * Preserves source file bytes and modes; omits Agent Profile Kit sidecars.
 * Host-native translation of model-invocation policy is Adapter-owned.
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

export const DEFAULT_ADAPTER_PLANNING_MATERIALS: AdapterPlanningMaterials = {
  composeContext: composeContextEnvelope,
  readSkillPackage: skillPackageMembers,
};

/** True when any resolved Skill requires disabled implicit model invocation. */
export function skillsRequireDisabledModelInvocation(
  skills: readonly Skill[],
): boolean {
  return skills.some((skill) => skill.modelInvocation === "disabled");
}

/** Plan one complete owned Skill package directory under a Host discovery root. */
export async function planSkillPackageDirectory(
  skill: Skill,
  discoveryRoot: string,
  baseRequirements: readonly string[],
  projection: SkillPackageProjection,
  materials: AdapterPlanningMaterials = DEFAULT_ADAPTER_PLANNING_MATERIALS,
): Promise<ProposedProjectDirectoryOutput> {
  const sourceMembers = await materials.readSkillPackage(skill);
  return {
    members: projection.projectMembers(skill, sourceMembers),
    mode: 0o755,
    origins: [{ id: skill.id, type: "skill" }],
    path: posix.join(discoveryRoot, skill.id),
    requirements: projection.requirements(skill, baseRequirements),
    type: "directory",
  };
}
