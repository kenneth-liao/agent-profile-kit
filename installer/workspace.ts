import { stat, readFile } from "node:fs/promises";
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

/** When the named path exists, require it to be a directory; absence is valid (empty). */
async function requirePresentDirectory(
  workspace: string,
  name: string,
): Promise<void> {
  let entryStats;
  try {
    entryStats = await stat(join(workspace, name));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }

  if (!entryStats.isDirectory()) {
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
