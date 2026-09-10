import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { type OwnershipOutputReceipt, type OwnershipReceipt, type OwnershipState } from "../schemas/ownership-state.js";
import { hashBytes, hashDirectoryMembersFromFiles } from "./project-plan.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Instrumentation fired only when the invocation context performs real work
 * (cache miss). Tests inject counters; production callers omit this.
 */
export interface LifecycleOwnershipInspectionInstrumentation {
  readonly onInspectDirectory?: () => void;
  readonly onInspectFile?: () => void;
  readonly onUnsafeParent?: () => void;
}

/**
 * One normalized inspection of one owned file or generated directory root.
 * Directory output proof carries one aggregate root hash and never reconstructs
 * member-level ownership evidence. Every consumer shares this result.
 */
export interface OwnedOutputInspection {
  /**
   * On-disk classification of the output root. `missing` means the root itself
   * is proven absent (ordinary pending work `apply` restores); `unreadable` is
   * an explicit fail-closed inspection failure for a root or traversal that
   * cannot be proven; `other` covers a root that is not the recorded type and a
   * readable root containing an unsupported member entry (distinguished by
   * `unsupportedMember`).
   */
  readonly kind: "directory" | "file" | "missing" | "other" | "unreadable";
  /** Regular-file bytes when the output root is a regular file. */
  readonly content?: string;
  /**
   * Exact on-disk bytes when the output root is a regular file. Decoded
   * `content` is rendering and continuity evidence only: review identity
   * must bind these bytes, since distinct invalid sequences decode alike.
   */
  readonly contentBytes?: Uint8Array;
  /** Deterministic hash of `content` when the output root is a regular file. */
  readonly contentHash?: string;
  /** Deterministic aggregate hash when the output root is a readable safe directory. */
  readonly directoryHash?: string;
  /** Root mode when the output root is a regular file or directory. */
  readonly mode?: number;
  /** Recorded-root-relative path of the first unsupported member entry. */
  readonly unsupportedMember?: string;
}

/**
 * Whether the on-disk root still matches the receipt's recorded hash and mode:
 * the durable continuity evidence that the extant bytes are Agent Profile
 * Kit's own published output. One canonical matcher shared by the ownership
 * proof, the conflict preflight, and the refresh planner.
 */
export function recordedOutputMatches(
  inspection: OwnedOutputInspection,
  output: OwnershipOutputReceipt,
): boolean {
  return output.type === "file"
    ? inspection.kind === "file" &&
        inspection.mode === output.mode &&
        inspection.contentHash === output.hash
    : inspection.kind === "directory" &&
        inspection.mode === output.mode &&
        inspection.directoryHash === output.hash;
}

/**
 * One invocation-scoped reader for ordinary owned outputs and unsafe-parent
 * evidence. Each owned output is read or walked at most once per reconciliation
 * pass; every consumer shares the same root result. Discarded when the
 * lifecycle command exits; never persisted or shared across commands.
 */
/** One listed member of a generated directory root, relative to the root. */
export type ListedDirectoryMember =
  | {
      readonly mode: number;
      readonly path: string;
      readonly type: "file";
    }
  | {
      readonly mode: number;
      readonly path: string;
      readonly type: "directory";
    }
  | {
      readonly path: string;
      readonly type: "other";
    };

export interface LifecycleOwnershipInspection {
  inspectOutput(project: string, output: OwnershipOutputReceipt): Promise<OwnedOutputInspection>;
  unsafeParent(project: string, relativePath: string): Promise<string | undefined>;
  /**
   * Review-grade member listing for one project-relative directory root.
   * Shares the walk boundary with directory ownership proof; throws when the
   * root is absent or cannot be walked.
   */
  listDirectoryMembers(project: string, relativeRoot: string): Promise<readonly ListedDirectoryMember[]>;
  /**
   * Exact bytes of one member of a listed directory root, or undefined when
   * absent. Rejects member paths that escape the root.
   */
  readDirectoryMember(
    project: string,
    relativeRoot: string,
    memberPath: string,
  ): Promise<Uint8Array | undefined>;
}

