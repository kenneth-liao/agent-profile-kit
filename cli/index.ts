#!/usr/bin/env node

import { homedir } from "node:os";
import type { WriteStream } from "node:tty";

import { agentGuide, focusedGuide, guideIndex, humanGuide, type GuideTopic } from "./guides.js";
import {
  carriedErrorParts,
  diagnosticDocument,
} from "./diagnostics.js";
import {
  capitalize,
  DEFAULT_VIEW_LEXICON,
  displayProjectPath,
  formatApplyJson,
  formatApplyReport,
  formatApplyExecutionFailure,
  formatApplyExecutionFailureJson,
  formatApplyVerificationFailure,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatBlockedApplyReport,
  formatLifecycleJson,
  formatLifecycleReport,
  formatLifecycleToolErrorJson,
  formatInfoHuman,
  formatInfoJson,
  formatInfoToolErrorJson,
  formatHostInventoryHuman,
  formatHostInventoryJson,
  formatInventoryIndex,
  formatMachineInventoryIndex,
  formatProjectInventoryHuman,
  formatProjectInventoryJson,
  formatProjectInventoryToolErrorJson,
  formatProfileInventoryHuman,
  formatProfileInventoryJson,
  formatProfileInventoryToolErrorJson,
  formatTemporaryInventoryHuman,
  formatTemporaryInventoryJson,
  formatTemporaryInventoryToolErrorJson,
  describeStateReadFailure,
  formatMissingProfileError,
  formatProjectTargetError,
  applyNewcomerSubstitutions,
  formatProjectTargetErrorForHuman,
  formatTemporaryInstallationBlockedJson,
  formatTemporaryInstallationHuman,
  formatTemporaryInstallationJson,
  formatTemporaryInstallationToolErrorJson,
  formatUninstallResult,
  formatValidationResult,
  lifecycleExitCode,
  temporaryBlockedMessagesDocument,
  responsiveHumanText,
  type LifecycleCommand,
} from "./presentation.js";
import { renderPresentationDocument, type PresentationDocument } from "./presentation-document.js";
import { applicationInfoLocations, readApplicationInfo } from "../installer/info.js";
import { bindProject, hostsEqual } from "../installer/bind-project.js";
import {
  unbindProject,
} from "../installer/unbind-project.js";
import { errorMessage, initializeWorkspace } from "../installer/initialize-workspace.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";
import {
  ProjectTargetError,
  type ProjectBindingSelection,
} from "../installer/local-configuration.js";
import { StateReadFailureError } from "../installer/installation-state.js";
import {
  applyApplication,
  statusApplication,
  uninstallApplication,
  validateApplication,
} from "../installer/commands.js";
import {
  ApplyBlockedError,
  ApplyExecutionError,
  ApplyVerificationError,
} from "../installer/reconcile.js";
import {
  installTemporaryProfile,
  removeTemporaryProfile,
  TEMPORARY_INSTALLATION_HOSTS,
  TemporaryInstallationBlockedError,
  TemporaryInstallationRecoverableError,
} from "../installer/temporary-installation.js";
import { COMMAND_NAME, ENGINE_VERSION } from "../installer/version.js";
import { installerErrorSentence } from "./error-wording.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import {
  listHosts,
  listProfiles,
  listProjectBindings,
  listTemporaryInstallations,
} from "../installer/inventory.js";
import { MissingProfileError } from "../installer/profile-selection.js";
import {
  COMMAND_HELP_ALIASES,
  commandInvocationStarters,
  COMMANDS,
  COMMAND_GROUPS,
  defaultCommands,
  findMachineCommand,
  HELP_COMMAND,
  machineCommands,
  ROOT_HELP_ALIASES,
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
  agentProfileKitWordmark,
  renderHumanOutput,
  terminalPresentationContext,
  wrapPresentationText,
  type TerminalPresentationContext,
} from "./terminal-presentation.js";
import {
  beginDelayedProgress,
  STATUS_PROGRESS_LABEL,
} from "./progress.js";

const COMMAND_NAMES = commandInvocationStarters();

/**
 * One trusted terminal-presentation context per human stream, read once at the
 * CLI boundary (DEC-001). Every human view receives these instead of reading
 * terminal state independently; machine surfaces never touch them.
 */
const stdoutPresentationContext = terminalPresentationContext(process.stdout);
const stderrPresentationContext = terminalPresentationContext(process.stderr);

function writeHuman(
  stream: WriteStream,
  text: string,
  context: TerminalPresentationContext,
): void {
  stream.write(renderHumanOutput(text, context, { commandNames: COMMAND_NAMES }));
}

