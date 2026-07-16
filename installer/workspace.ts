import { lstat, stat, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_FILE,
} from "../schemas/workspace-manifest.js";

export const WORKSPACE_ARTIFACT_DIRECTORIES = [
  "profiles",
  "context",
  "skills",
  "agents",
  "hooks",
  "tools",
] as const;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

/**
 * Require a supported Workspace Manifest. Missing artifact directories are empty
 * categories; present ones must be directories. Bootstrap docs are not required.
 */
export async function validateWorkspaceStructure(path: string): Promise<void> {
  await requireWorkspaceManifestFile(path);
  const manifest = await readFile(join(path, WORKSPACE_MANIFEST_FILE), "utf8");
  parseWorkspaceManifest(manifest);

  await Promise.all(
    WORKSPACE_ARTIFACT_DIRECTORIES.map((directory) =>
      requirePresentDirectory(path, directory),
    ),
  );
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
      throw new Error(
        `Workspace is invalid at ${workspace}: '${name}' is a dangling symlink; remove it or restore its target directory`,
      );
    }
    throw error;
  }

  if (!targetStats.isDirectory()) {
    throw new Error(
      `Workspace is invalid at ${workspace}: '${name}' must be a directory`,
    );
  }
}

async function requireWorkspaceManifestFile(workspace: string): Promise<void> {
  let entryStats;
  try {
    entryStats = await stat(join(workspace, WORKSPACE_MANIFEST_FILE));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        `Workspace is incomplete at ${workspace}: missing required file '${WORKSPACE_MANIFEST_FILE}'`,
      );
    }
    throw error;
  }

  if (!entryStats.isFile()) {
    throw new Error(
      `Workspace is invalid at ${workspace}: '${WORKSPACE_MANIFEST_FILE}' must be a file`,
    );
  }
}
