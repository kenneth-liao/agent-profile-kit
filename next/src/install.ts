// The safety core. One rule for every write: replace or delete only what apkit
// wrote and nobody changed since; anything else needs an explicit decision.
// The manifest in each target folder records what apkit wrote, by content hash.
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isTracked } from "./gitindex.js";
import { addClaudeImport, hasClaudeImport, readBlock, removeClaudeImport, writeBlock } from "./instructions.js";
import { isAgentId, type AgentId, type Desired } from "./render.js";

export const MANIFEST_PATH = ".agents/apkit.json";

export interface Manifest {
  readonly schema: 1;
  readonly profile: string;
  readonly agents: readonly AgentId[];
  /** POSIX path → content hash, for every file apkit wrote. */
  readonly files: Readonly<Record<string, string>>;
  /** Hash of the AGENTS.md block body apkit wrote, or null. */
  readonly block: string | null;
  readonly createdAgentsMd: boolean;
  readonly claudeImport: boolean;
  /** Present for a user-level install (`install --global`). */
  readonly scope?: "user";
}

export type IssueKind =
  /** An edit to a file the user owns (AGENTS.md, CLAUDE.md). Allowed by `--yes`. */
  | "consent"
  /** A file apkit wrote was changed since. Replaced only with `--overwrite`. */
  | "changed"
  /** A file apkit did not write is in the way. Replaced only with `--overwrite`. */
  | "unowned"
  /** A symlink would take writes or deletions outside the target. Allowed by `--yes`. */
  | "outside";

export interface Issue {
  readonly kind: IssueKind;
  readonly path: string;
  readonly message: string;
}

type Op =
  | { readonly type: "write"; readonly path: string; readonly bytes: Uint8Array; readonly executable: boolean }
  | { readonly type: "delete"; readonly path: string }
  /** Whole-file text replacement of an instruction file; null deletes the file. */
  | { readonly type: "text"; readonly path: string; readonly absolute: string; readonly text: string | null };

/** What the plan does to one instruction file, so the user can decide before it happens (ISC-86). */
export interface InstructionChange {
  readonly path: "AGENTS.md" | "CLAUDE.md";
  readonly action: "create" | "change" | "delete";
  /** Whether Git tracks the file. */
  readonly tracked: boolean;
}

export interface Plan {
  readonly target: string;
  readonly ops: readonly Op[];
  readonly issues: readonly Issue[];
  readonly instructions: readonly InstructionChange[];
  readonly manifest: Manifest | null;
}

export interface Decisions {
  /** Allow edits to AGENTS.md / CLAUDE.md, including creating AGENTS.md, and writes through a symlink outside the target. */
  readonly yes?: boolean;
  /** Replace or delete files that were changed or not written by apkit. */
  readonly overwrite?: boolean;
}

/** Normalizes CRLF so a Git checkout on Windows does not look like an edit. */
export function hash(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const text = Buffer.from(raw).toString("latin1");
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "latin1").digest("hex");
}

function abs(target: string, path: string): string {
  return join(target, ...path.split("/"));
}

async function readBytes(path: string): Promise<Uint8Array | null | "directory"> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return "directory";
    return new Uint8Array(await readFile(path));
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string | null> {
  const bytes = await readBytes(path);
  return bytes === null || bytes === "directory" ? null : new TextDecoder().decode(bytes);
}

