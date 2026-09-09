/**
 * The `bind` command: prompts complete only the missing required Profile and
 * Host arguments on an interactive input stream (US-051, DEC-030–031), then
 * records the binding through the unchanged Installer operation. A completed
 * prompt flow prints the equivalent fully specified command (US-052, DEC-032);
 * cancellation exits without recording any configuration change (US-056,
 * DEC-033). Fully specified binds and non-interactive invocations never
 * prompt: missing required arguments remain the delivered errors (US-055).
 *
 * The prompt layer takes injectable input and output streams and a clock,
 * mirroring the progress seam (DEC-035), so the flow is exercisable without a
 * pseudo-terminal. Host choices carry advisory installed/absent detection
 * evidence (US-053); detection never gates anything.
 */
import type { Readable, Writable } from "node:stream";

import {
  bindReceiptDocument,
  PROFILE_EXPLANATION_SENTENCE,
} from "./receipts.js";
import {
  bindCancelledDocument,
  bindPromptedCommandDocument,
} from "./presentation.js";
import {
  writeHumanDocument,
  type PresentationDocument,
} from "./presentation-document.js";
import { errorDiagnosticDocument } from "./error-wording.js";
import {
  createMultiSelectPrompt,
  createSelectPrompt,
  isInteractiveInput,
  type PromptClock,
} from "./prompts.js";
import {
  terminalPresentationContext,
  type TerminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";
import { bindProject } from "../installer/bind-project.js";
import { listProfiles } from "../installer/inventory.js";
import {
  detectInstalledHosts,
  SUPPORTED_HOSTS,
  type SupportedHost,
} from "../adapters/registry.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { COMMANDS } from "./command-help.js";

export interface ParsedBindArguments {
  readonly profile?: string;
  readonly project?: string;
  readonly hosts?: readonly string[];
  readonly replace: boolean;
}

/**
 * Parse `bind <profile> [project] --host <host> ... [--replace]`.
 * Missing required Profile and Host arguments are reported as absent, not
 * errors: the command layer decides between prompting (interactive) and the
 * delivered argument errors (non-interactive).
 */
export function parseBindArguments(arguments_: readonly string[]): ParsedBindArguments {
  if (arguments_.length === 0) {
    return { replace: false };
  }
  const profile = positionalArgument("bind", "a Profile", arguments_[0]!);
  let index = 1;
  let project: string | undefined;
  if (index < arguments_.length && !arguments_[index]!.startsWith("-")) {
    project = arguments_[index]!;
    index += 1;
  }

  const hosts: string[] = [];
  let replace = false;
  while (index < arguments_.length) {
    const flag = arguments_[index]!;
    if (flag === "--host") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("bind --host requires an Agent Host name");
      }
      hosts.push(value);
      index += 2;
      continue;
    }
    if (flag === "--replace") {
      replace = true;
      index += 1;
      continue;
    }
    throw new Error(`bind does not accept argument '${flag}'`);
  }

  return {
    ...(profile === undefined ? {} : { profile }),
    ...(project === undefined ? {} : { project }),
    ...(hosts.length === 0 ? {} : { hosts }),
    replace,
  };
}

function positionalArgument(command: string, description: string, value: string): string {
  if (value.startsWith("-")) {
    throw new Error(`${command} does not accept flag '${value}' as ${description}`);
  }
  return value;
}