/** Diagnostic output rendered from a presentation document (DEC-018). */
function writeHumanDiagnostic(
  stream: WriteStream,
  document: PresentationDocument,
  context: TerminalPresentationContext,
): void {
  stream.write(`${renderPresentationDocument(document, context)}\n`);
}

/** Authoring and teardown output wrapped through the shared human boundary. */
function humanOutput(
  text: string,
  copyableValues: readonly string[] = [],
): string {
  return responsiveHumanText(text, stdoutPresentationContext, copyableValues);
}

/** Diagnostic output (errors and warnings) wrapped through the shared human boundary. */
function humanError(
  text: string,
  copyableValues: readonly string[] = [],
): string {
  return responsiveHumanText(text, stderrPresentationContext, copyableValues);
}

/**
 * Human error projection: typed Installer errors render through presentation's
 * carried sentences verbatim (the #405 decision keeps tool-error wording
 * unchanged on screen); everything else matches the machine projection.
 */
function formatErrorForHuman(error: unknown): string {
  const authored = installerErrorSentence(error);
  if (authored !== undefined) return authored;
  if (error instanceof ProjectTargetError) {
    return formatProjectTargetErrorForHuman(error.reason);
  }
  if (error instanceof StateReadFailureError) {
    return applyNewcomerSubstitutions(describeStateReadFailure(error.failure));
  }
  return formatError(error);
}

/**
 * Machine projection: typed Installer errors render through presentation's
 * owned sentences; unrecognized errors keep `error.message`.
 */
function formatError(error: unknown): string {
  const authored = installerErrorSentence(error);
  if (authored !== undefined) return authored;
  if (error instanceof MissingProfileError) return formatMissingProfileError(error);
  if (error instanceof ProjectTargetError) return formatProjectTargetError(error.reason);
  if (error instanceof StateReadFailureError) return describeStateReadFailure(error.failure);
  if (error instanceof AggregateError) {
    const causes = Array.from(error.errors, formatError);
    return [error.message, ...causes.map((cause) => `caused by: ${cause}`)].join("\n");
  }
  return errorMessage(error);
}

function usageLine(command: { readonly syntax: string }): string {
  return `Usage: ${COMMAND_NAME} ${command.syntax}`;
}

/** The carried syntax of one named command, for diagnostic usage nodes. */
function commandSyntax(name: string): string {
  return findCommand(name).syntax;
}

/**
 * The human diagnostic for one lifecycle tool error: the carried sentence as
 * what happened, any carried cause lines as why, and usage guidance as what
 * to type when the error names a Project target.
 */
function lifecycleToolErrorDiagnostic(
  command: LifecycleCommand,
  error: unknown,
): PresentationDocument {
  const { happened, why } = carriedErrorParts(formatErrorForHuman(error));
  return diagnosticDocument({
    happened,
    why,
    ...(error instanceof ProjectTargetError ? { usage: commandSyntax(command) } : {}),
  });
}

/** The single line of usage guidance for one named command. */
function commandUsage(name: string): string {
  const command = findCommand(name);
  return `${usageLine(command)}\n`;
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
  | { readonly kind: "unknown"; readonly token: string };

function removedTemporaryRequest(token: string): FocusedHelpRequest | undefined {
  return REMOVED_TEMPORARY_COMMANDS.some((name) => name === token)
    ? { kind: "removedTemporary", name: token }
    : undefined;
}

const MACHINE_NAMESPACE = "machine" as const;

/** Top-level temporary installation command names removed by DEC-019. */
const REMOVED_TEMPORARY_COMMANDS = ["install-temp", "remove-temp"] as const;

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
    const removed = removedTemporaryRequest(commandToken);
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
    if (ROOT_HELP_ALIASES.some((alias) => alias === second) || second === "--version") {
      return { kind: "root" };
    }
    if (second === MACHINE_NAMESPACE) {
      return { kind: "machine" };
    }
    const removed = removedTemporaryRequest(second);
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
  const removed = removedTemporaryRequest(first);
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

const MAX_COMMAND_SUGGESTION_DISTANCE = 2;

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function suggestedCommand(unknown: string): string | undefined {
  return defaultCommands()
    .map((command) => ({
      distance: editDistance(unknown, command.name),
      name: command.name,
    }))
    .filter(({ distance }) => distance <= MAX_COMMAND_SUGGESTION_DISTANCE)
    .sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    })[0]
    ?.name;
}

function sanitizeCommandToken(token: string): string {
  return token.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replaceAll("'", "\\'");
}

