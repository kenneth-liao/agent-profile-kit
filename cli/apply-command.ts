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
  applyReplacementConfirmationDocument,
  applyReplacementDeclinedDocument,
  applyReportDocument,
  applyReviewStaleDocument,
  applyVerificationFailureDocument,
  blockedApplyReportDocument,
  changedOutputDiffDocument,
  APPLY_REPLACEMENT_QUESTION,
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
  writeHumanDocument,
  type PresentationDocument,
} from "./presentation-document.js";
import { errorDiagnosticDocument, formatError } from "./error-wording.js";
import { COMMANDS } from "./command-help.js";
import { terminalPresentationContext, type TerminalPresentationContext, type TerminalStream } from "./terminal-presentation.js";
import {
  createTextPrompt,
  isInteractiveInput,
  type PromptClock,
} from "./prompts.js";
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
  type ChangedOutputConsentRequest,
} from "../installer/reconcile.js";

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
  const stdoutContext = presentationContext(request.stdout);
  const stderrContext = presentationContext(request.stderr);
  const humanOptions: LifecycleHumanOptions = {
    selection: request.selection,
    ...(request.verbose ? { verbose: true } : {}),
  };
  const interactive = isInteractiveInput(request.input);
  // Update has no general confirmation (DEC-004): the prompt exists only for
  // unauthored changed-file scope. When both answering flags are present no
  // review can fire, so no prompt object is needed.
  const prompt = interactive && !request.json && !(request.replaceChanged && request.removeChanged)
    ? createTextPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    })
    : undefined;
  let promptedAcceptedScope: ApplyAnsweringScope | undefined;
  let requestedScope: ApplyAnsweringScope = { replace: false, remove: false };
  let declinedAnswer: ApplyDeclinedAnswer = "declined";
  const confirmChangedOutputReplacement = prompt === undefined
    ? undefined
    : async (consentRequest: ChangedOutputConsentRequest): Promise<"accepted" | "declined" | "cancelled"> => {
      let diffPage = 0;
      requestedScope = {
        remove: consentRequest.projects.some((project) => project.removedOutputs.length > 0),
        replace: consentRequest.projects.some((project) => project.changedOutputs.length > 0),
      };
      writeHumanDocument(
        request.stdout,
        applyReplacementConfirmationDocument(consentRequest, humanOptions),
        stdoutContext,
      );
      for (;;) {
        const answer = await prompt(APPLY_REPLACEMENT_QUESTION);
        if (answer.kind === "cancelled") {
          declinedAnswer = "cancelled";
          return "cancelled";
        }
        const normalized = answer.value.trim().toLowerCase();
        if (normalized === "d" || normalized === "diff") {
          // The optional diff is a consent view, not consent (US-020):
          // viewing returns to the same scope with nothing authorized, and
          // repeated views page through the remaining hunks (INT-3).
          const viewed = changedOutputDiffDocument(consentRequest.comparisons, diffPage);
          diffPage = (viewed.pageIndex + 1) % viewed.pageCount;
          writeHumanDocument(request.stdout, viewed.document, stdoutContext);
          continue;
        }
        if (normalized === "y" || normalized === "yes") {
          promptedAcceptedScope = {
            remove: consentRequest.projects.some((project) => project.removedOutputs.length > 0),
            replace: consentRequest.projects.some((project) => project.changedOutputs.length > 0),
          };
          return "accepted";
        }
        declinedAnswer = normalized === "" ? "default" : "declined";
        return "declined";
      }
    };
  // The answering scope one equivalent command must carry: flags already
  // given plus the operations the prompt authorized or is asked to authorize.
  const equivalentScope = (prompted: ApplyAnsweringScope | undefined): ApplyAnsweringScope => ({
    remove: request.removeChanged || prompted?.remove === true || requestedScope.remove,
    replace: request.replaceChanged || prompted?.replace === true || requestedScope.replace,
  });
  try {
    const applied = await applyApplication(request.home, {
      selection: request.selection,
      ...(request.replaceChanged ? { replaceChanged: true as const } : {}),
      ...(request.removeChanged ? { removeChanged: true as const } : {}),
      ...(confirmChangedOutputReplacement === undefined
        ? {}
        : { confirmChangedOutputReplacement }),
    });
    if (request.json) {
      request.stdout.write(formatApplyJson(applied));
    } else {
      writeHumanDocument(request.stdout, applyReportDocument(applied, humanOptions), stdoutContext);
      if (promptedAcceptedScope !== undefined) {
        writeHumanDocument(
          request.stdout,
          applyReplacementCommandDocument(
            fullySpecifiedApplyArguments(request.selection, equivalentScope(promptedAcceptedScope)),
          ),
          stdoutContext,
        );
      }
    }
    // Exit 0 whenever update completed without blockers, including remaining
    // non-current work (outcome "attention"). Gate on blockers only.
    return { exitCode: lifecycleExitCode(applied.resultingState) };
  } catch (error) {
    if (error instanceof ApplyDeclinedError) {
      if (request.json) {
        request.stdout.write(formatLifecycleToolErrorJson("update", formatError(error)));
      } else {
        const scope = equivalentScope(promptedAcceptedScope);
        writeHumanDocument(
          request.stderr,
          applyReplacementDeclinedDocument(
            error.reason === "cancelled" ? "cancelled" : declinedAnswer,
            fullySpecifiedApplyArguments(request.selection, scope),
            scope,
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyConsentRequiredError) {
      // The remedy stays runnable: already-supplied flags are kept and the
      // missing operations are added, so re-running answers the whole scope.
      const scope: ApplyAnsweringScope = {
        remove: request.removeChanged || error.requiredOperations.includes("remove"),
        replace: request.replaceChanged || error.requiredOperations.includes("replace"),
      };
      if (request.json) {
        request.stdout.write(formatLifecycleToolErrorJson("update", formatError(error)));
      } else {
        writeHumanDocument(
          request.stderr,
          applyConsentRequiredDocument(
            error,
            fullySpecifiedApplyArguments(request.selection, scope),
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyReviewStaleError) {
      if (request.json) {
        request.stdout.write(formatLifecycleToolErrorJson("update", formatError(error)));
      } else {
        writeHumanDocument(
          request.stderr,
          applyReviewStaleDocument(
            error,
            fullySpecifiedApplyArguments(
              request.selection,
              equivalentScope(promptedAcceptedScope),
            ),
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyBlockedError) {
      if (request.json) {
        request.stdout.write(formatBlockedApplyJson(error.report));
      } else {
        writeHumanDocument(
          request.stdout,
          blockedApplyReportDocument(error.report, humanOptions),
          stdoutContext,
        );
      }
      return { exitCode: lifecycleExitCode(error.report) };
    }
    if (error instanceof ApplyExecutionError) {
      if (request.json) {
        request.stdout.write(formatApplyExecutionFailureJson(error));
      } else {
        writeHumanDocument(
          request.stderr,
          applyExecutionFailureDocument(error, humanOptions),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyVerificationError) {
      if (request.json) {
        request.stdout.write(formatApplyVerificationFailureJson(error.receipt, error.message));
      } else {
        writeHumanDocument(
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
    return { exitCode: 1 };
  }
}
