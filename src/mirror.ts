// `apkit mirror <from> [folder]`: gives a folder a Mirrored Installation of a named folder
// (ADR-0062). It reads only the named folder, never the Workspace, and writes real copies of
// its installed files and the mirror record. No instruction file, no Repository Exclusion
// Contribution, and no Local Configuration entry: deleting the folder is the whole cleanup.
import { readFile, realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { findRepository } from "./gitindex.js";
import { abs, execute, plan, readManifest, readMirror, unresolved, type Decisions, type Manifest } from "./install.js";
import { trustNeeds, type Outcome, type TrustNeed } from "./location.js";
import { display, nextCommand } from "./output.js";
import type { Desired, DesiredFile } from "./render.js";

export interface MirrorRun {
  readonly outcome: Outcome;
  /** The agents that need the folder trusted; empty when nothing was written. */
  readonly trust: readonly TrustNeed[];
}

/** Mirrors `from`'s Profile Installation into `folder` (both real, absolute paths). */
export async function mirror(from: string, folder: string, decisions: Decisions): Promise<MirrorRun> {
  const source = await sourceInstallation(from, folder);
  // The bytes on disk at each listed path, as they are (DEC-002). A listed file that is gone is not copied.
  const files = new Map<string, DesiredFile>();
  for (const path of Object.keys(source.files).sort()) {
    const full = abs(from, path);
    const info = await stat(full).catch(() => null);
    if (info === null || !info.isFile()) continue;
    files.set(path, { bytes: new Uint8Array(await readFile(full)), executable: (info.mode & 0o111) !== 0 });
  }
  // No Context, and no earlier record: the plan touches no AGENTS.md or CLAUDE.md.
  const desired: Desired = { profile: source.profile, agents: source.agents, files, context: null, contextIds: [] };
  const planned = await plan(folder, desired, null, { mirror: from });
  const open = unresolved(planned, decisions);
  const base = { folder, mirror: from, profile: source.profile, agents: source.agents, instructions: planned.instructions };
  if (open.length > 0) return { outcome: { ...base, result: "needs-decision", issues: open }, trust: [] };
  await execute(planned);
  return { outcome: { ...base, result: "mirrored", changed: planned.ops.map((op) => op.path) }, trust: trustNeeds(desired) };
}

/**
 * The named folder's Profile Installation, after the checks that keep a mirror from damaging an
 * installation. `folder == from` is refused before the lock, in the CLI. Interim: #805 owns a second
 * mirror into the same folder, and #806 a mirror into a Profile Installation.
 * Each stops with an error and changes nothing.
 */
async function sourceInstallation(from: string, folder: string): Promise<Manifest> {
  const mirrored = await readMirror(from);
  if (mirrored !== null) {
    const original = display(mirrored.mirror);
    throw new Error(
      `${display(from)} holds a Mirrored Installation of ${original}, not a Profile Installation. Mirror ${original} in its place. Nothing was changed.\n${nextCommand(["mirror", mirrored.mirror, folder])}`,
    );
  }
  const source = await readManifest(from);
  if (source === null) throw new Error(`${display(from)} holds no Profile Installation to mirror. Nothing was changed.`);
  await checkPlace(from, folder);
  const existing = await readMirror(folder);
  if (existing !== null) {
    throw new Error(`${display(folder)} already holds a Mirrored Installation of ${display(existing.mirror)}. Nothing was changed.`);
  }
  const installed = await readManifest(folder);
  if (installed !== null) {
    throw new Error(`${display(folder)} already holds a Profile Installation of '${installed.profile}'. Nothing was changed.`);
  }
  return source;
}

/**
 * Refuses a folder in a Git repository where `from`'s Repository Exclusion Contribution does not cover
 * the copies (DEC-004): another repository, or another path from the root of its worktree. A folder
 * outside any repository is served. Reads Git's files only, as `findRepository` does.
 */
async function checkPlace(from: string, folder: string): Promise<void> {
  const target = await findRepository(folder);
  if (target === null) return;
  const source = await findRepository(from);
  if (source === null) {
    throw new Error(
      `${display(folder)} is in a Git repository and ${display(from)} is in none, so no Repository Exclusion Contribution covers the copies. A mirror of ${display(from)} goes into a folder outside any Git repository. Nothing was changed.`,
    );
  }
  const covers = `so ${display(from)}'s Repository Exclusion Contribution does not cover the copies.`;
  const served = `A mirror goes into a folder outside any Git repository, or into a linked worktree of ${display(from)}'s repository at the same path from the worktree root. Nothing was changed.`;
  const real = (path: string) => realpath(path).catch(() => path);
  if ((await real(target.commonDir)) !== (await real(source.commonDir))) {
    throw new Error(`${display(folder)} is in another Git repository than ${display(from)}, ${covers} ${served}`);
  }
  const at = (root: string, path: string) => relative(root, path).split(sep).join("/");
  const [here, there] = [at(target.root, folder), at(source.root, from)];
  if (here !== there) {
    const where = (path: string) => (path === "" ? "the root" : path);
    throw new Error(`${display(folder)} is at ${where(here)} from the root of its worktree, and ${display(from)} at ${where(there)}, ${covers} ${served}`);
  }
}
