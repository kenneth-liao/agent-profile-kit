/**
 * The `uninstall` command (spec #491 US-003/US-006/US-007/US-008, DEC-001/
 * DEC-003–DEC-006, ticket #496): remove selected Project installations and
 * forget their remembered selection in one per-Project transition. It
 * replaces public `unbind` with no compatibility shim (pre-1.0
 * breaking-change policy).
 *
 * Scope is explicit: `--here`, `--project <path>`, or `--all` (mutually
 * exclusive), intersected by `--profile`. An absent non-interactive scope
 * never implies all Projects, and a bare interactive invocation refuses
 * instead of widening (interactive selection belongs to #499). `--host`
 * stays rejected until #498 introduces per-Host removal with final
 * partial-removal semantics; `--replace-changed` is rejected because a
 * deletion-only operation has no replacement scope for it to authorize.
 */
export interface ParsedUninstallArguments {
  readonly project?: string;
  readonly projectFlag: boolean;
  readonly here: boolean;
  readonly all: boolean;
  readonly profile?: string;
  readonly autoConfirm: boolean;
  readonly removeChanged: boolean;
  readonly json: boolean;
}

/**
 * A flag rejection that carries the runnable full-Project equivalent: the
 * same invocation with the rejected flag answered, so declining the new
 * semantics never strands the user without a working command.
 */
export class UninstallUnsupportedFlagError extends Error {
  readonly equivalent: string;

  constructor(flag: "--host" | "--replace-changed", equivalent: string, message: string) {
    super(message);
    this.name = "UninstallUnsupportedFlagError";
    this.equivalent = equivalent;
  }
}

/** The canonical token order for one equivalent uninstall command. */
function equivalentCommand(options: {
  readonly here: boolean;
  readonly all: boolean;
  readonly project?: string;
  readonly profile?: string;
  readonly removeChanged: boolean;
  readonly autoConfirm: boolean;
  readonly json: boolean;
}): string {
  const tokens = ["uninstall"];
  if (options.here) tokens.push("--here");
  if (options.all) tokens.push("--all");
  if (options.project !== undefined) tokens.push("--project", options.project);
  if (options.profile !== undefined) tokens.push("--profile", options.profile);
  if (options.removeChanged) tokens.push("--remove-changed");
  if (options.autoConfirm) tokens.push("--auto-confirm");
  if (options.json) tokens.push("--json");
  return tokens.join(" ");
}

/**
 * Parse `uninstall [--here | --project <path> | --all] [--profile <name>]
 * [--auto-confirm] [--remove-changed] [--json]`. Missing scope is reported
 * as absent, not defaulted: the command layer refuses it before any write.
 */
