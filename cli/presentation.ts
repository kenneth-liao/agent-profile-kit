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
import {
  STATE_READ_FAILURE_CASES,
  type StateReadFailureFact,
} from "../installer/blockers.js";

export {
  applyNewcomerSubstitutions,
  describeStateReadFailure,
  formatProjectTargetError,
  formatProjectTargetErrorForHuman,
} from "./blocker-wording.js";
import {
  commandPart,
  flatInlineText,
  identifierPart,
  pathPart,
  renderPresentationDocument,
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
import type { HostSetupProvenance, HostSetupStep, HostSetupStepKind } from "../adapters/project-plan.js";
import {
  type ApplyReconciliationResult,
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
import type { UninstallResult, ValidationResult } from "../installer/commands.js";
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

export type LifecycleCommand = "apply" | "status";

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
    `The ${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)} is not installed yet; apply will create its ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}.`,
  update:
    `${capitalize(DEFAULT_VIEW_LEXICON.desiredState)} changed for this ` +
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)}; apply will rewrite ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive} to match.`,
  "stale source":
    `Workspace source changed since the last apply; ${DEFAULT_VIEW_LEXICON.generatedOutput.plural} no longer ` +
    `match current ${DEFAULT_VIEW_LEXICON.desiredState}.`,
  "drifted output":
    `An owned ${DEFAULT_VIEW_LEXICON.generatedOutput.singular} differs from its recorded installation; apply will ` +
    `replace it from current ${DEFAULT_VIEW_LEXICON.desiredState}.`,
  "malformed ownership state":
    "Ownership metadata is incomplete or inconsistent, so Agent Profile Kit cannot prove what it owns.",
  blocked:
    `${capitalize(DEFAULT_VIEW_LEXICON.reconciliation.noun)} cannot change this ` +
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)} until the listed blocker is resolved.`,
  removal:
    `No ${DEFAULT_VIEW_LEXICON.projectBinding.singular} remains for this installation; apply will remove proven ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}.`,
};

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

export function formatInfoHuman(
  info: ApplicationInfo,
  options: { readonly context?: TerminalPresentationContext } = {},
  home = homedir(),
  cwd = process.cwd(),
): string {
  return renderStandaloneDocument(infoDocument(info, home, cwd), options.context, { cwd, home });
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

/** Shared rendering for standalone documents: default context when unrequested. */
function renderStandaloneDocument(
  document: PresentationDocument,
  context?: TerminalPresentationContext,
  environment: { readonly cwd?: string; readonly home?: string } = {},
): string {
  const rendered = renderPresentationDocument(
    document,
    context ?? DEFAULT_RENDER_CONTEXT,
    environment.cwd === undefined && environment.home === undefined ? {} : environment,
  );
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
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

export function formatInventoryIndex(
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  return renderStandaloneDocument(inventoryIndexDocument(), options.context);
}

/** Index view for the machine-namespaced inventory command (DEC-019). */
export function formatMachineInventoryIndex(
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  return renderStandaloneDocument(machineInventoryIndexDocument(), options.context);
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
          commandPart(COMMAND_NAME, [arg("bind"), arg("<profile>"), arg("--host"), arg("<host>")]),
          " to configure a Project.",
        ],
      },
    ];
  }

  const nodes: PresentationNode[] = [{ kind: "heading", text: `Projects (${projects.length}):` }];
  for (const project of projects) {
    nodes.push(
      spacerNode(),
      {
        kind: "key-value",
        key: "Project",
        value: projectPathNode(project.canonicalProject ?? project.project, project.project, "fleet"),
      },
      {
        kind: "key-value",
        key: "  Profile",
        value: { kind: "identifier", value: project.profile },
        category: "path",
      },
      {
        kind: "key-value",
        key: "  Hosts",
        value: { kind: "identifier", value: project.hosts.join(", ") },
      },
    );
    if (project.problem !== null) {
      nodes.push({
        kind: "prose",
        parts: [
          "  Problem: ",
          ...formatInstallerToolError(project.problem),
        ],
        category: "attention",
      });
    }
  }
  nodes.push(
    spacerNode(),
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

export function formatProjectInventoryHuman(
  projects: readonly ProjectInventoryRecord[],
  options: { readonly context?: TerminalPresentationContext } = {},
  home = homedir(),
  cwd = process.cwd(),
): string {
  return renderStandaloneDocument(
    projectInventoryDocument(projects, home, cwd),
    options.context,
    { cwd, home },
  );
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
          commandPart(COMMAND_NAME, [arg("bind")]),
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
        commandPart(COMMAND_NAME, [arg("bind")]),
        " to select it for a configured Project.",
      ],
    },
  );
  return nodes;
}

export function formatProfileInventoryHuman(
  profiles: readonly ProfileInventoryRecord[],
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  return renderStandaloneDocument(profileInventoryDocument(profiles), options.context);
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
        commandPart(COMMAND_NAME, [arg("bind")]),
        " to select it for a configured Project.",
      ],
    },
  ];
}

export function formatHostInventoryHuman(
  hosts: readonly HostInventoryRecord[],
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  return renderStandaloneDocument(hostInventoryDocument(hosts), options.context);
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

export function formatTemporaryInventoryHuman(
  installations: readonly TemporaryInventoryRecord[],
  options: { readonly context?: TerminalPresentationContext } = {},
  home = homedir(),
  cwd = process.cwd(),
): string {
  return renderStandaloneDocument(
    temporaryInventoryDocument(installations, home, cwd),
    options.context,
    { cwd, home },
  );
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
    ...result.warnings.map((warning) => ({
      kind: "prose" as const,
      parts: [`Warning: ${warning}`],
      category: "attention" as const,
    })),
    {
      kind: "key-value",
      key: "Next",
      value: {
        kind: "command",
        program: COMMAND_NAME,
        args: [{
          kind: "text",
          value: result.bindings === 0 ? "bind <profile> --host <host>" : "status",
        }],
      },
    },
  ];
}

export function formatValidationResult(
  result: ValidationResult,
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  return renderStandaloneDocument(validationResultDocument(result), options.context);
}

