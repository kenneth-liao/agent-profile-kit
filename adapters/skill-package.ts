import { join, posix } from "node:path";
import { lstat, readdir, readFile } from "node:fs/promises";

import type { Skill } from "../schemas/skill.js";
import type {
  ProposedDirectoryMember,
  ProposedProjectDirectoryOutput,
} from "./project-plan.js";

/** Agent Profile Kit-only Skill sidecars are never projected into Host discovery. */
export const SKILL_PACKAGE_SIDECAR = "agent-profile-kit.yaml";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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

/** Plan one complete owned Skill package directory under a Host discovery root. */
export async function planSkillPackageDirectory(
  skill: Skill,
  discoveryRoot: string,
  requirements: readonly string[],
): Promise<ProposedProjectDirectoryOutput> {
  return {
    members: await skillPackageMembers(skill),
    mode: 0o755,
    path: posix.join(discoveryRoot, skill.id),
    requirements,
    type: "directory",
  };
}
