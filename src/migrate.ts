// `apkit migrate`: takes each Project the old engine (apkit 0.238 and earlier) left on a
// machine over, behind one entry point (`migrate`). The old engine is gone: its state format,
// output hashes, and Git exclusion block are read here, at the boundary, and nowhere else (ISC-67).
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { COMMAND } from "./command.js";
import { readConfig, writeConfig } from "./config.js";
import { findRepository } from "./gitindex.js";
import { CONTRACT_POINTER } from "./guide.js";
import {
  abs,
  atomicWrite,
  hash as contentHash,
  execute,
  plan,
  readManifest,
  unresolved,
  type Decisions,
  type InstructionChange,
  type Issue,
  type Manifest,
} from "./install.js";
import { apply, planAt, renderFor, trustNeeds, type Outcome, type TrustNeed } from "./location.js";
import { display, nextCommand } from "./output.js";
import { AGENTS, isAgentId, type AgentId, type Desired } from "./render.js";
import { NewerSchemaError, refuseNewer } from "./schema.js";
import { loadWorkspace, type Workspace } from "./workspace.js";

/** The old engine's application folder. It had no override: always under the home folder. */
export function oldStateFolder(home: string): string {
  return join(home, ".agents", "agent-profile-kit");
}

export interface OldOutput {
  /** POSIX path relative to the Project. */
  readonly path: string;
  readonly type: "file" | "directory";
  readonly mode: number;
  /** `sha256:<hex>` as the old engine recorded it. */
  readonly hash: string;
}

export interface OldReceipt {
  readonly project: string;
  readonly profile: string;
  readonly agents: readonly AgentId[];
  readonly lifetime: "ordinary" | "temporary";
  /** Unbound by the old engine: its outputs are still on disk, but it is not installed. */
  readonly retired: boolean;
  readonly outputs: readonly OldOutput[];
}

export interface OldState {
  readonly folder: string;
  readonly workspace: string | undefined;
  readonly receipts: readonly OldReceipt[];
}

const STATE_SCHEMA = 9;
const CONFIG_SCHEMA = 2;
const OLD_HASH = /^sha256:[0-9a-f]{64}$/;

