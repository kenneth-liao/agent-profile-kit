/**
 * The `init` command: interactive setup asks where the Workspace goes and
 * confirms the chosen folder before any write (spec #593 #603, US-001,
 * ISC-24.1–24.2); optional first-Profile guidance on an interactive input
 * stream (US-054, DEC-030–031) follows the confirmation through the same
 * Profile-creation scaffolding path as `apkit new` (DEC-034). Every flow
 * decision is collected before initialization commits any change, so
 * cancellation or declining at any prompt records no configuration change
 * or generated output (US-056, DEC-033, ISC-27.3); a completed guided flow
 * prints the equivalent fully specified `apkit new profile` command
 * (US-052, DEC-032). Non-interactive invocations never prompt and behave
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
  guidedInitCompletionDocument,
  initConfirmationDocument,
  initLocationDocument,
  initReceiptDocument,
  PROFILE_EXPLANATION_SENTENCE,
  type NewArtifactReceiptInput,
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
import { createMultiSelectPrompt, createTextPrompt, createYesNoPrompt, isInteractiveInput, type PromptClock } from "./prompts.js";
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
  normalizeAuthoredWorkspace,
  planFirstConnectionSetup,
  previewInitTarget,
  type FirstConnectionSetupPlan,
  type InitTargetPreview,
} from "../installer/initialize-workspace.js";
import { createProfile } from "../installer/create-profile.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import { lstatEntry } from "../installer/workspace.js";
import { InstallerToolError } from "../installer/tool-errors.js";
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

const OFFER_QUESTION = "Set up your first Profile now?";
const NAME_QUESTION = "What should the Profile be named?";
const CONTEXT_QUESTION = "Which Context Modules?";
const SKILL_QUESTION = "Which Skills?";
const LOCATION_QUESTION = "Use the current folder as your Workspace?";
const FOLDER_QUESTION = "Which folder should be your Workspace?";
const CONFIRM_QUESTION = "Set up this folder as your Workspace?";

/** The one canonical init usage line, read from the command-help table. */
const initCommandSyntax = COMMANDS.find((command) => command.name === "init")!.syntax;

function initArgumentErrorDiagnostic(error: unknown): PresentationDocument {
  return errorDiagnosticDocument(error, { usage: initCommandSyntax });
}

/** One init invocation with its warnings, receipt, and advisory Host detection.
 * When the guided Profile completion follows this receipt, the receipt
 * carries no parallel next action of its own (spec #491, US-016). */
