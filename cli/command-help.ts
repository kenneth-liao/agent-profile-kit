import { COMMAND_NAME } from "../installer/version.js";
import { COMMAND_EXAMPLES } from "./examples.js";

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
  readonly writes: string;
  readonly next: string;
}

export type CommandGroup = "onboarding" | "workspace" | "lifecycle" | "temporary";

export const COMMAND_GROUPS = [
  ["onboarding", "Onboarding"],
  ["workspace", "Workspace and discovery"],
  ["lifecycle", "Project lifecycle"],
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
    group: "onboarding",
    syntax: "init [workspace]",
    summary: "Initialize or adopt the canonical Workspace and Local Configuration",
    examples: COMMAND_EXAMPLES.init,
    writes: "Creates missing Workspace scaffolding and Local Configuration; never overwrites a valid Workspace.",
    next: `Run ${COMMAND_NAME} guide profile.`,
  },
  {
    name: "guide",
    group: "onboarding",
    syntax: "guide [profile|context|skill|--full|--agent]",
    summary: "Show a topic index, full Workspace guidance, or one focused authoring example",
    examples: COMMAND_EXAMPLES.guide,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} validate after editing your Workspace.`,
  },
  {
    name: "bind",
    group: "workspace",
    syntax: "bind <profile> [project] --host <host> [--host <host> ...]",
    summary: "Record a Project Binding to a Profile and Agent Hosts",
    examples: COMMAND_EXAMPLES.bind,
    writes: "Records one Project Binding in Local Configuration; does not install project files.",
    next: `Run ${COMMAND_NAME} preview.`,
  },
  {
    name: "unbind",
    group: "workspace",
    syntax: "unbind [project]",
    summary: "Remove a Project Binding",
    examples: COMMAND_EXAMPLES.unbind,
    writes: "Removes one Project Binding from Local Configuration; does not remove installed project files.",
    next: `Run ${COMMAND_NAME} preview, then ${COMMAND_NAME} apply to remove obsolete generated files.`,
  },
  {
    name: "validate",
    group: "workspace",
    syntax: "validate",
    summary: "Check Workspace and Local Configuration validity",
    examples: COMMAND_EXAMPLES.validate,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} preview.`,
  },
  {
    name: "info",
    group: "workspace",
    syntax: "info [--json]",
    summary: "Show the engine version and selected application locations",
    examples: COMMAND_EXAMPLES.info,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} validate to check the selected Workspace and Local Configuration.`,
  },
  {
    name: "preview",
    group: "lifecycle",
    syntax: "preview [--verbose] [--json]",
    summary: "Show pending reconciliation changes without writing (read-only)",
    examples: COMMAND_EXAMPLES.preview,
    writes: "Nothing; this command is read-only.",
    next: `Run ${COMMAND_NAME} apply when the preview is ready.`,
  },
  {
    name: "apply",
    group: "lifecycle",
    syntax: "apply [--verbose] [--json]",
    summary: "Reconcile Profile Installations to match Local Configuration",
    examples: COMMAND_EXAMPLES.apply,
    writes: "Updates Agent Profile Kit-owned generated project files and machine-local installation records.",
    next: `Launch a bound Host from the project, or run ${COMMAND_NAME} status.`,
  },
  {
    name: "status",
    group: "lifecycle",
    syntax: "status [--verbose] [--json]",
    summary: "Show current Profile Installation lifecycle state",
    examples: COMMAND_EXAMPLES.status,
    writes: "Nothing; this command is read-only.",
    next: `If changes need attention, run ${COMMAND_NAME} preview.`,
  },
  {
    name: "uninstall",
    group: "lifecycle",
    syntax: "uninstall",
    summary: "Remove all Profile Installations",
    examples: COMMAND_EXAMPLES.uninstall,
    writes: "Removes owned generated project files and machine-local installation records; keeps the Workspace and Project Bindings.",
    next: `Run ${COMMAND_NAME} unbind for bindings you no longer want, or ${COMMAND_NAME} apply to reinstall.`,
  },
  {
    name: "install-temp",
    group: "temporary",
    syntax: "install-temp <profile> <project> --host <host> [--json]",
    summary: "Install a Profile temporarily into one Project",
    examples: COMMAND_EXAMPLES["install-temp"],
    writes: "Writes temporary Agent Profile Kit-owned project files and machine-local temporary installation state; does not change Local Configuration or Project Bindings.",
    next: `Run ${COMMAND_NAME} remove-temp <temporary-installation-id> when finished.`,
  },
  {
    name: "remove-temp",
    group: "temporary",
    syntax: "remove-temp <temporary-installation-id> [--json]",
    // "temporary Profile installation" is protected from ordinary Profile Installation
    // default-view rewriting (see defaultViewText) so this temporary lifetime stays distinct.
    summary: "Remove one temporary Profile installation",
    examples: COMMAND_EXAMPLES["remove-temp"],
    writes: "Removes only the receipt-owned temporary project files and exclusion contribution.",
    next: "Nothing further is required for this temporary installation.",
  },
];
