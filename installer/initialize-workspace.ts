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

const README = `# Agent Profile Kit Workspace

This Workspace is the canonical source for your Agent Profile Kit material.

Run \`agent-profile-kit guide\` for current authoring guidance.
`;

const AGENTS = `# Agent Profile Kit Workspace

Before editing this Workspace, run \`agent-profile-kit guide --agent\` and follow the current agent-oriented authoring guidance.
`;

const GITIGNORE = ".DS_Store\n";

export function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

export interface InitializationResult {
  readonly outcome: "created" | "unchanged";
  readonly path: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function inspectWorkspace(
  path: string,
): Promise<"missing" | "empty" | "valid"> {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return "missing";
    }
    throw error;
  }

  if (!pathStats.isDirectory()) {
    throw new Error(
      `Cannot initialize ${path}: the Workspace path exists and is not a directory`,
    );
  }

  const entries = await readdir(path);
  if (entries.length === 0) return "empty";
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
    ...["README.md", "AGENTS.md", ".gitignore"].map((file) =>
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

export async function initializeWorkspace(
  home: string,
): Promise<InitializationResult> {
  const applicationRoot = join(home, ".agents", "agent-profile-kit");
  const destination = workspacePath(home);
  const workspaceState = await inspectWorkspace(destination);

  if (workspaceState === "valid") {
    return { outcome: "unchanged", path: destination };
  }

  await mkdir(applicationRoot, { recursive: true });
  const stagingDirectory = await mkdtemp(join(applicationRoot, ".workspace-init-"));
  let removedEmptyDestination = false;

  try {
    await Promise.all([
      writeFile(join(stagingDirectory, "workspace.yaml"), WORKSPACE_MANIFEST),
      writeFile(join(stagingDirectory, "README.md"), README),
      writeFile(join(stagingDirectory, "AGENTS.md"), AGENTS),
      writeFile(join(stagingDirectory, ".gitignore"), GITIGNORE),
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
    await rm(stagingDirectory, { recursive: true, force: true });
    if (removedEmptyDestination) {
      try {
        await mkdir(destination);
      } catch (restorationError) {
        if (!hasErrorCode(restorationError, "EEXIST")) {
          throw new AggregateError(
            [error, restorationError],
            `Initialization failed and the empty Workspace directory could not be restored: ${destination}`,
          );
        }
      }
    }
    throw error;
  }

  return { outcome: "created", path: destination };
}
