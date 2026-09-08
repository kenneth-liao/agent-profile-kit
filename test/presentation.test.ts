import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { AdapterDiagnosticWarning, HostSetupStep } from "../adapters/project-plan.js";
import { capabilityFailure } from "../adapters/capability.js";
import { appendDiagnosticWarnings, capabilityWarning } from "../installer/project-plan.js";
import { bindReceiptDocument, initReceiptDocument, unbindReceiptDocument } from "../cli/receipts.js";
import {
  flatInlineText,
  identifierPart,
  type InlineContent,
  renderPresentationDocument,
} from "../cli/presentation-document.js";
import {
  COMMAND_GROUPS,
  commandHelpDocument,
  defaultCommands,
  machineCommands,
  machineHelpDocument,
  rootHelpDocument,
} from "../cli/command-help.js";
import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import {
  focusedGuideDocument,
  guideFileDocument,
  guideIndexDocument,
  TOPIC_GUIDES,
} from "../cli/guides.js";
import {
  applyExecutionFailureDocument as rawApplyExecutionFailureDocument,
  applyReportDocument as rawApplyReportDocument,
  applyVerificationFailureDocument as rawApplyVerificationFailureDocument,
  blockedApplyReportDocument as rawBlockedApplyReportDocument,
  formatApplyJson,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatLifecycleJson,
  formatLifecycleToolErrorJson,
  hostInventoryDocument,
  infoDocument,
  inventoryIndexDocument,
  lifecycleStatusDocument as rawLifecycleStatusDocument,
  type LifecycleHumanOptions,
  formatMissingProfileError,
  machineInventoryIndexDocument,
  profileInventoryDocument,
  projectInventoryDocument,
  temporaryBlockedMessagesDocument,
  temporaryInstallationDocument,
  temporaryInventoryDocument,
  uninstallResultDocument,
  validationResultDocument,
  type TemporaryInstallationReceiptView,
  displayPath,
  displayProjectPath,
  lifecycleExitCode,
  DEFAULT_VIEW_LEXICON,
  INTERNAL_ONLY_DEFAULT_TERMS,
  NON_CURRENT_STATE_ORDER,
  classifyPrimaryCause,
  classifyAllCauses,
  partitionFleet,
  PRIMARY_CAUSE_ORDER,
  PRIMARY_CAUSE_LABELS,
  hasNeedsAttention,
  hasGeneratedFilesChanged,
  hasGeneratedFilesMissing,
  hasNotInstalledYet,
  hasSourceChanged,
  primaryCauseGroupNode,
  settledCountNode,
} from "../cli/presentation.js";
import type {
  PresentationDocument,
  PresentationNode,
} from "../cli/presentation-document.js";
import type { ApplicationInfo } from "../installer/info.js";

/**
 * Selective document shape: kinds, keys, categories, and order — the carried
 * wording and complete rendering stay locked by the golden snapshots (#390,
 * TEST-003/TEST-016).
 */
function nodeShape(node: PresentationNode): string {
  switch (node.kind) {
    case "sentence":
    case "prose":
      return `${node.kind}${node.category === undefined ? "" : `(${node.category})`}`;
    case "heading":
      return "heading";
    case "key-value":
      return `key-value:${node.key.trim()}${node.category === undefined ? "" : `(${node.category})`}`;
    case "verbatim":
      return nodeText(node).length === 0 ? "spacer" : "verbatim";
    default:
      return node.kind;
  }
}

function shapes(document: PresentationDocument): readonly string[] {
  return document.map(nodeShape);
}
import { INVENTORY_TOPICS, MACHINE_INVENTORY_TOPICS } from "../cli/inventory-topics.js";
import { compareCanonicalStrings } from "../schemas/canonical.js";
import { type TerminalPresentationContext } from "../cli/terminal-presentation.js";
import {
  installationStateUnreadableBlocker,
  normalizeBlocker,
  occupiedOutputBlocker,
  outputOwnershipConflictBlocker,
  temporaryInstallationConflictBlocker,
  temporaryInstallationRemovalBlocker,
  type ReconciliationBlocker,
} from "../installer/blockers.js";
import {
  blockerWording,
  humanBlockerWording,
  opencodeConfigOccupiedRemedy,
} from "../cli/blocker-wording.js";
import type {
  OutputConsumerEvidence,
  OutputReconciliationItem,
  ReconciliationItem,
  ReconciliationKind,
  ReconciliationProjectRecord,
  ReconciliationReport,
  ReconciliationWarning,
} from "../installer/reconcile.js";
import type {
  RepositoryExclusionChange,
} from "../installer/git-exclusions.js";
import {
  reportBlockers,
  reportDesired,
  reportItems,
  reportOutputs,
} from "./support/reconciliation-report.js";

type BlockedReconciliationReport = ReconciliationReport;
interface ApplyReconciliationResult {
  readonly receipt: ReconciliationReport;
  readonly resultingState: ReconciliationReport;
}

function asBlockedReport(report: ReconciliationReport): BlockedReconciliationReport {
  if (reportBlockers(report).length === 0) {
    throw new Error("blocked report fixture requires a blocker");
  }
  return report;
}

function lifecycleStatusDocument(
  report: ReconciliationReport,
  options: Partial<LifecycleHumanOptions> = {},
): PresentationDocument {
  return rawLifecycleStatusDocument(report, {
    selection: { kind: "all" },
    ...options,
  });
}

function applyReportDocument(
  result: ApplyReconciliationResult,
  options: Partial<LifecycleHumanOptions> = {},
): PresentationDocument {
  return rawApplyReportDocument(result, {
    selection: { kind: "all" },
    ...options,
  });
}

function blockedApplyReportDocument(
  report: BlockedReconciliationReport,
  options: Partial<LifecycleHumanOptions> = {},
): PresentationDocument {
  return rawBlockedApplyReportDocument(report, {
    selection: { kind: "all" },
    ...options,
  });
}

function applyExecutionFailureDocument(
  failure: Parameters<typeof rawApplyExecutionFailureDocument>[0],
  options: Partial<LifecycleHumanOptions> = {},
): PresentationDocument {
  return rawApplyExecutionFailureDocument(failure, {
    selection: { kind: "all" },
    ...options,
  });
}

function applyVerificationFailureDocument(
  report: ReconciliationReport,
  message: string,
  options: Partial<LifecycleHumanOptions> = {},
): PresentationDocument {
  return rawApplyVerificationFailureDocument(report, message, {
    selection: { kind: "all" },
    ...options,
  });
}

/** One structured fixture blocker; global without a project, project-scoped with one. */
function fixtureBlocker(message: string, project?: string): ReconciliationBlocker {
  return project === undefined
    ? normalizeBlocker({
        affectedItems: [{ kind: "path", value: "/home/.agents/agent-profile-kit/state/manifest.json" }],
        detail: message,
        kind: "installation-state-unreadable",
        scope: "global",
      })
    : normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: {
          case: "no-ownership-continuity",
          output: message
            .replaceAll(`${project}/`, "")
            .replaceAll(`${project}: `, "")
            .replaceAll(project, "this Project"),
        },
        kind: "installation-ownership",
        project,
        scope: "project",
      });
}

/** One installation-ownership fixture blocker whose failure fact carries long evidence. */
function fixtureOwnershipBlocker(output: string, project: string): ReconciliationBlocker {
  return normalizeBlocker({
    action: "verify",
    affectedItems: [],
    failure: { case: "no-ownership-continuity", output },
    kind: "installation-ownership",
    project,
    scope: "project",
  });
}

type DesiredFixture = Omit<NonNullable<ReconciliationProjectRecord["desired"]>, "hosts"> & {
  readonly canonicalProject: string;
  readonly hosts?: NonNullable<ReconciliationProjectRecord["desired"]>["hosts"];
  readonly project: string;
  readonly setupSteps?: ReconciliationProjectRecord["setupSteps"];
};

interface FlatFixture {
  readonly blockers: readonly ReconciliationBlocker[];
  readonly desired: readonly DesiredFixture[];
  readonly items: readonly ReconciliationItem[];
  readonly outputConsumers: readonly OutputConsumerEvidence[];
  readonly outputs: readonly OutputReconciliationItem[];
  readonly repositoryExclusions: readonly RepositoryExclusionChange[];
  readonly diagnosticValues: readonly string[];
  readonly warnings: readonly string[];
  readonly warningParts?: readonly (readonly InlineContent[])[];
}

function emptyReport(overrides: Partial<FlatFixture> = {}): ReconciliationReport {
  const fixture: FlatFixture = {
    blockers: [],
    desired: [],
    items: [],
    outputConsumers: [],
    outputs: [],
    repositoryExclusions: [],
    diagnosticValues: [],
    warnings: [],
    ...overrides,
  };
  const desired = fixture.desired.map((installation) => ({
    ...installation,
    hosts: installation.hosts ?? ["codex"] as const,
    setupSteps: installation.setupSteps ?? [],
  }));
  const canonicalByProject = new Map(desired.flatMap((installation) => [
    [installation.canonicalProject, installation.canonicalProject] as const,
    [installation.project, installation.canonicalProject] as const,
  ]));
  const canonicalProject = (project: string): string => canonicalByProject.get(project) ?? project;
  const keys = new Set([
    ...desired.map((installation) => installation.canonicalProject),
    ...fixture.items.map((item) => canonicalProject(item.project)),
    ...fixture.outputs.map((output) => canonicalProject(output.project)),
    ...fixture.blockers.flatMap((blocker) => blocker.project === undefined
      ? []
      : [canonicalProject(blocker.project)]),
  ]);
  if (keys.size === 0 && (fixture.repositoryExclusions.length > 0 || fixture.warnings.length > 0)) {
    keys.add("/project-a");
  }
  const firstProject = [...keys][0];
  return {
    globalBlockers: fixture.blockers.filter((blocker) => blocker.scope === "global"),
    projects: [...keys].sort().map((key) => {
      const installation = desired.find((candidate) => candidate.canonicalProject === key || candidate.project === key);
      const item = fixture.items.find((candidate) => canonicalProject(candidate.project) === key) ?? { kind: "current" as const, project: key };
      return machineProject(key, {
        ...(installation === undefined ? {} : {
          desired: {
            ...(installation.capabilityContracts === undefined ? {} : {
              capabilityContracts: installation.capabilityContracts,
            }),
            context: installation.context,
            hosts: installation.hosts,
            outputs: installation.outputs,
            profile: installation.profile,
            resolvedArtifacts: installation.resolvedArtifacts,
          },
          project: installation.project,
          setupSteps: installation.setupSteps ?? [],
        }),
        state: { kind: item.kind, ...(item.reason === undefined ? {} : { reason: item.reason }) },
        outputs: fixture.outputs.filter((output) => canonicalProject(output.project) === key).map((output) => ({
          consumingHosts: fixture.outputConsumers.find((consumer) =>
            canonicalProject(consumer.project) === key && consumer.path === output.path
          )?.consumingHosts ?? (installation?.hosts ?? []),
          kind: output.kind,
          path: output.path,
        })),
        blockers: fixture.blockers.filter((blocker) =>
          blocker.scope === "project" && canonicalProject(blocker.project!) === key
        ),
        warnings: key === firstProject ? fixture.warnings.map((message, index) => ({
          copyableValues: fixture.diagnosticValues,
          kind: "diagnostic" as const,
          parts: fixture.warningParts?.[index] ?? [message],
        })) : [],
        repositoryExclusions: key === firstProject ? fixture.repositoryExclusions : [],
      });
    }),
  };
}

function applyResult(
  receipt: ReconciliationReport,
  resultingState: ReconciliationReport = receipt,
): ApplyReconciliationResult {
  return { receipt, resultingState };
}

function executionProject(project: string): { readonly canonicalProject: string; readonly project: string } {
  return { canonicalProject: project, project };
}

interface MachineProjectOverrides extends Omit<Partial<ReconciliationProjectRecord>, "warnings"> {
  readonly warnings?: readonly ReconciliationWarning[];
}

function machineProject(
  project: string,
  overrides: MachineProjectOverrides = {},
): ReconciliationProjectRecord {
  const { warnings: overrideWarnings, ...rest } = overrides;
  return {
    canonicalProject: project,
    project,
    state: { kind: "current" },
    outputs: [],
    blockers: [],
    setupSteps: [],
    repositoryExclusions: [],
    ...rest,
    warnings: overrideWarnings ?? [],
  };
}

function machineReport(
  projects: readonly ReconciliationProjectRecord[] = [],
  globalBlockers: readonly ReconciliationBlocker[] = [],
): ReconciliationReport {
  return { globalBlockers, projects } as ReconciliationReport;
}

function machineApplyResult(
  receipt: ReconciliationReport,
  resultingState: ReconciliationReport = receipt,
): import("../installer/reconcile.js").ApplyReconciliationResult {
  return { receipt, resultingState };
}

function temporaryReceipt(
  overrides: Partial<TemporaryInstallationReceiptView> = {},
): TemporaryInstallationReceiptView {
  return {
    adapterVersion: "codex-project-v2",
    completionState: "installed",
    engineVersion: "0.62.0",
    host: "codex",
    hostVersion: "native-project-sessionstart-v1",
    outputs: [".agent-profile-kit/codex/context.md"],
    profileId: "coding",
    project: "/tmp/temporary-project",
    setupSteps: [],
    temporaryInstallationId: "temporary-installation-opaque-id",
    diagnosticValues: [],
    warnings: [],
    workspaceInputHash: "workspace-hash",
    ...overrides,
  };
}

function identityReport(
  project: string,
  hosts: NonNullable<ReconciliationProjectRecord["desired"]>["hosts"] = ["codex"],
): ReconciliationReport {
  return emptyReport({
    desired: [{
      canonicalProject: project,
      context: "composed",
      hosts,
      outputs: ["a.md"],
      profile: "coding",
      project,
      resolvedArtifacts: [],
    }],
    items: [{ kind: "addition", project }],
    outputs: [{ kind: "addition", path: "a.md", project }],
  });
}

function flattenPresentationNodes(document: PresentationDocument): PresentationNode[] {
  const nodes: PresentationNode[] = [];
  const visit = (node: PresentationNode): void => {
    nodes.push(node);
    if (node.kind === "key-value") visit(node.value);
    if (node.kind === "notice") {
      for (const child of node.nodes) visit(child);
    }
    if (node.kind === "row") {
      for (const cell of node.cells) visit(cell.content);
    }
    if (node.kind === "column-group") {
      for (const column of node.columns) {
        for (const child of column) visit(child);
      }
    }
  };
  for (const node of document) visit(node);
  return nodes;
}

/** The flat carried text of one node, composed from its inline parts. */
function nodeText(node: PresentationNode): string {
  if (node.kind === "heading" || node.kind === "verbatim") return node.text;
  if (node.kind === "identifier") return node.value;
  if (node.kind === "prose" || node.kind === "sentence" || node.kind === "list-item") {
    return flatInlineText(node.parts);
  }
  return "";
}

/**
 * Count prose occurrences of a substring across text spans only: atomic
 * command arguments (scoped recovery commands) are carried once per command by
 * design and are not prose identity prose (#440).
 */
function proseOccurrences(document: PresentationDocument, substring: string): number {
  const prose = flattenPresentationNodes(document)
    .flatMap((node) =>
      node.kind === "prose" || node.kind === "sentence" || node.kind === "list-item"
        ? node.parts.flatMap((part) =>
            typeof part === "string"
              ? [part]
              : part.kind === "path"
              ? [part.authoredPath ?? part.canonicalPath]
              : [])
        : node.kind === "heading" || node.kind === "verbatim"
        ? [node.text]
        : [])
    .join("\n");
  return prose.split(substring).length - 1;
}

/**
 * Identity prose only: text spans, path parts, headings, and identifiers.
 * Atomic command arguments are excluded — a scoped recovery command carries
 * the canonical Project path on purpose (a runnable copy needs it) (#440).
 */
function proseTexts(document: PresentationDocument): string[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "prose" || node.kind === "sentence" || node.kind === "list-item"
      ? node.parts.flatMap((part) =>
          typeof part === "string"
            ? [part]
            : part.kind === "path"
            ? [part.authoredPath ?? part.canonicalPath]
            : [])
      : node.kind === "heading" || node.kind === "verbatim"
      ? [node.text]
      : node.kind === "identifier"
      ? [node.value]
      : []);
}

/** One top-level node's kind and semantic category, in document order. */
function shape(node: PresentationNode): string {
  const category = "category" in node && node.category !== undefined
    ? `:${node.category}`
    : "";
  switch (node.kind) {
    case "notice":
      return `notice:${node.severity}`;
    case "heading":
      return `heading${category}`;
    case "prose":
      return `prose${category}`;
    case "key-value":
      return `key-value(${node.key.trim()})${category}`;
    case "command":
      return "command";
    case "path":
      return "path";
    case "identifier":
      return "identifier";
    case "list-item":
      return "list-item";
    case "verbatim":
      return nodeText(node).length === 0 ? "blank" : "verbatim";
    default:
      return node.kind;
  }
}

const context = (width: number): TerminalPresentationContext => ({
  color: false,
  interactive: true,
  width,
});

/** The default render context the CLI-boundary string formatters used: the
 * vocabulary guard renders documents through it so its scanned text is
 * unchanged (TEST-014). */
const defaultRenderContext: TerminalPresentationContext = {
  color: false,
  interactive: false,
  width: 10_000,
};

/** One document rendered exactly as the CLI boundary renders it: the pure
 * renderer with the given context plus one terminating newline. Rendering
 * behaviour (TEST-006/TEST-008) asserts this form; meaning assertions read the
 * document nodes instead (TEST-003). */
function renderBoundary(
  document: PresentationDocument,
  context: TerminalPresentationContext = defaultRenderContext,
): string {
  const rendered = renderPresentationDocument(document, context);
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

describe("lifecycle status document", () => {
  const pendingReport = () => emptyReport({
    desired: [{
      canonicalProject: "/project-a",
      context: "composed",
      outputs: ["a.md"],
      profile: "coding",
      project: "/project-a",
      resolvedArtifacts: [],
    }],
    items: [{ kind: "addition", project: "/project-a" }],
    outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
  });
  const blockedReport = () => emptyReport({
    blockers: [fixtureBlocker("occupied output", "/project-a")],
    desired: [{
      canonicalProject: "/project-a",
      context: "composed",
      outputs: ["a.md"],
      profile: "coding",
      project: "/project-a",
      resolvedArtifacts: [],
    }],
    items: [{ kind: "blocked", project: "/project-a" }],
  });

  test("concise current status states current without setup, Project list, or next action", () => {
    const report = emptyReport({
      desired: ["/project-a", "/project-b"].map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      })),
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "current", project: "/project-b" },
      ],
    });

    const document = lifecycleStatusDocument(report);

    expect(document.map(shape)).toEqual(["notice:success"]);
  });

  test("concise pending status is outcome, warnings, then typed next commands in order", () => {
    const document = lifecycleStatusDocument(pendingReport());

    expect(document.map(shape)).toEqual([
      "notice:success",
      "list-item",
      "key-value(Next):command",
      "blank",
      "key-value(Details):command",
    ]);
    const commands = flattenPresentationNodes(document).filter((node) => node.kind === "command");
    expect(commands).toEqual([
      {
        kind: "command",
        program: "apkit",
        args: [{ kind: "text", value: "apply" }],
      },
      {
        kind: "command",
        program: "apkit",
        args: [
          { kind: "text", value: "status" },
          { kind: "text", value: "--verbose" },
        ],
      },
    ]);
  });

  test("concise blocked status orders notice, typed Blocker fields, summary, and next actions", () => {
    const document = lifecycleStatusDocument(blockedReport());

    expect(document.map(shape)).toEqual([
      "notice:error",
      "list-item",
      "prose",
      "prose:error",
      "prose",
      "prose",
      "blank",
      "notice:error",
      "blank",
      "heading",
      "list-item",
    ]);
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "list-item" &&
      node.parts !== undefined &&
      flatInlineText(node.parts).includes("apkit status")
    )).toBe(true);
    expect(commandsIn(document).some((node) =>
      node.args.some((arg) => arg.kind === "text" && arg.value === "apply")
    )).toBe(false);
  });

  test("verbose status orders detail sections with Context as the only verbatim content", () => {
    const authored = "First module\n--- begin Context ---\nNested module\n";
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: authored,
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [{
          host: "codex",
          kind: "trust-required",
          message: "Trust the bound project in Codex.",
          provenance: "standing",
        }],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const document = lifecycleStatusDocument(report, { verbose: true });

    expect(document.map(shape)).toEqual([
      "notice:success",
      "heading",
      "prose",
      "heading",
      "list-item",
      "heading",
      "prose",
      "heading",
      "prose",
      "heading",
      "prose",
      "prose",
      "prose",
      "prose",
      "prose",
      "prose",
      "prose",
      "verbatim",
      "heading:error",
      "prose",
      "heading",
      "heading",
      "list-item",
    ]);
    const verbatim = document.filter((node) => node.kind === "verbatim");
    expect(verbatim).toHaveLength(1);
    const contextText = verbatim[0]!.kind === "verbatim" ? verbatim[0]!.text : "";
    expect(contextText).toContain(authored);
    expect(contextText).toContain("---- begin Context ----");
    expect(contextText).toContain("---- end Context ----");
    expect(contextText.startsWith("---- begin Context ----")).toBe(true);
    const headings = document.filter((node) => node.kind === "heading")
      .map((node) => node.kind === "heading" ? nodeText(node) : "");
    expect(headings).toEqual([
      "Projects:",
      "State explanations:",
      "Outputs:",
      "Git exclusions:",
      "Selected setup:",
      "Blockers:",
      "Host Setup:",
      "Standing Host setup:",
    ]);
  });

  test("blocked verbose status renders the Blockers section exactly once, leading the details", () => {
    const document = lifecycleStatusDocument(blockedReport(), { verbose: true });

    const headings = document.filter((node) => node.kind === "heading")
      .map((node) => node.kind === "heading" ? nodeText(node) : "");
    expect(headings[0]).toBe("Blockers:");
    expect(headings.filter((text) => text === "Blockers:")).toHaveLength(1);
  });

  test("blockers-only status keeps Blockers and omits unrelated inventory", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [{
          host: "codex",
          kind: "trust-required",
          message: "Trust the bound project in Codex.",
          provenance: "standing",
        }],
      }],
      items: [{ kind: "blocked", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
      warnings: ["OpenCode reports a duplicate Skill identity"],
    });

    const document = lifecycleStatusDocument(report, { blockersOnly: true });

    expect(document.map(shape)).toEqual([
      "notice:error",
      "blank",
      "key-value(Project)",
      "prose:error",
      "prose",
      "prose",
      "blank",
      "prose:error",
      "blank",
      "heading",
      "list-item",
    ]);
    expect(flattenPresentationNodes(document).some((node) => node.kind === "path")).toBe(true);
    expect(document.filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(2);
    expect(headingsIn(document)).not.toContain("Host Setup:");
    expect(headingsIn(document)).not.toContain("Warnings:");
    expect(commandsIn(document)).toEqual([]);
  });

  test("derives the outcome notice severity from report facts, not rendered copy", () => {
    const hostAttention = machineReport([machineProject("/project-a", {
      desired: {
        context: "composed",
        hosts: ["codex"],
        outputs: ["a.md"],
        profile: "coding",
        resolvedArtifacts: [],
      },
      state: { kind: "current" },
      warnings: [{
        copyableValues: [],
        kind: "host-attention",
        parts: ["Trust the bound project in Codex."],
      }],
    })]);

    const document = lifecycleStatusDocument(hostAttention);
    expect(document.map(shape)).toEqual([
      "notice:attention",
      "list-item",
    ]);
    // Severity drives the colour, not rendered copy (TEST-008).
    const rendered = renderBoundary(
      lifecycleStatusDocument(hostAttention),
      { color: true, interactive: true, width: 80 },
    );
    expect(rendered).toContain("\u001b[33mHost attention required\u001b[0m");
  });

  test("renders an explicitly selected Project as a typed command path argument", () => {
    const project = "/tmp/apkit-int2/projects/deeply/nested/demo project";
    const report = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project }],
      outputs: [{ kind: "addition", path: "a.md", project }],
    });

    const nodes = flattenPresentationNodes(
      lifecycleStatusDocument(report, { selection: { command: "status", kind: "project", match: "exact", target: project } }),
    );
    const commands = nodes.filter((node) => node.kind === "command")
      .map((node) => node.kind === "command" ? node : undefined);
    expect(commands.some((node) =>
      node !== undefined && node.program === "apkit" &&
      node.args.some((arg) => arg.kind === "text" && arg.value === "apply") &&
      node.args.some((arg) =>
        arg.kind === "path" &&
        arg.canonicalPath === project &&
        arg.authoredPath === project &&
        arg.scope === "project"
      )
    )).toBe(true);
    expect(commands.some((node) =>
      node !== undefined && node.program === "apkit" &&
      node.args.some((arg) => arg.kind === "text" && arg.value === "status") &&
      node.args.some((arg) => arg.kind === "path")
    )).toBe(true);

    const rendered = renderBoundary(
      lifecycleStatusDocument(report, { selection: { command: "status", kind: "project", match: "exact", target: project } }),
      { color: false, interactive: true, width: 40 },
    );
    for (const line of rendered.split("\n")) {
      if (!line.startsWith("Next: apkit apply") && !line.startsWith("Details: apkit status")) {
        continue;
      }
      // The typed path argument shortens through the renderer's displayPath
      // contract (INT-2): the complete command stays on one fitting line and
      // the elision marker shows the shortened identity.
      expect(line.split("\n")).toHaveLength(1);
      expect(line.length, `command exceeds width: ${line}`).toBeLessThanOrEqual(40);
      expect(line).toContain("…");
    }
    // displayPath keeps whole trailing segments while they fit and only then
    // elides, so the runnable command tail survives shortening.
    const nextLine = rendered.split("\n").find((line) => line.startsWith("Next: apkit apply"));
    const detailsLine = rendered.split("\n").find((line) => line.startsWith("Details: apkit status"));
    expect(nextLine).toMatch(/^Next: apkit apply \/…\//);
    expect(nextLine!.endsWith("demo project")).toBe(true);
    expect(detailsLine).toMatch(/^Details: apkit status \/…/);
    expect(detailsLine!.endsWith("--verbose")).toBe(true);
  });

  test("wraps clean, attention, blocked, verbose, and blockers-only status prose to the selected width", () => {
    const clean = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    const attention = identityReport("/project-a");
    const blocked = emptyReport({
      blockers: [
        fixtureOwnershipBlocker("ownership-unresolved-output.md", "/project-a"),
      ],
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
      warnings: ["The Workspace warning explains a long condition that needs attention."],
    });
    for (const width of [40, 80, 100]) {
      const views = [
        renderBoundary(lifecycleStatusDocument(clean), context(width)),
        renderBoundary(lifecycleStatusDocument(attention), context(width)),
        renderBoundary(lifecycleStatusDocument(blocked), context(width)),
        renderBoundary(lifecycleStatusDocument(blocked, { verbose: true }), context(width)),
        renderBoundary(lifecycleStatusDocument(blocked, { blockersOnly: true }), context(width)),
      ];

      for (const view of views) {
        for (const line of view.trimEnd().split("\n")) {
          // Atomic command parts render on one unsplit line by design; prose
          // wraps to the selected width.
          if (/^\s*(ls|vi|git|apkit)\s/.test(line)) continue;
          expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("styles status lines through typed semantic categories", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
      warnings: ["The Workspace warning explains a long condition that needs attention."],
    });

    const document = lifecycleStatusDocument(report);
    const renderContext = { color: true, interactive: true, width: 80 } as const;
    const rendered = renderBoundary(document, renderContext);
    // Every line of a real error notice/Blocker inherits red, including wraps.
    // Expected line content comes from the document; no copy is maintained here.
    const errors = document.filter((node) => node.kind === "notice" && node.severity === "error" ||
      node.kind === "prose" && node.category === "error");
    expect(errors).toHaveLength(3);
    for (const node of errors) {
      const plain = renderPresentationDocument([node], { ...renderContext, color: false });
      for (const line of plain.split("\n")) {
        expect(rendered).toContain(`\u001b[31m${line}\u001b[0m`);
      }
    }
    expect(rendered).toContain("\u001b[33m- The Workspace warning explains a long condition that needs attention. (1\u001b[0m");
    expect(rendered).not.toContain("Warnings:");
    expect(rendered).toContain("\u001b[1;34mNext:\u001b[0m");
  });
});

function commandsIn(
  document: PresentationDocument,
): Extract<PresentationNode, { kind: "command" }>[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "command" ? [node] : [],
  );
}

/** The typed inline command invocations carried inside prose, sentence, and
 * list-item nodes, rendered from their atomic program/argument parts. */
function inlineCommandTexts(nodes: readonly PresentationNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "prose" || node.kind === "sentence" || node.kind === "list-item"
      ? node.parts.flatMap((part) =>
          typeof part === "string" || part.kind !== "command"
            ? []
            : [[part.program,
                ...part.args.map((arg) => arg.kind === "text" ? arg.value : "")]
              .filter((text) => text !== "").join(" ")])
      : []);
}

/** The exact invocation each command node carries, asserted as structure. */
function commandTexts(document: PresentationDocument): string[] {
  return commandsIn(document).map((node) =>
    [node.program, ...node.args.map((arg) => arg.kind === "text" ? arg.value : "")].join(" "),
  );
}

/** Read fixture-authored text and identity substrings only. Product copy is
 * covered by golden snapshots; this helper does not expose semantic facts. */
function presentationTexts(document: PresentationDocument): string[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "prose" || node.kind === "heading" || node.kind === "verbatim" ||
      node.kind === "list-item"
      ? [nodeText(node)]
      : node.kind === "identifier"
      ? [node.value]
      : [],
  );
}

/** Atomic identifiers already selected by the formatter. */
function inlineIdentifiers(document: PresentationDocument): string[] {
  return flattenPresentationNodes(document).flatMap((node) => {
    if (node.kind === "identifier") return [node.value];
    if (node.kind !== "prose" && node.kind !== "sentence" && node.kind !== "list-item") return [];
    return node.parts.flatMap((part) => typeof part !== "string" && part.kind === "identifier" ? [part.value] : []);
  });
}

/** The notice nodes of a presentation document, for severity assertions. */
function noticesIn(
  document: PresentationDocument,
): Extract<PresentationNode, { kind: "notice" }>[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "notice" ? [node] : [],
  );
}

/** The heading texts of a presentation document, in document order. */
function headingsIn(document: PresentationDocument): string[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "heading" ? [nodeText(node)] : [],
  );
}

/** The key-value nodes carrying one key, in document order. */
function keyValuesIn(
  document: PresentationDocument,
  key: string,
): Extract<PresentationNode, { kind: "key-value" }>[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "key-value" && node.key === key ? [node] : [],
  );
}

/** The carried text of consecutive list items beginning at one flat index. */
function listItemsFrom(
  nodes: readonly PresentationNode[],
  start: number,
): string[] {
  const texts: string[] = [];
  for (let index = start; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind !== "list-item") break;
    texts.push(nodeText(node));
  }
  return texts;
}

/** Every list-item's carried text in document order. */
function listItemsIn(document: PresentationDocument): string[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "list-item" ? [nodeText(node)] : [],
  );
}

/** Atomic Project identities in the verbose Projects section. */
function projectStateLines(document: PresentationDocument): string[] {
  const nodes = flattenPresentationNodes(document);
  const start = indexWhere(nodes, (node) =>
    node.kind === "heading" && nodeText(node) === "Projects:");
  if (start < 0) return [];
  const texts: string[] = [];
  for (let index = start + 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind === "heading") break;
    texts.push(...inlineIdentifiers([node]));
  }
  return texts;
}

/** The flat index of the first node satisfying one predicate. */
function indexWhere(
  nodes: readonly PresentationNode[],
  predicate: (node: PresentationNode) => boolean,
): number {
  return nodes.findIndex(predicate);
}

