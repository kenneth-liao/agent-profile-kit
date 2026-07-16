import {
  mkdir as defaultMkdir,
  readdir as defaultReaddir,
  readFile as defaultReadFile,
  rename as defaultRename,
  rm as defaultRm,
  stat as defaultStat,
  unlink as defaultUnlink,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

import { requireArtifactId } from "../schemas/dependencies.js";
import {
  isSupportedHost,
  SUPPORTED_HOSTS,
  type SupportedHost,
} from "../schemas/local-configuration.js";
import {
  ingestApplicationFromSource,
  localConfigurationPath,
  normalizeProject,
  requireExistingDirectory,
} from "./local-configuration.js";

/** Optional filesystem hooks used to prove snapshot checks and lock safety in tests. */
export interface BindProjectFileSystem {
  readonly mkdir: typeof defaultMkdir;
  readonly readdir: typeof defaultReaddir;
  readonly readFile: typeof defaultReadFile;
  readonly rename: typeof defaultRename;
  readonly rm: typeof defaultRm;
  readonly stat: typeof defaultStat;
  readonly unlink: typeof defaultUnlink;
  readonly writeFile: typeof defaultWriteFile;
}

const defaultFileSystem: BindProjectFileSystem = {
  mkdir: defaultMkdir,
  readdir: defaultReaddir,
  readFile: defaultReadFile,
  rename: defaultRename,
  rm: defaultRm,
  stat: defaultStat,
  unlink: defaultUnlink,
  writeFile: defaultWriteFile,
};

const LOCK_RETRY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const HELD_PREFIX = ".config-held-";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalizeHosts(hosts: readonly string[]): readonly SupportedHost[] {
  if (hosts.length === 0) {
    throw new Error(
      "bind requires at least one --host flag; supported Hosts: " +
        SUPPORTED_HOSTS.join(", "),
    );
  }
  const seen = new Set<SupportedHost>();
  for (const host of hosts) {
    if (!isSupportedHost(host)) {
      throw new Error(
        `unsupported Agent Host '${host}'; supported Hosts: ${SUPPORTED_HOSTS.join(", ")}`,
      );
    }
    seen.add(host);
  }
  // Canonical Host order matches Local Configuration ingestion.
  return SUPPORTED_HOSTS.filter((host) => seen.has(host));
}

function hostsEqual(
  left: readonly SupportedHost[],
  right: readonly SupportedHost[],
): boolean {
  return left.length === right.length && left.every((host, index) => host === right[index]);
}

/** Restore the source newline convention after YAML Document serialization (LF-only). */
export function preserveSourceNewlines(source: string, serialized: string): string {
  if (!source.includes("\r\n")) return serialized;
  return serialized.replace(/\r?\n/g, "\r\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(
  fileSystem: BindProjectFileSystem,
  path: string,
): Promise<boolean> {
  try {
    await fileSystem.stat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function hasHeldResidue(
  configurationPath: string,
  fileSystem: BindProjectFileSystem,
): Promise<boolean> {
  const directory = dirname(configurationPath);
  try {
    const names = await fileSystem.readdir(directory);
    return names.some((name) => name.startsWith(HELD_PREFIX));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * Restore the newest legacy claim-aside residue under exclusive lock ownership only.
 * Current publication never moves the canonical path aside; this recovers residue left
 * by older claim-aside builds or interrupted experiments.
 */
async function recoverHeldConfiguration(
  configurationPath: string,
  fileSystem: BindProjectFileSystem,
): Promise<boolean> {
  if (await pathExists(fileSystem, configurationPath)) return false;

  const directory = dirname(configurationPath);
  let names: string[];
  try {
    names = await fileSystem.readdir(directory);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }

  const heldNames = names.filter((name) => name.startsWith(HELD_PREFIX));
  if (heldNames.length === 0) return false;

  let newest: { readonly path: string; readonly mtimeMs: number } | undefined;
  for (const name of heldNames) {
    const path = join(directory, name);
    const stats = await fileSystem.stat(path);
    if (!newest || stats.mtimeMs > newest.mtimeMs) {
      newest = { path, mtimeMs: stats.mtimeMs };
    }
  }
  if (!newest) return false;

  await fileSystem.rename(newest.path, configurationPath);
  for (const name of heldNames) {
    const path = join(directory, name);
    if (path !== newest.path) {
      await fileSystem.unlink(path).catch(() => undefined);
    }
  }
  return true;
}

/**
 * A lock is stale only when ownership is safely proven abandoned:
 * - valid owner PID that is not alive, or
 * - empty/unparseable ownership whose mtime is older than the lock timeout
 *   (crashed during acquisition — never treat a fresh empty lock as free).
 */
async function lockIsSafelyStale(
  lockPath: string,
  fileSystem: BindProjectFileSystem,
  lockTimeoutMs: number,
): Promise<boolean> {
  try {
    const [ownerRaw, stats] = await Promise.all([
      fileSystem.readFile(lockPath, "utf8"),
      fileSystem.stat(lockPath),
    ]);
    const owner = ownerRaw.trim();
    const ownerPid = Number.parseInt(owner, 10);
    const ageMs = Date.now() - stats.mtimeMs;
    if (owner === "" || !Number.isFinite(ownerPid) || ownerPid <= 0) {
      return ageMs >= lockTimeoutMs;
    }
    return !processIsAlive(ownerPid);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

/**
 * Exclusive bind lock. Ownership is written in the same exclusive create as the
 * lock file (`writeFile` + `wx` with PID body) so contenders never see an empty
 * live lock as dead.
 */
async function withConfigurationLock<T>(
  configurationPath: string,
  fileSystem: BindProjectFileSystem,
  lockTimeoutMs: number,
  body: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configurationPath}.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      // Atomic create+own: PID is present as soon as the exclusive file exists.
      await fileSystem.writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
      acquired = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (await lockIsSafelyStale(lockPath, fileSystem, lockTimeoutMs)) {
        await fileSystem.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Local Configuration ${configurationPath} is busy; another bind holds the lock — retry`,
        );
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await body();
  } finally {
    await fileSystem.unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Publish nextSource without leaving the canonical path missing:
 * 1. Stage the replacement beside the live file.
 * 2. Re-read the live path and refuse if bytes differ from the validated snapshot.
 * 3. Atomically rename the stage onto the canonical path (POSIX replace never
 *    observes a missing destination — readers always see previous or next bytes).
 *
 * Cooperating binds are serialized by the exclusive lock. The byte re-check rejects
 * direct edits observed before publication. POSIX rename is not compare-and-swap, so
 * direct editors must not write concurrently with bind: an edit in the final
 * re-check-to-rename syscall window cannot be detected portably.
 */
async function publishConfigurationReplacement(
  configurationPath: string,
  source: string,
  nextSource: string,
  mode: number,
  fileSystem: BindProjectFileSystem,
  description: string,
): Promise<void> {
  const directory = dirname(configurationPath);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporary = join(directory, `.config-${token}.tmp`);

  await fileSystem.writeFile(temporary, nextSource, { flag: "wx", mode });
  try {
    const stillCurrent = await fileSystem.readFile(configurationPath, "utf8");
    if (stillCurrent !== source) {
      throw new Error(
        `${description} changed before bind publication; retry after the other edit completes`,
      );
    }
    // Atomic replace: destination stays continuously readable.
    await fileSystem.rename(temporary, configurationPath);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface BindProjectOptions {
  readonly home: string;
  readonly profile: string;
  /** Authored project path; omit to use cwd. */
  readonly project?: string;
  readonly hosts: readonly string[];
  /** Working directory used when project is omitted. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Test-only filesystem override for snapshot and publication proofs. */
  readonly fileSystem?: BindProjectFileSystem;
  /** Test-only lock wait/stale-empty timeout (ms). */
  readonly lockTimeoutMs?: number;
}

export interface BindProjectResult {
  readonly outcome: "created" | "unchanged";
  readonly configurationPath: string;
  readonly project: string;
  readonly canonicalProject: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
}

/**
 * Append one Project Binding to Local Configuration without reconciling output.
 * Local Configuration remains the sole canonical home; this is a validated edit.
 */
export async function bindProject(
  options: BindProjectOptions,
): Promise<BindProjectResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const configurationPath = localConfigurationPath(options.home);
  const profile = requireArtifactId(options.profile, "bind profile");
  const hosts = normalizeHosts(options.hosts);
  const cwd = options.cwd ?? process.cwd();

  const description = `Local Configuration ${configurationPath}`;
  let canonicalProject: string;
  if (options.project === undefined) {
    canonicalProject = await requireExistingDirectory(
      cwd,
      cwd,
      description,
      "project",
    );
  } else {
    canonicalProject = await normalizeProject(
      options.project,
      options.home,
      description,
    );
  }

  // Prefer absolute canonical root for cwd bindings; preserve authored spelling otherwise.
  const storedProject =
    options.project === undefined ? canonicalProject : options.project;

  // Friendly missing-config diagnostic before lock acquisition (avoids raw ENOENT on .lock).
  // Do not restore held residue here — recovery requires exclusive lock ownership so it
  // cannot interfere with another live bind transaction.
  if (!(await pathExists(fileSystem, configurationPath))) {
    if (!(await hasHeldResidue(configurationPath, fileSystem))) {
      throw new Error(
        `Local Configuration is missing at ${configurationPath}; run agent-profile-kit init`,
      );
    }
  }

  return withConfigurationLock(
    configurationPath,
    fileSystem,
    lockTimeoutMs,
    async () => {
      // Legacy claim-aside residue is restored only under proven exclusive ownership.
      await recoverHeldConfiguration(configurationPath, fileSystem);

      let source: string;
      try {
        source = await fileSystem.readFile(configurationPath, "utf8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          throw new Error(
            `Local Configuration is missing at ${configurationPath}; run agent-profile-kit init`,
          );
        }
        throw error;
      }

      // Exact snapshot being edited is the sole input to the trusted semantic boundary.
      const { configuration, workspace } = await ingestApplicationFromSource(
        options.home,
        source,
        configurationPath,
      );
      if (!workspace.profiles.has(profile)) {
        throw new Error(
          `${description} profile '${profile}' does not exist in Workspace ${workspace.path}`,
        );
      }

      const existing = configuration.bindings.find(
        (binding) => binding.canonicalProject === canonicalProject,
      );
      if (existing) {
        if (existing.profile === profile && hostsEqual(existing.hosts, hosts)) {
          return {
            outcome: "unchanged" as const,
            configurationPath,
            project: existing.project,
            canonicalProject,
            profile,
            hosts,
          };
        }
        throw new Error(
          `${description} already binds canonical project '${canonicalProject}' to profile '${existing.profile}' hosts [${existing.hosts.join(", ")}]; replace is not supported by bind`,
        );
      }

      const document = parseDocument(source);
      const bindingsNode = document.get("bindings");
      if (!isSeq(bindingsNode)) {
        throw new Error(`${description} bindings must be an array`);
      }
      // Prefer block style when starting from an empty flow sequence (init default).
      if (bindingsNode.items.length === 0) {
        bindingsNode.flow = false;
      }

      const entry = document.createNode({
        project: storedProject,
        profile,
        hosts: [...hosts],
      });
      if (isMap(entry)) {
        entry.flow = false;
        const hostsNode = entry.get("hosts");
        if (isSeq(hostsNode)) hostsNode.flow = false;
      }
      bindingsNode.add(entry);

      const nextSource = preserveSourceNewlines(source, document.toString());
      const sourceStats = await fileSystem.stat(configurationPath);
      const mode = sourceStats.mode & 0o777;

      await publishConfigurationReplacement(
        configurationPath,
        source,
        nextSource,
        mode,
        fileSystem,
        description,
      );

      return {
        outcome: "created" as const,
        configurationPath,
        project: storedProject,
        canonicalProject,
        profile,
        hosts,
      };
    },
  );
}
