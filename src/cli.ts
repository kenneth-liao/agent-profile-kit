#!/usr/bin/env node
// `apkit`: a small, non-interactive command meant to be driven by an agent.
// It never prompts. When a step needs the user's decision it changes nothing,
// lists the decisions (exit 3), and the caller re-runs with --yes or --overwrite.
import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { COMMANDS } from "./command.js";
import { configHome, globalManifestPath, readConfig, recordInstall, writeConfig } from "./config.js";
import { display, groupedWarning, nextCommand } from "./output.js";
import { COMMAND, CONTRACT, CONTRACT_POINTER, GUIDE, HELP, INTRODUCTION } from "./guide.js";
import { changesManifest, readManifest, readManifestAt, MANIFEST_PATH, type Decisions, type InstructionChange, type Manifest } from "./install.js";
import { removeGitExclude } from "./gitexclude.js";
import { apply, globalTarget, planAt, previousAt, renderFor, trustNeeds, type Outcome, type Planned, type Target, type TrustNeed } from "./location.js";
import { migrate, oldStateFolder, type Migration, type MigrationRun, type OldGeneratedPart, type OldOutputOutcome, type WorkspaceRename } from "./migrate.js";
import { AGENTS, isAgentId, type AgentId } from "./render.js";
import { createdFiles, detectAgents, executeNotes, noteTargets, planNotes } from "./setup.js";
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

const KNOWN = new Set(Object.values(COMMANDS).flatMap((c) => c.options));

/**
 * Rejects an option the command does not take, or more arguments than it takes, so a mistyped
 * flag or a path with a space in it never runs as if it were absent.
 */
function checkUsage(command: string | undefined, args: Args): void {
  if (command === undefined) {
    for (const flag of args.flags.keys()) if (flag !== "--json") throw new UsageError(`Unknown option ${flag}.\n${nextCommand(["help"])}`);
    return;
  }
  const spec = COMMANDS[command];
  // An unknown command is reported as such.
  if (spec === undefined) return;
  const allowed = spec.options;
  for (const flag of args.flags.keys()) {
    if (flag === "--json" || allowed.includes(flag)) continue;
    const takes = allowed.length === 0 ? "It takes no options." : `It takes ${allowed.join(", ")}.`;
    const message = KNOWN.has(flag) ? `\`${command}\` does not take ${flag}. ${takes}` : `Unknown option ${flag}.`;
    throw new UsageError(`${message}\n${nextCommand(["help"])}`);
  }
  // A scope option takes the place of the folder.
  const scope = ["--global", "--all"].find((flag) => args.flags.has(flag));
  const most = spec.arguments - (scope === undefined ? 0 : 1);
  const extra = args.positional.slice(1);
  if (extra.length <= most) return;
  const takes = most === 0 ? "takes no arguments" : `takes at most ${most} argument${most === 1 ? "" : "s"}`;
  const usage = usageOf(command);
  const lines = [
    `\`${command}\`${scope === undefined ? "" : ` with ${scope}`} ${takes}; got ${extra.length}: ${extra.map((a) => `'${a}'`).join(", ")}.`,
    ...(usage.length > 0 ? [`Usage: ${usage.join("\n       ")}`] : []),
  ];
  throw new UsageError(`${lines.join("\n")}\n${nextCommand(["help"])}`);
}

