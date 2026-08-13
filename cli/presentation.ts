import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import type { HostSetupProvenance, HostSetupStep, HostSetupStepKind } from "../adapters/project-plan.js";
import type {
  ApplyReconciliationResult,
  BlockedReconciliationReport,
  OutputReconciliationItem,
  OutputReconciliationKind,
  ReconciliationBlocker,
  ReconciliationItem,
  ReconciliationKind,
  ReconciliationReport,
} from "../installer/reconcile.js";
import type {
  LifecycleImpact,
  LifecycleImpactKind,
  LifecycleImpactOperation,
} from "../installer/impacts.js";
import {
  LIFECYCLE_IMPACT_KIND_ORDER,
  LIFECYCLE_IMPACT_OPERATION_ORDER,
} from "../installer/impacts.js";
import { REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX } from "../installer/git-exclusions.js";
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
import {
  artifactReferenceKey,
  type ArtifactReference,
} from "../schemas/dependencies.js";

export type LifecycleCommand = "preview" | "apply" | "status";

const HOST_SETUP_STEP_ORDER: readonly HostSetupStepKind[] = [
  "approval-required",
  "trust-required",
  "launch-constraint",
  "shared-path",
];
const ACTIONABLE_HOST_SETUP_STEP_KINDS: ReadonlySet<HostSetupStepKind> = new Set([
  "approval-required",
  "trust-required",
  "launch-constraint",
]);

type NonCurrentKind = Exclude<ReconciliationKind, "current">;

const DEFAULT_VIEW_LEXICON = {
  artifactId: { singular: "name", plural: "names" },
  desiredState: "selected setup",
  generatedOutput: {
    paths: "generated paths",
    plural: "generated files",
    singular: "generated file",
  },
  installationManifest: { singular: "installation record", plural: "installation records" },
  installerOwned: {
    attributive: "Agent Profile Kit-managed",
    postpositive: "managed by Agent Profile Kit",
  },
  profileInstallation: { singular: "project", plural: "projects" },
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
  repositoryExclusionRecord: { singular: "Git exclusion record", plural: "Git exclusion records" },
} as const;

const OUTPUT_PATH_PRIORITY = {
  "drifted member": 0,
  "missing member": 0,
  "unexpected member": 0,
  removal: 1,
  update: 2,
  addition: 3,
  repair: 3,
  unchanged: 4,
} as const satisfies Readonly<Record<OutputReconciliationKind, number>>;

export const INTERNAL_ONLY_DEFAULT_TERMS = [
  // Ordinary Profile Installation vocabulary — not the temporary-lifetime phrase.
  /(?<!temporary )Profile Installations?/i,
  /generated[- ]outputs?/i,
  /Repository Exclusions?/i,
  /Installer-owned/i,
  /reconcil(?:e|es|ed|ing|iation)/i,
  /Artifact IDs?/i,
  /Installation Manifests?/i,
  /desired state/i,
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

function capitalize(text: string): string {
  return `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

function preserveInitialCase(source: string, replacement: string): string {
  return source[0] === source[0]?.toUpperCase()
    ? capitalize(replacement)
    : replacement;
}

export function defaultViewText(text: string): string {
  const replacements: readonly (readonly [RegExp, string, boolean?])[] = [
    [
      /\bInstaller-owned generated outputs\b/gi,
      `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}`,
      false,
    ],
    [
      /\bInstaller-owned generated output\b/gi,
      `${DEFAULT_VIEW_LEXICON.generatedOutput.singular} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}`,
      false,
    ],
    [
      /\bInstaller-owned generated paths\b/gi,
      `${DEFAULT_VIEW_LEXICON.generatedOutput.paths} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}`,
      false,
    ],
    [/\bRepository Exclusion Records\b/gi, DEFAULT_VIEW_LEXICON.repositoryExclusionRecord.plural],
    [/\bRepository Exclusion Record\b/gi, DEFAULT_VIEW_LEXICON.repositoryExclusionRecord.singular],
    // Preserve "temporary Profile installation" (receipt-owned lifetime) as newcomer vocabulary.
    [/(?<!temporary )\bProfile Installations\b/gi, DEFAULT_VIEW_LEXICON.profileInstallation.plural],
    [/(?<!temporary )\bProfile Installation\b/gi, DEFAULT_VIEW_LEXICON.profileInstallation.singular],
    [/\bgenerated[- ]outputs\b/gi, DEFAULT_VIEW_LEXICON.generatedOutput.plural],
    [/\bgenerated[- ]output\b/gi, DEFAULT_VIEW_LEXICON.generatedOutput.singular],
    [/\bRepository Exclusions\b/gi, DEFAULT_VIEW_LEXICON.repositoryExclusion.plural],
    [/\bRepository Exclusion\b/gi, DEFAULT_VIEW_LEXICON.repositoryExclusion.singular],
    [/\bInstaller-owned\b/gi, DEFAULT_VIEW_LEXICON.installerOwned.attributive],
    [/\breconciling\b/gi, DEFAULT_VIEW_LEXICON.reconciliation.continuous],
    [/\breconciles\b/gi, DEFAULT_VIEW_LEXICON.reconciliation.thirdPerson],
    [/\breconciled\b/gi, DEFAULT_VIEW_LEXICON.reconciliation.past],
    [/\breconciliation\b/gi, DEFAULT_VIEW_LEXICON.reconciliation.noun],
    [/\breconcile\b/gi, DEFAULT_VIEW_LEXICON.reconciliation.base],
    [/\bArtifact IDs\b/gi, DEFAULT_VIEW_LEXICON.artifactId.plural, false],
    [/\bArtifact ID\b/gi, DEFAULT_VIEW_LEXICON.artifactId.singular, false],
    [/\bInstallation Manifests\b/gi, DEFAULT_VIEW_LEXICON.installationManifest.plural, false],
    [/\bInstallation Manifest\b/gi, DEFAULT_VIEW_LEXICON.installationManifest.singular, false],
    [/\bdesired state\b/gi, DEFAULT_VIEW_LEXICON.desiredState],
  ];
  return replacements.reduce(
    (rendered, [pattern, replacement, preserveSourceCase = true]) => rendered.replace(
      pattern,
      (match) => preserveSourceCase ? preserveInitialCase(match, replacement) : replacement,
    ),
    text,
  );
}

function defaultDiagnosticText(text: string): string {
  const protectedValue = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^\s'"]*\/[^\s'"]*)/g;
  return text
    .split(protectedValue)
    .map((part, index) => index % 2 === 1 ? part : defaultViewText(part))
    .join("");
}

/**
 * Single ordered list of non-current Profile Installation states for concise glosses.
 * Exhaustiveness against `ReconciliationKind` is asserted below so a new kind cannot
 * render without an explanation entry.
 */
export const NON_CURRENT_STATE_ORDER = [
  "addition",
  "intended teardown",
  "missing output",
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
  "intended teardown":
    `Generated files were deliberately removed by uninstall while the Project Binding was preserved; ` +
    "apply will reinstall the current Profile.",
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
    `An owned ${DEFAULT_VIEW_LEXICON.generatedOutput.singular} no longer matches its ` +
    `${DEFAULT_VIEW_LEXICON.installationManifest.singular} hash and is not treated as a safe automatic rewrite.`,
  "malformed ownership state":
    "Ownership metadata is incomplete or inconsistent, so Agent Profile Kit cannot prove what it owns.",
  blocked:
    `${capitalize(DEFAULT_VIEW_LEXICON.reconciliation.noun)} cannot change this ` +
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)} until the listed blocker is resolved.`,
  removal:
    `No Project Binding remains for this installation; apply will remove proven ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}.`,
  "missing output":
    `The ${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)} is absent or its ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.plural} are missing without proven Agent Profile Kit ownership; ` +
    "this is not a safe automatic repair.",
};

