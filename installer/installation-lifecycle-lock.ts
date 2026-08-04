import {
  mkdir as defaultMkdir,
  unlink as defaultUnlink,
  writeFile as defaultWriteFile,
  readFile as defaultReadFile,
  stat as defaultStat,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { stateDirectory } from "./local-configuration.js";

const LOCK_RETRY_MS = 20;
export const DEFAULT_INSTALLATION_LIFECYCLE_LOCK_TIMEOUT_MS = 5_000;

export interface InstallationLifecycleLockFileSystem {
  readonly mkdir: typeof defaultMkdir;
  readonly readFile: typeof defaultReadFile;
  readonly stat: typeof defaultStat;
  readonly unlink: typeof defaultUnlink;
  readonly writeFile: typeof defaultWriteFile;
}

const defaultFileSystem: InstallationLifecycleLockFileSystem = {
  mkdir: defaultMkdir,
  readFile: defaultReadFile,
  stat: defaultStat,
  unlink: defaultUnlink,
  writeFile: defaultWriteFile,
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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

/**
 * Absolute path of the exclusive Installation State lifecycle lock.
 * Lives beside the state directory (not inside it) so test and recovery seams
 * that make `state/` temporarily unwritable still serialize publication.
 */
export function installationLifecycleLockPath(home: string): string {
  return join(dirname(stateDirectory(home)), "lifecycle.lock");
}

/**
 * Serialize Installer operations that publish Installation State, project
 * outputs, or Repository Exclusion ownership so concurrent persistent and
 * temporary commands cannot interleave conflicting writes.
 */
export async function withInstallationLifecycleLock<T>(
  home: string,
  operation: string,
  body: () => Promise<T>,
  options: {
    readonly fileSystem?: Partial<InstallationLifecycleLockFileSystem>;
    readonly lockTimeoutMs?: number;
  } = {},
): Promise<T> {
  const fileSystem: InstallationLifecycleLockFileSystem = {
    ...defaultFileSystem,
    ...options.fileSystem,
  };
  const lockTimeoutMs =
    options.lockTimeoutMs ?? DEFAULT_INSTALLATION_LIFECYCLE_LOCK_TIMEOUT_MS;
  const lockPath = installationLifecycleLockPath(home);
  await fileSystem.mkdir(dirname(lockPath), { recursive: true });
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
          `Installation lifecycle is busy; another ${operation} holds the lock — retry`,
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
