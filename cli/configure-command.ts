/**
 * The `configure profile` command (spec #491 US-009/US-005, DEC-002/
 * DEC-004): one command changes a reusable Profile's Context and Skill
 * membership with explicit flags or, on an interactive human stream,
 * searchable pickers preselected from the current membership. Both modes
 * feed the same validated operation (`configureProfileMembership`); the
 * general confirmation (DEC-004) fires on interactive input unless
 * `--auto-confirm` answers it, and non-interactive invocations without
 * that flag refuse before any write. Configure never installs or updates
 * Projects: the receipt names `update` as the next action.
 */
import type { Readable, Writable } from "node:stream";

import { writeHumanDocument, type PresentationDocument } from "./presentation-document.js";
import { errorDiagnosticDocument } from "./error-wording.js";
import { COMMANDS } from "./command-help.js";
import {
  CONFIGURE_CONFIRMATION_QUESTION,
  CONFIGURE_CONTEXTS_QUESTION,
  CONFIGURE_PROFILE_QUESTION,
  CONFIGURE_SKILLS_QUESTION,
  configureChangingDocument,
  configureConfirmationRequiredDocument,
  configureCurrentMembershipDocument,
  configureDeclinedDocument,
  configureMembershipRequiredDocument,
  configureNameRequiredDocument,
  configurePickerCancelledDocument,
  formatConfigureJson,
  formatConfigureToolErrorJson,
} from "./presentation.js";
import { configureReceiptDocument } from "./receipts.js";
import {
  terminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";
import {
  createTextPrompt,
  createSearchableMultiSelectPrompt,
  createSearchableSelectPrompt,
  isInteractiveInput,
  type PromptClock,
} from "./prompts.js";
import { configureProfileMembership, planConfigureMembership } from "../installer/configure-profile.js";
import { ingestSelectedWorkspace } from "../installer/local-configuration.js";
import { MissingProfileError } from "../installer/profile-selection.js";
import { COMMAND_NAME } from "../installer/version.js";
import type { CommandArg } from "./inline-content.js";

const arg = (value: string): CommandArg => ({ kind: "text", value });

export interface ParsedConfigureArguments {
  readonly name?: string;
  /** Present replaces the Context membership (present-empty empties it). */
  readonly contexts?: readonly string[];
  /** Present replaces the Skill membership (present-empty empties it). */
  readonly skills?: readonly string[];
  readonly autoConfirm: boolean;
  readonly json: boolean;
}

/**
 * Parse `configure profile [name] [--context <id> ...] [--skill <id> ...]
 * [--auto-confirm] [--json]`. Each `--context`/`--skill` flag consumes its
 * following non-flag token (zero or one): repeating a flag appends its
 * values, and a flag with no values explicitly empties that category. An
 * omitted flag leaves its category unchanged; missing membership is
 * reported as absent, not an error, so an interactive invocation collects
 * it through searchable pickers while non-interactive invocations refuse
 * it before any write.
 */
export function parseConfigureArguments(
  arguments_: readonly string[],
): ParsedConfigureArguments {
  // A bare invocation defaults to the only supported object, so interactive
  // humans are guided; anything else names its object explicitly.
  const tokens = arguments_.length === 0 ? ["profile"] : arguments_;
  const object = tokens[0]!;
  if (object !== "profile") {
    throw new Error(
      `configure does not support '${object}'; supported objects: profile`,
    );
  }
  let name: string | undefined;
  const contexts: string[] = [];
  const skills: string[] = [];
  let contextsPresent = false;
  let skillsPresent = false;
  let autoConfirm = false;
  let json = false;
  let index = 1;
  const takeOneValue = (): string[] => {
    if (index + 1 < tokens.length && !tokens[index + 1]!.startsWith("-")) {
      index += 1;
      return [tokens[index]!];
    }
    return [];
  };
  const appendUnique = (selected: string[], values: readonly string[], label: string): void => {
    for (const value of values) {
      if (selected.includes(value)) {
        throw new Error(`configure profile selects ${label} '${value}' more than once`);
      }
      selected.push(value);
    }
  };
  while (index < tokens.length) {
    const argument = tokens[index]!;
    if (argument === "--context") {
      contextsPresent = true;
      appendUnique(contexts, takeOneValue(), "Context Module");
      index += 1;
      continue;
    }
    if (argument === "--skill") {
      skillsPresent = true;
      appendUnique(skills, takeOneValue(), "Skill");
      index += 1;
      continue;
    }
    if (argument === "--auto-confirm") {
      autoConfirm = true;
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`configure profile does not accept argument '${argument}'`);
    }
    if (name !== undefined) {
      throw new Error("configure profile accepts at most one Profile name");
    }
    if (argument.length === 0) {
      throw new Error("configure profile requires a Profile name");
    }
    name = argument;
    index += 1;
  }
  return {
    ...(name === undefined ? {} : { name }),
    ...(contextsPresent ? { contexts } : {}),
    ...(skillsPresent ? { skills } : {}),
    autoConfirm,
    json,
  };
}

