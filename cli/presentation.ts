import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import {
  applyNewcomerSubstitutions,
  blockerWording,
  describeOwnershipFailure,
  describeStateReadFailure,
  humanBlockerWording,
} from "./blocker-wording.js";
import { formatInstallerToolError } from "./error-wording.js";
import { diagnosticDocument } from "./diagnostics.js";
import type { InstallerToolErrorFact } from "../installer/tool-errors.js";
import {
  STATE_READ_FAILURE_CASES,
  type StateReadFailureFact,
} from "../installer/blockers.js";

export {
  applyNewcomerSubstitutions,
  describeStateReadFailure,
} from "./blocker-wording.js";
export {
  formatProjectTargetError,
  formatProjectTargetErrorForHuman,
} from "./error-wording.js";
import {
  commandPart,
  flatInlineText,
  identifierPart,
  pathPart,
  textPart,
  type CommandArg,
  type CommandNode,
  type InlineContent,
  type NoticeSeverity,
  type PresentationDocument,
  type PresentationNode,
} from "./presentation-document.js";

/** One carried command argument. */
const arg = (value: string): CommandArg => ({ kind: "text", value });
import type { ProjectBindingSelection } from "../installer/local-configuration.js";
import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import type { HostSetupProvenance, HostSetupStep, HostSetupStepKind } from "../adapters/project-plan.js";
import type { ChangedOutputComparison } from "../installer/changed-output-review.js";
import {
  type ApplyConsentRequiredError,
  type ApplyReconciliationResult,
  type ApplyReviewStaleError,
  type ChangedOutputConsentRequest,
  type ProjectIdentity,
  type BlockedReconciliationReport,
  type OutputReconciliationItem,
  type OutputReconciliationKind,
  type ReconciliationBlocker,
  type ReconciliationItem,
  type ReconciliationKind,
  type ReconciliationProjectOutput,
  type ReconciliationProjectRecord,
  type ReconciliationReport,
  type ReconciliationWarning,
} from "../installer/reconcile.js";

type PresentedDesired = NonNullable<ReconciliationProjectRecord["desired"]> & {
  readonly canonicalProject: string;
  readonly project: string;
  readonly setupSteps: ReconciliationProjectRecord["setupSteps"];
};

function reportBlockers(report: ReconciliationReport): readonly ReconciliationBlocker[] {
  return [...report.globalBlockers, ...report.projects.flatMap((project) => project.blockers)];
}

function reportDesired(report: ReconciliationReport): readonly PresentedDesired[] {
  return report.projects.flatMap((project) => project.desired === undefined ? [] : [{
    ...project.desired,
    canonicalProject: project.canonicalProject,
    project: project.project,
    setupSteps: project.setupSteps,
  }]);
}

function reportItems(report: ReconciliationReport): readonly ReconciliationItem[] {
  return report.projects.map((project) => ({ ...project.state, project: project.project }));
}

function reportOutputs(report: ReconciliationReport): readonly OutputReconciliationItem[] {
  return report.projects.flatMap((project) => project.outputs.map((output) => ({
    ...(output.driftKind === undefined ? {} : { driftKind: output.driftKind }),
    ...(output.sourceChanged === undefined ? {} : { sourceChanged: output.sourceChanged }),
    kind: output.kind,
    path: output.path,
    project: project.project,
  })));
}

function deduplicateRecords<T>(records: readonly T[]): readonly T[] {
  return [...new Map(records.map((record) => [JSON.stringify(record), record])).values()];
}

function reportRepositoryExclusions(
  report: ReconciliationReport,
): readonly ReconciliationProjectRecord["repositoryExclusions"][number][] {
  return deduplicateRecords(report.projects.flatMap((project) => project.repositoryExclusions));
}

function reportWarningValues(report: ReconciliationReport): readonly string[] {
  return [...new Set(report.projects.flatMap((project) =>
    project.warnings.flatMap((warning) => warning.copyableValues)
  ))].sort(compareCanonicalStrings);
}

function reportHasHostAttention(report: ReconciliationReport): boolean {
  return report.projects.some((project) =>
    project.warnings.some((warning) => warning.kind === "host-attention")
  );
}
import {
  isStructuredBlocker,
  OUTPUT_OWNERSHIP_CONFLICT,
  type BlockerAffectedItem,
  type BlockerKind,
  type BlockerScope,
  type StructuredReconciliationBlocker,
} from "../installer/blockers.js";
import {
  REPOSITORY_EXCLUSION_MODIFIED_WARNING_SUFFIX,
  REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX,
} from "../installer/git-exclusions.js";
import { COMMAND_NAME, ENGINE_VERSION } from "../installer/version.js";
import type { MissingProfileError } from "../installer/profile-selection.js";
import type { ValidationResult } from "../installer/commands.js";
import type {
  UninstallApplicationResult,
  UninstallCompletedProject,
  UninstallFailedProject,
  UninstallUnattemptedProject,
} from "../installer/uninstall-application.js";
import type {
  HostInventoryRecord,
  ProfileInventoryRecord,
  ProjectInventoryRecord,
  TemporaryInventoryRecord,
} from "../installer/inventory.js";
import type {
  ApplicationInfo,
  ApplicationInfoLocations,
  InfoConfigurationState,
} from "../installer/info.js";
import {
  type TerminalPresentationContext,
} from "./terminal-presentation.js";
import { COMMANDS } from "./command-help.js";
import {
  absoluteAuthoredPath,
  displayPath,
  displayProjectPath,
  type LocationDisplayScope,
} from "./display-path.js";

export { displayPath, displayProjectPath };
export type { LocationDisplayScope };
import {
  INVENTORY_TOPICS,
  MACHINE_INVENTORY_TOPICS,
  type InventoryTopic,
  type MachineInventoryTopic,
} from "./inventory-topics.js";
import { compareCanonicalStrings } from "../schemas/canonical.js";

export type LifecycleCommand = "update" | "status" | "install" | "uninstall";

const HOST_SETUP_STEP_ORDER: readonly HostSetupStepKind[] = [
  "approval-required",
  "trust-required",
  "launch-constraint",
  "shared-path",
];

type NonCurrentKind = Exclude<ReconciliationKind, "current">;

export const DEFAULT_VIEW_LEXICON = {
  artifactId: { singular: "name", plural: "names" },
  desiredState: "selected setup",
  generatedOutput: {
    paths: "generated paths",
    plural: "generated files",
    singular: "generated file",
  },
  hostSetupStep: "first use",
  installationManifest: { singular: "installation record", plural: "installation records" },
  installerOwned: {
    attributive: "Agent Profile Kit-managed",
    postpositive: "managed by Agent Profile Kit",
  },
  localConfiguration: "settings",
  profileInstallation: { singular: "project", plural: "projects" },
  projectBinding: { singular: "configured Project", plural: "configured Projects" },
  reconciliation: {
    base: "sync",
    continuous: "syncing",
    noun: "sync",
    past: "synced",
    thirdPerson: "syncs",
  },
  repositoryExclusion: {
    plural: "Git exclusions",
    singular: "Git exclusion",
  },
  temporaryProfileInstallation: {
    action: "temporary install",
    plural: "temporary Profiles",
    singular: "temporary Profile",
  },
} as const;

const OUTPUT_PATH_PRIORITY = {
  removal: 0,
  update: 1,
  addition: 2,
  unchanged: 3,
} as const satisfies Readonly<Record<OutputReconciliationKind, number>>;

export const INTERNAL_ONLY_DEFAULT_TERMS = [
  // Ordinary Profile Installation vocabulary
  /Profile Installations?/i,
  /generated[- ]outputs?/i,
  /Repository Exclusions?/i,
  /Installer-owned/i,
  /reconcil(?:e|es|ed|ing|iation)/i,
  /Artifact IDs?/i,
  /Installation Manifests?/i,
  /desired state/i,
  /Project Bindings?/i,
  /Local Configuration/i,
  /Temporary Profile Installations?/i,
  /Host Setup Steps?/i,
  /Installation State/i,
] as const;

export { formatMissingProfileError } from "./error-wording.js";

