import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { HostSetupProvenance, HostSetupStep, HostSetupStepKind } from "../adapters/project-plan.js";
import {
  type ApplyReconciliationResult,
  type BlockedReconciliationReport,
  type OutputReconciliationItem,
  type OutputReconciliationKind,
  type ReconciliationBlocker,
  type ReconciliationItem,
  type ReconciliationKind,
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

function reportRepositoryExclusionRepairs(
  report: ReconciliationReport,
): readonly ReconciliationProjectRecord["repositoryExclusionRepairs"][number][] {
  return deduplicateRecords(report.projects.flatMap((project) => project.repositoryExclusionRepairs));
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
  REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX,
  REPOSITORY_EXCLUSION_RETIREMENT_REPAIR_WARNING_SUFFIX,
} from "../installer/git-exclusions.js";
import {
  isContributionRepair,
  publishedContribution,
  safeRepairTargets,
  type SafeRepairExclusionRepair,
} from "../installer/safe-repair.js";
import {
  isStructuredBlocker,
  OUTPUT_OWNERSHIP_CONFLICT,
  type BlockerAffectedItem,
  type BlockerKind,
  type BlockerScope,
  type StructuredReconciliationBlocker,
} from "../installer/blockers.js";
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
  wrapPresentationText,
  type TerminalPresentationContext,
} from "./terminal-presentation.js";
import { COMMANDS } from "./command-help.js";
import { INVENTORY_TOPICS, type InventoryTopic } from "./inventory-topics.js";
import { compareCanonicalStrings } from "../schemas/installation-manifest.js";

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
  "drifted output": 0,
  removal: 1,
  update: 2,
  addition: 3,
  repair: 3,
  unchanged: 4,
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

export function formatMissingProfileError(error: MissingProfileError): string {
  const heading = `${error.message}.`;
  const recovery = error.recoverByEditingLocalConfiguration
    ? " Edit Local Configuration directly if this stale binding must be removed."
    : "";
  if (error.availableProfiles.length === 0) {
    const next = error.recoverByEditingLocalConfiguration
      ? recovery
      : ` Run ${COMMAND_NAME} guide profile to learn how to add a Profile.`;
    return `${heading} No Profiles exist in the Workspace.${next}`;
  }
  return `${heading} Available Profiles: ${error.availableProfiles.join(", ")}.${recovery}`;
}

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
  "repairable missing output",
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
  "repairable missing output":
    `An owned ${DEFAULT_VIEW_LEXICON.generatedOutput.singular} is wholly missing, but ownership is proven; ` +
    "apply will recreate it from current Workspace source.",
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
  readonly drift: number;
  readonly removals: number;
  readonly repairs: number;
  readonly updates: number;
}

interface ProjectGroup {
  readonly canonicalProject: string;
  readonly blockers: ReconciliationBlocker[];
  readonly items: ReconciliationItem[];
  readonly outputs: OutputReconciliationItem[];
  readonly project: string;
}

interface GroupedProjects {
  readonly groups: ProjectGroup[];
  readonly unscopedItems: ReconciliationItem[];
}

const DEFAULT_OUTPUT_PATH_LIMIT = 10;

function containsPath(parent: string, child: string): boolean {
  const childFromParent = relative(parent, child);
  return childFromParent === "" || (
    childFromParent !== ".." &&
    !childFromParent.startsWith("../") &&
    !isAbsolute(childFromParent)
  );
}

