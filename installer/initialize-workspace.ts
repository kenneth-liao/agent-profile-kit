import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import {
  WORKSPACE_MANIFEST,
  WORKSPACE_MANIFEST_FILE,
} from "../schemas/workspace-manifest.js";
import {
  EMPTY_LOCAL_CONFIGURATION,
  LOCAL_CONFIGURATION_FILE,
  parseLocalConfiguration,
} from "../schemas/local-configuration.js";
import { localConfigurationPath, resolveWorkspaceRoot } from "./local-configuration.js";
import {
  validateWorkspaceStructure,
  WORKSPACE_ARTIFACT_DIRECTORIES,
  workspacePath,
} from "./workspace.js";

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

export { workspacePath } from "./workspace.js";

export interface InitializationResult {
  readonly outcome: "created" | "unchanged";
  readonly path: string;
  readonly warnings: readonly string[];
}

async function ensureLocalConfiguration(applicationRoot: string): Promise<boolean> {
  const path = join(applicationRoot, LOCAL_CONFIGURATION_FILE);
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  try {
    await writeFile(path, EMPTY_LOCAL_CONFIGURATION, { flag: "wx" });
    return true;
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return false;
    throw error;
  }
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
        `Cannot initialize ${path}: the Workspace symlink target does not exist; remove the symlink or restore its target before retrying`,
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
        `Cannot initialize ${path}: the Workspace symlink target is empty; remove the symlink and run init, or populate its target with a valid Workspace before retrying`,
      );
    }
    return "empty";
  }
  if (!entries.includes(WORKSPACE_MANIFEST_FILE)) {
    throw new Error(
      `Cannot initialize ${path}: directory is non-empty and is not an Agent Profile Kit Workspace`,
    );
  }

  await validateWorkspaceStructure(path);
  return "valid";
}

/**
 * When Local Configuration already selects a custom Workspace path, validate
 * that target only. Never create, move, copy, adopt, or repair user-owned source.
 */
async function initializeConfiguredWorkspace(
  home: string,
  authored: string,
  configPath: string,
): Promise<InitializationResult> {
  const resolved = await resolveWorkspaceRoot(home, authored, configPath);
  return {
    outcome: "unchanged",
    path: resolved.path,
    warnings: [],
  };
}

export async function initializeWorkspace(
  home: string,
): Promise<InitializationResult> {
  const applicationRoot = join(home, ".agents", "agent-profile-kit");
  const configPath = localConfigurationPath(home);

  let authoredWorkspace: string | undefined;
  try {
    const source = await readFile(configPath, "utf8");
    const parsed = parseLocalConfiguration(source, configPath);
    authoredWorkspace = parsed.workspace;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  if (authoredWorkspace !== undefined) {
    return initializeConfiguredWorkspace(home, authoredWorkspace, configPath);
  }

  const destination = workspacePath(home);
  const workspaceState = await inspectWorkspace(destination);

  let workspaceCreated = false;
  if (workspaceState === "valid") {
    await mkdir(applicationRoot, { recursive: true });
    const configurationCreated = await ensureLocalConfiguration(applicationRoot);
    return {
      outcome: configurationCreated ? "created" : "unchanged",
      path: destination,
      warnings: [],
    };
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
      ...WORKSPACE_ARTIFACT_DIRECTORIES.map(async (directory) => {
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
          const configurationCreated = await ensureLocalConfiguration(applicationRoot);
          const cleanupWarnings = followUpErrors.map(
            (cleanupError) =>
              `Could not remove unused staging directory ${stagingDirectory}: ${errorMessage(cleanupError)}`,
          );
          return {
            outcome: configurationCreated ? "created" : "unchanged",
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

  workspaceCreated = true;
  const configurationCreated = await ensureLocalConfiguration(applicationRoot);
  return {
    outcome: workspaceCreated || configurationCreated ? "created" : "unchanged",
    path: destination,
    warnings: [],
  };
}
