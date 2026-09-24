/**
 * Presentation for retained lifecycle operation history (US-012, DEC-007,
 * DEC-008): one renderer for a stored entry, its compact list, and the
 * complete evidence a run displays when its entry could not be saved. Machine
 * JSON is one dedicated family (`schemaVersion: 1`), separate from the
 * reconciliation contract (ADR-0023), and never carries file contents.
 */
import type { Writable } from "node:stream";

import { COMMAND_NAME } from "../installer/version.js";
import {
  OPERATION_HISTORY_LIMIT,
  type OperationHistoryEntry,
  type OperationHistoryEntryDraft,
  type OperationHistoryOutcome,
  type OperationHistoryProject,
  type OperationHistoryScope,
} from "../installer/operation-history.js";
import { diagnosticDocument } from "./diagnostics.js";
import type { LifecycleOperationRecording } from "./operation-recording.js";
import {
  type TerminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";
import {
  commandNode,
  commandPart,
  footerNodes,
  identifierPart,
  list,
  notedCommand,
  part,
  pathPart,
  writeHumanDocument,
  type CommandArg,
  type CommandNode,
  type InlineContent,
  type NoticeSeverity,
  type PresentationDocument,
  type PresentationNode,
  type SemanticCategory,
} from "./presentation-document.js";

const arg = (value: string): CommandArg => ({ kind: "text", value });

export const DETAILS_MACHINE_SCHEMA_VERSION = 1;

/**
 * The completed-operation detail route (US-008, DEC-007; ADR-0040): one
 * discoverable `Details: apkit details` line that retrieves the run's retained
 * evidence. It names the read-only history command, never a re-run of the
 * lifecycle command, and it carries the one short note saying what the run
 * shows (`notedCommand`, review rule 6). The write helper below emits it
 * exactly when the recorded facts say something went wrong (DEC-007, D4).
 */
export function operationDetailsDocument(note: string): PresentationDocument {
  return [footerNodes({ details: operationDetailsCommand(note) })];
}

/** The typed completed-operation details command, with its display-only note. */
export function operationDetailsCommand(note: string): CommandNode {
  return notedCommand(
    { kind: "command", program: COMMAND_NAME, args: [arg("details")] },
    note,
  );
}

/**
 * The recorded facts the one details-route rule reads (US-008, DEC-007).
 * Never rendered copy: `hasWarnings` is the lifecycle report's warning fact,
 * and `hasFileWork` is the recorded operation's committed-or-attempted file
 * work.
 */
export interface DetailsRouteFacts {
  readonly outcome: OperationHistoryOutcome;
  readonly hasWarnings: boolean;
  readonly hasFileWork: boolean;
}

export interface DetailsRouteDecision {
  readonly show: boolean;
  readonly note: string;
}

/**
 * The one shared details-route rule (US-008, DEC-007, D4): the route appears
 * only after a failure, a blocked run, a warning or a partial run. Normal
 * successes — a clean success, a clean no-op, a neutral cancellation — omit
 * it. Decided from recorded facts only; presentation never reads its own
 * output to choose what to show. The note says what the run shows: file work
 * (the same paths the `Changed files` section renders) reads "changed"; a run
 * that only checked reads "checked" (review screens 27 and 28). History
 * retention and explicit `apkit details` retrieval are unchanged.
 */
export function detailsRouteDecision(facts: DetailsRouteFacts): DetailsRouteDecision {
  const wentWrong =
    facts.outcome === "failed" ||
    facts.outcome === "partial" ||
    facts.outcome === "blocked";
  return {
    show: wentWrong || facts.hasWarnings,
    note: facts.hasFileWork
      ? "see exactly what changed"
      : "see exactly what this run checked",
  };
}

function documentHasFooterAction(document: PresentationDocument): boolean {
  return flattenDocumentNodes(document).some(
    (node) =>
      (node.kind === "key-value" && node.key === "Next") ||
      (node.kind === "heading" && node.text === "Next:"),
  );
}

/** The document's nodes with authored parts flattened, in order. */
function flattenDocumentNodes(document: PresentationDocument): readonly PresentationNode[] {
  return document.flatMap((node) =>
    node.kind === "part" ? node.nodes : [node]);
}

/**
 * Whether one recorded Project carries file work — the exact predicate the
 * `Changed files` section renders (US-008): written or removed paths, or
 * committed output whose paths were not enumerated. A failed attempt with no
 * such paths is not file work.
 */
function projectHasChangedFiles(project: OperationHistoryProject): boolean {
  return (
    (project.written !== undefined && project.written.length > 0) ||
    (project.removed !== undefined && project.removed.length > 0) ||
    project.outputCommitted === true
  );
}

/** Whether the recorded operation committed any file work. */
function projectsHaveFileWork(projects: readonly OperationHistoryProject[]): boolean {
  return projects.some(projectHasChangedFiles);
}

/**
 * Write one run's terminal human report and, exactly when the run retained an
 * operation-history entry and the one details-route rule says this run went
 * wrong (US-008, DEC-007; ADR-0040), its completed-operation detail route.
 * The route is the secondary line of the report's one footer block: when the
 * report already carries a `Next` action list the details line follows it with
 * no second blank line, so no output prints two footers. The route follows the
 * stream that carries the report, so a declined or failed run keeps its
 * evidence pointer beside its own diagnostic while a pre-write refusal that
 * records nothing never advertises `apkit details`. An unsaved entry still
 * prints the route because that run displayed its complete evidence (DEC-008).
 * Machine JSON callers keep stdout parseable and never call this. `route` is
 * `false` only for `--verbose`, which already prints the complete current-run
 * receipt.
 *
 * The branch's recording decision is read here, after the branch decided and
 * before the finish boundary publishes it. A report written before its branch
 * decided is a developer error and fails loudly here instead of silently
 * dropping the route later, mirroring the finish boundary's own undecided
 * guard.
 */
export function writeLifecycleReport(
  stream: Writable & TerminalStream,
  document: PresentationDocument,
  context: TerminalPresentationContext,
  recording: LifecycleOperationRecording,
  route = true,
): void {
  const { collected, refusal } = recording;
  if (collected === undefined && refusal === undefined) {
    throw new Error(
      "lifecycle terminal report written before the run's operation-history decision",
    );
  }
  const decision =
    collected === undefined
      ? undefined
      : detailsRouteDecision({
          outcome: collected.outcome,
          hasWarnings: collected.hasWarnings,
          hasFileWork: projectsHaveFileWork(collected.projects),
        });
  const showDetails = route && decision !== undefined && decision.show;
  if (!showDetails || decision === undefined) {
    writeHumanDocument(stream, document, context);
    return;
  }
  const details: PresentationNode = {
    kind: "key-value",
    key: "Details",
    value: operationDetailsCommand(decision.note),
    category: "command",
  };
  const last = document.at(-1);
  writeHumanDocument(
    stream,
    // The details route joins the trailing footer part when one exists, so
    // the footer stays one screen part with no second blank line (US-010).
    documentHasFooterAction(document) && last?.kind === "part"
      ? [...document.slice(0, -1), { ...last, nodes: [...last.nodes, details] }]
      : documentHasFooterAction(document)
        ? [...document, details]
        : [...document, footerNodes({ details: operationDetailsCommand(decision.note) })],
    context,
  );
}

/** One entry's persisted identity is present only once the store saved it. */
export type OperationHistoryEvidence = OperationHistoryEntry | OperationHistoryEntryDraft;

function hasStoredId(entry: OperationHistoryEvidence): entry is OperationHistoryEntry {
  return "id" in entry;
}

const OUTCOME_SEVERITY: Readonly<Record<OperationHistoryOutcome, NoticeSeverity>> = {
  blocked: "warning",
  cancelled: "neutral",
  failed: "error",
  "no-op": "neutral",
  partial: "warning",
  succeeded: "success",
};

const OUTCOME_CATEGORY: Readonly<Record<OperationHistoryOutcome, SemanticCategory>> = {
  blocked: "warning",
  cancelled: "neutral",
  failed: "error",
  "no-op": "muted",
  partial: "warning",
  succeeded: "success",
};

/** The one human time spelling for retained evidence: UTC, second precision. */
export function formatOperationTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The injected clock and time zone every human time reads (US-008): tests
 * pass both explicitly and never read the ambient TZ or locale; the CLI edge
 * resolves the machine's zone once and passes it in.
 */
export interface HumanTimeContext {
  readonly nowMs: number;
  readonly timeZone: string;
}

/**
 * The machine's local zone, resolved at the CLI edge and injected from there
 * (US-008): this is the one reader of the ambient zone; presentation and its
 * tests never read it themselves.
 */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The CLI edge's human time: the injected clock beside the machine's zone. */
export function localHumanTimeContext(nowMs: number = Date.now()): HumanTimeContext {
  return { nowMs, timeZone: localTimeZone() };
}

/**
 * Local human time for one run's details (US-008, review screens 19 and 29):
 * `Today at 9:45 AM`, `Yesterday at …`, or a dated form. The day words and
 * the wall clock come from the injected zone against the injected now; the
 * spelling is fixed `en-US` and never the ambient locale. Exact timestamps
 * stay in `--json` (DEC-009).
 */
export function formatLocalHumanTime(iso: string, time: HumanTimeContext): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const clock = new Intl.DateTimeFormat("en-US", {
    timeZone: time.timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
  const dayKey = (instant: number): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: time.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  const day = dayKey(parsed.getTime());
  const today = dayKey(time.nowMs);
  // Yesterday is the previous calendar day in the injected zone: date-part
  // arithmetic (UTC midnight minus one day), never a fixed 24h subtract,
  // which mislabels across DST transitions (INT-A-3).
  const [year, month, date] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(year!, month! - 1, date!) - 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  if (day === today) return `Today at ${clock}`;
  if (day === yesterday) return `Yesterday at ${clock}`;
  const dated = new Intl.DateTimeFormat("en-US", {
    timeZone: time.timeZone,
    month: "short",
    day: "numeric",
    ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" as const }),
  }).format(parsed);
  return `${dated} at ${clock}`;
}

/**
 * Compact human time for the history list (US-008): UTC and locale-free
 * buckets from an injected `now`, so tests are deterministic across runners.
 * Exact timestamps stay in operation details through `formatOperationTime`.
 */
export function formatCompactOperationTime(iso: string, nowMs: number): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const deltaSeconds = Math.floor((nowMs - parsed.getTime()) / 1000);
  if (deltaSeconds < 60) return "just now";
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays}d ago`;
  return parsed.toISOString().slice(0, 10);
}

/** How one run's outcome reads in its headline (US-008, review screens 19/29). */
const OUTCOME_PHRASES: Readonly<Record<OperationHistoryOutcome, string>> = {
  blocked: "was blocked",
  cancelled: "cancelled",
  failed: "failed",
  "no-op": "changed nothing",
  partial: "stopped partway",
  succeeded: "succeeded",
};

/**
 * The run's headline facts: the outcome in the headline, then one line with
 * the local human time and scope (US-008). Exact timestamps stay in `--json`.
 */
function headlineNodes(
  entry: OperationHistoryEvidence,
  time: HumanTimeContext,
): readonly PresentationNode[] {
  const title: PresentationNode = {
    kind: "sentence",
    parts: [
      `${entry.command.charAt(0).toUpperCase()}${entry.command.slice(1)} `,
      ...(hasStoredId(entry) ? [identifierPart(entry.id)] : ["(not saved)"]),
      ` ${OUTCOME_PHRASES[entry.outcome]}`,
    ],
    category: OUTCOME_CATEGORY[entry.outcome],
  };
  const scopeBits = [operationScopeText(entry.scope)];
  if (entry.scope.profile !== undefined) {
    scopeBits.push(`Profile ${entry.scope.profile}`);
  }
  if (entry.scope.hosts !== undefined && entry.scope.hosts.length > 0) {
    scopeBits.push(`Agents ${entry.scope.hosts.join(", ")}`);
  }
  return [
    {
      kind: "notice",
      severity: OUTCOME_SEVERITY[entry.outcome],
      nodes: [title],
    },
    {
      kind: "prose",
      parts: [`  ${formatLocalHumanTime(entry.startedAt, time)} · ${scopeBits.join(" · ")}`],
    },
    ...(entry.cancelledReason === undefined ? [] : [{
      kind: "prose",
      parts: [`  Cancelled: ${entry.cancelledReason}`],
    }] as PresentationNode[]),
  ];
}

/** The requested scope of one operation in one short human phrase. */
export function operationScopeText(scope: OperationHistoryScope): string {
  const base = scope.selection === "all" ? "all Projects" : "one Project";
  return scope.filter === undefined ? base : `${base} (--${scope.filter})`;
}

function scopeNodes(scope: OperationHistoryScope): readonly PresentationNode[] {
  const nodes: PresentationNode[] = [
    {
      kind: "key-value",
      key: "Scope",
      value: { kind: "identifier", value: operationScopeText(scope) },
    },
  ];
  if (scope.profile !== undefined) {
    nodes.push({
      kind: "key-value",
      key: "Profile",
      value: { kind: "identifier", value: scope.profile },
      category: "path",
    });
  }
  if (scope.hosts !== undefined && scope.hosts.length > 0) {
    nodes.push({
      kind: "key-value",
      key: "Hosts",
      value: { kind: "identifier", value: scope.hosts.join(", ") },
    });
  }
  return nodes;
}

function projectIdentity(project: OperationHistoryProject): InlineContent {
  return pathPart(project.canonicalProject, "fleet", project.project);
}

function projectLine(
  project: OperationHistoryProject,
  detail?: string,
): PresentationNode {
  return {
    kind: "sentence",
    parts: [
      "  ",
      projectIdentity(project),
      ...(detail === undefined ? [] : [`: ${detail}`]),
    ],
    category: "path",
  };
}

function committedNodes(projects: readonly OperationHistoryProject[]): readonly PresentationNode[] {
  const committed = projects.filter(projectHasChangedFiles);
  if (committed.length === 0) return [];
  const section: PresentationNode[] = [{ kind: "heading", text: "Changed files:" }];
  for (const project of committed) {
    section.push(projectLine(project));
    if (
      (project.written?.length ?? 0) === 0 &&
      (project.removed?.length ?? 0) === 0 &&
      project.outputCommitted === true
    ) {
      section.push({
        kind: "sentence",
        parts: ["    + committed generated output (paths not enumerated)"],
        category: "success",
      });
    }
    for (const path of project.written ?? []) {
      section.push({
        kind: "sentence",
        parts: ["    + ", identifierPart(path)],
        category: "success",
      });
    }
    for (const path of project.removed ?? []) {
      section.push({
        kind: "sentence",
        parts: ["    - ", identifierPart(path)],
        category: "warning",
      });
    }
  }
  return [part(...section)];
}

/**
 * What went wrong (US-008, review screen 29): each failed Project with its
 * failure detail, or the run-level failure when no Project carries one.
 */
function wentWrongNodes(entry: OperationHistoryEvidence): readonly PresentationNode[] {
  const failed = entry.projects.filter((project) => project.result === "failed");
  const section: PresentationNode[] = [{ kind: "heading", text: "What went wrong:" }];
  if (failed.length === 0) {
    if (entry.failure === undefined) return [];
    section.push({
      kind: "sentence",
      parts: ["  ", entry.failure],
      category: "error",
    });
    return [part(...section)];
  }
  for (const project of failed) {
    section.push(projectLine(project));
    section.push({
      kind: "sentence",
      parts: ["    ", entry.failure ?? project.failure ?? "not completed"],
      category: "error",
    });
    if (project.outputCommitted === true) {
      section.push({
        kind: "sentence",
        parts: ["    generated output was committed"],
        category: "warning",
      });
    }
  }
  return [part(...section)];
}

/**
 * Not done (US-008, review screen 29): every Project the run left behind,
 * skipped or unattempted, with its reason when one was recorded (OOS-004).
 */
function notDoneNodes(projects: readonly OperationHistoryProject[]): readonly PresentationNode[] {
  const remaining = projects.filter(
    (project) => project.result === "skipped" || project.result === "unattempted",
  );
  if (remaining.length === 0) return [];
  return [
    part(
      { kind: "heading", text: "Not done:" },
      list(remaining.map((project) => [
        projectIdentity(project),
        ...(project.failure === undefined ? [] : [`: ${project.failure}`]),
      ])),
    ),
  ];
}

function reviewNodes(
  reviews: OperationHistoryEntry["reviewedChangedOutputs"],
): readonly PresentationNode[] {
  if (reviews === undefined || reviews.length === 0) return [];
  return [
    part(
      { kind: "heading", text: "Reviewed changed generated files:" },
      ...reviews.map((review): PresentationNode => ({
        kind: "sentence",
        parts: [
          "  ",
          review.operation === "replace" ? "replace " : "remove ",
          identifierPart(review.path),
          " in ",
          pathPart(review.project, "fleet"),
        ],
        category: "warning",
      })),
    ),
  ];
}

/**
 * The complete evidence of one run (US-008, review screens 19 and 29): the
 * outcome in the headline, a local human time and scope, then `Changed files`,
 * `What went wrong` and `Not done` as they apply. The same document serves
 * `apkit details` and, unsaved, the run whose entry could not be published
 * (DEC-008). Exact timestamps stay in `--json` (DEC-009).
 */
export function operationHistoryEntryDocument(
  entry: OperationHistoryEvidence,
  time: HumanTimeContext,
): PresentationDocument {
  const nodes: PresentationNode[] = [...headlineNodes(entry, time)];
  nodes.push(
    ...committedNodes(entry.projects),
    ...wentWrongNodes(entry),
    ...notDoneNodes(entry.projects),
    ...reviewNodes(entry.reviewedChangedOutputs),
  );
  if (entry.projects.length === 0) {
    nodes.push(part({ kind: "prose", parts: ["No Projects were selected."] }));
  }
  return nodes;
}

/** The compact retained list, newest first (US-008, review screen 18). */
export function operationHistoryListDocument(
  entries: readonly OperationHistoryEntry[],
  nowMs: number = Date.now(),
): PresentationDocument {
  const nodes: PresentationNode[] = [
    { kind: "heading", text: `Recent runs (${entries.length})` },
    { kind: "verbatim", text: "" },
  ];
  for (const entry of entries) {
    nodes.push({
      kind: "row",
      cells: [
        { column: "Run", content: { kind: "identifier", value: entry.id } },
        {
          column: "When",
          content: {
            kind: "identifier",
            value: formatCompactOperationTime(entry.startedAt, nowMs),
          },
        },
        { column: "Command", content: { kind: "identifier", value: entry.command } },
        {
          column: "Result",
          content: {
            kind: "identifier",
            value: entry.outcome,
            category: OUTCOME_CATEGORY[entry.outcome],
          },
        },
        {
          column: "Scope",
          content: { kind: "identifier", value: operationScopeText(entry.scope) },
        },
      ],
    });
  }
  nodes.push(
    footerNodes({
      next: {
        kind: "command",
        value: notedCommand(
          commandNode(COMMAND_NAME, [arg("details"), arg("<run>")]),
          "see exactly what one run changed",
        ),
      },
    }),
  );
  return nodes;
}

/** No retained operation, with the store's location and how it fills. */
export function operationHistoryEmptyDocument(historyPath: string): PresentationDocument {
  return [
    {
      kind: "notice",
      severity: "neutral",
      nodes: [{ kind: "prose", parts: ["No lifecycle operations are recorded yet."] }],
    },
    {
      kind: "sentence",
      parts: [
        "Install, update, and uninstall record automatically; run one, then run ",
        commandPart(COMMAND_NAME, [arg("details")]),
        ".",
      ],
    },
    {
      kind: "key-value",
      key: "History",
      value: { kind: "path", canonicalPath: historyPath, scope: "fleet" },
    },
  ];
}

/** A requested identity that the retained window does not hold. */
export function operationHistoryMissingIdDocument(
  id: string,
  historyPath: string,
): PresentationDocument {
  return diagnosticDocument({
    happened: [`no recorded operation has the identity '${id}'`],
    why: [
      [`Operation history retains the latest ${OPERATION_HISTORY_LIMIT} runs; older identities are evicted.`],
    ],
    whatToType: [
      ["Run ", commandPart(COMMAND_NAME, [arg("details"), arg("--list")]), " to see retained operations."],
      ["History: ", pathPart(historyPath, "fleet")],
    ],
  });
}

/** An unreadable or unsupported history document. */
export function operationHistoryUnavailableDocument(
  detail: string,
  historyPath: string,
): PresentationDocument {
  return diagnosticDocument({
    happened: ["operation history could not be read: ", detail],
    whatToType: [
      ["Fix or remove ", pathPart(historyPath, "fleet"), " to resume history retrieval and recording."],
    ],
  });
}

/**
 * The warning a run displays when its entry could not be saved (DEC-008): the
 * complete evidence of that run follows, and committed lifecycle work is never
 * rolled back.
 */
export function operationHistorySaveFailureDocument(
  detail: string,
  historyPath: string,
): PresentationDocument {
  return diagnosticDocument({
    severity: "warning",
    happened: ["operation history could not be saved: ", detail],
    why: [
      [
        "This run's entry was not added to operation history, so ",
        commandPart(COMMAND_NAME, [arg("details")]),
        " does not include it; this run's complete evidence follows instead.",
      ],
      ["The run itself is unaffected."],
    ],
    whatToType: [
      ["Fix or remove ", pathPart(historyPath, "fleet"), " to resume history recording."],
    ],
  });
}

/**
 * The non-fatal internal diagnostic for a lifecycle run whose branches made no
 * recording decision: the run's own report and exit code are untouched, and
 * the missing decision is reported once (DEC-008: history never fails the
 * lifecycle).
 */
export function operationHistoryUnrecordedDocument(): PresentationDocument {
  return diagnosticDocument({
    severity: "warning",
    happened: ["internal: this run recorded no operation-history decision"],
    why: [[
      "Every lifecycle terminal branch records its outcome or an explicit refusal; this run itself is unaffected.",
    ]],
    whatToType: [
      ["Run ", commandPart(COMMAND_NAME, [arg("details")]), " to see the retained history."],
    ],
  });
}

export interface DetailsJsonInput {
  readonly selection: "id" | "latest" | "list";
  readonly entries: readonly OperationHistoryEntry[];
  readonly historyPath: string;
  readonly error?: string;
}

/** The one `apkit details --json` payload (ADR-0023: its own family). */
export function formatDetailsJson(input: DetailsJsonInput): string {
  return `${JSON.stringify(
    {
      schemaVersion: DETAILS_MACHINE_SCHEMA_VERSION,
      command: "details",
      outcome: input.error !== undefined ? "error" : input.entries.length === 0 ? "empty" : "clean",
      selection: input.selection,
      history: input.historyPath,
      ...(input.error === undefined ? {} : { error: input.error }),
      entries: input.entries,
    },
    null,
    2,
  )}\n`;
}