describe("Host Setup Step provenance and presentation", () => {
  const hookPath = ".codex/hooks.json";

  const hookApproval = (): HostSetupStep => ({
    host: "codex",
    kind: "approval-required",
    message: "Review and approve the generated SessionStart hook when Codex asks.",
    consequence: "Declining the hook prevents Profile Context from loading.",
    output: hookPath,
    provenance: "transition",
  });
  const codexTrust = (): HostSetupStep => ({
    host: "codex",
    kind: "trust-required",
    message: "Trust the bound project in Codex.",
    consequence: "Profile Context does not load until the project is trusted.",
    provenance: "standing",
  });
  const rootLaunch = (): HostSetupStep => ({
    host: "codex",
    kind: "launch-constraint",
    message: "Launch Codex from the exact bound project root:",
    path: "bound-project",
    consequence: "Launching from a descendant prevents Profile Context from loading.",
    provenance: "standing",
  });
  const sharedPath = (): HostSetupStep => ({
    host: "grok",
    kind: "shared-path",
    message: "Grok uses Claude's shared rule path.",
    provenance: "standing",
  });

  const installation = (
    project: string,
    setupSteps: readonly HostSetupStep[],
  ): DesiredFixture => ({
    canonicalProject: project,
    context: "composed",
    outputs: ["a.md"],
    profile: "coding",
    project,
    resolvedArtifacts: [],
    setupSteps,
  });

  test("verbose status and JSON retain every Adapter-authored Host Setup Step with provenance", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [
        hookApproval(),
        codexTrust(),
        rootLaunch(),
        sharedPath(),
      ])],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: hookPath, project: "/project-a" }],
    });

    const context: TerminalPresentationContext = {
      color: false,
      interactive: false,
      width: 80,
    };
    const verbose = lifecycleStatusDocument(report, { verbose: true });
    // Sections are authored headings; each step is a list item whose distinct
    // consequence follows as its own prose node.
    expect(headingsIn(verbose)).toContain("Host setup:");
    expect(headingsIn(verbose)).toContain("Standing Host setup:");
    const nodes = flattenPresentationNodes(verbose);
    const approvalIndex = indexWhere(nodes, (node) =>
      node.kind === "list-item" && nodeText(node) ===
        "Review and approve the generated SessionStart hook when Codex asks.");
    expect(approvalIndex).toBeGreaterThan(-1);
    expect(nodes[approvalIndex + 1]).toEqual({
      kind: "prose",
      parts: ["  Consequence: Declining the hook prevents Profile Context from loading."],
    });
    const trustIndex = indexWhere(nodes, (node) =>
      node.kind === "list-item" && nodeText(node) === "Trust the bound project in Codex.");
    expect(trustIndex).toBeGreaterThan(-1);
    expect(nodes[trustIndex + 1]).toEqual({
      kind: "prose",
      parts: ["  Consequence: Profile Context does not load until the project is trusted."],
    });
    expect(listItemsIn(verbose)).toContain("Launch Codex from the exact bound project root: /project-a");
    expect(listItemsIn(verbose)).toContain("Grok uses Claude's shared rule path.");

    const machine = JSON.parse(formatLifecycleJson("status", report)) as {
      readonly projects: readonly {
        readonly setupSteps: readonly {
          readonly consequence?: string;
          readonly host: string;
          readonly kind: string;
          readonly message: string;
          readonly output?: string;
          readonly path?: "bound-project";
          readonly project?: string;
          readonly provenance: string;
        }[];
      }[];
    };
    expect(machine.projects[0]?.setupSteps).toEqual([
      {
        consequence: "Declining the hook prevents Profile Context from loading.",
        host: "codex",
        kind: "approval-required",
        message: "Review and approve the generated SessionStart hook when Codex asks.",
        output: hookPath,
        provenance: "transition",
      },
      {
        consequence: "Profile Context does not load until the project is trusted.",
        host: "codex",
        kind: "trust-required",
        message: "Trust the bound project in Codex.",
        provenance: "standing",
      },
      {
        consequence: "Launching from a descendant prevents Profile Context from loading.",
        host: "codex",
        kind: "launch-constraint",
        message: "Launch Codex from the exact bound project root:",
        path: "bound-project",
        project: "/project-a",
        provenance: "standing",
      },
      {
        host: "grok",
        kind: "shared-path",
        message: "Grok uses Claude's shared rule path.",
        provenance: "standing",
      },
    ]);
  });

  test("verbose status deduplicates identical setup steps without collapsing distinct consequences", () => {
    const report = emptyReport({
      desired: ["/project-a", "/project-b"].map((project) => ({
        ...installation(project, [codexTrust()]),
        setupSteps: [
          codexTrust(),
          ...(project === "/project-a"
            ? [{
                ...codexTrust(),
                consequence: "A different consequence remains visible.",
              }]
            : []),
        ],
      })),
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "current", project: "/project-b" },
      ],
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });

    // The identical step renders once with compact Project scope; the distinct
    // consequence keeps its own bullet (US-048, US-049).
    expect(listItemsIn(verbose).filter((text) =>
      text.startsWith("Trust the bound project in Codex.")
    )).toEqual([
      "Trust the bound project in Codex. (/project-a, /project-b)",
      "Trust the bound project in Codex.",
    ]);
    expect(presentationTexts(verbose).filter((text) =>
      text === "  Consequence: Profile Context does not load until the project is trusted."
    )).toHaveLength(1);
    expect(presentationTexts(verbose).filter((text) =>
      text === "  Consequence: A different consequence remains visible."
    )).toHaveLength(1);
  });

  test("verbose status renders typed bound-project paths through the canonical path presenter", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/private/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [rootLaunch()],
      }],
      items: [{ kind: "current", project: "/project-a" }],
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });

    expect(listItemsIn(verbose)).toContain(
      "Launch Codex from the exact bound project root: /project-a",
    );
  });

  test("apply shows change-relevant transition setup and a separate standing reminder", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [
        hookApproval(),
        codexTrust(),
        rootLaunch(),
        sharedPath(),
      ])],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: hookPath, project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(report),
      items: [{ kind: "current", project: "/project-a" }],
    });

    const concise = applyReportDocument(applyResult(report, resultingState));

    // Concise apply renders first-use guidance as one heading with consecutive
    // list items; transition and standing verbose headings never appear.
    const firstUse = indexWhere(concise, (node) => node.kind === "heading" && nodeText(node) === "First use:");
    expect(firstUse).toBeGreaterThan(-1);
    expect(listItemsFrom(concise, firstUse + 1)).toEqual([
      expect.stringContaining("Review and approve the generated SessionStart hook when Codex asks"),
      expect.stringContaining("Trust the bound project in Codex"),
      expect.stringContaining("Launch Codex from the exact bound project root"),
    ]);
    expect(headingsIn(applyReportDocument(applyResult(report, resultingState))))
      .not.toContain("Host setup:");
    expect(headingsIn(applyReportDocument(applyResult(report, resultingState))))
      .not.toContain("Standing Host setup:");
    // The readiness statement is the trailing prose node; its wording is
    // golden-covered (no structured fact exists for it).
    expect(concise.at(-1)).toMatchObject({ kind: "prose" });

    const verbose = applyReportDocument(applyResult(report, resultingState), { verbose: true });
    expect(headingsIn(verbose)).toEqual(expect.arrayContaining(["Host setup:", "Standing Host setup:"]));
    expect(listItemsIn(verbose)).toEqual(expect.arrayContaining([
      "Trust the bound project in Codex.",
      "Launch Codex from the exact bound project root: /project-a",
      "Grok uses Claude's shared rule path.",
    ]));
    expect(flattenPresentationNodes(verbose).some((node) =>
      node.kind === "prose" &&
      nodeText(node) === "  Consequence: Declining the hook prevents Profile Context from loading."
    )).toBe(true);
    expect(flattenPresentationNodes(verbose).at(-1)).toMatchObject({ kind: "prose" });
  });

  test("later Host-consumed addition on an established pairing does not replay standing first-use", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["codex"],
        outputs: ["a.md", "skill.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [codexTrust(), rootLaunch()],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "skill.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [
        { kind: "unchanged", path: "a.md", project: "/project-a" },
        { kind: "unchanged", path: "skill.md", project: "/project-a" },
      ],
    });

    const concise = applyReportDocument(applyResult(receipt, resultingState));
    expect(headingsIn(concise)).not.toContain("First use:");
    const verbose = applyReportDocument(applyResult(receipt, resultingState), { verbose: true });
    expect(headingsIn(verbose)).toContain("Standing Host setup:");
    expect(listItemsIn(verbose)).toContain("Trust the bound project in Codex.");
  });

  test("replacing the last Host-consumed output on an established pairing does not replay standing first-use", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["pi"],
        outputs: ["skill.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [{
          host: "pi",
          kind: "trust-required",
          message: "Trust the bound project in Pi.",
          consequence: "The Profile does not load until the project is trusted.",
          provenance: "standing",
        }],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [
        { kind: "removal", path: "context.md", project: "/project-a" },
        { kind: "addition", path: "skill.md", project: "/project-a" },
      ],
      outputConsumers: [
        { consumingHosts: ["pi"], path: "context.md", project: "/project-a" },
        { consumingHosts: ["pi"], path: "skill.md", project: "/project-a" },
      ],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "skill.md", project: "/project-a" }],
      outputConsumers: [
        { consumingHosts: ["pi"], path: "skill.md", project: "/project-a" },
      ],
    });

    const concise = applyReportDocument(applyResult(receipt, resultingState));
    expect(headingsIn(concise)).not.toContain("First use:");
    const verbose = applyReportDocument(applyResult(receipt, resultingState), { verbose: true });
    expect(headingsIn(verbose)).toContain("Standing Host setup:");
    expect(listItemsIn(verbose)).toContain("Trust the bound project in Pi.");
  });

  test("routine update does not replay transition setup or standing trust", () => {
    const receipt = emptyReport({
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    const concise = applyReportDocument(applyResult(receipt, resultingState));
    expect(headingsIn(concise)).not.toContain("First use:");
    expect(headingsIn(concise)).not.toContain("Host setup:");
    expect(headingsIn(concise)).not.toContain("Standing Host setup:");
    expect(flattenPresentationNodes(concise).at(-1)).toMatchObject({ kind: "prose" });
  });

  test("setup-free apply emits invocation-wide readiness statement", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["claude"],
        outputs: [".claude/rules/agent-profile-kit.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(report),
      items: [{ kind: "current", project: "/project-a" }],
    });

    const concise = flattenPresentationNodes(applyReportDocument(applyResult(report, resultingState)));
    // The readiness statement is the trailing prose node; its wording is
    // golden-covered (no structured fact exists for it).
    expect(concise.at(-1)).toMatchObject({ kind: "prose" });
  });

  test("informational standing setup does not imply an action is required", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["claude", "grok"],
        outputs: [".claude/rules/agent-profile-kit.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [sharedPath()],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(report),
      items: [{ kind: "current", project: "/project-a" }],
    });

    const concise = applyReportDocument(applyResult(report, resultingState));
    expect(headingsIn(concise)).not.toContain("First use:");
    expect(headingsIn(concise)).not.toContain("Standing Host setup:");
    expect(flattenPresentationNodes(concise).at(-1)).toMatchObject({ kind: "prose" });
    const verbose = applyReportDocument(applyResult(report, resultingState), { verbose: true });
    expect(headingsIn(verbose)).toContain("Standing Host setup:");
    expect(listItemsIn(verbose)).toContain("Grok uses Claude's shared rule path.");
  });

  test("no-op apply omits transition setup and the standing reminder", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    const concise = applyReportDocument(applyResult(report));
    const nodes = flattenPresentationNodes(concise);
    // No-op apply: success notice, the already-current statement, no setup
    // headings, no first-use items, no activation copy.
    expect(noticesIn(concise)).toHaveLength(1);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(headingsIn(concise)).not.toContain("First use:");
    expect(headingsIn(concise)).not.toContain("Host setup:");
    expect(listItemsIn(concise)).toEqual([]);
    // The trailing prose is the already-current statement; its wording is
    // golden-covered (no structured fact exists for it).
    expect(concise.map(shape)).toEqual(["notice:success", "prose"]);
  });

  test("concise apply deduplicates first-use guidance across projects without a path matrix", () => {
    const piTrust: HostSetupStep = {
      host: "pi",
      kind: "trust-required",
      message: "Trust the bound project in Pi.",
      consequence: "The Profile does not load until the project is trusted.",
      provenance: "standing",
    };
    const projects = ["/p-1", "/p-2", "/p-3", "/p-4"].map((project) => ({
      canonicalProject: project,
      context: "composed",
      hosts: ["codex", "pi"] as const,
      outputs: ["a.md", hookPath],
      profile: "coding",
      project,
      resolvedArtifacts: [],
      setupSteps: [hookApproval(), codexTrust(), piTrust],
    }));
    const receipt = emptyReport({
      desired: projects,
      items: projects.map((p) => ({ kind: "addition" as const, project: p.project })),
      outputs: projects.flatMap((p) => [
        { kind: "addition" as const, path: "a.md", project: p.project },
        { kind: "addition" as const, path: hookPath, project: p.project },
      ]),
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: projects.map((p) => ({ kind: "current" as const, project: p.project })),
    });

    const concise = applyReportDocument(applyResult(receipt, resultingState));
    const firstUse = indexWhere(
      concise,
      (node) => node.kind === "heading" && nodeText(node) === "First use:",
    );
    expect(firstUse).toBeGreaterThan(-1);
    // First-use guidance is deduplicated: one list item per distinct step,
    // with no per-Project setup matrix.
    expect(listItemsFrom(concise, firstUse + 1)).toEqual([
      expect.stringContaining("Review and approve the generated SessionStart hook when Codex asks"),
      expect.stringContaining("Trust the bound project in Codex"),
      expect.stringContaining("Trust the bound project in Pi"),
    ]);
  });

  test("subset-only launch constraint gives affected count and verbose route", () => {
    const projects = ["/p-1", "/p-2", "/p-3", "/p-4"].map((project, idx) => ({
      canonicalProject: project,
      context: "composed",
      hosts: ["codex"] as const,
      outputs: ["a.md"],
      profile: "coding",
      project,
      resolvedArtifacts: [],
      setupSteps: idx < 2 ? [codexTrust(), rootLaunch()] : [codexTrust()],
    }));
    const receipt = emptyReport({
      desired: projects,
      items: projects.map((p) => ({ kind: "addition" as const, project: p.project })),
      outputs: projects.map((p) => ({ kind: "addition" as const, path: "a.md", project: p.project })),
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: projects.map((p) => ({ kind: "current" as const, project: p.project })),
    });

    const concise = listItemsIn(applyReportDocument(applyResult(receipt, resultingState)));
    expect(concise).toEqual([
      expect.stringContaining("Trust the bound project in Codex"),
      expect.stringContaining("Launch Codex from the exact bound project root"),
    ]);

    const verbose = listItemsIn(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    expect(verbose).toContain("Launch Codex from the exact bound project root: /p-1");
    expect(verbose).toContain("Launch Codex from the exact bound project root: /p-2");
  });

  test("standing guidance is not triggered by non-host bookkeeping additions or outputs for different hosts", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["claude", "codex"] as const,
        outputs: [".claude/skills/review-pr", ".claude/rules/agent-profile-kit.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [codexTrust()],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [
        { kind: "addition", path: ".claude/skills/review-pr", project: "/project-a" },
        { kind: "addition", path: ".claude/rules/agent-profile-kit.md", project: "/project-a" },
      ],
      outputConsumers: [
        { consumingHosts: [], path: ".claude/skills/review-pr", project: "/project-a" },
        { consumingHosts: ["claude"], path: ".claude/rules/agent-profile-kit.md", project: "/project-a" },
      ],
    });
    const resultingState = emptyReport({
      desired: reportDesired(report),
      items: [{ kind: "current", project: "/project-a" }],
    });

    const concise = applyReportDocument(applyResult(report, resultingState));
    expect(headingsIn(concise)).not.toContain("First use:");
    expect(flattenPresentationNodes(concise).at(-1)).toMatchObject({ kind: "prose" });
  });

  test("non-standard security warning consequence is preserved in concise apply", () => {
    const warningStep: HostSetupStep = {
      consequence: "Security warning: remote execution permitted",
      host: "codex",
      kind: "trust-required",
      message: "Trust the bound project in Codex.",
      provenance: "standing",
    };
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["codex"] as const,
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [warningStep],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(report),
      items: [{ kind: "current", project: "/project-a" }],
    });

    const concise = applyReportDocument(applyResult(report, resultingState));
    const firstUse = indexWhere(
      concise,
      (node) => node.kind === "heading" && nodeText(node) === "First use:",
    );
    expect(firstUse).toBeGreaterThan(-1);
    expect(listItemsFrom(concise, firstUse + 1)).toEqual([
      "Trust the bound project in Codex (Security warning: remote execution permitted).",
    ]);
  });

  test("changed aliased projects retain activation through their authored report identity", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/private/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [codexTrust()],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
    });

    const concise = applyReportDocument(applyResult(receipt, resultingState));
    // The readiness statement is the trailing prose node; its wording is
    // golden-covered (no structured fact exists for it).
    expect(concise.at(-1)).toMatchObject({ kind: "prose" });
  });

  test("verbose standing reminder scope lists every Project without a concise escape hatch", () => {
    const projects = ["/p-1", "/p-2", "/p-3", "/p-4", "/p-5", "/p-6"].map((project) =>
      installation(project, [codexTrust()]),
    );
    const report = emptyReport({
      desired: projects,
      items: projects.map((desired) => ({ kind: "current", project: desired.project })),
    });

    // Concise clean status stays quiet; verbose retains the full Project scope.
    expect(lifecycleStatusDocument(report).map(shape)).toEqual(["notice:success"]);
    const verbose = lifecycleStatusDocument(report, { verbose: true });
    expect(listItemsIn(verbose)).toContain(
      "Trust the bound project in Codex. (/p-1, /p-2, /p-3, /p-4, /p-5, /p-6)",
    );
    expect(listItemsIn(verbose).filter((text) =>
      text.startsWith("Trust the bound project in Codex.")
    )).toHaveLength(1);
  });

  test("blocked apply suppresses Host setup for work that did not happen", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "blocked", project: "/project-a" }],
    });

    // Blocked apply suppresses all Host setup presentation: no first-use
    // heading or items, no verbose setup headings, no setup-step copy.
    const blockedApply = blockedApplyReportDocument(asBlockedReport(report));
    expect(headingsIn(blockedApply)).not.toContain("First use:");
    expect(headingsIn(blockedApply)).not.toContain("Host setup:");
    expect(headingsIn(blockedApply)).not.toContain("Standing Host setup:");
    expect(listItemsIn(blockedApply).some((text) =>
      text.includes("Review and approve the generated SessionStart hook") ||
      text.includes("Trust the bound project in Codex.")
    )).toBe(false);
    expect(flattenPresentationNodes(blockedApply).some((node) =>
      node.kind === "prose" &&
      (nodeText(node).includes("Review and approve the generated SessionStart hook") ||
        nodeText(node).includes("Trust the bound project in Codex."))
    )).toBe(false);
  });

  test("post-commit verification failure retains apply setup without claiming activation", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [codexTrust()])],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    // The failure view keeps first-use guidance as list items under its
    // heading and never claims activation.
    const failure = applyVerificationFailureDocument(report, "Verification failed.");
    const firstUse = indexWhere(
      failure,
      (node) => node.kind === "heading" && nodeText(node) === "First use:",
    );
    expect(firstUse).toBeGreaterThan(-1);
    expect(listItemsFrom(failure, firstUse + 1)).toEqual([expect.stringContaining("Trust the bound project in Codex")]);
  });
});

