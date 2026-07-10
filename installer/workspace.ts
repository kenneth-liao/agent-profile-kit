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

export const WORKSPACE_REQUIRED_ROOT_FILES = [
  "README.md",
  "AGENTS.md",
  ".gitignore",
] as const;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

export async function validateWorkspaceStructure(path: string): Promise<void> {
  await requireWorkspaceEntry(path, WORKSPACE_MANIFEST_FILE, "file");
  const manifest = await readFile(join(path, WORKSPACE_MANIFEST_FILE), "utf8");
  parseWorkspaceManifest(manifest);

  await Promise.all([
    ...WORKSPACE_ARTIFACT_DIRECTORIES.map((directory) =>
      requireWorkspaceEntry(path, directory, "directory"),
    ),
    ...WORKSPACE_REQUIRED_ROOT_FILES.map((file) =>
      requireWorkspaceEntry(path, file, "file"),
    ),
  ]);
}

async function requireWorkspaceEntry(
  workspace: string,
  name: string,
  kind: "directory" | "file",
): Promise<void> {
  let entryStats;
  try {
    entryStats = await stat(join(workspace, name));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        `Workspace is incomplete at ${workspace}: missing required ${kind} '${name}'`,
      );
    }
    throw error;
  }

  const hasExpectedKind =
    kind === "directory" ? entryStats.isDirectory() : entryStats.isFile();
  if (!hasExpectedKind) {
    throw new Error(
      `Workspace is invalid at ${workspace}: '${name}' must be a ${kind}`,
    );
  }
}