export interface ConfigureCommandRequest {
  readonly home: string;
  /** The arguments after the command token. */
  readonly arguments: readonly string[];
  /** Injectable output stream for the receipt and the prompt questions. */
  readonly stdout: Writable & TerminalStream;
  /** Injectable diagnostic stream. */
  readonly stderr: Writable & TerminalStream;
  /** Injectable prompt input stream; TTY evidence is read here (DEC-035). */
  readonly input: Readable;
  readonly clock?: PromptClock;
}

export interface ConfigureCommandOutcome {
  readonly exitCode: 0 | 1;
}

/** The one canonical configure usage line, read from the command-help table. */
const configureCommandSyntax = COMMANDS.find((command) => command.name === "configure")!.syntax;

function configureArgumentErrorDiagnostic(error: unknown): PresentationDocument {
  return errorDiagnosticDocument(error, { usage: configureCommandSyntax });
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The executable fully specified equivalent of one resolved configure:
 * both membership categories listed in full with the confirmation answer
 * explicit, so re-running it needs no second answer. Both categories are
 * always present because the equivalent echoes resolved values, never
 * omitted (unchanged) inputs.
 */
export function fullySpecifiedConfigureArguments(
  profile: string,
  contexts: readonly string[],
  skills: readonly string[],
): readonly CommandArg[] {
  const args: CommandArg[] = [arg("configure"), arg("profile"), arg(profile)];
  for (const context of contexts) args.push(arg("--context"), arg(context));
  if (contexts.length === 0) args.push(arg("--context"));
  for (const skill of skills) args.push(arg("--skill"), arg(skill));
  if (skills.length === 0) args.push(arg("--skill"));
  args.push(arg("--auto-confirm"));
  return args;
}

/** One shell line for the machine payload, quoting only unsafe tokens. */
function equivalentCommandLine(
  profile: string,
  contexts: readonly string[],
  skills: readonly string[],
): string {
  const tokens = [COMMAND_NAME, "configure", "profile", profile];
  for (const context of contexts) tokens.push("--context", context);
  if (contexts.length === 0) tokens.push("--context");
  for (const skill of skills) tokens.push("--skill", skill);
  if (skills.length === 0) tokens.push("--skill");
  tokens.push("--auto-confirm");
  return tokens.map(shellToken).join(" ");
}

function sameSelection(left: readonly string[], right: readonly string[]): boolean {
  const ordered = [...left].sort();
  const other = [...right].sort();
  return ordered.length === other.length && ordered.every((name, index) => name === other[index]);
}

export async function runConfigureCommand(request: ConfigureCommandRequest): Promise<ConfigureCommandOutcome> {
  const stderrContext = terminalPresentationContext(request.stderr);

  let parsed: ParsedConfigureArguments;
  try {
    parsed = parseConfigureArguments(request.arguments);
  } catch (error) {
    // The parse catch runs before `parsed` exists: detect machine mode
    // from the raw arguments so scripts get the versioned envelope
    // instead of prose on stderr. A `--json` token can only be the flag
    // here — every flag value and positional rejects a leading dash.
    const message = error instanceof Error ? error.message : String(error);
    if (request.arguments.includes("--json")) {
      request.stdout.write(formatConfigureToolErrorJson(message));
    } else {
      writeHumanDocument(request.stderr, configureArgumentErrorDiagnostic(error), stderrContext);
    }
    return { exitCode: 1 };
  }

  const fail = (document: PresentationDocument, message: string): ConfigureCommandOutcome => {
    if (parsed.json) {
      request.stdout.write(formatConfigureToolErrorJson(message));
    } else {
      writeHumanDocument(request.stderr, document, stderrContext);
    }
    return { exitCode: 1 };
  };
  const failWith = (error: unknown): ConfigureCommandOutcome => {
    const message = error instanceof Error ? error.message : String(error);
    return fail(errorDiagnosticDocument(error, { usage: configureCommandSyntax }), message);
  };

  const interactive = isInteractiveInput(request.input) && !parsed.json;
  const promptOptions = {
    input: request.input,
    output: request.stdout,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
  };

  // The Workspace boundary resolves once for display and picker choices;
  // the validated write path re-ingests before publishing, so this read
  // never authorizes the write.
  let workspace;
  try {
    workspace = await ingestSelectedWorkspace(request.home);
  } catch (error) {
    return failWith(error);
  }

  let name = parsed.name;
  if (name === undefined) {
    if (!interactive) {
      return fail(
        configureNameRequiredDocument(configureCommandSyntax),
        "configure profile requires a Profile name",
      );
    }
    const profiles = [...workspace.profiles.keys()].sort();
    if (profiles.length === 0) {
      return failWith(
        new Error("configure needs a Profile, but the Workspace has no Profiles yet; create one with apkit new profile"),
      );
    }
    const answer = await createSearchableSelectPrompt(promptOptions)(
      CONFIGURE_PROFILE_QUESTION,
      profiles.map((id) => ({ title: id, value: id })),
    );
    if (answer.kind === "cancelled") {
      if (!parsed.json) {
        writeHumanDocument(request.stderr, configurePickerCancelledDocument(), stderrContext);
      }
      return { exitCode: 1 };
    }
    name = answer.value;
  }

  const existing = workspace.profiles.get(name);
  if (existing === undefined) {
    const available = [...workspace.profiles.keys()].sort();
    return failWith(new MissingProfileError(name, available));
  }

  const stdoutContext = terminalPresentationContext(request.stdout);
  if (!parsed.json) {
    writeHumanDocument(
      request.stdout,
      configureCurrentMembershipDocument({
        profile: name,
        contexts: [...existing.context],
        skills: [...existing.skills],
      }),
      stdoutContext,
    );
  }

  // DEC-002 collect-only-missing: supplied categories skip their picker;
  // each picker preselects the current membership (US-005). A category
  // with no available material resolves to empty without prompting.
  let contexts = parsed.contexts;
  let skills = parsed.skills;
  const availableContexts = [...workspace.contexts.keys()].sort();
  const availableSkills = [...workspace.skills.keys()].sort();
  // An omitted flag leaves its category unchanged (REPLACE per supplied
  // category): only a request changing nothing at all refuses here.
  if (contexts === undefined && skills === undefined && !interactive) {
    return fail(
      configureMembershipRequiredDocument(configureCommandSyntax),
      "configure profile requires at least one of --context <id> or --skill <id>",
    );
  }
  if (interactive && contexts === undefined) {
    if (availableContexts.length === 0) {
      contexts = [];
    } else {
      const current = new Set(existing.context);
      const answer = await createSearchableMultiSelectPrompt(promptOptions)(
        CONFIGURE_CONTEXTS_QUESTION,
        availableContexts.map((id) => ({
          title: id,
          value: id,
          ...(current.has(id) ? { selected: true } : {}),
        })),
      );
      if (answer.kind === "cancelled") {
        writeHumanDocument(request.stderr, configurePickerCancelledDocument(), stderrContext);
        return { exitCode: 1 };
      }
      contexts = [...answer.values];
    }
  }
  if (interactive && skills === undefined) {
    if (availableSkills.length === 0) {
      skills = [];
    } else {
      const current = new Set(existing.skills);
      const answer = await createSearchableMultiSelectPrompt(promptOptions)(
        CONFIGURE_SKILLS_QUESTION,
        availableSkills.map((id) => ({
          title: id,
          value: id,
          ...(current.has(id) ? { selected: true } : {}),
        })),
      );
      if (answer.kind === "cancelled") {
        writeHumanDocument(request.stderr, configurePickerCancelledDocument(), stderrContext);
        return { exitCode: 1 };
      }
      skills = [...answer.values];
    }
  }
  // Omitted categories stay undefined for the write path so an untouched
  // category keeps authored order. Equivalents and confirmation still echo
  // the recorded membership for that category.
  const requestedContexts = contexts;
  const requestedSkills = skills;
  const resolvedContexts = requestedContexts ?? [...existing.context];
  const resolvedSkills = requestedSkills ?? [...existing.skills];

  // A request that matches the recorded membership changes nothing: report
  // it honestly without prompting or writing.
  if (
    sameSelection(existing.context, resolvedContexts) &&
    sameSelection(existing.skills, resolvedSkills)
  ) {
    const equivalent = fullySpecifiedConfigureArguments(name, resolvedContexts, resolvedSkills);
    if (parsed.json) {
      request.stdout.write(formatConfigureJson({
        profile: name,
        changed: false,
        previousContexts: [...existing.context],
        previousSkills: [...existing.skills],
        contexts: [...resolvedContexts],
        skills: [...resolvedSkills],
        equivalent: equivalentCommandLine(name, resolvedContexts, resolvedSkills),
      }));
    } else {
      writeHumanDocument(
        request.stdout,
        configureReceiptDocument({
          profile: name,
          previousContexts: [...existing.context],
          previousSkills: [...existing.skills],
          contexts: [...resolvedContexts],
          skills: [...resolvedSkills],
          changed: false,
          equivalent,
        }),
        stdoutContext,
      );
    }
    return { exitCode: 0 };
  }

  // Preview validation before the confirmation gate (mirroring install's
  // preview-then-confirm): typos surface before any prompt, with the same
  // typed facts the write path enforces. Picker-resolved values are valid
  // by construction; only supplied values can fail here.
  try {
    planConfigureMembership({
      profile: name,
      file: existing.path,
      existingContexts: existing.context,
      existingSkills: existing.skills,
      availableContexts: new Set(workspace.contexts.keys()),
      availableSkills: new Set(workspace.skills.keys()),
      ...(requestedContexts === undefined ? {} : { contexts: requestedContexts }),
      ...(requestedSkills === undefined ? {} : { skills: requestedSkills }),
    });
  } catch (error) {
    return failWith(error);
  }

  if (!parsed.json) {
    writeHumanDocument(
      request.stdout,
      configureChangingDocument({
        profile: name,
        previousContexts: [...existing.context],
        previousSkills: [...existing.skills],
        contexts: [...resolvedContexts],
        skills: [...resolvedSkills],
      }),
      stdoutContext,
    );
  }

  // DEC-004 general confirmation: interactive input confirms before any
  // write unless `--auto-confirm` answers it; non-interactive invocations
  // without that flag refuse with the runnable equivalent.
  const equivalent = fullySpecifiedConfigureArguments(name, resolvedContexts, resolvedSkills);
  if (!parsed.autoConfirm && (!interactive || parsed.json)) {
    return fail(
      configureConfirmationRequiredDocument(equivalent),
      "configure needs explicit confirmation before any write",
    );
  }
  if (!parsed.autoConfirm) {
    const prompt = createTextPrompt({
      input: request.input,
      output: request.stdout,
      ...(request.clock === undefined ? {} : { clock: request.clock }),
    });
    const answer = await prompt(CONFIGURE_CONFIRMATION_QUESTION);
    if (answer.kind === "cancelled") {
      writeHumanDocument(
        request.stderr,
        configureDeclinedDocument("cancelled", equivalent),
        stderrContext,
      );
      return { exitCode: 1 };
    }
    const normalized = answer.value.trim().toLowerCase();
    if (normalized !== "y" && normalized !== "yes") {
      writeHumanDocument(
        request.stderr,
        configureDeclinedDocument(normalized === "" ? "default" : "declined", equivalent),
        stderrContext,
      );
      return { exitCode: 1 };
    }
  }

  let result;
  try {
    result = await configureProfileMembership({
      home: request.home,
      profile: name,
      ...(requestedContexts === undefined ? {} : { contexts: [...requestedContexts] }),
      ...(requestedSkills === undefined ? {} : { skills: [...requestedSkills] }),
    });
  } catch (error) {
    return failWith(error);
  }

  if (parsed.json) {
    request.stdout.write(formatConfigureJson({
      profile: result.id,
      changed: result.changed,
      previousContexts: [...result.previousContexts],
      previousSkills: [...result.previousSkills],
      contexts: [...result.contexts],
      skills: [...result.skills],
      equivalent: equivalentCommandLine(result.id, result.contexts, result.skills),
    }));
  } else {
    writeHumanDocument(
      request.stdout,
      configureReceiptDocument({
        profile: result.id,
        previousContexts: [...result.previousContexts],
        previousSkills: [...result.previousSkills],
        contexts: [...result.contexts],
        skills: [...result.skills],
        changed: result.changed,
        equivalent,
      }),
      stdoutContext,
    );
  }
  return { exitCode: 0 };
}
