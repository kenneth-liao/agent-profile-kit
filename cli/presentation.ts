import type {
  ApplyReconciliationResult,
  OutputReconciliationItem,
  ReconciliationBlocker,
  ReconciliationItem,
  ReconciliationKind,
  ReconciliationReport,
} from "../installer/reconcile.js";
import { REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX } from "../installer/git-exclusions.js";
import { COMMAND_NAME } from "../installer/version.js";

export type LifecycleCommand = "preview" | "apply" | "status";

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
    localPlural: "Git-local exclusions",
    plural: "Git exclusions",
    singular: "Git exclusion",
  },
  repositoryExclusionRecord: { singular: "Git exclusion record", plural: "Git exclusion records" },
} as const;

function capitalize(text: string): string {
  return `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

function preserveInitialCase(source: string, replacement: string): string {
  return source[0] === source[0]?.toUpperCase()
    ? capitalize(replacement)
    : replacement;
}

function defaultViewText(text: string): string {
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
    [/\bProfile Installations\b/gi, DEFAULT_VIEW_LEXICON.profileInstallation.plural],
    [/\bProfile Installation\b/gi, DEFAULT_VIEW_LEXICON.profileInstallation.singular],
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
  readonly updates: number;
  readonly repairs: number;
  readonly removals: number;
  readonly drift: number;
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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function summarizeOutputs(outputs: readonly OutputReconciliationItem[]): OutputSummary {
  return outputs.reduce<OutputSummary>(
    (summary, output) => {
      if (output.kind === "addition") return { ...summary, additions: summary.additions + 1 };
      if (output.kind === "update") return { ...summary, updates: summary.updates + 1 };
      if (output.kind === "removal") return { ...summary, removals: summary.removals + 1 };
      if (output.kind === "repair") return { ...summary, repairs: summary.repairs + 1 };
      if (output.kind === "unchanged") return summary;
      return { ...summary, drift: summary.drift + 1 };
    },
    { additions: 0, updates: 0, repairs: 0, removals: 0, drift: 0 },
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

function changedRepositoryExclusions(report: ReconciliationReport): readonly ReconciliationReport["repositoryExclusions"][number][] {
  return report.repositoryExclusions.filter((change) =>
    change.current.length !== change.next.length ||
    change.current.some((entry, index) => entry !== change.next[index]),
  );
}

function repairedRepositoryExclusionLines(report: ReconciliationReport): readonly string[] {
  return report.repositoryExclusionRepairs.map((repair) => {
    const count = repair.entries.length;
    return `${repair.target}: restored ${count} recorded Repository Exclusion ${count === 1 ? "entry" : "entries"}`;
  });
}

function defaultRepositoryExclusionDescription(): string {
  return `${DEFAULT_VIEW_LEXICON.repositoryExclusion.localPlural} that keep ` +
    `${DEFAULT_VIEW_LEXICON.generatedOutput.paths} ${DEFAULT_VIEW_LEXICON.installerOwned.postpositive} untracked.`;
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

function projectCandidates(blocker: ReconciliationBlocker, displayProject?: string): string[] {
  return [...new Set([blocker.project, displayProject].filter((project): project is string => project !== undefined))];
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
    if (blocker.project) {
      const canonicalProject = canonicalByProject.get(blocker.project) ?? blocker.project;
      ensureGroup(canonicalProject, blocker.project).blockers.push(blocker);
    }
  }
  const groups = [...groupsByCanonical.values()].sort((left, right) => left.project.localeCompare(right.project));
  return { groups, unscopedItems };
}

function desiredProfile(report: ReconciliationReport, project: string): string | undefined {
  return report.desired.find((installation) =>
    installation.canonicalProject === project || installation.project === project,
  )?.profile;
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

function outcomeLine(command: LifecycleCommand, report: ReconciliationReport): string {
  if (command === "preview") return report.blockers.length > 0 ? "Cannot apply" : "Ready to apply";
  if (command === "apply") {
    if (report.blockers.length > 0) return "Apply completed with blockers";
    if (report.items.some((item) => item.kind !== "current")) return "Apply completed with attention";
    return "Apply complete";
  }
  if (report.blockers.length > 0 || report.items.some((item) => item.kind !== "current")) {
    return "Attention required";
  }
  const projects = capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural);
  return report.items.length === 0
    ? `No ${projects} are configured`
    : `All ${projects} are current`;
}

function aggregateLine(report: ReconciliationReport, groups: readonly ProjectGroup[]): string {
  const installations = groups.length;
  const summary = summarizeOutputs(report.outputs);
  const changes = changeParts(summary);
  return (
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)}: ${installations} · ` +
    `Changes: ${changes.length === 0 ? "none" : changes.join(", ")} · ` +
    `Blockers: ${report.blockers.length}`
  );
}

function warningsForPresentation(
  command: LifecycleCommand,
  warnings: readonly string[],
): readonly string[] {
  if (command !== "apply") return warnings;
  // A successful apply has repaired this preflight condition; omit the stale
  // completion guidance while leaving the canonical report unchanged.
  return warnings.filter(
    (warning) => !warning.endsWith(REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX),
  );
}

