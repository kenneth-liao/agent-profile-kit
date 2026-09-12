import { dirname, join } from "node:path";

import { stateDirectory } from "./local-configuration.js";
import { InstallerToolError } from "./tool-errors.js";
import {
  DEFAULT_EXCLUSIVE_FILE_LOCK_TIMEOUT_MS,
  withExclusiveFileLock,
  type ExclusiveFileLockFileSystem,
  type ExclusiveFileLockHandle,
} from "./exclusive-file-lock.js";

export const DEFAULT_INSTALLATION_LIFECYCLE_LOCK_TIMEOUT_MS =
  DEFAULT_EXCLUSIVE_FILE_LOCK_TIMEOUT_MS;

/** The kernel-lock types are re-exported so lifecycle callers keep one import. */
export type LifecycleLockHandle = ExclusiveFileLockHandle;
export type InstallationLifecycleLockFileSystem = ExclusiveFileLockFileSystem;

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
 * temporary commands cannot interleave conflicting writes. The wait and
 * exclusivity belong to the shared file-lock primitive; this wrapper owns the
 * lifecycle domain meaning of a busy lock.
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
  return withExclusiveFileLock({
    lockPath: installationLifecycleLockPath(home),
    body,
    busyError: () =>
      new InstallerToolError({
        kind: "lifecycle-lock-busy",
        operation,
      }),
    ...(options.fileSystem === undefined ? {} : { fileSystem: options.fileSystem }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
  });
}