function existingPathAlias(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function absoluteAuthoredPath(authoredPath: string, home: string): string {
  return authoredPath === "~"
    ? home
    : authoredPath.startsWith("~/")
      ? join(home, authoredPath.slice(2))
      : authoredPath;
}

export function displayPath(
  canonicalPath: string,
  authoredPath = canonicalPath,
  cwd = process.cwd(),
  home = homedir(),
): string {
  const authoredAbsolute = absoluteAuthoredPath(authoredPath, home);
  const paths = [...new Set([canonicalPath, authoredAbsolute])];
  const displayCwd = existingPathAlias(cwd);
  const displayHome = existingPathAlias(home);
  const cwdRelativePath = paths.find((path) => containsPath(path, cwd));
  if (cwdRelativePath) return relative(cwd, cwdRelativePath) || ".";
  const physicalCwdRelativePath = paths.find((path) => containsPath(path, displayCwd));
  if (physicalCwdRelativePath) return relative(displayCwd, physicalCwdRelativePath) || ".";
  if (authoredPath === "~" || authoredPath.startsWith("~/")) return authoredPath;
  const homeRelativePath = paths.find((path) => containsPath(home, path)) ??
    paths.find((path) => containsPath(displayHome, path));
  if (homeRelativePath) {
    const displayBase = containsPath(home, homeRelativePath) ? home : displayHome;
    const homeRelative = relative(displayBase, homeRelativePath);
    return homeRelative === "" ? "~" : `~/${homeRelative}`;
  }
  return authoredPath;
}

export function displayProjectPath(
  canonicalProject: string,
  authoredProject = canonicalProject,
  cwd = process.cwd(),
  home = homedir(),
): string {
  // Keep this project-specific name as the stable presentation API while all
  // location display policy lives in the shared displayPath implementation.
  return displayPath(canonicalProject, authoredProject, cwd, home);
}

export function formatInfoHuman(
  info: ApplicationInfo,
  options: { readonly context?: TerminalPresentationContext } = {},
  home = homedir(),
  cwd = process.cwd(),
): string {
  const workspace = info.workspace === null
    ? info.configurationState === "legacy"
      ? `Legacy configuration; run ${COMMAND_NAME} init`
      : "Not configured"
    : info.configurationState === "legacy"
      ? `Legacy configuration; run ${COMMAND_NAME} init (selected: ${displayPath(
          info.workspace.canonical,
          info.workspace.authored,
          cwd,
          home,
        )})`
      : displayPath(info.workspace.canonical, info.workspace.authored, cwd, home);
  const localConfiguration = displayPath(
    info.localConfiguration,
    info.localConfiguration,
    cwd,
    home,
  );
  const installationState = displayPath(
    info.installationState,
    info.installationState,
    cwd,
    home,
  );
  return responsiveHumanText(
    `Engine version: ${info.engineVersion}\n` +
      `Workspace: ${workspace}\n` +
      `Local Configuration: ${localConfiguration}\n` +
      `Installation State: ${installationState}\n`,
    options.context,
    [
      `Workspace: ${workspace}`,
      `Local Configuration: ${localConfiguration}`,
      `Installation State: ${installationState}`,
    ],
  );
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

export function formatInventoryIndex(
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  const lines = ["Inventory topics:"];
  for (const topic of INVENTORY_TOPICS) {
    lines.push(
      `  ${COMMAND_NAME} list ${topic.name}`,
      `    ${topic.description}`,
    );
  }
  return responsiveHumanText(`${lines.join("\n")}\n`, options.context);
}

export function formatProjectInventoryHuman(
  projects: readonly ProjectInventoryRecord[],
  options: { readonly context?: TerminalPresentationContext } = {},
  home = homedir(),
  cwd = process.cwd(),
): string {
  if (projects.length === 0) {
    return responsiveHumanText(
      "No Projects are configured.\n" +
        `Use ${COMMAND_NAME} bind <profile> --host <host> to configure a Project.\n`,
      options.context,
    );
  }

  const lines = [`Projects (${projects.length}):`];
  const copyable: string[] = [];
  for (const project of projects) {
    const presented = displayProjectPath(
      project.canonicalProject ?? project.project,
      project.project,
      cwd,
      home,
    );
    lines.push(
      "",
      `Project: ${presented}`,
      `  Profile: ${project.profile}`,
      `  Hosts: ${project.hosts.join(", ")}`,
    );
    if (project.problem !== null) lines.push(`  Problem: ${project.problem}`);
    copyable.push(
      `Project: ${presented}`,
      presented,
      project.canonicalProject ?? project.project,
      project.project,
      project.hosts.join(", "),
    );
  }
  lines.push("", `Use ${COMMAND_NAME} status to inspect Project lifecycle diagnostics.`);
  return responsiveHumanText(`${lines.join("\n")}\n`, options.context, copyable);
}

interface ListInventoryMachineBase<Topic extends InventoryTopic> {
  readonly command: "list";
  readonly engineVersion: string;
  readonly schemaVersion: 1;
  readonly topic: Topic;
}

type ListInventoryMachineOutcome = "error" | "success";

function listInventoryMachinePayload<
  Topic extends InventoryTopic,
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

interface ProjectInventoryMachineSuccessPayload extends ProjectInventoryMachineBase {
  readonly outcome: "success";
  readonly projects: readonly ProjectInventoryRecord[];
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
    listInventoryMachinePayload("projects", "success", { projects }) satisfies
      ProjectInventoryMachinePayload,
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

export function formatProfileInventoryHuman(
  profiles: readonly ProfileInventoryRecord[],
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  if (profiles.length === 0) {
    return responsiveHumanText(
      "No Profiles are available.\n" +
        `Add a Profile to the selected Workspace, then use <profile> with ${COMMAND_NAME} bind.\n`,
      options.context,
    );
  }

  const lines = [`Profiles (${profiles.length}):`];
  for (const profile of profiles) {
    lines.push(
      "",
      `Profile: ${profile.id}`,
      `  Context Modules: ${profile.contextModules}`,
      `  Skills: ${profile.skills}`,
    );
  }
  lines.push(
    "",
    `Use <profile> with ${COMMAND_NAME} bind to select it for a configured Project.`,
  );
  return responsiveHumanText(`${lines.join("\n")}\n`, options.context);
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

export function formatHostInventoryHuman(
  hosts: readonly HostInventoryRecord[],
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  const lines = [
    "Supported Hosts:",
    ...hosts.map(({ host }) => `  ${host}`),
    "",
    `Use <host> with ${COMMAND_NAME} bind to select it for a configured Project.`,
  ];
  return responsiveHumanText(`${lines.join("\n")}\n`, options.context);
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

export function formatTemporaryInventoryHuman(
  installations: readonly TemporaryInventoryRecord[],
  options: { readonly context?: TerminalPresentationContext } = {},
  home = homedir(),
  cwd = process.cwd(),
): string {
  if (installations.length === 0) {
    return responsiveHumanText(
      `No ${DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.plural} are active.\n` +
        `Use ${COMMAND_NAME} install-temp <profile> <project> --host <host> to create one.\n`,
      options.context,
    );
  }

  const lines = [`${capitalize(DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.plural)} (${installations.length}):`];
  const copyable: string[] = [];
  for (const installation of installations) {
    const presented = displayProjectPath(installation.project, installation.project, cwd, home);
    lines.push(
      "",
      `Temporary installation: ${installation.temporaryInstallationId}`,
      `  Project: ${presented}`,
      `  Profile: ${installation.profileId}`,
      `  Host: ${installation.host}`,
    );
    copyable.push(
      `Temporary installation: ${installation.temporaryInstallationId}`,
      `Project: ${presented}`,
      presented,
      installation.project,
    );
  }
  lines.push(
    "",
    `Use ${COMMAND_NAME} remove-temp <temporary-installation-id> to remove one when finished.`,
  );
  return responsiveHumanText(`${lines.join("\n")}\n`, options.context, copyable);
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

export function formatValidationResult(
  result: ValidationResult,
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  const profileCount = result.profiles.length;
  const countClause = `(${plural(profileCount, "Profile")}, ${plural(
    result.bindings,
    DEFAULT_VIEW_LEXICON.projectBinding.singular,
    DEFAULT_VIEW_LEXICON.projectBinding.plural,
  )})`;
  const output = `Workspace and ${DEFAULT_VIEW_LEXICON.localConfiguration} valid ${countClause}\n` +
    `Profiles found: ${profileCount === 0 ? "none" : result.profiles.join(", ")}\n` +
    `Hosts bound: ${result.hosts.length === 0 ? "none" : result.hosts.join(", ")}\n` +
    result.warnings.map((warning) => `Warning: ${warning}\n`).join("") +
    `Next: ${result.bindings === 0
      ? `${COMMAND_NAME} bind <profile> --host <host>`
      : `${COMMAND_NAME} status`}\n`;
  return responsiveHumanText(output, options.context, [
    countClause,
    result.profiles.join(", "),
    result.hosts.join(", "),
  ]);
}

export function formatUninstallResult(
  result: UninstallResult,
  options: { readonly context?: TerminalPresentationContext } = {},
): string {
  const projectCount = result.projects.length;
  const lines = [
    projectCount === 0
      ? "No ordinary Agent Profile Kit-owned output is installed."
      : `Removed proven Agent Profile Kit-owned output from ${plural(projectCount, "Project")}.`,
  ];
  const copyable: string[] = [];
  for (const project of result.projects) {
    const presentedProject = displayProjectPath(project.project);
    lines.push(
      "",
      `Project: ${presentedProject}`,
      "  Removed generated paths:",
      ...project.outputs.map((path) => `  - ${path}`),
    );
    copyable.push(`Project: ${presentedProject}`, presentedProject, project.project);
    if (project.repositoryExclusions.length > 0) {
      lines.push(
        "  Cleaned Git exclusions:",
        ...project.repositoryExclusions.flatMap((exclusion) =>
          exclusion.entries.map((entry) =>
            `  - ${entry} (${replaceProjectReference(
              exclusion.target,
              project.project,
              presentedProject,
            )})`
          )
        ),
      );
    }
  }
  lines.push("", `${capitalize(DEFAULT_VIEW_LEXICON.projectBinding.plural)} preserved.`);
  if (projectCount > 0) {
    lines.push(
      `Next: Run ${COMMAND_NAME} unbind for ${DEFAULT_VIEW_LEXICON.projectBinding.plural} you no longer want, or ${COMMAND_NAME} apply to reinstall.`,
    );
  }
  return responsiveHumanText(`${lines.join("\n")}\n`, options.context, copyable);
}

function summarizeOutputs(outputs: readonly OutputReconciliationItem[]): OutputSummary {
  return outputs.reduce<OutputSummary>(
    (summary, output) => {
      switch (output.kind) {
        case "addition":
          return { ...summary, additions: summary.additions + 1 };
        case "drifted output":
          return { ...summary, drift: summary.drift + 1 };
        case "removal":
          return { ...summary, removals: summary.removals + 1 };
        case "repair":
          return { ...summary, repairs: summary.repairs + 1 };
        case "unchanged":
          return summary;
        case "update":
          return { ...summary, updates: summary.updates + 1 };
        default:
          return assertNever(output.kind);
      }
    },
    { additions: 0, drift: 0, removals: 0, repairs: 0, updates: 0 },
  );
}

/** Concise change units; unchanged generated outputs are omitted by design. */
function changeParts(summary: OutputSummary): string[] {
  const parts: string[] = [];
  const generatedFile = DEFAULT_VIEW_LEXICON.generatedOutput.singular;
  if (summary.additions > 0) parts.push(plural(summary.additions, `${generatedFile} addition`));
  if (summary.updates > 0) parts.push(plural(summary.updates, `${generatedFile} update`));
  if (summary.repairs > 0) parts.push(plural(summary.repairs, `${generatedFile} repair`));
  if (summary.removals > 0) parts.push(plural(summary.removals, `${generatedFile} removal`));
  if (summary.drift > 0) parts.push(plural(summary.drift, `${generatedFile} drift item`));
  return parts;
}

function changeCount(summary: OutputSummary): number {
  return summary.additions + summary.updates + summary.repairs + summary.removals + summary.drift;
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
    case "repair":
      return `+ ${output.path}`;
    case "update":
      return `~ ${output.path}`;
    case "removal":
      return `- ${output.path}`;
    case "drifted output":
      return `! ${output.path} (${output.kind})`;
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

/** The exact entries one exclusion repair publishes at its target. */
function repairEntries(repair: SafeRepairExclusionRepair): readonly string[] {
  return isContributionRepair(repair)
    ? publishedContribution(repair).entries
    : repair.entries;
}

function repositoryExclusionRepairLines(
  report: ReconciliationReport,
  completed = false,
): readonly string[] {
  return reportRepositoryExclusionRepairs(report).map((repair) => {
    const count = repairEntries(repair).length;
    const noun = `Git exclusion ${count === 1 ? "entry" : "entries"}`;
    if (repair.class === "missing-contribution") {
      return `${repair.target}: ${completed ? "recorded" : "will record"} ${count} ${noun}`;
    }
    if (repair.class === "stale-contribution") {
      const staleCount = repair.currentEntries.length;
      const staleNoun = `Git exclusion ${staleCount === 1 ? "entry" : "entries"}`;
      return `${repair.target}: ${completed ? "replaced" : "will replace"} ${staleCount} stale ${staleNoun} with ${count} ${noun}`;
    }
    if (repair.class === "moved-contribution") {
      return `${repair.nextTarget}: ${completed ? "moved" : "will move"} ${count} ${noun} from ${repair.currentTarget}`;
    }
    if (repair.class === "retiring-exclusion-section") {
      return count === 0
        ? `${repair.target}: ${completed ? "removed" : "will remove"} the Agent Profile Kit exclusion section`
        : `${repair.target}: ${completed ? "published" : "will publish"} ${count} surviving ${noun}`;
    }
    return `${repair.target}: ${completed ? "restored" : "will restore"} ${count} recorded ${noun}`;
  });
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
  /** Ready status suppresses successful bookkeeping and keeps only repair attention. */
  repairsOnly = false,
): string | undefined {
  const provenContributionTargets = new Set(
    reportRepositoryExclusionRepairs(report)
      .filter((repair) => repair.class !== "exclusion-section")
      .flatMap(safeRepairTargets),
  );
  const changes = changedRepositoryExclusions(report);
  // Ready status keeps only proven-contribution attention; one delta function
  // owns the count so overlapping recorded entries are never double-counted.
  const delta = (repairsOnly
    ? changes.filter((change) => provenContributionTargets.has(change.target))
    : changes
  )
    .map(exclusionDelta)
    .reduce(
      (total, change) => ({
        additions: total.additions + change.additions.length,
        removals: total.removals + change.removals.length,
      }),
      { additions: 0, removals: 0 },
    );
  const repairs = reportRepositoryExclusionRepairs(report)
    .filter((repair) => repair.class === "exclusion-section")
    .reduce((count, repair) => count + repair.entries.length, 0);
  const parts: string[] = [];
  if (delta.additions > 0) {
    parts.push(`${plural(delta.additions, "entry", "entries")} ${completed ? "added" : "to add"}`);
  }
  if (delta.removals > 0) {
    parts.push(`${plural(delta.removals, "entry", "entries")} ${completed ? "removed" : "to remove"}`);
  }
  if (repairs > 0) {
    parts.push(`${plural(repairs, "recorded entry", "recorded entries")} ${completed ? "restored" : "to restore"}`);
  }
  return parts.length === 0
    ? undefined
    : `${capitalize(DEFAULT_VIEW_LEXICON.repositoryExclusion.plural)}: ${parts.join(", ")}.`;
}

function itemText(item: ReconciliationItem): string {
  return `${item.kind}${item.reason ? ` (${item.reason})` : ""}`;
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

function blockerProject(blocker: ReconciliationBlocker): string | undefined {
  return blocker.project || undefined;
}

function shortenProjectReferences(message: string, groups: readonly ProjectGroup[]): string {
  const references = groups.flatMap((group) => {
    const authoredAbsolute = absoluteAuthoredPath(group.project, homedir());
    const replacement = displayProjectPath(group.canonicalProject, group.project);
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

function untrackRecoveryLines(
  project: string,
  paths: readonly string[],
  indent: string,
  recovery: UntrackRecovery,
): readonly string[] {
  if (paths.length === 0) return [];
  if (recovery.kind === "pointer") {
    return [
      `${indent}  Recovery command: run apkit ${recovery.command} --blockers-only --verbose to see the exact untracking command.`,
    ];
  }
  return [
    `${indent}  Recovery: run the command below yourself; Agent Profile Kit never executes it. ` +
      "It stages removal of these paths from Git ownership (the Git index) while the working files are preserved:",
    `${indent}    ${trackedPathUntrackCommand(project, paths)}`,
    `${indent}  Alternatively, change or remove the Project Binding.`,
  ];
}

function conciseOwnershipConflictLines(
  blocker: StructuredReconciliationBlocker & {
    readonly kind: typeof OUTPUT_OWNERSHIP_CONFLICT;
    readonly scope: "project";
  },
  groups: readonly ProjectGroup[],
  indent: string,
  untrackRecovery: UntrackRecovery,
): readonly string[] {
  const paths = outputOwnershipConflictPaths(blocker);
  const displayProject = displayProjectPath(blocker.project);
  const lines = [
    `${indent}Blocker: ${shortenProjectReferences(blocker.problem, groups)}`,
    `${indent}  Requirement: ${blocker.requirement}`,
    `${indent}  Remedy: ${blocker.remedy}`,
    `${indent}  Scope: ${blockerScopeText(blocker, displayProject)}`,
  ];
  if (paths.length > 0) {
    lines.push(`${indent}  Affected paths (${paths.length}):`);
    lines.push(...trackedPathGroupLines(paths, indent));
  }
  lines.push(...untrackRecoveryLines(blocker.project, paths, indent, untrackRecovery));
  return lines;
}

function conciseBlockerLines(
  blocker: ReconciliationBlocker,
  displayProject: string | undefined,
  groups: readonly ProjectGroup[],
  indent: string,
  untrackRecovery: UntrackRecovery,
): readonly string[] {
  if (isOutputOwnershipConflict(blocker)) {
    return conciseOwnershipConflictLines(blocker, groups, indent, untrackRecovery);
  }
  const lines = [
    `${indent}Blocker: ${shortenProjectReferences(blocker.problem, groups)}`,
    `${indent}  Requirement: ${blocker.requirement}`,
    `${indent}  Remedy: ${blocker.remedy}`,
    `${indent}  Scope: ${blockerScopeText(blocker, displayProject)}`,
  ];
  for (const item of blocker.affectedItems) {
    lines.push(`${indent}  ${affectedItemLabel(item)}`);
  }
  return lines;
}

function verboseBlockerLines(
  blocker: ReconciliationBlocker,
  shorten: (text: string) => string,
  untrackRecovery: UntrackRecovery,
): readonly string[] {
  const project = blocker.scope === "project" ? displayProjectPath(blocker.project) : undefined;
  const lines = [
    `- ${shorten(blocker.problem)}`,
    `  Requirement: ${blocker.requirement}`,
    `  Remedy: ${blocker.remedy}`,
    `  Scope: ${blockerScopeText(blocker, project)}`,
  ];
  for (const item of blocker.affectedItems) {
    const value = blocker.scope === "project" && item.kind === "path"
      ? shorten(`${blocker.project}/${item.value}`)
      : item.value;
    lines.push(`  ${affectedItemLabel({ ...item, value })}`);
  }
  if (isOutputOwnershipConflict(blocker)) {
    lines.push(...untrackRecoveryLines(
      blocker.project,
      outputOwnershipConflictPaths(blocker),
      "",
      untrackRecovery,
    ));
  }
  return lines;
}

/** One group's concise blocker evidence, one entry per Blocker. */
function conciseGroupBlockerLines(
  group: ProjectGroup,
  groups: readonly ProjectGroup[],
  indent: string,
  untrackRecovery: UntrackRecovery,
): readonly string[] {
  const displayProject = displayProjectPath(group.canonicalProject, group.project);
  return group.blockers.flatMap((blocker) =>
    conciseBlockerLines(blocker, displayProject, groups, indent, untrackRecovery),
  );
}

/** The concise global-blocker section; empty when no global Blocker exists. */
function conciseGlobalBlockerLines(
  report: ReconciliationReport,
  groups: readonly ProjectGroup[],
  untrackRecovery: UntrackRecovery,
): readonly string[] {
  const globalBlockers = reportBlockers(report).filter((blocker) => blockerProject(blocker) === undefined);
  if (globalBlockers.length === 0) return [];
  return [
    "Global blockers:",
    ...globalBlockers.flatMap((blocker) =>
      conciseBlockerLines(blocker, undefined, groups, "  ", untrackRecovery)
    ),
  ];
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
    changedRepositoryExclusions(report).length > 0 ||
    reportRepositoryExclusionRepairs(report).length > 0
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
function stillPendingProjects(report: ReconciliationReport): readonly string[] {
  return report.projects
    .filter((project) =>
      project.blockers.length === 0 &&
      (
        project.state.kind !== "current" ||
        project.outputs.some((output) => output.kind !== "unchanged") ||
        project.repositoryExclusions.some((change) =>
          change.current.join("\n") !== change.next.join("\n")
        ) ||
        project.repositoryExclusionRepairs.length > 0
      )
    )
    .map((project) => displayProjectPath(project.canonicalProject, project.project));
}

/**
 * The committed Apply Receipt plus the Projects it made current — safety
 * evidence every human apply view must show (ADR-0024). `postState` is the
 * post-commit snapshot; `summarizeFleet` collapses per-Project receipts above
 * one Project.
 */
function committedApplyEvidence(
  receipt: ReconciliationReport,
  postState: ReconciliationReport,
  summarizeFleet: boolean,
): readonly string[] {
  const lines = [
    ...applyReceiptLines(receipt, summarizeFleet, postState),
  ];
  const appliedProjects = new Set(
    receipt.projects.map((project) => project.canonicalProject),
  );
  const freshlyCurrent = postState.projects
    .filter((project) =>
      project.state.kind === "current" && appliedProjects.has(project.canonicalProject)
    )
    .map((project) => displayProjectPath(project.canonicalProject, project.project));
  if (freshlyCurrent.length > 0) {
    lines.push(`Freshly current: ${freshlyCurrent.join(", ")}`);
  }
  return lines;
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
    projects: { canonicalProject: string; project: string }[];
  }>();

  for (const projectRecord of report.projects) {
    for (const warning of projectRecord.warnings) {
      if (warning.message.endsWith(REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX)) {
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
  "repair",
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
interface PresentedSetupStep {
  readonly canonicalProject: string;
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
        displayProjectPath(project.canonicalProject, project.project),
      );
      steps.push({
        canonicalProject: project.canonicalProject,
        message,
        step,
      });
    }
  }
  return steps;
}

/** One deduplicated setup step group with its deterministic Project scope. */
interface SetupStepGroup {
  readonly message: string;
  projects: string[];
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
  for (const { message, step, canonicalProject } of steps) {
    const key = setupStepGroupKey(step, message);
    const existing = byKey.get(key);
    if (existing) {
      existing.projects.push(canonicalProject);
    } else {
      byKey.set(key, { message, projects: [canonicalProject], step });
    }
  }
  return [...byKey.values()]
    .map((group) => ({
      ...group,
      projects: [...new Set(group.projects)].sort(compareCanonicalStrings),
    }))
    .sort((left, right) =>
      left.step.host.localeCompare(right.step.host) ||
      HOST_SETUP_STEP_ORDER.indexOf(left.step.kind) -
        HOST_SETUP_STEP_ORDER.indexOf(right.step.kind) ||
      left.message.localeCompare(right.message),
    );
}

/** Compact affected-Project scope for a deduplicated setup step. */
function setupProjectScope(projects: readonly string[], verbose: boolean): string {
  if (projects.length === 1) return "";
  if (verbose || projects.length <= PROJECT_SCOPE_LIMIT) {
    return ` (${projects.map((project) => displayProjectPath(project)).join(", ")})`;
  }
  const visible = projects
    .slice(0, PROJECT_SCOPE_LIMIT)
    .map((project) => displayProjectPath(project));
  return ` (${visible.join(", ")}, … ${plural(projects.length - PROJECT_SCOPE_LIMIT, "more Project")}; use --verbose to see all Projects)`;
}

function setupStepLines(group: SetupStepGroup, verbose: boolean): readonly string[] {
  const lines = [`- ${group.message}${setupProjectScope(group.projects, verbose)}`];
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

function conciseFirstUseLines(
  presented: readonly PresentedSetupStep[],
  changeEvidence: ReconciliationReport | undefined,
): readonly string[] {
  if (presented.length === 0) return [];
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
  const groups = [...byKey.values()]
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

  const lines = ["First use:"];
  for (const group of groups) {
    let isSubset = false;
    if (group.kind === "launch-constraint" && changeEvidence !== undefined) {
      const hostAdditionProjects = changeEvidence.projects.filter((changeProject) =>
        isFirstRelevantHostOutput(changeProject, changeProject, group.host)
      ).length;
      isSubset = group.projects.length < hostAdditionProjects;
    }
    lines.push(`- ${conciseFirstUseAction(group.step, group.projects, isSubset)}`);
  }
  return lines;
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
    for (const group of transition) lines.push(...setupStepLines(group, verbose));
  }
  if (standing.length > 0) {
    lines.push("Standing Host setup:");
    for (const group of standing) lines.push(...setupStepLines(group, verbose));
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
): readonly string[] {
  return setupSectionsFromPresented(
    presentedSetupSteps(command, report, changeEvidence, verbose),
    verbose,
    changeEvidence ?? report,
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
): string {
  if (projects.length <= 1) return "";
  const presented = projects.map((project) =>
    displayProjectPath(project.canonical, project.authored),
  );
  if (presented.length <= PROJECT_SCOPE_LIMIT) {
    return ` (${presented.join(", ")})`;
  }
  return ` (${presented.slice(0, PROJECT_SCOPE_LIMIT).join(", ")}, … ${plural(presented.length - PROJECT_SCOPE_LIMIT, "more Project")}; use --verbose to see all Projects)`;
}

function nextActionLines(
  command: LifecycleCommand,
  report: ReconciliationReport,
  surface: {
    readonly groups: readonly ProjectGroup[];
    readonly unscopedItems: readonly ReconciliationItem[];
  },
  options: LifecycleHumanOptions,
): readonly string[] {
  if (command === "apply" && reportBlockers(report).length === 0) return [];
  const applyCommand = options.all === true
    ? "apply --all"
    : options.project !== undefined
    ? `apply ${options.project}`
    : report.projects.length > 1
    ? "apply --all"
    : "apply";

  const globalBlockers = reportBlockers(report).filter((blocker) => blockerProject(blocker) === undefined);
  const grouped = new Map<string, Array<{ readonly authored: string; readonly canonical: string }>>();
  const addAction = (
    action: string,
    project?: { readonly authored: string; readonly canonical: string },
  ): void => {
    const existing = grouped.get(action) ?? [];
    if (project !== undefined) existing.push(project);
    grouped.set(action, existing);
  };
  for (const group of surface.groups) {
    const project = { authored: group.project, canonical: group.canonicalProject };
    if (group.blockers.length > 0) {
      const blockerWord = group.blockers.length === 1 ? "blocker" : "blockers";
      addAction(
        `Resolve the reported ${blockerWord}, then run ${COMMAND_NAME} ${command} again.`,
        project,
      );
      continue;
    }
    if (!groupNeedsAttention(group, command)) continue;
    if (reportBlockers(report).length > 0 && globalBlockers.length === 0) {
      if (command === "status") {
        addAction(
          `After all blockers are resolved, run ${COMMAND_NAME} ${applyCommand}.`,
          project,
        );
      } else {
        addAction(
          `After all blockers are resolved, run ${COMMAND_NAME} ${applyCommand}` +
            `${command === "apply" ? " again" : ""}.`,
          project,
        );
      }
      continue;
    }
    if (globalBlockers.length > 0) continue;
    if (command === "status") {
      addAction(`Run ${COMMAND_NAME} ${applyCommand}.`, project);
    } else {
      addAction(`Run ${COMMAND_NAME} ${applyCommand}.`, project);
    }
  }

  if (globalBlockers.length > 0) {
    const blockerWord = globalBlockers.length === 1 ? "blocker" : "blockers";
    addAction(`Resolve the reported global ${blockerWord}, then run ${COMMAND_NAME} ${command} again.`);
  }
  if (
    reportBlockers(report).length === 0 &&
    (
      surface.unscopedItems.some((item) => item.kind !== "current") ||
      (grouped.size === 0 && reportHasReconciliationWork(report))
    )
  ) {
    addAction(`Run ${COMMAND_NAME} ${applyCommand}.`);
  }
  const actions = [...grouped.entries()].map(([action, projects]) => {
    const uniqueProjects = [...new Map(
      projects.map((project) => [project.canonical, project]),
    ).values()].sort((left, right) =>
      compareCanonicalStrings(left.canonical, right.canonical),
    );
    if (uniqueProjects.length === 1) {
      const project = uniqueProjects[0]!;
      return `${displayProjectPath(project.canonical, project.authored)}: ${action}`;
    }
    // A single remaining next action is already fleet-scoped; listing every
    // Project would replay the matrix this ticket collapses.
    if (grouped.size === 1) return action;
    return `${action}${nextActionScope(uniqueProjects)}`;
  });
  return actions.length === 0 ? [] : ["Next:", ...actions.map((action) => `- ${action}`)];
}

/** Observable output operations included in concise fleet summaries. */
type PlannedOutputOperation = Extract<
  OutputReconciliationKind,
  "addition" | "removal" | "repair" | "update"
>;

const PLANNED_OUTPUT_OPERATION_ORDER: readonly PlannedOutputOperation[] = [
  "addition",
  "update",
  "repair",
  "removal",
];

const PLANNED_OUTPUT_OPERATION_MARKER: Readonly<Record<PlannedOutputOperation, string>> = {
  addition: "+",
  update: "~",
  repair: "~",
  removal: "-",
};

/** Output attention kinds that remain visible beside the operation summary. */
const OUTPUT_ATTENTION_KINDS: ReadonlySet<OutputReconciliationKind> = new Set([
  "drifted output",
]);

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
  readonly projects: readonly string[];
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
      projects: projects.map((project) => project.canonicalProject).sort(compareCanonicalStrings),
      fileCount,
    }];
  });
}

function operationScopeClause(
  group: OperationPresentationGroup,
  report: ReconciliationReport,
): string {
  const allProjects = reportProjects(report);
  if (
    group.projects.length === allProjects.length &&
    group.projects.every((project) => allProjects.includes(project))
  ) {
    return `in ${plural(group.projects.length, "project")}`;
  }
  if (group.projects.length <= PROJECT_SCOPE_LIMIT) {
    return `in ${group.projects.map((project) => displayProjectPath(project)).join(", ")}`;
  }
  const visible = group.projects
    .slice(0, PROJECT_SCOPE_LIMIT)
    .map((project) => displayProjectPath(project));
  return `in ${visible.join(", ")}, … ${plural(group.projects.length - PROJECT_SCOPE_LIMIT, "more Project")}; ` +
    "use --verbose to see all Projects";
}

function operationGroupLine(
  group: OperationPresentationGroup,
  report: ReconciliationReport,
): string {
  const operation = group.fileCount === 1 ? group.operation : `${group.operation}s`;
  return `${PLANNED_OUTPUT_OPERATION_MARKER[group.operation]} ${group.fileCount} generated file ${operation} ` +
    operationScopeClause(group, report);
}

function operationAttentionLines(
  report: ReconciliationReport,
  includeRemovals = false,
): readonly string[] {
  const exceptions = report.projects.filter((project) => {
    const hasPlannedOutput = project.outputs.some((output) => isPlannedOutputOperation(output.kind));
    return project.outputs.some((output) =>
      OUTPUT_ATTENTION_KINDS.has(output.kind) || (includeRemovals && output.kind === "removal")
    ) ||
      EXCEPTION_ITEM_KINDS.has(project.state.kind) ||
      (project.state.kind === STALE_SOURCE_KIND && !hasPlannedOutput);
  });
  if (exceptions.length === 0) return [];
  const lines = ["", "Project exceptions:"];
  for (const project of exceptions) {
    lines.push(`  ${displayProjectPath(project.canonicalProject, project.project)}:`);
    const hasPlannedOutput = project.outputs.some((output) => isPlannedOutputOperation(output.kind));
    if (
      EXCEPTION_ITEM_KINDS.has(project.state.kind) ||
      (project.state.kind === STALE_SOURCE_KIND && !hasPlannedOutput)
    ) {
      lines.push(`    State: ${itemText({ ...project.state, project: project.project })}`);
    }
    const attentionOutputs = project.outputs.filter((output) =>
      OUTPUT_ATTENTION_KINDS.has(output.kind) || (includeRemovals && output.kind === "removal")
    );
    lines.push(...outputPathLines(attentionOutputs).map((line) => `    ${line}`));
  }
  return lines;
}

function operationSummarySections(report: ReconciliationReport): readonly string[] {
  const groups = groupOutputOperations(report);
  return [
    "",
    "Project changes:",
    ...groups.map((group) => `  ${operationGroupLine(group, report)}`),
    ...operationAttentionLines(report),
  ];
}

function sameProjectScope(groups: readonly OperationPresentationGroup[]): boolean {
  if (groups.length < 2) return true;
  const first = groups[0]!.projects;
  return groups.slice(1).every((group) =>
    group.projects.length === first.length &&
    group.projects.every((project, index) => project === first[index])
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
): string {
  const operation = group.fileCount === 1 ? group.operation : `${group.operation}s`;
  return `${PLANNED_OUTPUT_OPERATION_MARKER[group.operation]} ${group.fileCount} file ${operation} ` +
    operationScopeClause(group, report);
}

function statusAffectedProjects(report: ReconciliationReport): readonly string[] {
  return report.projects
    .filter((project) =>
      project.state.kind !== "current" ||
      project.outputs.some((output) => isPlannedOutputOperation(output.kind)) ||
      project.repositoryExclusions.some((change) =>
        change.current.length !== change.next.length ||
        change.current.some((entry, index) => entry !== change.next[index])
      ) ||
      project.repositoryExclusionRepairs.length > 0
    )
    .map((project) => project.canonicalProject)
    .sort(compareCanonicalStrings);
}

function readyStatusImpactLines(report: ReconciliationReport): readonly string[] {
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
    ...operationGroups.map((group) => conciseStatusOperationLine(group, report)),
  ];
}

function lifecycleInvocation(
  command: LifecycleCommand,
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): string {
  if (options.all === true || (options.project === undefined && report.projects.length > 1)) {
    return `${COMMAND_NAME} ${command} --all`;
  }
  if (options.project !== undefined) return `${COMMAND_NAME} ${command} ${options.project}`;
  return `${COMMAND_NAME} ${command}`;
}

function readyStatusGuidance(
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): readonly string[] {
  return [
    `Next: ${lifecycleInvocation("apply", report, options)}`,
    "",
    `Details: ${lifecycleInvocation("status", report, options)} --verbose`,
  ];
}

function operationReceiptLines(
  receipt: ReconciliationReport,
  fleetScope: ReconciliationReport = receipt,
  includeExclusions = true,
): readonly string[] {
  const groups = groupOutputOperations(receipt);
  const exclusionClause = includeExclusions ? repositoryExclusionClause(receipt, true) : undefined;
  if (groups.length === 0 && exclusionClause === undefined) return [];
  const lines = [
    "Applied:",
    ...groups.map((group) => `  ${operationGroupLine(group, fleetScope)}`),
  ];
  if (exclusionClause !== undefined) lines.push("", exclusionClause);
  return lines;
}

function applyReceiptLines(
  receipt: ReconciliationReport,
  summarizeFleet = false,
  fleetScope: ReconciliationReport = receipt,
): readonly string[] {
  if (summarizeFleet || useOperationSummary(receipt, false)) {
    return operationReceiptLines(receipt, fleetScope);
  }
  const grouped = groupProjects(receipt);
  const entries = grouped.groups.flatMap((group) => {
    const paths = outputPathLines(group.outputs);
    if (paths.length > 0) {
      return [
        `- ${displayProjectPath(group.canonicalProject, group.project)}:`,
        ...paths.map((line) => `  ${line}`),
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
      ? [`- ${displayProjectPath(group.canonicalProject, group.project)}: ${workKinds.join(", ")}`]
      : [];
  });
  const exclusionClause = repositoryExclusionClause(receipt, true);
  if (entries.length === 0 && exclusionClause === undefined) {
    return ["Applied: none."];
  }

  const lines = [
    "Applied:",
    ...(entries.length > 0 ? entries : [`- No ${DEFAULT_VIEW_LEXICON.generatedOutput.singular} changes`]),
  ];
  if (exclusionClause !== undefined) lines.push("", exclusionClause);
  return lines;
}

function conciseReport(
  command: LifecycleCommand,
  report: ReconciliationReport,
  receipt?: ReconciliationReport,
  options: LifecycleHumanOptions = {},
): string {
  const grouped = groupProjects(report);
  const groups = grouped.groups;
  const blocked = reportBlockers(report).length > 0;
  const emptyStatus =
    command === "status" &&
    reportBlockers(report).length === 0 &&
    reportDesired(report).length === 0 &&
    reportItems(report).length === 0;
  const fullyCurrentStatus = command === "status" && fullyCurrentProjectCount(report) !== undefined;
  const readyStatus = command === "status" && !blocked && !emptyStatus && !fullyCurrentStatus;
  const noOpApply = isNoOpApply(command, report, receipt);

  if (emptyStatus) {
    return [
      "No Projects are configured.",
      `Next: Run ${COMMAND_NAME} list projects to inspect ${DEFAULT_VIEW_LEXICON.projectBinding.plural}, or ` +
        `${COMMAND_NAME} bind <profile> --host <host> to configure one.`,
      "",
    ].join("\n");
  }

  const lines = noOpApply
    ? [
        outcomeLine(command, report, true),
        `All ${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)} were already current.`,
      ]
    : readyStatus
    ? [...readyStatusImpactLines(report)]
    : [outcomeLine(command, report, receipt !== undefined)];

  const summary = !blocked && !fullyCurrentStatus && !readyStatus && !noOpApply && command !== "apply"
    ? aggregateLine(command, report, groups)
    : undefined;
  if (summary !== undefined) lines.push(summary);

  if (command === "apply" && !blocked && !noOpApply && receipt !== undefined) {
    const appliedLines = operationReceiptLines(receipt, report, false);
    if (appliedLines.length > 0) {
      lines.push("", ...appliedLines);
    }
  }

  const activeGroups = blocked
    ? groups.filter((group) => group.blockers.length > 0)
    : groups.filter((group) => groupNeedsAttention(group, command));
  const reportOperationSummary = command !== "apply" && useOperationSummary(report, blocked);

  if (!noOpApply) {
    if (readyStatus) {
      lines.push(...operationAttentionLines(report, true));
    } else if (reportOperationSummary) {
      lines.push(...operationSummarySections(report));
    } else if (activeGroups.length > 0) {
      for (const group of activeGroups) {
        lines.push(
          "",
          `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)}: ${displayProjectPath(group.canonicalProject, group.project)}`,
        );
        const desired = desiredInstallation(report, group.canonicalProject);
        if (desired) {
          lines.push(`  Profile: ${desired.profile}`, `  Hosts: ${desired.hosts.join(", ")}`);
        }
        if (blocked) {
          lines.push(...conciseGroupBlockerLines(group, groups, "  ", {
            kind: "pointer",
            command,
          }));
          continue;
        }
        for (const item of group.items) {
          if (item.kind !== "current") {
            lines.push(`  State: ${itemText(item)}`);
          }
        }
        const outputLines = outputPathLines(group.outputs);
        if (outputLines.length > 0) lines.push("  Files:", ...outputLines.map((line) => `  ${line}`));
        for (const blocker of group.blockers) {
          lines.push(...conciseBlockerLines(
            blocker,
            displayProjectPath(group.canonicalProject, group.project),
            groups,
            "  ",
            { kind: "pointer", command },
          ));
        }
      }
    } else if (
      command === "status" &&
      groups.length > 0 &&
      reportBlockers(report).length === 0 &&
      !fullyCurrentStatus &&
      !reportHasReconciliationWork(report)
    ) {
      const projects = capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural);
      lines.push(`No ${projects} need attention.`);
    }
  }

  if (command === "apply" && blocked) {
    const stillPending = stillPendingProjects(report);
    if (stillPending.length > 0) {
      lines.push("", `Still pending: ${stillPending.join(", ")}`);
    }
  }

  const exclusionClause = repositoryExclusionClause(report, false, readyStatus);
  if (exclusionClause !== undefined) lines.push("", exclusionClause);

  const globalBlockerLines = conciseGlobalBlockerLines(report, groups, {
    kind: "pointer",
    command,
  });
  if (globalBlockerLines.length > 0) lines.push("", ...globalBlockerLines);
  const blockedSummary = blocked ? aggregateLine(command, report, groups) : undefined;
  if (blockedSummary !== undefined) lines.push("", blockedSummary);
  if (!blocked && grouped.unscopedItems.length > 0) {
    lines.push("", "Diagnostics:");
    for (const item of grouped.unscopedItems) lines.push(`- ${item.project}: ${itemText(item)}`);
  }
  const warningGroups = groupWarnings(report);
  if (warningGroups.length > 0) {
    lines.push("", "Warnings:");
    for (const group of warningGroups) {
      const formatted = shortenProjectReferences(group.message, groups);
      lines.push(`- ${formatted} (${plural(group.projects.length, "Project")})`);
    }
  }
  const presented = presentedSetupSteps(
    command,
    report,
    command === "apply" ? receipt : undefined,
    false,
  );
  const setup = setupSectionsFromPresented(
    presented,
    false,
    command === "apply" ? receipt : undefined,
  );
  if (setup.length > 0) lines.push("", ...setup);
  const next = readyStatus
    ? readyStatusGuidance(report, options)
    : nextActionLines(command, report, {
        groups,
        unscopedItems: grouped.unscopedItems,
      }, options);
  if (next.length > 0) lines.push(...(readyStatus ? next : ["", ...next]));
  if (command === "apply" && blocked && receipt) {
    lines.push("", ...committedApplyEvidence(receipt, report, report.projects.length > 1));
  }
  if (command === "apply" && reportBlockers(report).length === 0 && !noOpApply) {
    const readiness = receipt ? readinessLines(report, receipt) : [];
    if (readiness.length > 0) lines.push("", ...readiness);
  }
  return `${lines.join("\n")}\n`;
}

const COMMAND_NAMES = new Set(COMMANDS.map((command) => command.name));
const INVENTORY_TOPIC_NAMES = new Set<string>(INVENTORY_TOPICS.map((topic) => topic.name));

interface CopyableValueProtector {
  readonly pattern: RegExp | undefined;
}

function unusedPresentationMarker(
  source: string,
  kind: string,
  lead: "\u0000" | "\u0001" = "\u0000",
): string {
  let marker = `${lead}apkit-${kind}`;
  while (source.includes(marker)) marker += "\u0000";
  return marker;
}

function escapedRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Keep command invocations together while prose wraps. */
function protectCommandInvocations(text: string, marker: string): string {
  const pattern = new RegExp(
    `\\b${escapedRegExp(COMMAND_NAME)}\\s+([A-Za-z][\\w-]*)\\b`,
    "g",
  );
  let cursor = 0;
  let protectedText = "";
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start < cursor || !COMMAND_NAMES.has(match[1]!)) continue;
    let end = start + match[0].length;
    while (true) {
      const argument = text.slice(end).match(/^\s+(\S+)/);
      if (argument !== null) {
        const token = argument[1]!;
        const syntaxToken = token.replace(/[.,;:!?)]*$/, "");
        if (
          /^<[^>]+>$/.test(syntaxToken) ||
          /^--[\w-]+$/.test(syntaxToken) ||
          INVENTORY_TOPIC_NAMES.has(syntaxToken)
        ) {
          end += argument[0].length;
          continue;
        }
      }
      const chained = text.slice(end).match(
        new RegExp(`^\\s+&&\\s+${escapedRegExp(COMMAND_NAME)}\\s+([A-Za-z][\\w-]*)\\b`),
      );
      if (chained !== null && COMMAND_NAMES.has(chained[1]!)) {
        end += chained[0].length;
        continue;
      }
      break;
    }
    protectedText += text.slice(cursor, start);
    protectedText += text.slice(start, end).replaceAll(" ", marker);
    cursor = end;
  }
  return protectedText + text.slice(cursor);
}

function restoreMarker(text: string, marker: string): string {
  return text.replaceAll(marker, " ");
}

/** Compile one report-wide matcher for values whose spaces must survive wrapping. */
function createCopyableValueProtector(
  values: readonly string[],
): CopyableValueProtector {
  const uniqueValues = [...new Set(values.filter((value) => value.includes(" ")))]
    .sort((left, right) => right.length - left.length);
  return {
    pattern: uniqueValues.length === 0
      ? undefined
      : new RegExp(uniqueValues.map(escapedRegExp).join("|"), "g"),
  };
}

/** Keep structurally supplied values containing spaces as one copyable token. */
function protectCopyableValues(
  text: string,
  protector: CopyableValueProtector,
  marker: string,
): string {
  if (protector.pattern === undefined) return text;
  return text.replace(
    protector.pattern,
    (value) => value.replaceAll(" ", marker),
  );
}

function wrapLifecycleText(
  text: string,
  width: number,
  commandMarker: string,
): readonly string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return text.length === 0 ? [] : [text];

  const lines: string[] = [];
  let prose = "";
  const flushProse = (): void => {
    if (prose.length === 0) return;
    lines.push(...wrapPresentationText(prose, width));
    prose = "";
  };
  for (const word of words) {
    if (word.includes(commandMarker)) {
      flushProse();
      lines.push(word);
    } else {
      prose = prose.length === 0 ? word : `${prose} ${word}`;
    }
  }
  flushProse();
  return lines;
}

function wrappedLifecycleLine(
  line: string,
  width: number,
  copyableValueProtector: CopyableValueProtector,
): readonly string[] {
  if (line.trim().length === 0) return [line];
  const indentation = line.match(/^\s*/)?.[0] ?? "";
  const content = line.slice(indentation.length);
  const bullet = content.startsWith("- ") ? "- " : "";
  const prose = bullet.length > 0 ? content.slice(bullet.length) : content;
  const commandMarker = unusedPresentationMarker(prose, "command");
  const copyableMarker = unusedPresentationMarker(
    `${prose}${commandMarker}`,
    "value",
    "\u0001",
  );
  const protectedProse = protectCommandInvocations(
    protectCopyableValues(prose, copyableValueProtector, copyableMarker),
    commandMarker,
  );
  // When the line already fits the selected measure, keep it intact: command
  // invocations and copyable values move to dedicated lines only when wrapping
  // is actually required (DEC-003).
  if (prose.length <= Math.max(1, width - indentation.length - 2)) {
    return [line];
  }
  const wrapped = wrapLifecycleText(
    protectedProse,
    Math.max(1, width - indentation.length - 2),
    commandMarker,
  ).map((part) =>
    restoreMarker(restoreMarker(part, commandMarker), copyableMarker)
  );
  return wrapped.map((part, index) =>
    `${index === 0 ? indentation + bullet : `${indentation}  `}${part}`
  );
}

function lifecycleCopyableValues(
  reports: readonly ReconciliationReport[],
): readonly string[] {
  const values = new Set<string>();
  for (const report of reports) {
    for (const installation of reportDesired(report)) {
      values.add(installation.canonicalProject);
      values.add(installation.project);
      values.add(displayProjectPath(installation.canonicalProject, installation.project));
      for (const output of installation.outputs) values.add(output);
      for (const artifact of installation.resolvedArtifacts) values.add(artifact.id);
    }
    for (const item of reportItems(report)) values.add(item.project);
    for (const output of reportOutputs(report)) {
      values.add(output.project);
      values.add(output.path);
    }
    for (const project of report.projects) {
      for (const output of project.outputs) {
        values.add(project.project);
        values.add(output.path);
      }
    }
    for (const blocker of reportBlockers(report)) {
      if (blocker.project !== undefined) values.add(blocker.project);
      for (const item of blocker.affectedItems ?? []) values.add(item.value);
      // The exact untracking command is copyable evidence: terminal wrapping
      // must never split it (#353).
      if (isOutputOwnershipConflict(blocker)) {
        const paths = outputOwnershipConflictPaths(blocker);
        if (paths.length > 0) values.add(trackedPathUntrackCommand(blocker.project, paths));
      }
    }
    for (const exclusion of reportRepositoryExclusions(report)) {
      values.add(exclusion.target);
      for (const entry of [...exclusion.current, ...exclusion.next]) values.add(entry);
    }
    for (const repair of reportRepositoryExclusionRepairs(report)) {
      for (const target of safeRepairTargets(repair)) values.add(target);
      for (const entry of repairEntries(repair)) values.add(entry);
    }
    for (const value of reportWarningValues(report)) values.add(value);
  }
  return [...values].filter((value) => value.length > 0);
}

/**
 * Apply the shared terminal width policy to lifecycle prose after semantic
 * report construction. Context payloads remain byte-for-byte intact because
 * they are user-authored material rather than presentation prose.
 */
function responsiveLifecycleOutput(
  text: string,
  context: TerminalPresentationContext | undefined,
  copyableValues: readonly string[] = [],
): string {
  if (context === undefined) return text;
  const copyableValueProtector = createCopyableValueProtector(copyableValues);
  let contextFence: string | undefined;
  const lines = text.split("\n").flatMap((line) => {
    if (contextFence !== undefined) {
      if (line === `${contextFence} end Context ${contextFence}`) contextFence = undefined;
      return [line];
    }

    const begin = /^(-+) begin Context \1$/.exec(line);
    if (begin !== null) {
      contextFence = begin[1];
      return [line];
    }

    return wrappedLifecycleLine(line, context.width, copyableValueProtector);
  });
  return lines.join("\n");
}

/**
 * Shared responsive wrapping for human surfaces that carry no lifecycle
 * Context fences: inventory, info, validation, teardown, authoring, and error
 * views receive the same trusted width policy as lifecycle reports. Structural
 * copyable values (paths, identities, command lines) stay whole on dedicated
 * lines while prose wraps to the selected measure.
 */
export function responsiveHumanText(
  text: string,
  context: TerminalPresentationContext | undefined,
  copyableValues: readonly string[] = [],
): string {
  if (context === undefined) return text;
  const copyableValueProtector = createCopyableValueProtector(copyableValues);
  return text
    .split("\n")
    .flatMap((line) => wrappedLifecycleLine(line, context.width, copyableValueProtector))
    .join("\n");
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
  readonly stateExplanationItems?: readonly ReconciliationItem[];
  readonly untrackRecovery: UntrackRecovery;
}

function delimitedContext(context: string): string {
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

function verboseSections(
  report: ReconciliationReport,
  options: VerboseSectionOptions,
): string {
  const {
    completedRepositoryExclusions = false,
    includeStateExplanations = true,
    stateExplanationItems = reportItems(report),
    untrackRecovery,
  } = options;
  const groups = groupProjects(report).groups;
  const shorten = (text: string): string => shortenProjectReferences(text, groups);
  const items = reportItems(report).length === 0
    ? "(no projects)"
    : reportItems(report)
        .map((item) => shorten(`${item.project}: ${item.kind}${item.reason ? ` (${item.reason})` : ""}`))
        .join("\n");
  const desired = reportDesired(report).length === 0
    ? "(none)"
    : reportDesired(report)
        .map((installation) => {
          const resolved = installation.resolvedArtifacts.length === 0
            ? "  Resolved artifacts: (none)"
            : `  Resolved artifacts:\n${installation.resolvedArtifacts.map((artifact) => {
                const reasons = artifact.inclusionReasons.map((reason) => {
                  const path = reason.path.length === 0
                    ? "selected by profile"
                    : `via ${reason.path.join(" -> ")}`;
                  return `${reason.profile}: ${path}`;
                }).join("; ");
                return `    - ${artifact.type}:${artifact.id} (${reasons})`;
              }).join("\n")}`;
          const project = report.projects.find((candidate) =>
            candidate.canonicalProject === installation.canonicalProject
          );
          const consumers = (project?.outputs ?? [])
            .filter((output) => output.consumingHosts.length > 0)
            .map((output) => `    - ${output.path}: ${output.consumingHosts.join(", ")}`)
            .join("\n");
          const consumerSection = consumers.length === 0
            ? ""
            : `  Consuming Hosts:\n${consumers}\n`;
          const capabilityContracts = installation.capabilityContracts === undefined
            ? ""
            : Object.entries(installation.capabilityContracts)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([host, contract]) => `    - ${host}: ${contract}`)
                .join("\n");
          return (
            `${shorten(`${installation.project}: Profile ${installation.profile}`)}\n` +
            `  Hosts: ${installation.hosts.join(", ")}\n` +
            (capabilityContracts.length === 0 ? "" : `  Capability Contracts:\n${capabilityContracts}\n`) +
            `  Outputs: ${installation.outputs.join(", ")}\n` +
            consumerSection +
            `${resolved}\n` +
            `  Context:\n${delimitedContext(installation.context)}`
          );
        })
        .join("\n");
  const blockers = reportBlockers(report).length === 0
    ? "(none)"
    : reportBlockers(report).flatMap((blocker) =>
        verboseBlockerLines(blocker, shorten, untrackRecovery)
      ).join("\n");
  const outputs = reportOutputs(report).length === 0
    ? "(none)"
    : reportOutputs(report)
        .map((output) => shorten(`${output.project}/${output.path}: ${output.kind}`))
        .join("\n");
  const repositoryExclusions = changedRepositoryExclusions(report).length === 0
    ? "(none)"
    : changedRepositoryExclusions(report)
        .map((change) => `- ${shorten(`${change.target}: ${exclusionDeltaText(change)}`)}`)
        .join("\n");
  const repositoryExclusionRepairs = reportRepositoryExclusionRepairs(report).length === 0
    ? "(none)"
    : repositoryExclusionRepairLines(report, completedRepositoryExclusions)
        .map((repair) => `- ${shorten(repair)}`)
        .join("\n");
  const warningGroups = groupWarnings(report);
  const warnings = warningGroups.length === 0
    ? "(none)"
    : warningGroups
        .map((group) => {
          const formatted = shorten(group.message);
          const projectList = group.projects
            .map((p) => displayProjectPath(p.canonicalProject, p.project))
            .join(", ");
          return `- ${formatted} (${projectList})`;
        })
        .join("\n");
  const explanations = includeStateExplanations ? stateExplanationLines(stateExplanationItems) : [];
  const explanationSection = explanations.length > 0 ? `${explanations.join("\n")}\n` : "";
  const detail = `Projects:\n${items}\n${explanationSection}Outputs:\n${outputs}\nGit exclusions:\n${repositoryExclusions}\nGit exclusion repairs:\n${repositoryExclusionRepairs}\nSelected setup:\n${desired}\nWarnings:\n${warnings}\n`;
  const blockerSection = `Blockers:\n${blockers}\n`;
  return reportBlockers(report).length > 0
    ? `${blockerSection}${detail}`
    : `${detail}${blockerSection}`;
}

function verboseSetupSection(command: LifecycleCommand, report: ReconciliationReport): string {
  const setup = hostSetupSections(command, report, undefined, true);
  return `Host Setup:\n${setup.length > 0 ? setup.join("\n") : "(none)"}\n`;
}

function verboseReport(command: LifecycleCommand, report: ReconciliationReport): string {
  return `${outcomeLine(command, report)}\n${verboseSections(report, {
    untrackRecovery: { kind: "pointer", command },
  })}` +
    verboseSetupSection(command, report);
}

function verboseApplyReport(result: {
  readonly receipt: ReconciliationReport;
  readonly resultingState: ReconciliationReport;
}): string {
  const report = (
    `${outcomeLine("apply", result.resultingState, true)}\n` +
    `Pending:\n${verboseSections(result.resultingState, {
      stateExplanationItems: [...reportItems(result.resultingState), ...reportItems(result.receipt)],
      untrackRecovery: { kind: "pointer", command: "apply" },
    })}` +
    `Applied:\n${verboseSections(result.receipt, {
      completedRepositoryExclusions: true,
      includeStateExplanations: false,
      untrackRecovery: { kind: "pointer", command: "apply" },
    })}` +
    verboseSetupSection("apply", result.resultingState)
  );
  const readiness = reportBlockers(result.resultingState).length === 0
    ? readinessLines(
        result.resultingState,
        result.receipt,
      )
    : [];
  return readiness.length > 0 ? `${report}\n${readiness.join("\n")}\n` : report;
}

/**
 * Ordered apply safety evidence for a focused view (#352): the committed Apply
 * Receipt with the Projects it made current, then still-pending Project
 * identities. The focused filter renders this prefix before Blocker evidence
 * and can never suppress it, because a presentation filter must never hide
 * writes (ADR-0024, spec #345 Decision 6).
 */
function focusedApplySafetyEvidence(
  postState: ReconciliationReport,
  receipt: ReconciliationReport,
): readonly string[] {
  const lines = [
    ...committedApplyEvidence(receipt, postState, postState.projects.length > 1),
  ];
  const pending = stillPendingProjects(postState);
  if (pending.length > 0) lines.push("", `Still pending: ${pending.join(", ")}`);
  return lines.length > 0 ? ["", ...lines] : lines;
}

/** Focused apply view (#352): the safety-evidence prefix, then shared Blocker evidence. */
function focusedApplyReport(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions,
): string {
  const evidence = focusedApplySafetyEvidence(result.resultingState, result.receipt);
  const blockers = options.verbose
    ? focusedVerboseBlockers(result.resultingState)
    : focusedConciseBlockers(result.resultingState, "apply");
  return [
    outcomeLine("apply", result.resultingState, true),
    ...evidence,
    ...blockers,
  ].join("\n") + "\n";
}

export function formatApplyReport(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions = {},
): string {
  const focused =
    options.blockersOnly === true && reportBlockers(result.resultingState).length > 0;
  const report = focused
    ? focusedApplyReport(result, options)
    : options.verbose
    ? verboseApplyReport(result)
    : conciseReport("apply", result.resultingState, result.receipt, options);
  return responsiveLifecycleOutput(
    report,
    options.context,
    lifecycleCopyableValues([result.resultingState, result.receipt]),
  );
}

export function formatApplyExecutionFailure(
  failure: {
    readonly failedProject: string | undefined;
    readonly message: string;
    readonly pendingProjects: readonly string[];
    readonly receipt: ReconciliationReport;
    readonly resultingState: ReconciliationReport | undefined;
  },
  options: LifecycleHumanOptions = {},
): string {
  const lines = [
    failure.message,
    ...(failure.failedProject === undefined
      ? []
      : [`Failed Project: ${displayProjectPath(failure.failedProject)}`]),
    `Still pending: ${failure.pendingProjects.length === 0
      ? "none"
      : failure.pendingProjects.map((project) => displayProjectPath(project)).join(", ")}`,
    ...applyReceiptLines(failure.receipt),
  ];
  if (failure.resultingState !== undefined) {
    const appliedProjects = new Set(
      failure.receipt.projects.map((project) => project.canonicalProject),
    );
    const current = failure.resultingState.projects
      .filter((project) =>
        project.state.kind === "current" && appliedProjects.has(project.canonicalProject)
      )
      .map((project) => displayProjectPath(project.canonicalProject, project.project));
    if (current.length > 0) lines.push(`Freshly current: ${current.join(", ")}`);
  }
  if (
    options.blockersOnly === true &&
    failure.resultingState !== undefined &&
    reportBlockers(failure.resultingState).length > 0
  ) {
    // Both focused sections supply their own leading blank line (RE-1).
    lines.push(...(options.verbose
      ? focusedVerboseBlockers(failure.resultingState)
      : focusedConciseBlockers(failure.resultingState, "apply")));
  }
  return responsiveLifecycleOutput(
    `${lines.join("\n")}\n`,
    options.context,
    lifecycleCopyableValues([
      failure.receipt,
      ...(failure.resultingState === undefined ? [] : [failure.resultingState]),
    ]),
  );
}

export function formatApplyVerificationFailure(
  receipt: ReconciliationReport,
  message: string,
  options: LifecycleHumanOptions = {},
): string {
  if (options.verbose) {
    return responsiveLifecycleOutput(
      `${message}\nApplied:\n${verboseSections(receipt, {
        completedRepositoryExclusions: true,
        // Focused verbose verification failure carries the exact command
        // (#353 Decision 3); ordinary verbose points to the focused view.
        untrackRecovery: options.blockersOnly === true
          ? { kind: "full" }
          : { kind: "pointer", command: "apply" },
      })}` +
        verboseSetupSection("apply", receipt),
      options.context,
      lifecycleCopyableValues([receipt]),
    );
  }
  const lines = [
    message,
    ...applyReceiptLines(receipt),
  ];
  const setup = hostSetupSections("apply", receipt, receipt);
  if (setup.length > 0) lines.push("", ...setup);
  return responsiveLifecycleOutput(
    `${lines.join("\n")}\n`,
    options.context,
    lifecycleCopyableValues([receipt]),
  );
}

export function formatBlockedApplyReport(
  report: BlockedReconciliationReport,
  options: LifecycleHumanOptions = {},
): string {
  const focused = options.blockersOnly === true && reportBlockers(report).length > 0;
  const output = focused
    ? [
        outcomeLine("apply", report),
        ...(options.verbose
          ? focusedVerboseBlockers(report)
          : focusedConciseBlockers(report, "apply")),
      ].join("\n") + "\n"
    : options.verbose
    ? verboseReport("apply", report)
    : conciseReport("apply", report, undefined, options);
  return responsiveLifecycleOutput(output, options.context, lifecycleCopyableValues([report]));
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

/** The concise focused Blocker section shared by `status` and `apply`: one
 * deterministic group per affected Project, then global Blockers, then the
 * displayed-Blocker footer. The caller owns the outcome line and any prefix. */
function focusedConciseBlockers(
  report: ReconciliationReport,
  command: LifecycleCommand,
): readonly string[] {
  const grouped = groupProjects(report);
  const displayedGroups = displayedBlockerGroups(report);
  const lines: string[] = [];
  for (const group of displayedGroups) {
    lines.push(
      "",
      `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)}: ${displayProjectPath(group.canonicalProject, group.project)}`,
      ...conciseGroupBlockerLines(group, grouped.groups, "  ", { kind: "pointer", command }),
    );
  }
  const globalBlockerLines = conciseGlobalBlockerLines(report, grouped.groups, {
    kind: "pointer",
    command,
  });
  if (globalBlockerLines.length > 0) lines.push("", ...globalBlockerLines);
  lines.push("", blockersOnlyFooter(report));
  return lines;
}

/** The verbose focused Blocker section shared by `status` and `apply`:
 * complete Blocker fields with every affected item, then the footer. The
 * leading blank line keeps one spacing contract across focused views (INT-3).
 * This is the only view that prints the exact user-owned untracking command
 * (#353, spec #345 Decision 8). */
function focusedVerboseBlockers(report: ReconciliationReport): readonly string[] {
  const groups = groupProjects(report).groups;
  const shorten = (text: string): string => shortenProjectReferences(text, groups);
  return [
    "",
    `Blockers:\n${reportBlockers(report)
      .flatMap((blocker) =>
        verboseBlockerLines(blocker, shorten, { kind: "full" })
      )
      .join("\n")}`,
    "",
    blockersOnlyFooter(report),
  ];
}

function blockersOnlyConciseReport(
  report: ReconciliationReport,
  options: LifecycleHumanOptions,
): string {
  const lines = [outcomeLine("status", report), ...focusedConciseBlockers(report, "status")];
  // Next actions cover exactly the displayed groups, so pending but
  // Blocker-free Projects cannot leak into the focused view.
  const next = nextActionLines("status", report, {
    groups: displayedBlockerGroups(report),
    unscopedItems: [],
  }, options);
  if (next.length > 0) lines.push("", ...next);
  return `${lines.join("\n")}\n`;
}

function blockersOnlyVerboseReport(report: ReconciliationReport): string {
  return [
    outcomeLine("status", report),
    ...focusedVerboseBlockers(report),
  ].join("\n") + "\n";
}

export function formatLifecycleReport(
  command: Exclude<LifecycleCommand, "apply">,
  report: ReconciliationReport,
  options: LifecycleHumanOptions = {},
): string {
  if (options.blockersOnly === true) {
    if (reportBlockers(report).length === 0) {
      const completeView = options.all === true
        ? `${COMMAND_NAME} status --all`
        : `${COMMAND_NAME} status`;
      const output =
        `No blockers.\nNext: Run ${completeView} for the complete lifecycle view.\n`;
      return responsiveLifecycleOutput(output, options.context, lifecycleCopyableValues([report]));
    }
    const output = options.verbose
      ? blockersOnlyVerboseReport(report)
      : blockersOnlyConciseReport(report, options);
    return responsiveLifecycleOutput(output, options.context, lifecycleCopyableValues([report]));
  }
  const output = options.verbose
    ? verboseReport(command, report)
    : conciseReport(command, report, undefined, options);
  return responsiveLifecycleOutput(output, options.context, lifecycleCopyableValues([report]));
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

const LIFECYCLE_MACHINE_SCHEMA_VERSION = 12 as const;

/**
 * One version line per JSON command family: every `install-temp`/`remove-temp`
 * payload (success receipt, blocked, tool error) shares this constant so the
 * version identifies the family, and it evolves independently of the
 * `status`/`apply` lifecycle payload family even when both currently publish
 * the same number.
 */
const TEMPORARY_INSTALLATION_MACHINE_SCHEMA_VERSION = 8 as const;

function machineBlocker(blocker: ReconciliationBlocker): MachineBlocker {
  return {
    kind: blocker.kind,
    scope: blocker.scope,
    ...(blocker.scope === "project" ? { project: blocker.project } : {}),
    message: blocker.message,
    problem: blocker.problem,
    requirement: blocker.requirement,
    remedy: blocker.remedy,
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

function canonicalMachineWarning(warning: ReconciliationWarning): ReconciliationWarning {
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
    state: { ...project.state },
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
    repositoryExclusionRepairs: [...project.repositoryExclusionRepairs]
      .sort((left, right) =>
        safeRepairTargets(left)[0]!.localeCompare(safeRepairTargets(right)[0]!) ||
        left.class.localeCompare(right.class))
      .map(machineRepositoryExclusionRepair),
  };
}

/**
 * One exclusion repair's canonical machine record. Every class publishes its
 * own explicit key set; a moved contribution names both targets and both entry
 * sets explicitly (`currentTarget`/`nextTarget`, `current`/`next`).
 */
function machineRepositoryExclusionRepair(
  repair: SafeRepairExclusionRepair,
): Record<string, unknown> {
  switch (repair.class) {
    case "exclusion-section":
      return { class: repair.class, entries: [...repair.entries], target: repair.target };
    case "missing-contribution":
      return {
        class: repair.class,
        entries: [...repair.entries],
        installationId: repair.installationId,
        target: repair.target,
      };
    case "stale-contribution":
      return {
        class: repair.class,
        current: [...repair.currentEntries],
        installationId: repair.installationId,
        next: [...repair.entries],
        target: repair.target,
      };
    case "moved-contribution":
      return {
        class: repair.class,
        current: [...repair.current],
        currentTarget: repair.currentTarget,
        installationId: repair.installationId,
        next: [...repair.next],
        nextTarget: repair.nextTarget,
      };
    case "retiring-exclusion-section":
      return { class: repair.class, entries: [...repair.entries], target: repair.target };
  }
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
      project.repositoryExclusionRepairs.length > 0 ||
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
  readonly failedProject: string | undefined;
  readonly message: string;
  readonly pendingProjects: readonly string[];
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
    ...(failure.failedProject === undefined ? {} : { failedProject: failure.failedProject }),
    pendingProjects: [...failure.pendingProjects],
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
  readonly repositoryExclusion:
    | {
        readonly entries: readonly string[];
        readonly target: string;
      }
    | undefined;
  readonly setupSteps: readonly HostSetupStep[];
  readonly temporaryInstallationId: string;
  readonly diagnosticValues: readonly string[];
  readonly warnings: readonly string[];
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
      repositoryExclusion: receipt.repositoryExclusion ?? null,
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

export function formatTemporaryInstallationHuman(
  command: TemporaryInstallCommand,
  receipt: TemporaryInstallationReceiptView,
  options: { readonly context?: TerminalPresentationContext } = {},
  cwd = process.cwd(),
  home = homedir(),
): string {
  if (command === "install-temp" && (
    receipt.project === undefined || receipt.profileId === undefined || receipt.host === undefined
  )) {
    throw new Error("Installed temporary receipt is missing active installation detail");
  }
  const project = receipt.project === undefined
    ? undefined
    : displayProjectPath(receipt.project, receipt.project, cwd, home);
  if (command === "install-temp") {
    const removalCommand = `${COMMAND_NAME} remove-temp ${receipt.temporaryInstallationId}`;
    const warningLines = receipt.warnings.length === 0
      ? []
      : [
          "Warnings:",
          ...receipt.warnings.map((warning) => `- ${warning}`),
        ];
    const setupLines = receipt.setupSteps.length === 0
      ? []
      : [
          `${capitalize(receipt.host!)} setup:`,
          ...[...receipt.setupSteps]
            .sort((left, right) =>
              HOST_SETUP_STEP_ORDER.indexOf(left.kind) -
                HOST_SETUP_STEP_ORDER.indexOf(right.kind) ||
              left.message.localeCompare(right.message)
            )
            .flatMap((step) => {
              const message = setupStepMessage(step, project!);
              return [
                `- ${message}`,
                ...(step.consequence === undefined
                  ? []
                  : [`  Consequence: ${step.consequence}`]),
              ];
            }),
        ];
    return responsiveLifecycleOutput((
      `Installed ${DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.singular}\n` +
      `  Profile: ${receipt.profileId}\n` +
      `  Host: ${receipt.host}\n` +
      `  Project: ${project!}\n` +
      `  Temporary installation: ${receipt.temporaryInstallationId}\n` +
      (warningLines.length > 0 ? `${warningLines.join("\n")}\n` : "") +
      (setupLines.length > 0 ? `${setupLines.join("\n")}\n` : "") +
      `Next: ${removalCommand}\n`
    ), options.context, [
      project!,
      removalCommand,
      receipt.temporaryInstallationId,
      receipt.profileId!,
      ...receipt.diagnosticValues,
      ...receipt.outputs,
    ]);
  }
  return responsiveLifecycleOutput((
    `Removed ${DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.singular}\n` +
    `  Temporary installation: ${receipt.temporaryInstallationId}\n` +
    (project === undefined ? "" : `  Project: ${project}\n`)
  ), options.context, [
    ...(project === undefined ? [] : [project]),
    receipt.temporaryInstallationId,
  ]);
}

/**
 * Render the blocked temporary-installation messages with the one canonical
 * Project path presenter, so a blocked install/remove identifies the Project
 * the same way every other human view does. Human views read the message
 * projection; machine JSON publishes the structured blocker records.
 */
/**
 * Render the blocked temporary-installation messages with the one canonical
 * Project path presenter, so a blocked install/remove identifies the Project
 * the same way every other human view does. Human views read the message
 * projection; machine JSON publishes the structured blocker records. The
 * rendered text is intentionally unwrapped: callers compose the complete
 * prefixed diagnostic and pass it through the shared human boundary so the
 * command-name prefix counts toward the width measure.
 */
export function presentTemporaryBlockedMessages(
  messages: readonly string[],
  canonicalProject: string,
  authoredProject = canonicalProject,
  cwd = process.cwd(),
  home = homedir(),
): { readonly presented: string; readonly text: string } {
  let presented = displayProjectPath(canonicalProject, authoredProject, cwd, home);
  if (presented === "." || presented === ".." || presented.startsWith("../")) {
    // A bare cwd-relative identity would lose the blocked message's subject;
    // blocked diagnostics identify the Project independently of the caller's
    // working directory.
    presented = displayProjectPath(canonicalProject, authoredProject, home, home);
  }
  const references = [...new Set([canonicalProject, absoluteAuthoredPath(authoredProject, home)])]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const text = messages
    .map((message) => references.reduce(
      (reduced, project) => replaceProjectReference(reduced, project, presented),
      message,
    ))
    .join("\n");
  return { presented, text };
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
