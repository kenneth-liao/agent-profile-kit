/**
 * The `update` command: one invocation-wide changed-output consent gate
 * (DEC-005, DEC-019) wired in front of the Installer's write loop.
 *
 * The consent review fires only on an interactive input stream, only for
 * human output, and only when the invocation holds proven changed generated
 * files; `--replace-changed` answers replacement and `--remove-changed`
 * answers deletion explicitly, and non-interactive invocations never prompt —
 * missing consent refuses before any write with the runnable remedy. Update
 * has no general confirmation (DEC-004): routine source updates stay
 * prompt-free. Declining, the default answer, or cancellation aborts the whole
 * invocation before any configuration or generated-output write and renders
 * in neutral styling. The Installer keeps every safety Blocker: consent never
 * bypasses ownership, path-safety, or global Blockers.
 */
import type { Readable, Writable } from "node:stream";

import {
  applyConsentRequiredDocument,
  applyExecutionFailureDocument,
  applyReplacementCommandDocument,
  applyReplacementDeclinedDocument,
  applyReportDocument,
  applyReviewStaleDocument,
  applyVerificationFailureDocument,
  blockedApplyReportDocument,
  formatApplyExecutionFailureJson,
  formatApplyJson,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatLifecycleToolErrorJson,
  lifecycleExitCode,
  type ApplyDeclinedAnswer,
  type ChangedFileAnsweringScope,
  type LifecycleHumanOptions,
} from "./presentation.js";
import {
  answeringScope,
  createChangedOutputConfirmer,
} from "./changed-output-confirm.js";
import {
  writeHumanDocument,
  type PresentationDocument,
} from "./presentation-document.js";
import { errorDiagnosticDocument, formatError } from "./error-wording.js";
import { COMMANDS } from "./command-help.js";
import { terminalPresentationContext, type TerminalPresentationContext, type TerminalStream } from "./terminal-presentation.js";
import {
  type PromptClock,
} from "./prompts.js";
import type { CommandArg } from "./inline-content.js";

const arg = (value: string): CommandArg => ({ kind: "text", value });
import { ProjectTargetError, type ProjectBindingSelection } from "../installer/local-configuration.js";
import {
  applyApplication,
} from "../installer/commands.js";
import {
  ApplyBlockedError,
  ApplyConsentRequiredError,
  ApplyDeclinedError,
  ApplyExecutionError,
  ApplyReviewStaleError,
  ApplyVerificationError,
} from "../installer/reconcile.js";
import {
  beginLifecycleOperationRecording,
  finishLifecycleOperationRecording,
  lateAuthorizationStopRecording,
  recordProjectedOutcome,
  recordingScopeForSelection,
  updateBlockedRecording,
  updateCancelledRecording,
  updateExecutionFailureRecording,
  updateSuccessRecording,
  updateVerificationFailureRecording,
  type LifecycleOperationRecording,
} from "./operation-recording.js";
import { writeLifecycleReport } from "./operation-history-presentation.js";

export interface ApplyCommandRequest {
  readonly home: string;
  readonly selection: ProjectBindingSelection;
  readonly json: boolean;
  /** The explicit answering flag: replace changed generated files without asking (DEC-005). */
  readonly replaceChanged: boolean;
  /** The explicit answering flag: delete changed generated files without asking (DEC-005). */
  readonly removeChanged: boolean;
  readonly verbose: boolean;
  /** Injectable output stream for the human report and the prompt question. */
  readonly stdout: Writable & TerminalStream;
  /** Injectable diagnostic stream. */
  readonly stderr: Writable & TerminalStream;
  /** Injectable prompt input stream; TTY evidence is read here (DEC-035). */
  readonly input: Readable;
  readonly clock?: PromptClock;
}

export interface ApplyCommandOutcome {
  readonly exitCode: 0 | 1 | 2;
}

/** The one canonical update usage line, read from the command-help table. */
const applyCommandSyntax = COMMANDS.find((command) => command.name === "update")!.syntax;

/** One trusted terminal-presentation context per injected stream. */
function presentationContext(stream: Writable & TerminalStream): TerminalPresentationContext {
  return terminalPresentationContext(stream);
}

/** Which discard operations one equivalent command answers explicitly. */
export type ApplyAnsweringScope = ChangedFileAnsweringScope;

