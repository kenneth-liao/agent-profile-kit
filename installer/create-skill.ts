import { lstat, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Stats } from "node:fs";

import { parseSkill } from "../schemas/skill.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import { newSkillScaffold } from "./authoring-examples.js";
import { ingestSelectedWorkspace } from "./local-configuration.js";
import { InstallerToolError } from "./tool-errors.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export interface CreateSkillOptions {
  readonly home: string;
  /** Authored Skill name; becomes the Skill's Artifact ID and directory name. */
  readonly name: string;
  /** Test-only exclusive leaf-write override for injected failure proofs. */
  readonly writeSkillFile?: (path: string, contents: string) => Promise<void>;
}

export interface CreateSkillResult {
  readonly id: string;
  /** Absolute path of the SKILL.md file actually created. */
  readonly path: string;
}

async function lstatEntry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Remove only material proven created by this invocation: the exclusive `wx`
 * open guarantees that after any non-EEXIST write failure, a SKILL.md at this
 * path was created by this invocation. Refuses the directory when it is no
 * longer empty (foreign material) and reports the deepest surviving residue.
 */
async function removeInvocationResidue(
  skillDirectory: string,
  skillFile: string,
): Promise<string | undefined> {
  try {
    await rm(skillFile, { force: true });
    await rmdir(skillDirectory);
    return undefined;
  } catch {
    if ((await lstatEntry(skillFile)) !== undefined) return skillFile;
    if ((await lstatEntry(skillDirectory)) !== undefined) return skillDirectory;
    return undefined;
  }
}

/**
 * Require the Workspace's `skills` category to be a real directory before any
 * creation write (CRAFT-1): a symlinked category — even one resolving to a
 * directory inside or outside the Workspace — must never receive writes, so
 * identity is checked with lstat, never through the link. A missing category
 * is a valid empty Workspace and is created exclusively.
 */
async function requireRealSkillsCategory(workspacePath: string): Promise<void> {
  const skillsDirectory = join(workspacePath, "skills");
  let entry = await lstatEntry(skillsDirectory);
  if (entry === undefined) {
    try {
      await mkdir(skillsDirectory);
      return;
    } catch (error) {
      // Lost a creation race; re-validate whatever now occupies the category.
      if (!hasErrorCode(error, "EEXIST")) throw error;
      entry = await lstat(skillsDirectory);
    }
  }
  if (entry!.isSymbolicLink() || !entry!.isDirectory()) {
    throw new InstallerToolError({
      kind: "workspace-category-not-directory",
      workspace: workspacePath,
      name: "skills",
    });
  }
}

/**
 * Create one valid Skill scaffold in the configured Workspace (DEC-026).
 * The name must satisfy the Artifact ID schema, which also pins the
 * destination to one direct child directory of the Workspace's validated
 * `skills` category — no authored spelling can escape it. Ingestion is the
 * single duplicate-Artifact-ID authority. The scaffold is serialized as a
 * YAML string and preflighted through the canonical Skill schema before any
 * write; creation is exclusive so an occupied destination, including a
 * symlink, is never written through.
 */
export async function createSkill(options: CreateSkillOptions): Promise<CreateSkillResult> {
  const id = requireArtifactId(options.name, "new skill name");
  const workspace = await ingestSelectedWorkspace(options.home);
  if (workspace.skills.has(id)) {
    throw new InstallerToolError({
      kind: "duplicate-artifact-name",
      artifactType: "Skill",
      id,
    });
  }

  // Preflight the exact bytes through the canonical Skill schema before any
  // filesystem mutation, so overlength or otherwise schema-invalid material
  // can never be reported as success (CRAFT-2).
  const relativePath = `skills/${id}/SKILL.md`;
  const sourcePath = join(workspace.path, "skills", id);
  const scaffold = newSkillScaffold(id);
  parseSkill(scaffold, relativePath, sourcePath);

  await requireRealSkillsCategory(workspace.path);

  const skillDirectory = join(workspace.path, "skills", id);
  // Occupancy check before creation: any existing entry — file, directory, or
  // symlink — refuses creation, so a symlink is never written through.
  const occupied = (await lstatEntry(skillDirectory)) !== undefined;
  if (occupied) {
    throw new InstallerToolError({
      kind: "skill-path-occupied",
      id,
      path: skillDirectory,
    });
  }

  // Exclusive leaf creation: fails when the entry appears between the
  // occupancy check and creation; the parent was validated as a directory.
  try {
    await mkdir(skillDirectory);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      throw new InstallerToolError({
        kind: "skill-path-occupied",
        id,
        path: skillDirectory,
      });
    }
    throw error;
  }

  const skillFile = join(skillDirectory, "SKILL.md");
  const writeSkillFile = options.writeSkillFile ??
    ((path: string, contents: string) => writeFile(path, contents, { flag: "wx" }));
  try {
    await writeSkillFile(skillFile, scaffold);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      // A concurrent writer created the file; it is not proven ours, so it is
      // kept and the destination is reported as occupied.
      throw new InstallerToolError({
        kind: "skill-path-occupied",
        id,
        path: skillDirectory,
      });
    }
    // Partial or failed write: clean up what this invocation created so a
    // later ingestion or retry is never blocked by incomplete material.
    const residual = await removeInvocationResidue(skillDirectory, skillFile);
    if (residual !== undefined) {
      throw new InstallerToolError({
        kind: "skill-creation-residue",
        id,
        path: residual,
      });
    }
    throw error;
  }
  return { id, path: skillFile };
}