describe("responsive lifecycle presentation", () => {

  test("wraps applied lifecycle prose to the selected width", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [{
          host: "codex",
          kind: "trust-required",
          message: "Trust the bound project in Codex.",
          consequence: "Profile Context does not load until the project is trusted.",
          provenance: "standing",
        }],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const applied = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    for (const width of [40, 80, 100]) {
      // Status wrapping is asserted by golden snapshots; apply wraps here.
      const view = renderBoundary(
        applyReportDocument(applyResult(receipt, applied)),
        context(width),
      );
      for (const line of view.trimEnd().split("\n")) {
        expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  test("keeps copyable Project paths and command invocations intact while wrapping prose", () => {
    const project = "/tmp/agent profile kit/project with a long name";
    const report = identityReport(project);
    // At a narrow width the selected-Project command argument shortens through
    // displayPath (INT-2) so each command stays on one fitting line; with room
    // to spare the copyable Project path survives intact.
    const status = renderBoundary(
      lifecycleStatusDocument(report, { selection: { command: "status", kind: "project", match: "exact", target: project } }),
      context(40),
    );
    const wideStatus = renderBoundary(
      lifecycleStatusDocument(report, { selection: { command: "status", kind: "project", match: "exact", target: project } }),
      context(80),
    );
    const emptyStatus = renderBoundary(lifecycleStatusDocument(emptyReport()), context(40));

    for (const line of status.split("\n")) {
      if (!line.startsWith("Next: apkit apply") && !line.startsWith("Details: apkit status")) {
        continue;
      }
      expect(line.split("\n")).toHaveLength(1);
      expect(line.length, `command exceeds width: ${line}`).toBeLessThanOrEqual(40);
      expect(line).toContain("…");
    }
    expect(status).toContain("apkit apply");
    expect(wideStatus).toContain(`apkit apply ${project}`);
    expect(wideStatus).toContain(`apkit status ${project} --verbose`);
    expect(emptyStatus).toContain("apkit list projects");
    expect(emptyStatus).toContain("apkit bind <profile> --host <host>");

    // A command invocation inside an opaque carried message is no longer
    // re-identified or promoted: structural commands are authored as parts
    // and pinned by the presentation-document equivalence tests.
  });

  test("keeps diagnostic paths and authored Context payloads intact", () => {
    const prefixedPath = "/tmp/project with spaces/config.toml";
    const warningPath = "/tmp/agent profile home/config.toml";
    const arbitraryPath = "/tmp/project with spaces/.grok/skills/foo";
    const pathWithConjunction = "/tmp/project and team/.grok/skills/foo";
    const replacementPath = "/tmp/$& spaced/project";
    const authoredContext = "First Context Module\n--- end Context ---\nSecond Context Module\n";
    const repairTarget = "/tmp/repository with spaces/.git/info/exclude";
    const markerCandidates = "\u0000apkit-command \u0000apkit-value";
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: authoredContext,
        outputs: ["context.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "stale source", project: "/project-a" }],
      repositoryExclusions: [{
        current: [],
        installed: false,
        next: ["/tmp/owned path.md"],
        target: repairTarget,
      }],
      diagnosticValues: [
        prefixedPath,
        warningPath,
        arbitraryPath,
        pathWithConjunction,
        replacementPath,
        markerCandidates,
      ],
      warnings: [
        `Review ${prefixedPath}: repair ${warningPath} \u0001\u0002`,
        `Inspect ${arbitraryPath} for the generated Skill output.`,
        `Inspect ${pathWithConjunction} because it is missing.`,
        `Inspect ${replacementPath} for marker replacement.`,
        `Check ${prefixedPath} then repair ${warningPath} ${markerCandidates}`,
      ],
      warningParts: [
        ["Review ", identifierPart(prefixedPath), ": repair ", identifierPart(warningPath), " \u0001\u0002"],
        ["Inspect ", identifierPart(arbitraryPath), " for the generated Skill output."],
        ["Inspect ", identifierPart(pathWithConjunction), " because it is missing."],
        ["Inspect ", identifierPart(replacementPath), " for marker replacement."],
        ["Check ", identifierPart(prefixedPath), " then repair ", identifierPart(warningPath), ` ${markerCandidates}`],
      ],
    });

    const output = renderBoundary(
      lifecycleStatusDocument(report, { verbose: true }),
      context(40),
    );

    expect(output).toContain(prefixedPath);
    expect(output).toContain(warningPath);
    expect(output).toContain(arbitraryPath);
    expect(output).toContain(pathWithConjunction);
    expect(output).toContain(replacementPath);
    expect(output).toContain(markerCandidates);
    expect(output.split("\n").some((line) => line.includes(pathWithConjunction))).toBe(true);
    expect(output).toContain("\u0001\u0002");
    expect(output).toContain(repairTarget);
    expect(output).toContain(
      `---- begin Context ----\n${authoredContext}---- end Context ----\n`,
    );
  });

  test("keeps structurally supplied diagnostic values intact without parsing warning prose", () => {
    const value = "generated diagnostic path with spaces";
    const warning = `Inspect ${value} before continuing with this diagnostic.`;
    const report = emptyReport({
      diagnosticValues: [value],
      warnings: [warning],
      warningParts: [["Inspect ", identifierPart(value), " before continuing with this diagnostic."]],
    });
    const output = renderBoundary(lifecycleStatusDocument(report), context(40));

    expect(output).toContain(value);
  });

  test("wraps prose after a suffixless path without widening the line", () => {
    const path = "/tmp/foo";
    const output = renderBoundary(lifecycleStatusDocument(emptyReport({
      warnings: [`Inspect ${path} and then explain this warning with enough prose to wrap cleanly.`],
      warningParts: [["Inspect ", identifierPart(path), " and then explain this warning with enough prose to wrap cleanly."]],
    })), context(40));

    expect(output).toContain(path);
  });

  test("preserves a typed path without relying on warning prose", () => {
    const path = "~/untyped project with spaces";
    const warning = `Inspect ${path} before continuing with this diagnostic.`;
    const output = renderBoundary(lifecycleStatusDocument(emptyReport({
      diagnosticValues: [path],
      warnings: [warning],
      warningParts: [["Inspect ", identifierPart(path), " before continuing with this diagnostic."]],
    })), context(40));

    expect(output).toContain(path);
    expect(output).not.toContain("untyped project with\n");
  });

  test("warning nodes contain structured identifier parts without substring re-identification", () => {
    const projectPath = "/Users/test/projects/my-project";
    const report = emptyReport({
      warnings: [`Inspect ${projectPath} for generated configuration.`],
      warningParts: [
        ["Inspect ", identifierPart(projectPath), " for generated configuration."],
      ],
    });
    const doc = lifecycleStatusDocument(report);
    const nodes = flattenPresentationNodes(doc);
    const warningListItem = nodes.find((node) =>
      node.kind === "list-item" &&
      node.parts.some((part) => typeof part === "object" && part.kind === "identifier" && part.value === projectPath)
    ) as Extract<PresentationNode, { kind: "list-item" }> | undefined;
    expect(warningListItem).toBeDefined();
    expect(warningListItem?.parts.slice(0, -1)).toEqual([
      "Inspect ",
      { kind: "identifier", value: projectPath },
      " for generated configuration.",
    ]);
  });

  test("adapter-authored warning document retains structured identifier parts through normalization pipeline", () => {
    const projectPath = "/projects/my-app";
    const globalPath = "/home/user/.codex/config.toml";
    const adapterWarnings: AdapterDiagnosticWarning[] = [
      {
        copyableValues: [globalPath, `${projectPath}/.codex/config.toml`],
        parts: [
          "Codex SessionStart hooks are not enabled by ",
          identifierPart(globalPath),
          "; generated Profile Context may not load until [features].hooks = true is set in ",
          identifierPart(`${projectPath}/.codex/config.toml`),
          " or ",
          identifierPart(globalPath),
        ],
      },
    ];

    // Normalize through appendDiagnosticWarnings
    const normalizedWarnings: AdapterDiagnosticWarning[] = [];
    appendDiagnosticWarnings(normalizedWarnings, adapterWarnings);

    // Form ReconciliationReport
    const report = machineReport([
      machineProject(projectPath, {
        warnings: normalizedWarnings.map((w) => ({
          copyableValues: [...w.copyableValues],
          kind: "diagnostic" as const,
          parts: w.parts,
        })),
      }),
    ]);

    const doc = lifecycleStatusDocument(report);
    const nodes = flattenPresentationNodes(doc);
    const warningItem = nodes.find((node) =>
      node.kind === "list-item" &&
      node.parts.some((part) => typeof part === "object" && part.kind === "identifier" && part.value === globalPath)
    ) as Extract<PresentationNode, { kind: "list-item" }> | undefined;

    expect(warningItem).toBeDefined();
    expect(warningItem?.parts.slice(0, -1)).toEqual([
      "Codex SessionStart hooks are not enabled by ",
      { kind: "identifier", value: globalPath },
      "; generated Profile Context may not load until [features].hooks = true is set in ",
      { kind: "identifier", value: `${projectPath}/.codex/config.toml` },
      " or ",
      { kind: "identifier", value: globalPath },
    ]);
  });

  test("adapter-authored capability failure warning document retains structured identifier parts through normalization pipeline", () => {
    const projectPath = "/projects/my-app";
    const agentsPath = `${projectPath}/.agents`;
    const failure = capabilityFailure(
      "antigravity",
      "project",
      `Antigravity project surface cannot host Context: ${agentsPath} is a file, not a directory`,
      "ensure the Antigravity Context surface is a directory, then retry",
      [{ kind: "path", value: agentsPath }],
      [
        "Antigravity project surface cannot host Context: ",
        identifierPart(agentsPath),
        " is a file, not a directory",
      ],
    );

    const capWarning = capabilityWarning("antigravity", failure);

    const report = machineReport([
      machineProject(projectPath, {
        warnings: [
          {
            copyableValues: [...capWarning.warning.copyableValues],
            kind: "host-attention",
            parts: capWarning.warning.parts,
          },
        ],
      }),
    ]);

    const doc = lifecycleStatusDocument(report);
    const nodes = flattenPresentationNodes(doc);
    const warningItem = nodes.find((node) =>
      node.kind === "list-item" &&
      node.parts.some((part) => typeof part === "object" && part.kind === "identifier" && part.value === agentsPath)
    ) as Extract<PresentationNode, { kind: "list-item" }> | undefined;

    expect(warningItem).toBeDefined();
    expect(warningItem?.parts.slice(0, -1)).toEqual([
      "Antigravity project surface cannot host Context: ",
      { kind: "identifier", value: agentsPath },
      " is a file, not a directory",
    ]);
  });
});

describe("temporary-installation Project identity in documents", () => {
  function receiptFixture(project: string, setupSteps: readonly HostSetupStep[] = []): TemporaryInstallationReceiptView {
    return {
      completionState: "installed",
      diagnosticValues: [],
      host: "codex",
      outputs: [],
      profileId: "coding",
      project,
      setupSteps: [...setupSteps],
      temporaryInstallationId: "temporary-installation-opaque-id",
      warnings: [],
    };
  }

  test("presents bound-project Host Setup Steps through the canonical path presenter", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const project = join(home, "projects", "alpha");
      const document = temporaryInstallationDocument(
        "install-temp",
        receiptFixture(project, [{
          host: "codex",
          kind: "launch-constraint",
          message: "Launch Codex from the exact bound project root:",
          path: "bound-project",
          provenance: "standing",
        }]),
        process.cwd(),
        home,
      );

      const step = flattenPresentationNodes(document).find((node) =>
        node.kind === "list-item" && nodeText(node).startsWith("Launch Codex from")
      ) as Extract<PresentationNode, { kind: "list-item" }>;
      const stepText = nodeText(step);
      expect(stepText).toBe("Launch Codex from the exact bound project root: ~/projects/alpha");
      // The rendered receipt presents the Project only through the canonical
      // presenter; the raw path never reaches the rendered text.
      const rendered = renderPresentationDocument(
        temporaryInstallationDocument(
          "install-temp",
          receiptFixture(project, [{
            host: "codex",
            kind: "launch-constraint",
            message: "Launch Codex from the exact bound project root:",
            path: "bound-project",
            provenance: "standing",
          }]),
          process.cwd(),
          home,
        ),
        { color: false, interactive: false, width: 10_000 },
        { cwd: process.cwd(), home },
      );
      expect(rendered).not.toContain(project);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

function expectUserFacingVocabulary(view: string): void {
  for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(view).not.toMatch(term);
}

/** Concise ownership evidence has problem, requirement, remedy, scope and
 * group heading, followed by one prose node per immediate-parent group.
 * Read the group structure without parsing labels, counts or indentation. */
function trackedPathGroups(document: PresentationDocument): PresentationNode[] {
  const nodes = document;
  const start = nodes.findIndex((node) => node.kind === "prose" && node.category === "error");
  expect(start).toBeGreaterThan(-1);
  const groups: PresentationNode[] = [];
  for (const node of nodes.slice(start + 4)) {
    if (node.kind !== "prose" || node.category !== undefined || inlineCommandTexts([node]).length > 0) break;
    groups.push(node);
  }
  return groups;
}

/** Group identities are fixture paths; their surrounding copy stays in goldens. */
function expectTrackedGroups(document: PresentationDocument, identities: readonly string[]): void {
  const groups = trackedPathGroups(document);
  expect(groups).toHaveLength(identities.length);
  groups.forEach((node, index) => expect(nodeText(node)).toContain(identities[index]!));
}

/** Top-level receipt evidence ends before the separator for the next section.
 * Its last prose is the freshly-current evidence; the preceding nodes are
 * Applied operations. Fixtures must contain a committed, resulting-current Project. */
function currentEvidenceIndex(nodes: readonly PresentationNode[], pending = false): number {
  const applied = nodes.findIndex((node) => node.kind === "heading" && node.text === "Applied:");
  expect(applied).toBeGreaterThan(-1);
  const boundary = nodes.findIndex((node, index) => index > applied && node.kind === "verbatim");
  expect(boundary).toBeGreaterThan(applied);
  const current = boundary - 1;
  expect(nodes[current]).toMatchObject({ kind: "prose" });
  expect(nodeText(nodes[current]!)).toContain("/project-a");
  expect(nodeText(nodes[current]!)).not.toContain("a.md");
  if (pending) {
    expect(nodes[current + 2]).toMatchObject({ kind: "prose" });
    expect(nodeText(nodes[current + 2]!)).toContain("/project-c");
  }
  return current;
}

/** The state-explanation glosses: the list items following the
 * "State explanations:" heading, in document order. */
function explanationItems(document: PresentationDocument): string[] {
  const nodes = flattenPresentationNodes(document);
  const start = indexWhere(nodes, (node) =>
    node.kind === "heading" && nodeText(node) === "State explanations:");
  if (start < 0) return [];
  return listItemsFrom(nodes, start + 1);
}

describe("status concise terminology", () => {
  test("blocked lifecycle reports lead with the blocker and suppress planned changes", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/project-a", reason: "occupied output" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
      blockers: [
        fixtureBlocker("/project-a/a.md is occupied by unowned or drifted output", "/project-a"),
      ],
    });

    for (const command of ["status", "apply"] as const) {
      const document = command === "apply"
        ? blockedApplyReportDocument(asBlockedReport(report))
        : lifecycleStatusDocument(report);
      const nodes = flattenPresentationNodes(document);

      // Blocked views lead with Blocker evidence and carry no planned-change
      // summary or per-Project state bookkeeping.
      const blockerIndex = indexWhere(nodes, (node) =>
        node.kind === "prose" && node.category === "error");
      const summaryIndex = nodes.lastIndexOf(noticesIn(document).at(-1)!);
      expect(blockerIndex).toBeGreaterThan(-1);
      expect(summaryIndex).toBeGreaterThan(blockerIndex);
      expect(nodes.some((node) => node.kind === "heading" && nodeText(node) === "Project changes:")).toBe(false);
      expect(keyValuesIn(document, "  State")).toEqual([]);
    }
  });

  test("structured blocker evidence drives human and machine views from one record", () => {
    const structured = emptyReport({
      blockers: [normalizeBlocker({
        action: "verify",
        affectedItems: [{ kind: "host", value: "codex" }],
        failure: { case: "unsafe-parent", output: ".codex/hooks.json", parent: "/project-a/.codex" },
        kind: "installation-ownership",
        project: "/project-a",
        scope: "project",
      })],
    });

    // Human views render presentation-owned wording keyed by the typed kind;
    // machine JSON publishes the verbatim stored sentences from one lexicon.
    const document = lifecycleStatusDocument(structured);
    expect(document.filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(1);
    const machine = machineReport([
      machineProject("/project-a", { blockers: reportBlockers(structured) }),
    ]);
    expect(JSON.parse(formatLifecycleJson("status", machine))).toMatchObject({
      schemaVersion: 14,
      globalBlockers: [],
      projects: [{
        project: "/project-a",
        blockers: [{
          affectedItems: [{ kind: "host", value: "codex" }],
          kind: "installation-ownership",
          message: "Cannot verify ownership of generated files: the recorded generated " +
            "file '.codex/hooks.json' has a parent path '/project-a/.codex' that is not a " +
            "regular directory inside the Project.",
          problem: "Cannot verify ownership of generated files: the recorded generated " +
            "file '.codex/hooks.json' has a parent path '/project-a/.codex' that is not a " +
            "regular directory inside the Project.",
          project: "/project-a",
          remedy: "Manual recovery is required: Agent Profile Kit will not adopt or delete " +
            "files it cannot prove. Inspect ls -ld '/project-a/.codex', restore it to a " +
            "regular directory inside the Project yourself, then run apkit apply " +
            "'/project-a'; or run apkit unbind '/project-a' to stop managing this Project " +
            "(its generated files stay on disk).",
          requirement:
            "Agent Profile Kit changes or removes generated files only when ownership " +
            "is proven by the installation record at safe paths.",
          scope: "project",
        }],
      }],
    });
  });

  test("renders every structured blocker field directly from nested Project evidence", () => {
    const report = machineReport([
      machineProject("/project-a", {
        blockers: [normalizeBlocker({
          action: "verify",
          affectedItems: [{ kind: "host", value: "codex" }],
          failure: { case: "unsafe-parent", output: ".codex/hooks.json", parent: "/project-a/.codex" },
          kind: "installation-ownership",
          project: "/project-a",
          scope: "project",
        })],
        state: { kind: "blocked", reason: "Host capability unavailable" },
      }),
    ]);

    const concise = lifecycleStatusDocument(report);
    const nodes = flattenPresentationNodes(concise);
    const blockerIndex = indexWhere(nodes, (node) =>
      node.kind === "prose" && node.category === "error");
    expect(blockerIndex).toBeGreaterThan(-1);
    // Every structured field is its own prose node in the typed evidence block.
    expect(nodes.slice(blockerIndex + 1, blockerIndex + 4).map(shape)).toEqual(["prose", "prose", "prose"]);
    // The remedy carries the evidence-derived scoped commands as atomic parts.
    expect(inlineCommandTexts([nodes[blockerIndex + 2]!])).toContain("apkit apply '/project-a'");
    expect(inlineCommandTexts([nodes[blockerIndex + 2]!])).toContain("apkit unbind '/project-a'");
    expect(nodeText(nodes[blockerIndex + 3]!)).toContain("codex");
  });

  test("preserves task-authored warning text and typed copyable values without translation", () => {
    const value = "generated diagnostic value with spaces";
    const report = machineReport([
      machineProject("/project-a", {
        warnings: [{
          copyableValues: [value],
          kind: "diagnostic",
          parts: ["Use reconcile as authored; inspect ", identifierPart(value), " before continuing."],
        }],
      }),
    ]);

    const output = renderBoundary(
      lifecycleStatusDocument(report),
      { color: false, interactive: true, width: 40 },
    );

    expect(output).toContain("Use reconcile as authored;");
    expect(output).toContain(value);
    expect(output).not.toContain("generated diagnostic value with\n");
    expect(output).not.toContain("Use sync as authored");
  });

  test("groups tracked-output ownership conflicts into one explained blocker with deterministic directory groups", () => {
    const project = "/project-a";
    const paths = [
      ".agent-profile-kit/codex/context.md",
      ".agents/skills/s01",
      ".agents/skills/s02",
      ".agents/skills/s03",
      ".agents/skills/s04",
      ".agents/skills/s05",
      ".agents/skills/s06",
      ".agents/skills/s07",
      ".agents/skills/s08",
      ".agents/skills/s09",
      ".agents/skills/s10",
      ".agents/skills/s11",
      ".agents/skills/s12",
      ".claude/rules/agent-profile-kit.md",
      ".codex/hooks.json",
    ];
    const report = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: paths,
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project, reason: "tracked path" }],
      blockers: [normalizeBlocker(outputOwnershipConflictBlocker({ paths, project }))],
    });

    const concise = lifecycleStatusDocument(report);
    const conciseNodes = flattenPresentationNodes(concise);

    // One explained Blocker: the problem, one Requirement, one Remedy carrying
    // both alternatives, the grouped Affected paths, and no untracking command.
    expect(conciseNodes.filter((node) =>
      node.kind === "prose" && node.category === "error"
    )).toHaveLength(1);
    const blockerAt = conciseNodes.findIndex((node) => node.kind === "prose" && node.category === "error");
    expect(conciseNodes.slice(blockerAt + 1, blockerAt + 4).map(shape)).toEqual(["prose", "prose", "prose"]);
    expectTrackedGroups(concise, [
      ".agent-profile-kit/codex/context.md",
      ".agents/skills/",
      ".claude/rules/agent-profile-kit.md",
      ".codex/hooks.json",
    ]);
    // Affected-path group lines elide deep members in the concise view; the
    // remedy's command arguments carry them.
    expect(proseTexts(concise).some((text) =>
      text.includes("/project-a/.agents/skills/s08")
    )).toBe(false);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const verboseTexts = proseTexts(verbose);

    // Every proven path is an Affected path node; one Requirement.
    expect(verboseTexts.some((text) => text.includes("/project-a/.agents/skills/s11"))).toBe(true);
    expect(verboseTexts.some((text) => text.includes("/project-a/.agents/skills/s12"))).toBe(true);
    expect(verboseTexts.some((text) => text.includes("/project-a/.codex/hooks.json"))).toBe(true);
    // The evidence-derived untracking command is carried in every view (#440);
    // the verbose pointer redirect is retired.
    for (const document of [concise, verbose]) {
      expect(inlineCommandTexts(flattenPresentationNodes(document)))
        .toContain(untrackCommandFor("/project-a", [...paths]));
      expect(proseTexts(document).join("\n"))
        .not.toContain("to see the exact untracking command");
    }
  });

  test("renders every tracked path in one parent-directory group without an overflow cap", () => {
    const project = "/project-a";
    const paths = Array.from(
      { length: 11 },
      (_, index) => `.agents/skills/s${String(index + 1).padStart(2, "0")}`,
    );
    const report = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: paths,
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project, reason: "tracked path" }],
      blockers: [normalizeBlocker(outputOwnershipConflictBlocker({ paths, project }))],
    });

    const concise = lifecycleStatusDocument(report);

    expectTrackedGroups(concise, [".agents/skills/"]);
  });

  test("keeps project-scoped ownership conflicts distinct from global blockers", () => {
    const project = "/project-a";
    const report = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: [".codex/hooks.json"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project, reason: "tracked path" }],
      blockers: [
        normalizeBlocker(outputOwnershipConflictBlocker({
          paths: [".codex/hooks.json"],
          project,
        })),
        normalizeBlocker({
          affectedItems: [{ kind: "path", value: "/home/.agents/agent-profile-kit/state/manifest.json" }],
          detail: "Installation State is unreadable",
          kind: "installation-state-unreadable",
          scope: "global",
        }),
      ],
    });

    const concise = lifecycleStatusDocument(report);
    const nodes = flattenPresentationNodes(concise);

    expect(headingsIn(concise)).toContain("Global blockers:");
    expect(nodes.filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(2);
    const projectAt = indexWhere(nodes, (node) =>
      node.kind === "list-item" && typeof node.parts?.[0] === "string" && node.parts[0].includes("needs attention"));
    const globalAt = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Global blockers:");
    expect(projectAt).toBeGreaterThan(-1);
    expect(projectAt).toBeLessThan(globalAt);
  });

  const ownershipReport = (
    paths: readonly string[],
    project = "/project-a",
  ): ReconciliationReport =>
    emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: [...paths],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project, reason: "tracked path" }],
      blockers: [
        normalizeBlocker(outputOwnershipConflictBlocker({ paths: [...paths], project })),
      ],
    });

  const untrackCommandFor = (project: string, paths: readonly string[]): string =>
    `git --literal-pathspecs -C '${project}' rm -r --cached -- ${[...paths]
      .sort((left, right) => compareCanonicalStrings(left, right))
      .map((path) => `'${path.replaceAll("'", "'\\''")}'`)
      .join(" ")}`;

  test("groups concise tracked paths by immediate parent directory with lossless counts (#353)", () => {
    const paths = [
      ".agents/skills/b/deep.md",
      ".agents/skills/a.md",
      ".agents/skills/c.md",
      ".codex/hooks.json",
      "AGENTS.md",
      "README.md",
    ];
    const concise = lifecycleStatusDocument(ownershipReport(paths));

    expectTrackedGroups(concise, [
      "./",
      ".agents/skills/",
      ".agents/skills/b/deep.md",
      ".codex/hooks.json",
    ]);
  });

  test("assigns paths under overlapping prefixes to exactly one group each (#353)", () => {
    const paths = [
      ".a/b/c.txt",
      ".a/b/d/e.txt",
      ".a/b/f.txt",
    ];
    const concise = lifecycleStatusDocument(ownershipReport(paths));

    expectTrackedGroups(concise, [
      ".a/b/",
      ".a/b/d/e.txt",
    ]);
  });

  test("renders concise tracked-path groups deterministically across repeated calls (#353)", () => {
    const paths = [
      ".b/two.md",
      ".a/one.md",
      ".a/sub/three.md",
      "root.md",
    ];
    const first = lifecycleStatusDocument(ownershipReport(paths));
    const second = lifecycleStatusDocument(ownershipReport(paths));

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // Groups sort by canonical parent-directory key: ".", ".a", ".a/sub", ".b".
    expectTrackedGroups(first, [
      "root.md",
      ".a/one.md",
      ".a/sub/three.md",
      ".b/two.md",
    ]);
  });

  test("focused verbose status prints one copyable untracking command with every proven path exactly once (#353)", () => {
    const paths = [
      ".b/space name.md",
      ".a/one.md",
      "-leading-dash.md",
      "weird'name.md",
    ];
    const focusedVerbose = lifecycleStatusDocument(ownershipReport(paths), {
      blockersOnly: true,
      verbose: true,
    });

    const gitCommands = inlineCommandTexts(flattenPresentationNodes(focusedVerbose)).filter((text) =>
      text.includes("rm -r --cached"));
    expect(gitCommands).toHaveLength(1);
    // The remedy carries the exact invocation as one atomic command part;
    // every proven path appears once as its own quoted argument (#440).
    expect(gitCommands[0]).toBe(untrackCommandFor("/project-a", paths));
    expect(gitCommands[0]).toContain("git --literal-pathspecs -C '/project-a' rm -r --cached --");
    expect(gitCommands[0]).toContain("-- '-leading-dash.md'");
    expect(gitCommands[0]).toContain("'weird'\\''name.md'");
  });

  test("the verbose remedy frames the working-files statement and the unbind choice (#440)", () => {
    const focusedVerbose = lifecycleStatusDocument(
      ownershipReport([".codex/hooks.json"]),
      { blockersOnly: true, verbose: true },
    );
    const remedyParts = flattenPresentationNodes(focusedVerbose)
      .filter((node) => node.kind === "prose" &&
        nodeText(node).startsWith("  Remedy: "))
      .map((node) => nodeText(node));
    expect(remedyParts).toHaveLength(1);
    expect(remedyParts[0]).toContain("stages their removal from the Git index");
    expect(remedyParts[0]).toContain("the files stay on disk");
    expect(remedyParts[0]).toContain("To keep Git ownership instead");
  });

  test("ordinary concise, focused concise, and ordinary verbose all carry the command (#440)", () => {
    const report = ownershipReport([".codex/hooks.json", ".agents/skills/s01.md"]);
    const concise = lifecycleStatusDocument(report);
    const focusedConcise = lifecycleStatusDocument(report, { blockersOnly: true });
    const verbose = lifecycleStatusDocument(report, { verbose: true });

    for (const document of [concise, focusedConcise, verbose]) {
      expect(inlineCommandTexts(flattenPresentationNodes(document))).toContain(
        untrackCommandFor("/project-a", [".agents/skills/s01.md", ".codex/hooks.json"]),
      );
      // The verbose pointer redirect is retired.
      expect(proseTexts(document).join("\n"))
        .not.toContain("to see the exact untracking command");
    }
  });

  test("focused verbose apply views print the command while ordinary apply verbose only points to it (#353)", () => {
    const paths = [".codex/hooks.json", ".agents/skills/s01.md"];
    const project = "/project-b";
    const receipt = emptyReport({
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: [...paths],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project, reason: "tracked path" }],
      blockers: [
        normalizeBlocker(outputOwnershipConflictBlocker({ paths: [...paths], project })),
      ],
    });
    const command = untrackCommandFor("/project-b", paths);

    const focusedApply = applyReportDocument(
      applyResult(receipt, resultingState),
      { blockersOnly: true, verbose: true },
    );
    // Every apply view carries the evidence-derived command inline (#440).
    expect(inlineCommandTexts(flattenPresentationNodes(focusedApply))).toContain(command);

    const blockedApply = blockedApplyReportDocument(
      asBlockedReport(resultingState),
      { blockersOnly: true, verbose: true },
    );
    expect(inlineCommandTexts(flattenPresentationNodes(blockedApply))).toContain(command);

    const executionFailure = applyExecutionFailureDocument({
      detail: "Apply failed while writing the Project",
      failedProject: executionProject(project),
      message: "Apply failed while writing the Project",
      pendingProjects: [],
      receipt,
      resultingState,
    }, { blockersOnly: true, verbose: true });
    expect(inlineCommandTexts(flattenPresentationNodes(executionFailure))).toContain(command);

    const ordinaryVerbose = flattenPresentationNodes(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    expect(inlineCommandTexts(ordinaryVerbose)).toContain(command);
  });

  test("verification-failure views carry the command in focused and ordinary verbose (#440)", () => {
    const paths = [".codex/hooks.json"];
    const project = "/project-b";
    const receipt = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: [...paths],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project, reason: "tracked path" }],
      blockers: [
        normalizeBlocker(outputOwnershipConflictBlocker({ paths: [...paths], project })),
      ],
    });
    const message = "Apply verification failed";

    const focused = applyVerificationFailureDocument(receipt, message, {
      blockersOnly: true,
      verbose: true,
    });
    expect(inlineCommandTexts(flattenPresentationNodes(focused)))
      .toContain(untrackCommandFor("/project-b", paths));

    const ordinary = flattenPresentationNodes(
      applyVerificationFailureDocument(receipt, message, { verbose: true }),
    );
    expect(inlineCommandTexts(ordinary)).toContain(untrackCommandFor("/project-b", paths));
  });

  test("large tracked-path sets render lossless groups and one complete command (#353)", () => {
    const paths = [
      ...Array.from({ length: 60 }, (_, index) => `.agents/skills/s${String(index).padStart(3, "0")}`),
      ...Array.from({ length: 60 }, (_, index) => `.codex/prompts/p${String(index).padStart(3, "0")}`),
      ...Array.from({ length: 30 }, (_, index) => `.opencode/agent/o${String(index).padStart(3, "0")}.md`),
    ];
    const concise = lifecycleStatusDocument(ownershipReport(paths));
    expectTrackedGroups(concise, [
      ".agents/skills/",
      ".codex/prompts/",
      ".opencode/agent/",
    ]);

    const focusedVerbose = lifecycleStatusDocument(ownershipReport(paths), {
      blockersOnly: true,
      verbose: true,
    });
    const gitCommands = inlineCommandTexts(flattenPresentationNodes(focusedVerbose)).filter((text) =>
      text.includes("rm -r --cached"));
    // One complete command: 150 paths plus the project, each shell-quoted.
    expect(gitCommands).toHaveLength(1);
    expect((gitCommands[0] ?? "").match(/'/g)).toHaveLength(302);
  });

  test("narrow terminals keep the untracking command on one unsplit line (#353)", () => {
    const paths = [
      ".codex/hooks.json",
      ".agents/skills/a skill with spaces.md",
      ".claude/rules/agent-profile-kit.md",
    ];
    const focusedVerbose = lifecycleStatusDocument(ownershipReport(paths), {
      blockersOnly: true,
      verbose: true,
    });
    const command = untrackCommandFor("/project-a", paths);

    // The atomic command node renders on one unsplit line at any width.
    const rendered = renderBoundary(focusedVerbose, { color: false, interactive: true, width: 40 });
    expect(rendered.split("\n").filter((line) => line.includes(command))).toHaveLength(1);
  });

  test("machine JSON publishes the same evidence-derived command in the remedy (#440)", () => {
    const paths = [".codex/hooks.json", ".agents/skills/s01.md"];
    const report = ownershipReport(paths);

    const json = formatLifecycleJson("status", report);
    expect(json).toContain(
      "git --literal-pathspecs -C '/project-a' rm -r --cached -- " +
        "'.agents/skills/s01.md' '.codex/hooks.json'",
    );
    for (const path of paths) {
      expect(json.split(JSON.stringify(path))).toHaveLength(2);
    }
    expect(JSON.parse(json).projects[0].blockers[0].affectedItems).toEqual(
      paths.sort(compareCanonicalStrings).map((path) => ({ kind: "path", value: path })),
    );
  });

  test("identifies the working-directory project as dot", () => {
    const project = process.cwd();
    const report = identityReport(project);

    const verbose = lifecycleStatusDocument(report, {
      selection: { command: "status", kind: "project", match: "containing", target: project },
      verbose: true,
    });
    const nodes = flattenPresentationNodes(verbose);
    const projectsIndex = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Projects:");
    expect(projectsIndex).toBeGreaterThan(-1);
    // The identity is a typed identifier part carrying the cwd alias.
    expect(inlineIdentifiers([nodes[projectsIndex + 1]!])).toEqual(["."]);
    expect(presentationTexts(verbose).some((text) => text.includes(project))).toBe(false);
  });

  test("identifies an ancestor project relative to the working directory", () => {
    const project = dirname(process.cwd());
    const report = identityReport(project);

    const verbose = lifecycleStatusDocument(report, {
      selection: { command: "status", kind: "project", match: "containing", target: project },
      verbose: true,
    });
    const nodes = flattenPresentationNodes(verbose);
    const projectsIndex = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Projects:");
    expect(projectsIndex).toBeGreaterThan(-1);
    expect(inlineIdentifiers([nodes[projectsIndex + 1]!])).toEqual([".."]);
    expect(presentationTexts(verbose).some((text) => text.includes(project))).toBe(false);
  });

  test("fleet status names the working-directory Project by home-relative identity", () => {
    const current = process.cwd();
    const other = join(homedir(), "other-fleet-project");
    const report = emptyReport({
      desired: [current, other].map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      })),
      items: [current, other].map((project) => ({ kind: "addition" as const, project })),
      outputs: [current, other].map((project) => ({
        kind: "addition" as const,
        path: "a.md",
        project,
      })),
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const concise = lifecycleStatusDocument(report);
    const homeRelative = current === homedir()
      ? "~"
      : current.startsWith(`${homedir()}/`)
      ? `~/${current.slice(homedir().length + 1)}`
      : current;

    const nodes = flattenPresentationNodes(verbose);
    const projectsIndex = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Projects:");
    expect(projectsIndex).toBeGreaterThan(-1);
    expect(nodes.slice(projectsIndex + 1).some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: homeRelative },
        ": addition",
      ])
    )).toBe(true);
    // No node carries a bare cwd alias in state or Profile lines.
    const verboseTexts = presentationTexts(verbose);
    expect(inlineIdentifiers(verbose)).not.toContain(".");
    // The concise Project key-value never presents a bare cwd alias.
  });

  test("identifies another home project with a home-relative path", () => {
    const project = join(homedir(), "another-project");
    const report = identityReport(project);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const projectsIndex = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Projects:");
    expect(projectsIndex).toBeGreaterThan(-1);
    expect(inlineIdentifiers([nodes[projectsIndex + 1]!])).toEqual(["~/another-project"]);
    expect(presentationTexts(verbose).some((text) => text.includes(project))).toBe(false);
  });

  test("keeps canonical paths short through symlinked home and working-directory aliases", () => {
    const physicalHome = mkdtempSync(join(tmpdir(), "agent-profile-kit-display-home-"));
    const logicalHome = `${physicalHome}-alias`;
    const physicalProjects = join(physicalHome, "projects");
    symlinkSync(physicalHome, logicalHome, "dir");
    mkdirSync(physicalProjects);
    const physicalProject = join(physicalProjects, "project");
    mkdirSync(join(physicalProject, "nested"), { recursive: true });
    const logicalCwd = join(logicalHome, "projects", "project", "nested");
    const canonicalProject = realpathSync(physicalProject);

    try {
      expect(displayPath(canonicalProject, canonicalProject, "project", "/outside", logicalHome)).toBe(
        "~/projects/project",
      );
      expect(displayPath(canonicalProject, canonicalProject, "project", logicalCwd, logicalHome)).toBe("..");
    } finally {
      rmSync(logicalHome, { force: true });
      rmSync(physicalHome, { force: true, recursive: true });
    }
  });

  test("fleet scope keeps a stable home-relative identity instead of a cwd alias", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-display-scope-"));
    try {
      const project = join(home, "projects", "alpha");
      mkdirSync(join(project, "nested"), { recursive: true });
      const nested = join(project, "nested");

      expect(displayPath(project, project, "project", project, home)).toBe(".");
      expect(displayPath(project, project, "project", nested, home)).toBe("..");
      expect(displayPath(project, project, "fleet", project, home)).toBe("~/projects/alpha");
      expect(displayPath(project, project, "fleet", nested, home)).toBe("~/projects/alpha");
      expect(displayProjectPath(project, project, "fleet", project, home)).toBe(
        "~/projects/alpha",
      );
      expect(displayProjectPath(project, project, "project", project, home)).toBe(".");
      for (const relativePath of [".", "..", "../alpha"]) {
        expect(displayPath(relativePath, relativePath, "fleet", project, home)).toBe(
          `relative path ${JSON.stringify(relativePath)}`,
        );
      }
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("lists committed paths under the short project identity in the apply receipt", () => {
    const project = join(homedir(), "receipt-project");
    const receipt = identityReport(project);

    // The concise receipt summarizes above one Project and names no Project
    // receipt block; the operation summary and named paths are prose nodes.
    const concise = applyReportDocument(applyResult(receipt, emptyReport()));
    expect(headingsIn(concise)).toContain("Applied:");
    expect(keyValuesIn(concise, "Project")).toEqual([]);
    expect(flattenPresentationNodes(concise).some((node) =>
      node.kind === "prose" && nodeText(node).includes("receipt-project")
    )).toBe(true);

    // Verbose receipt opens with the Applied section in Projects detail.
    const verbose = applyReportDocument(applyResult(receipt, emptyReport()), { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    // The Applied section carries its own Projects detail after the section heading.
    const projects = indexWhere(
      nodes.slice(applied + 1),
      (node) => node.kind === "heading" && nodeText(node) === "Projects:",
    ) + applied + 1;
    expect(applied).toBeGreaterThan(-1);
    expect(projects).toBeGreaterThan(applied);
    // The state lines pair a typed identifier part (fixture identity) with
    // the item kind.
    const identityStateLine = (identity: string, kind: string) => nodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: identity },
        `: ${kind}`,
      ]));
    expect(identityStateLine("~/receipt-project", "addition")).toBe(true);
    expect(identityStateLine("~/receipt-project/a.md", "addition")).toBe(true);
  });

  test("labels remaining and committed apply work distinctly", () => {
    const receipt = identityReport("/project-a");
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    // Successful changed apply: Applied section with the operation summary,
    // no already-current statement, no status-style Changes summary.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    const conciseNodes = flattenPresentationNodes(concise);
    expect(headingsIn(concise)).toContain("Applied:");
    expect(conciseNodes.some((node) =>
      node.kind === "prose"
    )).toBe(true);
    // No already-current prose among the receipt nodes: the concise document
    // ends at the guidance.
    expect(conciseNodes.some((node) => node.kind === "heading" && nodeText(node) === "Project changes:")).toBe(false);

    // Verbose apply separates Pending from Applied and has no resulting-state
    // section label.
    const verbose = applyReportDocument(applyResult(receipt, resultingState), { verbose: true });
    const verboseNodes = flattenPresentationNodes(verbose);
    const pending = indexWhere(verboseNodes, (node) => node.kind === "heading" && nodeText(node) === "Pending:");
    const applied = indexWhere(verboseNodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(pending).toBeGreaterThan(-1);
    expect(applied).toBeGreaterThan(pending);
    expect(verboseNodes.some((node) =>
      node.kind === "heading" && (nodeText(node) === "Resulting state:" || nodeText(node) === "Apply receipt:")
    )).toBe(false);
  });

  test("names the Hosts recorded by each Project Binding", () => {
    const project = join(homedir(), "multi-host-project");
    const report = identityReport(project, ["claude", "codex"]);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    // The Selected-setup block binds the fixture identity to the fixture
    // Profile and Hosts; the composed glue is golden-covered.
    const hostsIndex = indexWhere(nodes, (node) =>
      node.kind === "prose" && nodeText(node).includes("claude") && nodeText(node).includes("codex"));
    expect(hostsIndex).toBeGreaterThan(-1);
    expect(nodeText(nodes[hostsIndex - 1]!)).toContain("~/multi-host-project");
  });

  test("keeps displayed identities distinct for projects with the same basename", () => {
    const first = join(homedir(), "team-a", "project");
    const second = join(homedir(), "team-b", "project");
    const current = join(homedir(), "other-project");
    const report = emptyReport({
      desired: [first, second, current].map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      })),
      items: [
        ...[first, second].map((project) => ({ kind: "addition" as const, project })),
        { kind: "current" as const, project: current },
      ],
      outputs: [
        ...[first, second].map((project) => ({
          kind: "addition" as const,
          path: "a.md",
          project,
        })),
        { kind: "unchanged" as const, path: "a.md", project: current },
      ],
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const stateLines = projectStateLines(verbose);
    expect(stateLines).toContain("~/team-a/project");
    expect(stateLines).toContain("~/team-b/project");
  });

  test("keeps an outside-home project absolute", () => {
    const project = "/var/tmp/outside-home-project";
    const report = identityReport(project);

    expect(projectStateLines(lifecycleStatusDocument(report, { verbose: true }))).toContain(project);
  });

  test("preserves an authored path when its canonical spelling differs", () => {
    const canonicalProject = "/private/var/tmp/aliased-project";
    const authoredProject = "/var/tmp/aliased-project";
    const report = identityReport(canonicalProject);
    const aliasedReport = emptyReport({
      desired: reportDesired(report).map((installation) => ({
        ...installation,
        project: authoredProject,
      })),
      items: reportItems(report),
      outputs: reportOutputs(report),
    });

    const verbose = lifecycleStatusDocument(aliasedReport, { verbose: true });
    const stateLines = projectStateLines(verbose);
    expect(stateLines).toContain(authoredProject);
    expect(stateLines).not.toContain(canonicalProject);
  });

  test("preserves an authored home-relative path when its canonical spelling differs", () => {
    const canonicalProject = "/private/var/tmp/aliased-project";
    const authoredProject = "~/aliased-project";
    const report = identityReport(canonicalProject);
    const aliasedReport = emptyReport({
      desired: reportDesired(report).map((installation) => ({
        ...installation,
        project: authoredProject,
      })),
      items: reportItems(report),
      outputs: reportOutputs(report),
    });

    const verbose = lifecycleStatusDocument(aliasedReport, { verbose: true });
    const stateLines = projectStateLines(verbose);
    expect(stateLines).toContain(authoredProject);
    expect(stateLines).not.toContain(canonicalProject);
  });

  test("keeps authored home-relative identity across fleet aggregations", () => {
    const canonicalProject = "/private/var/tmp/aliased-project";
    const authoredProject = "~/aliased-project";
    const otherProject = "/var/tmp/other-project";
    const setupStep: HostSetupStep = {
      consequence: "Declining the hook prevents Profile Context from loading.",
      host: "codex",
      kind: "approval-required",
      message: "Review and approve the generated SessionStart hook when Codex asks.",
      output: ".codex/hooks.json",
      provenance: "transition",
    };
    const desired = [
      {
        canonicalProject,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: authoredProject,
        resolvedArtifacts: [],
        setupSteps: [setupStep],
      },
      {
        canonicalProject: otherProject,
        context: "composed",
        outputs: ["b.md"],
        profile: "coding",
        project: otherProject,
        resolvedArtifacts: [],
        setupSteps: [setupStep],
      },
    ];
    const operations = emptyReport({
      desired,
      items: [
        { kind: "update", project: authoredProject },
        { kind: "addition", project: otherProject },
      ],
      outputs: [
        { kind: "update", path: "a.md", project: authoredProject },
        { kind: "addition", path: "b.md", project: otherProject },
      ],
    });
    const blocked = emptyReport({
      desired,
      items: [
        { kind: "blocked", project: authoredProject, reason: "hooks disabled" },
        { kind: "current", project: otherProject },
      ],
      blockers: [fixtureBlocker(`${canonicalProject}: hooks disabled`, canonicalProject)],
    });

    const concise = lifecycleStatusDocument(operations);
    const verbose = lifecycleStatusDocument(operations, { verbose: true });
    const blockedConcise = lifecycleStatusDocument(blocked);

    expect(proseTexts(concise).some((text) => text.includes("~/aliased-project"))).toBe(true);
    expect(proseTexts(verbose).some((text) => text.includes("~/aliased-project") && text.includes("/var/tmp/other-project"))).toBe(true);
    expect(proseTexts(blockedConcise).some((text) => text.includes("~/aliased-project"))).toBe(true);
    for (const document of [concise, verbose, blockedConcise]) {
      // Identity prose stays home-relative; recovery commands carry the
      // canonical absolute path as their runnable argument (#440).
      expect(proseTexts(document).some((text) =>
        text.includes(canonicalProject)
      )).toBe(false);
    }
  });

  test("keeps internal vocabulary out of every default lifecycle view", () => {
    for (const kind of NON_CURRENT_STATE_ORDER) {
      const report = emptyReport({
        desired: [{
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        }],
        items: [{
          kind,
          project: "/project-a",
          reason: "Project setup needs a sync",
        }],
        outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
        repositoryExclusions: [{
          current: [],
          next: ["/a.md"],
          target: "/project-a/.git/info/exclude",
          installed: false,
        }],
        warnings: [
          "A generated file differs from its installation record; restore the selected Project setup",
        ],
        blockers: kind === "blocked"
          ? [
              fixtureBlocker(
                "/project-a: Cannot sync the selected Project setup",
                "/project-a",
              ),
              fixtureBlocker(
                "A generated file has a Git exclusion blocker",
              ),
            ]
          : [],
      });
      const defaultViews = [
        lifecycleStatusDocument(report),
        applyReportDocument(applyResult(report)),
      ];

      for (const view of defaultViews) {
        expectUserFacingVocabulary(renderBoundary(view));
      }
    }
  });

  test("preserves user values that contain internal vocabulary", () => {
    const project = "/tmp/reconcile/Profile Installation/generated-output";
    const exclusionTarget = "/tmp/reconcile/Repository Exclusion/info/exclude";
    const exclusionEntry = "/generated-output/reconcile";
    const report = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: ["generated-output/reconcile"],
        profile: "reconcile",
        project,
        resolvedArtifacts: [],
      }],
      items: [{
        kind: "addition",
        project,
        reason: `Profile 'reconcile' reads /tmp/reconcile/generated-output`,
      }],
      outputs: [{ kind: "addition", path: "generated-output/reconcile", project }],
      repositoryExclusions: [{
        current: [],
        installed: false,
        next: [exclusionEntry],
        target: exclusionTarget,
      }],
      warnings: [`Review /tmp/reconcile/generated-output for Profile 'reconcile'`],
    });

    const conciseStatus = lifecycleStatusDocument(report);
    const statusTexts = presentationTexts(conciseStatus);
    // User-authored values ride the warning list item verbatim.
    expect(statusTexts.some((text) => text.includes("/tmp/reconcile/generated-output"))).toBe(true);
    expect(statusTexts.some((text) => text.includes("'reconcile'"))).toBe(true);
    expect(statusTexts.some((text) => text.includes(exclusionTarget))).toBe(false);
    expect(statusTexts.some((text) => text.includes(exclusionEntry))).toBe(false);

    const concise = applyReportDocument(applyResult(report));
    const applyNodes = flattenPresentationNodes(concise);
    // Project identity, Profile, and receipt paths carry the user-authored
    // values intact through typed nodes.
    expect(keyValuesIn(concise, "Project")).toHaveLength(1);
    expect(keyValuesIn(concise, "  Profile")).toHaveLength(1);
    expect(keyValuesIn(concise, "  Profile")[0]!.value).toEqual({ kind: "identifier", value: "reconcile" });
    expect(applyNodes.some((node) =>
      node.kind === "prose" && nodeText(node).includes(project)
    )).toBe(true);
    expect(applyNodes.some((node) =>
      node.kind === "prose" && nodeText(node).includes("generated-output/reconcile")
    )).toBe(true);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const verboseTexts = presentationTexts(verbose);
    expect(verboseTexts.some((text) => text.includes(project))).toBe(true);
    expect(inlineIdentifiers(verbose)).toContain("/tmp/reconcile/Profile Installation/generated-output");
    expect(verboseTexts.some((text) => text.includes("generated-output/reconcile"))).toBe(true);
    expect(inlineIdentifiers(verbose)).toEqual(expect.arrayContaining([exclusionTarget, exclusionEntry]));
  });

  test("renders task-authored apply verification failures without semantic translation", () => {
    const receipt = emptyReport({
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const message = "Cannot verify the selected Project setup from its installation record";
    // The task-authored message rides verbatim inside the error notice, and
    // the vocabulary guard holds over the whole document.
    const conciseNotices = noticesIn(applyVerificationFailureDocument(receipt, message));
    expect(conciseNotices).toEqual([
      { kind: "notice", severity: "error", nodes: [{ kind: "prose", parts: [message] }] },
    ]);
    expectUserFacingVocabulary(
      renderBoundary(applyVerificationFailureDocument(receipt, message)),
    );

    const verbose = applyVerificationFailureDocument(receipt, message, { verbose: true });
    expect(noticesIn(verbose)).toEqual(conciseNotices);
    expect(headingsIn(verbose)).toEqual(expect.arrayContaining(["Applied:", "Git exclusions:", "Selected setup:"]));
  });

  test("concise status names drifted refresh work and destructive removals", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a", "b", "c", "d", "e"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "drifted output", project: "/project-a", reason: "f.md" }],
      outputs: [
        { kind: "update", path: "f.md", project: "/project-a" },
        { kind: "removal", path: "e.md", project: "/project-a" },
      ],
    });

    const concise = lifecycleStatusDocument(report);

    // The ready summary is a success notice; the project is classified under generated files changed.
    expect(noticesIn(concise)).toHaveLength(1);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    const listItems = concise.filter((node) => node.kind === "list-item");
    expect(listItems.some((node) => flatInlineText(node.parts).includes("generated files changed (1):"))).toBe(true);
    expect(listItems.some((node) => flatInlineText(node.parts).includes("/project-a"))).toBe(true);
    // The verbose route is a typed command value on the Details key-value.
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
    expect(headingsIn(concise)).not.toContain("Selected setup:");
    expect(headingsIn(concise)).not.toContain("Outputs:");
  });

  test("destructive removal remains visible in verbose output while concise suppresses routine paths", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["z.md", "a.md", "m.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [
        { kind: "removal", path: "z.md", project: "/project-a" },
        { kind: "addition", path: "a.md", project: "/project-a" },
        { kind: "update", path: "m.md", project: "/project-a" },
      ],
    });

    const concise = lifecycleStatusDocument(report);
    expect(presentationTexts(concise).some((text) =>
      text.includes("m.md") || text.includes("a.md") || text.includes("z.md")
    )).toBe(false);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    expect(presentationTexts(verbose).some((text) => text.includes("z.md"))).toBe(true);
  });

  test("hides routine generated paths behind one verbose route", () => {
    const project = "/project-a";
    const paths = Array.from({ length: 12 }, (_, index) => `file-${String(index + 1).padStart(2, "0")}.md`);
    const report = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: paths,
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project }],
      outputs: paths.map((path) => ({ kind: "addition" as const, path, project })),
    });

    const concise = lifecycleStatusDocument(report);

    // No routine path appears in the concise document; the one verbose route
    // is the typed Details command value.
    expect(flattenPresentationNodes(concise).some((node) =>
      nodeText(node).includes("file-")
    )).toBe(false);
    expect(keyValuesIn(concise, "Details")).toHaveLength(1);
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const verboseNodes = flattenPresentationNodes(verbose);
    // Each generated path is an Outputs-section prose node with a typed
    // identifier part carrying the full path.
    const outputLine = (path: string) => verboseNodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        ": addition",
      ]));
    expect(outputLine("/project-a/file-11.md")).toBe(true);
    expect(outputLine("/project-a/file-12.md")).toBe(true);
  });

  test("keeps attention paths and removals visible in verbose output ahead of concise summary", () => {
    const project = "/project-a";
    const additions = Array.from(
      { length: 10 },
      (_, index) => ({ kind: "addition" as const, path: `a-${index + 1}.md`, project }),
    );
    const report = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: additions.map((output) => output.path),
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "update", project }],
      outputs: [
        ...additions,
        { kind: "removal", path: "z-removal.md", project },
      ],
    });

    const concise = lifecycleStatusDocument(report);
    expect(presentationTexts(concise).some((text) => text.includes("a-1.md"))).toBe(false);
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    expect(presentationTexts(verbose).some((text) => text.includes("z-removal.md"))).toBe(true);
  });

  test("verbose output keeps generated-root attention authoritative", () => {
    const project = "/project-a";
    const report = emptyReport({
      items: [{ kind: "drifted output", project, reason: "skill" }],
      outputs: [
        { kind: "update", path: "skill", project },
        { kind: "unchanged", path: "context.md", project },
      ],
    });

    const concise = lifecycleStatusDocument(report);
    const listItems = concise.filter((node) => node.kind === "list-item");
    expect(listItems.some((node) => flatInlineText(node.parts).includes("generated files changed"))).toBe(true);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const verboseNodes = flattenPresentationNodes(verbose);
    const outputLine = (path: string, kind: string) => verboseNodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));
    expect(outputLine("/project-a/skill", "update")).toBe(true);
    expect(outputLine("/project-a/context.md", "unchanged")).toBe(true);
  });

  test("keeps every present non-current state definition available in verbose output", () => {
    for (const kind of NON_CURRENT_STATE_ORDER) {
      const report = emptyReport({
        desired: [{
          canonicalProject: "/solo",
          context: "composed",
          outputs: [],
          profile: "coding",
          project: "/solo",
          resolvedArtifacts: [],
        }],
        items: [
          kind === "blocked"
            ? { kind, project: "/solo", reason: "hooks disabled" }
            : { kind, project: "/solo" },
        ],
        blockers: kind === "blocked"
          ? [fixtureBlocker("/solo: hooks disabled", "/solo")]
          : [],
      });

      const concise = lifecycleStatusDocument(report);
      expect(headingsIn(concise)).not.toContain("State explanations:");
      const glosses = explanationItems(lifecycleStatusDocument(report, { verbose: true }));
      expect(glosses).toHaveLength(1);
      expect(glosses[0]).toMatch(new RegExp(`^${kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .+`));
      expect(glosses[0]!.length).toBeGreaterThan(`${kind}: `.length);
    }

    const currentOnly = emptyReport({
      desired: [{
        canonicalProject: "/current",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/current",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/current" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/current" }],
    });
    const allCurrent = lifecycleStatusDocument(currentOnly);
    expect(headingsIn(allCurrent)).not.toContain("State explanations:");
  });

  test("keeps state definitions behind the explicit verbose view", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "stale source", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });

    const concise = lifecycleStatusDocument(report);
    const verbose = lifecycleStatusDocument(report, { verbose: true });

    expect(headingsIn(concise)).not.toContain("State explanations:");
    expect(explanationItems(verbose)).toHaveLength(1);
  });

  test("blocked reports suppress planned detail for otherwise actionable projects", () => {
    const report = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          outputs: ["b"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
        },
      ],
      items: [
        { kind: "stale source", project: "/project-a" },
        { kind: "stale source", project: "/project-b" },
        { kind: "blocked", project: "/project-b", reason: "hooks disabled" },
      ],
      outputs: [
        { kind: "update", path: "a.md", project: "/project-a" },
        { kind: "update", path: "b.md", project: "/project-b" },
        { kind: "addition", path: "c.md", project: "/project-b" },
      ],
      blockers: [fixtureBlocker("/project-b: hooks disabled", "/project-b")],
    });

    const concise = lifecycleStatusDocument(report);
    const conciseNodes = flattenPresentationNodes(concise);
    // Only the blocked Project presents its binding block; no planned-change
    // summary or state explanations.
    const conciseText = renderBoundary(concise);
    expect(conciseText).toContain("- needs attention (1):");
    expect(conciseText).toContain("/project-b");
    expect(conciseText).toContain("- source changed (1): /project-a");
    expect(proseOccurrences(concise, "/project-b")).toBe(1);
    expect(concise.filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(1);
    expect(headingsIn(concise)).not.toContain("State explanations:");
    expect(headingsIn(concise)).not.toContain("Changes:");

    for (const command of ["status", "apply"] as const) {
      const verbose = command === "apply"
        ? blockedApplyReportDocument(asBlockedReport(report), { verbose: true })
        : lifecycleStatusDocument(report, { verbose: true });
      // The populated Blockers section leads the verbose view, ahead of the
      // Projects detail.
      const nodes = flattenPresentationNodes(verbose);
      const blockersHeading = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Blockers:");
      const projectsHeading = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Projects:");
      expect(blockersHeading).toBeGreaterThan(-1);
      expect(projectsHeading).toBeGreaterThan(blockersHeading);
      expect(nodes.slice(blockersHeading, projectsHeading).filter((node) => node.kind === "list-item")).toHaveLength(1);
      expect(nodes.some((node) => node.kind === "prose" && nodeText(node).includes("/project-b"))).toBe(true);
    }
  });

  test("orders verbose state definitions stably by NON_CURRENT_STATE_ORDER", () => {
    const present: readonly ReconciliationKind[] = ["removal", "blocked", "addition", "stale source"];
    const report = emptyReport({
      desired: present.map((kind, index) => ({
        canonicalProject: `/p${index}`,
        context: "composed",
        outputs: [],
        profile: "coding",
        project: `/p${index}`,
        resolvedArtifacts: [],
      })),
      items: present.map((kind, index) =>
        kind === "blocked"
          ? { kind, project: `/p${index}`, reason: "hooks disabled" }
          : { kind, project: `/p${index}` },
      ),
    });

    const glosses = explanationItems(
      lifecycleStatusDocument(report, { verbose: true }),
    );
    const kinds = glosses.map((line) => line.slice(0, line.indexOf(":")));
    expect(kinds).toEqual(NON_CURRENT_STATE_ORDER.filter((kind) => present.includes(kind)));
  });

  test("places verbose state definitions after Projects for unscoped items", () => {
    const report = emptyReport({
      items: [{ kind: "removal", project: "/orphan" }],
    });
    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const projectsAt = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Projects:");
    const explanationsAt = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "State explanations:");
    expect(projectsAt).toBeGreaterThan(-1);
    expect(explanationsAt).toBeGreaterThan(projectsAt);
    expect(projectStateLines(verbose)).toContain("/orphan");
    expect(explanationItems(verbose)).toHaveLength(1);
  });

  test("summarizes Git exclusions in one default clause and keeps exact deltas in --verbose", () => {
    const target = "/repo/.git/info/exclude";
    const report = emptyReport({
      desired: [{
        canonicalProject: "/repo",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/repo",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/repo" }],
      outputs: [{ kind: "addition", path: ".agent-profile-kit/codex/context.md", project: "/repo" }],
      repositoryExclusions: [{
        current: ["/.old-path.md"],
        installed: false,
        next: ["/.agent-profile-kit/codex/context.md", "/.codex/hooks.json"],
        target,
      }],
    });

    const concise = lifecycleStatusDocument(report);

    expect(headingsIn(concise)).not.toContain("Git exclusions:");
    expect(presentationTexts(concise).some((text) =>
      text.includes(target) || text.includes("/.old-path.md")
    )).toBe(false);
    // The one default clause points at the typed Details command value.
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const exclusionLine = flattenPresentationNodes(verbose).find((node) =>
      node.kind === "list-item" && inlineIdentifiers([node])[0] === target);
    expect(inlineIdentifiers([exclusionLine!])).toEqual([target, "/.agent-profile-kit/codex/context.md", "/.codex/hooks.json", "/.old-path.md"]);
  });

  test("blocked reports retain the pending Git exclusion clause", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/repo",
        context: "composed",
        outputs: ["context.md"],
        profile: "coding",
        project: "/repo",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/repo", reason: "occupied output" }],
      blockers: [fixtureBlocker("/repo: occupied output", "/repo")],
      repositoryExclusions: [{
        current: [],
        next: ["/.agent-profile-kit/codex/context.md"],
        target: "/repo/.git/info/exclude",
        installed: false,
      }],
      warnings: [
        "/repo/.git/info/exclude is missing its Agent Profile Kit exclusion section; apply will restore recorded exact entries",
      ],
    });

    const concise = lifecycleStatusDocument(report);
    const conciseTexts = presentationTexts(concise);

    expect(concise.filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(1);
    expect(conciseTexts.some((text) => text.includes("/repo/.git/info/exclude"))).toBe(false);
  });

  test("--verbose still renders complete diagnostics from the same ReconciliationReport", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "First Context Module\n--- end Context ---\nSecond Context Module\n",
        hosts: ["claude", "codex"],
        outputs: [".agent-profile-kit/codex/context.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [{
          id: "team-rules",
          inclusionReasons: [{ path: [], profile: "coding" }],
          type: "context",
        }],
      }],
      items: [{ kind: "stale source", project: "/project-a" }],
      outputs: [
        { kind: "update", path: ".agent-profile-kit/codex/context.md", project: "/project-a" },
        { kind: "unchanged", path: ".codex/hooks.json", project: "/project-a" },
      ],
      repositoryExclusions: [{
        current: [],
        next: ["/.agent-profile-kit/codex/context.md"],
        target: "/project-a/.git/info/exclude",
        installed: false,
      }],
      warnings: ["example warning"],
      blockers: [fixtureBlocker("/project-a: example blocker", "/project-a")],
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const texts = presentationTexts(verbose);

    // The outcome notice leads; every verbose section follows with its typed nodes.
    expect(noticesIn(verbose)[0]).toMatchObject({ kind: "notice", severity: "error" });
    const sectionAt = (text: string) => indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === text);
    for (const section of ["Projects:", "Outputs:", "Git exclusions:", "Selected setup:", "Blockers:", "State explanations:"]) {
      expect(sectionAt(section)).toBeGreaterThan(-1);
    }
    expect(headingsIn(verbose)).not.toContain("Warnings:");
    expect(projectStateLines(verbose)).toContain("/project-a");
    const outputLine = (path: string, kind: string) => nodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));
    expect(outputLine("/project-a/.agent-profile-kit/codex/context.md", "update")).toBe(true);
    expect(outputLine("/project-a/.codex/hooks.json", "unchanged")).toBe(true);
    const exclusionLine = nodes.find((node) =>
      node.kind === "list-item" && inlineIdentifiers([node])[0] === "/project-a/.git/info/exclude");
    expect(inlineIdentifiers([exclusionLine!])).toEqual(["/project-a/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);
    expect(texts.some((text) =>
      text.includes("/project-a") && text.includes("coding")
    )).toBe(true);
    expect(texts.some((text) => text.includes("claude") && text.includes("codex"))).toBe(true);
    expect(texts.some((text) => text.includes("context:team-rules") && text.includes("coding"))).toBe(true);
    // Composed Context is verbatim content reproduced exactly (DEC-008).
    const verbatim = nodes.find((node) =>
      node.kind === "verbatim" && nodeText(node).includes("First Context Module"));
    // The verbatim node reproduces the authored Context byte-for-byte,
    // delimiters and fence escalation included (DEC-008).
    expect(verbatim).toEqual({
      kind: "verbatim",
      text: "---- begin Context ----\n" +
        "First Context Module\n" +
        "--- end Context ---\n" +
        "Second Context Module\n" +
        "---- end Context ----",
    });
    expect(listItemsIn(verbose)).toContain("example warning (/project-a)");
    expect(nodes.filter((node) => node.kind === "list-item").some((node) => nodeText(node).includes("example blocker"))).toBe(true);
    expect(texts.some((text) => text.includes("/project-a"))).toBe(true);
    expect(texts.some((text) => text.includes("generated-output"))).toBe(false);
  });

  test("verbose apply keeps published exclusion guidance in the receipt tense", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/repo",
        context: "composed",
        outputs: ["context.md"],
        profile: "coding",
        project: "/repo",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/repo" }],
      repositoryExclusions: [{
        current: [],
        installed: true,
        next: ["/.agent-profile-kit/codex/context.md"],
        target: "/repo/.git/info/exclude",
      }],
    });
    const result = emptyReport({
      desired: reportDesired(receipt),
      items: reportItems(receipt),
      outputs: reportOutputs(receipt),
    });

    const status = lifecycleStatusDocument(receipt);
    const statusTexts = presentationTexts(status);
    expect(keyValuesIn(status, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
    expect(statusTexts.some((text) =>
      text.includes("/repo/.git/info/exclude") ||
      text.includes("/.agent-profile-kit/codex/context.md")
    )).toBe(false);

    const verbosePending = lifecycleStatusDocument(receipt, { verbose: true });
    const pendingNodes = flattenPresentationNodes(verbosePending);
    expect(pendingNodes.filter((node) => node.kind === "list-item").map((node) => inlineIdentifiers([node]))).toContainEqual(["/repo/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);

    // Concise receipt carries no Git-exclusion clause for this unchanged
    // receipt; the success notice opens the view.
    const concise = applyReportDocument(applyResult(receipt, result));
    expect(headingsIn(concise)).not.toContain("Git exclusions:");
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });

    const verbose = applyReportDocument(applyResult(receipt, result), { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(applied).toBeGreaterThan(-1);
    const exclusions = indexWhere(
      nodes.slice(applied),
      (node) => node.kind === "heading" && nodeText(node) === "Git exclusions:",
    );
    expect(exclusions).toBeGreaterThan(-1);
    expect(nodes.slice(applied).filter((node) => node.kind === "list-item").map((node) => inlineIdentifiers([node]))).toContainEqual(["/repo/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);
  });

  test("verbose apply explains non-current states once across pending and applied sections", () => {
    const receipt = emptyReport({
      items: [{ kind: "stale source", project: "/repo" }],
    });
    const resultingState = emptyReport({
      items: [{ kind: "drifted output", project: "/repo", reason: "a.md" }],
    });

    const verbose = applyReportDocument(applyResult(receipt, resultingState), { verbose: true });
    const nodes = verbose;

    // Exactly one State explanations section, listing pending and applied
    // non-current states in canonical order as consecutive list items.
    const sections = nodes.flatMap((node, index) =>
      node.kind === "heading" && nodeText(node) === "State explanations:" ? [index] : []);
    expect(sections).toHaveLength(1);
    expect(listItemsFrom(nodes, sections[0]! + 1)).toHaveLength(2);
  });

  test("apply only expands projects with receipt work", () => {
    const desired = [
      {
        canonicalProject: "/changed",
        context: "composed",
        outputs: ["changed.md"],
        profile: "coding",
        project: "/changed",
        resolvedArtifacts: [],
      },
      {
        canonicalProject: "/untouched",
        context: "composed",
        outputs: ["untouched.md"],
        profile: "coding",
        project: "/untouched",
        resolvedArtifacts: [],
      },
    ];
    const receipt = emptyReport({
      desired,
      items: [{ kind: "update", project: "/changed" }],
      outputs: [{ kind: "update", path: "changed.md", project: "/changed" }],
    });
    const resultingState = emptyReport({
      desired,
      items: [
        { kind: "current", project: "/changed" },
        { kind: "current", project: "/untouched" },
      ],
      outputs: [
        { kind: "unchanged", path: "changed.md", project: "/changed" },
        { kind: "unchanged", path: "untouched.md", project: "/untouched" },
      ],
    });

    // Receipt work drives the operation summary; Projects without receipt work
    // gain no receipt block.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    expect(headingsIn(concise)).toContain("Applied:");
    expect(flattenPresentationNodes(concise).some((node) =>
      node.kind === "prose" && nodeText(node).includes("/changed")
    )).toBe(true);
    expect(keyValuesIn(concise, "Project")).toEqual([]);
  });

  test("verified apply blockers change the outcome and preserve a nonzero-worthy state", () => {
    const resultingState = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/project-a", reason: "changed after commit" }],
      blockers: [fixtureBlocker("changed after commit", "/project-a")],
    });

    // Verified post-commit blockers flip the outcome to an error notice and
    // retain the resolve-and-retry next action.
    const concise = applyReportDocument(applyResult(emptyReport(), resultingState));
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "error" });
    expect(noticesIn(concise).map((node) => node.severity)).toEqual(["error", "error"]);
    expect(nextActionItems(concise).map(nextActionStructure)).toEqual([{ paths: [], commands: ["apkit apply"] }]);
  });

  test("execution failures label only applied receipt Projects as freshly current", () => {
    const receipt = emptyReport({
      items: [{ kind: "addition", project: "/applied" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/applied" }],
    });
    const resultingState = emptyReport({
      items: [
        { kind: "current", project: "/already-current" },
        { kind: "current", project: "/applied" },
        { kind: "addition", project: "/failed" },
      ],
    });

    const concise = flattenPresentationNodes(applyExecutionFailureDocument({
      detail: "Apply failed",
      failedProject: executionProject("/failed"),
      message: "Apply failed",
      pendingProjects: [],
      receipt,
      resultingState,
    }));

    expect(concise.at(-1)).toMatchObject({ kind: "prose" });
    expect(nodeText(concise.at(-1)!)).toContain("/applied");
    expect(nodeText(concise.at(-1)!)).not.toContain("a.md");
    expect(concise.some((node) =>
      node.kind === "prose" && nodeText(node).includes("/already-current")
    )).toBe(false);
  });

  test("execution failure headers preserve home-relative symlink aliases", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-failure-home-"));
    const failedTarget = mkdtempSync(join(tmpdir(), "agent-profile-kit-failed-target-"));
    const pendingTarget = mkdtempSync(join(tmpdir(), "agent-profile-kit-pending-target-"));
    try {
      const failedAlias = join(home, "failed-alias");
      const pendingAlias = join(home, "pending-alias");
      symlinkSync(failedTarget, failedAlias, "dir");
      symlinkSync(pendingTarget, pendingAlias, "dir");
      const failedCanonical = realpathSync(failedAlias);
      const pendingCanonical = realpathSync(pendingAlias);

      const document = applyExecutionFailureDocument({
        detail: "permission denied",
        failedProject: {
          canonicalProject: failedCanonical,
          project: "~/failed-alias",
        },
        message: `Apply failed at ${failedCanonical}: permission denied`,
        pendingProjects: [{
          canonicalProject: pendingCanonical,
          project: "~/pending-alias",
        }],
        receipt: emptyReport(),
        resultingState: undefined,
      }, { selection: { kind: "all" } });
      const nodes = flattenPresentationNodes(document);

      // Failure header, Failed Project, and Still pending prose carry the
      // authored home-relative aliases; canonical spellings stay out.
      expect(noticesIn(document)[0]).toMatchObject({ kind: "notice", severity: "error" });
      expect(nodes.some((node) => node.kind === "prose" && nodeText(node).includes("~/failed-alias"))).toBe(true);
      expect(nodes.some((node) => node.kind === "prose" && nodeText(node).includes("~/pending-alias"))).toBe(true);
      expect(nodes.some((node) => nodeText(node).includes(failedCanonical))).toBe(false);
      expect(nodes.some((node) => nodeText(node).includes(pendingCanonical))).toBe(false);
    } finally {
      rmSync(home, { force: true, recursive: true });
      rmSync(failedTarget, { force: true, recursive: true });
      rmSync(pendingTarget, { force: true, recursive: true });
    }
  });

  test("verification failures print the completed receipt without claiming current state", () => {
    const receipt = emptyReport({
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    // The task message opens as the error notice; the completed receipt follows
    // as Applied evidence, with no success outcome anywhere in the document.
    const concise = applyVerificationFailureDocument(
      receipt,
      "Apply committed; post-apply verification failed: transient read",
    );
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "error" });
    const nodes = flattenPresentationNodes(concise);
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(applied).toBeGreaterThan(-1);
    expect(nodes.slice(applied).some((node) => node.kind === "prose" && nodeText(node).includes("a.md"))).toBe(true);
    // A failure view carries no success-claim notice.
    expect(noticesIn(concise).every((notice) => notice.severity === "error")).toBe(true);
  });
});

