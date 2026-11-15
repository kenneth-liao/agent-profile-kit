// One install location (a project folder, or the global install at user level): plans it
// against the Workspace and applies it. Commands and `apkit migrate` share this path.
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { globalManifestPath, readConfig, recordInstall } from "./config.js";
import {
  changesManifest,
  execute,
  isInside,
  plan,
  readManifest,
  readManifestAt,
  readMirror,
  unresolved,
  type Decisions,
  type InstructionChange,
  type Issue,
  type Manifest,
  type MirrorManifest,
  type Plan,
} from "./install.js";
import { syncGitExclude } from "./gitexclude.js";
import { AGENTS, render, userRoots, type AgentId, type Desired } from "./render.js";
import { contextSection, createdFiles, executeNotes, noteTargets, planSections, type NotePlan } from "./setup.js";
import type { Workspace } from "./workspace.js";

export interface Outcome {
  readonly folder: string;
  /** The global install (user level), as opposed to a project install in `folder`. */
  readonly global?: true;
  readonly result: "installed" | "mirrored" | "updated" | "removed" | "unchanged" | "needs-decision" | "not-installed" | "missing" | "error";
  /** For a Mirrored Installation: the folder whose installation it copies. */
  readonly mirror?: string;
  readonly profile?: string;
  readonly agents?: readonly AgentId[];
  readonly issues?: readonly Issue[];
  readonly instructions?: readonly InstructionChange[];
  readonly changed?: readonly string[];
  /** For a Mirrored Installation run again: the copies it deleted, among `changed`; absent when none. */
  readonly deleted?: readonly string[];
  readonly message?: string;
  /** Context Modules this project install shares with the global install (status only). */
  readonly overlap?: readonly string[];
}

/** An install location: a project folder, or the global install (Skills under the home folder). */
export interface Target {
  readonly folder: string;
  readonly global?: true;
}

export async function globalTarget(): Promise<Target> {
  return { folder: await realpath(homedir()), global: true };
}

export async function previousAt(target: Target): Promise<Manifest | null> {
  return target.global ? readManifestAt(globalManifestPath(), globalManifestPath(), "user") : readManifest(target.folder);
}

export interface Planned {
  readonly files: Plan;
  /** The global install's Context sections in user-level files. */
  readonly sections: NotePlan | null;
  readonly issues: readonly Issue[];
  readonly paths: readonly string[];
}

/**
 * Plans one location. The home folder can hold a project install and the global
 * install at once: each keeps its own manifest and never deletes the other's files.
 */
export async function planAt(target: Target, desired: Desired | null, previous: Manifest | MirrorManifest | null): Promise<Planned> {
  const home = await realpath(homedir());
  if (!target.global) {
    const other = target.folder === home ? await previousAt(await globalTarget()) : null;
    const files = await plan(target.folder, desired, previous, { shared: new Set(Object.keys(other?.files ?? {})) });
    return { files, sections: null, issues: files.issues, paths: files.ops.map((op) => op.path) };
  }
  // A Mirrored Installation in the home folder owns its files as a Profile Installation does.
  const project = (await readMirror(home)) ?? (await readManifest(home));
  const planned = await plan(home, desired, previous, {
    manifestPath: globalManifestPath(),
    shared: new Set(Object.keys(project?.files ?? {})),
    pruneLimits: agentFoldersOutside(home),
  });
  const body = desired?.context ?? null;
  const targets = body === null ? [] : await noteTargets(desired?.agents ?? [], homedir(), process.env);
  const notes = (await readConfig()).notes;
  const sections = await planSections(targets, (previous?.schema === 1 ? previous.sections : undefined) ?? {}, contextSection(body ?? ""), createdFiles(notes));
  const files = planned.manifest === null ? planned : { ...planned, manifest: { ...planned.manifest, sections: sections.records } };
  return {
    files,
    sections,
    issues: [...files.issues, ...sections.issues],
    paths: [...files.ops.map((op) => op.path), ...sections.ops.map((op) => op.path)],
  };
}

export async function apply(
  target: Target,
  desired: Desired | null,
  previous: Manifest | MirrorManifest | null,
  decisions: Decisions,
): Promise<Outcome> {
  const { folder, global } = target;
  const planned = await planAt(target, desired, previous);
  const open = unresolved({ ...planned.files, issues: planned.issues }, decisions);
  const base = {
    folder,
    ...(global ? { global } : {}),
    profile: desired?.profile ?? previous?.profile,
    agents: desired?.agents ?? previous?.agents,
    instructions: planned.files.instructions,
  };
  if (open.length > 0) return { ...base, result: "needs-decision", issues: open };
  const exclusion = global ? null : await syncGitExclude(folder, planned.files.manifest);
  // Unchanged only when no file, no manifest record, and no registration would change.
  const registered = global || (await readConfig()).installs.includes(folder);
  if (planned.paths.length === 0 && !changesManifest(planned.files) && registered && desired !== null && previous !== null) {
    return { ...base, result: "unchanged" };
  }
  if (planned.sections !== null) await executeNotes(planned.sections);
  await execute(planned.files);
  if (!global) await recordInstall(folder, desired !== null, exclusion);
  const changed = [...new Set(planned.paths)];
  // A Mirrored Installation it replaces was no Profile Installation (ISC-103).
  const result = desired === null ? "removed" : previous === null || previous.schema === 2 ? "installed" : "updated";
  return { ...base, result, changed };
}

/** Agent folders outside the home that hold user-level Skills: removal prunes up to each, never past it. */
function agentFoldersOutside(home: string): string[] {
  const folders = Object.values(userRoots(homedir(), process.env)).map((root) => resolve(home, root, ".."));
  return [...new Set(folders)].filter((folder) => !isInside(home, folder));
}

/** Renders for a project folder, or (scope "user") for each agent's user-level folders and files. */
export function renderFor(workspace: Workspace, profile: string, agents: readonly AgentId[], scope?: "user"): Desired {
  if (scope === undefined) return render(workspace, profile, agents);
  return render(workspace, profile, agents, userRoots(homedir(), process.env), scope);
}

export interface TrustNeed {
  readonly agent: AgentId;
  readonly untilTrusted: "skills" | "everything";
}

/** The selected agents that hold back part of a project install until the folder is trusted. */
export function trustNeeds(desired: Desired): TrustNeed[] {
  if (desired.scope === "user") return [];
  const held = { skills: desired.files.size > 0, everything: desired.files.size > 0 || desired.context !== null };
  return desired.agents.flatMap((agent) => {
    const untilTrusted = AGENTS[agent].untilTrusted;
    return untilTrusted !== null && held[untilTrusted] ? [{ agent, untilTrusted }] : [];
  });
}
