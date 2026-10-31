// One lock per apkit home: every command that writes holds it from its first
// read to its last write, so runs at the same time take turns (ADR-0058).
// Plain files only: no child processes and nothing that differs by platform.
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Owner {
  readonly pid: number;
  readonly token: string;
}

const WAIT_MS = 120_000;

async function readOwner(path: string): Promise<Owner | null> {
  try {
    const data = JSON.parse(await readFile(path, "utf8")) as Partial<Owner>;
    return typeof data.pid === "number" && typeof data.token === "string" ? { pid: data.pid, token: data.token } : null;
  } catch {
    return null;
  }
}

/** Signal 0 only checks that the process exists; EPERM means it runs as another user. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the lock in one step: the owner record is complete before the lock exists. Exported for tests. */
export async function tryTake(path: string, owner: Owner): Promise<boolean> {
  const temp = `${path}.${owner.token}.tmp`;
  await writeFile(temp, JSON.stringify(owner));
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/** The reclaim mark for one owner's lock. Exported for tests. */
export function reclaimMark(path: string, token: string): string {
  // The token comes from a file on disk: hash it, so it is always a plain file name.
  return `${path}.${createHash("sha256").update(token).digest("hex").slice(0, 16)}.reclaim`;
}

/**
 * Removes a lock whose owner stopped. Only the run that creates the stopped
 * owner's reclaim mark may delete a lock with that owner's token, and it checks
 * the token first: a live owner's lock is never moved or deleted. Exported for tests.
 */
export async function takeOver(path: string, stale: Owner, mine: string): Promise<void> {
  const mark = reclaimMark(path, stale.token);
  if (!(await tryTake(mark, { pid: process.pid, token: mine }))) return;
  try {
    if ((await readOwner(path))?.token === stale.token) await unlink(path).catch(() => undefined);
  } finally {
    await unlink(mark).catch(() => undefined);
  }
}

export async function withLock<T>(home: string, body: () => Promise<T>, waitMs = WAIT_MS): Promise<T> {
  await mkdir(home, { recursive: true });
  const path = join(home, "lock");
  const owner: Owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + waitMs;
  // Every pass that does not get the lock checks the deadline and backs off, even after
  // a takeover: a reclaim mark left by a stopped run makes takeovers return at once.
  while (!(await tryTake(path, owner))) {
    const holder = await readOwner(path);
    if (holder !== null && !isRunning(holder.pid)) await takeOver(path, holder, owner.token);
    if (Date.now() >= deadline) {
      const who = holder === null ? "" : ` (pid ${holder.pid})`;
      const mark = holder === null ? null : reclaimMark(path, holder.token);
      const stranded = mark !== null && (await readOwner(mark)) !== null ? ` and ${mark}` : "";
      throw new Error(`Another apkit-next run${who} is changing files. Try again when it ends. If no run is active, delete ${path}${stranded}.`);
    }
    await new Promise((done) => setTimeout(done, 25 + Math.random() * 75));
  }
  try {
    return await body();
  } finally {
    if ((await readOwner(path))?.token === owner.token) await unlink(path).catch(() => undefined);
  }
}
