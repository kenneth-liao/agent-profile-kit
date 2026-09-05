import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_NAME } from "../installer/version.js";
import { TEMPORARY_INSTALLATION_HOSTS } from "../installer/temporary-installation.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";
import { COMMAND_EXAMPLES, MACHINE_LIST_EXAMPLES } from "./examples.js";
import { inventoryCommandSyntax, machineInventoryCommandSyntax } from "./inventory-topics.js";

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
  /**
   * Commands behind a machine-facing namespace (DEC-019) carry it here; they are
   * omitted from the default command list and invoked through their namespace.
   */
  readonly namespace?: "machine";
  readonly syntax: string;
  readonly summary: string;
  readonly examples: readonly string[];
  readonly supportedHosts?: readonly string[];
  readonly writes: string;
  readonly next: readonly InlineContent[];
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
    next: ["Run ", invocation("bind", AUTHORING_EXAMPLES.profile.id, "--host", "codex"), "."],
  },
  {
    name: "guide",
    group: "common",
    syntax: "guide [profile|context|skill|--full|--agent]",
    summary: "Show a topic index, full Workspace guidance, or one focused authoring example",
    examples: COMMAND_EXAMPLES.guide,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("validate"), " after editing your Workspace."],
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
    next: ["Run ", invocation("status"), "."],
  },
  {
    name: "unbind",
    group: "teardown",
    syntax: "unbind [project]",
    summary: "Remove a configured Project",
    examples: COMMAND_EXAMPLES.unbind,
    writes: "Removes one configured Project from settings; does not remove installed project files.",
    next: [
      "Run ",
      invocation("status", "--all"),
      ", then ",
      invocation("apply", "--all"),
      " to remove obsolete generated files.",
    ],
  },
  {
    name: "validate",
    group: "common",
    syntax: "validate",
    summary: "Check Workspace and settings validity",
    examples: COMMAND_EXAMPLES.validate,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("status"), "."],
  },
  {
    name: "info",
    group: "machine",
    syntax: "info [--json]",
    summary: "Show the engine version and selected application locations",
    examples: COMMAND_EXAMPLES.info,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("validate"), " to check the selected Workspace and settings."],
  },
  {
    name: "list",
    group: "inventory",
    syntax: inventoryCommandSyntax(),
    summary: "List read-only inventory for Projects, Profiles, Hosts, or temporary Profiles",
    examples: COMMAND_EXAMPLES.list,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("status"), " for Project lifecycle diagnostics."],
  },
  {
    name: "status",
    group: "common",
    syntax: "status [project | --all] [--verbose] [--blockers-only] [--json]",
    summary: "Show the complete read-only apply plan for the current Project, one explicit Project, or the complete fleet; --blockers-only shows a focused Blocker-only view (combines with --verbose, not --json)",
    examples: COMMAND_EXAMPLES.status,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("apply"), " for pending work after resolving any blockers."],
  },
  {
    name: "apply",
    group: "common",
    syntax: "apply [project | --all] [--verbose] [--blockers-only] [--json]",
    summary: "Sync the current Project, one explicit Project, or the complete fleet; --blockers-only shows a focused Blocker-only view that always keeps the Applied receipt and failed or pending Projects visible (combines with --verbose, not --json); with no Blockers the ordinary receipt view renders unchanged",
    examples: COMMAND_EXAMPLES.apply,
    writes: "Updates Agent Profile Kit-owned generated project files and machine-local installation records.",
    next: ["Launch a bound Host from the project, or run ", invocation("status"), "."],
  },
  {
    name: "uninstall",
    group: "teardown",
    syntax: "uninstall",
    summary: "Remove proven Agent Profile Kit-owned output from all ordinary Project installations",
    examples: COMMAND_EXAMPLES.uninstall,
    writes: "Removes owned generated project files and machine-local installation records; keeps the Workspace and configured Projects.",
    next: ["Run ", invocation("unbind"), " for configured Projects you no longer want, or ",
    invocation("apply"), " to reinstall."],
  },
  {
    name: "install-temp",
    group: "temporary",
    namespace: "machine",
    syntax: "machine install-temp <profile> <project> --host <host> [--json]",
    summary: "Install a temporary Profile into one Project",
    examples: COMMAND_EXAMPLES["install-temp"],
    supportedHosts: TEMPORARY_INSTALLATION_HOSTS,
    writes: "Writes temporary Agent Profile Kit-owned project files and machine-local temporary installation records; does not change settings or configured Projects.",
    next: ["Run ", invocation("machine", "remove-temp", "<temporary-installation-id>"), " when finished."],
  },
  {
    name: "remove-temp",
    group: "temporary",
    namespace: "machine",
    syntax: "machine remove-temp <temporary-installation-id> [--json]",
    summary: "Remove one temporary Profile",
    examples: COMMAND_EXAMPLES["remove-temp"],
    writes: "Removes only the receipt-owned temporary project files and exclusion contribution.",
    next: ["Nothing further is required for this temporary installation."],
  },
  {
    name: "list",
    group: "inventory",
    namespace: "machine",
    syntax: `machine ${machineInventoryCommandSyntax()}`,
    summary: "List active temporary Profile inventory for external runners",
    examples: MACHINE_LIST_EXAMPLES,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("machine", "remove-temp", "<temporary-installation-id>"), " to remove one."],
  },
];

