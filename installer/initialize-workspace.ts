import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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
} from "../schemas/local-configuration.js";
import {
  assertWorkspaceSelectionSeparation,
  expandConfiguredPath,
  localConfigurationPath,
  requireCurrentApplicationConfiguration,
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
import { AUTHORING_EXAMPLES } from "./authoring-examples.js";
import { COMMAND_NAME } from "./version.js";
import { InstallerToolError } from "./tool-errors.js";

const WORKSPACE_ROOT_FILES = {
  [WORKSPACE_MANIFEST_FILE]: WORKSPACE_MANIFEST,
  "README.md": `# Agent Profile Kit Workspace

This Workspace is the canonical source for your Agent Profile Kit material.

Run \`${COMMAND_NAME} guide --full\` for current authoring guidance.
`,
  "AGENTS.md": `# Agent Profile Kit Workspace

Before editing this Workspace, run \`${COMMAND_NAME} guide --agent\` and follow the current agent-oriented authoring guidance.
`,
  ".gitignore": ".DS_Store\n",
} as const;

const STAGING_DIRECTORY_PREFIX = ".workspace-init-";

export { workspacePath } from "./workspace.js";

export interface InitializationResult {
  readonly outcome: "created" | "migrated" | "unchanged";
  readonly path: string;
  readonly workspaceScaffolded: boolean;
  readonly warnings: readonly string[];
}

export interface InitializeWorkspaceOptions {
  /** Optional explicit authored Workspace selection for init. */
  readonly workspace?: string;
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

async function assertWorkspaceSelectionPath(
  home: string,
  authored: string,
): Promise<string> {
  const destination = expandConfiguredPath(authored, home, { source: "init" }, "workspace");
  await assertWorkspaceSelectionSeparation(home, destination, authored, { source: "init" });
  return destination;
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
      throw new InstallerToolError({ kind: "init-symlink-target-missing", path });
    }
    throw error;
  }

  if (!pathStats.isDirectory()) {
    throw new InstallerToolError({ kind: "init-path-not-directory", path });
  }

  const entries = await readdir(path);
  if (entries.length === 0) {
    if (pathEntryStats.isSymbolicLink()) {
      throw new InstallerToolError({ kind: "init-empty-symlink-target", path });
    }
    return "empty";
  }
  if (!entries.includes(WORKSPACE_MANIFEST_FILE)) {
    throw new InstallerToolError({ kind: "init-not-workspace-directory", path });
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
    workspaceScaffolded: false,
    warnings: [],
  };
}

async function initializeExplicitWorkspaceSelection(
  home: string,
  requested: string,
  configured: string,
  configPath: string,
): Promise<InitializationResult> {
  const configuredWorkspace = await resolveWorkspaceRoot(home, configured, configPath);
  const requestedWorkspace = await resolveWorkspaceRoot(home, requested, configPath);
  assertCanonicalWorkspaceMatch(
    requested,
    requestedWorkspace.path,
    configuredWorkspace.path,
    configPath,
  );
  return {
    outcome: "unchanged",
    path: requestedWorkspace.path,
    workspaceScaffolded: false,
    warnings: [],
  };
}

function assertCanonicalWorkspaceMatch(
  requested: string,
  requestedPath: string,
  configuredPath: string,
  configPath: string,
): void {
  if (configuredPath === requestedPath) return;
  throw new InstallerToolError({
    kind: "init-workspace-selection-conflict",
    requested,
    configurationPath: configPath,
    configuredPath,
  });
}

function selectsConventionalDefaultWorkspace(home: string, authored: string): boolean {
  try {
    return expandConfiguredPath(
      authored,
      home,
      { source: "local-configuration", configurationPath: localConfigurationPath(home) },
      "workspace",
    ) === workspacePath(home);
  } catch {
    return false;
  }
}

