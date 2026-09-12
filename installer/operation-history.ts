import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { applicationDirectory } from "./application-directory.js";
import type { ChangedOutputHistoryRecord } from "./changed-output-review.js";
import { withExclusiveFileLock } from "./exclusive-file-lock.js";

export const OPERATION_HISTORY_SCHEMA_VERSION = 1;
/** Retained lifecycle runs: new entries evict the oldest only after this cap. */
export const OPERATION_HISTORY_LIMIT = 200;
export const OPERATION_HISTORY_FILE = "operation-history.json";
export const OPERATION_HISTORY_LOCK_FILE = "operation-history.lock";

export type LifecycleOperationCommand = "install" | "update" | "uninstall";
export type OperationHistoryOutcome =
  | "blocked"
  | "cancelled"
  | "failed"
  | "no-op"
  | "partial"
  | "succeeded";
export type OperationHistoryProjectResult =
  | "completed"
  | "failed"
  | "skipped"
  | "unattempted"
  | "unchanged";
export type OperationHistorySelection = "all" | "project";
export type OperationHistoryFilter = "blocked" | "stale";
export type OperationHistoryCancelledReason = "cancelled" | "declined";
export type LifecycleOperationReviewRecord = ChangedOutputHistoryRecord;

/** The requested scope of one lifecycle operation. */
export interface OperationHistoryScope {
  readonly selection: OperationHistorySelection;
  readonly filter?: OperationHistoryFilter;
  readonly profile?: string;
  readonly hosts?: readonly string[];
}

/**
 * One Project's evidence in a retained run. `written`/`removed` carry
 * Project-relative generated paths only — never file contents.
 */
export interface OperationHistoryProject {
  /** Authored Project spelling retained for display. */
  readonly project: string;
  readonly canonicalProject: string;
  readonly profile?: string;
  /**
   * The Hosts this run's Project work covered: installed for install/update,
   * removed for uninstall (the entry's `command` owns the direction).
   */
  readonly hosts?: readonly string[];
  readonly result: OperationHistoryProjectResult;
  readonly written?: readonly string[];
  readonly removed?: readonly string[];
  /**
   * Generated output was committed for this Project and this evidence does not
   * enumerate its exact paths: the post-verify concurrent-change stop and a
   * late authorization stop that carried only Project identities.
   */
  readonly outputCommitted?: boolean;
  /** Carried failure or skip detail, never rendered prose. */
  readonly failure?: string;
  readonly restored?: boolean;
}

/** One retained lifecycle operation (DEC-008). */
export interface OperationHistoryEntry {
  /** Stable persisted identity: `op-` plus the monotonic operation sequence. */
  readonly id: string;
  readonly command: LifecycleOperationCommand;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly outcome: OperationHistoryOutcome;
  readonly scope: OperationHistoryScope;
  readonly projects: readonly OperationHistoryProject[];
  /** Run-level carried failure detail (facts, never rendered prose). */
  readonly failure?: string;
  readonly cancelledReason?: OperationHistoryCancelledReason;
  readonly reviewedChangedOutputs?: readonly LifecycleOperationReviewRecord[];
}

/** One entry before the store assigns its stable identity. */
export type OperationHistoryEntryDraft = Omit<OperationHistoryEntry, "id">;

export interface OperationHistory {
  readonly schemaVersion: number;
  readonly entries: readonly OperationHistoryEntry[];
}

export interface OperationHistoryFileSystem {
  readonly mkdir: typeof mkdir;
  readonly readFile: typeof readFile;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly writeFile: typeof writeFile;
}

const defaultFileSystem: OperationHistoryFileSystem = {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
};

/** One history read or publication that could not be completed safely. */
export class OperationHistoryUnavailableError extends Error {
  readonly detail: string;
  readonly path: string | undefined;

  constructor(detail: string, path?: string) {
    super(
      path === undefined
        ? `operation history is invalid: ${detail}`
        : `operation history is unavailable at ${path}: ${detail}`,
    );
    this.name = "OperationHistoryUnavailableError";
    this.detail = detail;
    this.path = path;
  }
}