export function capitalize(text: string): string {
  return `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/**
 * Single ordered list of non-current Profile Installation states for concise glosses.
 * Exhaustiveness against `ReconciliationKind` is asserted below so a new kind cannot
 * render without an explanation entry.
 */
export const NON_CURRENT_STATE_ORDER = [
  "addition",
  "update",
  "stale source",
  "drifted output",
  "malformed ownership state",
  "blocked",
  "removal",
] as const;

type OrderedNonCurrentKind = (typeof NON_CURRENT_STATE_ORDER)[number];

type AssertOrderExhaustive =
  Exclude<NonCurrentKind, OrderedNonCurrentKind> extends never
    ? Exclude<OrderedNonCurrentKind, NonCurrentKind> extends never
      ? true
      : never
    : never;
const _assertOrderExhaustive: AssertOrderExhaustive = true;
void _assertOrderExhaustive;

/** Short, progressive-disclosure glosses for non-current Profile Installation states. */
const STATE_EXPLANATIONS: Readonly<Record<NonCurrentKind, string>> = {
  addition:
    `The ${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)} is not installed yet; update will create its ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}.`,
  update:
    `${capitalize(DEFAULT_VIEW_LEXICON.desiredState)} changed for this ` +
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)}; update will rewrite ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive} to match.`,
  "stale source":
    `Workspace source changed since the last update; ${DEFAULT_VIEW_LEXICON.generatedOutput.plural} no longer ` +
    `match current ${DEFAULT_VIEW_LEXICON.desiredState}.`,
  "drifted output":
    `An owned ${DEFAULT_VIEW_LEXICON.generatedOutput.singular} differs from its recorded installation; update will ` +
    `replace it from current ${DEFAULT_VIEW_LEXICON.desiredState}.`,
  "malformed ownership state":
    "Ownership metadata is incomplete or inconsistent, so Agent Profile Kit cannot prove what it owns.",
  blocked:
    `${capitalize(DEFAULT_VIEW_LEXICON.reconciliation.noun)} cannot change this ` +
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)} until the listed blocker is resolved.`,
  removal:
    `No ${DEFAULT_VIEW_LEXICON.projectBinding.singular} remains for this installation; update will remove proven ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}.`,
};

export type PrimaryCauseKind =
  | "needs-attention"
  | "generated-files-changed"
  | "generated-files-missing"
  | "not-installed-yet"
  | "source-changed";

export const PRIMARY_CAUSE_ORDER: readonly PrimaryCauseKind[] = [
  "needs-attention",
  "generated-files-changed",
  "generated-files-missing",
  "not-installed-yet",
  "source-changed",
] as const;

export const PRIMARY_CAUSE_LABELS: Readonly<Record<PrimaryCauseKind, string>> = {
  "needs-attention": "needs attention",
  "generated-files-changed": "generated files changed",
  "generated-files-missing": "generated files missing",
  "not-installed-yet": "not installed yet",
  "source-changed": "source changed",
};

export function hasNeedsAttention(project: ReconciliationProjectRecord): boolean {
  return (
    project.blockers.length > 0 ||
    project.state.kind === "malformed ownership state" ||
    project.state.kind === "blocked" ||
    project.state.kind === "removal"
  );
}

export function hasGeneratedFilesChanged(project: ReconciliationProjectRecord): boolean {
  if (project.outputs.some((output) => output.driftKind === "changed")) {
    return true;
  }
  const hasExplicitDrift = project.outputs.some((output) => output.driftKind !== undefined);
  if (!hasExplicitDrift && project.state.kind === "drifted output") {
    return true;
  }
  return false;
}

export function hasGeneratedFilesMissing(project: ReconciliationProjectRecord): boolean {
  return project.outputs.some((output) => output.driftKind === "missing");
}

export function hasNotInstalledYet(project: ReconciliationProjectRecord): boolean {
  return project.state.kind === "addition";
}

/** Canonical per-output source-change evidence: only outputs whose desired
 * projection provably differs from the recorded receipt (typed sourceChanged
 * fact from the reconciliation boundary), or whose operation itself implies
 * desired-state change since the last update (addition, removal, a source-only
 * update). Drifted outputs without the typed fact never claim a source
 * change — that would infer a cause the evidence does not own. */
function outputSourceChanged(output: Omit<OutputReconciliationItem, "project">): boolean {
  return (
    output.sourceChanged === true ||
    output.kind === "addition" ||
    output.kind === "removal" ||
    (output.kind === "update" && output.driftKind === undefined)
  );
}

export function hasSourceChanged(project: ReconciliationProjectRecord): boolean {
  return (
    project.sourceInputChanged === true ||
    project.state.kind === "stale source" ||
    project.state.kind === "update" ||
    project.outputs.some(outputSourceChanged)
  );
}

export function classifyPrimaryCause(
  project: ReconciliationProjectRecord,
): PrimaryCauseKind | "settled" {
  if (hasNeedsAttention(project)) return "needs-attention";
  if (hasGeneratedFilesChanged(project)) return "generated-files-changed";
  if (hasGeneratedFilesMissing(project)) return "generated-files-missing";
  if (hasNotInstalledYet(project)) return "not-installed-yet";
  if (hasSourceChanged(project)) return "source-changed";
  return "settled";
}

export function classifyAllCauses(
  project: ReconciliationProjectRecord,
): readonly PrimaryCauseKind[] {
  const causes: PrimaryCauseKind[] = [];
  if (hasNeedsAttention(project)) causes.push("needs-attention");
  if (hasGeneratedFilesChanged(project)) causes.push("generated-files-changed");
  if (hasGeneratedFilesMissing(project)) causes.push("generated-files-missing");
  if (hasNotInstalledYet(project)) causes.push("not-installed-yet");
  if (hasSourceChanged(project)) causes.push("source-changed");
  return causes;
}

export interface FleetPartition {
  readonly groups: Readonly<Record<PrimaryCauseKind, readonly ReconciliationProjectRecord[]>>;
  readonly settledCount: number;
  readonly totalActionableCount: number;
  readonly totalFleetCount: number;
}

export function partitionFleet(report: ReconciliationReport): FleetPartition {
  const groups: Record<PrimaryCauseKind, ReconciliationProjectRecord[]> = {
    "needs-attention": [],
    "generated-files-changed": [],
    "generated-files-missing": [],
    "not-installed-yet": [],
    "source-changed": [],
  };
  let settledCount = 0;

  for (const project of report.projects) {
    const cause = classifyPrimaryCause(project);
    if (cause === "settled") {
      settledCount += 1;
    } else {
      groups[cause].push(project);
    }
  }

  const totalActionableCount =
    groups["needs-attention"].length +
    groups["generated-files-changed"].length +
    groups["generated-files-missing"].length +
    groups["not-installed-yet"].length +
    groups["source-changed"].length;

  return {
    groups,
    settledCount,
    totalActionableCount,
    totalFleetCount: totalActionableCount + settledCount,
  };
}

export function primaryCauseGroupNode(
  label: string,
  projects: readonly ReconciliationProjectRecord[],
  scope: LocationDisplayScope,
): PresentationNode {
  const parts: InlineContent[] = [`${label} (${projects.length}): `];
  projects.forEach((record, index) => {
    if (index > 0) parts.push(", ");
    parts.push(pathPart(record.canonicalProject, scope, record.project));
  });
  return {
    kind: "list-item",
    parts,
  };
}

/** Nested needs-attention members: each path once, with diagnostic children. */
function needsAttentionCauseNodes(
  projects: readonly ReconciliationProjectRecord[],
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): PresentationNode[] {
  const nodes: PresentationNode[] = [{
    kind: "list-item",
    parts: [`${PRIMARY_CAUSE_LABELS["needs-attention"]} (${projects.length}):`],
  }];
  for (const project of projects) {
    nodes.push({
      kind: "prose",
      parts: ["  ", pathPart(project.canonicalProject, scope, project.project)],
    });
    const displayProject = displayProjectPath(project.canonicalProject, project.project, scope);
    for (const blocker of project.blockers) {
      nodes.push(...conciseBlockerNodes(
        blocker,
        displayProject,
        groups,
        "    ",
        scope,
      ));
    }
    if (project.state.kind === "removal") {
      nodes.push({
        kind: "prose",
        parts: ["    Update will remove generated files for unbound projects."],
      });
    }
  }
  return nodes;
}

export function settledCountNode(count: number): PresentationNode {
  return {
    kind: "list-item",
    parts: [`settled (${count})`],
  };
}

interface OutputSummary {
  readonly additions: number;
  readonly removals: number;
  readonly updates: number;
}

interface ProjectGroup extends ProjectIdentity {
  readonly blockers: ReconciliationBlocker[];
  readonly items: ReconciliationItem[];
  readonly outputs: OutputReconciliationItem[];
}

function presentProject(
  project: ProjectIdentity,
  scope: LocationDisplayScope,
): string {
  return displayProjectPath(project.canonicalProject, project.project, scope);
}

interface GroupedProjects {
  readonly groups: ProjectGroup[];
  readonly unscopedItems: ReconciliationItem[];
}

const DEFAULT_OUTPUT_PATH_LIMIT = 10;


/** The machine-details view (`apkit info`) as a presentation document. */
export function infoDocument(
  info: ApplicationInfo,
  home = homedir(),
  cwd = process.cwd(),
): PresentationDocument {
  const workspaceValue: PresentationNode = info.workspace === null
    ? { kind: "prose", parts: info.configurationState === "legacy"
      ? ["Legacy configuration; run ", commandPart(COMMAND_NAME, [arg("init")])]
      : ["Not configured"] }
    : info.configurationState === "legacy"
      ? { kind: "prose", parts: [
        "Legacy configuration; run ",
        commandPart(COMMAND_NAME, [arg("init")]),
        ` (selected: ${
          displayPath(info.workspace.canonical, info.workspace.authored, "fleet", cwd, home)
        })`,
      ] }
      : { kind: "path", canonicalPath: info.workspace.canonical, authoredPath: info.workspace.authored, scope: "fleet" };
  return [
    {
      kind: "key-value",
      key: "Engine version",
      value: { kind: "identifier", value: info.engineVersion },
      category: "path",
    },
    { kind: "key-value", key: "Workspace", value: workspaceValue },
    {
      kind: "key-value",
      key: "Local Configuration",
      value: {
        kind: "path",
        canonicalPath: info.localConfiguration,
        authoredPath: info.localConfiguration,
        scope: "fleet",
      },
    },
    {
      kind: "key-value",
      key: "Installation State",
      value: {
        kind: "path",
        canonicalPath: info.installationState,
        authoredPath: info.installationState,
        scope: "fleet",
      },
    },
  ];
}


interface InfoMachineBase {
  readonly command: "info";
  readonly engineVersion: string;
  readonly installationState: string;
  readonly localConfiguration: string;
  readonly schemaVersion: 1;
}

interface InfoMachineSuccessPayload extends InfoMachineBase {
  readonly outcome: "success";
  readonly configurationState: InfoConfigurationState;
  readonly workspace: ApplicationInfo["workspace"];
}

interface InfoMachineErrorPayload extends InfoMachineBase {
  readonly configurationState: "unknown";
  readonly error: string;
  readonly outcome: "error";
}

type InfoMachinePayload = InfoMachineErrorPayload | InfoMachineSuccessPayload;

function infoMachinePayload(info: ApplicationInfo): InfoMachineSuccessPayload {
  return {
    schemaVersion: 1,
    command: "info",
    outcome: "success",
    engineVersion: info.engineVersion,
    configurationState: info.configurationState,
    workspace: info.workspace,
    localConfiguration: info.localConfiguration,
    installationState: info.installationState,
  };
}

function serializeInfoMachinePayload(payload: InfoMachinePayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function formatInfoJson(info: ApplicationInfo): string {
  return serializeInfoMachinePayload(infoMachinePayload(info));
}

export function formatInfoToolErrorJson(
  locations: ApplicationInfoLocations,
  message: string,
): string {
  return serializeInfoMachinePayload({
    schemaVersion: 1,
    command: "info",
    outcome: "error",
    error: message,
    engineVersion: locations.engineVersion,
    configurationState: "unknown",
    localConfiguration: locations.localConfiguration,
    installationState: locations.installationState,
  });
}

/**
 * Task-relevant human commands on the bare-invocation entry screen (US-032,
 * DEC-020). Names only — flags stay in per-command help. Every entry resolves
 * against the canonical command table, so a machine-facing command
 * (DEC-021) cannot appear here by construction.
 */
const BARE_TASK_COMMAND_NAMES = ["status", "update", "install", "guide"] as const;

/** One muted pointer to the full surface; the entry screen is not the manual. */
function bareHelpPointerNodes(): PresentationNode[] {
  return [
    { kind: "verbatim", text: "" },
    {
      kind: "prose",
      category: "muted",
      parts: [
        "Run ",
        commandPart(COMMAND_NAME, [arg("--help")]),
        " for the full command list.",
      ],
    },
  ];
}

/** One indented command invocation with the canonical summary under it. */
function bareCommandNodes(names: readonly string[]): PresentationNode[] {
  const nodes: PresentationNode[] = [];
  for (const name of names) {
    const command = COMMANDS.find((candidate) => candidate.name === name);
    if (command === undefined) throw new Error(`no canonical help for command '${name}'`);
    nodes.push(
      {
        kind: "prose",
        category: "command",
        parts: ["  ", commandPart(COMMAND_NAME, [arg(command.name)])],
      },
      { kind: "prose", parts: [`    ${command.summary}`] },
    );
  }
  return nodes;
}

export interface BareInvocationOptions {
  readonly info: ApplicationInfo;
  /** The read-only fleet plan (default fleet scope) for a configured machine. */
  readonly report?: ReconciliationReport;
  /** Boundary-authored wordmark lines; empty when output is redirected. */
  readonly wordmark?: readonly string[];
}

/**
 * The bare-invocation entry screen (US-032, DEC-020): current setup state and
 * a short task-relevant command list, never the full manual. Machine-facing
 * commands are omitted (US-035, DEC-021); the screen is read-only — the fleet
 * facts come from the status plan, not a write path.
 */
export function bareInvocationDocument(options: BareInvocationOptions): PresentationDocument {
  const prefix: PresentationNode[] = [];
  const wordmark = options.wordmark ?? [];
  // The wordmark is pre-formatted ASCII art: reproduced exactly, unwrapped
  // and unstyled (verbatim content, DEC-008).
  for (const line of wordmark) prefix.push({ kind: "verbatim", text: line });
  if (wordmark.length > 0) prefix.push({ kind: "verbatim", text: "" });

  if (options.info.configurationState !== "current") {
    // The setup-needed state is stated once; the init command is carried by
    // the Next line (fact-once, US-008).
    const happened: InlineContent[] = options.info.configurationState === "not-configured"
      ? ["Agent Profile Kit is not set up on this machine."]
      : ["Legacy configuration."];
    return [
      ...prefix,
      {
        kind: "notice",
        severity: "attention",
        nodes: [{ kind: "prose", parts: happened }],
      },
      {
        kind: "prose",
        category: "command",
        parts: [
          "Next: Run ",
          commandPart(COMMAND_NAME, [arg("init")]),
          " to set it up.",
        ],
      },
      ...bareHelpPointerNodes(),
    ];
  }

  const nodes: PresentationNode[] = [...prefix];
  const partition = options.report === undefined ? undefined : partitionFleet(options.report);
  if (partition === undefined || partition.totalFleetCount === 0) {
    nodes.push({
      kind: "notice",
      severity: "success",
      nodes: [{ kind: "prose", parts: ["No Projects are configured."] }],
    });
  } else if (partition.totalActionableCount === 0) {
    nodes.push({
      kind: "notice",
      severity: "success",
      nodes: [{
        kind: "prose",
        parts: [`${plural(partition.settledCount, "Project")} up to date.`],
      }],
    });
  } else {
    for (const cause of PRIMARY_CAUSE_ORDER) {
      const count = partition.groups[cause].length;
      if (count > 0) {
        nodes.push({ kind: "list-item", parts: [`${PRIMARY_CAUSE_LABELS[cause]} (${count})`] });
      }
    }
    if (partition.settledCount > 0) nodes.push(settledCountNode(partition.settledCount));
  }
  nodes.push(
    { kind: "verbatim", text: "" },
    { kind: "heading", text: "Common next steps:" },
    ...bareCommandNodes(BARE_TASK_COMMAND_NAMES),
  );
  nodes.push(...bareHelpPointerNodes());
  return nodes;
}

/** The inventory index view as a presentation document. */
export function inventoryIndexDocument(): PresentationDocument {
  return inventoryTopicNodes(INVENTORY_TOPICS, (topic) => [arg("list"), arg(topic.name)]);
}

/** Index view for the machine-namespaced inventory command (DEC-019). */
export function machineInventoryIndexDocument(): PresentationDocument {
  return inventoryTopicNodes(
    MACHINE_INVENTORY_TOPICS,
    (topic) => [arg("machine"), arg("list"), arg(topic.name)],
  );
}

function inventoryTopicNodes(
  topics: readonly { readonly description: string; readonly name: string }[],
  command: (topic: { readonly description: string; readonly name: string }) => readonly CommandArg[],
): PresentationDocument {
  const nodes: PresentationNode[] = [{ kind: "heading", text: "Inventory topics:" }];
  for (const topic of topics) {
    nodes.push(
      // Indented command invocations are prose lines with an authored command
      // category: the command node kind cannot carry the two-space indent.
      { kind: "prose", parts: ["  ", commandPart(COMMAND_NAME, command(topic))], category: "command" },
      { kind: "prose", parts: [`    ${topic.description}`] },
    );
  }
  return nodes;
}


function projectInventoryStateNode(problem: InstallerToolErrorFact | null): PresentationNode {
  if (problem === null) {
    return { kind: "identifier", value: "configured" };
  }
  return {
    kind: "prose",
    parts: formatInstallerToolError(problem),
    category: "attention",
  };
}

function projectInventorySummary(projects: readonly ProjectInventoryRecord[]): string {
  const problemCount = projects.filter((project) => project.problem !== null).length;
  if (problemCount === 0) {
    return `${plural(projects.length, "Project")} configured.`;
  }
  const configuredCount = projects.length - problemCount;
  if (configuredCount === 0) {
    return `${plural(projects.length, "Project")}: ${plural(problemCount, "problem")}.`;
  }
  return `${plural(projects.length, "Project")}: ${configuredCount} configured, ${plural(problemCount, "problem")}.`;
}

/** The Project inventory listing as a presentation document. */
export function projectInventoryDocument(
  projects: readonly ProjectInventoryRecord[],
  home = homedir(),
  cwd = process.cwd(),
): PresentationDocument {
  if (projects.length === 0) {
    return [
      {
        kind: "notice",
        severity: "success",
        nodes: [{ kind: "prose", parts: ["No Projects are configured."] }],
      },
      {
        kind: "prose",
        parts: [
          "Use ",
          commandPart(COMMAND_NAME, [arg("install"), arg("<profile>"), arg("--host"), arg("<host>")]),
          " to install a Project.",
        ],
      },
    ];
  }

  const nodes: PresentationNode[] = [
    { kind: "heading", text: `Projects (${projects.length}):` },
    spacerNode(),
  ];
  for (const project of projects) {
    nodes.push({
      kind: "row",
      cells: [
        {
          column: "Project",
          content: projectPathNode(project.canonicalProject ?? project.project, project.project, "fleet"),
        },
        {
          column: "Profile",
          content: { kind: "identifier", value: project.profile, category: "path" },
        },
        {
          column: "Hosts",
          content: { kind: "identifier", value: project.hosts.join(", ") },
        },
        {
          column: "State",
          content: projectInventoryStateNode(project.problem),
        },
      ],
    });
  }
  nodes.push(
    spacerNode(),
    {
      kind: "prose",
      parts: [projectInventorySummary(projects)],
    },
    {
      kind: "prose",
      parts: [
        "Use ",
        commandPart(COMMAND_NAME, [arg("status")]),
        " to inspect Project lifecycle diagnostics.",
      ],
    },
  );
  return nodes;
}


interface ListInventoryMachineBase<Topic extends InventoryTopic | MachineInventoryTopic> {
  readonly command: "list";
  readonly engineVersion: string;
  readonly schemaVersion: 1;
  readonly topic: Topic;
}

type ListInventoryMachineOutcome = "error" | "success";

function listInventoryMachinePayload<
  Topic extends InventoryTopic | MachineInventoryTopic,
  Outcome extends ListInventoryMachineOutcome,
  Payload extends object,
>(
  topic: Topic,
  outcome: Outcome,
  payload: Payload,
): ListInventoryMachineBase<Topic> & { readonly outcome: Outcome } & Payload {
  return {
    schemaVersion: 1,
    command: "list",
    topic,
    outcome,
    engineVersion: ENGINE_VERSION,
    ...payload,
  };
}

function serializeListInventoryMachinePayload(payload: object): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

type ProjectInventoryMachineBase = ListInventoryMachineBase<"projects">;

/** Machine publication shape: the typed problem fact rendered as its carried sentence. */
type PublishedProjectInventoryRecord = Omit<ProjectInventoryRecord, "problem"> & {
  readonly problem: string | null;
};

interface ProjectInventoryMachineSuccessPayload extends ProjectInventoryMachineBase {
  readonly outcome: "success";
  readonly projects: readonly PublishedProjectInventoryRecord[];
}

interface ProjectInventoryMachineErrorPayload extends ProjectInventoryMachineBase {
  readonly error: string;
  readonly outcome: "error";
  readonly projects: readonly [];
}

type ProjectInventoryMachinePayload =
  | ProjectInventoryMachineErrorPayload
  | ProjectInventoryMachineSuccessPayload;

/** Versioned machine payload for the read-only Project inventory topic. */
export function formatProjectInventoryJson(
  projects: readonly ProjectInventoryRecord[],
): string {
  return serializeListInventoryMachinePayload(
    listInventoryMachinePayload("projects", "success", {
      projects: projects.map((project) => ({
        ...project,
        problem: project.problem === null
          ? null
          : flatInlineText(formatInstallerToolError(project.problem)),
      })),
    }) satisfies ProjectInventoryMachinePayload,
  );
}

export function formatProjectInventoryToolErrorJson(message: string): string {
  return serializeListInventoryMachinePayload(
    listInventoryMachinePayload("projects", "error", {
      error: message,
      projects: [] as const,
    }) satisfies ProjectInventoryMachinePayload,
  );
}

/** The Profile inventory listing as a presentation document. */
export function profileInventoryDocument(
  profiles: readonly ProfileInventoryRecord[],
): PresentationDocument {
  if (profiles.length === 0) {
    return [
      {
        kind: "notice",
        severity: "success",
        nodes: [{ kind: "prose", parts: ["No Profiles are available."] }],
      },
      {
        kind: "prose",
        parts: [
          "Add a Profile to the selected Workspace, then use <profile> with ",
          commandPart(COMMAND_NAME, [arg("install")]),
          ".",
        ],
      },
    ];
  }

  const nodes: PresentationNode[] = [{ kind: "heading", text: `Profiles (${profiles.length}):` }];
  for (const profile of profiles) {
    nodes.push(
      spacerNode(),
      {
        kind: "key-value",
        key: "Profile",
        value: { kind: "identifier", value: profile.id },
        category: "path",
      },
      {
        kind: "key-value",
        key: "  Context Modules",
        value: { kind: "identifier", value: String(profile.contextModules) },
      },
      {
        kind: "key-value",
        key: "  Skills",
        value: { kind: "identifier", value: String(profile.skills) },
      },
    );
  }
  nodes.push(
    spacerNode(),
    {
      kind: "prose",
      parts: [
        "Use <profile> with ",
        commandPart(COMMAND_NAME, [arg("install")]),
        " to select it for a Project.",
      ],
    },
  );
  return nodes;
}


type ProfileInventoryMachineBase = ListInventoryMachineBase<"profiles">;

interface ProfileInventoryMachineSuccessPayload extends ProfileInventoryMachineBase {
  readonly outcome: "success";
  readonly profiles: readonly ProfileInventoryRecord[];
}

interface ProfileInventoryMachineErrorPayload extends ProfileInventoryMachineBase {
  readonly error: string;
  readonly outcome: "error";
  readonly profiles: readonly [];
}

type ProfileInventoryMachinePayload =
  | ProfileInventoryMachineErrorPayload
  | ProfileInventoryMachineSuccessPayload;

export function formatProfileInventoryJson(
  profiles: readonly ProfileInventoryRecord[],
): string {
  return serializeListInventoryMachinePayload(
    listInventoryMachinePayload("profiles", "success", { profiles }) satisfies
      ProfileInventoryMachinePayload,
  );
}

export function formatProfileInventoryToolErrorJson(message: string): string {
  return serializeListInventoryMachinePayload(
    listInventoryMachinePayload("profiles", "error", {
      error: message,
      profiles: [] as const,
    }) satisfies ProfileInventoryMachinePayload,
  );
}

/** The Agent Host inventory listing as a presentation document. */
export function hostInventoryDocument(
  hosts: readonly HostInventoryRecord[],
): PresentationDocument {
  return [
    { kind: "heading", text: "Supported Hosts:" },
    ...hosts.map(({ host }) => ({ kind: "prose" as const, parts: [`  ${host}`] })),
    spacerNode(),
    {
      kind: "prose",
      parts: [
        "Use <host> with ",
        commandPart(COMMAND_NAME, [arg("install")]),
        " to select it for a Project.",
      ],
    },
  ];
}


type HostInventoryMachineBase = ListInventoryMachineBase<"hosts">;

interface HostInventoryMachineSuccessPayload extends HostInventoryMachineBase {
  readonly outcome: "success";
  readonly hosts: readonly HostInventoryRecord[];
}

/** Versioned machine payload for the read-only Agent Host inventory topic. */
export function formatHostInventoryJson(
  hosts: readonly HostInventoryRecord[],
): string {
  return serializeListInventoryMachinePayload(
    listInventoryMachinePayload("hosts", "success", { hosts }) satisfies
      HostInventoryMachineSuccessPayload,
  );
}

/** The Temporary Profile Installation inventory listing as a presentation document. */
export function temporaryInventoryDocument(
  installations: readonly TemporaryInventoryRecord[],
  home = homedir(),
  cwd = process.cwd(),
): PresentationDocument {
  if (installations.length === 0) {
    return [
      {
        kind: "notice",
        severity: "success",
        nodes: [{
          kind: "prose",
          parts: [`No ${DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.plural} are active.`],
        }],
      },
      {
        kind: "prose",
        parts: [
          "Create one with ",
          commandPart(COMMAND_NAME, [
            arg("machine"),
            arg("install-temp"),
            arg("<profile>"),
            arg("<project>"),
            arg("--host"),
            arg("<host>"),
          ]),
          ".",
        ],
      },
    ];
  }

  const nodes: PresentationNode[] = [
    {
      kind: "heading",
      text: `${capitalize(DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.plural)} (${installations.length}):`,
    },
  ];
  for (const installation of installations) {
    nodes.push(
      spacerNode(),
      {
        kind: "key-value",
        key: "Temporary installation",
        value: { kind: "identifier", value: installation.temporaryInstallationId },
        category: "path",
      },
      {
        kind: "key-value",
        key: "  Project",
        value: projectPathNode(installation.project, installation.project, "fleet"),
      },
      {
        kind: "key-value",
        key: "  Profile",
        value: { kind: "identifier", value: installation.profileId },
        category: "path",
      },
      {
        kind: "key-value",
        key: "  Host",
        value: { kind: "identifier", value: installation.host },
        category: "path",
      },
    );
  }
  nodes.push(
    spacerNode(),
    {
      kind: "prose",
      parts: [
        "Use ",
        commandPart(COMMAND_NAME, [
          arg("machine"),
          arg("remove-temp"),
          arg("<temporary-installation-id>"),
        ]),
        " to remove one.",
      ],
    },
  );
  return nodes;
}


type TemporaryInventoryMachineBase = ListInventoryMachineBase<"temporary">;

interface TemporaryInventoryMachineSuccessPayload extends TemporaryInventoryMachineBase {
  readonly outcome: "success";
  readonly temporaryInstallations: readonly TemporaryInventoryRecord[];
}

interface TemporaryInventoryMachineErrorPayload extends TemporaryInventoryMachineBase {
  readonly error: string;
  readonly outcome: "error";
  readonly temporaryInstallations: readonly [];
}

type TemporaryInventoryMachinePayload =
  | TemporaryInventoryMachineErrorPayload
  | TemporaryInventoryMachineSuccessPayload;

/** Versioned machine payload for the read-only Temporary Profile Installation inventory topic. */
export function formatTemporaryInventoryJson(
  installations: readonly TemporaryInventoryRecord[],
): string {
  return serializeListInventoryMachinePayload(
    listInventoryMachinePayload("temporary", "success", {
      temporaryInstallations: installations,
    }) satisfies TemporaryInventoryMachinePayload,
  );
}

export function formatTemporaryInventoryToolErrorJson(message: string): string {
  return serializeListInventoryMachinePayload(
    listInventoryMachinePayload("temporary", "error", {
      error: message,
      temporaryInstallations: [] as const,
    }) satisfies TemporaryInventoryMachinePayload,
  );
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled output kind: ${String(value)}`);
}

/** The one home for the validation count clause: document and protector share it. */
function validationCountClause(result: ValidationResult): string {
  return `(${plural(result.profiles.length, "Profile")}, ${plural(
    result.bindings,
    DEFAULT_VIEW_LEXICON.projectBinding.singular,
    DEFAULT_VIEW_LEXICON.projectBinding.plural,
  )})`;
}

/** The validation result view as a presentation document. */
export function validationResultDocument(result: ValidationResult): PresentationDocument {
  const profileCount = result.profiles.length;
  const countClause = validationCountClause(result);
  return [
    // Severity is the validation outcome fact: the view only renders valid results.
    {
      kind: "notice",
      severity: "success",
      nodes: [{
        kind: "prose",
        parts: [
          `Workspace and ${DEFAULT_VIEW_LEXICON.localConfiguration} valid `,
          identifierPart(countClause),
        ],
      }],
    },
    ...result.warnings.map((warning) => ({
      kind: "list-item" as const,
      parts: [warning],
      category: "attention" as const,
    })),
    {
      kind: "key-value",
      key: "Profiles found",
      value: {
        kind: "prose",
        parts: [profileCount === 0 ? "none" : result.profiles.join(", ")],
      },
    },
    {
      kind: "key-value",
      key: "Hosts bound",
      value: {
        kind: "prose",
        parts: [result.hosts.length === 0 ? "none" : result.hosts.join(", ")],
      },
    },
    {
      kind: "key-value",
      key: "Next",
      value: {
        kind: "command",
        program: COMMAND_NAME,
        args: [{
          kind: "text",
          value: result.bindings === 0 ? "install <profile> --host <host>" : "status",
        }],
      },
    },
  ];
}

/** The interactive general-confirmation question for uninstall (DEC-004). */
export const UNINSTALL_CONFIRMATION_QUESTION = "Uninstall as listed? (y/N)";

/** The interactive general-confirmation review (DEC-004, US-003): the exact
 * selected scope — Projects with their Profile and Hosts — before any
 * write. Forgetting is stated plainly: a later update will not reinstall. */
export function uninstallConfirmationDocument(preview: {
  readonly projects: readonly {
    readonly canonicalProject?: string;
    readonly project: string;
    readonly profile: string;
    readonly hosts: readonly string[];
  }[];
}): PresentationDocument {
  return [
    { kind: "heading", text: "Uninstall:" },
    ...preview.projects.map((entry): PresentationNode => ({
      kind: "prose",
      parts: [
        `  ${displayProjectPath(entry.canonicalProject ?? entry.project, entry.project, "fleet")} (Profile ${entry.profile}, Hosts ${entry.hosts.join(", ")})`,
      ],
    })),
    {
      kind: "prose",
      parts: ["Removes the generated files and forgets the recorded selection. A later update will not reinstall them."],
    },
  ];
}

/** The declined-or-cancelled general-confirmation diagnostic (DEC-004):
 * what happened and the command that answers it explicitly. Rendered with
 * neutral styling: declining is a safe choice, not an error. */
export function uninstallDeclinedDocument(
  reason: ApplyDeclinedAnswer,
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return diagnosticDocument({
    happened: [reason === "cancelled"
      ? "uninstall was cancelled before any write"
      : reason === "default"
        ? "uninstall kept the current state; nothing was written (default answer no)"
        : "uninstall kept the current state; nothing was written (you answered no)"],
    why: [["No Project or setting was changed."]],
    whatToType: [[
      "To proceed without asking, run ",
      commandPart(COMMAND_NAME, commandArguments),
    ]],
    severity: "info",
  });
}

/** The missing general-confirmation refusal diagnostic (DEC-004): a
 * non-interactive (or machine-JSON) uninstall without `--auto-confirm`
 * refuses before any write, with the runnable command that answers it. */
export function uninstallConfirmationRequiredDocument(
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return diagnosticDocument({
    happened: ["uninstall needs explicit confirmation before any write"],
    why: [["No Project or setting was changed."]],
    whatToType: [[
      "To proceed without asking, run ",
      commandPart(COMMAND_NAME, commandArguments),
    ]],
  });
}

/** The missing-scope refusal diagnostic (DEC-003/DEC-004): an uninstall
 * without an explicit scope refuses instead of implying all Projects.
 * Missing choices stay missing — the equivalent names the fleet scope
 * explicitly so re-running it stays intentional. */
export function uninstallMissingScopeDocument(
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return diagnosticDocument({
    happened: ["uninstall needs an explicit scope before any write; an absent scope never implies all Projects"],
    why: [["No Project or setting was changed."]],
    whatToType: [[
      "To remove every installation without asking, run ",
      commandPart(COMMAND_NAME, commandArguments),
      ", or scope to one Project with --here or --project.",
    ]],
  });
}

/** The truthful zero-match outcome (DEC-003): the selected scope matched no
 * installation, so nothing was written. Never an error-shaped report for a
 * state that simply selects nothing. */
