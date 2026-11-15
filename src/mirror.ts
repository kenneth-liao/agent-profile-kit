// `apkit mirror <from> [folder]`: gives a folder a Mirrored Installation of a named folder
// (ADR-0062). It reads only the named folder, never the Workspace, and writes real copies of
// its installed files and the mirror record. No instruction file, no Repository Exclusion
// Contribution, and no Local Configuration entry: deleting the folder is the whole cleanup.
import { readFile, stat } from "node:fs/promises";
import { abs, changesManifest, execute, plan, readManifest, readMirror, unresolved, type Decisions, type Manifest, type MirrorManifest } from "./install.js";
import { trustNeeds, type Outcome, type TrustNeed } from "./location.js";
import { display } from "./output.js";
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
  // No Context: the plan touches no AGENTS.md or CLAUDE.md. A second run plans against the mirror's
  // own record, so it replaces and deletes only copies it wrote that nobody changed since.
  const desired: Desired = { profile: source.profile, agents: source.agents, files, context: null, contextIds: [] };
  const planned = await plan(folder, desired, previous, { mirror: from });
  const open = unresolved(planned, decisions);
  const base = { folder, mirror: from, profile: source.profile, agents: source.agents, instructions: planned.instructions };
  if (open.length > 0) return { outcome: { ...base, result: "needs-decision", issues: open }, trust: [] };
  if (previous !== null && planned.ops.length === 0 && !changesManifest(planned)) {
    return { outcome: { ...base, result: "unchanged" }, trust: trustNeeds(desired) };
  }
  await execute(planned);
  const deleted = planned.ops.flatMap((op) => (op.type === "delete" ? [op.path] : []));
  return {
    outcome: { ...base, result: "mirrored", changed: planned.ops.map((op) => op.path), ...(deleted.length === 0 ? {} : { deleted }) },
    trust: trustNeeds(desired),
  };
}

/**
 * The named folder's Profile Installation, and the folder's own mirror record of it when this is a
 * second run, after the checks that keep a mirror from damaging an installation. A folder that
 * mirrors a different folder stops with an error and changes nothing. Interim: #803 owns the
 * refusals for the named folder and for `folder == from`, and #806 a mirror into a Profile
 * Installation. Each stops with an error and changes nothing.
 */
async function sourceInstallation(from: string, folder: string): Promise<{ source: Manifest; previous: MirrorManifest | null }> {
  // A named folder that holds a mirror throws MirroredInstallationError here.
  const source = await readManifest(from);
  if (source === null) throw new Error(`${display(from)} holds no Profile Installation to mirror. Nothing was changed.`);
  const mirrored = await readMirror(folder);
  if (mirrored !== null && mirrored.mirror !== from) {
    throw new Error(`${display(folder)} holds a Mirrored Installation of ${display(mirrored.mirror)}, not of ${display(from)}. Nothing was changed.`);
  }
  if (mirrored !== null) return { source, previous: mirrored };
  const installed = await readManifest(folder);
  if (installed !== null) {
    throw new Error(`${display(folder)} already holds a Profile Installation of '${installed.profile}'. Nothing was changed.`);
  }
  return { source, previous: null };
}