/** The diagnostic for one command removed behind the machine namespace (DEC-019). */
function removedNamespaceDiagnostic(name: string): PresentationDocument {
  return diagnosticDocument({
    happened: `${name} moved behind the machine namespace`,
    whatToType: [`Use ${COMMAND_NAME} machine ${name}`],
  });
}

function unknownCommandDiagnostic(unknown: string): PresentationDocument {
  const safeUnknown = sanitizeCommandToken(unknown);
  const suggestion = suggestedCommand(safeUnknown);
  return diagnosticDocument({
    happened: `unknown command '${safeUnknown}'`,
    whatToType: [
      ...(suggestion === undefined ? [] : [`Did you mean: ${COMMAND_NAME} ${suggestion}?`]),
      "",
      `Run ${COMMAND_NAME} --help for available commands.`,
    ],
  });
}

/** Unknown-command help inside the machine-facing namespace (DEC-019). */
function unknownMachineCommandDiagnostic(unknown: string): PresentationDocument {
  const safeUnknown = sanitizeCommandToken(unknown);
  const suggestion = machineCommands()
    .map((command) => ({
      distance: editDistance(safeUnknown, command.name),
      name: command.name,
    }))
    .filter(({ distance }) => distance <= MAX_COMMAND_SUGGESTION_DISTANCE)
    .sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    })[0]
    ?.name;
  return diagnosticDocument({
    happened: `unknown machine command '${safeUnknown}'`,
    whatToType: [
      ...(suggestion === undefined
        ? []
        : [`Did you mean: ${COMMAND_NAME} machine ${suggestion}?`]),
      "",
      `Run ${COMMAND_NAME} machine --help for available machine commands.`,
    ],
  });
}

function perCommandHelp(
  command: CommandHelp,
  context: TerminalPresentationContext,
): string {
  const supportedHosts = command.supportedHosts === undefined
    ? ""
    : `Supported Hosts: ${command.supportedHosts.join(", ")}\n\n`;
  return responsiveHumanText(
    `Purpose: ${command.summary}\n\n` +
      `${usageLine(command)}\n\n` +
      "Examples:\n" +
      command.examples.map((example) => `  ${COMMAND_NAME} ${example}\n`).join("") +
      `\n${supportedHosts}` +
      `Writes: ${command.writes}\n\n` +
      `Next: ${command.next}\n`,
    context,
    [
      usageLine(command),
      ...command.examples.map((example) => `${COMMAND_NAME} ${example}`),
      ...(command.supportedHosts === undefined
        ? []
        : [`Supported Hosts: ${command.supportedHosts.join(", ")}`]),
    ],
  );
}

/** Root help shown for a bare invocation and root `--help` aliases. */
function rootHelp(context: TerminalPresentationContext): string {
  const wordmark = context.interactive ? agentProfileKitWordmark(context.width) : [];
  const proseWidth = Math.max(1, context.width - 4);
  const listedCommands = defaultCommands();
  const commandLines = (group: CommandHelp["group"]): string[] =>
    listedCommands
      .filter((candidate) => candidate.group === group)
      .flatMap((command) => [
        `  ${command.syntax}`,
        ...wrapPresentationText(command.summary, proseWidth)
          .map((line) => `    ${line}`),
      ]);
  const commonGroupLabel = COMMAND_GROUPS.find(([group]) => group === "common")?.[1];
  if (commonGroupLabel === undefined) throw new Error("Common command group is not configured");
  const commonCommandLines = commandLines("common");
  const secondaryCommandLines = COMMAND_GROUPS
    .filter(([group]) => group !== "common")
    .flatMap(([group, label]) => {
      const lines = commandLines(group);
      return lines.length === 0 ? [] : [`  ${label}:`, ...lines];
    });
  const intro = wrapPresentationText(
    "Agent Profile Kit composes reusable agent material into host-native projects.",
    context.width,
  ).join("\n");
  const guidance = wrapPresentationText(
    `For deeper Workspace authoring guidance (Context Modules, Skills, Profiles, and bindings), run ${COMMAND_NAME} guide --full.`,
    context.width,
  ).join("\n");
  const quickStartHeading = "First run:";
  const discovery = wrapPresentationText(
    `Choose a Profile with ${COMMAND_NAME} guide profile; see ${COMMAND_NAME} bind --help for supported Host values.`,
    Math.max(1, context.width - 2),
  ).map((line) => `  ${line}`).join("\n");
  const identity = wordmark.length === 0 ? "" : `${wordmark.join("\n")}\n\n`;
  return identity + `${intro}\n\n` +
    `Usage: ${COMMAND_NAME} <command> [arguments]\n\n` +
    `${quickStartHeading}\n` +
    `  ${COMMAND_NAME} init\n` +
    `  ${COMMAND_NAME} bind <profile> --host <host>\n` +
    `  ${COMMAND_NAME} status\n` +
    `  ${COMMAND_NAME} apply\n\n` +
    `${discovery}\n\n` +
    `${commonGroupLabel}:\n` +
    `${commonCommandLines.join("\n")}\n\n` +
    "More commands:\n" +
    `${secondaryCommandLines.join("\n")}\n\n` +
    `${guidance}\n`;
}

