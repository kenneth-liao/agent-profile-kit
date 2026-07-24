#!/usr/bin/env node

import { homedir } from "node:os";

import { agentGuide, humanGuide } from "./guides.js";
import { formatLifecycleReport, type LifecycleCommand } from "./presentation.js";
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
const COMMANDS: readonly { readonly name: string; readonly syntax: string; readonly summary: string }[] = [
  { name: "init", syntax: "init [workspace]", summary: "Initialize or adopt the canonical Workspace and Local Configuration" },
  { name: "guide", syntax: "guide [--agent]", summary: "Print Workspace authoring guidance (human-facing by default; --agent for agent-facing)" },
  { name: "bind", syntax: "bind <profile> [project] --host <host> [--host <host> ...]", summary: "Record a Project Binding to a Profile and Agent Hosts" },
  { name: "unbind", syntax: "unbind [project]", summary: "Remove a Project Binding" },
  { name: "validate", syntax: "validate", summary: "Check Workspace and Local Configuration validity" },
  { name: "preview", syntax: "preview [--verbose]", summary: "Show pending reconciliation changes without writing (read-only)" },
  { name: "apply", syntax: "apply [--verbose]", summary: "Reconcile Profile Installations to match Local Configuration" },
  { name: "status", syntax: "status [--verbose]", summary: "Show current Profile Installation lifecycle state" },
  { name: "uninstall", syntax: "uninstall", summary: "Remove all Profile Installations" },
];

function usageLine(command: { readonly syntax: string }): string {
  return `Usage: agent-profile-kit ${command.syntax}`;
}

/** The single line of usage guidance for one named command. */
function commandUsage(name: string): string {
  const command = COMMANDS.find((candidate) => candidate.name === name);
  if (!command) throw new Error(`no canonical usage for command '${name}'`);
  return `${usageLine(command)}\n`;
}

/** Root help shown for a bare invocation, `--help`, and unknown-command errors. */
function rootHelp(): string {
  const longestSyntax = Math.max(...COMMANDS.map((command) => command.syntax.length));
  const commandLines = COMMANDS.map(
    (command) => `  ${command.syntax.padEnd(longestSyntax)}  ${command.summary}`,
  ).join("\n");
  return (
    "Agent Profile Kit composes reusable agent material into host-native Profile Installations.\n\n" +
    "Usage: agent-profile-kit <command> [arguments]\n\n" +
    "Commands:\n" +
    `${commandLines}\n\n` +
    "Profile Installation quick start:\n" +
    "  agent-profile-kit init\n" +
    "  agent-profile-kit bind <profile> --host <host>\n" +
    "  agent-profile-kit preview\n" +
    "  agent-profile-kit apply\n\n" +
    "For deeper Workspace authoring guidance (Context Modules, Skills, Profiles, and bindings), run agent-profile-kit guide.\n"
  );
}

/** Runs a command-argument parser and, on failure, reports the error with that command's usage. */
function parseOrExit<T>(command: string, parse: () => T): T | undefined {
  try {
    return parse();
  } catch (error) {
    process.stderr.write(`agent-profile-kit: ${formatError(error)}\n${commandUsage(command)}`);
    process.exitCode = 1;
    return undefined;
  }
}

function parseInitArguments(arguments_: readonly string[]): { readonly workspace?: string } {
  if (arguments_.length > 1) {
    throw new Error("init accepts at most one Workspace path");
  }
  return arguments_.length === 0 ? {} : { workspace: arguments_[0]! };
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
  const profile = arguments_[0]!;
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
  return arguments_.length === 0 ? {} : { project: arguments_[0]! };
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

  if (arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === "--help")) {
    process.stdout.write(rootHelp());
    return;
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
    for (const warning of result.warnings) process.stderr.write(`agent-profile-kit: warning: ${warning}\n`);
    if (result.outcome === "migrated") {
      process.stdout.write(
        `Migrated Local Configuration and validated the Agent Profile Kit Workspace at ${result.path}\n` +
          "Next: run agent-profile-kit validate, then preview and apply as needed\n",
      );
      return;
    }
    if (result.outcome === "unchanged") {
      process.stdout.write(`Workspace and Local Configuration already initialized at ${result.path}; unchanged.\n`);
      return;
    }
    process.stdout.write(
      `Initialized Agent Profile Kit Workspace and Local Configuration at ${result.path}\n` +
        "Next: bind a project or edit config.yaml, then run agent-profile-kit validate\n",
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
          "Next: agent-profile-kit preview\n",
      );
      return;
    }
    process.stdout.write(
      `Recorded Project Binding for ${result.project}\n` +
        `  Profile: ${result.profile}\n` +
        `  Hosts: ${result.hosts.join(", ")}\n` +
        "Next: agent-profile-kit preview\n",
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
        "Next: agent-profile-kit preview && agent-profile-kit apply\n",
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
      process.stdout.write(formatLifecycleReport("apply", await applyApplication(home), parsed));
    } catch (error) {
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

  process.stderr.write(`agent-profile-kit: unknown command '${arguments_[0] ?? ""}'\n\n${rootHelp()}`);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`agent-profile-kit: ${formatError(error)}\n`);
  process.exitCode = 1;
});