/** The next-action bullets of a lifecycle document, asserted as structure. */
/** The typed "Next" key-value's command invocation, when the view carries one. */
function nextGuidance(document: PresentationDocument): string[] {
  const next = keyValuesIn(document, "Next")[0];
  if (next === undefined || next.value.kind !== "command") return [];
  const command = next.value;
  return [
    [command.program,
      ...command.args.map((arg) => arg.kind === "text" ? arg.value : "")]
      .filter((part) => part !== "").join(" "),
  ];
}

/** The list items following the "Next:" heading, as nodes. */
function nextActionItems(document: PresentationDocument): readonly PresentationNode[] {
  const nodes = flattenPresentationNodes(document);
  const start = indexWhere(nodes, (node) =>
    node.kind === "heading" && nodeText(node) === "Next:");
  if (start < 0) return [];
  const items: PresentationNode[] = [];
  for (let index = start + 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind !== "list-item") break;
    items.push(node);
  }
  return items;
}

/** The displayed-Blocker footer: the last error-category prose node of a
 * focused view (the Blocker lines precede it). */
function footerNode(document: PresentationDocument): PresentationNode | undefined {
  return flattenPresentationNodes(document)
    .filter((node) => node.kind === "prose" && node.category === "error")
    .at(-1);
}

/** One next-action item's structural content: its typed path identities and
 * inline command invocations — never the surrounding copy. */
function nextActionStructure(item: PresentationNode): {
  readonly paths: readonly { readonly canonicalPath: string; readonly scope: string }[];
  readonly commands: readonly string[];
} {
  const parts = item.kind === "list-item" ? item.parts : [];
  return {
    paths: parts.flatMap((part) =>
      typeof part === "string" || part.kind !== "path"
        ? []
        : [{ canonicalPath: part.canonicalPath, scope: part.scope }]),
    commands: inlineCommandTexts([item]),
  };
}

describe("status next-action guidance", () => {

  test("stale source status reports what changed and what to run", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "stale source", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });

    const concise = lifecycleStatusDocument(report);
    expect(nextGuidance(concise)).toEqual(["apkit apply"]);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    // The drift detail stays behind the verbose route; no routine path appears.
    expect(presentationTexts(concise).some((text) => text.includes("a.md"))).toBe(false);
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
  });

  test("ready status recommends apply", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const concise = lifecycleStatusDocument(report);
    expect(nextGuidance(concise)).toEqual(["apkit apply"]);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
  });

  test("blocked status retries status without recommending apply", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/project-a", reason: "hooks disabled" }],
      blockers: [fixtureBlocker("/project-a: hooks disabled", "/project-a")],
    });

    const status = lifecycleStatusDocument(report);
    // One item retrying status for the blocked Project; no apply guidance.
    expect(nextActionItems(status).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
    ]);
    // The outcome notice leads; the aggregate Blocker count follows it.
    expect(noticesIn(status)[0]).toMatchObject({ kind: "notice", severity: "error" });
  });

  test("blocked apply directs resolve-and-retry of apply", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/project-a", reason: "hooks disabled" }],
      blockers: [fixtureBlocker("/project-a: hooks disabled", "/project-a")],
    });

    expect(nextActionItems(applyReportDocument(applyResult(report))).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit apply"] },
    ]);
  });

  test("current status emits no next action", () => {
    const current = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    expect(nextGuidance(lifecycleStatusDocument(current))).toEqual([]);
  });


  test("a diagnostic warning on current output is not Host attention", () => {
    const current = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
      warnings: ["Codex hooks are disabled in this Project."],
    });

    const status = lifecycleStatusDocument(current);

    expect(noticesIn(status)).toHaveLength(1);
    expect(noticesIn(status)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(JSON.parse(formatLifecycleJson("status", current)).outcome).toBe("clean");
  });

  test("completed or no-op apply without blockers emits no next action", () => {
    const current = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    expect(nextActionItems(applyReportDocument(applyResult(current)))).toEqual([]);

    const appliedWithChanges = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });
    // Apply already completed; do not recommend another apply or status.
    expect(nextActionItems(applyReportDocument(applyResult(appliedWithChanges)))).toEqual([]);

    const metadataOnlyReceipt = emptyReport({
      desired: reportDesired(current),
      items: [{ kind: "update", project: "/project-a", reason: "desired output changed" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    const metadataOnlyResult = emptyReport({
      desired: reportDesired(current),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    // Metadata-only receipt work applies without an already-current statement
    // or a no-changes clause; verbose keeps the update evidence.
    // Metadata-only apply: one success notice and no per-Project receipt
    // block — no already-current prose, no zero-value clauses.
    const metadataDocument = applyReportDocument(applyResult(metadataOnlyReceipt, metadataOnlyResult));
    expect(noticesIn(metadataDocument)).toHaveLength(1);
    expect(noticesIn(metadataDocument)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(keyValuesIn(metadataDocument, "Project")).toEqual([]);
    expect(keyValuesIn(metadataDocument, "  State")).toEqual([]);
    expect(headingsIn(applyReportDocument(applyResult(metadataOnlyReceipt, metadataOnlyResult), { verbose: true }))).toContain("Applied:");
  });

  test("mixed multi-project guidance names ready work alongside blocked work", () => {
    const mixedBlocked = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          outputs: ["b"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
        },
      ],
      items: [
        { kind: "stale source", project: "/project-a" },
        { kind: "blocked", project: "/project-b", reason: "hooks disabled" },
      ],
      outputs: [
        { kind: "update", path: "a.md", project: "/project-a" },
        { kind: "update", path: "b.md", project: "/project-b" },
      ],
      blockers: [fixtureBlocker("/project-b: hooks disabled", "/project-b")],
    });

    const status = lifecycleStatusDocument(mixedBlocked);

    expect(nextActionItems(status).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
    ]);
  });

  test("global blockers suppress ready guidance for every project", () => {
    const globallyBlocked = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "stale source", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
      blockers: [fixtureBlocker("Installation State is unreadable")],
    });

    const status = lifecycleStatusDocument(globallyBlocked);

    expect(nextActionItems(status).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
    ]);
  });

  test("mixed actionable outcomes name only projects with work", () => {
    const mixedActionable = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          outputs: ["b"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
        },
      ],
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "stale source", project: "/project-b" },
      ],
      outputs: [
        { kind: "unchanged", path: "a.md", project: "/project-a" },
        { kind: "update", path: "b.md", project: "/project-b" },
      ],
    });

    const mixedStatus = lifecycleStatusDocument(mixedActionable);
    expect(nextGuidance(mixedStatus)).toEqual(["apkit apply"]);
    // The Details key-value carries the typed fleet-verbose command.
    expect(keyValuesIn(mixedStatus, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
  });

  test("--verbose does not append next-action guidance", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "stale source", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });

    expect(nextGuidance(lifecycleStatusDocument(report, { verbose: true }))).toEqual([]);
  });

  test("exclusion-only deltas remain pending work with a direct apply action", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/repo",
        context: "composed",
        outputs: ["a"],
        profile: "coding",
        project: "/repo",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/repo" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/repo" }],
      repositoryExclusions: [{
        current: [],
        next: ["/.agent-profile-kit/codex/context.md"],
        target: "/repo/.git/info/exclude",
        installed: false,
      }],
    });

    const status = lifecycleStatusDocument(report);
    expect(noticesIn(status)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(headingsIn(status)).not.toContain("Git exclusions:");
    expect(keyValuesIn(status, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
    expect(nextGuidance(status)).toEqual(["apkit apply"]);
  });

  test("status renders a nested desired Project with current state as current", () => {
    // The nested model always owns exactly one state record per Project.
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: [],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [],
      outputs: [],
    });

    const status = lifecycleStatusDocument(report);
    expect(status.map(shape)).toEqual(["notice:success"]);
    expect(nextGuidance(status)).toEqual([]);
  });

  test("multiple blocked projects each receive their own guidance", () => {
    const report = emptyReport({
      desired: [
        {
          canonicalProject: "/a",
          context: "composed",
          outputs: [],
          profile: "coding",
          project: "/a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/b",
          context: "composed",
          outputs: [],
          profile: "coding",
          project: "/b",
          resolvedArtifacts: [],
        },
      ],
      items: [
        { kind: "blocked", project: "/a", reason: "hooks disabled" },
        { kind: "blocked", project: "/b", reason: "tracked path" },
      ],
      blockers: [
        fixtureBlocker("/a: hooks disabled", "/a"),
        fixtureBlocker("/b: tracked path", "/b"),
      ],
    });

    expect(nextActionItems(lifecycleStatusDocument(report)).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
    ]);
  });
});

describe("Machine surface JSON and exit codes", () => {
  const project = "/project-a";
  const desired = {
    context: "composed",
    hosts: ["codex"] as const,
    outputs: ["a.md"],
    profile: "coding",
    resolvedArtifacts: [],
  };

  test("lifecycle JSON publishes complete nested Project evidence under schema version 7", () => {
    const blocker = fixtureBlocker("CLI missing", project);
    const report = machineReport([
      machineProject(project, {
        desired,
        state: { kind: "addition" },
        outputs: [{ kind: "addition", path: "a.md", consumingHosts: ["codex"] }],
        blockers: [blocker],
        warnings: [{
          copyableValues: ["/copy/me"],
          kind: "diagnostic",
          parts: ["Review ", identifierPart("/copy/me")],
        }],
        setupSteps: [{
          host: "codex",
          kind: "approval-required",
          message: "Approve the hook.",
          output: ".codex/hooks.json",
          provenance: "transition",
        }],
        repositoryExclusions: [{
          current: [],
          next: ["/.agent-profile-kit/"],
          target: "/project-a/.git/info/exclude",
          installed: false,
        }],
      }),
    ]);

    const payload = JSON.parse(formatLifecycleJson("status", report));
    expect(payload.schemaVersion).toBe(14);
    expect(payload.command).toBe("status");
    expect(payload.outcome).toBe("blocked");
    expect(payload.globalBlockers).toEqual([]);
    expect(payload.projects).toEqual([{
      canonicalProject: project,
      project,
      desired: { profile: "coding", hosts: ["codex"] },
      state: { kind: "addition" },
      outputs: [{ kind: "addition", path: "a.md", consumingHosts: ["codex"] }],
      blockers: [{
        affectedItems: [],
        kind: "installation-ownership",
        message: "Cannot verify ownership of generated files: the recorded generated " +
          "file 'CLI missing' does not match the installation record and no other " +
          "recorded file proves ownership.",
        problem: "Cannot verify ownership of generated files: the recorded generated " +
          "file 'CLI missing' does not match the installation record and no other " +
          "recorded file proves ownership.",
        project,
        remedy: "Manual recovery is required: Agent Profile Kit will not adopt or " +
          "delete files it cannot prove. Inspect ls -ld '/project-a/CLI missing', " +
          "remove or restore it yourself, then run apkit apply '/project-a'; or run " +
          "apkit unbind '/project-a' to stop managing this Project (its generated " +
          "files stay on disk).",
        requirement:
          "Agent Profile Kit changes or removes generated files only when ownership " +
          "is proven by the installation record at safe paths.",
        scope: "project",
      }],
      warnings: [{ message: "Review /copy/me", copyableValues: ["/copy/me"], kind: "diagnostic" }],
      setupSteps: [{
        host: "codex",
        kind: "approval-required",
        message: "Approve the hook.",
        output: ".codex/hooks.json",
        provenance: "transition",
      }],
      repositoryExclusions: [{
        current: [],
        next: ["/.agent-profile-kit/"],
        target: "/project-a/.git/info/exclude",
      }],
    }]);
    expect(payload).not.toHaveProperty("installations");
    expect(payload).not.toHaveProperty("outputs");
    expect(lifecycleExitCode(report)).toBe(2);
  });

  test("machine JSON preserves warning and Git exclusion attribution across Projects", () => {
    const report = machineReport([
      machineProject("/project-a", {
        warnings: [{ copyableValues: ["/copy/a"], kind: "diagnostic", parts: ["Review A"] }],
        repositoryExclusions: [{
          current: [],
          next: ["/a"],
          target: "/repo-a/.git/info/exclude",
          installed: false,
        }],
      }),
      machineProject("/project-b", {
        warnings: [{ copyableValues: ["/copy/b"], kind: "diagnostic", parts: ["Review B"] }],
        repositoryExclusions: [{
          current: ["/old-b"],
          next: ["/b"],
          target: "/repo-b/.git/info/exclude",
          installed: false,
        }],
      }),
    ]);

    const projects = JSON.parse(formatLifecycleJson("status", report)).projects;
    expect(projects.map((entry: Record<string, unknown>) => ({
      project: entry.project,
      warnings: entry.warnings,
      repositoryExclusions: entry.repositoryExclusions,
    }))).toEqual([
      {
        project: "/project-a",
        warnings: [{ message: "Review A", copyableValues: ["/copy/a"], kind: "diagnostic" }],
        repositoryExclusions: [{
          current: [], next: ["/a"], target: "/repo-a/.git/info/exclude",
        }],
      },
      {
        project: "/project-b",
        warnings: [{ message: "Review B", copyableValues: ["/copy/b"], kind: "diagnostic" }],
        repositoryExclusions: [{
          current: ["/old-b"], next: ["/b"], target: "/repo-b/.git/info/exclude",
        }],
      },
    ]);
  });

  test("apply JSON keeps applied work distinct from resulting state", () => {
    const receipt = machineReport([
      machineProject(project, {
        desired,
        state: { kind: "addition" },
        outputs: [{ kind: "addition", path: "a.md", consumingHosts: ["codex"] }],
      }),
    ]);
    const resultingState = machineReport([
      machineProject(project, {
        desired,
        state: { kind: "current" },
        outputs: [{ kind: "unchanged", path: "a.md", consumingHosts: ["codex"] }],
      }),
    ]);

    const payload = JSON.parse(formatApplyJson(machineApplyResult(receipt, resultingState)));
    expect(payload.schemaVersion).toBe(14);
    expect(payload.projects[0].state).toEqual({ kind: "current" });
    expect(payload.applied.projects[0].state).toEqual({ kind: "addition" });
  });

  test("blocked apply JSON has no applied snapshot", () => {
    const report = machineReport([
      machineProject(project, { blockers: [fixtureBlocker("CLI missing", project)] }),
    ]);

    const payload = JSON.parse(formatBlockedApplyJson(report));
    expect(payload).toMatchObject({ command: "apply", outcome: "blocked", schemaVersion: 14 });
    expect(payload).not.toHaveProperty("applied");
    expect(payload.projects[0].blockers).toHaveLength(1);
  });

  test("apply verification failure JSON retains applied evidence and the typed error", () => {
    const receipt = machineReport([
      machineProject(project, {
        state: { kind: "addition" },
        outputs: [{ kind: "addition", path: "a.md", consumingHosts: ["codex"] }],
      }),
    ]);

    const payload = JSON.parse(
      formatApplyVerificationFailureJson(receipt, "post-apply verification failed: boom"),
    );
    expect(payload).toMatchObject({
      command: "apply",
      outcome: "error",
      error: "post-apply verification failed: boom",
      schemaVersion: 14,
    });
    expect(payload.projects).toEqual([]);
    expect(payload.applied.projects[0].outputs).toEqual([
      { kind: "addition", path: "a.md", consumingHosts: ["codex"] },
    ]);
  });

  test("tool-error JSON uses the empty nested model", () => {
    for (const command of ["status", "apply"] as const) {
      expect(JSON.parse(formatLifecycleToolErrorJson(command, "missing"))).toEqual({
        schemaVersion: 14,
        command,
        outcome: "error",
        error: "missing",
        globalBlockers: [],
        projects: [],
      });
    }
  });

  test("pending work remains attention with exit code 0", () => {
    const report = machineReport([
      machineProject(project, { state: { kind: "addition" } }),
    ]);
    expect(JSON.parse(formatLifecycleJson("status", report)).outcome).toBe("attention");
    expect(lifecycleExitCode(report)).toBe(0);
  });
});

