import { lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
import { applicationDirectory } from "./application-directory.js";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  defaultFileSystem,
  preserveSourceNewlines,
  publishConfigurationReplacement,
  type LocalConfigurationFileSystem,
  withConfigurationLock,
} from "./local-configuration-publication.js";
import {
  lstatEntry,
  WORKSPACE_ARTIFACT_DIRECTORIES,
} from "./workspace.js";
import { ingestWorkspace } from "./ingest-workspace.js";
import { InstallerToolError } from "./tool-errors.js";

export interface InitializationResult {
  readonly outcome: "created" | "migrated" | "unchanged";
  readonly path: string;
  /** The effective authored Workspace spelling this outcome rendered. */
  readonly authoredPath: string;
  /** True when setup created the named folder itself (it did not exist). */
  readonly folderCreated: boolean;
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
  fileSystem: LocalConfigurationFileSystem,
): Promise<boolean> {
  const path = join(applicationRoot, LOCAL_CONFIGURATION_FILE);
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  try {
    await fileSystem.writeFile(path, createEmptyLocalConfiguration(workspace), { flag: "wx" });
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

/**
 * Normalize one authored CLI Workspace argument to the spelling setup records
 * and resolves downstream (spec #593 ISC-26, #599): home-relative forms keep
 * their authored `~/…` spelling (cwd-stable by construction), while every
 * working-directory-relative form — including `.` — is resolved to the named
 * absolute folder, because a relative spelling would select a different
 * folder when later commands run from another directory. Any other `~…`
 * form (for example `~otheruser/x`) is passed through untouched so the
 * shared path-shape boundary rejects it as a relative path instead of
 * resolving it to a literal directory under the working directory.
 */
function normalizeAuthoredWorkspace(value: string): string {
  return value.startsWith("~") ? value : resolve(value);
}

async function assertWorkspaceSelectionPath(
  home: string,
  authored: string,
): Promise<string> {
  const destination = expandConfiguredPath(authored, home, { source: "init" }, "workspace");
  await assertWorkspaceSelectionSeparation(home, destination, authored, { source: "init" });
  return destination;
}

/**
 * The path facts of one setup destination, checked before any write: a
 * missing folder is provisionable, anything present must resolve to a real
 * directory, and the established symlink refusals stand — a symlink is
 * followed only when its target is a non-empty directory.
 */
async function inspectDestinationPath(
  path: string,
): Promise<"missing" | "present"> {
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

  if (pathEntryStats.isSymbolicLink()) {
    const entries = await readdir(path);
    if (entries.length === 0) {
      throw new InstallerToolError({ kind: "init-empty-symlink-target", path });
    }
  }
  return "present";
}

/**
 * Refuse a missing named folder whose parent directory is missing too
 * (spec #593 #599): nothing is ever written outside the named path, so setup
 * never creates missing parent directories.
 */
async function requireProvisionableDestination(
  destination: string,
  allowMissingParents: boolean,
): Promise<void> {
  const state = await inspectDestinationPath(destination);
  if (state === "missing" && !allowMissingParents) {
    const parent = dirname(destination);
    let parentStats;
    try {
      parentStats = await stat(parent);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
        throw new InstallerToolError({
          kind: "init-missing-parent-directory",
          path: destination,
          parent,
        });
      }
      throw error;
    }
    if (!parentStats.isDirectory()) {
      throw new InstallerToolError({
        kind: "init-missing-parent-directory",
        path: destination,
        parent,
      });
    }
  }
}

/**
 * The write-free validation of a folder's would-be Workspace state (spec #593
 * DEC-011, #599): the on-disk manifest when present, otherwise the canonical
 * manifest setup would write. Returns whether the manifest already exists, so
 * the caller knows which parts the transaction still owes.
 */
async function validateWouldBeWorkspace(destination: string): Promise<boolean> {
  const manifestPath = join(destination, WORKSPACE_MANIFEST_FILE);
  const manifestPresent = (await lstatEntry(manifestPath)) !== undefined;
  await ingestWorkspace(destination, manifestPresent ? undefined : WORKSPACE_MANIFEST);
  return manifestPresent;
}

/**
 * The one setup write transaction (spec #593 DEC-003, #599, DEC-011): the
 * folder's would-be state is validated write-free before anything is written
 * — the on-disk manifest when present, otherwise the canonical manifest setup
 * is about to write — so an invalid folder is refused with its violation and
 * zero writes. Valid folders then receive exactly their missing required
 * parts, added in place; existing entries are never changed, moved, or
 * deleted. A failure after some parts were added reports exactly what was
 * added (`init-partial-setup`); a re-run adds only the still-missing parts.
 */
async function prepareWorkspaceDestination(
  destination: string,
  options: {
    readonly fileSystem: LocalConfigurationFileSystem;
    readonly allowMissingParents: boolean;
  },
): Promise<{ readonly folderCreated: boolean; readonly added: readonly string[] }> {
  await requireProvisionableDestination(destination, options.allowMissingParents);
  const state = await inspectDestinationPath(destination);
  const folderCreated = state === "missing";
  const manifestPath = join(destination, WORKSPACE_MANIFEST_FILE);
  const manifestPresent = await validateWouldBeWorkspace(destination);

  const added: string[] = [];
  /**
   * Exclusive creation for one directory entry (spec #593 #599, PROD-1):
   * an EEXIST from a concurrent creator converges only when the winner is a
   * real directory; a file or symlink at the path fails closed instead of
   * being silently adopted or written through.
   */
  const ensureDirectory = async (path: string): Promise<boolean> => {
    try {
      await options.fileSystem.mkdir(path);
      return true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      let stats;
      try {
        stats = await options.fileSystem.stat(path);
      } catch (statError) {
        throw statError;
      }
      if (!stats.isDirectory()) throw error;
      return false;
    }
  };
  const commit = async (): Promise<void> => {
    if (folderCreated) {
      if (await ensureDirectory(destination)) added.push(destination);
    }
    if (!manifestPresent) {
      let manifestWritten = true;
      try {
        await options.fileSystem.writeFile(manifestPath, WORKSPACE_MANIFEST, { flag: "wx" });
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
        // A manifest appeared between validation and the write: converge on
        // the on-disk state, failing closed when it is not a valid Workspace.
        manifestWritten = false;
        await ingestWorkspace(destination);
      }
      if (manifestWritten) added.push(WORKSPACE_MANIFEST_FILE);
    }
    // A folder that already satisfies the structure is never re-scaffolded by
    // a re-init, but every destination that reaches this transaction is a
    // first connection at a user-given path — the already-connected cases
    // (zero-argument on a configured machine, an explicit matching request)
    // resolve the configured Workspace without it, and the legacy implicit
    // default is gone (spec #593 #601). So a manifest-present folder always
    // receives its missing required directories (PR #617 review INT-1).
    for (const directory of WORKSPACE_ARTIFACT_DIRECTORIES) {
      const created = await ensureDirectory(join(destination, directory));
      if (created) added.push(directory);
    }
  };
  try {
    await commit();
  } catch (error) {
    throw new InstallerToolError({
      kind: "init-partial-setup",
      path: destination,
      added: [...added],
      cause: errorMessage(error),
    });
  }
  return { folderCreated, added: [...added] };
}

/**
 * Read-only preview of the Workspace one `init` invocation will target, so
 * guided initialization can offer material selections before committing any
 * change (US-054, DEC-031). One home beside the resolution logic it mirrors:
 * the destination is resolved the same way init resolves it, and the material
 * is read through the canonical Workspace ingestion boundary. Setup no longer
 * scaffolds example material (spec #593 DEC-003, #599), so a missing or empty
 * destination previews no material and the guided first-Profile offer fires
 * only for a destination that already has material but no Profile. Ambiguous
 * targets (invalid Workspace, legacy migration, unread material) return
 * undefined, meaning "do not offer guidance": init then behaves exactly as it
 * does today and explains any problem itself.
 */
export interface InitTargetPreview {
  /** Absolute destination path this init will target. */
  readonly destinationPath: string;
  /** Existing Profile IDs at the destination. */
  readonly profiles: readonly string[];
  /** Existing Context Module IDs at the destination. */
  readonly contexts: readonly string[];
  /** Existing Skill IDs at the destination. */
  readonly skills: readonly string[];
}

async function previewWorkspaceDestination(
  destination: string,
): Promise<InitTargetPreview | undefined> {
  const state = await inspectDestinationPath(destination).catch(() => undefined);
  if (state === undefined) return undefined;
  if (state === "missing") {
    return { destinationPath: destination, profiles: [], contexts: [], skills: [] };
  }
  try {
    const workspace = await ingestWorkspace(await realpath(destination));
    return {
      destinationPath: destination,
      profiles: [...workspace.profiles.keys()].sort(),
      contexts: [...workspace.contexts.keys()].sort(),
      skills: [...workspace.skills.keys()].sort(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Preview the init target for guided initialization without changing anything.
 * Mirrors `initializeWorkspace`'s destination selection read-only; see
 * `InitTargetPreview`'s undefined contract. Zero-argument init on a machine
 * with no selected Workspace refuses (spec #593 #601), so it previews no
 * target.
 */
export async function previewInitTarget(
  home: string,
  options: { readonly workspace?: string } = {},
): Promise<InitTargetPreview | undefined> {
  const requested = options.workspace === undefined
    ? undefined
    : normalizeAuthoredWorkspace(options.workspace);
  const configPath = localConfigurationPath(home);
  let source: string;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    try {
      if (requested === undefined) return undefined;
      const destination = await assertWorkspaceSelectionPath(home, requested);
      return await previewWorkspaceDestination(destination);
    } catch {
      return undefined;
    }
  }
  let parsed;
  try {
    parsed = parseLocalConfiguration(source, configPath);
  } catch {
    return undefined;
  }
  if (parsed.schemaVersion === LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION) {
    return undefined;
  }
  const configured = requireCurrentApplicationConfiguration(parsed, configPath).workspace;
  try {
    if (requested !== undefined) {
      // Share init's read-only explicit-selection eligibility check: the same
      // resolution and canonical-match comparison initialization performs, so
      // a selection init will refuse never enters guidance; init then explains
      // the conflict itself.
      const eligible = await initializeExplicitWorkspaceSelection(
        home,
        requested,
        configured,
        configPath,
      );
      return await previewWorkspaceDestination(eligible.path);
    }
    // Mirror init's own no-argument branch selection: the configured Workspace
    // is revalidated (it selects nothing new; connecting-again semantics are
    // #607's).
    const destination = await resolveWorkspaceRoot(home, configured, configPath);
    return await previewWorkspaceDestination(destination.path);
  } catch {
    return undefined;
  }
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
    authoredPath: resolved.authored,
    folderCreated: false,
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
    authoredPath: requested,
    folderCreated: false,
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

async function initializeWorkspaceAt(
  home: string,
  authored: string,
  ensureConfiguration: boolean,
  allowMissingParents: boolean,
  fileSystem: LocalConfigurationFileSystem,
): Promise<InitializationResult> {
  const applicationRoot = applicationDirectory(home);
  const destination = await assertWorkspaceSelectionPath(home, authored);
  const { folderCreated, added } = await prepareWorkspaceDestination(destination, {
    fileSystem,
    allowMissingParents,
  });

  let configurationCreated = false;
  if (ensureConfiguration) {
    try {
      await mkdir(applicationRoot, { recursive: true });
      configurationCreated = await ensureLocalConfiguration(applicationRoot, authored, fileSystem);
    } catch (error) {
      // The folder transaction already wrote entries: the failure fact
      // reports exactly what was added (spec #593 DEC-003, #599).
      throw new InstallerToolError({
        kind: "init-partial-setup",
        path: destination,
        added: [...added],
        cause: errorMessage(error),
      });
    }
  }

  return {
    outcome: configurationCreated ? "created" : "unchanged",
    path: await realpath(destination),
    authoredPath: authored,
    folderCreated,
    warnings: [],
  };
}

async function initializeWithoutConfiguration(
  home: string,
  configPath: string,
  fileSystem: LocalConfigurationFileSystem,
  lockTimeoutMs: number,
  requested: string,
): Promise<InitializationResult> {
  // No default Workspace location exists (spec #593 #601, DEC-001): setup
  // never selects a location the user did not give, so zero-argument init
  // refuses before any side effect — including the application directories
  // and the Local Configuration lock file (ISC-23, ISC-25.1).
  const destination = await assertWorkspaceSelectionPath(home, requested);
  await requireProvisionableDestination(destination, false);
  // Refuse an invalid folder before any side effect at all — including the
  // application directories and the Local Configuration lock file (DEC-011,
  // #599). The transaction re-validates inside the lock.
  await validateWouldBeWorkspace(destination);
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
        return initializeWorkspaceAt(home, requested, true, false, fileSystem);
      }
      return undefined;
    },
  );
  return initialized ?? initializeWorkspace(home, { workspace: requested });
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
      // A legacy file with no authored `workspace` has no selection to
      // preserve; without a user-given path there is nothing to upgrade to
      // (spec #593 #601, DEC-011). The re-read under the lock may differ from
      // the outer check, so this gate lives at the ingestion of this source
      // (the branch-local refusal below).

      let selectedWorkspace: string;
      if (parsed.workspace === undefined) {
        // No authored selection to conflict-check: the user-given path is the
        // first connection, set up like any explicit destination and then
        // recorded (keeping the legacy Project Bindings).
        if (requestedWorkspace === undefined) {
          throw new InstallerToolError({ kind: "init-workspace-path-required" });
        }
        selectedWorkspace = requestedWorkspace;
      } else {
        selectedWorkspace = parsed.workspace;
        if (requestedWorkspace !== undefined) {
          await initializeExplicitWorkspaceSelection(
            home,
            requestedWorkspace,
            parsed.workspace,
            configPath,
          );
        }
      }
      const workspaceResult = parsed.workspace === undefined
        ? await initializeWorkspaceAt(home, selectedWorkspace, false, false, fileSystem)
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
        authoredPath: workspaceResult.authoredPath,
        folderCreated: workspaceResult.folderCreated,
        warnings: workspaceResult.warnings,
      };
    },
  );
}

