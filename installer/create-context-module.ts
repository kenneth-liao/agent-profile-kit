import { open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { parseContextModule } from "../schemas/context-profile.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import { newContextModuleScaffold } from "./authoring-examples.js";
import { ingestSelectedWorkspace } from "./local-configuration.js";
import { lstatEntry, requireRealCategory } from "./workspace.js";
import { InstallerToolError } from "./tool-errors.js";

const CONTEXT_MODULE_EXTENSION = ".md";

export interface CreateContextModuleOptions {
  readonly home: string;
  /** Authored Context Module name; becomes the module's Artifact ID. */
  readonly name: string;
  /**
   * Test-only ownership-transition seam: the exclusive open of the leaf file.
   * The default is `open(path, "wx")`; only its success proves the file was
   * created by this invocation.
   */
  readonly openModuleFile?: (path: string) => Promise<FileHandle>;
  /** Test-only handle-write override for injected failure proofs. */
  readonly writeModuleFile?: (handle: FileHandle, contents: string) => Promise<void>;
}

export interface CreateContextModuleResult {
  readonly id: string;
  /** Absolute path of the Context Module file actually created. */
  readonly path: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Classify what survives a failed creation attempt. Only a file proven
 * created by a successful exclusive open is ever removed; a Context Module
 * is one file inside the shared `context` category, so the category itself
 * is never removed — valid Workspace material may already live beside it.
 * Returns the typed residue fact when the proven-created file could not be
 * removed, else undefined. The residue path is always the module file — the
 * retry blocker.
 */
async function reportInvocationResidue(
  moduleFile: string,
  id: string,
): Promise<InstallerToolError | undefined> {
  try {
    await rm(moduleFile);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      // What survives at the path is entirely Agent Profile Kit-created:
      // only the proven-created file can occupy it.
      return new InstallerToolError({
        kind: "artifact-creation-residue",
        artifactType: "Context Module",
        id,
        path: moduleFile,
        contents: "own",
      });
    }
  }
  return undefined;
}

/**
 * Create one valid Context Module scaffold in the configured Workspace
 * (DEC-026). The name must satisfy the Artifact ID schema, which pins the
 * destination to one `<name>.md` file inside the Workspace's validated
 * `context` category — no authored spelling can escape it. Ingestion is the
 * single duplicate-Artifact-ID authority. The scaffold is preflighted through
 * the canonical Context Module schema before any write. The exclusive open is
 * the sole creation-evidence boundary: only a successful `wx` open authorizes
 * removing the file on later failure, and open failure never deletes a file.
 * Occupied destinations, including symlinks, are never written through.
 */
export async function createContextModule(
  options: CreateContextModuleOptions,
): Promise<CreateContextModuleResult> {
  const id = requireArtifactId(options.name, "new context name");
  const workspace = await ingestSelectedWorkspace(options.home);
  if (workspace.contexts.has(id)) {
    throw new InstallerToolError({
      kind: "duplicate-artifact-name",
      artifactType: "Context Module",
      id,
    });
  }

  // Preflight the exact bytes through the canonical Context Module schema
  // before any filesystem mutation, so schema-invalid material can never be
  // reported as success (CRAFT-2).
  const fileName = `${id}${CONTEXT_MODULE_EXTENSION}`;
  const relativePath = `context/${fileName}`;
  const moduleFile = join(workspace.path, "context", fileName);
  const scaffold = newContextModuleScaffold(id);
  parseContextModule(scaffold, relativePath);

  await requireRealCategory(workspace.path, "context");

  // Occupancy check before creation: any existing entry — file, directory, or
  // symlink — refuses creation, so a symlink is never written through.
  if ((await lstatEntry(moduleFile)) !== undefined) {
    throw new InstallerToolError({
      kind: "artifact-path-occupied",
      artifactType: "Context Module",
      id,
      path: moduleFile,
    });
  }

  // Exclusive leaf creation: fails when the entry appears between the
  // occupancy check and creation; the category was validated as a directory.
  const openModuleFile = options.openModuleFile ?? ((path: string) => open(path, "wx"));
  const writeModuleFile =
    options.writeModuleFile ?? ((handle: FileHandle, contents: string) => handle.writeFile(contents));

  // Ownership transition: only a successful exclusive open proves the file
  // was created by this invocation. Until it succeeds, no file is removed —
  // a pre-open rejection says nothing about what exists at the path.
  let handle: FileHandle;
  try {
    handle = await openModuleFile(moduleFile);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) {
      // A foreign file occupies the destination; it is not ours and is kept.
      throw new InstallerToolError({
        kind: "artifact-path-occupied",
        artifactType: "Context Module",
        id,
        path: moduleFile,
      });
    }
    // Nothing was proven created; the category — if this invocation created
    // it — is a valid Workspace category either way. The original error is
    // reported; a surviving foreign file is refused as occupied on retry.
    throw error;
  }

  let writeError: unknown;
  try {
    await writeModuleFile(handle, scaffold);
  } catch (error) {
    writeError = error;
  }
  if (writeError !== undefined) {
    // Close is secondary during error recovery; it must never mask the
    // original write error.
    await closeQuietly(handle);
    await throwWithResidue(moduleFile, id, writeError);
  }
  // Success path: an awaited close failure is a failed creation, never a
  // success receipt; route it through the same creation recovery.
  try {
    await handle.close();
  } catch (error) {
    await throwWithResidue(moduleFile, id, error);
  }
  return { id, path: moduleFile };
}

/** Remove the proven-created file, then rethrow the original failure — or the typed residue when removal could not confirm absence. */
async function throwWithResidue(moduleFile: string, id: string, original: unknown): Promise<never> {
  const residue = await reportInvocationResidue(moduleFile, id);
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
