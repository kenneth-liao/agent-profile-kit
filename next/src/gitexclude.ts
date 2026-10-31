// Keeps what apkit installs out of `git status` by listing it in the
// repository's own `.git/info/exclude`, which is never committed. Each install
// folder owns one marked block, so subfolders and linked worktrees sharing one
// exclude file do not overwrite each other.
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { findRepository } from "./gitindex.js";
import { atomicWrite, type Manifest } from "./install.js";

/** Exclude patterns for an install in `prefix` (POSIX, from the repository root): each Skill folder and the manifest. Never an instruction file (ISC-87). */
export function excludePatterns(manifest: Manifest, prefix = ""): string[] {
  const base = prefix === "" ? "" : `/${prefix}`;
  const patterns = new Set<string>([`${base}/.agents/apkit.json`]);
  for (const path of Object.keys(manifest.files)) {
    const parts = path.split("/");
    const skills = parts.indexOf("skills");
    patterns.add(skills >= 0 && skills + 1 < parts.length - 1 ? `${base}/${parts.slice(0, skills + 2).join("/")}/` : `${base}/${path}`);
  }
  return [...patterns].sort();
}

/**
 * Writes (or, with manifest null, removes) this folder's block in the exclude
 * file of the repository that holds it. Returns that exclude file, or null
 * outside a repository, so a block can still be removed after the folder is gone.
 */
export async function syncGitExclude(target: string, manifest: Manifest | null): Promise<string | null> {
  if (manifest?.scope === "user") return null;
  const repository = await findRepository(target);
  if (repository === null) return null;
  const path = join(repository.commonDir, "info", "exclude");
  const prefix = relative(repository.root, target).split(sep).join("/");
  await writeBlock(path, target, manifest === null ? null : excludePatterns(manifest, prefix));
  return path;
}

/** Removes `target`'s block from the exclude file at `path`, if there is one. */
export async function removeGitExclude(path: string, target: string): Promise<void> {
  await writeBlock(path, target, null);
}

async function writeBlock(path: string, target: string, patterns: readonly string[] | null): Promise<void> {
  const begin = `# apkit:begin ${target}`;
  const end = `# apkit:end ${target}`;
  const current = await readFile(path, "utf8").catch(() => "");
  const lines = current.split(/\r?\n/);
  const start = lines.indexOf(begin);
  const stop = lines.indexOf(end, start);
  if (start < 0 && patterns === null) return;
  const kept = start >= 0 && stop > start ? [...lines.slice(0, start), ...lines.slice(stop + 1)] : lines;
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const block = patterns === null ? [] : [begin, ...patterns, end];
  const next = [...kept, ...block].join("\n");
  const text = next === "" ? "" : `${next}\n`;
  if (text === current) return;
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, new TextEncoder().encode(text));
}
