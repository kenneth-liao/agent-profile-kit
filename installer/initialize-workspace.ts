import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST,
} from "../schemas/workspace-manifest.js";

const ARTIFACT_DIRECTORIES = [
  "profiles",
  "context",
  "skills",
  "agents",
  "hooks",
  "tools",
] as const;

const WORKSPACE_ROOT_FILES = {
  "workspace.yaml": WORKSPACE_MANIFEST,
  "README.md": `# Agent Profile Kit Workspace

This Workspace is the canonical source for your Agent Profile Kit material.

Run \`agent-profile-kit guide\` for current authoring guidance.
`,
  "AGENTS.md": `# Agent Profile Kit Workspace

Before editing this Workspace, run \`agent-profile-kit guide --agent\` and follow the current agent-oriented authoring guidance.
`,
  ".gitignore": ".DS_Store\n",
} as const;

const STAGING_DIRECTORY_PREFIX = ".workspace-init-";
const ABANDONED_STAGING_AGE_MS = 24 * 60 * 60 * 1_000;

export function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

export interface InitializationResult {
  readonly outcome: "created" | "unchanged";
  readonly path: string;
  readonly warnings: readonly string[];
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function inspectWorkspace(
  path: string,
): Promise<"missing" | "empty" | "valid"> {
  let pathEntryStats;
  try {
    pathEntryStats = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return "missing";
    }
    throw error;
  }

  let pathStats;
  try {
    pathStats = await stat(path);
  } catch (error) {
    if (pathEntryStats.isSymbolicLink() && hasErrorCode(error, "ENOENT")) {
      throw new Error(
        `Cannot initialize ${path}: the Workspace symlink target does not exist`,
      );
    }
    throw error;
  }

  if (!pathStats.isDirectory()) {
    throw new Error(
      `Cannot initialize ${path}: the Workspace path exists and is not a directory`,
    );
  }

  const entries = await readdir(path);
  if (entries.length === 0) {
    if (pathEntryStats.isSymbolicLink()) {
      throw new Error(
        `Cannot initialize ${path}: the Workspace symlink target is empty; initialize the target directly first`,
      );
    }
    return "empty";
  }
  if (!entries.includes("workspace.yaml")) {
    throw new Error(
      `Cannot initialize ${path}: directory is non-empty and is not an Agent Profile Kit Workspace`,
    );
  }

  await validateWorkspace(path);
  return "valid";
}

async function validateWorkspace(path: string): Promise<void> {
  const manifest = await readFile(join(path, "workspace.yaml"), "utf8");
  parseWorkspaceManifest(manifest);

  await Promise.all([
    ...ARTIFACT_DIRECTORIES.map((directory) =>
      requireWorkspaceEntry(path, directory, "directory"),
    ),
    ...Object.keys(WORKSPACE_ROOT_FILES).map((file) =>
      requireWorkspaceEntry(path, file, "file"),
    ),
  ]);
}

async function removeAbandonedStagingDirectories(
  applicationRoot: string,
): Promise<readonly string[]> {
  const now = Date.now();
  const entries = await readdir(applicationRoot, { withFileTypes: true });

  const warnings = await Promise.all(
    entries.map(async (entry) => {
      if (
        !entry.isDirectory() ||
        !entry.name.startsWith(STAGING_DIRECTORY_PREFIX)
      ) {
        return undefined;
      }

      const path = join(applicationRoot, entry.name);
      try {
        const stats = await stat(path);
        if (now - stats.mtimeMs >= ABANDONED_STAGING_AGE_MS) {
          await rm(path, { recursive: true, force: true });
        }
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return undefined;
        const message = error instanceof Error ? error.message : String(error);
        return `Could not remove abandoned staging directory ${path}: ${message}`;
      }
      return undefined;
    }),
  );

  return warnings.filter((warning): warning is string => warning !== undefined);
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

export async function initializeWorkspace(
  home: string,
): Promise<InitializationResult> {
  const applicationRoot = join(home, ".agents", "agent-profile-kit");
  const destination = workspacePath(home);
  const workspaceState = await inspectWorkspace(destination);

  if (workspaceState === "valid") {
    return { outcome: "unchanged", path: destination, warnings: [] };
  }

  await mkdir(applicationRoot, { recursive: true });
  const warnings = await removeAbandonedStagingDirectories(applicationRoot);
  const stagingDirectory = await mkdtemp(
    join(applicationRoot, STAGING_DIRECTORY_PREFIX),
  );
  let removedEmptyDestination = false;

  try {
    await Promise.all([
      ...Object.entries(WORKSPACE_ROOT_FILES).map(([file, contents]) =>
        writeFile(join(stagingDirectory, file), contents),
      ),
      ...ARTIFACT_DIRECTORIES.map(async (directory) => {
        const path = join(stagingDirectory, directory);
        await mkdir(path);
        await writeFile(join(path, ".gitkeep"), "");
      }),
    ]);
    if (workspaceState === "empty") {
      await rmdir(destination);
      removedEmptyDestination = true;
    }
    await rename(stagingDirectory, destination);
    removedEmptyDestination = false;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (removedEmptyDestination) {
      try {
        await mkdir(destination);
      } catch (restorationError) {
        if (!hasErrorCode(restorationError, "EEXIST")) {
          cleanupErrors.push(restorationError);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Initialization failed and cleanup was incomplete for ${destination}`,
      );
    }
    if (
      !removedEmptyDestination &&
      (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) &&
      (await inspectWorkspace(destination)) === "valid"
    ) {
      return { outcome: "unchanged", path: destination, warnings };
    }
    throw error;
  }

  return { outcome: "created", path: destination, warnings };
}