class OldStateError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} is not old apkit state this version understands: ${detail}. Nothing was changed.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A POSIX path inside the Project, as the old engine required. */
function isProjectPath(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !isAbsolute(path) && !/^[A-Za-z]:/.test(path) && !path.includes("\\") &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * The old Local Configuration and receipts, or null when the old engine left no state.
 * Every field that decides a deletion is checked; anything else is refused before a change.
 */
export async function readOldState(home: string): Promise<OldState | null> {
  const folder = oldStateFolder(home);
  const configPath = join(folder, "config.yaml");
  const statePath = join(folder, "state", "manifest.json");
  const configText = await readOptional(configPath);
  const stateText = await readOptional(statePath);
  if (configText === null && stateText === null) return null;

  let workspace: string | undefined;
  if (configText !== null) {
    let config: unknown;
    try {
      config = parseYaml(configText);
    } catch {
      throw new OldStateError(configPath, "it is not valid YAML");
    }
    if (!isRecord(config)) throw new OldStateError(configPath, "it is not a mapping");
    refuseNewer(config.schema_version, CONFIG_SCHEMA, configPath);
    if (config.workspace !== undefined && typeof config.workspace !== "string") throw new OldStateError(configPath, "workspace is not a path");
    workspace = config.workspace === undefined ? undefined : resolve(config.workspace as string);
  }

  const receipts: OldReceipt[] = [];
  if (stateText !== null) {
    let state: unknown;
    try {
      state = JSON.parse(stateText);
    } catch {
      throw new OldStateError(statePath, "it is not valid JSON");
    }
    if (!isRecord(state)) throw new OldStateError(statePath, "it is not an object");
    refuseNewer(state.schema_version, STATE_SCHEMA, statePath);
    if (!Array.isArray(state.receipts)) throw new OldStateError(statePath, "receipts is not a list");
    for (const [index, value] of state.receipts.entries()) receipts.push(parseReceipt(value, `${statePath} receipts[${index}]`, statePath));
  }
  return { folder, workspace, receipts };
}

function parseReceipt(value: unknown, where: string, file: string): OldReceipt {
  const fail = (detail: string) => new OldStateError(file, `${where} ${detail}`);
  if (!isRecord(value)) throw fail("is not an object");
  const { project, profile_id: profile, hosts, lifetime, retired, outputs } = value;
  if (typeof project !== "string" || !isAbsolute(project)) throw fail("project is not an absolute path");
  if (typeof profile !== "string" || profile === "") throw fail("profile_id is missing");
  if (lifetime !== "ordinary" && lifetime !== "temporary") throw fail("lifetime is not 'ordinary' or 'temporary'");
  if (retired !== undefined && retired !== true) throw fail("retired is not true");
  if (!isRecord(hosts) || Object.keys(hosts).length === 0 || !Object.keys(hosts).every(isAgentId)) throw fail("hosts names an unknown agent");
  if (!Array.isArray(outputs)) throw fail("outputs is not a list");
  const parsed = outputs.map((output, index): OldOutput => {
    if (!isRecord(output)) throw fail(`outputs[${index}] is not an object`);
    const { path, type, mode, hash } = output;
    if (!isProjectPath(path)) throw fail(`outputs[${index}] path is not inside the Project`);
    if (type !== "file" && type !== "directory") throw fail(`outputs[${index}] type is not 'file' or 'directory'`);
    if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o777) throw fail(`outputs[${index}] mode is not a permission mode`);
    if (typeof hash !== "string" || !OLD_HASH.test(hash)) throw fail(`outputs[${index}] hash is not a SHA-256 hash`);
    return { path, type, mode, hash };
  });
  const paths = parsed.map((output) => output.path);
  // A recorded root inside another recorded root would delete one output through the other.
  if (paths.some((path) => paths.some((other) => other !== path && path.startsWith(`${other}/`)))) throw fail("outputs nest inside each other");
  return {
    project: resolve(project),
    profile,
    agents: Object.keys(hosts).filter(isAgentId).sort(),
    lifetime,
    retired: retired === true,
    outputs: parsed,
  };
}