interface OutputSummary {
  readonly additions: number;
  readonly drift: number;
  readonly missing: number;
  readonly removals: number;
  readonly repairs: number;
  readonly unexpected: number;
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
      `    JSON example: ${COMMAND_NAME} list ${topic.name} --json`,
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
        `Next: Run ${COMMAND_NAME} bind <profile> --host <host>.\n`,
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
  lines.push("", `Next: Run ${COMMAND_NAME} status for Project lifecycle diagnostics.`);
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
        `Next: Add a Profile to the selected Workspace, then run ${COMMAND_NAME} list profiles.\n`,
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
  lines.push("", `Next: Run ${COMMAND_NAME} bind <profile> --host <host>.`);
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
  const capability = (host: HostInventoryRecord): string =>
    `Temporary Profile Installation: ${host.supportsTemporaryProfileInstallation ? "supported" : "not supported"}`;
  const lines = [`Hosts (${hosts.length}):`];
  for (const host of hosts) {
    lines.push(
      "",
      `Host: ${host.host}`,
      `  ${capability(host)}`,
    );
  }
  lines.push("", `Next: Run ${COMMAND_NAME} bind <profile> --host <host>.`);
  return responsiveHumanText(`${lines.join("\n")}\n`, options.context, hosts.map(capability));
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
      "No Temporary Profile Installations are active.\n" +
        `Next: Run ${COMMAND_NAME} install-temp <profile> <project> --host <host>.\n`,
      options.context,
    );
  }

  const lines = [`Temporary Profile Installations (${installations.length}):`];
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
  lines.push("", `Next: Run ${COMMAND_NAME} remove-temp <temporary-installation-id> when finished.`);
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
  const countClause = `(${plural(profileCount, "Profile")}, ${plural(result.bindings, "Project Binding")})`;
  const output = `Workspace and Local Configuration valid ${countClause}\n` +
    `Profiles found: ${profileCount === 0 ? "none" : result.profiles.join(", ")}\n` +
    `Hosts bound: ${result.hosts.length === 0 ? "none" : result.hosts.join(", ")}\n` +
    result.warnings.map((warning) => `Warning: ${warning}\n`).join("");
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
  lines.push("", "Project Bindings preserved.");
  if (projectCount > 0) {
    lines.push(`Next: Run ${COMMAND_NAME} unbind for bindings you no longer want, or ${COMMAND_NAME} apply to reinstall.`);
  }
  return responsiveHumanText(`${lines.join("\n")}\n`, options.context, copyable);
}