export function parseUninstallArguments(
  arguments_: readonly string[],
): ParsedUninstallArguments {
  let project: string | undefined;
  let projectFlag = false;
  let here = false;
  let all = false;
  let profile: string | undefined;
  let autoConfirm = false;
  let removeChanged = false;
  let json = false;
  let positional: string | undefined;
  let host: string | undefined;
  let replaceChanged = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--here") {
      here = true;
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--project") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("uninstall --project requires a Project path");
      }
      project = value;
      projectFlag = true;
      index += 1;
      continue;
    }
    if (argument === "--profile") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("uninstall --profile requires a Profile name");
      }
      profile = value;
      index += 1;
      continue;
    }
    if (argument === "--host") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("uninstall --host requires an Agent Host name");
      }
      host = value;
      index += 1;
      continue;
    }
    if (argument === "--auto-confirm") {
      autoConfirm = true;
      continue;
    }
    if (argument === "--remove-changed") {
      removeChanged = true;
      continue;
    }
    if (argument === "--replace-changed") {
      replaceChanged = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      if (positional !== undefined) {
        throw new Error("uninstall accepts at most one Project path");
      }
      positional = argument;
      continue;
    }
    throw new Error(`uninstall does not accept argument '${argument}'`);
  }
  if (positional !== undefined) {
    if (projectFlag) {
      throw new Error("uninstall --project cannot be combined with a Project path");
    }
    project = positional;
  }
  if (projectFlag && here) {
    throw new Error("uninstall --project cannot be combined with --here");
  }
  if (projectFlag && all) {
    throw new Error("uninstall --project cannot be combined with --all");
  }
  if (all && project !== undefined) {
    throw new Error("uninstall --all cannot be combined with a Project path");
  }
  if (here && all) {
    throw new Error("uninstall --here cannot be combined with --all");
  }
  if (here && project !== undefined) {
    throw new Error("uninstall --here cannot be combined with a Project path");
  }
  if (host !== undefined) {
    // A bare `--host` names no scope, and the scope-less equivalent would
    // itself be refused: `--here` (the containing Project) keeps the
    // rejection runnable (INT-6).
    const equivalent = equivalentCommand({
      here: here || (!all && project === undefined),
      all,
      ...(project === undefined ? {} : { project }),
      ...(profile === undefined ? {} : { profile }),
      removeChanged,
      autoConfirm,
      json,
    });
    throw new UninstallUnsupportedFlagError(
      "--host",
      equivalent,
      `uninstall --host is not supported yet; per-Host removal arrives with the Host-removal change, which removes only output no longer required by the remaining Hosts. ` +
        `To remove the whole installation now, run ${equivalent}`,
    );
  }
  if (replaceChanged) {
    // Like --host, a scope-less rejection names --here so the equivalent
    // stays runnable (RE-4).
    const equivalent = equivalentCommand({
      here: here || (!all && project === undefined),
      all,
      ...(project === undefined ? {} : { project }),
      ...(profile === undefined ? {} : { profile }),
      removeChanged: true,
      autoConfirm,
      json,
    });
    throw new UninstallUnsupportedFlagError(
      "--replace-changed",
      equivalent,
      `uninstall --replace-changed is not applicable: uninstall only deletes generated output, so there is no replacement scope to authorize. ` +
        `Did you mean --remove-changed? To authorize deletion of independently changed output, run ${equivalent}`,
    );
  }
  return {
    ...(project === undefined ? {} : { project }),
    projectFlag,
    here,
    all,
    ...(profile === undefined ? {} : { profile }),
    autoConfirm,
    removeChanged,
    json,
  };
}

import type { Readable, Writable } from "node:stream";

