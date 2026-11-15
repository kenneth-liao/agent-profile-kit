// `apkit mirror <from> [folder]`: gives a folder a Mirrored Installation of a named folder
// (ADR-0062). It reads only the named folder, never the Workspace, and writes real copies of
// its installed files and the mirror record. No instruction file, no Repository Exclusion
// Contribution, and no Local Configuration entry: deleting the folder is the whole cleanup.
import { readFile, stat } from "node:fs/promises";
import { recordInstall } from "./config.js";
import { syncGitExclude } from "./gitexclude.js";
import { abs, execute, plan, readManifest, readMirror, unresolved, type Decisions, type Manifest } from "./install.js";
import { globalTarget, previousAt, trustNeeds, type Outcome, type TrustNeed } from "./location.js";
import { display } from "./output.js";
import type { Desired, DesiredFile } from "./render.js";

export interface MirrorRun {
  readonly outcome: Outcome;
  /** The agents that need the folder trusted; empty when nothing was written. */
  readonly trust: readonly TrustNeed[];
}

/** Mirrors `from`'s Profile Installation into `folder` (both real, absolute paths). */
export async function mirror(from: string, folder: string, decisions: Decisions): Promise<MirrorRun> {
  const { source, installed } = await sourceInstallation(from, folder);
  // The bytes on disk at each listed path, as they are (DEC-002). A listed file that is gone is not copied.
  const files = new Map<string, DesiredFile>();
  for (const path of Object.keys(source.files).sort()) {
    const full = abs(from, path);
    const info = await stat(full).catch(() => null);
    if (info === null || !info.isFile()) continue;
    files.set(path, { bytes: new Uint8Array(await readFile(full)), executable: (info.mode & 0o111) !== 0 });
  }
  // No Context: the plan writes no AGENTS.md or CLAUDE.md. A Profile Installation it replaces (a Decision,
  // ISC-103) loses its Context Section and CLAUDE.md line only where Git does not track the file.
  const desired: Desired = { profile: source.profile, agents: source.agents, files, context: null, contextIds: [] };
  // In the home folder, a file the User-Level Installation also owns is never deleted.
  const global = await globalTarget();
  const shared = new Set(Object.keys((folder === global.folder ? await previousAt(global) : null)?.files ?? {}));
  const planned = await plan(folder, desired, installed, { mirror: from, shared });
  const open = unresolved(planned, decisions);
  const base = { folder, mirror: from, profile: source.profile, agents: source.agents, instructions: planned.instructions };
  if (open.length > 0) return { outcome: { ...base, result: "needs-decision", issues: open }, trust: [] };
  await execute(planned);
  // Nothing of the Profile Installation is left: its exclusion block and its Local Configuration entry go too.
  if (installed !== null) await recordInstall(folder, false, await syncGitExclude(folder, null));
  return { outcome: { ...base, result: "mirrored", changed: planned.ops.map((op) => op.path) }, trust: trustNeeds(desired) };
}

/**
 * The named folder's Profile Installation, and the Profile Installation in `folder` that the mirror
 * replaces after the user's Decision (ISC-103), after the checks that keep a mirror from damaging an
 * installation. Interim: #803 owns the refusals for the named folder and for `folder == from`, and
 * #805 a second mirror into the same folder. Each stops with an error and changes nothing.
 */
async function sourceInstallation(from: string, folder: string): Promise<{ source: Manifest; installed: Manifest | null }> {
  // A named folder that holds a mirror throws MirroredInstallationError here.
  const source = await readManifest(from);
  if (source === null) throw new Error(`${display(from)} holds no Profile Installation to mirror. Nothing was changed.`);
  const mirrored = await readMirror(folder);
  if (mirrored !== null) {
    throw new Error(`${display(folder)} already holds a Mirrored Installation of ${display(mirrored.mirror)}. Nothing was changed.`);
  }
  const installed = await readManifest(folder);
  if (installed !== null && folder === from) {
    throw new Error(`${display(folder)} already holds a Profile Installation of '${installed.profile}'. Nothing was changed.`);
  }
  return { source, installed };
}
