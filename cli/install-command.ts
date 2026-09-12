/**
 * The `install` command (spec #491 US-001/US-006/US-007/US-008, DEC-001/
 * DEC-002/DEC-004–DEC-006): one action records the Project's desired
 * selection and installs/verifies the generated output. It replaces public
 * `bind` with no compatibility shim (pre-1.0 breaking-change policy).
 *
 * An interactive human invocation with missing Profile/Hosts collects only
 * those choices through searchable pickers (#495, US-001/US-005): the target
 * is named first, supplied choices skip their picker, and the picked values
 * flow into the same explicit operation below. The general confirmation
 * (DEC-004) fires on interactive input unless `--auto-confirm` answers it;
 * non-interactive invocations without that flag refuse before any write.
 * Changed-file consent (DEC-005) consumes the shared #493 contract and is
 * never answered by `--auto-confirm`.
 */
import type { Readable, Writable } from "node:stream";

import {
  writeHumanDocument,
  type PresentationDocument,
  type PresentationNode,
} from "./presentation-document.js";
import { errorDiagnosticDocument } from "./error-wording.js";
import { COMMANDS } from "./command-help.js";
import {
  applyConsentRequiredDocument,
  applyReplacementDeclinedDocument,
  applyReviewStaleDocument,
  installBlockedDocument,
  installConfirmationDocument,
  installConfirmationRequiredDocument,
  installDeclinedDocument,
  installDetectedHostsDocument,
  installExecutionFailureDocument,
  installRecoveryAddendum,
  installReplacementCommandDocument,
  installTargetDocument,
  installVerificationFailureDocument,
  installWarningNodes,
  formatApplyExecutionFailureJson,
  formatApplyVerificationFailureJson,
  formatInstallJson,
  formatLifecycleJson,
  formatLifecycleToolErrorJson,
  lifecycleExitCode,
  INSTALL_CONFIRMATION_QUESTION,
  type ChangedFileAnsweringScope,
  type InstallRecoveryEvidence,
} from "./presentation.js";
import {
  answeringScope,
  createChangedOutputConfirmer,
  type ChangedOutputConfirmer,
} from "./changed-output-confirm.js";
import { installReceiptDocument, type InstallReceiptInput } from "./receipts.js";
import {
  terminalPresentationContext,
  type TerminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";
import { createTextPrompt, createSearchableMultiSelectPrompt, createSearchableSelectPrompt, isInteractiveInput, type PromptClock } from "./prompts.js";
import {
  beginLifecycleOperationRecording,
  finishLifecycleOperationRecording,
  installCancelledRecording,
  installFailureRecording,
  installSuccessRecording,
  recordProjectedOutcome,
  type LifecycleOperationRecording,
} from "./operation-recording.js";
import { writeLifecycleReport } from "./operation-history-presentation.js";
import { detectInstalledHosts, SUPPORTED_HOSTS } from "../adapters/registry.js";
import {
  executeInstall,
  previewInstall,
  resolveInstallTarget,
  InstallExecutionError,
  type InstallApplicationResult,
  type InstallTarget,
} from "../installer/install-application.js";
import {
  ApplyBlockedError,
  ApplyConsentRequiredError,
  ApplyDeclinedError,
  ApplyExecutionError,
  ApplyReviewStaleError,
  ApplyVerificationError,
  type ProjectIdentity,
} from "../installer/reconcile.js";
import { formatError } from "./error-wording.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { listProfiles } from "../installer/inventory.js";
import type { CommandArg } from "./inline-content.js";

const arg = (value: string): CommandArg => ({ kind: "text", value });

export interface ParsedInstallArguments {
  readonly profile?: string;
  readonly project?: string;
  readonly projectFlag: boolean;
  readonly hosts?: readonly string[];
  readonly autoConfirm: boolean;
  readonly replaceChanged: boolean;
  readonly removeChanged: boolean;
  readonly json: boolean;
}

/**
 * Parse `install [profile] [project] --host <host> ... [--project <path>]
 * [--auto-confirm] [--replace-changed] [--remove-changed] [--json]`.
 * Missing Profile/Hosts are reported as absent, not errors: an interactive
 * human invocation collects them through searchable pickers (#495), while
 * non-interactive and machine-JSON invocations refuse them before any write.
 */
export function parseInstallArguments(
  arguments_: readonly string[],
): ParsedInstallArguments {
  let profile: string | undefined;
  let project: string | undefined;
  let projectFlag = false;
  const hosts: string[] = [];
  let autoConfirm = false;
  let replaceChanged = false;
  let removeChanged = false;
  let json = false;
  const positionals: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--host") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("install --host requires an Agent Host name");
      }
      hosts.push(value);
      index += 1;
      continue;
    }
    if (argument === "--project") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("install --project requires a Project path");
      }
      project = value;
      projectFlag = true;
      index += 1;
      continue;
    }
    if (argument === "--auto-confirm") {
      autoConfirm = true;
      continue;
    }
    if (argument === "--replace-changed") {
      replaceChanged = true;
      continue;
    }
    if (argument === "--remove-changed") {
      removeChanged = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    throw new Error(`install does not accept argument '${argument}'`);
  }
  if (positionals.length > 0) {
    profile = positionalArgument("install", "a Profile", positionals[0]!);
  }
  if (positionals.length > 1) {
    if (projectFlag) {
      throw new Error("install --project cannot be combined with a Project path");
    }
    project = positionalArgument("install", "a project path", positionals[1]!);
  }
  if (positionals.length > 2) {
    throw new Error("install accepts at most one Project path");
  }
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(project === undefined ? {} : { project }),
    projectFlag,
    ...(hosts.length === 0 ? {} : { hosts }),
    autoConfirm,
    replaceChanged,
    removeChanged,
    json,
  };
}