export function uninstallNoMatchDocument(description: string): PresentationDocument {
  return diagnosticDocument({
    happened: [`uninstall matched no installation for ${description}; nothing was written`],
    why: [["No Project or setting was changed."]],
    whatToType: [[
      "Run ",
      commandPart(COMMAND_NAME, [arg("list"), arg("projects")]),
      " to list installed Projects.",
    ]],
  });
}

/** The compact uninstall receipt (DEC-007/US-011): removed Project count
 * once, without per-file, per-Project, or Profile-breakdown inventories.
 * Skipped Projects keep actionable identities with their reasons;
 * warnings stay visible. Complete evidence belongs to history (US-012). */
export function uninstallReceiptDocument(
  result: UninstallApplicationResult,
): PresentationDocument {
  const removedCount = result.completed.length;
  const skippedCount = result.skipped.length;
  const nodes: PresentationNode[] = [{
    kind: "notice",
    severity: "success",
    nodes: [{
      kind: "prose",
      parts: [removedCount === 0
        ? skippedCount === 0
          ? "No Agent Profile Kit-owned output was installed for the selected scope."
          : `Removed no Agent Profile Kit-owned output; skipped ${plural(skippedCount, "Project")} below.`
        : `Removed proven Agent Profile Kit-owned output from ${plural(removedCount, "Project")} and forgot ${removedCount === 1 ? "its" : "their"} recorded selection.`],
    }],
  }];
  for (const warning of result.warnings) {
    nodes.push({
      kind: "list-item" as const,
      parts: [warning],
      category: "attention" as const,
    });
  }
  if (skippedCount > 0) {
    nodes.push(
      spacerNode(),
      {
        kind: "prose",
        parts: [`Skipped ${plural(skippedCount, "Project")} with a known Blocker; healthy Projects above still completed:`],
      },
    );
    for (const skipped of result.skipped) {
      nodes.push(
        spacerNode(),
        {
          kind: "key-value",
          key: "Project",
          value: projectPathNode(skipped.canonicalProject ?? skipped.project, skipped.project, "fleet"),
        },
        { kind: "prose", parts: [`  - ${renderItemReason(skipped.reason)}`], category: "error" },
      );
    }
  }
  return nodes;
}

/** The stopped-removal diagnostic (DEC-006/US-008): an unexpected write
 * failure stopped further work. Completed Projects stay completed, the
 * failed Project carries its restoration evidence, unattempted Projects
 * remain untouched, and the retry preserves the original scope. */
export function uninstallExecutionFailureDocument(input: {
  readonly failed: UninstallFailedProject;
  readonly completed: readonly UninstallCompletedProject[];
  readonly unattempted: readonly UninstallUnattemptedProject[];
  readonly retryArguments: readonly CommandArg[];
}): PresentationDocument {
  const { failed, completed, unattempted, retryArguments } = input;
  const restoration = failed.restoreError !== undefined
    ? `Previous selection/output restore failed: ${failed.restoreError}`
    : failed.selectionRestored
      ? "The previous selection and output were restored where possible."
      : "The previous selection could not be restored.";
  return diagnosticDocument({
    happened: [`uninstall stopped at ${failed.project}: ${failed.detail}`],
    why: [[
      completed.length === 0
        ? "No Project was completed before the failure."
        : `Completed Projects stay completed: ${completed.map((entry) => entry.project).join(", ")}.`,
      ` ${restoration}`,
      unattempted.length === 0
        ? ""
        : ` Unattempted Projects remain untouched: ${unattempted.map((entry) => entry.project).join(", ")}.`,
    ]],
    whatToType: [[
      "After resolving the cause, retry the same scope with ",
      commandPart(COMMAND_NAME, retryArguments),
    ]],
  });
}


function summarizeOutputs(outputs: readonly OutputReconciliationItem[]): OutputSummary {
  return outputs.reduce<OutputSummary>(
    (summary, output) => {
      switch (output.kind) {
        case "addition":
          return { ...summary, additions: summary.additions + 1 };
        case "removal":
          return { ...summary, removals: summary.removals + 1 };
        case "unchanged":
          return summary;
        case "update":
          return { ...summary, updates: summary.updates + 1 };
        default:
          return assertNever(output.kind);
      }
    },
    { additions: 0, removals: 0, updates: 0 },
  );
}

/** Concise change units; unchanged generated outputs are omitted by design. */
function changeParts(summary: OutputSummary): string[] {
  const parts: string[] = [];
  const generatedFile = DEFAULT_VIEW_LEXICON.generatedOutput.singular;
  if (summary.additions > 0) parts.push(plural(summary.additions, `${generatedFile} addition`));
  if (summary.updates > 0) parts.push(plural(summary.updates, `${generatedFile} update`));
  if (summary.removals > 0) parts.push(plural(summary.removals, `${generatedFile} removal`));
  return parts;
}

function changeCount(summary: OutputSummary): number {
  return summary.additions + summary.updates + summary.removals;
}

/** One canonical overflow pointer shared by every capped path list in default views. */
function overflowPointer(overflow: number, singular: string): string {
  const noun = overflow === 1 ? singular : `${singular}s`;
  return `… ${overflow} more ${noun}; use --verbose to see all paths`;
}

function outputPathLine(
  output: Pick<OutputReconciliationItem, "kind" | "path">,
): string | undefined {
  switch (output.kind) {
    case "addition":
      return `+ ${output.path}`;
    case "update":
      return `~ ${output.path}`;
    case "removal":
      return `- ${output.path}`;
    case "unchanged":
      return undefined;
    default:
      return assertNever(output.kind);
  }
}

function outputPathLines(
  outputs: readonly Pick<OutputReconciliationItem, "kind" | "path">[],
  /** Infinity renders every path; a finite number caps the list with an overflow pointer. */
  limit: number = DEFAULT_OUTPUT_PATH_LIMIT,
): readonly string[] {
  const paths = [...outputs]
    // Protect attention and destructive changes from the concise-view cap, then
    // use canonical byte ordering so the visible path set is locale-independent.
    .sort((left, right) =>
      OUTPUT_PATH_PRIORITY[left.kind] - OUTPUT_PATH_PRIORITY[right.kind] ||
      compareCanonicalStrings(left.path, right.path) ||
      compareCanonicalStrings(left.kind, right.kind)
    )
    .flatMap((output) => {
      const line = outputPathLine(output);
      return line === undefined ? [] : [line];
    });
  const overflow = paths.length - limit;
  return overflow > 0
    ? [
        ...paths.slice(0, limit),
        overflowPointer(overflow, "file"),
      ]
    : paths;
}

function changedRepositoryExclusions(
  report: ReconciliationReport,
): readonly ReconciliationProjectRecord["repositoryExclusions"][number][] {
  return reportRepositoryExclusions(report).filter((change) =>
    change.current.length !== change.next.length ||
    change.current.some((entry, index) => entry !== change.next[index]),
  );
}

function exclusionDelta(change: ReconciliationProjectRecord["repositoryExclusions"][number]): {
  readonly additions: readonly string[];
  readonly removals: readonly string[];
} {
  const current = new Set(change.current);
  const next = new Set(change.next);
  return {
    additions: change.next.filter((entry) => !current.has(entry)),
    removals: change.current.filter((entry) => !next.has(entry)),
  };
}

function exclusionDeltaText(change: ReconciliationProjectRecord["repositoryExclusions"][number]): string {
  const delta = exclusionDelta(change);
  const parts: string[] = [];
  if (delta.additions.length > 0) parts.push(`add ${delta.additions.join(", ")}`);
  if (delta.removals.length > 0) parts.push(`remove ${delta.removals.join(", ")}`);
  return parts.join("; ");
}

function repositoryExclusionClause(
  report: ReconciliationReport,
  completed: boolean,
  /** Ready status suppresses routine pending bookkeeping and keeps drift attention. */
  driftOnly = false,
): string | undefined {
  const changed = changedRepositoryExclusions(report);
  const delta = (driftOnly ? changed.filter((change) => change.installed) : changed)
    .map(exclusionDelta)
    .reduce(
      (total, change) => ({
        additions: total.additions + change.additions.length,
        removals: total.removals + change.removals.length,
      }),
      { additions: 0, removals: 0 },
    );
  const parts: string[] = [];
  if (delta.additions > 0) {
    parts.push(`${plural(delta.additions, "entry", "entries")} ${completed ? "added" : "to add"}`);
  }
  if (delta.removals > 0) {
    parts.push(`${plural(delta.removals, "entry", "entries")} ${completed ? "removed" : "to remove"}`);
  }
  return parts.length === 0
    ? undefined
    : `${capitalize(DEFAULT_VIEW_LEXICON.repositoryExclusion.plural)}: ${parts.join(", ")}.`;
}

function isStateReadFailureFact(
  reason: NonNullable<ReconciliationItem["reason"]>,
): reason is StateReadFailureFact {
  return typeof reason === "object" &&
    (STATE_READ_FAILURE_CASES as readonly string[]).includes(reason.case);
}

/** Machine projection: diagnostic strings pass through; typed facts compose canonically. */
function renderMachineItemReason(reason: NonNullable<ReconciliationItem["reason"]>): string {
  if (typeof reason === "string") return reason;
  return isStateReadFailureFact(reason)
    ? describeStateReadFailure(reason)
    : describeOwnershipFailure(reason);
}

/** Human projection: typed facts compose through the newcomer vocabulary. */
function renderItemReason(reason: NonNullable<ReconciliationItem["reason"]>): string {
  return applyNewcomerSubstitutions(renderMachineItemReason(reason));
}

function itemText(item: ReconciliationItem): string {
  return `${item.kind}${item.reason ? ` (${renderItemReason(item.reason)})` : ""}`;
}

function isNonCurrentKind(kind: ReconciliationKind): kind is NonCurrentKind {
  return kind !== "current";
}

function presentNonCurrentKinds(items: readonly ReconciliationItem[]): readonly NonCurrentKind[] {
  const present = new Set<NonCurrentKind>();
  for (const item of items) {
    if (isNonCurrentKind(item.kind)) present.add(item.kind);
  }
  return NON_CURRENT_STATE_ORDER.filter((kind) => present.has(kind));
}

function stateExplanationLines(items: readonly ReconciliationItem[]): readonly string[] {
  const kinds = presentNonCurrentKinds(items);
  if (kinds.length === 0) return [];
  return [
    "State explanations:",
    ...kinds.map((kind) => `- ${kind}: ${STATE_EXPLANATIONS[kind]}`),
  ];
}

/** The typed state-explanation section; empty when every item is current. */
function stateExplanationNodes(items: readonly ReconciliationItem[]): PresentationNode[] {
  const kinds = presentNonCurrentKinds(items);
  if (kinds.length === 0) return [];
  return [
    { kind: "heading", text: "State explanations:" },
    ...kinds.map((kind) => ({
      kind: "list-item" as const,
      parts: [`${kind}: ${STATE_EXPLANATIONS[kind]}`],
    })),
  ];
}

function blockerProject(blocker: ReconciliationBlocker): string | undefined {
  return blocker.project || undefined;
}

function requireProjectGroup(
  groups: readonly ProjectGroup[],
  canonicalProject: string,
): ProjectGroup {
  const group = groups.find((candidate) => candidate.canonicalProject === canonicalProject);
  if (group === undefined) {
    throw new Error(`Project ${canonicalProject} is missing its presentation group`);
  }
  return group;
}

function shortenProjectReferences(
  message: string,
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): string {
  const references = groups.flatMap((group) => {
    const authoredAbsolute = absoluteAuthoredPath(group.project, homedir());
    const replacement = displayProjectPath(group.canonicalProject, group.project, scope);
    return [...new Set([group.canonicalProject, authoredAbsolute])].map((project) => ({ project, replacement }));
  }).sort((left, right) =>
    right.project.length - left.project.length || left.project.localeCompare(right.project)
  );
  return references.reduce(
    (rendered, reference) =>
      replaceProjectReference(rendered, reference.project, reference.replacement),
    message,
  );
}

/**
 * The one canonical Project-reference replacement policy shared by every human
 * view: boundary-aware so a longer path sharing the Project prefix is never
 * mangled, and cwd-dot children elide the slash so `./x` renders as `x`.
 */