/** One `apkit …` invocation as one atomic inline command part. */
function invocation(...tokens: readonly string[]): ReturnType<typeof commandPart> {
  return commandPart(
    COMMAND_NAME,
    tokens.map((value): CommandArg => ({ kind: "text", value })),
  );
}

/**
 * Commands shown in the default command list: every command outside a
 * machine-facing namespace (DEC-019).
 */
export function defaultCommands(): readonly CommandHelp[] {
  return COMMANDS.filter((command) => command.namespace === undefined);
}

/** Commands invoked through one machine-facing namespace (DEC-019). */
export function machineCommands(): readonly CommandHelp[] {
  return COMMANDS.filter((command) => command.namespace === "machine");
}

/** Resolves one machine-namespaced command by its bare name. */
export function findMachineCommand(name: string): CommandHelp | undefined {
  return machineCommands().find((command) => command.name === name);
}

/**
 * The token that starts one command's human invocation line: the bare name for
 * default commands, the namespace-qualified form for machine-facing commands
 * (DEC-019). One canonical home so semantic command styling cannot drift from
 * the command table.
 */
export function commandInvocationStarters(): readonly string[] {
  return COMMANDS.map((command) =>
    command.namespace === undefined ? command.name : `${command.namespace} ${command.name}`,
  );
}

import {
  commandPart,
  type CommandArg,
  type InlineContent,
} from "./inline-content.js";
import type {
  PresentationDocument,
  PresentationNode,
} from "./presentation-document.js";

const ROOT_INTRO =
  "Agent Profile Kit composes reusable agent material into host-native projects.";
const ROOT_DISCOVERY_PARTS: readonly InlineContent[] = [
  "  Choose a Profile with ",
  invocation("guide"),
  " profile; see ",
  invocation("bind", "--help"),
  " for supported Host values.",
];
const ROOT_GUIDANCE_PARTS: readonly InlineContent[] = [
  "For deeper Workspace authoring guidance (Context Modules, Skills, Profiles, and bindings), run ",
  invocation("guide", "--full"),
  ".",
];

const QUICK_START_COMMANDS = [
  "init",
  "bind <profile> --host <host>",
  "status",
  "apply",
] as const;

function spacer(): PresentationNode {
  return { kind: "verbatim", text: "" };
}

/**
 * One indented syntax line: category command, and the whole syntax is one
 * atomic inline command, never wrapped or folded.
 */
function syntaxNodes(command: CommandHelp): PresentationNode {
  const tokens = command.syntax.trim().split(/\s+/).filter(Boolean);
  return {
    kind: "sentence",
    parts: [
      "  ",
      commandPart(
        tokens[0]!,
        tokens.slice(1).map((value): CommandArg => ({ kind: "text", value })),
      ),
    ],
    category: "command",
  };
}

