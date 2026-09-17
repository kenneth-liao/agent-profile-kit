import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Recursive relative-path, mode, and bytes snapshot of one file tree — the
 * before/after comparison primitive for side-effect isolation (TEST-011,
 * spec #593). Symlinks are recorded as links and never followed, so a
 * shared-deps symlink cannot enter the walk; a dangling link is recorded,
 * not an error. Entries sort stably so two snapshots of an unchanged tree
 * compare equal.
 */
export function fileTree(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (absolute: string, relative: string): void => {
    // lstat never follows links: a symlinked entry is recorded as a link,
    // never walked into or read through, and a dangling link stays a record
    // instead of an ENOENT.
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      entries.push(`link ${relative}`);
      return;
    }
    if (stats.isDirectory()) {
      entries.push(`dir ${relative} ${stats.mode.toString(8)}`);
      for (const child of readdirSync(absolute).sort()) {
        walk(join(absolute, child), relative === "" ? child : join(relative, child));
      }
      return;
    }
    // Mode is part of the snapshot: a mode-only side effect (chmod) must
    // fail the before/after comparison, not just content and path changes.
    entries.push(`file ${relative} ${stats.mode.toString(8)} ${readFileSync(absolute).toString("hex")}`);
  };
  walk(root, "");
  return entries.sort();
}