function replaceProjectReference(
  message: string,
  project: string,
  replacement: string,
): string {
  let cursor = 0;
  let formatted = "";
  while (cursor < message.length) {
    const index = message.indexOf(project, cursor);
    if (index < 0) return formatted + message.slice(cursor);
    const previous = message[index - 1];
    const next = message[index + project.length];
    const startsAtBoundary = index === 0 || previous === undefined ||
      /[\s("'=:/]/.test(previous);
    const endsAtBoundary = next === undefined || /[\s)"':/,;]/.test(next);
    if (!startsAtBoundary || !endsAtBoundary) {
      formatted += message.slice(cursor, index + 1);
      cursor = index + 1;
      continue;
    }
    const cwdChild = replacement === "." && next === "/";
    formatted += message.slice(cursor, index) + (cwdChild ? "" : replacement);
    cursor = index + project.length + (cwdChild ? 1 : 0);
  }
  return formatted;
}

function isOutputOwnershipConflict(
  blocker: ReconciliationBlocker,
): blocker is StructuredReconciliationBlocker & {
  readonly kind: typeof OUTPUT_OWNERSHIP_CONFLICT;
  readonly scope: "project";
} {
  return (
    isStructuredBlocker(blocker) &&
    blocker.kind === OUTPUT_OWNERSHIP_CONFLICT &&
    blocker.scope === "project"
  );
}

/**
 * Default-view evidence for one grouped ownership conflict: one explanation and
 * a deterministic capped path list with an overflow pointer to --verbose.
 */
function blockerScopeText(
  blocker: ReconciliationBlocker,
  displayProject?: string,
): string {
  return blocker.scope === "global"
    ? "Global"
    : `Project ${displayProject ?? blocker.project}`;
}

function affectedItemLabel(item: BlockerAffectedItem): string {
  return `Affected ${item.kind}: ${item.value}`;
}

/** The proven tracked paths of one ownership conflict, in canonical order. */
function outputOwnershipConflictPaths(
  blocker: StructuredReconciliationBlocker & {
    readonly kind: typeof OUTPUT_OWNERSHIP_CONFLICT;
    readonly scope: "project";
  },
): readonly string[] {
  return blocker.affectedItems
    .filter((item) => item.kind === "path")
    .map((item) => item.value)
    .sort(compareCanonicalStrings);
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

/**
 * Concise grouping by immediate parent directory (#353): every proven path
 * belongs to exactly one group, counts sum to the Blocker total, and labels
 * never imply authority over unlisted descendants under the prefix.
 */
function trackedPathGroupLines(
  paths: readonly string[],
  indent: string,
): readonly string[] {
  const members = new Map<string, string[]>();
  for (const path of paths) {
    const directory = parentDirectory(path);
    const group = members.get(directory);
    if (group === undefined) members.set(directory, [path]);
    else group.push(path);
  }
  return [...members.entries()]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([directory, groupPaths]) =>
      groupPaths.length === 1
        ? `${indent}    - ${groupPaths[0]}`
        : `${indent}    - ${directory === "." ? "./" : `${directory}/`} (${groupPaths.length} paths)`
    );
}


function groupProjects(report: ReconciliationReport): GroupedProjects {
  const groups = report.projects.map((record): ProjectGroup => ({
    blockers: [...record.blockers],
    canonicalProject: record.canonicalProject,
    items: [{ ...record.state, project: record.project }],
    outputs: record.outputs.map((output) => ({
      kind: output.kind,
      path: output.path,
      project: record.project,
    })),
    project: record.project,
  })).sort((left, right) => compareCanonicalStrings(
    left.canonicalProject,
    right.canonicalProject,
  ));
  return { groups, unscopedItems: [] };
}

function desiredInstallation(report: ReconciliationReport, project: string): PresentedDesired | undefined {
  const record = report.projects.find((candidate) =>
    candidate.canonicalProject === project || candidate.project === project
  );
  return record?.desired === undefined ? undefined : {
    ...record.desired,
    canonicalProject: record.canonicalProject,
    project: record.project,
    setupSteps: record.setupSteps,
  };
}

function groupNeedsAttention(group: ProjectGroup, command: LifecycleCommand): boolean {
  const summary = summarizeOutputs(group.outputs);
  return (
    group.blockers.length > 0 ||
    changeCount(summary) > 0 ||
    group.items.some((item) => item.kind !== "current") ||
    (command === "status" && group.items.length === 0)
  );
}

function fullyCurrentProjectCount(report: ReconciliationReport): number | undefined {
  if (
    reportItems(report).length === 0 ||
    reportHasReconciliationWork(report)
  ) {
    return undefined;
  }
  return new Set(reportItems(report).map((item) => item.project)).size;
}

function reportHasReconciliationWork(report: ReconciliationReport): boolean {
  return (
    reportBlockers(report).length > 0 ||
    changeCount(summarizeOutputs(reportOutputs(report))) > 0 ||
    reportItems(report).some((item) => item.kind !== "current") ||
    changedRepositoryExclusions(report).length > 0
  );
}

function isNoOpApply(
  command: LifecycleCommand,
  report: ReconciliationReport,
  receipt: ReconciliationReport | undefined,
): boolean {
  return command === "update" &&
    receipt !== undefined &&
    fullyCurrentProjectCount(report) !== undefined &&
    !reportHasReconciliationWork(receipt);
}

/** Projects that still need reconciliation work but carry no Blocker. */
function stillPendingProjects(
  report: ReconciliationReport,
  scope: LocationDisplayScope,
): readonly string[] {
  return report.projects
    .filter((project) =>
      project.blockers.length === 0 &&
      (
        project.state.kind !== "current" ||
        project.outputs.some((output) => output.kind !== "unchanged") ||
        project.repositoryExclusions.length > 0
      )
    )
    .map((project) => displayProjectPath(project.canonicalProject, project.project, scope));
}


function outcomeLine(
  command: LifecycleCommand,
  report: ReconciliationReport,
  applyCompleted = false,
  selection?: ProjectBindingSelection,
): string {
  if (command === "update") {
    if (reportBlockers(report).length > 0) return applyCompleted ? "Update completed with blockers" : "Update blocked";
    if (reportItems(report).some((item) => item.kind !== "current")) return "Update completed with attention";
    return "Update complete";
  }
  const currentProjects = fullyCurrentProjectCount(report);
  if (reportBlockers(report).length > 0) return "Cannot update";
  // An empty filtered selection is a valid empty result, not an unconfigured
  // fleet: the outcome names the filter, never unconfigured-fleet copy (DEC-006).
  if (selection?.filter !== undefined && report.projects.length === 0) {
    return selection.filter === "stale" ? "No stale Projects." : "No Blocked Projects.";
  }
  if (currentProjects !== undefined) {
    if (reportHasHostAttention(report)) return "Host attention required";
    const projects = capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural);
    return `All ${projects} are current (${plural(currentProjects, capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular))})`;
  }
  if (reportItems(report).length > 0) return "Ready to update";
  return `No ${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)} are configured`;
}

function aggregateLine(
  command: LifecycleCommand,
  report: ReconciliationReport,
  groups: readonly ProjectGroup[],
): string | undefined {
  const installations = groups.length;
  const parts = [
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)}: ${installations}`,
  ];
  if (reportBlockers(report).length > 0) {
    if (command === "update") parts.push("Pending: blocked");
    parts.push(`Blockers: ${reportBlockers(report).length}`);
    return parts.join(" · ");
  }
  const changes = changeParts(summarizeOutputs(reportOutputs(report)));
  if (changes.length > 0) {
    parts.push(`${command === "update" ? "Pending" : "Changes"}: ${changes.join(", ")}`);
  }
  return parts.length === 1 ? undefined : parts.join(" · ");
}

function warningGroupKey(warning: ReconciliationWarning): string {
  return JSON.stringify([
    warning.kind,
    flatInlineText(warning.parts),
    warning.consequence ?? "",
    [...warning.copyableValues],
  ]);
}

export interface WarningPresentationGroup {
  readonly consequence?: string;
  readonly copyableValues: readonly string[];
  readonly kind: ReconciliationWarning["kind"];
  readonly parts: readonly InlineContent[];
  readonly projects: readonly {
    readonly canonicalProject: string;
    readonly project: string;
  }[];
}

function groupWarnings(
  reports: ReconciliationReport | readonly ReconciliationReport[],
): readonly WarningPresentationGroup[] {
  const reportList = Array.isArray(reports) ? reports : [reports];
  const groups = new Map<string, {
    consequence?: string;
    copyableValues: readonly string[];
    kind: ReconciliationWarning["kind"];
    parts: readonly InlineContent[];
    projects: { canonicalProject: string; project: string }[];
  }>();

  for (const report of reportList) {
    for (const projectRecord of report.projects) {
      for (const warning of projectRecord.warnings) {
        const message = flatInlineText(warning.parts);
        if (
          message.endsWith(REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX) ||
          message.endsWith(REPOSITORY_EXCLUSION_MODIFIED_WARNING_SUFFIX)
        ) {
          continue;
        }
        const key = warningGroupKey(warning);
        const existing = groups.get(key);
        if (!existing) {
          groups.set(key, {
            ...(warning.consequence === undefined ? {} : { consequence: warning.consequence }),
            copyableValues: [...warning.copyableValues],
            kind: warning.kind,
            parts: warning.parts,
            projects: [{
              canonicalProject: projectRecord.canonicalProject,
              project: projectRecord.project,
            }],
          });
        } else {
          if (!existing.projects.some((p) => p.canonicalProject === projectRecord.canonicalProject)) {
            existing.projects.push({
              canonicalProject: projectRecord.canonicalProject,
              project: projectRecord.project,
            });
          }
        }
      }
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...(group.consequence === undefined ? {} : { consequence: group.consequence }),
      copyableValues: group.copyableValues,
      kind: group.kind,
      parts: group.parts,
      projects: [...group.projects].sort((left, right) =>
        compareCanonicalStrings(left.canonicalProject, right.canonicalProject)
      ),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(flatInlineText(left.parts), flatInlineText(right.parts)) ||
      compareCanonicalStrings(left.kind, right.kind) ||
      compareCanonicalStrings(left.consequence ?? "", right.consequence ?? "") ||
      compareCanonicalStrings(
        JSON.stringify(left.copyableValues),
        JSON.stringify(right.copyableValues),
      )
    );
}

/** Output kinds that make a transition-triggered Host Setup Step newly relevant. */
const TRANSITION_TRIGGERING_OUTPUT_KINDS: ReadonlySet<OutputReconciliationKind> = new Set([
  "addition",
  "update",
]);

/**
 * Whether the Apply Receipt creates the first Host-consumed generated output
 * for this Project/Host pairing (#292 DEC-016). Later additions, and replacements
 * that remove a prior Host-consumed output in the same receipt, are not first use.
 */
function isFirstRelevantHostOutput(
  changeProject: ReconciliationProjectRecord,
  resultingProject: ReconciliationProjectRecord,
  host: string,
): boolean {
  const addedPaths = new Set(
    changeProject.outputs
      .filter((output) =>
        output.kind === "addition" && output.consumingHosts.includes(host)
      )
      .map((output) => output.path),
  );
  if (addedPaths.size === 0) return false;
  const hadPriorResultingOutput = resultingProject.outputs.some((output) =>
    output.consumingHosts.includes(host) &&
    output.kind !== "removal" &&
    !addedPaths.has(output.path)
  );
  const hadRemovedHostOutput = changeProject.outputs.some((output) =>
    output.kind === "removal" && output.consumingHosts.includes(host)
  );
  return !hadPriorResultingOutput && !hadRemovedHostOutput;
}

/** A Host Setup Step selected for one surface, with its Project identities. */
interface PresentedSetupStep extends ProjectIdentity {
  readonly message: string;
  readonly step: HostSetupStep;
}

/**
 * Select the Host Setup Steps one lifecycle surface presents (DEC-036–DEC-038,
 * #292 DEC-014–DEC-020): transition-triggered steps appear when their associated
 * output is added, updated, or repaired, while standing trust and root-launch
 * guidance appear only when the Apply Receipt adds a relevant output consumed by
 * that Project/Host pairing (#292 DEC-016). Concise `status` renders none (DEC-008,
 * #292 DEC-015); shared-path steps remain verbose (#292 DEC-020); verbose and JSON
 * retain every step as complete evidence.
 */
function presentedSetupSteps(
  command: LifecycleCommand,
  report: ReconciliationReport,
  changeEvidence: ReconciliationReport | undefined,
  verbose: boolean,
  scope: LocationDisplayScope,
): readonly PresentedSetupStep[] {
  if (command === "status" && !verbose) return [];
  if (command === "update" && reportBlockers(report).length > 0) return [];
  const changeReport = changeEvidence ?? report;
  const steps: PresentedSetupStep[] = [];
  for (const project of report.projects) {
    const changeProject = changeReport.projects.find((candidate) =>
      candidate.canonicalProject === project.canonicalProject
    );
    for (const step of project.setupSteps) {
      if (!verbose) {
        if (step.kind === "shared-path") continue;
        if (changeProject === undefined) continue;
        if (step.provenance === "transition") {
          if (!changeProject.outputs.some((output) =>
            output.path === step.output && TRANSITION_TRIGGERING_OUTPUT_KINDS.has(output.kind)
          )) continue;
        } else if (step.provenance === "standing") {
          if (!isFirstRelevantHostOutput(changeProject, project, step.host)) continue;
        }
      }
      const message = setupStepMessage(
        step,
        displayProjectPath(project.canonicalProject, project.project, scope),
      );
      steps.push({
        canonicalProject: project.canonicalProject,
        message,
        project: project.project,
        step,
      });
    }
  }
  return steps;
}

/** One deduplicated setup step group with its deterministic Project scope. */
interface SetupStepGroup {
  readonly message: string;
  projects: ProjectIdentity[];
  readonly step: HostSetupStep;
}

/** The transition-triggered output reference, present only on transition steps. */
function setupStepOutput(step: HostSetupStep): string | undefined {
  return step.provenance === "transition" ? step.output : undefined;
}

function setupStepGroupKey(step: HostSetupStep, message: string): string {
  return [
    step.host,
    step.kind,
    step.provenance,
    setupStepOutput(step) ?? "",
    message,
    step.consequence ?? "",
  ].join("\u0000");
}

/**
 * Collapse identical Host Setup Steps across Projects while distinct
 * consequences and typed bound-project roots stay visible (US-048, US-049).
 */
function groupSetupSteps(
  steps: readonly PresentedSetupStep[],
): readonly SetupStepGroup[] {
  const byKey = new Map<string, SetupStepGroup>();
  for (const { message, step, canonicalProject, project } of steps) {
    const key = setupStepGroupKey(step, message);
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.projects.some((candidate) =>
        candidate.canonicalProject === canonicalProject
      )) {
        existing.projects.push({ canonicalProject, project });
      }
    } else {
      byKey.set(key, { message, projects: [{ canonicalProject, project }], step });
    }
  }
  return [...byKey.values()]
    .map((group) => ({
      ...group,
      projects: [...group.projects].sort((left, right) =>
        compareCanonicalStrings(left.canonicalProject, right.canonicalProject)
      ),
    }))
    .sort((left, right) =>
      left.step.host.localeCompare(right.step.host) ||
      HOST_SETUP_STEP_ORDER.indexOf(left.step.kind) -
        HOST_SETUP_STEP_ORDER.indexOf(right.step.kind) ||
      left.message.localeCompare(right.message),
    );
}

/** Compact affected-Project scope for a deduplicated setup step. */
function setupProjectScope(
  projects: readonly ProjectIdentity[],
  verbose: boolean,
  scope: LocationDisplayScope,
): string {
  if (projects.length === 1) return "";
  if (verbose || projects.length <= PROJECT_SCOPE_LIMIT) {
    return ` (${projects.map((project) => presentProject(project, scope)).join(", ")})`;
  }
  const visible = projects
    .slice(0, PROJECT_SCOPE_LIMIT)
    .map((project) => presentProject(project, scope));
  return ` (${visible.join(", ")}, … ${plural(projects.length - PROJECT_SCOPE_LIMIT, "more Project")}; use --verbose to see all Projects)`;
}

function setupStepLines(
  group: SetupStepGroup,
  verbose: boolean,
  scope: LocationDisplayScope,
): readonly string[] {
  const lines = [`- ${group.message}${setupProjectScope(group.projects, verbose, scope)}`];
  if (group.step.consequence !== undefined) {
    lines.push(`  Consequence: ${group.step.consequence}`);
  }
  return lines;
}

/** Canonical load-prevention consequences that map to the standard concise reason. */
const STANDARD_LOAD_CONSEQUENCES: ReadonlySet<string> = new Set([
  "Declining the hook prevents Profile Context from loading.",
  "Profile Context does not load until the project is trusted.",
  "The Profile does not load until the project is trusted.",
  "Launching from a descendant prevents Profile Context from loading.",
]);

function conciseFirstUseAction(
  step: HostSetupStep,
  projects: readonly string[],
  isSubset: boolean,
): string {
  const base = step.message
    .replace(/:\s*$/, "")
    .replace(/[.:]+$/, "");
  const subsetClause = isSubset
    ? ` for ${plural(projects.length, "project")} (use --verbose to see all Projects)`
    : "";
  const reason = step.consequence === undefined || STANDARD_LOAD_CONSEQUENCES.has(step.consequence)
    ? "so the Profile can load."
    : `(${step.consequence.replace(/[.:]+$/, "")}).`;
  return `${base}${subsetClause} ${reason}`;
}

/** One deduplicated concise first-use group with its affected Projects. */
interface ConciseFirstUseGroup {
  readonly host: HostSetupStep["host"];
  readonly kind: HostSetupStepKind;
  readonly message: string;
  readonly projects: readonly string[];
  readonly step: HostSetupStep;
}

/** Deduplicate identical concise first-use actions across Projects. */
function conciseFirstUseGroups(
  presented: readonly PresentedSetupStep[],
): readonly ConciseFirstUseGroup[] {
  const byKey = new Map<string, {
    host: HostSetupStep["host"];
    kind: HostSetupStepKind;
    message: string;
    projects: string[];
    step: HostSetupStep;
  }>();
  for (const { step, canonicalProject } of presented) {
    const key = `${step.host}\0${step.kind}\0${step.message}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.projects.push(canonicalProject);
    } else {
      byKey.set(key, {
        host: step.host,
        kind: step.kind,
        message: step.message,
        projects: [canonicalProject],
        step,
      });
    }
  }
  return [...byKey.values()]
    .map((group) => ({
      ...group,
      projects: [...new Set(group.projects)].sort(compareCanonicalStrings),
    }))
    .sort((left, right) =>
      left.host.localeCompare(right.host) ||
      HOST_SETUP_STEP_ORDER.indexOf(left.kind) -
        HOST_SETUP_STEP_ORDER.indexOf(right.kind) ||
      left.message.localeCompare(right.message),
    );
}

/** One concise first-use action line for a deduplicated setup-step group. */
function conciseFirstUseActionLine(
  group: ConciseFirstUseGroup,
  changeEvidence: ReconciliationReport | undefined,
): string {
  let isSubset = false;
  if (group.kind === "launch-constraint" && changeEvidence !== undefined) {
    const hostAdditionProjects = changeEvidence.projects.filter((changeProject) =>
      isFirstRelevantHostOutput(changeProject, changeProject, group.host)
    ).length;
    isSubset = group.projects.length < hostAdditionProjects;
  }
  return conciseFirstUseAction(group.step, group.projects, isSubset);
}

function conciseFirstUseLines(
  presented: readonly PresentedSetupStep[],
  changeEvidence: ReconciliationReport | undefined,
): readonly string[] {
  if (presented.length === 0) return [];
  const groups = conciseFirstUseGroups(presented);
  const lines = ["First use:"];
  for (const group of groups) {
    lines.push(`- ${conciseFirstUseActionLine(group, changeEvidence)}`);
  }
  return lines;
}

/** The typed concise first-use section; empty when no presented step remains. */
function conciseFirstUseNodes(
  presented: readonly PresentedSetupStep[],
  changeEvidence: ReconciliationReport | undefined,
): PresentationNode[] {
  const groups = conciseFirstUseGroups(presented);
  if (groups.length === 0) return [];
  return [
    { kind: "heading", text: "First use:" },
    ...groups.map((group) => ({
      kind: "list-item" as const,
      parts: [conciseFirstUseActionLine(group, changeEvidence)],
    })),
  ];
}

/**
 * Host Setup presentation sections: verbose retains separate transition and
 * standing headings, consequences, and project paths (DEC-014, DEC-015); concise
 * apply groups first-use actions under one note with plain reasons (#292 DEC-016–DEC-020).
 */
function setupSectionsFromPresented(
  presented: readonly PresentedSetupStep[],
  verbose: boolean,
  changeEvidence: ReconciliationReport | undefined,
  scope: LocationDisplayScope,
): readonly string[] {
  if (!verbose) {
    return conciseFirstUseLines(presented, changeEvidence);
  }
  const transition = groupSetupSteps(
    presented.filter((item) => item.step.provenance === "transition"),
  );
  const standing = groupSetupSteps(
    presented.filter((item) => item.step.provenance === "standing"),
  );
  const lines: string[] = [];
  if (transition.length > 0) {
    lines.push("Host setup:");
    for (const group of transition) lines.push(...setupStepLines(group, verbose, scope));
  }
  if (standing.length > 0) {
    lines.push("Standing Host setup:");
    for (const group of standing) lines.push(...setupStepLines(group, verbose, scope));
  }
  return lines;
}

/** Concise default view caps the rendered affected-Project list at this size. */
const PROJECT_SCOPE_LIMIT = 4;

/** Select and render the Host Setup Steps for one surface. */
function hostSetupSections(
  command: LifecycleCommand,
  report: ReconciliationReport,
  changeEvidence: ReconciliationReport | undefined,
  verbose = false,
  scope: LocationDisplayScope,
): readonly string[] {
  return setupSectionsFromPresented(
    presentedSetupSteps(command, report, changeEvidence, verbose, scope),
    verbose,
    changeEvidence ?? report,
    scope,
  );
}

/**
 * Emit one invocation-wide next-launch readiness statement for successful changed apply
 * (#292 DEC-011–DEC-013, US-011–US-013).
 */
/**
 * The Profiles whose desired installations one apply's committed work touched:
 * the single canonical home shared by the readiness statement and the
 * Host-loading verification instruction, so both fire on exactly the same
 * evidence.
 */
function appliedProfiles(
  report: ReconciliationReport,
  receipt: ReconciliationReport,
): readonly string[] {
  const changedProjects = new Set(statusAffectedProjects(receipt));
  return [...new Set(
    report.projects
      .filter((record) => changedProjects.has(record.canonicalProject))
      .map((record) => record.desired?.profile)
      .filter((profile): profile is string => profile !== undefined),
  )].sort(compareCanonicalStrings);
}

function readinessLines(
  report: ReconciliationReport,
  receipt: ReconciliationReport,
): readonly string[] {
  const profiles = appliedProfiles(report, receipt);

  if (profiles.length === 0) return [];
  const subject = profiles.length === 1
    ? `Profile ${profiles[0]}`
    : `${plural(profiles.length, "Profile")}`;
  return [`${subject} will load the next time you launch a configured Host from a bound Project root.`];
}

function nextActionScope(
  projects: ReadonlyArray<{ readonly authored: string; readonly canonical: string }>,
  scope: LocationDisplayScope,
): string {
  if (projects.length <= 1) return "";
  const presented = projects.map((project) =>
    displayProjectPath(project.canonical, project.authored, scope),
  );
  if (presented.length <= PROJECT_SCOPE_LIMIT) {
    return ` (${presented.join(", ")})`;
  }
  return ` (${presented.slice(0, PROJECT_SCOPE_LIMIT).join(", ")}, … ${plural(presented.length - PROJECT_SCOPE_LIMIT, "more Project")}; use --verbose to see all Projects)`;
}

/** One invocation-scoped next action node list. */
function nextActionNodes(
  command: LifecycleCommand,
  report: ReconciliationReport,
  surface: {
    readonly groups: readonly ProjectGroup[];
    readonly unscopedItems: readonly ReconciliationItem[];
  },
  options: LifecycleHumanOptions,
): PresentationNode[] {
  if (command === "update" && reportBlockers(report).length === 0) return [];
  const scope = locationDisplayScope(options, report);
  const commandArgs = lifecycleCommandArgs(command, options.selection, report, scope);
  const applyCommandArgs = lifecycleCommandArgs("update", options.selection, report, scope);

  const globalBlockers = reportBlockers(report).filter((blocker) => blockerProject(blocker) === undefined);
  const grouped = new Map<
    string,
    {
      readonly parts: readonly InlineContent[];
      readonly projects: Array<{ readonly authored: string; readonly canonical: string }>;
    }
  >();
  const addAction = (
    parts: readonly InlineContent[],
    project?: { readonly authored: string; readonly canonical: string },
  ): void => {
    const key = flatInlineText(parts);
    const existing = grouped.get(key) ?? { parts, projects: [] };
    if (project !== undefined) existing.projects.push(project);
    grouped.set(key, existing);
  };
  for (const group of surface.groups) {
    const project = { authored: group.project, canonical: group.canonicalProject };
    if (group.blockers.length > 0) {
      const blockerWord = group.blockers.length === 1 ? "blocker" : "blockers";
      addAction([
        "Resolve the reported ",
        blockerWord,
        ", then run ",
        commandPart(COMMAND_NAME, commandArgs),
        " again.",
      ]);
      continue;
    }
    if (!groupNeedsAttention(group, command)) continue;
    if (reportBlockers(report).length > 0 && globalBlockers.length === 0) {
      if (command === "status") {
        continue;
      }
      addAction(
        [
          "After all blockers are resolved, run ",
          commandPart(COMMAND_NAME, applyCommandArgs),
          command === "update" ? " again." : ".",
        ],
        project,
      );
      continue;
    }
    if (globalBlockers.length > 0) continue;
    addAction(
      ["Run ", commandPart(COMMAND_NAME, applyCommandArgs), "."],
      project,
    );
  }

  if (globalBlockers.length > 0) {
    const blockerWord = globalBlockers.length === 1 ? "blocker" : "blockers";
    addAction([
      "Resolve the reported global ",
      blockerWord,
      ", then run ",
      commandPart(COMMAND_NAME, commandArgs),
      " again.",
    ]);
  }
  if (
    reportBlockers(report).length === 0 &&
    (
      surface.unscopedItems.some((item) => item.kind !== "current") ||
      (grouped.size === 0 && reportHasReconciliationWork(report))
    )
  ) {
    addAction(["Run ", commandPart(COMMAND_NAME, applyCommandArgs), "."]);
  }
  const items: InlineContent[][] = [...grouped.values()].map((entry) => {
    const uniqueProjects = [...new Map(
      entry.projects.map((project) => [project.canonical, project]),
    ).values()].sort((left, right) =>
      compareCanonicalStrings(left.canonical, right.canonical),
    );
    if (grouped.size === 1) return [...entry.parts];
    if (uniqueProjects.length === 1) {
      const project = uniqueProjects[0]!;
      return [
        pathPart(project.canonical, scope, project.authored),
        ": ",
        ...entry.parts,
      ];
    }
    return [...entry.parts, nextActionScope(uniqueProjects, scope)];
  });

  if (items.length === 0) return [];
  return [
    { kind: "heading", text: "Next:" },
    ...items.map((parts) => ({
      kind: "list-item" as const,
      parts,
    })),
  ];
}

/** Observable output operations included in concise fleet summaries. */
type PlannedOutputOperation = Extract<
  OutputReconciliationKind,
  "addition" | "removal" | "update"
>;

const PLANNED_OUTPUT_OPERATION_ORDER: readonly PlannedOutputOperation[] = [
  "addition",
  "update",
  "removal",
];

const PLANNED_OUTPUT_OPERATION_MARKER: Readonly<Record<PlannedOutputOperation, string>> = {
  addition: "+",
  update: "~",
  removal: "-",
};

/** Attention item kinds that are not planned output operations. */
const EXCEPTION_ITEM_KINDS: ReadonlySet<ReconciliationKind> = new Set([
  "drifted output",
  "malformed ownership state",
]);

const STALE_SOURCE_KIND: ReconciliationKind = "stale source";

function isPlannedOutputOperation(
  kind: OutputReconciliationKind,
): kind is PlannedOutputOperation {
  return PLANNED_OUTPUT_OPERATION_ORDER.includes(kind as PlannedOutputOperation);
}

function reportProjects(report: ReconciliationReport): readonly string[] {
  return report.projects.map((project) => project.canonicalProject).sort(compareCanonicalStrings);
}

/** Fleet grouping is based only on observable work and Project scope. */
function useOperationSummary(report: ReconciliationReport, blocked: boolean): boolean {
  return !blocked &&
    reportProjects(report).length > 1 &&
    reportOutputs(report).some((output) => isPlannedOutputOperation(output.kind));
}

interface OperationPresentationGroup {
  readonly operation: PlannedOutputOperation;
  readonly projects: readonly ProjectIdentity[];
  readonly fileCount: number;
}

function groupOutputOperations(
  report: ReconciliationReport,
): readonly OperationPresentationGroup[] {
  return PLANNED_OUTPUT_OPERATION_ORDER.flatMap((operation) => {
    const projects = report.projects.filter((project) =>
      project.outputs.some((output) => output.kind === operation)
    );
    const fileCount = projects.reduce(
      (count, project) => count + project.outputs.filter((output) => output.kind === operation).length,
      0,
    );
    return fileCount === 0 ? [] : [{
      operation,
      projects: projects
        .map(({ canonicalProject, project }) => ({ canonicalProject, project }))
        .sort((left, right) =>
          compareCanonicalStrings(left.canonicalProject, right.canonicalProject)
        ),
      fileCount,
    }];
  });
}

