import { createHash } from "node:crypto";

import { compareCanonicalStrings } from "../schemas/canonical.js";

/**
 * Shared changed-output comparison contract (US-020): one pure
 * current-disk-versus-planned comparison consumed by update now and by
 * dependent install/uninstall flows later. Consumers never reimplement the
 * diff or the review identity; history records carry the review identity and
 * paths only, never file contents (DEC-014, OOS-006).
 *
 * Review identity binds exact byte digests: decoded text is rendering only,
 * so concurrently swapped invalid bytes can never compare equal (INT-1).
 */
export type ChangedOutputOperation = "replace" | "remove";

/** Exact bytes on either side of a file comparison. */
export type RawBytes = string | Uint8Array;

/** One change-bearing hunk in file order, with surrounding context lines. */
export interface ChangeHunk {
  readonly heading: string;
  readonly lines: readonly string[];
}

export interface ChangedOutputComparison {
  readonly kind: "file" | "directory";
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  /** Deterministic identity of the reviewed bytes; safe for history. */
  readonly reviewId: string;
  /** Hex digest of the exact current bytes (or a `missing`/`unreadable:*` marker). */
  readonly currentDigest: string;
  /** Hex digest of the exact planned bytes, `deletion`, or a marker. */
  readonly plannedDigest: string;
  /** Change-bearing hunks in file order; display limits apply only at render time. */
  readonly hunks: readonly ChangeHunk[];
  /** Total added plus removed lines across every hunk. */
  readonly changedLines: number;
}

export interface ChangedOutputHistoryRecord {
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  readonly reviewId: string;
}

/** Member-level evidence for one generated directory root (INT-2). */
export interface DirectoryMemberEvidence {
  readonly path: string;
  readonly status: "added" | "removed" | "changed" | "unchanged";
  /** Change hunks for changed text members; paths alone carry added/removed. */
  readonly hunks?: readonly ChangeHunk[];
  /** Why a changed member renders no hunks (binary, unreadable). */
  readonly note?: string;
}

const HUNK_CONTEXT = 3;
const MAX_LCS_LINES = 500;
const MAX_HUNK_LINES = 100;
const LARGE_MEMBER_BYTES = 100_000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Hex digest of the exact bytes: strings hash as their UTF-8 encoding. */
export function digestBytes(value: RawBytes): string {
  return typeof value === "string"
    ? sha256Hex(value)
    : createHash("sha256").update(value).digest("hex");
}

