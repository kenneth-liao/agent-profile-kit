import { mkdir, open, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileHandle } from "node:fs/promises";

import { parseSkill } from "../schemas/skill.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import { newSkillScaffold } from "./authoring-examples.js";
import { ingestSelectedWorkspace } from "./local-configuration.js";
import { lstatEntry, requireRealCategory } from "./workspace.js";
import { InstallerToolError } from "./tool-errors.js";

const SKILL_FILE_NAME = "SKILL.md";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export interface CreateSkillOptions {
  readonly home: string;
  /** Authored Skill name; becomes the Skill's Artifact ID and directory name. */
  readonly name: string;
  /**
   * Test-only ownership-transition seam: the exclusive open of the leaf file.
   * The default is `open(path, "wx")`; only its success proves the file was
   * created by this invocation.
   */
  readonly openSkillFile?: (path: string) => Promise<FileHandle>;
  /** Test-only handle-write override for injected failure proofs. */
  readonly writeSkillFile?: (handle: FileHandle, contents: string) => Promise<void>;
}

export interface CreateSkillResult {
  readonly id: string;
  /** Absolute path of the SKILL.md file actually created. */
  readonly path: string;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Close during error recovery is secondary; the original error is
    // preserved and reported instead.
  }
}

/**
 * Classify and report what survives a failed creation attempt. Only a file
 * proven created by a successful exclusive open is ever removed; the
 * invocation-created directory is removed only while empty, so preserved
 * foreign material is never deleted. Returns the typed residue fact when
 * anything survives, else undefined. The residue path is always the skill
 * directory — the retry blocker — and `contents` distinguishes surviving
 * material that is entirely Agent Profile Kit-created from material that
 * includes entries Agent Profile Kit did not create.
 */
async function reportInvocationResidue(
  skillDirectory: string,
  provenCreatedFile: string | null,
  id: string,
): Promise<InstallerToolError | undefined> {
  if (provenCreatedFile !== null) {
    try {
      await rm(provenCreatedFile);
    } catch {
      // Kept; the classification below reports exactly what survives.
    }
  }
  try {
    await rmdir(skillDirectory); // refuses non-empty: foreign content preserved
    return undefined;
  } catch {
    // Fall through to classification of what survives.
  }
  let inspection: "own" | "foreign";
  try {
    const entries = await readdir(skillDirectory);
    // With a proven-created file, a surviving SKILL.md may be our own partial
    // write; without one, every entry — a surviving SKILL.md included — is
    // material this invocation never created.
    inspection = provenCreatedFile !== null
      ? (entries.some((entry) => entry !== SKILL_FILE_NAME) ? "foreign" : "own")
      : (entries.length > 0 ? "foreign" : "own");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      // Confirmed absence is the only proof that nothing survived.
      return undefined;
    }
    // EACCES, EIO, EMFILE, and any other inspection failure do not prove
    // absence or foreign content: the directory stays reported residue with
    // conservative uninspectable guidance.
    return new InstallerToolError({
      kind: "artifact-creation-residue",
      artifactType: "Skill",
      id,
      path: skillDirectory,
      contents: "uninspectable",
    });
  }
  return new InstallerToolError({
    kind: "artifact-creation-residue",
    artifactType: "Skill",
    id,
    path: skillDirectory,
    contents: inspection,
  });
}

/**
 * Create one valid Skill scaffold in the configured Workspace (DEC-026).
 * The name must satisfy the Artifact ID schema, which also pins the
 * destination to one direct child directory of the Workspace's validated
 * `skills` category — no authored spelling can escape it. Ingestion is the
 * single duplicate-Artifact-ID authority. The scaffold is serialized as a
 * YAML string and preflighted through the canonical Skill schema before any
 * write. The exclusive open is the sole creation-evidence boundary: only a
 * successful `wx` open authorizes removing the leaf file on later failure,
 * and open failure never deletes a file. Occupied destinations, including
 * symlinks, are never written through.
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

  await requireRealCategory(workspace.path, "skills");

  const skillDirectory = join(workspace.path, "skills", id);
  // Occupancy check before creation: any existing entry — file, directory, or
  // symlink — refuses creation, so a symlink is never written through.
  const occupied = (await lstatEntry(skillDirectory)) !== undefined;
  if (occupied) {
    throw new InstallerToolError({
      kind: "artifact-path-occupied",
      artifactType: "Skill",
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
        kind: "artifact-path-occupied",
        artifactType: "Skill",
        id,
        path: skillDirectory,
      });
    }
    throw error;
  }

  const skillFile = join(skillDirectory, SKILL_FILE_NAME);
  const openSkillFile = options.openSkillFile ?? ((path: string) => open(path, "wx"));
  const writeSkillFile =
    options.writeSkillFile ?? ((handle: FileHandle, contents: string) => handle.writeFile(contents));

  // Ownership transition: only a successful exclusive open proves the leaf
  // file was created by this invocation. Until it succeeds, no file is
  // removed — a pre-open rejection says nothing about what exists at the path.
  let handle: FileHandle;
  try {
    handle = await openSkillFile(skillFile);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      // A foreign file occupies the destination; it is not ours and is kept.
      throw new InstallerToolError({
        kind: "artifact-path-occupied",
        artifactType: "Skill",
        id,
        path: skillDirectory,
      });
    }
    const residual = await reportInvocationResidue(skillDirectory, null, id);
    if (residual !== undefined) throw residual;
    throw error;
  }

  let writeError: unknown;
  try {
    await writeSkillFile(handle, scaffold);
  } catch (error) {
    writeError = error;
  }
  if (writeError !== undefined) {
    // Close is secondary during error recovery; it must never mask the
    // original write error.
    await closeQuietly(handle);
    const residual = await reportInvocationResidue(skillDirectory, skillFile, id);
    if (residual !== undefined) throw residual;
    throw writeError;
  }
  // Success path: an awaited close failure is a failed creation, never a
  // success receipt; route it through the same creation recovery.
  try {
    await handle.close();
  } catch (error) {
    const residual = await reportInvocationResidue(skillDirectory, skillFile, id);
    if (residual !== undefined) throw residual;
    throw error;
  }
  return { id, path: skillFile };
}