/** The command's usage lines, as `--help` prints them. */
function usageOf(command: string): string[] {
  return HELP.split("\n")
    .filter((line) => line.startsWith(`  ${COMMAND} ${command} `) || line === `  ${COMMAND} ${command}`)
    .map((line) => line.trim().split(/\s{2,}/)[0]!);
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
  if (previous === null) return { folder, ...(target.global ? { global: target.global } : {}), result: "not-installed" };
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

/** `--all` is every registered folder plus the global install, if there is one; `--global` (status) is the global install. */
async function targets(args: Args): Promise<Target[]> {
  if (args.flags.has("--global")) return [await globalTarget()];
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

const DONE = { create: "created", change: "changed", delete: "deleted" } as const;

/** One instruction file, what happens (or happened) to it, and whether Git tracks it (ISC-86). */
function instructionLine(file: InstructionChange, when: "planned" | "done"): string {
  return `${file.path}: ${when === "planned" ? "will be " : ""}${DONE[file.action]}; ${file.tracked ? "tracked" : "not tracked"} by Git.`;
}

/** After a run that wrote: each instruction file it created, changed, or deleted. */
function changedInstructionLines(files: readonly InstructionChange[] | undefined): string[] {
  if (files === undefined || files.length === 0) return [];
  return ["  Instruction files:", ...files.map((file) => `    - ${instructionLine(file, "done")}`)];
}

function describe(outcome: Outcome, mode: "apply" | "status", args: Args): string {
  const where = outcome.global ? "User level" : display(outcome.folder);
  const at = outcome.global ? "at user level" : `in ${where}`;
  const from = outcome.global ? "from user level" : `from ${where}`;
  const who = outcome.agents?.map((id) => AGENTS[id].name).join(", ");
  const what = outcome.profile === undefined ? "" : `'${outcome.profile}'${who ? ` for ${who}` : ""}`;
  const written = (line: string) => [line, ...changedInstructionLines(outcome.instructions)].join("\n");
  switch (outcome.result) {
    case "installed":
      return written(`Installed ${what} ${at}.`);
    case "updated":
      return mode === "status"
        ? `${where}: ${what} is out of date.\n${(outcome.changed ?? []).map((path) => `  - ${path}`).join("\n")}\n${nextCommand(nextArgs(outcome, args, mode))}`
        : written(`Updated ${what} ${at} (${outcome.changed?.length ?? 0} changed).`);
    case "removed":
      return written(`Removed ${what} ${from}.`);
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
      const files = (outcome.instructions ?? []).map((file) => `    - ${instructionLine(file, "planned")}`);
      const listed = files.length > 0 ? `\n  Instruction files:\n${files.join("\n")}` : "";
      return `${lead}\n${lines.join("\n")}${listed}\n  Only after the user agrees:\n  ${nextCommand(nextArgs(outcome, args, mode))}`;
    }
  }
}

/** Until setup has run, init and workspace name it as the next step: agents follow command output. */
function setupHint(config: { readonly notes?: Readonly<Record<string, unknown>> }): string | null {
  return Object.keys(config.notes ?? {}).length > 0 ? null : `${nextCommand(["setup"])} so your agents know about apkit.`;
}

function selectionProblems(workspace: Workspace): string[] {
  return workspace.violations.length === 0
    ? []
    : ["It has problems:", ...workspace.violations.map((v) => `  - ${v.message}`), BLOCKED, CONTRACT_POINTER];
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

/** Text for one migration. */
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
      const files = migration.instructions.map((file) => instructionLine(file, "planned"));
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
        ...changedInstructionLines(migration.instructions),
        ...trustLines(migration.trust, migration.folder).map((line) => `  ${line}`),
      ];
  }
}

function describeRename(rename: WorkspaceRename | undefined): string[] {
  if (rename === undefined) return [];
  if (rename.result === "renamed") return [`  Renamed ${display(rename.from)} to ${display(rename.to)}; the content is unchanged.`];
  return [
    "  Nothing changed. Needs a decision:",
    `  - Rename ${display(rename.from)} to ${display(rename.to)}; the content stays the same. This apkit finds a Workspace by its apkit-workspace.yaml file.`,
  ];
}

/** After a run that changed things: the Workspace it selected and its problems, or why it selected none. */
function selectionLines(run: Extract<MigrationRun, { found: true }>): string[] {
  if (run.planOnly) return [];
  const select = `Select your Workspace: \`${COMMAND} workspace <path>\`.`;
  if (run.workspace === null) return [`The old apkit named no Workspace, so none was selected. ${select}`];
  if (!run.workspace.selected) return [`${display(run.workspace.path)} is not a Workspace, so it was not selected. ${select}`];
  const problems = run.loaded?.violations ?? [];
  return problems.length === 0 ? [] : ["The selected Workspace has problems:", ...problems.map((v) => `  - ${v.message}`), BLOCKED, CONTRACT_POINTER];
}

