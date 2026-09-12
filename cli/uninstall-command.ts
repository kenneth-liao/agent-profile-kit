/**
 * The `uninstall` command (spec #491 US-003/US-004/US-006/US-007/US-008,
 * DEC-001/DEC-003–DEC-006, tickets #496–#498): remove selected Project
 * installations and forget their remembered selection in one per-Project
 * transition. It replaces public `unbind` with no compatibility shim
 * (pre-1.0 breaking-change policy).
 *
 * Scope is explicit: `--here`, `--project <path>`, or `--all` (mutually
 * exclusive), intersected by `--profile`. An absent non-interactive scope
 * never implies all Projects, and a bare interactive invocation collects
 * its scope through the searchable Project picker instead of widening
 * (ticket #499). `--host`
 * narrows removal to those Hosts within the selected scope (#498): a
 * Host-only invocation still needs an explicit Project scope (a `--profile`
 * selector provides one) on non-interactive and machine-JSON input, while
 * Host-only interactive input routes into Project selection with its Hosts
 * proposed. `--replace-changed` authorizes only the
 * survivor-rewrite portion of a `--host` partial removal; whole-removal
 * stays deletion-only and keeps rejecting it.
 */
export interface ParsedUninstallArguments {
  readonly project?: string;
  readonly projectFlag: boolean;
  readonly here: boolean;
  readonly all: boolean;
  readonly profile?: string;
  readonly hosts?: readonly string[];
  readonly autoConfirm: boolean;
  readonly removeChanged: boolean;
  readonly replaceChanged: boolean;
  readonly json: boolean;
}

/**
 * A flag rejection that carries the runnable full-Project equivalent: the
 * same invocation with the rejected flag answered, so declining the new
 * semantics never strands the user without a working command.
 */
export class UninstallUnsupportedFlagError extends Error {
  readonly equivalent: string;

  constructor(flag: "--replace-changed", equivalent: string, message: string) {
    super(message);
    this.name = "UninstallUnsupportedFlagError";
    this.equivalent = equivalent;
  }
}

/**
 * The canonical token order for one equivalent uninstall command. The
 * `--replace-changed` rejection is the sole caller and fires only for
 * whole-removal (no `--host`), so no Host rendering belongs here:
 * `--host` values travel only through `fullySpecifiedUninstallArguments`,
 * which renders them exactly like install's equivalent (plain-text tokens
 * from the allowlisted Host catalog).
 */
function equivalentCommand(options: {
  readonly here: boolean;
  readonly all: boolean;
  readonly project?: string;
  readonly profile?: string;
  readonly removeChanged: boolean;
  readonly replaceChanged: boolean;
  readonly autoConfirm: boolean;
  readonly json: boolean;
}): string {
  const tokens = ["uninstall"];
  if (options.here) tokens.push("--here");
  if (options.all) tokens.push("--all");
  if (options.project !== undefined) tokens.push("--project", options.project);
  if (options.profile !== undefined) tokens.push("--profile", options.profile);
  if (options.removeChanged) tokens.push("--remove-changed");
  if (options.replaceChanged) tokens.push("--replace-changed");
  if (options.autoConfirm) tokens.push("--auto-confirm");
  if (options.json) tokens.push("--json");
  return tokens.join(" ");
}