export interface BindCommandRequest {
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

export interface BindCommandOutcome {
  readonly exitCode: 0 | 1;
}

const HOST_QUESTION = "Which Agent Hosts?";
const PROFILE_QUESTION = "Which Profile?";

/** The Host choices in canonical order, each carrying advisory detection evidence. */
function hostChoices(detectedHosts: readonly SupportedHost[]) {
  return SUPPORTED_HOSTS.map((host) => ({
    title: detectedHosts.includes(host) ? `${host} (installed)` : `${host} (not installed)`,
    value: host,
  }));
}

/** The one canonical bind usage line, read from the command-help table. */
const bindCommandSyntax = COMMANDS.find((command) => command.name === "bind")!.syntax;

/**
 * The delivered bind argument errors, used whenever prompting cannot happen
 * (non-interactive input) or cannot help (nothing to choose from).
 */
function missingProfileDiagnostic(): PresentationDocument {
  return errorDiagnosticDocument(new Error("bind requires a Profile name"), {
    usage: bindCommandSyntax,
  });
}

function missingHostsDiagnostic(): PresentationDocument {
  return errorDiagnosticDocument(
    new InstallerToolError({
      kind: "bind-host-required",
      supportedHosts: SUPPORTED_HOSTS,
    }),
    { usage: bindCommandSyntax },
  );
}

function bindArgumentErrorDiagnostic(error: unknown): PresentationDocument {
  return errorDiagnosticDocument(error, { usage: bindCommandSyntax });
}

export async function runBindCommand(request: BindCommandRequest): Promise<BindCommandOutcome> {
  const stdoutContext = terminalPresentationContext(request.stdout);
  const stderrContext = terminalPresentationContext(request.stderr);

  let parsed: ParsedBindArguments;
  try {
    parsed = parseBindArguments(request.arguments);
  } catch (error) {
    writeHumanDocument(request.stderr, bindArgumentErrorDiagnostic(error), stderrContext);
    return { exitCode: 1 };
  }

  const interactive = isInteractiveInput(request.input);
  let profile = parsed.profile;
  let hosts = parsed.hosts;
  let prompted = false;

  if (interactive && profile === undefined) {
    let profiles: readonly { id: string }[];
    try {
      profiles = await listProfiles(request.home);
    } catch (error) {
      // Nothing to choose from and nothing to prompt about: the delivered
      // diagnostic (missing configuration, invalid Workspace) explains itself.
      writeHumanDocument(request.stderr, errorDiagnosticDocument(error), stderrContext);
      return { exitCode: 1 };
    }
    if (profiles.length === 0) {
      writeHumanDocument(request.stderr, missingProfileDiagnostic(), stderrContext);
      return { exitCode: 1 };
    }
    prompted = true;
    writeHumanDocument(
      request.stdout,
      [{ kind: "sentence", parts: [PROFILE_EXPLANATION_SENTENCE] }],
      stdoutContext,
    );
    const select = createSelectPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    });
    const answer = await select(PROFILE_QUESTION, profiles.map((entry) => ({
      title: entry.id,
      value: entry.id,
    })));
    if (answer.kind === "cancelled") {
      writeHumanDocument(request.stderr, bindCancelledDocument(), stderrContext);
      return { exitCode: 1 };
    }
    profile = answer.value;
  }

  if (interactive && hosts === undefined) {
    prompted = true;
    const detectedHosts = await detectInstalledHosts(
      request.env === undefined ? {} : { env: request.env },
    );
    const multiSelect = createMultiSelectPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    });
    const answer = await multiSelect(HOST_QUESTION, hostChoices(detectedHosts), { min: 1 });
    if (answer.kind === "cancelled") {
      writeHumanDocument(request.stderr, bindCancelledDocument(), stderrContext);
      return { exitCode: 1 };
    }
    hosts = answer.values;
  }

  if (profile === undefined) {
    writeHumanDocument(request.stderr, missingProfileDiagnostic(), stderrContext);
    return { exitCode: 1 };
  }
  if (hosts === undefined || hosts.length === 0) {
    writeHumanDocument(request.stderr, missingHostsDiagnostic(), stderrContext);
    return { exitCode: 1 };
  }

  const result = await bindProject({
    home: request.home,
    profile,
    hosts,
    ...(parsed.replace ? { replace: true } : {}),
    ...(parsed.project === undefined ? {} : { project: parsed.project }),
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
  });
  writeHumanDocument(request.stdout, bindReceiptDocument(result), stdoutContext);

  if (prompted) {
    // The equivalent fully specified command (DEC-032): the Project path made
    // explicit so re-running it needs no answers again.
    const equivalentArguments = [
      "bind",
      profile,
      parsed.project ?? request.cwd ?? process.cwd(),
      ...hosts.flatMap((host) => ["--host", host]),
      ...(parsed.replace ? ["--replace"] : []),
    ];
    writeHumanDocument(
      request.stdout,
      bindPromptedCommandDocument(equivalentArguments),
      stdoutContext,
    );
  }
  return { exitCode: 0 };
}