/** Absolute path of the one machine-local operation-history document. */
export function operationHistoryPath(home: string): string {
  return join(applicationDirectory(home), OPERATION_HISTORY_FILE);
}

/** Absolute path of the dedicated history publication lock (beside the document). */
export function operationHistoryLockPath(home: string): string {
  return join(applicationDirectory(home), OPERATION_HISTORY_LOCK_FILE);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(detail: string, path?: string): never {
  throw new OperationHistoryUnavailableError(detail, path);
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
  path?: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) invalid(`${what} has unknown field '${key}'`, path);
  }
}

function requireText(value: unknown, what: string, path?: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${what} must be a non-empty string`, path);
  }
  return value;
}

function requireStringArray(value: unknown, what: string, path?: string): readonly string[] {
  if (!Array.isArray(value)) invalid(`${what} must be an array of strings`, path);
  return value.map((entry) => requireText(entry, what, path));
}

function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  what: string,
  path?: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalid(`${what} must be one of ${allowed.join(", ")}`, path);
  }
  return value as T;
}

function requireTime(value: unknown, what: string, path?: string): string {
  const text = requireText(value, what, path);
  if (Number.isNaN(Date.parse(text))) invalid(`${what} must be an ISO-8601 timestamp`, path);
  return text;
}

const COMMANDS: readonly LifecycleOperationCommand[] = ["install", "uninstall", "update"];
const OUTCOMES: readonly OperationHistoryOutcome[] = [
  "blocked",
  "cancelled",
  "failed",
  "no-op",
  "partial",
  "succeeded",
];
const PROJECT_RESULTS: readonly OperationHistoryProjectResult[] = [
  "completed",
  "failed",
  "skipped",
  "unattempted",
  "unchanged",
];
const SELECTIONS: readonly OperationHistorySelection[] = ["all", "project"];
const FILTERS: readonly OperationHistoryFilter[] = ["blocked", "stale"];
const CANCELLED_REASONS: readonly OperationHistoryCancelledReason[] = ["cancelled", "declined"];
const REVIEW_OPERATIONS: readonly LifecycleOperationReviewRecord["operation"][] = ["remove", "replace"];

const ENTRY_FIELDS = [
  "id",
  "command",
  "startedAt",
  "finishedAt",
  "outcome",
  "scope",
  "projects",
  "failure",
  "cancelledReason",
  "reviewedChangedOutputs",
] as const;
const SCOPE_FIELDS = ["selection", "filter", "profile", "hosts"] as const;
const PROJECT_FIELDS = [
  "project",
  "canonicalProject",
  "profile",
  "hosts",
  "result",
  "written",
  "removed",
  "outputCommitted",
  "failure",
  "restored",
] as const;
const REVIEW_FIELDS = ["operation", "path", "project", "reviewId"] as const;

function parseScope(value: unknown, path?: string): OperationHistoryScope {
  if (!isRecord(value)) invalid("scope must be an object", path);
  requireExactKeys(value, SCOPE_FIELDS, "scope", path);
  return {
    selection: requireOneOf(value.selection, SELECTIONS, "scope selection", path),
    ...(value.filter === undefined
      ? {}
      : { filter: requireOneOf(value.filter, FILTERS, "scope filter", path) }),
    ...(value.profile === undefined
      ? {}
      : { profile: requireText(value.profile, "scope profile", path) }),
    ...(value.hosts === undefined
      ? {}
      : { hosts: requireStringArray(value.hosts, "scope hosts", path) }),
  };
}

function parseProject(value: unknown, path?: string): OperationHistoryProject {
  if (!isRecord(value)) invalid("project record must be an object", path);
  requireExactKeys(value, PROJECT_FIELDS, "project record", path);
  return {
    project: requireText(value.project, "project identity", path),
    canonicalProject: requireText(value.canonicalProject, "project canonical identity", path),
    ...(value.profile === undefined
      ? {}
      : { profile: requireText(value.profile, "project profile", path) }),
    ...(value.hosts === undefined
      ? {}
      : { hosts: requireStringArray(value.hosts, "project hosts", path) }),
    result: requireOneOf(value.result, PROJECT_RESULTS, "project result", path),
    ...(value.written === undefined
      ? {}
      : { written: requireStringArray(value.written, "project written paths", path) }),
    ...(value.removed === undefined
      ? {}
      : { removed: requireStringArray(value.removed, "project removed paths", path) }),
    ...(value.outputCommitted === undefined
      ? {}
      : {
          outputCommitted: requireBoolean(
            value.outputCommitted,
            "project committed-output evidence",
            path,
          ),
        }),
    ...(value.failure === undefined
      ? {}
      : { failure: requireText(value.failure, "project failure detail", path) }),
    ...(value.restored === undefined
      ? {}
      : { restored: requireBoolean(value.restored, "project restoration evidence", path) }),
  };
}

function requireBoolean(value: unknown, what: string, path?: string): boolean {
  if (typeof value !== "boolean") invalid(`${what} must be a boolean`, path);
  return value;
}

function parseReviewRecord(value: unknown, path?: string): LifecycleOperationReviewRecord {
  if (!isRecord(value)) invalid("changed-output review record must be an object", path);
  requireExactKeys(value, REVIEW_FIELDS, "changed-output review record", path);
  return {
    operation: requireOneOf(value.operation, REVIEW_OPERATIONS, "review operation", path),
    path: requireText(value.path, "review path", path),
    project: requireText(value.project, "review project", path),
    reviewId: requireText(value.reviewId, "review identity", path),
  };
}

/** The monotonic operation sequence carried by one stored identity. */
export function operationSequence(id: string): number | undefined {
  const match = /^op-(\d{6,})$/.exec(id);
  return match === null ? undefined : Number.parseInt(match[1]!, 10);
}

function parseEntry(value: unknown, path?: string): OperationHistoryEntry {
  if (!isRecord(value)) invalid("entry must be an object", path);
  requireExactKeys(value, ENTRY_FIELDS, "entry", path);
  const id = requireText(value.id, "entry id", path);
  if (operationSequence(id) === undefined) invalid(`entry id '${id}' is not an op-<sequence> identity`, path);
  const outcome = requireOneOf(value.outcome, OUTCOMES, "entry outcome", path);
  const cancelledReason = value.cancelledReason === undefined
    ? undefined
    : requireOneOf(value.cancelledReason, CANCELLED_REASONS, "cancellation reason", path);
  if (outcome === "cancelled" && cancelledReason === undefined) {
    invalid("a cancelled entry must carry its cancellation reason", path);
  }
  if (outcome !== "cancelled" && cancelledReason !== undefined) {
    invalid("only a cancelled entry may carry a cancellation reason", path);
  }
  if (!Array.isArray(value.projects)) invalid("entry projects must be an array", path);
  const projects = value.projects.map((project) => parseProject(project, path));
  if (value.reviewedChangedOutputs !== undefined && !Array.isArray(value.reviewedChangedOutputs)) {
    invalid("entry changed-output reviews must be an array", path);
  }
  return {
    id,
    command: requireOneOf(value.command, COMMANDS, "entry command", path),
    startedAt: requireTime(value.startedAt, "entry start time", path),
    finishedAt: requireTime(value.finishedAt, "entry finish time", path),
    outcome,
    scope: parseScope(value.scope, path),
    projects,
    ...(value.failure === undefined ? {} : { failure: requireText(value.failure, "entry failure detail", path) }),
    ...(cancelledReason === undefined ? {} : { cancelledReason }),
    ...(value.reviewedChangedOutputs === undefined
      ? {}
      : {
          reviewedChangedOutputs: (value.reviewedChangedOutputs as readonly unknown[])
            .map((record) => parseReviewRecord(record, path)),
        }),
  };
}

/**
 * Parse one history document exactly as this module publishes it: exact fields,
 * unique identities in strictly decreasing sequence order, and at most the
 * retained entry cap (older entries beyond it are dropped, never reinterpreted).
 * Anything else fails closed so a foreign or corrupt file is never interpreted
 * as this store's evidence — and never overwritten by an append.
 */
export function parseOperationHistory(source: string, path?: string): OperationHistory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalid("the document is not valid JSON", path);
  }
  if (!isRecord(parsed)) invalid("the document must be a JSON object", path);
  requireExactKeys(parsed, ["schemaVersion", "entries"], "document", path);
  if (parsed.schemaVersion !== OPERATION_HISTORY_SCHEMA_VERSION) {
    invalid(
      `schema version ${String(parsed.schemaVersion)} is not supported (expected ${OPERATION_HISTORY_SCHEMA_VERSION})`,
      path,
    );
  }
  if (!Array.isArray(parsed.entries)) invalid("entries must be an array", path);
  // The retained window is a bound, not a shape violation: a document written
  // by an engine with a larger cap (or a future reduction of this one) reads as
  // its newest entries instead of becoming permanently unreadable.
  const entries = parsed.entries
    .map((entry) => parseEntry(entry, path))
    .slice(0, OPERATION_HISTORY_LIMIT);
  for (let index = 1; index < entries.length; index += 1) {
    const previous = operationSequence(entries[index - 1]!.id)!;
    const current = operationSequence(entries[index]!.id)!;
    if (current >= previous) {
      invalid(`entry '${entries[index]!.id}' must follow '${entries[index - 1]!.id}' in newest-first order`, path);
    }
  }
  return { schemaVersion: OPERATION_HISTORY_SCHEMA_VERSION, entries };
}

/** One entry in canonical field order; empty optional collections are omitted. */
function canonicalEntry(entry: OperationHistoryEntry): OperationHistoryEntry {
  const canonicalProject = (project: OperationHistoryProject): OperationHistoryProject => ({
    project: project.project,
    canonicalProject: project.canonicalProject,
    ...(project.profile === undefined ? {} : { profile: project.profile }),
    ...(project.hosts === undefined ? {} : { hosts: [...project.hosts] }),
    result: project.result,
    ...(project.written === undefined || project.written.length === 0
      ? {}
      : { written: [...project.written] }),
    ...(project.removed === undefined || project.removed.length === 0
      ? {}
      : { removed: [...project.removed] }),
    ...(project.outputCommitted === true ? { outputCommitted: true } : {}),
    ...(project.failure === undefined ? {} : { failure: project.failure }),
    ...(project.restored === undefined ? {} : { restored: project.restored }),
  });
  return {
    id: entry.id,
    command: entry.command,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    outcome: entry.outcome,
    scope: {
      selection: entry.scope.selection,
      ...(entry.scope.filter === undefined ? {} : { filter: entry.scope.filter }),
      ...(entry.scope.profile === undefined ? {} : { profile: entry.scope.profile }),
      ...(entry.scope.hosts === undefined || entry.scope.hosts.length === 0
        ? {}
        : { hosts: [...entry.scope.hosts] }),
    },
    projects: entry.projects.map(canonicalProject),
    ...(entry.failure === undefined ? {} : { failure: entry.failure }),
    ...(entry.cancelledReason === undefined ? {} : { cancelledReason: entry.cancelledReason }),
    ...(entry.reviewedChangedOutputs === undefined || entry.reviewedChangedOutputs.length === 0
      ? {}
      : {
          reviewedChangedOutputs: entry.reviewedChangedOutputs.map((record) => ({
            operation: record.operation,
            path: record.path,
            project: record.project,
            reviewId: record.reviewId,
          })),
        }),
  };
}

/** Serialize one normalized document exactly as the production reader accepts it. */
export function formatOperationHistory(history: OperationHistory): string {
  return `${JSON.stringify(
    {
      schemaVersion: OPERATION_HISTORY_SCHEMA_VERSION,
      entries: history.entries.map(canonicalEntry),
    },
    null,
    2,
  )}\n`;
}

function emptyHistory(): OperationHistory {
  return { schemaVersion: OPERATION_HISTORY_SCHEMA_VERSION, entries: [] };
}

async function readSource(
  path: string,
  fileSystem: OperationHistoryFileSystem,
): Promise<string | undefined> {
  try {
    return await fileSystem.readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    const detail = error instanceof Error ? error.message : String(error);
    throw new OperationHistoryUnavailableError(detail, path);
  }
}

async function readHistoryAt(
  path: string,
  fileSystem: OperationHistoryFileSystem,
): Promise<OperationHistory> {
  const source = await readSource(path, fileSystem);
  return source === undefined ? emptyHistory() : parseOperationHistory(source, path);
}

/**
 * Read the retained history without writing anything. An absent document is an
 * empty history; an unreadable, invalid, or unsupported document fails closed
 * with its path so the caller can tell the user what to fix.
 */
export async function readOperationHistory(
  home: string,
  options: { readonly fileSystem?: Partial<OperationHistoryFileSystem> } = {},
): Promise<OperationHistory> {
  const fileSystem: OperationHistoryFileSystem = { ...defaultFileSystem, ...options.fileSystem };
  return readHistoryAt(operationHistoryPath(home), fileSystem);
}

function nextEntryId(history: OperationHistory): string {
  const highest = history.entries.reduce((maximum, entry) => {
    return Math.max(maximum, operationSequence(entry.id)!);
  }, 0);
  return `op-${String(highest + 1).padStart(6, "0")}`;
}

async function publishHistory(
  path: string,
  history: OperationHistory,
  fileSystem: OperationHistoryFileSystem,
): Promise<void> {
  const source = formatOperationHistory(history);
  // Publication is allowed only when the production reader accepts the exact
  // bytes. That pre-write proof is the whole proof: installation-state
  // publication re-reads after the rename because ownership evidence must fail
  // closed, while a diagnostic history re-read under the held lock could only
  // fail spuriously and would report an entry as unsaved after writing it.
  parseOperationHistory(source, path);
  const directory = dirname(path);
  await fileSystem.mkdir(directory, { recursive: true });
  const temporary = join(directory, `.operation-history-${process.pid}-${Date.now()}.tmp`);
  await fileSystem.writeFile(temporary, source, { flag: "wx", mode: 0o600 });
  try {
    await fileSystem.rename(temporary, path);
  } finally {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Append one entry under the exclusive history lock: re-read, append, evict the
 * oldest entries only beyond the cap, and atomically replace the document.
 * Concurrent writers therefore cannot lose a retained report or observe a torn
 * document. Returns the saved entry with its stable identity.
 */
export async function appendOperationHistory(
  home: string,
  draft: OperationHistoryEntryDraft,
  options: {
    readonly fileSystem?: Partial<OperationHistoryFileSystem>;
    readonly lockTimeoutMs?: number;
  } = {},
): Promise<OperationHistoryEntry> {
  const fileSystem: OperationHistoryFileSystem = { ...defaultFileSystem, ...options.fileSystem };
  const path = operationHistoryPath(home);
  return withExclusiveFileLock({
    lockPath: operationHistoryLockPath(home),
    busyError: () =>
      new OperationHistoryUnavailableError("another writer holds the history lock", path),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    body: async () => {
      const current = await readHistoryAt(path, fileSystem);
      const entry = canonicalEntry({
        id: nextEntryId(current),
        ...draft,
      });
      const next: OperationHistory = {
        schemaVersion: OPERATION_HISTORY_SCHEMA_VERSION,
        entries: [entry, ...current.entries].slice(0, OPERATION_HISTORY_LIMIT),
      };
      try {
        await publishHistory(path, next, fileSystem);
      } catch (error) {
        if (error instanceof OperationHistoryUnavailableError) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new OperationHistoryUnavailableError(detail, path);
      }
      return entry;
    },
  });
}