/**
 * Parse `uninstall [--here | --project <path> | --all] [--profile <name>]
 * [--host <host>]... [--auto-confirm] [--remove-changed]
 * [--replace-changed] [--json]`. Missing scope is reported as absent, not
 * defaulted: the command layer refuses it before any write. `--host` may
 * repeat; `--replace-changed` is accepted only alongside `--host` (it
 * authorizes the survivor-rewrite portion of a partial removal).
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
  const hosts: string[] = [];
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
      hosts.push(value);
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
  if (replaceChanged && hosts.length === 0) {
    // A whole-removal deletes only: there is no replacement scope for
    // `--replace-changed` to authorize (DEC-005). It becomes applicable on
    // the `--host` partial path, where retained shared output may be
    // rewritten to serve the remaining Hosts — the rejection points there.
    // A scope-less rejection names --here so the equivalent stays runnable.
    const equivalent = equivalentCommand({
      here: here || (!all && project === undefined),
      all,
      ...(project === undefined ? {} : { project }),
      ...(profile === undefined ? {} : { profile }),
      removeChanged: true,
      replaceChanged: false,
      autoConfirm,
      json,
    });
    throw new UninstallUnsupportedFlagError(
      "--replace-changed",
      equivalent,
      `uninstall --replace-changed is not applicable: whole-removal only deletes generated output, so there is no replacement scope to authorize. ` +
        `It applies only to per-Host removal, where retained shared output may be rewritten for the remaining Hosts: add --host <name> to remove Hosts. ` +
        `Did you mean --remove-changed? To authorize deletion of independently changed output, run ${equivalent}`,
    );
  }
  return {
    ...(project === undefined ? {} : { project }),
    projectFlag,
    here,
    all,
    ...(profile === undefined ? {} : { profile }),
    ...(hosts.length === 0 ? {} : { hosts }),
    autoConfirm,
    removeChanged,
    replaceChanged,
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
  uninstallInteractiveCommandsDocument,
  uninstallInteractiveEquivalentDocument,
  uninstallInteractivePickedDocument,
  uninstallMissingScopeDocument,
  uninstallNoMatchDocument,
  uninstallPickerNoopDocument,
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
import {
  createSearchableMultiSelectPrompt,
  createSelectPrompt,
  createTextPrompt,
  isInteractiveInput,
  type PromptClock,
} from "./prompts.js";
import type { CommandArg } from "./inline-content.js";
import {
  beginLifecycleOperationRecording,
  finishLifecycleOperationRecording,
  lateAuthorizationStopRecording,
  operationOutcome,
  recordProjectedOutcome,
  unattemptedProjectsFromPreview,
  uninstallCancelledRecording,
  uninstallProjects,
  uninstallRecording,
  type LifecycleOperationRecording,
} from "./operation-recording.js";
import { writeLifecycleReport } from "./operation-history-presentation.js";
import type { OperationHistoryScope } from "../installer/operation-history.js";
import { displayProjectPath } from "./display-path.js";
import { SUPPORTED_HOSTS } from "../adapters/registry.js";
import { ProjectTargetError, type ProjectBindingSelection } from "../installer/local-configuration.js";
import {
  executeUninstall,
  normalizeUninstallHosts,
  previewUninstall,
  survivingHostsForRemoval,
  UninstallScopeChangedError,
  type UninstallApplicationResult,
  type UninstallCompletedProject,
  type UninstallFailedProject,
  type UninstallPreview,
  type UninstallPreviewProject,
  type UninstallSkippedProject,
  type UninstallUnattemptedProject,
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

/** The requested scope of one uninstall invocation, for retained evidence. */
function uninstallRecordingScope(parsed: ParsedUninstallArguments): OperationHistoryScope {
  return {
    selection: parsed.all ? "all" : "project",
    ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
    ...(parsed.hosts === undefined || parsed.hosts.length === 0 ? {} : { hosts: [...parsed.hosts] }),
  };
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
  for (const host of parsed.hosts ?? []) {
    args.push(uninstallArg("--host"), uninstallArg(host));
  }
  if (parsed.removeChanged) args.push(uninstallArg("--remove-changed"));
  if (parsed.replaceChanged) args.push(uninstallArg("--replace-changed"));
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

/**
 * Interactive uninstall selection (ticket #499, spec #491 US-003/US-004/
 * US-005, DEC-003–DEC-005): the searchable Project picker, the per-flow
 * whole-versus-Host removal mode, and the Host picker — all on the shared
 * #495 carriage seam, no second prompt framework. Picks are choices, never
 * authority: the batch reviews its complete scope, answers the general
 * confirmation (DEC-004), authorizes changed discards through the shared
 * #493 loop (DEC-005), and commits each Project through the existing
 * explicit contract with its own single-resolution guard (INT-2).
 */
const UNINSTALL_PROJECTS_QUESTION = "Which Projects to uninstall?";
const UNINSTALL_REMOVAL_MODE_QUESTION =
  "Whole installations or selected Hosts? (mix modes by repeating this command)";
const UNINSTALL_HOSTS_QUESTION = "Which Hosts to remove?";

type InteractiveHost = UninstallPreviewProject["hosts"][number];

/** One picked Project with its reviewed single-Project scope. */
interface InteractiveUninstallTarget {
  readonly preview: UninstallPreviewProject;
}

/** Fleet identity for the pick-to-commit comparison (INT-2 for picks):
 * canonical identity, Profile, and bound Hosts — anything the picker
 * inventory showed. A binding added, removed, or rebound anywhere in the
 * fleet fails the remaining batch closed, so unshown scope is never
 * removed. */
function interactiveFleetScopeKey(entry: {
  readonly canonicalProject?: string;
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly string[];
}): string {
  return JSON.stringify([
    entry.canonicalProject ?? entry.project,
    entry.profile,
    [...entry.hosts].sort(),
  ]);
}

/** One picked Project as explicit equivalent arguments: the same removal
 * with its scope, consent flags, and (unless omitted for a scope-change
 * retry, RE-1) the general-confirmation answer explicit. The Project
 * travels as a `--project` path argument so the renderer shell-quotes it
 * as one POSIX token. */
function interactiveEquivalentCommand(
  scope: {
    readonly project: string;
    readonly canonicalProject?: string;
    readonly removeHosts?: readonly string[];
  },
  options: {
    readonly includeAutoConfirm: boolean;
    readonly removeChanged: boolean;
    readonly replaceChanged: boolean;
  },
): readonly CommandArg[] {
  const scopePreview: UninstallPreview = {
    projects: [{
      ...(scope.canonicalProject === undefined
        ? {}
        : { canonicalProject: scope.canonicalProject }),
      project: scope.project,
      profile: "",
      hosts: [],
      ...(scope.removeHosts === undefined ? {} : { removeHosts: [...scope.removeHosts] as InteractiveHost[] }),
      missing: false,
    }],
  };
  return fullySpecifiedUninstallArguments(
    {
      project: scope.project,
      projectFlag: true,
      here: false,
      all: false,
      ...(scope.removeHosts === undefined ? {} : { hosts: [...scope.removeHosts] }),
      autoConfirm: options.includeAutoConfirm,
      removeChanged: options.removeChanged,
      // Whole-removal performs no replacements (DEC-005): never render
      // an inapplicable `--replace-changed` on a whole-removal line.
      replaceChanged: scope.removeHosts === undefined ? false : options.replaceChanged,
      json: false,
    },
    scopePreview,
    options.includeAutoConfirm,
  );
}

/** Per-Project equivalents for the remaining batch (one runnable line per
 * picked Project — a single combined line cannot express per-Project
 * narrowing). */
function interactiveRemainingCommands(
  targets: readonly InteractiveUninstallTarget[],
  options: {
    readonly includeAutoConfirm: boolean;
    readonly removeChanged: boolean;
    readonly replaceChanged: boolean;
  },
): readonly (readonly CommandArg[])[] {
  return targets.map((target) =>
    interactiveEquivalentCommand(
      {
        project: target.preview.project,
        ...(target.preview.canonicalProject === undefined
          ? {}
          : { canonicalProject: target.preview.canonicalProject }),
        ...(target.preview.removeHosts === undefined
          ? {}
          : { removeHosts: [...target.preview.removeHosts] }),
      },
      options,
    )
  );
}

/** The scope-changed halt for the remaining picked batch: nothing further
 * is removed, and every retry omits `--auto-confirm` so the changed scope
 * is reviewed, not removed unseen (RE-1). */
function writeInteractiveScopeChanged(
  request: UninstallCommandRequest,
  stderrContext: TerminalPresentationContext,
  parsed: ParsedUninstallArguments,
  completed: readonly UninstallCompletedProject[],
  remaining: readonly InteractiveUninstallTarget[],
  recording: LifecycleOperationRecording,
): void {
  writeLifecycleReport(
    request.stderr,
    uninstallInteractiveCommandsDocument({
      happened: completed.length === 0
        ? ["uninstall stopped before any write: the selected scope changed during confirmation"]
        : [`uninstall stopped: the selected scope changed during confirmation; completed Projects stay completed: ${completed.map((entry) => entry.project).join(", ")}.`],
      why: [completed.length === 0
        ? ["No Project or setting was changed."]
        : ["Remaining Projects were not attempted."]],
      intro: "Re-run to review the current scope (one command per Project):",
      commands: interactiveRemainingCommands(remaining, {
        includeAutoConfirm: false,
        removeChanged: parsed.removeChanged,
        replaceChanged: parsed.replaceChanged,
      }),
    }),
    stderrContext,
    recording,
  );
}

async function runInteractiveUninstall(
  request: UninstallCommandRequest,
  parsed: ParsedUninstallArguments,
  cwd: string,
  stderrContext: TerminalPresentationContext,
  recording: LifecycleOperationRecording,
): Promise<UninstallCommandOutcome> {
  const scope = uninstallRecordingScope(parsed);
  const stdoutContext: TerminalPresentationContext = terminalPresentationContext(request.stdout);
  const promptOptions = {
    input: request.input,
    output: request.stdout,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
  };

  // The picker inventory reads Local Configuration bindings without
  // resolving the Workspace — the same boundary as the explicit preview —
  // so listing never writes and never needs valid source.
  let fleet: UninstallPreview;
  try {
    fleet = await previewUninstall(request.home, { all: true });
  } catch (error) {
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
    recording.recordNothing("the bound Project inventory could not be read");
    return { exitCode: 1 };
  }
  if (fleet.projects.length === 0) {
    writeHumanDocument(
      request.stderr,
      uninstallNoMatchDocument("any bound Project"),
      stderrContext,
    );
    recording.recordNothing("no Project is bound");
    return { exitCode: 1 };
  }

  // A carried `--host` filter is validated before any picker opens (fail
  // fast): unknown Hosts fail through the shared normalization boundary
  // with zero writes, before the user picks anything.
  let carriedHosts: readonly InteractiveHost[] | undefined;
  if (parsed.hosts !== undefined) {
    try {
      carriedHosts = normalizeUninstallHosts(parsed.hosts);
    } catch (error) {
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      recording.recordNothing("the requested Agent Host is unsupported");
      return { exitCode: 1 };
    }
  }

  // Bare interactive uninstall starts with no Projects selected (DEC-003):
  // nothing is pre-checked, so bound Projects are never silently picked.
  // Titles stay bare identities so typing filters the choice, never
  // evidence text (the #495 seam contract); Profile and Hosts appear in
  // the pre-execution review instead.
  const projectsAnswer = await createSearchableMultiSelectPrompt(promptOptions)(
    UNINSTALL_PROJECTS_QUESTION,
    fleet.projects.map((entry) => ({
      title: displayProjectPath(entry.canonicalProject ?? entry.project, entry.project, "fleet"),
      value: entry.project,
    })),
  );
  if (projectsAnswer.kind === "cancelled") {
    writeHumanDocument(request.stderr, uninstallPickerNoopDocument("cancelled"), stderrContext);
    recording.recordNothing("the Project choice was cancelled");
    return { exitCode: 1 };
  }
  if (projectsAnswer.values.length === 0) {
    // Empty never widens to all Projects: a no-op with zero writes.
    writeHumanDocument(
      request.stderr,
      uninstallPickerNoopDocument("empty-projects"),
      stderrContext,
    );
    recording.recordNothing("no Project was selected");
    return { exitCode: 1 };
  }
  const fleetByProject = new Map(fleet.projects.map((entry) => [entry.project, entry]));
  const picked = [...new Set(projectsAnswer.values)]
    .map((project) => fleetByProject.get(project))
    .filter((entry) => entry !== undefined);
  if (picked.length === 0) {
    writeHumanDocument(
      request.stderr,
      uninstallPickerNoopDocument("empty-projects"),
      stderrContext,
    );
    recording.recordNothing("no Project was selected");
    return { exitCode: 1 };
  }
  // The selected count stays visible with the picked identities (US-005),
  // ahead of the mode question; the pre-execution review repeats the
  // complete scope with Profile and Hosts before any confirmation.
  writeHumanDocument(
    request.stdout,
    uninstallInteractivePickedDocument(
      picked.map((entry) =>
        displayProjectPath(entry.canonicalProject ?? entry.project, entry.project, "fleet")
      ),
    ),
    stdoutContext,
  );

  // A carried `--host` filter proposes Host-mode removal of those Hosts —
  // reviewed at the mode question and again at the confirmation — never
  // silently applied.

  // One removal mode per flow (US-004): mixed whole+partial needs are
  // served by repeat runs, stated in the question framing. The carried
  // Hosts open with Host removal first and named, so the proposal is
  // reviewed here and again at the confirmation.
  const modeAnswer = await createSelectPrompt(promptOptions)(
    UNINSTALL_REMOVAL_MODE_QUESTION,
    carriedHosts === undefined
      ? [
        { title: "Whole installations", value: "whole" as const },
        { title: "Selected Hosts", value: "hosts" as const },
      ]
      : [
        { title: `Selected Hosts (${carriedHosts.join(", ")})`, value: "hosts" as const },
        { title: "Whole installations", value: "whole" as const },
      ],
  );
  if (modeAnswer.kind === "cancelled") {
    writeHumanDocument(request.stderr, uninstallPickerNoopDocument("cancelled"), stderrContext);
    recording.recordNothing("the removal mode was cancelled");
    return { exitCode: 1 };
  }
  const hostMode = modeAnswer.value === "hosts";

  // Host removal offers the union of the picked Projects' bound Hosts in
  // catalog order; carried Hosts stay pre-selected. A Project with no host
  // intersection drops below — the explicit `--host` rule — while the mode
  // stays visible per Project in the review.
  let pickedHosts: readonly InteractiveHost[] | undefined;
  if (hostMode) {
    const union = SUPPORTED_HOSTS.filter((host) =>
      picked.some((entry) => (entry.hosts as readonly string[]).includes(host)));
    const hostsAnswer = await createSearchableMultiSelectPrompt(promptOptions)(
      UNINSTALL_HOSTS_QUESTION,
      union.map((host) => ({
        title: host,
        value: host as InteractiveHost,
        ...(carriedHosts !== undefined &&
          (carriedHosts as readonly string[]).includes(host)
          ? { selected: true as const }
          : {}),
      })),
    );
    if (hostsAnswer.kind === "cancelled") {
      writeHumanDocument(request.stderr, uninstallPickerNoopDocument("cancelled"), stderrContext);
      recording.recordNothing("the Host choice was cancelled");
      return { exitCode: 1 };
    }
    if (hostsAnswer.values.length === 0) {
      writeHumanDocument(
        request.stderr,
        uninstallPickerNoopDocument("empty-hosts"),
        stderrContext,
      );
      recording.recordNothing("no Host was selected");
      return { exitCode: 1 };
    }
    pickedHosts = [...new Set(hostsAnswer.values)];
  }
  // Total from here: whole mode narrows nothing, while Host mode always
  // carries a non-empty selection (its cancel/empty paths return above).
  // Fail closed with a diagnostic — before any write — rather than crash
  // if that ever stops holding.
  const narrowingHosts: readonly InteractiveHost[] = pickedHosts ?? [];
  if (hostMode && narrowingHosts.length === 0) {
    writeHumanDocument(
      request.stderr,
      errorDiagnosticDocument(new Error("interactive uninstall Host mode left no Host selection")),
      stderrContext,
    );
    recording.recordNothing("the interactive Host mode resolved no Host selection");
    return { exitCode: 1 };
  }

  // Resolve the picked scope without writing: a whole preview per picked
  // Project (a vanished binding reports truthfully instead of removing
  // around it), narrowed per Project in Host mode. The review below shows
  // the complete picked scope — every selected Project with its mode —
  // before any confirmation.
  const targets: InteractiveUninstallTarget[] = [];
  for (const entry of picked) {
    let whole: UninstallPreview;
    try {
      whole = await previewUninstall(request.home, { project: entry.project });
    } catch (error) {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(
          error,
          error instanceof ProjectTargetError ? { usage: uninstallCommandSyntax } : undefined,
        ),
        stderrContext,
      );
      recording.recordNothing("the picked Project could not be re-resolved");
      return { exitCode: 1 };
    }
    const wholeEntry = whole.projects.find((candidate) => candidate.project === entry.project);
    const fleetEntry = fleetByProject.get(entry.project);
    if (wholeEntry === undefined ||
      fleetEntry === undefined ||
      interactiveFleetScopeKey(wholeEntry) !== interactiveFleetScopeKey(fleetEntry)) {
      // The binding vanished or changed between the picker inventory and
      // this review: fail
      // closed before any review or write. The retry preserves the picked
      // Host narrowing (PROD-2) and omits `--auto-confirm` (RE-1), so
      // re-running reviews the current scope instead of widening it.
      recording.recordNothing("the picked scope changed before the review");
      writeInteractiveScopeChanged(request, stderrContext, parsed, [], picked.map((scope) => ({
        preview: {
          project: scope.project,
          ...(scope.canonicalProject === undefined
            ? {}
            : { canonicalProject: scope.canonicalProject }),
          profile: scope.profile,
          hosts: [...scope.hosts],
          ...(hostMode ? { removeHosts: [...narrowingHosts] } : {}),
          missing: false,
        },
      })), recording);
      return { exitCode: 1 };
    }
    if (!hostMode) {
      targets.push({ preview: wholeEntry });
      continue;
    }
    let narrowed: UninstallPreview;
    try {
      narrowed = await previewUninstall(request.home, {
        project: entry.project,
        hosts: [...narrowingHosts],
      });
    } catch (error) {
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      recording.recordNothing("the picked Host scope could not be re-resolved");
      return { exitCode: 1 };
    }
    const narrowedEntry = narrowed.projects.find(
      (candidate) => candidate.project === entry.project,
    );
    // A Project with no host intersection drops — the explicit `--host`
    // rule — while picked Projects with one keep their narrowed scope.
    if (narrowedEntry !== undefined) targets.push({ preview: narrowedEntry });
  }
  if (targets.length === 0) {
    // Reachable only in Host mode when no picked Project binds a picked
    // Host (whole mode resolves every pick or fails closed above, and an
    // empty Host selection is refused above): report no match with no
    // writes, never broaden. Via the picker this needs a concurrent
    // rebinding between the Host pick and this resolution, since picks
    // come from the offered bound-Host union.
    if (!hostMode || narrowingHosts.length === 0) {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(new Error("interactive uninstall resolved no removal scope")),
        stderrContext,
      );
      recording.recordNothing("the picked scope resolved no removal");
      return { exitCode: 1 };
    }
    const description = `the selected scope for Hosts '${narrowingHosts.join(", ")}'`;
    writeHumanDocument(request.stderr, uninstallNoMatchDocument(description), stderrContext);
    recording.recordNothing("no picked Project binds the selected Hosts");
    return { exitCode: 1 };
  }
  const reviewed: UninstallPreview = { projects: targets.map((target) => target.preview) };

  const fleetSnapshot = fleet.projects.map(interactiveFleetScopeKey).sort();
  // Expected fleet keys evolve as the batch commits: a completed whole
  // removal drops its binding, a completed partial removal narrows its
  // Hosts. Any other movement — an unrelated binding added, removed, or
  // rebound — fails the remainder closed, so unshown scope is never
  // removed. Commit-time skips change nothing, so the expectation stands.
  let expectedFleetKeys = fleetSnapshot;
  const fleetMoved = async (): Promise<boolean> => {
    const fresh = await previewUninstall(request.home, { all: true });
    const keys = fresh.projects.map(interactiveFleetScopeKey).sort();
    return keys.length !== expectedFleetKeys.length ||
      keys.some((key, index) => key !== expectedFleetKeys[index]);
  };
  const forgetCompletedFleetKey = (target: InteractiveUninstallTarget): void => {
    const before = interactiveFleetScopeKey({
      ...(target.preview.canonicalProject === undefined
        ? {}
        : { canonicalProject: target.preview.canonicalProject }),
      project: target.preview.project,
      profile: target.preview.profile,
      hosts: [...target.preview.hosts],
    });
    // Keys are unique per bound path in practice; remove one occurrence so
    // a hypothetical duplicate spelling keeps its surviving twin expected.
    const at = expectedFleetKeys.indexOf(before);
    expectedFleetKeys = at === -1
      ? expectedFleetKeys
      : [...expectedFleetKeys.slice(0, at), ...expectedFleetKeys.slice(at + 1)];
    if (target.preview.removeHosts !== undefined) {
      // The executor routes a zero-survivor Host removal through the
      // complete-uninstall path (isPartialWorkItem): the binding drops,
      // so no narrowed key is expected — re-adding one would phantom-trip
      // the next guard. Single home for the rule: ask the survivor set
      // the executor itself derives (INT-1).
      const survivors = survivingHostsForRemoval(target.preview.hosts, target.preview.removeHosts);
      if (survivors.length > 0) {
        expectedFleetKeys = [...expectedFleetKeys, interactiveFleetScopeKey({
          ...(target.preview.canonicalProject === undefined
            ? {}
            : { canonicalProject: target.preview.canonicalProject }),
          project: target.preview.project,
          profile: target.preview.profile,
          hosts: [...survivors],
        })].sort();
      }
    }
  };

  if (!parsed.autoConfirm) {
    // The general confirmation answers no missing choice and no
    // changed-file scope (DEC-004/DEC-005); declining leaves everything
    // untouched with neutral styling.
    const prompt = createTextPrompt(promptOptions);
    writeHumanDocument(
      request.stdout,
      uninstallConfirmationDocument(reviewed),
      stdoutContext,
    );
    const answer = await prompt(UNINSTALL_CONFIRMATION_QUESTION);
    const normalized = answer.kind === "cancelled" ? "" : answer.value.trim().toLowerCase();
    if (answer.kind === "cancelled" || (normalized !== "y" && normalized !== "yes")) {
      const reason = answer.kind === "cancelled"
        ? "cancelled" as const
        : normalized === "" ? "default" as const : "declined" as const;
      const happened = reason === "cancelled"
        ? ["uninstall was cancelled before any write"]
        : reason === "default"
          ? ["uninstall kept the current state; nothing was written (default answer no)"]
          : ["uninstall kept the current state; nothing was written (you answered no)"];
      recording.collect(uninstallCancelledRecording(
        reason === "cancelled" ? "cancelled" : "declined",
        scope,
        unattemptedProjectsFromPreview(targets.map((target) => target.preview)),
      ));
      writeLifecycleReport(
        request.stderr,
        uninstallInteractiveCommandsDocument({
          happened,
          why: [["No Project or setting was changed."]],
          intro: "To proceed without asking, run (one command per Project):",
          commands: interactiveRemainingCommands(targets, {
            includeAutoConfirm: true,
            removeChanged: parsed.removeChanged,
            replaceChanged: parsed.replaceChanged,
          }),
          severity: "info",
        }),
        stderrContext,
        recording,
      );
      return { exitCode: 1 };
    }
  } else {
    // `--auto-confirm` answers the general confirmation only, never the
    // picks above — but the reviewed scope is still shown, so the run
    // stays reviewable without a second answer.
    writeHumanDocument(
      request.stdout,
      uninstallConfirmationDocument(reviewed),
      stdoutContext,
    );
  }

  // Changed-file consent consumes the one shared loop (DEC-005, US-020),
  // across the sequential batch: the review above authorized the scope,
  // this gate authorizes only actual planned discards.
  const confirmer = createChangedOutputConfirmer({
    input: request.input,
    output: request.stdout,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    json: false,
    replaceChanged: parsed.replaceChanged,
    removeChanged: parsed.removeChanged,
    selection: { kind: "all" },
  });
  recording.collectReviewsFrom(() => confirmer.reviewedChangedOutputs());
  const completed: UninstallCompletedProject[] = [];
  const skipped: UninstallSkippedProject[] = [];
  const warnings: string[] = [];
  for (const [index, target] of targets.entries()) {
    const remaining = targets.slice(index);
    // A batch guard, scope move, or late authorization refusal stops the
    // remaining picks; work earlier picks already committed stays retained
    // evidence (US-012: partial outcomes), while a stop with nothing
    // committed remains a refusal that records nothing.
    const collectCommittedStop = (failure: string): void => {
      if (completed.length === 0) {
        recording.recordNothing(failure);
        return;
      }
      recording.collect({
        outcome: operationOutcome({
          committed: completed.length,
          outstanding: remaining.length,
          failed: true,
          noWork: false,
        }),
        scope,
        projects: [
          ...uninstallProjects({ completed, skipped, unattempted: [], warnings: [] }),
          ...unattemptedProjectsFromPreview(remaining.map((entry) => entry.preview)),
        ],
        failure,
      });
    };
    const remainingCommands = (options: {
      readonly includeAutoConfirm: boolean;
      readonly removeChanged: boolean;
      readonly replaceChanged: boolean;
    }): readonly (readonly CommandArg[])[] =>
      interactiveRemainingCommands(remaining, options);
    // The fleet re-resolution fails the remaining batch closed when a
    // concurrent change widened or narrowed it (INT-2 for picks):
    // unshown scope is never removed.
    let fleetChanged: boolean;
    try {
      fleetChanged = await fleetMoved();
    } catch (error) {
      // The guard itself failed (e.g. Local Configuration unreadable
      // mid-batch): fail closed with the same completed / unattempted /
      // per-Project retry report as every other mid-batch failure mode,
      // instead of escaping without one (INT-2). The recording decision
      // precedes the report so its retained-entry route follows it.
      collectCommittedStop(formatError(error));
      writeLifecycleReport(
        request.stderr,
        uninstallInteractiveCommandsDocument({
          happened: [formatError(error)],
          why: [[
            completed.length === 0
              ? "No Project or setting was changed."
              : `Completed Projects stay completed: ${completed.map((entry) => entry.project).join(", ")}.`,
            " The remaining picked Projects were not attempted.",
          ]],
          intro: "After resolving the cause, retry the same scope (one command per Project):",
          commands: remainingCommands({
            includeAutoConfirm: true,
            removeChanged: parsed.removeChanged,
            replaceChanged: parsed.replaceChanged,
          }),
        }),
        stderrContext,
        recording,
      );
      return { exitCode: 1 };
    }
    if (fleetChanged) {
      collectCommittedStop("the selected scope changed while removing the picked Projects");
      writeInteractiveScopeChanged(request, stderrContext, parsed, completed, remaining, recording);
      return { exitCode: 1 };
    }
    try {
      const result = await executeUninstall(request.home, {
        project: target.preview.project,
        ...(target.preview.removeHosts === undefined
          ? {}
          : { hosts: [...target.preview.removeHosts] }),
        cwd,
        // The executed scope is the reviewed scope: re-resolution inside
        // fails closed when a concurrent change moved it (INT-2).
        confirmedPreview: { projects: [target.preview] },
        ...(parsed.removeChanged ? { removeChanged: true as const } : {}),
        ...(parsed.replaceChanged ? { replaceChanged: true as const } : {}),
        ...(confirmer.confirm === undefined
          ? {}
          : { confirmChangedOutputReplacement: confirmer.confirm }),
      });
      if (result.failed !== undefined) {
        const failed: UninstallFailedProject = result.failed;
        const unattempted: UninstallUnattemptedProject[] = [
          ...targets.slice(index + 1).map((entry) => ({
            ...(entry.preview.canonicalProject === undefined
              ? {}
              : { canonicalProject: entry.preview.canonicalProject }),
            project: entry.preview.project,
            profile: entry.preview.profile,
          })),
        ];
        const restoration = failed.restoreError !== undefined
          ? `Previous selection/output restore failed: ${failed.restoreError}`
          : failed.selectionRestored
            ? "The previous selection and output were restored where possible."
            : "The previous selection could not be restored.";
        recording.collect(uninstallRecording({
          completed: [...completed, ...result.completed],
          skipped: [...skipped, ...result.skipped],
          failed,
          unattempted,
          warnings: [],
        }, scope));
        writeLifecycleReport(
          request.stderr,
          uninstallInteractiveCommandsDocument({
            happened: [`uninstall stopped at ${failed.project}: ${failed.detail}`],
            why: [[
              completed.length === 0 && result.completed.length === 0
                ? "No Project was completed before the failure."
                : `Completed Projects stay completed: ${[...completed, ...result.completed].map((entry) => entry.project).join(", ")}.`,
              ` ${restoration}`,
              unattempted.length === 0
                ? ""
                : ` Unattempted Projects remain untouched: ${unattempted.map((entry) => entry.project).join(", ")}.`,
            ]],
            intro: "After resolving the cause, retry the same scope (one command per Project):",
            commands: [
              interactiveEquivalentCommand({
                project: failed.project,
                ...(failed.canonicalProject === undefined
                  ? {}
                  : { canonicalProject: failed.canonicalProject }),
                ...(target.preview.removeHosts === undefined
                  ? {}
                  : { removeHosts: [...target.preview.removeHosts] }),
              }, {
                includeAutoConfirm: true,
                removeChanged: parsed.removeChanged,
                replaceChanged: parsed.replaceChanged,
              }),
              ...remainingCommands({
                includeAutoConfirm: true,
                removeChanged: parsed.removeChanged,
                replaceChanged: parsed.replaceChanged,
              }).slice(1),
            ],
          }),
          stderrContext,
          recording,
        );
        return { exitCode: 1 };
      }
      completed.push(...result.completed);
      skipped.push(...result.skipped);
      warnings.push(...result.warnings);
      // The committed removal moved the fleet exactly as reviewed:
      // expect it, so the next guard trips only on concurrent movement.
      // (A commit-time skip changes nothing, so the expectation stands.)
      if (result.completed.length > 0) forgetCompletedFleetKey(target);
      continue;
    } catch (error) {
      if (error instanceof UninstallScopeChangedError) {
        collectCommittedStop(formatError(error));
        writeInteractiveScopeChanged(request, stderrContext, parsed, completed, remaining, recording);
        return { exitCode: 1 };
      }
      if (error instanceof ApplyDeclinedError) {
        const declined = error.reason === "cancelled"
          ? "cancelled" as const
          : confirmer.declinedAnswer();
        recording.collect(uninstallCancelledRecording(
          error.reason === "cancelled" ? "cancelled" : "declined",
          scope,
          [
            ...uninstallProjects({ completed, skipped, unattempted: [], warnings: [] }),
            ...unattemptedProjectsFromPreview(targets.slice(index).map((entry) => entry.preview)),
          ],
        ));
        writeLifecycleReport(
          request.stderr,
          uninstallInteractiveCommandsDocument({
            happened: [declined === "cancelled"
              ? "uninstall was cancelled before any write"
              : declined === "default"
                ? "uninstall kept the current state; nothing was written (default answer no)"
                : "uninstall kept the current state; nothing was written (you answered no)"],
            why: [[completed.length === 0
              ? "No Project or setting was changed."
              : `Completed Projects stay completed: ${completed.map((entry) => entry.project).join(", ")}. Remaining Projects were not attempted.`]],
            intro: "To proceed without asking, run (one command per Project):",
            commands: remainingCommands({
              includeAutoConfirm: true,
              removeChanged: parsed.removeChanged,
              replaceChanged: parsed.replaceChanged,
            }),
            severity: "info",
          }),
          stderrContext,
          recording,
        );
        return { exitCode: 1 };
      }
      if (error instanceof ApplyConsentRequiredError) {
        collectCommittedStop(formatError(error));
        writeLifecycleReport(
          request.stderr,
          uninstallInteractiveCommandsDocument({
            happened: [formatError(error)],
            why: [[completed.length === 0
              ? "No Project or setting was changed."
              : `Completed Projects stay completed: ${completed.map((entry) => entry.project).join(", ")}. Remaining Projects were not attempted.`]],
            intro: "To authorize the planned change, run (one command per Project):",
            commands: remainingCommands({
              includeAutoConfirm: true,
              removeChanged: parsed.removeChanged || error.requiredOperations.includes("remove"),
              replaceChanged: parsed.replaceChanged ||
                error.requiredOperations.includes("replace"),
            }),
          }),
          stderrContext,
          recording,
        );
        return { exitCode: 1 };
      }
      if (error instanceof ApplyReviewStaleError) {
        collectCommittedStop(formatError(error));
        writeLifecycleReport(
          request.stderr,
          uninstallInteractiveCommandsDocument({
            happened: [formatError(error)],
            why: [[completed.length === 0
              ? "No Project or setting was changed."
              : `Completed Projects stay completed: ${completed.map((entry) => entry.project).join(", ")}. Remaining Projects were not attempted.`]],
            intro: "Re-run to review the current change (one command per Project):",
            commands: remainingCommands({
              includeAutoConfirm: true,
              removeChanged: parsed.removeChanged,
              replaceChanged: parsed.replaceChanged,
            }),
          }),
          stderrContext,
          recording,
        );
        return { exitCode: 1 };
      }
      collectCommittedStop(formatError(error));
      writeLifecycleReport(request.stderr, errorDiagnosticDocument(error), stderrContext, recording);
      return { exitCode: 1 };
    }
  }

  const aggregate: UninstallApplicationResult = {
    completed,
    skipped,
    unattempted: [],
    warnings: [...new Set(warnings)].sort(),
  };
  recording.collect(uninstallRecording(aggregate, scope));
  // A picked run always leaves its executable repeat (US-006 parity with
  // the guided-install echo): the picked scope with the general
  // confirmation answered, carrying consent the flow actually authorized.
  const acceptedScope = confirmer.promptedAcceptedScope();
  writeLifecycleReport(
    request.stdout,
    [
      ...uninstallReceiptDocument(aggregate),
      ...uninstallInteractiveEquivalentDocument(
        interactiveRemainingCommands(targets, {
          includeAutoConfirm: true,
          removeChanged: parsed.removeChanged || acceptedScope?.remove === true,
          replaceChanged: parsed.replaceChanged || acceptedScope?.replace === true,
        }),
      ),
    ],
    stdoutContext,
    recording,
  );
  // Exit 2 when known Blockers skipped healthy work (the lifecycle
  // blocker matrix); exit 0 when every picked Project completed.
  return { exitCode: skipped.length > 0 ? 2 : 0 };
}