function positionalArgument(command: string, description: string, value: string): string {
  if (value.startsWith("-")) {
    throw new Error(`${command} does not accept flag '${value}' as ${description}`);
  }
  return value;
}

export interface InstallCommandRequest {
  readonly home: string;
  /** The arguments after the command token. */
  readonly arguments: readonly string[];
  /** Injectable output stream for the receipt and the prompt questions. */
  readonly stdout: Writable & TerminalStream;
  /** Injectable diagnostic stream. */
  readonly stderr: Writable & TerminalStream;
  /** Injectable prompt input stream; TTY evidence is read here (DEC-035). */
  readonly input: Readable;
  /** Working directory used when the project argument is omitted. */
  readonly cwd?: string;
  /** Environment for advisory Host detection; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: PromptClock;
}

export interface InstallCommandOutcome {
  readonly exitCode: 0 | 1 | 2;
}

/** The one canonical install usage line, read from the command-help table. */
const installCommandSyntax = COMMANDS.find((command) => command.name === "install")!.syntax;

/**
 * The delivered install argument errors, used whenever prompting cannot help
 * (non-interactive and machine-JSON invocations keep missing choices as
 * refusals; interactive humans collect them through pickers instead).
 */
function missingProfileDiagnostic(): PresentationDocument {
  return errorDiagnosticDocument(new Error("install requires a Profile name"), {
    usage: installCommandSyntax,
  });
}

function missingHostsDiagnostic(): PresentationDocument {
  return errorDiagnosticDocument(
    new InstallerToolError({
      kind: "install-host-required",
      supportedHosts: SUPPORTED_HOSTS,
    }),
    { usage: installCommandSyntax },
  );
}

function installArgumentErrorDiagnostic(error: unknown): PresentationDocument {
  return errorDiagnosticDocument(error, { usage: installCommandSyntax });
}

const INSTALL_PROFILE_QUESTION = "Which Profile?";
const INSTALL_HOSTS_QUESTION = "Which Agent Hosts?";

/**
 * Collect the missing Profile/Host choices for one guided install (#495,
 * US-001/US-005, DEC-002): the target is resolved and named before anything
 * is asked, supplied choices skip their picker, and the picked values return
 * with the shared target for the explicit operation. Cancellation or an
 * unanswerable choice writes its diagnostic and resolves undefined with
 * zero lifecycle writes.
 */
async function collectMissingInstallChoices(
  request: InstallCommandRequest,
  parsed: ParsedInstallArguments,
  cwd: string,
  stderrContext: TerminalPresentationContext,
): Promise<{ readonly parsed: ParsedInstallArguments; readonly target: InstallTarget } | undefined> {
  const stdoutContext = terminalPresentationContext(request.stdout);
  let target;
  try {
    target = await resolveInstallTarget(request.home, {
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      cwd,
    });
  } catch (error) {
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
    return undefined;
  }
  writeHumanDocument(request.stdout, installTargetDocument(target), stdoutContext);

  const promptOptions = {
    input: request.input,
    output: request.stdout,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
  };

  let profile = parsed.profile;
  if (profile === undefined) {
    let profiles;
    try {
      profiles = await listProfiles(request.home);
    } catch (error) {
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      return undefined;
    }
    if (profiles.length === 0) {
      writeHumanDocument(
        request.stderr,
        errorDiagnosticDocument(
          new Error("install needs a Profile, but the Workspace has no Profiles yet; create one with apkit new profile"),
        ),
        stderrContext,
      );
      return undefined;
    }
    const answer = await createSearchableSelectPrompt(promptOptions)(
      INSTALL_PROFILE_QUESTION,
      profiles.map((entry) => ({ title: entry.id, value: entry.id })),
    );
    if (answer.kind === "cancelled") {
      writeHumanDocument(
        request.stderr,
        installDeclinedDocument("cancelled", fullySpecifiedInstallArguments(parsed, cwd)),
        stderrContext,
      );
      return undefined;
    }
    profile = answer.value;
  }

  let hosts = parsed.hosts;
  if (hosts === undefined) {
    // Detection is advisory only and is stated once up front, mirroring
    // the initialization receipt; titles stay bare Host identities so
    // filtering matches the Host, never the evidence text. A new
    // installation starts with nothing checked; an existing installation
    // pre-checks its Hosts, so detected Hosts are never silently selected.
    const detected = await detectInstalledHosts({ env: request.env ?? process.env });
    writeHumanDocument(request.stdout, installDetectedHostsDocument(detected), stdoutContext);
    const previousHosts = new Set(target.previous?.hosts ?? []);
    const answer = await createSearchableMultiSelectPrompt(promptOptions)(
      INSTALL_HOSTS_QUESTION,
      SUPPORTED_HOSTS.map((host) => ({
        title: host,
        value: host,
        ...(previousHosts.has(host) ? { selected: true } : {}),
      })),
      { min: 1 },
    );
    if (answer.kind === "cancelled") {
      writeHumanDocument(
        request.stderr,
        installDeclinedDocument(
          "cancelled",
          fullySpecifiedInstallArguments(
            { ...parsed, ...(profile === undefined ? {} : { profile }) },
            cwd,
          ),
        ),
        stderrContext,
      );
      return undefined;
    }
    hosts = [...answer.values];
  }

  if (profile === undefined || hosts === undefined) {
    // Unreachable: each picker above either fills its choice or cancels
    // with a diagnostic. Fail closed instead of smuggling undefined into
    // the explicit operation.
    writeHumanDocument(
      request.stderr,
      errorDiagnosticDocument(new Error("install guided flow left a missing choice unfilled")),
      stderrContext,
    );
    return undefined;
  }
  return { parsed: { ...parsed, profile, hosts: [...hosts] }, target };
}

export async function runInstallCommand(
  request: InstallCommandRequest,
): Promise<InstallCommandOutcome> {
  // One recording boundary per invocation: the body collects the run's one
  // terminal outcome, and this wrapper publishes or reports it exactly once.
  const startedAt = Date.now();
  const recording = beginLifecycleOperationRecording();
  const outcome = await runInstallCommandWithRecording(request, recording);
  await finishLifecycleOperationRecording({
    recording,
    home: request.home,
    command: "install",
    startedAt,
    finishedAt: Date.now(),
    stderr: request.stderr,
  });
  return outcome;
}

async function runInstallCommandWithRecording(
  request: InstallCommandRequest,
  recording: LifecycleOperationRecording,
): Promise<InstallCommandOutcome> {
  const stderrContext = terminalPresentationContext(request.stderr);

  let parsed: ParsedInstallArguments;
  try {
    parsed = parseInstallArguments(request.arguments);
  } catch (error) {
    writeHumanDocument(request.stderr, installArgumentErrorDiagnostic(error), stderrContext);
    recording.recordNothing("the install arguments were rejected");
    return { exitCode: 1 };
  }

  // The effective working directory is captured once at the command boundary:
  // retries and equivalent commands always name the resolved Project, even
  // when the real entrypoint leaves cwd implicit (DEC-006).
  const cwd = request.cwd ?? process.cwd();
  const interactive = isInteractiveInput(request.input);

  // Guided install (#495, US-001/US-005, DEC-002): an interactive human
  // invocation collects only its missing choices through searchable pickers;
  // supplied choices skip their picker and the picked values flow into the
  // same explicit operation below. `--auto-confirm` still answers only the
  // later general confirmation, never a missing choice (DEC-004).
  let guided = false;
  let guidedTarget: InstallTarget | undefined;
  if (
    (parsed.profile === undefined || parsed.hosts === undefined) &&
    interactive &&
    !parsed.json
  ) {
    const completed = await collectMissingInstallChoices(request, parsed, cwd, stderrContext);
    if (completed === undefined) {
      recording.recordNothing("the interactive install choice was cancelled");
      return { exitCode: 1 };
    }
    parsed = completed.parsed;
    guidedTarget = completed.target;
    guided = true;
  }

  if (parsed.profile === undefined) {
    writeHumanDocument(request.stderr, missingProfileDiagnostic(), stderrContext);
    recording.recordNothing("install needs a Profile");
    return { exitCode: 1 };
  }
  if (parsed.hosts === undefined) {
    writeHumanDocument(request.stderr, missingHostsDiagnostic(), stderrContext);
    recording.recordNothing("install needs an Agent Host");
    return { exitCode: 1 };
  }

  if (!parsed.autoConfirm && (!interactive || parsed.json)) {
    writeHumanDocument(
      request.stderr,
      installConfirmationRequiredDocument(
        fullySpecifiedInstallArguments(parsed, cwd),
      ),
      stderrContext,
    );
    recording.recordNothing("install needs explicit non-interactive confirmation");
    return { exitCode: 1 };
  }

  // The preview validates the proposed scope without writing anything; the
  // general confirmation (DEC-004) authorizes exactly this scope. A guided
  // flow passes its already-resolved target so the preview cannot drift
  // from what was named and picked.
  let preview;
  try {
    preview = await previewInstall(request.home, {
      profile: parsed.profile,
      hosts: [...(parsed.hosts ?? [])],
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      cwd,
      ...(guidedTarget === undefined ? {} : { target: guidedTarget }),
    });
  } catch (error) {
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
    recording.recordNothing("the install preview refused before any write");
    return { exitCode: 1 };
  }

  const stdoutContext = terminalPresentationContext(request.stdout);
  if (!parsed.autoConfirm) {
    // Interactive human input only: every other case refused above. The
    // general confirmation answers no missing choice and no changed-file
    // scope (DEC-004/DEC-005); declining leaves everything untouched.
    const prompt = createTextPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    });
    writeHumanDocument(request.stdout, installConfirmationDocument(preview), stdoutContext);
    const answer = await prompt(INSTALL_CONFIRMATION_QUESTION);
    const previewIdentity = {
      canonicalProject: preview.canonicalProject,
      project: preview.authoredProject,
      ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
      hosts: [...(parsed.hosts ?? [])],
    };
    if (answer.kind === "cancelled") {
      recording.collect(installCancelledRecording("cancelled", previewIdentity));
      writeInstallReport(
        request.stderr,
        installDeclinedDocument("cancelled", fullySpecifiedInstallArguments(parsed, cwd, undefined, preview)),
        stderrContext,
        recording,
      );
      return { exitCode: 1 };
    }
    const normalized = answer.value.trim().toLowerCase();
    if (normalized !== "y" && normalized !== "yes") {
      recording.collect(installCancelledRecording("declined", previewIdentity));
      writeInstallReport(
        request.stderr,
        installDeclinedDocument(
          normalized === "" ? "default" : "declined",
          fullySpecifiedInstallArguments(parsed, cwd, undefined, preview),
        ),
        stderrContext,
        recording,
      );
      return { exitCode: 1 };
    }
  }

  const selection = {
    command: "install" as const,
    kind: "project" as const,
    match: "exact" as const,
    target: preview.canonicalProject,
  };
  // Changed-file consent consumes the one shared loop (DEC-005, US-020).
  const confirmer = createChangedOutputConfirmer({
    input: request.input,
    output: request.stdout,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    json: parsed.json,
    replaceChanged: parsed.replaceChanged,
    removeChanged: parsed.removeChanged,
    selection,
  });
  recording.collectReviewsFrom(() => confirmer.reviewedChangedOutputs());
  try {
    const result = await executeInstall(request.home, {
      profile: parsed.profile,
      hosts: [...(parsed.hosts ?? [])],
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      cwd,
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(parsed.replaceChanged ? { replaceChanged: true as const } : {}),
      ...(parsed.removeChanged ? { removeChanged: true as const } : {}),
      ...(confirmer.confirm === undefined ? {} : { confirmChangedOutputReplacement: confirmer.confirm }),
    });
    recording.collect(installSuccessRecording(result));
    const acceptedScope = confirmer.promptedAcceptedScope();
    if (parsed.json) {
      request.stdout.write(formatInstallJson(result.applied));
    } else {
      const reportDocument: PresentationNode[] = [
        ...installReceiptDocument(installReceiptInput(result)),
        // Advisory report warnings (absent Host CLIs and the like) stay
        // visible on the install path that replaces the old bind+update
        // sequence; they never block and never change the outcome.
        ...installWarningNodes(result.applied.resultingState),
      ];
      if (acceptedScope !== undefined) {
        reportDocument.push(...installReplacementCommandDocument(
          fullySpecifiedInstallArguments(parsed, cwd, answeringScope(parsed, acceptedScope, acceptedScope), preview),
        ));
      } else if (guided) {
        // A guided install always leaves its executable fully specified
        // equivalent (US-006): the picked choices plus the general
        // confirmation answer, with consent flags when the flow authorized
        // them. Explicit installs keep the #494 echo contract.
        reportDocument.push(...installReplacementCommandDocument(
          fullySpecifiedInstallArguments(parsed, cwd, undefined, preview),
        ));
      }
      writeInstallReport(request.stdout, reportDocument, stdoutContext, recording);
    }
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof InstallExecutionError) {
      return installReconcileFailureOutcome(
        request,
        parsed,
        error,
        confirmer,
        recording,
        cwd,
        {
          canonicalProject: preview.canonicalProject,
          project: preview.authoredProject,
        },
        stdoutContext,
        stderrContext,
      );
    }
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
    recording.recordNothing("the install refused before any lifecycle write");
    return { exitCode: 1 };
  }
}

