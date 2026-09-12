#!/usr/bin/env node

import { homedir } from "node:os";
import type { WriteStream } from "node:tty";

import {
  agentGuide,
  focusedGuideDocument,
  guideFileDocument,
  guideIndexDocument,
  humanGuide,
  type GuideTopic,
} from "./guides.js";
import {
  diagnosticDocument,
} from "./diagnostics.js";
import {
  commandHelpDocument,
  machineHelpDocument,
  rootHelpDocument,
} from "./command-help.js";
import {
  newArtifactReceiptDocument,
  type NewArtifactReceiptInput,
} from "./receipts.js";
import {
  DEFAULT_VIEW_LEXICON,
  formatLifecycleJson,
  formatLifecycleToolErrorJson,
  lifecycleStatusDocument,
  formatInfoJson,
  formatInfoToolErrorJson,
  formatHostInventoryJson,
  formatProjectInventoryJson,
  formatProjectInventoryToolErrorJson,
  formatProfileInventoryJson,
  formatProfileInventoryToolErrorJson,
  formatTemporaryInventoryJson,
  formatTemporaryInventoryToolErrorJson,
  hostInventoryDocument,
  infoDocument,
  bareInvocationDocument,
  inventoryIndexDocument,
  formatTemporaryInstallationBlockedJson,
  formatTemporaryInstallationJson,
  formatTemporaryInstallationToolErrorJson,
  lifecycleExitCode,
  machineInventoryIndexDocument,
  profileInventoryDocument,
  projectInventoryDocument,
  temporaryBlockedMessagesDocument,
  temporaryInstallationDocument,
  temporaryInventoryDocument,
  type LifecycleCommand,
  validationResultDocument,
} from "./presentation.js";
import { runApplyCommand } from "./apply-command.js";
import { runConfigureCommand } from "./configure-command.js";
import { runInstallCommand } from "./install-command.js";
import { runUninstallCommand } from "./uninstall-command.js";
import { runInitCommand } from "./init-command.js";
import {
  renderPresentationDocument,
  writeHumanDocument,
  type PresentationDocument,
  type PresentationRenderOptions,
} from "./presentation-document.js";
import { commandPart, flatInlineText, type CommandArg, type InlineContent } from "./inline-content.js";
import { nearestName } from "./nearest-match.js";

/** One carried command argument. */
const arg = (value: string): CommandArg => ({ kind: "text", value });
import { applicationInfoLocations, readApplicationInfo } from "../installer/info.js";
import { createSkill } from "../installer/create-skill.js";
import { createContextModule } from "../installer/create-context-module.js";
import { createProfile } from "../installer/create-profile.js";
import { openWorkspace } from "../installer/open-workspace.js";
import {
  ProjectTargetError,
  type ProjectBindingSelection,
  type ProjectSelectionFilter,
} from "../installer/local-configuration.js";
import { StateReadFailureError } from "../installer/installation-state.js";
import {
  statusApplication,
  validateApplication,
} from "../installer/commands.js";
import {
  installTemporaryProfile,
  removeTemporaryProfile,
  TEMPORARY_INSTALLATION_HOSTS,
  TemporaryInstallationBlockedError,
  TemporaryInstallationRecoverableError,
} from "../installer/temporary-installation.js";
import { COMMAND_NAME, ENGINE_VERSION } from "../installer/version.js";
import {
  CliArgumentError,
  errorDiagnosticDocument,
  errorDiagnosticParts,
  formatError,
} from "./error-wording.js";
import {
  listHosts,
  listProfiles,
  listProjectBindings,
  listTemporaryInstallations,
} from "../installer/inventory.js";
import { MissingProfileError } from "../installer/profile-selection.js";
import {
  COMMAND_HELP_ALIASES,
  COMMANDS,
  COMMAND_GROUPS,
  defaultCommands,
  findMachineCommand,
  HELP_COMMAND,
  machineCommands,
  ROOT_HELP_ALIASES,
  VERSION_ALIASES,
  type CommandHelp,
} from "./command-help.js";
import {
  inventoryTopicNames,
  isInventoryTopic,
  isMachineInventoryTopic,
  machineInventoryTopicNames,
  type InventoryTopic,
  type MachineInventoryTopic,
} from "./inventory-topics.js";
import {
  pageGuidanceDocument,
  shouldPageGuidance,
} from "./pager.js";
import {
  agentProfileKitWordmark,
  terminalPresentationContext,
  type TerminalPresentationContext,
} from "./terminal-presentation.js";
import {
  beginDelayedProgress,
  STATUS_PROGRESS_LABEL,
} from "./progress.js";

/**
 * One trusted terminal-presentation context per human stream, read once at the
 * CLI boundary (DEC-001). Every human view receives these instead of reading
 * terminal state independently; machine surfaces never touch them.
 */
const stdoutPresentationContext = terminalPresentationContext(process.stdout);
const stderrPresentationContext = terminalPresentationContext(process.stderr);

/**
 * The interactive wordmark authored at the CLI boundary — the one place allowed
 * to read the terminal context (DEC-012).
 */
function rootWordmark(context: TerminalPresentationContext): readonly string[] {
  return context.interactive ? agentProfileKitWordmark(context.width) : [];
}

/**
 * Human output rendered from a presentation document (DEC-001): the one
 * boundary render. The renderer joins node lines without a trailing newline,
 * so the document receives exactly one terminating newline and a view ending
 * in a blank line is never doubled. Render environment is needed by views whose
 * location display scope resolves against the CLI's home.
 */