export async function runUninstallCommand(
  request: UninstallCommandRequest,
): Promise<UninstallCommandOutcome> {
  // One recording boundary per invocation (US-012, DEC-008): every terminal
  // branch below collects this run's one outcome; the wrapper publishes it.
  const startedAt = Date.now();
  const recording = beginLifecycleOperationRecording();
  const outcome = await runUninstallCommandWithRecording(request, recording);
  await finishLifecycleOperationRecording({
    recording,
    home: request.home,
    command: "uninstall",
    startedAt,
    finishedAt: Date.now(),
    stderr: request.stderr,
  });
  return outcome;
}

async function runUninstallCommandWithRecording(
  request: UninstallCommandRequest,
  recording: LifecycleOperationRecording,
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
    recording.recordNothing("the uninstall arguments were rejected");
    return { exitCode: 1 };
  }

  const cwd = request.cwd ?? process.cwd();
  const interactive = isInteractiveInput(request.input);
  // A `--host` filter narrows removal within a scope but never provides
  // one (DEC-003): Host-only non-interactive use requires an explicit
  // Project scope, while Host-only interactive use routes into Project
  // selection with its Hosts proposed (#499). A `--profile` selector
  // provides scope and keeps the explicit flow untouched. The refusal below
  // carries the requested Hosts through fullySpecifiedUninstallArguments.
  const hasScope = parsed.here || parsed.all || parsed.project !== undefined ||
    parsed.profile !== undefined;
  if (!hasScope) {
    if (interactive && !parsed.json) {
      // Bare or Host-only interactive input collects its scope through
      // the searchable Project picker (#499, US-003/US-004/US-005):
      // nothing is pre-selected, and `--auto-confirm` answers only the
      // later general confirmation, never the picks (DEC-004).
      // Non-interactive and machine-JSON input keep the refusal below —
      // missing choices stay missing there.
      return runInteractiveUninstall(request, parsed, cwd, stderrContext, recording);
    }
    // Missing choices stay missing (DEC-004/US-006): an absent scope never
    // implies all Projects, on any non-interactive input stream; this
    // refusal names the explicit fleet equivalent.
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
    recording.recordNothing("uninstall needs an explicit scope");
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
      ...(parsed.hosts === undefined ? {} : { hosts: parsed.hosts }),
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
    recording.recordNothing("the uninstall preview refused before any write");
    return { exitCode: 1 };
  }

  if (preview.projects.length === 0) {
    // Filters intersect, never broaden: a zero match reports truthfully with
    // no writes rather than failing as a target error.
    const hostFilter = parsed.hosts === undefined
      ? ""
      : ` Host${parsed.hosts.length === 1 ? "" : "s"} '${parsed.hosts.join(", ")}'`;
    const description = parsed.profile !== undefined
      ? `Profile '${parsed.profile}'${parsed.all || parsed.here || parsed.project !== undefined ? " within the selected scope" : ""}${hostFilter}`
      : hostFilter === ""
        ? "the selected scope"
        : `the selected scope for Host${parsed.hosts!.length === 1 ? "" : "s"} '${parsed.hosts!.join(", ")}'`;
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
    recording.recordNothing("no installation matched the selected scope");
    return { exitCode: 1 };
  }

  const stdoutContext: TerminalPresentationContext = terminalPresentationContext(request.stdout);
  const recordingScope = uninstallRecordingScope(parsed);
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
    recording.recordNothing("uninstall needs explicit non-interactive confirmation");
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
      recording.collect(uninstallCancelledRecording(
        "cancelled",
        recordingScope,
        unattemptedProjectsFromPreview(preview.projects),
      ));
      writeLifecycleReport(
        request.stderr,
        uninstallDeclinedDocument("cancelled", fullySpecifiedUninstallArguments(parsed, preview)),
        stderrContext,
        recording,
      );
      return { exitCode: 1 };
    }
    const normalized = answer.value.trim().toLowerCase();
    if (normalized !== "y" && normalized !== "yes") {
      recording.collect(uninstallCancelledRecording(
        "declined",
        recordingScope,
        unattemptedProjectsFromPreview(preview.projects),
      ));
      writeLifecycleReport(
        request.stderr,
        uninstallDeclinedDocument(
          normalized === "" ? "default" : "declined",
          fullySpecifiedUninstallArguments(parsed, preview),
        ),
        stderrContext,
        recording,
      );
      return { exitCode: 1 };
    }
  }

  // Changed-file consent consumes the one shared loop (DEC-005, US-020).
  // Whole-removal performs no replacements, so only deletion needs
  // authorization there; a `--host` partial removal may additionally
  // rewrite retained shared output for the survivors, which
  // `--replace-changed` authorizes (conditional on the actual plan: clean
  // portions need no flag — the gate demands only planned discards).
  const confirmer = createChangedOutputConfirmer({
    input: request.input,
    output: request.stdout,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    json: parsed.json,
    replaceChanged: parsed.replaceChanged,
    removeChanged: parsed.removeChanged,
    selection: uninstallScopeSelection(parsed, cwd),
  });
  const answering = (
    prompted: ChangedFileAnsweringScope | undefined,
  ): ChangedFileAnsweringScope =>
    answeringScope({ replaceChanged: parsed.replaceChanged, removeChanged: parsed.removeChanged }, prompted, confirmer.requestedScope());
  // The finish boundary reads the reviews the gate performed, so every
  // terminal outcome of this invocation carries the same reviewed identities.
  recording.collectReviewsFrom(() => confirmer.reviewedChangedOutputs());
  try {
    const result = await executeUninstall(request.home, {
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(parsed.here ? { here: true as const } : {}),
      ...(parsed.all ? { all: true as const } : {}),
      ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
      ...(parsed.hosts === undefined ? {} : { hosts: parsed.hosts }),
      cwd,
      // The executed scope is the reviewed scope: re-resolution inside
      // fails closed when a concurrent change widens or narrows it (INT-2).
      confirmedPreview: preview,
      ...(parsed.removeChanged ? { removeChanged: true as const } : {}),
      ...(parsed.replaceChanged ? { replaceChanged: true as const } : {}),
      ...(confirmer.confirm === undefined ? {} : { confirmChangedOutputReplacement: confirmer.confirm }),
    });
    if (result.failed !== undefined) {
      recording.collect(uninstallRecording(result, recordingScope));
      const retry = fullySpecifiedUninstallArguments(parsed, preview);
      if (parsed.json) {
        request.stdout.write(formatUninstallJson(result));
      } else {
        writeLifecycleReport(
          request.stderr,
          uninstallExecutionFailureDocument({
            failed: result.failed,
            completed: [...result.completed],
            unattempted: [...result.unattempted],
            retryArguments: retry,
          }),
          stderrContext,
          recording,
        );
      }
      return { exitCode: 1 };
    }
    recording.collect(uninstallRecording(result, recordingScope));
    if (parsed.json) {
      request.stdout.write(formatUninstallJson(result));
    } else {
      const acceptedScope = confirmer.promptedAcceptedScope();
      writeLifecycleReport(
        request.stdout,
        [
          ...uninstallReceiptDocument(result),
          ...(acceptedScope === undefined
            ? []
            : uninstallReplacementCommandDocument(
                fullySpecifiedUninstallArguments(
                  {
                    ...parsed,
                    removeChanged: parsed.removeChanged || acceptedScope.remove === true,
                    replaceChanged: parsed.replaceChanged || acceptedScope.replace === true,
                  },
                  preview,
                ),
              )),
        ],
        stdoutContext,
        recording,
      );
    }
    // Exit 2 when known Blockers skipped healthy work (the lifecycle
    // blocker matrix); exit 0 when every selected Project completed.
    return { exitCode: result.skipped.length > 0 ? 2 : 0 };
  } catch (error) {
    if (error instanceof UninstallScopeChangedError) {
      recording.recordNothing("the reviewed scope changed before any write");
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
      recording.collect(uninstallCancelledRecording(
        error.reason === "cancelled" ? "cancelled" : "declined",
        recordingScope,
        unattemptedProjectsFromPreview(preview.projects),
      ));
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
        writeLifecycleReport(
          request.stderr,
          applyReplacementDeclinedDocument(
            error.reason === "cancelled" ? "cancelled" : confirmer.declinedAnswer(),
            fullySpecifiedUninstallArguments(parsed, preview),
            scope,
            "uninstall",
          ),
          stderrContext,
          recording,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyConsentRequiredError) {
      // A late stop that committed earlier Projects keeps that partial
      // evidence; a pre-write refusal records nothing.
      recordProjectedOutcome(
        recording,
        lateAuthorizationStopRecording(error, recordingScope, formatError(error)),
        "uninstall refused before any write",
      );
      // The remedy stays runnable: precisely the missing authorizations
      // named by the gate are added (a changed deletion names only
      // `--remove-changed`, a changed survivor-rewrite only
      // `--replace-changed`), so re-running answers the actual plan with
      // one actionable command. The refusal carries the partial outcome
      // for machine consumers (PROD-3); a pre-write refusal carries no
      // pending evidence, so the whole reviewed scope reports as
      // unattempted — nothing was attempted.
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
        writeLifecycleReport(
          request.stderr,
          applyConsentRequiredDocument(
            error,
            fullySpecifiedUninstallArguments(
              {
                ...parsed,
                removeChanged: parsed.removeChanged ||
                  error.requiredOperations.includes("remove"),
                replaceChanged: parsed.replaceChanged ||
                  error.requiredOperations.includes("replace"),
              },
              preview,
            ),
            "uninstall",
          ),
          stderrContext,
          recording,
        );
      }
      return { exitCode: 1 };
    }
    if (error instanceof ApplyReviewStaleError) {
      recordProjectedOutcome(
        recording,
        lateAuthorizationStopRecording(error, recordingScope, formatError(error)),
        "uninstall refused before any write",
      );
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
        writeLifecycleReport(
          request.stderr,
          applyReviewStaleDocument(
            error,
            fullySpecifiedUninstallArguments(parsed, preview),
            "uninstall",
          ),
          stderrContext,
          recording,
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
    recording.recordNothing("uninstall refused before any lifecycle write");
    return { exitCode: 1 };
  }
}