describe("standalone view presentation documents (#389)", () => {
  const context = (width: number): TerminalPresentationContext => ({
    color: false,
    interactive: true,
    width,
  });

  test("info presents the engine version and three application locations as typed fields", () => {
    const info: ApplicationInfo = {
      configurationState: "current",
      engineVersion: "0.67.0",
      installationState: "/home/.agents/agent-profile-kit/state/manifest.json",
      localConfiguration: "/home/.agents/agent-profile-kit/config.yaml",
      workspace: {
        authored: "/home/.agents/agent-profile-kit/workspace",
        canonical: "/home/.agents/agent-profile-kit/workspace",
      },
    };

    const document = infoDocument(info, "/home", "/work");

    expect(document.map(shape)).toEqual([
      "key-value(Engine version):path",
      "key-value(Workspace)",
      "key-value(Local Configuration)",
      "key-value(Installation State)",
    ]);
    const workspace = keyValuesIn(document, "Workspace")[0]!;
    expect(workspace.value).toEqual({
      kind: "path",
      canonicalPath: "/home/.agents/agent-profile-kit/workspace",
      authoredPath: "/home/.agents/agent-profile-kit/workspace",
      scope: "fleet",
    });
    expect(keyValuesIn(document, "Engine version")[0]!.value).toEqual({
      kind: "identifier",
      value: "0.67.0",
    });
  });

  test("info presents an unconfigured Workspace as prose, not a path node", () => {
    const document = infoDocument({
      configurationState: "current",
      engineVersion: "0.67.0",
      installationState: "/home/.agents/agent-profile-kit/state/manifest.json",
      localConfiguration: "/home/.agents/agent-profile-kit/config.yaml",
      workspace: null,
    }, "/home", "/work");

    expect(keyValuesIn(document, "Workspace")[0]!.value).toMatchObject({ kind: "prose" });
  });

  test("info renders a long Workspace location elided, never folded (US-008)", () => {
    const info: ApplicationInfo = {
      configurationState: "current",
      engineVersion: "0.67.0",
      installationState: "/home/.agents/agent-profile-kit/state/manifest.json",
      localConfiguration: "/home/.agents/agent-profile-kit/config.yaml",
      workspace: {
        authored: "/home/projects/a-very-long-project-identity-name",
        canonical: "/home/projects/a-very-long-project-identity-name",
      },
    };
    const output = renderPresentationDocument(infoDocument(info, "/home", "/work"), context(40), { cwd: "/work", home: "/home" });
    const workspaceLine = output.split("\n").find((line) => line.startsWith("Workspace: "));
    expect(workspaceLine).toBeDefined();
    // The path is one unbroken line that fits the measure by eliding.
    expect(workspaceLine!.length).toBeLessThanOrEqual(40);
    expect(workspaceLine!.endsWith("identity-name")).toBe(true);
    expect(output).not.toContain("Workspace: ~/projects/a-very-long\n");
  });

  test("info keeps the legacy configured-Workspace sentence as one prose field", () => {
    const document = infoDocument({
      configurationState: "legacy",
      engineVersion: "0.67.0",
      installationState: "/home/.agents/agent-profile-kit/state/manifest.json",
      localConfiguration: "/home/.agents/agent-profile-kit/config.yaml",
      workspace: {
        authored: "/home/.agents/agent-profile-kit/workspace",
        canonical: "/home/.agents/agent-profile-kit/workspace",
      },
    }, "/home", "/work");

    expect(keyValuesIn(document, "Workspace")[0]!.value).toMatchObject({ kind: "prose" });
    expect(inlineCommandTexts([keyValuesIn(document, "Workspace")[0]!.value])).toEqual(["apkit init"]);
  });

  test("inventory indexes present one typed entry per topic with its description", () => {
    const document = inventoryIndexDocument();
    expect(document.map(shape)).toEqual([
      "heading",
      ...INVENTORY_TOPICS.flatMap(() => ["prose:command", "prose"]),
    ]);
    const lines = flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose")
      .map((node) => nodeText(node));
    for (const topic of INVENTORY_TOPICS) {
      expect(lines.some((line) => line.includes(`apkit list ${topic.name}`))).toBe(true);
    }

    const machine = machineInventoryIndexDocument();
    expect(machine.map(shape)).toEqual([
      "heading",
      ...MACHINE_INVENTORY_TOPICS.flatMap(() => ["prose:command", "prose"]),
    ]);
  });

  test("project inventory presents each Project as an aligned row with identity, Profile, Hosts, and State", () => {
    const project = "/home/projects/a-very-long-project-identity";
    const document = projectInventoryDocument(
      [
        {
          canonicalProject: project,
          hosts: ["claude", "codex"],
          problem: {
            kind: "foreign-diagnostic",
            detail:
              "Configured project root does not exist on this machine and cannot be reconciled.",
          },
          profile: "engineering",
          project,
        },
      ],
      "/home",
      "/work",
    );

    expect(document.map(shape)).toEqual([
      "heading",
      "blank",
      "row",
      "blank",
      "prose",
      "prose",
    ]);
    const row = document.find((node) => node.kind === "row") as Extract<PresentationNode, { kind: "row" }>;
    expect(row).toBeDefined();
    expect(row.cells).toHaveLength(4);
    expect(row.cells.map((c) => c.column)).toEqual(["Project", "Profile", "Hosts", "State"]);
    expect(row.cells[0]!.content).toEqual({
      kind: "path",
      canonicalPath: project,
      authoredPath: project,
      scope: "fleet",
    });
    expect(row.cells[1]!.content).toEqual({
      category: "path",
      kind: "identifier",
      value: "engineering",
    });
    expect(row.cells[2]!.content).toEqual({
      kind: "identifier",
      value: "claude, codex",
    });
    expect(nodeText(row.cells[3]!.content)).toContain(
      "Configured project root does not exist on this machine and cannot be reconciled.",
    );
    const summary = document[4] as Extract<PresentationNode, { kind: "prose" }>;
    expect(nodeText(summary)).toBe("1 Project: 1 problem.");
    const guidance = document[5] as Extract<PresentationNode, { kind: "prose" }>;
    expect(nodeText(guidance)).toContain("apkit status");
  });

  test("project inventory presents clean Projects with configured state and summary count", () => {
    const projects = [
      {
        canonicalProject: "/home/projects/alpha",
        hosts: ["codex" as const],
        problem: null,
        profile: "engineering",
        project: "~/projects/alpha",
      },
      {
        canonicalProject: "/home/projects/beta",
        hosts: ["claude" as const, "codex" as const],
        problem: null,
        profile: "devops",
        project: "~/projects/beta",
      },
    ];

    const document = projectInventoryDocument(projects, "/home", "/home");
    expect(document.map(shape)).toEqual([
      "heading",
      "blank",
      "row",
      "row",
      "blank",
      "prose",
      "prose",
    ]);
    const rows = document.filter((node): node is Extract<PresentationNode, { kind: "row" }> => node.kind === "row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.cells[3]!.content).toEqual({
      kind: "identifier",
      value: "configured",
    });
    expect(rows[1]!.cells[3]!.content).toEqual({
      kind: "identifier",
      value: "configured",
    });

    const summary = document[5] as Extract<PresentationNode, { kind: "prose" }>;
    expect(nodeText(summary)).toBe("2 Projects configured.");
  });

  test("project inventory aligns columns across records of differing lengths", () => {
    const projects = [
      {
        canonicalProject: "/home/p/short",
        hosts: ["codex" as const],
        problem: null,
        profile: "eng",
        project: "~/p/short",
      },
      {
        canonicalProject: "/home/projects/much-longer-project-name",
        hosts: ["claude" as const, "codex" as const, "opencode" as const],
        problem: null,
        profile: "data-engineering",
        project: "~/projects/much-longer-project-name",
      },
    ];

    const document = projectInventoryDocument(projects, "/home", "/home");
    const rendered = renderPresentationDocument(document, {
      color: false,
      interactive: true,
      width: 120,
    }, { home: "/home", cwd: "/home" });

    const lines = rendered.split("\n");
    // lines: [ "Projects (2):", "", "<row1>", "<row2>", "", "2 Projects configured.", "Use apkit status..." ]
    expect(lines[0]).toBe("Projects (2):");
    const row1 = lines[2]!;
    const row2 = lines[3]!;
    expect(row1).toBeDefined();
    expect(row2).toBeDefined();

    // The columns are: Project, Profile, Hosts, State.
    // In row 1: "~/p/short" padded to match "~/projects/much-longer-project-name"
    // In row 2: "~/projects/much-longer-project-name"
    // Then 2 spaces gap, then "eng" vs "data-engineering", then 2 spaces gap, then "codex" vs "claude, codex, opencode", then "configured"
    const profile1Index = row1.indexOf("eng");
    const profile2Index = row2.indexOf("data-engineering");
    expect(profile1Index).toBe(profile2Index);

    const hosts1Index = row1.indexOf("codex");
    const hosts2Index = row2.indexOf("claude, codex, opencode");
    expect(hosts1Index).toBe(hosts2Index);

    const state1Index = row1.indexOf("configured");
    const state2Index = row2.indexOf("configured");
    expect(state1Index).toBe(state2Index);
  });

  test("project inventory degrades to stacked fields on narrow terminals without dropping fields", () => {
    const projects = [
      {
        canonicalProject: "/home/projects/alpha",
        hosts: ["codex" as const],
        problem: null,
        profile: "engineering",
        project: "~/projects/alpha",
      },
      {
        canonicalProject: "/home/projects/beta",
        hosts: ["claude" as const],
        problem: null,
        profile: "devops",
        project: "~/projects/beta",
      },
    ];

    const document = projectInventoryDocument(projects, "/home", "/home");
    const rendered = renderPresentationDocument(document, {
      color: false,
      interactive: true,
      width: 40,
    }, { home: "/home", cwd: "/home" });

    const lines = rendered.split("\n");
    expect(rendered).toContain("Project: ~/projects/alpha");
    expect(rendered).toContain("Profile: engineering");
    expect(rendered).toContain("Hosts: codex");
    expect(rendered).toContain("State: configured");
    expect(rendered).toContain("Project: ~/projects/beta");
    expect(rendered).toContain("Profile: devops");
    expect(rendered).toContain("Hosts: claude");
    expect(rendered).toContain("2 Projects configured.");
  });

  test("project inventory preserves canonical diagnostic evidence and repair locators", () => {
    const problems = [
      {
        problem: {
          kind: "missing-directory" as const,
          origin: {
            source: "local-configuration" as const,
            configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
            bindingIndex: 0,
          },
          field: "project",
          authored: "~/projects/missing",
        },
        expected: "Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[0] project '~/projects/missing' must be an existing directory",
      },
      {
        problem: {
          kind: "dangling-symlink" as const,
          origin: {
            source: "local-configuration" as const,
            configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
            bindingIndex: 1,
          },
          field: "project",
          authored: "~/projects/dangling",
        },
        expected: "Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[1] project '~/projects/dangling' is a dangling symlink; restore its target or choose an existing directory",
      },
      {
        problem: {
          kind: "relative-path" as const,
          origin: {
            source: "local-configuration" as const,
            configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
            bindingIndex: 2,
          },
          field: "project",
        },
        expected: "Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[2] project must be an absolute path or home-relative path beginning with ~/",
      },
      {
        problem: {
          kind: "wildcard-path" as const,
          origin: {
            source: "local-configuration" as const,
            configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
            bindingIndex: 3,
          },
          field: "project",
        },
        expected: "Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[3] project must be an explicit directory path without wildcards",
      },
      {
        problem: {
          kind: "duplicate-canonical-root" as const,
          configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
          bindingIndex: 4,
          canonicalProject: "/home/projects/dup",
        },
        expected: "Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[4] project resolves to duplicate canonical root '/home/projects/dup'",
      },
      {
        problem: {
          kind: "foreign-diagnostic" as const,
          detail: "Configured project root does not exist on this machine and cannot be reconciled.",
        },
        expected: "Configured project root does not exist on this machine and cannot be reconciled.",
      },
    ];

    for (const { problem, expected } of problems) {
      const document = projectInventoryDocument(
        [
          {
            canonicalProject: null,
            hosts: ["codex"],
            problem,
            profile: "engineering",
            project: "~/projects/test",
          },
        ],
        "/home",
        "/home",
      );
      const row = document.find((node): node is Extract<PresentationNode, { kind: "row" }> => node.kind === "row")!;
      expect(nodeText(row.cells[3]!.content)).toBe(expected);
    }
  });

  test("project inventory preserves configuration locators when alphabetical sort differs from configuration order", () => {
    // In config.yaml:
    // binding[0] is zeta-broken
    // binding[1] is alpha-broken
    const projects = [
      {
        canonicalProject: null,
        hosts: ["codex" as const],
        problem: {
          kind: "dangling-symlink" as const,
          origin: {
            source: "local-configuration" as const,
            configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
            bindingIndex: 1,
          },
          field: "project",
          authored: "~/projects/alpha-broken",
        },
        profile: "engineering",
        project: "~/projects/alpha-broken",
      },
      {
        canonicalProject: null,
        hosts: ["claude" as const],
        problem: {
          kind: "missing-directory" as const,
          origin: {
            source: "local-configuration" as const,
            configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
            bindingIndex: 0,
          },
          field: "project",
          authored: "~/projects/zeta-broken",
        },
        profile: "devops",
        project: "~/projects/zeta-broken",
      },
    ];

    const document = projectInventoryDocument(projects, "/home", "/home");
    const rows = document.filter((node): node is Extract<PresentationNode, { kind: "row" }> => node.kind === "row");
    expect(rows).toHaveLength(2);

    // Row 0 is alpha-broken, but its state carries bindings[1] locator from configuration
    expect(nodeText(rows[0]!.cells[3]!.content)).toContain("bindings[1]");
    expect(nodeText(rows[0]!.cells[3]!.content)).toContain("dangling symlink");

    // Row 1 is zeta-broken, but its state carries bindings[0] locator from configuration
    expect(nodeText(rows[1]!.cells[3]!.content)).toContain("bindings[0]");
    expect(nodeText(rows[1]!.cells[3]!.content)).toContain("must be an existing directory");
  });

  test("project inventory accurately reports existing non-directory file without claiming absence", () => {
    const document = projectInventoryDocument(
      [
        {
          canonicalProject: null,
          hosts: ["pi" as const],
          problem: {
            kind: "missing-directory" as const,
            origin: {
              source: "local-configuration" as const,
              configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
              bindingIndex: 0,
            },
            field: "project",
            authored: "~/projects/charlie-file",
          },
          profile: "coding",
          project: "~/projects/charlie-file",
        },
      ],
      "/home",
      "/home",
    );

    const row = document.find((node): node is Extract<PresentationNode, { kind: "row" }> => node.kind === "row")!;
    const stateText = nodeText(row.cells[3]!.content);
    expect(stateText).toBe(
      "Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[0] project '~/projects/charlie-file' must be an existing directory",
    );
    expect(stateText).not.toContain("missing directory;");
  });

  test("project inventory labels invalid relative paths through the canonical presenter", () => {
    const projects = [".", "..", "../alpha"].map((project) => ({
      canonicalProject: null,
      hosts: ["codex" as const],
      problem: {
        kind: "relative-path" as const,
        origin: {
          source: "local-configuration" as const,
          configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
          bindingIndex: 0,
        },
        field: "project",
      },
      profile: "engineering",
      project,
    }));

    const document = projectInventoryDocument(projects, "/home", "/home/projects/alpha");
    const rows = document.filter((node): node is Extract<PresentationNode, { kind: "row" }> => node.kind === "row");
    const projectCells = rows.map((row) => row.cells[0]!.content);
    for (const project of [".", "..", "../alpha"]) {
      expect(projectCells).toContainEqual({
        kind: "path",
        canonicalPath: project,
        authoredPath: project,
        scope: "fleet",
      });
    }
  });

  test("an empty project inventory is a success notice with bind guidance", () => {
    const document = projectInventoryDocument([], "/home", "/work");
    expect(document.map(shape)).toEqual(["notice:success", "prose"]);
    const notice = document[0] as Extract<PresentationNode, { kind: "notice" }>;
    expect(notice.severity).toBe("success");
    // The guidance is one prose node whose typed inline command part keeps
    // the bind invocation atomic.
    expect(inlineCommandTexts([document[1]!])).toEqual(["apkit bind <profile> --host <host>"]);
  });

  test("profile inventory presents each Profile with its module and skill counts", () => {
    const document = profileInventoryDocument([{ contextModules: 2, id: "engineering", skills: 3 }]);
    expect(document.map(shape)).toEqual([
      "heading",
      "blank",
      "key-value(Profile):path",
      "key-value(Context Modules)",
      "key-value(Skills)",
      "blank",
      "prose",
    ]);
    expect(keyValuesIn(document, "Profile")[0]!.value).toEqual({
      kind: "identifier",
      value: "engineering",
    });
  });

  test("an empty profile inventory is a success notice with workspace guidance", () => {
    const document = profileInventoryDocument([]);
    expect(document.map(shape)).toEqual(["notice:success", "prose"]);
    expect((document[0] as Extract<PresentationNode, { kind: "notice" }>).nodes[0]).toMatchObject({ kind: "prose" });
  });

  test("host inventory lists supported Hosts as one entry each", () => {
    const document = hostInventoryDocument([
      { host: "codex", supportsTemporaryProfileInstallation: true },
      { host: "claude", supportsTemporaryProfileInstallation: false },
    ]);
    expect(document.map(shape)).toEqual(["heading", "prose", "prose", "blank", "prose"]);
    const hostLines = flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose")
      .map((node) => nodeText(node));
    expect(hostLines[0]).toContain("codex");
    expect(hostLines[1]).toContain("claude");
    expect(inlineCommandTexts(document)).toContain("apkit bind");
  });

  test("temporary inventory presents each installation as typed identity fields", () => {
    const project = "/home/projects/temporary-project";
    const document = temporaryInventoryDocument(
      [
        {
          host: "codex",
          profileId: "coding",
          project,
          temporaryInstallationId: "temporary-installation-opaque-id",
        },
      ],
      "/home",
      "/work",
    );

    expect(document.map(shape)).toEqual([
      "heading",
      "blank",
      "key-value(Temporary installation):path",
      "key-value(Project)",
      "key-value(Profile):path",
      "key-value(Host):path",
      "blank",
      "prose",
    ]);
    expect(keyValuesIn(document, "Temporary installation")[0]!.value).toEqual({
      kind: "identifier",
      value: "temporary-installation-opaque-id",
    });
    expect(keyValuesIn(document, "  Project")[0]!.value).toEqual({
      kind: "path",
      canonicalPath: project,
      authoredPath: project,
      scope: "fleet",
    });
  });

  test("an empty temporary inventory is a success notice with install guidance", () => {
    const document = temporaryInventoryDocument([], "/home", "/work");
    expect(document.map(shape)).toEqual(["notice:success", "prose"]);
    expect((document[0] as Extract<PresentationNode, { kind: "notice" }>).severity).toBe("success");
    // The guidance prose carries the typed inline creation command.
    expect(inlineCommandTexts([document[1]!])).toEqual([
      "apkit machine install-temp <profile> <project> --host <host>",
    ]);
  });

  test("validation presents the valid outcome, found counts, warnings, and a typed next command", () => {
    const document = validationResultDocument({
      bindings: 2,
      hosts: ["claude", "codex"],
      profiles: ["engineering"],
      warnings: [
        "This is an unusually long validation warning that must wrap cleanly at a narrow terminal measure.",
      ],
    });

    expect(document.map(shape)).toEqual([
      "notice:success",
      "list-item",
      "key-value(Profiles found)",
      "key-value(Hosts bound)",
      "key-value(Next)",
    ]);
    const next = keyValuesIn(document, "Next")[0]!;
    expect(next.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }],
    });
    expect(keyValuesIn(document, "Profiles found")[0]!.value).toEqual({
      kind: "prose",
      parts: ["engineering"],
    });
  });

  test("validation without bindings points at the bind command as a typed command node", () => {
    const document = validationResultDocument({
      bindings: 0,
      hosts: [],
      profiles: [],
      warnings: [],
    });

    expect(keyValuesIn(document, "Next")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "bind <profile> --host <host>" }],
    });
    expect(keyValuesIn(document, "Profiles found")[0]!.value).toMatchObject({ kind: "prose" });
    // The count clause is protected report material: it never wraps (US-010).
    const rendered = renderPresentationDocument(
      validationResultDocument({
        bindings: 0,
        hosts: [],
        profiles: [],
        warnings: [],
      }),
      context(40),
    );
    const notice = document[0] as Extract<PresentationNode, { kind: "notice" }>;
    const count = inlineIdentifiers(notice.nodes)[0]!;
    expect(count).toBeDefined();
    expect(rendered.split("\n").filter((line) => line.includes(count))).toHaveLength(1);
  });

  test("uninstall presents removed Projects with typed identity and their generated paths", () => {
    const document = uninstallResultDocument({
      kept: [],
      projects: [
        {
          outputs: [".agent-profile-kit/codex/context.md"],
          project: "/home/projects/api",
          repositoryExclusions: [],
        },
      ],
      warnings: [],
    }, "/home", "/work");

    expect(document.map(shape)).toEqual([
      "notice:success",
      "blank",
      "key-value(Project)",
      "prose:success",
      "prose",
      "blank",
      "prose",
      "prose:command",
    ]);
    expect(keyValuesIn(document, "Project")[0]!.value).toEqual({
      kind: "path",
      canonicalPath: "/home/projects/api",
      authoredPath: "/home/projects/api",
      scope: "fleet",
    });
    const proseNodes = flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose");
    // The generated paths are listed under one success-category prose node;
    // each fixture output path rides as its own list-entry prose node.
    expect(proseNodes.some((node) => node.category === "success")).toBe(true);
    expect(proseNodes.some((node) => nodeText(node).includes(".agent-profile-kit/codex/context.md"))).toBe(true);
  });

  test("uninstall presents cleaned Git exclusions with their repository target", () => {
    const document = uninstallResultDocument({
      kept: [],
      projects: [{
        outputs: [".codex/hooks.json"],
        project: "/project-a",
        repositoryExclusions: [
          {
            entries: ["/.claude/rules/agent-profile-kit.md", "/.codex/hooks.json"],
            target: "/project-a/.git/info/exclude",
          },
          {
            entries: ["/.claude/rules/agent-profile-kit.md"],
            target: "/shared/.git/info/exclude",
          },
        ],
      }],
      warnings: [],
    });

    const entries = document.filter((node) => node.kind === "prose")
      .filter((node) => inlineIdentifiers([node])[0]?.startsWith("/") === true);
    expect(entries.map((node) => inlineIdentifiers([node]))).toEqual([
      ["/.claude/rules/agent-profile-kit.md"], ["/.codex/hooks.json"], ["/.claude/rules/agent-profile-kit.md"],
    ]);
    ["/project-a/.git/info/exclude", "/project-a/.git/info/exclude", "/shared/.git/info/exclude"]
      .forEach((target, index) => expect(nodeText(entries[index]!)).toContain(target));
  });

  test("uninstall presents kept Projects and their removal failure reasons", () => {
    const document = uninstallResultDocument({
      projects: [],
      kept: [{
        project: "/project-a",
        reason: "Cannot remove Project at /project-a: owned output .codex/hooks.json has unsafe parent: /project-a/.codex is a symlink parent",
      }],
      warnings: [],
    });

    expect(document.map(shape)).toEqual([
      "notice:success",
      "blank",
      "prose",
      "blank",
      "key-value(Project)",
      "prose:error",
      "blank",
      "prose",
    ]);
    const keptReason = flattenPresentationNodes(document).find((node) =>
      node.kind === "prose" && node.category === "error"
    ) as Extract<PresentationNode, { kind: "prose" }>;
    expect(keptReason.category).toBe("error");
  });

  test("uninstall presents warnings as inline typed list items beside the outcome notice", () => {
    const document = uninstallResultDocument({
      kept: [],
      projects: [],
      warnings: [
        "/project-a/.git/info/exclude changed during exclusion publication; skipping to preserve unrelated bytes",
      ],
    });

    const items = flattenPresentationNodes(document).filter((node) => node.kind === "list-item");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(document.map(shape)).toEqual(["notice:success", "list-item", "blank", "prose"]);
    expect(keyValuesIn(document, "Project")).toEqual([]);
  });

  test("an uninstall with nothing installed is a single success notice", () => {
    const document = uninstallResultDocument({ projects: [], kept: [], warnings: [] });
    expect(document.map(shape)).toEqual(["notice:success", "blank", "prose"]);
    expect((document[0] as Extract<PresentationNode, { kind: "notice" }>).nodes[0]).toMatchObject({ kind: "prose" });
  });

  test("temporary installation receipts present identity fields and a typed removal command", () => {
    const receipt: TemporaryInstallationReceiptView = {
      completionState: "installed",
      diagnosticValues: [],
      host: "codex",
      outputs: [".codex/hooks.json"],
      profileId: "engineering",
      project: "/project-a",
      setupSteps: [],
      temporaryInstallationId: "temp-987",
      warnings: [],
    };

    const document = temporaryInstallationDocument("install-temp", receipt);
    expect(document.map(shape)).toEqual([
      "notice:success",
      "key-value(Profile):path",
      "key-value(Host):path",
      "key-value(Project)",
      "key-value(Temporary installation):path",
      "key-value(Next)",
    ]);
    expect(keyValuesIn(document, "  Project")[0]!.value).toEqual({
      kind: "path",
      canonicalPath: "/project-a",
      authoredPath: "/project-a",
      scope: "project",
    });
    const next = keyValuesIn(document, "Next")[0]!;
    expect(next.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "machine" },
        { kind: "text", value: "remove-temp" },
        { kind: "text", value: "temp-987" },
      ],
    });

    const removed = temporaryInstallationDocument("remove-temp", receipt);
    expect(removed.map(shape)).toEqual([
      "notice:success",
      "key-value(Temporary installation):path",
      "key-value(Project)",
    ]);
  });

  test("temporary installation receipts present warnings and setup steps as typed lists", () => {
    const diagnosticValue = "generated diagnostic path with spaces";
    const receipt: TemporaryInstallationReceiptView = {
      completionState: "installed",
      diagnosticValues: [diagnosticValue],
      host: "codex",
      outputs: [".agent-profile-kit/codex/context.md"],
      profileId: "coding",
      project: "/tmp/temporary project with spaces",
      setupSteps: [{
        consequence: "Profile Context does not load until the project is trusted.",
        host: "codex",
        kind: "trust-required",
        message: "Trust the bound project in Codex.",
        provenance: "standing",
      }],
      temporaryInstallationId: "temporary-installation-opaque-id",
      warnings: [`Inspect ${diagnosticValue} before continuing with this diagnostic.`],
      warningParts: [["Inspect ", identifierPart(diagnosticValue), " before continuing with this diagnostic."]],
      workspaceInputHash: "workspace-hash",
    };

    const document = temporaryInstallationDocument("install-temp", receipt);
    expect(document.map(shape)).toEqual([
      "notice:success",
      "list-item",
      "key-value(Profile):path",
      "key-value(Host):path",
      "key-value(Project)",
      "key-value(Temporary installation):path",
      "heading",
      "list-item",
      "prose",
      "key-value(Next)",
    ]);
    // The diagnostic value survives as protected report material (US-019).
    const rendered = renderPresentationDocument(
      temporaryInstallationDocument("install-temp", receipt),
      context(40),
    );
    expect(rendered).toContain(diagnosticValue);
    expect(rendered).not.toContain("generated diagnostic path with\n");
    expect(rendered.split("\n").some((line) => line.startsWith("- Trust the bound project in Codex."))).toBe(true);
    expect(rendered.split("\n")).toContain("  Consequence: Profile Context does");
    for (const line of rendered.trimEnd().split("\n")) {
      if (
        line.includes("/tmp/temporary project with spaces") ||
        line.includes("apkit machine remove-temp") ||
        // The installation identity is protected report material: it stays
        // whole on its own line even when wider than the measure.
        line.startsWith("  Temporary installation:")
      ) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
  });

  test("blocked temporary-installation messages carry the diagnostic prefix and replaced Project references", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const canonical = join(home, "projects", "alpha");
      const blockers = [
        normalizeBlocker({
          affectedItems: [{ kind: "path", value: "/home/.agents/agent-profile-kit/state/manifest.json" }],
          detail:
            `${canonical} already has an ordinary Profile Installation; remove it ` +
            "before installing a temporary Profile",
          kind: "installation-state-unreadable",
          scope: "global",
        }),
        normalizeBlocker(temporaryInstallationRemovalBlocker({
          failure: { case: "symlink-output", output: ".codex/hooks.json" },
          outputs: [".codex/hooks.json"],
          project: canonical,
          temporaryInstallationId: "temp-1",
        })),
      ];

      const { presented, document } = temporaryBlockedMessagesDocument(
        blockers,
        canonical,
        "~/projects/alpha",
        process.cwd(),
        home,
      );

      expect(presented).toBe("~/projects/alpha");
      const prose = flattenPresentationNodes(document)
        .filter((node) => node.kind === "prose")
        .map((node) => node as Extract<PresentationNode, { kind: "prose" }>);
      expect(nodeText(prose[0]!)).toContain("~/projects/alpha");
      expect(prose[0]!.category).toBe("error");
      expect(nodeText(prose[2]!)).toContain(".codex/hooks.json");
      expect(inlineCommandTexts([prose[3]!])).toContain(
        "apkit machine remove-temp 'temp-1'",
      );
      // Identity prose keeps the authored home-relative display; the remedy's
      // scoped command arguments carry the canonical runnable path (#440).
      const proseSpans = flattenPresentationNodes(document)
        .flatMap((node) =>
          node.kind === "prose" || node.kind === "sentence" || node.kind === "list-item"
            ? node.parts.filter((part): part is string => typeof part === "string")
            : [])
        .join("\n");
      expect(proseSpans).not.toContain(canonical);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });


  test("blocked messages keep the Project subject when running from inside it", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const canonical = join(home, "projects", "alpha");
      const blockers = [
        normalizeBlocker({
          affectedItems: [{ kind: "path", value: "/home/.agents/agent-profile-kit/state/manifest.json" }],
          detail:
            `${canonical} already has an ordinary Profile Installation; remove it ` +
            "before installing a temporary Profile",
          kind: "installation-state-unreadable",
          scope: "global",
        }),
      ];

      const { document } = temporaryBlockedMessagesDocument(
        blockers,
        canonical,
        canonical,
        canonical,
        home,
      );

      const prose = flattenPresentationNodes(document)
        .filter((node) => node.kind === "prose")
        .map((node) => node as Extract<PresentationNode, { kind: "prose" }>);
      expect(nodeText(prose[0]!)).toContain("~/projects/alpha");
      // Identity prose keeps the authored home-relative display; the remedy's
      // scoped command arguments carry the canonical runnable path (#440).
      const proseSpans = flattenPresentationNodes(document)
        .flatMap((node) =>
          node.kind === "prose" || node.kind === "sentence" || node.kind === "list-item"
            ? node.parts.filter((part): part is string => typeof part === "string")
            : [])
        .join("\n");
      expect(proseSpans).not.toContain(canonical);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("blocked messages replace both canonical and authored-absolute Project spellings", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const canonical = join(home, "real-project");
      const authored = join(home, "alias-project");
      const blockers = [
        normalizeBlocker({
          affectedItems: [{ kind: "path", value: "/home/.agents/agent-profile-kit/state/manifest.json" }],
          detail: `${authored} cannot be resolved: the authored spelling differs from ${canonical}`,
          kind: "installation-state-unreadable",
          scope: "global",
        }),
      ];

      const { document } = temporaryBlockedMessagesDocument(
        blockers,
        canonical,
        authored,
        process.cwd(),
        home,
      );

      const prose = flattenPresentationNodes(document)
        .filter((node) => node.kind === "prose")
        .map((node) => node as Extract<PresentationNode, { kind: "prose" }>);
      expect(nodeText(prose[0]!)).toContain("~/real-project cannot be resolved: the authored spelling differs from ~/real-project");
      // Identity prose keeps the authored home-relative display; the remedy's
      // scoped command arguments carry the canonical runnable path (#440).
      const proseSpans = flattenPresentationNodes(document)
        .flatMap((node) =>
          node.kind === "prose" || node.kind === "sentence" || node.kind === "list-item"
            ? node.parts.filter((part): part is string => typeof part === "string")
            : [])
        .join("\n");
      expect(proseSpans).not.toContain(canonical);
      expect(JSON.stringify(document)).not.toContain(authored);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

describe("operation-first multi-Project presentation", () => {
  const SKILL_PATH = ".agents/skills/review-pr";
  const CONTEXT_PATH = ".agent-profile-kit/codex/context.md";

  function sharedSkillFleet(overrides: Partial<FlatFixture> = {}): ReconciliationReport {
    const projects = ["/project-a", "/project-b", "/project-c"];
    return emptyReport({
      desired: projects.map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: [SKILL_PATH, CONTEXT_PATH],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      })),
      items: projects.map((project) => ({ kind: "update" as const, project })),
      outputs: projects.flatMap((project) => [
        { kind: "update" as const, path: SKILL_PATH, project },
        { kind: "unchanged" as const, path: CONTEXT_PATH, project },
      ]),
      ...overrides,
    });
  }

  test("multi-Project status groups observable operations without inferring artifact causality", () => {
    const concise = lifecycleStatusDocument(sharedSkillFleet());

    // The operation summary is one notice; guidance is the typed Next and
    // Details command values; no per-Project receipt bookkeeping appears.
    expect(noticesIn(concise)).toHaveLength(1);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(nextGuidance(concise)).toEqual(["apkit apply"]);
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "status" },
        { kind: "text", value: "--verbose" },
      ],
    });
    const conciseTexts = presentationTexts(concise);
    expect(keyValuesIn(concise, "Project")).toEqual([]);
    expectUserFacingVocabulary(renderBoundary(concise));
  });

  test("fleet summaries group each observable operation with its affected Projects", () => {
    const report = sharedSkillFleet({
      outputs: [
        { kind: "addition", path: ".agents/skills/new-skill", project: "/project-a" },
        { kind: "update", path: SKILL_PATH, project: "/project-a" },
        { kind: "update", path: SKILL_PATH, project: "/project-b" },
        { kind: "update", path: CONTEXT_PATH, project: "/project-b" },
        { kind: "removal", path: ".agents/skills/old-skill", project: "/project-c" },
      ],
    });

    const concise = lifecycleStatusDocument(report);

    // The ready summary notice leads; primary causes partition the affected Projects.
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    const listItems = concise.filter((node) => node.kind === "list-item");
    expect(listItems.some((node) => flatInlineText(node.parts).includes("source changed"))).toBe(true);
    expect(headingsIn(concise)).not.toContain("Project changes:");
  });

  test("large affected-Project sets are capped with a verbose pointer", () => {
    const projects = Array.from({ length: 8 }, (_, index) => `/project-${String.fromCharCode(97 + index)}`);
    const changed = projects.slice(0, 5);
    const report = emptyReport({
      desired: projects.map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: [SKILL_PATH],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      })),
      items: projects.map((project) => ({
        kind: changed.includes(project) ? ("update" as const) : ("current" as const),
        project,
      })),
      outputs: projects.map((project) => ({
        kind: changed.includes(project) ? ("update" as const) : ("unchanged" as const),
        path: SKILL_PATH,
        project,
      })),
    });

    expect(noticesIn(lifecycleStatusDocument(report))).toHaveLength(1);
    expect(noticesIn(lifecycleStatusDocument(report))[0]).toMatchObject({
      kind: "notice",
      severity: "success",
    });
  });

  test("single-Project status hides routine paths and Git bookkeeping behind matching verbose detail", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: [SKILL_PATH],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "update", path: SKILL_PATH, project: "/project-a" }],
      repositoryExclusions: [{
        current: [],
        next: [`/${SKILL_PATH}`],
        target: "/project-a/.git/info/exclude",
        installed: false,
      }],
    });

    const concise = lifecycleStatusDocument(report, { selection: { command: "status", kind: "project", match: "exact", target: "/project-a" } });

    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    // The selected Project is a typed path argument on each guidance command.
    const next = keyValuesIn(concise, "Next")[0]!.value;
    expect(next).toMatchObject({ kind: "command", program: "apkit" });
    expect(next).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "apply" },
        { kind: "path", canonicalPath: "/project-a", authoredPath: "/project-a", scope: "project" },
      ],
    });
    const details = keyValuesIn(concise, "Details")[0]!.value;
    expect(details).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "status" },
        { kind: "path", canonicalPath: "/project-a", authoredPath: "/project-a", scope: "project" },
        { kind: "text", value: "--verbose" },
      ],
    });
    expect(presentationTexts(concise).some((text) => text.includes(SKILL_PATH) || text.includes(".git/info/exclude"))).toBe(false);
  });

  test("blocked fleets keep structured blockers ahead of operation detail", () => {
    const report = sharedSkillFleet({
      items: ["/project-a", "/project-b", "/project-c"].map((project) => ({
        kind: "blocked" as const,
        project,
        reason: "hooks disabled",
      })),
      blockers: ["/project-a", "/project-b", "/project-c"].map((project) =>
        fixtureBlocker(`${project}: hooks disabled`, project),
      ),
    });

    const concise = lifecycleStatusDocument(report);

    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "error" });
    expect(flattenPresentationNodes(concise).some((node) =>
      node.kind === "prose" && node.category === "error"
    )).toBe(true);
    expect(headingsIn(concise)).not.toContain("Project changes:");
  });

  test("apply summarizes applied operations separately from freshly verified state", () => {
    const receipt = sharedSkillFleet();
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: ["/project-a", "/project-b", "/project-c"].map((project) => ({
        kind: "current" as const,
        project,
      })),
      outputs: ["/project-a", "/project-b", "/project-c"].map((project) => ({
        kind: "unchanged" as const,
        path: SKILL_PATH,
        project,
      })),
    });

    // The receipt summarizes applied operations; current-state bookkeeping and
    // selected-setup detail stay out of the receipt section.
    const apply = applyReportDocument({ receipt, resultingState });
    const nodes = flattenPresentationNodes(apply);
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(applied).toBeGreaterThan(-1);
    expect(nodes.slice(applied).some((node) =>
      node.kind === "prose"
    )).toBe(true);
    expect(nodes.slice(applied).some((node) =>
      node.kind === "key-value" && node.key === "  State"
    )).toBe(false);
  });

  test("generated-root ownership attention remains visible under primary cause partition", () => {
    const report = sharedSkillFleet({
      items: [
        { kind: "drifted output" as const, project: "/project-a", reason: SKILL_PATH },
        { kind: "update" as const, project: "/project-b" },
        { kind: "update" as const, project: "/project-c" },
      ],
    });

    const concise = lifecycleStatusDocument(report);
    const listItems = concise.filter((node) => node.kind === "list-item");
    expect(listItems.some((node) => flatInlineText(node.parts).includes("generated files changed (1):"))).toBe(true);
    expect(listItems.some((node) => flatInlineText(node.parts).includes("/project-a"))).toBe(true);
    expect(listItems.some((node) => flatInlineText(node.parts).includes("source changed (2):"))).toBe(true);
  });

  test("verbose retains complete per-Project operation evidence", () => {
    const verbose = lifecycleStatusDocument(sharedSkillFleet(), { verbose: true });
    const outputLine = (path: string, kind: string) => flattenPresentationNodes(verbose).some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));
    expect(outputLine("/project-a/.agents/skills/review-pr", "update")).toBe(true);
    expect(outputLine("/project-b/.agents/skills/review-pr", "update")).toBe(true);
    expect(outputLine("/project-c/.agents/skills/review-pr", "update")).toBe(true);
  });
});

describe("lifecycle summaries, next actions, and readiness", () => {


  test("identical next actions collapse once with Project scope", () => {
    const report = emptyReport({
      desired: ["/project-a", "/project-b", "/project-c"].map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      })),
      items: ["/project-a", "/project-b", "/project-c"].map((project) => ({
        kind: "update" as const,
        project,
      })),
      outputs: ["/project-a", "/project-b", "/project-c"].map((project) => ({
        kind: "update" as const,
        path: "a.md",
        project,
      })),
    });

    const status = lifecycleStatusDocument(report);
    // The typed Next command value carries the fleet invocation once.
    expect(nextGuidance(status)).toEqual(["apkit apply"]);
    expect(keyValuesIn(status, "Next")).toHaveLength(1);
  });

  test("aliased Project next actions keep the authored identity", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/private/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const status = lifecycleStatusDocument(report, { selection: { command: "status", kind: "project", match: "exact", target: "/project-a" } });
    // The authored identity is the path argument; the canonical spelling stays
    // out of the document.
    expect(keyValuesIn(status, "Next")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "apply" },
        { kind: "path", canonicalPath: "/private/project-a", authoredPath: "/project-a", scope: "project" },
      ],
    });
    expect(keyValuesIn(status, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "status" },
        { kind: "path", canonicalPath: "/private/project-a", authoredPath: "/project-a", scope: "project" },
        { kind: "text", value: "--verbose" },
      ],
    });
    expect(presentationTexts(status).some((text) => text.includes("/private/project-a"))).toBe(false);
  });

  test("differing next actions stay scoped", () => {
    const report = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          outputs: ["b.md"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
        },
      ],
      items: [
        { kind: "stale source", project: "/project-a" },
        { kind: "blocked", project: "/project-b", reason: "hooks disabled" },
      ],
      outputs: [
        { kind: "update", path: "a.md", project: "/project-a" },
        { kind: "update", path: "b.md", project: "/project-b" },
      ],
      blockers: [fixtureBlocker("/project-b: hooks disabled", "/project-b")],
    });

    const status = lifecycleStatusDocument(report);
    expect(nextActionItems(status).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
    ]);
  });

  test("fleet next actions name the working-directory Project by home-relative identity", () => {
    const current = process.cwd();
    const other = join(homedir(), "other-fleet-project");
    const homeRelative = current === homedir()
      ? "~"
      : current.startsWith(`${homedir()}/`)
      ? `~/${current.slice(homedir().length + 1)}`
      : current;
    const report = emptyReport({
      desired: [current, other].map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      })),
      items: [
        { kind: "stale source" as const, project: current },
        { kind: "blocked" as const, project: other, reason: "hooks disabled" },
      ],
      outputs: [current, other].map((project) => ({
        kind: "update" as const,
        path: "a.md",
        project,
      })),
      blockers: [fixtureBlocker(`${other}: hooks disabled`, other)],
    });

    const status = lifecycleStatusDocument(report);
    expect(nextActionItems(status).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
    ]);
    const rendered = renderBoundary(status, defaultRenderContext);
    expect(rendered).toContain(homeRelative);
    expect(rendered).not.toMatch(/(^|\n)\.: /);
  });

  test("successful apply does not print a current-Project matrix before Applied", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    // Successful changed apply: success notice, operation summary under
    // Applied, and no per-Project receipt block or state bookkeeping.
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(apply);
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(applied).toBeGreaterThan(-1);
    // The Applied section carries operation-summary prose; the composed count
    // wording is golden-covered.
    expect(nodes.slice(applied).filter((node) => node.kind === "prose").length).toBeGreaterThan(0);
    expect(keyValuesIn(apply, "Project")).toEqual([]);
    expect(keyValuesIn(apply, "  State")).toEqual([]);
  });

  test("exclusion-only apply does not reprint a current Project block", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/repo",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/repo",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/repo" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/repo" }],
      repositoryExclusions: [{
        current: [],
        next: ["/.agent-profile-kit/codex/context.md"],
        target: "/repo/.git/info/exclude",
        installed: false,
      }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/repo" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/repo" }],
    });

    // Exclusion-only apply: success notice with no Git-exclusion clause, no
    // already-current statement, and no Project receipt block in the concise
    // view; verbose keeps the exact exclusion delta under Applied.
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(headingsIn(apply)).not.toContain("Git exclusions:");
    expect(keyValuesIn(apply, "Project")).toEqual([]);
    expect(keyValuesIn(apply, "  State")).toEqual([]);

    const verbose = flattenPresentationNodes(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    expect(verbose.filter((node) => node.kind === "list-item").map((node) => inlineIdentifiers([node]))).toContainEqual(["/repo/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);
  });

  test("remaining attention after apply still appears", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "drifted output", project: "/project-a", reason: "a.md" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });

    // Remaining attention renders as a Project group with its State key-value;
    // the receipt operation summary stays present.
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(apply);
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(keyValuesIn(apply, "Project")).toHaveLength(1);
    const stateNodes = keyValuesIn(apply, "  State");
    expect(stateNodes).toHaveLength(1);
    expect(stateNodes[0]!.value).toMatchObject({ kind: "prose" });
    expect(nodeText(stateNodes[0]!.value)).toContain("a.md");
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(applied).toBeGreaterThan(-1);
    expect(nodes.slice(applied).some((node) =>
      node.kind === "prose"
    )).toBe(true);
    expect(nodes.slice(applied).some((node) => node.kind === "prose" && nodeText(node).includes("a.md"))).toBe(true);
  });

  test("multi-project apply preserves remaining attention across projects", () => {
    const receipt = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          outputs: ["b.md"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
        },
      ],
      items: [
        { kind: "update", project: "/project-a" },
        { kind: "update", project: "/project-b" },
      ],
      outputs: [
        { kind: "update", path: "a.md", project: "/project-a" },
        { kind: "update", path: "b.md", project: "/project-b" },
      ],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "drifted output", project: "/project-b" },
      ],
      outputs: [
        { kind: "unchanged", path: "a.md", project: "/project-a" },
        { kind: "update", path: "b.md", project: "/project-b" },
      ],
    });

    // Remaining attention appears only for the drifted Project; the receipt
    // covers both Projects' updates.
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(apply);
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "success" });
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(applied).toBeGreaterThan(-1);
    expect(nodes.slice(applied).some((node) =>
      node.kind === "prose"
    )).toBe(true);
    const projectNodes = keyValuesIn(apply, "Project");
    expect(projectNodes).toHaveLength(1);
    expect(projectNodes[0]!.value).toMatchObject({ kind: "path", canonicalPath: "/project-b" });
    const stateNodes = keyValuesIn(apply, "  State");
    expect(stateNodes).toHaveLength(1);
    expect(stateNodes[0]!.value).toMatchObject({ kind: "prose" });
    expect(nodes.slice(applied).some((node) => node.kind === "prose" && nodeText(node).includes("b.md"))).toBe(true);
  });

  test("no-op apply preserves adapter warnings", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
      warnings: ["Project /project-a carries an adapter warning."],
    });

    // The adapter warning joins the no-op view as an inline warning list item,
    // without a Warnings heading and still without an Applied section.
    const document = applyReportDocument(applyResult(report));
    expect(headingsIn(document)).toEqual([]);
    expect(listItemsIn(document)).toEqual([expect.stringContaining("Project /project-a carries an adapter warning.")]);
    expect(headingsIn(document)).not.toContain("Applied:");
  });


  test("blocked multi-project apply retains exclusion-only apply receipt", () => {
    const receipt = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: [],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
      ],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [],
      repositoryExclusions: [{
        current: [],
        next: ["/.agent-profile-kit/codex/context.md"],
        target: "/project-a/.git/info/exclude",
        installed: false,
      }],
    });
    const resultingState = emptyReport({
      blockers: [fixtureBlocker("Project B is blocked", "/project-b")],
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: [],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          outputs: ["b.md"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
        },
      ],
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "addition", project: "/project-b" },
      ],
      outputs: [{ kind: "addition", path: "b.md", project: "/project-b" }],
    });

    // Blocked apply retains the exclusion-only receipt: Applied section with
    // the completed exclusion clause, then the committed evidence suffix.
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(apply);
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "error" });
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(applied).toBeGreaterThan(-1);
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node).includes("/project-a"))).toBe(true);
  });

  test("readiness groups Projects that share Profile, Hosts, and setup condition", () => {
    const hookApproval: HostSetupStep = {
      host: "codex",
      kind: "approval-required",
      message: "Review and approve the generated SessionStart hook when Codex asks.",
      consequence: "Declining the hook prevents Profile Context from loading.",
      output: ".codex/hooks.json",
      provenance: "transition",
    };
    const receipt = emptyReport({
      desired: ["/project-a", "/project-b"].map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: [".codex/hooks.json"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
        setupSteps: [hookApproval],
      })),
      items: ["/project-a", "/project-b"].map((project) => ({
        kind: "addition" as const,
        project,
      })),
      outputs: ["/project-a", "/project-b"].map((project) => ({
        kind: "addition" as const,
        path: ".codex/hooks.json",
        project,
      })),
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: ["/project-a", "/project-b"].map((project) => ({
        kind: "current" as const,
        project,
      })),
    });

    // One invocation-wide readiness statement as the trailing prose node,
    // with no per-Project attachment or activation copy.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(concise);
    // Exactly one readiness statement, trailing the document; the composed
    // readiness wording (and any Project list) is golden-covered.
    expect(concise.map(shape)).toEqual([
      "notice:success", "blank", "heading", "prose", "prose", "prose",
      "blank", "heading", "list-item", "blank", "prose",
    ]);
  });

  test("grouped readiness appears once across multiple projects despite distinct exact Host sets", () => {
    const receipt = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          hosts: ["codex"],
          outputs: [".codex/hooks.json"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
          setupSteps: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          hosts: ["claude"],
          outputs: [".claude/rules/agent-profile-kit.md"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
          setupSteps: [],
        },
        {
          canonicalProject: "/project-c",
          context: "composed",
          hosts: ["claude", "grok"],
          outputs: [".claude/rules/agent-profile-kit.md"],
          profile: "coding",
          project: "/project-c",
          resolvedArtifacts: [],
          setupSteps: [],
        },
      ],
      items: ["/project-a", "/project-b", "/project-c"].map((project) => ({
        kind: "addition" as const,
        project,
      })),
      outputs: [
        { kind: "addition" as const, path: ".codex/hooks.json", project: "/project-a" },
        { kind: "addition" as const, path: ".claude/rules/agent-profile-kit.md", project: "/project-b" },
        { kind: "addition" as const, path: ".claude/rules/agent-profile-kit.md", project: "/project-c" },
      ],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: ["/project-a", "/project-b", "/project-c"].map((project) => ({
        kind: "current" as const,
        project,
      })),
    });

    // The readiness statement stays invocation-wide despite distinct Host sets.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(concise);
    expect(concise.map(shape)).toEqual([
      "notice:success", "blank", "heading", "prose", "prose", "prose", "prose",
      "blank", "prose",
    ]);
  });


  test("current project . identity is never formatted with adjacent punctuation as ..", () => {
    const receipt = emptyReport({
      desired: [
        {
          canonicalProject: "/Users/test/workspace/my-project",
          context: "composed",
          hosts: ["codex"],
          outputs: [".codex/hooks.json"],
          profile: "coding",
          project: ".",
          resolvedArtifacts: [],
          setupSteps: [],
        },
      ],
      items: [{ kind: "addition" as const, project: "." }],
      outputs: [{ kind: "addition" as const, path: ".codex/hooks.json", project: "." }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current" as const, project: "." }],
    });

    // The cwd-authored identity never renders with adjacent punctuation; the
    // readiness statement trails the document.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(concise);
    expect(nodes.some((node) => nodeText(node).includes(".."))).toBe(false);
    // The readiness statement trails the document; its wording is
    // golden-covered (no structured fact exists for it).
    expect(nodes.at(-1)).toMatchObject({ kind: "prose" });
  });

  test("setup-dependent readiness appears without presenter-internal grouping copy", () => {
    const hookApproval: HostSetupStep = {
      host: "codex",
      kind: "approval-required",
      message: "Review and approve the generated SessionStart hook when Codex asks.",
      consequence: "Declining the hook prevents Profile Context from loading.",
      output: ".codex/hooks.json",
      provenance: "transition",
    };
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [hookApproval],
      }],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    // The readiness statement carries no presenter-internal grouping copy.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(concise);
    // The setup-dependent receipt shape: the setup section, then one prose
    // summary, then the trailing readiness prose — no grouping section.
    expect(concise.map(shape)).toEqual([
      "notice:success",
      "blank",
      "heading",
      "prose",
      "prose",
      "blank",
      "prose",
    ]);
    // The readiness statement trails the document; its wording is
    // golden-covered (no structured fact exists for it).
    expect(nodes.at(-1)).toMatchObject({ kind: "prose" });
  });

  test("verbose evidence, JSON, and exit codes stay unchanged", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const sectionAt = (text: string) => indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === text);
    for (const section of ["Projects:", "Outputs:", "Selected setup:", "Blockers:"]) {
      expect(sectionAt(section)).toBeGreaterThan(-1);
    }
    expect(projectStateLines(verbose)).toContain("/project-a");
    const nodes2 = flattenPresentationNodes(verbose);
    expect(nodes2.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: "/project-a/a.md" },
        ": addition",
      ])
    )).toBe(true);
    expect(keyValuesIn(verbose, "Next")).toEqual([]);
    expect(headingsIn(verbose).some((text) => text.startsWith("Next"))).toBe(false);

    const machine = machineReport([
      machineProject("/project-a", {
        desired: {
          context: "composed",
          hosts: ["codex"],
          outputs: ["a.md"],
          profile: "coding",
          resolvedArtifacts: [],
        },
        state: { kind: "addition" },
        outputs: [{ kind: "addition", path: "a.md", consumingHosts: [] }],
      }),
    ]);
    const payload = JSON.parse(formatLifecycleJson("status", machine)) as {
      readonly command: string;
      readonly outcome: string;
      readonly schemaVersion: number;
    };
    expect(payload).toMatchObject({
      command: "status",
      outcome: "attention",
      schemaVersion: 14,
    });
    expect(lifecycleExitCode(report)).toBe(0);
    expect(lifecycleExitCode(emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
    }))).toBe(2);
  });
});