/** The old file hash: SHA-256 of the exact bytes, without the new engine's CRLF normalization. */
export async function oldFileHash(path: string): Promise<string> {
  return `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
}

function frame(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = Buffer.from(value);
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

interface Member {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly mode: number;
}

/** Every member under `root`, or null when one is a symlink or anything but a file or folder. */
async function members(root: string, prefix = ""): Promise<Member[] | null> {
  const found: Member[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const info = await lstat(join(root, entry.name));
    if (info.isSymbolicLink() || !(info.isFile() || info.isDirectory())) return null;
    found.push({ path, type: info.isDirectory() ? "directory" : "file", mode: info.mode & 0o7777 });
    if (info.isDirectory()) {
      const inner = await members(join(root, entry.name), path);
      if (inner === null) return null;
      found.push(...inner);
    }
  }
  return found;
}

/**
 * The old aggregate hash of a generated folder (0.238.0 `hashDirectoryMembersFromFiles`):
 * framed type, path, mode, and file bytes for every member, sorted with `localeCompare`.
 * Null when the folder holds a symlink or another kind of entry, which never matched.
 */
export async function hashOldDirectory(root: string): Promise<string | null> {
  const found = await members(root);
  if (found === null) return null;
  const hash = createHash("sha256");
  for (const member of found.sort((a, b) => a.path.localeCompare(b.path))) {
    frame(hash, member.type);
    frame(hash, member.path);
    frame(hash, String(member.mode));
    if (member.type === "file") frame(hash, await readFile(abs(root, member.path)));
  }
  return `sha256:${hash.digest("hex")}`;
}

export interface OldOutputState {
  readonly result: "unchanged" | "missing" | "changed";
  /** For an unchanged output: each file it holds (POSIX, from the Project) and its new-engine hash. */
  readonly files?: Readonly<Record<string, string>>;
}

/** Whether an old output is still exactly what the old engine wrote: same type, mode, and hash. */
export async function inspectOldOutput(project: string, output: OldOutput): Promise<OldOutputState> {
  const path = abs(project, output.path);
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { result: "missing" };
    throw error;
  }
  if ((info.mode & 0o7777) !== output.mode) return { result: "changed" };
  if (output.type === "file") {
    if (!info.isFile() || (await oldFileHash(path)) !== output.hash) return { result: "changed" };
    return { result: "unchanged", files: { [output.path]: contentHash(await readFile(path)) } };
  }
  if (!info.isDirectory() || (await hashOldDirectory(path)) !== output.hash) return { result: "changed" };
  const files: Record<string, string> = {};
  for (const member of (await members(path)) ?? []) {
    if (member.type !== "file") continue;
    files[`${output.path}/${member.path}`] = contentHash(await readFile(abs(path, member.path)));
  }
  return { result: "unchanged", files };
}

/**
 * Whether this engine already owns everything at an old output's path: each file in it is
 * recorded in `owned` (a manifest's files) with its current hash, and nothing else is there.
 * An earlier `migrate` replaced it, so it is not a change the user made.
 */
export async function takenOver(project: string, output: OldOutput, owned: Readonly<Record<string, string>>): Promise<boolean> {
  const path = abs(project, output.path);
  const info = await lstat(path).catch(() => null);
  if (info === null) return false;
  const matches = async (relativePath: string) => owned[relativePath] !== undefined && owned[relativePath] === contentHash(await readFile(abs(project, relativePath)));
  if (info.isFile()) return matches(output.path);
  if (!info.isDirectory()) return false;
  const found = await members(path);
  const files = (found ?? []).filter((member) => member.type === "file");
  if (found === null || files.length === 0) return false;
  for (const member of files) if (!(await matches(`${output.path}/${member.path}`))) return false;
  return true;
}

/** The entries the old engine listed for a Project `relativeProject` (POSIX, from the repository root) deep. */
export function oldExcludeEntries(relativeProject: string, outputs: readonly OldOutput[]): string[] {
  return outputs.map((output) => `/${[relativeProject, output.path].filter((part) => part !== "").join("/")}`);
}

const BEGIN = "# BEGIN Agent Profile Kit generated paths";
const BEGIN_WITH_SEPARATOR = `${BEGIN} (separator owned)`;
const END = "# END Agent Profile Kit generated paths";
const SEPARATOR = "# Agent Profile Kit generated paths separator";

interface Line {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly newline: string;
}

function lines(source: string): Line[] {
  const result: Line[] = [];
  let start = 0;
  while (start < source.length) {
    const lf = source.indexOf("\n", start);
    if (lf === -1) {
      result.push({ text: source.slice(start), start, end: source.length, newline: "" });
      break;
    }
    const crlf = lf > start && source[lf - 1] === "\r";
    result.push({ text: source.slice(start, crlf ? lf - 1 : lf), start, end: lf + 1, newline: crlf ? "\r\n" : "\n" });
    start = lf + 1;
  }
  return result;
}

/** The entries the old engine's block in an exclude file holds now: empty without a block. */
export function oldBlockEntries(source: Buffer): string[] {
  const all = lines(source.toString("latin1"));
  const begin = all.findIndex((line) => line.text === BEGIN || line.text === BEGIN_WITH_SEPARATOR);
  const end = all.findIndex((line) => line.text === END);
  if (begin === -1 || end < begin) return [];
  return all.slice(begin + 1, end).map((line) => Buffer.from(line.text, "latin1").toString("utf8"));
}

/**
 * Rewrites the old engine's one block in an exclude file to hold `entries` (the other old
 * Projects' entries), or removes it, with the separator it owned, when none remain. Everything
 * outside the block keeps its exact bytes. Ported from 0.238.0 `reconcileGitExcludeBytes`.
 */
export function rewriteOldExclude(source: Buffer, entries: readonly string[], path: string): Buffer {
  // latin1 maps each byte to one character, so offsets and bytes stay exact.
  const text = source.toString("latin1");
  const all = lines(text);
  const markers = all.filter((line) => line.text.startsWith(BEGIN) || line.text.startsWith(END) || line.text === SEPARATOR);
  const begins = all.filter((line) => line.text === BEGIN || line.text === BEGIN_WITH_SEPARATOR);
  const ends = all.filter((line) => line.text === END);
  if (markers.length === 0) return source;
  const malformed = new Error(`${path} has a malformed old apkit exclusion block. Nothing was changed; fix or remove the block between "${BEGIN}" and "${END}", then run the command again.`);
  if (begins.length !== 1 || ends.length !== 1) throw malformed;
  const begin = begins[0]!;
  const end = ends[0]!;
  if (end.start < begin.end) throw malformed;
  const ownsSeparator = begin.text === BEGIN_WITH_SEPARATOR;
  if (markers.length !== (ownsSeparator ? 3 : 2)) throw malformed;
  let prefixEnd = begin.start;
  if (ownsSeparator) {
    const separator = all.find((line) => line.end === begin.start);
    const previous = separator === undefined ? undefined : all.find((line) => line.end === separator.start);
    if (separator?.text !== SEPARATOR || previous === undefined || previous.newline === "") throw malformed;
    prefixEnd = separator.start - previous.newline.length;
  }
  const prefix = text.slice(0, prefixEnd);
  const suffix = text.slice(end.end);
  const kept = [...new Set(entries)]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((entry) => Buffer.from(entry, "utf8").toString("latin1"));
  if (kept.length === 0) return Buffer.from(prefix + suffix, "latin1");
  const newline = begin.newline || "\n";
  const separate = prefix.length > 0 && !prefix.endsWith("\n");
  const block = `${separate ? BEGIN_WITH_SEPARATOR : BEGIN}${newline}${kept.join(newline)}${newline}${END}${newline}`;
  return Buffer.from(`${prefix}${separate ? `${newline}${SEPARATOR}${newline}` : ""}${block}${suffix}`, "latin1");
}

/** Which agents each old Context file was for: the old engine's layout (0.238.0). */
const OLD_CONTEXT: readonly { readonly prefix: string; readonly agents: readonly AgentId[]; readonly what?: string }[] = [
  { prefix: ".agents/rules/", agents: ["antigravity"] },
  { prefix: ".claude/rules/", agents: ["claude", "grok"] },
  { prefix: ".agent-profile-kit/codex/", agents: ["codex"] },
  { prefix: ".agent-profile-kit/opencode/", agents: ["opencode"] },
  { prefix: ".pi/", agents: ["pi"] },
  { prefix: ".codex/hooks.json", agents: ["codex"], what: "the Codex hook that loads the Context" },
  { prefix: ".opencode/opencode.jsonc", agents: ["opencode"], what: "the OpenCode configuration that loads the Context" },
];

/** What an old output was, in plain words: the Skill or Context it held, for which agents, from which Profile. */
export function oldOutputOrigin(path: string, receipt: { readonly profile: string; readonly agents: readonly AgentId[] }): string {
  const from = `from the Profile '${receipt.profile}'`;
  const names = (agents: readonly AgentId[]) => agents.filter((agent) => receipt.agents.includes(agent)).map((agent) => AGENTS[agent].name).join(", ");
  const skill = /^(.+)\/([^/]+)$/.exec(path);
  if (skill !== null) {
    const agents = (Object.keys(AGENTS) as AgentId[]).filter((agent) => AGENTS[agent].skillsRoot === skill[1]);
    if (agents.length > 0) return `the Skill '${skill[2]}' for ${names(agents)}, ${from}`;
  }
  const context = OLD_CONTEXT.find((entry) => path === entry.prefix || path.startsWith(entry.prefix));
  if (context !== undefined) return `${context.what ?? `the Context for ${names(context.agents)}`}, ${from}`;
  return `a file the old apkit wrote, ${from}`;
}

/** The part the old apkit added to a configuration file that the user can also add to. */
export interface OldGeneratedPart {
  /** What apkit added, in plain words. */
  readonly description: string;
  /** Whether that part is still in the file; "unknown" when the file does not parse. */
  readonly present: "yes" | "no" | "unknown";
  /** The part as it is in the file now, when present. */
  readonly text?: string;
}

const CODEX_CONTEXT = ".agent-profile-kit/codex/context.md";
const OPENCODE_CONTEXT = ".agent-profile-kit/opencode/context.md";

/** JSONC to JSON: drops comments and trailing commas outside strings. */
function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c === ",") {
      const next = /^\s*([}\]])/.exec(text.slice(i + 1));
      if (next === null) out += c;
    } else out += c;
  }
  return out;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * For `.codex/hooks.json` and `.opencode/opencode.jsonc`, the part the old apkit added,
 * found in the file as it is now. Null for any other output: the old apkit owned it whole.
 */
export function oldGeneratedPart(path: string, text: string, skills: readonly string[]): OldGeneratedPart | null {
  if (path === ".codex/hooks.json") {
    const description = `the SessionStart hook that reads ${CODEX_CONTEXT}`;
    const data = parseJson(text);
    if (!isRecord(data)) return { description, present: "unknown" };
    const groups = isRecord(data.hooks) && Array.isArray(data.hooks.SessionStart) ? data.hooks.SessionStart : [];
    const ours = groups.flatMap((group: unknown) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [];
      const hooks = group.hooks.filter((hook: unknown) => isRecord(hook) && typeof hook.command === "string" && hook.command.includes(CODEX_CONTEXT));
      return hooks.length === 0 ? [] : [{ ...group, hooks }];
    });
    if (ours.length === 0) return { description, present: "no" };
    return { description, present: "yes", text: JSON.stringify({ hooks: { SessionStart: ours } }, null, 2) };
  }
  if (path === ".opencode/opencode.jsonc") {
    const description = `the "Generated by apkit" comment at the top, the instructions entry ${OPENCODE_CONTEXT}, and the permission.skill entries for the Profile's Skills`;
    const data = parseJson(stripJsonc(text));
    if (!isRecord(data)) return { description, present: "unknown" };
    const lines = text.split(/\r?\n/);
    const header = lines[0]?.startsWith("// Generated by apkit") ? lines.slice(0, lines.findIndex((line) => !line.startsWith("//"))) : [];
    const part: Record<string, unknown> = {};
    if (Array.isArray(data.instructions) && data.instructions.includes(OPENCODE_CONTEXT)) part.instructions = [OPENCODE_CONTEXT];
    const permissions = isRecord(data.permission) && isRecord(data.permission.skill) ? data.permission.skill : {};
    const denied = Object.fromEntries(Object.entries(permissions).filter(([id, value]) => skills.includes(id) && value === "deny"));
    if (Object.keys(denied).length > 0) part.permission = { skill: denied };
    if (header.length === 0 && Object.keys(part).length === 0) return { description, present: "no" };
    const json = Object.keys(part).length === 0 ? [] : [JSON.stringify(part, null, 2)];
    return { description, present: "yes", text: [...header, ...json].join("\n") };
  }
  return null;
}

