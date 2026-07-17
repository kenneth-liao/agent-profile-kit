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
import { parseDocument } from "yaml";

import {
  WORKSPACE_MANIFEST,
  WORKSPACE_MANIFEST_FILE,
} from "../schemas/workspace-manifest.js";
import {
  createEmptyLocalConfiguration,
  LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION,
  LOCAL_CONFIGURATION_SCHEMA_VERSION,
  LOCAL_CONFIGURATION_FILE,
  parseLocalConfiguration,
  requireCurrentLocalConfiguration,
} from "../schemas/local-configuration.js";
import {
  expandConfiguredPath,
  localConfigurationPath,
  resolveWorkspaceRoot,
} from "./local-configuration.js";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  defaultFileSystem,
  preserveSourceNewlines,
  publishConfigurationReplacement,
  type LocalConfigurationFileSystem,
  withConfigurationLock,
} from "./local-configuration-publication.js";
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
  readonly outcome: "created" | "migrated" | "unchanged";
  readonly path: string;
  readonly warnings: readonly string[];
}

export interface InitializeWorkspaceOptions {
  /** Test-only filesystem override for migration publication proofs. */
  readonly fileSystem?: LocalConfigurationFileSystem;
  /** Test-only lock wait/stale-empty timeout (ms). */
  readonly lockTimeoutMs?: number;
}

async function ensureLocalConfiguration(
  applicationRoot: string,
  workspace: string,
): Promise<boolean> {
  const path = join(applicationRoot, LOCAL_CONFIGURATION_FILE);
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  try {
    await writeFile(path, createEmptyLocalConfiguration(workspace), { flag: "wx" });
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

function selectsConventionalDefaultWorkspace(home: string, authored: string): boolean {
  try {
    return expandConfiguredPath(
      authored,
      home,
      `Local Configuration ${localConfigurationPath(home)}`,
      "workspace",
    ) === workspacePath(home);
  } catch {
    return false;
  }
}

async function initializeDefaultWorkspace(
  home: string,
  ensureConfiguration: boolean,
): Promise<InitializationResult> {
  const applicationRoot = join(home, ".agents", "agent-profile-kit");
  const destination = workspacePath(home);
  const workspaceState = await inspectWorkspace(destination);

  let workspaceCreated = false;
  if (workspaceState === "valid") {
    if (ensureConfiguration) {
      await mkdir(applicationRoot, { recursive: true });
      const configurationCreated = await ensureLocalConfiguration(applicationRoot, destination);
      return {
        outcome: configurationCreated ? "created" : "unchanged",
        path: destination,
        warnings: [],
      };
    }
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
          const configurationCreated = ensureConfiguration
            ? await ensureLocalConfiguration(applicationRoot, destination)
            : false;
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
  const configurationCreated = ensureConfiguration
    ? await ensureLocalConfiguration(applicationRoot, destination)
    : false;
  return {
    outcome: workspaceCreated || configurationCreated ? "created" : "unchanged",
    path: destination,
    warnings: [],
  };
}

function migrateLegacyConfigurationSource(source: string, workspace: string): string {
  const document = parseDocument(source);
  document.set("schema_version", LOCAL_CONFIGURATION_SCHEMA_VERSION);
  document.set("workspace", workspace);
  return preserveSourceNewlines(source, document.toString());
}

async function migrateLegacyConfiguration(
  home: string,
  configPath: string,
  fileSystem: LocalConfigurationFileSystem,
  lockTimeoutMs: number,
): Promise<InitializationResult | undefined> {
  return withConfigurationLock(
    configPath,
    fileSystem,
    lockTimeoutMs,
    "init",
    async () => {
      const source = await fileSystem.readFile(configPath, "utf8");
      const parsed = parseLocalConfiguration(source, configPath);
      if (parsed.schemaVersion !== LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION) {
        return undefined;
      }

      const selectedWorkspace = parsed.workspace ?? workspacePath(home);
      const workspaceResult = parsed.workspace === undefined
        ? await initializeDefaultWorkspace(home, false)
        : await initializeConfiguredWorkspace(home, parsed.workspace, configPath);
      const nextSource = migrateLegacyConfigurationSource(source, selectedWorkspace);
      const sourceStats = await fileSystem.stat(configPath);
      await publishConfigurationReplacement(
        configPath,
        source,
        nextSource,
        sourceStats.mode & 0o777,
        fileSystem,
        `Local Configuration ${configPath}`,
        "init migration",
      );

      return {
        outcome: "migrated",
        path: workspaceResult.path,
        warnings: workspaceResult.warnings,
      };
    },
  );
}

export async function initializeWorkspace(
  home: string,
  options: InitializeWorkspaceOptions = {},
): Promise<InitializationResult> {
  const configPath = localConfigurationPath(home);
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  let source: string;
  try {
    source = await fileSystem.readFile(configPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return initializeDefaultWorkspace(home, true);
    }
    throw error;
  }

  const parsed = parseLocalConfiguration(source, configPath);
  if (parsed.schemaVersion === LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION) {
    const migrated = await migrateLegacyConfiguration(
      home,
      configPath,
      fileSystem,
      lockTimeoutMs,
    );
    return migrated ?? initializeWorkspace(home, options);
  }
  const authoredWorkspace = requireCurrentLocalConfiguration(parsed, configPath).workspace;
  if (selectsConventionalDefaultWorkspace(home, authoredWorkspace)) {
    return initializeDefaultWorkspace(home, false);
  }
  return initializeConfiguredWorkspace(home, authoredWorkspace, configPath);
}