describe("newcomer presentation lexicon (TEST-015, US-030, US-031, DEC-027)", () => {
  test("maintains canonical newcomer mappings in DEFAULT_VIEW_LEXICON", () => {
    expect(DEFAULT_VIEW_LEXICON.projectBinding.singular).toBe("configured Project");
    expect(DEFAULT_VIEW_LEXICON.projectBinding.plural).toBe("configured Projects");
    expect(DEFAULT_VIEW_LEXICON.localConfiguration).toBe("settings");
    expect(DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.singular).toBe("temporary Profile");
    expect(DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.plural).toBe("temporary Profiles");
    expect(DEFAULT_VIEW_LEXICON.temporaryProfileInstallation.action).toBe("temporary install");
    expect(DEFAULT_VIEW_LEXICON.hostSetupStep).toBe("first use");
  });

  test("INTERNAL_ONLY_DEFAULT_TERMS disallows internal domain terms on routine default views", () => {
    const prohibited = [
      "Project Binding",
      "Project Bindings",
      "Local Configuration",
      "Temporary Profile Installation",
      "Temporary Profile Installations",
      "Host Setup Step",
      "Host Setup Steps",
      "Installation State",
      "Profile Installation",
      "generated-output",
      "Repository Exclusion",
      "Installer-owned",
      "reconciliation",
      "Artifact ID",
      "Installation Manifest",
      "desired state",
    ];
    for (const term of prohibited) {
      const matches = INTERNAL_ONLY_DEFAULT_TERMS.some((pattern) => pattern.test(term));
      expect(matches).toBeTrue();
    }
  });

  test("routine validation uses newcomer presentation lexicon and omits internal terms", () => {
    const validationDocument = (bindings: number, hosts: string[], profiles: string[]) =>
      validationResultDocument({ bindings, hosts, profiles, warnings: [] });

    const zeroProjects = validationDocument(0, [], ["engineering"]);
    // Severity is the validity fact; the count clause is its carried value,
    // authored as an atomic identifier so it never wraps (US-010).
    expect(noticesIn(zeroProjects)).toHaveLength(1);
    expect(noticesIn(zeroProjects)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect((noticesIn(zeroProjects)[0]!.nodes[0] as { readonly parts: readonly InlineContent[] })
      .parts.at(-1)).toMatchObject({ kind: "identifier" });
    expect(keyValuesIn(zeroProjects, "Profiles found")[0]!.value).toEqual({
      kind: "prose",
      parts: ["engineering"],
    });
    expect(keyValuesIn(zeroProjects, "Hosts bound")[0]!.value).toMatchObject({ kind: "prose" });
    expect(commandTexts(zeroProjects)).toContain("apkit bind <profile> --host <host>");
    expectUserFacingVocabulary(renderBoundary(zeroProjects));

    const oneProject = validationDocument(1, ["codex"], ["engineering"]);
    expect(noticesIn(oneProject)).toHaveLength(1);
    expect(noticesIn(oneProject)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect((noticesIn(oneProject)[0]!.nodes[0] as { readonly parts: readonly InlineContent[] })
      .parts.at(-1)).toMatchObject({ kind: "identifier" });
    expectUserFacingVocabulary(renderBoundary(oneProject));

    const multiProjects = validationDocument(3, ["codex", "claude"], ["engineering", "design"]);
    expect(noticesIn(multiProjects)).toHaveLength(1);
    expect(noticesIn(multiProjects)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect((noticesIn(multiProjects)[0]!.nodes[0] as { readonly parts: readonly InlineContent[] })
      .parts.at(-1)).toMatchObject({ kind: "identifier" });
    expectUserFacingVocabulary(renderBoundary(multiProjects));
  });

  test("routine inventory topics and temporary inventory use newcomer lexicon", () => {
    // Topic inventory structure is asserted in the #389 describe; the routine
    // surfaces carry the newcomer vocabulary (guard runs on rendered output).
    const index = inventoryIndexDocument();
    expectUserFacingVocabulary(renderPresentationDocument(index, defaultRenderContext));

    const machineIndex = machineInventoryIndexDocument();
    expectUserFacingVocabulary(renderPresentationDocument(machineIndex, defaultRenderContext));

    // Empty temporary inventory: one success notice and one prose node whose
    // typed inline command part keeps the creation invocation atomic.
    const emptyTemp = temporaryInventoryDocument([]);
    expect(emptyTemp.map(shape)).toEqual(["notice:success", "prose"]);
    expect((emptyTemp[0] as Extract<PresentationNode, { kind: "notice" }>).severity).toBe("success");
    expect(inlineCommandTexts(emptyTemp)).toEqual([
      "apkit machine install-temp <profile> <project> --host <host>",
    ]);
    expectUserFacingVocabulary(renderPresentationDocument(emptyTemp, defaultRenderContext));

    // Active temporary inventory: a heading carrying the installation count,
    // the fixture identity as a typed identifier, and the removal invocation
    // as a typed inline command.
    const activeTemp = temporaryInventoryDocument([
      {
        host: "codex",
        profileId: "engineering",
        project: "/project-a",
        temporaryInstallationId: "temp-12345",
      },
    ]);
    expect(headingsIn(activeTemp).filter((text) => text.endsWith("(1):"))).toHaveLength(1);
    expect(keyValuesIn(activeTemp, "Temporary installation")[0]!.value).toEqual({
      kind: "identifier",
      value: "temp-12345",
    });
    expect(inlineCommandTexts(activeTemp)).toEqual([
      "apkit machine remove-temp <temporary-installation-id>",
    ]);
    expectUserFacingVocabulary(renderPresentationDocument(activeTemp, defaultRenderContext));
  });

  test("routine teardown receipts preserve configured Projects in user-facing vocabulary", () => {
    const uninstall = uninstallResultDocument({
      kept: [],
      projects: [{
        outputs: [".claude/rules/agent-profile-kit.md", ".codex/hooks.json"],
        project: "/project-a",
        repositoryExclusions: [],
      }],
      warnings: [],
    });
    // The next action is one command-category prose node whose typed inline
    // command parts keep both invocations atomic.
    const guidance = flattenPresentationNodes(uninstall).find((node) =>
      node.kind === "prose" && node.category === "command");
    expect(guidance).toBeDefined();
    expect(inlineCommandTexts([guidance!])).toEqual(["apkit unbind", "apkit apply"]);
    expectUserFacingVocabulary(renderPresentationDocument(uninstall, defaultRenderContext));
  });

  test("uninstall renders best-effort exclusion warnings and claims only cleaned entries", () => {
    const result = uninstallResultDocument({
      kept: [],
      projects: [{
        outputs: [".codex/hooks.json"],
        project: "/project-a",
        repositoryExclusions: [],
      }],
      warnings: [
        "/project-a/.git/info/exclude changed during exclusion publication; skipping to preserve unrelated bytes",
      ],
    });
    const warningItem = flattenPresentationNodes(result).find((node) =>
      node.kind === "list-item" && node.category === "attention"
    );
    expect(warningItem).toBeDefined();
    expect(listItemsIn(result)).toContain(
      "/project-a/.git/info/exclude changed during exclusion publication; skipping to preserve unrelated bytes",
    );
    // No cleaned-exclusion section exists for this receipt.
    expect(headingsIn(result)).toEqual([]);
  });

  test("empty status references configured Projects in next guidance", () => {
    const empty = lifecycleStatusDocument(emptyReport());
    expect(empty.map(shape)).toEqual(["notice:success", "prose:command"]);
    expect((empty[0] as Extract<PresentationNode, { kind: "notice" }>).severity).toBe("success");
    // The next action is one command-category prose node whose typed inline
    // command parts keep both invocations atomic.
    expect(inlineCommandTexts(empty)).toEqual([
      "apkit list projects",
      "apkit bind <profile> --host <host>",
    ]);
    expectUserFacingVocabulary(renderPresentationDocument(empty, defaultRenderContext));
  });

  test("temporary install and remove receipts use newcomer lexicon", () => {
    const install = temporaryInstallationDocument("install-temp", {
      completionState: "installed",
      diagnosticValues: [],
      host: "codex",
      outputs: [".codex/hooks.json"],
      profileId: "engineering",
      project: "/project-a",
      setupSteps: [],
      temporaryInstallationId: "temp-987",
      warnings: [],
    });
    expect(noticesIn(install)).toHaveLength(1);
    expect(noticesIn(install)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(keyValuesIn(install, "  Temporary installation")[0]!.value).toEqual({
      kind: "identifier",
      value: "temp-987",
    });
    expect(commandTexts(install)).toContain("apkit machine remove-temp temp-987");
    expectUserFacingVocabulary(renderPresentationDocument(install, defaultRenderContext));

    const remove = temporaryInstallationDocument("remove-temp", {
      completionState: "removed",
      diagnosticValues: [],
      host: "codex",
      outputs: [],
      setupSteps: [],
      temporaryInstallationId: "temp-987",
      warnings: [],
    });
    expect(noticesIn(remove)).toHaveLength(1);
    expect(noticesIn(remove)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(keyValuesIn(remove, "  Temporary installation")[0]!.value).toEqual({
      kind: "identifier",
      value: "temp-987",
    });
    expectUserFacingVocabulary(renderPresentationDocument(remove, defaultRenderContext));
  });

  test("technical surfaces (info, verbose, JSON, actionable recovery) retain canonical domain terms", () => {
    const info = infoDocument({
      configurationState: "current",
      engineVersion: "0.114.0",
      installationState: "/home/user/.agents/agent-profile-kit/state/manifest.json",
      localConfiguration: "/home/user/.agents/agent-profile-kit/config.yaml",
      workspace: { authored: "~/workspace", canonical: "/home/user/workspace" },
    });
    // The canonical keys are authored key-value nodes, retained on technical surfaces.
    expect(keyValuesIn(info, "Local Configuration")).toHaveLength(1);
    expect(keyValuesIn(info, "Installation State")).toHaveLength(1);

    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [{
          consequence: "hook approval required",
          host: "codex",
          kind: "approval-required",
          message: "Approve hook",
          output: ".codex/hooks.json",
          provenance: "transition",
        }],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const verbose = lifecycleStatusDocument(report, { verbose: true });
    expect(headingsIn(verbose)).toContain("Host Setup:");

    const missingProfile = flatInlineText(formatMissingProfileError({
      availableProfiles: ["coding"],
      message: "Profile 'unknown' not found",
      name: "MissingProfileError",
      profile: "unknown",
      recoverByEditingLocalConfiguration: true,
    }));
    expect(missingProfile).toContain("Local Configuration");
  });
});


describe("focused blockers-only status view (#351)", () => {
  const blockedFleet = (): ReconciliationReport => {
    const projectBlocker = normalizeBlocker({
      action: "verify",
      affectedItems: [{ kind: "host", value: "codex" }],
      failure: { case: "unsafe-parent", output: ".codex/hooks.json", parent: "/project-a/.codex" },
      kind: "installation-ownership",
      project: "/project-a",
      scope: "project",
    });
    return emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [{
          consequence: "hook approval required",
          host: "codex",
          kind: "approval-required",
          message: "Approve hook",
          output: ".codex/hooks.json",
          provenance: "transition",
        }],
      }],
      items: [{ kind: "blocked", project: "/project-a", reason: "tracked path" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
      warnings: ["OpenCode reports a duplicate Skill identity"],
      blockers: [
        projectBlocker,
        normalizeBlocker({
          affectedItems: [{ kind: "path", value: "/home/.agents/agent-profile-kit/state/manifest.json" }],
          detail: "Installation State is unreadable",
          kind: "installation-state-unreadable",
          scope: "global",
        }),
      ],
    });
  };

  test("focused concise view renders Project and global Blockers and suppresses unrelated inventory", () => {
    const focused = lifecycleStatusDocument(blockedFleet(), { blockersOnly: true });
    const nodes = flattenPresentationNodes(focused);
    const texts = presentationTexts(focused);

    expect(noticesIn(focused)[0]).toMatchObject({ kind: "notice", severity: "error" });
    expect(keyValuesIn(focused, "Project")).toHaveLength(1);
    expect(focused.filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(3);
    expect(headingsIn(focused)).toContain("Global blockers:");
    expect(nextActionItems(focused).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
      { paths: [], commands: ["apkit status"] },
    ]);
    // The displayed-Blocker footer is the last error prose of the focused view.
    expect(footerNode(focused)).toMatchObject({ kind: "prose", category: "error" });
    // No unrelated lifecycle inventory: no warnings, paths, states, setup, or
    // exclusion sections, and no binding Profile detail.
    expect(headingsIn(focused).some((text) =>
      /Warnings:|Host Setup:|Git exclusions/.test(text)
    )).toBe(false);
    expect(keyValuesIn(focused, "  State")).toEqual([]);
    expect(texts.some((text) => text.includes("duplicate Skill identity") || text.includes("Approve hook"))).toBe(false);
    expect(keyValuesIn(focused, "  Profile")).toEqual([]);
  });

  test("focused concise output is deterministic across repeated rendering", () => {
    const first = lifecycleStatusDocument(blockedFleet(), { blockersOnly: true });
    const second = lifecycleStatusDocument(blockedFleet(), { blockersOnly: true });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("focused concise view deduplicates one shared blocker resolution across Projects", () => {
    const report = emptyReport({
      blockers: [
        fixtureBlocker("Project /z-project is blocked", "/z-project"),
        fixtureBlocker("Project /a-project is blocked", "/a-project"),
      ],
    });

    const focused = lifecycleStatusDocument(report, { blockersOnly: true });
    const projectKeys = keyValuesIn(focused, "Project")
      .map((node) => (node.value as { readonly canonicalPath: string }).canonicalPath);
    expect(projectKeys).toEqual(["/a-project", "/z-project"]);
    // One shared resolution renders once; the footer is the last error prose
    // before the shared next action.
    expect(nextActionItems(focused).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
    ]);
    expect(footerNode(focused)).toMatchObject({ kind: "prose", category: "error" });
  });

  test("focused concise view never attributes next actions to Projects without displayed Blockers", () => {
    const report = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          outputs: ["b.md"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
        },
      ],
      items: [{ kind: "blocked", project: "/project-a", reason: "tracked path" }],
      outputs: [
        { kind: "update", path: "a.md", project: "/project-a" },
        { kind: "addition", path: "b.md", project: "/project-b" },
      ],
      blockers: [fixtureBlocker("Project /project-a is blocked", "/project-a")],
    });

    const focused = lifecycleStatusDocument(report, { blockersOnly: true });
    const texts = presentationTexts(focused);

    expect(keyValuesIn(focused, "Project")).toHaveLength(1);
    expect(texts.some((text) => text.includes("/project-b"))).toBe(false);
    // Only the displayed-Blocker Project receives an item, retrying status.
    expect(nextActionItems(focused).map(nextActionStructure)).toEqual([
      { paths: [], commands: ["apkit status"] },
    ]);
  });

  test("focused verbose view retains complete Blocker fields and affected items without unrelated sections", () => {
    const focused = lifecycleStatusDocument(blockedFleet(), { blockersOnly: true, verbose: true });
    const nodes = flattenPresentationNodes(focused);
    const texts = presentationTexts(focused);

    expect(nodes.filter((node) => node.kind === "list-item")).toHaveLength(2);
    const evidence = nodes.slice(nodes.findIndex((node) => node.kind === "list-item"), -1);
    expect(evidence.map(shape)).toEqual([
      "list-item", "prose", "prose", "prose", "prose",
      "list-item", "prose", "prose", "prose", "prose",
      "blank",
    ]);
    expect(inlineCommandTexts(nodes)).toContain("apkit apply '/project-a'");
    expect(texts.some((text) => text.includes("/project-a"))).toBe(true);
    expect(texts.some((text) => text.includes("codex"))).toBe(true);
    // The displayed-Blocker footer closes the focused verbose view.
    expect(flattenPresentationNodes(focused).at(-1)).toMatchObject({
      kind: "prose",
      category: "error",
    });
    // No unrelated sections or next guidance.
    for (const section of ["Projects:", "Outputs:", "Selected setup:", "Warnings:", "Host Setup:"]) {
      expect(headingsIn(focused)).not.toContain(section);
    }
    expect(nextGuidance(focused)).toEqual([]);
  });


  test("a scope with no Blockers reports that outcome without lifecycle inventory", () => {
    const concise = lifecycleStatusDocument(emptyReport(), { blockersOnly: true });
    const verbose = lifecycleStatusDocument(emptyReport(), { blockersOnly: true, verbose: true });

    expect(JSON.stringify(concise)).toBe(JSON.stringify(verbose));
    expect(concise[0]).toMatchObject({ kind: "prose", category: "success" });
    expect(concise[1]).toMatchObject({ kind: "prose", category: "command" });
    expect(inlineCommandTexts(concise)).toEqual(["apkit status"]);
    expect(concise.map(shape)).toEqual(["prose:success", "prose:command"]);

    const here = lifecycleStatusDocument(emptyReport(), {
      blockersOnly: true,
      selection: { command: "status", kind: "project", match: "containing", target: process.cwd() },
    });
    expect(inlineCommandTexts(here)).toEqual(["apkit status --here"]);
  });
});

describe("focused blockers-only apply view (#352)", () => {
  const affectedBlocker = () =>
    normalizeBlocker({
      action: "verify",
      affectedItems: [{ kind: "host", value: "codex" }],
      failure: { case: "unsafe-parent", output: ".codex/hooks.json", parent: "/project-b/.codex" },
      kind: "installation-ownership",
      project: "/project-b",
      scope: "project",
    });

  /** One committed Project, one Project-scoped Blocker, one still-pending Project. */
  const partialApply = () => {
    const receipt = emptyReport({
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project: "/project-a",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          outputs: ["b.md"],
          profile: "coding",
          project: "/project-b",
          resolvedArtifacts: [],
        },
        {
          canonicalProject: "/project-c",
          context: "composed",
          outputs: ["c.md"],
          profile: "coding",
          project: "/project-c",
          resolvedArtifacts: [],
        },
      ],
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "blocked", project: "/project-b", reason: "host capability" },
        { kind: "current", project: "/project-c" },
      ],
      outputs: [
        { kind: "unchanged", path: "a.md", project: "/project-a" },
        { kind: "addition", path: "b.md", project: "/project-b" },
        { kind: "addition", path: "c.md", project: "/project-c" },
      ],
      warnings: ["OpenCode reports a duplicate Skill identity"],
      blockers: [affectedBlocker()],
    });
    return { receipt, resultingState };
  };

  test("focused concise apply renders receipt and pending scope before Blocker evidence and suppresses unrelated inventory", () => {
    const { receipt, resultingState } = partialApply();
    const document = applyReportDocument({ receipt, resultingState }, { blockersOnly: true });
    const nodes = flattenPresentationNodes(document);

    expect(noticesIn(document)[0]).toMatchObject({ kind: "notice", severity: "error" });
    // ADR-0024 safety-evidence order: Applied → Freshly current → Still pending
    // → Project → Blocker → footer, as an ordered prefix before the footer.
    const appliedIndex = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    // The safety-evidence lines bind the fixture identities: the applied
    // Project is freshly current, the untouched Project is still pending
    // (position and fixture identity).
    const freshIndex = currentEvidenceIndex(nodes, true);
    const pendingIndex = freshIndex + 2;
    const projectIndex = indexWhere(nodes, (node) => node.kind === "key-value" && node.key === "Project");
    const blockerIndex = indexWhere(nodes, (node) => node.kind === "prose" && node.category === "error");
    const footerIndex = nodes.indexOf(footerNode(document)!);
    expect(footerIndex).toBeGreaterThan(-1);
    expect(nodes[footerIndex]).toMatchObject({ kind: "prose", category: "error" });
    expect(appliedIndex).toBeGreaterThan(-1);
    expect(freshIndex).toBeGreaterThan(appliedIndex);
    expect(pendingIndex).toBeGreaterThan(freshIndex);
    expect(projectIndex).toBeGreaterThan(pendingIndex);
    expect(blockerIndex).toBeGreaterThan(projectIndex);
    expect(footerIndex).toBeGreaterThan(blockerIndex);
    // Receipt evidence rendered exactly once inside the prefix.
    expect(nodes.filter((node) => node.kind === "heading" && nodeText(node) === "Applied:")).toHaveLength(1);
    // The Applied receipt evidence binds the fixture Project; the composed
    // count wording is golden-covered.
    expect(nodes.slice(appliedIndex, pendingIndex).some((node) =>
      node.kind === "prose" && nodeText(node).includes("/project-a")
    )).toBe(true);
    // The strict Blocker filter suppresses ordinary inventory.
    expect(headingsIn(document)).not.toContain("Warnings:");
    expect(headingsIn(document)).not.toContain("Host Setup:");
    expect(headingsIn(document)).not.toContain("Next:");
    expect(nodes.some((node) => nodeText(node).includes("duplicate Skill identity"))).toBe(false);
    expect(nodes.some((node) => (nodeText(node).includes("b.md") || nodeText(node).includes("c.md")))).toBe(false);
  });

  test("focused verbose apply retains every Blocker affected item and the receipt without ordinary inventory sections", () => {
    const { receipt, resultingState } = partialApply();
    const document = applyReportDocument(
      { receipt, resultingState },
      { blockersOnly: true, verbose: true },
    );
    const nodes = flattenPresentationNodes(document);

    expect(noticesIn(document)[0]).toMatchObject({ kind: "notice", severity: "error" });
    // ADR-0024 safety-evidence order (verbose): Applied → Freshly current →
    // Still pending → Blockers section → footer.
    const appliedIndex = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    const freshIndex = currentEvidenceIndex(nodes, true);
    const pendingIndex = freshIndex + 2;
    const blockersHeading = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Blockers:");
    const footerIndex = nodes.indexOf(footerNode(document)!);
    expect(footerIndex).toBeGreaterThan(-1);
    expect(nodes[footerIndex]).toMatchObject({ kind: "prose", category: "error" });
    expect(appliedIndex).toBeGreaterThan(-1);
    expect(freshIndex).toBeGreaterThan(appliedIndex);
    expect(pendingIndex).toBeGreaterThan(freshIndex);
    expect(blockersHeading).toBeGreaterThan(pendingIndex);
    expect(footerIndex).toBeGreaterThan(blockersHeading);
    // The Blocker bullet keeps every affected item as typed evidence.
    expect(nodes.slice(blockersHeading, footerIndex).filter((node) => node.kind === "list-item")).toHaveLength(1);
    expect(nodes.slice(blockersHeading, footerIndex).some((node) => node.kind === "prose" && nodeText(node).includes("codex"))).toBe(true);
    // The strict Blocker filter suppresses ordinary verbose inventory.
    expect(headingsIn(document)).toEqual(expect.arrayContaining(["Applied:", "Blockers:"]));
    expect(headingsIn(document)).not.toContain("Projects:");
    expect(headingsIn(document)).not.toContain("Outputs:");
    expect(headingsIn(document)).not.toContain("Selected setup:");
    expect(headingsIn(document)).not.toContain("Warnings:");
    expect(headingsIn(document)).not.toContain("Host Setup:");
    expect(headingsIn(document)).not.toContain("Git exclusions:");
    expect(headingsIn(document)).not.toContain("Next:");
  });

  test("an apply with no Blockers renders the ordinary receipt view under the filter", () => {
    const receipt = emptyReport({
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const result = applyResult(receipt, emptyReport());

    expect(applyReportDocument(result, { blockersOnly: true })).toEqual(applyReportDocument(result, {}));
    expect(applyReportDocument(result, { blockersOnly: true, verbose: true })).toEqual(
      applyReportDocument(result, { verbose: true }),
    );
    expect(headingsIn(applyReportDocument(result, { blockersOnly: true }))).toContain("Applied:");
  });

  test("a globally blocked apply renders focused Blocker evidence without receipt sections", () => {
    const report = asBlockedReport(emptyReport({
      blockers: [fixtureBlocker("Installation State is unreadable")],
    }));

    // Concise: outcome notice, global Blocker section, footer — no receipt,
    // still-pending, or warning inventory.
    const concise = blockedApplyReportDocument(report, { blockersOnly: true });
    expect(noticesIn(concise).map((node) => node.severity)).toEqual(["error"]);
    expect(headingsIn(concise)).toEqual(["Global blockers:"]);
    expect(keyValuesIn(concise, "Project")).toEqual([]);
    expect(concise.filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(2);
    expect(footerNode(concise)).toMatchObject({ kind: "prose", category: "error" });

    // Verbose: the Blocker bullet with its fields, then the footer.
    const verbose = blockedApplyReportDocument(report, { blockersOnly: true, verbose: true });
    expect(noticesIn(verbose)[0]).toMatchObject({ kind: "notice", severity: "error" });
    expect(headingsIn(verbose)).toEqual(["Blockers:"]);
    expect(verbose.filter((node) => node.kind === "list-item")).toHaveLength(1);
    // The footer is the last error prose of the view; its count wording is
    // golden-covered.
    expect(footerNode(verbose)).toMatchObject({ kind: "prose", category: "error" });
    expect(headingsIn(verbose)).not.toContain("Applied:");
    expect(headingsIn(verbose)).not.toContain("Next:");
    expect(headingsIn(verbose)).not.toContain("Projects:");
  });

  test("an execution failure retains its safety evidence under the filter and appends Blocker evidence", () => {
    const { receipt, resultingState } = partialApply();
    const failure = {
      detail: "write failed",
      failedProject: executionProject("/project-b"),
      message: "Apply failed while writing the Project",
      pendingProjects: [executionProject("/project-c")],
      receipt,
      resultingState,
    };
    const document = applyExecutionFailureDocument(failure, { blockersOnly: true });
    const nodes = flattenPresentationNodes(document);

    expect(noticesIn(document)[0]).toMatchObject({ kind: "notice", severity: "error" });
    // Safety evidence (Applied → Freshly current) precedes the Blocker section.
    const appliedIndex = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    const freshIndex = currentEvidenceIndex(nodes);
    const blockerIndex = indexWhere(nodes, (node) => node.kind === "prose" && node.category === "error");
    expect(appliedIndex).toBeGreaterThan(-1);
    expect(freshIndex).toBeGreaterThan(appliedIndex);
    expect(blockerIndex).toBeGreaterThan(freshIndex);
    // The failed and pending evidence bind their fixture identities to the
    // ordered evidence nodes.
    expect(nodes.some((node) =>
      node.kind === "prose" && nodeText(node).includes("/project-b")
    )).toBe(true);
    expect(nodes.some((node) =>
      node.kind === "prose" && nodeText(node).includes("/project-c")
    )).toBe(true);
  });

  test("an execution failure with no Blockers renders unchanged under the filter", () => {
    const receipt = emptyReport({
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const failure = {
      detail: "write failed",
      failedProject: executionProject("/project-b"),
      message: "Apply failed while writing the Project",
      pendingProjects: [executionProject("/project-b")],
      receipt,
      resultingState: undefined,
    };

    expect(applyExecutionFailureDocument(failure, { blockersOnly: true })).toEqual(
      applyExecutionFailureDocument(failure, {}),
    );
  });

  test("focused execution-failure output uses single blank-line separation before the Blocker section (RE-1)", () => {
    const { receipt, resultingState } = partialApply();
    const failure = {
      detail: "write failed",
      failedProject: executionProject("/project-b"),
      message: "Apply failed while writing the Project",
      pendingProjects: [executionProject("/project-c")],
      receipt,
      resultingState,
    };

    const concise = flattenPresentationNodes(
      applyExecutionFailureDocument(failure, { blockersOnly: true }),
    );
    const freshIndex = currentEvidenceIndex(concise);
    expect(freshIndex).toBeGreaterThan(-1);
    // Single blank-line separation before the concise Blocker section (RE-1).
    expect(concise[freshIndex + 1]).toMatchObject({ kind: "verbatim", text: "" });
    expect(concise[freshIndex + 2]).toMatchObject({
      kind: "key-value",
      key: "Project",
      value: { kind: "path", canonicalPath: "/project-b" },
    });
    const blockerIndex = concise.findIndex((node, index) =>
      index > freshIndex && node.kind === "prose" &&
      node.category === "error");
    expect(blockerIndex).toBeGreaterThan(freshIndex + 2);
    expect(concise[blockerIndex - 1]).toMatchObject({
      kind: "path",
      canonicalPath: "/project-b",
    });

    const verbose = flattenPresentationNodes(
      applyExecutionFailureDocument(failure, { blockersOnly: true, verbose: true }),
    );
    const verboseFreshIndex = currentEvidenceIndex(verbose);
    expect(verboseFreshIndex).toBeGreaterThan(-1);
    expect(verbose[verboseFreshIndex + 1]).toMatchObject({ kind: "verbatim", text: "" });
    expect(verbose[verboseFreshIndex + 2]).toMatchObject({ kind: "heading", text: "Blockers:" });
    expect(verbose[verboseFreshIndex + 3]).toMatchObject({ kind: "list-item" });
  });
});

describe("apply presentation documents", () => {
  test("concise apply receipt carries a success notice, receipt evidence, and trailing readiness", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    const document = applyReportDocument(applyResult(receipt, resultingState));
    expect(noticesIn(document)).toHaveLength(1);
    expect(noticesIn(document)[0]).toMatchObject({ kind: "notice", severity: "success" });
    const nodes = flattenPresentationNodes(document);
    const appliedIndex = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(appliedIndex).toBeGreaterThan(-1);
    expect(nodes.slice(appliedIndex).some((node) =>
      node.kind === "prose"
    )).toBe(true);
    // The per-Project operation line binds the fixture identity; the
    // readiness statement closes the receipt as its trailing prose node.
    expect(nodes.slice(appliedIndex).some((node) =>
      node.kind === "prose" && nodeText(node).includes("a.md") && nodeText(node).includes("/project-a")
    )).toBe(true);
    expect(nodes.at(-1)).toMatchObject({ kind: "prose" });
    expect(commandsIn(document)).toEqual([]);
  });

  test("verbose apply keeps composed Context as the only verbatim content", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
    });

    const nodes = flattenPresentationNodes(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    const verbatim = nodes.flatMap((node) => node.kind === "verbatim" && nodeText(node) !== "" ? [nodeText(node)] : []);
    expect(verbatim).toHaveLength(2);
    for (const context of verbatim) {
      expect(context).toMatch(/begin Context/);
      expect(context).toMatch(/end Context/);
    }
    const texts = headingsIn(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    expect(texts).toContain("Pending:");
    expect(texts).toContain("Applied:");
    expect(texts).toContain("Host Setup:");
  });

  test("blocked apply presents an error notice, Blocker evidence, and the committed receipt", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/project-a" }],
    });

    const document = blockedApplyReportDocument(asBlockedReport(report));
    const notices = noticesIn(document);
    // The outcome and displayed-evidence aggregates are error notices.
    expect(notices[0]).toMatchObject({ kind: "notice", severity: "error" });
    expect(notices.at(-1)).toMatchObject({ kind: "notice", severity: "error" });
    const nodes = flattenPresentationNodes(document);
    expect(nodes.some((node) => node.kind === "key-value" && node.key === "Project")).toBe(true);
    expect(nodes.some((node) =>
      node.kind === "prose" && node.category === "error"
    )).toBe(true);
  });

  test("focused apply places the complete ADR-0024 safety-evidence order before the Blocker footer", () => {
    const receipt = emptyReport({
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-b")],
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }, {
        canonicalProject: "/project-b",
        context: "composed",
        outputs: ["b.md"],
        profile: "coding",
        project: "/project-b",
        resolvedArtifacts: [],
      }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "blocked", project: "/project-b" },
      ],
    });

    const nodes = flattenPresentationNodes(
      applyReportDocument(applyResult(receipt, resultingState), { blockersOnly: true }),
    );
    // The complete ADR-0024 order: Applied → Freshly current → Project →
    // Blocker → footer, each as its own typed node.
    const appliedIndex = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    const freshlyCurrentIndex = currentEvidenceIndex(nodes);
    const projectIndex = indexWhere(nodes, (node) => node.kind === "key-value" && node.key === "Project");
    const blockerIndex = indexWhere(nodes, (node) => node.kind === "prose" && node.category === "error");
    const footerIndex = nodes.lastIndexOf(nodes.filter((node) => node.kind === "prose" && node.category === "error").at(-1)!);
    expect(appliedIndex).toBeGreaterThan(-1);
    expect(freshlyCurrentIndex).toBeGreaterThan(appliedIndex);
    expect(projectIndex).toBeGreaterThan(freshlyCurrentIndex);
    expect(blockerIndex).toBeGreaterThan(projectIndex);
    expect(footerIndex).toBeGreaterThan(blockerIndex);
  });

  test("execution failure carries an error notice, Project scope, and the committed receipt", () => {
    const receipt = emptyReport({
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const document = applyExecutionFailureDocument({
      detail: "write failed",
      failedProject: executionProject("/project-a"),
      message: "Apply failed while writing the Project",
      pendingProjects: [],
      receipt,
      resultingState: undefined,
    });
    expect(noticesIn(document)).toHaveLength(1);
    expect(noticesIn(document)[0]).toMatchObject({ kind: "notice", severity: "error" });
    const nodes = flattenPresentationNodes(document);
    // Failed identity and empty pending scope precede any Applied operations.
    expect(document.slice(0, 4).map(shape)).toEqual(["notice:error", "prose", "prose", "heading"]);
    expect(nodeText(document[1]!)).toContain("/project-a");
    expect(nodeText(document[2]!)).not.toContain("/project-a");
    expect(document[3]).toMatchObject({ kind: "heading", text: "Applied:" });
  });

  test("verification failure carries the task message as an error notice and receipt evidence", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const document = applyVerificationFailureDocument(receipt, "Verification failed.");
    expect(noticesIn(document)).toEqual([
      { kind: "notice", severity: "error", nodes: [{ kind: "prose", parts: ["Verification failed."] }] },
    ]);
    expect(headingsIn(document)).toContain("Applied:");
  });
});