/**
 * Guidance output (US-050, DEC-029): identical to writeHumanDocument when the
 * output is redirected or short; on an interactive terminal whose height is
 * known, long guidance is delivered through the configured pager (cli/pager).
 * The exit code is unchanged unless the user interrupted a paging session.
 */
async function writeGuidanceDocument(
  stream: WriteStream,
  document: PresentationDocument,
  context: TerminalPresentationContext,
  environment: PresentationRenderOptions = {},
): Promise<void> {
  const rendered = renderPresentationDocument(document, context, environment);
  const text = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  const exitCode = await pageGuidanceDocument({
    text,
    stream,
    writeAdvisory: (advisory) => {
      writeHumanDocument(process.stderr, advisory, stderrPresentationContext);
    },
    shouldPage: shouldPageGuidance(context, text),
  });
  if (exitCode !== 0) process.exitCode = exitCode;
}

/** The carried syntax of one named command, for diagnostic usage nodes. */
function commandSyntax(name: string): string {
  return findCommand(name).syntax;
}

/**
 * The human diagnostic for one lifecycle tool error: structured diagnostic
 * with usage guidance when the error names a Project target (DEC-014).
 */
function lifecycleToolErrorDiagnostic(
  command: LifecycleCommand,
  error: unknown,
): PresentationDocument {
  return errorDiagnosticDocument(
    error,
    error instanceof ProjectTargetError ? { usage: commandSyntax(command) } : undefined,
  );
}

/**
 * Resolves one command by its display token: a bare name for default commands,
 * or a `machine <name>` token for machine-namespaced commands (DEC-019).
 */
function findCommand(token: string): CommandHelp {
  const [namespace, ...rest] = token.split(" ");
  const command = namespace === MACHINE_NAMESPACE && rest.length === 1
    ? findMachineCommand(rest[0]!)
    : COMMANDS.find((candidate) => candidate.name === token && candidate.namespace === undefined);
  if (!command) throw new Error(`no canonical help for command '${token}'`);
  return command;
}

type FocusedHelpRequest =
  | { readonly kind: "root" }
  | { readonly kind: "machine" }
  | { readonly kind: "command"; readonly command: CommandHelp }
  | { readonly kind: "removedTemporary"; readonly name: string }
  | { readonly kind: "removedPublic"; readonly from: string; readonly to: string }
  | { readonly kind: "unknown"; readonly token: string };

function removedTemporaryRequest(token: string): FocusedHelpRequest | undefined {
  return REMOVED_TEMPORARY_COMMANDS.some((name) => name === token)
    ? { kind: "removedTemporary", name: token }
    : undefined;
}

function removedPublicCommandRequest(token: string): FocusedHelpRequest | undefined {
  const replaced = REMOVED_PUBLIC_COMMANDS.find((entry) => entry.from === token);
  return replaced === undefined
    ? undefined
    : { kind: "removedPublic", from: replaced.from, to: replaced.to };
}

const MACHINE_NAMESPACE = "machine" as const;

/** Top-level temporary installation command names removed by DEC-019. */
const REMOVED_TEMPORARY_COMMANDS = ["install-temp", "remove-temp"] as const;

/** Public commands replaced by a new name (DEC-001): retired without a compatibility shim. */
const REMOVED_PUBLIC_COMMANDS = [{ from: "apply", to: "update" }, { from: "bind", to: "install" }, { from: "unbind", to: "uninstall" }] as const;

function focusedHelpRequest(arguments_: readonly string[]): FocusedHelpRequest | undefined {
  if (
    arguments_.length === 4 &&
    arguments_[0] === HELP_COMMAND &&
    arguments_[1] === MACHINE_NAMESPACE &&
    COMMAND_HELP_ALIASES.some((alias) => alias === arguments_[3])
  ) {
    const machineCommand = findMachineCommand(arguments_[2]!);
    return machineCommand === undefined
      ? { kind: "unknown", token: arguments_[2]! }
      : { kind: "command", command: machineCommand };
  }
  if (arguments_.length === 3 && arguments_[0] === HELP_COMMAND) {
    const commandToken = arguments_[1]!;
    if (commandToken === MACHINE_NAMESPACE) {
      const machineCommand = findMachineCommand(arguments_[2]!);
      if (machineCommand !== undefined) return { kind: "command", command: machineCommand };
      return { kind: "unknown", token: arguments_[2]! };
    }
    const removed = removedTemporaryRequest(commandToken) ?? removedPublicCommandRequest(commandToken);
    if (removed !== undefined) return removed;
    if (!COMMAND_HELP_ALIASES.some((alias) => alias === arguments_[2])) return undefined;
    const command = COMMANDS.find((candidate) => candidate.name === commandToken);
    return command === undefined
      ? { kind: "unknown", token: commandToken }
      : { kind: "command", command };
  }
  if (arguments_.length !== 2) return undefined;
  const first = arguments_[0]!;
  const second = arguments_[1]!;
  if (first === HELP_COMMAND) {
    if (
      ROOT_HELP_ALIASES.some((alias) => alias === second) ||
      VERSION_ALIASES.some((alias) => alias === second)
    ) {
      return { kind: "root" };
    }
    if (second === MACHINE_NAMESPACE) {
      return { kind: "machine" };
    }
    const removed = removedTemporaryRequest(second) ?? removedPublicCommandRequest(second);
    if (removed !== undefined) return removed;
    const command = COMMANDS.find(
      (candidate) => candidate.name === second && candidate.namespace === undefined,
    );
    return command === undefined
      ? { kind: "unknown", token: second }
      : { kind: "command", command };
  }
  if (first === MACHINE_NAMESPACE) {
    if (ROOT_HELP_ALIASES.some((alias) => alias === second)) {
      return { kind: "machine" };
    }
    return undefined;
  }
  const removed = removedTemporaryRequest(first) ?? removedPublicCommandRequest(first);
  if (removed !== undefined) return removed;
  const command = COMMANDS.find(
    (candidate) => candidate.name === first && candidate.namespace === undefined,
  );
  if (command !== undefined && COMMAND_HELP_ALIASES.some((alias) => alias === second)) {
    return { kind: "command", command };
  }
  if (COMMAND_HELP_ALIASES.some((alias) => alias === second)) {
    return { kind: "unknown", token: first };
  }
  return undefined;
}

