/**
 * The `install` command (spec #491 US-001/US-006/US-007/US-008, DEC-001/
 * DEC-002/DEC-004–DEC-006): one action records the Project's desired
 * selection and installs/verifies the generated output. It replaces public
 * `bind` with no compatibility shim (pre-1.0 breaking-change policy).
 *
 * Explicit arguments are required for the Profile and Hosts in this slice;
 * searchable missing-choice pickers belong to #495, so missing Profile/Hosts
 * remain errors on every input stream here. The general confirmation
 * (DEC-004) fires on interactive input unless `--auto-confirm` answers it;
 * non-interactive invocations without that flag refuse before any write.
 * Changed-file consent (DEC-005) consumes the shared #493 contract and is
 * never answered by `--auto-confirm`.
 */
import type { Readable, Writable } from "node:stream";

import { writeHumanDocument, type PresentationDocument } from "./presentation-document.js";
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
  installExecutionFailureDocument,
  installReplacementCommandDocument,
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
import { createTextPrompt, isInteractiveInput, type PromptClock } from "./prompts.js";
import { SUPPORTED_HOSTS } from "../adapters/registry.js";
import {
  executeInstall,
  previewInstall,
  InstallExecutionError,
  type InstallApplicationResult,
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
 * Parse `install <profile> [project] --host <host> ... [--project <path>]
 * [--auto-confirm] [--replace-changed] [--remove-changed] [--json]`.
 * Missing Profile/Hosts are reported as absent, not errors: the command
 * layer refuses them before any write on every input stream (#495 owns the
 * pickers that will complete them interactively).
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
 * (missing choices belong to #495; non-interactive invocations keep them).
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

export async function runInstallCommand(request: InstallCommandRequest): Promise<InstallCommandOutcome> {
  const stderrContext = terminalPresentationContext(request.stderr);

  let parsed: ParsedInstallArguments;
  try {
    parsed = parseInstallArguments(request.arguments);
  } catch (error) {
    writeHumanDocument(request.stderr, installArgumentErrorDiagnostic(error), stderrContext);
    return { exitCode: 1 };
  }

  if (parsed.profile === undefined) {
    writeHumanDocument(request.stderr, missingProfileDiagnostic(), stderrContext);
    return { exitCode: 1 };
  }
  if (parsed.hosts === undefined || parsed.hosts.length === 0) {
    writeHumanDocument(request.stderr, missingHostsDiagnostic(), stderrContext);
    return { exitCode: 1 };
  }

  const interactive = isInteractiveInput(request.input);
  if (!parsed.autoConfirm && (!interactive || parsed.json)) {
    writeHumanDocument(
      request.stderr,
      installConfirmationRequiredDocument(
        fullySpecifiedInstallArguments(parsed, request.cwd),
      ),
      stderrContext,
    );
    return { exitCode: 1 };
  }

  // The preview validates the proposed scope without writing anything; the
  // general confirmation (DEC-004) authorizes exactly this scope.
  let preview;
  try {
    preview = await previewInstall(request.home, {
      profile: parsed.profile,
      hosts: [...(parsed.hosts ?? [])],
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    });
  } catch (error) {
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
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
    if (answer.kind === "cancelled") {
      writeHumanDocument(
        request.stderr,
        installDeclinedDocument("cancelled", fullySpecifiedInstallArguments(parsed, request.cwd)),
        stderrContext,
      );
      return { exitCode: 1 };
    }
    const normalized = answer.value.trim().toLowerCase();
    if (normalized !== "y" && normalized !== "yes") {
      writeHumanDocument(
        request.stderr,
        installDeclinedDocument(
          normalized === "" ? "default" : "declined",
          fullySpecifiedInstallArguments(parsed, request.cwd),
        ),
        stderrContext,
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
  try {
    const result = await executeInstall(request.home, {
      profile: parsed.profile,
      hosts: [...(parsed.hosts ?? [])],
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(parsed.replaceChanged ? { replaceChanged: true as const } : {}),
      ...(parsed.removeChanged ? { removeChanged: true as const } : {}),
      ...(confirmer.confirm === undefined ? {} : { confirmChangedOutputReplacement: confirmer.confirm }),
    });
    const acceptedScope = confirmer.promptedAcceptedScope();
    if (parsed.json) {
      request.stdout.write(formatInstallJson(result.applied));
    } else {
      writeHumanDocument(
        request.stdout,
        installReceiptDocument(installReceiptInput(result)),
        stdoutContext,
      );
      // Advisory report warnings (absent Host CLIs and the like) stay
      // visible on the install path that replaces the old bind+update
      // sequence; they never block and never change the outcome.
      const warnings = installWarningNodes(result.applied.resultingState);
      if (warnings.length > 0) {
        writeHumanDocument(request.stdout, warnings, stdoutContext);
      }
      if (acceptedScope !== undefined) {
        writeHumanDocument(
          request.stdout,
          installReplacementCommandDocument(
            fullySpecifiedInstallArguments(parsed, request.cwd, answeringScope(parsed, acceptedScope, acceptedScope)),
          ),
          stdoutContext,
        );
      }
    }
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof InstallExecutionError) {
      return installReconcileFailureOutcome(
        request,
        parsed,
        error,
        confirmer,
        {
          canonicalProject: preview.canonicalProject,
          project: preview.authoredProject,
        },
        stdoutContext,
        stderrContext,
      );
    }
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
    return { exitCode: 1 };
  }
}

/** Map one post-publication install failure to its truthful diagnostic. */
function installReconcileFailureOutcome(
  request: InstallCommandRequest,
  parsed: ParsedInstallArguments,
  failure: InstallExecutionError,
  confirmer: ChangedOutputConfirmer,
  failedProject: ProjectIdentity,
  stdoutContext: TerminalPresentationContext,
  stderrContext: TerminalPresentationContext,
): InstallCommandOutcome {
  const cause = failure.failure.cause;
  const answering = (prompted: ChangedFileAnsweringScope | undefined): ChangedFileAnsweringScope =>
    answeringScope(parsed, prompted, confirmer.requestedScope());
  if (cause instanceof ApplyDeclinedError) {
    if (parsed.json) {
      request.stdout.write(formatLifecycleToolErrorJson("install", formatError(cause)));
    } else {
      const scope = answering(confirmer.promptedAcceptedScope());
      writeHumanDocument(
        request.stderr,
        applyReplacementDeclinedDocument(
          cause.reason === "cancelled" ? "cancelled" : confirmer.declinedAnswer(),
          fullySpecifiedInstallArguments(parsed, request.cwd, scope),
          scope,
          "install",
        ),
        stderrContext,
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
      request.stdout.write(formatLifecycleToolErrorJson("install", formatError(cause)));
    } else {
      writeHumanDocument(
        request.stderr,
        applyConsentRequiredDocument(
          cause,
          fullySpecifiedInstallArguments(parsed, request.cwd, scope),
          "install",
        ),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }
  if (cause instanceof ApplyReviewStaleError) {
    if (parsed.json) {
      request.stdout.write(formatLifecycleToolErrorJson("install", formatError(cause)));
    } else {
      writeHumanDocument(
        request.stderr,
        applyReviewStaleDocument(
          cause,
          fullySpecifiedInstallArguments(parsed, request.cwd, answering(confirmer.promptedAcceptedScope())),
          "install",
        ),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }
  if (cause instanceof ApplyBlockedError) {
    if (parsed.json) {
      request.stdout.write(formatLifecycleJson("install", cause.report));
    } else {
      writeHumanDocument(
        request.stdout,
        installBlockedDocument(
          cause.report,
          fullySpecifiedInstallArguments(parsed, request.cwd),
        ),
        stdoutContext,
      );
    }
    return { exitCode: lifecycleExitCode(cause.report) };
  }
  if (cause instanceof ApplyExecutionError) {
    const retry = fullySpecifiedInstallArguments(parsed, request.cwd);
    if (parsed.json) {
      request.stdout.write(formatApplyExecutionFailureJson({
        failedProject: cause.failedProject,
        message: cause.message,
        pendingProjects: cause.pendingProjects,
        receipt: cause.receipt,
        resultingState: cause.resultingState,
        command: "install",
      }));
    } else {
      writeHumanDocument(
        request.stderr,
        installExecutionFailureDocument({
          detail: cause.detail,
          ...(cause.failedProject === undefined ? {} : { failedProject: cause.failedProject }),
          selectionRestored: failure.failure.selectionRestored,
          ...(failure.failure.restoreFailure === undefined
            ? {}
            : { restoreFailure: failure.failure.restoreFailure }),
          retryArguments: retry,
        }),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }
  if (cause instanceof ApplyVerificationError) {
    const retry = fullySpecifiedInstallArguments(parsed, request.cwd);
    if (parsed.json) {
      request.stdout.write(formatApplyVerificationFailureJson(cause.receipt, cause.message, "install"));
    } else {
      writeHumanDocument(
        request.stderr,
        installVerificationFailureDocument({ message: cause.message, retryArguments: retry }),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }
  // Publication and other pre-write failures carry no reconciliation cause:
  // nothing was published, so the previous selection stands — reported here
  // with the same concrete retry instead of a bare diagnostic.
  const retry = fullySpecifiedInstallArguments(parsed, request.cwd);
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (parsed.json) {
    request.stdout.write(formatLifecycleToolErrorJson("install", detail));
  } else {
    writeHumanDocument(
      request.stderr,
      installExecutionFailureDocument({
        detail,
        failedProject,
        selectionRestored: failure.failure.selectionRestored,
        ...(failure.failure.restoreFailure === undefined
          ? {}
          : { restoreFailure: failure.failure.restoreFailure }),
        retryArguments: retry,
      }),
      stderrContext,
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
 * re-running it needs no second answer.
 */export function fullySpecifiedInstallArguments(
  parsed: ParsedInstallArguments,
  cwd: string | undefined,
  answering?: ChangedFileAnsweringScope,
): readonly string[] {
  const args: string[] = ["install"];
  if (parsed.profile !== undefined) args.push(parsed.profile);
  if (parsed.project !== undefined) {
    if (parsed.projectFlag) args.push("--project", parsed.project);
    else args.push(parsed.project);
  } else if (cwd !== undefined && parsed.profile !== undefined) {
    args.push(cwd);
  }
  for (const host of parsed.hosts ?? []) args.push("--host", host);
  if (parsed.replaceChanged || answering?.replace === true) args.push("--replace-changed");
  if (parsed.removeChanged || answering?.remove === true) args.push("--remove-changed");
  args.push("--auto-confirm");
  return args;
}
