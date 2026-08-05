import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import type { HostSetupStep, HostSetupStepKind } from "../adapters/project-plan.js";
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
import { REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX } from "../installer/git-exclusions.js";
import { COMMAND_NAME } from "../installer/version.js";
import type { MissingProfileError } from "../installer/profile-selection.js";
import type { UninstallResult, ValidationResult } from "../installer/commands.js";
import type {
  ApplicationInfo,
  ApplicationInfoLocations,
  InfoConfigurationState,
} from "../installer/info.js";
import { compareCanonicalStrings } from "../schemas/installation-manifest.js";

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
  const cwdRelativePath = paths.find((path) => containsPath(path, cwd));
  if (cwdRelativePath) return relative(cwd, cwdRelativePath) || ".";
  if (authoredPath === "~" || authoredPath.startsWith("~/")) return authoredPath;
  const homeRelativePath = paths.find((path) => containsPath(home, path));
  if (homeRelativePath) {
    const homeRelative = relative(home, homeRelativePath);
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
  return (
    `Engine version: ${info.engineVersion}\n` +
    `Workspace: ${workspace}\n` +
    `Local Configuration: ${displayPath(info.localConfiguration, info.localConfiguration, cwd, home)}\n` +
    `Installation State: ${displayPath(info.installationState, info.installationState, cwd, home)}\n`
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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled output kind: ${String(value)}`);
}

export function formatValidationResult(result: ValidationResult): string {
  const profileCount = result.profiles.length;
  return `Workspace and Local Configuration valid (` +
    `${plural(profileCount, "Profile")}, ${plural(result.bindings, "Project Binding")})\n` +
    `Profiles found: ${profileCount === 0 ? "none" : result.profiles.join(", ")}\n` +
    `Hosts bound: ${result.hosts.length === 0 ? "none" : result.hosts.join(", ")}\n` +
    result.warnings.map((warning) => `Warning: ${warning}\n`).join("");
}

export function formatUninstallResult(result: UninstallResult): string {
  const projectCount = result.projects.length;
  const lines = [
    projectCount === 0
      ? "No installed Projects to uninstall."
      : `Uninstalled ${plural(projectCount, "Project")}.`,
  ];
  for (const project of result.projects) {
    lines.push(
      "",
      `Project: ${displayProjectPath(project.project)}`,
      "  Removed generated paths:",
      ...project.outputs.map((path) => `  - ${path}`),
    );
    if (project.repositoryExclusions.length > 0) {
      lines.push(
        "  Cleaned Git exclusions:",
        ...project.repositoryExclusions.flatMap((exclusion) =>
          exclusion.entries.map((entry) => `  - ${entry} (${exclusion.target})`)
        ),
      );
    }
  }
  lines.push("", "Project Bindings preserved.");
  if (projectCount > 0) {
    lines.push(`Next: Run ${COMMAND_NAME} unbind for bindings you no longer want, or ${COMMAND_NAME} apply to reinstall.`);
  }
  return `${lines.join("\n")}\n`;
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
        `… ${overflow} more ${overflow === 1 ? "file" : "files"}; use --verbose to see all paths`,
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
  return references.reduce((rendered, reference) => {
    const { project, replacement } = reference;
    let cursor = 0;
    let formatted = "";
    while (cursor < rendered.length) {
      const index = rendered.indexOf(project, cursor);
      if (index < 0) return formatted + rendered.slice(cursor);
      const previous = rendered[index - 1];
      const next = rendered[index + project.length];
      const startsAtBoundary = index === 0 || previous === undefined || /[\s("'=:/]/.test(previous);
      const endsAtBoundary = next === undefined || /[\s)"':/,;]/.test(next);
      if (!startsAtBoundary || !endsAtBoundary) {
        formatted += rendered.slice(cursor, index + 1);
        cursor = index + 1;
        continue;
      }
      const cwdChild = replacement === "." && next === "/";
      formatted += rendered.slice(cursor, index) + (cwdChild ? "" : replacement);
      cursor = index + project.length + (cwdChild ? 1 : 0);
    }
    return formatted;
  }, message);
}

function formatProjectPaths(message: string, projects: readonly string[]): string {
  return projects.reduce(removeProjectPathPrefix, message);
}

function formatBlocker(blocker: ReconciliationBlocker, displayProject?: string): string {
  const projects = projectCandidates(blocker, displayProject);
  const message = formatProjectPaths(stripProjectPrefix(blocker.message, projects), projects);
  const trackedSuffix = " is a tracked project path";
  if (message.endsWith(trackedSuffix)) {
    const path = message.slice(0, -trackedSuffix.length);
    return (
      `Tracked project path '${path}' is repository-owned. Agent Profile Kit cannot replace it ` +
      `because ${DEFAULT_VIEW_LEXICON.generatedOutput.plural} must be exclusively ` +
      `${DEFAULT_VIEW_LEXICON.installerOwned.postpositive}.`
    );
  }
  return defaultDiagnosticText(message);
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

function groupHasReconciliationWork(group: ProjectGroup | undefined): boolean {
  if (group === undefined) return false;
  return (
    group.blockers.length > 0 ||
    changeCount(summarizeOutputs(group.outputs)) > 0 ||
    group.items.some((item) => item.kind !== "current")
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

function outcomeLine(
  command: LifecycleCommand,
  report: ReconciliationReport,
  applyCompleted = false,
): string {
  if (command === "preview") return report.blockers.length > 0 ? "Cannot apply" : "Ready to apply";
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
): string {
  const installations = groups.length;
  if (report.blockers.length > 0) {
    const pending = command === "apply" ? " · Pending: blocked" : "";
    return (
      `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)}: ${installations}${pending} · ` +
      `Blockers: ${report.blockers.length}`
    );
  }
  const summary = summarizeOutputs(report.outputs);
  const changes = changeParts(summary);
  const workLabel = command === "apply" ? "Pending" : "Changes";
  return (
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)}: ${installations} · ` +
    `${workLabel}: ${changes.length === 0 ? "none" : changes.join(", ")} · ` +
    `Blockers: ${report.blockers.length}`
  );
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

