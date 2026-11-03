#!/usr/bin/env node
// `apkit`: a small, non-interactive command meant to be driven by an agent.
// It never prompts. When a step needs the user's decision it changes nothing,
// lists the decisions (exit 3), and the caller re-runs with --yes or --overwrite.
import { lstat, readdir, readFile, realpath, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { configHome, globalManifestPath, readConfig, recordInstall, writeConfig } from "./config.js";
import { groupedWarning, nextCommand } from "./output.js";
import { COMMAND, CONTRACT, CONTRACT_POINTER, GUIDE, HELP, INTRODUCTION } from "./guide.js";
import {
  atomicWrite,
  changesManifest,
  execute,
  isInside,
  plan,
  readManifest,
  readManifestAt,
  MANIFEST_PATH,
  unresolved,
  type Decisions,
  type InstructionChange,
  type Issue,
  type Manifest,
  type Plan,
} from "./install.js";
import { removeGitExclude, syncGitExclude } from "./gitexclude.js";
import { findRepository } from "./gitindex.js";
import { currentFiles, inspectOldOutput, oldBlockEntries, oldExcludeEntries, oldGeneratedPart, oldOutputOrigin, oldStateFolder, readOldState, rewriteOldExclude, takenOver, type OldGeneratedPart, type OldOutput, type OldReceipt } from "./migrate.js";
import { AGENTS, isAgentId, render, userRoots, type AgentId, type Desired } from "./render.js";
import {
  contextSection,
  createdFiles,
  detectAgents,
  executeNotes,
  noteTargets,
  planNotes,
  planSections,
  type NotePlan,
} from "./setup.js";
import { NewerSchemaError } from "./schema.js";
import { withLock } from "./lock.js";
import { initWorkspace, loadWorkspace, type Workspace } from "./workspace.js";

const EXIT = { ok: 0, error: 1, usage: 2, decision: 3 } as const;

interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(["--agents", "--workspace"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.split("=", 2) as [string, string | undefined];
      if (valued.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`${name} needs a value.`);
        flags.set(name, value);
      } else {
        flags.set(name, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

class UsageError extends Error {}

function display(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

async function folderArg(value: string | undefined): Promise<string> {
  const path = resolve(value ?? process.cwd());
  try {
    if (!(await stat(path)).isDirectory()) throw new Error();
  } catch {
    throw new UsageError(`${path} is not a folder.`);
  }
  return realpath(path);
}

async function workspaceFor(args: Args): Promise<Workspace> {
  const flag = args.flags.get("--workspace");
  const root = typeof flag === "string" ? resolve(flag) : (await readConfig()).workspace;
  if (root === undefined) throw new UsageError("No Workspace selected. Run `apkit init <path>` or `apkit workspace <path>`.");
  return loadWorkspace(root);
}

const BLOCKED = `Installs and updates wait until \`${COMMAND} check\` reports no problems.`;

function requireValid(workspace: Workspace): void {
  if (workspace.violations.length > 0) {
    const lines = workspace.violations.map((v) => `  - ${v.message}`);
    throw new Error([`The Workspace at ${display(workspace.root)} has problems:`, ...lines, BLOCKED, CONTRACT_POINTER, ...warningLines(workspace)].join("\n"));
  }
}

interface MissingProfile {
  readonly folder: string;
  readonly global?: true;
  readonly profile: string;
}

/** Each install (registered folders, then the global install) whose Profile the Workspace lacks. Reads only. */
async function missingProfiles(workspace: Workspace, installs: readonly string[]): Promise<MissingProfile[]> {
  const missing: MissingProfile[] = [];
  for (const target of [...installs.map((folder): Target => ({ folder })), await globalTarget()]) {
    let previous: Manifest | null;
    try {
      previous = await previousAt(target);
    } catch (error) {
      // status reports a manifest from a newer apkit.
      if (error instanceof NewerSchemaError) continue;
      throw error;
    }
    if (previous === null || workspace.profiles.has(previous.profile)) continue;
    missing.push({ folder: target.folder, ...(target.global ? { global: target.global } : {}), profile: previous.profile });
  }
  return missing;
}

/** Warnings never block; they are shown so that no skipped file goes unnoticed (ADR-0057 §4). */
function warningLines(workspace: Workspace): string[] {
  return workspace.warnings.map((w) => groupedWarning(w.message, [display(resolve(workspace.root, w.path))]));
}

/** The `--json` record of several locations: one object, with each location's record complete. */
function withWarnings(outcomes: readonly Outcome[], workspace: Workspace): { results: unknown[] } {
  return { results: workspace.warnings.length === 0 ? [...outcomes] : outcomes.map((outcome) => ({ ...outcome, warnings: workspace.warnings })) };
}

function agentsFlag(args: Args, fallback: readonly AgentId[] | undefined): AgentId[] {
  const flag = args.flags.get("--agents");
  if (typeof flag !== "string") {
    if (fallback !== undefined) return [...fallback];
    throw new UsageError(`Name the agents with --agents (${Object.keys(AGENTS).join(", ")}).`);
  }
  const ids = flag.split(",").map((id) => id.trim()).filter((id) => id !== "");
  const unknown = ids.filter((id) => !isAgentId(id));
  if (unknown.length > 0 || ids.length === 0) {
    throw new UsageError(`Unknown agent: ${unknown.join(", ") || "(none)"}. Use ${Object.keys(AGENTS).join(", ")}.`);
  }
  return ids as AgentId[];
}

interface Outcome {
  readonly folder: string;
  /** The global install (user level), as opposed to a project install in `folder`. */
  readonly global?: true;
  readonly result: "installed" | "updated" | "removed" | "unchanged" | "needs-decision" | "not-installed" | "missing" | "error";
  readonly profile?: string;
  readonly agents?: readonly AgentId[];
  readonly issues?: readonly Issue[];
  readonly instructions?: readonly InstructionChange[];
  readonly changed?: readonly string[];
  readonly message?: string;
  /** Context Modules this project install shares with the global install (status only). */
  readonly overlap?: readonly string[];
}

/** An install location: a project folder, or the global install (Skills under the home folder). */
interface Target {
  readonly folder: string;
  readonly global?: true;
}

async function globalTarget(): Promise<Target> {
  return { folder: await realpath(homedir()), global: true };
}

async function previousAt(target: Target): Promise<Manifest | null> {
  return target.global ? readManifestAt(globalManifestPath(), globalManifestPath(), "user") : readManifest(target.folder);
}

interface Planned {
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
async function planAt(target: Target, desired: Desired | null, previous: Manifest | null): Promise<Planned> {
  const home = await realpath(homedir());
  if (!target.global) {
    const other = target.folder === home ? await previousAt(await globalTarget()) : null;
    const files = await plan(target.folder, desired, previous, { shared: new Set(Object.keys(other?.files ?? {})) });
    return { files, sections: null, issues: files.issues, paths: files.ops.map((op) => op.path) };
  }
  const project = await readManifest(home);
  const planned = await plan(home, desired, previous, {
    manifestPath: globalManifestPath(),
    shared: new Set(Object.keys(project?.files ?? {})),
    pruneLimits: agentFoldersOutside(home),
  });
  const body = desired?.context ?? null;
  const targets = body === null ? [] : await noteTargets(desired?.agents ?? [], homedir(), process.env);
  const notes = (await readConfig()).notes;
  const sections = await planSections(targets, previous?.sections ?? {}, contextSection(body ?? ""), createdFiles(notes));
  const files = planned.manifest === null ? planned : { ...planned, manifest: { ...planned.manifest, sections: sections.records } };
  return {
    files,
    sections,
    issues: [...files.issues, ...sections.issues],
    paths: [...files.ops.map((op) => op.path), ...sections.ops.map((op) => op.path)],
  };
}

async function apply(
  target: Target,
  desired: Desired | null,
  previous: Manifest | null,
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
  const result = desired === null ? "removed" : previous === null ? "installed" : "updated";
  return { ...base, result, changed };
}

/** Agent folders outside the home that hold user-level Skills: removal prunes up to each, never past it. */
function agentFoldersOutside(home: string): string[] {
  const folders = Object.values(userRoots(homedir(), process.env)).map((root) => resolve(home, root, ".."));
  return [...new Set(folders)].filter((folder) => !isInside(home, folder));
}

/** Renders for a project folder, or (scope "user") for each agent's user-level folders and files. */
function renderFor(workspace: Workspace, profile: string, agents: readonly AgentId[], scope?: "user"): Desired {
  if (scope === undefined) return render(workspace, profile, agents);
  return render(workspace, profile, agents, userRoots(homedir(), process.env), scope);
}

async function statusOf(workspace: Workspace, target: Target): Promise<Outcome> {
  const { folder } = target;
  try {
    if (!(await stat(folder)).isDirectory()) throw new Error();
  } catch {
    return { folder, result: "missing", message: "The folder no longer exists." };
  }
  let previous: Manifest | null;
  try {
    previous = await previousAt(target);
  } catch (error) {
    if (error instanceof NewerSchemaError) return { folder, ...(target.global ? { global: target.global } : {}), result: "error", message: error.message };
    throw error;
  }
  if (previous === null) return { folder, result: "not-installed" };
  const base = {
    folder,
    ...(target.global ? { global: target.global } : {}),
    profile: previous.profile,
    agents: previous.agents,
    ...(target.global ? {} : { overlap: await overlapWithGlobal(previous) }),
  };
  if (!workspace.profiles.has(previous.profile)) {
    return { ...base, result: "error", message: `Profile '${previous.profile}' is no longer in the Workspace.` };
  }
  let planned: Planned;
  try {
    // A project install in the home folder also reads the global manifest, which can be newer.
    planned = await planAt(target, renderFor(workspace, previous.profile, previous.agents, previous.scope), previous);
  } catch (error) {
    if (error instanceof NewerSchemaError) return { ...base, result: "error", message: error.message };
    throw error;
  }
  if (planned.issues.length > 0) {
    return { ...base, result: "needs-decision", issues: planned.issues, instructions: planned.files.instructions };
  }
  if (planned.paths.length > 0 || changesManifest(planned.files)) {
    return { ...base, result: "updated", instructions: planned.files.instructions, changed: [...new Set(planned.paths)] };
  }
  return { ...base, result: "unchanged" };
}

/** The Context Modules a project install shares with the global install. A newer global manifest is reported elsewhere. */
async function overlapWithGlobal(project: Manifest): Promise<string[]> {
  const global = await readManifestAt(globalManifestPath(), globalManifestPath(), "user").catch((error: unknown) => {
    if (error instanceof NewerSchemaError) return null;
    throw error;
  });
  const shared = new Set(global?.context ?? []);
  return (project.context ?? []).filter((id) => shared.has(id));
}

/** Drops a folder that no longer exists from the registry, with its exclusion block. */
async function forget(folder: string): Promise<void> {
  const exclusion = (await readConfig()).exclusions?.[folder];
  if (exclusion !== undefined) await removeGitExclude(exclusion, folder);
  await recordInstall(folder, false);
}

/** `--all` is every registered folder plus the global install, if there is one. */
async function targets(args: Args): Promise<Target[]> {
  if (!args.flags.has("--all")) return [{ folder: await folderArg(args.positional[1]) }];
  const folders: Target[] = (await readConfig()).installs.map((folder) => ({ folder }));
  const global = await globalTarget();
  return (await stat(globalManifestPath()).then(() => true, () => false)) ? [...folders, global] : folders;
}

/** A shared warning appears once, with every Project affected by that condition. */
function describeOutcomes(outcomes: readonly Outcome[], mode: "apply" | "status", args: Args): string {
  const warnings = new Map<string, string[]>();
  if (mode === "status") {
    for (const outcome of outcomes) {
      if (!outcome.overlap?.length) continue;
      const ids = [...outcome.overlap].sort().map((id) => `'${id}'`).join(", ");
      const message = `Context ${ids} is also installed at user level; an agent selected in both places reads it twice.`;
      warnings.set(message, [...(warnings.get(message) ?? []), display(outcome.folder)]);
    }
  }
  return [
    ...outcomes.map((outcome) => describe(outcome, mode, args)),
    ...[...warnings].map(([message, paths]) => groupedWarning(message, paths)),
  ].join("\n") || "Nothing is installed yet.";
}

/** Preserve the caller's selection, but make the target and Workspace independent of cwd. */
function nextArgs(outcome: Outcome, args: Args, mode: "apply" | "status"): string[] {
  const command = mode === "status" ? "update" : args.positional[0]!;
  const global = outcome.global === true;
  const result = command === "setup" ? [command]
    : command === "install" || (command === "update" && global)
      ? ["install", outcome.profile!, ...(global ? ["--global"] : [outcome.folder])]
      : [command, ...(global ? ["--global"] : [outcome.folder])];
  for (const [flag, value] of args.flags) {
    if (["--all", "--global", "--json"].includes(flag)) continue;
    result.push(flag);
    if (typeof value === "string") result.push(flag === "--workspace" ? resolve(value) : value);
  }
  if (result[0] === "install" && !args.flags.has("--agents")) result.push("--agents", outcome.agents!.join(","));
  if (outcome.issues?.some((i) => i.kind === "consent" || i.kind === "outside") && !result.includes("--yes")) result.push("--yes");
  if (outcome.issues?.some((i) => i.kind === "changed" || i.kind === "unowned") && !result.includes("--overwrite")) result.push("--overwrite");
  return result;
}

function describe(outcome: Outcome, mode: "apply" | "status", args: Args): string {
  const where = outcome.global ? "User level" : display(outcome.folder);
  const who = outcome.agents?.map((id) => AGENTS[id].name).join(", ");
  const what = outcome.profile === undefined ? "" : `'${outcome.profile}'${who ? ` for ${who}` : ""}`;
  switch (outcome.result) {
    case "installed":
      return `Installed ${what} in ${where}.`;
    case "updated":
      return mode === "status"
        ? `${where}: ${what} is out of date.\n${(outcome.changed ?? []).map((path) => `  - ${path}`).join("\n")}\n${nextCommand(nextArgs(outcome, args, mode))}`
        : `Updated ${what} in ${where} (${outcome.changed?.length ?? 0} changed).`;
    case "removed":
      return `Removed ${what} from ${where}.`;
    case "unchanged":
      return mode === "status" ? `${where}: ${what} is up to date.` : `${where}: ${what} is already up to date.`;
    case "not-installed":
      return `${where}: nothing installed.`;
    case "missing":
    case "error":
      return `${where}: ${outcome.message}`;
    case "needs-decision": {
      const lines = (outcome.issues ?? []).map((issue) => `  - ${issue.message}`);
      const lead = mode === "status" ? `${where}: needs a decision before updating:` : `${where}: nothing changed. Needs a decision:`;
      const files = (outcome.instructions ?? []).map(
        (file) =>
          `    - ${file.path}: will be ${file.action === "create" ? "created" : file.action === "delete" ? "deleted" : "changed"}; ${file.tracked ? "tracked" : "not tracked"} by Git.`,
      );
      const listed = files.length > 0 ? `\n  Instruction files:\n${files.join("\n")}` : "";
      return `${lead}\n${lines.join("\n")}${listed}\n  Only after the user agrees:\n  ${nextCommand(nextArgs(outcome, args, mode))}`;
    }
  }
}

/** Until setup has run, init and workspace name it as the next step: agents follow command output. */
function setupHint(config: { readonly notes?: Readonly<Record<string, unknown>> }): string | null {
  return Object.keys(config.notes ?? {}).length > 0 ? null : `${nextCommand(["setup"])} so your agents know about apkit.`;
}

interface TrustNeed {
  readonly agent: AgentId;
  readonly untilTrusted: "skills" | "everything";
}

/** The selected agents that hold back part of a project install until the folder is trusted. */
function trustNeeds(desired: Desired): TrustNeed[] {
  if (desired.scope === "user") return [];
  const held = { skills: desired.files.size > 0, everything: desired.files.size > 0 || desired.context !== null };
  return desired.agents.flatMap((agent) => {
    const untilTrusted = AGENTS[agent].untilTrusted;
    return untilTrusted !== null && held[untilTrusted] ? [{ agent, untilTrusted }] : [];
  });
}

function trustLines(needs: readonly TrustNeed[], folder: string): string[] {
  const names = (kind: TrustNeed["untilTrusted"]) => needs.filter((n) => n.untilTrusted === kind).map((n) => AGENTS[n.agent].name);
  const list = (items: readonly string[]) =>
    items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const skills = names("skills");
  const everything = names("everything");
  return [
    skills.length === 0 ? null : `${list(skills)} ${skills.length === 1 ? "loads" : "load"} Skills from ${display(folder)} only after you trust that Project.`,
    everything.length === 0 ? null : `${list(everything)} ${everything.length === 1 ? "loads" : "load"} nothing from ${display(folder)} until you trust that Project.`,
  ].filter((line) => line !== null);
}

/** What `migrate` did with one output that the old engine recorded. */
interface OldOutputOutcome {
  readonly path: string;
  readonly type: "file" | "directory";
  /**
   * "unchanged": still as the old apkit wrote it, because the run stopped for a decision.
   * "already-replaced": an earlier run replaced it, and this apkit owns it now.
   * "kept": it was changed, and `migrate --yes` left it to the user; apkit does not track it.
   */
  readonly result: "deleted" | "replaced" | "already-replaced" | "missing" | "changed" | "kept" | "unchanged";
  /** For a changed or kept output: what it was, in plain words. */
  readonly origin?: string;
  /** For a changed or kept `.codex/hooks.json` or `.opencode/opencode.jsonc`: the part the old apkit added. */
  readonly apkitPart?: OldGeneratedPart | null;
  /** For a changed output: the flags that settle it. Empty when the user must move it by hand. */
  readonly choices?: readonly ("yes" | "overwrite")[];
  /** For a changed output: this apkit installs its own copy at the same path. */
  readonly installedAgain?: boolean;
}

/** The complete record of migrating one Project from the old engine (ISC-89, ISC-90). */
interface Migration {
  readonly folder: string;
  /**
   * "retired": the old apkit no longer had a Profile selected here; its unchanged files were deleted and nothing was installed.
   * "missing": the recorded Project folder no longer exists; it was skipped.
   * "waiting": a planning run found no decision of its own; it continues after the Workspace decision.
   */
  readonly result: "migrated" | "unchanged" | "needs-decision" | "waiting" | "retired" | "missing" | "error";
  readonly profile: string;
  readonly agents: readonly AgentId[];
  readonly outputs: readonly OldOutputOutcome[];
  /** Folders removed because nothing but old output was in them, relative to the Project. */
  readonly folders: readonly string[];
  readonly exclusion: { readonly file: string | null; readonly result: "removed" | "kept-for-others" | "none" };
  /** The new engine's install, as `install --json` reports it. */
  readonly install?: Outcome;
  readonly issues: readonly Issue[];
  readonly instructions: readonly InstructionChange[];
  readonly trust: readonly TrustNeed[];
  readonly message?: string;
}

/** The folders old outputs lie in, inside the Project: the only folders `migrate` may remove, and only when emptied. */
async function oldFolders(folder: string, outputs: readonly OldOutput[]): Promise<string[]> {
  const found = new Set<string>();
  for (const output of outputs) {
    const parts = output.path.split("/");
    for (let i = 1; i < parts.length; i++) found.add(parts.slice(0, i).join("/"));
    if (output.type !== "directory") continue;
    found.add(output.path);
    const root = join(folder, ...parts);
    const inner = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
    for (const entry of inner) {
      if (entry.isDirectory()) found.add(`${output.path}/${relative(root, join(entry.parentPath, entry.name)).split(sep).join("/")}`);
    }
  }
  const existing: string[] = [];
  for (const path of found) if (await isFolder(join(folder, ...path.split("/")))) existing.push(path);
  return existing;
}

async function isFolder(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isDirectory(), () => false);
}

/**
 * The exclude file that holds the old block for `folder`, and the entries in it that other
 * old Projects still need: those whose old files are not gone yet (`pending`). An entry
 * already removed is never written back. A malformed block stops the Project before any write.
 */
async function oldExclusion(folder: string, pending: readonly OldReceipt[]): Promise<{ file: string; keep: string[] } | null> {
  const repository = await findRepository(folder);
  if (repository === null) return null;
  const file = join(repository.commonDir, "info", "exclude");
  const before = await readFile(file).catch(() => null);
  if (before === null) return { file, keep: [] };
  const present = new Set(oldBlockEntries(before));
  const keep: string[] = [];
  for (const other of pending) {
    const theirs = await findRepository(other.project);
    if (theirs === null || theirs.commonDir !== repository.commonDir) continue;
    keep.push(...oldExcludeEntries(relative(theirs.root, other.project).split(sep).join("/"), other.outputs).filter((entry) => present.has(entry)));
  }
  rewriteOldExclude(before, keep, file);
  return { file, keep };
}

/** Whether this apkit installs a file at `path` or inside it. */
function installsAt(desired: Desired, path: string): boolean {
  return [...desired.files.keys()].some((file) => file === path || file.startsWith(`${path}/`));
}

/** The part the old apkit added to a configuration file at an old output's path, as it is now. */
async function generatedPartAt(folder: string, output: OldOutput, skills: readonly string[]): Promise<OldGeneratedPart | null> {
  if (output.type !== "file") return null;
  const text = await readFile(join(folder, ...output.path.split("/")), "utf8").catch(() => null);
  return text === null ? null : oldGeneratedPart(output.path, text, skills);
}

/** A changed old output and what the flags settle for it (ISC-66, ISC-91). */
interface OldChange {
  readonly output: OldOutput;
  /** "keep" (`--yes`): left to the user. "overwrite": handed to the planner whole, which deletes or replaces it. */
  readonly resolution: "open" | "keep" | "overwrite";
  readonly issue: Issue;
  readonly apkitPart: OldGeneratedPart | null;
  readonly choices: readonly ("yes" | "overwrite")[];
  readonly installedAgain: boolean;
  /** Its current files, handed to the planner unless the user keeps it. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * Settles each changed old output with the flags. `--overwrite` deletes it whole; `--yes` keeps
 * it, unless this apkit installs at the same path. Without either, it stays a decision.
 */
async function changedOutputs(
  workspace: Workspace,
  receipt: OldReceipt,
  folder: string,
  states: readonly { output: OldOutput; state: { result: string } }[],
  /** Null for a retired Project: nothing is installed, so `--yes` can keep every changed output. */
  desired: Desired | null,
  decisions: Decisions,
): Promise<OldChange[]> {
  const skills = workspace.profiles.get(receipt.profile)?.skills ?? [];
  const result: OldChange[] = [];
  for (const { output, state } of states) {
    if (state.result !== "changed") continue;
    const apkitPart = await generatedPartAt(folder, output, skills);
    const files = await currentFiles(folder, output);
    const installed = desired !== null && installsAt(desired, output.path);
    const lead = `${output.path} was changed after the old apkit wrote it. It is ${oldOutputOrigin(output.path, receipt)}.`;
    let resolution: OldChange["resolution"] = "open";
    let message = lead;
    if (files === null) message = `${lead} It holds a symlink or another special file, so apkit does not delete it: move your changes out of it and delete it, then run migrate again.`;
    else if (decisions.overwrite) resolution = "overwrite";
    else if (decisions.yes && !installed) resolution = "keep";
    const choices = files === null ? [] : installed ? (["overwrite"] as const) : (["yes", "overwrite"] as const);
    result.push({ output, resolution, apkitPart, choices, installedAgain: installed, issue: { kind: "changed", path: output.path, message }, ...(files === null || resolution === "keep" ? {} : { files }) });
  }
  return result;
}

/** Removes the old entries for one Project from its exclude file, keeping those `exclusion.keep` names. */
async function removeOldEntries(exclusion: { file: string; keep: string[] } | null): Promise<Migration["exclusion"]> {
  if (exclusion === null) return { file: null, result: "none" };
  const before = await readFile(exclusion.file).catch(() => null);
  const after = before === null ? null : rewriteOldExclude(before, exclusion.keep, exclusion.file);
  if (before === null || after === null || after.equals(before)) return { file: exclusion.file, result: "none" };
  await atomicWrite(exclusion.file, after);
  return { file: exclusion.file, result: exclusion.keep.length === 0 ? "removed" : "kept-for-others" };
}

function emptyMigration(receipt: OldReceipt) {
  return {
    folder: receipt.project,
    profile: receipt.profile,
    agents: receipt.agents,
    outputs: [] as OldOutputOutcome[],
    folders: [] as string[],
    exclusion: { file: null, result: "none" as const },
    issues: [] as Issue[],
    instructions: [] as InstructionChange[],
    trust: [] as TrustNeed[],
  };
}

/** The old outputs of one Project and their states, as `migrate` inspects them. */
type OldStates = readonly { output: OldOutput; state: { result: OldOutputOutcome["result"]; files?: Readonly<Record<string, string>> } }[];

/**
 * Builds each old output's outcome, with what a changed or kept output was and the part the
 * old apkit added to it. `result` gives each output's result for this outcome.
 */
async function outcomeBuilder(workspace: Workspace, receipt: OldReceipt, folder: string, states: OldStates, changes: readonly OldChange[]) {
  const skills = workspace.profiles.get(receipt.profile)?.skills ?? [];
  const keptParts = new Map<OldOutput, OldGeneratedPart | null>();
  for (const { output, state } of states) if (state.result === "kept") keptParts.set(output, await generatedPartAt(folder, output, skills));
  return (result: (output: OldOutput, state: { result: OldOutputOutcome["result"] }) => OldOutputOutcome["result"]) =>
    states.map(({ output, state }): OldOutputOutcome => {
      const change = changes.find((c) => c.output === output);
      const described = change !== undefined || state.result === "kept";
      return {
        path: output.path,
        type: output.type,
        result: result(output, state),
        ...(described ? { origin: oldOutputOrigin(output.path, receipt), apkitPart: change?.apkitPart ?? keptParts.get(output) ?? null } : {}),
        ...(change !== undefined && state.result === "changed" ? { choices: change.choices, installedAgain: change.installedAgain } : {}),
      };
    });
}

/** Records the changed old outputs that `migrate --yes` left to the user, so a later run does not ask again. */
async function recordKept(folder: string, changes: readonly OldChange[]): Promise<void> {
  const keep = changes.filter((change) => change.resolution === "keep").map((change) => change.output.path);
  if (keep.length === 0) return;
  const config = await readConfig();
  await writeConfig({ ...config, kept: { ...config.kept, [folder]: [...new Set([...(config.kept?.[folder] ?? []), ...keep])].sort() } });
}

/**
 * Takes over a Project the old apkit had unbound: deletes each of its old outputs that is still
 * as the old apkit wrote it, through the ordinary planner, and its old exclusion entries.
 * Nothing is installed. A changed output follows the same decision rules as a bound Project's
 * (`--yes` keeps it, `--overwrite` deletes it). Paths that a bound receipt for the same folder records stay.
 */
async function retireProject(
  workspace: Workspace,
  receipt: OldReceipt,
  pending: readonly OldReceipt[],
  bound: readonly OldReceipt[],
  decisions: Decisions,
  planOnly = false,
): Promise<Migration> {
  const base = emptyMigration(receipt);
  if (!(await isFolder(receipt.project))) return { ...base, result: "missing" };
  const folder = await realpath(receipt.project);
  const keptBefore = new Set((await readConfig()).kept?.[folder] ?? []);
  const states: OldStates = await Promise.all(
    receipt.outputs.map(async (output) =>
      // `migrate --yes` left it to the user in an earlier run.
      keptBefore.has(output.path) ? { output, state: { result: "kept" as const } } : { output, state: await inspectOldOutput(folder, output) },
    ),
  );
  const changes = await changedOutputs(workspace, receipt, folder, states, null, decisions);
  const outcomes = await outcomeBuilder(workspace, receipt, folder, states, changes);
  if (changes.some((change) => change.resolution === "open") || (planOnly && changes.length > 0)) {
    // Nothing is written, so every decision is listed, including those the flags given would settle.
    return { ...base, folder, result: "needs-decision", outputs: outcomes((_, state) => state.result), issues: changes.map((change) => change.issue) };
  }

  const exclusion = await oldExclusion(folder, pending);
  const shared = new Set(bound.filter((other) => other.project === receipt.project).flatMap((other) => other.outputs.map((output) => output.path)));
  const resolution = (output: OldOutput) => changes.find((change) => change.output === output)?.resolution;
  const goes = (output: OldOutput, state: { result: string }) => !shared.has(output.path) && (state.result === "unchanged" || resolution(output) === "overwrite");
  const files: Record<string, string> = {};
  for (const { output, state } of states) if (goes(output, state)) Object.assign(files, state.files ?? changes.find((change) => change.output === output)?.files ?? {});
  const previous: Manifest = { schema: 1, profile: receipt.profile, agents: receipt.agents, files, block: null, createdAgentsMd: false, claudeImport: false };
  const candidates = await oldFolders(folder, receipt.outputs);
  const planned = await plan(folder, null, previous);
  const issues = unresolved(planned, decisions);
  if (issues.length > 0) return { ...base, folder, result: "needs-decision", outputs: outcomes((_, state) => state.result), issues };
  if (planOnly) return { ...base, folder, result: "waiting", outputs: outcomes((_, state) => state.result) };
  // Only the old files: any manifest this apkit keeps here is left as it is.
  await execute({ ...planned, manifest: null, manifestBefore: null });
  await recordKept(folder, changes);
  const exclusionResult = await removeOldEntries(exclusion);
  const folders: string[] = [];
  for (const path of candidates) if (!(await isFolder(join(folder, ...path.split("/"))))) folders.push(path);
  const outputs = outcomes((output, state) => (resolution(output) === "keep" ? "kept" : goes(output, state) ? "deleted" : state.result));
  return { ...base, folder, result: "retired", outputs, folders: folders.sort(), exclusion: exclusionResult };
}

/**
 * Moves one Project from the old engine to this one. Every unchanged old output is handed
 * to the ordinary planner as if this engine had written it, so the same safety core replaces
 * or deletes it, prunes only folders it emptied, and stops for the same decisions (ISC-65).
 */
async function migrateProject(workspace: Workspace, receipt: OldReceipt, pending: readonly OldReceipt[], decisions: Decisions, planOnly = false): Promise<Migration> {
  const base = emptyMigration(receipt);
  if (!(await isFolder(receipt.project))) return { ...base, result: "missing" };
  const folder = await realpath(receipt.project);
  if (!workspace.profiles.has(receipt.profile)) {
    return { ...base, folder, result: "error", message: `Profile '${receipt.profile}' is not in the Workspace.` };
  }

  const current = await readManifest(folder);
  const kept = new Set((await readConfig()).kept?.[folder] ?? []);
  const states = await Promise.all(
    receipt.outputs.map(async (output) => {
      // `migrate --yes` left it to the user in an earlier run.
      if (kept.has(output.path)) return { output, state: { result: "kept" as const } };
      const state = await inspectOldOutput(folder, output);
      // An earlier run replaced it: this engine owns it now.
      const replaced = state.result === "changed" && (await takenOver(folder, output, current?.files ?? {}));
      return { output, state: replaced ? { result: "already-replaced" as const } : state };
    }),
  );
  const desired = renderFor(workspace, receipt.profile, receipt.agents);
  const changes = await changedOutputs(workspace, receipt, folder, states, desired, decisions);
  const exclusion = await oldExclusion(folder, pending);

  // The old outputs join any install this engine already made here. A changed output the user
  // did not keep is handed over whole, so a decision about it is not listed twice.
  const owned = Object.assign({}, ...states.map(({ state }) => ("files" in state ? state.files : undefined) ?? {}), ...changes.map((change) => change.files ?? {})) as Record<string, string>;
  const previous: Manifest = {
    ...(current ?? { schema: 1, block: null, createdAgentsMd: false, claudeImport: false }),
    profile: receipt.profile,
    agents: receipt.agents,
    files: { ...owned, ...current?.files },
  };
  const outcomes = await outcomeBuilder(workspace, receipt, folder, states, changes);
  const open = changes.filter((change) => change.resolution === "open");
  if (open.length > 0 || (planOnly && changes.length > 0)) {
    // Nothing is written, so every decision is listed, including those the flags given would settle.
    const planned = await planAt({ folder }, desired, previous);
    const issues = [...changes.map((change) => change.issue), ...planned.issues];
    const outputs = outcomes((_, state) => state.result);
    return { ...base, folder, result: "needs-decision", outputs, issues, instructions: planned.files.instructions };
  }
  const candidates = await oldFolders(folder, receipt.outputs);
  if (planOnly) {
    // Every issue is open: the run that settles them also settles the Workspace decision.
    const planned = await planAt({ folder }, desired, previous);
    const issues = unresolved({ ...planned.files, issues: planned.issues }, {});
    const outputs = states.map(({ output, state }) => ({ path: output.path, type: output.type, result: state.result }));
    return { ...base, folder, result: issues.length > 0 ? "needs-decision" : "waiting", outputs, issues, instructions: planned.files.instructions };
  }
  const install = await apply({ folder }, desired, previous, decisions);
  const instructions = install.instructions ?? [];
  if (install.result === "needs-decision") {
    const outputs = outcomes((_, state) => state.result);
    return { ...base, folder, result: "needs-decision", outputs, issues: install.issues ?? [], instructions, install };
  }
  await recordKept(folder, changes);

  const removed = await removeOldEntries(exclusion);

  const outputs = outcomes((output, state) => {
    const resolution = changes.find((change) => change.output === output)?.resolution;
    if (resolution === "keep") return "kept";
    if (state.result !== "unchanged" && resolution !== "overwrite") return state.result;
    return installsAt(desired, output.path) ? "replaced" : "deleted";
  });
  const folders: string[] = [];
  for (const path of candidates) if (!(await isFolder(join(folder, ...path.split("/"))))) folders.push(path);
  const moved = install.result !== "unchanged" || removed.result !== "none";
  return {
    ...base,
    folder,
    result: moved ? "migrated" : "unchanged",
    outputs,
    folders: folders.sort(),
    exclusion: removed,
    install,
    instructions,
    trust: moved ? trustNeeds(desired) : [],
  };
}

/** The lines that show what the old apkit added to a changed or kept configuration file. */
function apkitPartLines(part: OldGeneratedPart): string[] {
  switch (part.present) {
    case "yes":
      return [`    The part the old apkit added (${part.description}):`, ...part.text!.split("\n").map((line) => `      ${line}`)];
    case "no":
      return [`    The part the old apkit added is no longer in it: ${part.description}.`];
    case "unknown":
      return [`    It does not parse, so apkit cannot show its part. The old apkit added ${part.description}.`];
  }
}

/** For changed old outputs: what each flag does to each listed file, and the commands that settle them. */
function changedChoices(migration: Migration): { lines: string[]; next: string[][] } | null {
  const changed = migration.outputs.filter((o) => o.result === "changed");
  if (changed.length === 0) return null;
  const paths = (items: readonly OldOutputOutcome[]) => items.map((o) => o.path).join(", ");
  const them = (items: readonly OldOutputOutcome[]) => (items.length === 1 ? "it" : "them");
  const keepable = changed.filter((o) => o.choices?.includes("yes"));
  const notKeepable = changed.filter((o) => o.choices?.includes("overwrite") && !o.choices.includes("yes"));
  const deletable = changed.filter((o) => o.choices?.includes("overwrite"));
  const consent = migration.issues.filter((issue) => issue.kind === "consent" || issue.kind === "outside");
  const deleted = deletable.filter((o) => !o.installedAgain);
  const replaced = deletable.filter((o) => o.installedAgain);
  const lines = [
    "  What each choice does:",
    ...(keepable.length === 0 ? [] : [`    --yes keeps ${paths(keepable)} as your own: apkit stops tracking ${them(keepable)}, and Git no longer ignores ${them(keepable)}. First remove the part the old apkit added, with the user.`]),
    ...(notKeepable.length === 0 ? [] : [`    --yes cannot keep ${paths(notKeepable)}: this apkit installs its own copy there. To keep your changes, move them out first.`]),
    ...consent.map((issue) => `    --yes also allows: ${issue.message}`),
    ...(deleted.length === 0 ? [] : [`    --overwrite deletes ${paths(deleted)}.`]),
    ...(replaced.length === 0 ? [] : [`    --overwrite deletes ${paths(replaced)} and installs this apkit's copy in its place.`]),
  ];
  const next: string[][] = [];
  if (keepable.length === changed.length) next.push(["migrate", "--yes"]);
  if (deletable.length === changed.length) next.push(["migrate", "--overwrite", ...(consent.length > 0 ? ["--yes"] : [])]);
  return { lines, next };
}

/** Text for one migration. Kept in one place so the shared output rules (#760) can take it over. */
function describeMigration(migration: Migration, nextStep = true): string[] {
  const where = display(migration.folder);
  const who = migration.agents.map((id) => AGENTS[id].name).join(", ");
  const list = (label: string, items: readonly string[]) => (items.length === 0 ? [] : [`  ${label}:`, ...items.map((item) => `    - ${item}`)]);
  const paths = (result: OldOutputOutcome["result"]) => migration.outputs.filter((o) => o.result === result).map((o) => o.path);
  const kept = migration.outputs.filter((o) => o.result === "kept");
  const keptLines = [
    ...list("Kept as your own (apkit no longer tracks them)", kept.map((o) => o.path)),
    ...(kept.some((o) => o.apkitPart != null && o.apkitPart.present !== "no")
      ? groupedWarning(
          "these files you kept may still hold the part the old apkit added, which loads files that are now deleted. Remove that part with the user:",
          kept.filter((o) => o.apkitPart != null && o.apkitPart.present !== "no").map((o) => display(join(migration.folder, ...o.path.split("/")))),
        ).split("\n").map((line) => `  ${line}`)
      : []),
  ];
  switch (migration.result) {
    case "missing":
      // Listed once, with every missing folder, by `migrate`.
      return [];
    case "error":
      return [`${where}: not migrated. ${migration.message}`];
    case "retired":
      if (paths("deleted").length === 0 && migration.exclusion.result === "none") {
        return [`${where}: the old apkit no longer had a Profile selected here, and none of its files are left.`, ...keptLines];
      }
      return [
        `${where}: the old apkit no longer had a Profile selected here. Deleted its old files; installed nothing.`,
        ...list("Deleted old files", paths("deleted")),
        ...keptLines,
        ...list("Removed folders that held only old files", migration.folders),
        ...(migration.exclusion.result === "none" ? [] : [`  Removed the old apkit lines from ${display(migration.exclusion.file!)}.`]),
      ];
    case "waiting":
      return [`${where}: nothing changed yet. It continues with the Profile '${migration.profile}' for ${who} after the Workspace decision.`];
    case "unchanged":
      return [`${where}: already migrated; '${migration.profile}' for ${who} is installed and nothing of the old apkit is left.`, ...keptLines];
    case "needs-decision": {
      const yes = migration.issues.some((issue) => issue.kind === "consent" || issue.kind === "outside");
      const files = migration.instructions.map(
        (file) => `${file.path}: will be ${file.action === "create" ? "created" : file.action === "delete" ? "deleted" : "changed"}; ${file.tracked ? "tracked" : "not tracked"} by Git`,
      );
      const issueLines = migration.issues.flatMap((issue) => {
        const output = issue.kind === "changed" ? migration.outputs.find((o) => o.path === issue.path && o.result === "changed") : undefined;
        return [`  - ${issue.message}`, ...(output?.apkitPart ? apkitPartLines(output.apkitPart) : [])];
      });
      const choices = changedChoices(migration);
      const next =
        choices === null
          ? yes
            ? ["  Only after the user agrees:", `  ${nextCommand(["migrate", "--yes"])}`]
            : [`  ${nextCommand(["migrate"])}`]
          : choices.next.length === 0
            ? [`  ${nextCommand(["migrate"])}`]
            : [`  Only after the user agrees, ${choices.next.length === 1 ? "run" : "one of"}:`, ...choices.next.map((args) => `  ${nextCommand(args)}`)];
      return [
        `${where}: nothing changed. Needs a decision:`,
        ...issueLines,
        ...list("Instruction files", files),
        ...(choices?.lines ?? []),
        ...(nextStep ? next : []),
      ];
    }
    case "migrated":
      return [
        `${where}: migrated. Installed the Profile '${migration.profile}' for ${who} again with this apkit.`,
        ...list("Deleted old files", paths("deleted")),
        ...list("Replaced old Skill and file copies", paths("replaced")),
        ...keptLines,
        ...list("Removed folders that held only old files", migration.folders),
        ...(migration.exclusion.result === "none" ? [] : [`  Removed the old apkit lines from ${display(migration.exclusion.file!)}.`]),
        ...trustLines(migration.trust, migration.folder).map((line) => `  ${line}`),
      ];
  }
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

function backupExists(state: string, backup: string, changed: boolean): Error {
  return new Error(
    [
      `${display(backup)} already exists, so apkit cannot keep the old state at ${display(state)} there as a backup. ${changed ? `${display(state)} was not renamed.` : "Nothing was changed."}`,
      `Move ${display(backup)} somewhere else, then run migrate again.`,
      nextCommand(["migrate"]),
    ].join("\n"),
  );
}

/** Renaming an old Workspace's `workspace.yaml` to the file that marks a Workspace now (ADR-0057 §6). */
interface WorkspaceRename {
  readonly from: string;
  readonly to: string;
  readonly result: "needs-decision" | "renamed";
}

/**
 * The rename `migrate` can make, when the old `workspace.yaml` is the Workspace's only problem.
 * With any other problem it is null, so validation stops the run before anything is renamed.
 */
function oldMarkerRename(workspace: Workspace): Pick<WorkspaceRename, "from" | "to"> | null {
  const [only, ...rest] = workspace.violations;
  if (only?.code !== "workspace-old-manifest" || rest.length > 0) return null;
  return { from: join(workspace.root, "workspace.yaml"), to: join(workspace.root, "apkit-workspace.yaml") };
}

function describeRename(rename: WorkspaceRename | undefined): string[] {
  if (rename === undefined) return [];
  if (rename.result === "renamed") return [`  Renamed ${display(rename.from)} to ${display(rename.to)}; the content is unchanged.`];
  return [
    "  Nothing changed. Needs a decision:",
    `  - Rename ${display(rename.from)} to ${display(rename.to)}; the content stays the same. This apkit finds a Workspace by its apkit-workspace.yaml file.`,
  ];
}

async function migrate(decisions: Decisions, json: boolean): Promise<number> {
  const old = await readOldState(homedir());
  const state = oldStateFolder(homedir());
  const backup = `${state}.migrated`;
  if (old === null) {
    const kept = (await exists(backup)) ? backup : null;
    if (json) console.log(JSON.stringify({ state, found: false, projects: [], backup: kept }, null, 2));
    else if (kept !== null) console.log(`Nothing to migrate: the old apkit state was already migrated. It is kept as a backup at ${display(kept)}.`);
    else console.log(`Nothing to migrate: there is no old apkit state at ${display(state)}.`);
    return EXIT.ok;
  }
  // The backup is never replaced or merged into.
  if (await exists(backup)) throw backupExists(state, backup, false);
  if (old.workspace === undefined) throw new Error(`${display(join(state, "config.yaml"))} names no Workspace, so apkit cannot tell which Profiles to install. Nothing was changed.`);
  let workspace = await loadWorkspace(old.workspace);
  const marker = oldMarkerRename(workspace);
  // Without consent nothing changes: each Project is only planned, so one run lists every decision.
  const planOnly = marker !== null && !decisions.yes;
  if (marker !== null && !planOnly) {
    await rename(marker.from, marker.to);
    workspace = await loadWorkspace(old.workspace);
  }
  if (!planOnly) requireValid(workspace);
  const renamed: WorkspaceRename | undefined = marker === null ? undefined : { ...marker, result: planOnly ? "needs-decision" : "renamed" };
  const previousWorkspace = (await readConfig()).workspace ?? null;
  const projects: Migration[] = [];
  const bound = old.receipts.filter((receipt) => !receipt.retired);
  // Receipts whose old files are gone: their exclusion entries are no longer kept for them.
  const settled = new Set<OldReceipt>();
  for (const receipt of old.receipts) {
    const pending = old.receipts.filter((other) => other !== receipt && !settled.has(other));
    let migration: Migration;
    try {
      migration = receipt.retired ? await retireProject(workspace, receipt, pending, bound, decisions, planOnly) : await migrateProject(workspace, receipt, pending, decisions, planOnly);
    } catch (error) {
      if (error instanceof NewerSchemaError || !(error instanceof Error)) throw error;
      migration = { ...emptyMigration(receipt), result: "error", message: error.message };
    }
    projects.push(migration);
    if (migration.result !== "needs-decision" && migration.result !== "waiting" && migration.result !== "error") settled.add(receipt);
  }
  // The Workspace the old apkit used is selected once a Project uses it with this one.
  if (projects.some((p) => p.result === "migrated" || p.result === "unchanged")) await writeConfig({ ...(await readConfig()), workspace: workspace.root });

  // The old state is kept, renamed, once no Project needs it any more (ISC-92). A rename changes no file.
  const open = projects.filter((p) => p.result === "needs-decision" || p.result === "waiting" || p.result === "error");
  if (open.length === 0 && !planOnly) {
    if (await exists(backup)) throw backupExists(state, backup, true);
    await rename(state, backup);
  }
  const kept = { path: backup, result: open.length === 0 && !planOnly ? "renamed" : "kept" };

  if (json) {
    console.log(JSON.stringify({ state, found: true, workspace: { path: workspace.root, previous: previousWorkspace, ...(renamed ? { rename: renamed } : {}) }, projects, backup: kept }, null, 2));
  } else {
    const missing = projects.filter((p) => p.result === "missing").map((p) => display(p.folder));
    console.log(
      [
        INTRODUCTION,
        `Migrating from the old apkit, whose records are in ${display(state)}.`,
        `This apkit keeps each Project's installation in the Project itself, in ${MANIFEST_PATH}.`,
        `Workspace: ${display(workspace.root)}`,
        ...describeRename(renamed),
        // A planning run ends with one next step for every decision.
        ...projects.flatMap((project) => describeMigration(project, !planOnly)),
        ...(planOnly ? ["Only after the user agrees to every decision above:", `  ${nextCommand(["migrate", "--yes"])}`] : []),
        ...(missing.length === 0 ? [] : [groupedWarning("these recorded Project folders no longer exist, so they were skipped:", missing)]),
        ...(open.length === 0 && !planOnly
          ? [`Renamed ${display(state)} to ${display(backup)}. It keeps the old apkit records, unchanged, as a backup.`]
          : open.length === 0
            ? [`Kept ${display(state)} as it is. It is renamed to ${display(backup)} as a backup after the Workspace decision.`]
            : [
                `Kept ${display(state)} as it is. It is renamed to ${display(backup)} as a backup once these Projects are migrated:`,
                ...open.map((p) => `  - ${display(p.folder)}`),
              ]),
        ...warningLines(workspace),
      ].join("\n"),
    );
  }
  if (planOnly || open.some((p) => p.result === "needs-decision")) return EXIT.decision;
  return open.some((p) => p.result === "error") ? EXIT.error : EXIT.ok;
}

/** Commands that can write. `workspace` without a path only reads, but takes the lock anyway: it is quick. */
const WRITES = new Set(["init", "workspace", "install", "update", "remove", "setup", "migrate"]);

/**
 * The old engine's state folder while it exists, so every command names `apkit migrate` (ISC-93).
 * A complete migration renames it. Set once per run, from one stat, before anything can fail.
 */
let unmigrated: string | null = null;

const MIGRATE = nextCommand(["migrate"]);

function migrationNotice(state: string): string {
  return `The old apkit (0.238 or earlier) left its records at ${display(state)}; they are not migrated yet.\n${MIGRATE} to move each of its Projects to this apkit.`;
}

/** The field a `--json` record carries while the old state is not migrated. */
function migrationField(state: string | null): { migration?: { command: string; state: string } } {
  return state === null ? {} : { migration: { command: `${COMMAND} migrate`, state } };
}

/** Runs that write take turns, so none plans against files another run is changing. */
async function main(argv: readonly string[]): Promise<number> {
  const command = parseArgs(argv).positional[0];
  const state = oldStateFolder(homedir());
  unmigrated = (await exists(state)) ? state : null;
  return command !== undefined && WRITES.has(command) ? withLock(configHome(), () => run(argv)) : run(argv);
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const json = args.flags.has("--json");
  const decisions: Decisions = { yes: args.flags.has("--yes"), overwrite: args.flags.has("--overwrite") };
  const command = args.positional[0];
  // A configuration from a newer apkit stops every command before anything is written.
  if (command !== undefined && command !== "help" && command !== "guide" && command !== "contract") await readConfig();
  // `migrate` explains the migration itself, so it does not repeat the notice.
  const pending = command === "migrate" ? null : unmigrated;
  const withNotice = (text: string) => (pending === null ? text : `${text}\n${migrationNotice(pending)}`);
  const print = (text: string, data: object) =>
    console.log(json ? JSON.stringify({ ...data, ...migrationField(pending) }, null, 2) : withNotice(text));

  switch (command) {
    case undefined:
    case "help":
      console.log(withNotice(HELP));
      return args.flags.has("--help") || command === "help" ? EXIT.ok : EXIT.usage;

    case "guide":
      console.log(withNotice(GUIDE));
      return EXIT.ok;

    case "contract":
      // Byte for byte as the canonical file, so no newline is added; the notice goes to stderr.
      process.stdout.write(CONTRACT);
      if (pending !== null) console.error(migrationNotice(pending));
      return EXIT.ok;

    case "init": {
      const path = args.positional[1];
      if (path === undefined) throw new UsageError("Name the Workspace folder: `apkit init <path>`.");
      const root = resolve(path);
      const added = await initWorkspace(root);
      const config = await readConfig();
      await writeConfig({ ...config, workspace: root });
      const next = setupHint(config);
      print(
        `${INTRODUCTION}\nWorkspace ready at ${display(root)}${added.length > 0 ? ` (added ${added.join(", ")})` : ""}.${next ? `\n${next}` : ""}`,
        { workspace: root, added, next },
      );
      return EXIT.ok;
    }

    case "workspace": {
      const path = args.positional[1];
      if (path === undefined) {
        const current = (await readConfig()).workspace;
        print(`${INTRODUCTION}\n${current === undefined ? "No Workspace selected." : display(current)}`, { workspace: current ?? null });
        return EXIT.ok;
      }
      const workspace = await loadWorkspace(resolve(path));
      const unmarked = workspace.violations.find((v) => v.code === "workspace-missing-manifest" || v.code === "workspace-old-manifest");
      if (unmarked?.code === "workspace-old-manifest") throw new Error(`${display(workspace.root)}: ${unmarked.message}`);
      if (unmarked !== undefined) {
        throw new Error(`${display(workspace.root)} is not a Workspace.\n${nextCommand(["init", workspace.root])}`);
      }
      const config = await readConfig();
      await writeConfig({ ...config, workspace: workspace.root });
      const next = setupHint(config);
      // A Workspace with errors is selected anyway; its report shows what to fix (ISC-48).
      const problems =
        workspace.violations.length === 0
          ? []
          : ["It has problems:", ...workspace.violations.map((v) => `  - ${v.message}`), BLOCKED, CONTRACT_POINTER];
      const missing = await missingProfiles(workspace, config.installs);
      const lacks =
        missing.length === 0
          ? []
          : [
              "These installs use a Profile this Workspace lacks:",
              ...missing.map((m) => `  - ${m.global ? "User level" : display(m.folder)}: '${m.profile}'`),
            ];
      const lines = [INTRODUCTION, `Selected the Workspace at ${display(workspace.root)}.`, ...problems, ...warningLines(workspace), ...lacks, ...(next ? [next] : [])];
      print(lines.join("\n"), {
        workspace: workspace.root,
        valid: workspace.violations.length === 0,
        violations: workspace.violations,
        warnings: workspace.warnings,
        missing,
        next,
        ...(workspace.violations.length > 0 ? { contract: `${COMMAND} contract` } : {}),
      });
      return EXIT.ok;
    }

    case "check": {
      const workspace = await workspaceFor(args);
      const data = {
        workspace: workspace.root,
        valid: workspace.violations.length === 0,
        violations: workspace.violations,
        warnings: workspace.warnings,
        profiles: [...workspace.profiles.values()],
        skills: [...workspace.skills.keys()],
        context: [...workspace.context.keys()],
        ...(workspace.violations.length > 0 ? { contract: `${COMMAND} contract` } : {}),
      };
      const lines =
        workspace.violations.length > 0
          ? [
              `The Workspace at ${display(workspace.root)} has problems:`,
              ...workspace.violations.map((v) => `  - ${v.message}`),
              CONTRACT_POINTER,
            ]
          : [
              `The Workspace at ${display(workspace.root)} is valid.`,
              ...[...workspace.profiles.values()].map(
                (p) => `  ${p.id}: ${p.context.length} context, ${p.skills.length} skills`,
              ),
            ];
      print([...lines, ...warningLines(workspace)].join("\n"), data);
      return workspace.violations.length > 0 ? EXIT.error : EXIT.ok;
    }

    case "install": {
      const profile = args.positional[1];
      if (profile === undefined) throw new UsageError("Name the Profile: `apkit install <profile> [folder] --agents <a,b>`.");
      const global = args.flags.has("--global");
      const target = global ? await globalTarget() : { folder: await folderArg(args.positional[2]) };
      const workspace = await workspaceFor(args);
      requireValid(workspace);
      const previous = await previousAt(target);
      const agents = agentsFlag(args, previous?.profile === profile ? previous.agents : undefined);
      const desired = renderFor(workspace, profile, agents, global ? "user" : undefined);
      const outcome = await apply(target, desired, previous, decisions);
      const trust = outcome.result === "needs-decision" ? [] : trustNeeds(desired);
      print([describe(outcome, "apply", args), ...trustLines(trust, target.folder), ...warningLines(workspace)].join("\n"), {
        ...outcome,
        trust,
        warnings: workspace.warnings,
      });
      return outcome.result === "needs-decision" ? EXIT.decision : EXIT.ok;
    }

    case "update": {
      const workspace = await workspaceFor(args);
      requireValid(workspace);
      const outcomes: Outcome[] = [];
      for (const target of await targets(args)) {
        const status = await statusOf(workspace, target);
        // A deleted folder is forgotten, with its exclusion block, as `remove` would.
        if (status.result === "missing" && !target.global) await forget(target.folder);
        if (status.result === "missing" || status.result === "error" || status.result === "not-installed") {
          outcomes.push(status);
          continue;
        }
        const previous = await previousAt(target);
        const desired = renderFor(workspace, previous!.profile, previous!.agents, previous!.scope);
        outcomes.push(await apply(target, desired, previous, decisions));
      }
      print([describeOutcomes(outcomes, "apply", args), ...warningLines(workspace)].join("\n"), withWarnings(outcomes, workspace));
      if (outcomes.some((o) => o.result === "needs-decision")) return EXIT.decision;
      return outcomes.some((o) => o.result === "error" || o.result === "not-installed") ? EXIT.error : EXIT.ok;
    }

    case "remove": {
      if (args.flags.has("--global")) {
        const target = await globalTarget();
        const previous = await previousAt(target);
        if (previous === null) {
          print("Nothing is installed at user level.", { folder: target.folder, global: true, result: "not-installed" });
          return EXIT.ok;
        }
        const outcome = await apply(target, null, previous, decisions);
        print(describe(outcome, "apply", args), outcome);
        return outcome.result === "needs-decision" ? EXIT.decision : EXIT.ok;
      }
      const path = resolve(args.positional[1] ?? process.cwd());
      const exists = await stat(path).then((s) => s.isDirectory(), () => false);
      if (!exists) {
        await forget(path);
        print(`${display(path)} no longer exists; forgot it.`, { folder: path, result: "forgotten" });
        return EXIT.ok;
      }
      const folder = await realpath(path);
      const previous = await readManifest(folder);
      if (previous === null) {
        await recordInstall(folder, false);
        print(`${display(folder)}: nothing installed.`, { folder, result: "not-installed" });
        return EXIT.ok;
      }
      const outcome = await apply({ folder }, null, previous, decisions);
      print(describe(outcome, "apply", args), outcome);
      return outcome.result === "needs-decision" ? EXIT.decision : EXIT.ok;
    }

    case "setup": {
      const config = await readConfig();
      const remove = args.flags.has("--remove");
      const detected = await detectAgents(homedir(), process.env);
      const agents = remove ? [] : args.flags.has("--agents") ? agentsFlag(args, undefined) : detected;
      if (!remove && agents.length === 0) {
        print(`No supported agents found on this machine. Select the agents to set up.\n${nextCommand(["setup", "--agents", Object.keys(AGENTS).join(",")])}`, { result: "no-agents" });
        return EXIT.error;
      }
      const targets = await noteTargets(agents, homedir(), process.env);
      const global = await previousAt(await globalTarget());
      const planned = await planNotes(targets, config.notes ?? {}, createdFiles(global?.sections));
      const open = planned.issues.filter((issue) => (issue.kind === "consent" ? !decisions.yes : !decisions.overwrite));
      const files = targets.map((t) => ({ path: t.path, agents: t.agents }));
      if (open.length > 0) {
        const outcome: Outcome = { folder: homedir(), result: "needs-decision", issues: open };
        print(describe(outcome, "apply", args), { result: "needs-decision", issues: open, files });
        return EXIT.decision;
      }
      await executeNotes(planned);
      await writeConfig({ ...config, notes: planned.records });
      const result = remove ? "removed" : planned.ops.length === 0 ? "unchanged" : "updated";
      const lines = remove
        ? [planned.ops.length === 0 ? "No apkit notes to remove." : "Removed the apkit note from your agents' user instructions."]
        : [
            planned.ops.length === 0 ? "Your agents already know about apkit:" : "Your agents now know about apkit:",
            ...targets.map((t) => `  ${t.agents.map((id) => AGENTS[id].name).join(", ")}: ${display(t.path)}`),
          ];
      print(lines.join("\n"), { result, files });
      return EXIT.ok;
    }

    case "migrate":
      return migrate(decisions, json);

    case "status": {
      const workspace = await workspaceFor(args);
      const outcomes: Outcome[] = [];
      for (const target of await targets(args)) outcomes.push(await statusOf(workspace, target));
      print([describeOutcomes(outcomes, "status", args), ...warningLines(workspace)].join("\n"), withWarnings(outcomes, workspace));
      return EXIT.ok;
    }

    default:
      throw new UsageError(`Unknown command '${command}'.\n${nextCommand(["help"])}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // A failed `migrate` may already have renamed the old state, or may name `migrate` itself.
    const migrating = process.argv.slice(2).find((arg) => !arg.startsWith("--")) === "migrate";
    const state = migrating && unmigrated !== null && !(await exists(unmigrated)) ? null : unmigrated;
    if (process.argv.includes("--json")) console.log(JSON.stringify({ error: message, ...migrationField(state) }));
    else console.error(state === null || message.includes(MIGRATE) ? message : `${message}\n${migrationNotice(state)}`);
    process.exitCode = error instanceof UsageError ? EXIT.usage : EXIT.error;
  },
);