/** Write one install terminal human report plus its retained-operation detail
 * route exactly when this run retained an entry (US-011, DEC-007; ADR-0040).
 * The route follows the report's own stream, so a declined or failed install
 * keeps the pointer beside its diagnostic. */
function writeInstallReport(
  stream: Writable & TerminalStream,
  document: PresentationDocument,
  context: TerminalPresentationContext,
  recording: LifecycleOperationRecording,
): void {
  writeLifecycleReport(stream, document, context, recording.collected !== undefined);
}

/** Map one post-publication install failure to its truthful diagnostic. */
function installReconcileFailureOutcome(
  request: InstallCommandRequest,
  parsed: ParsedInstallArguments,
  failure: InstallExecutionError,
  confirmer: ChangedOutputConfirmer,
  recording: LifecycleOperationRecording,
  cwd: string,
  failedProject: ProjectIdentity,
  stdoutContext: TerminalPresentationContext,
  stderrContext: TerminalPresentationContext,
): InstallCommandOutcome {
  const cause = failure.failure.cause;
  // One collected outcome for this run (DEC-008): the projection refuses the
  // fail-closed no-entry causes (missing non-interactive consent or a stale
  // review) and carries the cancelled/blocked/failed evidence otherwise.
  recordProjectedOutcome(
    recording,
    installFailureRecording(failure, {
      canonicalProject: failedProject.canonicalProject,
      project: failedProject.project,
      ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
      hosts: [...(parsed.hosts ?? [])],
    }),
    "the install refused before any generated-output write",
  );
  const answering = (prompted: ChangedFileAnsweringScope | undefined): ChangedFileAnsweringScope =>
    answeringScope(parsed, prompted, confirmer.requestedScope());
  // Every remedy below names the resolved Project, so the printed command
  // shell-quotes it as one token even when the path contains spaces.
  // Selection/output recovery evidence renders consistently in every branch:
  // the dedicated execution/verification diagnostics carry it, and the shared
  // declined/consent/stale/blocked views append the addendum below.
  const recovery: InstallRecoveryEvidence = {
    selectionRestored: failure.failure.selectionRestored,
    ...(failure.failure.restoreFailure === undefined
      ? {}
      : {
        restoreError: failure.failure.restoreFailure instanceof Error
          ? failure.failure.restoreFailure.message
          : String(failure.failure.restoreFailure),
      }),
    outputCommitted: failure.failure.outputCommitted,
    concurrentSelectionChange: failure.failure.concurrentSelectionChange,
  };
  const recoveryJson = {
    selectionRestored: recovery.selectionRestored,
    ...(recovery.restoreError === undefined ? {} : { restoreError: recovery.restoreError }),
    outputCommitted: recovery.outputCommitted,
    concurrentSelectionChange: recovery.concurrentSelectionChange,
  };
  if (cause instanceof ApplyDeclinedError) {
    if (parsed.json) {
      request.stdout.write(formatLifecycleToolErrorJson("install", formatError(cause), recoveryJson));
    } else {
      const scope = answering(confirmer.promptedAcceptedScope());
      writeInstallReport(
        request.stderr,
        [
          ...applyReplacementDeclinedDocument(
            cause.reason === "cancelled" ? "cancelled" : confirmer.declinedAnswer(),
            fullySpecifiedInstallArguments(parsed, cwd, scope, {
              canonicalProject: failedProject.canonicalProject,
              authoredProject: failedProject.project,
            }),
            scope,
            "install",
          ),
          ...installRecoveryAddendum(recovery),
        ],
        stderrContext,
        recording,
      );
    }
    return { exitCode: 1 };
  }
  if (cause instanceof ApplyConsentRequiredError) {
    // The remedy stays runnable: already-supplied flags are kept and the
    // missing operations are added, so re-running answers the whole scope.
    const scope: ChangedFileAnsweringScope = {
      remove: parsed.removeChanged || cause.requiredOperations.includes("remove"),
      replace: parsed.replaceChanged || cause.requiredOperations.includes("replace"),
    };
    if (parsed.json) {
      request.stdout.write(formatLifecycleToolErrorJson("install", formatError(cause), recoveryJson));
    } else {
      writeInstallReport(
        request.stderr,
        [
          ...applyConsentRequiredDocument(
            cause,
            fullySpecifiedInstallArguments(parsed, cwd, scope, {
              canonicalProject: failedProject.canonicalProject,
              authoredProject: failedProject.project,
            }),
            "install",
          ),
          ...installRecoveryAddendum(recovery),
        ],
        stderrContext,
        recording,
      );
    }
    return { exitCode: 1 };
  }
  if (cause instanceof ApplyReviewStaleError) {
    if (parsed.json) {
      request.stdout.write(formatLifecycleToolErrorJson("install", formatError(cause), recoveryJson));
    } else {
      writeInstallReport(
        request.stderr,
        [
          ...applyReviewStaleDocument(
            cause,
            fullySpecifiedInstallArguments(
              parsed,
              cwd,
              answering(confirmer.promptedAcceptedScope()),
              {
                canonicalProject: failedProject.canonicalProject,
                authoredProject: failedProject.project,
              },
            ),
            "install",
          ),
          ...installRecoveryAddendum(recovery),
        ],
        stderrContext,
        recording,
      );
    }
    return { exitCode: 1 };
  }
  if (cause instanceof ApplyBlockedError) {
    if (parsed.json) {
      request.stdout.write(formatLifecycleJson("install", cause.report, recoveryJson));
    } else {
      writeInstallReport(
        request.stdout,
        [
          ...installBlockedDocument(
            cause.report,
            fullySpecifiedInstallArguments(parsed, cwd, undefined, {
              canonicalProject: failedProject.canonicalProject,
              authoredProject: failedProject.project,
            }),
          ),
          ...installRecoveryAddendum(recovery),
        ],
        stdoutContext,
        recording,
      );
    }
    return { exitCode: lifecycleExitCode(cause.report) };
  }
  if (cause instanceof ApplyExecutionError) {
    const retry = fullySpecifiedInstallArguments(parsed, cwd, undefined, {
      canonicalProject: failedProject.canonicalProject,
      authoredProject: failedProject.project,
    });
    if (parsed.json) {
      request.stdout.write(formatApplyExecutionFailureJson({
        failedProject: cause.failedProject,
        message: cause.message,
        pendingProjects: cause.pendingProjects,
        receipt: cause.receipt,
        resultingState: cause.resultingState,
        command: "install",
        recovery: recoveryJson,
      }));
    } else {
      writeInstallReport(
        request.stderr,
        installExecutionFailureDocument({
          detail: cause.detail,
          ...(cause.failedProject === undefined ? {} : { failedProject: cause.failedProject }),
          recovery,
          retryArguments: retry,
        }),
        stderrContext,
        recording,
      );
    }
    return { exitCode: 1 };
  }
  if (cause instanceof ApplyVerificationError) {
    const retry = fullySpecifiedInstallArguments(parsed, cwd, undefined, {
      canonicalProject: failedProject.canonicalProject,
      authoredProject: failedProject.project,
    });
    if (parsed.json) {
      request.stdout.write(
        formatApplyVerificationFailureJson(cause.receipt, cause.message, "install", recoveryJson),
      );
    } else {
      writeInstallReport(
        request.stderr,
        installVerificationFailureDocument({ message: cause.message, retryArguments: retry }),
        stderrContext,
        recording,
      );
    }
    return { exitCode: 1 };
  }
  // Publication and other pre-write failures carry no reconciliation cause:
  // nothing was published, so the previous selection stands — reported here
  // with the same concrete retry instead of a bare diagnostic.
  const retry = fullySpecifiedInstallArguments(parsed, cwd, undefined, {
    canonicalProject: failedProject.canonicalProject,
    authoredProject: failedProject.project,
  });
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (parsed.json) {
    request.stdout.write(formatLifecycleToolErrorJson("install", detail, recoveryJson));
  } else {
    writeInstallReport(
      request.stderr,
      installExecutionFailureDocument({
        detail,
        failedProject,
        recovery,
        retryArguments: retry,
      }),
      stderrContext,
      recording,
    );
  }
  return { exitCode: 1 };
}

