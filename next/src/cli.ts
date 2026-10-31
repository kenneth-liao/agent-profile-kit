#!/usr/bin/env node
// `apkit-next`: a small, non-interactive command meant to be driven by an agent.
// It never prompts. When a step needs the user's decision it changes nothing,
// lists the decisions (exit 3), and the caller re-runs with --yes or --overwrite.
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { globalManifestPath, readConfig, recordInstall, writeConfig } from "./config.js";
import { COMMAND, GUIDE, HELP } from "./guide.js";
import {
  execute,
  plan,
  readManifest,
  readManifestAt,
  unresolved,
  type Decisions,
  type InstructionChange,
  type Issue,
  type Manifest,
  type Plan,
} from "./install.js";
import { removeGitExclude, syncGitExclude } from "./gitexclude.js";
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
  if (root === undefined) throw new UsageError("No Workspace selected. Run `apkit-next init <path>` or `apkit-next workspace <path>`.");
  return loadWorkspace(root);
}

function requireValid(workspace: Workspace): void {
  if (workspace.violations.length > 0) {
    const lines = workspace.violations.map((v) => `  - ${v.message}`);
    throw new Error(`The Workspace at ${display(workspace.root)} has problems:\n${lines.join("\n")}`);
  }
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
  return target.global ? readManifestAt(globalManifestPath()) : readManifest(target.folder);
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
  if (planned.paths.length === 0 && desired !== null && previous !== null) return { ...base, result: "unchanged" };
  if (planned.sections !== null) await executeNotes(planned.sections);
  await execute(planned.files);
  if (!global) await recordInstall(folder, desired !== null, exclusion);
  const changed = [...new Set(planned.paths)];
  const result = desired === null ? "removed" : previous === null ? "installed" : "updated";
  return { ...base, result, changed };
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
  const base = { folder, ...(target.global ? { global: target.global } : {}), profile: previous.profile, agents: previous.agents };
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
  if (planned.paths.length > 0) return { ...base, result: "updated", instructions: planned.files.instructions, changed: [...new Set(planned.paths)] };
  return { ...base, result: "unchanged" };
}

/** `--all` is every registered folder plus the global install, if there is one. */
async function targets(args: Args): Promise<Target[]> {
  if (!args.flags.has("--all")) return [{ folder: await folderArg(args.positional[1]) }];
  const folders: Target[] = (await readConfig()).installs.map((folder) => ({ folder }));
  const global = await globalTarget();
  return (await stat(globalManifestPath()).then(() => true, () => false)) ? [...folders, global] : folders;
}

function describe(outcome: Outcome, mode: "apply" | "status"): string {
  const where = outcome.global ? "User level" : display(outcome.folder);
  const who = outcome.agents?.map((id) => AGENTS[id].name).join(", ");
  const what = outcome.profile === undefined ? "" : `'${outcome.profile}'${who ? ` for ${who}` : ""}`;
  switch (outcome.result) {
    case "installed":
      return `Installed ${what} in ${where}.`;
    case "updated":
      return mode === "status"
        ? `${where}: ${what} is out of date (${outcome.changed?.length ?? 0} to update). Run \`apkit-next update\`.`
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
      const yes = [
        outcome.issues?.some((i) => i.kind === "consent") ? "the edits to your instruction files" : null,
        outcome.issues?.some((i) => i.kind === "outside") ? "the writes outside this folder" : null,
      ].filter((what) => what !== null);
      const flags = [
        yes.length > 0 ? `--yes to allow ${yes.join(" and ")}` : null,
        outcome.issues?.some((i) => i.kind === "changed" || i.kind === "unowned") ? "--overwrite to replace the changed files" : null,
      ].filter((flag) => flag !== null);
      const lead = mode === "status" ? `${where}: needs a decision before updating:` : `${where}: nothing changed. Needs a decision:`;
      const files = (outcome.instructions ?? []).map(
        (file) =>
          `    - ${file.path}: will be ${file.action === "create" ? "created" : file.action === "delete" ? "deleted" : "changed"}; ${file.tracked ? "tracked" : "not tracked"} by Git.`,
      );
      const listed = files.length > 0 ? `\n  Instruction files:\n${files.join("\n")}` : "";
      return `${lead}\n${lines.join("\n")}${listed}\n  Re-run with ${flags.join(" and ")}.`;
    }
  }
}

