/**
 * The `init` command: optional first-Profile guidance on an interactive input
 * stream (US-054, DEC-030–031) through the same Profile-creation scaffolding
 * path as `apkit new` (DEC-034). Every flow decision is collected before
 * initialization commits any change, so cancellation at any prompt records no
 * configuration change or generated output (US-056, DEC-033); a completed
 * flow prints the equivalent fully specified `apkit new profile` command
 * (US-052, DEC-032). Non-interactive invocations never prompt and behave
 * exactly as before (US-055).
 *
 * The prompt layer takes injectable input and output streams and a clock,
 * mirroring the progress seam (DEC-035), so the flow is exercisable without a
 * pseudo-terminal.
 */
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  initReceiptDocument,
  newArtifactReceiptDocument,
  PROFILE_EXPLANATION_SENTENCE,
  type NewArtifactReceiptInput,
} from "./receipts.js";
import {
  initCancelledDocument,
  newProfilePromptedCommandDocument,
} from "./presentation.js";
import {
  writeHumanDocument,
  type PresentationDocument,
} from "./presentation-document.js";
import { diagnosticDocument } from "./diagnostics.js";
import { errorDiagnosticDocument } from "./error-wording.js";
import {
  createMultiSelectPrompt,
  createTextPrompt,
  createYesNoPrompt,
  isInteractiveInput,
  type PromptClock,
} from "./prompts.js";
import {
  terminalPresentationContext,
  type TerminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";
import {
  detectInstalledHosts,
} from "../adapters/registry.js";
import { initializeWorkspace, previewInitTarget } from "../installer/initialize-workspace.js";
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
  readonly clock?: PromptClock;
}

export interface InitCommandOutcome {
  readonly exitCode: 0 | 1;
}

const OFFER_QUESTION = "Set up your first Profile now?";
const NAME_QUESTION = "What should the Profile be named?";
const CONTEXT_QUESTION = "Which Context Modules?";
const SKILL_QUESTION = "Which Skills?";

/** The one canonical init usage line, read from the command-help table. */
const initCommandSyntax = COMMANDS.find((command) => command.name === "init")!.syntax;

function initArgumentErrorDiagnostic(error: unknown): PresentationDocument {
  return errorDiagnosticDocument(error, { usage: initCommandSyntax });
}

/** One init invocation with its warnings, receipt, and advisory Host detection. */
async function initializeAndReport(
  request: InitCommandRequest,
  parsed: ParsedInitArguments,
  stdoutContext: TerminalPresentationContext,
  stderrContext: TerminalPresentationContext,
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
    }),
    stdoutContext,
  );
}

export async function runInitCommand(request: InitCommandRequest): Promise<InitCommandOutcome> {
  const stdoutContext = terminalPresentationContext(request.stdout);
  const stderrContext = terminalPresentationContext(request.stderr);

  let parsed: ParsedInitArguments;
  try {
    parsed = parseInitArguments(request.arguments);
  } catch (error) {
    writeHumanDocument(request.stderr, initArgumentErrorDiagnostic(error), stderrContext);
    return { exitCode: 1 };
  }

  const interactive = isInteractiveInput(request.input);
  const preview = interactive ? await previewInitTarget(request.home, parsed) : undefined;
  const guidanceOffered = preview !== undefined &&
    preview.profiles.length === 0 &&
    (preview.contexts.length > 0 || preview.skills.length > 0);

  if (!guidanceOffered) {
    await initializeAndReport(request, parsed, stdoutContext, stderrContext);
    return { exitCode: 0 };
  }

  // Optional first-Profile guidance (US-054). All decisions are collected
  // before initialization commits any change, so backing out is always safe
  // (DEC-031, DEC-033).
  const guidedPrompts = {
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

  writeHumanDocument(
    request.stdout,
    [{ kind: "sentence", parts: [PROFILE_EXPLANATION_SENTENCE] }],
    stdoutContext,
  );
  const offer = await guidedPrompts.yesNo(OFFER_QUESTION);
  if (offer === "cancelled") {
    writeHumanDocument(request.stderr, initCancelledDocument(), stderrContext);
    return { exitCode: 1 };
  }
  if (offer === "declined") {
    await initializeAndReport(request, parsed, stdoutContext, stderrContext);
    return { exitCode: 0 };
  }

  const nameAnswer = await guidedPrompts.text(NAME_QUESTION);
  if (nameAnswer.kind === "cancelled") {
    writeHumanDocument(request.stderr, initCancelledDocument(), stderrContext);
    return { exitCode: 1 };
  }
  // Pre-commit validation keeps every refusal before any change: an invalid
  // name or an occupied destination is reported while nothing exists yet.
  let name: string;
  try {
    name = requireArtifactId(nameAnswer.value, "new profile name");
  } catch (error) {
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
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
    );
    return { exitCode: 1 };
  }

  // Each available category is offered when material exists (US-045); a
  // category with no material is skipped. When both exist, either may stay
  // empty and the total is checked afterwards; with one category left, that
  // category must be selected, because a Profile requires at least one
  // artifact.
  const bothAvailable = preview.contexts.length > 0 && preview.skills.length > 0;
  const contextAnswer = await guidedPrompts.multiSelect(
    CONTEXT_QUESTION,
    preview.contexts.map((id) => ({ title: id, value: id })),
    { min: bothAvailable ? 0 : 1 },
  );
  if (contextAnswer.kind === "cancelled") {
    writeHumanDocument(request.stderr, initCancelledDocument(), stderrContext);
    return { exitCode: 1 };
  }
  const skillAnswer = preview.skills.length > 0
    ? await guidedPrompts.multiSelect(
      SKILL_QUESTION,
      preview.skills.map((id) => ({ title: id, value: id })),
      { min: bothAvailable ? 0 : 1 },
    )
    : { kind: "selected" as const, values: [] as readonly string[] };
  if (skillAnswer.kind === "cancelled") {
    writeHumanDocument(request.stderr, initCancelledDocument(), stderrContext);
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
    );
    return { exitCode: 1 };
  }

  // Commit: initialization first, then the delivered Profile-creation
  // scaffolding path (DEC-034). A creation failure after initialization is
  // reported after the true initialization receipt; the flow's collected
  // decisions cannot cause one, since they were validated above.
  await initializeAndReport(request, parsed, stdoutContext, stderrContext);
  let created: Awaited<ReturnType<typeof createProfile>>;
  try {
    created = await createProfile({
      home: request.home,
      name,
      contexts,
      skills,
    });
  } catch (error) {
    writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
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
  writeHumanDocument(request.stdout, newArtifactReceiptDocument(receipt), stdoutContext);
  const equivalentArguments = [
    "new",
    "profile",
    name,
    ...contexts.flatMap((id) => ["--context", id]),
    ...skills.flatMap((id) => ["--skill", id]),
  ];
  writeHumanDocument(
    request.stdout,
    newProfilePromptedCommandDocument(equivalentArguments),
    stdoutContext,
  );
  return { exitCode: 0 };
}
