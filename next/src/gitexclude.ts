// Keeps what apkit installs out of `git status` by listing it in the
// repository's own `.git/info/exclude`, which is never committed. Each install
// folder owns one marked block, so linked worktrees sharing one exclude file
// do not overwrite each other.
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { atomicWrite, type Manifest } from "./install.js";

/** The exclude file for a folder at the root of a Git work tree, or null. */
async function excludeFile(target: string): Promise<string | null> {
  const dotGit = join(target, ".git");
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    return null;
  }
  let gitDir = dotGit;
  if (info.isFile()) {
    // A linked worktree: `.git` names its git dir, whose `commondir` holds info/.
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
    if (match === null) return null;
    gitDir = resolve(target, match[1] as string);
    const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => null);
    if (common !== null) gitDir = resolve(gitDir, common.trim());
  }
  return join(gitDir, "info", "exclude");
}

/** Exclude patterns for an install: each Skill folder and the manifest. Never an instruction file (ISC-87). */
export function excludePatterns(manifest: Manifest): string[] {
  const patterns = new Set<string>(["/.agents/apkit.json"]);
  for (const path of Object.keys(manifest.files)) {
    const parts = path.split("/");
    const skills = parts.indexOf("skills");
    patterns.add(skills >= 0 && skills + 1 < parts.length - 1 ? `/${parts.slice(0, skills + 2).join("/")}/` : `/${path}`);
  }
  return [...patterns].sort();
}

/** Writes (or, with manifest null, removes) this folder's block in the exclude file. */
export async function syncGitExclude(target: string, manifest: Manifest | null): Promise<void> {
  if (manifest?.scope === "user") return;
  const path = await excludeFile(target);
  if (path === null) return;
  const begin = `# apkit:begin ${target}`;
  const end = `# apkit:end ${target}`;
  const current = await readFile(path, "utf8").catch(() => "");
  const lines = current.split(/\r?\n/);
  const start = lines.indexOf(begin);
  const stop = lines.indexOf(end, start);
  if (start < 0 && manifest === null) return;
  const kept = start >= 0 && stop > start ? [...lines.slice(0, start), ...lines.slice(stop + 1)] : lines;
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const block = manifest === null ? [] : [begin, ...excludePatterns(manifest), end];
  const next = [...kept, ...block].join("\n");
  const text = next === "" ? "" : `${next}\n`;
  if (text === current) return;
  await mkdir(dirname(path), { recursive: true });
  await atomicWrite(path, new TextEncoder().encode(text));
}
