#!/usr/bin/env node

import { homedir } from "node:os";

import { agentGuide, humanGuide } from "./guides.js";
import {
  defaultViewText,
  formatApplyReport,
  formatApplyVerificationFailure,
  formatLifecycleReport,
  type LifecycleCommand,
} from "./presentation.js";
import { bindProject } from "../installer/bind-project.js";
import { unbindProject } from "../installer/unbind-project.js";
import { errorMessage, initializeWorkspace } from "../installer/initialize-workspace.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";
import {
  applyApplication,
  previewApplication,
  statusApplication,
  uninstallApplication,
  validateApplication,
} from "../installer/commands.js";
import { ApplyVerificationError } from "../installer/reconcile.js";
import { COMMAND_NAME, ENGINE_VERSION } from "../installer/version.js";
import { COMMAND_EXAMPLES } from "./examples.js";

function formatError(error: unknown): string {
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
    next: `Run ${COMMAND_NAME} guide to learn how to add a Profile.`,
  },
  {
    name: "guide",
    syntax: "guide [--agent]",
    summary: "Print Workspace authoring guidance (human-facing by default; --agent for agent-facing)",
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
    syntax: "preview [--verbose]",
    summary: "Show pending reconciliation changes without writing (read-only)",
    examples: COMMAND_EXAMPLES.preview,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} apply when the preview is ready.`,
  },
  {
    name: "apply",
    syntax: "apply [--verbose]",
    summary: "Reconcile Profile Installations to match Local Configuration",
    examples: COMMAND_EXAMPLES.apply,
    writes: "Updates Agent Profile Kit-owned generated project files and machine-local installation records.",
    next: `Launch a bound Host from the project, or run ${COMMAND_NAME} status.`,
  },
  {
    name: "status",
    syntax: "status [--verbose]",
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

function parseOptionalFlag(command: string, arguments_: readonly string[], flag: string): boolean {
  if (arguments_.length === 0) return false;
  if (arguments_.every((argument) => argument === flag)) return true;
  const invalidArgument = arguments_.find((argument) => argument !== flag) ?? arguments_[0] ?? "";
  throw new Error(`${command} does not accept argument '${invalidArgument}'`);
}

function parseGuideArguments(arguments_: readonly string[]): { readonly agent: boolean } {
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
): { readonly verbose: boolean } {
  return { verbose: parseOptionalFlag(command, arguments_, "--verbose") };
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
    process.stdout.write(parsed.agent ? await agentGuide() : await humanGuide());
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
    process.stdout.write(
      `Initialized Agent Profile Kit Workspace and Local Configuration at ${result.path}\n` +
        `Next: bind a project or edit config.yaml, then run ${COMMAND_NAME} validate\n`,
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
        `Project Binding unchanged for ${result.project}\n` +
          `  Profile: ${result.profile}\n` +
          `  Hosts: ${result.hosts.join(", ")}\n` +
          `Next: ${COMMAND_NAME} preview\n`,
      );
      return;
    }
    process.stdout.write(
      `Recorded Project Binding for ${result.project}\n` +
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
    process.stdout.write(
      `Removed Project Binding for ${result.project}\n` +
        recovery +
        `  Profile: ${result.profile}\n` +
        `  Hosts: ${result.hosts.join(", ")}\n` +
        `  Local Configuration: ${result.configurationPath}\n` +
        `Next: ${COMMAND_NAME} preview && ${COMMAND_NAME} apply\n`,
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "validate") {
    const parsed = parseOrExit("validate", () => parseNoArguments("validate", arguments_.slice(1)));
    if (parsed === undefined) return;
    const result = await validateApplication(home);
    process.stdout.write(
      `Workspace and Local Configuration valid (${result.profiles} Profiles, ${result.bindings} Project Bindings)\n` +
      result.warnings.map((warning) => `Warning: ${warning}\n`).join(""),
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "preview") {
    const parsed = parseOrExit("preview", () => parseLifecycleArguments("preview", arguments_.slice(1)));
    if (parsed === undefined) return;
    const report = await previewApplication(home);
    process.stdout.write(formatLifecycleReport("preview", report, parsed));
    if (report.blockers.length > 0) process.exitCode = 1;
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "apply") {
    const parsed = parseOrExit("apply", () => parseLifecycleArguments("apply", arguments_.slice(1)));
    if (parsed === undefined) return;
    try {
      const applied = await applyApplication(home);
      process.stdout.write(formatApplyReport(applied, parsed));
      if (
        applied.resultingState.blockers.length > 0 ||
        applied.resultingState.items.some((item) => item.kind !== "current")
      ) {
        process.exitCode = 1;
      }
    } catch (error) {
      if (error instanceof ApplyVerificationError) {
        process.stdout.write(formatApplyVerificationFailure(error.receipt, error.message, parsed));
        process.exitCode = 1;
        return;
      }
      if (error instanceof Error && error.message.startsWith("Apply blocked before writes:")) {
        try {
          process.stdout.write(formatLifecycleReport("preview", await previewApplication(home), parsed));
        } catch {
          // Preserve the original apply failure when the diagnostic preview cannot run.
        }
      }
      throw error;
    }
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "status") {
    const parsed = parseOrExit("status", () => parseLifecycleArguments("status", arguments_.slice(1)));
    if (parsed === undefined) return;
    process.stdout.write(formatLifecycleReport("status", await statusApplication(home), parsed));
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "uninstall") {
    const parsed = parseOrExit("uninstall", () => parseNoArguments("uninstall", arguments_.slice(1)));
    if (parsed === undefined) return;
    const count = await uninstallApplication(home);
    process.stdout.write(`Uninstalled ${count} Profile Installation${count === 1 ? "" : "s"}\n`);
    return;
  }

  process.stderr.write(`${COMMAND_NAME}: unknown command '${arguments_[0] ?? ""}'\n\n${rootHelp()}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${COMMAND_NAME}: ${formatError(error)}\n`);
  process.exitCode = 1;
});