/**
 * The equivalent fully specified command arguments (DEC-032): every scope
 * argument explicit, plus the answering flags for the given scope, so the
 * printed command expresses the chosen operation without needing the same
 * answer again. Defaults to the historical replacement-only scope.
 */
export function fullySpecifiedApplyArguments(
  selection: ProjectBindingSelection,
  scope: ApplyAnsweringScope = { replace: true, remove: false },
): readonly string[] {
  const args: string[] = [];
  if (selection.kind === "all") {
    args.push("--all");
  } else if (selection.match === "containing") {
    args.push("--here");
  } else {
    args.push(selection.target);
  }
  if (selection.filter !== undefined) {
    args.push(selection.filter === "stale" ? "--stale" : "--blocked");
  }
  if (scope.replace) args.push("--replace-changed");
  if (scope.remove) args.push("--remove-changed");
  return ["update", ...args];
}

export async function runApplyCommand(request: ApplyCommandRequest): Promise<ApplyCommandOutcome> {
  // One recording boundary per invocation (US-012, DEC-008): the body
  // collects one terminal outcome; this wrapper publishes it once.
  const startedAt = Date.now();
  const recording = beginLifecycleOperationRecording();
  const outcome = await runApplyCommandWithRecording(request, recording);
  await finishLifecycleOperationRecording({
    recording,
    home: request.home,
    command: "update",
    startedAt,
    finishedAt: Date.now(),
    stderr: request.stderr,
  });
  return outcome;
}