function hostSetupLines(
  command: LifecycleCommand,
  report: ReconciliationReport,
): readonly string[] {
  if (command !== "status" && report.blockers.length > 0) return [];
  const visibleKinds = command === "preview"
    ? new Set<HostSetupStepKind>(["approval-required", "launch-constraint"])
    : new Set<HostSetupStepKind>(HOST_SETUP_STEP_ORDER);
  const byHost = new Map<string, Map<string, HostSetupStep>>();
  const intentionallyUninstalledProjects = new Set(
    report.items
      .filter((item) => item.kind === "intended teardown")
      .map((item) => item.project),
  );
  for (const installation of report.desired) {
    if (
      command === "status" &&
      intentionallyUninstalledProjects.has(installation.project)
    ) {
      continue;
    }
    for (const step of installation.setupSteps) {
      if (!visibleKinds.has(step.kind)) continue;
      const message = step.path === "bound-project"
        ? `${step.message} ${displayProjectPath(
          installation.canonicalProject,
          installation.project,
        )}`
        : step.message;
      const renderedStep = { ...step, message };
      const steps = byHost.get(step.host) ?? new Map<string, HostSetupStep>();
      steps.set(`${step.kind}\0${message}\0${step.consequence ?? ""}`, renderedStep);
      byHost.set(step.host, steps);
    }
  }
  return [...byHost.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([host, steps]) => [
      `${capitalize(host)} setup:`,
      ...[...steps.values()]
        .sort((left, right) =>
          HOST_SETUP_STEP_ORDER.indexOf(left.kind) - HOST_SETUP_STEP_ORDER.indexOf(right.kind) ||
          left.message.localeCompare(right.message)
        )
        .map((step) =>
          `- ${step.message}${step.consequence ? ` Consequence: ${step.consequence}` : ""}`
        ),
    ]);
}