function operationScopeClause(
  group: OperationPresentationGroup,
  report: ReconciliationReport,
  scope: LocationDisplayScope,
  /** Undefined renders every affected Project; a number caps the list. */
  projectLimit?: number,
): string {
  const allProjects = reportProjects(report);
  if (
    group.projects.length === allProjects.length &&
    group.projects.every(({ canonicalProject }) => allProjects.includes(canonicalProject))
  ) {
    return `in ${plural(group.projects.length, "project")}`;
  }
  const limit = projectLimit ?? group.projects.length;
  if (group.projects.length <= limit) {
    return `in ${group.projects.map((project) => presentProject(project, scope)).join(", ")}`;
  }
  const visible = group.projects
    .slice(0, limit)
    .map((project) => presentProject(project, scope));
  return `in ${visible.join(", ")}, … ${plural(group.projects.length - limit, "more Project")}; ` +
    "use --verbose to see all Projects";
}

function operationGroupLine(
  group: OperationPresentationGroup,
  report: ReconciliationReport,
  scope: LocationDisplayScope,
  projectLimit?: number,
): string {
  const operation = group.fileCount === 1 ? group.operation : `${group.operation}s`;
  return `${PLANNED_OUTPUT_OPERATION_MARKER[group.operation]} ${group.fileCount} generated file ${operation} ` +
    operationScopeClause(group, report, scope, projectLimit);
}


/** The typed concise operation summary shared by the status views. */
function operationSummaryNodes(
  report: ReconciliationReport,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const groups = groupOutputOperations(report);
  return [
    spacerNode(),
    { kind: "heading", text: "Project changes:" },
    ...groups.map((group) => ({
      kind: "prose" as const,
      // Status keeps the concise affected-Project cap; only Apply Receipts
      // render every affected Project (US-027, DEC-018).
      parts: [`  ${operationGroupLine(group, report, scope, PROJECT_SCOPE_LIMIT)}`],
    })),
    ...operationAttentionNodes(report, scope),
  ];
}

/** The typed Project-exceptions block shared by the status views. */
function operationAttentionNodes(
  report: ReconciliationReport,
  scope: LocationDisplayScope,
  includeRemovals = false,
): PresentationNode[] {
  const exceptions = report.projects.filter((project) => {
    const hasPlannedOutput = project.outputs.some((output) => isPlannedOutputOperation(output.kind));
    return project.outputs.some((output) =>
      includeRemovals && output.kind === "removal"
    ) ||
      EXCEPTION_ITEM_KINDS.has(project.state.kind) ||
      (project.state.kind === STALE_SOURCE_KIND && !hasPlannedOutput);
  });
  if (exceptions.length === 0) return [];
  const nodes: PresentationNode[] = [
    spacerNode(),
    { kind: "heading", text: "Project exceptions:" },
  ];
  for (const project of exceptions) {
    nodes.push({
      kind: "prose",
      parts: [`  ${displayProjectPath(project.canonicalProject, project.project, scope)}:`],
    });
    const hasPlannedOutput = project.outputs.some((output) => isPlannedOutputOperation(output.kind));
    if (
      EXCEPTION_ITEM_KINDS.has(project.state.kind) ||
      (project.state.kind === STALE_SOURCE_KIND && !hasPlannedOutput)
    ) {
      nodes.push({
        kind: "prose",
        parts: [`    State: ${itemText({ ...project.state, project: project.project })}`],
      });
    }
    const attentionOutputs = project.outputs.filter((output) =>
      includeRemovals && output.kind === "removal"
    );
    nodes.push(...outputPathLines(attentionOutputs).map((line) => ({
      kind: "prose" as const,
      parts: [`    ${line}`],
    })));
  }
  return nodes;
}

function sameProjectScope(groups: readonly OperationPresentationGroup[]): boolean {
  if (groups.length < 2) return true;
  const first = groups[0]!.projects;
  return groups.slice(1).every((group) =>
    group.projects.length === first.length &&
    group.projects.every((project, index) =>
      project.canonicalProject === first[index]!.canonicalProject
    )
  );
}

function conciseFileChangeParts(groups: readonly OperationPresentationGroup[]): readonly string[] {
  return groups.map((group) => {
    const operation = group.fileCount === 1 ? group.operation : `${group.operation}s`;
    return `${group.fileCount} file ${operation}`;
  });
}

function conciseStatusOperationLine(
  group: OperationPresentationGroup,
  report: ReconciliationReport,
  displayScope: LocationDisplayScope,
): string {
  const operation = group.fileCount === 1 ? group.operation : `${group.operation}s`;
  return `${PLANNED_OUTPUT_OPERATION_MARKER[group.operation]} ${group.fileCount} file ${operation} ` +
    // Status keeps the concise affected-Project cap (see operationSummaryNodes).
    operationScopeClause(group, report, displayScope, PROJECT_SCOPE_LIMIT);
}

function statusAffectedProjects(report: ReconciliationReport): readonly string[] {
  return report.projects
    .filter((project) =>
      project.state.kind !== "current" ||
      project.outputs.some((output) => isPlannedOutputOperation(output.kind)) ||
      project.repositoryExclusions.length > 0
    )
    .map((project) => project.canonicalProject)
    .sort(compareCanonicalStrings);
}

function readyStatusImpactLines(
  report: ReconciliationReport,
  displayScope: LocationDisplayScope,
): readonly string[] {
  const operationGroups = groupOutputOperations(report);
  const affectedProjects = statusAffectedProjects(report);
  const scope = plural(affectedProjects.length, "project");
  if (sameProjectScope(operationGroups)) {
    const changes = conciseFileChangeParts(operationGroups);
    return [
      `Updates ready for ${scope}${changes.length > 0 ? ` (${changes.join(", ")})` : ""}.`,
    ];
  }
  return [
    `Updates ready for ${scope}.`,
    ...operationGroups.map((group) => conciseStatusOperationLine(group, report, displayScope)),
  ];
}

/** Build command arguments preserving selection scope. */
function lifecycleCommandArgs(
  command: LifecycleCommand,
  selection: ProjectBindingSelection,
  report?: ReconciliationReport,
  scope?: LocationDisplayScope,
  extraArgs: readonly CommandArg[] = [],
): readonly CommandArg[] {
  const args: CommandArg[] = [{ kind: "text", value: command }];
  if (selection.kind === "project") {
    if (selection.match === "containing") {
      args.push({ kind: "text", value: "--here" });
    } else {
      if (report !== undefined && scope !== undefined) {
        const group = selectedProjectGroup(report, selection.target);
        // A copyable command argument must be a runnable target: the fleet
        // identity is home-relative or absolute, which the Project-target
        // boundary accepts, while the project-scope identity can render the
        // cwd-relative alias that every relative target is rejected as
        // (US-007; the typed relative-target fact).
        args.push({
          kind: "path",
          canonicalPath: group.canonicalProject,
          authoredPath: group.project,
          scope: "fleet",
        });
      } else {
        args.push({ kind: "text", value: selection.target });
      }
    }
  }
  // The copyable command must reproduce the selected write scope: a narrowed
  // next action never suggests the unfiltered fleet (DEC-006).
  if (selection.filter !== undefined) {
    args.push({ kind: "text", value: selection.filter === "stale" ? "--stale" : "--blocked" });
  }
  args.push(...extraArgs);
  return args;
}

function isFleetLifecycle(
  options: LifecycleHumanOptions,
  _report: ReconciliationReport,
): boolean {
  return options.selection.kind === "all";
}

function locationDisplayScope(
  options: LifecycleHumanOptions,
  report: ReconciliationReport,
): LocationDisplayScope {
  return isFleetLifecycle(options, report) ? "fleet" : "project";
}


/**
 * One named path line per affected generated file in the Apply Receipt, with
 * its Project attribution, ordered by operation, Project, then path, and
 * never capped: the receipt names every write it committed (DEC-018).
 */
function operationReceiptPathLines(
  receipt: ReconciliationReport,
  scope: LocationDisplayScope,
): readonly string[] {
  return receipt.projects
    .slice()
    .sort((left, right) => compareCanonicalStrings(left.canonicalProject, right.canonicalProject))
    .flatMap((project) =>
      project.outputs
        .filter((output): output is ReconciliationProjectOutput & { readonly kind: PlannedOutputOperation } =>
          isPlannedOutputOperation(output.kind)
        )
        .flatMap((output) => {
          const path = outputPathLine(output);
          return path === undefined ? [] : [{
            operation: PLANNED_OUTPUT_OPERATION_ORDER.indexOf(output.kind),
            line: `  ${path} (${displayProjectPath(project.canonicalProject, project.project, scope)})`,
          }];
        }),
    )
    .sort((left, right) =>
      left.operation - right.operation || compareCanonicalStrings(left.line, right.line)
    )
    .map((entry) => entry.line);
}


export interface LifecycleHumanOptions {
  readonly context?: TerminalPresentationContext;
  readonly selection: ProjectBindingSelection;
  readonly verbose?: boolean;
}

interface VerboseSectionOptions {
  readonly completedRepositoryExclusions?: boolean;
  readonly includeStateExplanations?: boolean;
  readonly scope: LocationDisplayScope;
  readonly stateExplanationItems?: readonly ReconciliationItem[];
}

export function delimitedContext(context: string): string {
  const body = context.length > 0 && !context.endsWith("\n") ? `${context}\n` : context;
  let fence = "---";
  while (
    context.includes(`${fence} begin Context ${fence}`) ||
    context.includes(`${fence} end Context ${fence}`)
  ) {
    fence += "-";
  }
  return `${fence} begin Context ${fence}\n${body}${fence} end Context ${fence}`;
}


/** The apply outcome notice: severity derives from report facts, never copy. */
function applyOutcomeNotice(
  report: ReconciliationReport,
  applyCompleted: boolean,
): PresentationNode {
  return {
    kind: "notice",
    severity: reportBlockers(report).length > 0 ? "error" : "success",
    nodes: [{ kind: "prose", parts: [outcomeLine("update", report, applyCompleted)] }],
  };
}

/** The typed Apply Receipt operation summary: counted operations, then the
 * named affected paths with their Project attribution (#380). */
function operationReceiptNodes(
  receipt: ReconciliationReport,
  fleetScope: ReconciliationReport,
  scope: LocationDisplayScope,
  includeExclusions = true,
): PresentationNode[] {
  const groups = groupOutputOperations(receipt);
  const exclusionClause = includeExclusions ? repositoryExclusionClause(receipt, true) : undefined;
  if (groups.length === 0 && exclusionClause === undefined) return [];
  const nodes: PresentationNode[] = [
    { kind: "heading", text: "Updated:" },
    ...groups.map((group) => ({
      kind: "prose" as const,
      parts: [`  ${operationGroupLine(group, fleetScope, scope)}`],
    })),
    ...operationReceiptPathLines(receipt, scope).map((line) => ({
      kind: "prose" as const,
      parts: [line],
    })),
  ];
  if (exclusionClause !== undefined) {
    nodes.push(spacerNode(), { kind: "prose", parts: [exclusionClause] });
  }
  return nodes;
}

/** The typed Apply Receipt: applied evidence per Project, or the operation
 * summary above one Project, or the explicit no-change outcome. */
function applyReceiptNodes(
  receipt: ReconciliationReport,
  scope: LocationDisplayScope,
  summarizeFleet = false,
  fleetScope: ReconciliationReport = receipt,
): PresentationNode[] {
  if (summarizeFleet || useOperationSummary(receipt, false)) {
    return operationReceiptNodes(receipt, fleetScope, scope);
  }
  const grouped = groupProjects(receipt);
  const entries: PresentationNode[] = grouped.groups.flatMap((group) => {
    // The receipt names every committed file operation; the concise cap
    // belongs to pending resulting-state views, not committed evidence.
    const paths = outputPathLines(group.outputs, Infinity);
    if (paths.length > 0) {
      return [
        {
          kind: "prose" as const,
          parts: [`- ${displayProjectPath(group.canonicalProject, group.project, scope)}:`],
        },
        ...paths.map((line) => ({ kind: "prose" as const, parts: [`  ${line}`] })),
      ];
    }
    const workKinds = [...new Set(
      group.items
        .filter((item) => item.kind !== "current")
        .map((item) => item.kind === "update"
          ? `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)} update`
          : `${DEFAULT_VIEW_LEXICON.reconciliation.noun} ${item.kind}`),
    )];
    return workKinds.length > 0
      ? [{
        kind: "prose" as const,
        parts: [`- ${displayProjectPath(group.canonicalProject, group.project, scope)}: ${workKinds.join(", ")}`],
      }]
      : [];
  });
  const exclusionClause = repositoryExclusionClause(receipt, true);
  if (entries.length === 0 && exclusionClause === undefined) {
    return [{ kind: "prose", parts: ["Updated: none."] }];
  }
  const nodes: PresentationNode[] = [
    { kind: "heading", text: "Updated:" },
    ...(entries.length > 0
      ? entries
      : [{ kind: "prose" as const, parts: [`- No ${DEFAULT_VIEW_LEXICON.generatedOutput.singular} changes`] }]),
  ];
  if (exclusionClause !== undefined) {
    nodes.push(spacerNode(), { kind: "prose", parts: [exclusionClause] });
  }
  return nodes;
}

/** The committed Apply Receipt plus the Projects it made current, as typed nodes. */
function committedApplyEvidenceNodes(
  receipt: ReconciliationReport,
  postState: ReconciliationReport,
  summarizeFleet: boolean,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const nodes: PresentationNode[] = [
    ...applyReceiptNodes(receipt, scope, summarizeFleet, postState),
  ];
  const appliedProjects = new Set(
    receipt.projects.map((project) => project.canonicalProject),
  );
  const freshlyCurrent = postState.projects
    .filter((project) =>
      project.state.kind === "current" && appliedProjects.has(project.canonicalProject)
    )
    .map((project) => displayProjectPath(project.canonicalProject, project.project, scope));
  if (freshlyCurrent.length > 0) {
    nodes.push({ kind: "prose", parts: [`Freshly current: ${freshlyCurrent.join(", ")}`] });
  }
  return nodes;
}

/** The typed still-pending line; empty when no Project awaits reconciliation work. */
function stillPendingNodes(
  report: ReconciliationReport,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const pending = stillPendingProjects(report, scope);
  if (pending.length === 0) return [];
  return [{ kind: "prose", parts: [`Still pending: ${pending.join(", ")}`] }];
}

/** The typed invocation-wide next-launch readiness statement. */
function readinessNodes(
  report: ReconciliationReport,
  receipt: ReconciliationReport,
): PresentationNode[] {
  return readinessLines(report, receipt).map((line) => ({
    kind: "prose" as const,
    parts: [line],
  }));
}

/**
 * The post-apply Host-loading verification instruction (US-041, DEC-025): one
 * concrete action the user can take inside the updated Project to check that
 * the Agent Host loaded the Profile — start a new session of the configured
 * Host and ask it what Profile material it loaded, looking for the installed
 * material in its answer. The sentence is presentation-authored from facts
 * Agent Profile Kit owns — the applied Profiles, the configured Hosts, and
 * the updated Projects — and never claims that Agent Profile Kit observed the
 * loading or completed Host-owned setup (OOS-009); no Host-specific checking
 * method is authored here, and Host-specific loading knowledge stays
 * Adapter-owned through the rendered Host Setup Steps. It fires exactly where
 * the readiness statement fires: a successful apply that committed
 * installation work, never a no-op, blocked, or failed one, and never machine
 * JSON (US-060).
 */
function hostLoadingVerificationNodes(
  report: ReconciliationReport,
  receipt: ReconciliationReport,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const profiles = appliedProfiles(report, receipt);
  if (profiles.length === 0) return [];
  const changedProjects = new Set(statusAffectedProjects(receipt));
  const changed = report.projects.filter((record) =>
    changedProjects.has(record.canonicalProject)
  );
  // Canonical Host order, matching the sorted Profiles line and every other
  // canonical Host rendering.
  const hosts = [...new Set(
    changed.flatMap((record) => record.desired?.hosts ?? []),
  )].sort(compareCanonicalStrings);
  if (hosts.length === 0) return [];
  const subject = profiles.length === 1
    ? `Profile ${profiles[0]}`
    : `${plural(profiles.length, "Profile")}`;
  const hostList = hosts.length === 1 ? hosts[0]
    : hosts.length === 2 ? `${hosts[0]} and ${hosts[1]}`
    : `${hosts.slice(0, -1).join(", ")}, and ${hosts.at(-1)}`;
  const session = hosts.length === 1
    ? `start a new ${hosts[0]} session`
    : "start a new session of each configured Host";
  const ask = hosts.length === 1
    ? `ask ${hosts[0]} what Profile material it loaded`
    : "ask each Host what Profile material it loaded";
  const evidence = hosts.length === 1
    ? "the installed material should appear in its answer"
    : "the installed material should appear in the answers";
  const [firstChanged] = changed;
  if (changed.length === 1 && firstChanged !== undefined) {
    // The Project identity is one atomic path part (ADR-0016): plain text is
    // tokenized for wrapping, which would split whitespace-containing paths
    // and normalize repeated spaces.
    return [{
      kind: "prose",
      parts: [
        `To check that ${hostList} loaded ${subject}, ${session} in `,
        pathPart(firstChanged.canonicalProject, scope, firstChanged.project),
        ` and ${ask}; ${evidence}.`,
      ],
    }];
  }
  return [{
    kind: "prose",
    parts: [
      `To check that ${hostList} loaded ${subject}, ${session} in each updated Project and ${ask}; ${evidence}.`,
    ],
  }];
}

/** The concise apply view as a presentation document. */
function conciseApplyDocument(
  report: ReconciliationReport,
  receipt: ReconciliationReport | undefined,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, report);
  const grouped = groupProjects(report);
  const groups = grouped.groups;
  const blocked = reportBlockers(report).length > 0;
  const noOpApply = isNoOpApply("update", report, receipt);

  const nodes: PresentationNode[] = [
    applyOutcomeNotice(report, noOpApply || receipt !== undefined),
    ...warningNodes(receipt ? [report, receipt] : report, groups, scope),
  ];
  if (noOpApply) {
    nodes.push({
      kind: "prose",
      parts: [`All ${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)} were already current.`],
    });
  }

  if (!blocked && !noOpApply && receipt !== undefined) {
    const appliedNodes = operationReceiptNodes(receipt, report, scope, false);
    if (appliedNodes.length > 0) nodes.push(spacerNode(), ...appliedNodes);
  }

  const activeGroups = blocked
    ? groups.filter((group) => group.blockers.length > 0)
    : groups.filter((group) => groupNeedsAttention(group, "update"));

  if (!noOpApply) {
    for (const group of activeGroups) {
      nodes.push(
        spacerNode(),
        {
          kind: "key-value",
          key: capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular),
          value: projectPathNode(group.canonicalProject, group.project, scope),
        },
      );
      const desired = desiredInstallation(report, group.canonicalProject);
      if (desired) {
        nodes.push(
          {
            kind: "key-value",
            key: "  Profile",
            value: { kind: "identifier", value: desired.profile },
            category: "path",
          },
          {
            kind: "key-value",
            key: "  Hosts",
            value: { kind: "identifier", value: desired.hosts.join(", ") },
          },
        );
      }
      if (blocked) {
        nodes.push(...group.blockers.flatMap((blocker) =>
          conciseBlockerNodes(
            blocker,
            displayProjectPath(group.canonicalProject, group.project, scope),
            groups,
            "  ",
            scope,
          ),
        ));
        continue;
      }
      for (const item of group.items) {
        if (item.kind !== "current") {
          nodes.push({
            kind: "key-value",
            key: "  State",
            value: { kind: "prose", parts: [itemText(item)] },
            category: "attention",
          });
        }
      }
      const outputLines = outputPathLines(group.outputs);
      if (outputLines.length > 0) {
        nodes.push({ kind: "prose", parts: ["  Files:"] });
        nodes.push(...outputLines.map((line) => ({ kind: "prose" as const, parts: [`  ${line}`] })));
      }
      for (const blocker of group.blockers) {
        nodes.push(...conciseBlockerNodes(
          blocker,
          displayProjectPath(group.canonicalProject, group.project, scope),
          groups,
          "  ",
          scope,
        ));
      }
    }
  }

  if (blocked) {
    const pending = stillPendingNodes(report, scope);
    if (pending.length > 0) nodes.push(spacerNode(), ...pending);
  }

  const exclusionClause = repositoryExclusionClause(report, false, false);
  if (exclusionClause !== undefined) {
    nodes.push(spacerNode(), { kind: "prose", parts: [exclusionClause] });
  }

  const globalBlockers = globalBlockerNodes(report, groups, scope);
  if (globalBlockers.length > 0) nodes.push(spacerNode(), ...globalBlockers);

  const blockedSummary = blocked ? aggregateLine("update", report, groups) : undefined;
  if (blockedSummary !== undefined) {
    nodes.push(spacerNode(), {
      kind: "notice",
      severity: "error",
      nodes: [{ kind: "prose", parts: [blockedSummary] }],
    });
  }

  const setupNodes = conciseFirstUseNodes(
    presentedSetupSteps("update", report, receipt, false, scope),
    receipt,
  );
  if (setupNodes.length > 0) nodes.push(spacerNode(), ...setupNodes);

  const next = nextActionNodes("update", report, {
    groups,
    unscopedItems: grouped.unscopedItems,
  }, options);
  if (next.length > 0) nodes.push(spacerNode(), ...next);

  if (blocked && receipt !== undefined) {
    nodes.push(
      spacerNode(),
      ...committedApplyEvidenceNodes(receipt, report, report.projects.length > 1, scope),
    );
  }
  if (!blocked && !noOpApply && receipt !== undefined) {
    const readiness = readinessNodes(report, receipt);
    if (readiness.length > 0) {
      nodes.push(spacerNode(), ...readiness);
      // The check fires exactly where the readiness statement fires: both
      // key off the same applied evidence, and the check follows it.
      nodes.push(...hostLoadingVerificationNodes(report, receipt, scope));
    }
  }
  return nodes;
}

