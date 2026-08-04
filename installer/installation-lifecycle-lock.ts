import { open as defaultOpen, type FileHandle } from "node:fs/promises";
import { mkdir as defaultMkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { stateDirectory } from "./local-configuration.js";

const LOCK_RETRY_MS = 20;
export const DEFAULT_INSTALLATION_LIFECYCLE_LOCK_TIMEOUT_MS = 5_000;

/**
 * Darwin open(2) flags. Node does not export O_EXLOCK on fs.constants, but the
 * kernel honors it when passed through open(2). This package is darwin-only.
 * @see man 2 open — O_EXLOCK atomically obtains an exclusive lock on open.
 */
const DARWIN_O_RDWR = 0x0002;
const DARWIN_O_NONBLOCK = 0x0004;
const DARWIN_O_CREAT = 0x0200;
const DARWIN_O_EXLOCK = 0x0020;

export interface LifecycleLockHandle {
  readonly close: () => Promise<void>;
}

export interface InstallationLifecycleLockFileSystem {
  readonly mkdir: typeof defaultMkdir;
  /**
   * Open/create the lock path with an exclusive kernel lock, non-blocking.
   * Must reject with EAGAIN/EWOULDBLOCK when another holder exists.
   */
  readonly openExclusiveLock: (path: string) => Promise<LifecycleLockHandle>;
}

async function defaultOpenExclusiveLock(path: string): Promise<LifecycleLockHandle> {
  const handle: FileHandle = await defaultOpen(
    path,
    DARWIN_O_CREAT | DARWIN_O_RDWR | DARWIN_O_EXLOCK | DARWIN_O_NONBLOCK,
    0o600,
  );
  return {
    close: async () => {
      await handle.close();
    },
  };
}

const defaultFileSystem: InstallationLifecycleLockFileSystem = {
  mkdir: defaultMkdir,
  openExclusiveLock: defaultOpenExclusiveLock,
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isLockBusyError(error: unknown): boolean {
  return hasErrorCode(error, "EAGAIN") || hasErrorCode(error, "EWOULDBLOCK");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 *
 * Uses Darwin `O_EXLOCK` so the exclusive lock is bound to an open file
 * descriptor (kernel identity), not a pathname TOCTOU protocol. Process exit
 * releases the lock automatically; there is no stale-file reclaim race.
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

  let handle: LifecycleLockHandle | undefined;
  while (handle === undefined) {
    try {
      handle = await fileSystem.openExclusiveLock(lockPath);
    } catch (error) {
      if (!isLockBusyError(error)) throw error;
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
    await handle.close();
  }
}