describe("grouped semantic warnings across Projects (#354, DEC-011)", () => {
  test("concise lifecycle output groups identical warnings and reports affected-Project count", () => {
    const report: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [{
            copyableValues: [".claude/skills", ".agents/skills"],
            kind: "diagnostic",
            parts: ["OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names"],
          }],
        }),
        machineProject("/project-b", {
          warnings: [{
            copyableValues: [".claude/skills", ".agents/skills"],
            kind: "diagnostic",
            parts: ["OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names"],
          }],
        }),
        machineProject("/project-c", {
          warnings: [{
            copyableValues: [".claude/skills", ".agents/skills"],
            kind: "diagnostic",
            parts: ["OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names"],
          }],
        }),
      ],
    };

    const concise = lifecycleStatusDocument(report);
    const warningItems = listItemsIn(concise).filter((text) =>
      text.startsWith("OpenCode discovers Skills from both .claude/skills and .agents/skills"));
    // One grouped warning item carries the affected-Project count.
    expect(warningItems).toHaveLength(1);
    expect(headingsIn(concise)).not.toContain("Warnings:");
  });

  test("concise lifecycle output reports (1 Project) for a single affected project", () => {
    const report: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [{
            copyableValues: ["/tmp/config.toml"],
            kind: "diagnostic",
            parts: ["Codex SessionStart hooks are not enabled"],
          }],
        }),
      ],
    };

    const concise = lifecycleStatusDocument(report);
    expect(headingsIn(concise)).not.toContain("Warnings:");
    expect(listItemsIn(concise)).toEqual([expect.stringContaining("Codex SessionStart hooks are not enabled")]);
  });

  test("verbose lifecycle output renders each semantic warning once and lists every affected project", () => {
    const report: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [{
            copyableValues: [".claude/skills", ".agents/skills"],
            kind: "diagnostic",
            parts: ["OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names"],
          }],
        }),
        machineProject("/project-b", {
          warnings: [{
            copyableValues: [".claude/skills", ".agents/skills"],
            kind: "diagnostic",
            parts: ["OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names"],
          }],
        }),
      ],
    };

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const warningItems = listItemsIn(verbose).filter((text) =>
      text.startsWith("OpenCode discovers Skills from both .claude/skills and .agents/skills"));
    // One grouped item lists every affected project.
    expect(warningItems).toEqual([
      "OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names (/project-a, /project-b)",
    ]);
  });

  test("distinct warning kinds, messages, consequences, or copyable values do not collapse", () => {
    const report: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [{
            copyableValues: ["/val-1"],
            kind: "diagnostic",
            parts: ["Same message"],
          }],
        }),
        machineProject("/project-b", {
          warnings: [{
            copyableValues: ["/val-2"],
            kind: "diagnostic",
            parts: ["Same message"],
          }],
        }),
        machineProject("/project-c", {
          warnings: [{
            consequence: "Consequence X",
            copyableValues: ["/val-1"],
            kind: "diagnostic",
            parts: ["Same message"],
          }],
        }),
        machineProject("/project-d", {
          warnings: [{
            copyableValues: ["/val-1"],
            kind: "host-attention",
            parts: ["Same message"],
          }],
        }),
      ],
    };

    const concise = lifecycleStatusDocument(report);
    // All 4 distinct warnings stay separate list items with their counts.
    expect(listItemsIn(concise).filter((text) => text.startsWith("Same message"))).toHaveLength(4);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const verboseItems = listItemsIn(verbose).filter((text) => text.startsWith("Same message"));
    expect(verboseItems).toHaveLength(4);
    for (const project of ["/project-a", "/project-b", "/project-c", "/project-d"]) {
      expect(verboseItems.some((text) => text.includes(`(${project})`))).toBe(true);
    }
  });

  test("machine JSON retains normalized warning under each Project without embedded Project prefix in message", () => {
    const report: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [{
            copyableValues: [".claude/skills", ".agents/skills"],
            kind: "diagnostic",
            parts: ["OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names"],
          }],
        }),
        machineProject("/project-b", {
          warnings: [{
            copyableValues: [".claude/skills", ".agents/skills"],
            kind: "diagnostic",
            parts: ["OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names"],
          }],
        }),
      ],
    };

    const json = JSON.parse(formatLifecycleJson("status", report)) as {
      projects: {
        canonicalProject: string;
        warnings: { copyableValues: string[]; kind: string; message: string }[];
      }[];
    };

    expect(json.projects).toHaveLength(2);
    expect(json.projects[0]?.warnings).toEqual([{
      copyableValues: [".claude/skills", ".agents/skills"],
      kind: "diagnostic",
      message: "OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names",
    }]);
    expect(json.projects[1]?.warnings).toEqual([{
      copyableValues: [".claude/skills", ".agents/skills"],
      kind: "diagnostic",
      message: "OpenCode discovers Skills from both .claude/skills and .agents/skills and will report duplicate Skill names",
    }]);
  });

  test("semantically distinct same-message groups supplied in non-output order sort deterministically (INT-1)", () => {
    // Supplied in reverse order of canonical sort
    const report: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-4", {
          warnings: [{
            consequence: "Consequence Z",
            copyableValues: ["/val-z"],
            kind: "host-attention",
            parts: ["Shared warning message"],
          }],
        }),
        machineProject("/project-3", {
          warnings: [{
            consequence: "Consequence B",
            copyableValues: ["/val-b"],
            kind: "diagnostic",
            parts: ["Shared warning message"],
          }],
        }),
        machineProject("/project-2", {
          warnings: [{
            consequence: "Consequence A",
            copyableValues: ["/val-b", "/val-c"],
            kind: "diagnostic",
            parts: ["Shared warning message"],
          }],
        }),
        machineProject("/project-1", {
          warnings: [{
            consequence: "Consequence A",
            copyableValues: ["/val-a"],
            kind: "diagnostic",
            parts: ["Shared warning message"],
          }],
        }),
      ],
    };

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    // The Warnings list items sort by canonical Project identity.
    expect(listItemsIn(verbose).filter((text) => text.startsWith("Shared warning message"))).toEqual([
      "Shared warning message (/project-1)",
      "Shared warning message (/project-2)",
      "Shared warning message (/project-3)",
      "Shared warning message (/project-4)",
    ]);
  });

  test("multi-report apply deduplicates same Project across receipt and resultingState without inflating count", () => {
    const w1 = {
      copyableValues: [".claude/skills"],
      kind: "diagnostic" as const,
      parts: ["Skill discovery collision warning"],
    };
    const w2 = {
      copyableValues: ["/tmp/config.toml"],
      kind: "diagnostic" as const,
      parts: ["Codex SessionStart hooks warning"],
    };

    const receiptReport: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [w1],
        }),
        machineProject("/project-c", {
          warnings: [w2],
        }),
      ],
    };

    const resultingStateReport: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [w1],
        }),
        machineProject("/project-b", {
          warnings: [w1],
        }),
      ],
    };

    const applyRes: ApplyReconciliationResult = {
      receipt: receiptReport,
      resultingState: resultingStateReport,
    };

    const concise = applyReportDocument(applyRes);
    const conciseWarnings = listItemsIn(concise).filter((text) =>
      text.startsWith("Skill discovery collision warning") || text.startsWith("Codex SessionStart hooks warning"));
    // w1 affects 2 projects (/project-a, /project-b) because /project-a is unioned once.
    expect(conciseWarnings).toContainEqual(expect.stringContaining("Skill discovery collision warning (2 Projects)"));
    // w2 affects 1 project (/project-c) which was only in receipt.
    expect(conciseWarnings).toContainEqual(expect.stringContaining("Codex SessionStart hooks warning (1 Project)"));
    expect(headingsIn(concise)).not.toContain("Warnings:");

    const verbose = applyReportDocument(applyRes, { verbose: true });
    const verboseWarnings = listItemsIn(verbose).filter((text) =>
      text.startsWith("Skill discovery collision warning") || text.startsWith("Codex SessionStart hooks warning"));
    expect(verboseWarnings).toContainEqual("Skill discovery collision warning (/project-a, /project-b)");
    expect(verboseWarnings).toContainEqual("Codex SessionStart hooks warning (/project-c)");
    expect(headingsIn(verbose)).not.toContain("Warnings:");
  });

  test("warnings are placed inline directly beside outcome notices across all lifecycle views and failure views", () => {
    const warning = {
      copyableValues: ["/path/to/diagnostic"],
      kind: "diagnostic" as const,
      parts: ["Sample diagnostic warning"],
    };

    const statusReport: ReconciliationReport = {
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [warning],
        }),
      ],
    };

    // 1. Status document (concise)
    const statusConcise = lifecycleStatusDocument(statusReport);
    expect(statusConcise[0]?.kind).toBe("notice");
    expect(statusConcise[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(statusConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(statusConcise)).not.toContain("Warnings:");

    // 2. Status document (verbose)
    const statusVerbose = lifecycleStatusDocument(statusReport, { verbose: true });
    expect(statusVerbose[0]?.kind).toBe("notice");
    expect(statusVerbose[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(statusVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(statusVerbose)).not.toContain("Warnings:");

    // 3. Apply document (concise)
    const applyConcise = applyReportDocument(applyResult(statusReport));
    expect(applyConcise[0]?.kind).toBe("notice");
    expect(applyConcise[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(applyConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(applyConcise)).not.toContain("Warnings:");

    // 4. Apply document (verbose)
    const applyVerbose = applyReportDocument(applyResult(statusReport), { verbose: true });
    expect(applyVerbose[0]?.kind).toBe("notice");
    expect(applyVerbose[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(applyVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(applyVerbose)).not.toContain("Warnings:");

    // 5. Blocked apply document (concise & verbose)
    const blockedReport: ReconciliationReport = {
      globalBlockers: [normalizeBlocker({
        affectedItems: [{ kind: "path", value: "/home/.agents/agent-profile-kit/state/manifest.json" }],
        detail: "Global failure",
        kind: "installation-state-unreadable",
        scope: "global",
      })],
      projects: [
        machineProject("/project-a", {
          warnings: [warning],
        }),
      ],
    };
    const blockedConcise = blockedApplyReportDocument(blockedReport);
    expect(blockedConcise[0]?.kind).toBe("notice");
    expect(blockedConcise[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(blockedConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(blockedConcise)).not.toContain("Warnings:");

    const blockedVerbose = blockedApplyReportDocument(blockedReport, { verbose: true });
    expect(blockedVerbose[0]?.kind).toBe("notice");
    expect(blockedVerbose[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(blockedVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(blockedVerbose)).not.toContain("Warnings:");

    // 6. Apply Execution Failure (concise & verbose)
    const execFailure = {
      detail: "disk full",
      failedProject: executionProject("/project-a"),
      message: "Apply execution failed",
      pendingProjects: [],
      receipt: statusReport,
      resultingState: statusReport,
    };
    const execConcise = applyExecutionFailureDocument(execFailure, {});
    expect(execConcise[0]?.kind).toBe("notice");
    expect(execConcise[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(execConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(execConcise)).not.toContain("Warnings:");

    const execVerbose = applyExecutionFailureDocument(execFailure, { verbose: true });
    expect(execVerbose[0]?.kind).toBe("notice");
    expect(execVerbose[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(execVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(execVerbose)).not.toContain("Warnings:");

    // 7. Apply Verification Failure (concise & verbose)
    const verifyConcise = applyVerificationFailureDocument(statusReport, "Verification check failed", {});
    expect(verifyConcise[0]?.kind).toBe("notice");
    expect(verifyConcise[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(verifyConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(verifyConcise)).not.toContain("Warnings:");

    const verifyVerbose = applyVerificationFailureDocument(statusReport, "Verification check failed", { verbose: true });
    expect(verifyVerbose[0]?.kind).toBe("notice");
    expect(verifyVerbose[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(verifyVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(verifyVerbose)).not.toContain("Warnings:");

    // 8. Uninstall result document (with Projects and kept Projects)
    const uninstallDoc = uninstallResultDocument({
      kept: [{ project: "/project-b", reason: "permission denied" }],
      projects: [{ outputs: [".codex/hooks.json"], project: "/project-a", repositoryExclusions: [] }],
      warnings: ["Sample uninstall warning"],
    });
    expect(uninstallDoc[0]?.kind).toBe("notice");
    expect(uninstallDoc[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(uninstallDoc)).toContain("Sample uninstall warning");
    expect(headingsIn(uninstallDoc)).not.toContain("Warnings:");

    // 9. Validation result document
    const validationDoc = validationResultDocument({
      bindings: 1,
      hosts: ["codex"],
      profiles: ["engineering"],
      warnings: ["Sample validation warning"],
    });
    expect(validationDoc[0]?.kind).toBe("notice");
    expect(validationDoc[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(validationDoc)).toContain("Sample validation warning");
    expect(headingsIn(validationDoc)).not.toContain("Warnings:");

    // 10. Temporary installation document (install-temp and remove-temp)
    const tempReceipt: TemporaryInstallationReceiptView = {
      completionState: "installed",
      diagnosticValues: [],
      host: "codex",
      outputs: [".codex/hooks.json"],
      profileId: "engineering",
      project: "/project-a",
      setupSteps: [],
      temporaryInstallationId: "temp-987",
      warnings: ["Sample temporary warning"],
    };
    const tempInstallDoc = temporaryInstallationDocument("install-temp", tempReceipt);
    expect(tempInstallDoc[0]?.kind).toBe("notice");
    expect(tempInstallDoc[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(tempInstallDoc)).toContain("Sample temporary warning");
    expect(headingsIn(tempInstallDoc)).not.toContain("Warnings:");

    const tempRemoveDoc = temporaryInstallationDocument("remove-temp", tempReceipt);
    expect(tempRemoveDoc[0]?.kind).toBe("notice");
    expect(tempRemoveDoc[1]).toMatchObject({ kind: "list-item", category: "attention" });
    expect(renderBoundary(tempRemoveDoc)).toContain("Sample temporary warning");
    expect(headingsIn(tempRemoveDoc)).not.toContain("Warnings:");
  });

  test("--blockers-only strictly suppresses warning text and attention items across all views", () => {
    const warning = {
      copyableValues: ["/path/to/diagnostic"],
      kind: "diagnostic" as const,
      parts: ["Strictly suppressed warning text"],
    };

    const blockedReport: ReconciliationReport = {
      globalBlockers: [normalizeBlocker({
        affectedItems: [{ kind: "path", value: "/home/.agents/agent-profile-kit/state/manifest.json" }],
        detail: "Global failure",
        kind: "installation-state-unreadable",
        scope: "global",
      })],
      projects: [
        machineProject("/project-a", {
          warnings: [warning],
        }),
      ],
    };

    // 1. Blocked status (--blockers-only concise & verbose)
    const statusBlockersConcise = lifecycleStatusDocument(blockedReport, { blockersOnly: true });
    expect(renderBoundary(statusBlockersConcise)).not.toContain("Strictly suppressed warning text");
    expect(statusBlockersConcise.filter((n) => n.kind === "list-item" && n.category === "attention")).toHaveLength(0);

    const statusBlockersVerbose = lifecycleStatusDocument(blockedReport, { blockersOnly: true, verbose: true });
    expect(renderBoundary(statusBlockersVerbose)).not.toContain("Strictly suppressed warning text");
    expect(statusBlockersVerbose.filter((n) => n.kind === "list-item" && n.category === "attention")).toHaveLength(0);

    // 2. Blocked apply (--blockers-only concise & verbose)
    const applyBlockersConcise = blockedApplyReportDocument(blockedReport, { blockersOnly: true });
    expect(renderBoundary(applyBlockersConcise)).not.toContain("Strictly suppressed warning text");
    expect(applyBlockersConcise.filter((n) => n.kind === "list-item" && n.category === "attention")).toHaveLength(0);

    const applyBlockersVerbose = blockedApplyReportDocument(blockedReport, { blockersOnly: true, verbose: true });
    expect(renderBoundary(applyBlockersVerbose)).not.toContain("Strictly suppressed warning text");
    expect(applyBlockersVerbose.filter((n) => n.kind === "list-item" && n.category === "attention")).toHaveLength(0);

    // 3. Execution failure with blockers
    const execFailure = {
      detail: "disk full",
      failedProject: executionProject("/project-a"),
      message: "Apply execution failed",
      pendingProjects: [],
      receipt: blockedReport,
      resultingState: blockedReport,
    };
    const execBlockersConcise = applyExecutionFailureDocument(execFailure, { blockersOnly: true });
    expect(renderBoundary(execBlockersConcise)).not.toContain("Strictly suppressed warning text");
    expect(execBlockersConcise.filter((n) => n.kind === "list-item" && n.category === "attention")).toHaveLength(0);

    const execBlockersVerbose = applyExecutionFailureDocument(execFailure, { blockersOnly: true, verbose: true });
    expect(renderBoundary(execBlockersVerbose)).not.toContain("Strictly suppressed warning text");
    expect(execBlockersVerbose.filter((n) => n.kind === "list-item" && n.category === "attention")).toHaveLength(0);

    // 4. Verification failure with blockers
    const verifyBlockersConcise = applyVerificationFailureDocument(blockedReport, "Verification failed", { blockersOnly: true });
    expect(renderBoundary(verifyBlockersConcise)).not.toContain("Strictly suppressed warning text");
    expect(verifyBlockersConcise.filter((n) => n.kind === "list-item" && n.category === "attention")).toHaveLength(0);

    const verifyBlockersVerbose = applyVerificationFailureDocument(blockedReport, "Verification failed", { blockersOnly: true, verbose: true });
    expect(renderBoundary(verifyBlockersVerbose)).not.toContain("Strictly suppressed warning text");
    expect(verifyBlockersVerbose.filter((n) => n.kind === "list-item" && n.category === "attention")).toHaveLength(0);
  });
});

describe("every Blocker renders plain wording and an evidence-derived runnable remedy (#440)", () => {
  const project = "/project-a";
  const statePath = "/home/.agents/agent-profile-kit/state/manifest.json";

  /** Flat text of every command part carried by inline content. */
  const commands = (parts: readonly InlineContent[]): string[] =>
    parts.flatMap((part) => (typeof part === "string" ? [] : [flatInlineText([part])]));

  const wording = (blocker: ReconciliationBlocker) => humanBlockerWording(blocker);
  const flat = (blocker: ReconciliationBlocker) => ({
    message: flatInlineText(wording(blocker).message),
    problem: flatInlineText(wording(blocker).problem),
    remedy: flatInlineText(wording(blocker).remedy),
    requirement: flatInlineText(wording(blocker).requirement),
  });

  /** One exhaustive fixture per typed variant across all six kinds. */
  const fixtures: readonly {
    readonly label: string;
    readonly blocker: ReconciliationBlocker;
    /** Every command invocation the evidence-derived remedy must carry. */
    readonly expectedCommands: readonly string[];
    readonly bannedCommands?: readonly string[];
    /** Honest-consequence phrases the remedy must state. */
    readonly mustState?: readonly string[];
    /** Honest phrases the problem sentence must state. */
    readonly problemMustState?: readonly string[];
  }[] = [
    // 1. installation-state-unreadable — externally damaged record: manual
    // recovery stated, inspect/editor commands, status verifies only.
    {
      label: "state-unreadable/legacy-yaml",
      blocker: normalizeBlocker(installationStateUnreadableBlocker({
        stateFailure: { case: "legacy-yaml-state-expired", retiredPath: "/home/state/manifest.yaml" },
        statePath,
      })),
      expectedCommands: [
        "ls -ld '/home/state/manifest.yaml'",
        "vi '/home/state/manifest.yaml'",
        "apkit status",
      ],
      mustState: ["Manual recovery is required", "0.95.0"],
    },
    {
      label: "state-unreadable/oversize",
      blocker: normalizeBlocker(installationStateUnreadableBlocker({
        stateFailure: { case: "oversize-state", limitBytes: 8388608 },
        statePath,
      })),
      expectedCommands: [
        "ls -lh '/home/.agents/agent-profile-kit/state/manifest.json'",
        "vi '/home/.agents/agent-profile-kit/state/manifest.json'",
        "apkit status",
      ],
      mustState: ["Manual recovery is required", "8388608"],
    },
    {
      label: "state-unreadable/no-outputs",
      blocker: normalizeBlocker(installationStateUnreadableBlocker({
        stateFailure: { case: "receipt-records-no-outputs", project: "/project-a" },
        statePath,
      })),
      expectedCommands: [
        "ls -lh '/home/.agents/agent-profile-kit/state/manifest.json'",
        "vi '/home/.agents/agent-profile-kit/state/manifest.json'",
        "apkit status",
      ],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "state-unreadable/foreign-detail",
      blocker: normalizeBlocker(installationStateUnreadableBlocker({
        detail: "EACCES: permission denied",
        statePath,
      })),
      expectedCommands: [
        "ls -ld '/home/.agents/agent-profile-kit/state/manifest.json'",
        "vi '/home/.agents/agent-profile-kit/state/manifest.json'",
        "apkit status",
      ],
      mustState: ["Manual recovery is required"],
    },
    // 2. occupied-output — the occupying material is the user's decision.
    {
      label: "occupied-output/drifted",
      blocker: normalizeBlocker(occupiedOutputBlocker({
        occupied: { case: "drifted-output" },
        path: ".codex/hooks.json",
        project,
      })),
      expectedCommands: [
        "ls -la '/project-a/.codex/hooks.json'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "occupied-output/occupied-directory",
      blocker: normalizeBlocker(occupiedOutputBlocker({
        occupied: { case: "occupied-destination", occupation: "directory" },
        path: ".agents/skills/demo-skill",
        project,
      })),
      expectedCommands: [
        "ls -la '/project-a/.agents/skills/demo-skill'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "occupied-output/occupied-parent",
      blocker: normalizeBlocker(occupiedOutputBlocker({
        occupied: { case: "occupied-parent", occupation: "symlink" },
        path: ".codex/nested/hooks.json",
        project,
      })),
      expectedCommands: [
        "ls -ld '/project-a/.codex/nested'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "occupied-output/unowned-artifact-directory",
      blocker: normalizeBlocker(occupiedOutputBlocker({
        occupied: { case: "unowned-artifact-directory" },
        path: ".agents/skills/demo-skill",
        project,
      })),
      expectedCommands: [
        "ls -la '/project-a/.agents/skills/demo-skill'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "occupied-output/opencode-config",
      blocker: normalizeBlocker(occupiedOutputBlocker({
        occupied: { case: "occupied-destination", occupation: "file" },
        path: ".opencode/opencode.json",
        project,
        remedyKey: "opencode-config-occupied",
      })),
      expectedCommands: [
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["opencode.json"],
    },
    // 3. installation-ownership, verify action — one remedy per failure case.
    {
      label: "ownership/verify/git-tracked",
      blocker: normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: { case: "git-tracked-output", outputs: [".codex/hooks.json", ".agents/skills/s01"] },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "git --literal-pathspecs -C '/project-a' rm -r --cached -- " +
          "'.agents/skills/s01' '.codex/hooks.json'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Git index", "files stay on disk"],
    },
    {
      label: "ownership/verify/continuity",
      blocker: normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: { case: "no-ownership-continuity", output: ".agent-profile-kit/codex/context.md" },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "ls -ld '/project-a/.agent-profile-kit/codex/context.md'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "ownership/verify/type-mismatch",
      blocker: normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: { case: "type-mismatch", expected: "directory", output: ".codex/hooks.json" },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "ls -ld '/project-a/.codex/hooks.json'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "ownership/verify/unsafe-parent",
      blocker: normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: { case: "unsafe-parent", output: ".codex/hooks.json", parent: "/p/.codex" },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "ls -ld '/p/.codex'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Manual recovery is required"],
      problemMustState: ["not a regular directory"],
    },
    {
      label: "ownership/verify/unreadable",
      blocker: normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: { case: "unreadable-output", output: ".codex/hooks.json" },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "ls -ld '/project-a/.codex/hooks.json'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "ownership/verify/unsupported-entry",
      blocker: normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: {
          case: "unsupported-entry",
          member: "scripts/run.sh",
          output: ".agents/skills/demo-skill",
        },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "ls -ld '/project-a/.agents/skills/demo-skill/scripts/run.sh'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      // No rm from observed type alone: the user inspects and recovers by hand.
      bannedCommands: ["rm '"],
      mustState: ["Manual recovery is required"],
    },
    {
      label: "ownership/verify/unproven",
      blocker: normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: { case: "unproven" },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "apkit unbind '/project-a'",
        "apkit apply '/project-a'",
      ],
      mustState: ["nothing is repaired or removed"],
    },
    // 3b. installation-ownership, remove action — teardown: explicit --all.
    {
      label: "ownership/remove/git-tracked",
      blocker: normalizeBlocker({
        action: "remove",
        affectedItems: [],
        failure: { case: "git-tracked-output", outputs: [".codex/hooks.json"] },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "git --literal-pathspecs -C '/project-a' rm -r --cached -- '.codex/hooks.json'",
        "apkit apply --all",
      ],
      bannedCommands: ["apkit apply '/project-a'", "apkit uninstall"],
      mustState: ["every pending Project"],
    },
    {
      label: "ownership/remove/continuity",
      blocker: normalizeBlocker({
        action: "remove",
        affectedItems: [],
        failure: { case: "no-ownership-continuity", output: ".agent-profile-kit/codex/context.md" },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: [
        "ls -ld '/project-a/.agent-profile-kit/codex/context.md'",
        "apkit apply --all",
      ],
      bannedCommands: ["apkit apply '/project-a'", "apkit uninstall"],
      mustState: ["Manual recovery is required", "every pending Project"],
    },
    {
      label: "ownership/remove/unproven",
      blocker: normalizeBlocker({
        action: "remove",
        affectedItems: [],
        failure: { case: "unproven" },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      expectedCommands: ["apkit apply --all"],
      bannedCommands: ["apkit apply '/project-a'", "apkit uninstall"],
      mustState: ["Manual recovery is required", "every pending Project"],
    },
    // 4. output-ownership-conflict — the stated Git-vs-binding choice.
    {
      label: "output-ownership-conflict/single",
      blocker: normalizeBlocker(outputOwnershipConflictBlocker({
        paths: [".codex/hooks.json"],
        project,
      })),
      expectedCommands: [
        "git --literal-pathspecs -C '/project-a' rm -r --cached -- '.codex/hooks.json'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
      mustState: ["Git index", "files stay on disk"],
    },
    {
      label: "output-ownership-conflict/multi",
      blocker: normalizeBlocker(outputOwnershipConflictBlocker({
        paths: [".codex/hooks.json", ".agents/skills/s01.md"],
        project,
      })),
      expectedCommands: [
        "git --literal-pathspecs -C '/project-a' rm -r --cached -- " +
          "'.agents/skills/s01.md' '.codex/hooks.json'",
        "apkit apply '/project-a'",
        "apkit unbind '/project-a'",
      ],
    },
    // Literal pathspecs: glob-significant filenames stay verbatim, quoted.
    {
      label: "output-ownership-conflict/literal-pathspecs",
      blocker: normalizeBlocker(outputOwnershipConflictBlocker({
        paths: ["we*rd[n].md", "a?b.md"],
        project,
      })),
      expectedCommands: [
        "git --literal-pathspecs -C '/project-a' rm -r --cached -- " +
          "'a?b.md' 'we*rd[n].md'",
      ],
    },
    // 5. temporary-installation-conflict.
    {
      label: "temp-conflict/with-id",
      blocker: normalizeBlocker(temporaryInstallationConflictBlocker({
        project,
        temporaryInstallationId: "temp-123",
      })),
      expectedCommands: ["apkit machine remove-temp 'temp-123'"],
      bannedCommands: ["install-temp"],
      mustState: ["retry your original command"],
    },
    {
      label: "temp-conflict/ordinary",
      blocker: normalizeBlocker(temporaryInstallationConflictBlocker({ project })),
      expectedCommands: ["apkit unbind '/project-a'"],
      bannedCommands: ["install-temp"],
      mustState: ["stay on disk", "retry your original command"],
    },
    // 6. temporary-installation-removal — identity is required evidence.
    {
      label: "temp-removal/git-tracked",
      blocker: normalizeBlocker(temporaryInstallationRemovalBlocker({
        failure: { case: "git-tracked-output", outputs: [".codex/hooks.json"] },
        outputs: [".codex/hooks.json"],
        project,
        temporaryInstallationId: "temp-123",
      })),
      expectedCommands: [
        "git --literal-pathspecs -C '/project-a' rm -r --cached -- '.codex/hooks.json'",
        "apkit machine remove-temp 'temp-123'",
      ],
      mustState: ["Git index", "deletes the generated files from disk"],
    },
    {
      label: "temp-removal/symlink",
      blocker: normalizeBlocker(temporaryInstallationRemovalBlocker({
        failure: { case: "symlink-output", output: ".codex/hooks.json" },
        outputs: [".codex/hooks.json"],
        project,
        temporaryInstallationId: "temp-123",
      })),
      expectedCommands: [
        "ls -ld '/project-a/.codex/hooks.json'",
        "apkit machine remove-temp 'temp-123'",
      ],
      bannedCommands: ["rm '"],
      mustState: ["Manual recovery is required", "will not follow"],
    },
    {
      label: "temp-removal/unsafe-parent",
      blocker: normalizeBlocker(temporaryInstallationRemovalBlocker({
        failure: { case: "unsafe-parent", output: ".codex/hooks.json", parent: "/p/.codex" },
        outputs: [".codex/hooks.json"],
        project,
        temporaryInstallationId: "temp-123",
      })),
      expectedCommands: [
        "ls -ld '/p/.codex'",
        "apkit machine remove-temp 'temp-123'",
      ],
      mustState: ["Manual recovery is required", "will not traverse outside the Project"],
    },
  ];

  test.each(fixtures.map((fixture) => [fixture.label, fixture] as const))(
    "%s renders plain wording with exactly its evidence-derived commands",
    (_label, fixture) => {
      const { problem, requirement, remedy } = flat(fixture.blocker);
      // Plain human wording: no prohibited internal-only terms anywhere.
      for (const sentence of [problem, requirement, remedy]) {
        for (const term of INTERNAL_ONLY_DEFAULT_TERMS) {
          expect(sentence).not.toMatch(term);
        }
      }
      // Every expected command is carried as an atomic command part.
      const carried = commands(wording(fixture.blocker).remedy);
      for (const expected of fixture.expectedCommands) {
        expect(carried).toContain(expected);
      }
      for (const banned of fixture.bannedCommands ?? []) {
        expect(carried.join("\n")).not.toContain(banned);
        expect(remedy).not.toContain(banned);
      }
      for (const phrase of fixture.mustState ?? []) {
        expect(remedy).toContain(phrase);
      }
      for (const phrase of fixture.problemMustState ?? []) {
        expect(problem).toContain(phrase);
      }
      // The remedy never claims the verify command repairs anything.
      if (fixture.expectedCommands.includes("apkit status")) {
        expect(remedy).toContain("to verify");
        expect(remedy).toContain("Manual recovery is required");
      }
    },
  );

  test("every fixture remedy carries at least one runnable command", () => {
    for (const fixture of fixtures) {
      expect(
        commands(wording(fixture.blocker).remedy).length,
        `${fixture.label} carries no runnable command`,
      ).toBeGreaterThan(0);
    }
  });

  test("hostile filenames fail closed without hiding the Blocker (#440)", () => {
    const blocker = normalizeBlocker(outputOwnershipConflictBlocker({
      paths: ["broken\nname.md"],
      project,
    }));
    const { problem, remedy } = flat(blocker);
    // No safe command could be derived; the original blocker still renders and
    // the remedy states the manual fallback.
    expect(problem).toContain("broken\nname.md");
    expect(remedy).not.toContain("rm -r --cached");
    expect(remedy).toContain("Manual recovery is required");
    expect(commands(wording(blocker).remedy)).toContain("apkit apply '/project-a'");
    expect(commands(wording(blocker).remedy)).toContain("apkit unbind '/project-a'");
  });

  test("quoted filenames survive POSIX quoting inside the derived command (#440)", () => {
    const blocker = normalizeBlocker(outputOwnershipConflictBlocker({
      paths: ["weird'name.md", "a b.md", "-leading-dash.md"],
      project,
    }));
    const carried = commands(wording(blocker).remedy);
    const git = carried.find((command) => command.includes("rm -r --cached"))!;
    expect(git).toBe(
      "git --literal-pathspecs -C '/project-a' rm -r --cached -- " +
        "'-leading-dash.md' 'a b.md' 'weird'\\''name.md'",
    );
  });

  const focusedReport = (blocker: ReconciliationBlocker): ReconciliationReport => {
    const scoped = blocker.scope === "project";
    const affected = scoped ? blocker.project! : project;
    return emptyReport({
      blockers: [blocker],
      desired: [{
        canonicalProject: affected,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: affected,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: affected }],
      outputs: [{ kind: "addition", path: "a.md", project: affected }],
    });
  };

  test.each(fixtures.map((fixture) => [fixture.label, fixture] as const))(
    "%s carries the same evidence-derived commands in concise and verbose views",
    (_label, fixture) => {
      for (const options of [{ verbose: false }, { verbose: true }] as const) {
        const document = lifecycleStatusDocument(focusedReport(fixture.blocker), {
          blockersOnly: true,
          ...options,
        });
        const rendered = renderBoundary(document);
        for (const expected of fixture.expectedCommands) {
          expect(rendered).toContain(expected);
        }
        // The verbose pointer redirect is retired: the command is carried here.
        expect(rendered).not.toContain("to see the exact untracking command");
      }
    },
  );

  test.each(fixtures.map((fixture) => [fixture.label, fixture] as const))(
    "%s publishes the verbatim stored wording on the machine surface",
    (_label, fixture) => {
      const payload = JSON.parse(
        formatLifecycleJson("status", focusedReport(fixture.blocker)),
      ) as {
        readonly globalBlockers: readonly Record<string, string>[];
        readonly projects: readonly { readonly blockers: readonly Record<string, string>[] }[];
      };
      const published = [...payload.globalBlockers, ...payload.projects[0]!.blockers][0]!;
      const stored = blockerWording(fixture.blocker);
      expect(published.message).toBe(stored.message);
      expect(published.problem).toBe(stored.problem);
      expect(published.requirement).toBe(stored.requirement);
      expect(published.remedy).toBe(stored.remedy);
    },
  );

  test("occupied-output renders the adapter remedy key with its carried sentence", () => {
    const blocker = normalizeBlocker(occupiedOutputBlocker({
      occupied: { case: "occupied-destination", occupation: "directory" },
      path: ".opencode/opencode.json",
      project,
      remedyKey: "opencode-config-occupied",
    }));
    expect(blockerWording(blocker).remedy).toBe(opencodeConfigOccupiedRemedy(project));
  });
});

describe("authoring and teardown receipt documents (#390)", () => {
  const home = homedir();
  const projectPath = join(home, "projects", "demo");

  test("the created receipt presents a success headline, Profile explanation, detected Hosts, and the next command", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: join(home, ".agents", "agent-profile-kit", "workspace"),
      authoredPath: join(home, ".agents", "agent-profile-kit", "workspace"),
      workspaceScaffolded: true,
      detectedHosts: ["codex"],
    });
    // Selective shape: kinds, categories, order, and atomic values — the
    // carried wording is locked by the golden snapshots.
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "sentence",
      "sentence",
      "sentence(command)",
    ]);
    expect(document[0]).toMatchObject({ kind: "sentence", category: "success" });
    expect(document[1]).toMatchObject({
      kind: "sentence",
      parts: ["A Profile is a named selection of Context and Skills to adapt for your projects."],
    });
    expect(document[2]).toMatchObject({
      kind: "sentence",
      parts: ["Detected Agent Hosts: ", { kind: "identifier", value: "codex" }],
    });
    expect(document[3]).toMatchObject({
      kind: "sentence",
      category: "command",
      parts: [
        "Next: from the project you want to try, run ",
        {
          kind: "command",
          program: "apkit",
          args: [
            { kind: "text", value: "bind" },
            { kind: "text", value: "example" },
            { kind: "text", value: "--host" },
            { kind: "text", value: "codex" },
          ],
        },
      ],
    });

    // When multiple Hosts are detected, the first detected Host is selected for the suggested bind
    const multiHostDocument = initReceiptDocument({
      outcome: "created",
      path: join(home, ".agents", "agent-profile-kit", "workspace"),
      authoredPath: join(home, ".agents", "agent-profile-kit", "workspace"),
      workspaceScaffolded: true,
      detectedHosts: ["antigravity", "claude", "codex"],
    });
    expect(multiHostDocument[2]).toMatchObject({
      kind: "sentence",
      parts: [
        "Detected Agent Hosts: ",
        { kind: "identifier", value: "antigravity, claude, codex" },
      ],
    });
    expect(multiHostDocument[3]).toMatchObject({
      kind: "sentence",
      category: "command",
      parts: [
        "Next: from the project you want to try, run ",
        {
          kind: "command",
          program: "apkit",
          args: [
            { kind: "text", value: "bind" },
            { kind: "text", value: "example" },
            { kind: "text", value: "--host" },
            { kind: "text", value: "antigravity" },
          ],
        },
      ],
    });
  });

  test("the created receipt with no detected Hosts states so and suggests validate without inventing an absent Host", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: join(home, ".agents", "agent-profile-kit", "workspace"),
      authoredPath: join(home, ".agents", "agent-profile-kit", "workspace"),
      workspaceScaffolded: true,
      detectedHosts: [],
    });
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "sentence",
      "sentence",
      "sentence(command)",
    ]);
    expect(document[2]).toMatchObject({
      kind: "sentence",
      parts: ["Detected Agent Hosts: none"],
    });
    expect(document[3]).toMatchObject({
      kind: "sentence",
      category: "command",
      parts: [
        "Next: run ",
        {
          kind: "command",
          program: "apkit",
          args: [{ kind: "text", value: "validate" }],
        },
      ],
    });
  });

  test("the created receipt without scaffolding points at validate", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: join(home, ".agents", "agent-profile-kit", "workspace"),
      authoredPath: join(home, ".agents", "agent-profile-kit", "workspace"),
      workspaceScaffolded: false,
      detectedHosts: ["codex"],
    });
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "sentence",
      "sentence",
      "sentence(command)",
    ]);
    expect(document[3]).toMatchObject({
      kind: "sentence",
      category: "command",
      parts: [
        "Next: run ",
        {
          kind: "command",
          program: "apkit",
          args: [{ kind: "text", value: "validate" }],
        },
      ],
    });
  });

  test("the migrated and unchanged receipts carry their severities and values", () => {
    const migrated = initReceiptDocument({
      outcome: "migrated",
      path: `/test/workspace`,
      authoredPath: `/test/workspace`,
    });
    expect(shapes(migrated)).toEqual(["sentence(success)", "sentence(command)"]);
    const unchanged = initReceiptDocument({
      outcome: "unchanged",
      path: `/test/workspace`,
      authoredPath: `/test/workspace`,
    });
    expect(shapes(unchanged)).toEqual(["sentence"]);
  });

  test("the recorded bind receipt presents binding detail and the next command", () => {
    const document = bindReceiptDocument({
      outcome: "created",
      canonicalProject: projectPath,
      project: projectPath,
      profile: "coding",
      hosts: ["codex", "pi"],
    });
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "key-value:Profile(path)",
      "key-value:Hosts",
      "key-value:Next(command)",
    ]);
    expect(document[1]).toEqual({
      kind: "key-value",
      key: "  Profile",
      value: { kind: "identifier", value: "coding" },
      category: "path",
    });
    expect(document.at(-1)).toEqual({
      kind: "key-value",
      key: "Next",
      value: { kind: "command", program: "apkit", args: [{ kind: "text", value: "status" }] },
      category: "command",
    });
  });

  test("the replaced bind receipt keeps only the changed deltas", () => {
    const document = bindReceiptDocument({
      outcome: "replaced",
      canonicalProject: projectPath,
      project: projectPath,
      profile: "coding",
      hosts: ["codex"],
      previousProfile: "coding",
      previousHosts: ["codex", "pi"],
    });
    // The unchanged Profile delta is omitted; the changed Hosts delta remains.
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "key-value:Hosts",
      "key-value:Next(command)",
    ]);
    expect(document[1]).toEqual({
      kind: "key-value",
      key: "  Hosts",
      value: { kind: "identifier", value: "codex, pi → codex" },
    });
  });

  test("the unchanged bind and unbind receipts stay informational", () => {
    const unchangedBind = bindReceiptDocument({
      outcome: "unchanged",
      canonicalProject: projectPath,
      project: projectPath,
      profile: "coding",
      hosts: ["codex"],
    });
    expect(shapes(unchangedBind)).toEqual([
      "sentence",
      "key-value:Profile(path)",
      "key-value:Hosts",
      "key-value:Next(command)",
    ]);
    const unchangedUnbind = unbindReceiptDocument({
      outcome: "unchanged",
      requestedProject: "~/projects/absent",
    });
    expect(shapes(unchangedUnbind)).toEqual(["sentence"]);
  });

  test("bind receipt names the Project recognizably across created, unchanged, and replaced outcomes even inside the project", () => {
    const created = bindReceiptDocument({
      outcome: "created",
      canonicalProject: projectPath,
      project: ".",
      profile: "coding",
      hosts: ["codex"],
    });
    expect(created[0]).toEqual({
      kind: "sentence",
      parts: [
        "Recorded configured Project for ",
        {
          kind: "path",
          canonicalPath: projectPath,
          scope: "fleet",
          authoredPath: "~/projects/demo",
        },
      ],
      category: "success",
    });

    const unchanged = bindReceiptDocument({
      outcome: "unchanged",
      canonicalProject: projectPath,
      project: ".",
      profile: "coding",
      hosts: ["codex"],
    });
    expect(unchanged[0]).toEqual({
      kind: "sentence",
      parts: [
        "Configured Project unchanged for ",
        {
          kind: "path",
          canonicalPath: projectPath,
          scope: "fleet",
          authoredPath: "~/projects/demo",
        },
      ],
    });

    const replaced = bindReceiptDocument({
      outcome: "replaced",
      canonicalProject: projectPath,
      project: ".",
      profile: "ops",
      hosts: ["codex", "claude"],
      previousProfile: "coding",
      previousHosts: ["codex"],
    });
    expect(replaced[0]).toEqual({
      kind: "sentence",
      parts: [
        "Replaced configured Project for ",
        {
          kind: "path",
          canonicalPath: projectPath,
          scope: "fleet",
          authoredPath: "~/projects/demo",
        },
      ],
      category: "success",
    });
  });

  test("the removed unbind receipt keeps recovery evidence and survival guidance", () => {
    const document = unbindReceiptDocument({
      outcome: "removed",
      canonicalProject: projectPath,
      project: projectPath,
      profile: "coding",
      hosts: ["codex"],
      recovery: "canonical",
      generatedOutputSurvives: true,
    });
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "key-value:Profile(path)",
      "key-value:Hosts",
      "prose",
      "key-value:Next(command)",
    ]);
    expect(document.at(-1)).toEqual({
      kind: "key-value",
      key: "Next",
      value: { kind: "command", program: "apkit", args: [
        { kind: "text", value: "status" },
        { kind: "text", value: "--all" },
      ] },
      category: "command",
    });
  });

  test("the authored-path unbind receipt carries the recovery explanation and configuration location", () => {
    const document = unbindReceiptDocument({
      outcome: "removed",
      project: "/opt/authored/demo",
      profile: "coding",
      hosts: ["codex"],
      recovery: "authored-path",
      configurationPath: `/test/config.yaml`,
      generatedOutputSurvives: false,
    });
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "key-value:Recovery",
      "key-value:Local Configuration(path)",
      "key-value:Profile(path)",
      "key-value:Hosts",
    ]);
  });
});

/**
 * Render one node alone: for asserting an atomic inline value survives as one
 * whole line (the structural replacement for the copyable-value list).
 */
function renderedNodeLine(node: PresentationNode): string {
  return renderPresentationDocument([node], { color: false, interactive: false, width: 40 });
}

/** The carried inline text of a wrapping node, flattened from its parts. */
function inlineText(node: PresentationNode): string {
  const parts: readonly InlineContent[] =
    (node as { readonly parts?: readonly InlineContent[] }).parts ??
    [(node as { readonly text?: string }).text ?? ""];
  return parts.map((part) => {
    if (typeof part === "string") return part;
    switch (part.kind) {
      case "text": return part.value;
      case "command": return [part.program, ...part.args.map((arg) => arg.kind === "text" ? arg.value : "")].join(" ");
      case "path": return part.authoredPath ?? part.canonicalPath;
      case "identifier": return part.value;
    }
  }).join("");
}

describe("help documents (#390)", () => {
  test("root help presents the wordmark, intro, usage, quick start, groups, and guidance", () => {
    const document = rootHelpDocument([]);
    expect(shapes(document)).toEqual([
      "sentence",
      "spacer",
      "key-value:Usage(heading)",
      "spacer",
      "heading",
      "sentence(command)",
      "sentence(command)",
      "sentence(command)",
      "sentence(command)",
      "spacer",
      "sentence",
      "spacer",
      "heading",
      ...defaultCommands()
        .filter((command) => command.group === "common")
        .flatMap(() => ["sentence(command)", "sentence"]),
      "spacer",
      "heading",
      ...COMMAND_GROUPS
        .filter(([group]) => group !== "common")
        .flatMap(([group]) => {
          const listed = defaultCommands().filter((command) => command.group === group);
          if (listed.length === 0) return [];
          return ["heading", ...listed.flatMap(() => ["sentence(command)", "sentence"])];
        }),
      "spacer",
      "sentence(muted)",
    ]);
    // The usage line is one atomic command.
    expect(document[2]).toEqual({
      kind: "key-value",
      key: "Usage",
      value: {
        kind: "command",
        program: "apkit",
        args: [
          { kind: "text", value: "<command>" },
          { kind: "text", value: "[arguments]" },
        ],
      },
      category: "heading",
    });
    // Every listed command in root help is one atomic command with just
    // the command name, without command flag inventories (US-034, DEC-020).
    const commandLines = (document as PresentationNode[])
      .filter((node) => node.kind === "sentence" && node.category === "command")
      .map(renderedNodeLine);
    const catalogLines = commandLines.slice(4);
    expect(catalogLines).toHaveLength(defaultCommands().length);
    for (const command of defaultCommands()) {
      expect(catalogLines).toContain(`  ${command.name}`);
    }
    // Flag inventories and machine-facing commands are absent from root help (DEC-020, DEC-021).
    for (const line of catalogLines) {
      expect(line).not.toMatch(/\[--\w+/);
      expect(line).not.toMatch(/--host\b/);
      expect(line).not.toMatch(/--replace\b/);
    }
    for (const command of machineCommands()) {
      expect(catalogLines).not.toContain(`  ${command.syntax}`);
      if (defaultCommands().every((dc) => dc.name !== command.name)) {
        expect(catalogLines).not.toContain(`  ${command.name}`);
      }
    }
    expect(catalogLines).not.toContain("  machine");
  });

  test("root help renders the wordmark lines before the intro when interactive", () => {
    const document = rootHelpDocument(["  /\\  Agent Profile Kit", " /__\\ reusable agent material"]);
    expect(shapes(document).slice(0, 2)).toEqual(["verbatim", "verbatim"]);
    expect(document[0]).toEqual({ kind: "verbatim", text: "  /\\  Agent Profile Kit" });
    expect(document[1]).toEqual({ kind: "verbatim", text: " /__\\ reusable agent material" });
  });

  test("focused command help presents purpose, usage, examples, writes, and next", () => {
    const status = defaultCommands().find((command) => command.name === "status")!;
    const document = commandHelpDocument(status);
    expect(shapes(document)).toEqual([
      "sentence(heading)",
      "spacer",
      "key-value:Usage(heading)",
      "spacer",
      "heading",
      ...status.examples.map(() => "sentence(command)"),
      "spacer",
      "sentence(heading)",
      "spacer",
      "sentence(command)",
    ]);
    expect(document[2]).toEqual({
      kind: "key-value",
      key: "Usage",
      value: {
        kind: "command",
        program: "apkit",
        args: status.syntax.split(/\s+/).map((token) => ({ kind: "text", value: token })),
      },
      category: "heading",
    });
    // Every example and the usage line are atomic: one whole line each.
    const commandLines = (document as PresentationNode[])
      .filter((node) => node.kind === "sentence" && node.category === "command")
      .map(renderedNodeLine);
    for (const example of status.examples) {
      expect(commandLines).toContain(`  apkit ${example}`);
    }
  });

  test("focused command help lists supported Hosts when the command carries them", () => {
    const bind = defaultCommands().find((command) => command.name === "bind")!;
    const document = commandHelpDocument(bind);
    const sections = shapes(document);
    const examplesIndex = sections.indexOf("heading");
    // The Supported Hosts sentence sits after Examples and before Writes.
    const hostIndex = sections.indexOf("sentence(heading)", examplesIndex + 1);
    expect(sections.indexOf("sentence(heading)", hostIndex + 1)).toBeGreaterThan(hostIndex);
    expect(inlineText(document[hostIndex] as PresentationNode))
      .toContain(`Supported Hosts: ${bind.supportedHosts!.join(", ")}`);
  });

  test("machine help presents the namespace intro, usage, and machine commands", () => {
    const document = machineHelpDocument();
    expect(shapes(document)).toEqual([
      "sentence",
      "spacer",
      "key-value:Usage(heading)",
      "spacer",
      ...machineCommands().flatMap(() => ["sentence(command)", "sentence"]),
    ]);
    const machineSyntaxLines = (document as PresentationNode[])
      .filter((node) => node.kind === "sentence" && node.category === "command")
      .map(renderedNodeLine);
    for (const command of machineCommands()) {
      expect(machineSyntaxLines).toContain(`  ${command.syntax}`);
    }
  });
});

describe("guide documents (#390)", () => {
  test("the guide index presents the title, intro, topics, references, and examples", () => {
    const document = guideIndexDocument();
    expect(shapes(document)).toEqual([
      "heading",
      "spacer",
      "sentence",
      "spacer",
      "heading",
      "sentence(command)",
      "sentence",
      "sentence(command)",
      "sentence",
      "sentence(command)",
      "sentence",
      "spacer",
      "heading",
      "sentence(command)",
      "sentence",
      "sentence(command)",
      "sentence",
      "spacer",
      "heading",
      "sentence(command)",
      "sentence(command)",
      "sentence(command)",
    ]);
    // Every route and example line is one atomic command: one whole line each.
    const routeLines = (document as PresentationNode[])
      .filter((node) => node.kind === "sentence" && node.category === "command")
      .map(renderedNodeLine);
    expect(routeLines).toEqual([
      "  apkit guide profile",
      "  apkit guide context",
      "  apkit guide skill",
      "  apkit guide --full",
      "  apkit guide --agent",
      "  apkit init",
      "  apkit guide profile",
      "  apkit bind example --host codex",
    ]);
  });

  test("the focused guide keeps its fenced examples as verbatim content and identifies configured Workspace", () => {
    const document = focusedGuideDocument("profile", {
      configurationState: "current",
      workspace: { canonical: "/tmp/workspace", authored: "~/workspace" },
    });
    const example = AUTHORING_EXAMPLES.profile;
    const contextExample = AUTHORING_EXAMPLES.context;
    expect(shapes(document)).toEqual([
      "heading",
      "spacer",
      "sentence",
      "spacer",
      "sentence",
      "spacer",
      "verbatim",
      "spacer",
      "verbatim",
      "spacer",
      "sentence(heading)",
    ]);
    expect(document[4]).toEqual({
      kind: "sentence",
      parts: [
        "Workspace: ",
        {
          kind: "path",
          canonicalPath: "/tmp/workspace",
          authoredPath: "~/workspace",
          scope: "fleet",
        },
      ],
    });
    // Example bodies are true verbatim content: reproduced exactly.
    expect(document[6]).toEqual({
      kind: "verbatim",
      text: `Create \`${example.path}\`:\n\n\`\`\`yaml\n${example.contents}\`\`\``,
    });
    expect(document[8]).toEqual({
      kind: "verbatim",
      text: `Create \`${contextExample.path}\`:\n\n\`\`\`md\n${contextExample.contents}\`\`\``,
    });
    // The carried next action renders whole, as the literal block it came from.
    expect(renderedNodeLine(document.at(-1) as PresentationNode))
      .toBe(TOPIC_GUIDES.profile.next);
  });

  test("the focused context and skill guides include Workspace location preceding creation instructions", () => {
    for (const topic of ["context", "skill"] as const) {
      const document = focusedGuideDocument(topic, {
        configurationState: "current",
        workspace: { canonical: "/tmp/workspace", authored: "~/workspace" },
      });
      expect(shapes(document)).toEqual([
        "heading",
        "spacer",
        "sentence",
        "spacer",
        "sentence",
        "spacer",
        "verbatim",
        "spacer",
        "sentence(heading)",
      ]);
      expect(document[4]).toEqual({
        kind: "sentence",
        parts: [
          "Workspace: ",
          {
            kind: "path",
            canonicalPath: "/tmp/workspace",
            authoredPath: "~/workspace",
            scope: "fleet",
          },
        ],
      });
      const bodies = document.filter(
        (node): node is Extract<PresentationNode, { readonly kind: "verbatim" }> =>
          node.kind === "verbatim" && nodeText(node).length > 0,
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.text.includes(AUTHORING_EXAMPLES[topic].path)).toBe(true);
      expect(shapes(document).at(-1)).toBe("sentence(heading)");
    }
  });

  test("focused guide identifies unconfigured Workspace before initialization with actionable init guidance", () => {
    const document = focusedGuideDocument("profile", {
      configurationState: "not-configured",
      workspace: null,
    });
    expect(document[4]).toEqual({
      kind: "sentence",
      parts: [
        "Workspace: Not configured (run ",
        { kind: "command", program: "apkit", args: [{ kind: "text", value: "init" }] },
        ")",
      ],
    });
  });

  test("focused guide identifies legacy Workspace configuration with init guidance", () => {
    const unselected = focusedGuideDocument("profile", {
      configurationState: "legacy",
      workspace: null,
    });
    expect(unselected[4]).toEqual({
      kind: "sentence",
      parts: [
        "Workspace: Legacy configuration; run ",
        { kind: "command", program: "apkit", args: [{ kind: "text", value: "init" }] },
      ],
    });

    const selected = focusedGuideDocument("profile", {
      configurationState: "legacy",
      workspace: { canonical: "/tmp/legacy-ws", authored: "~/legacy-ws" },
    });
    expect(selected[4]).toEqual({
      kind: "sentence",
      parts: [
        "Workspace: Legacy configuration; run ",
        { kind: "command", program: "apkit", args: [{ kind: "text", value: "init" }] },
        " (selected: ~/legacy-ws)",
      ],
    });
  });

  test("a guide file body renders verbatim with one trailing newline restored by the writer", () => {
    const document = guideFileDocument("# Title\n\nBody line.\n");
    expect(shapes(document)).toEqual(["verbatim"]);
  });
});

describe("primary-cause fleet partition (spec #373, DEC-041, issue #435)", () => {
  const createRecord = (overrides: Partial<ReconciliationProjectRecord> = {}): ReconciliationProjectRecord => ({
    blockers: [],
    canonicalProject: "/project-a",
    desired: {
      context: "composed",
      hosts: ["codex"],
      outputs: [],
      profile: "coding",
      resolvedArtifacts: [],
    },
    outputs: [],
    project: "/project-a",
    repositoryExclusions: [],
    setupSteps: [],
    state: { kind: "current" },
    warnings: [],
    ...overrides,
  });

  describe("classifyPrimaryCause and priority order", () => {
    test("classifies needs-attention for blockers, malformed ownership, blocked, and removal", () => {
      expect(classifyPrimaryCause(createRecord({
        blockers: [fixtureBlocker("occupied output", "/project-a")],
      }))).toBe("needs-attention");

      expect(classifyPrimaryCause(createRecord({
        state: { kind: "malformed ownership state", reason: "corrupted state" },
      }))).toBe("needs-attention");

      expect(classifyPrimaryCause(createRecord({
        state: { kind: "blocked", reason: "hooks disabled" },
      }))).toBe("needs-attention");

      expect(classifyPrimaryCause(createRecord({
        state: { kind: "removal" },
      }))).toBe("needs-attention");
    });

    test("classifies generated-files-changed for extant changed files", () => {
      expect(classifyPrimaryCause(createRecord({
        outputs: [{
          consumingHosts: ["codex"],
          driftKind: "changed",
          kind: "update",
          path: "context.md",
        }],
        state: { kind: "drifted output", reason: "context.md" },
      }))).toBe("generated-files-changed");
    });

    test("classifies generated-files-missing for missing generated files", () => {
      expect(classifyPrimaryCause(createRecord({
        outputs: [{
          consumingHosts: ["codex"],
          driftKind: "missing",
          kind: "update",
          path: "context.md",
        }],
        state: { kind: "drifted output", reason: "context.md" },
      }))).toBe("generated-files-missing");
    });

    test("classifies generated-files-missing when one output is missing and sibling outputs are unchanged", () => {
      const record = createRecord({
        outputs: [
          {
            consumingHosts: ["codex"],
            driftKind: "missing",
            kind: "update",
            path: "context.md",
          },
          {
            consumingHosts: ["codex"],
            kind: "unchanged",
            path: "hooks.json",
          },
        ],
        state: { kind: "drifted output", reason: "context.md" },
      });
      expect(hasGeneratedFilesChanged(record)).toBe(false);
      expect(hasGeneratedFilesMissing(record)).toBe(true);
      expect(classifyPrimaryCause(record)).toBe("generated-files-missing");
    });

    test("classifies not-installed-yet for fresh additions", () => {
      expect(classifyPrimaryCause(createRecord({
        outputs: [{
          consumingHosts: ["codex"],
          kind: "addition",
          path: "context.md",
        }],
        state: { kind: "addition" },
      }))).toBe("not-installed-yet");
    });

    test("classifies source-changed for stale source and updates", () => {
      expect(classifyPrimaryCause(createRecord({
        outputs: [{
          consumingHosts: ["codex"],
          kind: "update",
          path: "context.md",
        }],
        state: { kind: "stale source" },
      }))).toBe("source-changed");

      expect(classifyPrimaryCause(createRecord({
        outputs: [{
          consumingHosts: ["codex"],
          kind: "update",
          path: "context.md",
        }],
        state: { kind: "update" },
      }))).toBe("source-changed");
    });

    test("classifies settled for current projects, exclusion-only changes, and advisory warnings", () => {
      expect(classifyPrimaryCause(createRecord({
        outputs: [{
          consumingHosts: ["codex"],
          kind: "unchanged",
          path: "context.md",
        }],
        state: { kind: "current" },
      }))).toBe("settled");

      expect(classifyPrimaryCause(createRecord({
        repositoryExclusions: [{
          current: [],
          installed: false,
          next: ["/.agent-profile-kit/codex/context.md"],
          target: "/project-a/.git/info/exclude",
        }],
        state: { kind: "current" },
      }))).toBe("settled");

      expect(classifyPrimaryCause(createRecord({
        state: { kind: "current" },
        warnings: [{
          copyableValues: [],
          kind: "host-attention",
          parts: ["Agent Host codex is outdated"],
        }],
      }))).toBe("settled");
    });

    test("strictly enforces priority order: needs attention > generated files changed > generated files missing > not installed yet > source changed", () => {
      // Blocker beats drifted output
      expect(classifyPrimaryCause(createRecord({
        blockers: [fixtureBlocker("occupied output", "/project-a")],
        outputs: [{
          consumingHosts: ["codex"],
          driftKind: "changed",
          kind: "update",
          path: "context.md",
        }],
        state: { kind: "drifted output", reason: "context.md" },
      }))).toBe("needs-attention");

      // Generated files changed beats missing
      expect(classifyPrimaryCause(createRecord({
        outputs: [
          {
            consumingHosts: ["codex"],
            driftKind: "changed",
            kind: "update",
            path: "a.md",
          },
          {
            consumingHosts: ["codex"],
            driftKind: "missing",
            kind: "update",
            path: "b.md",
          },
        ],
        state: { kind: "drifted output" },
      }))).toBe("generated-files-changed");

      // Generated files missing beats addition
      expect(classifyPrimaryCause(createRecord({
        outputs: [
          {
            consumingHosts: ["codex"],
            driftKind: "missing",
            kind: "update",
            path: "b.md",
          },
        ],
        state: { kind: "addition" },
      }))).toBe("generated-files-missing");

      // Not installed yet beats source changed
      expect(classifyPrimaryCause(createRecord({
        outputs: [
          {
            consumingHosts: ["codex"],
            kind: "update",
            path: "b.md",
          },
        ],
        state: { kind: "addition" },
      }))).toBe("not-installed-yet");
    });

    test("classifyAllCauses returns all matching causes in priority order", () => {
      const causes = classifyAllCauses(createRecord({
        blockers: [fixtureBlocker("occupied output", "/project-a")],
        outputs: [
          {
            consumingHosts: ["codex"],
            driftKind: "changed",
            kind: "update",
            path: "a.md",
          },
          {
            consumingHosts: ["codex"],
            driftKind: "missing",
            kind: "update",
            path: "b.md",
          },
          {
            consumingHosts: ["codex"],
            kind: "addition",
            path: "c.md",
          },
        ],
        state: { kind: "addition" },
      }));

      expect(causes).toEqual([
        "needs-attention",
        "generated-files-changed",
        "generated-files-missing",
        "not-installed-yet",
        "source-changed",
      ]);
    });
  });

  describe("partitionFleet", () => {
    test("partitions mixed fleet across all 5 causes and settled count", () => {
      const p1 = createRecord({ canonicalProject: "/project-1", project: "/project-1", state: { kind: "removal" } });
      const p2 = createRecord({ canonicalProject: "/project-2", project: "/project-2", state: { kind: "drifted output" }, outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "a.md" }] });
      const p3 = createRecord({ canonicalProject: "/project-3", project: "/project-3", state: { kind: "drifted output" }, outputs: [{ consumingHosts: ["codex"], driftKind: "missing", kind: "update", path: "b.md" }] });
      const p4 = createRecord({ canonicalProject: "/project-4", project: "/project-4", state: { kind: "addition" } });
      const p5 = createRecord({ canonicalProject: "/project-5", project: "/project-5", state: { kind: "stale source" } });
      const p6 = createRecord({ canonicalProject: "/project-6", project: "/project-6", state: { kind: "current" } });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [p1, p2, p3, p4, p5, p6],
      };

      const partition = partitionFleet(report);
      expect(partition.groups["needs-attention"]).toEqual([p1]);
      expect(partition.groups["generated-files-changed"]).toEqual([p2]);
      expect(partition.groups["generated-files-missing"]).toEqual([p3]);
      expect(partition.groups["not-installed-yet"]).toEqual([p4]);
      expect(partition.groups["source-changed"]).toEqual([p5]);
      expect(partition.settledCount).toBe(1);
      expect(partition.totalActionableCount).toBe(5);
      expect(partition.totalFleetCount).toBe(6);
    });

    test("scales cleanly across 12- and 30-project fleets", () => {
      const projects = Array.from({ length: 30 }, (_, index) => {
        const path = `/project-${String(index + 1).padStart(2, "0")}`;
        const causeIndex = index % 6;
        if (causeIndex === 0) return createRecord({ canonicalProject: path, project: path, blockers: [fixtureBlocker("occupied", path)] });
        if (causeIndex === 1) return createRecord({ canonicalProject: path, project: path, state: { kind: "drifted output" }, outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "a.md" }] });
        if (causeIndex === 2) return createRecord({ canonicalProject: path, project: path, state: { kind: "drifted output" }, outputs: [{ consumingHosts: ["codex"], driftKind: "missing", kind: "update", path: "b.md" }] });
        if (causeIndex === 3) return createRecord({ canonicalProject: path, project: path, state: { kind: "addition" } });
        if (causeIndex === 4) return createRecord({ canonicalProject: path, project: path, state: { kind: "stale source" } });
        return createRecord({ canonicalProject: path, project: path, state: { kind: "current" } });
      });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects,
      };

      const partition = partitionFleet(report);
      expect(partition.groups["needs-attention"]).toHaveLength(5);
      expect(partition.groups["generated-files-changed"]).toHaveLength(5);
      expect(partition.groups["generated-files-missing"]).toHaveLength(5);
      expect(partition.groups["not-installed-yet"]).toHaveLength(5);
      expect(partition.groups["source-changed"]).toHaveLength(5);
      expect(partition.settledCount).toBe(5);
      expect(partition.totalActionableCount).toBe(25);
      expect(partition.totalFleetCount).toBe(30);
    });
  });

  describe("lifecycleStatusDocument primary-cause presentation", () => {
    test("renders mixed fleet with notice, all 5 cause groups, settled count, and next/details", () => {
      const p1 = createRecord({ canonicalProject: "/project-1", project: "/project-1", state: { kind: "removal" } });
      const p2 = createRecord({ canonicalProject: "/project-2", project: "/project-2", state: { kind: "drifted output" }, outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "a.md" }] });
      const p3 = createRecord({ canonicalProject: "/project-3", project: "/project-3", state: { kind: "drifted output" }, outputs: [{ consumingHosts: ["codex"], driftKind: "missing", kind: "update", path: "b.md" }] });
      const p4 = createRecord({ canonicalProject: "/project-4", project: "/project-4", state: { kind: "addition" } });
      const p5 = createRecord({ canonicalProject: "/project-5", project: "/project-5", state: { kind: "stale source" } });
      const p6 = createRecord({ canonicalProject: "/project-6", project: "/project-6", state: { kind: "current" } });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [p1, p2, p3, p4, p5, p6],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered).toStartWith("Ready to apply\n");
      expect(rendered).toContain("- needs attention (1):");
      expect(rendered).toContain("/project-1");
      expect((rendered.match(/\/project-1/g) || []).length).toBe(1);
      expect(rendered).toContain("- generated files changed (1): /project-2");
      expect(rendered).toContain("- generated files missing (1): /project-3");
      expect(rendered).toContain("- not installed yet (1): /project-4");
      expect(rendered).toContain("- source changed (1): /project-5");
      expect(rendered).toContain("- settled (1)");
      expect(rendered).toContain("Next: apkit apply");
      expect(rendered).toContain("Details: apkit status --verbose");
    });

    test("contains Blockers concisely while preserving the full fleet partition", () => {
      const p1 = createRecord({
        blockers: [fixtureBlocker("occupied output", "/project-1")],
        canonicalProject: "/project-1",
        project: "/project-1",
      });
      const p2 = createRecord({
        canonicalProject: "/project-2",
        project: "/project-2",
        state: { kind: "addition" },
      });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [p1, p2],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered).toStartWith("Cannot apply\n");
      expect(rendered).toContain("- needs attention (1):");
      expect(rendered).toContain("/project-1");
      expect(rendered).toContain("- not installed yet (1): /project-2");
      expect(rendered).toContain("Blocker:");
      expect(rendered).toContain("Requirement:");
      expect(rendered).toContain("Remedy:");
      expect(rendered).not.toContain("Scope: Project");
      // Prose identity stays exactly once; recovery commands may repeat the
      // scoped Project argument (a runnable copy needs it).
      expect(proseOccurrences(document, "/project-1")).toBe(1);
      expect(proseOccurrences(document, "/project-2")).toBe(1);
    });

    test("wholly settled fleet renders single line outcome without breakdown or next action", () => {
      const p1 = createRecord({ canonicalProject: "/project-1", project: "/project-1", state: { kind: "current" } });
      const p2 = createRecord({ canonicalProject: "/project-2", project: "/project-2", state: { kind: "current" } });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [p1, p2],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered.trim()).toBe("All Projects are current (2 Projects)");
      expect(rendered).not.toContain("settled");
      expect(rendered).not.toContain("Next:");
    });

    test("advisory host-attention warning on settled fleet renders warning but keeps single outcome notice", () => {
      const p1 = createRecord({
        canonicalProject: "/project-1",
        project: "/project-1",
        state: { kind: "current" },
        warnings: [{
          copyableValues: [],
          kind: "host-attention",
          parts: ["Agent Host codex CLI is outdated"],
        }],
      });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [p1],
      };

      const document = lifecycleStatusDocument(report);
      const rendered = renderBoundary(document);

      expect(rendered).toContain("Host attention required");
      expect(rendered).not.toContain("Warnings:");
      expect(rendered).toContain("Agent Host codex CLI is outdated");
      expect(rendered).not.toContain("needs attention");
      expect(rendered).not.toContain("Next:");
    });

    test("concise status explains removal for unbound teardown under needs attention", () => {
      const p1 = createRecord({
        canonicalProject: "/project-1",
        project: "/project-1",
        state: { kind: "removal" },
      });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [p1],
      };

      const document = lifecycleStatusDocument(report);
      const rendered = renderBoundary(document);

      expect(rendered).toContain("- needs attention (1):");
      expect(rendered).toContain("/project-1");
      expect(rendered).toContain("Apply will remove generated files for unbound projects.");
      expect(rendered).not.toContain("Blocker:");
      expect((rendered.match(/\/project-1/g) || []).length).toBe(1);
    });

    test("two interleaved removals each keep nested teardown explanation among blocked and healthy peers", () => {
      const sharedPath = ".codex/hooks.json";
      const nodeHasPath = (node: PresentationNode, canonical: string): boolean => {
        if (node.kind !== "prose" && node.kind !== "list-item") return false;
        return node.parts.some((part) =>
          typeof part !== "string" && part.kind === "path" && part.canonicalPath === canonical,
        );
      };
      const nextCauseAt = (nodes: readonly PresentationNode[], after: number): number =>
        nodes.findIndex((node, index) =>
          index > after && node.kind === "list-item" && nodeText(node).startsWith("not installed yet"));
      const beta = createRecord({
        blockers: [
          normalizeBlocker(outputOwnershipConflictBlocker({
            paths: [sharedPath],
            project: "/project-beta",
          })),
          normalizeBlocker(occupiedOutputBlocker({
            occupied: { case: "drifted-output" },
            path: "second.json",
            project: "/project-beta",
          })),
        ],
        canonicalProject: "/project-beta",
        project: "/project-beta",
      });
      const removalFirst = createRecord({
        canonicalProject: "/removal-first",
        project: "/removal-first",
        state: { kind: "removal" },
      });
      const alpha = createRecord({
        blockers: [normalizeBlocker(occupiedOutputBlocker({
          occupied: { case: "drifted-output" },
          path: sharedPath,
          project: "/project-alpha",
        }))],
        canonicalProject: "/project-alpha",
        project: "/project-alpha",
      });
      const removalSecond = createRecord({
        canonicalProject: "/removal-second",
        project: "/removal-second",
        state: { kind: "removal" },
      });
      const pending = createRecord({
        canonicalProject: "/pending",
        project: "/pending",
        state: { kind: "addition" },
      });
      const settled = createRecord({
        canonicalProject: "/settled",
        project: "/settled",
        state: { kind: "current" },
      });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [beta, removalFirst, alpha, removalSecond, pending, settled],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const nodes = flattenPresentationNodes(document);
      const attentionAt = indexWhere(nodes, (node) =>
        node.kind === "list-item" && nodeText(node) === "needs attention (4):");
      const betaAt = indexWhere(nodes, (node) => nodeHasPath(node, "/project-beta"));
      const removalFirstAt = indexWhere(nodes, (node) => nodeHasPath(node, "/removal-first"));
      const alphaAt = indexWhere(nodes, (node) => nodeHasPath(node, "/project-alpha"));
      const removalSecondAt = indexWhere(nodes, (node) => nodeHasPath(node, "/removal-second"));
      const pendingGroupAt = nextCauseAt(nodes, removalSecondAt);
      expect(attentionAt).toBeGreaterThan(-1);
      expect(betaAt).toBeGreaterThan(attentionAt);
      expect(removalFirstAt).toBeGreaterThan(betaAt);
      expect(alphaAt).toBeGreaterThan(removalFirstAt);
      expect(removalSecondAt).toBeGreaterThan(alphaAt);
      expect(pendingGroupAt).toBeGreaterThan(removalSecondAt);

      const betaChildren = nodes.slice(betaAt + 1, removalFirstAt);
      expect(betaChildren.some((node) => nodeText(node).includes("tracked by Git"))).toBe(true);
      expect(betaChildren.some((node) => nodeText(node).includes("second.json"))).toBe(true);
      expect(betaChildren.some((node) => nodeText(node).includes("Apply will remove generated files for unbound projects."))).toBe(false);
      expect(betaChildren.some((node) => nodeHasPath(node, "/project-beta"))).toBe(false);

      const removalFirstChildren = nodes.slice(removalFirstAt + 1, alphaAt);
      expect(removalFirstChildren.some((node) =>
        nodeText(node).includes("Apply will remove generated files for unbound projects."))).toBe(true);
      expect(removalFirstChildren.some((node) => nodeText(node).includes("Blocker:"))).toBe(false);
      expect(removalFirstChildren.some((node) => nodeHasPath(node, "/removal-first"))).toBe(false);

      const alphaChildren = nodes.slice(alphaAt + 1, removalSecondAt);
      expect(alphaChildren.some((node) =>
        nodeText(node).includes("already contains a file Agent Profile Kit did not install")
      )).toBe(true);
      expect(alphaChildren.some((node) => nodeText(node).includes("Manual recovery is required"))).toBe(true);
      expect(alphaChildren.some((node) => nodeText(node).includes("tracked by Git"))).toBe(false);
      expect(alphaChildren.some((node) => nodeText(node).includes("Apply will remove generated files for unbound projects."))).toBe(false);

      const removalSecondChildren = nodes.slice(removalSecondAt + 1, pendingGroupAt);
      expect(removalSecondChildren.some((node) =>
        nodeText(node).includes("Apply will remove generated files for unbound projects."))).toBe(true);
      expect(removalSecondChildren.some((node) => nodeText(node).includes("Blocker:"))).toBe(false);
      expect(removalSecondChildren.some((node) => nodeHasPath(node, "/removal-second"))).toBe(false);
      expect(pendingGroupAt).not.toBe(removalSecondAt + 1);

      for (const width of [40, 60, 80, 10_000]) {
        const rendered = renderBoundary(document, { ...defaultRenderContext, width });
        expect(rendered).toContain("- needs attention (4):");
        expect(rendered).toContain("- not installed yet (1):");
        expect(rendered).toContain("- settled (1)");
        expect(proseOccurrences(document, "/project-beta")).toBe(1);
        expect(proseOccurrences(document, "/removal-first")).toBe(1);
        expect(proseOccurrences(document, "/project-alpha")).toBe(1);
        expect((rendered.match(/\/removal-second/g) || []).length).toBe(1);
        expect((rendered.match(/\/pending/g) || []).length).toBe(1);
        expect((rendered.match(/\/settled/g) || []).length).toBe(0);

        const compact = (text: string): string => text.replace(/\s+/g, " ");
        const betaStart = rendered.indexOf("/project-beta");
        const removalFirstStart = rendered.indexOf("/removal-first");
        const alphaStart = rendered.indexOf("/project-alpha");
        const removalSecondStart = rendered.indexOf("/removal-second");
        expect(betaStart).toBeGreaterThan(-1);
        expect(removalFirstStart).toBeGreaterThan(betaStart);
        expect(alphaStart).toBeGreaterThan(removalFirstStart);
        expect(removalSecondStart).toBeGreaterThan(alphaStart);
        const removalFirstSection = compact(rendered.slice(removalFirstStart, alphaStart));
        const removalSecondSection = compact(rendered.slice(removalSecondStart, rendered.indexOf("- not installed yet")));
        const alphaSection = compact(rendered.slice(alphaStart, removalSecondStart));
        expect(removalFirstSection).toContain("Apply will remove generated files for unbound projects.");
        expect(removalFirstSection).not.toContain("Blocker:");
        expect(removalSecondSection).toContain("Apply will remove generated files for unbound projects.");
        expect(removalSecondSection).not.toContain("Blocker:");
        expect(alphaSection).toContain("already contains a file Agent Profile Kit did not install");
        expect(alphaSection).not.toContain("Apply will remove generated files for unbound projects.");
      }
    });

    test("nested needs-attention members bind each blocker remedy to its project among reversed multi-blocked, removal, pending, and settled peers", () => {
      const sharedPath = ".codex/hooks.json";
      const beta = createRecord({
        blockers: [normalizeBlocker(outputOwnershipConflictBlocker({
          paths: [sharedPath],
          project: "/project-beta",
        }))],
        canonicalProject: "/project-beta",
        project: "/project-beta",
      });
      const alpha = createRecord({
        blockers: [normalizeBlocker(occupiedOutputBlocker({
          occupied: { case: "drifted-output" },
          path: sharedPath,
          project: "/project-alpha",
        }))],
        canonicalProject: "/project-alpha",
        project: "/project-alpha",
      });
      const removal = createRecord({
        canonicalProject: "/project-removal",
        project: "/project-removal",
        state: { kind: "removal" },
      });
      const pending = createRecord({
        canonicalProject: "/project-pending",
        project: "/project-pending",
        state: { kind: "addition" },
      });
      const settled = createRecord({
        canonicalProject: "/project-settled",
        project: "/project-settled",
        state: { kind: "current" },
      });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [beta, alpha, removal, pending, settled],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const nodes = flattenPresentationNodes(document);
      const nodeHasPath = (node: PresentationNode, canonical: string): boolean => {
        if (node.kind !== "prose" && node.kind !== "list-item") return false;
        return node.parts.some((part) =>
          typeof part !== "string" && part.kind === "path" && part.canonicalPath === canonical,
        );
      };
      const attentionAt = indexWhere(nodes, (node) =>
        node.kind === "list-item" && nodeText(node) === "needs attention (3):");
      const betaAt = indexWhere(nodes, (node) => nodeHasPath(node, "/project-beta"));
      const alphaAt = indexWhere(nodes, (node) => nodeHasPath(node, "/project-alpha"));
      const removalAt = indexWhere(nodes, (node) => nodeHasPath(node, "/project-removal"));
      expect(attentionAt).toBeGreaterThan(-1);
      expect(betaAt).toBeGreaterThan(attentionAt);
      expect(alphaAt).toBeGreaterThan(betaAt);
      expect(removalAt).toBeGreaterThan(alphaAt);
      expect(nodeHasPath(nodes[attentionAt]!, "/project-beta")).toBe(false);
      expect(nodeHasPath(nodes[attentionAt]!, "/project-alpha")).toBe(false);
      expect(nodeHasPath(nodes[attentionAt]!, "/project-removal")).toBe(false);

      const betaChildren = nodes.slice(betaAt + 1, alphaAt);
      expect(betaChildren.some((node) => nodeText(node).includes("tracked by Git"))).toBe(true);
      expect(betaChildren.some((node) =>
        nodeText(node).includes("stages their removal from the Git index while the files stay on disk")
      )).toBe(true);
      expect(betaChildren.some((node) => nodeText(node).includes("Remove, move, or adopt"))).toBe(false);
      expect(betaChildren.some((node) => nodeHasPath(node, "/project-beta"))).toBe(false);

      const alphaChildren = nodes.slice(alphaAt + 1, removalAt);
      expect(alphaChildren.some((node) =>
        nodeText(node).includes("already contains a file Agent Profile Kit did not install")
      )).toBe(true);
      expect(alphaChildren.some((node) => nodeText(node).includes("Manual recovery is required"))).toBe(true);
      expect(alphaChildren.some((node) => nodeText(node).includes("tracked by Git"))).toBe(false);
      expect(alphaChildren.some((node) => nodeHasPath(node, "/project-alpha"))).toBe(false);

      const removalChildren = nodes.slice(removalAt + 1, indexWhere(nodes, (node) =>
        node.kind === "list-item" && nodeText(node).startsWith("not installed yet")));
      expect(removalChildren.some((node) =>
        nodeText(node).includes("Apply will remove generated files for unbound projects."))).toBe(true);
      expect(removalChildren.some((node) => nodeText(node).includes("Blocker:"))).toBe(false);

      for (const width of [40, 60, 80, 10_000]) {
        const rendered = renderBoundary(document, { ...defaultRenderContext, width });
        expect(rendered).toContain("- needs attention (3):");
        expect(rendered).toContain("- not installed yet (1):");
        expect(rendered).toContain("- settled (1)");
        expect(rendered).not.toContain("Scope: Project");
        expect(proseOccurrences(document, "/project-beta")).toBe(1);
        expect(proseOccurrences(document, "/project-alpha")).toBe(1);
        expect((rendered.match(/\/project-removal/g) || []).length).toBe(1);
        expect((rendered.match(/\/project-pending/g) || []).length).toBe(1);
        expect((rendered.match(/\/project-settled/g) || []).length).toBe(0);

        const betaStart = rendered.indexOf("/project-beta");
        const alphaStart = rendered.indexOf("/project-alpha");
        const removalStart = rendered.indexOf("/project-removal");
        expect(betaStart).toBeGreaterThan(-1);
        expect(alphaStart).toBeGreaterThan(betaStart);
        expect(removalStart).toBeGreaterThan(alphaStart);
        const compact = (text: string): string => text.replace(/\s+/g, " ");
        const betaSection = compact(rendered.slice(betaStart, alphaStart));
        const alphaSection = compact(rendered.slice(alphaStart, removalStart));
        const removalSection = compact(rendered.slice(removalStart));
        expect(betaSection).toContain("tracked by Git");
        expect(betaSection).toContain("stages their removal from the Git index while the files stay on disk");
        expect(betaSection).not.toContain("Manual recovery is required");
        expect(alphaSection).toContain("already contains a file Agent Profile Kit did not install");
        expect(alphaSection).toContain("Manual recovery is required");
        expect(alphaSection).not.toContain("tracked by Git");
        expect(removalSection).toContain("Apply will remove generated files for unbound projects.");
        expect(removalSection).not.toContain("Blocker:");
      }
    });

    test("healthy mixed fleet names each actionable project exactly once and settled projects zero times", () => {
      const pMissing = createRecord({
        canonicalProject: "/project-missing",
        outputs: [{
          consumingHosts: ["codex"],
          driftKind: "missing",
          kind: "update",
          path: "context.md",
        }],
        project: "/project-missing",
        state: { kind: "drifted output" },
      });
      const pChanged = createRecord({
        canonicalProject: "/project-changed",
        outputs: [{
          consumingHosts: ["codex"],
          driftKind: "changed",
          kind: "update",
          path: "context.md",
        }],
        project: "/project-changed",
        state: { kind: "drifted output" },
      });
      const pSettled = createRecord({
        canonicalProject: "/project-settled",
        project: "/project-settled",
        state: { kind: "current" },
      });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [pMissing, pChanged, pSettled],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered).toContain("- generated files missing (1): /project-missing");
      expect(rendered).toContain("- generated files changed (1): /project-changed");
      expect(rendered).toContain("- settled (1)");
      expect((rendered.match(/\/project-missing/g) || []).length).toBe(1);
      expect((rendered.match(/\/project-changed/g) || []).length).toBe(1);
      expect((rendered.match(/\/project-settled/g) || []).length).toBe(0);
      expect(rendered).toContain("Next: apkit apply");
    });

    test("wrapped concise status preserves exactly-once project identity in narrow terminals", () => {
      const longProject1 = "/long/path/to/first/nested/corporate/monorepo/project-one";
      const longProject2 = "/long/path/to/second/nested/corporate/monorepo/project-two";
      const p1 = createRecord({
        blockers: [fixtureBlocker("occupied output", longProject1)],
        canonicalProject: longProject1,
        project: longProject1,
      });
      const p2 = createRecord({
        canonicalProject: longProject2,
        outputs: [{
          consumingHosts: ["codex"],
          driftKind: "missing",
          kind: "update",
          path: "context.md",
        }],
        project: longProject2,
        state: { kind: "drifted output" },
      });

      const report: ReconciliationReport = {
        globalBlockers: [],
        projects: [p1, p2],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      for (const width of [40, 60, 80]) {
        const rendered = renderBoundary(document, { ...defaultRenderContext, width });
        // Prose identity stays exactly once; the remedy's scoped command
        // arguments repeat the Project path on purpose (a runnable copy needs
        // it), and atomic commands never split.
        expect(proseOccurrences(document, "project-one")).toBe(1);
        expect(proseOccurrences(document, "project-two")).toBe(1);
      }
    });
  });
});

