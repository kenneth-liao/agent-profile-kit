import { createHash } from "node:crypto";

/**
 * Shared changed-output comparison contract (US-020): one pure
 * current-disk-versus-planned comparison consumed by update now and by
 * dependent install/uninstall flows later. Consumers never reimplement the
 * diff or the review identity; history records carry the review identity and
 * paths only, never file contents (DEC-014, OOS-006).
 */
export type ChangedOutputOperation = "replace" | "remove";

export interface ChangedOutputComparison {
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  /** Deterministic identity of the reviewed bytes; safe for history. */
  readonly reviewId: string;
  /** Bounded unified-style view lines; rendering only, never persisted. */
  readonly diffLines: readonly string[];
  readonly truncated: boolean;
}

export interface ChangedOutputHistoryRecord {
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  readonly reviewId: string;
}

const MAX_DIFF_LINES = 200;
const MAX_LCS_LINES = 500;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function splitLines(value: string): readonly string[] {
  if (value === "") return [];
  const lines = value.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

/** Minimal line LCS for small generated files; larger inputs fall back. */
function diffLinePrefixes(current: readonly string[], planned: readonly string[]): readonly string[] {
  if (current.length > MAX_LCS_LINES || planned.length > MAX_LCS_LINES) {
    return [
      ...current.map((line) => `-${line}`),
      ...planned.map((line) => `+${line}`),
    ];
  }
  const rows = current.length + 1;
  const columns = planned.length + 1;
  const table = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
  for (let i = rows - 2; i >= 0; i -= 1) {
    for (let j = columns - 2; j >= 0; j -= 1) {
      table[i]![j]! = current[i] === planned[j]
        ? (table[i + 1]![j + 1]! + 1)
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < current.length && j < planned.length) {
    if (current[i] === planned[j]) {
      out.push(` ${current[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`-${current[i]}`);
      i += 1;
    } else {
      out.push(`+${planned[j]}`);
      j += 1;
    }
  }
  while (i < current.length) {
    out.push(`-${current[i]}`);
    i += 1;
  }
  while (j < planned.length) {
    out.push(`+${planned[j]}`);
    j += 1;
  }
  return out;
}

function reviewIdFor(options: {
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  readonly current: string | undefined;
  readonly planned: string | undefined;
}): string {
  return sha256Hex(JSON.stringify([
    options.operation,
    options.project,
    options.path,
    sha256Hex(options.current ?? "\0missing"),
    sha256Hex(options.planned ?? "\0deletion"),
  ]));
}

export function compareChangedOutput(options: {
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  /** Current on-disk bytes; undefined when the root is absent. */
  readonly current: string | undefined;
  /** Planned bytes; undefined when the operation deletes the root. */
  readonly planned: string | undefined;
  /**
   * Generated directory roots review by aggregate hash: the diff names the
   * root instead of dumping member bytes, while the review identity still
   * binds the exact hashes. File roots default to a line diff.
   */
  readonly contentKind?: "file" | "directory";
}): ChangedOutputComparison {
  if (options.contentKind === "directory") {
    const header = options.operation === "remove"
      ? [`--- current/${options.path}/`, `+++ /dev/null`]
      : [`--- current/${options.path}/`, `+++ planned/${options.path}/`];
    return {
      diffLines: [
        ...header,
        `directory ${options.path} changed on disk; compare the directory before deciding.`,
      ],
      operation: options.operation,
      path: options.path,
      project: options.project,
      reviewId: reviewIdFor(options),
      truncated: false,
    };
  }
  const currentLines = options.current === undefined ? [] : splitLines(options.current);
  const plannedLines = options.planned === undefined ? [] : splitLines(options.planned);
  const header = options.operation === "remove"
    ? [`--- current/${options.path}`, `+++ /dev/null`]
    : [`--- current/${options.path}`, `+++ planned/${options.path}`];
  const body = options.current === undefined && options.operation === "replace"
    ? plannedLines.map((line) => `+${line}`)
    : diffLinePrefixes(currentLines, plannedLines);
  const full = [...header, ...body];
  const truncated = full.length > MAX_DIFF_LINES;
  const diffLines = truncated
    ? [...full.slice(0, MAX_DIFF_LINES), `... truncated (${full.length - MAX_DIFF_LINES} more lines)`]
    : full;
  return {
    diffLines,
    operation: options.operation,
    path: options.path,
    project: options.project,
    reviewId: reviewIdFor(options),
    truncated,
  };
}

/** History-safe record: identity and paths only, never contents. */
export function historyRecordFor(comparison: ChangedOutputComparison): ChangedOutputHistoryRecord {
  return {
    operation: comparison.operation,
    path: comparison.path,
    project: comparison.project,
    reviewId: comparison.reviewId,
  };
}

/** Fresh safety check: the bytes about to execute must match the reviewed bytes. */
export function comparisonMatchesCurrent(
  comparison: ChangedOutputComparison,
  current: string | undefined,
  planned: string | undefined,
): boolean {
  return comparison.reviewId === reviewIdFor({
    current,
    operation: comparison.operation,
    path: comparison.path,
    planned,
    project: comparison.project,
  });
}
