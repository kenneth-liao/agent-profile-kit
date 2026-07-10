import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_MANIFEST_FILE,
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
  [WORKSPACE_MANIFEST_FILE]: WORKSPACE_MANIFEST,
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  if (!entries.includes(WORKSPACE_MANIFEST_FILE)) {
    throw new Error(
      `Cannot initialize ${path}: directory is non-empty and is not an Agent Profile Kit Workspace`,
    );
  }

  await validateWorkspace(path);
  return "valid";
}

async function validateWorkspace(path: string): Promise<void> {
  await requireWorkspaceEntry(path, WORKSPACE_MANIFEST_FILE, "file");
  const manifest = await readFile(join(path, WORKSPACE_MANIFEST_FILE), "utf8");
  parseWorkspaceManifest(manifest);

  await Promise.all([
    ...ARTIFACT_DIRECTORIES.map((directory) =>
      requireWorkspaceEntry(path, directory, "directory"),
    ),
    ...Object.keys(WORKSPACE_ROOT_FILES)
      .filter((file) => file !== WORKSPACE_MANIFEST_FILE)
      .map((file) => requireWorkspaceEntry(path, file, "file")),
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
  const stagingDirectory = await mkdtemp(
    join(applicationRoot, STAGING_DIRECTORY_PREFIX),
  );

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
    await rename(stagingDirectory, destination);
  } catch (error) {
    const followUpErrors: unknown[] = [];
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      followUpErrors.push(cleanupError);
    }

    if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) {
      try {
        if ((await inspectWorkspace(destination)) === "valid") {
          const cleanupWarnings = followUpErrors.map(
            (cleanupError) =>
              `Could not remove unused staging directory ${stagingDirectory}: ${errorMessage(cleanupError)}`,
          );
          return {
            outcome: "unchanged",
            path: destination,
            warnings: cleanupWarnings,
          };
        }
      } catch (inspectionError) {
        followUpErrors.push(inspectionError);
      }
    }

    if (followUpErrors.length > 0) {
      throw new AggregateError(
        [error, ...followUpErrors],
        `Initialization failed and follow-up handling was incomplete for ${destination}`,
      );
    }
    throw error;
  }

  return { outcome: "created", path: destination, warnings: [] };
}
