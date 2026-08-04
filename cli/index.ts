#!/usr/bin/env node

import { homedir } from "node:os";

import { agentGuide, focusedGuide, humanGuide, type GuideTopic } from "./guides.js";
import {
  defaultViewText,
  displayProjectPath,
  formatApplyJson,
  formatApplyReport,
  formatApplyVerificationFailure,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatBlockedApplyReport,
  formatLifecycleJson,
  formatLifecycleReport,
  formatLifecycleToolErrorJson,
  formatMissingProfileError,
  formatTemporaryInstallationBlockedJson,
  formatTemporaryInstallationHuman,
  formatTemporaryInstallationJson,
  formatTemporaryInstallationToolErrorJson,
  formatUninstallResult,
  formatValidationResult,
  lifecycleExitCode,
  type LifecycleCommand,
} from "./presentation.js";
import { bindProject } from "../installer/bind-project.js";
import {
  generatedOutputSurvivesUnbind,
  unbindProject,
} from "../installer/unbind-project.js";
import { errorMessage, initializeWorkspace } from "../installer/initialize-workspace.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";
import {
  applyApplication,
  previewApplication,
  statusApplication,
  uninstallApplication,
  validateApplication,
} from "../installer/commands.js";
import { ApplyBlockedError, ApplyVerificationError } from "../installer/reconcile.js";
import {
  installTemporaryProfile,
  removeTemporaryProfile,
  TEMPORARY_INSTALLATION_HOSTS,
  TemporaryInstallationBlockedError,
  TemporaryInstallationRecoverableError,
} from "../installer/temporary-installation.js";
import { COMMAND_NAME, ENGINE_VERSION } from "../installer/version.js";
import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_EXAMPLES } from "./examples.js";
import { MissingProfileError } from "../installer/profile-selection.js";

function formatError(error: unknown): string {
  if (error instanceof MissingProfileError) return formatMissingProfileError(error);
  if (error instanceof AggregateError) {
    const causes = Array.from(error.errors, formatError);
    return [error.message, ...causes.map((cause) => `caused by: ${cause}`)].join("\n");
  }
  return errorMessage(error);
}

/**
 * Single canonical source for every command's syntax and purpose. Root help
 * and per-command usage guidance are both derived from this table so they
 * cannot drift apart.
 */
interface CommandHelp {
  readonly name: string;
  readonly syntax: string;
  readonly summary: string;
  readonly examples: readonly string[];
  readonly writes: string;
  readonly next: string;
}

