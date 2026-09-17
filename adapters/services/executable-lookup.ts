import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Report whether one executable name resolves on `PATH` — the read-only
 * presence check behind Host detection (spec #593, US-009, DEC-012). The
 * lookup never spawns the executable and never writes: it only stats
 * candidate paths. Empty `PATH` entries are skipped so a same-named file in
 * the working directory can never satisfy detection. The optional
 * environment overrides the ambient one, matching the bounded executor's
 * `environment` contract.
 */
export function executableOnPath(
  executable: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  // An override environment is the whole search space: only a completely
  // absent environment falls back to the ambient one, matching the bounded
  // executor's `environment` contract (spawn semantics omit unset keys).
  const searchPath = (env === undefined ? process.env.PATH : env.PATH) ?? "";
  for (const directory of searchPath.split(":")) {
    if (directory === "") continue;
    try {
      // statSync follows symlinks (Homebrew, npm, pip shims) and isFile()
      // rejects directories, which carry the execute bit for traversal.
      if (!statSync(join(directory, executable)).isFile()) continue;
      accessSync(join(directory, executable), constants.X_OK);
      return true;
    } catch {
      // Absent, unreadable, or not executable here; keep searching.
    }
  }
  return false;
}