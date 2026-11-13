// A short note in each agent's user-level instructions, so every session knows
// the user's Skills and Context come from apkit and where to learn more. The
// note names only the guide command, so a newer guide never makes it stale.
// It uses the same marked section and safety rules as project installs.
// `install --global` puts a Profile's Context in the same files, in a section
// of its own, through the same planner.
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { COMMAND } from "./guide.js";
import { atomicWrite, hash, missingFolders, removeEmptyFolders, type Issue } from "./install.js";
import { readBlock, writeBlock, type Marker } from "./instructions.js";
import type { AgentId } from "./render.js";

export const NOTE =
  "The user's Skills and Context are managed from one Workspace by apkit (Agent Profile Kit).\n" +
  `Before creating or changing Skills, Context, Profiles, or the instruction files apkit installs, run \`${COMMAND} guide\` and follow it.\n`;

/**
 * What apkit recorded for each user-level file it wrote, by absolute path: the section's hash, whether
 * apkit created the file, and the folders it created to hold it (deepest first; absent when none).
 */
export type NoteRecords = Readonly<Record<string, NoteRecord>>;
export interface NoteRecord {
  readonly hash: string;
  readonly created: boolean;
  readonly createdDirs?: readonly string[];
}

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

/** The user-level file each agent reads, verified per agent (see docs/ARCHITECTURE.md, Verified Locations). */
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
    case "opencode":
      // OpenCode does not read ~/.claude/CLAUDE.md, so it always gets its own file.
      return join(dir, "AGENTS.md");
    case "grok":
      return join(dir, "rules", "apkit.md");
    case "antigravity":
      return join(home, ".gemini", "AGENTS.md");
  }
}

/** The user-level files for `agents`, one per file, with the agents that read it. */
export async function noteTargets(agents: readonly AgentId[], home: string, env: Env): Promise<NoteTarget[]> {
  const byPath = new Map<string, AgentId[]>();
  for (const agent of agents) {
    const path = await noteFile(agent, home, env);
    byPath.set(path, [...(byPath.get(path) ?? []), agent]);
  }
  return [...byPath].map(([path, owners]) => ({ path, agents: owners }));
}

export interface NotePlan {
  /** `text` null deletes the file, then removes the folders in `prune` that are left empty. */
  readonly ops: readonly { readonly path: string; readonly text: string | null; readonly prune?: readonly string[] }[];
  readonly issues: readonly Issue[];
  readonly records: NoteRecords;
}

/** One kind of marked section in user-level files: the setup note, or a global install's Context. */
export interface Section {
  readonly marker: Marker;
  readonly body: string;
  /** Decision text for creating a file, adding the section, and a changed section. */
  readonly create: (path: string) => string;
  readonly add: (path: string) => string;
  /** Without a final period; removal appends ", and would be removed." */
  readonly changed: (path: string) => string;
}

export const NOTE_SECTION: Section = {
  marker: "apkit",
  body: NOTE,
  create: (path) => `Create ${path} with a short note about apkit.`,
  add: (path) => `Add a short marked note about apkit to ${path}.`,
  changed: (path) => `The apkit note in ${path} was changed`,
};

/** A global install's Context: a section of its own beside the note, so each is added and removed alone. */
export function contextSection(body: string): Section {
  return {
    marker: "apkit:global",
    body,
    create: (path) => `Create ${path} to hold this Profile's Context for every project.`,
    add: (path) => `Add a marked apkit section with this Profile's Context to ${path}.`,
    changed: (path) => `The apkit Context section in ${path} was changed after apkit wrote it`,
  };
}

/** Files apkit created, from section records, with the folders it created to hold each. */
export function createdFiles(records: NoteRecords | undefined): Map<string, readonly string[]> {
  return new Map(
    Object.entries(records ?? {})
      .filter(([, record]) => record.created)
      .map(([path, record]) => [path, record.createdDirs ?? []]),
  );
}

/** Plans adding the note to `targets` and removing it from recorded files that are no longer targets. */
export function planNotes(
  targets: readonly NoteTarget[],
  recorded: NoteRecords,
  alsoCreated?: ReadonlyMap<string, readonly string[]>,
): Promise<NotePlan> {
  return planSections(targets, recorded, NOTE_SECTION, alsoCreated);
}

/**
 * Plans adding `section` to `targets` and removing it from recorded files that are no longer targets.
 * `alsoCreated` lists files apkit created for another kind of section: a file both share is deleted
 * when the last section leaves it, whichever goes last.
 */
export async function planSections(
  targets: readonly NoteTarget[],
  recorded: NoteRecords,
  section: Section,
  alsoCreated: ReadonlyMap<string, readonly string[]> = new Map(),
): Promise<NotePlan> {
  const ops: { path: string; text: string | null; prune?: readonly string[] }[] = [];
  const issues: Issue[] = [];
  const records: Record<string, NoteRecord> = {};
  const want = hash(section.body);
  const wanted = new Set(targets.map((t) => t.path));

  for (const { path } of targets) {
    const text = await readText(path);
    const block = text === null ? null : readBlock(text, section.marker);
    const was = recorded[path];
    // Folders are recorded with the file that needed them, or taken over from the other kind of section.
    const dirs = was?.createdDirs ?? (text === null ? await missingFolders(path) : (alsoCreated.get(path) ?? []));
    records[path] = {
      hash: want,
      created: was?.created ?? (text === null || alsoCreated.has(path)),
      ...(dirs.length > 0 ? { createdDirs: dirs } : {}),
    };
    if (block !== null && hash(block) === want) continue;
    if (text === null) {
      issues.push({ kind: "consent", path, message: section.create(path) });
    } else if (block === null) {
      issues.push({ kind: "consent", path, message: section.add(path) });
    } else if (was === undefined || hash(block) !== was.hash) {
      issues.push({ kind: was === undefined ? "unowned" : "changed", path, message: `${section.changed(path)}.` });
    }
    ops.push({ path, text: writeBlock(text, section.body, section.marker) });
  }

  for (const [path, was] of Object.entries(recorded)) {
    if (wanted.has(path)) continue;
    const text = await readText(path);
    const block = text === null ? null : readBlock(text, section.marker);
    if (text === null || block === null) continue;
    if (hash(block) !== was.hash) {
      issues.push({ kind: "changed", path, message: `${section.changed(path)}, and would be removed.` });
    }
    const remaining = writeBlock(text, null, section.marker);
    if ((was.created || alsoCreated.has(path)) && remaining.trim() === "") {
      ops.push({ path, text: null, prune: [...(was.createdDirs ?? []), ...(alsoCreated.get(path) ?? [])] });
    } else {
      ops.push({ path, text: remaining });
    }
  }
  return { ops, issues, records };
}

export async function executeNotes(planned: NotePlan): Promise<void> {
  for (const op of planned.ops) {
    // User-level files are often symlinks into a dotfiles repo: write the real file.
    const real = await realpath(op.path).catch(() => op.path);
    if (op.text === null) {
      await unlink(real);
      await removeEmptyFolders(op.prune ?? []);
    } else await atomicWrite(real, new TextEncoder().encode(op.text));
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