/** The verbose apply view as a presentation document. */
function verboseApplyDocument(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, result.resultingState);
  const groups = groupProjects(result.resultingState).groups;
  const nodes: PresentationNode[] = [
    applyOutcomeNotice(result.resultingState, true),
    ...verboseWarningNodes([result.resultingState, result.receipt], groups, scope),
    { kind: "heading", text: "Pending:" },
    ...verboseLifecycleSections(result.resultingState, {
      scope,
      stateExplanationItems: [
        ...reportItems(result.resultingState),
        ...reportItems(result.receipt),
      ],
    }),
    { kind: "heading", text: "Updated:" },
    ...verboseLifecycleSections(result.receipt, {
      includeStateExplanations: false,
      scope,
    }),
    ...verboseHostSetupNodes("update", result.resultingState, scope),
  ];
  if (reportBlockers(result.resultingState).length === 0) {
    const readiness = readinessNodes(result.resultingState, result.receipt);
    if (readiness.length > 0) {
      nodes.push(...readiness);
      nodes.push(...hostLoadingVerificationNodes(result.resultingState, result.receipt, scope));
    }
  }
  return nodes;
}

/**
 * Whether this apply's committed evidence installed the scaffolded example
 * Profile for the first time (DEC-024, US-040): the receipt's pre-apply state
 * proves the example's Profile Installation did not exist before this apply
 * (`addition`). Maintenance of an already-installed example — a refresh, a
 * no-op, or adding a Host, which reports `update`/`stale source`/`drifted
 * output` even when the apply adds new outputs for the added Host — proves an
 * existing installation and is routine. The condition is pure apply/example
 * evidence; no onboarding state is persisted anywhere.
 */
function applyInstalledExampleProfile(receipt: ReconciliationReport): boolean {
  return receipt.projects.some((project) =>
    project.desired?.profile === AUTHORING_EXAMPLES.profile.id &&
    project.state.kind === "addition"
  );
}

/**
 * The first-run authoring handoff as typed nodes (DEC-024): a successful apply
 * that installed the scaffolded example ends by showing how to author real
 * material with the delivered `apkit new` commands. Piece scaffolds precede
 * the Profile command that selects them, and every command is one atomic
 * command part so it is copyable as printed. The argument sequences mirror the
 * canonical `new` spellings in cli/command-help.ts; they are authored here
 * because presentation owns wording, as with the bind equivalent-command
 * precedent (DEC-032).
 */
function applyAuthoringHandoffNodes(): PresentationNode[] {
  const authoringCommand = (args: readonly string[]): PresentationNode => ({
    kind: "sentence",
    parts: ["  ", commandPart(COMMAND_NAME, args.map((value) => arg(value)))],
    category: "command",
  });
  return [
    spacerNode(),
    { kind: "heading", text: "Now author your own:" },
    authoringCommand(["new", "skill", "<skill>"]),
    authoringCommand(["new", "context", "<context>"]),
    authoringCommand([
      "new",
      "profile",
      "<profile>",
      "--context",
      "<context>",
      "--skill",
      "<skill>",
    ]),
  ];
}

/** The apply receipt view as a presentation document. */
export function applyReportDocument(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const document = options.verbose === true
    ? verboseApplyDocument(result, options)
    : conciseApplyDocument(result.resultingState, result.receipt, options);
  // DEC-024: the first-run apply ends with the authoring handoff; routine
  // applies never carry it. Machine JSON is untouched (US-060).
  return applyInstalledExampleProfile(result.receipt)
    ? [...document, ...applyAuthoringHandoffNodes()]
    : document;
}

/** The blocked apply view as a presentation document. */
export function blockedApplyReportDocument(
  report: BlockedReconciliationReport,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, report);
  if (options.verbose === true) {
    const groups = groupProjects(report).groups;
    return [
      applyOutcomeNotice(report, false),
      ...verboseWarningNodes(report, groups, scope),
      ...verboseLifecycleSections(report, {
        scope,
      }),
      ...verboseHostSetupNodes("update", report, scope),
    ];
  }
  return conciseApplyDocument(report, undefined, options);
}

/** The apply execution-failure view as a presentation document. */
export function applyExecutionFailureDocument(
  failure: {
    readonly detail: string;
    readonly failedProject: ProjectIdentity | undefined;
    readonly message: string;
    readonly pendingProjects: readonly ProjectIdentity[];
    readonly receipt: ReconciliationReport;
    readonly resultingState: ReconciliationReport | undefined;
  },
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, failure.receipt);
  const failedProject = failure.failedProject === undefined
    ? undefined
    : presentProject(failure.failedProject, scope);
  const reports = failure.resultingState !== undefined
    ? [failure.resultingState, failure.receipt]
    : failure.receipt;
  const groups = groupProjects(failure.resultingState ?? failure.receipt).groups;
  const warningItems = options.verbose === true
    ? verboseWarningNodes(reports, groups, scope)
    : warningNodes(reports, groups, scope);
  const nodes: PresentationNode[] = [
    {
      kind: "notice",
      severity: "error",
      nodes: [{
        kind: "prose",
        parts: [failedProject === undefined
          ? `Update failed after committing Project work: ${failure.detail}`
          : `Update failed at ${failedProject}: ${failure.detail}`],
      }],
    },
    ...warningItems,
  ];
  if (failedProject !== undefined) {
    nodes.push({ kind: "prose", parts: [`Failed Project: ${failedProject}`] });
  }
  nodes.push({
    kind: "prose",
    parts: [`Still pending: ${failure.pendingProjects.length === 0
      ? "none"
      : failure.pendingProjects.map((project) => presentProject(project, scope)).join(", ")}`],
  });
  nodes.push(...applyReceiptNodes(failure.receipt, scope));
  if (failure.resultingState !== undefined) {
    const appliedProjects = new Set(
      failure.receipt.projects.map((project) => project.canonicalProject),
    );
    const current = failure.resultingState.projects
      .filter((project) =>
        project.state.kind === "current" && appliedProjects.has(project.canonicalProject)
      )
      .map((project) => displayProjectPath(project.canonicalProject, project.project, scope));
    if (current.length > 0) {
      nodes.push({ kind: "prose", parts: [`Freshly current: ${current.join(", ")}`] });
    }
  }
  return nodes;
}

/** The interactive changed-output consent question (DEC-005, DEC-019); the
 * capitalized N marks the default no answer, and `d` opens the optional
 * current-versus-planned diff without granting consent (US-020). */
export const APPLY_REPLACEMENT_QUESTION =
  "Replace or delete these generated files as listed? (y/N)";

/** The interactive changed-output review (DEC-005, DEC-019): names every
 * affected changed generated file with its Project attribution and the
 * planned operation before any write, without inferring who changed the
 * bytes. Wording reflects explicit changed-file protection, never an
 * ownership marker (DEC-014). */
export function applyReplacementConfirmationDocument(
  request: ChangedOutputConsentRequest,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope: LocationDisplayScope = options.selection.kind === "all" ? "fleet" : "project";
  const lines = request.projects
    .slice()
    .sort((left, right) => compareCanonicalStrings(left.canonicalProject, right.canonicalProject))
    .flatMap((project) => [
      ...project.changedOutputs
        .slice()
        .sort(compareCanonicalStrings)
        .map((path) => `  ~ ${path} (${displayProjectPath(project.canonicalProject, project.project, scope)})`),
      ...project.removedOutputs
        .slice()
        .sort(compareCanonicalStrings)
        .map((path) => `  - ${path} (${displayProjectPath(project.canonicalProject, project.project, scope)})`),
    ]);
  const hasReplacements = request.projects.some((project) => project.changedOutputs.length > 0);
  const hasRemovals = request.projects.some((project) => project.removedOutputs.length > 0);
  const consequence = hasReplacements && hasRemovals
    ? "Replacing overwrites the ~ files with current Workspace content; deleting removes the - files."
    : hasRemovals
      ? "Deleting removes these files."
      : "Replacing overwrites these files with current Workspace content.";
  return [
    { kind: "heading", text: `Changed ${DEFAULT_VIEW_LEXICON.generatedOutput.plural}:` },
    ...lines.map((line): PresentationNode => ({ kind: "prose", parts: [line] })),
    { kind: "prose", parts: [consequence] },
    { kind: "prose", parts: ["Type d to view the current on-disk versus planned diff before deciding."] },
  ];
}

/** One page of the optional current-disk-versus-planned diff view (US-020,
 * INT-3): hunks render in file order across every comparison, bounded per
 * page so no single view can bury the changes; typing `d` again advances to
 * the next page. Viewing grants no consent; the caller returns to the same
 * scope. */
export const CHANGED_OUTPUT_DIFF_PAGE_LINES = 60;

export function changedOutputDiffDocument(
  comparisons: readonly ChangedOutputComparison[],
  pageIndex: number,
): {
  readonly document: PresentationDocument;
  readonly pageIndex: number;
  readonly pageCount: number;
} {
  const lines: string[] = [];
  for (const comparison of [...comparisons].sort((left, right) =>
    left.project.localeCompare(right.project) || left.path.localeCompare(right.path))) {
    lines.push(
      `${comparison.operation === "remove" ? "Delete" : "Replace"} ${comparison.path}`,
      comparison.kind === "directory"
        ? `--- current/${comparison.path}/`
        : `--- current/${comparison.path}`,
      comparison.operation === "remove"
        ? "+++ /dev/null"
        : comparison.kind === "directory"
          ? `+++ planned/${comparison.path}/`
          : `+++ planned/${comparison.path}`,
    );
    for (const hunk of comparison.hunks) {
      lines.push(hunk.heading, ...hunk.lines);
    }
  }
  const pageCount = Math.max(1, Math.ceil(lines.length / CHANGED_OUTPUT_DIFF_PAGE_LINES));
  const page = Math.min(Math.max(0, pageIndex), pageCount - 1);
  const window = lines.slice(page * CHANGED_OUTPUT_DIFF_PAGE_LINES, (page + 1) * CHANGED_OUTPUT_DIFF_PAGE_LINES);
  const nodes: PresentationNode[] = [
    { kind: "heading", text: "Current on-disk versus planned:" },
    { kind: "verbatim", text: window.join("\n") },
  ];
  if (pageCount > 1) {
    nodes.push({
      kind: "prose",
      parts: [page < pageCount - 1
        ? `…more changes remain (page ${page + 1}/${pageCount}) — type d again to continue.`
        : `(last page ${page + 1}/${pageCount}; type d again to review from the start.)`],
    });
  }
  return { document: nodes, pageIndex: page, pageCount };
}

/** The equivalent fully specified command for a completed prompt flow (DEC-032):
 * the same operation with every scope argument and the replacement-answering
 * flag explicit, so re-running it needs no second answer (US-052). */
export function applyReplacementCommandDocument(
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return promptedEquivalentCommandDocument("update", commandArguments);
}

/** The one shared equivalent-command rendering for completed prompt flows:
 * the sentence names the command; the carried command part is canonical. */
function promptedEquivalentCommandDocument(
  command: "update" | "install" | "uninstall",
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return [{
    kind: "prose",
    parts: [
      `Run the same ${command} without the prompt: `,
      commandPart(COMMAND_NAME, commandArguments),
    ],
  }];
}

/** The equivalent fully specified command for a completed install consent
 * flow: the same installation with the authorized changed-file scope
 * explicit, so re-running it needs no second answer. */
export function installReplacementCommandDocument(
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return promptedEquivalentCommandDocument("install", commandArguments);
}

/** The equivalent fully specified command for a completed uninstall consent
 * flow: the same removal with the authorized deletion scope explicit, so
 * re-running it needs no second answer. */
export function uninstallReplacementCommandDocument(
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return promptedEquivalentCommandDocument("uninstall", commandArguments);
}

/** The equivalent fully specified command for a completed guided-init Profile
 * creation (DEC-032): the chosen name and every explicit material selection,
 * in the non-interactive authoring command's form, so re-running it needs no
 * answers again (US-052). Initialization itself is flagless and needs no
 * equivalent form. */
export function newProfilePromptedCommandDocument(
  commandArguments: readonly string[],
): PresentationDocument {
  return [{
    kind: "prose",
    parts: [
      "Run the same Profile creation without the prompt: ",
      commandPart(COMMAND_NAME, commandArguments.map((value) => arg(value))),
    ],
  }];
}

/** The cancelled guided-init diagnostic (DEC-033): what happened, and that
 * initialization changed nothing. */
export function initCancelledDocument(): PresentationDocument {
  return diagnosticDocument({
    happened: ["init was cancelled; nothing was initialized or created"],
    whatToType: [[
      "To initialize without the first-Profile guidance, run ",
      commandPart(COMMAND_NAME, [arg("init")]),
    ]],
  });
}

/** How the declined answer was given: an explicit no, or the default no. */
export type ApplyDeclinedAnswer = "cancelled" | "declined" | "default";

/** Which discard operations one equivalent update command answers. */
export interface ChangedFileAnsweringScope {
  readonly remove: boolean;
  readonly replace: boolean;
}

/** The declined-or-cancelled replacement diagnostic (DEC-019, DEC-033): what
 * happened, why, and the command that answers the prompt explicitly.
 * Rendered with neutral styling: declining is a safe choice, not an error.
 * The remedy names only the operations at stake (DEC-005). */
export function applyReplacementDeclinedDocument(
  reason: ApplyDeclinedAnswer,
  commandArguments: readonly CommandArg[],
  scope: ChangedFileAnsweringScope,
  command: LifecycleCommand = "update",
): PresentationDocument {
  const remedy = scope.replace && scope.remove
    ? "To replace or delete changed generated files without asking, run "
    : scope.remove
      ? "To delete changed generated files without asking, run "
      : "To replace changed generated files without asking, run ";
  return diagnosticDocument({
    happened: [reason === "cancelled"
      ? `${command} was cancelled before any write`
      : reason === "default"
        ? `${command} kept the changed generated files; nothing was written (default answer no)`
        : `${command} kept the changed generated files; nothing was written (you answered no)`],
    why: [["No Project or setting was changed; your edits to the named generated files are preserved."]],
    whatToType: [[
      remedy,
      commandPart(COMMAND_NAME, commandArguments),
    ]],
    severity: "info",
  });
}

/** The missing-consent refusal diagnostic (DEC-005): what happened, which
 * files still need an explicit flag, and the runnable command that answers
 * it. Raised before any selected lifecycle write. */
export function applyConsentRequiredDocument(
  error: ApplyConsentRequiredError,
  commandArguments: readonly CommandArg[],
  command: LifecycleCommand = "update",
): PresentationDocument {
  const lines = error.projects
    .slice()
    .sort((left, right) => left.canonicalProject.localeCompare(right.canonicalProject))
    .flatMap((project) => [
      ...[...project.changedOutputs].sort().map((path) => `  ~ ${path} (${project.project})`),
      ...[...project.removedOutputs].sort().map((path) => `  - ${path} (${project.project})`),
    ]);
  // A late authorization stop reports the actual partial outcome (RE-1):
  // the no-write claim below belongs only to the invocation-wide pre-write
  // refusal, where completedProjects is empty.
  if (error.completedProjects.length > 0) {
    const pending = (error.pendingProjects ?? [])
      .map((project) => project.canonicalProject)
      .sort(compareCanonicalStrings);
    return diagnosticDocument({
      happened: [error.failedProject === undefined
        ? `${command} stopped: newly changed files need explicit consent`
        : `${command} stopped at ${error.failedProject.canonicalProject}: newly changed files need explicit consent`],
      why: [
        [`Completed Projects stay completed: ${[...error.completedProjects].sort(compareCanonicalStrings).join(", ")}.`],
        ...lines.map((line): readonly InlineContent[] => [line]),
        ...(pending.length === 0
          ? []
          : [[`Still pending: ${pending.join(", ")}.`] as readonly InlineContent[]]),
      ],
      whatToType: [[
        "To review the current bytes and proceed, run ",
        commandPart(COMMAND_NAME, commandArguments),
      ]],
    });
  }
  return diagnosticDocument({
    happened: [`${command} needs explicit changed-file consent before any write`],
    why: [
      ...lines.map((line): readonly InlineContent[] => [line]),
      ["No Project or setting was changed."],
    ],
    whatToType: [[
      "To proceed without asking, run ",
      commandPart(COMMAND_NAME, commandArguments),
    ]],
  });
}

export const INSTALL_CONFIRMATION_QUESTION = "Install as listed? (y/N)";

/** The guided-install Host detection notice (US-005): states the advisory
 * detection result before the Host picker opens, mirroring the
 * initialization receipt's wording. Titles stay bare Host identities so
 * filtering matches the Host, never the evidence text; every Host stays
 * selectable regardless of detection. */
export function installDetectedHostsDocument(detected: readonly string[]): PresentationDocument {
  return [{
    kind: "prose",
    parts: [detected.length > 0
      ? `Detected Agent Hosts: ${detected.join(", ")}.`
      : "Detected Agent Hosts: none. Every supported Host stays selectable."],
  }];
}
/** The guided-install target notice (US-001, DEC-002): names the Project
 * target before missing choices are collected, so a bare interactive
 * install shows which directory it will act on — and states the existing
 * selection when one is recorded, so replacing it starts informed. The
 * full proposed scope follows later in the general-confirmation review. */
export function installTargetDocument(target: {
  readonly canonicalProject: string;
  readonly authoredProject: string;
  readonly previous?: { readonly profile: string; readonly hosts: readonly string[] } | undefined;
}): PresentationDocument {
  const scope = "project" as const;
  return [
    {
      kind: "prose",
      parts: [`Installing into ${displayProjectPath(target.canonicalProject, target.authoredProject, scope)}.`],
    },
    ...(target.previous === undefined ? [] : [{
      kind: "prose",
      parts: [`Current selection: Profile ${target.previous.profile}, Hosts ${target.previous.hosts.join(", ")}.`],
    } as const]),
  ];
}

/** The interactive general-confirmation review (DEC-004): the proposed
 * scope — Project, previous-to-new Profile and Hosts — before any write. */
export function installConfirmationDocument(preview: {
  readonly canonicalProject: string;
  readonly authoredProject: string;
  readonly profile: string;
  readonly hosts: readonly string[];
  readonly previous?: { readonly profile: string; readonly hosts: readonly string[] } | undefined;
}): PresentationDocument {
  const scope = "project" as const;
  const lines = [
    `  Project: ${displayProjectPath(preview.canonicalProject, preview.authoredProject, scope)}`,
    preview.previous !== undefined && preview.previous.profile !== preview.profile
      ? `  Profile: ${preview.previous.profile} → ${preview.profile}`
      : `  Profile: ${preview.profile}`,
    preview.previous !== undefined &&
      preview.previous.hosts.join(", ") !== preview.hosts.join(", ")
      ? `  Hosts: ${preview.previous.hosts.join(", ")} → ${preview.hosts.join(", ")}`
      : `  Hosts: ${preview.hosts.join(", ")}`,
  ];
  return [
    { kind: "heading", text: "Install:" },
    ...lines.map((line): PresentationNode => ({ kind: "prose", parts: [line] })),
    { kind: "prose", parts: ["Records the selection and installs the verified Project files."] },
  ];
}

/** How the general-confirmation answer was given: an explicit no, the
 * default no, or cancellation. Shared with the changed-output gate. */
export type InstallDeclinedAnswer = ApplyDeclinedAnswer;

/** The declined-or-cancelled general-confirmation diagnostic (DEC-004):
 * what happened and the command that answers it explicitly. Rendered with
 * neutral styling: declining is a safe choice, not an error. */
export function installDeclinedDocument(
  reason: InstallDeclinedAnswer,
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return diagnosticDocument({
    happened: [reason === "cancelled"
      ? "install was cancelled before any write"
      : reason === "default"
        ? "install kept the current state; nothing was written (default answer no)"
        : "install kept the current state; nothing was written (you answered no)"],
    why: [["No Project or setting was changed."]],
    whatToType: [[
      "To proceed without asking, run ",
      commandPart(COMMAND_NAME, commandArguments),
    ]],
    severity: "info",
  });
}

/** The missing general-confirmation refusal diagnostic (DEC-004): a
 * non-interactive (or machine-JSON) install without `--auto-confirm` refuses
 * before any configuration or generated-output write, with the runnable
 * command that answers it. */