import { writeHumanDocument } from "./presentation-document.js";
import { errorDiagnosticDocument, formatError } from "./error-wording.js";
import { COMMANDS } from "./command-help.js";
import {
  applyConsentRequiredDocument,
  applyReplacementDeclinedDocument,
  applyReviewStaleDocument,
  formatUninstallJson,
  formatUninstallToolErrorJson,
  uninstallConfirmationDocument,
  uninstallConfirmationRequiredDocument,
  uninstallDeclinedDocument,
  uninstallExecutionFailureDocument,
  uninstallMissingScopeDocument,
  uninstallNoMatchDocument,
  uninstallReceiptDocument,
  uninstallReplacementCommandDocument,
  uninstallScopeChangedDocument,
  UNINSTALL_CONFIRMATION_QUESTION,
  type ChangedFileAnsweringScope,
  type UninstallErrorProgress,
} from "./presentation.js";
import {
  answeringScope,
  createChangedOutputConfirmer,
} from "./changed-output-confirm.js";
import {
  terminalPresentationContext,
  type TerminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";
import { createTextPrompt, isInteractiveInput, type PromptClock } from "./prompts.js";
import type { CommandArg } from "./inline-content.js";
import { ProjectTargetError, type ProjectBindingSelection } from "../installer/local-configuration.js";
import {
  executeUninstall,
  previewUninstall,
  UninstallScopeChangedError,
  type UninstallPreview,
} from "../installer/uninstall-application.js";
import {
  ApplyConsentRequiredError,
  ApplyDeclinedError,
  ApplyReviewStaleError,
} from "../installer/reconcile.js";

const uninstallArg = (value: string): CommandArg => ({ kind: "text", value });

export interface UninstallCommandRequest {
  readonly home: string;
  /** The arguments after the command token. */
  readonly arguments: readonly string[];
  /** Injectable output stream for the receipt and the prompt questions. */
  readonly stdout: Writable & TerminalStream;
  /** Injectable diagnostic stream. */
  readonly stderr: Writable & TerminalStream;
  /** Injectable prompt input stream; TTY evidence is read here (DEC-035). */
  readonly input: Readable;
  /** Working directory used for `--here` and bare-scope guidance. */
  readonly cwd?: string;
  readonly clock?: PromptClock;
}

export interface UninstallCommandOutcome {
  readonly exitCode: 0 | 1 | 2;
}

/** The one canonical uninstall usage line, read from the command-help table. */
const uninstallCommandSyntax = COMMANDS.find((command) => command.name === "uninstall")!.syntax;

function uninstallScopeSelection(
  parsed: ParsedUninstallArguments,
  cwd: string,
): ProjectBindingSelection {
  if (parsed.here) {
    return { command: "uninstall", kind: "project", match: "containing", target: cwd };
  }
  if (parsed.project !== undefined) {
    return { command: "uninstall", kind: "project", match: "exact", target: parsed.project };
  }
  return { kind: "all" };
}

/**
 * The equivalent fully specified command arguments: the same removal with
 * every scope argument and, unless omitted, the general-confirmation answer
 * explicit, so re-running it needs no second answer. The scope-changed
 * retry omits the answer so the changed scope is reviewed, not removed
 * unseen (RE-1). The Project travels as a path
 * argument so the renderer shell-quotes it as one POSIX token; every other
 * token is plain text.
 */
export function fullySpecifiedUninstallArguments(
  parsed: ParsedUninstallArguments,
  preview?: UninstallPreview,
  includeAutoConfirm = true,
): readonly CommandArg[] {
  const args: CommandArg[] = [uninstallArg("uninstall")];
  if (parsed.here) args.push(uninstallArg("--here"));
  if (parsed.all) args.push(uninstallArg("--all"));
  if (parsed.project !== undefined) {
    const canonical = preview?.projects.find((entry) => entry.project === parsed.project)
      ?.canonicalProject;
    args.push(
      uninstallArg("--project"),
      {
        kind: "path",
        canonicalPath: canonical ?? parsed.project,
        scope: "fleet",
        authoredPath: parsed.project,
      },
    );
  }
  if (parsed.profile !== undefined) {
    args.push(uninstallArg("--profile"), uninstallArg(parsed.profile));
  }
  if (parsed.removeChanged) args.push(uninstallArg("--remove-changed"));
  if (includeAutoConfirm) args.push(uninstallArg("--auto-confirm"));
  return args;
}

/** One preview identity carried into machine progress payloads. */
function uninstallProgressIdentity(entry: {
  readonly canonicalProject?: string;
  readonly project: string;
}): { readonly canonicalProject?: string; readonly project: string } {
  return {
    ...(entry.canonicalProject === undefined ? {} : { canonicalProject: entry.canonicalProject }),
    project: entry.project,
  };
}

export async function runUninstallCommand(
  request: UninstallCommandRequest,
): Promise<UninstallCommandOutcome> {
  const stderrContext: TerminalPresentationContext = terminalPresentationContext(request.stderr);

  let parsed: ParsedUninstallArguments;
  try {
    parsed = parseUninstallArguments(request.arguments);
  } catch (error) {
    // The parse catch runs before `parsed` exists: detect machine mode
    // from the raw arguments so scripts get the versioned envelope
    // instead of prose on stderr (RE-3). A `--json` token can only be the
    // flag here — every flag value and positional rejects a leading dash.
    if (request.arguments.includes("--json")) {
      request.stdout.write(formatUninstallToolErrorJson(formatError(error)));
    } else {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(error, { usage: uninstallCommandSyntax }),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }

  const cwd = request.cwd ?? process.cwd();
  const interactive = isInteractiveInput(request.input);
  const hasScope = parsed.here || parsed.all || parsed.project !== undefined ||
    parsed.profile !== undefined;
  if (!hasScope) {
    // Missing choices stay missing (DEC-004/US-006): an absent scope never
    // implies all Projects, on any input stream. Interactive selection
    // belongs to #499; this refusal names the explicit fleet equivalent.
    if (parsed.json) {
      request.stdout.write(formatUninstallToolErrorJson(
        "uninstall needs an explicit scope before any write; an absent scope never implies all Projects",
      ));
    } else {
      writeHumanDocument(
        request.stderr,
        uninstallMissingScopeDocument(fullySpecifiedUninstallArguments({ ...parsed, all: true })),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }

  // The preview resolves the scope without writing anything; the general
  // confirmation (DEC-004) authorizes exactly this scope.
  let preview: UninstallPreview;
  try {
    preview = await previewUninstall(request.home, {
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.here ? { here: true as const } : {}),
      ...(parsed.all ? { all: true as const } : {}),
      ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
      cwd,
    });
  } catch (error) {
    if (parsed.json) {
      request.stdout.write(formatUninstallToolErrorJson(formatError(error)));
    } else {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(
          error,
          error instanceof ProjectTargetError ? { usage: uninstallCommandSyntax } : undefined,
        ),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }

  if (preview.projects.length === 0) {
    // Filters intersect, never broaden: a zero match reports truthfully with
    // no writes rather than failing as a target error.
    const description = parsed.profile !== undefined
      ? `Profile '${parsed.profile}'${parsed.all || parsed.here || parsed.project !== undefined ? " within the selected scope" : ""}`
      : "the selected scope";
    if (parsed.json) {
      request.stdout.write(
        formatUninstallToolErrorJson(`uninstall matched no installation for ${description}`),
      );
    } else {
      writeHumanDocument(
        request.stderr,
        uninstallNoMatchDocument(description),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }

  const stdoutContext: TerminalPresentationContext = terminalPresentationContext(request.stdout);
  if (!parsed.autoConfirm && (!interactive || parsed.json)) {
    if (parsed.json) {
      request.stdout.write(formatUninstallToolErrorJson(
        "uninstall needs explicit confirmation before any write",
      ));
    } else {
      writeHumanDocument(
        request.stderr,
        uninstallConfirmationRequiredDocument(fullySpecifiedUninstallArguments(parsed, preview)),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }
  if (!parsed.autoConfirm) {
    // Interactive human input only: every other case refused above. The
    // general confirmation answers no missing choice and no changed-file
    // scope (DEC-004/DEC-005); declining leaves everything untouched.
    const prompt = createTextPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    });
    writeHumanDocument(
      request.stdout,
      uninstallConfirmationDocument(
        preview,
        // A Profile-only scope names its fleet-wide reach (PROD-4): it
        // selects every installation using the Profile, not a modifier.
        !parsed.here && !parsed.all && parsed.project === undefined && parsed.profile !== undefined
          ? { fleetProfile: parsed.profile }
          : {},
      ),
      stdoutContext,
    );
    const answer = await prompt(UNINSTALL_CONFIRMATION_QUESTION);
    if (answer.kind === "cancelled") {
      writeHumanDocument(
        request.stderr,
        uninstallDeclinedDocument("cancelled", fullySpecifiedUninstallArguments(parsed, preview)),
        stderrContext,
      );
      return { exitCode: 1 };
    }
    const normalized = answer.value.trim().toLowerCase();
    if (normalized !== "y" && normalized !== "yes") {
      writeHumanDocument(
        request.stderr,
        uninstallDeclinedDocument(
          normalized === "" ? "default" : "declined",
          fullySpecifiedUninstallArguments(parsed, preview),
        ),
        stderrContext,
      );
      return { exitCode: 1 };
    }
  }

  // Changed-file consent consumes the one shared loop (DEC-005, US-020).
  // Uninstall performs no replacements, so only deletion needs authorization.
  const confirmer = createChangedOutputConfirmer({
    input: request.input,
    output: request.stdout,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    json: parsed.json,
    replaceChanged: false,
    removeChanged: parsed.removeChanged,
    selection: uninstallScopeSelection(parsed, cwd),
  });
  const answering = (
    prompted: ChangedFileAnsweringScope | undefined,
  ): ChangedFileAnsweringScope =>
    answeringScope({ replaceChanged: false, removeChanged: parsed.removeChanged }, prompted, confirmer.requestedScope());
  try {
    const result = await executeUninstall(request.home, {
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.here ? { here: true as const } : {}),
      ...(parsed.all ? { all: true as const } : {}),
      ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
      cwd,
      // The executed scope is the reviewed scope: re-resolution inside
      // fails closed when a concurrent change widens or narrows it (INT-2).
      confirmedPreview: preview,
      ...(parsed.removeChanged ? { removeChanged: true as const } : {}),
      ...(confirmer.confirm === undefined ? {} : { confirmChangedOutputReplacement: confirmer.confirm }),
    });
    if (result.failed !== undefined) {
      const retry = fullySpecifiedUninstallArguments(parsed, preview);
      if (parsed.json) {
        request.stdout.write(formatUninstallJson(result));
      } else {
        writeHumanDocument(
          request.stderr,
          uninstallExecutionFailureDocument({
            failed: result.failed,
            completed: [...result.completed],
            unattempted: [...result.unattempted],
            retryArguments: retry,
          }),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (parsed.json) {
      request.stdout.write(formatUninstallJson(result));
    } else {
      writeHumanDocument(request.stdout, uninstallReceiptDocument(result), stdoutContext);
      const acceptedScope = confirmer.promptedAcceptedScope();
      if (acceptedScope !== undefined) {
        writeHumanDocument(
          request.stdout,
          uninstallReplacementCommandDocument(
            fullySpecifiedUninstallArguments(
              {
                ...parsed,
                removeChanged: parsed.removeChanged || acceptedScope.remove === true,
              },
              preview,
            ),
          ),
          stdoutContext,
        );
      }
    }
    // Exit 2 when known Blockers skipped healthy work (the lifecycle
    // blocker matrix); exit 0 when every selected Project completed.
    return { exitCode: result.skipped.length > 0 ? 2 : 0 };
  } catch (error) {
    if (error instanceof UninstallScopeChangedError) {
      // The selection moved between confirmation and commit: nothing was
      // written, and the current scope reports as unattempted (INT-2). The
      // retry deliberately omits --auto-confirm: following it must review
      // the changed scope, not remove it unseen (RE-1).
      const progress: UninstallErrorProgress = {
        completed: [],
        unattempted: error.current.map(uninstallProgressIdentity),
      };
      const retry = fullySpecifiedUninstallArguments(parsed, preview, false);
      if (parsed.json) {
        request.stdout.write(formatUninstallToolErrorJson(formatError(error), progress));
      } else {
        writeHumanDocument(
          request.stderr,
          uninstallScopeChangedDocument(retry),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyDeclinedError) {
      const scope = answering(confirmer.promptedAcceptedScope());
      // Declining precedes every lifecycle write: nothing completed, and
      // the reviewed scope reports as unattempted (PROD-3).
      const progress: UninstallErrorProgress = {
        completed: [],
        unattempted: preview.projects.map(uninstallProgressIdentity),
      };
      if (parsed.json) {
        request.stdout.write(formatUninstallToolErrorJson(formatError(error), progress));
      } else {
        writeHumanDocument(
          request.stderr,
          applyReplacementDeclinedDocument(
            error.reason === "cancelled" ? "cancelled" : confirmer.declinedAnswer(),
            fullySpecifiedUninstallArguments(parsed, preview),
            scope,
            "uninstall",
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyConsentRequiredError) {
      // The remedy stays runnable: the missing deletion authorization is
      // added, so re-running answers the whole scope. The refusal carries
      // the partial outcome for machine consumers (PROD-3); a pre-write
      // refusal carries no pending evidence, so the whole reviewed scope
      // reports as unattempted — nothing was attempted.
      const progress: UninstallErrorProgress = {
        completed: error.completedProjects.map((name) => ({ canonicalProject: name, project: name })),
        ...(error.failedProject === undefined ? {} : {
          failed: {
            canonicalProject: error.failedProject.canonicalProject,
            project: error.failedProject.project,
            detail: formatError(error),
            selectionRestored: true,
            concurrentSelectionChange: false,
          },
        }),
        unattempted: (error.pendingProjects ?? preview.projects).map(uninstallProgressIdentity),
      };
      if (parsed.json) {
        request.stdout.write(formatUninstallToolErrorJson(formatError(error), progress));
      } else {
        writeHumanDocument(
          request.stderr,
          applyConsentRequiredDocument(
            error,
            fullySpecifiedUninstallArguments({ ...parsed, removeChanged: true }, preview),
            "uninstall",
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyReviewStaleError) {
      const progress: UninstallErrorProgress = {
        completed: error.completedProjects.map((name) => ({ canonicalProject: name, project: name })),
        failed: {
          canonicalProject: error.failedProject.canonicalProject,
          project: error.failedProject.project,
          detail: formatError(error),
          selectionRestored: true,
          concurrentSelectionChange: false,
        },
        unattempted: error.pendingProjects.map(uninstallProgressIdentity),
      };
      if (parsed.json) {
        request.stdout.write(formatUninstallToolErrorJson(formatError(error), progress));
      } else {
        writeHumanDocument(
          request.stderr,
          applyReviewStaleDocument(
            error,
            fullySpecifiedUninstallArguments(parsed, preview),
            "uninstall",
          ),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (parsed.json) {
      request.stdout.write(formatUninstallToolErrorJson(formatError(error)));
    } else {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(
          error,
          error instanceof ProjectTargetError ? { usage: uninstallCommandSyntax } : undefined,
        ),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }
}
