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
  commandPart,
  identifierPart,
  pathPart,
  writeHumanDocument,
  type CommandArg,
  type InlineContent,
  type PresentationDocument,
  type PresentationNode,
  type SemanticCategory,
} from "./presentation-document.js";

const arg = (value: string): CommandArg => ({ kind: "text", value });

export const DETAILS_MACHINE_SCHEMA_VERSION = 1;

/**
 * The completed-operation detail route (US-011, DEC-007; ADR-0040): one
 * discoverable `Details: apkit details` line that retrieves the run's retained
 * evidence. It names the read-only history command, never a re-run of the
 * lifecycle command, and the write helper below emits it exactly when this run
 * retained an entry.
 */
export function operationDetailsDocument(): PresentationDocument {
  return [
    { kind: "verbatim", text: "" },
    {
      kind: "key-value",
      key: "Details",
      value: { kind: "command", program: COMMAND_NAME, args: [arg("details")] },
      category: "command",
    },
  ];
}

/**
 * Write one run's terminal human report and, exactly when the run retained an
 * operation-history entry, its completed-operation detail route (US-011,
 * DEC-007; ADR-0040). The route follows the stream that carries the report, so
 * a declined or failed run keeps its evidence pointer beside its own
 * diagnostic while a pre-write refusal that records nothing never advertises
 * `apkit details`. An unsaved entry still prints the route because that run
 * displayed its complete evidence (DEC-008). Machine JSON callers keep stdout
 * parseable and never call this. `route` is `false` only for `--verbose`,
 * which already prints the complete current-run receipt.
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
  writeHumanDocument(stream, document, context);
  if (route && collected !== undefined) {
    writeHumanDocument(stream, operationDetailsDocument(), context);
  }
}

/** One entry's persisted identity is present only once the store saved it. */
export type OperationHistoryEvidence = OperationHistoryEntry | OperationHistoryEntryDraft;

function hasStoredId(entry: OperationHistoryEvidence): entry is OperationHistoryEntry {
  return "id" in entry;
}

const OUTCOME_SEVERITY: Readonly<Record<OperationHistoryOutcome, "attention" | "error" | "info" | "success">> = {
  blocked: "attention",
  cancelled: "info",
  failed: "error",
  "no-op": "info",
  partial: "attention",
  succeeded: "success",
};

const OUTCOME_CATEGORY: Readonly<Record<OperationHistoryOutcome, SemanticCategory>> = {
  blocked: "attention",
  cancelled: "attention",
  failed: "error",
  "no-op": "muted",
  partial: "attention",
  succeeded: "success",
};

/** The one human time spelling for retained evidence: UTC, second precision. */
export function formatOperationTime(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
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
  const committed = projects.filter((project) =>
    (project.written?.length ?? 0) > 0 ||
    (project.removed?.length ?? 0) > 0 ||
    project.outputCommitted === true
  );
  const nodes: PresentationNode[] = [{ kind: "heading", text: "Committed:" }];
  if (committed.length === 0) {
    nodes.push({ kind: "prose", parts: ["  none"] });
    return nodes;
  }
  for (const project of committed) {
    nodes.push(projectLine(project));
    if (
      (project.written?.length ?? 0) === 0 &&
      (project.removed?.length ?? 0) === 0 &&
      project.outputCommitted === true
    ) {
      nodes.push({
        kind: "sentence",
        parts: ["    + committed generated output (paths not enumerated)"],
        category: "success",
      });
    }
    for (const path of project.written ?? []) {
      nodes.push({
        kind: "sentence",
        parts: ["    + ", identifierPart(path)],
        category: "success",
      });
    }
    for (const path of project.removed ?? []) {
      nodes.push({
        kind: "sentence",
        parts: ["    - ", identifierPart(path)],
        category: "attention",
      });
    }
  }
  return nodes;
}

function outcomeGroupNodes(
  title: string,
  projects: readonly OperationHistoryProject[],
  category: SemanticCategory,
): readonly PresentationNode[] {
  if (projects.length === 0) return [];
  return [
    { kind: "heading", text: title },
    ...projects.map((project) => ({
      ...projectLine(project, [
        project.failure ?? "not completed",
        ...(project.outputCommitted === true ? ["generated output was committed"] : []),
      ].join("; ")),
      category,
    })),
  ];
}