/** Decoded text for rendering only; never used for identity. */
function decodeForRender(value: RawBytes): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function splitLines(value: string): string[] {
  if (value === "") return [];
  const lines = value.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

type DiffOp = { readonly type: " " | "-" | "+"; readonly text: string };

/** Minimal line operations via LCS for small inputs. */
function lcsOps(current: readonly string[], planned: readonly string[]): DiffOp[] {
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
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < current.length && j < planned.length) {
    if (current[i] === planned[j]) {
      ops.push({ type: " ", text: current[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: "-", text: current[i]! });
      i += 1;
    } else {
      ops.push({ type: "+", text: planned[j]! });
      j += 1;
    }
  }
  while (i < current.length) {
    ops.push({ type: "-", text: current[i]! });
    i += 1;
  }
  while (j < planned.length) {
    ops.push({ type: "+", text: planned[j]! });
    j += 1;
  }
  return ops;
}

/**
 * Bounded operations for large inputs: common prefix/suffix stay context and
 * the middle becomes one change block. Linear time; hunkification below still
 * guarantees the changed lines render with context.
 */
function trimmedOps(current: readonly string[], planned: readonly string[]): DiffOp[] {
  let prefix = 0;
  while (
    prefix < current.length &&
    prefix < planned.length &&
    current[prefix] === planned[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < planned.length - prefix &&
    current[current.length - 1 - suffix] === planned[planned.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...current.slice(0, prefix).map((text): DiffOp => ({ type: " ", text })),
    ...current.slice(prefix, current.length - suffix).map((text): DiffOp => ({ type: "-", text })),
    ...planned.slice(prefix, planned.length - suffix).map((text): DiffOp => ({ type: "+", text })),
    ...current.slice(current.length - suffix).map((text): DiffOp => ({ type: " ", text })),
  ];
}

function hunkHeading(aStart: number, aCount: number, bStart: number, bCount: number): string {
  const aRange = aCount === 0 ? `${aStart},0` : `${aStart + 1},${aCount}`;
  const bRange = bCount === 0 ? `${bStart},0` : `${bStart + 1},${bCount}`;
  return `@@ -${aRange} +${bRange} @@`;
}

/**
 * Contextual change hunks in file order (INT-3): only changed line ranges
 * with surrounding context become hunks, so display limits can never bury
 * every change under unchanged lines. Oversized change blocks split into
 * bounded hunks that paging can reach one by one.
 */
export function fileHunks(current: readonly string[], planned: readonly string[]): ChangeHunk[] {
  const ops = current.length > MAX_LCS_LINES || planned.length > MAX_LCS_LINES
    ? trimmedOps(current, planned)
    : lcsOps(current, planned);
  const changedAt = ops
    .map((op, index) => (op.type === " " ? -1 : index))
    .filter((index) => index >= 0);
  if (changedAt.length === 0) return [];
  // Group changed lines whose context windows overlap.
  const groups: number[][] = [];
  for (const index of changedAt) {
    const group = groups[groups.length - 1];
    if (group !== undefined && index - group[group.length - 1]! <= HUNK_CONTEXT * 2) {
      group.push(index);
    } else {
      groups.push([index]);
    }
  }
  const hunks: ChangeHunk[] = [];
  for (const group of groups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const windowStart = Math.max(0, first - HUNK_CONTEXT);
    const windowEnd = Math.min(ops.length, last + HUNK_CONTEXT + 1);
    // Emit the window in bounded hunks, tracking line numbers per hunk.
    let cursor = windowStart;
    let aLine = ops.slice(0, windowStart).filter((op) => op.type !== "+").length;
    let bLine = ops.slice(0, windowStart).filter((op) => op.type !== "-").length;
    while (cursor < windowEnd) {
      const slice = ops.slice(cursor, Math.min(windowEnd, cursor + MAX_HUNK_LINES));
      // Never split mid-change if the window is larger than the bound: extend
      // to the end of the running change before cutting.
      let end = cursor + slice.length;
      if (end < windowEnd) {
        while (end < windowEnd && ops[end]!.type !== " ") end += 1;
        while (end < windowEnd && end - cursor < MAX_HUNK_LINES && ops[end]!.type === " ") end += 1;
      }
      const lines = ops.slice(cursor, end).map((op) =>
        op.type === " " ? ` ${op.text}` : op.type === "-" ? `-${op.text}` : `+${op.text}`);
      const aCount = ops.slice(cursor, end).filter((op) => op.type !== "+").length;
      const bCount = ops.slice(cursor, end).filter((op) => op.type !== "-").length;
      hunks.push({ heading: hunkHeading(aLine, aCount, bLine, bCount), lines });
      aLine += aCount;
      bLine += bCount;
      cursor = end;
    }
  }
  return hunks;
}

/** Change hunks comparing two byte sequences, decoded for rendering only. */
export function hunksForBytes(current: RawBytes, planned: RawBytes): ChangeHunk[] {
  return fileHunks(splitLines(decodeForRender(current)), splitLines(decodeForRender(planned)));
}

function isBinaryBytes(value: Uint8Array): boolean {
  return value.includes(0);
}

/** One inspected member of a generated directory root. */
export interface InspectedDirectoryMember {
  readonly path: string;
  readonly type: "file" | "directory" | "other";
  readonly mode?: number;
}

/** One planned member of a generated directory root. */
export type PlannedDirectoryMember =
  | {
      /** Exact planned bytes. */
      readonly bytes: Uint8Array | string;
      readonly mode: number;
      readonly path: string;
      readonly type: "file";
    }
  | {
      readonly mode: number;
      readonly path: string;
      readonly type: "directory";
    };

/**
 * Shared directory comparison policy (INT-2): the live/planned union,
 * type/mode decisions, binary/large rules, and text comparison. Pure
 * except for the supplied member reader, which the caller binds to its own
 * inspection boundary — install/uninstall reuse this policy instead of
 * reimplementing it. Every non-unchanged member stays in the evidence so
 * paging, not a count cap, bounds the view.
 */
export async function compareDirectoryMembers(
  current: readonly InspectedDirectoryMember[],
  planned: readonly PlannedDirectoryMember[],
  readCurrentMember: (path: string) => Promise<Uint8Array | undefined>,
): Promise<readonly DirectoryMemberEvidence[]> {
  const plannedByPath = new Map(planned.map((member) => [member.path, member]));
  const currentByPath = new Map(current.map((member) => [member.path, member]));
  // Children under an added or removed directory are covered by the
  // directory entry itself.
  const coveredDirs = new Set([
    ...current.filter((member) => member.type === "directory" && !plannedByPath.has(member.path)),
    ...planned.filter((member) => member.type === "directory" && !currentByPath.has(member.path)),
  ].map((member) => member.path));
  const underCovered = (path: string): boolean =>
    [...coveredDirs].some((dir) => path !== dir && path.startsWith(`${dir}/`));
  const names = [...new Set([...currentByPath.keys(), ...plannedByPath.keys()])]
    .filter((name) => !underCovered(name))
    .sort((left, right) => compareCanonicalStrings(left, right));
  const members: DirectoryMemberEvidence[] = [];
  for (const name of names) {
    const live = currentByPath.get(name);
    const want = plannedByPath.get(name);
    if (live === undefined) {
      members.push({ path: name, status: "added" });
      continue;
    }
    if (want === undefined) {
      members.push({ path: name, status: "removed" });
      continue;
    }
    if (live.type !== "file" || want.type !== "file") {
      if (live.type === "directory" && want.type === "directory") continue;
      members.push({ path: name, status: "changed", note: "(type changed)" });
      continue;
    }
    const liveBytes = await readCurrentMember(name);
    if (liveBytes === undefined) {
      members.push({ path: name, status: "changed", note: "(could not be read)" });
      continue;
    }
    if (digestBytes(liveBytes) === digestBytes(want.bytes)) {
      if (live.mode !== undefined && live.mode !== want.mode) {
        members.push({ path: name, status: "changed", note: "(mode changed)" });
      }
      continue;
    }
    if (isBinaryBytes(liveBytes) || isBinaryBytes(Buffer.from(want.bytes))) {
      members.push({ path: name, status: "changed", note: "(binary contents not shown)" });
    } else if (liveBytes.byteLength > LARGE_MEMBER_BYTES) {
      members.push({ path: name, status: "changed", note: "(large contents: review on disk)" });
    } else {
      members.push({ path: name, status: "changed", hunks: hunksForBytes(liveBytes, want.bytes) });
    }
  }
  return members;
}

function reviewIdFor(options: {
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  readonly currentDigest: string;
  readonly plannedDigest: string;
}): string {
  return sha256Hex(JSON.stringify([
    options.operation,
    options.project,
    options.path,
    options.currentDigest,
    options.plannedDigest,
  ]));
}

export function compareChangedFile(options: {
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  /** Current on-disk bytes; undefined when the root is absent or unreadable. */
  readonly current?: RawBytes;
  /** Why absent current bytes cannot be shown (otherwise the root is missing). */
  readonly currentNote?: string;
  /** Planned bytes; undefined when the operation deletes the root. */
  readonly planned?: RawBytes;
}): ChangedOutputComparison {
  const currentDigest = options.current === undefined
    ? (options.currentNote ?? "missing")
    : digestBytes(options.current);
  const plannedDigest = options.planned === undefined ? "deletion" : digestBytes(options.planned);
  const currentLines = options.current === undefined ? [] : splitLines(decodeForRender(options.current));
  const plannedLines = options.planned === undefined ? [] : splitLines(decodeForRender(options.planned));
  const hunks = options.current === undefined && options.currentNote !== undefined
    ? [{ heading: "@@ unavailable @@", lines: [options.currentNote] }]
    : fileHunks(currentLines, plannedLines);
  return {
    changedLines: hunks.flatMap((hunk) => hunk.lines).filter((line) =>
      line.startsWith("-") || line.startsWith("+")).length,
    currentDigest,
    hunks,
    kind: "file",
    operation: options.operation,
    path: options.path,
    plannedDigest,
    project: options.project,
    reviewId: reviewIdFor({ ...options, currentDigest, plannedDigest }),
  };
}

export function compareChangedDirectory(options: {
  readonly operation: ChangedOutputOperation;
  readonly path: string;
  readonly project: string;
  /** Aggregate hash of the current tree; undefined when the root is absent. */
  readonly currentHash?: string;
  /** Aggregate hash of the planned tree; undefined when the operation deletes it. */
  readonly plannedHash?: string;
  readonly members: readonly DirectoryMemberEvidence[];
  /** Rendered when the root changed type and member evidence cannot apply. */
  readonly note?: string;
}): ChangedOutputComparison {
  const currentDigest = options.currentHash ?? "missing";
  const plannedDigest = options.operation === "remove"
    ? "deletion"
    : (options.plannedHash ?? "deletion");
  const hunks: ChangeHunk[] = [];
  if (options.note !== undefined) {
    hunks.push({ heading: "@@ changed @@", lines: [options.note] });
  }
  // Every non-unchanged member stays in the evidence: the shared paging
  // path bounds the view, so no count cap may permanently drop a path.
  const changed = options.members.filter((member) => member.status !== "unchanged");
  for (const member of changed) {
    if (member.status === "changed" && member.hunks !== undefined && member.hunks.length > 0) {
      hunks.push({
        heading: `member ${member.path} (${member.status})`,
        lines: member.hunks.flatMap((hunk) => [hunk.heading, ...hunk.lines]),
      });
    } else {
      hunks.push({
        heading: `member ${member.path} (${member.status})`,
        lines: member.note === undefined ? [] : [member.note],
      });
    }
  }
  const unchanged = options.members.length - changed.length;
  if (unchanged > 0) {
    hunks.push({ heading: "unchanged", lines: [`(${unchanged} unchanged members)`] });
  }
  return {
    changedLines: hunks.flatMap((hunk) => hunk.lines).filter((line) =>
      line.startsWith("-") || line.startsWith("+")).length,
    currentDigest,
    hunks,
    kind: "directory",
    operation: options.operation,
    path: options.path,
    plannedDigest,
    project: options.project,
    reviewId: reviewIdFor({ ...options, currentDigest, plannedDigest }),
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

/** Fresh safety check: the live digests must match the reviewed digests. */
export function comparisonMatchesDigests(
  comparison: ChangedOutputComparison,
  currentDigest: string,
  plannedDigest: string,
): boolean {
  return comparison.reviewId === reviewIdFor({
    currentDigest,
    operation: comparison.operation,
    path: comparison.path,
    plannedDigest,
    project: comparison.project,
  });
}
