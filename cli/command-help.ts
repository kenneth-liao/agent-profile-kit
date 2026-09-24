import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_NAME } from "../installer/version.js";
import { TEMPORARY_INSTALLATION_HOSTS } from "../installer/temporary-installation.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";
import { COMMAND_EXAMPLES, MACHINE_LIST_EXAMPLES } from "./examples.js";
import { inventoryCommandSyntax, machineInventoryCommandSyntax } from "./inventory-topics.js";

export const HELP_COMMAND = "help" as const;
export const ROOT_HELP_ALIASES = ["--help", "-h", HELP_COMMAND] as const;
export const COMMAND_HELP_ALIASES = ["-h", "--help"] as const;
export const VERSION_ALIASES = ["--version", "-v"] as const;

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
    summary: "Initialize, adopt, or connect the canonical Workspace and settings",
    examples: COMMAND_EXAMPLES.init,
    writes: "Creates missing Workspace scaffolding and settings; never overwrites a valid Workspace.",
    next: ["Run ", invocation("install", AUTHORING_EXAMPLES.profile.id, "--agent", "codex"), "."],
  },
  {
    name: "guide",
    group: "common",
    syntax: "guide [profile|context|skill|--full|--agent|--contract]",
    summary: "Show a topic index, the Workspace contract, full Workspace guidance, or one focused authoring example",
    examples: COMMAND_EXAMPLES.guide,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("validate"), " after editing your Workspace."],
  },
  {
    name: "new",
    group: "common",
    // Separate valid lines (US-016, #509): each usage line is one complete
    // invocation shape, so no line joins two forms behind a pipe or repeats
    // the verb.
    syntax: "new skill <skill>\nnew context <context>\nnew profile\nnew profile <profile> [--context <context>]... [--skill <skill>]...",
    summary: "Create a Skill, Context Module, or Profile scaffold in the configured Workspace",
    examples: COMMAND_EXAMPLES.new,
    writes: "Creates one new Skill directory with SKILL.md, one Context Module file, or one Profile file selecting existing material, in the Workspace; without a name, guides Profile creation interactively; never overwrites or edits existing material.",
    next: [
      "Select a new Skill or Context Module into a Profile with ",
      configureProfileRouting(),
      "; install a new Profile with ",
      createdProfileInstallRouting("<profile>"),
      ".",
    ],
  },
  {
    name: "open",
    group: "common",
    syntax: "open",
    summary: "Open the configured Workspace in your system file manager",
    examples: COMMAND_EXAMPLES.open,
    writes: "Nothing; this command is read-only.",
    next: ["Edit your Workspace files, then run ", invocation("validate"), "."],
  },
  {
    name: "install",
    group: "common",
    syntax: "install <profile> [project] --agent <agent> [--agent <agent> ...] [--project <path>] [--auto-confirm] [--replace-changed] [--remove-changed] [--json]",
    summary: "Install a Profile with agents into a Project and remember the selection",
    examples: COMMAND_EXAMPLES.install,
    supportedHosts: SUPPORTED_HOSTS,
    writes:
      "Records the Project's Profile and agent choice and installs its verified files in one action.",
    next: ["Run ", invocation("status"), "."],
  },
  {
    name: "validate",
    group: "common",
    syntax: "validate [workspace]",
    summary: "Check a Workspace folder or the connected Workspace and settings",
    examples: COMMAND_EXAMPLES.validate,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("status"), "."],
  },
  {
    name: "configure",
    group: "common",
    syntax: "configure profile [name] [--context <id> ...] [--skill <id> ...] [--auto-confirm] [--json]",
    summary: "Change a reusable Profile's Context and Skill membership without editing files",
    examples: COMMAND_EXAMPLES.configure,
    writes: "Updates only the named Profile's definition in the Workspace; never installs or updates Projects.",
    next: ["Run ", invocation("update"), " to refresh installations from the Workspace."],
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
    summary: "List read-only inventory for Projects, Profiles, or agents",
    examples: COMMAND_EXAMPLES.list,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("status"), " for Project lifecycle diagnostics."],
  },
  {
    name: "status",
    group: "common",
    syntax: "status [project | --here | --all | --project <path>] [--stale | --blocked] [--verbose] [--json]",
    summary: "Show the complete read-only update plan for the complete fleet, the containing Project, or one explicit Project",
    examples: COMMAND_EXAMPLES.status,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("update"), " for pending work after resolving any blockers."],
  },
  {
    name: "update",
    group: "common",
    syntax: "update [project | --here | --all | --project <path>] [--stale | --blocked] [--replace-changed] [--remove-changed] [--verbose] [--json]",
    summary: "Sync the complete fleet, the containing Project, or one explicit Project",
    examples: COMMAND_EXAMPLES.update,
    writes: "Updates Agent Profile Kit-owned generated project files and machine-local installation records from the Workspace. This updates installed Context and Skills; it does not upgrade the apkit executable itself.",
    next: ["Launch a bound agent from the project, or run ", invocation("status"), "."],
  },
  {
    name: "details",
    group: "common",
    syntax: "details [--list | <operation-id>] [--json]",
    summary: "Show retained lifecycle operation history: the latest run, a compact list, or one run by identity",
    examples: COMMAND_EXAMPLES.details,
    writes: "Nothing; this command is read-only.",
    next: ["Run ", invocation("status"), " for the current plan of the selected Projects."],
  },
  {
    name: "uninstall",
    group: "teardown",
    syntax: "uninstall [--here | --project <path> | --all] [--profile <name>] [--agent <agent>] [--auto-confirm] [--remove-changed] [--replace-changed] [--json]",
    summary: "Remove selected Project installations and forget their recorded selection; a lone --profile reaches that Profile's installations fleet-wide; --agent removes only those agents within the scope",
    examples: COMMAND_EXAMPLES.uninstall,
    writes: "Removes owned generated project files, forgets the removed scope's recorded selection, and updates machine-local installation records; keeps the Workspace and unselected Projects.",
    next: ["Run ", invocation("install"), " to install a Profile into a Project again."],
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
 * One usage string as separate valid lines: the multi-line `new` usage
 * renders one Usage line per form, both in focused help and in the
 * argument-error diagnostic that carries the same syntax (US-016, #509).
 * One home for the split rule, so help and diagnostics cannot disagree.
 */
export function commandSyntaxLines(syntax: string): readonly string[] {
  return syntax
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * The routing destinations for created authoring material, shared by the
 * `new` help entry and the creation receipts (spec #491, US-016, #509): a new
 * Skill or Context Module is selected into a Profile with configure, and a
 * created Profile is installed. One home so help and receipts cannot route
 * differently.
 */
export function configureProfileRouting(): ReturnType<typeof invocation> {
  return invocation("configure", "profile");
}

export function createdProfileInstallRouting(profile: string): ReturnType<typeof invocation> {
  return invocation("install", profile);
}

/**
 * The Profile-creation next action for a Workspace with zero Profiles
 * (spec #640 US-002, DEC-005): the handoff comes from the resulting content.
 * With no Context Module the chain starts by authoring one; with existing
 * Context it is only the Profile command, and no existing Context is named.
 * One home so help and receipts cannot route differently.
 */
export function newProfileCreationCommands(
  hasContexts: boolean,
): readonly (readonly InlineContent[])[] {
  return hasContexts
    ? [[invocation("new", "profile", "<name>", "--context", "<context>")]]
    : [
        [invocation("new", "context", "<context>")],
        [invocation("new", "profile", "<name>", "--context", "<context>")],
      ];
}

/**
 * The install next action after setup when Profiles already exist (spec
 * #640 US-002): names no Profile — the user chooses in the picker.
 */
export function guidedInstallRouting(): ReturnType<typeof invocation> {
  return invocation("install");
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
import {
  part,
  type PresentationDocument,
  type PresentationNode,
} from "./presentation-document.js";

const ROOT_INTRO =
  "Agent Profile Kit composes reusable agent material into agent-native projects.";
const ROOT_DISCOVERY_PARTS: readonly InlineContent[] = [
  "  Scaffold material with ",
  invocation("new"),
  "; focus a topic with ",
  invocation("guide", "profile"),
  ", ",
  invocation("guide", "context"),
  ", or ",
  invocation("guide", "skill"),
  "; see ",
  invocation("install", "--help"),
  " for supported agent values.",
];
const ROOT_GUIDANCE_PARTS: readonly InlineContent[] = [
  "For the complete Workspace authoring reference (Context Modules, Skills, and Profiles), run ",
  invocation("guide", "--full"),
  ".",
];

const QUICK_START_COMMANDS = [
  "init <path>",
  "install <profile> --agent <agent>",
  "status",
  "update",
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

/**
 * One indented command name line for root help: lists the human command
 * without flag inventories (US-034, DEC-020).
 */
function commandNameNode(command: CommandHelp): PresentationNode {
  return {
    kind: "sentence",
    parts: ["  ", commandPart(command.name, [])],
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
    part({ kind: "sentence", parts: [ROOT_INTRO] }),
    spacer(),
    part(usageNode("<command> [arguments]")),
    spacer(),
  );
  // The quick-start menu is one part: its heading keeps its command entries.
  nodes.push(part(
    { kind: "heading", text: "First run:" },
    ...QUICK_START_COMMANDS.map((command): PresentationNode => ({
      kind: "sentence",
      parts: ["  ", invocation(...command.split(/\s+/))],
      category: "command",
    })),
  ));
  nodes.push(
    spacer(),
    part({ kind: "sentence", parts: ROOT_DISCOVERY_PARTS }),
    spacer(),
  );
  // The command groups are one part each: heading, entries, and summaries.
  nodes.push(part(
    { kind: "heading", text: "Common commands:" },
    ...defaultCommands()
      .filter((entry) => entry.group === "common")
      .flatMap((command) => [commandNameNode(command), summaryNode(command)]),
  ));
  const secondary: PresentationNode[] = [{ kind: "heading", text: "More commands:" }];
  for (const [group, label] of COMMAND_GROUPS) {
    if (group === "common") continue;
    const listed = defaultCommands().filter((entry) => entry.group === group);
    if (listed.length === 0) continue;
    secondary.push(
      part(
        { kind: "heading", text: `  ${label}:` },
        ...listed.flatMap((command) => [commandNameNode(command), summaryNode(command)]),
      ),
    );
  }
  nodes.push(part(...secondary));
  nodes.push(
    spacer(),
    part({
      kind: "sentence",
      parts: ROOT_GUIDANCE_PARTS,
      category: "muted" as const,
    }),
  );
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
  nodes.push(part(
    ...machineCommands().flatMap((command) => [syntaxNodes(command), summaryNode(command)]),
  ));
  return nodes;
}

/** Focused help for one command: purpose, usage, examples, writes, and next. */
export function commandHelpDocument(command: CommandHelp): PresentationDocument {
  const nodes: PresentationNode[] = [
    part({ kind: "sentence", parts: [`Purpose: ${command.summary}`], category: "heading" }),
    spacer(),
    part(...commandSyntaxLines(command.syntax).map(usageNode)),
    spacer(),
  ];
  // The examples menu is one part: the heading keeps its command lines.
  nodes.push(part(
    { kind: "heading", text: "Examples:" },
    ...command.examples.map((example): PresentationNode => ({
      kind: "sentence",
      parts: ["  ", invocation(...example.split(/\s+/))],
      category: "command",
    })),
  ));
  if (command.supportedHosts !== undefined) {
    const label = command.namespace === "machine" ? "Supported Hosts" : "Supported agents";
    nodes.push(
      spacer(),
      part({
        kind: "sentence",
        parts: [`${label}: ${command.supportedHosts.join(", ")}`],
        category: "heading",
      }),
    );
  }
  nodes.push(
    spacer(),
    part({ kind: "sentence", parts: [`Writes: ${command.writes}`], category: "heading" }),
    spacer(),
    part({ kind: "sentence", parts: ["Next: ", ...command.next], category: "command" }),
  );
  return nodes;
}
