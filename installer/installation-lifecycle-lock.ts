import {
  mkdir as defaultMkdir,
  readFile as defaultReadFile,
  rename as defaultRename,
  stat as defaultStat,
  unlink as defaultUnlink,
  writeFile as defaultWriteFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { stateDirectory } from "./local-configuration.js";

const LOCK_RETRY_MS = 20;
export const DEFAULT_INSTALLATION_LIFECYCLE_LOCK_TIMEOUT_MS = 5_000;

export interface InstallationLifecycleLockFileSystem {
  readonly mkdir: typeof defaultMkdir;
  readonly readFile: typeof defaultReadFile;
  readonly rename: typeof defaultRename;
  readonly stat: typeof defaultStat;
  readonly unlink: typeof defaultUnlink;
  readonly writeFile: typeof defaultWriteFile;
}

const defaultFileSystem: InstallationLifecycleLockFileSystem = {
  mkdir: defaultMkdir,
  readFile: defaultReadFile,
  rename: defaultRename,
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

/** Unique lock body: owner PID plus opaque token for ownership-safe release. */
export function formatLifecycleLockBody(pid: number, token: string): string {
  return `${pid}\n${token}\n`;
}

function parseLifecycleLockBody(raw: string): {
  readonly pid: number | undefined;
  readonly token: string | undefined;
} {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return { pid: undefined, token: undefined };
  const pid = Number.parseInt(lines[0]!, 10);
  return {
    pid: Number.isFinite(pid) ? pid : undefined,
    token: lines[1],
  };
}

function isStaleLockBody(
  raw: string,
  ageMs: number,
  lockTimeoutMs: number,
): boolean {
  const { pid } = parseLifecycleLockBody(raw);
  if (pid === undefined || pid <= 0) return ageMs >= lockTimeoutMs;
  return !processIsAlive(pid);
}

/**
 * Serialize Installer operations that publish Installation State, project
 * outputs, or Repository Exclusion ownership so concurrent persistent and
 * temporary commands cannot interleave conflicting writes.
 *
 * Stale takeover renames the observed lock path to a contender-unique quarantine
 * before deletion so two waiters cannot both unlink a live lock. Release unlinks
 * only when the live lock body still matches this contender's unique token.
 */
export async function withInstallationLifecycleLock<T>(
  home: string,
  operation: string,
  body: () => Promise<T>,
  options: {
    readonly fileSystem?: Partial<InstallationLifecycleLockFileSystem>;
    readonly lockTimeoutMs?: number;
    readonly ownerPid?: number;
  } = {},
): Promise<T> {
  const fileSystem: InstallationLifecycleLockFileSystem = {
    ...defaultFileSystem,
    ...options.fileSystem,
  };
  const lockTimeoutMs =
    options.lockTimeoutMs ?? DEFAULT_INSTALLATION_LIFECYCLE_LOCK_TIMEOUT_MS;
  const ownerPid = options.ownerPid ?? process.pid;
  const ownerToken = randomUUID();
  const lockBody = formatLifecycleLockBody(ownerPid, ownerToken);
  const lockPath = installationLifecycleLockPath(home);
  await fileSystem.mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + lockTimeoutMs;
  let acquired = false;

  while (!acquired) {
    try {
      await fileSystem.writeFile(lockPath, lockBody, { flag: "wx" });
      acquired = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      let observedRaw: string | undefined;
      let observedAgeMs = 0;
      try {
        const [ownerRaw, stats] = await Promise.all([
          fileSystem.readFile(lockPath, "utf8"),
          fileSystem.stat(lockPath),
        ]);
        observedRaw = ownerRaw;
        observedAgeMs = Date.now() - stats.mtimeMs;
      } catch (lockError) {
        if (hasErrorCode(lockError, "ENOENT")) {
          // Lost the race to another contender's reclaim or release; retry create.
          continue;
        }
        throw lockError;
      }
      if (!isStaleLockBody(observedRaw, observedAgeMs, lockTimeoutMs)) {
        if (Date.now() >= deadline) {
          throw new Error(
            `Installation lifecycle is busy; another ${operation} holds the lock — retry`,
          );
        }
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      // Ownership-safe stale reclaim: atomically move the observed path to a
      // contender-unique quarantine. Only the rename winner may delete it.
      const quarantine = `${lockPath}.claim-${ownerPid}-${randomUUID()}`;
      try {
        await fileSystem.rename(lockPath, quarantine);
      } catch (renameError) {
        if (hasErrorCode(renameError, "ENOENT")) continue;
        throw renameError;
      }
      try {
        const quarantined = await fileSystem.readFile(quarantine, "utf8");
        // Another contender could only win by renaming first; if we hold a
        // non-stale body here the original inspection was racy with a live
        // owner that died mid-hold — still reclaimable. If somehow a live
        // owner body appears, put it back.
        let quarantinedAgeMs = observedAgeMs;
        try {
          const stats = await fileSystem.stat(quarantine);
          quarantinedAgeMs = Date.now() - stats.mtimeMs;
        } catch {
          // Use the pre-rename observation when quarantine stat races.
        }
        if (!isStaleLockBody(quarantined, quarantinedAgeMs, lockTimeoutMs)) {
          try {
            await fileSystem.rename(quarantine, lockPath);
          } catch {
            // If the path is occupied again, drop the quarantine residue.
            await fileSystem.unlink(quarantine).catch(() => undefined);
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Installation lifecycle is busy; another ${operation} holds the lock — retry`,
            );
          }
          await sleep(LOCK_RETRY_MS);
          continue;
        }
        await fileSystem.unlink(quarantine).catch(() => undefined);
      } catch (claimError) {
        await fileSystem.unlink(quarantine).catch(() => undefined);
        throw claimError;
      }
    }
  }

  try {
    return await body();
  } finally {
    // Release only our uniquely owned token — never unlink a successor's lock.
    try {
      const current = await fileSystem.readFile(lockPath, "utf8");
      if (current === lockBody) {
        await fileSystem.unlink(lockPath);
      }
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        // Best-effort release; prefer not masking the caller's result.
      }
    }
  }
}