/** Until setup has run, init and workspace name it as the next step: agents follow command output. */
function setupHint(config: { readonly notes?: Readonly<Record<string, unknown>> }): string | null {
  return Object.keys(config.notes ?? {}).length > 0 ? null : `Next: run \`${COMMAND} setup\` so your agents know about apkit.`;
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

function trustLines(needs: readonly TrustNeed[]): string[] {
  const names = (kind: TrustNeed["untilTrusted"]) => needs.filter((n) => n.untilTrusted === kind).map((n) => AGENTS[n.agent].name);
  const list = (items: readonly string[]) =>
    items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const skills = names("skills");
  const everything = names("everything");
  return [
    skills.length === 0 ? null : `${list(skills)} ${skills.length === 1 ? "loads" : "load"} this folder's Skills only after you trust the folder.`,
    everything.length === 0 ? null : `${list(everything)} ${everything.length === 1 ? "loads" : "load"} nothing from this folder until you trust it.`,
  ].filter((line) => line !== null);
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const json = args.flags.has("--json");
  const decisions: Decisions = { yes: args.flags.has("--yes"), overwrite: args.flags.has("--overwrite") };
  const command = args.positional[0];
  // A configuration from a newer apkit stops every command before anything is written.
  if (command !== undefined && command !== "help" && command !== "guide") await readConfig();
  const print = (text: string, data: unknown) => console.log(json ? JSON.stringify(data, null, 2) : text);

  switch (command) {
    case undefined:
    case "help":
      console.log(HELP);
      return args.flags.has("--help") || command === "help" ? EXIT.ok : EXIT.usage;

    case "guide":
      console.log(GUIDE);
      return EXIT.ok;

    case "init": {
      const path = args.positional[1];
      if (path === undefined) throw new UsageError("Name the Workspace folder: `apkit-next init <path>`.");
      const root = resolve(path);
      const added = await initWorkspace(root);
      const config = await readConfig();
      await writeConfig({ ...config, workspace: root });
      const next = setupHint(config);
      print(
        `Workspace ready at ${display(root)}${added.length > 0 ? ` (added ${added.join(", ")})` : ""}.${next ? `\n${next}` : ""}`,
        { workspace: root, added, next },
      );
      return EXIT.ok;
    }

    case "workspace": {
      const path = args.positional[1];
      if (path === undefined) {
        const current = (await readConfig()).workspace;
        print(current === undefined ? "No Workspace selected." : display(current), { workspace: current ?? null });
        return EXIT.ok;
      }
      const workspace = await loadWorkspace(resolve(path));
      const unmarked = workspace.violations.find((v) => v.code === "workspace-missing-manifest" || v.code === "workspace-old-manifest");
      if (unmarked?.code === "workspace-old-manifest") throw new Error(`${display(workspace.root)}: ${unmarked.message}`);
      if (unmarked !== undefined) {
        throw new Error(`${display(workspace.root)} is not a Workspace. Run \`apkit-next init ${path}\` to make it one.`);
      }
      const config = await readConfig();
      await writeConfig({ ...config, workspace: workspace.root });
      const next = setupHint(config);
      print(`Selected the Workspace at ${display(workspace.root)}.${next ? `\n${next}` : ""}`, { workspace: workspace.root, next });
      return EXIT.ok;
    }

    case "check": {
      const workspace = await workspaceFor(args);
      const data = {
        workspace: workspace.root,
        valid: workspace.violations.length === 0,
        violations: workspace.violations,
        profiles: [...workspace.profiles.values()],
        skills: [...workspace.skills.keys()],
        context: [...workspace.context.keys()],
      };
      const lines =
        workspace.violations.length > 0
          ? [`The Workspace at ${display(workspace.root)} has problems:`, ...workspace.violations.map((v) => `  - ${v.message}`)]
          : [
              `The Workspace at ${display(workspace.root)} is valid.`,
              ...[...workspace.profiles.values()].map(
                (p) => `  ${p.id}: ${p.context.length} context, ${p.skills.length} skills`,
              ),
            ];
      print(lines.join("\n"), data);
      return workspace.violations.length > 0 ? EXIT.error : EXIT.ok;
    }

    case "install": {
      const profile = args.positional[1];
      if (profile === undefined) throw new UsageError("Name the Profile: `apkit-next install <profile> [folder] --agents <a,b>`.");
      const global = args.flags.has("--global");
      const target = global ? await globalTarget() : { folder: await folderArg(args.positional[2]) };
      const workspace = await workspaceFor(args);
      requireValid(workspace);
      const previous = await previousAt(target);
      const agents = agentsFlag(args, previous?.profile === profile ? previous.agents : undefined);
      const desired = renderFor(workspace, profile, agents, global ? "user" : undefined);
      const outcome = await apply(target, desired, previous, decisions);
      const trust = outcome.result === "needs-decision" ? [] : trustNeeds(desired);
      print([describe(outcome, "apply"), ...trustLines(trust)].join("\n"), { ...outcome, trust });
      return outcome.result === "needs-decision" ? EXIT.decision : EXIT.ok;
    }

    case "update": {
      const workspace = await workspaceFor(args);
      requireValid(workspace);
      const outcomes: Outcome[] = [];
      for (const target of await targets(args)) {
        const status = await statusOf(workspace, target);
        if (status.result === "missing" || status.result === "error" || status.result === "not-installed") {
          outcomes.push(status);
          continue;
        }
        const previous = await previousAt(target);
        const desired = renderFor(workspace, previous!.profile, previous!.agents, previous!.scope);
        outcomes.push(await apply(target, desired, previous, decisions));
      }
      print(outcomes.map((o) => describe(o, "apply")).join("\n") || "Nothing is installed yet.", outcomes);
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
        print(describe(outcome, "apply"), outcome);
        return outcome.result === "needs-decision" ? EXIT.decision : EXIT.ok;
      }
      const path = resolve(args.positional[1] ?? process.cwd());
      const exists = await stat(path).then((s) => s.isDirectory(), () => false);
      if (!exists) {
        const exclusion = (await readConfig()).exclusions?.[path];
        if (exclusion !== undefined) await removeGitExclude(exclusion, path);
        await recordInstall(path, false);
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
      print(describe(outcome, "apply"), outcome);
      return outcome.result === "needs-decision" ? EXIT.decision : EXIT.ok;
    }

    case "setup": {
      const config = await readConfig();
      const remove = args.flags.has("--remove");
      const detected = await detectAgents(homedir(), process.env);
      const agents = remove ? [] : args.flags.has("--agents") ? agentsFlag(args, undefined) : detected;
      if (!remove && agents.length === 0) {
        print("No supported agents found on this machine. Name them with --agents.", { result: "no-agents" });
        return EXIT.error;
      }
      const targets = await noteTargets(agents, homedir(), process.env);
      const global = await previousAt(await globalTarget());
      const planned = await planNotes(targets, config.notes ?? {}, createdFiles(global?.sections));
      const open = planned.issues.filter((issue) => (issue.kind === "consent" ? !decisions.yes : !decisions.overwrite));
      const files = targets.map((t) => ({ path: t.path, agents: t.agents }));
      if (open.length > 0) {
        const outcome: Outcome = { folder: homedir(), result: "needs-decision", issues: open };
        print(describe(outcome, "apply"), { result: "needs-decision", issues: open, files });
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

    case "status": {
      const workspace = await workspaceFor(args);
      const outcomes: Outcome[] = [];
      for (const target of await targets(args)) outcomes.push(await statusOf(workspace, target));
      print(outcomes.map((o) => describe(o, "status")).join("\n") || "Nothing is installed yet.", outcomes);
      return EXIT.ok;
    }

    default:
      throw new UsageError(`Unknown command '${command}'. Run \`apkit-next help\`.`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    process.exitCode = error instanceof UsageError ? EXIT.usage : EXIT.error;
  },
);