/**
 * One aggregate next-action instruction for concise lifecycle results.
 * Derives from the same attention surface already computed for the report body
 * (active groups + unscoped diagnostics + blockers) — not a third "actionable" predicate.
 * Blockers take precedence; completed/no-op apply is silent after the blocker branch.
 */
function nextActionLine(
  command: LifecycleCommand,
  report: ReconciliationReport,
  surface: {
    readonly activeGroups: readonly ProjectGroup[];
    readonly unscopedItems: readonly ReconciliationItem[];
  },
): string | undefined {
  if (report.blockers.length > 0) {
    const blockerWord = report.blockers.length === 1 ? "blocker" : "blockers";
    // Same command the user just ran (status, preview, or apply) so the retry
    // invariant is structural — not parallel prose strings that can drift.
    return `Next: Resolve the reported ${blockerWord}, then run ${COMMAND_NAME} ${command} again.`;
  }

  // Completed or no-op apply: reconciliation already ran; do not recommend more work.
  if (command === "apply") return undefined;

  const hasActionableWork =
    surface.activeGroups.length > 0 ||
    surface.unscopedItems.some((item) => item.kind !== "current");

  if (!hasActionableWork) return undefined;

  if (command === "status") {
    return `Next: Run ${COMMAND_NAME} preview to review the planned changes (read-only), then apply when ready.`;
  }
  return `Next: Run ${COMMAND_NAME} apply to ${DEFAULT_VIEW_LEXICON.reconciliation.base} ` +
    `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)}.`;
}

function applyReceiptLines(receipt: ReconciliationReport): readonly string[] {
  const grouped = groupProjects(receipt);
  const entries = grouped.groups.flatMap((group) => {
    const changes = changeParts(summarizeOutputs(group.outputs));
    if (changes.length > 0) return [`- ${group.project}: ${changes.join(", ")}`];
    const workKinds = [...new Set(
      group.items
        .filter((item) => item.kind !== "current")
        .map((item) => item.kind === "update"
          ? `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)} update`
          : `${DEFAULT_VIEW_LEXICON.reconciliation.noun} ${item.kind}`),
    )];
    return workKinds.length > 0 ? [`- ${group.project}: ${workKinds.join(", ")}`] : [];
  });
  const exclusionChanges = changedRepositoryExclusions(receipt);
  const exclusionRepairs = repairedRepositoryExclusionLines(receipt).map(defaultViewText);
  if (entries.length === 0 && exclusionChanges.length === 0 && exclusionRepairs.length === 0) {
    return [
      `Apply receipt: no changes were applied; all ` +
      `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.plural)} were already current.`,
    ];
  }

  const lines = [
    "Apply receipt:",
    ...(entries.length > 0 ? entries : [`- No ${DEFAULT_VIEW_LEXICON.generatedOutput.singular} changes`]),
  ];
  if (exclusionChanges.length > 0 || exclusionRepairs.length > 0) {
    lines.push(
      "",
      `${capitalize(DEFAULT_VIEW_LEXICON.repositoryExclusion.plural)} completed:`,
      defaultRepositoryExclusionDescription(),
    );
    for (const change of exclusionChanges) {
      lines.push(`- ${change.target}: ${exclusionDeltaText(change)}`);
    }
    for (const repair of exclusionRepairs) lines.push(`- ${repair}`);
  }
  return lines;
}

