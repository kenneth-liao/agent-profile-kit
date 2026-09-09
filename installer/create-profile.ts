import { open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { parseProfile } from "../schemas/context-profile.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import { newProfileScaffold } from "./authoring-examples.js";
import { ingestSelectedWorkspace } from "./local-configuration.js";
import { lstatEntry, requireRealCategory } from "./workspace.js";
import { InstallerToolError } from "./tool-errors.js";

const PROFILE_EXTENSION = ".yaml";

export interface CreateProfileOptions {
  readonly home: string;
  /** Authored Profile name; becomes the Profile's Artifact ID and file name. */
  readonly name: string;
  /** Explicitly selected existing Context Module Artifact IDs. */
  readonly contexts: readonly string[];
  /** Explicitly selected existing Skill Artifact IDs. */
  readonly skills: readonly string[];
  /**
   * Test-only ownership-transition seam: the exclusive open of the leaf file.
   * The default is `open(path, "wx")`; only its success proves the file was
   * created by this invocation.
   */
  readonly openProfileFile?: (path: string) => Promise<FileHandle>;
  /** Test-only handle-write override for injected failure proofs. */
  readonly writeProfileFile?: (handle: FileHandle, contents: string) => Promise<void>;
}

export interface CreateProfileResult {
  readonly id: string;
  /** Absolute path of the Profile file actually created. */
  readonly path: string;
  /** Sorted available Context Module names, as receipt guidance. */
  readonly availableContexts: readonly string[];
  /** Sorted available Skill names, as receipt guidance. */
  readonly availableSkills: readonly string[];
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Classify what survives a failed creation attempt. Only a file proven
 * created by a successful exclusive open is ever removed; a Profile is one
 * file inside the shared `profiles` category, so the category itself is never
 * removed — valid Workspace material may already live beside it. Returns the
 * typed residue fact when the proven-created file could not be removed, else
 * undefined. The residue path is always the profile file — the retry blocker.
 */
async function reportInvocationResidue(
  profileFile: string,
  id: string,
): Promise<InstallerToolError | undefined> {
  try {
    await rm(profileFile);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      // What survives at the path is entirely Agent Profile Kit-created:
      // only the proven-created file can occupy it.
      return new InstallerToolError({
        kind: "artifact-creation-residue",
        artifactType: "Profile",
        id,
        path: profileFile,
        contents: "own",
      });
    }
  }
  return undefined;
}

/**
 * Create one valid bindable Profile scaffold in the configured Workspace
 * (DEC-026). The name must satisfy the Artifact ID schema, which pins the
 * destination to one `<name>.yaml` file inside the Workspace's validated
 * `profiles` category — no authored spelling can escape it. Explicit
 * selections resolve against the ingested Workspace boundary: a selected name
 * that does not exist is a typed missing-reference fact carrying the sorted
 * available names, so creation can never emit a Profile that fails ingestion
 * (US-044, US-045). A Profile must select at least one supported artifact;
 * an empty selection is refused with the same typed fact ingestion uses.
 * Ingestion is the single duplicate-Artifact-ID authority. The scaffold is
 * preflighted through the canonical Profile schema before any write. The
 * exclusive open is the sole creation-evidence boundary: only a successful
 * `wx` open authorizes removing the file on later failure, and open failure
 * never deletes a file. Occupied destinations, including symlinks, are never
 * written through.
 */
export async function createProfile(options: CreateProfileOptions): Promise<CreateProfileResult> {
  const id = requireArtifactId(options.name, "new profile name");
  const workspace = await ingestSelectedWorkspace(options.home);

  const availableContexts = [...workspace.contexts.keys()].sort();
  const availableSkills = [...workspace.skills.keys()].sort();

  if (options.contexts.length === 0 && options.skills.length === 0) {
    throw new InstallerToolError({
      kind: "profile-without-artifacts",
      profile: id,
      availableContexts,
      availableSkills,
    });
  }
  for (const contextId of options.contexts) {
    if (!workspace.contexts.has(contextId)) {
      throw new InstallerToolError({
        kind: "missing-context-reference",
        profile: id,
        contextId,
        file: `profiles/${id}${PROFILE_EXTENSION}`,
        available: availableContexts,
      });
    }
  }
  for (const skillId of options.skills) {
    if (!workspace.skills.has(skillId)) {
      throw new InstallerToolError({
        kind: "missing-skill-reference",
        profile: id,
        skillId,
        file: `profiles/${id}${PROFILE_EXTENSION}`,
        available: availableSkills,
      });
    }
  }

  if (workspace.profiles.has(id)) {
    throw new InstallerToolError({
      kind: "duplicate-artifact-name",
      artifactType: "Profile",
      id,
    });
  }

  // Preflight the exact bytes through the canonical Profile schema before any
  // filesystem mutation, so schema-invalid material (duplicated selections
  // included) can never be reported as success (CRAFT-2).
  const fileName = `${id}${PROFILE_EXTENSION}`;
  const relativePath = `profiles/${fileName}`;
  const profileFile = join(workspace.path, "profiles", fileName);
  const scaffold = newProfileScaffold(id, options.contexts, options.skills);
  parseProfile(scaffold, relativePath);

  await requireRealCategory(workspace.path, "profiles");

  // Occupancy check before creation: any existing entry — file, directory, or
  // symlink — refuses creation, so a symlink is never written through.
  if ((await lstatEntry(profileFile)) !== undefined) {
    throw new InstallerToolError({
      kind: "artifact-path-occupied",
      artifactType: "Profile",
      id,
      path: profileFile,
    });
  }

  // Exclusive leaf creation: fails when the entry appears between the
  // occupancy check and creation; the category was validated as a directory.
  const openProfileFile = options.openProfileFile ?? ((path: string) => open(path, "wx"));
  const writeProfileFile =
    options.writeProfileFile ?? ((handle: FileHandle, contents: string) => handle.writeFile(contents));

  // Ownership transition: only a successful exclusive open proves the file
  // was created by this invocation. Until it succeeds, no file is removed —
  // a pre-open rejection says nothing about what exists at the path.
  let handle: FileHandle;
  try {
    handle = await openProfileFile(profileFile);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      // A foreign file occupies the destination; it is not ours and is kept.
      throw new InstallerToolError({
        kind: "artifact-path-occupied",
        artifactType: "Profile",
        id,
        path: profileFile,
      });
    }
    // Nothing was proven created; the category — if this invocation created
    // it — is a valid Workspace category either way. The original error is
    // reported; a surviving foreign file is refused as occupied on retry.
    throw error;
  }

  let writeError: unknown;
  try {
    await writeProfileFile(handle, scaffold);
  } catch (error) {
    writeError = error;
  }
  if (writeError !== undefined) {
    // Close is secondary during error recovery; it must never mask the
    // original write error.
    await closeQuietly(handle);
    await throwWithResidue(profileFile, id, writeError);
  }
  // Success path: an awaited close failure is a failed creation, never a
  // success receipt; route it through the same creation recovery.
  try {
    await handle.close();
  } catch (error) {
    await throwWithResidue(profileFile, id, error);
  }
  return { id, path: profileFile, availableContexts, availableSkills };
}

/** Remove the proven-created file, then rethrow the original failure — or the typed residue when removal could not confirm absence. */
async function throwWithResidue(profileFile: string, id: string, original: unknown): Promise<never> {
  const residue = await reportInvocationResidue(profileFile, id);
  if (residue !== undefined) throw residue;
  throw original;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // Close during error recovery is secondary; the original error is
    // preserved and reported instead.
  }
}