const COMMANDS: readonly CommandHelp[] = [
  {
    name: "init",
    syntax: "init [workspace]",
    summary: "Initialize or adopt the canonical Workspace and Local Configuration",
    examples: COMMAND_EXAMPLES.init,
    writes: "Creates missing Workspace scaffolding and Local Configuration; never overwrites a valid Workspace.",
    next: `Run ${COMMAND_NAME} guide profile.`,
  },
  {
    name: "guide",
    syntax: "guide [profile|context|skill|--agent]",
    summary: "Print full Workspace guidance or one focused authoring example",
    examples: COMMAND_EXAMPLES.guide,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} validate after editing your Workspace.`,
  },
  {
    name: "bind",
    syntax: "bind <profile> [project] --host <host> [--host <host> ...]",
    summary: "Record a Project Binding to a Profile and Agent Hosts",
    examples: COMMAND_EXAMPLES.bind,
    writes: "Records one Project Binding in Local Configuration; does not install project files.",
    next: `Run ${COMMAND_NAME} preview.`,
  },
  {
    name: "unbind",
    syntax: "unbind [project]",
    summary: "Remove a Project Binding",
    examples: COMMAND_EXAMPLES.unbind,
    writes: "Removes one Project Binding from Local Configuration; does not remove installed project files.",
    next: `Run ${COMMAND_NAME} preview, then ${COMMAND_NAME} apply to remove obsolete generated files.`,
  },
  {
    name: "validate",
    syntax: "validate",
    summary: "Check Workspace and Local Configuration validity",
    examples: COMMAND_EXAMPLES.validate,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} preview.`,
  },
  {
    name: "preview",
    syntax: "preview [--verbose] [--json]",
    summary: "Show pending reconciliation changes without writing (read-only)",
    examples: COMMAND_EXAMPLES.preview,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} apply when the preview is ready.`,
  },
  {
    name: "apply",
    syntax: "apply [--verbose] [--json]",
    summary: "Reconcile Profile Installations to match Local Configuration",
    examples: COMMAND_EXAMPLES.apply,
    writes: "Updates Agent Profile Kit-owned generated project files and machine-local installation records.",
    next: `Launch a bound Host from the project, or run ${COMMAND_NAME} status.`,
  },
  {
    name: "status",
    syntax: "status [--verbose] [--json]",
    summary: "Show current Profile Installation lifecycle state",
    examples: COMMAND_EXAMPLES.status,
    writes: "Nothing; this command is read-only.",
    next: `If changes need attention, run ${COMMAND_NAME} preview.`,
  },
  {
    name: "uninstall",
    syntax: "uninstall",
    summary: "Remove all Profile Installations",
    examples: COMMAND_EXAMPLES.uninstall,
    writes: "Removes owned generated project files and machine-local installation records; keeps the Workspace and Project Bindings.",
    next: `Run ${COMMAND_NAME} unbind for bindings you no longer want, or ${COMMAND_NAME} apply to reinstall.`,
  },
  {
    name: "install-temp",
    syntax: "install-temp <profile> <project> --host <host> [--json]",
    summary: "Install a Profile temporarily into one Project",
    examples: COMMAND_EXAMPLES["install-temp"],
    writes: "Writes temporary Agent Profile Kit-owned project files and machine-local temporary installation state; does not change Local Configuration or Project Bindings.",
    next: `Run ${COMMAND_NAME} remove-temp <temporary-installation-id> when finished.`,
  },
  {
    name: "remove-temp",
    syntax: "remove-temp <temporary-installation-id> [--json]",
    // "temporary Profile installation" is protected from ordinary Profile Installation
    // default-view rewriting (see defaultViewText) so this temporary lifetime stays distinct.
    summary: "Remove one temporary Profile installation",
    examples: COMMAND_EXAMPLES["remove-temp"],
    writes: "Removes only the receipt-owned temporary project files and exclusion contribution.",
    next: "Nothing further is required for this temporary installation.",
  },
];

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

function perCommandHelp(command: CommandHelp): string {
  return defaultViewText(
    `Purpose: ${command.summary}\n\n` +
    `${usageLine(command)}\n\n` +
    "Examples:\n" +
    command.examples.map((example) => `  ${COMMAND_NAME} ${example}\n`).join("") +
    `\nWrites: ${command.writes}\n\n` +
    `Next: ${command.next}\n`,
  );
}

/** Root help shown for a bare invocation, `--help`, and unknown-command errors. */
function rootHelp(): string {
  const longestSyntax = Math.max(...COMMANDS.map((command) => command.syntax.length));
  const commandLines = COMMANDS.map(
    (command) => `  ${command.syntax.padEnd(longestSyntax)}  ${command.summary}`,
  ).join("\n");
  return defaultViewText(
    "Agent Profile Kit composes reusable agent material into host-native Profile Installations.\n\n" +
    `Usage: ${COMMAND_NAME} <command> [arguments]\n\n` +
    "Commands:\n" +
    `${commandLines}\n\n` +
    "Profile Installation quick start:\n" +
    `  ${COMMAND_NAME} init\n` +
    `  ${COMMAND_NAME} bind <profile> --host <host>\n` +
    `  ${COMMAND_NAME} preview\n` +
    `  ${COMMAND_NAME} apply\n\n` +
    `For deeper Workspace authoring guidance (Context Modules, Skills, Profiles, and bindings), run ${COMMAND_NAME} guide.\n`,
  );
}

/** Runs a command-argument parser and, on failure, reports the error with that command's usage. */
function parseOrExit<T>(command: string, parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n${commandUsage(command)}`);
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
    throw new Error("bind requires a Profile Artifact ID");
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
    throw new Error("install-temp requires a Profile Artifact ID and a Project path");
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

function parseGuideArguments(arguments_: readonly string[]): {
  readonly agent: boolean;
  readonly topic?: GuideTopic;
} {
  const topic = arguments_[0];
  if (topic === "profile" || topic === "context" || topic === "skill") {
    if (arguments_.length > 1) {
      throw new Error(
        `guide does not accept argument '${arguments_[1]}' after topic '${topic}'`,
      );
    }
    return { agent: false, topic };
  }
  return { agent: parseOptionalFlag("guide", arguments_, "--agent") };
}

