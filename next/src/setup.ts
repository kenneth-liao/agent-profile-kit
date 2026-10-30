// A short note in each agent's user-level instructions, so every session knows
// the user's Skills and Context come from apkit and where to learn more. The
// note names only the guide command, so a newer guide never makes it stale.
// It uses the same marked section and safety rules as project installs.
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { COMMAND } from "./guide.js";
import { atomicWrite, hash, type Issue } from "./install.js";
import { readBlock, writeBlock } from "./instructions.js";
import type { AgentId } from "./render.js";

export const NOTE =
  "The user's Skills and Context are managed from one Workspace by apkit (Agent Profile Kit).\n" +
  `Before creating or changing Skills, Context, Profiles, or the instruction files apkit installs, run \`${COMMAND} guide\` and follow it.\n`;

/** What setup recorded for each file it wrote, by absolute path. */
export type NoteRecords = Readonly<Record<string, { readonly hash: string; readonly created: boolean }>>;

export interface NoteTarget {
  readonly path: string;
  readonly agents: readonly AgentId[];
}

type Env = Readonly<Record<string, string | undefined>>;

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** Each agent's user-level folder; an agent counts as installed when it exists. */
function agentHome(agent: AgentId, home: string, env: Env): string {
  switch (agent) {
    case "claude":
      return env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
    case "codex":
      return env.CODEX_HOME ?? join(home, ".codex");
    case "opencode":
      return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode");
    case "pi":
      return env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
    case "grok":
      return env.GROK_HOME ?? join(home, ".grok");
    case "antigravity":
      return join(home, ".gemini", "antigravity");
  }
}

export async function detectAgents(home: string, env: Env): Promise<AgentId[]> {
  const all: AgentId[] = ["antigravity", "claude", "codex", "grok", "opencode", "pi"];
  const found: AgentId[] = [];
  for (const agent of all) if (await exists(agentHome(agent, home, env))) found.push(agent);
  return found;
}

/** The user-level file each agent reads, verified per agent (see the prototype's README). */
async function noteFile(agent: AgentId, home: string, env: Env): Promise<string> {
  const dir = agentHome(agent, home, env);
  switch (agent) {
    case "claude":
      return join(dir, "CLAUDE.md");
    case "codex":
    case "pi": {
      // An override file replaces AGENTS.md in the same folder.
      const override = join(dir, "AGENTS.override.md");
      return (await exists(override)) ? override : join(dir, "AGENTS.md");
    }
    case "opencode": {
      // OpenCode reads only the first of these that exists. Creating its own
      // AGENTS.md would hide the user's ~/.claude/CLAUDE.md from it.
      const own = join(dir, "AGENTS.md");
      const claude = join(agentHome("claude", home, env), "CLAUDE.md");
      return !(await exists(own)) && (await exists(claude)) ? claude : own;
    }
    case "grok":
      return join(dir, "rules", "apkit.md");
    case "antigravity":
      return join(home, ".gemini", "AGENTS.md");
  }
}

export async function noteTargets(agents: readonly AgentId[], home: string, env: Env): Promise<NoteTarget[]> {
  const byPath = new Map<string, AgentId[]>();
  for (const agent of agents) {
    const path = await noteFile(agent, home, env);
    byPath.set(path, [...(byPath.get(path) ?? []), agent]);
  }
  return [...byPath].map(([path, owners]) => ({ path, agents: owners }));
}

export interface NotePlan {
  readonly ops: readonly { readonly path: string; readonly text: string | null }[];
  readonly issues: readonly Issue[];
  readonly records: NoteRecords;
}

/** Plans adding the note to `targets` and removing it from recorded files that are no longer targets. */
export async function planNotes(targets: readonly NoteTarget[], recorded: NoteRecords): Promise<NotePlan> {
  const ops: { path: string; text: string | null }[] = [];
  const issues: Issue[] = [];
  const records: Record<string, { hash: string; created: boolean }> = {};
  const want = hash(NOTE);
  const wanted = new Set(targets.map((t) => t.path));

  for (const { path } of targets) {
    const text = await readText(path);
    const block = text === null ? null : readBlock(text);
    const was = recorded[path];
    records[path] = { hash: want, created: was?.created ?? text === null };
    if (block !== null && hash(block) === want) continue;
    if (text === null) {
      issues.push({ kind: "consent", path, message: `Create ${path} with a short note about apkit.` });
    } else if (block === null) {
      issues.push({ kind: "consent", path, message: `Add a short marked note about apkit to ${path}.` });
    } else if (was === undefined || hash(block) !== was.hash) {
      issues.push({ kind: was === undefined ? "unowned" : "changed", path, message: `The apkit note in ${path} was changed.` });
    }
    ops.push({ path, text: writeBlock(text, NOTE) });
  }

  for (const [path, was] of Object.entries(recorded)) {
    if (wanted.has(path)) continue;
    const text = await readText(path);
    const block = text === null ? null : readBlock(text);
    if (text === null || block === null) continue;
    if (hash(block) !== was.hash) {
      issues.push({ kind: "changed", path, message: `The apkit note in ${path} was changed, and would be removed.` });
    }
    const remaining = writeBlock(text, null);
    ops.push({ path, text: was.created && remaining.trim() === "" ? null : remaining });
  }
  return { ops, issues, records };
}

export async function executeNotes(planned: NotePlan): Promise<void> {
  for (const op of planned.ops) {
    // User-level files are often symlinks into a dotfiles repo: write the real file.
    const real = await realpath(op.path).catch(() => op.path);
    if (op.text === null) await unlink(real);
    else await atomicWrite(real, new TextEncoder().encode(op.text));
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