/** Focused help inside the machine namespace: `machine [<name>] --help`. */
function focusedMachineHelpRequest(arguments_: readonly string[]):
  | { readonly kind: "command"; readonly command: CommandHelp }
  | undefined {
  const [first, second, third] = arguments_;
  if (first !== undefined && second !== undefined && COMMAND_HELP_ALIASES.some((alias) => alias === second)) {
    const command = findMachineCommand(first);
    return command === undefined ? undefined : { kind: "command", command };
  }
  if (
    first === HELP_COMMAND &&
    second !== undefined &&
    (third === undefined || COMMAND_HELP_ALIASES.some((alias) => alias === third))
  ) {
    const command = findMachineCommand(second);
    return command === undefined ? undefined : { kind: "command", command };
  }
  return undefined;
}

function suggestedCommand(unknown: string): string | undefined {
  return nearestName(unknown, defaultCommands().map((command) => command.name));
}

function sanitizeCommandToken(token: string): string {
  return token.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replaceAll("'", "\\'");
}

/** The diagnostic for one public command replaced by a new name (DEC-001). */
function removedPublicCommandDiagnostic(from: string, to: string): PresentationDocument {
  return diagnosticDocument({
    happened: [`${from} was replaced by ${to}`],
    whatToType: [["Use ", commandPart(COMMAND_NAME, [arg(to)])]],
  });
}

/** The diagnostic for one command removed behind the machine namespace (DEC-019). */
function removedNamespaceDiagnostic(name: string): PresentationDocument {
  return diagnosticDocument({
    happened: [`${name} moved behind the machine namespace`],
    whatToType: [["Use ", commandPart(COMMAND_NAME, [arg("machine"), arg(name)])]],
  });
}

function unknownCommandDiagnostic(unknown: string): PresentationDocument {
  const safeUnknown = sanitizeCommandToken(unknown);
  const suggestion = suggestedCommand(safeUnknown);
  return diagnosticDocument({
    happened: [`unknown command '${safeUnknown}'`],
    whatToType: [
      ...(suggestion === undefined
        ? []
        : [["Did you mean: ", commandPart(COMMAND_NAME, [arg(suggestion)]), "?"]]),
      [],
      ["Run ", commandPart(COMMAND_NAME, [arg("--help")]), " for available commands."],
    ],
  });
}

/** Unknown-command help inside the machine-facing namespace (DEC-019). */
function unknownMachineCommandDiagnostic(unknown: string): PresentationDocument {
  const safeUnknown = sanitizeCommandToken(unknown);
  const suggestion = nearestName(safeUnknown, machineCommands().map((command) => command.name));
  return diagnosticDocument({
    happened: [`unknown machine command '${safeUnknown}'`],
    whatToType: [
      ...(suggestion === undefined
        ? []
        : [["Did you mean: ", commandPart(COMMAND_NAME, [arg("machine"), arg(suggestion)]), "?"]]),
      [],
      [
        "Run ",
        commandPart(COMMAND_NAME, [arg("machine"), arg("--help")]),
        " for available machine commands.",
      ],
    ],
  });
}

/** Runs a command-argument parser and, on failure, reports the error with that command's usage. */
function parseOrExit<T>(command: string, parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    writeHumanDocument(
      process.stderr,
      errorDiagnosticDocument(error, { usage: commandSyntax(command) }),
      stderrPresentationContext,
    );
    process.exitCode = 1;
    return undefined;
  }
}

function positionalArgument(command: string, description: string, value: string): string {
  if (value.startsWith("-")) {
    throw new Error(`${command} does not accept flag '${value}' as ${description}`);
  }
  return value;
}