/**
 * The success receipt input for one installed result. A `replaced` outcome
 * without a snapshotted previous selection is a defect, not a quieter
 * receipt: fail fast instead of omitting the old → new scope.
 */
function installReceiptInput(
  result: InstallApplicationResult,
): InstallReceiptInput {
  const binding = result.binding;
  if (binding.outcome !== "replaced") {
    return {
      outcome: binding.outcome,
      canonicalProject: binding.canonicalProject,
      project: binding.project,
      profile: binding.profile,
      hosts: binding.hosts,
    };
  }
  const previous = result.preview.previous;
  if (previous === undefined) {
    throw new Error("install replaced a Project with no previous selection snapshot");
  }
  return {
    outcome: binding.outcome,
    canonicalProject: binding.canonicalProject,
    project: binding.project,
    profile: binding.profile,
    hosts: binding.hosts,
    previous: { profile: previous.profile, hosts: previous.hosts },
  };
}

/**
 * The equivalent fully specified command arguments: the same installation
 * with every scope argument and the general-confirmation answer explicit, so
 * re-running it needs no second answer. The Project travels as a path
 * argument so the renderer shell-quotes it as one POSIX token (US-006);
 * every other token is plain text.
 */
export function fullySpecifiedInstallArguments(
  parsed: ParsedInstallArguments,
  cwd: string | undefined,
  answering?: ChangedFileAnsweringScope,
  project?: { readonly canonicalProject: string; readonly authoredProject: string },
): readonly CommandArg[] {
  const args: CommandArg[] = [arg("install")];
  if (parsed.profile !== undefined) args.push(arg(parsed.profile));
  const authored = parsed.project ??
    (cwd !== undefined && parsed.profile !== undefined ? cwd : undefined);
  if (authored !== undefined) {
    // Fleet scope: the equivalent must name the Project stably (DEC-006),
    // never as a cwd-relative alias that reinstalls elsewhere when pasted.
    const projectArg: CommandArg = {
      kind: "path",
      canonicalPath: project?.canonicalProject ?? authored,
      scope: "fleet",
      authoredPath: project?.authoredProject ?? authored,
    };
    if (parsed.project !== undefined && parsed.projectFlag) args.push(arg("--project"), projectArg);
    else args.push(projectArg);
  }
  for (const host of parsed.hosts ?? []) args.push(arg("--host"), arg(host));
  if (parsed.replaceChanged || answering?.replace === true) args.push(arg("--replace-changed"));
  if (parsed.removeChanged || answering?.remove === true) args.push(arg("--remove-changed"));
  args.push(arg("--auto-confirm"));
  return args;
}