export function installConfirmationRequiredDocument(
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  return diagnosticDocument({
    happened: ["install needs explicit confirmation before any write"],
    why: [["No Project or setting was changed."]],
    whatToType: [[
      "To proceed without asking, run ",
      commandPart(COMMAND_NAME, commandArguments),
    ]],
  });
}

/** The install follow-up warnings (Host capability and other advisory
 * report warnings) for one installed Project: advisory only, never
 * blocking, reusing the shared warning rendering. Empty when none. */
export function installWarningNodes(report: ReconciliationReport): PresentationDocument {
  return warningNodes(report, groupProjects(report).groups, "project");
}

/** The blocked-install diagnostic (DEC-005/DEC-006): ownership, path-safety,
 * or global Blockers stop the install before any write, with each Blocker's
 * own requirement and remedy plus the concrete retry. Single-Project scope
 * keeps the view compact; machine JSON carries the complete report. */
export function installBlockedDocument(
  report: BlockedReconciliationReport,
  commandArguments: readonly CommandArg[],
): PresentationDocument {
  const scope = "project" as const;
  const groups = groupProjects(report).groups;
  const nodes: PresentationNode[] = [{
    kind: "notice",
    severity: "error",
    nodes: [{ kind: "prose", parts: ["install blocked before any write"] }],
  }];
  for (const blocker of report.globalBlockers) {
    nodes.push(...conciseBlockerNodes(blocker, undefined, groups, "", scope));
  }
  for (const project of report.projects) {
    if (project.blockers.length === 0) continue;
    const displayProject = displayProjectPath(project.canonicalProject, project.project, scope);
    for (const blocker of project.blockers) {
      nodes.push(...conciseBlockerNodes(blocker, displayProject, groups, "", scope));
    }
  }
  nodes.push({
    kind: "prose",
    parts: [
      "To retry after resolving the cause, run ",
      commandPart(COMMAND_NAME, commandArguments),
    ],
  });
  return nodes;
}

/** Selection and output recovery evidence for one failed install (DEC-006).
 * Selection and output restoration are independent outcomes: each renders
 * from its own fact, never inferred from the other. */
export interface InstallRecoveryEvidence {
  readonly selectionRestored: boolean;
  /** Stringified restoration failure, when restoring itself failed. */
  readonly restoreError?: string;
  /** True when generated output was committed (verification path or concurrent commit). */
  readonly outputCommitted: boolean;
  /** True when another writer owns the current selection, which was left untouched. */
  readonly concurrentSelectionChange: boolean;
}

/** Recovery sentences shared by every install failure view: the dedicated
 * execution/verification diagnostics and the addendum appended to the
 * shared declined/consent/stale/blocked views. */
export function installRecoverySentences(recovery: InstallRecoveryEvidence): readonly string[] {
  if (recovery.restoreError !== undefined) {
    return [
      `The previous selection could not be restored: ${recovery.restoreError}.`,
      recovery.outputCommitted
        ? "Generated output may have been committed; review it before retrying."
        : "The failed installation was not committed.",
    ];
  }
  if (recovery.concurrentSelectionChange) {
    return ["Another operation changed the selection during installation; it was left untouched."];
  }
  if (recovery.selectionRestored) {
    return ["The previous selection was restored; the failed installation was not committed."];
  }
  if (recovery.outputCommitted) {
    return ["The new selection was kept; generated output may not match the Workspace."];
  }
  return ["Nothing was written."];
}

/** Recovery evidence appended to the shared declined/consent/stale/blocked
 * views. Empty when the shared view already states the outcome (an
 * untouched invocation with nothing to restore). */
export function installRecoveryAddendum(recovery: InstallRecoveryEvidence): PresentationDocument {
  if (
    recovery.restoreError === undefined &&
    !recovery.concurrentSelectionChange &&
    !recovery.selectionRestored
  ) {
    return [];
  }
  return installRecoverySentences(recovery).map((sentence): PresentationNode => ({
    kind: "prose",
    parts: [sentence],
  }));
}

/** The install execution-failure diagnostic (US-008, DEC-006): what failed,
 * the selection/output recovery evidence, and the concrete retry. */
export function installExecutionFailureDocument(input: {
  readonly detail: string;
  readonly failedProject?: ProjectIdentity;
  readonly recovery: InstallRecoveryEvidence;
  readonly retryArguments: readonly CommandArg[];
}): PresentationDocument {
  const failed = input.failedProject === undefined
    ? undefined
    : displayProjectPath(
      input.failedProject.canonicalProject,
      input.failedProject.project,
      "project",
    );
  return diagnosticDocument({
    happened: [failed === undefined
      ? `install failed: ${input.detail}`
      : `install failed at ${failed}: ${input.detail}`],
    why: installRecoverySentences(input.recovery).map((sentence): readonly InlineContent[] => [sentence]),
    whatToType: [[
      "To retry the same installation, run ",
      commandPart(COMMAND_NAME, input.retryArguments),
    ]],
  });
}

/** The install verification-failure diagnostic (US-008): the new output is
 * committed but did not verify, so the new selection is kept and the
 * failure reports truthfully with a concrete retry. */
export function installVerificationFailureDocument(input: {
  readonly message: string;
  readonly retryArguments: readonly CommandArg[];
}): PresentationDocument {
  return diagnosticDocument({
    happened: [`install verified nothing: ${input.message}`],
    why: [["The new selection is kept; generated output may not match the Workspace."]],
    whatToType: [[
      "To retry verification of the same installation, run ",
      commandPart(COMMAND_NAME, input.retryArguments),
    ]],
  });
}

/** The stale-review safety refusal diagnostic (US-020): the reviewed bytes
 * moved before the write, so the invocation stopped instead of executing a
 * change different from the reviewed one. Completed work stays committed. */
export function applyReviewStaleDocument(
  error: ApplyReviewStaleError,
  commandArguments: readonly CommandArg[],
  command: LifecycleCommand = "update",
): PresentationDocument {
  return diagnosticDocument({
    happened: [`${command} stopped at ${error.failedProject.canonicalProject}: the reviewed files changed during confirmation`],
    why: [[
      error.completedProjects.length === 0
        ? "No Project was changed after the review."
        : `Completed Projects stay completed: ${error.completedProjects.join(", ")}.`,
    ]],
    whatToType: [[
      "To review the current bytes and proceed, run ",
      commandPart(COMMAND_NAME, commandArguments),
    ]],
  });
}

/** The apply verification-failure view as a presentation document. */
export function applyVerificationFailureDocument(
  receipt: ReconciliationReport,
  message: string,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, receipt);
  const groups = groupProjects(receipt).groups;
  const warningItems = options.verbose === true
    ? verboseWarningNodes(receipt, groups, scope)
    : warningNodes(receipt, groups, scope);
  if (options.verbose === true) {
    return [
      { kind: "notice", severity: "error", nodes: [{ kind: "prose", parts: [message] }] },
      ...warningItems,
      { kind: "heading", text: "Updated:" },
      ...verboseLifecycleSections(receipt, {
        scope,
      }),
      ...verboseHostSetupNodes("update", receipt, scope),
    ];
  }
  const nodes: PresentationNode[] = [
    { kind: "notice", severity: "error", nodes: [{ kind: "prose", parts: [message] }] },
    ...warningItems,
    ...applyReceiptNodes(receipt, scope),
  ];
  const setup = conciseFirstUseNodes(
    presentedSetupSteps("update", receipt, receipt, false, scope),
    receipt,
  );
  if (setup.length > 0) nodes.push(spacerNode(), ...setup);
  return nodes;
}


/** The typed untracking recovery for one ownership-conflict Blocker. */
function shortenInlinePart(
  part: InlineContent,
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): InlineContent {
  if (typeof part === "string") {
    return shortenProjectReferences(part, groups, scope);
  }
  if (part.kind === "identifier") {
    return identifierPart(shortenProjectReferences(part.value, groups, scope));
  }
  if (part.kind === "path") {
    return pathPart(
      shortenProjectReferences(part.canonicalPath, groups, scope),
      part.scope,
      part.authoredPath === undefined ? undefined : shortenProjectReferences(part.authoredPath, groups, scope),
    );
  }
  if (part.kind === "text") {
    return textPart(shortenProjectReferences(part.value, groups, scope));
  }
  return part;
}

/**
 * Shorten project references inside inline content across text spans and
 * carried identifier/path parts.
 */
function shortenInlineProjectReferences(
  content: readonly InlineContent[],
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): readonly InlineContent[] {
  return content.map((part) => shortenInlinePart(part, groups, scope));
}

/** The typed concise Blocker evidence for one Blocker (legacy indent kept). */
function conciseBlockerNodes(
  blocker: ReconciliationBlocker,
  displayProject: string | undefined,
  groups: readonly ProjectGroup[],
  indent: string,
  scope: LocationDisplayScope,
): PresentationNode[] {
  if (isOutputOwnershipConflict(blocker)) {
    if (displayProject === undefined) {
      throw new Error("Project-scoped ownership Blocker is missing its Project presentation");
    }
    const paths = outputOwnershipConflictPaths(blocker);
    const wording = humanBlockerWording(blocker);
    return [
      {
        kind: "prose",
        parts: shortenInlineProjectReferences([`${indent}Blocker: `, ...wording.problem], groups, scope),
        category: "error",
      },
      { kind: "prose", parts: [`${indent}  Requirement: `, ...wording.requirement] },
      { kind: "prose", parts: [`${indent}  Remedy: `, ...wording.remedy] },
      ...(paths.length === 0 ? [] as PresentationNode[] : [
        { kind: "prose" as const, parts: [`${indent}  Affected paths (${paths.length}):`] },
        ...trackedPathGroupLines(paths, indent).map((line) => ({
          kind: "prose" as const,
          parts: [line],
        })),
      ]),
    ];
  }
  const wording = humanBlockerWording(blocker);
  return [
    {
      kind: "prose",
      parts: shortenInlineProjectReferences([`${indent}Blocker: `, ...wording.problem], groups, scope),
      category: "error",
    },
    { kind: "prose", parts: [`${indent}  Requirement: `, ...wording.requirement] },
    { kind: "prose", parts: [`${indent}  Remedy: `, ...wording.remedy] },
    ...blocker.affectedItems.map((item) => ({
      kind: "prose" as const,
      parts: [`${indent}  ${affectedItemLabel(item)}`],
    })),
  ];
}

/** The typed verbose Blocker evidence for one Blocker. */
function verboseBlockerNodes(
  blocker: ReconciliationBlocker,
  groups: readonly ProjectGroup[],
  shorten: (text: string) => string,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const project = blocker.scope === "project"
    ? presentProject(requireProjectGroup(groups, blocker.project!), scope)
    : undefined;
  const wording = humanBlockerWording(blocker);
  const nodes: PresentationNode[] = [
    { kind: "list-item", parts: shortenInlineProjectReferences(wording.problem, groups, scope) },
    { kind: "prose", parts: ["  Requirement: ", ...wording.requirement] },
    { kind: "prose", parts: ["  Remedy: ", ...wording.remedy] },
    { kind: "prose", parts: [`  Scope: ${blockerScopeText(blocker, project)}`] },
  ];
  for (const item of blocker.affectedItems) {
    const value = blocker.scope === "project" && item.kind === "path"
      ? shorten(`${blocker.project!}/${item.value}`)
      : item.value;
    nodes.push({ kind: "prose", parts: [`  ${affectedItemLabel({ ...item, value })}`] });
  }
  return nodes;
}

/** The typed global-Blocker section; empty when no global Blocker exists. */
function globalBlockerNodes(
  report: ReconciliationReport,
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): PresentationNode[] {
  const globalBlockers = reportBlockers(report).filter((blocker) => blockerProject(blocker) === undefined);
  if (globalBlockers.length === 0) return [];
  return [
    { kind: "heading", text: "Global blockers:", category: "error" },
    ...globalBlockers.flatMap((blocker) =>
      conciseBlockerNodes(blocker, undefined, groups, "  ", scope)
    ),
  ];
}

/** The presentation group of an explicitly selected Project, normalized once. */
function selectedProjectGroup(
  report: ReconciliationReport,
  target: string,
): ProjectGroup {
  const groups = groupProjects(report).groups;
  const group = groups.find((candidate) =>
    candidate.project === target || candidate.canonicalProject === target
  ) ?? findSelectedProjectGroupByCanonical(groups, target);
  if (group === undefined) {
    throw new Error(`Selected Project ${target} is missing its presentation group`);
  }
  return group;
}

/** Resolve the target through the same realpath the selection boundary used. */
function findSelectedProjectGroupByCanonical(
  groups: readonly ProjectGroup[],
  target: string,
): ProjectGroup | undefined {
  if (target !== "~" && !target.startsWith("~/") && !isAbsolute(target)) return undefined;
  try {
    const expanded = target === "~"
      ? homedir()
      : target.startsWith("~/")
      ? join(homedir(), target.slice(2))
      : target;
    const canonical = realpathSync(expanded);
    return groups.find((candidate) => candidate.canonicalProject === canonical);
  } catch {
    return undefined;
  }
}

function statusLifecycleCommand(
  command: LifecycleCommand,
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
  extraArgs: readonly CommandArg[] = [],
): CommandNode {
  const args = lifecycleCommandArgs(
    command,
    options.selection,
    report,
    locationDisplayScope(options, report),
    extraArgs,
  );
  return { kind: "command", program: COMMAND_NAME, args };
}

function readyStatusGuidanceNodes(
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): PresentationNode[] {
  return [
    {
      kind: "key-value",
      key: "Next",
      value: statusLifecycleCommand("update", report, options),
      category: "command",
    },
    spacerNode(),
    {
      kind: "key-value",
      key: "Details",
      value: statusLifecycleCommand("status", report, options, [
        { kind: "text", value: "--verbose" },
      ]),
      category: "command",
    },
  ];
}

/** The status outcome notice: severity derives from report facts, never copy. */
function statusOutcomeNotice(
  report: ReconciliationReport,
  selection?: ProjectBindingSelection,
): PresentationNode {
  let severity: NoticeSeverity = "success";
  if (reportBlockers(report).length > 0) severity = "error";
  else if (
    reportHasHostAttention(report) && fullyCurrentProjectCount(report) !== undefined
  ) severity = "attention";
  return {
    kind: "notice",
    severity,
    nodes: [{ kind: "prose", parts: [outcomeLine("status", report, false, selection)] }],
  };
}

function spacerNode(): PresentationNode {
  return { kind: "verbatim", text: "" };
}

function projectPathNode(
  canonicalProject: string,
  authoredProject: string,
  scope: LocationDisplayScope,
): PresentationNode {
  return {
    kind: "path",
    canonicalPath: canonicalProject,
    authoredPath: authoredProject,
    scope,
  };
}


function formatWarningGroupParts(
  group: WarningPresentationGroup,
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): readonly InlineContent[] {
  return shortenInlineProjectReferences(group.parts, groups, scope);
}

function warningNodes(
  reports: ReconciliationReport | readonly ReconciliationReport[],
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): PresentationNode[] {
  const warningGroups = groupWarnings(reports);
  if (warningGroups.length === 0) return [];
  return warningGroups.map((group) => ({
    kind: "list-item" as const,
    parts: [
      ...formatWarningGroupParts(group, groups, scope),
      ` (${plural(group.projects.length, "Project")})`,
    ],
    category: "attention" as const,
  }));
}

function verboseWarningNodes(
  reports: ReconciliationReport | readonly ReconciliationReport[],
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): PresentationNode[] {
  const warningGroups = groupWarnings(reports);
  if (warningGroups.length === 0) return [];
  return warningGroups.map((group) => {
    const projectList = group.projects
      .map((project) => displayProjectPath(project.canonicalProject, project.project, scope))
      .join(", ");
    return {
      kind: "list-item" as const,
      parts: [
        ...formatWarningGroupParts(group, groups, scope),
        ` (${projectList})`,
      ],
      category: "attention" as const,
    };
  });
}

function renderVerboseOutputKind(output: OutputReconciliationItem): string {
  if (output.driftKind !== undefined) {
    return output.driftKind;
  }
  return output.kind;
}

/** The verbose lifecycle detail sections and Blocker section as typed nodes. */
function verboseLifecycleSections(
  report: ReconciliationReport,
  options: VerboseSectionOptions,
): PresentationNode[] {
  const groups = groupProjects(report).groups;
  const shorten = (text: string): string => shortenProjectReferences(text, groups, options.scope);
  const blockers = reportBlockers(report);
  const nodes: PresentationNode[] = [];
  if (blockers.length > 0) {
    nodes.push({ kind: "heading", text: "Blockers:", category: "error" });
    for (const blocker of blockers) {
      nodes.push(...verboseBlockerNodes(blocker, groups, shorten, options.scope));
    }
  }
  nodes.push(...verboseDetailNodes(
    report,
    groups,
    shorten,
    options.scope,
    options.includeStateExplanations ?? true,
    options.stateExplanationItems ?? reportItems(report),
  ));
  return nodes;
}

/** The receipt-proven Project input change renders once at Project scope
 * only when no changed output projection truthfully owns the cause and the
 * state kind does not already name it; otherwise the existing evidence stands
 * alone (fact-once, DEC-007). */
function projectSourceChangeSuffix(
  item: ReconciliationItem,
  records: readonly ReconciliationProjectRecord[],
): string {
  if (item.kind === "stale source") return "";
  const record = records.find((candidate) =>
    candidate.project === item.project || candidate.canonicalProject === item.project
  );
  if (record?.sourceInputChanged !== true) return "";
  if (record.outputs.some(outputSourceChanged)) return "";
  return " (source changed)";
}

function verboseDetailNodes(
  report: ReconciliationReport,
  groups: readonly ProjectGroup[],
  shorten: (text: string) => string,
  scope: LocationDisplayScope,
  includeStateExplanations = true,
  stateExplanationItems: readonly ReconciliationItem[] = reportItems(report),
): PresentationNode[] {
  const items = reportItems(report);
  const outputs = reportOutputs(report).filter((output) => output.kind !== "unchanged");
  const exclusions = changedRepositoryExclusions(report);
  const nodes: PresentationNode[] = [
    { kind: "heading", text: "Projects:" },
    ...(items.length === 0
      ? [{ kind: "prose" as const, parts: ["(no projects)"] }]
      : items.map((item) => ({
        kind: "prose" as const,
        parts: [
          identifierPart(shorten(item.project)),
          `: ${item.kind}${item.reason ? ` (${renderItemReason(item.reason)})` : ""}${
            projectSourceChangeSuffix(item, report.projects)
          }`,
        ],
      }))),
  ];
  if (includeStateExplanations) {
    nodes.push(...stateExplanationNodes(stateExplanationItems));
  }
  if (outputs.length > 0) {
    nodes.push(
      { kind: "heading", text: "Outputs:" },
      ...outputs.map((output) => ({
        kind: "prose" as const,
        parts: [
          identifierPart(shorten(`${output.project}/${output.path}`)),
          `: ${renderVerboseOutputKind(output)}${
            outputSourceChanged(output) ? " (source changed)" : ""
          }`,
        ],
      })),
    );
  }
  if (exclusions.length > 0) {
    nodes.push(
      { kind: "heading", text: "Git exclusions:" },
      ...exclusions.map((change) => {
        const delta = exclusionDelta(change);
        const parts: InlineContent[] = [identifierPart(shorten(change.target)), ": "];
        const deltaClauses: InlineContent[] = [];
        if (delta.additions.length > 0) {
          deltaClauses.push("add ", ...delta.additions.flatMap((e, i) => (i === 0 ? [identifierPart(e)] : [", ", identifierPart(e)])));
        }
        if (delta.removals.length > 0) {
          if (deltaClauses.length > 0) deltaClauses.push("; ");
          deltaClauses.push("remove ", ...delta.removals.flatMap((e, i) => (i === 0 ? [identifierPart(e)] : [", ", identifierPart(e)])));
        }
        return {
          kind: "list-item" as const,
          parts: [...parts, ...deltaClauses],
        };
      }),
    );
  }
  return nodes;
}

/** The verbose Host Setup section as typed nodes. */
function verboseHostSetupNodes(
  command: LifecycleCommand,
  report: ReconciliationReport,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const presented = presentedSetupSteps(command, report, undefined, true, scope);
  if (presented.length === 0) return [];
  const transition = groupSetupSteps(
    presented.filter((item) => item.step.provenance === "transition"),
  );
  const standing = groupSetupSteps(
    presented.filter((item) => item.step.provenance === "standing"),
  );
  const nodes: PresentationNode[] = [];
  for (const [heading, sectionGroups] of [
    ["Host setup:", transition],
    ["Standing Host setup:", standing],
  ] as const) {
    if (sectionGroups.length === 0) continue;
    nodes.push({ kind: "heading", text: heading });
    for (const group of sectionGroups) {
      nodes.push({
        kind: "list-item",
        parts: [`${group.message}${setupProjectScope(group.projects, true, scope)}`],
      });
      if (group.step.consequence !== undefined) {
        nodes.push({ kind: "prose", parts: [`  Consequence: ${group.step.consequence}`] });
      }
    }
  }
  return nodes;
}

