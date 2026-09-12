/**
 * The one shared interactive changed-output consent loop (DEC-005, US-020):
 * consumed by every lifecycle command that can discard independently changed
 * generated files, so there is exactly one confirmation flow, one optional
 * diff view, and one declined/default/cancelled answer contract. The loop
 * authorizes only the reviewed scope; viewing the diff grants no consent.
 */
import type { Readable, Writable } from "node:stream";

import {
  applyReplacementConfirmationDocument,
  changedOutputDiffDocument,
  APPLY_REPLACEMENT_QUESTION,
  type ApplyDeclinedAnswer,
  type ChangedFileAnsweringScope,
} from "./presentation.js";
import { writeHumanDocument } from "./presentation-document.js";
import { createTextPrompt, isInteractiveInput, type PromptClock } from "./prompts.js";
import { terminalPresentationContext, type TerminalStream } from "./terminal-presentation.js";
import type { ProjectBindingSelection } from "../installer/local-configuration.js";
import type {
  ChangedOutputConsentAnswer,
  ChangedOutputConsentProject,
  ChangedOutputConsentRequest,
} from "../installer/reconcile.js";
import {
  historyRecordFor,
  type ChangedOutputHistoryRecord,
} from "../installer/changed-output-review.js";

export interface ChangedOutputConfirmerOptions {
  readonly input: Readable;
  readonly output: Writable & TerminalStream;
  readonly clock?: PromptClock;
  /** Machine JSON never prompts; missing consent refuses instead. */
  readonly json: boolean;
  /** Explicit per-operation answering flags (DEC-005). */
  readonly replaceChanged: boolean;
  readonly removeChanged: boolean;
  /** The invocation scope, for Project-attributed review rendering. */
  readonly selection: ProjectBindingSelection;
}

export interface ChangedOutputConfirmer {
  /**
   * The consent callback for the Installer gate, or undefined when no review
   * can fire (non-interactive/JSON input, or both answering flags present).
   * The Installer refuses before any write when the gate fires without one.
   */
  readonly confirm:
    | ((request: ChangedOutputConsentRequest) => Promise<ChangedOutputConsentAnswer>)
    | undefined;
  /** The operations the prompt authorized, once it has accepted. */
  promptedAcceptedScope(): ChangedFileAnsweringScope | undefined;
  /** The operations at stake in the latest review, for equivalent commands. */
  requestedScope(): ChangedFileAnsweringScope;
  /** How the declined answer was given. */
  declinedAnswer(): ApplyDeclinedAnswer;
  /**
   * The Projects the consent gate reviewed, in review order (DEC-008): the one
   * diagnostic projection an entry carries, never file contents.
   */
  reviewedProjects(): readonly ChangedOutputConsentProject[];
  /** History-safe changed-output records (identity and paths only). */
  reviewedChangedOutputs(): readonly ChangedOutputHistoryRecord[];
}

export function createChangedOutputConfirmer(
  options: ChangedOutputConfirmerOptions,
): ChangedOutputConfirmer {
  const stdoutContext = terminalPresentationContext(options.output);
  const interactive = isInteractiveInput(options.input);
  // The prompt exists only for unauthored changed-file scope. When both
  // answering flags are present no review can fire, so no prompt is needed.
  const prompt = interactive && !options.json &&
      !(options.replaceChanged && options.removeChanged)
    ? createTextPrompt({
      input: options.input,
      output: options.output,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    })
    : undefined;
  let promptedScope: ChangedFileAnsweringScope | undefined;
  let requested: ChangedFileAnsweringScope = { replace: false, remove: false };
  let declined: ApplyDeclinedAnswer = "declined";
  const reviewedProjects: ChangedOutputConsentProject[] = [];
  const reviewedChangedOutputs: ChangedOutputHistoryRecord[] = [];
  const confirm = prompt === undefined
    ? undefined
    : async (consentRequest: ChangedOutputConsentRequest): Promise<ChangedOutputConsentAnswer> => {
      reviewedProjects.push(...consentRequest.projects);
      reviewedChangedOutputs.push(...consentRequest.comparisons.map(historyRecordFor));
      let diffPage = 0;
      requested = {
        remove: consentRequest.projects.some((project) => project.removedOutputs.length > 0),
        replace: consentRequest.projects.some((project) => project.changedOutputs.length > 0),
      };
      writeHumanDocument(
        options.output,
        applyReplacementConfirmationDocument(consentRequest, { selection: options.selection }),
        stdoutContext,
      );
      for (;;) {
        const answer = await prompt(APPLY_REPLACEMENT_QUESTION);
        if (answer.kind === "cancelled") {
          declined = "cancelled";
          return "cancelled";
        }
        const normalized = answer.value.trim().toLowerCase();
        if (normalized === "d" || normalized === "diff") {
          // The optional diff is a consent view, not consent (US-020):
          // viewing returns to the same scope with nothing authorized, and
          // repeated views page through the remaining hunks (INT-3).
          const viewed = changedOutputDiffDocument(consentRequest.comparisons, diffPage);
          diffPage = (viewed.pageIndex + 1) % viewed.pageCount;
          writeHumanDocument(options.output, viewed.document, stdoutContext);
          continue;
        }
        if (normalized === "y" || normalized === "yes") {
          promptedScope = {
            remove: consentRequest.projects.some((project) => project.removedOutputs.length > 0),
            replace: consentRequest.projects.some((project) => project.changedOutputs.length > 0),
          };
          return "accepted";
        }
        declined = normalized === "" ? "default" : "declined";
        return "declined";
      }
    };
  return {
    confirm,
    promptedAcceptedScope: () => promptedScope,
    requestedScope: () => requested,
    declinedAnswer: () => declined,
    reviewedProjects: () => reviewedProjects,
    reviewedChangedOutputs: () => reviewedChangedOutputs,
  };
}

/**
 * The answering scope one equivalent command must carry: flags already given
 * plus the operations the prompt authorized or is asked to authorize.
 */
export function answeringScope(
  flags: { readonly replaceChanged: boolean; readonly removeChanged: boolean },
  prompted: ChangedFileAnsweringScope | undefined,
  requested: ChangedFileAnsweringScope,
): ChangedFileAnsweringScope {
  return {
    remove: flags.removeChanged || prompted?.remove === true || requested.remove,
    replace: flags.replaceChanged || prompted?.replace === true || requested.replace,
  };
}