/** The uninstall result view as a presentation document. */
export function uninstallResultDocument(
  result: UninstallResult,
  home = homedir(),
  cwd = process.cwd(),
): PresentationDocument {
  const projectCount = result.projects.length;
  const keptCount = result.kept.length;
  const nodes: PresentationNode[] = [
    // Severity is the teardown outcome fact: removed, kept-below, or nothing installed.
    {
      kind: "notice",
      severity: "success",
      nodes: [{
        kind: "prose",
        parts: [projectCount === 0
          ? keptCount === 0
            ? "No ordinary Agent Profile Kit-owned output is installed."
            : `Removed no Agent Profile Kit-owned output; kept ${plural(keptCount, "Project")} below.`
          : `Removed proven Agent Profile Kit-owned output from ${plural(projectCount, "Project")}.`],
      }],
    },
  ];
  for (const project of result.projects) {
    nodes.push(
      spacerNode(),
      {
        kind: "key-value",
        key: "Project",
        value: projectPathNode(project.project, project.project, "fleet"),
      },
      { kind: "prose", parts: ["  Removed generated paths:"], category: "success" },
      ...project.outputs.map((path) => ({ kind: "prose" as const, parts: ["  - ", identifierPart(path)] })),
    );
    if (project.repositoryExclusions.length > 0) {
      nodes.push(
        { kind: "prose", parts: ["  Cleaned Git exclusions:"] },
        ...project.repositoryExclusions.flatMap((exclusion) =>
          exclusion.entries.map((entry) => ({
            kind: "prose" as const,
            parts: [
              "  - ",
              identifierPart(entry),
              ` (${replaceProjectReference(
                exclusion.target,
                project.project,
                displayProjectPath(project.project, project.project, "fleet", cwd, home),
              )})`,
            ],
          })),
        ),
      );
    }
  }
  if (keptCount > 0) {
    nodes.push(
      spacerNode(),
      {
        kind: "prose",
        parts: [`Kept ${plural(keptCount, "Project")} whose owned output could not be fully removed:`],
      },
    );
    for (const kept of result.kept) {
      nodes.push(
        spacerNode(),
        {
          kind: "key-value",
          key: "Project",
          value: projectPathNode(kept.project, kept.project, "fleet"),
        },
        // The reason is a removal failure fact; its category is error.
        { kind: "prose", parts: [`  - ${renderItemReason(kept.reason)}`], category: "error" },
      );
    }
  }
  if (result.warnings.length > 0) {
    nodes.push(
      spacerNode(),
      { kind: "prose", parts: ["Warnings:"], category: "attention" },
      ...result.warnings.map((warning) => ({
        kind: "list-item" as const,
        parts: [warning],
      })),
    );
  }
  nodes.push(
    spacerNode(),
    { kind: "prose", parts: [`${capitalize(DEFAULT_VIEW_LEXICON.projectBinding.plural)} preserved.`] },
  );
  if (projectCount > 0) {
    nodes.push({
      kind: "prose",
      parts: [
        "Next: Run ",
        commandPart(COMMAND_NAME, [arg("unbind")]),
        ` for ${DEFAULT_VIEW_LEXICON.projectBinding.plural} you no longer want, or `,
        commandPart(COMMAND_NAME, [arg("apply")]),
        " to reinstall.",
      ],
      category: "command",
    });
  }
  return nodes;
}

export function formatUninstallResult(
  result: UninstallResult,
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  return renderStandaloneDocument(uninstallResultDocument(result), options.context);
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
  const overflow = paths.length - DEFAULT_OUTPUT_PATH_LIMIT;
  return overflow > 0
    ? [
        ...paths.slice(0, DEFAULT_OUTPUT_PATH_LIMIT),
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

function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The exact user-owned untracking command for proven tracked paths only
 * (#353): bound to the Blocker's own Project root so the caller's working
 * directory never selects the wrong repository, recursive so directory
 * evidence works, canonical order, safe option termination, POSIX
 * single-quoting. Guidance only — Agent Profile Kit never executes it.
 */
function trackedPathUntrackCommand(
  project: string,
  paths: readonly string[],
): string {
  return `git -C ${shellSingleQuoted(project)} rm -r --cached -- ${paths.map(shellSingleQuoted).join(" ")}`;
}

/** How one ownership-conflict Blocker presents its user-owned recovery. */
type UntrackRecovery =
  | { readonly kind: "full" }
  | { readonly kind: "pointer"; readonly command: LifecycleCommand };







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
  return command === "apply" &&
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
): string {
  if (command === "apply") {
    if (reportBlockers(report).length > 0) return applyCompleted ? "Apply completed with blockers" : "Apply blocked";
    if (reportItems(report).some((item) => item.kind !== "current")) return "Apply completed with attention";
    return "Apply complete";
  }
  const currentProjects = fullyCurrentProjectCount(report);
  if (reportBlockers(report).length > 0) return "Cannot apply";
  if (currentProjects !== undefined) {
    if (reportHasHostAttention(report)) return "Host attention required";
    const projects = capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural);
    return `All ${projects} are current (${plural(currentProjects, capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular))})`;
  }
  if (reportItems(report).length > 0) return "Ready to apply";
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
    if (command === "apply") parts.push("Pending: blocked");
    parts.push(`Blockers: ${reportBlockers(report).length}`);
    return parts.join(" · ");
  }
  const changes = changeParts(summarizeOutputs(reportOutputs(report)));
  if (changes.length > 0) {
    parts.push(`${command === "apply" ? "Pending" : "Changes"}: ${changes.join(", ")}`);
  }
  return parts.length === 1 ? undefined : parts.join(" · ");
}

function warningGroupKey(warning: ReconciliationWarning): string {
  return JSON.stringify([
    warning.kind,
    warning.message,
    warning.consequence ?? "",
    [...warning.copyableValues],
  ]);
}

export interface WarningPresentationGroup {
  readonly consequence?: string;
  readonly copyableValues: readonly string[];
  readonly kind: ReconciliationWarning["kind"];
  readonly message: string;
  readonly parts: readonly InlineContent[];
  readonly projects: readonly {
    readonly canonicalProject: string;
    readonly project: string;
  }[];
}