function activationLines(
  report: ReconciliationReport,
  receipt: ReconciliationReport,
): readonly string[] {
  const changedProjects = new Set(
    receipt.items.filter((item) => item.kind !== "current").map((item) => item.project),
  );
  return [...report.desired]
    .filter((installation) => changedProjects.has(installation.project))
    .sort((left, right) => left.canonicalProject.localeCompare(right.canonicalProject))
    .map((installation) => {
      const setupCondition = installation.setupSteps.some((step) =>
          ACTIONABLE_HOST_SETUP_STEP_KINDS.has(step.kind)
        )
        ? "After completing the Host setup above, "
        : "No further Host setup is required. ";
      return `${setupCondition}Profile ${installation.profile} becomes active on the next launch ` +
        `of each bound Host (${installation.hosts.join(", ")}) from ` +
        `${displayProjectPath(installation.canonicalProject, installation.project)}.`;
    });
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
  const actions = surface.groups.flatMap((group) => {
    const project = displayProjectPath(group.canonicalProject, group.project);
    if (group.blockers.length > 0) {
      const blockerWord = group.blockers.length === 1 ? "blocker" : "blockers";
      return [`${project}: Resolve the reported ${blockerWord}, then run ${COMMAND_NAME} ${command} again.`];
    }
    if (!groupNeedsAttention(group, command)) return [];
    if (report.blockers.length > 0 && globalBlockers.length === 0) {
      if (command === "status") {
        return [
          `${project}: After all blockers are resolved, run ${COMMAND_NAME} preview to review its ` +
          "planned changes (read-only), then apply when ready.",
        ];
      }
      return [
        `${project}: After all blockers are resolved, run ${COMMAND_NAME} apply` +
        `${command === "apply" ? " again" : ""}.`,
      ];
    }
    if (globalBlockers.length > 0) return [];
    if (command === "status") {
      return [
        `${project}: Run ${COMMAND_NAME} preview to review its planned changes (read-only), then apply when ready.`,
      ];
    }
    return [`${project}: Run ${COMMAND_NAME} apply.`];
  });

  if (globalBlockers.length > 0) {
    const blockerWord = globalBlockers.length === 1 ? "blocker" : "blockers";
    actions.push(`Resolve the reported global ${blockerWord}, then run ${COMMAND_NAME} ${command} again.`);
  }
  if (
    report.blockers.length === 0 &&
    surface.unscopedItems.some((item) => item.kind !== "current")
  ) {
    actions.push(
      command === "status"
        ? `Run ${COMMAND_NAME} preview to review the planned changes (read-only), then apply when ready.`
        : `Run ${COMMAND_NAME} apply.`,
    );
  }
  return actions.length === 0 ? [] : ["Next:", ...actions.map((action) => `- ${action}`)];
}

function applyReceiptLines(receipt: ReconciliationReport): readonly string[] {
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
  const fullyCurrentStatus = command === "status" && fullyCurrentProjectCount(report) !== undefined;
  const lines = [outcomeLine(command, report, receipt !== undefined)];
  if (!blocked && !fullyCurrentStatus) lines.push(aggregateLine(command, report, groups));
  const receiptGroups = receipt === undefined
    ? new Map<string, ProjectGroup>()
    : new Map(groupProjects(receipt).groups.map((group) => [group.canonicalProject, group]));
  const receiptHasRepositoryWork = receipt !== undefined && (
    changedRepositoryExclusions(receipt).length > 0 ||
    receipt.repositoryExclusionRepairs.length > 0
  );
  const showSingleCurrentGroup = command === "apply" && receiptHasRepositoryWork && groups.length === 1;
  const activeGroups = blocked
    ? groups.filter((group) => group.blockers.length > 0)
    : groups.filter((group) =>
        groupNeedsAttention(group, command) ||
        (command === "apply" && groupHasReconciliationWork(receiptGroups.get(group.canonicalProject))) ||
        (showSingleCurrentGroup && group.items.every((item) => item.kind === "current")),
      );

  if (activeGroups.length === 0) {
    if (groups.length > 0 && report.blockers.length === 0 && !fullyCurrentStatus) {
      const projects = capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural);
      lines.push(
        command === "apply"
          ? `All ${projects} were already current.`
          : command === "preview"
            ? `Nothing to ${DEFAULT_VIEW_LEXICON.reconciliation.base}; all ${projects} are current.`
            : `No ${projects} need attention.`,
      );
    }
  } else {
    for (const group of activeGroups) {
      const receiptGroup = receiptGroups.get(group.canonicalProject);
      const receiptHasWork = command === "apply" && groupHasReconciliationWork(receiptGroup);
      const showCurrentState = receiptHasWork || showSingleCurrentGroup;
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
          lines.push(`  Blocker: ${shortenProjectReferences(formatBlocker(blocker, group.project), groups)}`);
        }
        continue;
      }
      for (const item of group.items) {
        if (
          item.kind !== "current" ||
          (command === "apply" && showCurrentState)
        ) {
          lines.push(`  State: ${itemText(item)}`);
        }
      }
      const outputLines = outputPathLines(group.outputs);
      if (outputLines.length > 0) lines.push("  Files:", ...outputLines.map((line) => `  ${line}`));
      for (const blocker of group.blockers) {
        lines.push(`  Blocker: ${shortenProjectReferences(formatBlocker(blocker, group.project), groups)}`);
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
  if (blocked) lines.push("", aggregateLine(command, report, groups));
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
  const setup = hostSetupLines(command, report);
  if (setup.length > 0) lines.push("", ...setup);
  const next = nextActionLines(command, report, {
    groups,
    unscopedItems: grouped.unscopedItems,
  });
  if (next.length > 0) lines.push("", ...next);
  if (receipt) lines.push("", ...applyReceiptLines(receipt));
  if (command === "apply" && report.blockers.length === 0) {
    const activation = receipt ? activationLines(report, receipt) : [];
    if (activation.length > 0) lines.push("", ...activation);
  }
  return `${lines.join("\n")}\n`;
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
    : report.blockers.map((blocker) => `- ${shorten(blocker.message)}`).join("\n");
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
  const setup = hostSetupLines(command, report);
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
    ? activationLines(result.resultingState, result.receipt)
    : [];
  return activation.length > 0 ? `${report}\n${activation.join("\n")}\n` : report;
}

