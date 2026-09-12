/**
 * The one lifecycle operation-recording contract (US-012, DEC-007, DEC-008):
 * install, update, and uninstall collect structured outcome facts at their
 * terminal branches through one collector, and one finish boundary publishes
 * the entry. When the entry cannot be saved the boundary warns and displays
 * that run's complete evidence on stderr; stdout never gains prose, committed
 * lifecycle work is never rolled back, and machine JSON stays parseable.
 *
 * Entries record what happened — scope, actions, outcomes, committed/failed/
 * remaining work — never file contents and never rendered report prose.
 */
import type { Writable } from "node:stream";

import type { ChangedOutputHistoryRecord } from "../installer/changed-output-review.js";
import {
  appendOperationHistory,
  operationHistoryPath,
  OperationHistoryUnavailableError,
  type LifecycleOperationCommand,
  type OperationHistoryCancelledReason,
  type OperationHistoryEntryDraft,
  type OperationHistoryFileSystem,
  type OperationHistoryOutcome,
  type OperationHistoryProject,
  type OperationHistoryScope,
} from "../installer/operation-history.js";
import {
  ApplyBlockedError,
  ApplyConsentRequiredError,
  ApplyDeclinedError,
  ApplyExecutionError,
  ApplyReviewStaleError,
  ApplyVerificationError,
  type ApplyReconciliationResult,
  type ChangedOutputConsentProject,
  type ReconciliationBlocker,
  type ReconciliationProjectRecord,
  type ReconciliationReport,
} from "../installer/reconcile.js";
import type { ProjectBindingSelection } from "../installer/local-configuration.js";
import type {
  InstallApplicationResult,
  InstallExecutionError,
  InstallPreview,
} from "../installer/install-application.js";
import type {
  UninstallApplicationResult,
  UninstallPreviewProject,
} from "../installer/uninstall-application.js";
import {
  operationHistoryEntryDocument,
  operationHistorySaveFailureDocument,
} from "./operation-history-presentation.js";
import { reportHasReconciliationWork } from "./presentation.js";
import { writeHumanDocument } from "./presentation-document.js";
import {
  terminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";

export interface OperationRecordingFacts {
  readonly outcome: OperationHistoryOutcome;
  readonly scope: OperationHistoryScope;
  readonly projects: readonly OperationHistoryProject[];
  /** Run-level carried detail (facts, never rendered prose). */
  readonly failure?: string;
  readonly cancelledReason?: OperationHistoryCancelledReason;
}

/**
 * One invocation's collector. A run has exactly one terminal outcome, so the
 * first collected facts win; a run that reaches no recording point (refusal,
 * usage error, or missing non-interactive authorization) collects nothing and
 * records nothing.
 */
export interface LifecycleOperationRecording {
  collect(facts: OperationRecordingFacts | undefined): void;
  /**
   * Register the invocation's consent-review source. Reviews happen while the
   * operation runs, so the finish boundary reads them once and every recorded
   * outcome — committed, failed, or cancelled — carries the same history-safe
   * reviewed identities and paths.
   */
  collectReviewsFrom(source: () => readonly ChangedOutputHistoryRecord[]): void;
  /** The invocation's deduplicated consent-review evidence. */
  reviewed(): readonly ChangedOutputHistoryRecord[];
  readonly collected: OperationRecordingFacts | undefined;
}

export function beginLifecycleOperationRecording(): LifecycleOperationRecording {
  let facts: OperationRecordingFacts | undefined;
  let reviewSource: (() => readonly ChangedOutputHistoryRecord[]) | undefined;
  const reviewed = (): readonly ChangedOutputHistoryRecord[] => {
    const unique = new Map<string, ChangedOutputHistoryRecord>();
    for (const record of reviewSource?.() ?? []) {
      unique.set(`${record.operation}\0${record.project}\0${record.path}\0${record.reviewId}`, record);
    }
    return [...unique.values()];
  };
  return {
    collect(next) {
      if (facts === undefined) facts = next;
    },
    collectReviewsFrom(source) {
      reviewSource = source;
    },
    reviewed,
    get collected() {
      return facts;
    },
  };
}

function isoTime(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

export type OperationRecordingFinish = "saved" | "skipped" | "unsaved";

export interface FinishOperationRecordingInput {
  readonly recording: LifecycleOperationRecording;
  readonly home: string;
  readonly command: LifecycleOperationCommand;
  readonly startedAt: number;
  readonly finishedAt: number;
  /** Test seam over the history document's filesystem operations. */
  readonly fileSystem?: Partial<OperationHistoryFileSystem>;
  readonly stderr: Writable & TerminalStream;
}

/**
 * Publish one collected entry at the command boundary. Returns `skipped` when
 * the run recorded nothing, `saved` on success, and `unsaved` when the entry
 * could not be published — in which case the warning and the complete run
 * evidence are written to stderr (DEC-008).
 */
export async function finishLifecycleOperationRecording(
  input: FinishOperationRecordingInput,
): Promise<OperationRecordingFinish> {
  const facts = input.recording.collected;
  if (facts === undefined) return "skipped";
  const reviewed = input.recording.reviewed();
  const draft: OperationHistoryEntryDraft = {
    command: input.command,
    startedAt: isoTime(input.startedAt),
    finishedAt: isoTime(input.finishedAt),
    outcome: facts.outcome,
    scope: facts.scope,
    projects: facts.projects,
    ...(facts.failure === undefined ? {} : { failure: facts.failure }),
    ...(facts.cancelledReason === undefined ? {} : { cancelledReason: facts.cancelledReason }),
    ...(reviewed.length === 0 ? {} : { reviewedChangedOutputs: reviewed }),
  };
  try {
    await appendOperationHistory(input.home, draft, {
      ...(input.fileSystem === undefined ? {} : { fileSystem: input.fileSystem }),
    });
    return "saved";
  } catch (error) {
    const detail = error instanceof OperationHistoryUnavailableError
      ? (error.detail ?? error.message)
      : error instanceof Error
        ? error.message
        : String(error);
    const stderrContext = terminalPresentationContext(input.stderr);
    writeHumanDocument(
      input.stderr,
      operationHistorySaveFailureDocument(detail, operationHistoryPath(input.home)),
      stderrContext,
    );
    writeHumanDocument(input.stderr, operationHistoryEntryDocument(draft), stderrContext);
    return "unsaved";
  }
}

/** One Project's identity in the report, preferring the authored spelling. */
function projectIdentity(record: Pick<ReconciliationProjectRecord, "canonicalProject" | "project">): {
  readonly canonicalProject: string;
  readonly project: string;
} {
  return { canonicalProject: record.canonicalProject, project: record.project };
}

function blockerFailures(blockers: readonly ReconciliationBlocker[]): string {
  return blockers.map((blocker) => blocker.kind).join(", ");
}

function outputPaths(
  record: ReconciliationProjectRecord | undefined,
  kind: "written" | "removed",
): readonly string[] {
  if (record === undefined) return [];
  return record.outputs
    .filter((output) => kind === "written"
      ? output.kind === "addition" || output.kind === "update"
      : output.kind === "removal")
    .map((output) => output.path);
}

/**
 * One Project record from a reconciliation snapshot: the committed paths the
 * snapshot recorded, the desired selection when the report carries it, and the
 * resulting state when one is available for the same Project.
 */
function projectRecord(
  record: ReconciliationProjectRecord,
  options: {
    readonly receipt?: ReconciliationProjectRecord | undefined;
    readonly state?: ReconciliationProjectRecord | undefined;
  } = {},
): OperationHistoryProject {
  const written = outputPaths(options.receipt, "written");
  const removed = outputPaths(options.receipt, "removed");
  const state = options.state;
  if (state !== undefined && state.blockers.length > 0) {
    return {
      ...projectIdentity(record),
      ...(record.desired === undefined ? {} : { profile: record.desired.profile }),
      ...(record.desired === undefined ? {} : { hosts: [...record.desired.hosts] }),
      result: "skipped",
      failure: blockerFailures(state.blockers),
      ...(written.length === 0 ? {} : { written }),
      ...(removed.length === 0 ? {} : { removed }),
    };
  }
  return {
    ...projectIdentity(record),
    ...(record.desired === undefined ? {} : { profile: record.desired.profile }),
    ...(record.desired === undefined ? {} : { hosts: [...record.desired.hosts] }),
    result: written.length === 0 && removed.length === 0 ? "unchanged" : "completed",
    ...(written.length === 0 ? {} : { written }),
    ...(removed.length === 0 ? {} : { removed }),
  };
}

function receiptByProject(report: ReconciliationReport): ReadonlyMap<string, ReconciliationProjectRecord> {
  return new Map(report.projects.map((record) => [record.canonicalProject, record]));
}

function unattemptedProject(identity: {
  readonly canonicalProject: string;
  readonly project: string;
}): OperationHistoryProject {
  return { ...identity, result: "unattempted" };
}

function failedProject(
  identity: { readonly canonicalProject: string; readonly project: string },
  failure: string,
  restored?: boolean,
): OperationHistoryProject {
  return {
    ...identity,
    result: "failed",
    failure,
    ...(restored === undefined ? {} : { restored }),
  };
}

/** The requested scope of one update/status selection. */
export function recordingScopeForSelection(
  selection: ProjectBindingSelection,
): OperationHistoryScope {
  return {
    selection: selection.kind === "all" ? "all" : "project",
    ...(selection.filter === undefined ? {} : { filter: selection.filter }),
  };
}

/** The requested scope of one install/uninstall invocation. */
export function recordingScopeForProject(input: {
  readonly profile?: string;
  readonly hosts?: readonly string[];
}): OperationHistoryScope {
  return {
    selection: "project",
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.hosts === undefined || input.hosts.length === 0 ? {} : { hosts: [...input.hosts] }),
  };
}

/** The Projects a consent review covered, as remaining (unattempted) work. */
export function reviewedProjectsAsUnattempted(
  projects: readonly ChangedOutputConsentProject[],
): readonly OperationHistoryProject[] {
  const seen = new Set<string>();
  const records: OperationHistoryProject[] = [];
  for (const project of projects) {
    if (seen.has(project.canonicalProject)) continue;
    seen.add(project.canonicalProject);
    records.push(unattemptedProject({
      canonicalProject: project.canonicalProject,
      project: project.project,
    }));
  }
  return records;
}

/** Update succeeded: committed paths from the receipt, state from the fresh snapshot. */
export function updateSuccessRecording(
  applied: ApplyReconciliationResult,
  selection: ProjectBindingSelection,
): OperationRecordingFacts {
  const receipt = receiptByProject(applied.receipt);
  const projects = applied.resultingState.projects.map((record) =>
    projectRecord(record, {
      receipt: receipt.get(record.canonicalProject),
      state: record,
    })
  );
  const committed = projects.filter((project) => project.result === "completed").length;
  // "unchanged" is settled work, not outstanding work: a mixed fleet that
  // committed every selected Project's actual work succeeded.
  const outstanding = projects.filter((project) =>
    project.result === "skipped" || project.result === "unattempted"
  ).length;
  const noWork = !reportHasReconciliationWork(applied.receipt);
  return {
    outcome: noWork
      ? "no-op"
      : outstanding === 0
        ? "succeeded"
        : committed > 0 ? "partial" : "blocked",
    scope: recordingScopeForSelection(selection),
    projects,
  };
}

/** Update stopped before writes by a blocker: skipped Projects plus untouched ones. */
export function updateBlockedRecording(
  report: ReconciliationReport,
  selection: ProjectBindingSelection,
): OperationRecordingFacts {
  const projects = report.projects.map((record) =>
    record.blockers.length > 0
      ? {
          ...projectIdentity(record),
          ...(record.desired === undefined ? {} : { profile: record.desired.profile }),
          ...(record.desired === undefined ? {} : { hosts: [...record.desired.hosts] }),
          result: "skipped" as const,
          failure: blockerFailures(record.blockers),
        }
      : unattemptedProject(projectIdentity(record))
  );
  return {
    outcome: "blocked",
    scope: recordingScopeForSelection(selection),
    projects,
    ...(report.globalBlockers.length === 0
      ? {}
      : { failure: blockerFailures(report.globalBlockers) }),
  };
}

/** Update stopped by an unexpected write failure: committed, failed, remaining. */
export function updateExecutionFailureRecording(
  error: ApplyExecutionError,
  selection: ProjectBindingSelection,
): OperationRecordingFacts {
  const receipt = receiptByProject(error.receipt);
  const projects: OperationHistoryProject[] = error.receipt.projects.map((record) =>
    projectRecord(record, { receipt: receipt.get(record.canonicalProject) })
  );
  if (error.failedProject !== undefined) {
    projects.push(failedProject(error.failedProject, error.detail));
  }
  for (const pending of error.pendingProjects) {
    projects.push(unattemptedProject(pending));
  }
  const committed = projects.filter((project) => project.result === "completed").length;
  return {
    outcome: committed > 0 ? "partial" : "failed",
    scope: recordingScopeForSelection(selection),
    projects,
    failure: error.detail,
  };
}

/** Update committed but failed fresh verification: the receipt plus the failure. */
export function updateVerificationFailureRecording(
  error: ApplyVerificationError,
  selection: ProjectBindingSelection,
): OperationRecordingFacts {
  const receipt = receiptByProject(error.receipt);
  const projects = error.receipt.projects.map((record) =>
    projectRecord(record, { receipt: receipt.get(record.canonicalProject) })
  );
  const committed = projects.filter((project) => project.result === "completed").length;
  return {
    outcome: committed > 0 ? "partial" : "failed",
    scope: recordingScopeForSelection(selection),
    projects,
    failure: error.message,
  };
}

/** Update cancelled at the changed-file consent gate: nothing was attempted. */
export function updateCancelledRecording(
  reason: "cancelled" | "declined",
  selection: ProjectBindingSelection,
  evidence: { readonly projects: readonly ChangedOutputConsentProject[] },
): OperationRecordingFacts {
  return {
    outcome: "cancelled",
    scope: recordingScopeForSelection(selection),
    projects: reviewedProjectsAsUnattempted(evidence.projects),
    cancelledReason: reason,
  };
}

/**
 * A late authorization or stale-review stop that carries work an earlier
 * Project already committed: the run is a partial outcome, not a refusal that
 * records nothing. Completed Projects come from the Installer's committed
 * identities; this evidence does not enumerate their generated paths.
 */
export function lateAuthorizationStopRecording(
  error: {
    readonly completedProjects: readonly string[];
    readonly failedProject?:
      | { readonly canonicalProject: string; readonly project: string }
      | undefined;
    readonly pendingProjects?:
      | readonly { readonly canonicalProject: string; readonly project: string }[]
      | undefined;
  },
  scope: OperationHistoryScope,
  failure: string,
): OperationRecordingFacts | undefined {
  if (error.completedProjects.length === 0) return undefined;
  const projects: OperationHistoryProject[] = error.completedProjects.map((name) => ({
    project: name,
    canonicalProject: name,
    result: "completed",
    outputCommitted: true,
  }));
  if (error.failedProject !== undefined) {
    projects.push(failedProject(error.failedProject, failure));
  }
  for (const pending of error.pendingProjects ?? []) {
    projects.push(unattemptedProject(pending));
  }
  return {
    outcome: "partial",
    scope,
    projects,
    failure,
  };
}

/** Install completed: the binding outcome and the verified generated output. */
export function installSuccessRecording(
  result: InstallApplicationResult,
): OperationRecordingFacts {
  const receipt = receiptByProject(result.applied.receipt);
  const projects = result.applied.resultingState.projects.map((record) =>
    projectRecord(record, { receipt: receipt.get(record.canonicalProject) })
  );
  return {
    outcome: reportHasReconciliationWork(result.applied.receipt) ? "succeeded" : "no-op",
    scope: recordingScopeForProject(result.preview),
    projects,
  };
}

export interface InstallRecordingIdentity {
  readonly canonicalProject: string;
  readonly project: string;
  readonly profile?: string;
  readonly hosts?: readonly string[];
}

/** Install failed after its confirmation: the cause's own partial evidence. */
export function installFailureRecording(
  error: InstallExecutionError,
  preview: InstallPreview | InstallRecordingIdentity,
): OperationRecordingFacts | undefined {
  const scope = recordingScopeForProject(preview);
  const identity = {
    canonicalProject: preview.canonicalProject,
    project: "authoredProject" in preview ? preview.authoredProject : preview.project,
  };
  const cause = error.failure.cause;
  if (cause instanceof ApplyDeclinedError) {
    return {
      outcome: "cancelled",
      scope,
      projects: [unattemptedProject(identity)],
      cancelledReason: cause.reason,
    };
  }
  if (cause instanceof ApplyBlockedError) {
    const blocked = updateBlockedRecording(cause.report, {
      command: "install",
      kind: "project",
      match: "exact",
      target: identity.canonicalProject,
    });
    return { ...blocked, scope };
  }
  if (cause instanceof ApplyExecutionError) {
    const failed = updateExecutionFailureRecording(cause, {
      command: "install",
      kind: "project",
      match: "exact",
      target: identity.canonicalProject,
    });
    return { ...failed, scope };
  }
  if (cause instanceof ApplyVerificationError) {
    const verified = updateVerificationFailureRecording(cause, {
      command: "install",
      kind: "project",
      match: "exact",
      target: identity.canonicalProject,
    });
    return { ...verified, scope };
  }
  // A missing-consent or stale-review stop that committed nothing records
  // nothing; one that already committed work records its partial outcome.
  if (cause instanceof ApplyConsentRequiredError || cause instanceof ApplyReviewStaleError) {
    return lateAuthorizationStopRecording(cause, scope, cause.message);
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    outcome: "failed",
    scope,
    projects: [{
      ...failedProject(identity, detail, error.failure.selectionRestored),
      ...(error.failure.outputCommitted ? { outputCommitted: true } : {}),
    }],
    failure: detail,
  };
}

/** Install cancelled at its general confirmation: nothing was written. */
export function installCancelledRecording(
  reason: "cancelled" | "declined",
  identity: InstallRecordingIdentity,
): OperationRecordingFacts {
  return {
    outcome: "cancelled",
    scope: recordingScopeForProject(identity),
    projects: [unattemptedProject(identity)],
    cancelledReason: reason,
  };
}

/** The per-Project evidence of one uninstall result, in result order. */
export function uninstallProjects(
  result: UninstallApplicationResult,
): readonly OperationHistoryProject[] {
  const projects: OperationHistoryProject[] = [];
  for (const completed of result.completed) {
    projects.push({
      project: completed.project,
      canonicalProject: completed.canonicalProject ?? completed.project,
      profile: completed.profile,
      ...(completed.removedHosts === undefined ? {} : { hosts: [...completed.removedHosts] }),
      result: "completed",
      ...(completed.outputs.length === 0 ? {} : { removed: [...completed.outputs] }),
    });
  }
  for (const skipped of result.skipped) {
    projects.push({
      project: skipped.project,
      canonicalProject: skipped.canonicalProject ?? skipped.project,
      profile: skipped.profile,
      result: "skipped",
      failure: typeof skipped.reason === "string" ? skipped.reason : skipped.reason.case,
    });
  }
  if (result.failed !== undefined) {
    projects.push({
      project: result.failed.project,
      canonicalProject: result.failed.canonicalProject ?? result.failed.project,
      profile: result.failed.profile,
      result: "failed",
      failure: result.failed.detail,
      restored: result.failed.selectionRestored,
    });
  }
  for (const unattempted of result.unattempted) {
    projects.push({
      project: unattempted.project,
      canonicalProject: unattempted.canonicalProject ?? unattempted.project,
      profile: unattempted.profile,
      result: "unattempted",
    });
  }
  return projects;
}

/** The un-attempted Projects of one preview or remaining batch. */
export function unattemptedProjectsFromPreview(
  projects: readonly UninstallPreviewProject[],
): readonly OperationHistoryProject[] {
  return projects.map((project) => ({
    project: project.project,
    canonicalProject: project.canonicalProject ?? project.project,
    profile: project.profile,
    ...(project.removeHosts === undefined ? {} : { hosts: [...project.removeHosts] }),
    result: "unattempted" as const,
  }));
}

/** Uninstall completed (possibly partially): completed, skipped, failed, remaining. */
export function uninstallRecording(
  result: UninstallApplicationResult,
  scope: OperationHistoryScope,
): OperationRecordingFacts {
  const projects = uninstallProjects(result);
  const committed = result.completed.length;
  const outcome: OperationHistoryOutcome = result.failed !== undefined
    ? (committed > 0 ? "partial" : "failed")
    : result.skipped.length > 0
      ? (committed > 0 ? "partial" : "blocked")
      : result.unattempted.length > 0
        ? "partial"
        : committed > 0 ? "succeeded" : "no-op";
  return {
    outcome,
    scope,
    projects,
    ...(result.failed === undefined
      ? {}
      : {
          failure: result.failed.restoreError === undefined
            ? result.failed.detail
            : `${result.failed.detail}; previous state restore failed: ${result.failed.restoreError}`,
        }),
  };
}

/** Uninstall cancelled at a confirmation or consent prompt: nothing else was attempted. */
export function uninstallCancelledRecording(
  reason: "cancelled" | "declined",
  scope: OperationHistoryScope,
  projects: readonly OperationHistoryProject[],
): OperationRecordingFacts {
  return {
    outcome: "cancelled",
    scope,
    projects,
    cancelledReason: reason,
  };
}