/** One on-disk entry recorded by a directory walk. */
export type DirectoryEntry =
  | {
      readonly mode: number;
      readonly path: string;
      readonly type: "file";
    }
  | {
      readonly mode: number;
      readonly path: string;
      readonly type: "directory";
    }
  | {
      readonly path: string;
      readonly type: "other";
    };

/** The recursive walker used to enumerate one owned directory tree. */
export type DirectoryWalker = (
  root: string,
  prefix?: string,
) => Promise<readonly DirectoryEntry[]>;

async function listRelativeEntries(
  root: string,
  prefix = "",
): Promise<readonly DirectoryEntry[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: DirectoryEntry[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolute = join(root, entry.name);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      result.push({ path: relativePath, type: "other" });
      continue;
    }
    const mode = stats.mode & 0o7777;
    if (stats.isDirectory()) {
      result.push({ mode, path: relativePath, type: "directory" });
      result.push(...await listRelativeEntries(absolute, relativePath));
      continue;
    }
    if (stats.isFile()) {
      result.push({ mode, path: relativePath, type: "file" });
      continue;
    }
    result.push({ path: relativePath, type: "other" });
  }
  return result;
}

async function inspectDirectoryOutput(
  project: string,
  output: OwnershipOutputReceipt,
  walk: DirectoryWalker,
): Promise<OwnedOutputInspection> {
  const root = join(project, output.path);
  let mode: number;
  // Only a proven-absent root (lstat ENOENT) is ordinary pending work. Every
  // other root or traversal failure fails closed so extant output is never
  // replaced without a continuity proof.
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return { kind: "other" };
    mode = stats.mode & 0o7777;
  } catch (error) {
    return { kind: hasErrorCode(error, "ENOENT") ? "missing" : "unreadable" };
  }

  try {
    const entries = await walk(root);
    const unsupported = entries.find((entry) => entry.type === "other");
    if (unsupported) return { kind: "other", mode, unsupportedMember: unsupported.path };
    const supported = entries.filter(
      (entry): entry is Exclude<DirectoryEntry, { readonly type: "other" }> => entry.type !== "other",
    );
    return {
      directoryHash: await hashDirectoryMembersFromFiles(
        supported,
        async (entry) => readFile(join(root, entry.path)),
      ),
      kind: "directory",
      mode,
    };
  } catch {
    return { kind: "unreadable", mode };
  }
}

async function inspectFileOutput(
  project: string,
  output: OwnershipOutputReceipt,
): Promise<OwnedOutputInspection> {
  const path = join(project, output.path);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    return { kind: hasErrorCode(error, "ENOENT") ? "missing" : "unreadable" };
  }
  if (stats.isSymbolicLink() || !stats.isFile()) return { kind: "other" };
  let raw: Uint8Array;
  try {
    raw = await readFile(path);
  } catch {
    return { kind: "unreadable" };
  }
  const content = Buffer.from(raw).toString("utf8");
  return {
    content,
    contentBytes: raw,
    contentHash: hashBytes(content),
    kind: "file",
    mode: stats.mode & 0o7777,
  };
}

/**
 * Prove path-safety evidence for one project-relative output path: every parent
 * and the path itself must be real directories, never symlinks. A missing
 * parent chain is safe (the Installer may create it); a non-directory or
 * symlink parent is not. The returned fact is the offending parent path only:
 * typed evidence carries no user-facing sentence, and the recovery command is
 * derived from the bare path (#440).
 */
export async function unsafeOutputParent(
  project: string,
  relativePath: string,
): Promise<string | undefined> {
  const parts = relativePath.split("/");
  let parent = project;
  for (const part of parts.slice(0, -1)) {
    let stats;
    try {
      stats = await lstat(parent);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      if (hasErrorCode(error, "ENOTDIR")) return parent;
      throw error;
    }
    if (stats.isSymbolicLink()) return parent;
    if (!stats.isDirectory()) return parent;
    parent = join(parent, part);
  }
  let stats;
  try {
    stats = await lstat(parent);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    if (hasErrorCode(error, "ENOTDIR")) return parent;
    throw error;
  }
  if (stats.isSymbolicLink()) return parent;
  if (!stats.isDirectory()) return parent;
  return undefined;
}

