import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_NAME } from "../installer/version.js";
import { TEMPORARY_INSTALLATION_HOSTS } from "../installer/temporary-installation.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";
import { COMMAND_EXAMPLES } from "./examples.js";
import { inventoryCommandSyntax } from "./inventory-topics.js";

export const HELP_COMMAND = "help" as const;
export const ROOT_HELP_ALIASES = ["--help", "-h", HELP_COMMAND] as const;
export const COMMAND_HELP_ALIASES = ["-h", "--help"] as const;

/**
 * Single canonical source for every command's syntax and purpose. Root help,
 * per-command usage guidance, and CLI help tests are all derived from this
 * table so they cannot drift apart.
 */
export interface CommandHelp {
  readonly name: string;
  readonly group: CommandGroup;
  readonly syntax: string;
  readonly summary: string;
  readonly examples: readonly string[];
  readonly supportedHosts?: readonly string[];
  readonly writes: string;
  readonly next: string;
}

export type CommandGroup = "common" | "inventory" | "teardown" | "machine" | "temporary";

export const COMMAND_GROUPS = [
  ["common", "Common commands"],
  ["inventory", "Inventory"],
  ["teardown", "Teardown"],
  ["machine", "Machine details"],
  ["temporary", "Temporary installations"],
] as const satisfies readonly (readonly [CommandGroup, string])[];

type ListedCommandGroup = (typeof COMMAND_GROUPS)[number][0];
type AssertCommandGroupsExhaustive =
  Exclude<CommandGroup, ListedCommandGroup> extends never
    ? Exclude<ListedCommandGroup, CommandGroup> extends never
      ? true
      : never
    : never;
const _assertCommandGroupsExhaustive: AssertCommandGroupsExhaustive = true;
void _assertCommandGroupsExhaustive;

export const COMMANDS: readonly CommandHelp[] = [
  {
    name: "init",
    group: "common",
    syntax: "init [workspace]",
    summary: "Initialize or adopt the canonical Workspace and settings",
    examples: COMMAND_EXAMPLES.init,
    writes: "Creates missing Workspace scaffolding and settings; never overwrites a valid Workspace.",
    next: `Run ${COMMAND_NAME} bind ${AUTHORING_EXAMPLES.profile.id} --host codex.`,
  },
  {
    name: "guide",
    group: "common",
    syntax: "guide [profile|context|skill|--full|--agent]",
    summary: "Show a topic index, full Workspace guidance, or one focused authoring example",
    examples: COMMAND_EXAMPLES.guide,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} validate after editing your Workspace.`,
  },
  {
    name: "bind",
    group: "common",
    syntax: "bind <profile> [project] --host <host> [--host <host> ...] [--replace]",
    summary: "Configure a Project with a Profile and Agent Hosts, or replace an existing binding",
    examples: COMMAND_EXAMPLES.bind,
    supportedHosts: SUPPORTED_HOSTS,
    writes:
      "Records one configured Project in settings; --replace restates an existing binding's Profile and Hosts. Does not install project files.",
    next: `Run ${COMMAND_NAME} status.`,
  },
  {
    name: "unbind",
    group: "teardown",
    syntax: "unbind [project]",
    summary: "Remove a configured Project",
    examples: COMMAND_EXAMPLES.unbind,
    writes: "Removes one configured Project from settings; does not remove installed project files.",
    next: `Run ${COMMAND_NAME} status --all, then ${COMMAND_NAME} apply --all to remove obsolete generated files.`,
  },
  {
    name: "validate",
    group: "common",
    syntax: "validate",
    summary: "Check Workspace and settings validity",
    examples: COMMAND_EXAMPLES.validate,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} status.`,
  },
  {
    name: "info",
    group: "machine",
    syntax: "info [--json]",
    summary: "Show the engine version and selected application locations",
    examples: COMMAND_EXAMPLES.info,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} validate to check the selected Workspace and settings.`,
  },
  {
    name: "list",
    group: "inventory",
    syntax: inventoryCommandSyntax(),
    summary: "List read-only inventory for Projects, Profiles, Hosts, or temporary Profiles",
    examples: COMMAND_EXAMPLES.list,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} status for Project lifecycle diagnostics.`,
  },
  {
    name: "status",
    group: "common",
    syntax: "status [project | --all] [--verbose] [--blockers-only] [--json]",
    summary: "Show the complete read-only apply plan for the current Project, one explicit Project, or the complete fleet; --blockers-only shows a focused Blocker-only view (combines with --verbose, not --json)",
    examples: COMMAND_EXAMPLES.status,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} apply for pending work after resolving any blockers.`,
  },
  {
    name: "apply",
    group: "common",
    syntax: "apply [project | --all] [--verbose] [--json]",
    summary: "Sync the current Project, one explicit Project, or the complete fleet",
    examples: COMMAND_EXAMPLES.apply,
    writes: "Updates Agent Profile Kit-owned generated project files and machine-local installation records.",
    next: `Launch a bound Host from the project, or run ${COMMAND_NAME} status.`,
  },
  {
    name: "uninstall",
    group: "teardown",
    syntax: "uninstall",
    summary: "Remove proven Agent Profile Kit-owned output from all ordinary Project installations",
    examples: COMMAND_EXAMPLES.uninstall,
    writes: "Removes owned generated project files and machine-local installation records; keeps the Workspace and configured Projects.",
    next: `Run ${COMMAND_NAME} unbind for configured Projects you no longer want, or ${COMMAND_NAME} apply to reinstall.`,
  },
  {
    name: "install-temp",
    group: "temporary",
    syntax: "install-temp <profile> <project> --host <host> [--json]",
    summary: "Install a temporary Profile into one Project",
    examples: COMMAND_EXAMPLES["install-temp"],
    supportedHosts: TEMPORARY_INSTALLATION_HOSTS,
    writes: "Writes temporary Agent Profile Kit-owned project files and machine-local temporary installation records; does not change settings or configured Projects.",
    next: `Run ${COMMAND_NAME} remove-temp <temporary-installation-id> when finished.`,
  },
  {
    name: "remove-temp",
    group: "temporary",
    syntax: "remove-temp <temporary-installation-id> [--json]",
    summary: "Remove one temporary Profile",
    examples: COMMAND_EXAMPLES["remove-temp"],
    writes: "Removes only the receipt-owned temporary project files and exclusion contribution.",
    next: "Nothing further is required for this temporary installation.",
  },
];
