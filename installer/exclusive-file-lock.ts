import { open as defaultOpen, mkdir as defaultMkdir, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_RETRY_MS = 20;
export const DEFAULT_EXCLUSIVE_FILE_LOCK_TIMEOUT_MS = 5_000;

/**
 * Darwin open(2) flags. Node does not export O_EXLOCK on fs.constants, but the
 * kernel honors it when passed through open(2). This package is darwin-only.
 * @see man 2 open — O_EXLOCK atomically obtains an exclusive lock on open.
 */
const DARWIN_O_RDWR = 0x0002;
const DARWIN_O_NONBLOCK = 0x0004;
const DARWIN_O_CREAT = 0x0200;
const DARWIN_O_EXLOCK = 0x0020;

export interface ExclusiveFileLockHandle {
  readonly close: () => Promise<void>;
}

export interface ExclusiveFileLockFileSystem {
  readonly mkdir: typeof defaultMkdir;
  /**
   * Open/create the lock path with an exclusive kernel lock, non-blocking.
   * Must reject with EAGAIN/EWOULDBLOCK when another holder exists.
   */
  readonly openExclusiveLock: (path: string) => Promise<ExclusiveFileLockHandle>;
}

export async function defaultOpenExclusiveLock(path: string): Promise<ExclusiveFileLockHandle> {
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

const defaultFileSystem: ExclusiveFileLockFileSystem = {
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

export interface ExclusiveFileLockOptions<T> {
  /** Absolute path of the lock file; its parent directory is created if needed. */
  readonly lockPath: string;
  /** The exclusive critical section. */
  readonly body: () => Promise<T>;
  /**
   * The error to raise when the lock stays busy through the deadline. The
   * caller owns the error's domain meaning; this primitive owns only the wait.
   */
  readonly busyError: () => Error;
  readonly fileSystem?: Partial<ExclusiveFileLockFileSystem>;
  readonly lockTimeoutMs?: number;
}

/**
 * Serialize one read-modify-publish critical section behind an exclusive kernel
 * lock. Uses Darwin `O_EXLOCK` so the exclusive lock is bound to an open file
 * descriptor (kernel identity), not a pathname TOCTOU protocol. Process exit
 * releases the lock automatically; there is no stale-file reclaim race.
 * Concurrent holders wait and retry until the caller's busy error is raised.
 */
export async function withExclusiveFileLock<T>(
  options: ExclusiveFileLockOptions<T>,
): Promise<T> {
  const fileSystem: ExclusiveFileLockFileSystem = {
    ...defaultFileSystem,
    ...options.fileSystem,
  };
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_EXCLUSIVE_FILE_LOCK_TIMEOUT_MS;
  await fileSystem.mkdir(dirname(options.lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;

  let handle: ExclusiveFileLockHandle | undefined;
  while (handle === undefined) {
    try {
      handle = await fileSystem.openExclusiveLock(options.lockPath);
    } catch (error) {
      if (!isLockBusyError(error)) throw error;
      if (Date.now() >= deadline) throw options.busyError();
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await options.body();
  } finally {
    await handle.close();
  }
}
