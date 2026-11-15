// `apkit mirror <from> [folder]`: gives a folder a Mirrored Installation of a named folder
// (ADR-0062). It reads only the named folder, never the Workspace, and writes real copies of
// its installed files and the mirror record. No instruction file, no Repository Exclusion
// Contribution, and no Local Configuration entry: deleting the folder is the whole cleanup.
import { readFile, realpath, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import { recordInstall } from "./config.js";
import { syncGitExclude } from "./gitexclude.js";
import { findRepository } from "./gitindex.js";
import { abs, changesManifest, execute, plan, readManifest, readMirror, unresolved, type Decisions, type Manifest, type MirrorManifest } from "./install.js";
import { globalTarget, previousAt, trustNeeds, type Outcome, type TrustNeed } from "./location.js";
import { display, nextCommand } from "./output.js";
import type { Desired, DesiredFile } from "./render.js";

export interface MirrorRun {
  readonly outcome: Outcome;
  /** The agents that need the folder trusted; empty when nothing was written. */
  readonly trust: readonly TrustNeed[];
}

/** Mirrors `from`'s Profile Installation into `folder` (both real, absolute paths). */
export async function mirror(from: string, folder: string, decisions: Decisions): Promise<MirrorRun> {
  const { source, previous } = await sourceInstallation(from, folder);
  // The bytes on disk at each listed path, as they are (DEC-002). A listed file that is gone is not copied.
  const files = new Map<string, DesiredFile>();
  for (const path of Object.keys(source.files).sort()) {
    const full = abs(from, path);
    const info = await stat(full).catch(() => null);
    if (info === null || !info.isFile()) continue;
    files.set(path, { bytes: new Uint8Array(await readFile(full)), executable: (info.mode & 0o111) !== 0 });
  }
  // No Context: the plan writes no AGENTS.md or CLAUDE.md. A second run plans against the mirror's
  // own record, so it replaces and deletes only copies it wrote that nobody changed since. A Profile
  // Installation it replaces (a Decision, ISC-103) loses its Context Section and CLAUDE.md line only
  // where Git does not track the file.
  const desired: Desired = { profile: source.profile, agents: source.agents, files, context: null, contextIds: [] };
  // In the home folder, a file the User-Level Installation also owns is never deleted.
  const global = await globalTarget();
  const shared = new Set(Object.keys((folder === global.folder ? await previousAt(global) : null)?.files ?? {}));
  const planned = await plan(folder, desired, previous, { mirror: from, shared });
  const open = unresolved(planned, decisions);
  const base = { folder, mirror: from, profile: source.profile, agents: source.agents, instructions: planned.instructions };
  if (open.length > 0) return { outcome: { ...base, result: "needs-decision", issues: open }, trust: [] };
  if (previous !== null && planned.ops.length === 0 && !changesManifest(planned)) {
    return { outcome: { ...base, result: "unchanged" }, trust: trustNeeds(desired) };
  }
  await execute(planned);
  // Nothing of a Profile Installation it replaced is left: its exclusion block and Local Configuration entry go too.
  if (previous?.schema === 1) await recordInstall(folder, false, await syncGitExclude(folder, null));
  const deleted = planned.ops.flatMap((op) => (op.type === "delete" ? [op.path] : []));
  return {
    outcome: { ...base, result: "mirrored", changed: planned.ops.map((op) => op.path), ...(deleted.length === 0 ? {} : { deleted }) },
    trust: trustNeeds(desired),
  };
}

/**
 * Removes the Mirrored Installation in `folder`: its copies, its Installation Manifest, and the
 * folders it created when they end up empty. Like `mirror`, it touches no instruction file, no
 * exclude file, and no Local Configuration.
 */
export async function removeMirror(folder: string, record: MirrorManifest, decisions: Decisions): Promise<Outcome> {
  const planned = await plan(folder, null, record);
  const open = unresolved(planned, decisions);
  const base = { folder, mirror: record.mirror, profile: record.profile, agents: record.agents, instructions: planned.instructions };
  if (open.length > 0) return { ...base, result: "needs-decision", issues: open };
  await execute(planned);
  return { ...base, result: "removed", changed: planned.ops.map((op) => op.path) };
}

/**
 * The named folder's Profile Installation, and the folder's own record: its mirror of the same folder
 * when this is a second run, or a Profile Installation the mirror replaces after the user's Decision
 * (ISC-103), after the checks that keep a mirror from damaging an installation. A folder that mirrors
 * a different folder stops with an error and changes nothing. `folder == from` is refused before the
 * lock, in the CLI.
 */
async function sourceInstallation(from: string, folder: string): Promise<{ source: Manifest; previous: Manifest | MirrorManifest | null }> {
  const named = await readMirror(from);
  if (named !== null) {
    const original = display(named.mirror);
    throw new Error(
      `${display(from)} holds a Mirrored Installation of ${original}, not a Profile Installation. Mirror ${original} in its place. Nothing was changed.\n${nextCommand(["mirror", named.mirror, folder])}`,
    );
  }
  const source = await readManifest(from);
  if (source === null) throw new Error(`${display(from)} holds no Profile Installation to mirror. Nothing was changed.`);
  await checkPlace(from, folder);
  const mirrored = await readMirror(folder);
  if (mirrored !== null && mirrored.mirror !== from) {
    throw new Error(`${display(folder)} holds a Mirrored Installation of ${display(mirrored.mirror)}, not of ${display(from)}. Nothing was changed.`);
  }
  if (mirrored !== null) return { source, previous: mirrored };
  return { source, previous: await readManifest(folder) };
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
