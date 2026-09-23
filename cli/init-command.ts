/**
 * The `init` command: interactive setup asks where the Workspace goes and
 * confirms the chosen folder before any write (spec #593 #603, US-001,
 * ISC-24.1–24.2). Setup creates or connects the Workspace and routes the
 * handoff from the resulting content (spec #640 US-002, DEC-005); it never
 * creates or guides a first Profile (OOS-002). Cancellation or declining at
 * any prompt records no configuration change or generated output (US-056,
 * DEC-033, ISC-27.3). Non-interactive invocations never prompt and behave
 * exactly as before (US-055): supplying the path counts as confirmation for
 * adding missing parts (US-003).
 *
 * The prompt layer takes injectable input and output streams and a clock,
 * mirroring the progress seam (DEC-035), so the flow is exercisable without a
 * pseudo-terminal.
 */
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  initConfirmationDocument,
  initLocationDocument,
  initReceiptDocument,
} from "./receipts.js";
import {
  initCancelledDocument,
  initDeclinedDocument,
} from "./presentation.js";
import {
  writeHumanDocument,
  type PresentationDocument,
  type PresentationRenderOptions,
} from "./presentation-document.js";
import { diagnosticDocument } from "./diagnostics.js";
import { errorDiagnosticDocument } from "./error-wording.js";
import { createTextPrompt, createYesNoPrompt, isInteractiveInput, type PromptClock } from "./prompts.js";
import {
  terminalPresentationContext,
  type TerminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";
import {
  detectInstalledHosts,
} from "../adapters/registry.js";
import {
  classifyInitSetup,
  initializeWorkspace,
  isSameWorkspace,
  normalizeAuthoredWorkspace,
  planFirstConnectionSetup,
  type FirstConnectionSetupPlan,
} from "../installer/initialize-workspace.js";
import { localConfigurationPath, resolveWorkspaceRoot } from "../installer/local-configuration.js";
import { COMMANDS } from "./command-help.js";

export interface ParsedInitArguments {
  readonly workspace?: string;
}

/** Parse `init [<workspace>]`. */
export function parseInitArguments(arguments_: readonly string[]): ParsedInitArguments {
  if (arguments_.length > 1) {
    throw new Error("init accepts at most one Workspace path");
  }
  return arguments_.length === 0
    ? {}
    : { workspace: positionalArgument("init", "a Workspace path", arguments_[0]!) };
}

function positionalArgument(command: string, description: string, value: string): string {
  if (value.startsWith("-")) {
    throw new Error(`${command} does not accept flag '${value}' as ${description}`);
  }
  return value;
}

export interface InitCommandRequest {
  readonly home: string;
  /** The arguments after the command token. */
  readonly arguments: readonly string[];
  /** Injectable output stream for receipts and the prompt questions. */
  readonly stdout: Writable & TerminalStream;
  /** Injectable diagnostic stream. */
  readonly stderr: Writable & TerminalStream;
  /** Injectable prompt input stream; TTY evidence is read here (DEC-035). */
  readonly input: Readable;
  /** Environment for advisory Host detection; defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** The working directory the invocation runs in; defaults to process.cwd().
   * The current-folder choice and typed relative paths resolve against it. */
  readonly cwd?: string;
  readonly clock?: PromptClock;
}

export interface InitCommandOutcome {
  readonly exitCode: 0 | 1;
}

const LOCATION_QUESTION = "Use the current folder as your Workspace?";
const FOLDER_QUESTION = "Which folder should be your Workspace?";
const CONFIRM_QUESTION = "Set up this folder as your Workspace?";

/** The one canonical init usage line, read from the command-help table. */
const initCommandSyntax = COMMANDS.find((command) => command.name === "init")!.syntax;

function initArgumentErrorDiagnostic(error: unknown): PresentationDocument {
  return errorDiagnosticDocument(error, { usage: initCommandSyntax });
}

/** One init invocation with its warnings, receipt, and advisory Host detection.
 * The receipt routes the handoff from the resulting content (spec #640
 * US-002) and names Local Configuration when this outcome wrote it. */
async function initializeAndReport(
  request: InitCommandRequest,
  parsed: ParsedInitArguments,
  stdoutContext: TerminalPresentationContext,
  stderrContext: TerminalPresentationContext,
  renderOptions: PresentationRenderOptions,
): Promise<void> {
  const result = await initializeWorkspace(request.home, parsed);
  for (const warning of result.warnings) {
    writeHumanDocument(
      request.stderr,
      diagnosticDocument({
        happened: [`warning: ${warning}`],
        severity: "warning",
      }),
      stderrContext,
      renderOptions,
    );
  }
  const detectedHosts = result.outcome === "created"
    ? await detectInstalledHosts({ env: request.env ?? process.env })
    : undefined;
  writeHumanDocument(
    request.stdout,
    initReceiptDocument({
      ...result,
      ...(detectedHosts !== undefined ? { detectedHosts } : {}),
      ...(result.outcome === "unchanged"
        ? {}
        : { configurationPath: localConfigurationPath(request.home) }),
    }),
    stdoutContext,
    renderOptions,
  );
}

export async function runInitCommand(request: InitCommandRequest): Promise<InitCommandOutcome> {
  const stdoutContext = terminalPresentationContext(request.stdout);
  const stderrContext = terminalPresentationContext(request.stderr);

  const renderOptions = { cwd: request.cwd ?? process.cwd(), home: request.home };

  let parsed: ParsedInitArguments;
  try {
    parsed = parseInitArguments(request.arguments);
  } catch (error) {
    writeHumanDocument(
      request.stderr,
      initArgumentErrorDiagnostic(error),
      stderrContext,
      renderOptions,
    );
    return { exitCode: 1 };
  }

  const interactive = isInteractiveInput(request.input);
  // One render environment for the whole invocation: the working directory
  // the user is in and the machine's Local Configuration home, so path
  // spellings render against the invocation, not the renderer's defaults.
  // The one classification read routes the interactive flow and the commit
  // alike (spec #593 #603): first connections ask and confirm; already-
  // connected destinations keep the delivered behavior.
  let authored = parsed.workspace;
  const classification = await classifyInitSetup(request.home);
  const firstConnection = interactive && classification.kind === "first-connection";
  const connectingAgain = interactive && classification.kind === "already-connected" && authored !== undefined;

  // Interactive first connections ask where the Workspace goes (US-001,
  // ISC-24.1) and confirm the chosen folder before any write. Non-interactive
  // and already-connected invocations never prompt (US-055): a supplied path
  // counts as confirmation for adding missing parts (US-003), and without a
  // path the delivered refusal stands (spec #593 #601).
  const prompts = {
    yesNo: createYesNoPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    }),
    text: createTextPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    }),
  };

  if (firstConnection && authored === undefined) {
    // The location question: the current folder, shown as its full path, or
    // another path (ISC-24.2). Cancelling writes nothing.
    const cwd = request.cwd ?? process.cwd();
    writeHumanDocument(
      request.stdout,
      initLocationDocument({ destinationPath: cwd, authoredPath: "." }),
      stdoutContext,
      renderOptions,
    );
    const currentFolder = await prompts.yesNo(LOCATION_QUESTION);
    if (currentFolder === "cancelled") {
      writeHumanDocument(request.stderr, initCancelledDocument(), stderrContext, renderOptions);
      return { exitCode: 1 };
    }
    if (currentFolder === "accepted") {
      authored = normalizeAuthoredWorkspace(".", cwd);
    } else {
      const folderAnswer = await prompts.text(FOLDER_QUESTION);
      if (folderAnswer.kind === "cancelled") {
        writeHumanDocument(request.stderr, initCancelledDocument(), stderrContext, renderOptions);
        return { exitCode: 1 };
      }
      const typed = folderAnswer.value.trim();
      if (typed === "") {
        writeHumanDocument(
          request.stderr,
          initArgumentErrorDiagnostic(new Error("Enter a Workspace folder path, or cancel with Ctrl-C")),
          stderrContext,
          renderOptions,
        );
        return { exitCode: 1 };
      }
      authored = normalizeAuthoredWorkspace(typed, cwd);
    }
  }

  // First connections and connecting-again plan the setup read-only first:
  // every pre-write refusal surfaces before the confirmation, so an invalid
  // folder is never connected (US-002). The plan is read-only — waiting at
  // the confirmation writes nothing (ISC-24.1).
  if (firstConnection || connectingAgain) {
    const plan: FirstConnectionSetupPlan = await planFirstConnectionSetup(request.home, authored!);
    let shouldConfirm = true;
    let currentDestinationPath: string | undefined;
    let currentAuthoredPath: string | undefined;

    if (connectingAgain) {
      currentAuthoredPath = classification.configuredWorkspace;
      const configPath = localConfigurationPath(request.home);
      const configuredWorkspace = await resolveWorkspaceRoot(request.home, currentAuthoredPath, configPath);
      currentDestinationPath = configuredWorkspace.path;
      if (await isSameWorkspace(plan.destinationPath, currentDestinationPath)) {
        shouldConfirm = false;
      }
    }

    if (shouldConfirm) {
      writeHumanDocument(
        request.stdout,
        initConfirmationDocument({
          destinationPath: plan.destinationPath,
          authoredPath: plan.authoredPath,
          folderMissing: plan.folderMissing,
          missingParts: plan.missingParts,
          ...(currentDestinationPath !== undefined ? { currentDestinationPath, currentAuthoredPath } : {}),
        }),
        stdoutContext,
        renderOptions,
      );
      const confirmed = await prompts.yesNo(CONFIRM_QUESTION);
      if (confirmed === "cancelled") {
        writeHumanDocument(
          request.stderr,
          initCancelledDocument(),
          stderrContext,
          renderOptions,
        );
        return { exitCode: 1 };
      }
      if (confirmed === "declined") {
        writeHumanDocument(
          request.stdout,
          initDeclinedDocument(),
          stdoutContext,
          renderOptions,
        );
        return { exitCode: 0 };
      }
    }
  }

  await initializeAndReport(
    request,
    authored === undefined ? {} : { workspace: authored },
    stdoutContext,
    stderrContext,
    renderOptions,
  );
  return { exitCode: 0 };
}