function conciseReport(
  command: LifecycleCommand,
  report: ReconciliationReport,
  receipt?: ReconciliationReport,
): string {
  const grouped = groupProjects(report);
  const groups = grouped.groups;
  const lines = [outcomeLine(command, report), aggregateLine(report, groups)];
  const receiptGroups = receipt === undefined
    ? new Map<string, ProjectGroup>()
    : new Map(groupProjects(receipt).groups.map((group) => [group.canonicalProject, group]));
  const receiptHasRepositoryWork = receipt !== undefined && (
    changedRepositoryExclusions(receipt).length > 0 ||
    repairedRepositoryExclusionLines(receipt).length > 0
  );
  const showSingleCurrentGroup = command === "apply" && receiptHasRepositoryWork && groups.length === 1;
  const activeGroups = groups.filter((group) =>
    groupNeedsAttention(group, command) ||
    (command === "apply" && groupHasReconciliationWork(receiptGroups.get(group.canonicalProject))) ||
    (showSingleCurrentGroup && group.items.every((item) => item.kind === "current")),
  );

  if (activeGroups.length === 0) {
    if (groups.length > 0 && report.blockers.length === 0) {
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
      const summary = summarizeOutputs(group.outputs);
      const receiptGroup = receiptGroups.get(group.canonicalProject);
      const receiptHasWork = command === "apply" && groupHasReconciliationWork(receiptGroup);
      const showCurrentState = receiptHasWork || showSingleCurrentGroup;
      lines.push("", `${capitalize(DEFAULT_VIEW_LEXICON.profileInstallation.singular)}: ${group.project}`);
      const profile = desiredProfile(report, group.project);
      if (profile) lines.push(`  Profile: ${profile}`);
      for (const item of group.items) {
        if (
          item.kind !== "current" ||
          (command === "apply" && showCurrentState)
        ) {
          lines.push(`  State: ${itemText(item)}`);
        }
      }
      const changes = changeParts(summary);
      if (changes.length > 0) lines.push(`  Changes: ${changes.join(", ")}`);
      for (const blocker of group.blockers) lines.push(`  Blocker: ${formatBlocker(blocker, group.project)}`);
    }
  }

  const exclusionChanges = changedRepositoryExclusions(report);
  if (exclusionChanges.length > 0) {
    lines.push(
      "",
      `${capitalize(DEFAULT_VIEW_LEXICON.repositoryExclusion.plural)}:`,
      defaultRepositoryExclusionDescription(),
    );
    for (const change of exclusionChanges) {
      lines.push(`- ${change.target}: ${exclusionDeltaText(change)}`);
    }
  }

  const globalBlockers = report.blockers.filter((blocker) => !blocker.project);
  if (globalBlockers.length > 0) {
    lines.push("", "Global blockers:");
    for (const blocker of globalBlockers) lines.push(`- ${formatBlocker(blocker)}`);
  }
  if (grouped.unscopedItems.length > 0) {
    lines.push("", "Diagnostics:");
    for (const item of grouped.unscopedItems) lines.push(`- ${item.project}: ${itemText(item)}`);
  }
  // After every state line (installations + unscoped diagnostics) so glosses follow the states they explain.
  const explanations = stateExplanationLines([
    ...activeGroups.flatMap((group) => group.items),
    ...grouped.unscopedItems,
  ]);
  if (explanations.length > 0) {
    lines.push("", ...explanations);
  }
  const warnings = warningsForPresentation(command, report.warnings);
  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warnings) lines.push(`- ${defaultDiagnosticText(warning)}`);
  }
  const next = nextActionLine(command, report, {
    activeGroups,
    unscopedItems: grouped.unscopedItems,
  });
  if (next) lines.push("", next);
  if (receipt) lines.push("", ...applyReceiptLines(receipt));
  return `${lines.join("\n")}\n`;
}

function verboseSections(command: LifecycleCommand, report: ReconciliationReport): string {
  const items = report.items.length === 0
    ? "(no Profile Installations)"
    : report.items
        .map((item) => `${item.project}: ${item.kind}${item.reason ? ` (${item.reason})` : ""}`)
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
            `${installation.project}: Profile ${installation.profile}\n` +
            `  Outputs: ${installation.outputs.join(", ")}\n` +
            `${resolved}\n` +
            `  Context:\n${installation.context}`
          );
        })
        .join("\n");
  const blockers = report.blockers.length === 0
    ? "(none)"
    : report.blockers.map((blocker) => `- ${blocker.message}`).join("\n");
  const outputs = report.outputs.length === 0
    ? "(none)"
    : report.outputs
        .map((output) => `${output.project}/${output.path}: ${output.kind}`)
        .join("\n");
  const repositoryExclusions = changedRepositoryExclusions(report).length === 0
    ? "(none)"
    : changedRepositoryExclusions(report)
        .map((change) => `- ${change.target}: ${exclusionDeltaText(change)}`)
        .join("\n");
  const repositoryExclusionRepairs = report.repositoryExclusionRepairs.length === 0
    ? "(none)"
    : repairedRepositoryExclusionLines(report).map((repair) => `- ${repair}`).join("\n");
  const presentationWarnings = warningsForPresentation(command, report.warnings);
  const warnings = presentationWarnings.length === 0
    ? "(none)"
    : presentationWarnings.map((warning) => `- ${warning}`).join("\n");
  return `Projects:\n${items}\nOutputs:\n${outputs}\nRepository Exclusions:\n${repositoryExclusions}\nRepository Exclusion Repairs:\n${repositoryExclusionRepairs}\nDesired State:\n${desired}\nWarnings:\n${warnings}\nBlockers:\n${blockers}\n`;
}

function verboseReport(command: LifecycleCommand, report: ReconciliationReport): string {
  return `${outcomeLine(command, report)}\n${verboseSections(command, report)}`;
}

function verboseApplyReport(result: ApplyReconciliationResult): string {
  return (
    `${outcomeLine("apply", result.resultingState)}\n` +
    `Resulting state:\n${verboseSections("status", result.resultingState)}` +
    `Apply receipt:\n${verboseSections("apply", result.receipt)}`
  );
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
    return `${message}\nApply receipt:\n${verboseSections("apply", receipt)}`;
  }
  return [
    defaultDiagnosticText(message),
    ...applyReceiptLines(receipt),
  ].join("\n") + "\n";
}

export function formatLifecycleReport(
  command: Exclude<LifecycleCommand, "apply">,
  report: ReconciliationReport,
  options: { readonly verbose?: boolean } = {},
): string {
  return options.verbose ? verboseReport(command, report) : conciseReport(command, report);
}
