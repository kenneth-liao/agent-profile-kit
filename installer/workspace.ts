import { lstat, mkdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Stats } from "node:fs";

import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_FILE,
} from "../schemas/workspace-manifest.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import {
  InstallerToolError,
  type InstallerToolErrorFact,
  type WorkspaceIngestionErrorFact,
  type WorkspaceViolation,
} from "./tool-errors.js";

export const WORKSPACE_ARTIFACT_DIRECTORIES = [
  "profiles",
  "context",
  "skills",
] as const;

/**
 * The one guard for the structure stage's throwers: they raise exactly the
 * four structural facts, so a collected structure violation can never be an
 * aggregate or non-Workspace fact.
 */
function isStructureFact(
  fact: InstallerToolErrorFact,
): fact is Extract<
  WorkspaceIngestionErrorFact,
  { readonly kind: "workspace-missing-manifest" | "workspace-manifest-not-file" | "workspace-dangling-category" | "workspace-category-not-directory" }
> {
  return (
    fact.kind === "workspace-missing-manifest" ||
    fact.kind === "workspace-manifest-not-file" ||
    fact.kind === "workspace-dangling-category" ||
    fact.kind === "workspace-category-not-directory"
  );
}

/**
 * The canonical entry-file name of one Skill package (Agent Skills standard);
 * the single home so the Skill-package locator and every detection or read of
 * the entry file cannot drift from it (US-015, #508).
 */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * The Workspace-relative SKILL.md locator for one Skill whose source directory
 * is `skillDirectory` under `workspaceRoot`: one home for the locator formula
 * shared by Workspace ingestion and Skill creation, so a duplicate-Artifact-ID
 * fact cannot name a different file than the one a user would edit.
 */
export function skillEntryRelativePath(workspaceRoot: string, skillDirectory: string): string {
  return join(relative(workspaceRoot, skillDirectory), SKILL_FILE_NAME);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Read one filesystem entry without following symlinks; absence is undefined. */
export async function lstatEntry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Require the named Workspace artifact category to be a real directory before
 * any creation write (CRAFT-1): a symlinked category — even one resolving to
 * a directory inside or outside the Workspace — must never receive writes, so
 * identity is checked with lstat, never through the link. A missing category
 * is a valid empty Workspace and is created exclusively.
 */
export async function requireRealCategory(workspacePath: string, name: string): Promise<void> {
  const categoryDirectory = join(workspacePath, name);
  let entry = await lstatEntry(categoryDirectory);
  if (entry === undefined) {
    try {
      await mkdir(categoryDirectory);
      return;
    } catch (error) {
      // Lost a creation race; re-validate whatever now occupies the category.
      if (!hasErrorCode(error, "EEXIST")) throw error;
      entry = await lstat(categoryDirectory);
    }
  }
  if (entry!.isSymbolicLink() || !entry!.isDirectory()) {
    throw new InstallerToolError({
      kind: "workspace-category-not-directory",
      workspace: workspacePath,
      name,
    });
  }
}

/**
 * The collected result of the Workspace structure stage (spec #593 DEC-009,
 * #604): every structural violation at once, plus which artifact categories
 * are readable directories and may be scanned. A missing category is a valid
 * empty collection, never a violation.
 */export interface WorkspaceStructureCollection {
  readonly violations: readonly WorkspaceViolation[];
  /** Category names backed by a readable real directory. */
  readonly readableCategories: ReadonlySet<string>;
}

/**
 * Collect every Workspace structure violation in one run: the Manifest's
 * presence, bytes, and rejections, then each artifact category's presence
 * and shape, independently. `manifestSource` replaces the on-disk
 * `workspace.yaml` with in-memory bytes (spec #593 #599): setup validates a
 * folder whose manifest is missing against the canonical manifest it would
 * write. A structure violation never stops the other checks — the complete
 * report is the point (DEC-009).
 */
export async function collectWorkspaceStructure(
  path: string,
  manifestSource?: string,
): Promise<WorkspaceStructureCollection> {
  const violations: WorkspaceViolation[] = [];
  const readableCategories = new Set<string>();
  if (manifestSource === undefined) {
    try {
      await requireWorkspaceManifestFile(path);
    } catch (error) {
      if (error instanceof InstallerToolError && isStructureFact(error.fact)) {
        violations.push({ via: "ingestion", fact: error.fact });
      } else {
        throw error;
      }
    }
  }
  if (violations.length === 0) {
    const manifestBytes = manifestSource ?? await readFile(join(path, WORKSPACE_MANIFEST_FILE), "utf8");
    try {
      parseWorkspaceManifest(manifestBytes);
    } catch (error) {
      if (error instanceof SchemaRejectionError && error.reason.schema === "workspace-manifest") {
        violations.push({ via: "manifest", detail: error.reason.detail });
      } else {
        throw error;
      }
    }
  }
  await Promise.all(
    WORKSPACE_ARTIFACT_DIRECTORIES.map(async (directory) => {
      try {
        await requirePresentDirectory(path, directory);
        readableCategories.add(directory);
      } catch (error) {
        if (error instanceof InstallerToolError && isStructureFact(error.fact)) {
          violations.push({ via: "ingestion", fact: error.fact });
        } else {
          throw error;
        }
      }
    }),
  );
  return { violations, readableCategories };
}

/**
 * Require a supported Workspace Manifest. Missing artifact directories are empty
 * categories; present ones must be directories. Bootstrap docs are not required.
 *
 * Ingest-or-throw composition over {@link collectWorkspaceStructure}: the
 * first collected violation is re-raised in its original error form (typed
 * Installer fact or manifest schema rejection), so callers that wrap single
 * facts keep their exact behavior.
 */
export async function validateWorkspaceStructure(path: string, manifestSource?: string): Promise<void> {
  const { violations } = await collectWorkspaceStructure(path, manifestSource);
  const first = violations[0];
  if (first === undefined) return;
  switch (first.via) {
    case "ingestion":
      throw new InstallerToolError(first.fact);
    case "manifest":
      throw new SchemaRejectionError({ schema: "workspace-manifest", detail: first.detail });
    case "artifact":
      throw new SchemaRejectionError({ schema: "workspace-artifact", detail: first.detail });
  }
}

/**
 * When the named path is absent, the category is empty. When a directory entry
 * is present (including a symlink), it must resolve to a directory — dangling
 * symlinks are structural errors, not empty categories.
 */
async function requirePresentDirectory(
  workspace: string,
  name: string,
): Promise<void> {
  const entryPath = join(workspace, name);
  try {
    await lstat(entryPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  let targetStats;
  try {
    targetStats = await stat(entryPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new InstallerToolError({
        kind: "workspace-dangling-category",
        workspace,
        name,
      });
    }
    throw error;
  }

  if (!targetStats.isDirectory()) {
    throw new InstallerToolError({
      kind: "workspace-category-not-directory",
      workspace,
      name,
    });
  }
}

async function requireWorkspaceManifestFile(workspace: string): Promise<void> {
  let entryStats;
  try {
    entryStats = await stat(join(workspace, WORKSPACE_MANIFEST_FILE));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new InstallerToolError({
        kind: "workspace-missing-manifest",
        workspace,
      });
    }
    throw error;
  }

  if (!entryStats.isFile()) {
    throw new InstallerToolError({
      kind: "workspace-manifest-not-file",
      workspace,
    });
  }
}