/**
 * Every file now at an old output's path (POSIX, from the Project) with its new-engine hash, so
 * `migrate --overwrite` can hand a changed output to the planner whole. Null when it holds a
 * symlink or anything but files and folders: apkit does not delete those.
 */
export async function currentFiles(project: string, output: OldOutput): Promise<Record<string, string> | null> {
  const path = abs(project, output.path);
  const info = await lstat(path).catch(() => null);
  if (info === null) return {};
  if (info.isFile()) return { [output.path]: contentHash(await readFile(path)) };
  if (!info.isDirectory()) return null;
  const found = await members(path);
  if (found === null) return null;
  const files: Record<string, string> = {};
  for (const member of found) if (member.type === "file") files[`${output.path}/${member.path}`] = contentHash(await readFile(abs(path, member.path)));
  return files;
}


// Taking the old Projects over. `migrate` below is the one entry point: it reads the old state,
// moves every Project, selects the Workspace, and renames the old state to its backup.

/** What `migrate` did with one output that the old engine recorded. */
export interface OldOutputOutcome {
  readonly path: string;
  readonly type: "file" | "directory";
  /**
   * "unchanged": still as the old apkit wrote it, because the run stopped for a decision.
   * "already-replaced": an earlier run (or an install by this apkit) replaced it, and this apkit owns it now.
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
export interface Migration {
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
  for (const path of found) if (await isFolder(abs(folder, path))) existing.push(path);
  return existing;
}

async function isFolder(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isDirectory(), () => false);
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
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
  const text = await readFile(abs(folder, output.path), "utf8").catch(() => null);
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

/** The old outputs of one Project and their states, as `migrate` inspects them. */
type OldStates = readonly { output: OldOutput; state: { result: OldOutputOutcome["result"]; files?: Readonly<Record<string, string>> } }[];

/** One Project as `migrate` finds it: this apkit's manifest there, and each old output's state. */
interface Inspected {
  readonly folder: string;
  readonly current: Manifest | null;
  readonly states: OldStates;
  /** The Skills of the receipt's Profile, for the part the old apkit added to the OpenCode configuration. */
  readonly skills: readonly string[];
}

/**
 * Each old output's state: kept by an earlier `migrate --yes`, already replaced by this apkit
 * (an earlier `migrate` or `install` wrote what is there now and records it), or as inspected.
 */
async function inspectProject(folder: string, receipt: OldReceipt, workspace: Workspace | null): Promise<Inspected> {
  const current = await readManifest(folder);
  const kept = new Set((await readConfig()).kept?.[folder] ?? []);
  const states = await Promise.all(
    receipt.outputs.map(async (output) => {
      if (kept.has(output.path)) return { output, state: { result: "kept" as const } };
      const state = await inspectOldOutput(folder, output);
      const replaced = state.result === "changed" && (await takenOver(folder, output, current?.files ?? {}));
      return { output, state: replaced ? { result: "already-replaced" as const } : state };
    }),
  );
  return { folder, current, states, skills: workspace?.profiles.get(receipt.profile)?.skills ?? [] };
}

/**
 * Settles each changed old output with the flags. `--overwrite` deletes it whole; `--yes` keeps
 * it, unless this apkit installs at the same path. Without either, it stays a decision.
 */
async function changedOutputs(
  project: Inspected,
  receipt: OldReceipt,
  /** Null for a retired Project: nothing is installed, so `--yes` can keep every changed output. */
  desired: Desired | null,
  decisions: Decisions,
): Promise<OldChange[]> {
  const { folder, states, skills } = project;
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

/** Whether the Project stops before any change: a changed output is still open, or a planning run must list every decision. */
function stopsForChanges(changes: readonly OldChange[], planOnly: boolean): boolean {
  return changes.some((change) => change.resolution === "open") || (planOnly && changes.length > 0);
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

/**
 * After the old files are gone: records the changed outputs `--yes` kept, so a later run does not
 * ask again, removes the old exclusion entries, and lists the folders that were emptied.
 */
async function finishProject(
  folder: string,
  changes: readonly OldChange[],
  exclusion: { file: string; keep: string[] } | null,
  candidates: readonly string[],
): Promise<Pick<Migration, "exclusion" | "folders">> {
  const keep = changes.filter((change) => change.resolution === "keep").map((change) => change.output.path);
  if (keep.length > 0) {
    const config = await readConfig();
    await writeConfig({ ...config, kept: { ...config.kept, [folder]: [...new Set([...(config.kept?.[folder] ?? []), ...keep])].sort() } });
  }
  const removed = await removeOldEntries(exclusion);
  const folders: string[] = [];
  for (const path of candidates) if (!(await isFolder(abs(folder, path)))) folders.push(path);
  return { exclusion: removed, folders: folders.sort() };
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

/**
 * Builds each old output's outcome, with what a changed or kept output was and the part the
 * old apkit added to it. `result` gives each output's result for this outcome.
 */
async function outcomeBuilder(project: Inspected, receipt: OldReceipt, changes: readonly OldChange[]) {
  const { folder, states, skills } = project;
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

/**
 * Takes over a Project the old apkit had unbound: deletes each of its old outputs that is still
 * as the old apkit wrote it, through the ordinary planner, and its old exclusion entries.
 * Nothing is installed. A changed output follows the same decision rules as a bound Project's
 * (`--yes` keeps it, `--overwrite` deletes it). Paths that a bound receipt for the same folder
 * records stay, and so do outputs this apkit already installed again.
 */
async function retireProject(
  workspace: Workspace | null,
  receipt: OldReceipt,
  pending: readonly OldReceipt[],
  bound: readonly OldReceipt[],
  decisions: Decisions,
  planOnly: boolean,
): Promise<Migration> {
  const base = emptyMigration(receipt);
  if (!(await isFolder(receipt.project))) return { ...base, result: "missing" };
  const folder = await realpath(receipt.project);
  const project = await inspectProject(folder, receipt, workspace);
  const { states } = project;
  const changes = await changedOutputs(project, receipt, null, decisions);
  const outcomes = await outcomeBuilder(project, receipt, changes);
  if (stopsForChanges(changes, planOnly)) {
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
  const finished = await finishProject(folder, changes, exclusion, candidates);
  const outputs = outcomes((output, state) => (resolution(output) === "keep" ? "kept" : goes(output, state) ? "deleted" : state.result));
  return { ...base, folder, result: "retired", outputs, ...finished };
}

/**
 * Moves one Project from the old engine to this one. Every unchanged old output is handed
 * to the ordinary planner as if this engine had written it, so the same safety core replaces
 * or deletes it, prunes only folders it emptied, and stops for the same decisions (ISC-65).
 */
async function migrateProject(workspace: Workspace | null, receipt: OldReceipt, pending: readonly OldReceipt[], decisions: Decisions, planOnly: boolean): Promise<Migration> {
  const base = emptyMigration(receipt);
  if (!(await isFolder(receipt.project))) return { ...base, result: "missing" };
  const folder = await realpath(receipt.project);
  if (workspace === null || !workspace.profiles.has(receipt.profile)) {
    return { ...base, folder, result: "error", message: `Profile '${receipt.profile}' is not in the Workspace.` };
  }

  const project = await inspectProject(folder, receipt, workspace);
  const { current, states } = project;
  const desired = renderFor(workspace, receipt.profile, receipt.agents);
  const changes = await changedOutputs(project, receipt, desired, decisions);
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
  const outcomes = await outcomeBuilder(project, receipt, changes);
  if (stopsForChanges(changes, planOnly)) {
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
  const finished = await finishProject(folder, changes, exclusion, candidates);
  const outputs = outcomes((output, state) => {
    const resolution = changes.find((change) => change.output === output)?.resolution;
    if (resolution === "keep") return "kept";
    if (state.result !== "unchanged" && resolution !== "overwrite") return state.result;
    return installsAt(desired, output.path) ? "replaced" : "deleted";
  });
  const moved = install.result !== "unchanged" || finished.exclusion.result !== "none";
  return {
    ...base,
    folder,
    result: moved ? "migrated" : "unchanged",
    outputs,
    ...finished,
    install,
    instructions,
    trust: moved ? trustNeeds(desired) : [],
  };
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
export interface WorkspaceRename {
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

/** Problems that mean a folder is not a Workspace at all, so it cannot be selected. */
const UNMARKED = new Set(["workspace-missing-manifest", "workspace-old-manifest"]);

const NAME_WORKSPACE = `\`${COMMAND} migrate --workspace <path>\``;

/** A Project needs the Workspace to install its Profile again: stop before any change unless it is valid. */
function requireUsable(workspace: Workspace | null, config: string, flagged: boolean): asserts workspace is Workspace {
  if (workspace === null) {
    throw new Error(`${display(config)} names no Workspace, so apkit cannot tell which Profiles to install. Nothing was changed.\nName the Workspace the old apkit used: ${NAME_WORKSPACE}.`);
  }
  if (workspace.violations.length === 0) return;
  throw new Error(
    [
      `${flagged ? "--workspace names" : `${display(config)} names`} the Workspace at ${display(workspace.root)}, and it has problems:`,
      ...workspace.violations.map((v) => `  - ${v.message}`),
      "Nothing was changed: the Projects the old apkit installed need a valid Workspace to install their Profiles again.",
      `Fix the Workspace, or name the Workspace to use: ${NAME_WORKSPACE}.`,
      CONTRACT_POINTER,
    ].join("\n"),
  );
}

/** The Workspace a run of `migrate` used. */
export interface MigrationWorkspace {
  readonly path: string;
  /** The Workspace this apkit had selected before the run. */
  readonly previous: string | null;
  /** Whether the run selected it. A folder that is not a Workspace is never selected. */
  readonly selected: boolean;
  readonly rename?: WorkspaceRename;
}

/** What one run of `migrate` did. */
export type MigrationRun =
  | {
      readonly found: false;
      readonly state: string;
      /** The backup folder, when it exists. */
      readonly backup: string | null;
      /** The old state folder held no old records, and this run renamed it to the backup. */
      readonly renamed: boolean;
    }
  | {
      readonly found: true;
      readonly state: string;
      /** Null when neither the old configuration nor `--workspace` names one. */
      readonly workspace: MigrationWorkspace | null;
      /** The Workspace as loaded, for its problems and warnings. */
      readonly loaded: Workspace | null;
      readonly projects: readonly Migration[];
      readonly backup: { readonly path: string; readonly result: "renamed" | "kept" };
      /** Only planned: the Workspace rename needs consent first. */
      readonly planOnly: boolean;
    };

export interface MigrateOptions {
  readonly home: string;
  readonly decisions: Decisions;
  /** `--workspace`: the Workspace to use instead of the one the old configuration names. */
  readonly workspace?: string;
}

/**
 * Moves every Project the old apkit recorded to this one, selects the Workspace, and renames the
 * old state to its backup once no Project needs it (ISC-92). The Workspace must be valid only when
 * a Project will install its Profile again; otherwise the migration completes without it.
 */
export async function migrate(options: MigrateOptions): Promise<MigrationRun> {
  const { home, decisions } = options;
  const old = await readOldState(home);
  const state = oldStateFolder(home);
  const backup = `${state}.migrated`;
  if (old === null && (await exists(state))) {
    // The folder holds no old records: there is nothing to move, so the migration is complete.
    if (await exists(backup)) throw backupExists(state, backup, false);
    await rename(state, backup);
    return { found: false, state, backup, renamed: true };
  }
  if (old === null) return { found: false, state, backup: (await exists(backup)) ? backup : null, renamed: false };
  // The backup is never replaced or merged into.
  if (await exists(backup)) throw backupExists(state, backup, false);

  const root = options.workspace ?? old.workspace;
  let workspace = root === undefined ? null : await loadWorkspace(root);
  const marker = workspace === null ? null : oldMarkerRename(workspace);
  // Without consent nothing changes: each Project is only planned, so one run lists every decision.
  const planOnly = marker !== null && !decisions.yes;
  if (marker !== null && !planOnly) {
    await rename(marker.from, marker.to);
    workspace = await loadWorkspace(root!);
  }
  // Only a bound Project whose folder exists installs a Profile again, so only it needs the Workspace.
  let needed = false;
  for (const receipt of old.receipts) if (!receipt.retired && (await isFolder(receipt.project))) needed = true;
  if (needed && !planOnly) requireUsable(workspace, join(state, "config.yaml"), options.workspace !== undefined);

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
  // The old state is kept, renamed, once no Project needs it any more (ISC-92). A rename changes no file.
  const complete = !planOnly && projects.every((p) => p.result !== "needs-decision" && p.result !== "waiting" && p.result !== "error");
  // A complete run, or one where a Project uses it, selects the Workspace the old apkit used, when it is one (SRC-08a).
  // A run that only stops for decisions changes nothing.
  const used = complete || projects.some((p) => p.result === "migrated" || p.result === "unchanged");
  const selected = used && workspace !== null && !workspace.violations.some((v) => UNMARKED.has(v.code));
  if (selected) await writeConfig({ ...(await readConfig()), workspace: workspace!.root });
  if (complete) {
    if (await exists(backup)) throw backupExists(state, backup, true);
    await rename(state, backup);
  }
  return {
    found: true,
    state,
    workspace:
      workspace === null
        ? null
        : { path: workspace.root, previous: previousWorkspace, selected, ...(marker === null ? {} : { rename: { ...marker, result: planOnly ? "needs-decision" : "renamed" } }) },
    loaded: workspace,
    projects,
    backup: { path: backup, result: complete ? "renamed" : "kept" },
    planOnly,
  };
}