function reviewNodes(
  reviews: OperationHistoryEntry["reviewedChangedOutputs"],
): readonly PresentationNode[] {
  if (reviews === undefined || reviews.length === 0) return [];
  return [
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
      category: "attention",
    })),
  ];
}

/**
 * The complete evidence of one run: identity, command, time, scope, outcome,
 * committed work, failed work, skipped work, and remaining work. The same
 * document serves `apkit details` and, unsaved, the run whose entry could not
 * be published (DEC-008).
 */
export function operationHistoryEntryDocument(
  entry: OperationHistoryEvidence,
): PresentationDocument {
  const title: PresentationNode = {
    kind: "sentence",
    parts: [
      `${entry.command.charAt(0).toUpperCase()}${entry.command.slice(1)} `,
      ...(hasStoredId(entry) ? [identifierPart(entry.id)] : ["(not saved)"]),
    ],
    category: OUTCOME_CATEGORY[entry.outcome],
  };
  const nodes: PresentationNode[] = [
    {
      kind: "notice",
      severity: OUTCOME_SEVERITY[entry.outcome],
      nodes: [title],
    },
    {
      kind: "key-value",
      key: "Time",
      value: {
        kind: "identifier",
        value: `${formatOperationTime(entry.startedAt)} → ${formatOperationTime(entry.finishedAt)}`,
      },
    },
    ...scopeNodes(entry.scope),
    {
      kind: "key-value",
      key: "Outcome",
      value: { kind: "identifier", value: entry.outcome },
      category: OUTCOME_CATEGORY[entry.outcome],
    },
  ];
  if (entry.cancelledReason !== undefined) {
    nodes.push({
      kind: "key-value",
      key: "Cancelled",
      value: { kind: "identifier", value: entry.cancelledReason },
    });
  }
  if (entry.failure !== undefined) {
    nodes.push({
      kind: "key-value",
      key: "Failure",
      value: { kind: "identifier", value: entry.failure },
      category: "error",
    });
  }
  nodes.push(
    { kind: "verbatim", text: "" },
    ...committedNodes(entry.projects),
    ...outcomeGroupNodes(
      "Failed:",
      entry.projects.filter((project) => project.result === "failed"),
      "error",
    ),
    ...outcomeGroupNodes(
      "Skipped:",
      entry.projects.filter((project) => project.result === "skipped"),
      "attention",
    ),
    ...outcomeGroupNodes(
      "Remaining:",
      entry.projects.filter((project) => project.result === "unattempted"),
      "muted",
    ),
    ...reviewNodes(entry.reviewedChangedOutputs),
  );
  if (entry.projects.length === 0) {
    nodes.push({ kind: "prose", parts: ["  No Projects were selected."] });
  }
  return nodes;
}

/** The compact retained list, newest first (US-012). */
export function operationHistoryListDocument(
  entries: readonly OperationHistoryEntry[],
): PresentationDocument {
  const nodes: PresentationNode[] = [
    { kind: "heading", text: `Operation history (${entries.length}):` },
  ];
  for (const entry of entries) {
    nodes.push({
      kind: "row",
      cells: [
        { column: "Operation", content: { kind: "identifier", value: entry.id } },
        {
          column: "Time",
          content: { kind: "identifier", value: formatOperationTime(entry.startedAt) },
        },
        { column: "Command", content: { kind: "identifier", value: entry.command } },
        {
          column: "Outcome",
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
  nodes.push({
    kind: "sentence",
    parts: [
      "Run ",
      commandPart(COMMAND_NAME, [arg("details"), arg("<operation-id>")]),
      " for one operation's complete evidence.",
    ],
    category: "command",
  });
  return nodes;
}

/** No retained operation, with the store's location and how it fills. */
export function operationHistoryEmptyDocument(historyPath: string): PresentationDocument {
  return [
    {
      kind: "notice",
      severity: "info",
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
    severity: "attention",
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
    severity: "attention",
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
