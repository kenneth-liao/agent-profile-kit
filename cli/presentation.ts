import type {
  OutputReconciliationItem,
  ReconciliationBlocker,
  ReconciliationItem,
  ReconciliationKind,
  ReconciliationReport,
} from "../installer/reconcile.js";

export type LifecycleCommand = "preview" | "apply" | "status";

type NonCurrentKind = Exclude<ReconciliationKind, "current">;

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
    "The Profile Installation is not installed yet; apply will create its Installer-owned generated outputs.",
  update:
    "Desired state changed for this Profile Installation; apply will rewrite Installer-owned generated outputs to match.",
  "stale source":
    "Workspace source changed since the last apply; generated outputs no longer match current desired state.",
  "repairable missing output":
    "An owned generated output is wholly missing, but ownership is proven; apply will recreate it from current Workspace source.",
  "drifted output":
    "An owned generated output no longer matches its Installation Manifest hash and is not treated as a safe automatic rewrite.",
  "malformed ownership state":
    "Ownership metadata is incomplete or inconsistent, so the Installer cannot prove what it owns.",
  blocked:
    "Reconciliation cannot change this Profile Installation until the listed blocker is resolved.",
  removal:
    "No Project Binding remains for this installation; apply will remove proven Installer-owned generated outputs.",
  "missing output":
    "The Profile Installation is absent or its generated outputs are missing without proven Installer ownership; this is not a safe automatic repair.",
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
  if (summary.additions > 0) parts.push(plural(summary.additions, "generated-output addition"));
  if (summary.updates > 0) parts.push(plural(summary.updates, "generated-output update"));
  if (summary.repairs > 0) parts.push(plural(summary.repairs, "generated-output repair"));
  if (summary.removals > 0) parts.push(plural(summary.removals, "generated-output removal"));
  if (summary.drift > 0) parts.push(plural(summary.drift, "generated-output drift item"));
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
      `Tracked project path '${path}' is repository-owned. The Installer cannot replace it ` +
      "because generated Profile Installation output must be exclusively Installer-owned."
    );
  }
  return message;
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

function outcomeLine(command: LifecycleCommand, report: ReconciliationReport): string {
  if (command === "preview") return report.blockers.length > 0 ? "Cannot apply" : "Ready to apply";
  if (command === "apply") return "Apply complete";
  if (report.blockers.length > 0 || report.items.some((item) => item.kind !== "current")) {
    return "Attention required";
  }
  return report.items.length === 0
    ? "No Profile Installations are configured"
    : "All Profile Installations are current";
}

function aggregateLine(report: ReconciliationReport, groups: readonly ProjectGroup[]): string {
  const installations = groups.length;
  const summary = summarizeOutputs(report.outputs);
  const changes = changeParts(summary);
  return (
    `Profile Installations: ${installations} · ` +
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
    (warning) => !warning.includes(" is missing its Agent Profile Kit exclusion section; apply will restore"),
  );
}

/**
 * One aggregate next-action instruction for concise lifecycle results.
 * Reads only the existing ReconciliationReport — no second desired-state model.
 * Blockers take precedence over apply guidance; apply never recommends more work.
 */
function nextActionLine(command: LifecycleCommand, report: ReconciliationReport): string | undefined {
  if (command === "apply") return undefined;

  if (report.blockers.length > 0) {
    const blockerWord = report.blockers.length === 1 ? "blocker" : "blockers";
    return command === "status"
      ? `Next: Resolve the reported ${blockerWord}, then run agent-profile-kit status again.`
      : `Next: Resolve the reported ${blockerWord}, then run agent-profile-kit preview again.`;
  }

  const hasActionableWork =
    report.items.some((item) => item.kind !== "current") ||
    report.outputs.some((output) => output.kind !== "unchanged") ||
    changedRepositoryExclusions(report).length > 0;

  if (!hasActionableWork) return undefined;

  if (command === "status") {
    return "Next: Run agent-profile-kit preview to review the planned changes (read-only), then apply when ready.";
  }
  return "Next: Run agent-profile-kit apply to reconcile Profile Installations.";
}

function conciseReport(command: LifecycleCommand, report: ReconciliationReport): string {
  const grouped = groupProjects(report);
  const groups = grouped.groups;
  const lines = [outcomeLine(command, report), aggregateLine(report, groups)];
  const activeGroups = groups.filter((group) => groupNeedsAttention(group, command));

  if (activeGroups.length === 0) {
    if (groups.length > 0 && report.blockers.length === 0) {
      lines.push(
        command === "apply"
          ? "All Profile Installations were already current."
          : command === "preview"
            ? "Nothing to reconcile; all Profile Installations are current."
            : "No Profile Installations need attention.",
      );
    }
  } else {
    for (const group of activeGroups) {
      const summary = summarizeOutputs(group.outputs);
      lines.push("", `Profile Installation: ${group.project}`);
      const profile = desiredProfile(report, group.project);
      if (profile) lines.push(`  Profile: ${profile}`);
      for (const item of group.items) {
        if (item.kind !== "current") lines.push(`  State: ${itemText(item)}`);
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
      "Repository exclusions:",
      "Git-local exclusions that keep Installer-owned generated paths untracked.",
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
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  const next = nextActionLine(command, report);
  if (next) lines.push("", next);
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
  const presentationWarnings = warningsForPresentation(command, report.warnings);
  const warnings = presentationWarnings.length === 0
    ? "(none)"
    : presentationWarnings.map((warning) => `- ${warning}`).join("\n");
  return `Projects:\n${items}\nOutputs:\n${outputs}\nRepository Exclusions:\n${repositoryExclusions}\nDesired State:\n${desired}\nWarnings:\n${warnings}\nBlockers:\n${blockers}\n`;
}

function verboseReport(command: LifecycleCommand, report: ReconciliationReport): string {
  return `${outcomeLine(command, report)}\n${verboseSections(command, report)}`;
}

export function formatLifecycleReport(
  command: LifecycleCommand,
  report: ReconciliationReport,
  options: { readonly verbose?: boolean } = {},
): string {
  return options.verbose ? verboseReport(command, report) : conciseReport(command, report);
}
