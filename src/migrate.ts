// Reads what the old engine (apkit 0.238 and earlier) left on a machine, so
// `apkit migrate` can take each of its Projects over. The old engine is gone:
// its state format, output hashes, and Git exclusion block are read here, at
// the boundary, and nowhere else (ISC-67).
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { hash as contentHash } from "./install.js";
import { isAgentId, type AgentId } from "./render.js";
import { refuseNewer } from "./schema.js";

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

function abs(project: string, path: string): string {
  return join(project, ...path.split("/"));
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
