#!/usr/bin/env node
// `apkit-next`: a small, non-interactive command meant to be driven by an agent.
// It never prompts. When a step needs the user's decision it changes nothing,
// lists the decisions (exit 3), and the caller re-runs with --yes or --overwrite.
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { readConfig, recordInstall, writeConfig } from "./config.js";
import { COMMAND, GUIDE, HELP } from "./guide.js";
import { execute, plan, readManifest, unresolved, type Decisions, type Issue, type Manifest } from "./install.js";
import { syncGitExclude } from "./gitexclude.js";
import { AGENTS, isAgentId, render, userRoots, type AgentId, type Desired } from "./render.js";
import { detectAgents, executeNotes, noteTargets, planNotes } from "./setup.js";
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
  readonly result: "installed" | "updated" | "removed" | "unchanged" | "needs-decision" | "not-installed" | "missing" | "error";
  readonly profile?: string;
  readonly agents?: readonly AgentId[];
  readonly issues?: readonly Issue[];
  readonly changed?: readonly string[];
  readonly message?: string;
}

async function apply(
  folder: string,
  desired: Desired | null,
  previous: Manifest | null,
  decisions: Decisions,
): Promise<Outcome> {
  const planned = await plan(folder, desired, previous);
  const open = unresolved(planned, decisions);
  const base = { folder, profile: desired?.profile ?? previous?.profile, agents: desired?.agents ?? previous?.agents };
  if (open.length > 0) return { ...base, result: "needs-decision", issues: open };
  await syncGitExclude(folder, planned.manifest);
  if (planned.ops.length === 0 && desired !== null && previous !== null) return { ...base, result: "unchanged" };
  await execute(planned);
  await recordInstall(folder, desired !== null);
  const changed = [...new Set(planned.ops.map((op) => op.path))];
  const result = desired === null ? "removed" : previous === null ? "installed" : "updated";
  return { ...base, result, changed };
}

/** Renders for a project folder, or (scope "user") for the home folder's user-level Skills folders. */
function renderFor(workspace: Workspace, profile: string, agents: readonly AgentId[], scope?: "user"): Desired {
  if (scope === undefined) return render(workspace, profile, agents);
  if ((workspace.profiles.get(profile)?.context.length ?? 0) > 0) {
    throw new UsageError(
      `Profile '${profile}' has Context, which is installed per project. Use --global with a Skills-only Profile.`,
    );
  }
  return { ...render(workspace, profile, agents, userRoots(homedir(), process.env)), scope };
}

async function statusOf(workspace: Workspace, folder: string): Promise<Outcome> {
  try {
    if (!(await stat(folder)).isDirectory()) throw new Error();
  } catch {
    return { folder, result: "missing", message: "The folder no longer exists." };
  }
  const previous = await readManifest(folder);
  if (previous === null) return { folder, result: "not-installed" };
  const base = { folder, profile: previous.profile, agents: previous.agents };
  if (!workspace.profiles.has(previous.profile)) {
    return { ...base, result: "error", message: `Profile '${previous.profile}' is no longer in the Workspace.` };
  }
  const planned = await plan(folder, renderFor(workspace, previous.profile, previous.agents, previous.scope), previous);
  if (planned.issues.length > 0) return { ...base, result: "needs-decision", issues: planned.issues };
  if (planned.ops.length > 0) return { ...base, result: "updated", changed: [...new Set(planned.ops.map((op) => op.path))] };
  return { ...base, result: "unchanged" };
}

async function targets(args: Args): Promise<string[]> {
  if (args.flags.has("--all")) return [...(await readConfig()).installs];
  return [await folderArg(args.positional[1])];
}

function describe(outcome: Outcome, mode: "apply" | "status"): string {
  const where = display(outcome.folder);
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
      return `${lead}\n${lines.join("\n")}\n  Re-run with ${flags.join(" and ")}.`;
    }
  }
}

/** Until setup has run, init and workspace name it as the next step: agents follow command output. */
function setupHint(config: { readonly notes?: Readonly<Record<string, unknown>> }): string | null {
  return Object.keys(config.notes ?? {}).length > 0 ? null : `Next: run \`${COMMAND} setup\` so your agents know about apkit.`;
}

const TRUST_NOTE = "Some agents load project instructions only in folders you trust. If an agent asks, trust this folder.";

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const json = args.flags.has("--json");
  const decisions: Decisions = { yes: args.flags.has("--yes"), overwrite: args.flags.has("--overwrite") };
  const command = args.positional[0];
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
      if (workspace.violations.some((v) => v.code === "workspace-missing-manifest")) {
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
      const folder = global ? await realpath(homedir()) : await folderArg(args.positional[2]);
      const workspace = await workspaceFor(args);
      requireValid(workspace);
      const previous = await readManifest(folder);
      const agents = agentsFlag(args, previous?.profile === profile ? previous.agents : undefined);
      const desired = renderFor(workspace, profile, agents, global ? "user" : undefined);
      const outcome = await apply(folder, desired, previous, decisions);
      const note = outcome.result !== "needs-decision" && desired.context !== null ? `\n${TRUST_NOTE}` : "";
      print(describe(outcome, "apply") + note, outcome);
      return outcome.result === "needs-decision" ? EXIT.decision : EXIT.ok;
    }

    case "update": {
      const workspace = await workspaceFor(args);
      requireValid(workspace);
      const outcomes: Outcome[] = [];
      for (const folder of await targets(args)) {
        const status = await statusOf(workspace, folder);
        if (status.result === "missing" || status.result === "error" || status.result === "not-installed") {
          outcomes.push(status);
          continue;
        }
        const previous = await readManifest(folder);
        const desired = renderFor(workspace, previous!.profile, previous!.agents, previous!.scope);
        outcomes.push(await apply(folder, desired, previous, decisions));
      }
      print(outcomes.map((o) => describe(o, "apply")).join("\n") || "Nothing is installed yet.", outcomes);
      if (outcomes.some((o) => o.result === "needs-decision")) return EXIT.decision;
      return outcomes.some((o) => o.result === "error" || o.result === "not-installed") ? EXIT.error : EXIT.ok;
    }

    case "remove": {
      const path = args.flags.has("--global") ? homedir() : resolve(args.positional[1] ?? process.cwd());
      const exists = await stat(path).then((s) => s.isDirectory(), () => false);
      if (!exists) {
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
      const outcome = await apply(folder, null, previous, decisions);
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
      const planned = await planNotes(targets, config.notes ?? {});
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
      for (const folder of await targets(args)) outcomes.push(await statusOf(workspace, folder));
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