export function formatApplyReport(
  result: ApplyReconciliationResult,
  options: { readonly verbose?: boolean } = {},
): string {
  return options.verbose
    ? verboseApplyReport(result)
    : conciseReport("apply", result.resultingState, result.receipt);
}

export function formatApplyVerificationFailure(
  receipt: ReconciliationReport,
  message: string,
  options: { readonly verbose?: boolean } = {},
): string {
  if (options.verbose) {
    return `${message}\nApplied:\n${verboseSections(receipt, {
      completedRepositoryExclusions: true,
    })}` +
      verboseSetupSection("apply", receipt);
  }
  const lines = [
    defaultDiagnosticText(message),
    ...applyReceiptLines(receipt),
  ];
  const setup = hostSetupLines("apply", receipt);
  if (setup.length > 0) lines.push("", ...setup);
  return `${lines.join("\n")}\n`;
}

export function formatBlockedApplyReport(
  report: BlockedReconciliationReport,
  options: { readonly verbose?: boolean } = {},
): string {
  return options.verbose ? verboseReport("apply", report) : conciseReport("apply", report);
}

export function formatLifecycleReport(
  command: Exclude<LifecycleCommand, "apply">,
  report: ReconciliationReport,
  options: { readonly verbose?: boolean } = {},
): string {
  return options.verbose ? verboseReport(command, report) : conciseReport(command, report);
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

interface MachineBlocker {
  readonly message: string;
  readonly project?: string;
}

interface MachineSetupStep {
  readonly consequence?: string;
  readonly host: string;
  readonly kind: HostSetupStepKind;
  readonly message: string;
  readonly path?: "bound-project";
  readonly project?: string;
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
  readonly schemaVersion: 1;
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

function machineBlockers(report: ReconciliationReport): readonly MachineBlocker[] {
  return report.blockers.map((blocker) => (
    blocker.project === undefined
      ? { message: blocker.message }
      : { message: blocker.message, project: blocker.project }
  ));
}

function machineSetupSteps(report: ReconciliationReport): readonly MachineSetupStep[] {
  const steps: MachineSetupStep[] = [];
  for (const installation of report.desired) {
    for (const step of installation.setupSteps) {
      steps.push({
        host: step.host,
        kind: step.kind,
        message: step.message,
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

function machineSnapshot(report: ReconciliationReport): LifecycleMachineSnapshot {
  return {
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
    schemaVersion: 1,
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
    schemaVersion: 1,
    command,
    outcome: "error",
    error: message,
    installations: [],
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
  readonly warnings: readonly string[];
  readonly workspaceInputHash: string;
}

function temporarySetupStepMessage(
  step: HostSetupStep,
  project: string,
): string {
  return step.path === "bound-project" ? `${step.message} ${project}` : step.message;
}

function temporarySetupStepJson(step: HostSetupStep, project: string) {
  return {
    host: step.host,
    kind: step.kind,
    message: temporarySetupStepMessage(step, project),
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
): string {
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
            .map((step) => {
              const message = temporarySetupStepMessage(step, receipt.project);
              return `- ${message}${
                step.consequence ? ` Consequence: ${step.consequence}` : ""
              }`;
            }),
        ];
    return (
      `Installed Profile temporarily\n` +
      `  Profile: ${receipt.profileId}\n` +
      `  Host: ${receipt.host}\n` +
      `  Project: ${receipt.project}\n` +
      `  Temporary installation: ${receipt.temporaryInstallationId}\n` +
      (warningLines.length > 0 ? `${warningLines.join("\n")}\n` : "") +
      (setupLines.length > 0 ? `${setupLines.join("\n")}\n` : "")
    );
  }
  return (
    `Removed temporary Profile installation\n` +
    `  Temporary installation: ${receipt.temporaryInstallationId}\n` +
    `  Project: ${receipt.project}\n`
  );
}

export function formatTemporaryInstallationBlockedJson(
  command: TemporaryInstallCommand,
  blockers: readonly string[],
): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      command,
      outcome: "blocked",
      blockers: blockers.map((message) => ({ message })),
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
