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

/** Optional filesystem hooks used to prove snapshot checks and lock safety in tests. */
export interface LocalConfigurationFileSystem {
  readonly mkdir: typeof defaultMkdir;
  readonly readdir: typeof defaultReaddir;
  readonly readFile: typeof defaultReadFile;
  readonly rename: typeof defaultRename;
  readonly rm: typeof defaultRm;
  readonly stat: typeof defaultStat;
  readonly unlink: typeof defaultUnlink;
  readonly writeFile: typeof defaultWriteFile;
}

export const defaultFileSystem: LocalConfigurationFileSystem = {
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
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const HELD_PREFIX = ".config-held-";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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

export async function pathExists(
  fileSystem: LocalConfigurationFileSystem,
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

export async function hasHeldResidue(
  configurationPath: string,
  fileSystem: LocalConfigurationFileSystem,
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
export async function recoverHeldConfiguration(
  configurationPath: string,
  fileSystem: LocalConfigurationFileSystem,
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
 * An exclusive Local Configuration lock. Ownership is written in the same
 * exclusive create as the lock file (`writeFile` + `wx` with PID body) so
 * contenders never see an empty live lock as dead.
 */
export async function withConfigurationLock<T>(
  configurationPath: string,
  fileSystem: LocalConfigurationFileSystem,
  lockTimeoutMs: number,
  operation: string,
  body: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configurationPath}.lock`;
  const deadline = Date.now() + lockTimeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      await fileSystem.writeFile(lockPath, `${process.pid}\n`, { flag: "wx" });
      acquired = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      let stale = false;
      try {
        const [ownerRaw, stats] = await Promise.all([
          fileSystem.readFile(lockPath, "utf8"),
          fileSystem.stat(lockPath),
        ]);
        const owner = ownerRaw.trim();
        const ownerPid = Number.parseInt(owner, 10);
        const ageMs = Date.now() - stats.mtimeMs;
        stale = owner === "" || !Number.isFinite(ownerPid) || ownerPid <= 0
          ? ageMs >= lockTimeoutMs
          : !processIsAlive(ownerPid);
      } catch (lockError) {
        if (hasErrorCode(lockError, "ENOENT")) stale = true;
        else throw lockError;
      }
      if (stale) {
        await fileSystem.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Local Configuration ${configurationPath} is busy; another ${operation} holds the lock — retry`,
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
 */
export async function publishConfigurationReplacement(
  configurationPath: string,
  source: string,
  nextSource: string,
  mode: number,
  fileSystem: LocalConfigurationFileSystem,
  description: string,
  operation: string,
): Promise<void> {
  const directory = dirname(configurationPath);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporary = join(directory, `.config-${token}.tmp`);

  try {
    await fileSystem.writeFile(temporary, nextSource, { flag: "wx", mode });
    const stillCurrent = await fileSystem.readFile(configurationPath, "utf8");
    if (stillCurrent !== source) {
      throw new Error(
        `${description} changed before ${operation} publication; retry after the other edit completes`,
      );
    }
    await fileSystem.rename(temporary, configurationPath);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