async function runApplyCommandWithRecording(
  request: ApplyCommandRequest,
  recording: LifecycleOperationRecording,
): Promise<ApplyCommandOutcome> {
  const stdoutContext = presentationContext(request.stdout);
  const stderrContext = presentationContext(request.stderr);
  const humanOptions: LifecycleHumanOptions = {
    selection: request.selection,
    ...(request.verbose ? { verbose: true } : {}),
  };
  /**
   * Write one terminal human report, then this run's retained-operation detail
   * route exactly when the run retained an entry and the default (non-verbose)
   * view is showing (US-011, DEC-007; ADR-0040). The route follows the report's
   * own stream, so a declined or failed run keeps the pointer beside its
   * diagnostic, and a pre-write refusal that records nothing advertises
   * nothing.
   */
  const writeReport = (
    stream: Writable & TerminalStream,
    document: PresentationDocument,
    context: TerminalPresentationContext,
  ): void => {
    writeLifecycleReport(stream, document, context, recording, request.verbose !== true);
  };
  // Update has no general confirmation (DEC-004): the prompt exists only for
  // unauthored changed-file scope, through the one shared consent loop.
  const confirmer = createChangedOutputConfirmer({
    input: request.input,
    output: request.stdout,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    json: request.json,
    replaceChanged: request.replaceChanged,
    removeChanged: request.removeChanged,
    selection: request.selection,
  });
  const confirmChangedOutputReplacement = confirmer.confirm;
  const promptedAcceptedScope = (): ApplyAnsweringScope | undefined =>
    confirmer.promptedAcceptedScope();
  const declinedAnswer = (): ApplyDeclinedAnswer => confirmer.declinedAnswer();
  // The finish boundary reads the reviews the gate performed, so a committed,
  // failed, or cancelled run all carry the same reviewed identities.
  recording.collectReviewsFrom(() => confirmer.reviewedChangedOutputs());
  // The answering scope one equivalent command must carry: flags already
  // given plus the operations the prompt authorized or is asked to authorize.
  const equivalentScope = (prompted: ApplyAnsweringScope | undefined): ApplyAnsweringScope =>
    answeringScope(request, prompted, confirmer.requestedScope());
  try {
    const applied = await applyApplication(request.home, {
      selection: request.selection,
      ...(request.replaceChanged ? { replaceChanged: true as const } : {}),
      ...(request.removeChanged ? { removeChanged: true as const } : {}),
      ...(confirmChangedOutputReplacement === undefined
        ? {}
        : { confirmChangedOutputReplacement }),
    });
    recording.collect(updateSuccessRecording(applied, request.selection));
    if (request.json) {
      request.stdout.write(formatApplyJson(applied));
    } else {
      const reportDocument = applyReportDocument(applied, humanOptions);
      const prompted = promptedAcceptedScope();
      writeReport(
        request.stdout,
        prompted === undefined
          ? reportDocument
          : [
              ...reportDocument,
              ...applyReplacementCommandDocument(
                fullySpecifiedApplyArguments(request.selection, equivalentScope(prompted)).map(arg),
              ),
            ],
        stdoutContext,
      );
    }
    // Exit 0 whenever update completed without blockers, including remaining
    // non-current work (outcome "attention"). Gate on blockers only.
    return { exitCode: lifecycleExitCode(applied.resultingState) };
  } catch (error) {
    if (error instanceof ApplyDeclinedError) {
      recording.collect(updateCancelledRecording(error.reason, request.selection, {
        projects: confirmer.reviewedProjects(),
      }));
      if (request.json) {
        request.stdout.write(formatLifecycleToolErrorJson("update", formatError(error)));
      } else {
        const scope = equivalentScope(promptedAcceptedScope());
        writeReport(
          request.stderr,
          applyReplacementDeclinedDocument(
            error.reason === "cancelled" ? "cancelled" : declinedAnswer(),
            fullySpecifiedApplyArguments(request.selection, scope).map(arg),
            scope,
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyConsentRequiredError) {
      // A late stop that committed earlier Projects keeps that partial
      // evidence; a pre-write refusal records nothing.
      recordProjectedOutcome(
        recording,
        lateAuthorizationStopRecording(error, recordingScopeForSelection(request.selection), formatError(error)),
        "update refused before any write",
      );
      // The remedy stays runnable: already-supplied flags are kept and the
      // missing operations are added, so re-running answers the whole scope.
      const scope: ApplyAnsweringScope = {
        remove: request.removeChanged || error.requiredOperations.includes("remove"),
        replace: request.replaceChanged || error.requiredOperations.includes("replace"),
      };
      if (request.json) {
        request.stdout.write(formatLifecycleToolErrorJson("update", formatError(error)));
      } else {
        writeReport(
          request.stderr,
          applyConsentRequiredDocument(
            error,
            fullySpecifiedApplyArguments(request.selection, scope).map(arg),
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyReviewStaleError) {
      recordProjectedOutcome(
        recording,
        lateAuthorizationStopRecording(error, recordingScopeForSelection(request.selection), formatError(error)),
        "update refused before any write",
      );
      if (request.json) {
        request.stdout.write(formatLifecycleToolErrorJson("update", formatError(error)));
      } else {
        writeReport(
          request.stderr,
          applyReviewStaleDocument(
            error,
            fullySpecifiedApplyArguments(
              request.selection,
              equivalentScope(promptedAcceptedScope()),
            ).map(arg),
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyBlockedError) {
      recording.collect(updateBlockedRecording(error.report, request.selection));
      if (request.json) {
        request.stdout.write(formatBlockedApplyJson(error.report));
      } else {
        writeReport(
          request.stdout,
          blockedApplyReportDocument(error.report, humanOptions),
          stdoutContext,
        );
      }
      return { exitCode: lifecycleExitCode(error.report) };
    }
    if (error instanceof ApplyExecutionError) {
      recording.collect(updateExecutionFailureRecording(error, request.selection));
      if (request.json) {
        request.stdout.write(formatApplyExecutionFailureJson(error));
      } else {
        writeReport(
          request.stderr,
          applyExecutionFailureDocument(error, humanOptions),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyVerificationError) {
      recording.collect(updateVerificationFailureRecording(error, request.selection));
      if (request.json) {
        request.stdout.write(formatApplyVerificationFailureJson(error.receipt, error.message));
      } else {
        writeReport(
          request.stdout,
          applyVerificationFailureDocument(error.receipt, error.message, humanOptions),
          stdoutContext,
        );
      }
      return { exitCode: 1 };
    }
    if (request.json) {
      request.stdout.write(formatLifecycleToolErrorJson("update", formatError(error)));
    } else {
      // Structured recovery: Project-target rejections carry their usage node,
      // matching the shared lifecycle diagnostic (DEC-014).
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(
          error,
          error instanceof ProjectTargetError ? { usage: applyCommandSyntax } : undefined,
        ),
        stderrContext,
      );
    }
    recording.recordNothing("update refused before any lifecycle write");
    return { exitCode: 1 };
  }
}