/** Follows a symlinked instruction file so writes land in the real file. */
async function resolveFile(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function isInside(target: string, path: string): boolean {
  const rel = relative(target, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/** The first symlink on the way to `path` that leads outside the target, and where it leads. */
async function outsideLink(target: string, path: string): Promise<{ link: string; leadsTo: string } | null> {
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const current = abs(target, parts.slice(0, i).join("/"));
    let info;
    try {
      info = await lstat(current);
    } catch {
      return null;
    }
    if (!info.isSymbolicLink()) continue;
    // A dangling link has no real path; read where it points instead.
    const leadsTo = await realpath(current).catch(async () => resolve(dirname(current), await readlink(current)));
    if (!isInside(target, leadsTo)) return { link: parts.slice(0, i).join("/"), leadsTo };
  }
  return null;
}

export async function readManifest(target: string): Promise<Manifest | null> {
  const text = await readText(abs(target, MANIFEST_PATH));
  if (text === null) return null;
  const data = JSON.parse(text) as Manifest;
  if (data.schema !== 1 || !Array.isArray(data.agents) || !data.agents.every(isAgentId)) {
    throw new Error(`${MANIFEST_PATH} in ${target} is not a manifest this version understands.`);
  }
  return data;
}

/** Plans an install or update (desired) or a removal (desired null). Writes nothing. */
export async function plan(target: string, desired: Desired | null, previous: Manifest | null): Promise<Plan> {
  const ops: Op[] = [];
  const issues: Issue[] = [];
  const files: Record<string, string> = {};
  const owned = previous?.files ?? {};

  for (const [path, file] of desired?.files ?? []) {
    const want = hash(file.bytes);
    files[path] = want;
    const disk = await readBytes(abs(target, path));
    if (disk === "directory") {
      issues.push({ kind: "unowned", path, message: `${path} is a folder where apkit needs a file.` });
      continue;
    }
    if (disk !== null && hash(disk) === want) continue;
    if (disk !== null && owned[path] === undefined) {
      issues.push({ kind: "unowned", path, message: `${path} exists and was not written by apkit.` });
    } else if (disk !== null && hash(disk) !== owned[path]) {
      issues.push({ kind: "changed", path, message: `${path} was changed after apkit wrote it.` });
    }
    ops.push({ type: "write", path, bytes: file.bytes, executable: file.executable });
  }
  for (const [path, was] of Object.entries(owned)) {
    if (path in files) continue;
    const disk = await readBytes(abs(target, path));
    if (disk === null || disk === "directory") continue;
    if (hash(disk) !== was) {
      issues.push({ kind: "changed", path, message: `${path} was changed after apkit wrote it, and would be deleted.` });
    }
    ops.push({ type: "delete", path });
  }

  // AGENTS.md: the one place Context goes. Every supported agent loads it.
  const agentsPath = await resolveFile(abs(target, "AGENTS.md"));
  const agentsText = await readText(agentsPath);
  const block = agentsText === null ? null : readBlock(agentsText);
  const body = desired?.context ?? null;
  let blockHash: string | null = null;
  let createdAgentsMd = previous?.createdAgentsMd ?? false;
  if (body !== null) {
    blockHash = hash(body);
    if (agentsText === null) {
      issues.push({ kind: "consent", path: "AGENTS.md", message: "Create AGENTS.md to hold this Profile's Context." });
      createdAgentsMd = true;
    } else if (block === null) {
      if (previous?.block) {
        issues.push({ kind: "changed", path: "AGENTS.md", message: "The apkit section was removed from AGENTS.md." });
      } else {
        issues.push({ kind: "consent", path: "AGENTS.md", message: "Add a marked apkit section with this Profile's Context to AGENTS.md." });
      }
    } else if (hash(block) !== blockHash) {
      if (!previous?.block) {
        issues.push({ kind: "unowned", path: "AGENTS.md", message: "AGENTS.md already has an apkit section that this folder's install did not write." });
      } else if (hash(block) !== previous.block) {
        issues.push({ kind: "changed", path: "AGENTS.md", message: "The apkit section in AGENTS.md was changed after apkit wrote it." });
      }
    }
    if (block === null || hash(block) !== blockHash) {
      ops.push({ type: "text", path: "AGENTS.md", absolute: agentsPath, text: writeBlock(agentsText, body) });
    }
  } else if (block !== null && previous?.block) {
    if (hash(block) !== previous.block) {
      issues.push({ kind: "changed", path: "AGENTS.md", message: "The apkit section in AGENTS.md was changed after apkit wrote it, and would be removed." });
    }
    const remaining = writeBlock(agentsText, null);
    ops.push({
      type: "text",
      path: "AGENTS.md",
      absolute: agentsPath,
      text: createdAgentsMd && remaining.trim() === "" ? null : remaining,
    });
    createdAgentsMd = false;
  }

  // CLAUDE.md: Claude Code reads it instead of AGENTS.md when it exists, so it
  // needs one import line. Never put the block itself here: Grok reads both.
  const claudePath = await resolveFile(abs(target, "CLAUDE.md"));
  const claudeText = await readText(claudePath);
  const sameFile = claudeText !== null && agentsText !== null && claudePath === agentsPath;
  const wantImport = body !== null && (desired?.agents.includes("claude") ?? false) && claudeText !== null && !sameFile;
  let claudeImport = false;
  if (wantImport && claudeText !== null) {
    if (hasClaudeImport(claudeText)) {
      claudeImport = previous?.claudeImport ?? false;
    } else {
      issues.push({ kind: "consent", path: "CLAUDE.md", message: "Add `@AGENTS.md` to CLAUDE.md so Claude Code loads the Context." });
      ops.push({ type: "text", path: "CLAUDE.md", absolute: claudePath, text: addClaudeImport(claudeText) });
      claudeImport = true;
    }
  } else if (previous?.claudeImport && claudeText !== null && hasClaudeImport(claudeText)) {
    const remaining = removeClaudeImport(claudeText);
    ops.push({ type: "text", path: "CLAUDE.md", absolute: claudePath, text: remaining });
  }

  // A symlink can lead a write or deletion out of the target: the user decides.
  if ((desired?.scope ?? previous?.scope) === undefined) {
    const touched = ops.map((op) => op.path);
    if (ops.length > 0 || desired === null) touched.push(MANIFEST_PATH);
    const links = new Map<string, { leadsTo: string; count: number }>();
    for (const path of touched) {
      const found = await outsideLink(target, path);
      if (found === null) continue;
      const seen = links.get(found.link) ?? { leadsTo: found.leadsTo, count: 0 };
      links.set(found.link, { ...seen, count: seen.count + 1 });
    }
    for (const [link, { leadsTo, count }] of links) {
      issues.push({
        kind: "outside",
        path: link,
        message: `${link} is a symlink to ${leadsTo}, outside this folder. apkit would change ${count} ${count === 1 ? "file" : "files"} there.`,
      });
    }
  }

  const instructions: InstructionChange[] = [];
  for (const op of ops) {
    if (op.type !== "text") continue;
    const path = op.path as InstructionChange["path"];
    const before = path === "AGENTS.md" ? agentsText : claudeText;
    const action = before === null ? "create" : op.text === null ? "delete" : "change";
    instructions.push({ path, action, tracked: await isTracked(target, path) });
  }

  const manifest: Manifest | null =
    desired === null
      ? null
      : {
          schema: 1,
          profile: desired.profile,
          agents: desired.agents,
          files,
          block: blockHash,
          createdAgentsMd,
          claudeImport,
          ...(desired.scope === undefined ? {} : { scope: desired.scope }),
        };
  return { target, ops, issues, instructions, manifest };
}

/** Issues the given decisions do not settle. Nothing is written while any remain. */
export function unresolved(planned: Plan, decisions: Decisions): Issue[] {
  return planned.issues.filter((issue) => (issue.kind === "consent" || issue.kind === "outside" ? !decisions.yes : !decisions.overwrite));
}

/** Applies a plan whose issues are all settled. The manifest is written last. */
export async function execute(planned: Plan): Promise<void> {
  const { target } = planned;
  for (const op of planned.ops) {
    if (op.type === "write") {
      const path = abs(target, op.path);
      await atomicWrite(path, op.bytes);
      if (op.executable) await chmod(path, 0o755);
    } else if (op.type === "text") {
      if (op.text === null) await unlink(op.absolute);
      else await atomicWrite(op.absolute, new TextEncoder().encode(op.text));
    } else {
      await unlink(abs(target, op.path)).catch(() => undefined);
      await pruneEmpty(target, dirname(abs(target, op.path)));
    }
  }
  const manifestPath = abs(target, MANIFEST_PATH);
  if (planned.manifest === null) {
    await unlink(manifestPath).catch(() => undefined);
    await pruneEmpty(target, dirname(manifestPath));
  } else {
    await atomicWrite(manifestPath, new TextEncoder().encode(`${JSON.stringify(planned.manifest, null, 2)}\n`));
  }
}

/** Temp file + rename, retried briefly: Windows refuses renames over files another process holds open. */
export async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.apkit-${process.pid}.tmp`;
  await writeFile(temp, bytes);
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Removes now-empty folders apkit's files lived in, stopping at the target. */
async function pruneEmpty(target: string, dir: string): Promise<void> {
  let current = dir;
  while (current.length > target.length && current.startsWith(target)) {
    try {
      if ((await readdir(current)).length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}