function parseInstallTempArguments(
  arguments_: readonly string[],
  label: string,
): {
  readonly host: string;
  readonly json: boolean;
  readonly profile: string;
  readonly project: string;
} {
  if (arguments_.length < 2) {
    throw new Error(`${label} requires a Profile name and a Project path`);
  }
  const profile = positionalArgument(label, "a Profile", arguments_[0]!);
  const project = positionalArgument(label, "a Project path", arguments_[1]!);
  let host: string | undefined;
  let json = false;
  let index = 2;
  while (index < arguments_.length) {
    const flag = arguments_[index]!;
    if (flag === "--host") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${label} --host requires an Agent Host name`);
      }
      if (host !== undefined) {
        throw new Error(`${label} accepts exactly one --host value`);
      }
      host = value;
      index += 2;
      continue;
    }
    if (flag === "--json") {
      json = true;
      index += 1;
      continue;
    }
    throw new Error(`${label} does not accept argument '${flag}'`);
  }
  if (host === undefined) {
    throw new Error(
      `${label} requires --host <host>; temporary installation supports: ${TEMPORARY_INSTALLATION_HOSTS.join(", ")}`,
    );
  }
  return { host, json, profile, project };
}

function parseRemoveTempArguments(
  arguments_: readonly string[],
  label: string,
): {
  readonly json: boolean;
  readonly temporaryInstallationId: string;
} {
  if (arguments_.length === 0) {
    throw new Error(`${label} requires a temporary installation identity`);
  }
  const temporaryInstallationId = positionalArgument(
    label,
    "a temporary installation identity",
    arguments_[0]!,
  );
  let json = false;
  for (const argument of arguments_.slice(1)) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    throw new Error(`${label} does not accept argument '${argument}'`);
  }
  return { json, temporaryInstallationId };
}

function parseOptionalFlags(
  command: string,
  arguments_: readonly string[],
  flags: readonly string[],
): Readonly<Record<string, boolean>> {
  const accepted = new Set(flags);
  const present = Object.fromEntries(flags.map((flag) => [flag, false])) as Record<string, boolean>;
  for (const argument of arguments_) {
    if (!accepted.has(argument)) {
      throw new Error(`${command} does not accept argument '${argument}'`);
    }
    present[argument] = true;
  }
  return present;
}

function parseOptionalFlag(command: string, arguments_: readonly string[], flag: string): boolean {
  return parseOptionalFlags(command, arguments_, [flag])[flag] === true;
}

function parseGuideArguments(arguments_: readonly string[]):
  | { readonly kind: "index" }
  | { readonly kind: "full" }
  | { readonly kind: "agent" }
  | { readonly kind: "topic"; readonly topic: GuideTopic } {
  if (arguments_.length === 0) return { kind: "index" };

  const route = arguments_[0]!;
  if (arguments_.length > 1) {
    if (route === "profile" || route === "context" || route === "skill") {
      throw new Error(
        `guide does not accept argument '${arguments_[1]}' after topic '${route}'`,
      );
    }
    throw new Error(`guide does not accept argument '${arguments_[1]}' after '${route}'`);
  }
  if (route === "profile" || route === "context" || route === "skill") {
    return { kind: "topic", topic: route };
  }
  if (route === "--full") return { kind: "full" };
  if (route === "--agent") return { kind: "agent" };
  throw new Error(`guide does not accept argument '${route}'`);
}

/**
 * Parse `apkit new` (DEC-026): one artifact kind plus a name; Profile creation
 * takes repeatable explicit `--context`/`--skill` selections of existing
 * material. Never prompts and never opens an editor, on any input stream
 * (US-055).
 */
function parseNewArguments(
  arguments_: readonly string[],
):
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "context"; readonly name: string }
  | {
      readonly kind: "profile";
      readonly name: string;
      readonly contexts: readonly string[];
      readonly skills: readonly string[];
    } {
  if (arguments_.length === 0) {
    throw new Error("new requires an artifact kind; supported kinds: skill, context, profile");
  }
  const kind = arguments_[0]!;
  if (kind !== "skill" && kind !== "context" && kind !== "profile") {
    throw new Error(
      `new does not support kind '${sanitizeCommandToken(kind)}'; supported kinds: skill, context, profile`,
    );
  }
  if (arguments_.length < 2 || arguments_[1]!.startsWith("--")) {
    throw new Error(
      kind === "context"
        ? "new context requires a Context Module name"
        : kind === "profile"
          ? "new profile requires a Profile name"
          : "new skill requires a Skill name",
    );
  }
  if (kind === "profile") {
    const name = positionalArgument("new profile", "a Profile name", arguments_[1]!);
    const selections = parseNewProfileSelections(arguments_.slice(2));
    return { kind, name, ...selections };
  }
  if (arguments_.length > 2) {
    throw new Error(`new ${kind} does not accept argument '${arguments_[2]}'`);
  }
  const name = positionalArgument(`new ${kind}`, kind === "context" ? "a Context Module name" : "a Skill name", arguments_[1]!);
  return { kind, name };
}

/**
 * Parse the Profile creation selections: repeatable `--context <id>` and
 * `--skill <id>` flags, each naming existing Workspace material. A name
 * repeated within one category is an argument error; resolution against the
 * Workspace boundary happens in the Installer creation path (US-045).
 */
function parseNewProfileSelections(
  arguments_: readonly string[],
): { readonly contexts: readonly string[]; readonly skills: readonly string[] } {
  const contexts: string[] = [];
  const skills: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index]!;
    const selectsContext = flag === "--context";
    if (!selectsContext && flag !== "--skill") {
      throw new Error(`new profile does not accept argument '${flag}'`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(`new profile requires a value for '${flag}'`);
    }
    index += 1;
    const selected = selectsContext ? contexts : skills;
    if (selected.includes(value)) {
      throw new Error(
        `new profile selects ${selectsContext ? "Context Module" : "Skill"} '${sanitizeCommandToken(value)}' more than once`,
      );
    }
    selected.push(value);
  }
  return { contexts, skills };
}

function parseNoArguments(command: string, arguments_: readonly string[]): { readonly valid: true } {
  if (arguments_.length > 0) {
    throw new Error(`${command} does not accept argument '${arguments_[0]}'`);
  }
  return { valid: true };
}

function parseInfoArguments(arguments_: readonly string[]): { readonly json: boolean } {
  return { json: parseOptionalFlag("info", arguments_, "--json") };
}

function parseListArguments(
  arguments_: readonly string[],
):
  | { readonly kind: "index" }
  | { readonly json: boolean; readonly kind: "topic"; readonly topic: InventoryTopic } {
  if (arguments_.length === 0) return { kind: "index" };
  const topic = positionalArgument("list", "an inventory topic", arguments_[0]!);
  if (isMachineInventoryTopic(topic)) {
    throw new CliArgumentError([
      commandPart(COMMAND_NAME, [arg("list"), arg(topic)]),
      " moved behind the machine namespace; use ",
      commandPart(COMMAND_NAME, [arg("machine"), arg("list"), arg(topic)]),
    ]);
  }
  if (!isInventoryTopic(topic)) {
    throw new Error(
      `list does not support topic '${topic}'; available topics: ${inventoryTopicNames().join(", ")}`,
    );
  }
  return {
    kind: "topic",
    json: parseOptionalFlag("list", arguments_.slice(1), "--json"),
    topic,
  };
}

function parseMachineListArguments(
  arguments_: readonly string[],
):
  | { readonly kind: "index" }
  | { readonly json: boolean; readonly kind: "topic"; readonly topic: MachineInventoryTopic } {
  if (arguments_.length === 0) return { kind: "index" };
  const topic = positionalArgument("machine list", "an inventory topic", arguments_[0]!);
  if (!isMachineInventoryTopic(topic)) {
    throw new Error(
      `machine list does not support topic '${topic}'; available topics: ${machineInventoryTopicNames().join(", ")}`,
    );
  }
  return {
    kind: "topic",
    json: parseOptionalFlag("machine list", arguments_.slice(1), "--json"),
    topic,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled inventory topic: ${String(value)}`);
}

