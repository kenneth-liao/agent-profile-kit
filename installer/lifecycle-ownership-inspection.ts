import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  INSTALLATION_MARKER_PATH,
  parseInstallationMarker,
  type InstallationMarker,
} from "../schemas/installation-manifest.js";
import type { OwnershipOutputReceipt } from "../schemas/ownership-state.js";
import { hashBytes, hashDirectoryMembersFromFiles, markerPath } from "./project-plan.js";

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
  readonly onInspectMarker?: () => void;
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
   * is proven absent (repairable); `unreadable` is an explicit non-repairable
   * inspection failure for a root or traversal that cannot be proven.
   */
  readonly kind: "directory" | "file" | "missing" | "other" | "unreadable";
  /** Regular-file bytes when the output root is a regular file. */
  readonly content?: string;
  /** Deterministic hash of `content` when the output root is a regular file. */
  readonly contentHash?: string;
  /** Deterministic aggregate hash when the output root is a readable safe directory. */
  readonly directoryHash?: string;
  /** Root mode when the output root is a regular file or directory. */
  readonly mode?: number;
}

/** One normalized Installation Marker evidence snapshot for one project root. */
export interface MarkerInspection {
  readonly kind: "file" | "missing" | "other";
  /** Regular-file bytes when the Marker path is a regular file. */
  readonly content: string | undefined;
  /** Root mode when the Marker path is a regular file. */
  readonly mode: number | undefined;
  /** Parsed Marker value when the file parses cleanly. */
  readonly value: InstallationMarker | undefined;
  /** Parse failure message when the file is a regular file but malformed. */
  readonly malformed: string | undefined;
}

/**
 * One invocation-scoped reader for ordinary owned outputs, Installation Marker
 * evidence, and unsafe-parent evidence. Each owned output is read or walked at
 * most once per reconciliation pass; every consumer shares the same root result.
 * Discarded when the lifecycle command exits; never persisted or shared across
 * commands.
 */
export interface LifecycleOwnershipInspection {
  inspectMarker(project: string): Promise<MarkerInspection>;
  inspectOutput(project: string, output: OwnershipOutputReceipt): Promise<OwnedOutputInspection>;
  unsafeParent(project: string, relativePath: string): Promise<string | undefined>;
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
  // Only a proven-absent root (lstat ENOENT) is repairable. Every other root or
  // traversal failure is non-repairable so extant output cannot enter repair.
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return { kind: "other" };
    mode = stats.mode & 0o7777;
  } catch (error) {
    return { kind: hasErrorCode(error, "ENOENT") ? "missing" : "unreadable" };
  }

  try {
    const entries = await walk(root);
    if (entries.some((entry) => entry.type === "other")) return { kind: "other", mode };
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
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return { kind: "unreadable" };
  }
  return {
    content,
    contentHash: hashBytes(content),
    kind: "file",
    mode: stats.mode & 0o7777,
  };
}

/**
 * Prove path-safety evidence for one project-relative output path: every parent
 * and the path itself must be real directories, never symlinks. A missing
 * parent chain is safe (the Installer may create it); a non-directory or
 * symlink parent is not.
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
      if (hasErrorCode(error, "ENOTDIR")) return `${parent} is a non-directory parent`;
      throw error;
    }
    if (stats.isSymbolicLink()) return `${parent} is a symlink parent`;
    if (!stats.isDirectory()) return `${parent} is a non-directory parent`;
    parent = join(parent, part);
  }
  let stats;
  try {
    stats = await lstat(parent);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    if (hasErrorCode(error, "ENOTDIR")) return `${parent} is a non-directory parent`;
    throw error;
  }
  if (stats.isSymbolicLink()) return `${parent} is a symlink parent`;
  if (!stats.isDirectory()) return `${parent} is a non-directory parent`;
  return undefined;
}

async function inspectMarkerFile(project: string): Promise<MarkerInspection> {
  const path = markerPath(project);
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { content: undefined, kind: "missing", malformed: undefined, mode: undefined, value: undefined };
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { content: undefined, kind: "other", malformed: undefined, mode: undefined, value: undefined };
  }
  const content = await readFile(path, "utf8");
  try {
    return { content, kind: "file", malformed: undefined, mode: stats.mode & 0o7777, value: parseInstallationMarker(content) };
  } catch (error) {
    return {
      content,
      kind: "file",
      malformed: error instanceof Error ? error.message : String(error),
      mode: stats.mode & 0o7777,
      value: undefined,
    };
  }
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
  const markers = new Map<string, Promise<MarkerInspection>>();
  const unsafeParents = new Map<string, Promise<string | undefined>>();

  function inspectMarker(project: string): Promise<MarkerInspection> {
    const existing = markers.get(project);
    if (existing) return existing;
    instrumentation.onInspectMarker?.();
    const pending = inspectMarkerFile(project);
    markers.set(project, pending);
    return pending.catch((error) => {
      markers.delete(project);
      throw error;
    });
  }

  function inspectOutput(project: string, output: OwnershipOutputReceipt): Promise<OwnedOutputInspection> {
    // The cache key includes the canonical expected root identity. Legacy
    // directory member records are not ownership evidence and cannot cause a
    // second inspection or an alternate comparison path.
    const expected = JSON.stringify({ hash: output.hash, mode: output.mode, type: output.type });
    const key = `${project}\0${output.path}\0${expected}`;
    const existing = outputs.get(key);
    if (existing) return existing;
    // The Installation Marker is an owned file output whose content is already
    // normalized by the Marker reader; reuse it so the Marker file is read once.
    const pending =
      output.path === INSTALLATION_MARKER_PATH
        ? markerOutputInspection(project)
        : output.type === "file"
          ? inspectFileOutput(project, output)
          : inspectDirectoryOutput(project, output, walk);
    if (output.path !== INSTALLATION_MARKER_PATH) {
      if (output.type === "file") instrumentation.onInspectFile?.();
      else instrumentation.onInspectDirectory?.();
    }
    outputs.set(key, pending);
    return pending.catch((error) => {
      outputs.delete(key);
      throw error;
    });
  }

  async function markerOutputInspection(project: string): Promise<OwnedOutputInspection> {
    const marker = await inspectMarker(project);
    if (marker.kind === "file" && marker.content !== undefined && marker.mode !== undefined) {
      return {
        content: marker.content,
        contentHash: hashBytes(marker.content),
        kind: "file",
        mode: marker.mode,
      };
    }
    return { kind: marker.kind };
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
    inspectMarker,
    inspectOutput,
    unsafeParent: unsafeParentEvidence,
  };
}