function conciseStatusDocument(
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, report);
  const grouped = groupProjects(report);
  const groups = grouped.groups;
  const blocked = reportBlockers(report).length > 0;
  const emptyStatus =
    !blocked && reportDesired(report).length === 0 && reportItems(report).length === 0;
  const fullyCurrentStatus = fullyCurrentProjectCount(report) !== undefined;

  if (emptyStatus) {
    // A configured fleet with an empty filtered selection is not an
    // unconfigured fleet: render the filter's empty outcome without bind or
    // inventory guidance (DEC-006).
    if (options.selection.filter !== undefined) {
      return [statusOutcomeNotice(report, options.selection)];
    }
    return [
      {
        kind: "notice",
        severity: "success",
        nodes: [{ kind: "prose", parts: ["No Projects are configured."] }],
      },
      {
        kind: "prose",
        category: "command",
        parts: [
          "Next: Run ",
          commandPart(COMMAND_NAME, [arg("list"), arg("projects")]),
          ` to inspect ${DEFAULT_VIEW_LEXICON.projectBinding.plural}, or `,
          commandPart(COMMAND_NAME, [arg("install"), arg("<profile>"), arg("--host"), arg("<host>")]),
          " to install one.",
        ],
      },
    ];
  }

  const nodes: PresentationNode[] = [
    statusOutcomeNotice(report, options.selection),
    ...warningNodes(report, groups, scope),
  ];
  if (fullyCurrentStatus) {
    return nodes;
  }

  const partition = partitionFleet(report);
  for (const cause of PRIMARY_CAUSE_ORDER) {
    const causeProjects = partition.groups[cause];
    if (causeProjects.length === 0) continue;
    if (cause === "needs-attention") {
      nodes.push(...needsAttentionCauseNodes(
        causeProjects,
        groups,
        scope,
      ));
      continue;
    }
    nodes.push(primaryCauseGroupNode(PRIMARY_CAUSE_LABELS[cause], causeProjects, scope));
  }
  if (partition.settledCount > 0 && partition.totalActionableCount > 0) {
    nodes.push(settledCountNode(partition.settledCount));
  }

  if (blocked) {
    const globalBlockers = globalBlockerNodes(report, groups, scope);
    if (globalBlockers.length > 0) {
      nodes.push(spacerNode(), ...globalBlockers);
    }
    const blockedSummary = aggregateLine("status", report, groups);
    if (blockedSummary !== undefined) {
      nodes.push(spacerNode(), {
        kind: "notice",
        severity: "error",
        nodes: [{ kind: "prose", parts: [blockedSummary] }],
      });
    }
    nodes.push(spacerNode(), ...nextActionNodes("status", report, {
      groups,
      unscopedItems: grouped.unscopedItems,
    }, options));
    return nodes;
  }

  nodes.push(...readyStatusGuidanceNodes(report, options));
  return nodes;
}

function verboseStatusDocument(
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, report);
  const groups = groupProjects(report).groups;
  return [
    statusOutcomeNotice(report, options.selection),
    ...verboseWarningNodes(report, groups, scope),
    ...verboseLifecycleSections(report, { scope }),
    ...verboseHostSetupNodes("status", report, scope),
  ];
}

export function lifecycleStatusDocument(
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): PresentationDocument {
  if (options.verbose === true) return verboseStatusDocument(report, options);
  return conciseStatusDocument(report, options);
}


/**
 * Uniform machine-surface exit codes for apply and status:
 * - `0` — no tool error and no blockers (may still be `outcome: "attention"`)
 * - `2` — blockers present
 * Tool errors stay exit `1` and use {@link formatLifecycleToolErrorJson} under `--json`.
 */
export function lifecycleExitCode(report: ReconciliationReport): 0 | 2 {
  return reportBlockers(report).length > 0 ? 2 : 0;
}

type MachineOutcome = "attention" | "blocked" | "clean" | "error";

interface MachineBlocker {
  readonly affectedItems: readonly BlockerAffectedItem[];
  readonly kind: BlockerKind;
  readonly message: string;
  readonly problem: string;
  readonly project?: string;
  readonly remedy: string;
  readonly requirement: string;
  readonly scope: BlockerScope;
}

interface MachineSetupStep {
  readonly consequence?: string;
  readonly host: string;
  readonly kind: HostSetupStepKind;
  readonly message: string;
  readonly output?: string;
  readonly path?: "bound-project";
  readonly project?: string;
  readonly provenance: HostSetupProvenance;
}

const LIFECYCLE_MACHINE_SCHEMA_VERSION = 15 as const;

/**
 * One version line per JSON command family: every `install-temp`/`remove-temp`
 * payload (success receipt, blocked, tool error) shares this constant so the
 * version identifies the family, and it evolves independently of the
 * `status`/`apply` lifecycle payload family even when both currently publish
 * the same number.
 */
const TEMPORARY_INSTALLATION_MACHINE_SCHEMA_VERSION = 9 as const;

function machineBlocker(blocker: ReconciliationBlocker): MachineBlocker {
  const wording = blockerWording(blocker);
  return {
    kind: blocker.kind,
    scope: blocker.scope,
    ...(blocker.scope === "project" ? { project: blocker.project } : {}),
    message: wording.message,
    problem: wording.problem,
    requirement: wording.requirement,
    remedy: wording.remedy,
    affectedItems: blocker.affectedItems.map((item) => ({ kind: item.kind, value: item.value })),
  };
}

function serializeMachinePayload(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function canonicalMachineSetupSteps(
  project: ReconciliationProjectRecord,
): readonly MachineSetupStep[] {
  return project.setupSteps.map((step) => {
    const output = setupStepOutput(step);
    return {
      host: step.host,
      kind: step.kind,
      message: step.message,
      provenance: step.provenance,
      ...(output === undefined ? {} : { output }),
      ...(step.consequence === undefined ? {} : { consequence: step.consequence }),
      ...(step.path === undefined ? {} : { path: step.path, project: project.project }),
    };
  });
}

function canonicalMachineWarning(warning: ReconciliationWarning): {
  readonly consequence?: string;
  readonly copyableValues: readonly string[];
  readonly kind: ReconciliationWarning["kind"];
  readonly message: string;
} {
  return {
    ...(warning.consequence === undefined ? {} : { consequence: warning.consequence }),
    copyableValues: [...warning.copyableValues],
    kind: warning.kind,
    message: flatInlineText(warning.parts),
  };
}

function canonicalMachineProject(project: ReconciliationProjectRecord): unknown {
  return {
    canonicalProject: project.canonicalProject,
    project: project.project,
    ...(project.desired === undefined ? {} : {
      desired: {
        ...(project.desired.capabilityContracts === undefined
          ? {}
          : { capabilityContracts: { ...project.desired.capabilityContracts } }),
        hosts: [...project.desired.hosts],
        profile: project.desired.profile,
      },
    }),
    state: {
      kind: project.state.kind,
      ...(project.state.reason === undefined
        ? {}
        : { reason: renderMachineItemReason(project.state.reason) }),
    },
    outputs: project.outputs.map((output) => ({
      consumingHosts: [...output.consumingHosts],
      kind: output.kind,
      path: output.path,
    })),
    blockers: project.blockers.map(machineBlocker),
    warnings: project.warnings.map(canonicalMachineWarning),
    setupSteps: canonicalMachineSetupSteps(project),
    repositoryExclusions: project.repositoryExclusions.map((change) => ({
      current: [...change.current],
      next: [...change.next],
      target: change.target,
    })).sort((left, right) => left.target.localeCompare(right.target)),
  };
}

function canonicalMachineSnapshot(report: ReconciliationReport): unknown {
  return {
    globalBlockers: report.globalBlockers.map(machineBlocker),
    projects: report.projects.map(canonicalMachineProject),
  };
}

function canonicalMachineOutcome(
  report: ReconciliationReport,
): Exclude<MachineOutcome, "error"> {
  if (
    report.globalBlockers.length > 0 ||
    report.projects.some((project) => project.blockers.length > 0)
  ) return "blocked";
  if (
    report.projects.some((project) =>
      project.state.kind !== "current" ||
      project.outputs.some((output) => output.kind !== "unchanged") ||
      project.repositoryExclusions.length > 0 ||
      project.warnings.some((warning) => warning.kind === "host-attention")
    )
  ) return "attention";
  return "clean";
}

function canonicalLifecycleMachinePayload(
  command: LifecycleCommand,
  report: ReconciliationReport,
  applied?: ReconciliationReport,
): unknown {
  return {
    schemaVersion: LIFECYCLE_MACHINE_SCHEMA_VERSION,
    command,
    outcome: canonicalMachineOutcome(report),
    ...canonicalMachineSnapshot(report) as object,
    ...(applied === undefined ? {} : { applied: canonicalMachineSnapshot(applied) }),
  };
}

/** Selection/output recovery evidence in machine payloads (DEC-006). */
export interface InstallRecoveryJson {
  readonly selectionRestored: boolean;
  readonly restoreError?: string;
  readonly outputCommitted: boolean;
  readonly concurrentSelectionChange: boolean;
}

export function formatLifecycleJson(
  command: Exclude<LifecycleCommand, "update">,
  report: ReconciliationReport,
  recovery?: InstallRecoveryJson,
): string {
  const payload = canonicalLifecycleMachinePayload(command, report) as Record<string, unknown>;
  return serializeMachinePayload(
    recovery === undefined ? payload : { ...payload, selectionRecovery: recovery },
  );
}

export function formatApplyJson(result: ApplyReconciliationResult): string {
  return serializeMachinePayload(
    canonicalLifecycleMachinePayload("update", result.resultingState, result.receipt),
  );
}

/** The machine payload for one successful `install`: the same reconciliation
 * evidence under the command actually run. */
export function formatInstallJson(result: ApplyReconciliationResult): string {
  return serializeMachinePayload(
    canonicalLifecycleMachinePayload("install", result.resultingState, result.receipt),
  );
}

export function formatBlockedApplyJson(report: BlockedReconciliationReport): string {
  return serializeMachinePayload(canonicalLifecycleMachinePayload("update", report));
}

export function formatApplyExecutionFailureJson(failure: {
  readonly failedProject: ProjectIdentity | undefined;
  readonly message: string;
  readonly pendingProjects: readonly ProjectIdentity[];
  readonly receipt: ReconciliationReport;
  readonly resultingState: ReconciliationReport | undefined;
  readonly command?: LifecycleCommand;
  readonly recovery?: InstallRecoveryJson;
}): string {
  return serializeMachinePayload({
    schemaVersion: LIFECYCLE_MACHINE_SCHEMA_VERSION,
    command: failure.command ?? "update",
    outcome: "error",
    error: failure.message,
    ...(failure.resultingState === undefined
      ? { globalBlockers: [], projects: [] }
      : canonicalMachineSnapshot(failure.resultingState) as object),
    applied: canonicalMachineSnapshot(failure.receipt),
    ...(failure.failedProject === undefined
      ? {}
      : { failedProject: failure.failedProject.canonicalProject }),
    pendingProjects: failure.pendingProjects.map((project) => project.canonicalProject),
    ...(failure.recovery === undefined ? {} : { selectionRecovery: failure.recovery }),
  });
}

export function formatApplyVerificationFailureJson(
  receipt: ReconciliationReport,
  message: string,
  command: LifecycleCommand = "update",
  recovery?: InstallRecoveryJson,
): string {
  return serializeMachinePayload({
    schemaVersion: LIFECYCLE_MACHINE_SCHEMA_VERSION,
    command,
    outcome: "error",
    error: message,
    globalBlockers: [],
    projects: [],
    applied: canonicalMachineSnapshot(receipt),
    ...(recovery === undefined ? {} : { selectionRecovery: recovery }),
  });
}

/** Machine envelope for tool failures under `--json` (exit `1`). Parse stdout only when present. */
export function formatLifecycleToolErrorJson(
  command: LifecycleCommand,
  message: string,
  recovery?: InstallRecoveryJson,
): string {
  return serializeMachinePayload({
    schemaVersion: LIFECYCLE_MACHINE_SCHEMA_VERSION,
    command,
    outcome: "error",
    error: message,
    globalBlockers: [],
    projects: [],
    ...(recovery === undefined ? {} : { selectionRecovery: recovery }),
  });
}

export type TemporaryInstallCommand = "install-temp" | "remove-temp";

export interface TemporaryInstallationReceiptView {
  readonly adapterVersion?: string;
  readonly completionState: "installed" | "removed";
  readonly engineVersion?: string;
  readonly host?: string;
  readonly hostVersion?: string;
  readonly outputs: readonly string[];
  readonly profileId?: string;
  readonly project?: string;
  readonly setupSteps: readonly HostSetupStep[];
  readonly temporaryInstallationId: string;
  readonly diagnosticValues: readonly string[];
  readonly warnings: readonly string[];
  readonly warningParts?: readonly (readonly InlineContent[])[];
  readonly workspaceInputHash?: string;
}

/**
 * One home for the bound-project setup-step rule: a step that identifies its
 * path semantically as the Project renders the caller's chosen Project
 * identity, while JSON keeps the canonical spelling and human views pass the
 * presented one.
 */
function setupStepMessage(step: HostSetupStep, project: string): string {
  return step.path === "bound-project" ? `${step.message} ${project}` : step.message;
}

function temporarySetupStepJson(step: HostSetupStep, project: string) {
  const output = setupStepOutput(step);
  return {
    host: step.host,
    kind: step.kind,
    message: setupStepMessage(step, project),
    provenance: step.provenance,
    ...(output === undefined ? {} : { output }),
    ...(step.consequence === undefined ? {} : { consequence: step.consequence }),
    ...(step.path === undefined ? {} : { path: step.path }),
  };
}

/** Versioned temporary-installation receipt for automation. */
export function formatTemporaryInstallationJson(
  command: TemporaryInstallCommand,
  receipt: TemporaryInstallationReceiptView,
): string {
  return `${JSON.stringify(
    {
      schemaVersion: TEMPORARY_INSTALLATION_MACHINE_SCHEMA_VERSION,
      command,
      outcome: "success",
      temporaryInstallationId: receipt.temporaryInstallationId,
      profileId: receipt.profileId,
      host: receipt.host,
      project: receipt.project,
      workspaceInputHash: receipt.workspaceInputHash,
      engineVersion: receipt.engineVersion,
      adapterVersion: receipt.adapterVersion,
      hostVersion: receipt.hostVersion,
      outputs: receipt.outputs,
      completionState: receipt.completionState,
      warnings: [...receipt.warnings],
      setupSteps: receipt.setupSteps.map((step) =>
        temporarySetupStepJson(step, receipt.project ?? "")
      ),
    },
    null,
    2,
  )}\n`;
}

/** The temporary installation receipt view (install-temp and remove-temp) as a document. */
export function temporaryInstallationDocument(
  command: TemporaryInstallCommand,
  receipt: TemporaryInstallationReceiptView,
  cwd = process.cwd(),
  home = homedir(),
): PresentationDocument {
  if (command === "install-temp" && (
    receipt.project === undefined || receipt.profileId === undefined || receipt.host === undefined
  )) {
    throw new Error("Installed temporary receipt is missing active installation detail");
  }
  const projectValue = receipt.project === undefined
    ? undefined
    : projectPathNode(receipt.project, receipt.project, "project");
  if (command === "install-temp") {
    const nodes: PresentationNode[] = [
      // Severity is the receipt outcome fact: the temporary Profile was installed.
      {
        kind: "notice",
        severity: "success",
        nodes: [{
          kind: "prose",
          parts: [`Installed ${DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.singular}`],
        }],
      },
      ...receipt.warnings.map((warning, index) => ({
        kind: "list-item" as const,
        parts: receipt.warningParts?.[index] ?? [warning],
        category: "attention" as const,
      })),
      {
        kind: "key-value",
        key: "  Profile",
        value: { kind: "identifier", value: receipt.profileId! },
        category: "path",
      },
      {
        kind: "key-value",
        key: "  Host",
        value: { kind: "identifier", value: receipt.host! },
        category: "path",
      },
      { kind: "key-value", key: "  Project", value: projectValue! },
      {
        kind: "key-value",
        key: "  Temporary installation",
        value: { kind: "identifier", value: receipt.temporaryInstallationId },
        category: "path",
      },
    ];
    if (receipt.setupSteps.length > 0) {
      nodes.push(
        { kind: "heading", text: `${capitalize(receipt.host!)} setup:` },
        ...[...receipt.setupSteps]
          .sort((left, right) =>
            HOST_SETUP_STEP_ORDER.indexOf(left.kind) -
              HOST_SETUP_STEP_ORDER.indexOf(right.kind) ||
            left.message.localeCompare(right.message)
          )
          .flatMap((step) => {
            const message = setupStepMessage(step, displayProjectPath(
              receipt.project!,
              receipt.project!,
              "project",
              cwd,
              home,
            ));
            return [
              {
                kind: "list-item" as const,
                parts: [message],
              },
              ...(step.consequence === undefined
                ? []
                : [{ kind: "prose" as const, parts: [`  Consequence: ${step.consequence}`] }]),
            ];
          }),
      );
    }
    nodes.push({
      kind: "key-value",
      key: "Next",
      value: {
        kind: "command",
        program: COMMAND_NAME,
        args: [
          { kind: "text", value: "machine" },
          { kind: "text", value: "remove-temp" },
          { kind: "text", value: receipt.temporaryInstallationId },
        ],
      },
    });
    return nodes;
  }
  const nodes: PresentationNode[] = [
    // Severity is the receipt outcome fact: the temporary Profile was removed.
    {
      kind: "notice",
      severity: "success",
      nodes: [{
        kind: "prose",
        parts: [`Removed ${DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.singular}`],
      }],
    },
    ...receipt.warnings.map((warning, index) => ({
      kind: "list-item" as const,
      parts: receipt.warningParts?.[index] ?? [warning],
      category: "attention" as const,
    })),
    {
      kind: "key-value",
      key: "  Temporary installation",
      value: { kind: "identifier", value: receipt.temporaryInstallationId },
      category: "path",
    },
  ];
  if (projectValue !== undefined) {
    nodes.push({ kind: "key-value", key: "  Project", value: projectValue });
  }
  return nodes;
}


/**
 * The blocked temporary-installation diagnostic as a presentation document.
 * The command-name prefix is part of the first line so the prefix counts toward
 * the width measure, and every Project reference is replaced through the one
 * canonical Project path presenter. Human views consume this document; machine
 * JSON publishes the structured blocker records.
 */
export function temporaryBlockedMessagesDocument(
  blockers: readonly ReconciliationBlocker[],
  canonicalProject: string,
  authoredProject = canonicalProject,
  cwd = process.cwd(),
  home = homedir(),
): { readonly presented: string; readonly document: PresentationDocument } {
  const presented = displayProjectPath(
    canonicalProject,
    authoredProject,
    "fleet",
    cwd,
    home,
  );
  const references = [...new Set([canonicalProject, absoluteAuthoredPath(authoredProject, home)])]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const replaceReferences = (line: string): string =>
    references.reduce(
      (reduced, project) => replaceProjectReference(reduced, project, presented),
      line,
    );
  const replaceReferencesInParts = (content: readonly InlineContent[]): readonly InlineContent[] =>
    content.map((part) =>
      typeof part === "string" ? replaceReferences(part) : part
    );
  const document: PresentationDocument = blockers.flatMap((blocker, index) => {
    const wording = humanBlockerWording(blocker);
    // Every blocked temporary-installation Blocker renders its problem and
    // its remedy, so recovery always names a runnable command (US-027). The
    // command-name diagnostic prefix belongs to the first line only, exactly
    // as the composed CLI diagnostic carried it before the document model.
    const problem: readonly InlineContent[] = index === 0
      ? [`${COMMAND_NAME}: `, ...wording.problem]
      : wording.problem;
    return [
      { kind: "prose", parts: replaceReferencesInParts(problem), category: "error" },
      {
        kind: "prose",
        parts: replaceReferencesInParts(["Remedy: ", ...wording.remedy]),
      },
    ];
  });
  return { presented, document };
}

export function formatTemporaryInstallationBlockedJson(
  command: TemporaryInstallCommand,
  blockers: readonly ReconciliationBlocker[],
): string {
  return `${JSON.stringify(
    {
      schemaVersion: TEMPORARY_INSTALLATION_MACHINE_SCHEMA_VERSION,
      command,
      outcome: "blocked",
      blockers: blockers.map(machineBlocker),
    },
    null,
    2,
  )}\n`;
}

export function formatTemporaryInstallationToolErrorJson(
  command: TemporaryInstallCommand,
  message: string,
  options: {
    readonly removalRequired?: boolean;
    readonly temporaryInstallationId?: string;
  } = {},
): string {
  return `${JSON.stringify(
    {
      schemaVersion: TEMPORARY_INSTALLATION_MACHINE_SCHEMA_VERSION,
      command,
      outcome: "error",
      error: message,
      ...(options.removalRequired
        ? {
            removalRequired: true,
            temporaryInstallationId: options.temporaryInstallationId,
          }
        : {}),
    },
    null,
    2,
  )}\n`;
}