function summarizeOutputs(outputs: readonly OutputReconciliationItem[]): OutputSummary {
  return outputs.reduce<OutputSummary>(
    (summary, output) => {
      switch (output.kind) {
        case "addition":
          return { ...summary, additions: summary.additions + 1 };
        case "drifted member":
          return { ...summary, drift: summary.drift + 1 };
        case "missing member":
          return { ...summary, missing: summary.missing + 1 };
        case "removal":
          return { ...summary, removals: summary.removals + 1 };
        case "repair":
          return { ...summary, repairs: summary.repairs + 1 };
        case "unchanged":
          return summary;
        case "unexpected member":
          return { ...summary, unexpected: summary.unexpected + 1 };
        case "update":
          return { ...summary, updates: summary.updates + 1 };
        default:
          return assertNever(output.kind);
      }
    },
    { additions: 0, drift: 0, missing: 0, removals: 0, repairs: 0, unexpected: 0, updates: 0 },
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
  if (summary.missing > 0) {
    parts.push(`${summary.missing} generated ${summary.missing === 1 ? "file" : "files"} missing`);
  }
  if (summary.unexpected > 0) {
    parts.push(plural(summary.unexpected, `unexpected ${generatedFile}`));
  }
  return parts;
}

function changeCount(summary: OutputSummary): number {
  return summary.additions + summary.updates + summary.repairs + summary.removals + summary.drift +
    summary.missing + summary.unexpected;
}

/** One canonical overflow pointer shared by every capped path list in default views. */
function overflowPointer(overflow: number, singular: string): string {
  const noun = overflow === 1 ? singular : `${singular}s`;
  return `… ${overflow} more ${noun}; use --verbose to see all paths`;
}

function outputPathLine(output: OutputReconciliationItem): string | undefined {
  switch (output.kind) {
    case "addition":
    case "repair":
      return `+ ${output.path}`;
    case "update":
      return `~ ${output.path}`;
    case "removal":
      return `- ${output.path}`;
    case "drifted member":
    case "missing member":
    case "unexpected member":
      return `! ${output.path} (${output.kind})`;
    case "unchanged":
      return undefined;
    default:
      return assertNever(output.kind);
  }
}

function outputPathLines(outputs: readonly OutputReconciliationItem[]): readonly string[] {
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

function authoritativeVerboseOutputs(
  outputs: readonly OutputReconciliationItem[],
): readonly OutputReconciliationItem[] {
  return outputs.filter((output) =>
    output.kind !== "unchanged" || !outputs.some((candidate) =>
      candidate.project === output.project &&
      (
        candidate.kind === "drifted member" ||
        candidate.kind === "missing member" ||
        candidate.kind === "unexpected member"
      ) &&
      // Directory member labels are constructed as `<output.path>/<member.path>`
      // at ownership inspection, while root-mode drift uses the exact output path.
      (candidate.path === output.path || candidate.path.startsWith(`${output.path}/`))
    )
  );
}

function changedRepositoryExclusions(report: ReconciliationReport): readonly ReconciliationReport["repositoryExclusions"][number][] {
  return report.repositoryExclusions.filter((change) =>
    change.current.length !== change.next.length ||
    change.current.some((entry, index) => entry !== change.next[index]),
  );
}

function repositoryExclusionRepairLines(
  report: ReconciliationReport,
  completed = false,
): readonly string[] {
  return report.repositoryExclusionRepairs.map((repair) => {
    const count = repair.entries.length;
    const action = completed ? "restored" : "will restore";
    return `${repair.target}: ${action} ${count} recorded Repository Exclusion ${count === 1 ? "entry" : "entries"}`;
  });
}

function exclusionDelta(change: ReconciliationReport["repositoryExclusions"][number]): {
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

function exclusionDeltaText(change: ReconciliationReport["repositoryExclusions"][number]): string {
  const delta = exclusionDelta(change);
  const parts: string[] = [];
  if (delta.additions.length > 0) parts.push(`add ${delta.additions.join(", ")}`);
  if (delta.removals.length > 0) parts.push(`remove ${delta.removals.join(", ")}`);
  return parts.join("; ");
}

function repositoryExclusionClause(
  report: ReconciliationReport,
  completed: boolean,
): string | undefined {
  const delta = changedRepositoryExclusions(report)
    .map(exclusionDelta)
    .reduce(
      (total, change) => ({
        additions: total.additions + change.additions.length,
        removals: total.removals + change.removals.length,
      }),
      { additions: 0, removals: 0 },
    );
  const repairs = report.repositoryExclusionRepairs.reduce(
    (count, repair) => count + repair.entries.length,
    0,
  );
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
  return `${item.kind}${item.reason ? ` (${defaultDiagnosticText(item.reason)})` : ""}`;
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

function projectCandidates(blocker: ReconciliationBlocker, displayProject?: string): string[] {
  return [...new Set([blockerProject(blocker), displayProject].filter((project): project is string => project !== undefined))];
}

function stripProjectPrefix(message: string, projects: readonly string[]): string {
  for (const project of projects) {
    const prefix = `${project}: `;
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }
  return message;
}

function removeProjectPathPrefix(message: string, project: string): string {
  const prefix = `${project}/`;
  let cursor = 0;
  let formatted = "";
  while (cursor < message.length) {
    const index = message.indexOf(prefix, cursor);
    if (index < 0) return formatted + message.slice(cursor);
    const previous = message[index - 1];
    const boundary = index === 0 || previous === undefined || /[\s("'=:/]/.test(previous);
    if (!boundary) {
      formatted += message.slice(cursor, index + 1);
      cursor = index + 1;
      continue;
    }
    formatted += message.slice(cursor, index);
    cursor = index + prefix.length;
  }
  return formatted;
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

function formatProjectPaths(message: string, projects: readonly string[]): string {
  return projects.reduce(removeProjectPathPrefix, message);
}

function formatBlocker(blocker: ReconciliationBlocker, displayProject?: string): string {
  const projects = projectCandidates(blocker, displayProject);
  return defaultDiagnosticText(
    formatProjectPaths(stripProjectPrefix(blocker.message, projects), projects),
  );
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
function conciseOwnershipConflictLines(
  blocker: StructuredReconciliationBlocker & {
    readonly kind: typeof OUTPUT_OWNERSHIP_CONFLICT;
    readonly scope: "project";
  },
  groups: readonly ProjectGroup[],
  indent: string,
): readonly string[] {
  const paths = blocker.affectedItems.filter((item) => item.kind === "path");
  const lines = [
    `${indent}Blocker: ${shortenProjectReferences(defaultDiagnosticText(blocker.problem), groups)}`,
    `${indent}  Requirement: ${defaultDiagnosticText(blocker.requirement)}`,
    `${indent}  Remedy: ${defaultDiagnosticText(blocker.remedy)}`,
    `${indent}  Affected paths:`,
  ];
  for (const item of paths.slice(0, DEFAULT_OUTPUT_PATH_LIMIT)) {
    lines.push(`${indent}    - ${item.value}`);
  }
  const overflow = paths.length - DEFAULT_OUTPUT_PATH_LIMIT;
  if (overflow > 0) {
    lines.push(`${indent}    ${overflowPointer(overflow, "path")}`);
  }
  return lines;
}

function conciseBlockerLines(
  blocker: ReconciliationBlocker,
  displayProject: string | undefined,
  groups: readonly ProjectGroup[],
  indent: string,
): readonly string[] {
  if (isOutputOwnershipConflict(blocker)) {
    return conciseOwnershipConflictLines(blocker, groups, indent);
  }
  return [
    `${indent}Blocker: ${shortenProjectReferences(formatBlocker(blocker, displayProject), groups)}`,
  ];
}

function verboseBlockerLines(
  blocker: ReconciliationBlocker,
  shorten: (text: string) => string,
): readonly string[] {
  if (!isOutputOwnershipConflict(blocker)) return [`- ${shorten(blocker.message)}`];
  const lines = [
    `- ${shorten(`${blocker.project}: ${blocker.problem}`)}`,
    `  Requirement: ${defaultDiagnosticText(blocker.requirement)}`,
    `  Remedy: ${defaultDiagnosticText(blocker.remedy)}`,
    "  Affected paths:",
  ];
  for (const item of blocker.affectedItems) {
    if (item.kind !== "path") continue;
    lines.push(`    - ${shorten(`${blocker.project}/${item.value}`)}`);
  }
  return lines;
}

function groupProjects(report: ReconciliationReport): GroupedProjects {
  const groupsByCanonical = new Map<string, ProjectGroup>();
  const canonicalByProject = new Map<string, string>();
  const unscopedItems: ReconciliationItem[] = [];
  const ensureGroup = (canonicalProject: string, project: string): ProjectGroup => {
    const existing = groupsByCanonical.get(canonicalProject);
    if (existing) return existing;
    const group: ProjectGroup = {
      blockers: [],
      canonicalProject,
      items: [],
      outputs: [],
      project,
    };
    groupsByCanonical.set(canonicalProject, group);
    return group;
  };
  for (const desired of report.desired) {
    const canonicalProject = desired.canonicalProject;
    canonicalByProject.set(desired.project, canonicalProject);
    ensureGroup(canonicalProject, desired.project);
  }
  for (const output of report.outputs) {
    const canonicalProject = canonicalByProject.get(output.project) ?? output.project;
    canonicalByProject.set(output.project, canonicalProject);
    ensureGroup(canonicalProject, output.project).outputs.push(output);
  }
  for (const item of report.items) {
    const canonicalProject = canonicalByProject.get(item.project);
    if (canonicalProject === undefined) {
      unscopedItems.push(item);
      continue;
    }
    ensureGroup(canonicalProject, item.project).items.push(item);
  }
  for (const blocker of report.blockers) {
    const project = blockerProject(blocker);
    if (project !== undefined) {
      const canonicalProject = canonicalByProject.get(project) ?? project;
      ensureGroup(canonicalProject, project).blockers.push(blocker);
    }
  }
  const groups = [...groupsByCanonical.values()].sort((left, right) => left.project.localeCompare(right.project));
  return { groups, unscopedItems };
}

function desiredInstallation(report: ReconciliationReport, project: string) {
  return report.desired.find((installation) =>
    installation.canonicalProject === project || installation.project === project,
  );
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
    report.items.length === 0 ||
    report.blockers.length > 0 ||
    report.items.some((item) => item.kind !== "current")
  ) {
    return undefined;
  }
  return new Set(report.items.map((item) => item.project)).size;
}

function reportHasReconciliationWork(report: ReconciliationReport): boolean {
  return (
    report.blockers.length > 0 ||
    changeCount(summarizeOutputs(report.outputs)) > 0 ||
    report.items.some((item) => item.kind !== "current") ||
    changedRepositoryExclusions(report).length > 0 ||
    report.repositoryExclusionRepairs.length > 0
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

function outcomeLine(
  command: LifecycleCommand,
  report: ReconciliationReport,
  applyCompleted = false,
): string {
  if (command === "preview") {
    if (report.blockers.length > 0) return "Cannot apply";
    if (fullyCurrentProjectCount(report) !== undefined) {
      const projects = capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural);
      return `Nothing to ${DEFAULT_VIEW_LEXICON.reconciliation.base}; all ${projects} are current.`;
    }
    return "Ready to apply";
  }
  if (command === "apply") {
    if (report.blockers.length > 0) return applyCompleted ? "Apply completed with blockers" : "Apply blocked";
    if (report.items.some((item) => item.kind !== "current")) return "Apply completed with attention";
    return "Apply complete";
  }
  if (
    report.blockers.length === 0 &&
    report.items.length > 0 &&
    report.items.some((item) => item.kind === "intended teardown") &&
    report.items.every((item) => item.kind === "current" || item.kind === "intended teardown")
  ) {
    return report.items.some((item) => item.kind === "current")
      ? "Some Projects intentionally uninstalled"
      : "Intentionally uninstalled";
  }
  const currentProjects = fullyCurrentProjectCount(report);
  if (currentProjects === undefined && report.items.length > 0) {
    return "Attention required";
  }
  const projects = capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural);
  return currentProjects === undefined
    ? `No ${projects} are configured`
    : `All ${projects} are current (${plural(currentProjects, capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular))})`;
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
  if (report.blockers.length > 0) {
    if (command === "apply") parts.push("Pending: blocked");
    parts.push(`Blockers: ${report.blockers.length}`);
    return parts.join(" · ");
  }
  const changes = changeParts(summarizeOutputs(report.outputs));
  if (changes.length > 0) {
    parts.push(`${command === "apply" ? "Pending" : "Changes"}: ${changes.join(", ")}`);
  }
  return parts.length === 1 ? undefined : parts.join(" · ");
}

function warningsForPresentation(
  warnings: readonly string[],
): readonly string[] {
  // The dedicated exclusion clause/verbose repair section owns this fact.
  // Keeping the raw warning too would duplicate it and leak exact paths into
  // the default view.
  return warnings.filter(
    (warning) => !warning.endsWith(REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX),
  );
}

/** Output kinds that make a transition-triggered Host Setup Step newly relevant. */
const TRANSITION_TRIGGERING_OUTPUT_KINDS: ReadonlySet<OutputReconciliationKind> = new Set([
  "addition",
  "update",
  "repair",
]);

/** A Host Setup Step selected for one surface, with its Project identities. */
interface PresentedSetupStep {
  readonly canonicalProject: string;
  readonly message: string;
  readonly step: HostSetupStep;
}

/** Projects whose receipt carried reconciliation work (apply standing reminder). */
function projectsWithReconciliationWork(report: ReconciliationReport): ReadonlySet<string> {
  const projects = new Set<string>();
  for (const item of report.items) {
    if (item.kind !== "current") projects.add(item.project);
  }
  for (const output of report.outputs) {
    if (output.kind !== "unchanged") projects.add(output.project);
  }
  return projects;
}

/**
 * Outputs whose addition, update, or repair makes transition-triggered setup
 * relevant, keyed by authored Project identity.
 */
function transitionTriggeringOutputs(
  report: ReconciliationReport,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byProject = new Map<string, Set<string>>();
  for (const output of report.outputs) {
    if (!TRANSITION_TRIGGERING_OUTPUT_KINDS.has(output.kind)) continue;
    const paths = byProject.get(output.project) ?? new Set<string>();
    paths.add(output.path);
    byProject.set(output.project, paths);
  }
  return byProject;
}

/**
 * Select the Host Setup Steps one lifecycle surface presents (DEC-036–DEC-038):
 * transition-triggered steps appear only when the plan or applied receipt makes
 * their output relevant, standing steps appear as a separate reminder after
 * applied work or in `status`, and `preview` presents transition steps only.
 * Verbose surfaces retain every step as complete evidence (DEC-034).
 */
function presentedSetupSteps(
  command: LifecycleCommand,
  report: ReconciliationReport,
  changeEvidence: ReconciliationReport | undefined,
  verbose: boolean,
): readonly PresentedSetupStep[] {
  if (command !== "status" && report.blockers.length > 0) return [];
  const intentionallyUninstalledProjects = new Set(
    report.items
      .filter((item) => item.kind === "intended teardown")
      .map((item) => item.project),
  );
  const changeReport = changeEvidence ?? report;
  const triggeringOutputs = transitionTriggeringOutputs(changeReport);
  const workProjects = projectsWithReconciliationWork(changeReport);
  const steps: PresentedSetupStep[] = [];
  for (const installation of report.desired) {
    if (intentionallyUninstalledProjects.has(installation.project)) continue;
    for (const step of installation.setupSteps) {
      const message = setupStepMessage(
        step,
        displayProjectPath(installation.canonicalProject, installation.project),
      );
      if (step.provenance === "transition") {
        if (!verbose && command === "status") continue;
        if (!verbose && !(triggeringOutputs.get(installation.project)?.has(step.output) ?? false)) {
          continue;
        }
      } else if (!verbose && command === "preview") {
        continue;
      } else if (!verbose && command === "apply" && !workProjects.has(installation.project)) {
        continue;
      }
      steps.push({
        canonicalProject: installation.canonicalProject,
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

/**
 * Host Setup presentation sections from already-selected steps: change-caused
 * transition steps first, then a separate compact standing reminder (DEC-037,
 * DEC-038).
 */
function setupSectionsFromPresented(
  presented: readonly PresentedSetupStep[],
  verbose: boolean,
): readonly string[] {
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
  );
}

function activationLines(
  report: ReconciliationReport,
  receipt: ReconciliationReport,
  presented: readonly PresentedSetupStep[],
): readonly string[] {
  const changedProjects = new Set(
    receipt.items.filter((item) => item.kind !== "current").map((item) => item.project),
  );
  const actionableByCanonical = new Map<string, number>();
  for (const { step, canonicalProject } of presented) {
    if (!ACTIONABLE_HOST_SETUP_STEP_KINDS.has(step.kind)) continue;
    actionableByCanonical.set(
      canonicalProject,
      (actionableByCanonical.get(canonicalProject) ?? 0) + 1,
    );
  }
  const groups = new Map<string, {
    readonly hosts: readonly string[];
    readonly profile: string;
    readonly requiresSetup: boolean;
    projects: Array<{ readonly authored: string; readonly canonical: string }>;
  }>();
  for (const installation of report.desired) {
    if (!changedProjects.has(installation.project)) continue;
    const requiresSetup = (actionableByCanonical.get(installation.canonicalProject) ?? 0) > 0;
    const key = [installation.profile, installation.hosts.join(","), requiresSetup ? "setup" : "ready"].join("\u0000");
    const project = {
      authored: installation.project,
      canonical: installation.canonicalProject,
    };
    const existing = groups.get(key);
    if (existing) {
      existing.projects.push(project);
    } else {
      groups.set(key, {
        hosts: installation.hosts,
        profile: installation.profile,
        projects: [project],
        requiresSetup,
      });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      projects: [...group.projects].sort((left, right) =>
        compareCanonicalStrings(left.canonical, right.canonical),
      ),
    }))
    .sort((left, right) =>
      left.profile.localeCompare(right.profile) ||
      left.hosts.join(",").localeCompare(right.hosts.join(",")) ||
      Number(right.requiresSetup) - Number(left.requiresSetup) ||
      left.projects.map((project) => project.canonical).join("\u0000")
        .localeCompare(right.projects.map((project) => project.canonical).join("\u0000")),
    )
    .map((group) => {
      const setupCondition = group.requiresSetup
        ? "After completing the Host setup above, "
        : "No further Host setup is required. ";
      const presented = group.projects.map((project) =>
        displayProjectPath(project.canonical, project.authored),
      );
      const projectClause = presented.length === 1
        ? `from ${presented[0]!}`
        : `in ${plural(presented.length, "project")}`;
      return `${setupCondition}Profile ${group.profile} becomes active on the next launch ` +
        `of each bound Host (${group.hosts.join(", ")}) ${projectClause}.`;
    });
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
): readonly string[] {
  if (command === "apply" && report.blockers.length === 0) return [];

  const globalBlockers = report.blockers.filter((blocker) => blockerProject(blocker) === undefined);
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
    if (report.blockers.length > 0 && globalBlockers.length === 0) {
      if (command === "status") {
        addAction(
          `After all blockers are resolved, run ${COMMAND_NAME} preview to review the ` +
            "planned changes (read-only), then apply when ready.",
          project,
        );
      } else {
        addAction(
          `After all blockers are resolved, run ${COMMAND_NAME} apply` +
            `${command === "apply" ? " again" : ""}.`,
          project,
        );
      }
      continue;
    }
    if (globalBlockers.length > 0) continue;
    if (command === "status") {
      addAction(
        `Run ${COMMAND_NAME} preview to review the planned changes (read-only), then apply when ready.`,
        project,
      );
    } else {
      addAction(`Run ${COMMAND_NAME} apply.`, project);
    }
  }

  if (globalBlockers.length > 0) {
    const blockerWord = globalBlockers.length === 1 ? "blocker" : "blockers";
    addAction(`Resolve the reported global ${blockerWord}, then run ${COMMAND_NAME} ${command} again.`);
  }
  if (
    report.blockers.length === 0 &&
    surface.unscopedItems.some((item) => item.kind !== "current")
  ) {
    addAction(
      command === "status"
        ? `Run ${COMMAND_NAME} preview to review the planned changes (read-only), then apply when ready.`
        : `Run ${COMMAND_NAME} apply.`,
    );
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

/** Impact kinds presented as shared Workspace changes rather than Project changes. */
const WORKSPACE_IMPACT_KINDS: ReadonlySet<LifecycleImpactKind> = new Set(["artifact"]);

/** Output attention kinds that typed impacts never carry (member-level evidence). */
const MEMBER_ATTENTION_KINDS: ReadonlySet<OutputReconciliationKind> = new Set([
  "drifted member",
  "missing member",
  "unexpected member",
]);

/** Attention item kinds that typed impacts never represent as planned changes. */
const EXCEPTION_ITEM_KINDS: ReadonlySet<ReconciliationKind> = new Set([
  "drifted output",
  "malformed ownership state",
  "missing output",
]);

/**
 * Stale-source items accompany the same change typed impacts already explain;
 * they surface as exceptions only for a Project that carries no impact (e.g. a
 * non-material source change that leaves every output identical).
 */
const STALE_SOURCE_KIND: ReconciliationKind = "stale source";

const IMPACT_KIND_LABELS: Readonly<Record<Exclude<LifecycleImpactKind, "artifact">, string>> = {
  "adapter-capability": "Adapter",
  binding: "Project Binding",
  "generated-path": "Paths",
  "installation-removal": "Removal",
  "metadata-only": "Receipt",
  repair: "Repair",
};

/**
 * Fleet-oriented grouping applies to unblocked reports whose typed impacts span
 * more than one Project. Single-Project runs keep the recognizable Project-first
 * detail, and blocked runs keep blockers prominent ahead of any informational
 * impact detail (DEC-022, DEC-030, DEC-034).
 */
function useImpactFirstPresentation(report: ReconciliationReport, blocked: boolean): boolean {
  if (blocked || report.impacts.length === 0) return false;
  return new Set(report.impacts.map((impact) => impact.project)).size > 1;
}

interface ImpactPresentationGroup {
  readonly kind: LifecycleImpactKind;
  readonly operation: LifecycleImpactOperation;
  readonly artifacts: readonly ArtifactReference[] | undefined;
  readonly profile: string;
  readonly hosts: readonly string[];
  projects: string[];
  /** Total exact changed paths across every affected Project. */
  fileCount: number;
}

function impactGroupKey(group: ImpactPresentationGroup): string {
  return [
    group.kind,
    group.operation,
    (group.artifacts ?? []).map(artifactReferenceKey).join("\u0000"),
    group.profile,
    group.hosts.join("\u0000"),
  ].join("\u0001");
}

function sameHostSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((host, index) => host === right[index]);
}

/**
 * Aggregate typed impacts into deterministic presentation groups keyed by
 * change kind, proven source identity, Profile, Host scope, and operation
 * (DEC-029). Projects remain complete inside each group so the concise view can
 * derive counts and scope from the same evidence; the file count totals exact
 * changed paths across every affected Project.
 */
function groupImpacts(impacts: readonly LifecycleImpact[]): readonly ImpactPresentationGroup[] {
  const byKey = new Map<string, ImpactPresentationGroup>();
  for (const impact of impacts) {
    const key = impactGroupKey({
      kind: impact.kind,
      operation: impact.operation,
      artifacts: impact.artifacts,
      profile: impact.profile,
      hosts: impact.hosts,
      projects: [],
      fileCount: 0,
    });
    const existing = byKey.get(key);
    if (existing) {
      existing.projects.push(impact.project);
      existing.fileCount += impact.paths.length;
    } else {
      byKey.set(key, {
        kind: impact.kind,
        operation: impact.operation,
        artifacts: impact.artifacts,
        profile: impact.profile,
        hosts: impact.hosts,
        projects: [impact.project],
        fileCount: impact.paths.length,
      });
    }
  }
  const artifactKey = (artifacts: readonly ArtifactReference[] | undefined): string =>
    (artifacts ?? []).map(artifactReferenceKey).join("\u0000");
  return [...byKey.values()]
    .map((group) => ({
      ...group,
      projects: [...new Set(group.projects)].sort(compareCanonicalStrings),
    }))
    .sort((left, right) =>
      LIFECYCLE_IMPACT_KIND_ORDER.indexOf(left.kind) -
        LIFECYCLE_IMPACT_KIND_ORDER.indexOf(right.kind) ||
      LIFECYCLE_IMPACT_OPERATION_ORDER.indexOf(left.operation) -
        LIFECYCLE_IMPACT_OPERATION_ORDER.indexOf(right.operation) ||
      compareCanonicalStrings(artifactKey(left.artifacts), artifactKey(right.artifacts)) ||
      compareCanonicalStrings(left.profile, right.profile) ||
      left.hosts.join("\u0000").localeCompare(right.hosts.join("\u0000")) ||
      left.projects.join("\u0000").localeCompare(right.projects.join("\u0000"))
    );
}

function impactGroupLabel(group: ImpactPresentationGroup): string {
  if (group.kind === "artifact") {
    const type = capitalize(group.artifacts?.[0]?.type ?? "artifact");
    const ids = (group.artifacts ?? []).map((artifact) => artifact.id).join(", ");
    return ids.length === 0 ? "Artifact" : `${type} ${ids}`;
  }
  return IMPACT_KIND_LABELS[group.kind];
}

/**
 * Profile and Host clauses render where they disambiguate groups: when groups
 * sharing the same change kind, operation, and source identity differ in
 * Profile or Host scope. Variation is determined independently across every
 * cause-sharing group, so correlated changes (Profile and Host varying
 * together) still emit both clauses and no two cause-sharing groups can render
 * identically. Binding and Adapter groups always name their Hosts because the
 * Host selection is the change itself (US-026, US-027).
 */
function impactDisambiguation(
  group: ImpactPresentationGroup,
  groups: readonly ImpactPresentationGroup[],
): readonly string[] {
  const artifactKey = (candidate: ImpactPresentationGroup): string =>
    (candidate.artifacts ?? []).map(artifactReferenceKey).join("\u0000");
  const sharesCause = (candidate: ImpactPresentationGroup): boolean =>
    candidate !== group &&
    candidate.kind === group.kind &&
    candidate.operation === group.operation &&
    artifactKey(candidate) === artifactKey(group);
  const profileVaries = groups.some((candidate) =>
    sharesCause(candidate) && candidate.profile !== group.profile
  );
  const hostVaries = groups.some((candidate) =>
    sharesCause(candidate) &&
    candidate.hosts.join("\u0000") !== group.hosts.join("\u0000")
  );
  const clauses: string[] = [];
  if (profileVaries) clauses.push(`Profile ${group.profile}`);
  if (hostVaries || group.kind === "binding" || group.kind === "adapter-capability") {
    clauses.push(`Hosts ${group.hosts.join(", ")}`);
  }
  return clauses;
}

function impactScopeClause(
  group: ImpactPresentationGroup,
  report: ReconciliationReport,
  groups: readonly ImpactPresentationGroup[],
): string {
  const scopeProjects = report.desired
    .filter((desired) =>
      desired.profile === group.profile && sameHostSet(desired.hosts, group.hosts)
    )
    .map((desired) => desired.canonicalProject);
  const allAffected =
    scopeProjects.length > 0 &&
    group.projects.length === scopeProjects.length &&
    group.projects.every((project) => scopeProjects.includes(project));
  let projectClause: string;
  if (allAffected) {
    projectClause = `in ${plural(group.projects.length, "project")}`;
  } else if (group.projects.length <= PROJECT_SCOPE_LIMIT) {
    projectClause = `in ${group.projects.map((project) => displayProjectPath(project)).join(", ")}`;
  } else {
    const visible = group.projects
      .slice(0, PROJECT_SCOPE_LIMIT)
      .map((project) => displayProjectPath(project));
    projectClause =
      `in ${visible.join(", ")}, … ${plural(group.projects.length - PROJECT_SCOPE_LIMIT, "more Project")}; ` +
      "use --verbose to see all Projects";
  }
  const disambiguation = impactDisambiguation(group, groups);
  return disambiguation.length === 0
    ? projectClause
    : `${projectClause} · ${disambiguation.join(" · ")}`;
}

function impactGroupLine(
  group: ImpactPresentationGroup,
  report: ReconciliationReport,
  groups: readonly ImpactPresentationGroup[],
): string {
  const marker = group.operation === "addition" ? "+" : group.operation === "removal" ? "-" : "~";
  const fileClause = group.fileCount === 0 ? undefined : plural(group.fileCount, "file");
  const scope = impactScopeClause(group, report, groups);
  return fileClause === undefined
    ? `${marker} ${impactGroupLabel(group)} · ${scope}`
    : `${marker} ${impactGroupLabel(group)} · ${fileClause} ${scope}`;
}

function impactAttentionLines(report: ReconciliationReport): readonly string[] {
  const membersByProject = new Map<string, OutputReconciliationItem[]>();
  for (const output of report.outputs) {
    if (MEMBER_ATTENTION_KINDS.has(output.kind)) {
      const members = membersByProject.get(output.project) ?? [];
      members.push(output);
      membersByProject.set(output.project, members);
    }
  }
  const itemsByProject = new Map<string, ReconciliationItem[]>();
  const impactProjects = new Set(report.impacts.map((impact) => impact.project));
  for (const item of report.items) {
    if (
      EXCEPTION_ITEM_KINDS.has(item.kind) ||
      (item.kind === STALE_SOURCE_KIND && !impactProjects.has(item.project))
    ) {
      const items = itemsByProject.get(item.project) ?? [];
      items.push(item);
      itemsByProject.set(item.project, items);
    }
  }
  const projects = [...new Set([
    ...membersByProject.keys(),
    ...itemsByProject.keys(),
  ])].sort(compareCanonicalStrings);
  if (projects.length === 0) return [];
  const lines = ["", "Project exceptions:"];
  for (const project of projects) {
    const presented = displayProjectPath(project);
    const items = itemsByProject.get(project) ?? [];
    const members = membersByProject.get(project) ?? [];
    lines.push(`  ${presented}:`);
    for (const item of items) lines.push(`    State: ${itemText(item)}`);
    for (const member of members) lines.push(`    ! ${member.path} (${member.kind})`);
  }
  return lines;
}

/**
 * Impact-first sections for concise multi-Project views: shared Workspace
 * changes once, distinct Project changes, then Project-specific exceptions that
 * typed impacts do not carry (DEC-022, DEC-029).
 */
function impactFirstSections(report: ReconciliationReport): readonly string[] {
  const impactGroups = groupImpacts(report.impacts);
  const lines: string[] = [];
  const workspace = impactGroups.filter((group) => WORKSPACE_IMPACT_KINDS.has(group.kind));
  const project = impactGroups.filter((group) => !WORKSPACE_IMPACT_KINDS.has(group.kind));
  if (workspace.length > 0) {
    lines.push("", "Workspace changes:");
    for (const group of workspace) lines.push(`  ${impactGroupLine(group, report, impactGroups)}`);
  }
  if (project.length > 0) {
    lines.push("", "Project changes:");
    for (const group of project) lines.push(`  ${impactGroupLine(group, report, impactGroups)}`);
  }
  lines.push(...impactAttentionLines(report));
  return lines;
}

function impactReceiptLines(receipt: ReconciliationReport): readonly string[] {
  const impactGroups = groupImpacts(receipt.impacts);
  const lines = [
    "Applied:",
    ...impactGroups.map((group) => `  ${impactGroupLine(group, receipt, impactGroups)}`),
  ];
  const exclusionClause = repositoryExclusionClause(receipt, true);
  if (exclusionClause !== undefined) lines.push("", exclusionClause);
  return lines;
}

function applyReceiptLines(receipt: ReconciliationReport): readonly string[] {
  if (useImpactFirstPresentation(receipt, false)) {
    return impactReceiptLines(receipt);
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
    return [
      `Applied: none; all ` +
      `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)} were already current.`,
    ];
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
): string {
  const grouped = groupProjects(report);
  const groups = grouped.groups;
  const blocked = report.blockers.length > 0;
  const emptyStatus =
    command === "status" &&
    report.blockers.length === 0 &&
    report.desired.length === 0 &&
    report.items.length === 0;
  const fullyCurrentStatus = command === "status" && fullyCurrentProjectCount(report) !== undefined;
  const noOpPreview = command === "preview" && fullyCurrentProjectCount(report) !== undefined;
  const noOpApply = isNoOpApply(command, report, receipt);
  const lines = emptyStatus
    ? [
        "No Projects are configured.",
        `Next: Run ${COMMAND_NAME} list projects to inspect Project Bindings, or ` +
          `${COMMAND_NAME} bind <profile> --host <host> to configure one.`,
      ]
    : [outcomeLine(command, report, receipt !== undefined)];
  const summary = !emptyStatus && !fullyCurrentStatus && !noOpPreview && !noOpApply
    ? aggregateLine(command, report, groups)
    : undefined;
  if (!blocked && summary !== undefined) lines.push(summary);
  const activeGroups = blocked
    ? groups.filter((group) => group.blockers.length > 0)
    : groups.filter((group) => groupNeedsAttention(group, command));
  const receiptImpactFirst = command === "apply" && receipt !== undefined &&
    useImpactFirstPresentation(receipt, false);
  const impactFirst = useImpactFirstPresentation(report, blocked) || receiptImpactFirst;

  if (impactFirst) {
    lines.push(...impactFirstSections(report));
  } else if (activeGroups.length === 0) {
    if (groups.length > 0 && report.blockers.length === 0 && !fullyCurrentStatus && !noOpPreview) {
      const projects = capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural);
      if (command !== "preview") {
        lines.push(
          command === "apply"
            ? `All ${projects} were already current.`
            : `No ${projects} need attention.`,
        );
      }
    }
  } else {
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
        for (const blocker of group.blockers) {
          lines.push(...conciseBlockerLines(blocker, group.project, groups, "  "));
        }
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
        lines.push(...conciseBlockerLines(blocker, group.project, groups, "  "));
      }
    }
  }

  const exclusionClause = repositoryExclusionClause(report, false);
  if (exclusionClause !== undefined) lines.push("", exclusionClause);

  const globalBlockers = report.blockers.filter((blocker) => blockerProject(blocker) === undefined);
  if (globalBlockers.length > 0) {
    lines.push("", "Global blockers:");
    for (const blocker of globalBlockers) {
      lines.push(`- ${shortenProjectReferences(formatBlocker(blocker), groups)}`);
    }
  }
  if (blocked && summary !== undefined) lines.push("", summary);
  if (!blocked && grouped.unscopedItems.length > 0) {
    lines.push("", "Diagnostics:");
    for (const item of grouped.unscopedItems) lines.push(`- ${item.project}: ${itemText(item)}`);
  }
  const warnings = warningsForPresentation(report.warnings);
  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warnings) {
      lines.push(`- ${defaultDiagnosticText(shortenProjectReferences(warning, groups))}`);
    }
  }
  const presented = presentedSetupSteps(
    command,
    report,
    command === "apply" ? receipt : undefined,
    false,
  );
  const setup = setupSectionsFromPresented(presented, false);
  if (setup.length > 0) lines.push("", ...setup);
  const next = nextActionLines(command, report, {
    groups,
    unscopedItems: grouped.unscopedItems,
  });
  if (next.length > 0) lines.push("", ...next);
  if (receipt && !noOpApply) lines.push("", ...applyReceiptLines(receipt));
  if (command === "apply" && report.blockers.length === 0) {
    const activation = receipt ? activationLines(report, receipt, presented) : [];
    if (activation.length > 0) lines.push("", ...activation);
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
    for (const installation of report.desired) {
      values.add(installation.canonicalProject);
      values.add(installation.project);
      values.add(displayProjectPath(installation.canonicalProject, installation.project));
      for (const output of installation.outputs) values.add(output);
      for (const artifact of installation.resolvedArtifacts) values.add(artifact.id);
    }
    for (const item of report.items) values.add(item.project);
    for (const output of report.outputs) {
      values.add(output.project);
      values.add(output.path);
    }
    for (const blocker of report.blockers) {
      if (blocker.project !== undefined) values.add(blocker.project);
      for (const item of blocker.affectedItems ?? []) values.add(item.value);
    }
    for (const exclusion of report.repositoryExclusions) {
      values.add(exclusion.target);
      for (const entry of [...exclusion.current, ...exclusion.next]) values.add(entry);
    }
    for (const repair of report.repositoryExclusionRepairs) {
      values.add(repair.target);
      for (const entry of repair.entries) values.add(entry);
    }
    for (const value of report.diagnosticValues) values.add(value);
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
  readonly context?: TerminalPresentationContext;
  readonly verbose?: boolean;
}

interface VerboseSectionOptions {
  readonly completedRepositoryExclusions?: boolean;
  readonly includeStateExplanations?: boolean;
  readonly stateExplanationItems?: readonly ReconciliationItem[];
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
  options: VerboseSectionOptions = {},
): string {
  const {
    completedRepositoryExclusions = false,
    includeStateExplanations = true,
    stateExplanationItems = report.items,
  } = options;
  const groups = groupProjects(report).groups;
  const shorten = (text: string): string => shortenProjectReferences(text, groups);
  const items = report.items.length === 0
    ? "(no Profile Installations)"
    : report.items
        .map((item) => shorten(`${item.project}: ${item.kind}${item.reason ? ` (${item.reason})` : ""}`))
        .join("\n");
  const desired = report.desired.length === 0
    ? "(none)"
    : report.desired
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
          return (
            `${shorten(`${installation.project}: Profile ${installation.profile}`)}\n` +
            `  Hosts: ${installation.hosts.join(", ")}\n` +
            `  Outputs: ${installation.outputs.join(", ")}\n` +
            `${resolved}\n` +
            `  Context:\n${delimitedContext(installation.context)}`
          );
        })
        .join("\n");
  const blockers = report.blockers.length === 0
    ? "(none)"
    : report.blockers.flatMap((blocker) => verboseBlockerLines(blocker, shorten)).join("\n");
  const outputs = report.outputs.length === 0
    ? "(none)"
    : authoritativeVerboseOutputs(report.outputs)
        .map((output) => shorten(`${output.project}/${output.path}: ${output.kind}`))
        .join("\n");
  const repositoryExclusions = changedRepositoryExclusions(report).length === 0
    ? "(none)"
    : changedRepositoryExclusions(report)
        .map((change) => `- ${shorten(`${change.target}: ${exclusionDeltaText(change)}`)}`)
        .join("\n");
  const repositoryExclusionRepairs = report.repositoryExclusionRepairs.length === 0
    ? "(none)"
    : repositoryExclusionRepairLines(report, completedRepositoryExclusions)
        .map((repair) => `- ${shorten(repair)}`)
        .join("\n");
  const presentationWarnings = warningsForPresentation(report.warnings);
  const warnings = presentationWarnings.length === 0
    ? "(none)"
    : presentationWarnings.map((warning) => `- ${shorten(warning)}`).join("\n");
  const explanations = includeStateExplanations ? stateExplanationLines(stateExplanationItems) : [];
  const explanationSection = explanations.length > 0 ? `${explanations.join("\n")}\n` : "";
  const detail = `Projects:\n${items}\n${explanationSection}Outputs:\n${outputs}\nRepository Exclusions:\n${repositoryExclusions}\nRepository Exclusion Repairs:\n${repositoryExclusionRepairs}\nDesired State:\n${desired}\nWarnings:\n${warnings}\n`;
  const blockerSection = `Blockers:\n${blockers}\n`;
  return report.blockers.length > 0
    ? `${blockerSection}${detail}`
    : `${detail}${blockerSection}`;
}

function verboseSetupSection(command: LifecycleCommand, report: ReconciliationReport): string {
  const setup = hostSetupSections(command, report, undefined, true);
  return `Host Setup:\n${setup.length > 0 ? setup.join("\n") : "(none)"}\n`;
}

function verboseReport(command: LifecycleCommand, report: ReconciliationReport): string {
  return `${outcomeLine(command, report)}\n${verboseSections(report)}` +
    verboseSetupSection(command, report);
}

function verboseApplyReport(result: ApplyReconciliationResult): string {
  const report = (
    `${outcomeLine("apply", result.resultingState, true)}\n` +
    `Pending:\n${verboseSections(result.resultingState, {
      stateExplanationItems: [...result.resultingState.items, ...result.receipt.items],
    })}` +
    `Applied:\n${verboseSections(result.receipt, {
      completedRepositoryExclusions: true,
      includeStateExplanations: false,
    })}` +
    verboseSetupSection("apply", result.resultingState)
  );
  const activation = result.resultingState.blockers.length === 0
    ? activationLines(
        result.resultingState,
        result.receipt,
        presentedSetupSteps("apply", result.resultingState, undefined, true),
      )
    : [];
  return activation.length > 0 ? `${report}\n${activation.join("\n")}\n` : report;
}

export function formatApplyReport(
  result: ApplyReconciliationResult,
  options: LifecycleHumanOptions = {},
): string {
  const report = options.verbose
    ? verboseApplyReport(result)
    : conciseReport("apply", result.resultingState, result.receipt);
  return responsiveLifecycleOutput(
    report,
    options.context,
    lifecycleCopyableValues([result.resultingState, result.receipt]),
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
      })}` +
        verboseSetupSection("apply", receipt),
      options.context,
      lifecycleCopyableValues([receipt]),
    );
  }
  const lines = [
    defaultDiagnosticText(message),
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
  const output = options.verbose ? verboseReport("apply", report) : conciseReport("apply", report);
  return responsiveLifecycleOutput(output, options.context, lifecycleCopyableValues([report]));
}

export function formatLifecycleReport(
  command: Exclude<LifecycleCommand, "apply">,
  report: ReconciliationReport,
  options: LifecycleHumanOptions = {},
): string {
  const output = options.verbose ? verboseReport(command, report) : conciseReport(command, report);
  return responsiveLifecycleOutput(output, options.context, lifecycleCopyableValues([report]));
}

/**
 * Uniform machine-surface exit codes for preview, apply, and status:
 * - `0` — no tool error and no blockers (may still be `outcome: "attention"`)
 * - `2` — blockers present
 * Tool errors stay exit `1` and use {@link formatLifecycleToolErrorJson} under `--json`.
 */
export function lifecycleExitCode(
  report: { readonly blockers: readonly unknown[] },
): 0 | 2 {
  return report.blockers.length > 0 ? 2 : 0;
}

type MachineOutcome = "attention" | "blocked" | "clean" | "error";

interface MachineInstallation {
  readonly canonicalProject: string;
  readonly hosts?: readonly string[];
  readonly profile?: string;
  readonly project: string;
  readonly reason?: string;
  readonly state: ReconciliationKind | "unknown";
}

interface MachineOutput {
  readonly kind: OutputReconciliationKind;
  readonly path: string;
  readonly project: string;
}

interface MachineImpact {
  readonly artifacts?: readonly { readonly id: string; readonly type: string }[];
  readonly hosts: readonly string[];
  readonly kind: LifecycleImpactKind;
  readonly operation: LifecycleImpactOperation;
  readonly paths: readonly string[];
  readonly profile: string;
  readonly project: string;
  readonly reason: string;
}

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

interface MachineRepositoryExclusion {
  readonly current: readonly string[];
  readonly next: readonly string[];
  readonly target: string;
}

interface MachineRepositoryExclusionRepair {
  readonly entries: readonly string[];
  readonly target: string;
}

interface LifecycleMachineSnapshot {
  readonly impacts: readonly MachineImpact[];
  readonly installations: readonly MachineInstallation[];
  readonly outputs: readonly MachineOutput[];
  readonly repositoryExclusionRepairs: readonly MachineRepositoryExclusionRepair[];
  readonly repositoryExclusions: readonly MachineRepositoryExclusion[];
}

interface LifecycleMachinePayload extends LifecycleMachineSnapshot {
  readonly applied?: LifecycleMachineSnapshot;
  readonly blockers: readonly MachineBlocker[];
  readonly command: LifecycleCommand;
  readonly error?: string;
  readonly outcome: MachineOutcome;
  readonly schemaVersion: 2;
  readonly setupSteps: readonly MachineSetupStep[];
  readonly warnings: readonly string[];
}

function machineOutcome(report: ReconciliationReport): Exclude<MachineOutcome, "error"> {
  if (report.blockers.length > 0) return "blocked";
  if (
    report.items.some((item) => item.kind !== "current") ||
    report.outputs.some((output) => output.kind !== "unchanged")
  ) {
    return "attention";
  }
  return "clean";
}

/**
 * Map every authored or canonical project spelling onto one canonical identity
 * at this boundary, so downstream readers never need a dual-key fallback.
 */
function canonicalProjectMap(
  report: ReconciliationReport,
): ReadonlyMap<string, string> {
  const canonicalByProject = new Map<string, string>();
  for (const installation of report.desired) {
    canonicalByProject.set(installation.canonicalProject, installation.canonicalProject);
    canonicalByProject.set(installation.project, installation.canonicalProject);
  }
  for (const item of report.items) {
    if (!canonicalByProject.has(item.project)) {
      canonicalByProject.set(item.project, item.project);
    }
  }
  for (const output of report.outputs) {
    if (!canonicalByProject.has(output.project)) {
      canonicalByProject.set(output.project, output.project);
    }
  }
  return canonicalByProject;
}

function machineInstallations(report: ReconciliationReport): readonly MachineInstallation[] {
  const canonicalByProject = canonicalProjectMap(report);
  const itemsByCanonical = new Map<string, ReconciliationItem>();
  for (const item of report.items) {
    const canonical = canonicalByProject.get(item.project) ?? item.project;
    if (!itemsByCanonical.has(canonical)) itemsByCanonical.set(canonical, item);
  }
  const desiredCanonicals = new Set(
    report.desired.map((installation) => installation.canonicalProject),
  );
  const installations: MachineInstallation[] = report.desired.map((installation) => {
    const item = itemsByCanonical.get(installation.canonicalProject);
    return {
      canonicalProject: installation.canonicalProject,
      hosts: installation.hosts,
      profile: installation.profile,
      project: installation.project,
      ...(item?.reason === undefined ? {} : { reason: item.reason }),
      state: item?.kind ?? "unknown",
    };
  });
  for (const [canonical, item] of itemsByCanonical) {
    if (desiredCanonicals.has(canonical)) continue;
    installations.push({
      canonicalProject: canonical,
      project: item.project,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
      state: item.kind,
    });
  }
  return installations.sort((left, right) =>
    left.canonicalProject.localeCompare(right.canonicalProject)
  );
}

function machineOutputs(report: ReconciliationReport): readonly MachineOutput[] {
  return [...report.outputs]
    .map((output) => ({
      kind: output.kind,
      path: output.path,
      project: output.project,
    }))
    .sort((left, right) =>
      left.project.localeCompare(right.project) || left.path.localeCompare(right.path)
    );
}

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

function machineBlockers(report: ReconciliationReport): readonly MachineBlocker[] {
  return report.blockers.map(machineBlocker);
}

function machineSetupSteps(report: ReconciliationReport): readonly MachineSetupStep[] {
  const steps: MachineSetupStep[] = [];
  for (const installation of report.desired) {
    for (const step of installation.setupSteps) {
      const output = setupStepOutput(step);
      steps.push({
        host: step.host,
        kind: step.kind,
        message: step.message,
        provenance: step.provenance,
        ...(output === undefined ? {} : { output }),
        ...(step.consequence === undefined ? {} : { consequence: step.consequence }),
        ...(step.path === undefined ? {} : { path: step.path, project: installation.project }),
      });
    }
  }
  return steps.sort((left, right) =>
    left.host.localeCompare(right.host) ||
    HOST_SETUP_STEP_ORDER.indexOf(left.kind) - HOST_SETUP_STEP_ORDER.indexOf(right.kind) ||
    left.message.localeCompare(right.message)
  );
}

function machineRepositoryExclusions(
  report: ReconciliationReport,
): readonly MachineRepositoryExclusion[] {
  return [...report.repositoryExclusions]
    .map((change) => ({
      current: [...change.current],
      next: [...change.next],
      target: change.target,
    }))
    .sort((left, right) => left.target.localeCompare(right.target));
}

function machineRepositoryExclusionRepairs(
  report: ReconciliationReport,
): readonly MachineRepositoryExclusionRepair[] {
  return [...report.repositoryExclusionRepairs]
    .map((repair) => ({
      entries: [...repair.entries],
      target: repair.target,
    }))
    .sort((left, right) => left.target.localeCompare(right.target));
}

function machineImpacts(report: ReconciliationReport): readonly MachineImpact[] {
  return report.impacts.map((impact: LifecycleImpact) => ({
    kind: impact.kind,
    operation: impact.operation,
    project: impact.project,
    profile: impact.profile,
    hosts: [...impact.hosts],
    paths: [...impact.paths],
    ...(impact.artifacts === undefined
      ? {}
      : {
          artifacts: impact.artifacts.map((artifact) => ({
            id: artifact.id,
            type: artifact.type,
          })),
        }),
    reason: impact.reason,
  }));
}

function machineSnapshot(report: ReconciliationReport): LifecycleMachineSnapshot {
  return {
    impacts: machineImpacts(report),
    installations: machineInstallations(report),
    outputs: machineOutputs(report),
    repositoryExclusions: machineRepositoryExclusions(report),
    repositoryExclusionRepairs: machineRepositoryExclusionRepairs(report),
  };
}

function lifecycleMachinePayload(
  command: LifecycleCommand,
  report: ReconciliationReport,
  applied?: ReconciliationReport,
): LifecycleMachinePayload {
  return {
    schemaVersion: 2,
    command,
    outcome: machineOutcome(report),
    ...machineSnapshot(report),
    ...(applied === undefined ? {} : { applied: machineSnapshot(applied) }),
    blockers: machineBlockers(report),
    warnings: [...report.warnings],
    setupSteps: machineSetupSteps(report),
  };
}

function serializeMachinePayload(payload: LifecycleMachinePayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function formatLifecycleJson(
  command: Exclude<LifecycleCommand, "apply">,
  report: ReconciliationReport,
): string {
  return serializeMachinePayload(lifecycleMachinePayload(command, report));
}

export function formatApplyJson(result: ApplyReconciliationResult): string {
  return serializeMachinePayload(
    lifecycleMachinePayload("apply", result.resultingState, result.receipt),
  );
}

export function formatBlockedApplyJson(report: BlockedReconciliationReport): string {
  return serializeMachinePayload(lifecycleMachinePayload("apply", report));
}

export function formatApplyVerificationFailureJson(
  receipt: ReconciliationReport,
  message: string,
): string {
  return serializeMachinePayload({
    ...lifecycleMachinePayload("apply", receipt, receipt),
    outcome: "error",
    error: message,
  });
}

/** Machine envelope for tool failures under `--json` (exit `1`). Parse stdout only when present. */
export function formatLifecycleToolErrorJson(
  command: LifecycleCommand,
  message: string,
): string {
  return serializeMachinePayload({
    schemaVersion: 2,
    command,
    outcome: "error",
    error: message,
    installations: [],
    impacts: [],
    outputs: [],
    repositoryExclusions: [],
    repositoryExclusionRepairs: [],
    blockers: [],
    warnings: [],
    setupSteps: [],
  });
}

export type TemporaryInstallCommand = "install-temp" | "remove-temp";

export interface TemporaryInstallationReceiptView {
  readonly adapterVersion: string;
  readonly completionState: "installed" | "removed";
  readonly engineVersion: string;
  readonly host: string;
  readonly hostVersion: string;
  readonly outputs: readonly string[];
  readonly profileId: string;
  readonly project: string;
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
  readonly workspaceInputHash: string;
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
      schemaVersion: 1,
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
        temporarySetupStepJson(step, receipt.project)
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
  const project = displayProjectPath(receipt.project, receipt.project, cwd, home);
  if (command === "install-temp") {
    const warningLines = receipt.warnings.length === 0
      ? []
      : [
          "Warnings:",
          ...receipt.warnings.map((warning) => `- ${warning}`),
        ];
    const setupLines = receipt.setupSteps.length === 0
      ? []
      : [
          `${capitalize(receipt.host)} setup:`,
          ...[...receipt.setupSteps]
            .sort((left, right) =>
              HOST_SETUP_STEP_ORDER.indexOf(left.kind) -
                HOST_SETUP_STEP_ORDER.indexOf(right.kind) ||
              left.message.localeCompare(right.message)
            )
            .flatMap((step) => {
              const message = setupStepMessage(step, project);
              return [
                `- ${message}`,
                ...(step.consequence === undefined
                  ? []
                  : [`  Consequence: ${step.consequence}`]),
              ];
            }),
        ];
    return responsiveLifecycleOutput((
      `Installed Profile temporarily\n` +
      `  Profile: ${receipt.profileId}\n` +
      `  Host: ${receipt.host}\n` +
      `  Project: ${project}\n` +
      `  Temporary installation: ${receipt.temporaryInstallationId}\n` +
      (warningLines.length > 0 ? `${warningLines.join("\n")}\n` : "") +
      (setupLines.length > 0 ? `${setupLines.join("\n")}\n` : "")
    ), options.context, [
      project,
      receipt.temporaryInstallationId,
      receipt.profileId,
      ...receipt.diagnosticValues,
      ...receipt.outputs,
    ]);
  }
  return responsiveLifecycleOutput((
    `Removed temporary Profile installation\n` +
    `  Temporary installation: ${receipt.temporaryInstallationId}\n` +
    `  Project: ${project}\n`
  ), options.context, [
    project,
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
      schemaVersion: 2,
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
      schemaVersion: 1,
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