async function initializeWorkspaceAt(
  home: string,
  authored: string,
  ensureConfiguration: boolean,
): Promise<InitializationResult> {
  const applicationRoot = join(home, ".agents", "agent-profile-kit");
  const destination = await assertWorkspaceSelectionPath(home, authored);
  const workspaceState = await inspectWorkspace(destination);

  if (workspaceState === "valid") {
    if (ensureConfiguration) {
      await mkdir(applicationRoot, { recursive: true });
      const configurationCreated = await ensureLocalConfiguration(applicationRoot, authored);
      return {
        outcome: configurationCreated ? "created" : "unchanged",
        path: await realpath(destination),
        workspaceScaffolded: false,
        warnings: [],
      };
    }
    return {
      outcome: "unchanged",
      path: await realpath(destination),
      workspaceScaffolded: false,
      warnings: [],
    };
  }

  await Promise.all([
    mkdir(applicationRoot, { recursive: true }),
    mkdir(dirname(destination), { recursive: true }),
  ]);
  const stagingDirectory = await mkdtemp(
    join(dirname(destination), STAGING_DIRECTORY_PREFIX),
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
    await Promise.all(
      [AUTHORING_EXAMPLES.profile, AUTHORING_EXAMPLES.context].map((example) =>
        writeFile(join(stagingDirectory, example.path), example.contents),
      ),
    );
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
            ? await ensureLocalConfiguration(applicationRoot, authored)
            : false;
          const cleanupWarnings = followUpErrors.map(
            (cleanupError) =>
              `Could not remove unused staging directory ${stagingDirectory}: ${errorMessage(cleanupError)}`,
          );
          return {
            outcome: configurationCreated ? "created" : "unchanged",
            path: await realpath(destination),
            workspaceScaffolded: false,
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

  const configurationCreated = ensureConfiguration
    ? await ensureLocalConfiguration(applicationRoot, authored)
    : false;
  return {
    outcome: "created",
    path: await realpath(destination),
    workspaceScaffolded: true,
    warnings: [],
  };
}

async function initializeDefaultWorkspace(
  home: string,
  ensureConfiguration: boolean,
): Promise<InitializationResult> {
  return initializeWorkspaceAt(home, workspacePath(home), ensureConfiguration);
}

async function initializeWithoutConfiguration(
  home: string,
  configPath: string,
  fileSystem: LocalConfigurationFileSystem,
  lockTimeoutMs: number,
  options: InitializeWorkspaceOptions,
): Promise<InitializationResult> {
  const authored = options.workspace ?? workspacePath(home);
  const destination = await assertWorkspaceSelectionPath(home, authored);
  await inspectWorkspace(destination);
  await mkdir(dirname(configPath), { recursive: true });

  const initialized = await withConfigurationLock(
    configPath,
    fileSystem,
    lockTimeoutMs,
    "init",
    async () => {
      try {
        await fileSystem.readFile(configPath, "utf8");
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
        return options.workspace === undefined
          ? initializeDefaultWorkspace(home, true)
          : initializeWorkspaceAt(home, options.workspace, true);
      }
      return undefined;
    },
  );
  return initialized ?? initializeWorkspace(home, options);
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
  requestedWorkspace?: string,
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

      let selectedWorkspace = parsed.workspace ?? workspacePath(home);
      if (requestedWorkspace !== undefined) {
        if (parsed.workspace === undefined) {
          const requestedExpanded = expandConfiguredPath(
            requestedWorkspace,
            home,
            { source: "init" },
            "workspace",
          );
          if (requestedExpanded !== workspacePath(home)) {
            await initializeExplicitWorkspaceSelection(
              home,
              requestedWorkspace,
              workspacePath(home),
              configPath,
            );
          }
          selectedWorkspace = requestedWorkspace;
        } else {
          await initializeExplicitWorkspaceSelection(
            home,
            requestedWorkspace,
            parsed.workspace,
            configPath,
          );
        }
      }
      const workspaceResult = parsed.workspace === undefined
        ? await initializeWorkspaceAt(home, selectedWorkspace, false)
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
        workspaceScaffolded: workspaceResult.workspaceScaffolded,
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
      return initializeWithoutConfiguration(
        home,
        configPath,
        fileSystem,
        lockTimeoutMs,
        options,
      );
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
      options.workspace,
    );
    return migrated ?? initializeWorkspace(home, options);
  }
  const authoredWorkspace = requireCurrentApplicationConfiguration(parsed, configPath).workspace;
  if (options.workspace !== undefined) {
    return initializeExplicitWorkspaceSelection(
      home,
      options.workspace,
      authoredWorkspace,
      configPath,
    );
  }
  if (selectsConventionalDefaultWorkspace(home, authoredWorkspace)) {
    return initializeDefaultWorkspace(home, false);
  }
  return initializeConfiguredWorkspace(home, authoredWorkspace, configPath);
}
