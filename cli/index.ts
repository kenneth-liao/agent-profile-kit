#!/usr/bin/env node

import { homedir } from "node:os";
import type { WriteStream } from "node:tty";

import { agentGuide, focusedGuide, guideIndex, humanGuide, type GuideTopic } from "./guides.js";
import {
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
  formatProjectInventoryHuman,
  formatProjectInventoryJson,
  formatProjectInventoryToolErrorJson,
  formatProfileInventoryHuman,
  formatProfileInventoryJson,
  formatProfileInventoryToolErrorJson,
  formatTemporaryInventoryHuman,
  formatTemporaryInventoryJson,
  formatTemporaryInventoryToolErrorJson,
  formatMissingProfileError,
  formatTemporaryInstallationBlockedJson,
  formatTemporaryInstallationHuman,
  formatTemporaryInstallationJson,
  formatTemporaryInstallationToolErrorJson,
  formatUninstallResult,
  formatValidationResult,
  lifecycleExitCode,
  presentTemporaryBlockedMessages,
  responsiveHumanText,
  type LifecycleCommand,
} from "./presentation.js";
import { applicationInfoLocations, readApplicationInfo } from "../installer/info.js";
import { bindProject } from "../installer/bind-project.js";
import {
  generatedOutputSurvivesUnbind,
  unbindProject,
} from "../installer/unbind-project.js";
import { errorMessage, initializeWorkspace } from "../installer/initialize-workspace.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";
import {
  ProjectTargetError,
  type ProjectBindingSelection,
} from "../installer/local-configuration.js";
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
  COMMANDS,
  COMMAND_GROUPS,
  HELP_COMMAND,
  ROOT_HELP_ALIASES,
  type CommandHelp,
} from "./command-help.js";
import {
  inventoryTopicNames,
  isInventoryTopic,
  type InventoryTopic,
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

const COMMAND_NAMES = COMMANDS.map((command) => command.name);

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

function formatError(error: unknown): string {
  if (error instanceof MissingProfileError) return formatMissingProfileError(error);
  if (error instanceof AggregateError) {
    const causes = Array.from(error.errors, formatError);
    return [error.message, ...causes.map((cause) => `caused by: ${cause}`)].join("\n");
  }
  return errorMessage(error);
}

function usageLine(command: { readonly syntax: string }): string {
  return `Usage: ${COMMAND_NAME} ${command.syntax}`;
}

/** The single line of usage guidance for one named command. */
function commandUsage(name: string): string {
  const command = findCommand(name);
  return `${usageLine(command)}\n`;
}

function findCommand(name: string): CommandHelp {
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (!command) throw new Error(`no canonical help for command '${name}'`);
  return command;
}

type FocusedHelpRequest =
  | { readonly kind: "root" }
  | { readonly kind: "command"; readonly command: CommandHelp }
  | { readonly kind: "unknown"; readonly token: string };

function focusedHelpRequest(arguments_: readonly string[]): FocusedHelpRequest | undefined {
  if (arguments_.length === 3 && arguments_[0] === HELP_COMMAND) {
    const commandToken = arguments_[1]!;
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
    const command = COMMANDS.find((candidate) => candidate.name === second);
    return command === undefined
      ? { kind: "unknown", token: second }
      : { kind: "command", command };
  }
  const command = COMMANDS.find((candidate) => candidate.name === first);
  if (command !== undefined && COMMAND_HELP_ALIASES.some((alias) => alias === second)) {
    return { kind: "command", command };
  }
  if (COMMAND_HELP_ALIASES.some((alias) => alias === second)) {
    return { kind: "unknown", token: first };
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
  return COMMANDS
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

function wrapErrorLine(text: string, width: number): string {
  return wrapPresentationText(text, width)
    .map((line, index) => index === 0 ? line : `  ${line}`)
    .join("\n");
}

function unknownCommandHelp(unknown: string, context: TerminalPresentationContext): string {
  const safeUnknown = sanitizeCommandToken(unknown);
  const suggestion = suggestedCommand(safeUnknown);
  const unknownLine = `${COMMAND_NAME}: unknown command '${safeUnknown}'`;
  const lines = [unknownLine];
  if (suggestion !== undefined) lines.push(`Did you mean: ${COMMAND_NAME} ${suggestion}?`);
  lines.push("", `Run ${COMMAND_NAME} --help for available commands.`);
  return lines
    .map((line) => line === "" ? "" : wrapErrorLine(line, context.width))
    .join("\n") + "\n";
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
  const commandLines = (group: CommandHelp["group"]): string[] =>
    COMMANDS.filter((candidate) => candidate.group === group)
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
    .flatMap(([group, label]) => [`  ${label}:`, ...commandLines(group)]);
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

/** Runs a command-argument parser and, on failure, reports the error with that command's usage. */
function parseOrExit<T>(command: string, parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    writeHuman(
      process.stderr,
      humanError(`${COMMAND_NAME}: ${formatError(error)}\n`) + commandUsage(command),
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
 * Parse `bind <profile> [project] --host <host> ...`.
 * At least one --host is required. Host detection/defaults are intentionally absent.
 */
function parseBindArguments(arguments_: readonly string[]): {
  readonly profile: string;
  readonly project?: string;
  readonly hosts: readonly string[];
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
    throw new Error(`bind does not accept argument '${flag}'`);
  }

  if (hosts.length === 0) {
    throw new Error(
      "bind requires at least one --host flag; supported Hosts: " + SUPPORTED_HOSTS.join(", "),
    );
  }
  return project === undefined ? { profile, hosts } : { profile, project, hosts };
}

function parseUnbindArguments(arguments_: readonly string[]): { readonly project?: string } {
  if (arguments_.length > 1) {
    throw new Error("unbind accepts at most one project path");
  }
  return arguments_.length === 0
    ? {}
    : { project: positionalArgument("unbind", "a project path", arguments_[0]!) };
}

function parseInstallTempArguments(arguments_: readonly string[]): {
  readonly host: string;
  readonly json: boolean;
  readonly profile: string;
  readonly project: string;
} {
  if (arguments_.length < 2) {
    throw new Error("install-temp requires a Profile name and a Project path");
  }
  const profile = positionalArgument("install-temp", "a Profile", arguments_[0]!);
  const project = positionalArgument("install-temp", "a Project path", arguments_[1]!);
  let host: string | undefined;
  let json = false;
  let index = 2;
  while (index < arguments_.length) {
    const flag = arguments_[index]!;
    if (flag === "--host") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("install-temp --host requires an Agent Host name");
      }
      if (host !== undefined) {
        throw new Error("install-temp accepts exactly one --host value");
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
    throw new Error(`install-temp does not accept argument '${flag}'`);
  }
  if (host === undefined) {
    throw new Error(
      `install-temp requires --host <host>; temporary installation supports: ${TEMPORARY_INSTALLATION_HOSTS.join(", ")}`,
    );
  }
  return { host, json, profile, project };
}

function parseRemoveTempArguments(arguments_: readonly string[]): {
  readonly json: boolean;
  readonly temporaryInstallationId: string;
} {
  if (arguments_.length === 0) {
    throw new Error("remove-temp requires a temporary installation identity");
  }
  const temporaryInstallationId = positionalArgument(
    "remove-temp",
    "a temporary installation identity",
    arguments_[0]!,
  );
  let json = false;
  for (const argument of arguments_.slice(1)) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    throw new Error(`remove-temp does not accept argument '${argument}'`);
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

function assertNever(value: never): never {
  throw new Error(`Unhandled inventory topic: ${String(value)}`);
}

interface ParsedLifecycleArguments {
  readonly all: boolean;
  readonly json: boolean;
  readonly project?: string;
  readonly verbose: boolean;
}

function parseLifecycleArguments(
  command: LifecycleCommand,
  arguments_: readonly string[],
): ParsedLifecycleArguments {
  let all = false;
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
  return {
    all,
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
  if (
    arguments_[0] === "preview" ||
    (arguments_[0] === HELP_COMMAND && arguments_[1] === "preview")
  ) {
    writeHuman(
      process.stderr,
      humanError(
        `${COMMAND_NAME}: ${COMMAND_NAME} preview was removed; use ${COMMAND_NAME} status [project | --all] [--verbose] [--json] for the complete read-only apply plan.\n`,
      ),
      stderrPresentationContext,
    );
    process.exitCode = 1;
    return;
  }
  const focusedHelp = focusedHelpRequest(arguments_);
  if (focusedHelp?.kind === "root") {
    const context = stdoutPresentationContext;
    writeHuman(process.stdout, rootHelp(context), context);
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
      writeHuman(process.stderr, humanError(`${COMMAND_NAME}: warning: ${warning}\n`), stderrPresentationContext);
    }
    if (result.outcome === "migrated") {
      writeHuman(
        process.stdout,
        humanOutput(
          `Migrated Local Configuration and validated the Agent Profile Kit Workspace at ${result.path}\n` +
            `Next: run ${COMMAND_NAME} validate, then status and apply as needed\n`,
          [
            `Migrated Local Configuration and validated the Agent Profile Kit Workspace at ${result.path}`,
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
          `Workspace and Local Configuration already initialized at ${result.path}; unchanged.\n`,
          [`Workspace and Local Configuration already initialized at ${result.path}; unchanged.`],
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
        `Initialized Agent Profile Kit Workspace and Local Configuration at ${result.path}\n` + next,
        [
          `Initialized Agent Profile Kit Workspace and Local Configuration at ${result.path}`,
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
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
    });
    if (result.outcome === "unchanged") {
      writeHuman(
        process.stdout,
        humanOutput(
          `Project Binding unchanged for ${displayProjectPath(result.canonicalProject, result.project)}\n` +
            `  Profile: ${result.profile}\n` +
            `  Hosts: ${result.hosts.join(", ")}\n` +
            `Next: ${COMMAND_NAME} status\n`,
          [
            `Project Binding unchanged for ${displayProjectPath(result.canonicalProject, result.project)}`,
            result.hosts.join(", "),
          ],
        ),
        stdoutPresentationContext,
      );
      return;
    }
    writeHuman(
      process.stdout,
      humanOutput(
        `Recorded Project Binding for ${displayProjectPath(result.canonicalProject, result.project)}\n` +
          `  Profile: ${result.profile}\n` +
          `  Hosts: ${result.hosts.join(", ")}\n` +
          `Next: ${COMMAND_NAME} status\n`,
        [
          `Recorded Project Binding for ${displayProjectPath(result.canonicalProject, result.project)}`,
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
          `Project Binding unchanged; no binding matched ${result.requestedProject}\n`,
          [`Project Binding unchanged; no binding matched ${result.requestedProject}`],
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
    const generatedOutputSurvives = await generatedOutputSurvivesUnbind(home, result);
    const survival = generatedOutputSurvives
      ? "Generated files remain until apply\n" +
        `Next: ${COMMAND_NAME} status --all\n`
      : "";
    const presentedProject = result.recovery === "canonical"
      ? displayProjectPath(result.canonicalProject, result.project)
      : displayProjectPath(result.project, result.project);
    writeHuman(
      process.stdout,
      humanOutput(
        `Removed Project Binding for ${presentedProject}\n` +
          recovery +
          `  Profile: ${result.profile}\n` +
          `  Hosts: ${result.hosts.join(", ")}\n` +
          survival,
        [
          `Removed Project Binding for ${presentedProject}`,
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
    writeHuman(process.stdout, formatValidationResult(result, { context: stdoutPresentationContext }), stdoutPresentationContext);
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
        writeHuman(
          process.stdout,
          formatInfoHuman(info, { context: stdoutPresentationContext }, home),
          stdoutPresentationContext,
        );
      }
    } catch (error) {
      if (parsed.json) {
        process.stdout.write(
          formatInfoToolErrorJson(applicationInfoLocations(home), formatError(error)),
        );
      } else {
        writeHuman(process.stderr, humanError(`${COMMAND_NAME}: ${formatError(error)}\n`), stderrPresentationContext);
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "list") {
    const parsed = parseOrExit("list", () => parseListArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    if (parsed.kind === "index") {
      writeHuman(process.stdout, formatInventoryIndex({ context: stdoutPresentationContext }), stdoutPresentationContext);
      return;
    }
    switch (parsed.topic) {
      case "projects":
        try {
          const projects = await listProjectBindings(home);
          if (parsed.json) {
            process.stdout.write(formatProjectInventoryJson(projects));
          } else {
            writeHuman(
              process.stdout,
              formatProjectInventoryHuman(
                projects,
                { context: stdoutPresentationContext },
                home,
              ),
              stdoutPresentationContext,
            );
          }
        } catch (error) {
          if (parsed.json) {
            process.stdout.write(formatProjectInventoryToolErrorJson(formatError(error)));
          } else {
            writeHuman(process.stderr, humanError(`${COMMAND_NAME}: ${formatError(error)}\n`), stderrPresentationContext);
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
            writeHuman(
              process.stdout,
              formatProfileInventoryHuman(profiles, { context: stdoutPresentationContext }),
              stdoutPresentationContext,
            );
          }
        } catch (error) {
          if (parsed.json) {
            process.stdout.write(formatProfileInventoryToolErrorJson(formatError(error)));
          } else {
            writeHuman(process.stderr, humanError(`${COMMAND_NAME}: ${formatError(error)}\n`), stderrPresentationContext);
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
            writeHuman(
              process.stdout,
              formatHostInventoryHuman(hosts, { context: stdoutPresentationContext }),
              stdoutPresentationContext,
            );
          }
        }
        return;
      case "temporary":
        try {
          const installations = await listTemporaryInstallations(home);
          if (parsed.json) {
            process.stdout.write(formatTemporaryInventoryJson(installations));
          } else {
            writeHuman(
              process.stdout,
              formatTemporaryInventoryHuman(
                installations,
                { context: stdoutPresentationContext },
                home,
              ),
              stdoutPresentationContext,
            );
          }
        } catch (error) {
          if (parsed.json) {
            process.stdout.write(formatTemporaryInventoryToolErrorJson(formatError(error)));
          } else {
            writeHuman(process.stderr, humanError(`${COMMAND_NAME}: ${formatError(error)}\n`), stderrPresentationContext);
          }
          process.exitCode = 1;
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
        const guidance = error instanceof ProjectTargetError ? commandUsage("apply") : "";
        writeHuman(
          process.stderr,
          humanError(`${COMMAND_NAME}: ${formatError(error)}\n`) + guidance,
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
        writeHuman(
          process.stdout,
          formatLifecycleReport("status", report, { ...parsed, context }),
          context,
        );
      }
      process.exitCode = lifecycleExitCode(report);
    } catch (error) {
      progress?.finish();
      if (parsed.json) {
        process.stdout.write(formatLifecycleToolErrorJson("status", formatError(error)));
      } else {
        const guidance = error instanceof ProjectTargetError ? commandUsage("status") : "";
        writeHuman(
          process.stderr,
          humanError(`${COMMAND_NAME}: ${formatError(error)}\n`) + guidance,
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
    writeHuman(
      process.stdout,
      formatUninstallResult(await uninstallApplication(home), { context: stdoutPresentationContext }),
      stdoutPresentationContext,
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "install-temp") {
    const parsed = parseOrExit("install-temp", () => parseInstallTempArguments(arguments_.slice(1)));
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
        writeHuman(
          process.stdout,
          formatTemporaryInstallationHuman("install-temp", receipt, { context }),
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
          const blocked = presentTemporaryBlockedMessages(
            error.blockers,
            error.canonicalProject,
          );
          writeHuman(
            process.stderr,
            humanError(
              `${COMMAND_NAME}: ${blocked.text}\n`,
              [blocked.presented, error.canonicalProject],
            ),
            stderrPresentationContext,
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
          writeHuman(
            process.stderr,
            humanError(
              `${COMMAND_NAME}: ${formatError(error)}\n` +
                `${COMMAND_NAME}: removal is required; run ${COMMAND_NAME} remove-temp ${error.temporaryInstallationId}\n`,
              [error.temporaryInstallationId],
            ),
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
        writeHuman(process.stderr, humanError(`${COMMAND_NAME}: ${formatError(error)}\n`), stderrPresentationContext);
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "remove-temp") {
    const parsed = parseOrExit("remove-temp", () => parseRemoveTempArguments(arguments_.slice(1)));
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
        writeHuman(
          process.stdout,
          formatTemporaryInstallationHuman("remove-temp", receipt, { context }),
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
          const blocked = presentTemporaryBlockedMessages(
            error.blockers,
            error.canonicalProject,
          );
          writeHuman(
            process.stderr,
            humanError(
              `${COMMAND_NAME}: ${blocked.text}\n`,
              [blocked.presented, error.canonicalProject],
            ),
            stderrPresentationContext,
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
        writeHuman(process.stderr, humanError(`${COMMAND_NAME}: ${formatError(error)}\n`), stderrPresentationContext);
      }
      process.exitCode = 1;
    }
    return;
  }

  const unknown = focusedHelp?.kind === "unknown"
    ? focusedHelp.token
    : arguments_[0] ?? "";
  const context = stderrPresentationContext;
  writeHuman(process.stderr, unknownCommandHelp(unknown, context), context);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  writeHuman(process.stderr, humanError(`${COMMAND_NAME}: ${formatError(error)}\n`), stderrPresentationContext);
  process.exitCode = 1;
});