function parseNoArguments(command: string, arguments_: readonly string[]): { readonly valid: true } {
  if (arguments_.length > 0) {
    throw new Error(`${command} does not accept argument '${arguments_[0]}'`);
  }
  return { valid: true };
}

function parseLifecycleArguments(
  command: LifecycleCommand,
  arguments_: readonly string[],
): { readonly json: boolean; readonly verbose: boolean } {
  const flags = parseOptionalFlags(command, arguments_, ["--verbose", "--json"]);
  return {
    json: flags["--json"] === true,
    verbose: flags["--verbose"] === true,
  };
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
    (arguments_.length === 1 && ["--help", "-h", "help"].includes(arguments_[0]!))
  ) {
    process.stdout.write(rootHelp());
    return;
  }
  if (arguments_.length === 2 && arguments_[1] === "--help") {
    const command = COMMANDS.find((candidate) => candidate.name === arguments_[0]);
    if (command) {
      process.stdout.write(perCommandHelp(command));
      return;
    }
  }
  if (arguments_.length >= 1 && arguments_[0] === "guide") {
    const parsed = parseOrExit("guide", () => parseGuideArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    process.stdout.write(
      parsed.topic !== undefined
        ? focusedGuide(parsed.topic)
        : parsed.agent
          ? await agentGuide()
          : await humanGuide(),
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "init") {
    const parsed = parseOrExit("init", () => parseInitArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    const result = await initializeWorkspace(home, parsed);
    for (const warning of result.warnings) process.stderr.write(`${COMMAND_NAME}: warning: ${warning}\n`);
    if (result.outcome === "migrated") {
      process.stdout.write(
        `Migrated Local Configuration and validated the Agent Profile Kit Workspace at ${result.path}\n` +
          `Next: run ${COMMAND_NAME} validate, then preview and apply as needed\n`,
      );
      return;
    }
    if (result.outcome === "unchanged") {
      process.stdout.write(`Workspace and Local Configuration already initialized at ${result.path}; unchanged.\n`);
      return;
    }
    const next = result.workspaceScaffolded
      ? `Next: from the project you want to try, run ${COMMAND_NAME} bind ${AUTHORING_EXAMPLES.profile.id} --host codex\n`
      : `Next: run ${COMMAND_NAME} validate\n`;
    process.stdout.write(
      `Initialized Agent Profile Kit Workspace and Local Configuration at ${result.path}\n` + next,
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
      process.stdout.write(
        `Project Binding unchanged for ${displayProjectPath(result.canonicalProject, result.project)}\n` +
          `  Profile: ${result.profile}\n` +
          `  Hosts: ${result.hosts.join(", ")}\n` +
          `Next: ${COMMAND_NAME} preview\n`,
      );
      return;
    }
    process.stdout.write(
      `Recorded Project Binding for ${displayProjectPath(result.canonicalProject, result.project)}\n` +
        `  Profile: ${result.profile}\n` +
        `  Hosts: ${result.hosts.join(", ")}\n` +
        `Next: ${COMMAND_NAME} preview\n`,
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
      process.stdout.write(
        `Project Binding unchanged; no binding matched ${result.requestedProject}\n` +
          `  Local Configuration: ${result.configurationPath}\n`,
      );
      return;
    }
    const recovery = result.recovery === "authored-path"
      ? "  Recovery: exact authored path match; canonical project identity could not be proven\n"
      : `  Canonical project: ${result.canonicalProject}\n`;
    const next = await generatedOutputSurvivesUnbind(home, result)
      ? `Next: ${COMMAND_NAME} preview && ${COMMAND_NAME} apply\n`
      : "";
    process.stdout.write(
      `Removed Project Binding for ${result.project}\n` +
        recovery +
        `  Profile: ${result.profile}\n` +
        `  Hosts: ${result.hosts.join(", ")}\n` +
        `  Local Configuration: ${result.configurationPath}\n` +
        next,
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "validate") {
    const parsed = parseOrExit("validate", () => parseNoArguments("validate", arguments_.slice(1)));
    if (parsed === undefined) return;
    const result = await validateApplication(home);
    process.stdout.write(formatValidationResult(result));
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "preview") {
    const parsed = parseOrExit("preview", () => parseLifecycleArguments("preview", arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      const report = await previewApplication(home);
      process.stdout.write(
        parsed.json
          ? formatLifecycleJson("preview", report)
          : formatLifecycleReport("preview", report, parsed),
      );
      process.exitCode = lifecycleExitCode(report);
    } catch (error) {
      if (parsed.json) {
        process.stdout.write(formatLifecycleToolErrorJson("preview", formatError(error)));
      } else {
        process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "apply") {
    const parsed = parseOrExit("apply", () => parseLifecycleArguments("apply", arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      const applied = await applyApplication(home);
      process.stdout.write(
        parsed.json ? formatApplyJson(applied) : formatApplyReport(applied, parsed),
      );
      // Exit 0 whenever apply completed without blockers, including remaining
      // non-current work (outcome "attention"). Gate on blockers only — DEC-024.
      process.exitCode = lifecycleExitCode(applied.resultingState);
    } catch (error) {
      if (error instanceof ApplyBlockedError) {
        process.stdout.write(
          parsed.json
            ? formatBlockedApplyJson(error.report)
            : formatBlockedApplyReport(error.report, parsed),
        );
        process.exitCode = lifecycleExitCode(error.report);
        return;
      }
      if (error instanceof ApplyVerificationError) {
        process.stdout.write(
          parsed.json
            ? formatApplyVerificationFailureJson(error.receipt, error.message)
            : formatApplyVerificationFailure(error.receipt, error.message, parsed),
        );
        process.exitCode = 1;
        return;
      }
      if (parsed.json) {
        process.stdout.write(formatLifecycleToolErrorJson("apply", formatError(error)));
      } else {
        process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "status") {
    const parsed = parseOrExit("status", () => parseLifecycleArguments("status", arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      const report = await statusApplication(home);
      process.stdout.write(
        parsed.json
          ? formatLifecycleJson("status", report)
          : formatLifecycleReport("status", report, parsed),
      );
      process.exitCode = lifecycleExitCode(report);
    } catch (error) {
      if (parsed.json) {
        process.stdout.write(formatLifecycleToolErrorJson("status", formatError(error)));
      } else {
        process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "uninstall") {
    const parsed = parseOrExit("uninstall", () => parseNoArguments("uninstall", arguments_.slice(1)));
    if (parsed === undefined) return;
    process.stdout.write(formatUninstallResult(await uninstallApplication(home)));
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "install-temp") {
    const parsed = parseOrExit("install-temp", () => parseInstallTempArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      const receipt = await installTemporaryProfile({
        home,
        host: parsed.host,
        profile: parsed.profile,
        project: parsed.project,
      });
      process.stdout.write(
        parsed.json
          ? formatTemporaryInstallationJson("install-temp", receipt)
          : formatTemporaryInstallationHuman("install-temp", receipt),
      );
      process.exitCode = 0;
    } catch (error) {
      if (error instanceof TemporaryInstallationBlockedError) {
        if (parsed.json) {
          process.stdout.write(
            formatTemporaryInstallationBlockedJson("install-temp", error.blockers),
          );
        } else {
          process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
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
          process.stderr.write(
            `${COMMAND_NAME}: ${formatError(error)}\n` +
              `${COMMAND_NAME}: removal is required; run ${COMMAND_NAME} remove-temp ${error.temporaryInstallationId}\n`,
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
        process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
      }
      process.exitCode = 1;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "remove-temp") {
    const parsed = parseOrExit("remove-temp", () => parseRemoveTempArguments(arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      const receipt = await removeTemporaryProfile({
        home,
        temporaryInstallationId: parsed.temporaryInstallationId,
      });
      process.stdout.write(
        parsed.json
          ? formatTemporaryInstallationJson("remove-temp", receipt)
          : formatTemporaryInstallationHuman("remove-temp", receipt),
      );
      process.exitCode = 0;
    } catch (error) {
      if (error instanceof TemporaryInstallationBlockedError) {
        if (parsed.json) {
          process.stdout.write(
            formatTemporaryInstallationBlockedJson("remove-temp", error.blockers),
          );
        } else {
          process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
        }
        process.exitCode = 2;
        return;
      }
      if (parsed.json) {
        process.stdout.write(
          formatTemporaryInstallationToolErrorJson("remove-temp", formatError(error)),
        );
      } else {
        process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
      }
      process.exitCode = 1;
    }
    return;
  }

  process.stderr.write(`${COMMAND_NAME}: unknown command '${arguments_[0] ?? ""}'\n\n${rootHelp()}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
  process.exitCode = 1;
});
