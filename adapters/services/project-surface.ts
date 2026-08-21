import { lstat } from "node:fs/promises";

export type FileSystemEntryKind = "directory" | "file" | "missing" | "other" | "symlink";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Classify one filesystem entry without following symbolic links. */
export async function classifyFileSystemEntry(path: string): Promise<FileSystemEntryKind> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "missing";
    if (hasErrorCode(error, "ENOTDIR")) return "other";
    throw error;
  }
}
