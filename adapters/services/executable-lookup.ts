import { constants } from "node:fs";
import { stat, access } from "node:fs/promises";
import { join } from "node:path";

/**
 * Bound for one complete `PATH` lookup, matching the historical Adapter
 * probe budget (ADR-0016): a `PATH` entry on a stalled filesystem can hold
 * a stat indefinitely, so the lookup fails closed when its budget is
 * exhausted instead of blocking the detecting command forever.
 */
const LOOKUP_TIMEOUT_MS = 10_000;

async function candidateExecutableResolves(
  candidate: string,
  remainingMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), remainingMs);
    timer.unref?.();
  });
  const probed = (async () => {
    try {
      // stat follows symlinks (Homebrew, npm, pip shims) and isFile()
      // rejects directories, which carry the execute bit for traversal.
      if (!(await stat(candidate)).isFile()) return false;
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Absent, unreadable, or not executable here; keep searching.
      return false;
    }
  })();
  try {
    return (await Promise.race([probed, expired])) === true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report whether one executable name resolves on `PATH` — the read-only
 * presence check behind Host detection (spec #593, US-009, DEC-012). The
 * lookup never spawns the executable and never writes: it only stats
 * candidate paths. Completion is bounded at {@link LOOKUP_TIMEOUT_MS} for
 * the whole search; a stalled `PATH` entry degrades the lookup to
 * not-found instead of hanging the detecting command. Empty `PATH` entries
 * are skipped so a same-named file in the working directory can never
 * satisfy detection. The optional environment overrides the ambient one,
 * matching the bounded executor's `environment` contract.
 */
export async function executableOnPath(
  executable: string,
  env?: NodeJS.ProcessEnv,
  options: { readonly timeoutMs?: number } = {},
): Promise<boolean> {
  // An override environment is the whole search space: only a completely
  // absent environment falls back to the ambient one, matching the bounded
  // executor's `environment` contract (spawn semantics omit unset keys).
  const searchPath = (env === undefined ? process.env.PATH : env.PATH) ?? "";
  const deadline = Date.now() + (options.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  for (const directory of searchPath.split(":")) {
    if (directory === "") continue;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    if (await candidateExecutableResolves(join(directory, executable), remainingMs)) {
      return true;
    }
  }
  return false;
}

/**
 * The one `CompleteHostAdapter.detectHost` implementation shared by every
 * Adapter whose detection is the `PATH` presence check (spec #593, US-009,
 * DEC-012): the Host's executable name is the only Adapter-specific input.
 * Detection never starts the Host CLI and never writes; version and
 * capability evidence stays in lifecycle capability probing.
 */
export function detectHostByPresence(
  executable: string,
): (options?: { readonly env?: NodeJS.ProcessEnv }) => Promise<boolean> {
  return (options = {}) => executableOnPath(executable, options.env);
}