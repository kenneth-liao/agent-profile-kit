/**
 * The `apply` command: one invocation-wide changed-output replacement consent
 * gate (DEC-019) wired in front of the Installer's write loop.
 *
 * The consent prompt fires only on an interactive input stream, only for human
 * output, and only when the invocation holds proven changed generated files;
 * `--replace-changed` answers it explicitly, and non-interactive invocations
 * never prompt. Declining, cancelling, or the default answer aborts the whole
 * invocation before any configuration or generated-output write. The Installer
 * keeps every safety Blocker: consent never bypasses ownership, path-safety,
 * or global Blockers.
 */
import type { Readable, Writable } from "node:stream";
import type { WriteStream } from "node:tty";

import {
  applyExecutionFailureDocument,
  applyReplacementCommandDocument,
  applyReplacementConfirmationDocument,
  applyReplacementDeclinedDocument,
  applyReportDocument,
  applyVerificationFailureDocument,
  blockedApplyReportDocument,
  APPLY_REPLACEMENT_QUESTION,
  formatApplyExecutionFailureJson,
  formatApplyJson,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatLifecycleToolErrorJson,
  lifecycleExitCode,
  type LifecycleHumanOptions,
} from "./presentation.js";
import {
  renderPresentationDocument,
  type PresentationDocument,
} from "./presentation-document.js";
import { errorDiagnosticDocument, formatError } from "./error-wording.js";
import { COMMANDS } from "./command-help.js";
import { terminalPresentationContext, type TerminalPresentationContext } from "./terminal-presentation.js";
import {
  createConfirmPrompt,
  isInteractiveInput,
  type PromptClock,
} from "./prompts.js";
import { ProjectTargetError, type ProjectBindingSelection } from "../installer/local-configuration.js";
import {
  applyApplication,
} from "../installer/commands.js";
import {
  ApplyBlockedError,
  ApplyDeclinedError,
  ApplyExecutionError,
  ApplyVerificationError,
  type ChangedOutputConsentRequest,
} from "../installer/reconcile.js";

export interface ApplyCommandRequest {
  readonly home: string;
  readonly selection: ProjectBindingSelection;
  readonly json: boolean;
  /** The explicit answering flag: replace changed generated files without asking (US-031). */
  readonly replaceChanged: boolean;
  readonly verbose: boolean;
  /** Injectable output stream for the human report and the prompt question. */
  readonly stdout: Writable;
  /** Injectable diagnostic stream. */
  readonly stderr: Writable;
  /** Injectable prompt input stream; TTY evidence is read here (DEC-035). */
  readonly input: Readable;
  readonly clock?: PromptClock;
}

export interface ApplyCommandOutcome {
  readonly exitCode: 0 | 1 | 2;
}

/** The one canonical apply usage line, read from the command-help table. */
const applyCommandSyntax = COMMANDS.find((command) => command.name === "apply")!.syntax;

/** One trusted terminal-presentation context per injected stream. */
function presentationContext(stream: Writable): TerminalPresentationContext {
  return terminalPresentationContext(stream as unknown as WriteStream);
}

function writeHumanDocument(
  stream: Writable,
  document: PresentationDocument,
  context: TerminalPresentationContext,
): void {
  const rendered = renderPresentationDocument(document, context, {});
  stream.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}

/**
 * The equivalent fully specified command arguments (DEC-032): every scope
 * argument explicit, plus the answering flag, so the printed command expresses
 * the chosen operation without needing the same answer again.
 */
export function fullySpecifiedApplyArguments(
  selection: ProjectBindingSelection,
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
  args.push("--replace-changed");
  return ["apply", ...args];
}

export async function runApplyCommand(request: ApplyCommandRequest): Promise<ApplyCommandOutcome> {
  const stdoutContext = presentationContext(request.stdout);
  const stderrContext = presentationContext(request.stderr);
  const humanOptions: LifecycleHumanOptions = {
    selection: request.selection,
    ...(request.verbose ? { verbose: true } : {}),
  };
  const interactive = isInteractiveInput(request.input);
  const prompt = interactive && !request.json && !request.replaceChanged
    ? createConfirmPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    })
    : undefined;
  let promptedAccepted = false;
  const confirmChangedOutputReplacement = prompt === undefined
    ? undefined
    : async (consentRequest: ChangedOutputConsentRequest): Promise<"accepted" | "declined" | "cancelled"> => {
      writeHumanDocument(
        request.stdout,
        applyReplacementConfirmationDocument(consentRequest, humanOptions),
        stdoutContext,
      );
      const answer = await prompt(APPLY_REPLACEMENT_QUESTION);
      if (answer === "accepted") promptedAccepted = true;
      return answer;
    };
  try {
    const applied = await applyApplication(request.home, {
      selection: request.selection,
      ...(confirmChangedOutputReplacement === undefined
        ? {}
        : { confirmChangedOutputReplacement }),
    });
    if (request.json) {
      request.stdout.write(formatApplyJson(applied));
    } else {
      writeHumanDocument(request.stdout, applyReportDocument(applied, humanOptions), stdoutContext);
      if (promptedAccepted) {
        writeHumanDocument(
          request.stdout,
          applyReplacementCommandDocument(fullySpecifiedApplyArguments(request.selection)),
          stdoutContext,
        );
      }
    }
    // Exit 0 whenever apply completed without blockers, including remaining
    // non-current work (outcome "attention"). Gate on blockers only.
    return { exitCode: lifecycleExitCode(applied.resultingState) };
  } catch (error) {
    if (error instanceof ApplyDeclinedError) {
      if (request.json) {
        request.stdout.write(formatLifecycleToolErrorJson("apply", formatError(error)));
      } else {
        writeHumanDocument(
          request.stderr,
          applyReplacementDeclinedDocument(
            error.reason,
            fullySpecifiedApplyArguments(request.selection),
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
      request.stdout.write(formatLifecycleToolErrorJson("apply", formatError(error)));
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
