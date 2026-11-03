// Answers "does Git track this file?" without running `git` (ISC-61): find the
// repository that holds a folder, then read path names from its index file.
// Index versions 2 to 4 are read; split and sparse indexes are not.
import { readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface Repository {
  /** The work tree root: the folder that holds `.git`. */
  readonly root: string;
  /** This work tree's own git dir, which holds its index. */
  readonly gitDir: string;
  /** The git dir shared by all linked worktrees, which holds `info/`. Equal to gitDir outside linked worktrees. */
  readonly commonDir: string;
}

/** The repository whose work tree holds `folder` (searching upward), or null. */
export async function findRepository(folder: string): Promise<Repository | null> {
  for (let root = resolve(folder); ; root = dirname(root)) {
    const dotGit = join(root, ".git");
    const info = await stat(dotGit).catch(() => null);
    if (info?.isDirectory()) return { root, gitDir: dotGit, commonDir: dotGit };
    if (info?.isFile()) {
      // A linked worktree or submodule: `.git` names its git dir.
      const match = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
      if (match === null) return null;
      const gitDir = resolve(root, match[1] as string);
      const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => null);
      return { root, gitDir, commonDir: common === null ? gitDir : resolve(gitDir, common.trim()) };
    }
    if (dirname(root) === root) return null;
  }
}

/** Whether `path` (POSIX, relative to `folder`) is in the index of the repository holding `folder`. */
export async function isTracked(folder: string, path: string): Promise<boolean> {
  const repository = await findRepository(folder);
  if (repository === null) return false;
  const wanted = relative(repository.root, join(folder, ...path.split("/"))).split(sep).join("/");
  const index = await readFile(join(repository.gitDir, "index")).catch(() => null);
  return index !== null && indexPaths(index).has(wanted);
}

function indexPaths(index: Buffer): Set<string> {
  const paths = new Set<string>();
  if (index.length < 12 || index.toString("latin1", 0, 4) !== "DIRC") return paths;
  const version = index.readUInt32BE(4);
  if (version < 2 || version > 4) return paths;
  const count = index.readUInt32BE(8);
  let offset = 12;
  let previous: Buffer = Buffer.alloc(0);
  for (let entry = 0; entry < count; entry++) {
    const start = offset;
    const flags = index.readUInt16BE(start + 60);
    offset = start + (version >= 3 && flags & 0x4000 ? 64 : 62);
    let name: Buffer;
    if (version === 4) {
      // The name drops N bytes from the end of the previous one, then adds a suffix.
      let byte = index[offset++] as number;
      let strip = byte & 0x7f;
      while (byte & 0x80) {
        byte = index[offset++] as number;
        strip = ((strip + 1) << 7) | (byte & 0x7f);
      }
      const end = index.indexOf(0, offset);
      name = Buffer.concat([previous.subarray(0, previous.length - strip), index.subarray(offset, end)]);
      offset = end + 1;
    } else {
      // NUL-padded so the whole entry is a multiple of 8 bytes.
      const end = index.indexOf(0, offset);
      name = index.subarray(offset, end);
      offset = start + Math.ceil((end - start + 1) / 8) * 8;
    }
    previous = name;
    paths.add(name.toString("utf8"));
  }
  return paths;
}