interface ParsedLifecycleArguments {
  readonly json: boolean;
  readonly selection: ProjectBindingSelection;
  readonly verbose: boolean;
  /** The update replacement-answering flag (DEC-005); always false for status. */
  readonly replaceChanged: boolean;
  /** The update deletion-answering flag (DEC-005); always false for status. */
  readonly removeChanged: boolean;
}

function parseLifecycleArguments(
  command: "update" | "status",
  arguments_: readonly string[],
): ParsedLifecycleArguments {
  let all = false;
  let blocked = false;
  let here = false;
  let json = false;
  let project: string | undefined;
  let projectFlag = false;
  let stale = false;
  let verbose = false;
  // The changed-file answering flags exist only on update (DEC-005); status
  // rejects them through the shared unknown-argument error below. Update has
  // no general confirmation (DEC-004), so `--auto-confirm` is not accepted
  // here and stays inert toward changed-file consent by construction.
  const replaceChangedAllowed = command === "update";
  let removeChanged = false;
  let replaceChanged = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }
    if (replaceChangedAllowed && argument === "--replace-changed") {
      replaceChanged = true;
      continue;
    }
    if (replaceChangedAllowed && argument === "--remove-changed") {
      removeChanged = true;
      continue;
    }
    if (argument === "--blockers-only") {
      throw new Error(
        `${command} --blockers-only was removed; use --blocked to select Projects with Project-scoped Blockers, or run without a filter for the complete fleet`,
      );
    }
    if (argument === "--stale") {
      stale = true;
      continue;
    }
    if (argument === "--blocked") {
      blocked = true;
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--here") {
      here = true;
      continue;
    }
    if (argument === "--project") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${command} --project requires a Project path`);
      }
      if (project !== undefined) {
        throw new Error(`${command} --project cannot be combined with a Project path`);
      }
      project = value;
      projectFlag = true;
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) {
      if (project !== undefined) {
        throw new Error(
          projectFlag
            ? `${command} --project cannot be combined with a Project path`
            : `${command} accepts at most one Project path`,
        );
      }
      project = argument;
      continue;
    }
    throw new Error(`${command} does not accept argument '${argument}'`);
  }
  if (projectFlag && here) {
    throw new Error(`${command} --project cannot be combined with --here`);
  }
  if (projectFlag && all) {
    throw new Error(`${command} --project cannot be combined with --all`);
  }
  if (all && project !== undefined) {
    throw new Error(`${command} --all cannot be combined with a Project path`);
  }
  if (here && all) {
    throw new Error(`${command} --here cannot be combined with --all`);
  }
  if (here && project !== undefined) {
    throw new Error(`${command} --here cannot be combined with a Project path`);
  }
  if (stale && blocked) {
    throw new Error(
      `${command} --stale and --blocked select different Projects; choose one, or run without a filter for the complete fleet`,
    );
  }
  const filter: ProjectSelectionFilter | undefined = stale ? "stale" : blocked ? "blocked" : undefined;
  const selection: ProjectBindingSelection = here
    ? {
        command,
        kind: "project",
        match: "containing",
        target: process.cwd(),
        ...(filter === undefined ? {} : { filter }),
      }
    : project !== undefined
    ? {
        command,
        kind: "project",
        match: "exact",
        target: project,
        ...(filter === undefined ? {} : { filter }),
      }
    : filter === undefined
    ? { kind: "all" }
    : { kind: "all", filter };

  return {
    json,
    removeChanged,
    replaceChanged,
    selection,
    verbose,
  };
}

/**
 * Delayed ephemeral progress for one interactive long-running inspection.
 * Only interactive human views construct a reporter, so redirected output,
 * JSON, and non-interactive errors can never contain progress bytes.
 */
function interactiveProgress(
  context: TerminalPresentationContext,
  json: boolean,
  operation: string,
): { readonly finish: () => void } | undefined {
  return context.interactive && !json
    ? beginDelayedProgress({ operation, stream: process.stdout })
    : undefined;
}

/**
 * The bare-invocation entry screen (US-032, DEC-020): current setup state and
 * a short task-relevant command list instead of the full manual. Strictly
 * read-only — the fleet facts come from the status plan (default fleet scope,
 * issue #436); nothing on the machine is written.
 */
async function runBareInvocation(home: string): Promise<void> {
  try {
    const info = await readApplicationInfo(home);
    const report = info.configurationState === "current"
      ? await statusApplication(home)
      : undefined;
    writeHumanDocument(
      process.stdout,
      bareInvocationDocument({
        info,
        ...(report === undefined ? {} : { report }),
        wordmark: rootWordmark(stdoutPresentationContext),
      }),
      stdoutPresentationContext,
    );
  } catch (error) {
    writeHumanDocument(process.stderr, errorDiagnosticDocument(error), stderrPresentationContext);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const home = homedir();

  if (arguments_.length === 1 && VERSION_ALIASES.some((alias) => alias === arguments_[0])) {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return;
  }
  if (arguments_.length === 0) {
    await runBareInvocation(home);
    return;
  }
  if (arguments_.length === 1 && ROOT_HELP_ALIASES.some((alias) => alias === arguments_[0])) {
    const context = stdoutPresentationContext;
    writeHumanDocument(process.stdout, rootHelpDocument(rootWordmark(context)), stdoutPresentationContext);
    return;
  }
  const focusedHelp = focusedHelpRequest(arguments_);
  if (focusedHelp?.kind === "root") {
    writeHumanDocument(
      process.stdout,
      rootHelpDocument(rootWordmark(stdoutPresentationContext)),
      stdoutPresentationContext,
    );
    return;
  }
  if (focusedHelp?.kind === "machine") {
    writeHumanDocument(process.stdout, machineHelpDocument(), stdoutPresentationContext);
    return;
  }
  if (focusedHelp?.kind === "removedTemporary") {
    writeHumanDocument(
      process.stderr,
      removedNamespaceDiagnostic(focusedHelp.name),
      stderrPresentationContext,
    );
    process.exitCode = 1;
    return;
  }
  if (focusedHelp?.kind === "removedPublic") {
    writeHumanDocument(
      process.stderr,
      removedPublicCommandDiagnostic(focusedHelp.from, focusedHelp.to),
      stderrPresentationContext,
    );
    process.exitCode = 1;
    return;
  }
  if (focusedHelp?.kind === "command") {
    writeHumanDocument(process.stdout, commandHelpDocument(focusedHelp.command), stdoutPresentationContext);
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "guide") {
    const parsed = parseOrExit("guide", () => parseGuideArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    if (parsed.kind === "index") {
      await writeGuidanceDocument(process.stdout, guideIndexDocument(), stdoutPresentationContext);
    } else if (parsed.kind === "topic") {
      try {
        const info = await readApplicationInfo(home);
        await writeGuidanceDocument(
          process.stdout,
          focusedGuideDocument(parsed.topic, {
            configurationState: info.configurationState,
            workspace: info.workspace,
          }),
          stdoutPresentationContext,
        );
      } catch (error) {
        writeHumanDocument(
          process.stderr,
          errorDiagnosticDocument(error),
          stderrPresentationContext,
        );
        process.exitCode = 1;
      }
    } else if (parsed.kind === "agent") {
      await writeGuidanceDocument(process.stdout, guideFileDocument(await agentGuide()), stdoutPresentationContext);
    } else {
      await writeGuidanceDocument(process.stdout, guideFileDocument(await humanGuide()), stdoutPresentationContext);
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "init") {
    const outcome = await runInitCommand({
      home,
      arguments: arguments_.slice(1),
      stdout: process.stdout,
      stderr: process.stderr,
      input: process.stdin,
    });
    process.exitCode = outcome.exitCode;
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "new") {
    const parsed = parseOrExit("new", () => parseNewArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      let receipt: NewArtifactReceiptInput;
      if (parsed.kind === "skill") {
        const result = await createSkill({ home, name: parsed.name });
        receipt = { artifactType: "Skill", id: result.id, path: result.path };
      } else if (parsed.kind === "context") {
        const result = await createContextModule({ home, name: parsed.name });
        receipt = { artifactType: "Context Module", id: result.id, path: result.path };
      } else {
        const result = await createProfile({
          home,
          name: parsed.name,
          contexts: parsed.contexts,
          skills: parsed.skills,
        });
        receipt = {
          artifactType: "Profile",
          id: result.id,
          path: result.path,
          selectedContexts: parsed.contexts,
          selectedSkills: parsed.skills,
          availableContexts: result.availableContexts,
          availableSkills: result.availableSkills,
        };
      }
      writeHumanDocument(
        process.stdout,
        newArtifactReceiptDocument(receipt),
        stdoutPresentationContext,
      );
    } catch (error) {
      writeHumanDocument(
        process.stderr,
        errorDiagnosticDocument(error),
        stderrPresentationContext,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "configure") {
    const outcome = await runConfigureCommand({
      home,
      arguments: arguments_.slice(1),
      stdout: process.stdout,
      stderr: process.stderr,
      input: process.stdin,
    });
    process.exitCode = outcome.exitCode;
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "open") {
    const parsed = parseOrExit("open", () => parseNoArguments("open", arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      await openWorkspace({ home });
    } catch (error) {
      writeHumanDocument(
        process.stderr,
        errorDiagnosticDocument(error),
        stderrPresentationContext,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "install") {
    const outcome = await runInstallCommand({
      home,
      arguments: arguments_.slice(1),
      stdout: process.stdout,
      stderr: process.stderr,
      input: process.stdin,
    });
    process.exitCode = outcome.exitCode;
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "validate") {
    const parsed = parseOrExit("validate", () => parseNoArguments("validate", arguments_.slice(1)));
    if (parsed === undefined) return;
    const result = await validateApplication(home);
    writeHumanDocument(process.stdout, validationResultDocument(result), stdoutPresentationContext);
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "info") {
    const parsed = parseOrExit("info", () => parseInfoArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      const info = await readApplicationInfo(home);
      if (parsed.json) {
        process.stdout.write(formatInfoJson(info));
      } else {
        writeHumanDocument(process.stdout, infoDocument(info, home), stdoutPresentationContext);
      }
    } catch (error) {
      if (parsed.json) {
        process.stdout.write(
          formatInfoToolErrorJson(applicationInfoLocations(home), formatError(error)),
        );
      } else {
        writeHumanDocument(
          process.stderr,
          errorDiagnosticDocument(error),
          stderrPresentationContext,
        );
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "list") {
    const parsed = parseOrExit("list", () => parseListArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    if (parsed.kind === "index") {
      writeHumanDocument(process.stdout, inventoryIndexDocument(), stdoutPresentationContext);
      return;
    }
    switch (parsed.topic) {
      case "projects":
        try {
          const projects = await listProjectBindings(home);
          if (parsed.json) {
            process.stdout.write(formatProjectInventoryJson(projects));
          } else {
            writeHumanDocument(
              process.stdout,
              projectInventoryDocument(projects, home),
              stdoutPresentationContext,
            );
          }
        } catch (error) {
          if (parsed.json) {
            process.stdout.write(formatProjectInventoryToolErrorJson(formatError(error)));
          } else {
            writeHumanDocument(
              process.stderr,
              errorDiagnosticDocument(error),
              stderrPresentationContext,
            );
          }
          process.exitCode = 1;
        }
        return;
      case "profiles":
        try {
          const profiles = await listProfiles(home);
          if (parsed.json) {
            process.stdout.write(formatProfileInventoryJson(profiles));
          } else {
            writeHumanDocument(
              process.stdout,
              profileInventoryDocument(profiles),
              stdoutPresentationContext,
            );
          }
        } catch (error) {
          if (parsed.json) {
            process.stdout.write(formatProfileInventoryToolErrorJson(formatError(error)));
          } else {
            writeHumanDocument(
              process.stderr,
              errorDiagnosticDocument(error),
              stderrPresentationContext,
            );
          }
          process.exitCode = 1;
        }
        return;
      case "hosts":
        {
          const hosts = listHosts();
          if (parsed.json) {
            process.stdout.write(formatHostInventoryJson(hosts));
          } else {
            writeHumanDocument(process.stdout, hostInventoryDocument(hosts), stdoutPresentationContext);
          }
        }
        return;
      default:
        return assertNever(parsed.topic);
    }
  }
  if (arguments_.length >= 1 && arguments_[0] === "update") {
    const parsed = parseOrExit("update", () => parseLifecycleArguments("update", arguments_.slice(1)));
    if (parsed === undefined) return;
    const outcome = await runApplyCommand({
      home,
      selection: parsed.selection,
      json: parsed.json,
      removeChanged: parsed.removeChanged,
      replaceChanged: parsed.replaceChanged,
      verbose: parsed.verbose,
      stdout: process.stdout,
      stderr: process.stderr,
      input: process.stdin,
    });
    process.exitCode = outcome.exitCode;
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "status") {
    const parsed = parseOrExit("status", () => parseLifecycleArguments("status", arguments_.slice(1)));
    if (parsed === undefined) return;
    const context = stdoutPresentationContext;
    const progress = interactiveProgress(context, parsed.json, STATUS_PROGRESS_LABEL);
    try {
      const report = await statusApplication(home, {
        selection: parsed.selection,
      });
      progress?.finish();
      if (parsed.json) {
        process.stdout.write(formatLifecycleJson("status", report));
      } else {
        writeHumanDocument(process.stdout, lifecycleStatusDocument(report, parsed), context);
      }
      process.exitCode = lifecycleExitCode(report);
    } catch (error) {
      progress?.finish();
      if (parsed.json) {
        process.stdout.write(formatLifecycleToolErrorJson("status", formatError(error)));
      } else {
        writeHumanDocument(
          process.stderr,
          lifecycleToolErrorDiagnostic("status", error),
          stderrPresentationContext,
        );
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "uninstall") {
    const outcome = await runUninstallCommand({
      home,
      arguments: arguments_.slice(1),
      stdout: process.stdout,
      stderr: process.stderr,
      input: process.stdin,
    });
    process.exitCode = outcome.exitCode;
    return;
  }
  if (arguments_.length >= 1 && REMOVED_TEMPORARY_COMMANDS.some((name) => name === arguments_[0])) {
    const removed = arguments_[0]!;
    writeHumanDocument(
      process.stderr,
      removedNamespaceDiagnostic(removed),
      stderrPresentationContext,
    );
    process.exitCode = 1;
    return;
  }
  {
    const removed = arguments_.length >= 1
      ? REMOVED_PUBLIC_COMMANDS.find((entry) => entry.from === arguments_[0])
      : undefined;
    if (removed !== undefined) {
      writeHumanDocument(
        process.stderr,
        removedPublicCommandDiagnostic(removed.from, removed.to),
        stderrPresentationContext,
      );
      process.exitCode = 1;
      return;
    }
  }
  if (arguments_.length >= 1 && arguments_[0] === MACHINE_NAMESPACE) {
    const rest = arguments_.slice(1);
    if (rest.length === 0) {
      writeHumanDocument(process.stdout, machineHelpDocument(), stdoutPresentationContext);
      return;
    }
    const machineFocusedHelp = focusedMachineHelpRequest(rest);
    if (machineFocusedHelp?.kind === "command") {
      writeHumanDocument(
        process.stdout,
        commandHelpDocument(machineFocusedHelp.command),
        stdoutPresentationContext,
      );
      return;
    }
    const subcommand = rest[0] ?? "";
    if (subcommand === "install-temp") {
      const parsed = parseOrExit(
        "machine install-temp",
        () => parseInstallTempArguments(rest.slice(1), "machine install-temp"),
      );
      if (parsed === undefined) return;
      const context = stdoutPresentationContext;
      try {
        const receipt = await installTemporaryProfile({
          home,
          host: parsed.host,
          profile: parsed.profile,
          project: parsed.project,
        });
        if (parsed.json) {
          process.stdout.write(formatTemporaryInstallationJson("install-temp", receipt));
        } else {
          writeHumanDocument(
            process.stdout,
            temporaryInstallationDocument("install-temp", receipt),
            context,
          );
        }
        process.exitCode = 0;
      } catch (error) {
        if (error instanceof TemporaryInstallationBlockedError) {
          if (parsed.json) {
            process.stdout.write(
              formatTemporaryInstallationBlockedJson("install-temp", error.structured),
            );
          } else {
            const blocked = temporaryBlockedMessagesDocument(
              error.structured,
              error.canonicalProject,
            );
            process.stderr.write(
              `${renderPresentationDocument(
                blocked.document,
                stderrPresentationContext,
              )}\n`,
            );
          }
          process.exitCode = 2;
          return;
        }
        if (error instanceof TemporaryInstallationRecoverableError) {
          if (parsed.json) {
            process.stdout.write(
              formatTemporaryInstallationToolErrorJson("install-temp", formatError(error), {
                removalRequired: true,
                temporaryInstallationId: error.temporaryInstallationId,
              }),
            );
          } else {
            writeHumanDocument(
              process.stderr,
              diagnosticDocument({
                ...errorDiagnosticParts(error),
                whatToType: [[
                  "removal is required; run ",
                  commandPart(COMMAND_NAME, [
                    arg("machine"),
                    arg("remove-temp"),
                    arg(error.temporaryInstallationId),
                  ]),
                ]],
              }),
              stderrPresentationContext,
            );
          }
          process.exitCode = 1;
          return;
        }
        if (parsed.json) {
          process.stdout.write(
            formatTemporaryInstallationToolErrorJson("install-temp", formatError(error)),
          );
        } else {
          writeHumanDocument(
            process.stderr,
            errorDiagnosticDocument(error),
            stderrPresentationContext,
          );
        }
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === "remove-temp") {
      const parsed = parseOrExit(
        "machine remove-temp",
        () => parseRemoveTempArguments(rest.slice(1), "machine remove-temp"),
      );
      if (parsed === undefined) return;
      const context = stdoutPresentationContext;
      try {
        const receipt = await removeTemporaryProfile({
          home,
          temporaryInstallationId: parsed.temporaryInstallationId,
        });
        if (parsed.json) {
          process.stdout.write(formatTemporaryInstallationJson("remove-temp", receipt));
        } else {
          writeHumanDocument(
            process.stdout,
            temporaryInstallationDocument("remove-temp", receipt),
            context,
          );
        }
        process.exitCode = 0;
      } catch (error) {
        if (error instanceof TemporaryInstallationBlockedError) {
          if (parsed.json) {
            process.stdout.write(
              formatTemporaryInstallationBlockedJson("remove-temp", error.structured),
            );
          } else {
            const blocked = temporaryBlockedMessagesDocument(
              error.structured,
              error.canonicalProject,
            );
            process.stderr.write(
              `${renderPresentationDocument(
                blocked.document,
                stderrPresentationContext,
              )}\n`,
            );
          }
          process.exitCode = 2;
          return;
        }
        if (parsed.json) {
          process.stdout.write(
            formatTemporaryInstallationToolErrorJson("remove-temp", formatError(error)),
          );
        } else {
          writeHumanDocument(
            process.stderr,
            errorDiagnosticDocument(error),
            stderrPresentationContext,
          );
        }
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === "list") {
      const parsed = parseOrExit("machine list", () => parseMachineListArguments(rest.slice(1)));
      if (parsed === undefined) return;
      if (parsed.kind === "index") {
        writeHumanDocument(
          process.stdout,
          machineInventoryIndexDocument(),
          stdoutPresentationContext,
        );
        return;
      }
      try {
        const installations = await listTemporaryInstallations(home);
        if (parsed.json) {
          process.stdout.write(formatTemporaryInventoryJson(installations));
        } else {
          writeHumanDocument(
            process.stdout,
            temporaryInventoryDocument(installations, home),
            stdoutPresentationContext,
          );
        }
      } catch (error) {
        if (parsed.json) {
          process.stdout.write(formatTemporaryInventoryToolErrorJson(formatError(error)));
        } else {
          writeHumanDocument(
            process.stderr,
            errorDiagnosticDocument(error),
            stderrPresentationContext,
          );
        }
        process.exitCode = 1;
      }
      return;
    }
    writeHumanDocument(
      process.stderr,
      unknownMachineCommandDiagnostic(subcommand),
      stderrPresentationContext,
    );
    process.exitCode = 1;
    return;
  }

  const unknown = focusedHelp?.kind === "unknown"
    ? focusedHelp.token
    : arguments_[0] ?? "";
  writeHumanDocument(
    process.stderr,
    unknownCommandDiagnostic(unknown),
    stderrPresentationContext,
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  writeHumanDocument(
    process.stderr,
    errorDiagnosticDocument(error),
    stderrPresentationContext,
  );
  process.exitCode = 1;
});