function summaryNode(command: CommandHelp): PresentationNode {
  return { kind: "sentence", parts: [`    ${command.summary}`] };
}

function usageNode(syntax: string): PresentationNode {
  return {
    kind: "key-value",
    key: "Usage",
    value: {
      kind: "command",
      program: COMMAND_NAME,
      args: syntax
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => ({ kind: "text" as const, value: token })),
    },
    category: "heading",
  };
}

/**
 * Root help as a presentation document. The wordmark is authored by the CLI
 * boundary — the one place allowed to read the terminal context (DEC-012).
 */
export function rootHelpDocument(wordmark: readonly string[]): PresentationDocument {
  const nodes: PresentationNode[] = [];
  // The wordmark is pre-formatted ASCII art: reproduced exactly, unwrapped
  // and unstyled (verbatim content, DEC-008).
  for (const line of wordmark) {
    nodes.push({ kind: "verbatim", text: line });
  }
  if (wordmark.length > 0) nodes.push(spacer());
  nodes.push(
    { kind: "sentence", parts: [ROOT_INTRO] },
    spacer(),
    usageNode("<command> [arguments]"),
    spacer(),
    { kind: "heading", text: "First run:" },
  );
  for (const command of QUICK_START_COMMANDS) {
    nodes.push({
      kind: "sentence",
      parts: ["  ", invocation(...command.split(/\s+/))],
      category: "command",
    });
  }
  nodes.push(
    spacer(),
    { kind: "sentence", parts: ROOT_DISCOVERY_PARTS },
    spacer(),
    { kind: "heading", text: "Common commands:" },
  );
  for (const command of defaultCommands().filter((entry) => entry.group === "common")) {
    nodes.push(syntaxNodes(command), summaryNode(command));
  }
  nodes.push(spacer(), { kind: "heading", text: "More commands:" });
  for (const [group, label] of COMMAND_GROUPS) {
    if (group === "common") continue;
    const listed = defaultCommands().filter((entry) => entry.group === group);
    if (listed.length === 0) continue;
    nodes.push({ kind: "heading", text: `  ${label}:` });
    for (const command of listed) {
      nodes.push(syntaxNodes(command), summaryNode(command));
    }
  }
  nodes.push(spacer(), {
    kind: "sentence",
    parts: ROOT_GUIDANCE_PARTS,
    category: "muted",
  });
  return nodes;
}

/**
 * Help for the machine-facing namespace (DEC-019): the only place its commands
 * are listed, deliberately absent from the default command list.
 */
export function machineHelpDocument(): PresentationDocument {
  const nodes: PresentationNode[] = [
    {
      kind: "sentence",
      parts: [
        "Machine-facing commands for external runners and automation. Temporary Profile Installation behavior, JSON payloads, and exit codes are unchanged from their documented contract.",
      ],
    },
    spacer(),
    usageNode("machine <command> [arguments]"),
    spacer(),
  ];
  for (const command of machineCommands()) {
    nodes.push(syntaxNodes(command), summaryNode(command));
  }
  return nodes;
}

/** Focused help for one command: purpose, usage, examples, writes, and next. */
export function commandHelpDocument(command: CommandHelp): PresentationDocument {
  const nodes: PresentationNode[] = [
    { kind: "sentence", parts: [`Purpose: ${command.summary}`], category: "heading" },
    spacer(),
    usageNode(command.syntax),
    spacer(),
    { kind: "heading", text: "Examples:" },
  ];
  for (const example of command.examples) {
    nodes.push({
      kind: "sentence",
      parts: ["  ", invocation(...example.split(/\s+/))],
      category: "command",
    });
  }
  if (command.supportedHosts !== undefined) {
    nodes.push(
      spacer(),
      {
        kind: "sentence",
        parts: [`Supported Hosts: ${command.supportedHosts.join(", ")}`],
        category: "heading",
      },
    );
  }
  nodes.push(
    spacer(),
    { kind: "sentence", parts: [`Writes: ${command.writes}`], category: "heading" },
    spacer(),
    { kind: "sentence", parts: ["Next: ", ...command.next], category: "command" },
  );
  return nodes;
}