export async function initializeWorkspace(
  home: string,
  options: InitializeWorkspaceOptions = {},
): Promise<InitializationResult> {
  const requested = options.workspace === undefined
    ? undefined
    : normalizeAuthoredWorkspace(options.workspace);
  const configPath = localConfigurationPath(home);
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  let source: string;
  try {
    source = await fileSystem.readFile(configPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      if (requested === undefined) {
        // Refuse before any side effect at all — the application directories,
        // the Workspace, and the Local Configuration lock file (spec #593
        // #601, DEC-001, ISC-23, ISC-25.1).
        throw new InstallerToolError({ kind: "init-workspace-path-required" });
      }
      return initializeWithoutConfiguration(
        home,
        configPath,
        fileSystem,
        lockTimeoutMs,
        requested,
      );
    }
    throw error;
  }

  const parsed = parseLocalConfiguration(source, configPath);
  if (parsed.schemaVersion === LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION) {
    if (requested === undefined && parsed.workspace === undefined) {
      // Fail fast before the configuration lock: a legacy file without a
      // `workspace` value is never upgraded to a default location (DEC-011).
      throw new InstallerToolError({ kind: "init-workspace-path-required" });
    }
    const migrated = await migrateLegacyConfiguration(
      home,
      configPath,
      fileSystem,
      lockTimeoutMs,
      requested,
    );
    return migrated ?? initializeWorkspace(home, requested === undefined ? {} : { workspace: requested });
  }
  const authoredWorkspace = requireCurrentApplicationConfiguration(parsed, configPath).workspace;
  if (requested !== undefined) {
    return initializeExplicitWorkspaceSelection(
      home,
      requested,
      authoredWorkspace,
      configPath,
    );
  }
  return initializeConfiguredWorkspace(home, authoredWorkspace, configPath);
}