/** `apkit migrate`: runs the migration, then renders its record and picks the exit code. */
async function migrateCommand(args: Args, decisions: Decisions, json: boolean): Promise<number> {
  const flag = args.flags.get("--workspace");
  const run = await migrate({ home: homedir(), decisions, ...(typeof flag === "string" ? { workspace: resolve(flag) } : {}) });
  const { state } = run;
  if (!run.found) {
    if (json) console.log(JSON.stringify({ state, found: false, projects: [], backup: run.renamed ? { path: run.backup, result: "renamed" } : run.backup }, null, 2));
    else if (run.renamed) console.log(`Nothing to migrate: ${display(state)} holds no old apkit records. Renamed it to ${display(run.backup!)}, unchanged, as a backup.`);
    else if (run.backup !== null) console.log(`Nothing to migrate: the old apkit state was already migrated. It is kept as a backup at ${display(run.backup)}.`);
    else console.log(`Nothing to migrate: there is no old apkit state at ${display(state)}.`);
    return EXIT.ok;
  }
  const { projects, planOnly, workspace } = run;
  const backup = run.backup.path;
  const open = projects.filter((p) => p.result === "needs-decision" || p.result === "waiting" || p.result === "error");
  if (json) {
    console.log(JSON.stringify({ state, found: true, workspace, projects, backup: run.backup }, null, 2));
  } else {
    const missing = projects.filter((p) => p.result === "missing").map((p) => display(p.folder));
    console.log(
      [
        INTRODUCTION,
        `Migrating from the old apkit, whose records are in ${display(state)}.`,
        `This apkit keeps each Project's installation in the Project itself, in ${MANIFEST_PATH}.`,
        `Workspace: ${workspace === null ? "none named" : display(workspace.path)}`,
        ...describeRename(workspace?.rename),
        // A planning run ends with one next step for every decision.
        ...projects.flatMap((project) => describeMigration(project, !planOnly)),
        ...(planOnly ? ["Only after the user agrees to every decision above:", `  ${nextCommand(["migrate", "--yes"])}`] : []),
        ...(missing.length === 0 ? [] : [groupedWarning("these recorded Project folders no longer exist, so they were skipped:", missing)]),
        ...(run.backup.result === "renamed"
          ? [`Renamed ${display(state)} to ${display(backup)}. It keeps the old apkit records, unchanged, as a backup.`]
          : open.length === 0
            ? [`Kept ${display(state)} as it is. It is renamed to ${display(backup)} as a backup after the Workspace decision.`]
            : [
                `Kept ${display(state)} as it is. It is renamed to ${display(backup)} as a backup once these Projects are migrated:`,
                ...open.map((p) => `  - ${display(p.folder)}`),
              ]),
        ...selectionLines(run),
        ...(run.loaded === null ? [] : warningLines(run.loaded)),
      ].join("\n"),
    );
  }
  if (planOnly || open.some((p) => p.result === "needs-decision")) return EXIT.decision;
  return open.some((p) => p.result === "error") ? EXIT.error : EXIT.ok;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

/** Commands that can write. */
const WRITES = new Set(["init", "workspace", "install", "update", "remove", "setup", "migrate"]);

/**
 * Whether this run takes the lock. Taking it creates the apkit home, so a run that cannot write never
 * takes it (ISC-25.1): `--help` only prints, `workspace` without a path only reads, and `init` without
 * a path stops with a usage error.
 */
function locks(command: string | undefined, args: Args): boolean {
  if (command === undefined || !WRITES.has(command) || args.flags.has("--help")) return false;
  return (command !== "init" && command !== "workspace") || args.positional[1] !== undefined;
}

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
  const args = parseArgs(argv);
  const command = args.positional[0];
  const state = oldStateFolder(homedir());
  unmigrated = (await exists(state)) ? state : null;
  // Before the lock, so a rejected option or argument writes nothing.
  if (!args.flags.has("--help")) checkUsage(command, args);
  return locks(command, args) ? withLock(configHome(), () => run(argv)) : run(argv);
}

async function run(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const json = args.flags.has("--json");
  const decisions: Decisions = { yes: args.flags.has("--yes"), overwrite: args.flags.has("--overwrite") };
  const command = args.positional[0];
  if (args.flags.has("--help")) {
    console.log(unmigrated === null ? HELP : `${HELP}\n${migrationNotice(unmigrated)}`);
    return EXIT.ok;
  }
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
      return command === "help" ? EXIT.ok : EXIT.usage;

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
      const workspace = await loadWorkspace(root);
      const config = await readConfig();
      await writeConfig({ ...config, workspace: root });
      const next = setupHint(config);
      const valid = workspace.violations.length === 0;
      const additions = added.length > 0 ? ` (added ${added.join(", ")})` : "";
      const receipt = valid ? `Workspace ready at ${display(root)}${additions}.` : `Selected the Workspace at ${display(root)}${additions}.`;
      print(
        [INTRODUCTION, receipt, ...selectionProblems(workspace), ...warningLines(workspace), ...(next ? [next] : [])].join("\n"),
        {
          workspace: root,
          added,
          valid,
          violations: workspace.violations,
          warnings: workspace.warnings,
          next,
          ...(!valid ? { contract: `${COMMAND} contract` } : {}),
        },
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
      const problems = selectionProblems(workspace);
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
      return migrateCommand(args, decisions, json);

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