function groupWarnings(report: ReconciliationReport): readonly WarningPresentationGroup[] {
  const groups = new Map<string, {
    consequence?: string;
    copyableValues: readonly string[];
    kind: ReconciliationWarning["kind"];
    message: string;
    parts: readonly InlineContent[];
    projects: { canonicalProject: string; project: string }[];
  }>();

  for (const projectRecord of report.projects) {
    for (const warning of projectRecord.warnings) {
      if (
        warning.message.endsWith(REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX) ||
        warning.message.endsWith(REPOSITORY_EXCLUSION_MODIFIED_WARNING_SUFFIX)
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
          message: warning.message,
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

  return [...groups.values()]
    .map((group) => ({
      ...(group.consequence === undefined ? {} : { consequence: group.consequence }),
      copyableValues: group.copyableValues,
      kind: group.kind,
      message: group.message,
      parts: group.parts,
      projects: [...group.projects].sort((left, right) =>
        compareCanonicalStrings(left.canonicalProject, right.canonicalProject)
      ),
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.message, right.message) ||
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
  if (command === "apply" && reportBlockers(report).length > 0) return [];
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
function readinessLines(
  report: ReconciliationReport,
  receipt: ReconciliationReport,
): readonly string[] {
  const changedProjects = new Set(statusAffectedProjects(receipt));
  const profiles = [...new Set(
    report.projects
      .filter((record) => changedProjects.has(record.canonicalProject))
      .map((record) => record.desired?.profile)
      .filter((profile): profile is string => profile !== undefined),
  )].sort(compareCanonicalStrings);

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
  if (command === "apply" && reportBlockers(report).length === 0) return [];
  const scope = locationDisplayScope(options, report);
  const applyCommandArgs: readonly CommandArg[] = options.all === true
    ? [arg("apply"), arg("--all")]
    : options.project !== undefined
    ? [arg("apply"), arg(options.project)]
    : report.projects.length > 1
    ? [arg("apply"), arg("--all")]
    : [arg("apply")];

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
      addAction(
        [
          "Resolve the reported ",
          blockerWord,
          ", then run ",
          commandPart(COMMAND_NAME, [arg(command)]),
          " again.",
        ],
        project,
      );
      continue;
    }
    if (!groupNeedsAttention(group, command)) continue;
    if (reportBlockers(report).length > 0 && globalBlockers.length === 0) {
      if (command === "status") {
        addAction(
          [
            "After all blockers are resolved, run ",
            commandPart(COMMAND_NAME, applyCommandArgs),
            ".",
          ],
          project,
        );
      } else {
        addAction(
          [
            "After all blockers are resolved, run ",
            commandPart(COMMAND_NAME, applyCommandArgs),
            command === "apply" ? " again." : ".",
          ],
          project,
        );
      }
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
      commandPart(COMMAND_NAME, [arg(command)]),
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
    if (uniqueProjects.length === 1) {
      const project = uniqueProjects[0]!;
      return [
        pathPart(project.canonical, scope, project.authored),
        ": ",
        ...entry.parts,
      ];
    }
    if (grouped.size === 1) return [...entry.parts];
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
): string {
  const allProjects = reportProjects(report);
  if (
    group.projects.length === allProjects.length &&
    group.projects.every(({ canonicalProject }) => allProjects.includes(canonicalProject))
  ) {
    return `in ${plural(group.projects.length, "project")}`;
  }
  if (group.projects.length <= PROJECT_SCOPE_LIMIT) {
    return `in ${group.projects.map((project) => presentProject(project, scope)).join(", ")}`;
  }
  const visible = group.projects
    .slice(0, PROJECT_SCOPE_LIMIT)
    .map((project) => presentProject(project, scope));
  return `in ${visible.join(", ")}, … ${plural(group.projects.length - PROJECT_SCOPE_LIMIT, "more Project")}; ` +
    "use --verbose to see all Projects";
}

function operationGroupLine(
  group: OperationPresentationGroup,
  report: ReconciliationReport,
  scope: LocationDisplayScope,
): string {
  const operation = group.fileCount === 1 ? group.operation : `${group.operation}s`;
  return `${PLANNED_OUTPUT_OPERATION_MARKER[group.operation]} ${group.fileCount} generated file ${operation} ` +
    operationScopeClause(group, report, scope);
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
      parts: [`  ${operationGroupLine(group, report, scope)}`],
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
    operationScopeClause(group, report, displayScope);
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

function isFleetLifecycle(
  options: LifecycleHumanOptions,
  report: ReconciliationReport,
): boolean {
  return options.all === true || (options.project === undefined && report.projects.length > 1);
}

function locationDisplayScope(
  options: LifecycleHumanOptions,
  report: ReconciliationReport,
): LocationDisplayScope {
  return isFleetLifecycle(options, report) ? "fleet" : "project";
}

function lifecycleInvocation(
  command: LifecycleCommand,
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): string {
  if (isFleetLifecycle(options, report)) {
    return `${COMMAND_NAME} ${command} --all`;
  }
  if (options.project !== undefined) return `${COMMAND_NAME} ${command} ${options.project}`;
  return `${COMMAND_NAME} ${command}`;
}



/**
 * One named path line per affected generated file in the Apply Receipt, with
 * its Project attribution, ordered by operation, Project, then path, and
 * capped at the shared concise path limit with one overflow pointer.
 */
function operationReceiptPathLines(
  receipt: ReconciliationReport,
  scope: LocationDisplayScope,
): readonly string[] {
  const lines = receipt.projects
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
  const overflow = lines.length - DEFAULT_OUTPUT_PATH_LIMIT;
  return overflow > 0
    ? [...lines.slice(0, DEFAULT_OUTPUT_PATH_LIMIT), overflowPointer(overflow, "file")]
    : lines;
}




interface LifecycleHumanOptions {
  readonly all?: boolean;
  readonly blockersOnly?: boolean;
  readonly context?: TerminalPresentationContext;
  readonly project?: string;
  readonly verbose?: boolean;
}

interface VerboseSectionOptions {
  readonly completedRepositoryExclusions?: boolean;
  readonly includeStateExplanations?: boolean;
  readonly scope: LocationDisplayScope;
  readonly stateExplanationItems?: readonly ReconciliationItem[];
  readonly untrackRecovery: UntrackRecovery;
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
    nodes: [{ kind: "prose", parts: [outcomeLine("apply", report, applyCompleted)] }],
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
    { kind: "heading", text: "Applied:" },
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
    const paths = outputPathLines(group.outputs);
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
    return [{ kind: "prose", parts: ["Applied: none."] }];
  }
  const nodes: PresentationNode[] = [
    { kind: "heading", text: "Applied:" },
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
  const noOpApply = isNoOpApply("apply", report, receipt);

  const nodes: PresentationNode[] = [
    applyOutcomeNotice(report, noOpApply || receipt !== undefined),
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
    : groups.filter((group) => groupNeedsAttention(group, "apply"));

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
            { kind: "pointer", command: "apply" },
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
          { kind: "pointer", command: "apply" },
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

  const globalBlockers = globalBlockerNodes(report, groups, {
    kind: "pointer",
    command: "apply",
  }, scope);
  if (globalBlockers.length > 0) nodes.push(spacerNode(), ...globalBlockers);

  const blockedSummary = blocked ? aggregateLine("apply", report, groups) : undefined;
  if (blockedSummary !== undefined) {
    nodes.push(spacerNode(), {
      kind: "notice",
      severity: "error",
      nodes: [{ kind: "prose", parts: [blockedSummary] }],
    });
  }

  nodes.push(...warningNodes(report, groups, scope));

  const setupNodes = conciseFirstUseNodes(
    presentedSetupSteps("apply", report, receipt, false, scope),
    receipt,
  );
  if (setupNodes.length > 0) nodes.push(spacerNode(), ...setupNodes);

  const next = nextActionNodes("apply", report, {
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
    if (readiness.length > 0) nodes.push(spacerNode(), ...readiness);
  }
  return nodes;
}

/** The verbose apply view as a presentation document. */
function verboseApplyDocument(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, result.resultingState);
  const untrackRecovery: UntrackRecovery = { kind: "pointer", command: "apply" };
  const nodes: PresentationNode[] = [
    applyOutcomeNotice(result.resultingState, true),
    { kind: "heading", text: "Pending:" },
    ...verboseLifecycleSections(result.resultingState, {
      scope,
      stateExplanationItems: [
        ...reportItems(result.resultingState),
        ...reportItems(result.receipt),
      ],
      untrackRecovery,
    }),
    { kind: "heading", text: "Applied:" },
    ...verboseLifecycleSections(result.receipt, {
      includeStateExplanations: false,
      scope,
      untrackRecovery,
    }),
    ...verboseHostSetupNodes("apply", result.resultingState, scope),
  ];
  if (reportBlockers(result.resultingState).length === 0) {
    nodes.push(...readinessNodes(result.resultingState, result.receipt));
  }
  return nodes;
}

/**
 * Ordered apply safety evidence for a focused view (#352) as typed nodes: the
 * committed Apply Receipt with the Projects it made current, then still-pending
 * Project identities. The focused filter renders this prefix before Blocker
 * evidence and can never suppress it, because a presentation filter must never
 * hide writes (ADR-0024, spec #345 Decision 6).
 */
function focusedApplySafetyEvidenceNodes(
  postState: ReconciliationReport,
  receipt: ReconciliationReport,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const nodes: PresentationNode[] = [
    ...committedApplyEvidenceNodes(receipt, postState, postState.projects.length > 1, scope),
  ];
  const pending = stillPendingNodes(postState, scope);
  if (pending.length > 0) nodes.push(spacerNode(), ...pending);
  return nodes.length > 0 ? [spacerNode(), ...nodes] : nodes;
}

/** Focused apply view (#352) as a document: safety-evidence prefix, then Blocker evidence. */
function focusedApplyDocument(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, result.resultingState);
  return [
    applyOutcomeNotice(result.resultingState, true),
    ...focusedApplySafetyEvidenceNodes(result.resultingState, result.receipt, scope),
    ...(options.verbose === true
      ? focusedVerboseBlockerNodes(result.resultingState, scope)
      : focusedConciseBlockerNodes(result.resultingState, "apply", scope)),
  ];
}

/** The apply receipt view as a presentation document. */
export function applyReportDocument(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions = {},
): PresentationDocument {
  const focused =
    options.blockersOnly === true && reportBlockers(result.resultingState).length > 0;
  if (focused) return focusedApplyDocument(result, options);
  if (options.verbose === true) return verboseApplyDocument(result, options);
  return conciseApplyDocument(result.resultingState, result.receipt, options);
}

/** The blocked apply view as a presentation document. */
export function blockedApplyReportDocument(
  report: BlockedReconciliationReport,
  options: LifecycleHumanOptions = {},
): PresentationDocument {
  const scope = locationDisplayScope(options, report);
  if (options.blockersOnly === true) {
    return [
      applyOutcomeNotice(report, false),
      ...(options.verbose === true
        ? focusedVerboseBlockerNodes(report, scope)
        : focusedConciseBlockerNodes(report, "apply", scope)),
    ];
  }
  if (options.verbose === true) {
    return [
      applyOutcomeNotice(report, false),
      ...verboseLifecycleSections(report, {
        scope,
        untrackRecovery: { kind: "pointer", command: "apply" },
      }),
      ...verboseHostSetupNodes("apply", report, scope),
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
  options: LifecycleHumanOptions = {},
): PresentationDocument {
  const scope = locationDisplayScope(options, failure.receipt);
  const failedProject = failure.failedProject === undefined
    ? undefined
    : presentProject(failure.failedProject, scope);
  const nodes: PresentationNode[] = [
    {
      kind: "notice",
      severity: "error",
      nodes: [{
        kind: "prose",
        parts: [failedProject === undefined
          ? `Apply failed after committing Project work: ${failure.detail}`
          : `Apply failed at ${failedProject}: ${failure.detail}`],
      }],
    },
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
  if (
    options.blockersOnly === true &&
    failure.resultingState !== undefined &&
    reportBlockers(failure.resultingState).length > 0
  ) {
    // Both focused sections supply their own leading blank line (RE-1).
    nodes.push(...(options.verbose === true
      ? focusedVerboseBlockerNodes(
          failure.resultingState,
          locationDisplayScope(options, failure.resultingState),
        )
      : focusedConciseBlockerNodes(
          failure.resultingState,
          "apply",
          locationDisplayScope(options, failure.resultingState),
        )));
  }
  return nodes;
}

/** The apply verification-failure view as a presentation document. */
export function applyVerificationFailureDocument(
  receipt: ReconciliationReport,
  message: string,
  options: LifecycleHumanOptions = {},
): PresentationDocument {
  const scope = locationDisplayScope(options, receipt);
  if (options.verbose === true) {
    return [
      { kind: "notice", severity: "error", nodes: [{ kind: "prose", parts: [message] }] },
      { kind: "heading", text: "Applied:" },
      ...verboseLifecycleSections(receipt, {
        scope,
        // Focused verbose verification failure carries the exact command
        // (#353 Decision 3); ordinary verbose points to the focused view.
        untrackRecovery: options.blockersOnly === true
          ? { kind: "full" }
          : { kind: "pointer", command: "apply" },
      }),
      ...verboseHostSetupNodes("apply", receipt, scope),
    ];
  }
  const nodes: PresentationNode[] = [
    { kind: "notice", severity: "error", nodes: [{ kind: "prose", parts: [message] }] },
    ...applyReceiptNodes(receipt, scope),
  ];
  const setup = conciseFirstUseNodes(
    presentedSetupSteps("apply", receipt, receipt, false, scope),
    receipt,
  );
  if (setup.length > 0) nodes.push(spacerNode(), ...setup);
  return nodes;
}

const DEFAULT_RENDER_CONTEXT: TerminalPresentationContext = {
  color: false,
  interactive: false,
  width: 10_000,
};

/** Render one lifecycle document with default context when unrequested. */
function renderLifecycleDocument(
  document: PresentationDocument,
  context?: TerminalPresentationContext,
): string {
  const rendered = renderPresentationDocument(document, context ?? DEFAULT_RENDER_CONTEXT);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

export function formatApplyReport(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions = {},
): string {
  return renderLifecycleDocument(
    applyReportDocument(result, options),
    options.context,
  );
}

export function formatApplyExecutionFailure(
  failure: {
    readonly detail: string;
    readonly failedProject: ProjectIdentity | undefined;
    readonly message: string;
    readonly pendingProjects: readonly ProjectIdentity[];
    readonly receipt: ReconciliationReport;
    readonly resultingState: ReconciliationReport | undefined;
  },
  options: LifecycleHumanOptions = {},
): string {
  return renderLifecycleDocument(
    applyExecutionFailureDocument(failure, options),
    options.context,
  );
}

export function formatApplyVerificationFailure(
  receipt: ReconciliationReport,
  message: string,
  options: LifecycleHumanOptions = {},
): string {
  return renderLifecycleDocument(
    applyVerificationFailureDocument(receipt, message, options),
    options.context,
  );
}

export function formatBlockedApplyReport(
  report: BlockedReconciliationReport,
  options: LifecycleHumanOptions = {},
): string {
  return renderLifecycleDocument(
    blockedApplyReportDocument(report, options),
    options.context,
  );
}

/**
 * Focused Blocker view for `status --blockers-only` (#351) and
 * `apply --blockers-only` (#352). A strict Blocker filter, not an attention or
 * warning filter: every selected-scope Blocker with concise deterministic
 * grouping, no unrelated lifecycle inventory. Footer counts derive exclusively
 * from the displayed Blockers. Apply renderers place their receipt, failed,
 * and pending safety evidence in an ordered prefix before this section so the
 * filter can never conceal or duplicate it.
 */
function blockersOnlyFooter(report: ReconciliationReport): string {
  const blockers = reportBlockers(report);
  const affectedProjects = new Set(
    blockers
      .map((blocker) => blockerProject(blocker))
      .filter((project): project is string => project !== undefined),
  );
  const parts = [`Blockers: ${blockers.length}`];
  if (affectedProjects.size > 0) {
    parts.push(`Affected Projects: ${affectedProjects.size}`);
  }
  return parts.join(" · ");
}

/** Groups whose Blockers the focused view displays — the one derivation
 * shared by the focused Blocker section and status next actions, so the two
 * can never desync (INT-1). */
function displayedBlockerGroups(report: ReconciliationReport): readonly ProjectGroup[] {
  return groupProjects(report).groups.filter((candidate) => candidate.blockers.length > 0);
}



/** The typed concise focused Blocker section shared by `status` and `apply`:
 * one deterministic group per affected Project, then global Blockers, then the
 * displayed-Blocker footer. The caller owns the outcome notice and any prefix. */
function focusedConciseBlockerNodes(
  report: ReconciliationReport,
  command: LifecycleCommand,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const grouped = groupProjects(report);
  const nodes: PresentationNode[] = [];
  for (const group of displayedBlockerGroups(report)) {
    nodes.push(
      spacerNode(),
      {
        kind: "key-value",
        key: capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular),
        value: projectPathNode(group.canonicalProject, group.project, scope),
      },
      ...group.blockers.flatMap((blocker) =>
        conciseBlockerNodes(
          blocker,
          displayProjectPath(group.canonicalProject, group.project, scope),
          grouped.groups,
          "  ",
          { kind: "pointer", command },
          scope,
        ),
      ),
    );
  }
  const globalBlockers = globalBlockerNodes(report, grouped.groups, {
    kind: "pointer",
    command,
  }, scope);
  if (globalBlockers.length > 0) nodes.push(spacerNode(), ...globalBlockers);
  nodes.push(spacerNode(), blockersOnlyFooterNode(report));
  return nodes;
}

/** The typed verbose focused Blocker section: complete Blocker fields with
 * every affected item, then the footer. This is the only view that prints the
 * exact user-owned untracking command (#353, spec #345 Decision 8). */
function focusedVerboseBlockerNodes(
  report: ReconciliationReport,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const groups = groupProjects(report).groups;
  const shorten = (text: string): string => shortenProjectReferences(text, groups, scope);
  return [
    spacerNode(),
    { kind: "heading", text: "Blockers:", category: "error" },
    ...reportBlockers(report).flatMap((blocker) =>
      verboseBlockerNodes(blocker, groups, shorten, { kind: "full" }, scope)
    ),
    spacerNode(),
    blockersOnlyFooterNode(report),
  ];
}

/** The typed untracking recovery for one ownership-conflict Blocker. */
function untrackRecoveryNodes(
  project: string,
  paths: readonly string[],
  indent: string,
  recovery: UntrackRecovery,
): PresentationNode[] {
  if (paths.length === 0) return [];
  if (recovery.kind === "pointer") {
    return [
      {
        kind: "prose",
        parts: [
          `${indent}  Recovery command: run `,
          commandPart("apkit", [
            arg(recovery.command),
            arg("--blockers-only"),
            arg("--verbose"),
          ]),
          " to see the exact untracking command.",
        ],
      },
    ];
  }
  return [
    {
      kind: "prose",
      parts: [`${indent}  Recovery: run the command below yourself; Agent Profile Kit never executes it. ` +
        "It stages removal of these paths from Git ownership (the Git index) while the working files are preserved:"],
    },
    {
      kind: "command",
      program: "git",
      args: [
        { kind: "text", value: "-C" },
        { kind: "text", value: shellSingleQuoted(project) },
        { kind: "text", value: "rm" },
        { kind: "text", value: "-r" },
        { kind: "text", value: "--cached" },
        { kind: "text", value: "--" },
        ...paths.map((path) => ({ kind: "text" as const, value: shellSingleQuoted(path) })),
      ],
      category: "command",
    },
    { kind: "prose", parts: [`${indent}  Alternatively, change or remove the configured Project.`] },
  ];
}

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
  untrackRecovery: UntrackRecovery,
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
      { kind: "prose", parts: [`${indent}  Scope: ${blockerScopeText(blocker, displayProject)}`] },
      ...(paths.length === 0 ? [] as PresentationNode[] : [
        { kind: "prose" as const, parts: [`${indent}  Affected paths (${paths.length}):`] },
        ...trackedPathGroupLines(paths, indent).map((line) => ({
          kind: "prose" as const,
          parts: [line],
        })),
      ]),
      ...untrackRecoveryNodes(blocker.project!, paths, indent, untrackRecovery),
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
    { kind: "prose", parts: [`${indent}  Scope: ${blockerScopeText(blocker, displayProject)}`] },
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
  untrackRecovery: UntrackRecovery,
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
  if (isOutputOwnershipConflict(blocker)) {
    nodes.push(...untrackRecoveryNodes(
      blocker.project!,
      outputOwnershipConflictPaths(blocker),
      "",
      untrackRecovery,
    ));
  }
  return nodes;
}

/** The typed global-Blocker section; empty when no global Blocker exists. */
function globalBlockerNodes(
  report: ReconciliationReport,
  groups: readonly ProjectGroup[],
  untrackRecovery: UntrackRecovery,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const globalBlockers = reportBlockers(report).filter((blocker) => blockerProject(blocker) === undefined);
  if (globalBlockers.length === 0) return [];
  return [
    { kind: "heading", text: "Global blockers:", category: "error" },
    ...globalBlockers.flatMap((blocker) =>
      conciseBlockerNodes(blocker, undefined, groups, "  ", untrackRecovery, scope)
    ),
  ];
}

/** The displayed-Blocker footer as one typed summary line. */
function blockersOnlyFooterNode(report: ReconciliationReport): PresentationNode {
  return {
    kind: "prose",
    parts: [blockersOnlyFooter(report)],
    category: "error",
  };
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
  const args: CommandArg[] = [{ kind: "text", value: command }];
  if (isFleetLifecycle(options, report)) {
    args.push({ kind: "text", value: "--all" });
  } else if (options.project !== undefined) {
    const group = selectedProjectGroup(report, options.project);
    args.push({
      kind: "path",
      canonicalPath: group.canonicalProject,
      authoredPath: group.project,
      scope: locationDisplayScope(options, report),
    });
  }
  args.push(...extraArgs);
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
      value: statusLifecycleCommand("apply", report, options),
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
function statusOutcomeNotice(report: ReconciliationReport): PresentationNode {
  let severity: NoticeSeverity = "success";
  if (reportBlockers(report).length > 0) severity = "error";
  else if (
    reportHasHostAttention(report) && fullyCurrentProjectCount(report) !== undefined
  ) severity = "attention";
  return {
    kind: "notice",
    severity,
    nodes: [{ kind: "prose", parts: [outcomeLine("status", report)] }],
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
  report: ReconciliationReport,
  groups: readonly ProjectGroup[],
  scope: LocationDisplayScope,
): PresentationNode[] {
  const warningGroups = groupWarnings(report);
  if (warningGroups.length === 0) return [];
  return [
    spacerNode(),
    { kind: "heading", text: "Warnings:", category: "attention" },
    ...warningGroups.map((group) => ({
      kind: "list-item" as const,
      parts: [
        ...formatWarningGroupParts(group, groups, scope),
        ` (${plural(group.projects.length, "Project")})`,
      ],
    })),
  ];
}

/** The verbose lifecycle detail sections and Blocker section as typed nodes.
 * Composed Context is the only verbatim content: it is user-authored
 * material reproduced byte-for-byte (INT-1). */
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
      nodes.push(...verboseBlockerNodes(blocker, groups, shorten, options.untrackRecovery, options.scope));
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
  // The populated Blockers section leads the verbose view; the trailing
  // heading exists only to report the empty outcome.
  if (blockers.length === 0) {
    nodes.push({ kind: "heading", text: "Blockers:", category: "error" });
    nodes.push({ kind: "prose", parts: ["(none)"] });
  }
  return nodes;
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
  const outputs = reportOutputs(report);
  const exclusions = changedRepositoryExclusions(report);
  const warningGroups = groupWarnings(report);
  const nodes: PresentationNode[] = [
    { kind: "heading", text: "Projects:" },
    ...(items.length === 0
      ? [{ kind: "prose" as const, parts: ["(no projects)"] }]
      : items.map((item) => ({
        kind: "prose" as const,
        parts: [
          identifierPart(shorten(item.project)),
          `: ${item.kind}${item.reason ? ` (${renderItemReason(item.reason)})` : ""}`,
        ],
      }))),
  ];
  if (includeStateExplanations) {
    nodes.push(...stateExplanationNodes(stateExplanationItems));
  }
  nodes.push(
    { kind: "heading", text: "Outputs:" },
    ...(outputs.length === 0
      ? [{ kind: "prose" as const, parts: ["(none)"] }]
      : outputs.map((output) => ({
        kind: "prose" as const,
        parts: [
          identifierPart(shorten(`${output.project}/${output.path}`)),
          `: ${output.kind}`,
        ],
      }))),
    { kind: "heading", text: "Git exclusions:" },
    ...(exclusions.length === 0
      ? [{ kind: "prose" as const, parts: ["(none)"] }]
      : exclusions.map((change) => {
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
      })),
    { kind: "heading", text: "Selected setup:" },
  );
  const desired = reportDesired(report);
  if (desired.length === 0) nodes.push({ kind: "prose", parts: ["(none)"] });
  for (const installation of desired) {
    nodes.push(...verboseInstallationNodes(installation, report.projects, scope));
  }
  nodes.push({ kind: "heading", text: "Warnings:", category: "attention" });
  if (warningGroups.length === 0) {
    nodes.push({ kind: "prose", parts: ["(none)"] });
    return nodes;
  }
  for (const group of warningGroups) {
    const projectList = group.projects
      .map((project) => displayProjectPath(project.canonicalProject, project.project, scope))
      .join(", ");
    nodes.push({
      kind: "list-item",
      parts: [
        ...formatWarningGroupParts(group, groups, scope),
        ` (${projectList})`,
      ],
    });
  }
  return nodes;
}

/** One verbose Selected-setup installation block; Context stays verbatim. */
function verboseInstallationNodes(
  installation: PresentedDesired,
  records: readonly ReconciliationProjectRecord[],
  scope: LocationDisplayScope,
): PresentationNode[] {
  const project = displayProjectPath(installation.canonicalProject, installation.project, scope);
  const record = records.find((candidate) =>
    candidate.canonicalProject === installation.canonicalProject
  );
  const nodes: PresentationNode[] = [
    { kind: "prose", parts: [`${project}: Profile ${installation.profile}`] },
    { kind: "prose", parts: [`  Hosts: ${installation.hosts.join(", ")}`] },
  ];
  if (installation.capabilityContracts !== undefined) {
    nodes.push({ kind: "prose", parts: ["  Capability Contracts:"] });
    for (const [host, contract] of Object.entries(installation.capabilityContracts)
      .sort(([left], [right]) => left.localeCompare(right))) {
      nodes.push({ kind: "prose", parts: [`    - ${host}: ${contract}`] });
    }
  }
  nodes.push({ kind: "prose", parts: [`  Outputs: ${installation.outputs.join(", ")}`] });
  const consumers = (record?.outputs ?? [])
    .filter((output) => output.consumingHosts.length > 0);
  if (consumers.length > 0) {
    nodes.push({ kind: "prose", parts: ["  Consuming Hosts:"] });
    for (const output of consumers) {
      nodes.push({
        kind: "prose",
        parts: [`    - ${output.path}: ${output.consumingHosts.join(", ")}`],
      });
    }
  }
  if (installation.resolvedArtifacts.length === 0) {
    nodes.push({ kind: "prose", parts: ["  Resolved artifacts: (none)"] });
  } else {
    nodes.push({ kind: "prose", parts: ["  Resolved artifacts:"] });
    for (const artifact of installation.resolvedArtifacts) {
      const reasons = artifact.inclusionReasons.map((reason) => {
        const path = reason.path.length === 0
          ? "selected by profile"
          : `via ${reason.path.join(" -> ")}`;
        return `${reason.profile}: ${path}`;
      }).join("; ");
      nodes.push({ kind: "prose", parts: [`    - ${artifact.type}:${artifact.id} (${reasons})`] });
    }
  }
  nodes.push({ kind: "prose", parts: ["  Context:"] });
  nodes.push({ kind: "verbatim", text: delimitedContext(installation.context) });
  return nodes;
}

/** The verbose Host Setup section as typed nodes. */
function verboseHostSetupNodes(
  command: LifecycleCommand,
  report: ReconciliationReport,
  scope: LocationDisplayScope,
): PresentationNode[] {
  const presented = presentedSetupSteps(command, report, undefined, true, scope);
  const nodes: PresentationNode[] = [{ kind: "heading", text: "Host Setup:" }];
  if (presented.length === 0) {
    nodes.push({ kind: "prose", parts: ["(none)"] });
    return nodes;
  }
  const transition = groupSetupSteps(
    presented.filter((item) => item.step.provenance === "transition"),
  );
  const standing = groupSetupSteps(
    presented.filter((item) => item.step.provenance === "standing"),
  );
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
  const readyStatus = !blocked && !emptyStatus && !fullyCurrentStatus;

  if (emptyStatus) {
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
          commandPart(COMMAND_NAME, [arg("bind"), arg("<profile>"), arg("--host"), arg("<host>")]),
          " to configure one.",
        ],
      },
    ];
  }

  const nodes: PresentationNode[] = [];
  if (fullyCurrentStatus) {
    nodes.push(statusOutcomeNotice(report));
    nodes.push(...warningNodes(report, groups, scope));
    return nodes;
  }
  if (readyStatus) {
    const impact = readyStatusImpactLines(report, scope);
    const [first, ...rest] = impact;
    if (first !== undefined) {
      nodes.push({
        kind: "notice",
        severity: "success",
        nodes: [{ kind: "prose", parts: [first] }],
      });
    }
    for (const line of rest) nodes.push({ kind: "prose", parts: [line] });
    nodes.push(...operationAttentionNodes(report, scope, true));
    const exclusionClause = repositoryExclusionClause(report, false, true);
    if (exclusionClause !== undefined) {
      nodes.push(spacerNode(), { kind: "prose", parts: [exclusionClause] });
    }
    nodes.push(...warningNodes(report, groups, scope));
    nodes.push(...readyStatusGuidanceNodes(report, options));
    return nodes;
  }

  nodes.push(statusOutcomeNotice(report));
  const activeGroups = blocked
    ? groups.filter((group) => group.blockers.length > 0)
    : groups.filter((group) => groupNeedsAttention(group, "status"));
  const reportOperationSummary = useOperationSummary(report, blocked);
  if (reportOperationSummary) {
    nodes.push(...operationSummaryNodes(report, scope));
  } else if (activeGroups.length > 0) {
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
            { kind: "pointer", command: "status" },
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
    }
  }

  const exclusionClause = repositoryExclusionClause(report, false, false);
  if (exclusionClause !== undefined) {
    nodes.push(spacerNode(), { kind: "prose", parts: [exclusionClause] });
  }
  const globalBlockers = globalBlockerNodes(report, groups, {
    kind: "pointer",
    command: "status",
  }, scope);
  if (globalBlockers.length > 0) {
    nodes.push(spacerNode(), ...globalBlockers);
  }
  const blockedSummary = blocked ? aggregateLine("status", report, groups) : undefined;
  if (blockedSummary !== undefined) {
    nodes.push(spacerNode(), {
      kind: "notice",
      severity: "error",
      nodes: [{ kind: "prose", parts: [blockedSummary] }],
    });
  }
  nodes.push(...warningNodes(report, groups, scope));
  nodes.push(spacerNode(), ...nextActionNodes("status", report, {
    groups,
    unscopedItems: grouped.unscopedItems,
  }, options));
  return nodes;
}

function verboseStatusDocument(
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, report);
  return [
    statusOutcomeNotice(report),
    ...verboseLifecycleSections(report, { scope, untrackRecovery: { kind: "pointer", command: "status" } }),
    ...verboseHostSetupNodes("status", report, scope),
  ];
}

function blockersOnlyStatusDocument(
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): PresentationDocument {
  const scope = locationDisplayScope(options, report);
  if (reportBlockers(report).length === 0) {
    return [
      { kind: "prose", parts: ["No blockers."], category: "success" },
      {
        kind: "prose",
        category: "command",
        parts: [
          "Next: Run ",
          options.all === true
            ? commandPart(COMMAND_NAME, [arg("status"), arg("--all")])
            : commandPart(COMMAND_NAME, [arg("status")]),
          " for the complete lifecycle view.",
        ],
      },
    ];
  }
  const nodes: PresentationNode[] = [statusOutcomeNotice(report)];
  if (options.verbose === true) {
    nodes.push(...focusedVerboseBlockerNodes(report, scope));
    return nodes;
  }
  const grouped = groupProjects(report);
  const displayedGroups = displayedBlockerGroups(report);
  nodes.push(...focusedConciseBlockerNodes(report, "status", scope));
  const next = nextActionNodes("status", report, {
    groups: displayedGroups,
    unscopedItems: [],
  }, options);
  if (next.length > 0) nodes.push(spacerNode(), ...next);
  return nodes;
}

export function lifecycleStatusDocument(
  report: ReconciliationReport,
  options: LifecycleHumanOptions = {},
): PresentationDocument {
  if (options.blockersOnly === true) return blockersOnlyStatusDocument(report, options);
  if (options.verbose === true) return verboseStatusDocument(report, options);
  return conciseStatusDocument(report, options);
}

export function formatLifecycleReport(
  command: Exclude<LifecycleCommand, "apply">,
  report: ReconciliationReport,
  options: LifecycleHumanOptions = {},
): string {
  void command;
  return renderLifecycleDocument(
    lifecycleStatusDocument(report, options),
    options.context,
  );
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

const LIFECYCLE_MACHINE_SCHEMA_VERSION = 14 as const;

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
    message: warning.message,
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

export function formatLifecycleJson(
  command: Exclude<LifecycleCommand, "apply">,
  report: ReconciliationReport,
): string {
  return serializeMachinePayload(canonicalLifecycleMachinePayload(command, report));
}

export function formatApplyJson(result: ApplyReconciliationResult): string {
  return serializeMachinePayload(
    canonicalLifecycleMachinePayload("apply", result.resultingState, result.receipt),
  );
}

export function formatBlockedApplyJson(report: BlockedReconciliationReport): string {
  return serializeMachinePayload(canonicalLifecycleMachinePayload("apply", report));
}

export function formatApplyExecutionFailureJson(failure: {
  readonly failedProject: ProjectIdentity | undefined;
  readonly message: string;
  readonly pendingProjects: readonly ProjectIdentity[];
  readonly receipt: ReconciliationReport;
  readonly resultingState: ReconciliationReport | undefined;
}): string {
  return serializeMachinePayload({
    schemaVersion: LIFECYCLE_MACHINE_SCHEMA_VERSION,
    command: "apply",
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
  });
}

export function formatApplyVerificationFailureJson(
  receipt: ReconciliationReport,
  message: string,
): string {
  return serializeMachinePayload({
    schemaVersion: LIFECYCLE_MACHINE_SCHEMA_VERSION,
    command: "apply",
    outcome: "error",
    error: message,
    globalBlockers: [],
    projects: [],
    applied: canonicalMachineSnapshot(receipt),
  });
}

/** Machine envelope for tool failures under `--json` (exit `1`). Parse stdout only when present. */
export function formatLifecycleToolErrorJson(
  command: LifecycleCommand,
  message: string,
): string {
  return serializeMachinePayload({
    schemaVersion: LIFECYCLE_MACHINE_SCHEMA_VERSION,
    command,
    outcome: "error",
    error: message,
    globalBlockers: [],
    projects: [],
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
    if (receipt.warnings.length > 0) {
      nodes.push(
        { kind: "prose", parts: ["Warnings:"], category: "attention" },
        ...receipt.warnings.map((warning, index) => ({
          kind: "list-item" as const,
          parts: receipt.warningParts?.[index] ?? [warning],
        })),
      );
    }
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

export function formatTemporaryInstallationHuman(
  command: TemporaryInstallCommand,
  receipt: TemporaryInstallationReceiptView,
  options: { readonly context?: TerminalPresentationContext } = {},
  cwd = process.cwd(),
  home = homedir(),
): string {
  return renderStandaloneDocument(
    temporaryInstallationDocument(command, receipt, cwd, home),
    options.context,
    { cwd, home },
  );
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