/**
 * Help for the machine-facing namespace (DEC-019): the only place its commands
 * are listed, deliberately absent from the default command list.
 */
function machineHelp(context: TerminalPresentationContext): string {
  const proseWidth = Math.max(1, context.width - 4);
  const commandLines = machineCommands()
    .flatMap((command) => [
      `  ${command.syntax}`,
      ...wrapPresentationText(command.summary, proseWidth)
        .map((line) => `    ${line}`),
    ]);
  const intro = wrapPresentationText(
    "Machine-facing commands for external runners and automation. Temporary Profile Installation behavior, JSON payloads, and exit codes are unchanged from their documented contract.",
    context.width,
  ).join("\n");
  return `${intro}\n\n` +
    `Usage: ${COMMAND_NAME} machine <command> [arguments]\n\n` +
    `${commandLines.join("\n")}\n`;
}

/** Runs a command-argument parser and, on failure, reports the error with that command's usage. */
function parseOrExit<T>(command: string, parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    writeHumanDiagnostic(
      process.stderr,
      diagnosticDocument({
        ...carriedErrorParts(formatErrorForHuman(error)),
        usage: commandSyntax(command),
      }),
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

function parseInitArguments(arguments_: readonly string[]): { readonly workspace?: string } {
  if (arguments_.length > 1) {
    throw new Error("init accepts at most one Workspace path");
  }
  return arguments_.length === 0
    ? {}
    : { workspace: positionalArgument("init", "a Workspace path", arguments_[0]!) };
}

/**
 * Parse `bind <profile> [project] --host <host> ... [--replace]`.
 * At least one --host is required. Host detection/defaults are intentionally absent.
 */
function parseBindArguments(arguments_: readonly string[]): {
  readonly profile: string;
  readonly project?: string;
  readonly hosts: readonly string[];
  readonly replace: boolean;
} {
  if (arguments_.length === 0) {
    throw new Error("bind requires a Profile name");
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

  if (hosts.length === 0) {
    throw new InstallerToolError({
      kind: "bind-host-required",
      supportedHosts: SUPPORTED_HOSTS,
    });
  }
  return project === undefined ? { profile, hosts, replace } : { profile, project, hosts, replace };
}

function parseUnbindArguments(arguments_: readonly string[]): { readonly project?: string } {
  if (arguments_.length > 1) {
    throw new Error("unbind accepts at most one project path");
  }
  return arguments_.length === 0
    ? {}
    : { project: positionalArgument("unbind", "a project path", arguments_[0]!) };
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
    throw new Error(
      `${COMMAND_NAME} list ${topic} moved behind the machine namespace; use ${COMMAND_NAME} machine list ${topic}`,
    );
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
  readonly all: boolean;
  readonly blockersOnly: boolean;
  readonly json: boolean;
  readonly project?: string;
  readonly verbose: boolean;
}

function parseLifecycleArguments(
  command: LifecycleCommand,
  arguments_: readonly string[],
): ParsedLifecycleArguments {
  let all = false;
  let blockersOnly = false;
  let json = false;
  let project: string | undefined;
  let verbose = false;
  for (const argument of arguments_) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }
    if (argument === "--blockers-only") {
      blockersOnly = true;
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (!argument.startsWith("-")) {
      if (project !== undefined) {
        throw new Error(`${command} accepts at most one Project path`);
      }
      project = argument;
      continue;
    }
    throw new Error(`${command} does not accept argument '${argument}'`);
  }
  if (all && project !== undefined) {
    throw new Error(`${command} --all cannot be combined with a Project path`);
  }
  if (blockersOnly && json) {
    throw new Error(
      `${command} --blockers-only cannot be combined with --json; use ${command} --json for the complete machine report`,
    );
  }
  return {
    all,
    blockersOnly,
    json,
    ...(project === undefined ? {} : { project }),
    verbose,
  };
}

function lifecycleSelection(
  command: "apply" | "status",
  parsed: ParsedLifecycleArguments,
): ProjectBindingSelection {
  if (parsed.all) return { kind: "all" };
  return {
    command,
    kind: "project",
    match: parsed.project === undefined ? "containing" : "exact",
    target: parsed.project ?? process.cwd(),
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

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const home = homedir();

  if (arguments_.length === 1 && arguments_[0] === "--version") {
    process.stdout.write(`${ENGINE_VERSION}\n`);
    return;
  }
  if (
    arguments_.length === 0 ||
    (arguments_.length === 1 && ROOT_HELP_ALIASES.some((alias) => alias === arguments_[0]))
  ) {
    const context = stdoutPresentationContext;
    writeHuman(process.stdout, rootHelp(context), context);
    return;
  }
  const focusedHelp = focusedHelpRequest(arguments_);
  if (focusedHelp?.kind === "root") {
    const context = stdoutPresentationContext;
    writeHuman(process.stdout, rootHelp(context), context);
    return;
  }
  if (focusedHelp?.kind === "machine") {
    writeHuman(process.stdout, machineHelp(stdoutPresentationContext), stdoutPresentationContext);
    return;
  }
  if (focusedHelp?.kind === "removedTemporary") {
    writeHumanDiagnostic(
      process.stderr,
      removedNamespaceDiagnostic(focusedHelp.name),
      stderrPresentationContext,
    );
    process.exitCode = 1;
    return;
  }
  if (focusedHelp?.kind === "command") {
    writeHuman(
      process.stdout,
      perCommandHelp(focusedHelp.command, stdoutPresentationContext),
      stdoutPresentationContext,
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "guide") {
    const parsed = parseOrExit("guide", () => parseGuideArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    if (parsed.kind === "index") {
      const context = stdoutPresentationContext;
      writeHuman(process.stdout, guideIndex(context), context);
    } else if (parsed.kind === "topic") {
      const context = stdoutPresentationContext;
      writeHuman(process.stdout, focusedGuide(parsed.topic, context), context);
    } else if (parsed.kind === "agent") {
      process.stdout.write(await agentGuide());
    } else {
      writeHuman(process.stdout, await humanGuide(), stdoutPresentationContext);
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "init") {
    const parsed = parseOrExit("init", () => parseInitArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    const result = await initializeWorkspace(home, parsed);
    for (const warning of result.warnings) {
      writeHumanDiagnostic(
        process.stderr,
        diagnosticDocument({
          happened: `warning: ${warning}`,
          severity: "attention",
        }),
        stderrPresentationContext,
      );
    }
    if (result.outcome === "migrated") {
      writeHuman(
        process.stdout,
        humanOutput(
          `Migrated ${DEFAULT_VIEW_LEXICON.localConfiguration} and validated the Agent Profile Kit Workspace at ${result.path}\n` +
            `Next: run ${COMMAND_NAME} validate, then status and apply as needed\n`,
          [
            `Migrated ${DEFAULT_VIEW_LEXICON.localConfiguration} and validated the Agent Profile Kit Workspace at ${result.path}`,
          ],
        ),
        stdoutPresentationContext,
      );
      return;
    }
    if (result.outcome === "unchanged") {
      writeHuman(
        process.stdout,
        humanOutput(
          `Workspace and ${DEFAULT_VIEW_LEXICON.localConfiguration} already initialized at ${result.path}; unchanged.\n`,
          [`Workspace and ${DEFAULT_VIEW_LEXICON.localConfiguration} already initialized at ${result.path}; unchanged.`],
        ),
        stdoutPresentationContext,
      );
      return;
    }
    const next = result.workspaceScaffolded
      ? `Next: from the project you want to try, run ${COMMAND_NAME} bind ${AUTHORING_EXAMPLES.profile.id} --host codex\n`
      : `Next: run ${COMMAND_NAME} validate\n`;
    writeHuman(
      process.stdout,
      humanOutput(
        `Initialized Agent Profile Kit Workspace and ${DEFAULT_VIEW_LEXICON.localConfiguration} at ${result.path}\n` + next,
        [
          `Initialized Agent Profile Kit Workspace and ${DEFAULT_VIEW_LEXICON.localConfiguration} at ${result.path}`,
        ],
      ),
      stdoutPresentationContext,
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "bind") {
    const parsed = parseOrExit("bind", () => parseBindArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    const result = await bindProject({
      home,
      profile: parsed.profile,
      hosts: parsed.hosts,
      ...(parsed.replace ? { replace: true } : {}),
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
    });
    if (result.outcome === "unchanged") {
      writeHuman(
        process.stdout,
        humanOutput(
          `${capitalize(DEFAULT_VIEW_LEXICON.projectBinding.singular)} unchanged for ${displayProjectPath(result.canonicalProject, result.project, "project")}\n` +
            `  Profile: ${result.profile}\n` +
            `  Hosts: ${result.hosts.join(", ")}\n` +
            `Next: ${COMMAND_NAME} status\n`,
          [
            `${capitalize(DEFAULT_VIEW_LEXICON.projectBinding.singular)} unchanged for ${displayProjectPath(result.canonicalProject, result.project, "project")}`,
            result.hosts.join(", "),
          ],
        ),
        stdoutPresentationContext,
      );
      return;
    }
    if (result.outcome === "replaced") {
      const deltaLines = [
        result.previousProfile === result.profile
          ? undefined
          : `  Profile: ${result.previousProfile} → ${result.profile}`,
        hostsEqual(result.previousHosts, result.hosts)
          ? undefined
          : `  Hosts: ${result.previousHosts.join(", ")} → ${result.hosts.join(", ")}`,
      ].filter((line) => line !== undefined);
      writeHuman(
        process.stdout,
        humanOutput(
          `Replaced ${DEFAULT_VIEW_LEXICON.projectBinding.singular} for ${displayProjectPath(result.canonicalProject, result.project, "project")}\n` +
            deltaLines.map((line) => `${line}\n`).join("") +
            `Next: ${COMMAND_NAME} status\n`,
          [
            `Replaced ${DEFAULT_VIEW_LEXICON.projectBinding.singular} for ${displayProjectPath(result.canonicalProject, result.project, "project")}`,
            ...deltaLines.map((line) => line.slice(2)),
          ],
        ),
        stdoutPresentationContext,
      );
      return;
    }
    writeHuman(
      process.stdout,
      humanOutput(
        `Recorded ${DEFAULT_VIEW_LEXICON.projectBinding.singular} for ${displayProjectPath(result.canonicalProject, result.project, "project")}\n` +
          `  Profile: ${result.profile}\n` +
          `  Hosts: ${result.hosts.join(", ")}\n` +
          `Next: ${COMMAND_NAME} status\n`,
        [
          `Recorded ${DEFAULT_VIEW_LEXICON.projectBinding.singular} for ${displayProjectPath(result.canonicalProject, result.project, "project")}`,
          result.hosts.join(", "),
        ],
      ),
      stdoutPresentationContext,
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "unbind") {
    const parsed = parseOrExit("unbind", () => parseUnbindArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    const result = await unbindProject({
      home,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
    });
    if (result.outcome === "unchanged") {
      writeHuman(
        process.stdout,
        humanOutput(
          `${capitalize(DEFAULT_VIEW_LEXICON.projectBinding.singular)} unchanged; no ${DEFAULT_VIEW_LEXICON.projectBinding.singular} matched ${result.requestedProject}\n`,
          [`${capitalize(DEFAULT_VIEW_LEXICON.projectBinding.singular)} unchanged; no ${DEFAULT_VIEW_LEXICON.projectBinding.singular} matched ${result.requestedProject}`],
        ),
        stdoutPresentationContext,
      );
      return;
    }
    // Exceptional recovery keeps the diagnostic detail needed to act safely;
    // routine removal stays compact (ADR-0014, DEC-041/DEC-043).
    const recoveryExplanation =
      "Recovery: exact authored path match; canonical project identity could not be proven";
    const recovery = result.recovery === "authored-path"
      ? `  ${recoveryExplanation}\n` +
        `  Local Configuration: ${result.configurationPath}\n`
      : "";
    const recoveryCopyable = result.recovery === "authored-path"
      ? [recoveryExplanation, `Local Configuration: ${result.configurationPath}`]
      : [];
    const survival = result.generatedOutputSurvives
      ? "Generated files remain until apply\n" +
        `Next: ${COMMAND_NAME} status --all\n`
      : "";
    const presentedProject = result.recovery === "canonical"
      ? displayProjectPath(result.canonicalProject, result.project, "project")
      : displayProjectPath(result.project, result.project, "project");
    writeHuman(
      process.stdout,
      humanOutput(
        `Removed ${DEFAULT_VIEW_LEXICON.projectBinding.singular} for ${presentedProject}\n` +
          recovery +
          `  Profile: ${result.profile}\n` +
          `  Hosts: ${result.hosts.join(", ")}\n` +
          survival,
        [
          `Removed ${DEFAULT_VIEW_LEXICON.projectBinding.singular} for ${presentedProject}`,
          ...recoveryCopyable,
          result.hosts.join(", "),
        ],
      ),
      stdoutPresentationContext,
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "validate") {
    const parsed = parseOrExit("validate", () => parseNoArguments("validate", arguments_.slice(1)));
    if (parsed === undefined) return;
    const result = await validateApplication(home);
    // Validation already carries node categories; skip the regex categoriser.
    process.stdout.write(formatValidationResult(result, { context: stdoutPresentationContext }));
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
        // Machine details already carry node categories; skip the regex categoriser.
        process.stdout.write(
          formatInfoHuman(info, { context: stdoutPresentationContext }, home),
        );
      }
    } catch (error) {
      if (parsed.json) {
        process.stdout.write(
          formatInfoToolErrorJson(applicationInfoLocations(home), formatError(error)),
        );
      } else {
        writeHumanDiagnostic(
  process.stderr,
  diagnosticDocument(carriedErrorParts(formatErrorForHuman(error))),
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
      // Inventory already carries node categories; skip the regex categoriser.
      process.stdout.write(formatInventoryIndex({ context: stdoutPresentationContext }));
      return;
    }
    switch (parsed.topic) {
      case "projects":
        try {
          const projects = await listProjectBindings(home);
          if (parsed.json) {
            process.stdout.write(formatProjectInventoryJson(projects));
          } else {
            // Project inventory already carries node categories; skip the regex categoriser.
            process.stdout.write(
              formatProjectInventoryHuman(
                projects,
                { context: stdoutPresentationContext },
                home,
              ),
            );
          }
        } catch (error) {
          if (parsed.json) {
            process.stdout.write(formatProjectInventoryToolErrorJson(formatError(error)));
          } else {
            writeHumanDiagnostic(
  process.stderr,
  diagnosticDocument(carriedErrorParts(formatErrorForHuman(error))),
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
            // Profile inventory already carries node categories; skip the regex categoriser.
            process.stdout.write(
              formatProfileInventoryHuman(profiles, { context: stdoutPresentationContext }),
            );
          }
        } catch (error) {
          if (parsed.json) {
            process.stdout.write(formatProfileInventoryToolErrorJson(formatError(error)));
          } else {
            writeHumanDiagnostic(
  process.stderr,
  diagnosticDocument(carriedErrorParts(formatErrorForHuman(error))),
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
            // Host inventory already carries node categories; skip the regex categoriser.
            process.stdout.write(
              formatHostInventoryHuman(hosts, { context: stdoutPresentationContext }),
            );
          }
        }
        return;
      default:
        return assertNever(parsed.topic);
    }
  }
  if (arguments_.length >= 1 && arguments_[0] === "apply") {
    const parsed = parseOrExit("apply", () => parseLifecycleArguments("apply", arguments_.slice(1)));
    if (parsed === undefined) return;
    const context = stdoutPresentationContext;
    try {
      const applied = await applyApplication(home, {
        selection: lifecycleSelection("apply", parsed),
      });
      if (parsed.json) {
        process.stdout.write(formatApplyJson(applied));
      } else {
        writeHuman(
          process.stdout,
          formatApplyReport(applied, { ...parsed, context }),
          context,
        );
      }
      // Exit 0 whenever apply completed without blockers, including remaining
      // non-current work (outcome "attention"). Gate on blockers only — DEC-024.
      process.exitCode = lifecycleExitCode(applied.resultingState);
    } catch (error) {
      if (error instanceof ApplyBlockedError) {
        if (parsed.json) {
          process.stdout.write(formatBlockedApplyJson(error.report));
        } else {
          writeHuman(
            process.stdout,
            formatBlockedApplyReport(error.report, { ...parsed, context }),
            context,
          );
        }
        process.exitCode = lifecycleExitCode(error.report);
        return;
      }
      if (error instanceof ApplyExecutionError) {
        if (parsed.json) {
          process.stdout.write(formatApplyExecutionFailureJson(error));
        } else {
          writeHuman(
            process.stderr,
            formatApplyExecutionFailure(error, { ...parsed, context: stderrPresentationContext }),
            stderrPresentationContext,
          );
        }
        process.exitCode = 1;
        return;
      }
      if (error instanceof ApplyVerificationError) {
        if (parsed.json) {
          process.stdout.write(formatApplyVerificationFailureJson(error.receipt, error.message));
        } else {
          writeHuman(
            process.stdout,
            formatApplyVerificationFailure(
              error.receipt,
              error.message,
              { ...parsed, context },
            ),
            context,
          );
        }
        process.exitCode = 1;
        return;
      }
      if (parsed.json) {
        process.stdout.write(formatLifecycleToolErrorJson("apply", formatError(error)));
      } else {
        writeHumanDiagnostic(
          process.stderr,
          lifecycleToolErrorDiagnostic("apply", error),
          stderrPresentationContext,
        );
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "status") {
    const parsed = parseOrExit("status", () => parseLifecycleArguments("status", arguments_.slice(1)));
    if (parsed === undefined) return;
    const context = stdoutPresentationContext;
    const progress = interactiveProgress(context, parsed.json, STATUS_PROGRESS_LABEL);
    try {
      const report = await statusApplication(home, {
        selection: lifecycleSelection("status", parsed),
      });
      progress?.finish();
      if (parsed.json) {
        process.stdout.write(formatLifecycleJson("status", report));
      } else {
        // Status already carries node categories; skip the regex categoriser.
        process.stdout.write(
          formatLifecycleReport("status", report, { ...parsed, context }),
        );
      }
      process.exitCode = lifecycleExitCode(report);
    } catch (error) {
      progress?.finish();
      if (parsed.json) {
        process.stdout.write(formatLifecycleToolErrorJson("status", formatError(error)));
      } else {
        writeHumanDiagnostic(
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
    const parsed = parseOrExit("uninstall", () => parseNoArguments("uninstall", arguments_.slice(1)));
    if (parsed === undefined) return;
    // Teardown already carries node categories; skip the regex categoriser.
    process.stdout.write(
      formatUninstallResult(await uninstallApplication(home), { context: stdoutPresentationContext }),
    );
    return;
  }
  if (arguments_.length >= 1 && REMOVED_TEMPORARY_COMMANDS.some((name) => name === arguments_[0])) {
    const removed = arguments_[0]!;
    writeHumanDiagnostic(
      process.stderr,
      removedNamespaceDiagnostic(removed),
      stderrPresentationContext,
    );
    process.exitCode = 1;
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === MACHINE_NAMESPACE) {
    const rest = arguments_.slice(1);
    if (rest.length === 0) {
      writeHuman(process.stdout, machineHelp(stdoutPresentationContext), stdoutPresentationContext);
      return;
    }
    const machineFocusedHelp = focusedMachineHelpRequest(rest);
    if (machineFocusedHelp?.kind === "command") {
      writeHuman(
        process.stdout,
        perCommandHelp(machineFocusedHelp.command, stdoutPresentationContext),
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
          // Receipts already carry node categories; skip the regex categoriser.
          process.stdout.write(
            formatTemporaryInstallationHuman("install-temp", receipt, { context }),
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
              renderPresentationDocument(blocked.document, stderrPresentationContext, {
                copyableValues: [blocked.presented, error.canonicalProject],
              }) + "\n",
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
            writeHumanDiagnostic(
              process.stderr,
              diagnosticDocument({
                happened: formatError(error),
                whatToType: [
                  `removal is required; run ${COMMAND_NAME} machine remove-temp ${error.temporaryInstallationId}`,
                ],
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
          writeHumanDiagnostic(
  process.stderr,
  diagnosticDocument(carriedErrorParts(formatErrorForHuman(error))),
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
          // Receipts already carry node categories; skip the regex categoriser.
          process.stdout.write(
            formatTemporaryInstallationHuman("remove-temp", receipt, { context }),
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
              renderPresentationDocument(blocked.document, stderrPresentationContext, {
                copyableValues: [blocked.presented, error.canonicalProject],
              }) + "\n",
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
          writeHumanDiagnostic(
  process.stderr,
  diagnosticDocument(carriedErrorParts(formatErrorForHuman(error))),
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
        // Inventory already carries node categories; skip the regex categoriser.
        process.stdout.write(
          formatMachineInventoryIndex({ context: stdoutPresentationContext }),
        );
        return;
      }
      try {
        const installations = await listTemporaryInstallations(home);
        if (parsed.json) {
          process.stdout.write(formatTemporaryInventoryJson(installations));
        } else {
          // Temporary inventory already carries node categories; skip the regex categoriser.
          process.stdout.write(
            formatTemporaryInventoryHuman(
              installations,
              { context: stdoutPresentationContext },
              home,
            ),
          );
        }
      } catch (error) {
        if (parsed.json) {
          process.stdout.write(formatTemporaryInventoryToolErrorJson(formatError(error)));
        } else {
          writeHumanDiagnostic(
            process.stderr,
            diagnosticDocument(carriedErrorParts(formatErrorForHuman(error))),
            stderrPresentationContext,
          );
        }
        process.exitCode = 1;
      }
      return;
    }
    writeHumanDiagnostic(
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
  writeHumanDiagnostic(
    process.stderr,
    unknownCommandDiagnostic(unknown),
    stderrPresentationContext,
  );
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  writeHumanDiagnostic(
  process.stderr,
  diagnosticDocument(carriedErrorParts(formatErrorForHuman(error))),
  stderrPresentationContext,
);
  process.exitCode = 1;
});