async function initializeAndReport(
  request: InitCommandRequest,
  parsed: ParsedInitArguments,
  stdoutContext: TerminalPresentationContext,
  stderrContext: TerminalPresentationContext,
  renderOptions: PresentationRenderOptions,
  options: { readonly guidedProfileFollows?: boolean } = {},
): Promise<void> {
  const result = await initializeWorkspace(request.home, parsed);
  for (const warning of result.warnings) {
    writeHumanDocument(
      request.stderr,
      diagnosticDocument({
        happened: [`warning: ${warning}`],
        severity: "attention",
      }),
      stderrContext,
      renderOptions,
    );
  }
  const { guidedProfileFollows = false } = options ?? {};
  const detectedHosts = result.outcome === "created"
    ? await detectInstalledHosts({ env: request.env ?? process.env })
    : undefined;
  writeHumanDocument(
    request.stdout,
    initReceiptDocument({
      ...result,
      ...(guidedProfileFollows ? { guidedProfileFollows: true } : {}),
      ...(detectedHosts !== undefined ? { detectedHosts } : {}),
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
  const firstConnection = interactive &&
    (await classifyInitSetup(request.home)).kind === "first-connection";

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
    multiSelect: createMultiSelectPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    }),
  };

  let authored = parsed.workspace;
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

  // The guided-offer eligibility material. First connections plan the setup
  // read-only first: every pre-write refusal surfaces before the
  // confirmation, so an invalid folder is never connected and never prompted
  // about (US-002). The plan is read-only — waiting at the confirmation
  // writes nothing (ISC-24.1).
  let plan: FirstConnectionSetupPlan | undefined;
  let preview: InitTargetPreview | undefined;
  if (firstConnection) {
    plan = await planFirstConnectionSetup(request.home, authored!);
    writeHumanDocument(
      request.stdout,
      initConfirmationDocument({
        destinationPath: plan.destinationPath,
        authoredPath: plan.authoredPath,
        folderMissing: plan.folderMissing,
        missingParts: plan.missingParts,
      }),
      stdoutContext,
      renderOptions,
    );
    const confirmed = await prompts.yesNo(CONFIRM_QUESTION);
    if (confirmed === "cancelled") {
      writeHumanDocument(
        request.stderr,
        initCancelledDocument(authored === undefined ? {} : { workspace: authored }),
        stderrContext,
      );
      return { exitCode: 1 };
    }
    if (confirmed === "declined") {
      writeHumanDocument(
        request.stdout,
        initDeclinedDocument(authored === undefined ? {} : { workspace: authored }),
        stdoutContext,
        renderOptions,
      );
      return { exitCode: 0 };
    }
    preview = {
      destinationPath: plan.destinationPath,
      profiles: plan.profiles,
      contexts: plan.contexts,
      skills: plan.skills,
    };
  } else {
    preview = interactive
      ? await previewInitTarget(request.home, authored === undefined ? {} : { workspace: authored })
      : undefined;
  }

  const guidanceOffered = preview !== undefined &&
    preview.profiles.length === 0 &&
    (preview.contexts.length > 0 || preview.skills.length > 0);

  if (preview === undefined || !guidanceOffered) {
    await initializeAndReport(
      request,
      authored === undefined ? {} : { workspace: authored },
      stdoutContext,
      stderrContext,
      renderOptions,
    );
    return { exitCode: 0 };
  }

  // Optional first-Profile guidance (US-054). All decisions are collected
  // before initialization commits any change, so backing out is always safe
  // (DEC-031, DEC-033).
  writeHumanDocument(
    request.stdout,
    [{ kind: "sentence", parts: [PROFILE_EXPLANATION_SENTENCE] }],
    stdoutContext,
    renderOptions,
  );
  const offer = await prompts.yesNo(OFFER_QUESTION);
  if (offer === "cancelled") {
    writeHumanDocument(request.stderr, initCancelledDocument(authored === undefined ? {} : { workspace: authored }), stderrContext, renderOptions);
    return { exitCode: 1 };
  }
  if (offer === "declined") {
    await initializeAndReport(
      request,
      authored === undefined ? {} : { workspace: authored },
      stdoutContext,
      stderrContext,
      renderOptions,
    );
    return { exitCode: 0 };
  }

  const nameAnswer = await prompts.text(NAME_QUESTION);
  if (nameAnswer.kind === "cancelled") {
    writeHumanDocument(request.stderr, initCancelledDocument(authored === undefined ? {} : { workspace: authored }), stderrContext, renderOptions);
    return { exitCode: 1 };
  }
  // Pre-commit validation keeps every refusal before any change: an invalid
  // name or an occupied destination is reported while nothing exists yet.
  let name: string;
  try {
    name = requireArtifactId(nameAnswer.value, "new profile name");
  } catch (error) {
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext, renderOptions);
    return { exitCode: 1 };
  }
  if ((await lstatEntry(join(preview.destinationPath, "profiles", `${name}.yaml`))) !== undefined) {
    writeHumanDocument(
      request.stderr,
      errorDiagnosticDocument(new InstallerToolError({
        kind: "artifact-path-occupied",
        artifactType: "Profile",
        id: name,
        path: join(preview.destinationPath, "profiles", `${name}.yaml`),
      })),
      stderrContext,
      renderOptions,
    );
    return { exitCode: 1 };
  }

  // Each available category is offered when material exists (US-045); a
  // category with no material is skipped — a zero-choice question cannot be
  // answered. When both exist, either may stay empty and the total is checked
  // afterwards; with one category left, that category must be selected,
  // because a Profile requires at least one artifact.
  const bothAvailable = preview.contexts.length > 0 && preview.skills.length > 0;
  const contextAnswer = preview.contexts.length > 0
    ? await prompts.multiSelect(
      CONTEXT_QUESTION,
      preview.contexts.map((id) => ({ title: id, value: id })),
      { min: bothAvailable ? 0 : 1 },
    )
    : { kind: "selected" as const, values: [] as readonly string[] };
  if (contextAnswer.kind === "cancelled") {
    writeHumanDocument(request.stderr, initCancelledDocument(authored === undefined ? {} : { workspace: authored }), stderrContext, renderOptions);
    return { exitCode: 1 };
  }
  const skillAnswer = preview.skills.length > 0
    ? await prompts.multiSelect(
      SKILL_QUESTION,
      preview.skills.map((id) => ({ title: id, value: id })),
      { min: bothAvailable ? 0 : 1 },
    )
    : { kind: "selected" as const, values: [] as readonly string[] };
  if (skillAnswer.kind === "cancelled") {
    writeHumanDocument(request.stderr, initCancelledDocument(authored === undefined ? {} : { workspace: authored }), stderrContext, renderOptions);
    return { exitCode: 1 };
  }
  const contexts = contextAnswer.values;
  const skills = skillAnswer.values;
  if (contexts.length === 0 && skills.length === 0) {
    writeHumanDocument(
      request.stderr,
      errorDiagnosticDocument(new InstallerToolError({
        kind: "profile-without-artifacts",
        profile: name,
        availableContexts: [...preview.contexts],
        availableSkills: [...preview.skills],
      })),
      stderrContext,
      renderOptions,
    );
    return { exitCode: 1 };
  }

  // Commit: initialization first, then the delivered Profile-creation
  // scaffolding path (DEC-034). A creation failure after initialization is
  // reported after the true initialization receipt; the flow's collected
  // decisions cannot cause one, since they were validated above. The receipt
  // precedes creation, so it carries no next action; the Profile completion
  // below owns the one install next action (spec #491, US-016).
  await initializeAndReport(
    request,
    authored === undefined ? {} : { workspace: authored },
    stdoutContext,
    stderrContext,
    renderOptions,
    {
      guidedProfileFollows: true,
    },
  );
  let created: Awaited<ReturnType<typeof createProfile>>;
  try {
    created = await createProfile({
      home: request.home,
      name,
      contexts,
      skills,
    });
  } catch (error) {
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext, renderOptions);
    return { exitCode: 1 };
  }
  const receipt: NewArtifactReceiptInput = {
    artifactType: "Profile",
    id: created.id,
    path: created.path,
    selectedContexts: contexts,
    selectedSkills: skills,
    availableContexts: created.availableContexts,
    availableSkills: created.availableSkills,
  };
  writeHumanDocument(request.stdout, guidedInitCompletionDocument(receipt), stdoutContext, renderOptions);
  return { exitCode: 0 };
}