/**
 * Options for one invocation-scoped ownership inspection context. Production
 * callers omit these; tests may inject a deterministic directory walker to
 * simulate traversal failures.
 */
export interface LifecycleOwnershipInspectionOptions {
  /** Test seam: replace the recursive directory walker for owned directory outputs. */
  readonly walkDirectory?: DirectoryWalker;
}

/**
 * Create one invocation-scoped ownership inspection context. Call sites must
 * not add local memoization or fallback readers for the same facts.
 */
export function createLifecycleOwnershipInspectionContext(
  instrumentation: LifecycleOwnershipInspectionInstrumentation = {},
  options: LifecycleOwnershipInspectionOptions = {},
): LifecycleOwnershipInspection {
  const walk = options.walkDirectory ?? listRelativeEntries;
  const outputs = new Map<string, Promise<OwnedOutputInspection>>();
  const unsafeParents = new Map<string, Promise<string | undefined>>();

  function inspectOutput(project: string, output: OwnershipOutputReceipt): Promise<OwnedOutputInspection> {
    // The cache key includes the canonical expected root identity. Legacy
    // directory member records are not ownership evidence and cannot cause a
    // second inspection or an alternate comparison path.
    const expected = JSON.stringify({ hash: output.hash, mode: output.mode, type: output.type });
    const key = `${project}\0${output.path}\0${expected}`;
    const existing = outputs.get(key);
    if (existing) return existing;
    const pending = output.type === "file"
      ? inspectFileOutput(project, output)
      : inspectDirectoryOutput(project, output, walk);
    if (output.type === "file") instrumentation.onInspectFile?.();
    else instrumentation.onInspectDirectory?.();
    outputs.set(key, pending);
    return pending.catch((error) => {
      outputs.delete(key);
      throw error;
    });
  }

  /** Fail fast on member paths that escape the reviewed root. */
  function resolveMemberPath(relativeRoot: string, memberPath: string): string {
    if (
      memberPath.length === 0 ||
      memberPath.startsWith("/") ||
      memberPath.split("/").some((segment) => segment === ".." || segment.length === 0)
    ) {
      throw new Error(`Directory member path escapes its root: ${memberPath}`);
    }
    return join(relativeRoot, memberPath);
  }

  async function listDirectoryMembers(
    project: string,
    relativeRoot: string,
  ): Promise<readonly ListedDirectoryMember[]> {
    const root = join(project, relativeRoot);
    let stats;
    try {
      stats = await lstat(root);
    } catch (error) {
      throw new Error(
        `Cannot list directory members under ${relativeRoot}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Cannot list directory members under ${relativeRoot}: not a directory`);
    }
    return walk(root);
  }

  async function readDirectoryMember(
    project: string,
    relativeRoot: string,
    memberPath: string,
  ): Promise<Uint8Array | undefined> {
    const relative = resolveMemberPath(relativeRoot, memberPath);
    const absolute = join(project, relative);
    let stats;
    try {
      stats = await lstat(absolute);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return undefined;
    return readFile(absolute);
  }

  function unsafeParentEvidence(
    project: string,
    relativePath: string,
  ): Promise<string | undefined> {
    const key = `${project}\0${relativePath}`;
    const existing = unsafeParents.get(key);
    if (existing) return existing;
    instrumentation.onUnsafeParent?.();
    const pending = unsafeOutputParent(project, relativePath);
    unsafeParents.set(key, pending);
    return pending.catch((error) => {
      unsafeParents.delete(key);
      throw error;
    });
  }

  return {
    inspectOutput,
    listDirectoryMembers,
    readDirectoryMember,
    unsafeParent: unsafeParentEvidence,
  };
}
