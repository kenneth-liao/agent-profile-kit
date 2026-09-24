import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { AdapterDiagnosticWarning, HostSetupStep } from "../adapters/project-plan.js";
import type { SupportedHost } from "../adapters/host-catalog.js";
import { capabilityFailure } from "../adapters/capability.js";
import { appendDiagnosticWarnings, capabilityWarning } from "../installer/project-plan.js";
import {
  emptyWorkspaceProfileCreationDocument,
  hasProfiles,
  initConfirmationDocument,
  initLocationDocument,
  initReceiptDocument,
  installReceiptDocument,
  newArtifactCreatedNodes,
} from "../cli/receipts.js";
import { PROJECT_EXPLANATION_SENTENCE } from "../cli/concept-explanations.js";
import { workspaceSubfolderDisplay } from "../cli/display-path.js";
import {
  commandPart,
  flatInlineText,
  identifierPart,
  type CommandPart,
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
import { expectElidedProjectLine } from "./support/project-line.js";
import { guideMarkdownDocument } from "../cli/guide-markdown.js";
import {
  focusedGuideDocument,
  guideFileDocument,
  guideIndexDocument,
  humanGuide,
  TOPIC_GUIDES,
} from "../cli/guides.js";
import {
  bareInvocationDocument,
  applyReplacementDeclinedDocument,
  applyExecutionFailureDocument as rawApplyExecutionFailureDocument,
  applyReportDocument as rawApplyReportDocument,
  applyVerificationFailureDocument as rawApplyVerificationFailureDocument,
  blockedApplyReportDocument as rawBlockedApplyReportDocument,
  formatApplyJson,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatLifecycleJson,
  formatLifecycleToolErrorJson,
  HOST_DETECTION_LABELS,
  hostInventoryDocument,
  infoDocument,
  installBlockedDocument,
  installConfirmationDocument,
  INSTALL_CONFIRMATION_QUESTION,
  installDeclinedDocument,
  installHostSelectionNoteDocument,
  installHostSetupNodes,
  installProfileSelectionNoteDocument,
  installWarningNodes,
  installTargetDocument,
  configureDeclinedDocument,
  configurePickerCancelledDocument,
  initCancelledDocument,
  initDeclinedDocument,
  uninstallInteractiveDeclinedDocument,
  inventoryIndexDocument,
  lifecycleStatusDocument as rawLifecycleStatusDocument,
  type LifecycleHumanOptions,
  formatMissingProfileError,
  machineInventoryIndexDocument,
  profileDetailDocument,
  profileInventoryDocument,
  projectInventoryDocument,
  temporaryBlockedMessagesDocument,
  temporaryInstallationDocument,
  temporaryInventoryDocument,
  uninstallReceiptDocument,
  formatUninstallJson,
  uninstallConfirmationDocument,
  uninstallDeclinedDocument,
  uninstallConfirmationRequiredDocument,
  uninstallMissingScopeDocument,
  uninstallNoMatchDocument,
  uninstallExecutionFailureDocument,
  uninstallPickerNoopDocument,
  validationResultDocument,
  workspaceValidationDocument,
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
  primaryCauseLabel,
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

/** The document's content-node shapes, with authored parts flattened: the
 * composition order a screen can rely on (INT-1). */
function shapes(document: PresentationDocument): readonly string[] {
  return document.flatMap((node) =>
    node.kind === "part" ? shapes(node.nodes) : [nodeShape(node)]);
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
import {
  brokenProfileViolations,
  ingestWorkspaceToleratingReferenceViolations,
} from "../installer/ingest-workspace.js";
import type { WorkspaceViolation } from "../installer/tool-errors.js";
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
    brokenProfileViolations: [],
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
          ...(output.driftKind === undefined ? {} : { driftKind: output.driftKind }),
          ...(output.sourceChanged === undefined ? {} : { sourceChanged: output.sourceChanged }),
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
  return { brokenProfileViolations: [], globalBlockers, projects } as ReconciliationReport;
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
    if (node.kind === "part") {
      for (const child of node.nodes) visit(child);
      return;
    }
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

/** The warning list part of a document, when one is authored. */
function warningListIn(document: PresentationDocument): PresentationNode | undefined {
  return flattenPresentationNodes(document).find((node) =>
    node.kind === "list" && node.category === "warning");
}

/** One document node unwrapped to its first content node for part nodes. */
function firstContentNode(node: PresentationNode): PresentationNode {
  return node.kind === "part" ? node.nodes[0] ?? node : node;
}

/** Every list part's items, in document order (the one list home). */
function listPartsIn(document: PresentationDocument): readonly (readonly InlineContent[])[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "list" ? node.items : [],
  );
}

/** One list item's inline identifier values, in order. */
function itemIdentifiers(item: readonly InlineContent[]): string[] {
  return item.flatMap((part) =>
    typeof part !== "string" && part.kind === "identifier" ? [part.value] : []);
}

/** Every list item's inline identifier values, in document order. */
function listItemIdentities(document: PresentationDocument): string[][] {
  return listPartsIn(document).map(itemIdentifiers);
}

/** The flat carried text of one node, composed from its inline parts. */
function nodeText(node: PresentationNode): string {
  if (node.kind === "heading" || node.kind === "verbatim") return node.text;
  if (node.kind === "identifier") return node.value;
  if (node.kind === "prose" || node.kind === "sentence") return flatInlineText(node.parts);
  return "";
}

/** One list node's items flattened to their carried text. */
function listItemTexts(node: PresentationNode): readonly string[] {
  return node.kind === "list" ? node.items.map((item) => flatInlineText(item)) : [];
}

/**
 * Count prose occurrences of a substring across text spans only: atomic
 * command arguments (scoped recovery commands) are carried once per command by
 * design and are not prose identity prose (#440).
 */
function proseOccurrences(document: PresentationDocument, substring: string): number {
  const prose = flattenPresentationNodes(document)
    .flatMap((node) =>
      node.kind === "prose" || node.kind === "sentence"
        ? node.parts.flatMap((part) =>
            typeof part === "string"
              ? [part]
              : part.kind === "path"
              ? [part.authoredPath ?? part.canonicalPath]
              : [])
        : node.kind === "list"
        ? node.items.flatMap((item) =>
            item.flatMap((part) =>
              typeof part === "string"
                ? [part]
                : part.kind === "path"
                ? [part.authoredPath ?? part.canonicalPath]
                : []))
        : node.kind === "path"
        ? [node.authoredPath ?? node.canonicalPath]
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
    node.kind === "prose" || node.kind === "sentence"
      ? node.parts.flatMap((part) =>
          typeof part === "string"
            ? [part]
            : part.kind === "path"
            ? [part.authoredPath ?? part.canonicalPath]
            : [])
      : node.kind === "list"
      ? node.items.flatMap((item) =>
          item.flatMap((part) =>
            typeof part === "string"
              ? [part]
              : part.kind === "path"
              ? [part.authoredPath ?? part.canonicalPath]
              : []))
      : node.kind === "path"
      ? [node.authoredPath ?? node.canonicalPath]
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
    case "list":
      return `list${category}`;
    case "verbatim":
      return nodeText(node).length === 0 ? "spacer" : "verbatim";
    default:
      return node.kind;
  }
}

const context = (width: number): TerminalPresentationContext => ({
  color: false,
  interactive: true,
  rows: undefined,  width,
});

/** The default render context the CLI-boundary string formatters used: the
 * vocabulary guard renders documents through it so its scanned text is
 * unchanged (TEST-014). */
const defaultRenderContext: TerminalPresentationContext = {
  color: false,
  interactive: false,
  width: 10_000,
  rows: undefined,
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

  test("concise current status names every checked Project and invents no next action", () => {
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

    expect(shapes(document)).toEqual([
      "notice",
      "spacer",
      "row",
      "row",
    ]);
    const rendered = renderBoundary(document);
    expect(rendered).toStartWith("✔ All Projects are up to date (2 Projects)\n");
    expect(rendered).toContain("up to date");
    expect(rendered).not.toContain("Next:");
    expect(rendered).not.toContain("Details:");
  });

  test("concise pending status is outcome, scope rows, then typed next commands in order", () => {
    const document = lifecycleStatusDocument(pendingReport());

    expect(shapes(document)).toEqual([
      "notice",
      "spacer",
      "row",
      "key-value:Next(command)",
      "key-value:Details(command)",
    ]);
    expect(renderBoundary(document)).toStartWith("⚠ Ready to update\n");
    const commands = flattenPresentationNodes(document).filter((node) => node.kind === "command");
    expect(commands).toEqual([
      {
        kind: "command",
        program: "apkit",
        args: [{ kind: "text", value: "update" }],
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

  test("concise blocked status orders notice, scope rows, typed Blocker fields, summary, and next actions", () => {
    const document = lifecycleStatusDocument(blockedReport());

    expect(shapes(document)).toEqual([
      "notice",
      "spacer",
      "row",
      "spacer",
      "prose",
      "prose(error)",
      "prose",
      "prose",
      "spacer",
      "notice",
      "spacer",
      "heading",
      "list",
    ]);
    expect(renderBoundary(document)).toStartWith("⚠ Cannot update\n");
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "list" &&
      node.items.some((item) => flatInlineText(item).includes("apkit status"))
    )).toBe(true);
    expect(commandsIn(document).some((node) =>
      node.args.some((arg) => arg.kind === "text" && arg.value === "update")
    )).toBe(false);
  });

  test("verbose status presents focused diagnostics without composed Context bodies or setup provenance", () => {
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

    expect(shapes(document)).toEqual([
      "notice",
      "heading",
      "prose",
      "heading",
      "list",
      "heading",
      "prose",
      "heading",
      "list",
    ]);
    const verbatim = flattenPresentationNodes(document).filter((node) => node.kind === "verbatim");
    expect(verbatim).toHaveLength(0);
    const headings = flattenPresentationNodes(document).filter((node) => node.kind === "heading")
      .map((node) => node.kind === "heading" ? nodeText(node) : "");
    expect(headings).toEqual([
      "Projects:",
      "State explanations:",
      "Outputs:",
      "Standing agent setup:",
    ]);
    expect(headings).not.toContain("Selected setup:");
    expect(headings).not.toContain("Blockers:");
    expect(headings).not.toContain("Git exclusions:");
  });

  test("blocked verbose status renders the Blockers section exactly once, leading the details", () => {
    const document = lifecycleStatusDocument(blockedReport(), { verbose: true });

    const headings = document.filter((node) => node.kind === "heading")
      .map((node) => node.kind === "heading" ? nodeText(node) : "");
    expect(headings[0]).toBe("Blockers:");
    expect(headings.filter((text) => text === "Blockers:")).toHaveLength(1);
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
    expect(shapes(document)).toEqual([
      "notice",
      "list",
      "spacer",
      "row",
    ]);
    // Severity drives the colour, not rendered copy (TEST-008).
    const rendered = renderBoundary(
      lifecycleStatusDocument(hostAttention),
      { color: true, interactive: true, width: 80 , rows: undefined },
    );
    expect(rendered).toContain("\u001b[33m⚠ Agent attention required\u001b[0m");
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
      node.args.some((arg) => arg.kind === "text" && arg.value === "update") &&
      node.args.some((arg) =>
        arg.kind === "path" &&
        arg.canonicalPath === project &&
        arg.authoredPath === project &&
        // The command argument carries the runnable fleet identity (home-
        // relative or absolute), not the cwd-relative project-scope alias the
        // Project-target boundary rejects (US-007, review INT-1 on #489).
        arg.scope === "fleet"
      )
    )).toBe(true);
    expect(commands.some((node) =>
      node !== undefined && node.program === "apkit" &&
      node.args.some((arg) => arg.kind === "text" && arg.value === "status") &&
      node.args.some((arg) => arg.kind === "path")
    )).toBe(true);

    const rendered = renderBoundary(
      lifecycleStatusDocument(report, { selection: { command: "status", kind: "project", match: "exact", target: project } }),
      { color: false, interactive: true, width: 40 , rows: undefined },
    );
    for (const line of rendered.split("\n")) {
      if (!line.startsWith("Next: apkit update") && !line.startsWith("Details: apkit status")) {
        continue;
      }
      // A copyable command token is never middle-elided (review INT-1 cycle 2
      // on #489): the identity renders fully spelled so the command executes
      // as printed, exactly like the already-unelided remedy commands, even
      // when that renders past the selected width.
      expect(line.split("\n")).toHaveLength(1);
      expect(line).not.toContain("…");
    }
    // The full runnable identity survives at any width: the command tail and
    // the leading directory segments are all present.
    const nextLine = rendered.split("\n").find((line) => line.startsWith("Next: apkit update"));
    const detailsLine = rendered.split("\n").find((line) => line.startsWith("Details: apkit status"));
    // The argument is one shell-quoted token around the full identity
    // (review RE-1 on #489): the printed command executes as printed.
    expect(nextLine).toContain(`apkit update '${project}'`);
    expect(detailsLine).toContain(`apkit status '${project}' --verbose`);
  });

  test("wraps clean, attention, blocked, and verbose status prose to the selected width", () => {
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
    const renderContext = { color: true, interactive: true, width: 80 , rows: undefined } as const;
    const rendered = renderBoundary(document, renderContext);
    // Only the failure headline carries error color and opens with the DEC-001
    // error glyph; remedies and requirement guidance stay outside it.
    const errors = document.filter((node) => node.kind === "notice" && node.severity === "error" ||
      node.kind === "prose" && node.category === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(rendered).toContain("\u001b[31m✖ ");
    expect(rendered).toContain("\u001b[33m⚠ ");
    expect(rendered).toContain("\u001b[1mNext:\u001b[0m");
    expect(rendered).not.toContain("\u001b[1;34m");
    expect(rendered).not.toContain("\u001b[35m");
    const remedyLines = rendered.split("\n").filter((line) => line.includes("Remedy:"));
    expect(remedyLines.length).toBeGreaterThan(0);
    for (const line of remedyLines) {
      expect(line).not.toContain("\u001b[31m");
      expect(line).not.toContain("\u001b[2m");
    }
    expect(rendered).not.toContain("Warnings:");
  });

  test("keeps Blocker remedies and requirement guidance outside error and muted coloring", () => {
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
    });

    const rendered = renderBoundary(lifecycleStatusDocument(report), {
      color: true,
      interactive: true,
      width: 80,
      rows: undefined,
    });
    const failure = rendered.split("\n").find((line) => line.includes("Blocker:"))!;
    expect(failure).toContain("✖ ");
    expect(failure).toContain("Blocker:");
    expect(failure).toContain("\u001b[31m");
    for (const label of ["Requirement:", "Remedy:"]) {
      const line = rendered.split("\n").find((candidate) => candidate.includes(label))!;
      expect(line).not.toContain("\u001b[31m");
      expect(line).not.toContain("\u001b[2m");
      expect(line).not.toContain("\u001b[33m");
    }
  });
});

function commandsIn(
  document: PresentationDocument,
): Extract<PresentationNode, { kind: "command" }>[] {
  return flattenPresentationNodes(document).flatMap((node) =>
    node.kind === "command" ? [node] : [],
  );
}

/** The typed inline command invocations carried in one inline run. */
function commandTextsFromParts(parts: readonly InlineContent[]): string[] {
  return parts.flatMap((part) =>
    typeof part === "string" || part.kind !== "command"
      ? []
      : [[part.program,
          ...part.args.map((arg) => arg.kind === "text" ? arg.value : "")]
        .filter((text) => text !== "").join(" ")]);
}

/** The typed inline command invocations carried inside prose, sentence, and
 * list nodes, rendered from their atomic program/argument parts. */
function inlineCommandTexts(nodes: readonly PresentationNode[]): string[] {
  return nodes.flatMap((node) =>
    node.kind === "part"
      ? inlineCommandTexts(node.nodes)
      : node.kind === "prose" || node.kind === "sentence"
      ? commandTextsFromParts(node.parts)
      : node.kind === "list"
      ? node.items.flatMap((item) => commandTextsFromParts(item))
      : node.kind === "path"
      ? []
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
    node.kind === "prose" || node.kind === "heading" || node.kind === "verbatim"
      ? [nodeText(node)]
      : node.kind === "list"
      ? listItemTexts(node)
      : node.kind === "identifier"
      ? [node.value]
      : [],
  );
}

/** Atomic identifiers already selected by the formatter. */
function inlineIdentifiers(document: PresentationDocument): string[] {
  return flattenPresentationNodes(document).flatMap((node) => {
    if (node.kind === "identifier") return [node.value];
    if (node.kind === "list") {
      return node.items.flatMap((item) =>
        item.flatMap((part) => typeof part !== "string" && part.kind === "identifier" ? [part.value] : []));
    }
    if (node.kind !== "prose" && node.kind !== "sentence") return [];
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

/** The carried text of consecutive list parts beginning at one flat index. */
function listItemsFrom(
  nodes: readonly PresentationNode[],
  start: number,
): string[] {
  const texts: string[] = [];
  for (let index = start; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind !== "list") break;
    texts.push(...listItemTexts(node));
  }
  return texts;
}

/** Every list item's carried text in document order. */
function listItemsIn(document: PresentationDocument): string[] {
  return flattenPresentationNodes(document).flatMap((node) => listItemTexts(node));
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
    rows: undefined,
  };
    const verbose = lifecycleStatusDocument(report, { verbose: true });
    // Sections are authored headings; each step is a list item whose distinct
    // consequence follows as its own prose node.
    expect(headingsIn(verbose)).toContain("Agent setup:");
    expect(headingsIn(verbose)).toContain("Standing agent setup:");
    const nodes = flattenPresentationNodes(verbose);
    const approvalIndex = indexWhere(nodes, (node) =>
      listItemTexts(node).includes(
        "Review and approve the generated SessionStart hook when Codex asks."));
    expect(approvalIndex).toBeGreaterThan(-1);
    expect(nodes[approvalIndex + 1]).toEqual({
      kind: "prose",
      parts: ["  Consequence: Declining the hook prevents Profile Context from loading."],
    });
    const trustIndex = indexWhere(nodes, (node) =>
      listItemTexts(node).includes("Trust the bound project in Codex."));
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

  test("update shows change-relevant transition setup and a separate standing reminder", () => {
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
    const conciseNodes = flattenPresentationNodes(concise);

    // Concise apply renders first-use guidance as one heading with consecutive
    // list items; transition and standing verbose headings never appear.
    const firstUse = indexWhere(conciseNodes, (node) => node.kind === "heading" && nodeText(node) === "First use:");
    expect(firstUse).toBeGreaterThan(-1);
    expect(listItemsFrom(conciseNodes, firstUse + 1)).toEqual([
      expect.stringContaining("Review and approve the generated SessionStart hook when Codex asks"),
      expect.stringContaining("Trust the bound project in Codex"),
      expect.stringContaining("Launch Codex from the exact bound project root"),
    ]);
    expect(headingsIn(applyReportDocument(applyResult(report, resultingState))))
      .not.toContain("Agent setup:");
    expect(headingsIn(applyReportDocument(applyResult(report, resultingState))))
      .not.toContain("Standing agent setup:");
    // The readiness statement is the trailing prose node; its wording is
    // golden-covered (no structured fact exists for it).
    expect(concise.at(-1)).toMatchObject({ kind: "prose" });

    const verbose = applyReportDocument(applyResult(report, resultingState), { verbose: true });
    expect(headingsIn(verbose)).toEqual(expect.arrayContaining(["Agent setup:", "Standing agent setup:"]));
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
    expect(headingsIn(verbose)).toContain("Standing agent setup:");
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
    expect(headingsIn(verbose)).toContain("Standing agent setup:");
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
    expect(headingsIn(concise)).not.toContain("Agent setup:");
    expect(headingsIn(concise)).not.toContain("Standing agent setup:");
    expect(flattenPresentationNodes(concise).at(-1)).toMatchObject({ kind: "prose" });
  });

  test("setup-free update emits invocation-wide readiness statement", () => {
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
    expect(headingsIn(concise)).not.toContain("Standing agent setup:");
    expect(flattenPresentationNodes(concise).at(-1)).toMatchObject({ kind: "prose" });
    const verbose = applyReportDocument(applyResult(report, resultingState), { verbose: true });
    expect(headingsIn(verbose)).toContain("Standing agent setup:");
    expect(listItemsIn(verbose)).toContain("Grok uses Claude's shared rule path.");
  });

  test("no-op update omits transition setup and the standing reminder", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    const concise = applyReportDocument(applyResult(report));
    const nodes = flattenPresentationNodes(concise);
    // Clean no-op apply: one neutral statement, no setup headings, no
    // first-use items, no activation copy (US-003, US-010).
    expect(noticesIn(concise)).toHaveLength(0);
    expect(headingsIn(concise)).not.toContain("First use:");
    expect(headingsIn(concise)).not.toContain("Host setup:");
    expect(listItemsIn(concise)).toEqual([]);
    expect(shapes(concise)).toEqual(["sentence(neutral)"]);
  });

  test("concise update deduplicates first-use guidance across projects without a path matrix", () => {
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
    const conciseNodes = flattenPresentationNodes(concise);
    const firstUse = indexWhere(
      conciseNodes,
      (node) => node.kind === "heading" && nodeText(node) === "First use:",
    );
    expect(firstUse).toBeGreaterThan(-1);
    // First-use guidance is deduplicated: one list item per distinct step,
    // with no per-Project setup matrix.
    expect(listItemsFrom(conciseNodes, firstUse + 1)).toEqual([
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

  test("non-standard security warning consequence is preserved in concise update", () => {
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
      flattenPresentationNodes(concise),
      (node) => node.kind === "heading" && nodeText(node) === "First use:",
    );
    expect(firstUse).toBeGreaterThan(-1);
    const conciseNodes = flattenPresentationNodes(concise);
    expect(listItemsFrom(conciseNodes, firstUse + 1)).toEqual([
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

    // Concise clean status names checked Projects as rows; verbose retains the full Project scope.
    expect(shapes(lifecycleStatusDocument(report))).toEqual([
      "notice", "spacer",
      "row", "row", "row", "row", "row", "row",
    ]);
    const verbose = lifecycleStatusDocument(report, { verbose: true });
    expect(listItemsIn(verbose)).toContain(
      "Trust the bound project in Codex. (/p-1, /p-2, /p-3, /p-4, /p-5, /p-6)",
    );
    expect(listItemsIn(verbose).filter((text) =>
      text.startsWith("Trust the bound project in Codex.")
    )).toHaveLength(1);
  });

  test("blocked update suppresses Host setup for work that did not happen", () => {
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

  test("post-commit verification failure retains update setup without claiming activation", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [codexTrust()])],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    // The failure view keeps first-use guidance as list items under its
    // heading and never claims activation.
    const failure = applyVerificationFailureDocument(report, "Verification failed.");
    const failureNodes = flattenPresentationNodes(failure);
    const firstUse = indexWhere(
      failureNodes,
      (node) => node.kind === "heading" && nodeText(node) === "First use:",
    );
    expect(firstUse).toBeGreaterThan(-1);
    expect(listItemsFrom(failureNodes, firstUse + 1)).toEqual([expect.stringContaining("Trust the bound project in Codex")]);
  });
});

describe("responsive lifecycle presentation", () => {

  test("wraps updated lifecycle prose to the selected width", () => {
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
    // A copyable command token is never middle-elided at any width (review
    // INT-1 cycle 2 on #489): the identity renders fully spelled so each
    // command executes as printed, exactly like the already-unelided remedy
    // commands, even when that renders past the selected width.
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
      if (!line.startsWith("Next: apkit update") && !line.startsWith("Details: apkit status")) {
        continue;
      }
      expect(line.split("\n")).toHaveLength(1);
      expect(line).not.toContain("…");
    }
    expect(status).toContain(`apkit update '${project}'`);
    expect(status).toContain(`apkit status '${project}' --verbose`);
    expect(wideStatus).toContain(`apkit update '${project}'`);
    expect(wideStatus).toContain(`apkit status '${project}' --verbose`);
    expect(emptyStatus).toContain("apkit list projects");
    expect(emptyStatus).toContain("apkit install <profile> --agent <agent>");

    // A command invocation inside an opaque carried message is no longer
    // re-identified or promoted: structural commands are authored as parts
    // and pinned by the presentation-document equivalence tests.
  });

  test("keeps diagnostic paths and warning values intact under responsive wrapping", () => {
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
    expect(output).not.toContain("begin Context");
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
    const warningItem = listPartsIn(doc).find((item) =>
      item.some((part) => typeof part === "object" && part.kind === "identifier" && part.value === projectPath)
    );
    expect(warningItem).toBeDefined();
    expect(warningItem?.slice(0, -1)).toEqual([
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
    const warningItem = listPartsIn(doc).find((item) =>
      item.some((part) => typeof part === "object" && part.kind === "identifier" && part.value === globalPath)
    );

    expect(warningItem).toBeDefined();
    expect(warningItem?.slice(0, -1)).toEqual([
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
    const warningItem = listPartsIn(doc).find((item) =>
      item.some((part) => typeof part === "object" && part.kind === "identifier" && part.value === agentsPath)
    );

    expect(warningItem).toBeDefined();
    expect(warningItem?.slice(0, -1)).toEqual([
      "Antigravity project surface cannot host Context: ",
      { kind: "identifier", value: agentsPath },
      " is a file, not a directory",
    ]);
  });
});

describe("example apply authoring handoff (issue #456, US-040, DEC-024, TEST-015)", () => {
  const exampleProfile = AUTHORING_EXAMPLES.profile.id;

  /** An apply receipt whose committed work installs one Profile's outputs. */
  const installedReceipt = (profile: string) => emptyReport({
    desired: [{
      canonicalProject: "/project-a",
      context: "composed",
      outputs: ["a.md"],
      profile,
      project: "/project-a",
      resolvedArtifacts: [],
    }],
    items: [{ kind: "addition", project: "/project-a" }],
    outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
  });

  /** An apply receipt that refreshed already-installed outputs (routine). */
  const refreshedReceipt = (profile: string) => emptyReport({
    desired: [{
      canonicalProject: "/project-a",
      context: "composed",
      outputs: ["a.md"],
      profile,
      project: "/project-a",
      resolvedArtifacts: [],
    }],
    items: [{ kind: "update", project: "/project-a" }],
    outputs: [{ kind: "update", driftKind: "changed", path: "a.md", project: "/project-a" }],
  });

  /** Every atomic `apkit new …` command part carried by the document, in order. */
  const handoffCommands = (document: PresentationDocument): readonly string[] =>
    flattenPresentationNodes(document)
      .flatMap((node) => "parts" in node && Array.isArray(node.parts) ? node.parts : [])
      .filter((part): part is CommandPart => typeof part === "object" && part.kind === "command")
      .map((part) =>
        [part.program, ...part.args.filter((arg) => arg.kind === "text").map((arg) => arg.value)].join(" ")
      )
      .filter((command) => command.startsWith("apkit new "));

  test("an update that installed the scaffolded example ends with the authoring handoff", () => {
    const document = applyReportDocument(applyResult(installedReceipt(exampleProfile), emptyReport()));
    const commands = handoffCommands(document);
    // The handoff teaches the three predecessor authoring kinds: the Skill,
    // the Context Module, and the Profile selecting them. Piece scaffolds
    // precede the Profile that selects them.
    expect(commands).toHaveLength(3);
    expect(commands[0]).toBe("apkit new skill <skill>");
    expect(commands[1]).toBe("apkit new context <context>");
    expect(commands[2]).toBe("apkit new profile <profile> --context <context> --skill <skill>");
    // The handoff is the closing section of the view.
    const nodes = flattenPresentationNodes(document);
    const lastHeading = nodes.map((node) => node.kind === "heading" ? nodeText(node) : "").filter(Boolean).at(-1);
    expect(lastHeading).toContain("author");
    // Each command is one atomic command part, so the renderer never splits it
    // (copyable as printed): a fragmented command could not reconstruct the
    // full spelling, so the three exact spellings above prove atomicity.
  });

  test("the handoff also closes the verbose update view under the same condition", () => {
    const document = applyReportDocument(
      applyResult(installedReceipt(exampleProfile), emptyReport()),
      { verbose: true },
    );
    expect(handoffCommands(document)).toHaveLength(3);
  });

  test("adding a Host to an installed example omits the handoff (INT-1)", () => {
    // Routine maintenance of an already-installed example: the pre-apply state
    // proves an existing installation (`update`) even though this apply adds
    // the new Host's outputs. Adding a second Host to the installed example
    // must not repeat the first-run teaching.
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md", "b.md"],
        profile: exampleProfile,
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [
        { kind: "unchanged", path: "a.md", project: "/project-a" },
        { kind: "addition", path: "b.md", project: "/project-a" },
      ],
    });
    for (const options of [{}, { verbose: true }] as const) {
      const document = applyReportDocument(applyResult(receipt, emptyReport()), options);
      expect(handoffCommands(document)).toEqual([]);
    }
  });

  test("a routine update that refreshed the installed example omits the handoff", () => {
    for (const options of [{}, { verbose: true }] as const) {
      const document = applyReportDocument(
        applyResult(refreshedReceipt(exampleProfile), emptyReport()),
        options,
      );
      expect(handoffCommands(document)).toEqual([]);
    }
  });

  test("a no-op update of the example omits the handoff", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: exampleProfile,
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    const document = applyReportDocument(applyResult(receipt, receipt));
    expect(handoffCommands(document)).toEqual([]);
  });

  test("an update that installed a user-authored Profile omits the handoff", () => {
    const document = applyReportDocument(applyResult(installedReceipt("coding"), emptyReport()));
    expect(handoffCommands(document)).toEqual([]);
  });

  test("a mixed fleet handoff fires on the example addition and omits neither other evidence", () => {
    // One Project installs the example; another installs authored material.
    const receipt = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a.md"],
          profile: exampleProfile,
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
        { kind: "addition", project: "/project-a" },
        { kind: "addition", project: "/project-b" },
      ],
      outputs: [
        { kind: "addition", path: "a.md", project: "/project-a" },
        { kind: "addition", path: "b.md", project: "/project-b" },
      ],
    });
    const document = applyReportDocument(applyResult(receipt, emptyReport()));
    expect(handoffCommands(document)).toHaveLength(3);
  });
});

describe("Host-loading optional check and next-use instruction (US-012, ADR-0043, OOS-001)", () => {
  /** A changed apply receipt that installed or refreshed one Profile's outputs. */
  const changedApply = (
    profile: string,
    hosts: readonly SupportedHost[] = ["codex"],
    projects: readonly string[] = ["/project-a"],
  ) => {
    const receipt = emptyReport({
      desired: projects.map((project) => ({
        canonicalProject: project,
        context: "composed",
        hosts,
        outputs: ["a.md"],
        profile,
        project,
        resolvedArtifacts: [],
      })),
      items: projects.map((project) => ({ kind: "addition" as const, project })),
      outputs: projects.map((project) => ({ kind: "addition" as const, path: "a.md", project })),
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: projects.map((project) => ({ kind: "current" as const, project })),
      outputs: projects.map((project) => ({ kind: "unchanged" as const, path: "a.md", project })),
    });
    return applyResult(receipt, resultingState);
  };

  /** Every prose line of the document that carries the optional check. */
  const verificationLines = (document: PresentationDocument): readonly string[] =>
    flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose" && nodeText(node).startsWith("Optional check: "))
      .map((line) => nodeText(line));

  test("a first delivery offers one short optional check on the stable Project path", () => {
    const document = applyReportDocument(changedApply("coding"));
    const lines = verificationLines(document);
    expect(lines).toHaveLength(1);
    const instruction = lines[0];
    // One short optional action: name the newly delivering Host and the
    // Project, and ask what material loaded — no unverifiable appearance
    // claim (OOS-001).
    expect(instruction).toBe(
      "Optional check: start a new Codex session in /project-a and ask what Profile material it loaded.",
    );
    expect(instruction).not.toContain("installed material should appear");
    expect(instruction).not.toContain("Agent Profile Kit");
    expect(instruction).not.toContain("loaded Profile");
  });

  test("the next-use instruction is an action and never claims a Host will load", () => {
    const document = applyReportDocument(changedApply("coding"));
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "prose" &&
      nodeText(node) === "Start a new agent session from the Project root to use the updated material."
    )).toBe(true);
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "prose" && nodeText(node).includes("will load the next time")
    )).toBe(false);
  });

  test("a routine update that refreshes already-delivered Host outputs omits the check (US-012, #515)", () => {
    // An ordinary repeated content update: the receipt proves an update or
    // repair of outputs the Host already consumed, never a first delivery.
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["codex"],
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
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    const document = applyReportDocument(applyResult(receipt, resultingState));
    expect(verificationLines(document)).toEqual([]);
    // The short next-use instruction remains the committed update's closing
    // guidance.
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "prose" &&
      nodeText(node) === "Start a new agent session from the Project root to use the updated material."
    )).toBe(true);
  });

  test("a content update that adds a file for an already-delivering Host omits the check (US-012, #515)", () => {
    // The receipt proves an addition consumed by codex, but codex already
    // delivered prior output in this Project, so this is not a first delivery.
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["codex"],
        outputs: ["a.md", "b.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "stale source", project: "/project-a" }],
      outputs: [
        { kind: "update", path: "a.md", project: "/project-a" },
        { kind: "addition", path: "b.md", project: "/project-a" },
      ],
      outputConsumers: [
        { consumingHosts: ["codex"], path: "a.md", project: "/project-a" },
        { consumingHosts: ["codex"], path: "b.md", project: "/project-a" },
      ],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [
        { kind: "unchanged", path: "a.md", project: "/project-a" },
        { kind: "unchanged", path: "b.md", project: "/project-a" },
      ],
      outputConsumers: [
        { consumingHosts: ["codex"], path: "a.md", project: "/project-a" },
        { consumingHosts: ["codex"], path: "b.md", project: "/project-a" },
      ],
    });
    expect(verificationLines(applyReportDocument(applyResult(receipt, resultingState)))).toEqual([]);
  });

  test("the check names only the Hosts whose delivery began (US-012)", () => {
    // The fleet Host-addition pattern: the Project's installation is not an
    // addition; codex is refreshed while pi receives its first outputs.
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["codex", "pi"],
        outputs: [".agent-profile-kit/codex/context.md", ".pi/APPEND_SYSTEM.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "stale source", project: "/project-a" }],
      outputs: [
        { kind: "update", path: ".agent-profile-kit/codex/context.md", project: "/project-a" },
        { kind: "addition", path: ".pi/APPEND_SYSTEM.md", project: "/project-a" },
      ],
      outputConsumers: [
        { consumingHosts: ["codex"], path: ".agent-profile-kit/codex/context.md", project: "/project-a" },
        { consumingHosts: ["pi"], path: ".pi/APPEND_SYSTEM.md", project: "/project-a" },
      ],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [
        { kind: "unchanged", path: ".agent-profile-kit/codex/context.md", project: "/project-a" },
        { kind: "unchanged", path: ".pi/APPEND_SYSTEM.md", project: "/project-a" },
      ],
      outputConsumers: [
        { consumingHosts: ["codex"], path: ".agent-profile-kit/codex/context.md", project: "/project-a" },
        { consumingHosts: ["pi"], path: ".pi/APPEND_SYSTEM.md", project: "/project-a" },
      ],
    });
    const instruction = verificationLines(applyReportDocument(applyResult(receipt, resultingState)))[0];
    expect(instruction).toBe(
      "Optional check: start a new Pi session in /project-a and ask what Profile material it loaded.",
    );
    expect(instruction).not.toContain("Codex");
  });

  test("a first delivery for several Hosts names those Hosts in canonical order", () => {
    // Fixture order is deliberately non-canonical.
    const document = applyReportDocument(changedApply("coding", ["codex", "claude"]));
    const instruction = verificationLines(document)[0];
    expect(instruction).toBe(
      "Optional check: start new Claude and Codex sessions in /project-a and ask what Profile material each loaded.",
    );
  });

  test("a multi-Project update pairs the distributive form with 'each loaded' (INT-2)", () => {
    const document = applyReportDocument(changedApply("coding", ["codex"], ["/project-a", "/project-b"]));
    const instruction = verificationLines(document)[0];
    expect(instruction).toBe(
      "Optional check: start a new Codex session in each updated Project and ask what Profile material each loaded.",
    );
    expect(instruction).not.toContain("/project-a");
    expect(instruction).not.toContain("/project-b");
    expect(instruction).not.toContain("it loaded");
  });

  test("a no-op update omits the check", () => {
    const receipt = emptyReport({
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
    expect(verificationLines(applyReportDocument(applyResult(receipt, receipt)))).toEqual([]);
  });

  test("a blocked update omits the check", () => {
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
    expect(verificationLines(blockedApplyReportDocument(asBlockedReport(report)))).toEqual([]);
  });

  test("the verbose update view closes with the same check", () => {
    const document = applyReportDocument(changedApply("coding"), { verbose: true });
    const lines = verificationLines(document);
    expect(lines).toHaveLength(1);
  });

  test("the Project path is one atomic part, whole at narrow width (ADR-0016)", () => {
    // A Project path containing whitespace must survive wrapping and keep its
    // repeated spaces: the identity is an atomic path part, never plain text
    // the renderer may split or normalize (INT-2, ADR-0016).
    const spaced = "/projects/My Demo Space/project one  two";
    const document = applyReportDocument(changedApply("coding", ["codex"], [spaced]));
    const trailing = flattenPresentationNodes(document).find((node) =>
      node.kind === "prose" && nodeText(node).startsWith("Optional check: ")
    );
    expect(trailing).toMatchObject({ kind: "prose" });
    const trailingParts = trailing?.kind === "prose" ? trailing.parts : [];
    expect(trailingParts).toEqual([
      "Optional check: start a new Codex session in ",
      expect.objectContaining({ kind: "path", canonicalPath: spaced }),
      " and ask what Profile material it loaded.",
    ]);
    for (const width of [40, 100]) {
      // Render the check node in isolation: the Apply Receipt's Project
      // attribution above may also mention the path, which is not this node.
      const rendered = renderBoundary(
        trailing === undefined ? [] : [trailing],
        context(width),
      );
      // The whole identity — including its repeated spaces — sits on one
      // line; a split or normalized value would not match the full string.
      const pathLines = rendered.split("\n").filter((line) =>
        line.includes("project one  two")
      );
      expect(pathLines).toHaveLength(1);
    }
  });

  test("the check is a stable action path, not a scanning alias (US-006, #647)", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-check-home-"));
    try {
      const project = join(home, "projects", "demo");
      const document = applyReportDocument(changedApply("coding", ["codex"], [project]));
      const rendered = renderPresentationDocument(document, defaultRenderContext, {
        home,
        cwd: home,
      });
      expect(rendered).toContain("Optional check: start a new Codex session in ~/projects/demo");
      expect(rendered).not.toContain("session in demo ");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the check precedes the first-run authoring handoff, which still closes the view", () => {
    // Cross-ticket coherence with #456 (US-040): one closing frame — optional
    // check, then author real material — with no duplicated teaching.
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: AUTHORING_EXAMPLES.profile.id,
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const document = applyReportDocument(
      applyResult(
        receipt,
        emptyReport({
          desired: reportDesired(receipt),
          items: [{ kind: "current", project: "/project-a" }],
        }),
      ),
    );
    const nodes = flattenPresentationNodes(document);
    const checkIndex = nodes.findIndex((node) =>
      node.kind === "prose" && nodeText(node).startsWith("Optional check: ")
    );
    const handoffIndex = nodes.findIndex((node) => node.kind === "heading" && nodeText(node) === "Now author your own:");
    expect(checkIndex).toBeGreaterThan(-1);
    expect(handoffIndex).toBeGreaterThan(checkIndex);
    expect(nodes.at(-1)).toMatchObject({
      kind: "sentence",
      category: "command",
    });
  });
});

describe("install Host Setup Steps on the receipt (US-012, DEC-009)", () => {
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
  const sharedPath = (): HostSetupStep => ({
    host: "grok",
    kind: "shared-path",
    message: "Grok uses Claude's shared rule path.",
    provenance: "standing",
  });

  const installReports = (setupSteps: readonly HostSetupStep[], hosts: readonly SupportedHost[] = ["codex"]) => {
    const desired = [{
      canonicalProject: "/project-a",
      context: "composed" as const,
      hosts,
      outputs: ["a.md"],
      profile: "coding",
      project: "/project-a",
      resolvedArtifacts: [],
      setupSteps,
    }];
    const receipt = emptyReport({
      desired,
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: hookPath, project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired,
      items: [{ kind: "current", project: "/project-a" }],
    });
    return { receipt, resultingState };
  };

  test("a first install surfaces relevant required Adapter-authored steps as First use", () => {
    const { receipt, resultingState } = installReports([hookApproval(), codexTrust(), sharedPath()]);
    const nodes = installHostSetupNodes(resultingState, receipt, ["codex", "grok"]);
    const flattened = flattenPresentationNodes(nodes);
    const firstUse = indexWhere(flattened, (node) => node.kind === "heading" && nodeText(node) === "First use:");
    expect(firstUse).toBeGreaterThan(-1);
    expect(listItemsFrom(flattened, firstUse + 1)).toEqual([
      expect.stringContaining("Review and approve the generated SessionStart hook when Codex asks"),
      expect.stringContaining("Trust the bound project in Codex"),
    ]);
    // Shared-path stays out of the concise receipt; longer explanation is
    // focused guidance and verbose/JSON evidence.
    expect(listItemsIn(nodes).some((text) => text.includes("shared rule path"))).toBe(false);
    // Adapter text is presented through the concise rewriter; the unshortened
    // consequence is not dumped on the default receipt.
    expect(documentText(nodes)).not.toContain("Declining the hook prevents Profile Context from loading.");
  });

  test("steps for Hosts outside the installed selection never appear", () => {
    const { receipt, resultingState } = installReports([hookApproval(), codexTrust(), sharedPath()]);
    const nodes = installHostSetupNodes(resultingState, receipt, ["claude"]);
    expect(headingsIn(nodes)).not.toContain("First use:");
  });

  test("an unchanged install renders no First use section", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["codex"],
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [codexTrust()],
      }],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    const nodes = installHostSetupNodes(receipt, receipt, ["codex"]);
    expect(headingsIn(nodes)).not.toContain("First use:");
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

  test("keeps a bound-project setup instruction's stable path inside the working directory", () => {
    // A Host setup instruction names an exact location to act on, so it keeps
    // the stable path even when the Project root sits inside the working
    // directory and a scanning label would be shorter (US-013, ADR-0042).
    const project = join(process.cwd(), "scratch-setup-project");
    const document = temporaryInstallationDocument(
      "install-temp",
      receiptFixture(project, [{
        host: "codex",
        kind: "launch-constraint",
        message: "Launch Codex from the exact bound project root:",
        path: "bound-project",
        provenance: "standing",
      }]),
    );

    const step = listPartsIn(document).find((item) =>
      flatInlineText(item).startsWith("Launch Codex from")
    )!;
    const instruction = flatInlineText(step).replace(
      "Launch Codex from the exact bound project root: ",
      "",
    );
    // The stable spelling (home-relative or absolute), never the bare name.
    expect(instruction).toContain("/");
    expect(instruction).toContain(basename(project));
    expect(instruction).not.toBe(basename(project));
  });

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

      const step = listPartsIn(document).find((item) =>
        flatInlineText(item).startsWith("Launch Codex from")
      )!;
      const stepText = flatInlineText(step);
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
        { color: false, interactive: false, width: 10_000 , rows: undefined },
        { cwd: process.cwd(), home },
      );
      expect(rendered).not.toContain(project);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

function expectUserFacingVocabulary(view: string, options?: { allowMachineHost?: boolean }): void {
  for (const term of INTERNAL_ONLY_DEFAULT_TERMS) {
    if (options?.allowMachineHost && (term.source === "\\bAgent Hosts?\\b" || term.source === "\\bHosts?\\b")) {
      continue;
    }
    expect(view).not.toMatch(term);
  }
}

/** Concise ownership evidence has problem, requirement, remedy, scope and
 * group heading, followed by one prose node per immediate-parent group.
 * Read the group structure without parsing labels, counts or indentation. */
function trackedPathGroups(document: PresentationDocument): PresentationNode[] {
  const nodes = flattenPresentationNodes(document);
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
  const applied = nodes.findIndex((node) => node.kind === "heading" && node.text === "Updated:");
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

    for (const command of ["status", "update"] as const) {
      const document = command === "update"
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
    expect(flattenPresentationNodes(document).filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(1);
    const machine = machineReport([
      machineProject("/project-a", { blockers: reportBlockers(structured) }),
    ]);
    expect(JSON.parse(formatLifecycleJson("status", machine))).toMatchObject({
      schemaVersion: 16,
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
            "regular directory inside the Project yourself, then run apkit update " +
            "'/project-a'; or run apkit uninstall --project '/project-a' to remove its generated files and stop managing this Project.",
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
    expect(inlineCommandTexts([nodes[blockerIndex + 2]!])).toContain("apkit update '/project-a'");
    expect(inlineCommandTexts([nodes[blockerIndex + 2]!])).toContain("apkit uninstall --project '/project-a'");
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
      { color: false, interactive: true, width: 40 , rows: undefined },
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
      node.kind === "row" || (node.kind === "prose" && nodeText(node).includes("project-a")));
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

  test("verbose status prints one copyable untracking command with every proven path exactly once (#353)", () => {
    const paths = [
      ".b/space name.md",
      ".a/one.md",
      "-leading-dash.md",
      "weird'name.md",
    ];
    const verbose = lifecycleStatusDocument(ownershipReport(paths), {
      verbose: true,
    });

    const gitCommands = inlineCommandTexts(flattenPresentationNodes(verbose)).filter((text) =>
      text.includes("rm -r --cached"));
    expect(gitCommands).toHaveLength(1);
    // The remedy carries the exact invocation as one atomic command part;
    // every proven path appears once as its own quoted argument (#440).
    expect(gitCommands[0]).toBe(untrackCommandFor("/project-a", paths));
    expect(gitCommands[0]).toContain("git --literal-pathspecs -C '/project-a' rm -r --cached --");
    expect(gitCommands[0]).toContain("-- '-leading-dash.md'");
    expect(gitCommands[0]).toContain("'weird'\\''name.md'");
  });

  test("the verbose remedy frames the working-files statement and the uninstall choice (#440)", () => {
    const verbose = lifecycleStatusDocument(
      ownershipReport([".codex/hooks.json"]),
      { verbose: true },
    );
    const remedyParts = flattenPresentationNodes(verbose)
      .filter((node) => node.kind === "prose" &&
        nodeText(node).startsWith("  Remedy: "))
      .map((node) => nodeText(node));
    expect(remedyParts).toHaveLength(1);
    expect(remedyParts[0]).toContain("stages their removal from the Git index");
    expect(remedyParts[0]).toContain("the files stay on disk");
    expect(remedyParts[0]).toContain("To keep Git ownership instead");
  });

  test("ordinary concise and verbose views carry the command (#440)", () => {
    const report = ownershipReport([".codex/hooks.json", ".agents/skills/s01.md"]);
    const concise = lifecycleStatusDocument(report);
    const verbose = lifecycleStatusDocument(report, { verbose: true });

    for (const document of [concise, verbose]) {
      expect(inlineCommandTexts(flattenPresentationNodes(document))).toContain(
        untrackCommandFor("/project-a", [".agents/skills/s01.md", ".codex/hooks.json"]),
      );
      // The verbose pointer redirect is retired.
      expect(proseTexts(document).join("\n"))
        .not.toContain("to see the exact untracking command");
    }
  });

  test("blocked and failed update verbose views print the evidence-derived command (#353)", () => {
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

    const verboseApply = applyReportDocument(
      applyResult(receipt, resultingState),
      { verbose: true },
    );
    // Every apply view carries the evidence-derived command inline (#440).
    expect(inlineCommandTexts(flattenPresentationNodes(verboseApply))).toContain(command);

    const blockedApply = blockedApplyReportDocument(
      asBlockedReport(resultingState),
      { verbose: true },
    );
    expect(inlineCommandTexts(flattenPresentationNodes(blockedApply))).toContain(command);
  });

  test("verification-failure verbose view carries the command (#440)", () => {
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

    const verbose = lifecycleStatusDocument(ownershipReport(paths), {
      verbose: true,
    });
    const gitCommands = inlineCommandTexts(flattenPresentationNodes(verbose)).filter((text) =>
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
    const verbose = lifecycleStatusDocument(ownershipReport(paths), {
      verbose: true,
    });
    const command = untrackCommandFor("/project-a", paths);

    // The atomic command node renders on one unsplit line at any width.
    const rendered = renderBoundary(verbose, { color: false, interactive: true, width: 40 , rows: undefined });
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

  test("names the working-directory project by its stable identity, never a dot alias", () => {
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
    const stable = project === homedir()
      ? "~"
      : project.startsWith(`${homedir()}/`)
      ? `~/${project.slice(homedir().length + 1)}`
      : project;
    // Requested details expose the full stable path, never the cwd alias.
    expect(inlineIdentifiers([nodes[projectsIndex + 1]!])).toEqual([stable]);
    expect(inlineIdentifiers([nodes[projectsIndex + 1]!])).not.toEqual(["."]);
  });

  test("names an ancestor project by its stable identity, never a parent alias", () => {
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
    const stable = project === homedir()
      ? "~"
      : project.startsWith(`${homedir()}/`)
      ? `~/${project.slice(homedir().length + 1)}`
      : project;
    expect(inlineIdentifiers([nodes[projectsIndex + 1]!])).toEqual([stable]);
    expect(inlineIdentifiers([nodes[projectsIndex + 1]!])).not.toEqual([".."]);
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
        ": not installed yet",
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

  test("keeps canonical paths short through symlinked home without a working-directory alias", () => {
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
      expect(displayPath(canonicalProject, canonicalProject, "project", logicalCwd, logicalHome)).toBe(
        "~/projects/project",
      );
    } finally {
      rmSync(logicalHome, { force: true });
      rmSync(physicalHome, { force: true, recursive: true });
    }
  });

  test("workspaceSubfolderDisplay names the actual Workspace's skills/ and context/ folders (INT-2)", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-subfolder-"));
    try {
      const workspace = join(home, "my-kit");
      // A Workspace under home displays home-relative with a trailing slash.
      expect(workspaceSubfolderDisplay(workspace, "skills", "~/my-kit", workspace, home))
        .toBe("~/my-kit/skills/");
      expect(workspaceSubfolderDisplay(workspace, "context", "~/my-kit", workspace, home))
        .toBe("~/my-kit/context/");
      // A trailing-slash authored spelling keeps the subfolder single.
      expect(workspaceSubfolderDisplay(workspace, "skills", "~/my-kit/", workspace, home))
        .toBe("~/my-kit/skills/");
      // The Workspace folder itself is home: fleet displays `~`, so the
      // subfolder hangs directly off it.
      expect(workspaceSubfolderDisplay(home, "skills", "~", home, home)).toBe("~/skills/");
      // The fleet scope never returns `.` or an empty string: a relative
      // authored spelling resolves through the canonical path instead.
      const resolvedWorkspace = join(home, "resolved-kit");
      expect(workspaceSubfolderDisplay(resolvedWorkspace, "skills", "./resolved-kit", workspace, home))
        .toBe("~/resolved-kit/skills/");
      // A Workspace outside home displays absolute.
      const outside = join(home, "..", "outside-kit");
      expect(workspaceSubfolderDisplay(outside, "context", outside, workspace, home))
        .toBe(`${outside}/context/`);
      // The filesystem-root edge: fleet displays `/`, whose trailing-slash
      // trim leaves the subfolder alone.
      expect(workspaceSubfolderDisplay("/", "skills", "/", "/", home)).toBe("skills/");
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("names a Project root by its stable home-relative identity instead of a cwd alias", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-display-scope-"));
    try {
      const project = join(home, "projects", "alpha");
      mkdirSync(join(project, "nested"), { recursive: true });
      const nested = join(project, "nested");

      // A Project root is never named by the cwd-relative alias `.` or `..`
      // (US-013): only a location strictly inside the working directory keeps
      // a short relative spelling.
      expect(displayPath(project, project, "project", project, home)).toBe("~/projects/alpha");
      expect(displayPath(project, project, "project", nested, home)).toBe("~/projects/alpha");
      expect(displayPath(project, project, "fleet", project, home)).toBe("~/projects/alpha");
      expect(displayPath(project, project, "fleet", nested, home)).toBe("~/projects/alpha");
      expect(displayProjectPath(project, project, "fleet", project, home)).toBe(
        "~/projects/alpha",
      );
      expect(displayProjectPath(project, project, "project", project, home)).toBe("~/projects/alpha");
      for (const relativePath of [".", "..", "../alpha"]) {
        expect(displayPath(relativePath, relativePath, "fleet", project, home)).toBe(
          `relative path ${JSON.stringify(relativePath)}`,
        );
      }
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("the verbose apply receipt names committed paths under the short project identity", () => {
    const project = join(homedir(), "receipt-project");
    const receipt = identityReport(project);

    // The concise receipt states the impact count only; committed paths and
    // Project identities remain verbose evidence (US-011, DEC-007).
    const concise = applyReportDocument(applyResult(receipt, emptyReport()));
    expect(headingsIn(concise)).not.toContain("Updated:");
    expect(flattenPresentationNodes(concise).map(nodeText))
      .toContain("Updated 1 Project (1 generated file).");
    expect(flattenPresentationNodes(concise).some((node) =>
      node.kind === "prose" && nodeText(node).includes("receipt-project")
    )).toBe(false);

    // Verbose receipt opens with the Applied section in Projects detail.
    const verbose = applyReportDocument(applyResult(receipt, emptyReport()), { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Updated:");
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
    expect(identityStateLine("~/receipt-project/a.md", "addition (source changed)")).toBe(true);
  });

  test("the concise fleet apply receipt states affected Project and changed-file counts once", () => {
    const additionProjects = ["/project-alpha", "/project-beta", "/project-gamma", "/project-delta", "/project-epsilon"];
    const updateProject = "/project-zeta";
    const receipt = emptyReport({
      desired: [
        ...additionProjects.map((project) => ({
          canonicalProject: project,
          context: "composed",
          outputs: ["one.md", "two.md", "three.md"],
          profile: "coding",
          project,
          resolvedArtifacts: [],
        })),
        {
          canonicalProject: updateProject,
          context: "composed",
          outputs: ["single.md"],
          profile: "coding",
          project: updateProject,
          resolvedArtifacts: [],
        },
      ],
      items: [
        ...additionProjects.map((project) => ({ kind: "addition" as const, project })),
        { kind: "update" as const, project: updateProject },
      ],
      outputs: [
        ...additionProjects.flatMap((project) =>
          ["one.md", "two.md", "three.md"].map((path) => ({
            kind: "addition" as const,
            path,
            project,
          }))),
        { kind: "update" as const, path: "single.md", project: updateProject },
      ],
    });

    const document = applyReportDocument(applyResult(receipt, emptyReport()));
    const texts = flattenPresentationNodes(document).map(nodeText);

    // The receipt states the affected Project and changed-file counts once
    // (US-011, DEC-007).
    expect(texts.filter((text) => text === "Updated 6 Projects (16 generated files)."))
      .toHaveLength(1);

    // No per-file, per-Project, per-operation, or Profile inventory in the
    // default receipt (US-011, DEC-007).
    expect(texts.filter((text) => /^[+~-] /.test(text.trim()))).toEqual([]);
    expect(texts.some((text) => text.includes("generated file additions in"))).toBe(false);
    expect(headingsIn(document)).not.toContain("Updated:");
    for (const project of [...additionProjects, updateProject]) {
      expect(texts.some((text) => text.includes(project))).toBe(false);
    }
  });

  test("the concise single-Project apply receipt omits the per-file inventory", () => {
    const paths = Array.from({ length: 12 }, (_, index) => `file-${String(index + 1).padStart(2, "0")}.md`);
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: paths,
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: paths.map((path) => ({ kind: "addition" as const, path, project: "/project-a" })),
    });

    const texts = flattenPresentationNodes(applyReportDocument(applyResult(receipt, emptyReport())))
      .map(nodeText);
    expect(texts).toContain("Updated 1 Project (12 generated files).");
    expect(texts.filter((text) => text.trim().startsWith("+ "))).toEqual([]);
  });

  test("the concise apply receipt keeps approved changed-file identities as exceptions", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md", "b.md", "c.md", "d.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [
        { driftKind: "changed", kind: "update", path: "a.md", project: "/project-a" },
        { driftKind: "changed", kind: "removal", path: "c.md", project: "/project-a" },
        { kind: "update", path: "b.md", project: "/project-a" },
        { kind: "removal", path: "d.md", project: "/project-a" },
      ],
    });

    const document = applyReportDocument(applyResult(receipt, emptyReport()));
    const texts = flattenPresentationNodes(document).map(nodeText);

    // Routine committed work stays a count; the approved changed-file
    // replacement and deletion keep their actionable identities (US-011).
    expect(texts).toContain("Updated 1 Project (4 generated files).");
    expect(headingsIn(document)).toContain("Replaced changed generated files:");
    expect(texts).toContain("  ~ a.md (/project-a)");
    expect(headingsIn(document)).toContain("Removed changed generated files:");
    expect(texts).toContain("  - c.md (/project-a)");
    expect(texts.some((text) => text.includes("b.md") || text.includes("d.md"))).toBe(false);
  });

  test("the verification-failure receipt names its Project by the same view identity as its exceptions", () => {
    // Non-verbose verification failure: the receipt exceptions and the
    // document's other Project references must agree on this view's identity
    // (US-013; CRAFT-7), rather than one showing the full stable path.
    const project = join(homedir(), "verify", "project");
    const receipt = emptyReport({
      desired: [{
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      }],
      items: [{ kind: "update", project }],
      outputs: [{ driftKind: "changed", kind: "update", path: "a.md", project }],
    });

    const document = applyVerificationFailureDocument(receipt, "Verification failed.");
    const texts = flattenPresentationNodes(document).map(nodeText);

    expect(headingsIn(document)).toContain("Replaced changed generated files:");
    expect(texts).toContain("  ~ a.md (project)");
    expect(texts.some((text) => text.includes("(~/verify/project)"))).toBe(false);
  });

  test("a receipt-proven input or installation-record change with no file changes still states the impact", () => {
    for (const project of [
      // A new desired-input digest with every projection byte-identical.
      machineProject("/project-a", {
        state: { kind: "stale source" },
        sourceInputChanged: true,
        outputs: [{ consumingHosts: [], kind: "unchanged", path: "a.md" }],
      }),
      // An installation-record update with every projection byte-identical.
      machineProject("/project-a", {
        state: { kind: "update" },
        outputs: [
          { consumingHosts: [], kind: "unchanged", path: "a.md" },
          { consumingHosts: [], kind: "unchanged", path: "b.md" },
        ],
      }),
    ]) {
      const document = applyReportDocument(applyResult(machineReport([project]), emptyReport()));
      const texts = flattenPresentationNodes(document).map(nodeText);

      // The receipt proves committed work; every projection stayed
      // byte-identical, so the file count is truthfully zero while the
      // affected Project is still stated once (US-011, ADR-0040).
      expect(texts).toContain("Updated 1 Project (0 generated files).");
      expect(texts.some((text) => text.includes("a.md"))).toBe(false);
    }
  });

  test("committed exclusion bookkeeping counts its affected Project without printing the delta", () => {
    const receipt = emptyReport({
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
      repositoryExclusions: [{
        current: [],
        installed: false,
        next: ["/.agent-profile-kit/codex/context.md"],
        target: "/project-a/.git/info/exclude",
      }],
    });

    const document = applyReportDocument(applyResult(receipt, emptyReport()));
    const texts = flattenPresentationNodes(document).map(nodeText);

    expect(texts).toContain("Updated 1 Project (0 generated files).");
    // Routine Git exclusion bookkeeping stays out of the default view.
    expect(texts.some((text) => text.includes(".git/info/exclude"))).toBe(false);
  });

  test("the verbose apply receipt retains the complete operation inventory", () => {
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md", "b.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [
        { kind: "update", path: "a.md", project: "/project-a" },
        { kind: "update", path: "b.md", project: "/project-a" },
      ],
    });

    const verbose = applyReportDocument(applyResult(receipt, emptyReport()), { verbose: true });
    const texts = flattenPresentationNodes(verbose).map(nodeText);
    expect(headingsIn(verbose)).toContain("Updated:");
    expect(texts).toContain("/project-a/a.md: update (source changed)");
    expect(texts).toContain("/project-a/b.md: update (source changed)");
  });

  test("the partial-failure apply receipt summarizes committed work and retains the failure identity", () => {
    const paths = Array.from({ length: 12 }, (_, index) => `file-${String(index + 1).padStart(2, "0")}.md`);
    const receipt = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: paths,
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: paths.map((path) => ({ kind: "addition" as const, path, project: "/project-a" })),
    });

    const document = applyExecutionFailureDocument({
      detail: "the write failed",
      failedProject: executionProject("/project-b"),
      message: "Apply failed at /project-b: the write failed",
      pendingProjects: [executionProject("/project-b")],
      receipt,
      resultingState: undefined,
    });
    const texts = flattenPresentationNodes(document).map(nodeText);
    // Committed work is summarized once; the failed Project keeps its identity.
    expect(texts).toContain("Updated 1 Project (12 generated files).");
    expect(texts.filter((text) => text.trim().startsWith("+ "))).toEqual([]);
    expect(texts.some((text) => text.includes("/project-b"))).toBe(true);
  });

  test("labels remaining and committed update work distinctly", () => {
    const receipt = identityReport("/project-a");
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    // Successful changed apply: compact impact statement, no already-current
    // statement, no status-style Changes summary.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    const conciseNodes = flattenPresentationNodes(concise);
    expect(conciseNodes.map(nodeText)).toContain("Updated 1 Project (1 generated file).");
    expect(headingsIn(concise)).not.toContain("Updated:");
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
    const applied = indexWhere(verboseNodes, (node) => node.kind === "heading" && nodeText(node) === "Updated:");
    expect(pending).toBeGreaterThan(-1);
    expect(applied).toBeGreaterThan(pending);
    expect(verboseNodes.some((node) =>
      node.kind === "heading" && (nodeText(node) === "Resulting state:" || nodeText(node) === "Apply receipt:")
    )).toBe(false);
  });

  test("names the Hosts recorded by each Project Binding in project inventory", () => {
    const project = join(homedir(), "multi-host-project");
    const report = identityReport(project, ["claude", "codex"]);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    expect(headingsIn(verbose)).not.toContain("Selected setup:");

    const inventory = projectInventoryDocument([{
      canonicalProject: project,
      hosts: ["claude", "codex"],
      problem: null,
      profile: "coding",
      project,
    }], homedir(), homedir());
    const inventoryNodes = flattenPresentationNodes(inventory);
    expect(inventoryNodes.some((node) => nodeText(node).includes("claude, codex"))).toBe(true);
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

  test("renders task-authored update verification failures without semantic translation", () => {
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
    expect(headingsIn(verbose)).toEqual(expect.arrayContaining(["Updated:", "Outputs:"]));
    expect(headingsIn(verbose)).not.toContain("Selected setup:");
    expect(headingsIn(verbose)).not.toContain("Git exclusions:");
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

    // The ready summary is a warning notice; the project is classified under generated files changed.
    expect(noticesIn(concise)).toHaveLength(1);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "warning" });
    const rendered = renderBoundary(concise);
    expect(rendered).toContain("generated files changed");
    expect(rendered).toContain("project-a");
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
        ": addition (source changed)",
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
    expect(renderBoundary(concise)).toContain("generated files changed");

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const verboseNodes = flattenPresentationNodes(verbose);
    const outputLine = (path: string, kind: string) => verboseNodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));
    expect(outputLine("/project-a/skill", "update (source changed)")).toBe(true);
    expect(outputLine("/project-a/context.md", "unchanged")).toBe(false);
  });

  test("keeps every present non-current state definition available in verbose output", () => {
    for (const cause of PRIMARY_CAUSE_ORDER) {
      const label = PRIMARY_CAUSE_LABELS[cause];
      const kind = cause === "not-installed-yet" ? "addition" : cause === "source-changed" ? "stale source" : cause === "generated-files-missing" ? "drifted output" : cause === "generated-files-changed" ? "drifted output" : "blocked";
      const outputs = cause === "generated-files-missing"
        ? [{ consumingHosts: ["codex"], driftKind: "missing" as const, kind: "update" as const, path: "f.md", project: "/solo" }]
        : cause === "generated-files-changed"
        ? [{ consumingHosts: ["codex"], driftKind: "changed" as const, kind: "update" as const, path: "f.md", project: "/solo" }]
        : [];
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
        outputs,
        blockers: kind === "blocked"
          ? [fixtureBlocker("/solo: hooks disabled", "/solo")]
          : [],
      });

      const concise = lifecycleStatusDocument(report);
      expect(headingsIn(concise)).not.toContain("State explanations:");
      const glosses = explanationItems(lifecycleStatusDocument(report, { verbose: true }));
      expect(glosses).toHaveLength(1);
      expect(glosses[0]).toMatch(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .+`));
      expect(glosses[0]!.length).toBeGreaterThan(`${label}: `.length);
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
    expect(conciseText).toContain("needs attention");
    expect(conciseText).toContain("/project-b");
    expect(conciseText).toContain("source changed");
    expect(conciseText).toContain("/project-a");
    expect(proseOccurrences(concise, "/project-b")).toBe(2);
    expect(flattenPresentationNodes(concise).filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(1);
    expect(headingsIn(concise)).not.toContain("State explanations:");
    expect(headingsIn(concise)).not.toContain("Changes:");

    for (const command of ["status", "update"] as const) {
      const verbose = command === "update"
        ? blockedApplyReportDocument(asBlockedReport(report), { verbose: true })
        : lifecycleStatusDocument(report, { verbose: true });
      // The populated Blockers section leads the verbose view, ahead of the
      // Projects detail.
      const nodes = flattenPresentationNodes(verbose);
      const blockersHeading = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Blockers:");
      const projectsHeading = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Projects:");
      expect(blockersHeading).toBeGreaterThan(-1);
      expect(projectsHeading).toBeGreaterThan(blockersHeading);
      expect(nodes.slice(blockersHeading, projectsHeading).flatMap((node) => listItemTexts(node))).toHaveLength(1);
      expect(nodes.some((node) => node.kind === "prose" && nodeText(node).includes("/project-b"))).toBe(true);
    }
  });

  test("orders verbose state definitions stably by PRIMARY_CAUSE_ORDER", () => {
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
    expect(kinds).toEqual(["needs attention", "not installed yet", "source changed"]);
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
    const exclusionItem = listPartsIn(verbose).find((item) => itemIdentifiers(item)[0] === target);
    expect(itemIdentifiers(exclusionItem!)).toEqual([target, "/.agent-profile-kit/codex/context.md", "/.codex/hooks.json", "/.old-path.md"]);
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
        "/repo/.git/info/exclude is missing its Agent Profile Kit exclusion section; update will restore recorded exact entries",
      ],
    });

    const concise = lifecycleStatusDocument(report);
    const conciseTexts = presentationTexts(concise);

    expect(flattenPresentationNodes(concise).filter((node) => node.kind === "prose" && node.category === "error")).toHaveLength(1);
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
        resolvedArtifacts: [{ id: "team-rules", type: "context" }],
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
    expect(noticesIn(verbose)[0]).toMatchObject({ kind: "notice", severity: "warning" });
    const sectionAt = (text: string) => indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === text);
    for (const section of ["Projects:", "Outputs:", "Git exclusions:", "Blockers:", "State explanations:"]) {
      expect(sectionAt(section)).toBeGreaterThan(-1);
    }
    expect(headingsIn(verbose)).not.toContain("Selected setup:");
    expect(headingsIn(verbose)).not.toContain("Warnings:");
    expect(projectStateLines(verbose)).toContain("/project-a");
    const outputLine = (path: string, kind: string) => nodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));
    expect(outputLine("/project-a/.agent-profile-kit/codex/context.md", "update (source changed)")).toBe(true);
    expect(outputLine("/project-a/.codex/hooks.json", "unchanged")).toBe(false);
    const exclusionItem = listPartsIn(verbose).find((item) => itemIdentifiers(item)[0] === "/project-a/.git/info/exclude");
    expect(itemIdentifiers(exclusionItem!)).toEqual(["/project-a/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);
    expect(nodes.some((node) => node.kind === "verbatim")).toBe(false);
    expect(listItemsIn(verbose)).toContain("example warning (/project-a)");
    expect(listItemsIn(verbose).some((text) => text.includes("example blocker"))).toBe(true);
    expect(texts.some((text) => text.includes("/project-a"))).toBe(true);
    expect(texts.some((text) => text.includes("generated-output"))).toBe(false);
  });

  test("verbose update keeps published exclusion guidance in the receipt tense", () => {
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
    expect(listItemIdentities(verbosePending)).toContainEqual(["/repo/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);

    // Concise receipt carries no Git-exclusion clause for this unchanged
    // receipt; the success notice opens the view.
    const concise = applyReportDocument(applyResult(receipt, result));
    expect(headingsIn(concise)).not.toContain("Git exclusions:");
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });

    const verbose = applyReportDocument(applyResult(receipt, result), { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Updated:");
    expect(applied).toBeGreaterThan(-1);
    const exclusions = indexWhere(
      nodes.slice(applied),
      (node) => node.kind === "heading" && nodeText(node) === "Git exclusions:",
    );
    expect(exclusions).toBeGreaterThan(-1);
    expect(listItemIdentities(verbose)).toContainEqual(["/repo/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);
  });

  test("verbose update explains non-current states once across pending and updated sections", () => {
    const receipt = emptyReport({
      items: [{ kind: "stale source", project: "/repo" }],
    });
    const resultingState = emptyReport({
      items: [{ kind: "drifted output", project: "/repo", reason: "a.md" }],
    });

    const verbose = applyReportDocument(applyResult(receipt, resultingState), { verbose: true });
    const nodes = flattenPresentationNodes(verbose);

    // Exactly one State explanations section, listing pending and applied
    // non-current states in canonical order as consecutive list items.
    const sections = nodes.flatMap((node, index) =>
      node.kind === "heading" && nodeText(node) === "State explanations:" ? [index] : []);
    expect(sections).toHaveLength(1);
    expect(listItemsFrom(nodes, sections[0]! + 1)).toHaveLength(2);
  });

  test("update only counts projects with receipt work", () => {
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

    // Receipt work drives the impact statement; Projects without receipt work
    // gain no receipt block.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    expect(flattenPresentationNodes(concise).map(nodeText))
      .toContain("Updated 1 Project (1 generated file).");
    expect(headingsIn(concise)).not.toContain("Updated:");
    expect(keyValuesIn(concise, "Project")).toEqual([]);
  });

  test("verified update blockers change the outcome and preserve a nonzero-worthy state", () => {
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
    expect(nextActionItems(concise).map(nextActionStructure)).toEqual([{ paths: [], commands: ["apkit update"] }]);
  });

  test("execution failures label only updated receipt Projects as freshly current", () => {
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
    // The compact receipt follows the error notice: committed work is
    // summarized once and the message remains the only outcome claim.
    expect(nodes.map(nodeText)).toContain("Updated 1 Project (1 generated file).");
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

/** The list items following the "Next:" heading. */
function nextActionItems(document: PresentationDocument): readonly (readonly InlineContent[])[] {
  const nodes = flattenPresentationNodes(document);
  const start = indexWhere(nodes, (node) =>
    node.kind === "heading" && nodeText(node) === "Next:");
  if (start < 0) return [];
  for (let index = start + 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind === "list") return node.items;
  }
  return [];
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
function nextActionStructure(item: readonly InlineContent[]): {
  readonly paths: readonly { readonly canonicalPath: string; readonly scope: string }[];
  readonly commands: readonly string[];
} {
  return {
    paths: item.flatMap((part) =>
      typeof part === "string" || part.kind !== "path"
        ? []
        : [{ canonicalPath: part.canonicalPath, scope: part.scope }]),
    commands: commandTextsFromParts(item),
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
    expect(nextGuidance(concise)).toEqual(["apkit update"]);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "warning" });
    // The drift detail stays behind the verbose route; no routine path appears.
    expect(presentationTexts(concise).some((text) => text.includes("a.md"))).toBe(false);
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
  });

  test("ready status recommends update", () => {
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
    expect(nextGuidance(concise)).toEqual(["apkit update"]);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "warning" });
  });

  test("blocked status retries status without recommending update", () => {
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
    // The outcome notice is the warning headline; the aggregate Blocker count is the error notice.
    expect(noticesIn(status)[0]).toMatchObject({ kind: "notice", severity: "warning" });
  });

  test("blocked update directs resolve-and-retry of update", () => {
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
      { paths: [], commands: ["apkit update"] },
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

  test("completed or no-op update without blockers emits no next action", () => {
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
    expect(headingsIn(applyReportDocument(applyResult(metadataOnlyReceipt, metadataOnlyResult), { verbose: true }))).toContain("Updated:");
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
    expect(nextGuidance(mixedStatus)).toEqual(["apkit update"]);
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

  test("exclusion-only deltas remain pending work with a direct update action", () => {
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
    expect(noticesIn(status)[0]).toMatchObject({ kind: "notice", severity: "warning" });
    expect(headingsIn(status)).not.toContain("Git exclusions:");
    expect(keyValuesIn(status, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
    expect(nextGuidance(status)).toEqual(["apkit update"]);
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
    expect(shapes(status)).toEqual(["notice", "spacer", "row"]);
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
    expect(payload.schemaVersion).toBe(16);
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
          "remove or restore it yourself, then run apkit update '/project-a'; or run " +
          "apkit uninstall --project '/project-a' to remove its generated files and stop " +
          "managing this Project.",
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

  test("update JSON keeps updated work distinct from resulting state", () => {
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
    expect(payload.schemaVersion).toBe(16);
    expect(payload.projects[0].state).toEqual({ kind: "current" });
    expect(payload.applied.projects[0].state).toEqual({ kind: "addition" });
  });

  test("blocked update JSON has no updated snapshot", () => {
    const report = machineReport([
      machineProject(project, { blockers: [fixtureBlocker("CLI missing", project)] }),
    ]);

    const payload = JSON.parse(formatBlockedApplyJson(report));
    expect(payload).toMatchObject({ command: "update", outcome: "blocked", schemaVersion: 16 });
    expect(payload).not.toHaveProperty("applied");
    expect(payload.projects[0].blockers).toHaveLength(1);
  });

  test("update verification failure JSON retains updated evidence and the typed error", () => {
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
      command: "update",
      outcome: "error",
      error: "post-apply verification failed: boom",
      schemaVersion: 16,
    });
    expect(payload.projects).toEqual([]);
    expect(payload.applied.projects[0].outputs).toEqual([
      { kind: "addition", path: "a.md", consumingHosts: ["codex"] },
    ]);
  });

  test("tool-error JSON uses the empty nested model", () => {
    for (const command of ["status", "update"] as const) {
      expect(JSON.parse(formatLifecycleToolErrorJson(command, "missing"))).toEqual({
        schemaVersion: 16,
        command,
        outcome: "error",
        error: "missing",
        brokenProfileViolations: [],
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
    rows: undefined,
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

    expect(shapes(document)).toEqual([
      "key-value:Engine version(path)",
      "key-value:Workspace",
      "key-value:Local Configuration",
      "key-value:Installation State",
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
    expect(shapes(document)).toEqual([
      "heading",
      ...INVENTORY_TOPICS.flatMap(() => ["prose(command)", "prose"]),
    ]);
    const lines = flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose")
      .map((node) => nodeText(node));
    for (const topic of INVENTORY_TOPICS) {
      expect(lines.some((line) => line.includes(`apkit list ${topic.name}`))).toBe(true);
    }

    const machine = machineInventoryIndexDocument();
    expect(shapes(machine)).toEqual([
      "heading",
      ...MACHINE_INVENTORY_TOPICS.flatMap(() => ["prose(command)", "prose"]),
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

    expect(shapes(document)).toEqual([
      "heading",
      "spacer",
      "row",
      "spacer",
      "list",
      "prose",
      "prose",
    ]);
    const heading = document[0] as Extract<PresentationNode, { kind: "heading" }>;
    expect(heading.text).toBe("Projects:");
    const row = document.find((node) => node.kind === "row") as Extract<PresentationNode, { kind: "row" }>;
    expect(row).toBeDefined();
    expect(row.cells).toHaveLength(4);
    expect(row.cells.map((c) => c.column)).toEqual(["Project", "Profile", "Agents", "State"]);
    expect(row.cells[0]!.content).toEqual({
      kind: "path",
      canonicalPath: project,
      authoredPath: project,
      scope: "fleet",
      identity: "a-very-long-project-identity",
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
    expect(row.cells[3]!.content).toEqual({
      category: "warning",
      kind: "identifier",
      value: "problem",
    });
    // The machine projection keeps the canonical/authored path; the human
    // view renders the same exception under this view's identity.
    const exception = listPartsIn(document)[0]!;
    expect(flatInlineText(exception)).toBe(
      `${project}: Configured project root does not exist on this machine and cannot be reconciled.`,
    );
    const rendered = renderPresentationDocument(document, {
      color: false,
      interactive: true,
      width: 100,
      rows: undefined,
    }, { home: "/home", cwd: "/work" });
    expect(rendered).toContain(
      "⚠ a-very-long-project-identity: Configured project root does not exist on this machine and cannot be",
    );
    const summary = document[5] as Extract<PresentationNode, { kind: "prose" }>;
    expect(nodeText(summary)).toBe("1 Project: 1 problem.");
    const guidance = document[6] as Extract<PresentationNode, { kind: "prose" }>;
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
    expect(shapes(document)).toEqual([
      "heading",
      "spacer",
      "row",
      "row",
      "spacer",
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
    rows: undefined,
  }, { home: "/home", cwd: "/home" });

    const lines = rendered.split("\n");
    // lines: [ "Projects:", "", "<header>", "<row1>", "<row2>", "", "2 Projects configured.", "Use apkit status..." ]
    expect(lines[0]).toBe("Projects:");
    expect(lines[2]).toMatch(/^Project\s+Profile\s+Agents\s+State$/);
    const row1 = lines[3]!;
    const row2 = lines[4]!;
    expect(row1).toBeDefined();
    expect(row2).toBeDefined();

    // The columns are: Project, Profile, Agents, State.
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

  test("project inventory degrades to packed labeled records on narrow terminals without dropping fields", () => {
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
    rows: undefined,
  }, { home: "/home", cwd: "/home" });

    // Each entry is separated by a blank line; the identity is the shortest
    // unambiguous label for this view and the typed problem sentence stays in
    // the exception item below the entries.
    expect(rendered).toContain("Project: alpha");
    expect(rendered).toContain("Profile: engineering");
    expect(rendered).toContain("Agents: codex");
    expect(rendered).toContain("State: configured");
    expect(rendered).toContain("Project: beta");
    expect(rendered).toContain("Profile: devops");
    expect(rendered).toContain("Agents: claude");
    expect(rendered).toContain("2 Projects configured.");
    const records = rendered.split("\n\n");
    expect(records[1]).toContain("Project: alpha");
    expect(records[1]).toContain("Profile: engineering");
    expect(records[1]).toContain("Agents: codex");
    expect(records[1]).toContain("State: configured");
    expect(records[2]).toContain("Project: beta");
    expect(Math.max(...rendered.split("\n").map((line) => line.length))).toBeLessThanOrEqual(40);
  });

  test("project inventory labels every column at 100 columns and packs records at 60", () => {
    const projects = [
      {
        canonicalProject: "/home/projects/demo",
        hosts: ["codex" as const],
        problem: null,
        profile: "example",
        project: "~/projects/demo",
      },
      {
        canonicalProject: "/home/projects/other",
        hosts: ["codex" as const],
        problem: null,
        profile: "example",
        project: "~/projects/other",
      },
    ];

    const wide = renderPresentationDocument(
      projectInventoryDocument(projects, "/home", "/home"),
      { color: false, interactive: true, width: 100, rows: undefined },
      { home: "/home", cwd: "/home" },
    );
    const wideLines = wide.split("\n");
    expect(wideLines[0]).toBe("Projects:");
    expect(wideLines[2]).toBe("Project  Profile  Agents  State");
    expect(wideLines[3]).toBe("demo     example  codex   configured");
    expect(wideLines[4]).toBe("other    example  codex   configured");

    const narrow = renderPresentationDocument(
      projectInventoryDocument(projects, "/home", "/home"),
      { color: false, interactive: true, width: 60, rows: undefined },
      { home: "/home", cwd: "/home" },
    );
    const records = narrow.split("\n\n");
    expect(records[0]).toBe("Projects:");
    for (const record of records.slice(1, 3)) {
      const recordLines = record.split("\n");
      expect(recordLines.length).toBeLessThanOrEqual(2);
      expect(recordLines.join(" ")).toContain("Project:");
      expect(recordLines.join(" ")).toContain("Profile:");
      expect(recordLines.join(" ")).toContain("Agents:");
      expect(recordLines.join(" ")).toContain("State:");
    }
    expect(records[1]).toContain("demo");
    expect(records[2]).toContain("other");
    expect(Math.max(...narrow.split("\n").map((line) => line.length))).toBeLessThanOrEqual(60);
  });

  test("project inventory keeps over-width colliding-tail paths elided and whole at 60 columns", () => {
    const sharedTail = "shared-project-name";
    const first = `/home/very-long-parent-aaaaaaaaaaaaaaaaaaaa/team-a/${sharedTail}`;
    const second = `/home/very-long-parent-bbbbbbbbbbbbbbbbbbbb/team-b/${sharedTail}`;
    const projects = [
      {
        canonicalProject: first,
        hosts: ["codex" as const],
        problem: null,
        profile: "engineering",
        project: first,
      },
      {
        canonicalProject: second,
        hosts: ["claude" as const, "codex" as const],
        problem: null,
        profile: "devops",
        project: second,
      },
    ];

    const narrow = renderPresentationDocument(
      projectInventoryDocument(projects, "/home", "/home"),
      { color: false, interactive: true, width: 60, rows: undefined },
      { home: "/home", cwd: "/home" },
    );
    // Both identities keep their unique tail visible without exposing the
    // over-width path, and packed neighbors cannot be read as the Project field.
    expectElidedProjectLine(narrow, first, 60);
    expectElidedProjectLine(narrow, second, 60);
    expect(narrow).not.toContain(first);
    expect(narrow).not.toContain(second);
    expect(narrow).toContain(`team-a/${sharedTail}`);
    expect(narrow).toContain(`team-b/${sharedTail}`);
    // No fact is dropped when the records pack.
    expect(narrow).toContain("Profile: engineering");
    expect(narrow).toContain("Profile: devops");
    expect(narrow).toContain("Agents: codex");
    expect(narrow).toContain("Agents: claude, codex");
    expect(narrow).toContain("State: configured");
    expect(Math.max(...narrow.split("\n").map((line) => line.length))).toBeLessThanOrEqual(60);
    for (const record of narrow.split("\n\n").slice(1, 3)) {
      expect(record.split("\n").length).toBeLessThanOrEqual(3);
    }
  });

  test("project inventory keeps a Project field with spaces intact beside packed neighbors", () => {
    const spaced = "/home/my projects/demo app";
    const document = projectInventoryDocument(
      [{
        canonicalProject: spaced,
        hosts: ["codex" as const],
        problem: null,
        profile: "example",
        project: spaced,
      }],
      "/home",
      "/home",
    );
    const narrow = renderPresentationDocument(document, {
      color: false,
      interactive: true,
      width: 60,
      rows: undefined,
    }, { home: "/home", cwd: "/home" });
    // The view identity keeps the space-containing tail whole; the field
    // matcher must not stop at the first space and read `demo` only.
    expect(narrow).toContain("Project: demo app  Profile: example");
    expectElidedProjectLine(narrow, spaced, 60);
  });

  test("the Project field matcher keeps space-containing paths and ignores packed neighbors", () => {
    const spaced = "/home/my projects/demo app";
    expectElidedProjectLine(
      `Projects:\n\nProject: ${spaced}  Profile: example  Hosts: codex\nState: configured\n\n1 Project configured.\n`,
      spaced,
      80,
    );
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
      expect(nodeText(row.cells[3]!.content)).toBe("problem");
      const exceptionItem = listPartsIn(document)[0]!;
      // The machine projection keeps the authored spelling; the human view
      // renders the identity this view chose for the Project.
      expect(flatInlineText(exceptionItem)).toBe(`~/projects/test: ${expected}`);
      const rendered = renderPresentationDocument(document, {
        color: false,
        interactive: true,
        width: 200,
        rows: undefined,
      }, { home: "/home", cwd: "/home" });
      expect(rendered).toContain(`⚠ test: ${expected}`);
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
    const exceptionItems = listPartsIn(document);
    expect(flatInlineText(exceptionItems[0]!)).toContain("bindings[1]");
    expect(flatInlineText(exceptionItems[0]!)).toContain("dangling symlink");

    // Row 1 is zeta-broken, but its state carries bindings[0] locator from configuration
    expect(flatInlineText(exceptionItems[1]!)).toContain("bindings[0]");
    expect(flatInlineText(exceptionItems[1]!)).toContain("must be an existing directory");
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
    const exceptionItem = listPartsIn(document)[0]!;
    expect(flatInlineText(exceptionItem)).toBe(
      "~/projects/charlie-file: Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[0] project '~/projects/charlie-file' must be an existing directory",
    );
    expect(stateText).toBe("problem");
    expect(flatInlineText(exceptionItem)).not.toContain("missing directory;");
    const rendered = renderPresentationDocument(document, {
      color: false,
      interactive: true,
      width: 200,
      rows: undefined,
    }, { home: "/home", cwd: "/home" });
    expect(rendered).toContain("⚠ charlie-file: Local Configuration");
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
        identity: `relative path ${JSON.stringify(project)}`,
      });
    }
  });

  test("an empty project inventory is a success notice with install guidance", () => {
    const document = projectInventoryDocument([], "/home", "/work");
    expect(shapes(document)).toEqual(["notice", "prose"]);
    const notice = document[0] as Extract<PresentationNode, { kind: "notice" }>;
    expect(notice.severity).toBe("success");
    // The guidance is one prose node whose typed inline command part keeps
    // the install invocation atomic.
    expect(inlineCommandTexts([document[1]!])).toEqual(["apkit install <profile> --agent <agent>"]);
  });

  test("profile inventory presents each Profile with its module and skill counts", () => {
    const document = profileInventoryDocument([{ contextModules: 2, id: "engineering", skills: 3 }]);
    expect(shapes(document)).toEqual([
      "heading",
      "key-value:Profile(path)",
      "key-value:Context Modules",
      "key-value:Skills",
      "spacer",
      "prose",
    ]);
    expect(keyValuesIn(document, "Profile")[0]!.value).toEqual({
      kind: "identifier",
      value: "engineering",
    });
  });

  test("an empty profile inventory is a success notice with workspace guidance", () => {
    const document = profileInventoryDocument([]);
    expect(shapes(document)).toEqual(["notice", "prose"]);
    expect((document[0] as Extract<PresentationNode, { kind: "notice" }>).nodes[0]).toMatchObject({ kind: "prose" });
    // The focused route is not offered when no Profile can be inspected (#513);
    // the install guidance remains the only inline command.
    expect(inlineCommandTexts(document)).toEqual(["apkit install"]);
  });

  test("profile inventory points to the focused detail route when Profiles exist", () => {
    const document = profileInventoryDocument([{ contextModules: 2, id: "engineering", skills: 3 }]);
    expect(inlineCommandTexts(document)).toContain("apkit list profiles <profile>");
  });

  test("focused profile detail lists authored Context Module and Skill names", () => {
    const document = profileDetailDocument({
      context: ["team-rules", "writing-style"],
      id: "coding",
      skills: ["review-pr"],
    });
    expect(shapes(document)).toEqual([
      "heading",
      "key-value:Context Modules",
      "key-value:Skills",
      "spacer",
      "prose",
    ]);
    expect(keyValuesIn(document, "Context Modules")[0]!.value).toEqual({
      kind: "identifier",
      value: "team-rules, writing-style",
    });
    expect(keyValuesIn(document, "Skills")[0]!.value).toEqual({
      kind: "identifier",
      value: "review-pr",
    });
    // The tail names the executable next actions with the Profile's own name.
    expect(inlineCommandTexts(flattenPresentationNodes(document))).toEqual([
      "apkit configure profile coding",
      "apkit install coding --agent <agent>",
    ]);
  });

  test("focused profile detail renders empty membership without inventing names", () => {
    const document = profileDetailDocument({ context: [], id: "coding", skills: [] });
    expect(keyValuesIn(document, "Context Modules")[0]!.value).toEqual({
      kind: "identifier",
      value: "(none)",
    });
    expect(keyValuesIn(document, "Skills")[0]!.value).toEqual({
      kind: "identifier",
      value: "(none)",
    });
  });

  test("host inventory uses the shared detected/not found wording, never `installed`", () => {
    const document = hostInventoryDocument(
      [
        { host: "codex", supportsTemporaryProfileInstallation: true },
        { host: "claude", supportsTemporaryProfileInstallation: false },
      ],
      ["codex"],
    );
    expect(shapes(document)).toEqual(["heading", "prose", "prose", "spacer", "prose", "prose"]);
    const hostLines = flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose")
      .map((node) => nodeText(node));
    // One shared definition with the install Host picker (US-003, #669):
    // `installed` beside a Host is ambiguous — in this kit installing means
    // installing into a Project. Literal bytes pin the wording end-to-end;
    // the constant checks pin that the literals read the one shared home.
    expect(hostLines[0]).toContain("codex — detected");
    expect(hostLines[0]).toContain(`codex — ${HOST_DETECTION_LABELS.detected}`);
    expect(hostLines[1]).toContain(`claude — ${HOST_DETECTION_LABELS.notFound}`);
    expect(hostLines.join("\n")).not.toContain("— installed");
    // The advisory sentence quotes the shared not-found wording itself.
    expect(hostLines).toContain(
      `"${HOST_DETECTION_LABELS.notFound}" means the agent executable was not detected here.`,
    );
    expect(inlineCommandTexts(document)).toContain("apkit install");
  });

  test("host inventory keeps an undetected Host listed with the advisory loading distinction", () => {
    const document = hostInventoryDocument(
      [{ host: "claude", supportsTemporaryProfileInstallation: false }],
      [],
    );
    const hostLines = flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose")
      .map((node) => nodeText(node));
    expect(hostLines[0]).toContain("claude");
    expect(hostLines[0]).toContain("not found");
    // The advisory wording distinguishes executable presence from Profile
    // loading and keeps every Host an available installation choice.
    const advice = hostLines.filter((line) => line.includes("not detected") || line.includes("selectable"));
    expect(advice).toHaveLength(2);
    expect(advice[0]).toContain("not detected");
    expect(advice[1]).toContain("selectable");
    expect(inlineCommandTexts(document)).toContain("apkit install");
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

    expect(shapes(document)).toEqual([
      "heading",
      "spacer",
      "key-value:Temporary installation(path)",
      "key-value:Project",
      "key-value:Profile(path)",
      "key-value:Host(path)",
      "spacer",
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
      identity: "temporary-project",
    });
  });

  test("an empty temporary inventory is a success notice with install guidance", () => {
    const document = temporaryInventoryDocument([], "/home", "/work");
    expect(shapes(document)).toEqual(["notice", "prose"]);
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
      workspace: { authored: "~/apkit-workspace", canonical: "/Users/example/apkit-workspace" },
    });

    expect(shapes(document)).toEqual([
      "notice",
      "list",
      "key-value:Workspace",
      "key-value:Profiles found",
      "key-value:Agents bound",
      "key-value:Next(command)",
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

  test("bare validation names the connected Workspace through the same row as the path form (#629)", () => {
    const workspace = { authored: "~/apkit-workspace", canonical: "/Users/example/apkit-workspace" };
    const bare = validationResultDocument({
      bindings: 0,
      hosts: [],
      profiles: [],
      warnings: [],
      workspace,
    });
    const pathForm = workspaceValidationDocument(
      { outcome: "valid", path: workspace.canonical, contexts: [], profiles: [], skills: [] },
      workspace.authored,
    );

    const bareRow = keyValuesIn(bare, "Workspace")[0]!;
    expect(bareRow.value).toEqual({
      kind: "path",
      canonicalPath: workspace.canonical,
      authoredPath: workspace.authored,
      scope: "fleet",
    });
    // One row builder: the bare and path forms state what they checked identically.
    expect(bareRow).toEqual(keyValuesIn(pathForm, "Workspace")[0]!);
  });

  test("validation without bindings points at the install command as a typed command node", () => {
    const document = validationResultDocument({
      bindings: 0,
      hosts: [],
      profiles: [],
      warnings: [],
      workspace: { authored: "~/apkit-workspace", canonical: "/Users/example/apkit-workspace" },
    });

    expect(keyValuesIn(document, "Next")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "install <profile> --agent <agent>" }],
    });
    expect(keyValuesIn(document, "Profiles found")[0]!.value).toMatchObject({ kind: "prose" });
    // The count clause is protected report material: it never wraps (US-010).
    const rendered = renderPresentationDocument(
      validationResultDocument({
        bindings: 0,
        hosts: [],
        profiles: [],
        warnings: [],
      workspace: { authored: "~/apkit-workspace", canonical: "/Users/example/apkit-workspace" },
      }),
      context(40),
    );
    const notice = document[0] as Extract<PresentationNode, { kind: "notice" }>;
    const count = inlineIdentifiers(notice.nodes)[0]!;
    expect(count).toBeDefined();
    expect(rendered.split("\n").filter((line) => line.includes(count))).toHaveLength(1);
  });

  test("uninstall receipt reports the removed count once without inventories", () => {
    const document = uninstallReceiptDocument({
      completed: [
        {
          canonicalProject: "/home/projects/api",
          project: "/home/projects/api",
          profile: "engineering",
          outputs: [".agent-profile-kit/codex/context.md"],
        },
      ],
      skipped: [],
      unattempted: [],
      warnings: [],
    });

    expect(shapes(document)).toEqual(["notice"]);
    const notice = document[0] as Extract<PresentationNode, { kind: "notice" }>;
    expect(notice.severity).toBe("success");
    // One count, no per-file, per-Project, or Profile-breakdown inventory.
    const proseNodes = flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose");
    expect(proseNodes).toHaveLength(1);
    expect(nodeText(proseNodes[0]!)).toContain("1 Project");
    expect(nodeText(proseNodes[0]!)).not.toContain(".agent-profile-kit/codex/context.md");
    expect(keyValuesIn(document, "Project")).toEqual([]);
  });

  test("uninstall receipt counts multiple removed Projects once", () => {
    const document = uninstallReceiptDocument({
      completed: [
        { project: "/project-a", profile: "engineering", outputs: [] },
        { project: "/project-b", profile: "engineering", outputs: [] },
      ],
      skipped: [],
      unattempted: [],
      warnings: [],
    });
    expect(shapes(document)).toEqual(["notice"]);
    const text = nodeText(flattenPresentationNodes(document).find((node) => node.kind === "prose")!);
    expect(text).toContain("2 Projects");
  });

  test("uninstall receipt carries no per-file or exclusion inventory", () => {
    const document = uninstallReceiptDocument({
      completed: [
        {
          project: "/project-a",
          profile: "engineering",
          outputs: [".codex/hooks.json"],
        },
      ],
      skipped: [],
      unattempted: [],
      warnings: [],
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).not.toContain(".codex/hooks.json");
    expect(headingsIn(document)).toEqual([]);
  });

  test("uninstall receipt presents skipped Projects and their Blocker reasons", () => {
    const document = uninstallReceiptDocument({
      completed: [],
      skipped: [{
        canonicalProject: "/project-a",
        project: "/project-a",
        profile: "engineering",
        reason: "Cannot remove Project at /project-a: owned output .codex/hooks.json has unsafe parent: /project-a/.codex is a symlink parent",
      }],
      unattempted: [],
      warnings: [],
    });

    expect(shapes(document)).toEqual([
      "notice",
      "spacer",
      "prose",
      "spacer",
      "key-value:Project",
      "prose",
    ]);
    // Recovery evidence stays outside error coloring (DEC-001).
    const skippedReason = flattenPresentationNodes(document).find((node) =>
      node.kind === "prose" && nodeText(node).includes("Cannot remove Project")
    ) as Extract<PresentationNode, { kind: "prose" }>;
    expect(skippedReason.category).toBeUndefined();
    expect(keyValuesIn(document, "Project")[0]!.value).toEqual({
      kind: "path",
      canonicalPath: "/project-a",
      authoredPath: "/project-a",
      scope: "fleet",
      identity: "/project-a",
    });
  });

  test("uninstall receipt presents warnings as inline typed list items beside the outcome notice", () => {
    const document = uninstallReceiptDocument({
      completed: [],
      skipped: [],
      unattempted: [],
      warnings: [
        "/project-a/.git/info/exclude changed during exclusion publication; skipping to preserve unrelated bytes",
      ],
    });

    const warningLists = flattenPresentationNodes(document).filter((node) => node.kind === "list");
    expect(warningLists).toHaveLength(1);
    expect(warningLists[0]).toMatchObject({ kind: "list", category: "warning" });
    expect(shapes(document)).toEqual(["notice", "list"]);
    expect(keyValuesIn(document, "Project")).toEqual([]);
  });

  test("an uninstall with nothing installed is a single success notice", () => {
    const document = uninstallReceiptDocument({ completed: [], skipped: [], unattempted: [], warnings: [] });
    expect(shapes(document)).toEqual(["notice"]);
    expect((document[0] as Extract<PresentationNode, { kind: "notice" }>).nodes[0]).toMatchObject({ kind: "prose" });
  });

  test("install Host selection note states that selecting a Host does not install it", () => {
    const document = installHostSelectionNoteDocument();
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("Selecting an agent does not install it.");
  });

  test("install confirmation names the stable Project path, Profile once, and Hosts before any write", () => {
    const document = installConfirmationDocument({
      canonicalProject: "/project-a",
      authoredProject: "~/project-a",
      profile: "coding",
      hosts: ["claude", "codex"],
      previous: { profile: "coding", hosts: ["claude"] },
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext, {
      home: "/home",
      cwd: "/home",
    });
    expect(rendered).toContain("Install into ~/project-a");
    expect(rendered).toContain("Profile: coding");
    expect(rendered).toContain("Agents: claude → claude, codex");
    // US-006: installing into that Project, with no selection/verification jargon.
    expect(rendered).not.toMatch(/selection|verified/i);
    expect(INSTALL_CONFIRMATION_QUESTION).toBe("Install into this Project? (y/N)");
  });

  test("install confirmation shows delta arrows only when an existing installation changes", () => {
    const fresh = renderPresentationDocument(
      installConfirmationDocument({
        canonicalProject: "/home/projects/demo",
        authoredProject: "~/projects/demo",
        profile: "coding",
        hosts: ["codex"],
      }),
      defaultRenderContext,
      { home: "/home", cwd: "/home" },
    );
    expect(fresh).toContain("Profile: coding");
    expect(fresh).toContain("Agents: codex");
    expect(fresh).not.toContain("→");

    const changed = renderPresentationDocument(
      installConfirmationDocument({
        canonicalProject: "/home/projects/demo",
        authoredProject: "~/projects/demo",
        profile: "ops",
        hosts: ["codex", "claude"],
        previous: { profile: "coding", hosts: ["codex"] },
      }),
      defaultRenderContext,
      { home: "/home", cwd: "/home" },
    );
    expect(changed).toContain("Profile: coding → ops");
    expect(changed).toContain("Agents: codex → codex, claude");
  });

  test("install confirmation never prints a basename-only Project action location", () => {
    const rendered = renderPresentationDocument(
      installConfirmationDocument({
        canonicalProject: "/home/projects/my-app",
        authoredProject: "~/projects/my-app",
        profile: "coding",
        hosts: ["codex"],
      }),
      defaultRenderContext,
      { home: "/home", cwd: "/home" },
    );
    expect(rendered).toContain("~/projects/my-app");
    expect(rendered).not.toContain("Install into my-app");
  });

  test("uninstall confirmation review names every selected Project on its stable path before any write", () => {
    const document = uninstallConfirmationDocument({
      projects: [
        { canonicalProject: "/home/projects/alpha", project: "~/projects/alpha", profile: "engineering", hosts: ["codex"] },
        { project: "~/projects/beta", profile: "docs", hosts: ["claude", "pi"] },
      ],
    });
    expect(shapes(document)).toEqual(["heading", "prose", "prose", "prose"]);
    const rendered = renderPresentationDocument(document, defaultRenderContext, {
      home: "/home",
      cwd: "/home",
    });
    expect(rendered).toContain("~/projects/alpha");
    expect(rendered).toContain("~/projects/beta");
    expect(rendered).not.toContain(" alpha (");
    expect(rendered).toContain("engineering");
    expect(rendered).toContain("will not reinstall");
  });

  test("uninstall JSON outcomes unify skipped with blocked", () => {
    const clean = JSON.parse(formatUninstallJson({
      completed: [{ project: "/project-a", profile: "engineering", outputs: [] }],
      skipped: [],
      unattempted: [],
      warnings: [],
    })) as { schemaVersion: number; command: string; outcome: string };
    expect(clean.schemaVersion).toBe(16);
    expect(clean.command).toBe("uninstall");
    expect(clean.outcome).toBe("clean");

    const blocked = JSON.parse(formatUninstallJson({
      completed: [],
      skipped: [{ project: "/project-a", profile: "engineering", reason: "tracked by Git" }],
      unattempted: [],
      warnings: [],
    })) as { outcome: string };
    expect(blocked.outcome).toBe("blocked");

    const failed = JSON.parse(formatUninstallJson({
      completed: [],
      skipped: [],
      failed: {
        project: "/project-b",
        profile: "engineering",
        detail: "injected fault",
        selectionRestored: true,
        concurrentSelectionChange: false,
      },
      unattempted: [],
      warnings: [],
    })) as { outcome: string; error: string };
    expect(failed.outcome).toBe("error");
    expect(failed.error).toContain("injected fault");
  });

  test("uninstall confirmation names the fleet-wide reach of a Profile-only scope", () => {
    const document = uninstallConfirmationDocument(
      {
        projects: [
          { project: "/project-a", profile: "docs", hosts: ["codex"] },
          { project: "/project-b", profile: "docs", hosts: ["claude"] },
        ],
      },
      { fleetProfile: "docs" },
    );
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("every installation using Profile 'docs' (fleet-wide)");

    const scoped = uninstallConfirmationDocument({
      projects: [{ project: "/project-a", profile: "docs", hosts: ["codex"] }],
    });
    expect(renderPresentationDocument(scoped, defaultRenderContext)).not.toContain("fleet-wide");
  });

  test("uninstall declined and confirmation-required diagnostics name the explicit equivalent", () => {
    const args = [{ kind: "text" as const, value: "uninstall" }, { kind: "text" as const, value: "--all" }];
    // A plain decline carries no remedy command (US-010).
    const declined = uninstallDeclinedDocument("declined");
    expect(inlineCommandTexts(declined)).toEqual([]);
    const required = uninstallConfirmationRequiredDocument(args);
    expect(inlineCommandTexts(required)).toEqual(["apkit uninstall --all"]);
    const missing = uninstallMissingScopeDocument(args);
    expect(inlineCommandTexts(missing)).toEqual(["apkit uninstall --all"]);
    const noMatch = uninstallNoMatchDocument("Profile 'docs'");
    expect(renderPresentationDocument(noMatch, defaultRenderContext)).toContain("docs");
  });

  test("uninstall execution failure distinguishes completed, failed, and unattempted work", () => {
    const document = uninstallExecutionFailureDocument({
      failed: {
        canonicalProject: "/project-b",
        project: "/project-b",
        profile: "engineering",
        detail: "injected Installation State fault",
        selectionRestored: true,
        concurrentSelectionChange: false,
      },
      completed: [{ project: "/project-a", profile: "engineering", outputs: [] }],
      unattempted: [{ project: "/project-c", profile: "engineering" }],
      retryArguments: [{ kind: "text" as const, value: "uninstall" }, { kind: "text" as const, value: "--all" }],
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("/project-b");
    expect(rendered).toContain("/project-a");
    expect(rendered).toContain("/project-c");
    expect(inlineCommandTexts(document)).toEqual(["apkit uninstall --all"]);
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
    expect(shapes(document)).toEqual([
      "notice",
      "key-value:Profile(path)",
      "key-value:Host(path)",
      "key-value:Project",
      "key-value:Temporary installation(path)",
      "key-value:Next",
    ]);
    expect(keyValuesIn(document, "  Project")[0]!.value).toEqual({
      kind: "path",
      canonicalPath: "/project-a",
      authoredPath: "/project-a",
      scope: "project",
      identity: "/project-a",
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
    expect(shapes(removed)).toEqual([
      "notice",
      "key-value:Temporary installation(path)",
      "key-value:Project",
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
    expect(shapes(document)).toEqual([
      "notice",
      "list",
      "key-value:Profile(path)",
      "key-value:Host(path)",
      "key-value:Project",
      "key-value:Temporary installation(path)",
      "heading",
      "list",
      "prose",
      "key-value:Next",
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
          node.kind === "prose" || node.kind === "sentence"
            ? node.parts.filter((part): part is string => typeof part === "string")
            : node.kind === "list"
            ? node.items.flatMap((item) =>
                item.filter((part): part is string => typeof part === "string"))
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
          node.kind === "prose" || node.kind === "sentence"
            ? node.parts.filter((part): part is string => typeof part === "string")
            : node.kind === "list"
            ? node.items.flatMap((item) =>
                item.filter((part): part is string => typeof part === "string"))
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
          node.kind === "prose" || node.kind === "sentence"
            ? node.parts.filter((part): part is string => typeof part === "string")
            : node.kind === "list"
            ? node.items.flatMap((item) =>
                item.filter((part): part is string => typeof part === "string"))
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
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "warning" });
    expect(nextGuidance(concise)).toEqual(["apkit update"]);
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

    // The ready summary notice leads; scope rows carry each Project's Primary Cause.
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "warning" });
    expect(renderBoundary(concise)).toContain("source changed");
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
      severity: "warning",
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

    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "warning" });
    // The selected Project is a typed path argument on each guidance command.
    const next = keyValuesIn(concise, "Next")[0]!.value;
    expect(next).toMatchObject({ kind: "command", program: "apkit" });
    expect(next).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "update" },
        { kind: "path", canonicalPath: "/project-a", authoredPath: "/project-a", scope: "fleet" },
      ],
    });
    const details = keyValuesIn(concise, "Details")[0]!.value;
    expect(details).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "status" },
        { kind: "path", canonicalPath: "/project-a", authoredPath: "/project-a", scope: "fleet" },
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

    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "warning" });
    expect(flattenPresentationNodes(concise).some((node) =>
      node.kind === "prose" && node.category === "error"
    )).toBe(true);
    expect(headingsIn(concise)).not.toContain("Project changes:");
  });

  test("update summarizes updated operations separately from freshly verified state", () => {
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
    expect(nodes.map(nodeText)).toContain("Updated 3 Projects (3 generated files).");
    expect(nodes.some((node) => node.kind === "heading" && nodeText(node) === "Updated:")).toBe(false);
    expect(nodes.some((node) =>
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

    const rendered = renderBoundary(lifecycleStatusDocument(report));
    expect(rendered).toContain("generated files changed");
    expect(rendered).toContain("source changed");
    expect(rendered).toContain("project-a");
  });

  test("verbose retains complete per-Project operation evidence", () => {
    const verbose = lifecycleStatusDocument(sharedSkillFleet(), { verbose: true });
    const outputLine = (path: string, kind: string) => flattenPresentationNodes(verbose).some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));
    expect(outputLine("/project-a/.agents/skills/review-pr", "update (source changed)")).toBe(true);
    expect(outputLine("/project-b/.agents/skills/review-pr", "update (source changed)")).toBe(true);
    expect(outputLine("/project-c/.agents/skills/review-pr", "update (source changed)")).toBe(true);
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
    expect(nextGuidance(status)).toEqual(["apkit update"]);
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
    // out of the document. The argument carries the runnable fleet identity so
    // the printed command is always a valid target (US-007, INT-1 on #489).
    expect(keyValuesIn(status, "Next")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "update" },
        { kind: "path", canonicalPath: "/private/project-a", authoredPath: "/project-a", scope: "fleet" },
      ],
    });
    expect(keyValuesIn(status, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "status" },
        { kind: "path", canonicalPath: "/private/project-a", authoredPath: "/project-a", scope: "fleet" },
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

  test("fleet status names the working-directory Project by its shortest-unambiguous identity", () => {
    const current = process.cwd();
    const other = join(homedir(), "other-fleet-project");
    const homeRelative = current === homedir()
      ? "~"
      : current.startsWith(`${homedir()}/`)
      ? `~/${current.slice(homedir().length + 1)}`
      : current;
    const identity = current === homedir() ? "~" : basename(current);
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
    // The scanning view names the Project by its shortest-unambiguous identity;
    // the full stable path stays for requested details and commands.
    expect(rendered).toContain(identity);
    expect(rendered).not.toContain(homeRelative);
    expect(rendered).not.toMatch(/(^|\n)\.: /);
  });

  test("successful update does not print a current-Project matrix before the impact statement", () => {
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

    // Successful changed apply: success notice, one impact statement, and no
    // per-Project receipt block or state bookkeeping.
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(apply);
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(nodes.map(nodeText)).toContain("Updated 1 Project (1 generated file).");
    expect(headingsIn(apply)).not.toContain("Updated:");
    expect(keyValuesIn(apply, "Project")).toEqual([]);
    expect(keyValuesIn(apply, "  State")).toEqual([]);
  });

  test("exclusion-only update does not reprint a current Project block", () => {
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
    expect(listItemIdentities(applyReportDocument(applyResult(receipt, resultingState), { verbose: true }))).toContainEqual(["/repo/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);
  });

  test("remaining attention after update still appears", () => {
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
    // the compact impact statement stays first.
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(apply);
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(keyValuesIn(apply, "Project")).toHaveLength(1);
    const stateNodes = keyValuesIn(apply, "  State");
    expect(stateNodes).toHaveLength(1);
    expect(stateNodes[0]!.value).toMatchObject({ kind: "prose" });
    expect(nodeText(stateNodes[0]!.value)).toContain("a.md");
    const impact = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node) === "Updated 1 Project (1 generated file).");
    expect(impact).toBeGreaterThan(-1);
    expect(nodes.findIndex((node) => node.kind === "key-value" && node.key === "  State"))
      .toBeGreaterThan(impact);
  });

  test("multi-project update preserves remaining attention across projects", () => {
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

    // Remaining attention appears only for the drifted Project; the compact
    // receipt counts both Projects' updates.
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(apply);
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(nodes.map(nodeText)).toContain("Updated 2 Projects (2 generated files).");
    expect(headingsIn(apply)).not.toContain("Updated:");
    const projectNodes = keyValuesIn(apply, "Project");
    expect(projectNodes).toHaveLength(1);
    expect(projectNodes[0]!.value).toMatchObject({ kind: "path", canonicalPath: "/project-b" });
    const stateNodes = keyValuesIn(apply, "  State");
    expect(stateNodes).toHaveLength(1);
    expect(stateNodes[0]!.value).toMatchObject({ kind: "prose" });
    // Remaining attention keeps its Project identity and cause; routine
    // generated paths stay out of the default receipt (US-011).
    expect(nodeText(stateNodes[0]!.value)).toBe("drifted output");
  });

  test("no-op update preserves adapter warnings", () => {
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
    expect(headingsIn(document)).not.toContain("Updated:");
  });


  test("blocked multi-project update keeps routine exclusion bookkeeping out of the default view", () => {
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

    // Blocked apply: routine successful Git-exclusion bookkeeping is verbose
    // evidence, so the default view carries its Blocker without an exclusion
    // inventory (US-011, ADR-0020).
    const apply = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(apply);
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "error" });
    expect(headingsIn(apply)).not.toContain("Updated:");
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node).includes(".git/info/exclude"))).toBe(false);

    const verbose = flattenPresentationNodes(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    expect(listItemIdentities(applyReportDocument(applyResult(receipt, resultingState), { verbose: true })))
      .toContainEqual(["/project-a/.git/info/exclude", "/.agent-profile-kit/codex/context.md"]);
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
    // Exactly one readiness statement, followed by the Host-loading check as
    // the trailing prose node; the composed readiness wording (and any
    // Project list) is golden-covered.
    expect(shapes(concise)).toEqual([
      "notice", "spacer", "prose",
      "spacer", "heading", "list",
      "spacer", "prose", "prose",
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
    expect(shapes(concise)).toEqual([
      "notice", "spacer", "prose", "spacer", "prose", "prose",
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
    // summary, then the trailing readiness prose — no grouping section. The
    // optional Host-loading check is not part of a routine update's view
    // (spec #491 US-017, #515): the receipt proves no first delivery.
    expect(shapes(concise)).toEqual([
      "notice",
      "spacer",
      "prose",
      "spacer",
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
    for (const section of ["Projects:", "State explanations:", "Outputs:"]) {
      expect(sectionAt(section)).toBeGreaterThan(-1);
    }
    expect(headingsIn(verbose)).not.toContain("Selected setup:");
    expect(headingsIn(verbose)).not.toContain("Blockers:");
    expect(projectStateLines(verbose)).toContain("/project-a");
    const nodes2 = flattenPresentationNodes(verbose);
    expect(nodes2.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: "/project-a/a.md" },
        ": addition (source changed)",
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
      schemaVersion: 16,
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
      validationResultDocument({
        bindings,
        hosts,
        profiles,
        warnings: [],
        workspace: { authored: "~/apkit-workspace", canonical: "/Users/example/apkit-workspace" },
      });

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
    expect(keyValuesIn(zeroProjects, "Agents bound")[0]!.value).toMatchObject({ kind: "prose" });
    expect(commandTexts(zeroProjects)).toContain("apkit install <profile> --agent <agent>");
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
    expectUserFacingVocabulary(renderPresentationDocument(machineIndex, defaultRenderContext), { allowMachineHost: true });

    // Empty temporary inventory: one success notice and one prose node whose
    // typed inline command part keeps the creation invocation atomic.
    const emptyTemp = temporaryInventoryDocument([]);
    expect(shapes(emptyTemp)).toEqual(["notice", "prose"]);
    expect((emptyTemp[0] as Extract<PresentationNode, { kind: "notice" }>).severity).toBe("success");
    expect(inlineCommandTexts(emptyTemp)).toEqual([
      "apkit machine install-temp <profile> <project> --host <host>",
    ]);
    expectUserFacingVocabulary(renderPresentationDocument(emptyTemp, defaultRenderContext), { allowMachineHost: true });

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
    expectUserFacingVocabulary(renderPresentationDocument(activeTemp, defaultRenderContext), { allowMachineHost: true });
  });

  test("routine teardown receipts state forgetting in user-facing vocabulary", () => {
    const uninstall = uninstallReceiptDocument({
      completed: [{
        project: "/project-a",
        profile: "engineering",
        outputs: [".claude/rules/agent-profile-kit.md", ".codex/hooks.json"],
      }],
      skipped: [],
      unattempted: [],
      warnings: [],
    });
    const rendered = renderPresentationDocument(uninstall, defaultRenderContext);
    expect(rendered).toContain("forgot");
    expect(rendered).not.toContain(".claude/rules/agent-profile-kit.md");
    expectUserFacingVocabulary(rendered);
  });

  test("uninstall renders best-effort exclusion warnings without claiming cleaned entries", () => {
    const result = uninstallReceiptDocument({
      completed: [{
        project: "/project-a",
        profile: "engineering",
        outputs: [".codex/hooks.json"],
      }],
      skipped: [],
      unattempted: [],
      warnings: [
        "/project-a/.git/info/exclude changed during exclusion publication; skipping to preserve unrelated bytes",
      ],
    });
    const warningList = flattenPresentationNodes(result).find((node) =>
      node.kind === "list" && node.category === "warning"
    );
    expect(warningList).toBeDefined();
    expect(listItemsIn(result)).toContain(
      "/project-a/.git/info/exclude changed during exclusion publication; skipping to preserve unrelated bytes",
    );
    // No cleaned-exclusion section exists for this receipt.
    expect(headingsIn(result)).toEqual([]);
  });

  test("empty status references configured Projects in next guidance", () => {
    const empty = lifecycleStatusDocument(emptyReport());
    expect(shapes(empty)).toEqual(["notice", "prose(command)"]);
    expect(flattenPresentationNodes(empty)[0]).toMatchObject({ kind: "notice", severity: "neutral" });
    // The next action is one command-category prose node whose typed inline
    // command parts keep both invocations atomic.
    expect(inlineCommandTexts(empty)).toEqual([
      "apkit list projects",
      "apkit install <profile> --agent <agent>",
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
    expectUserFacingVocabulary(renderPresentationDocument(install, defaultRenderContext), { allowMachineHost: true });

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
    expectUserFacingVocabulary(renderPresentationDocument(remove, defaultRenderContext), { allowMachineHost: true });
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
    expect(headingsIn(verbose)).toContain("Agent setup:");

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


describe("update presentation documents", () => {
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
    expect(nodes.map(nodeText)).toContain("Updated 1 Project (1 generated file).");
    expect(headingsIn(document)).not.toContain("Updated:");
    expect(nodes.at(-1)).toMatchObject({ kind: "prose" });
    expect(commandsIn(document)).toEqual([]);
  });

  test("verbose update separates Pending and Updated sections without composed Context bodies", () => {
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
    expect(verbatim).toHaveLength(0);
    const texts = headingsIn(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    expect(texts).toContain("Pending:");
    expect(texts).toContain("Updated:");
    expect(texts).not.toContain("Selected setup:");
    expect(texts).not.toContain("Host Setup:");
  });

  test("blocked update presents an error notice, Blocker evidence, and the committed receipt", () => {
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
    // Failed identity and empty pending scope precede the compact receipt.
    expect(nodes.slice(0, 4).map((node) => shape(node))).toEqual(["notice:error", "prose", "prose", "prose"]);
    expect(nodeText(nodes[1]!)).toContain("/project-a");
    // The compact receipt evidence follows the locator and pending scope.
    expect(nodes.map((node) => nodeText(node))).toContain("Updated 1 Project (1 generated file).");
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
    expect(flattenPresentationNodes(document).map(nodeText)).toContain("Updated 1 Project (1 generated file).");
  });
});

describe("grouped semantic warnings across Projects (#354, DEC-011)", () => {
  test("concise lifecycle output groups identical warnings and names affected Projects", () => {
    const report: ReconciliationReport = {
      brokenProfileViolations: [],
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
    // One grouped warning item names every affected Project.
    expect(warningItems).toHaveLength(1);
    expect(warningItems[0]).toContain("(/project-a, /project-b, /project-c)");
    expect(headingsIn(concise)).not.toContain("Warnings:");
  });

  test("concise lifecycle output names the affected project rather than only a count", () => {
    const report: ReconciliationReport = {
      brokenProfileViolations: [],
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
    expect(listItemsIn(concise)).toEqual([
      expect.stringContaining("Codex SessionStart hooks are not enabled (/project-a)"),
    ]);
  });

  test("verbose lifecycle output renders each semantic warning once and lists every affected project", () => {
    const report: ReconciliationReport = {
      brokenProfileViolations: [],
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
      brokenProfileViolations: [],
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
      brokenProfileViolations: [],
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
      brokenProfileViolations: [],
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

  test("multi-report update deduplicates same Project across receipt and resultingState without inflating count", () => {
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
      brokenProfileViolations: [],
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
      brokenProfileViolations: [],
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
    expect(conciseWarnings).toContainEqual(expect.stringContaining("Skill discovery collision warning (/project-a, /project-b)"));
    // w2 affects 1 project (/project-c) which was only in receipt.
    expect(conciseWarnings).toContainEqual(expect.stringContaining("Codex SessionStart hooks warning (/project-c)"));
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
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [
        machineProject("/project-a", {
          warnings: [warning],
        }),
      ],
    };

    // 1. Status document (concise)
    const statusConcise = lifecycleStatusDocument(statusReport);
    const statusConciseNodes = flattenPresentationNodes(statusConcise);
    expect(statusConciseNodes[0]?.kind).toBe("notice");
    expect(warningListIn(statusConcise)).toMatchObject({ category: "warning" });
    expect(renderBoundary(statusConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(statusConcise)).not.toContain("Warnings:");

    // 2. Status document (verbose)
    const statusVerbose = lifecycleStatusDocument(statusReport, { verbose: true });
    expect(statusVerbose[0]?.kind).toBe("notice");
    expect(warningListIn(statusVerbose)).toMatchObject({ category: "warning" });
    expect(renderBoundary(statusVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(statusVerbose)).not.toContain("Warnings:");

    // 3. Apply document (concise) — a clean no-op is one neutral statement
    // with warnings still inline beside it (US-010).
    const applyConcise = applyReportDocument(applyResult(statusReport));
    expect(applyConcise[0]?.kind).toBe("sentence");
    expect(warningListIn(applyConcise)).toMatchObject({ category: "warning" });
    expect(renderBoundary(applyConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(applyConcise)).not.toContain("Warnings:");

    // 4. Apply document (verbose)
    const applyVerbose = applyReportDocument(applyResult(statusReport), { verbose: true });
    expect(applyVerbose[0]?.kind).toBe("notice");
    expect(warningListIn(applyVerbose)).toMatchObject({ category: "warning" });
    expect(renderBoundary(applyVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(applyVerbose)).not.toContain("Warnings:");

    // 5. Blocked apply document (concise & verbose)
    const blockedReport: ReconciliationReport = {
      brokenProfileViolations: [],
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
    expect(warningListIn(blockedConcise)).toMatchObject({ category: "warning" });
    expect(warningListIn(blockedConcise)).toMatchObject({ category: "warning" });
    expect(renderBoundary(blockedConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(blockedConcise)).not.toContain("Warnings:");

    const blockedVerbose = blockedApplyReportDocument(blockedReport, { verbose: true });
    expect(blockedVerbose[0]?.kind).toBe("notice");
    expect(warningListIn(blockedVerbose)).toMatchObject({ category: "warning" });
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
    expect(warningListIn(execConcise)).toMatchObject({ category: "warning" });
    expect(renderBoundary(execConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(execConcise)).not.toContain("Warnings:");

    const execVerbose = applyExecutionFailureDocument(execFailure, { verbose: true });
    expect(execVerbose[0]?.kind).toBe("notice");
    expect(warningListIn(execVerbose)).toMatchObject({ category: "warning" });
    expect(renderBoundary(execVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(execVerbose)).not.toContain("Warnings:");

    // 7. Apply Verification Failure (concise & verbose)
    const verifyConcise = applyVerificationFailureDocument(statusReport, "Verification check failed", {});
    expect(verifyConcise[0]?.kind).toBe("notice");
    expect(warningListIn(verifyConcise)).toMatchObject({ category: "warning" });
    expect(renderBoundary(verifyConcise)).toContain("Sample diagnostic warning");
    expect(headingsIn(verifyConcise)).not.toContain("Warnings:");

    const verifyVerbose = applyVerificationFailureDocument(statusReport, "Verification check failed", { verbose: true });
    expect(verifyVerbose[0]?.kind).toBe("notice");
    expect(warningListIn(verifyVerbose)).toMatchObject({ category: "warning" });
    expect(renderBoundary(verifyVerbose)).toContain("Sample diagnostic warning (/project-a)");
    expect(headingsIn(verifyVerbose)).not.toContain("Warnings:");

    // 8. Uninstall receipt document (completed and skipped Projects)
    const uninstallDoc = uninstallReceiptDocument({
      completed: [{ project: "/project-a", profile: "engineering", outputs: [".codex/hooks.json"] }],
      skipped: [{ project: "/project-b", profile: "engineering", reason: "permission denied" }],
      unattempted: [],
      warnings: ["Sample uninstall warning"],
    });
    expect(uninstallDoc[0]?.kind).toBe("notice");
    expect(warningListIn(uninstallDoc)).toMatchObject({ category: "warning" });
    expect(renderBoundary(uninstallDoc)).toContain("Sample uninstall warning");
    expect(headingsIn(uninstallDoc)).not.toContain("Warnings:");

    // 9. Validation result document
    const validationDoc = validationResultDocument({
      bindings: 1,
      hosts: ["codex"],
      profiles: ["engineering"],
      warnings: ["Sample validation warning"],
      workspace: { authored: "~/apkit-workspace", canonical: "/Users/example/apkit-workspace" },
    });
    expect(flattenPresentationNodes(validationDoc)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(warningListIn(validationDoc)).toMatchObject({ category: "warning" });
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
    const tempInstallNodes = flattenPresentationNodes(tempInstallDoc);
    expect(tempInstallNodes[0]?.kind).toBe("notice");
    expect(tempInstallNodes[2]).toMatchObject({ kind: "list", category: "warning" });
    expect(renderBoundary(tempInstallDoc)).toContain("Sample temporary warning");
    expect(headingsIn(tempInstallDoc)).not.toContain("Warnings:");

    const tempRemoveDoc = temporaryInstallationDocument("remove-temp", tempReceipt);
    const tempRemoveNodes = flattenPresentationNodes(tempRemoveDoc);
    expect(tempRemoveNodes[0]?.kind).toBe("notice");
    expect(tempRemoveNodes[2]).toMatchObject({ kind: "list", category: "warning" });
    expect(renderBoundary(tempRemoveDoc)).toContain("Sample temporary warning");
    expect(headingsIn(tempRemoveDoc)).not.toContain("Warnings:");
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
      ],
      mustState: ["Git index", "files stay on disk", "leave the files in place"],
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit update '/project-a'",
        "apkit uninstall --project '/project-a'",
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
        "apkit uninstall --project '/project-a'",
        "apkit update '/project-a'",
      ],
      mustState: ["remove its generated files and stop managing this Project"],
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
        "apkit update --all",
      ],
      bannedCommands: ["apkit update '/project-a'", "apkit uninstall"],
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
        "apkit update --all",
      ],
      bannedCommands: ["apkit update '/project-a'", "apkit uninstall"],
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
      expectedCommands: ["apkit update --all"],
      bannedCommands: ["apkit update '/project-a'", "apkit uninstall"],
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
        "apkit update '/project-a'",
      ],
      mustState: ["Git index", "files stay on disk", "leave the files in place"],
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
        "apkit update '/project-a'",
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
      expectedCommands: ["apkit uninstall --project '/project-a'"],
      bannedCommands: ["install-temp"],
      mustState: ["stop managing this Project", "retry your original command"],
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
    expect(commands(wording(blocker).remedy)).toContain("apkit update '/project-a'");
    expect(commands(wording(blocker).remedy)).not.toContain("apkit uninstall --project '/project-a'");
  });

  test("uninstallAlternative emits honest prose when the command cannot be derived (INT-1)", () => {
    const unquotableProject = "/project-a\u0007";
    const blocker = normalizeBlocker(occupiedOutputBlocker({
      occupied: { case: "occupied-destination", occupation: "directory" },
      path: ".opencode/opencode.json",
      project: unquotableProject,
    }));
    const { remedy } = flat(blocker);
    expect(remedy).toContain(
      "or remove its generated files and stop managing this Project yourself",
    );
    // No dangling "; or run" lead-in and no empty command (INT-1).
    expect(remedy).not.toContain("; or run");
    expect(remedy).not.toMatch(/or run\s+to /);
    expect(commands(wording(blocker).remedy).some((command) => command.includes("uninstall")))
      .toBe(false);
  });

  test("untrack-undefined branch emits honest prose with no dangling then-run (INT-1)", () => {
    const unquotableProject = "/project-a\u0007";
    const blocker = normalizeBlocker(outputOwnershipConflictBlocker({
      paths: ["broken\nname.md"],
      project: unquotableProject,
    }));
    const { remedy } = flat(blocker);
    expect(remedy).toContain("Manual recovery is required");
    expect(remedy).toContain("leave the files in place to keep Git ownership");
    // No dangling "then run" without a command (INT-1).
    expect(remedy).not.toContain("then run");
    expect(commands(wording(blocker).remedy)).toEqual([]);
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

  test("the created receipt names the Workspace, concept explanations, and the zero-Profile creation next step", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: join(home, "apkit-workspace"),
      authoredPath: join(home, "apkit-workspace"),
      folderCreated: true,
      detectedHosts: ["codex"],
      configurationWritten: true,
      configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
      addedParts: ["workspace.yaml", "context", "skills", "profiles"],
      profileCount: 0,
    });
    // Success headline (Workspace), 3 concept paragraphs, agents found, then Next actions footer.
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "prose",
      "prose",
      "prose",
      "sentence",
      "heading",
      "list",
    ]);
    const receiptNodes = flattenPresentationNodes(document);
    expect(receiptNodes[0]).toMatchObject({ kind: "sentence", category: "success" });
    const text = documentText(document);
    // Settings and added parts are dropped from the setup receipt (spec #672, #676).
    expect(text).not.toContain("settings:");
    expect(text).not.toContain("Added ");
    // Concept paragraphs (DEC-005 exception).
    expect(receiptNodes).toContainEqual({
      kind: "prose",
      parts: ["Profiles group Context and Skills for one kind of work. You can reuse them across Projects."],
    });
    expect(text).toContain("Skills are the skills you already use (open standard). Drop skill folders into");
    expect(text).toContain("Context is plain Markdown in");
    expect(receiptNodes).toContainEqual({
      kind: "sentence",
      parts: ["Agents found: ", { kind: "identifier", value: "codex" }],
    });
    // Setup just validated; never recommend `apkit validate` (spec #640 US-002).
    expect(text).not.toContain("apkit validate");
    // Zero Profiles: guided Profile creation next step with note.
    expect(text).toContain("apkit new profile");
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("apkit new profile (create your first Profile, step by step)");
  });

  test("zero Profiles with existing Context route to guided Profile creation with note", () => {
    const document = initReceiptDocument({
      outcome: "connected",
      path: join(home, "apkit-workspace"),
      authoredPath: "~/apkit-workspace",
      configurationWritten: true,
      configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
      addedParts: ["profiles"],
      profileCount: 0,
    });
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "prose",
      "prose",
      "prose",
      "heading",
      "list",
    ]);
    const text = documentText(document);
    expect(text).not.toContain("apkit new context");
    expect(text).toContain("apkit new profile");
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("apkit new profile (create your first Profile, step by step)");
    expect(text).not.toContain("settings:");
    expect(text).not.toContain("apkit validate");
  });

  test("one or more Profiles route to bare install without naming a Profile", () => {
    for (const profileCount of [1, 3]) {
      const document = initReceiptDocument({
        outcome: "connected",
        path: join(home, "apkit-workspace"),
        authoredPath: "~/apkit-workspace",
        configurationWritten: true,
        configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
        addedParts: ["workspace.yaml"],
        profileCount,
      });
      expect(shapes(document)).toEqual([
        "sentence(success)",
        "key-value:Next(command)",
      ]);
      expect(keyValuesIn(document, "Next")).toEqual([{
        kind: "key-value",
        key: "Next",
        category: "command",
        value: {
          kind: "command",
          program: "apkit",
          args: [{ kind: "text", value: "install" }],
          note: "run it inside a Project folder",
        },
      }]);
      const text = documentText(document);
      expect(text).not.toContain("apkit validate");
      expect(text).not.toContain("apkit new profile");
      expect(text).not.toContain("settings:");
    }
  });

  test("the receipt drops the settings path and added parts", () => {
    const document = initReceiptDocument({
      outcome: "connected",
      path: join(home, "apkit-workspace"),
      authoredPath: "~/apkit-workspace",
      addedParts: ["context", "profiles"],
      profileCount: 0,
      configurationWritten: true,
      configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
    });
    const text = documentText(document);
    expect(text).not.toContain("settings:");
    expect(text).not.toContain("config.yaml");
    expect(text).not.toContain("Added ");
  });

  test("no detected Hosts states so and still routes the handoff", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: join(home, "apkit-workspace"),
      authoredPath: "~/apkit-workspace",
      folderCreated: true,
      detectedHosts: [],
      configurationWritten: true,
      configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
      addedParts: ["workspace.yaml", "context", "skills", "profiles"],
      profileCount: 0,
    });
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "sentence" && nodeText(node) === "Agents found: none",
    )).toBe(true);
    expect(documentText(document)).toContain("apkit new profile");
  });

  test("several detected Hosts never enter the handoff", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: join(home, "apkit-workspace"),
      authoredPath: "~/apkit-workspace",
      folderCreated: true,
      detectedHosts: ["antigravity", "claude", "codex"],
      addedParts: [],
      profileCount: 1,
      configurationWritten: true,
      configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
    });
    const detected = document.flatMap((partNode) => partNode.kind === "part" ? partNode.nodes : [partNode])
      .find((node) => node.kind === "sentence" && node.parts[0] === "Agents found: ");
    expect(detected).toMatchObject({
      kind: "sentence",
      parts: ["Agents found: ", { kind: "identifier", value: "antigravity, claude, codex" }],
    });
    const text = documentText(document);
    expect(text).not.toContain("--host");
    expect(text).not.toContain("apkit validate");
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "key-value" && node.value.kind === "command" &&
      node.value.args.length === 1 && node.value.args[0]!.kind === "text" &&
      node.value.args[0]!.value === "install" &&
      node.value.note === "run it inside a Project folder"
    )).toBe(true);
  });

  test("the migrated receipt routes the handoff and keeps missing Profile bindings in the body", () => {
    const document = initReceiptDocument({
      outcome: "migrated",
      path: "/test/workspace",
      authoredPath: "/test/workspace",
      configurationWritten: true,
      configurationPath: "/home/test/.agents/agent-profile-kit/config.yaml",
      addedParts: ["skills"],
      profileCount: 0,
      missingProfileBindings: [{ project: "/projects/demo", profile: "coding" }],
    });
    const text = documentText(document);
    expect(text).toContain("Project Bindings whose Profile this Workspace lacks:");
    expect(text).toContain("apkit new profile coding");
    expect(text).toContain("apkit new profile");
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("apkit new profile (create your first Profile, step by step)");
    expect(text).not.toContain("apkit validate");
  });

  test("the unchanged receipt is a clean no-op with no next action", () => {
    const unchanged = initReceiptDocument({
      outcome: "unchanged",
      path: `/test/workspace`,
      authoredPath: `/test/workspace`,
      profileCount: 2,
      configurationWritten: false,
      configurationPath: `/home/test/.agents/agent-profile-kit/config.yaml`,
    });
    expect(shapes(unchanged)).toEqual(["sentence(neutral)"]);
    expect(documentText(unchanged)).not.toContain("Next:");
    expect(documentText(unchanged)).not.toContain("apkit validate");
  });

  test("hasProfiles is the single authority for zero-Profile vs with-Profile routing", () => {
    expect(hasProfiles({ profileCount: 0 })).toBe(false);
    expect(hasProfiles({ profileCount: 1 })).toBe(true);
    expect(hasProfiles({ profileCount: 5 })).toBe(true);
  });

  test("initConfirmationDocument with missing folder lists parts as bullets", () => {
    const document = initConfirmationDocument({
      destinationPath: "/private/tmp/apkit-session/workspace",
      authoredPath: "./workspace",
      folderMissing: true,
      missingParts: ["workspace.yaml", "context", "skills", "profiles"],
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("Context, Skills, and Profiles will be stored in and loaded from");
    expect(rendered).toContain("This folder doesn't exist yet. Setup will create it and add:");
    expect(rendered).toContain("- workspace.yaml");
    expect(rendered).toContain("- context/");
    expect(rendered).toContain("- skills/");
    expect(rendered).toContain("- profiles/");
  });

  test("initConfirmationDocument with complete existing folder states it has everything", () => {
    const document = initConfirmationDocument({
      destinationPath: "/private/tmp/apkit-session/workspace",
      authoredPath: "./workspace",
      folderMissing: false,
      missingParts: [],
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("Context, Skills, and Profiles will be stored in and loaded from");
    expect(rendered).toContain("This folder already has everything it needs.");
    expect(rendered).not.toContain("Setup will add");
  });

  test("initConfirmationDocument renders cleanly at 100 and 60 columns", () => {
    const document = initConfirmationDocument({
      destinationPath: "/private/tmp/apkit-session/workspace",
      authoredPath: "~/workspace",
      folderMissing: true,
      missingParts: ["workspace.yaml", "context", "skills", "profiles"],
    });
    for (const width of [100, 60] as const) {
      const rendered = renderPresentationDocument(document, { ...defaultRenderContext, width });
      // Narrow widths wrap the sentence across lines; compare on squashed text.
      const squashed = rendered.replace(/\s+/g, " ");
      expect(squashed).toContain(
        "Context, Skills, and Profiles will be stored in and loaded from",
      );
      expect(squashed).toContain("This folder doesn't exist yet. Setup will create it and add:");
      expect(rendered).toContain("- workspace.yaml");
      for (const line of rendered.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("setup receipt names actual Workspace skills/ and context/ folders, never literal 'workspace/'", () => {
    const customWorkspace = join(home, "my-team-kit");
    const document = initReceiptDocument({
      outcome: "created",
      path: customWorkspace,
      authoredPath: "~/my-team-kit",
      folderCreated: true,
      detectedHosts: ["claude", "codex"],
      configurationWritten: true,
      configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
      addedParts: ["workspace.yaml", "context", "skills", "profiles"],
      profileCount: 0,
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("Created your Workspace at");
    expect(rendered).toContain("Profiles group Context and Skills for one kind of work.");
    // Mentions actual display path of skills and context subfolders, not literal 'workspace/skills/'
    expect(rendered).toContain("~/my-team-kit/skills/");
    expect(rendered).toContain("~/my-team-kit/context/");
    expect(rendered).not.toContain("workspace/skills/");
    expect(rendered).not.toContain("workspace/context/");
    expect(rendered).toContain("Agents found: claude, codex");
    expect(rendered).toContain("Next:\n- apkit new profile (create your first Profile, step by step)");
  });

  test("reconnect setup receipt with Profiles does not explain concepts again", () => {
    const customWorkspace = join(home, "my-team-kit");
    const document = initReceiptDocument({
      outcome: "connected",
      path: customWorkspace,
      authoredPath: "~/my-team-kit",
      folderCreated: false,
      detectedHosts: ["claude", "codex"],
      configurationWritten: true,
      configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
      addedParts: [],
      profileCount: 2,
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("Connected your Workspace at");
    expect(rendered).not.toContain("Profiles group Context and Skills");
    expect(rendered).not.toContain("Skills are the skills you already use");
    expect(rendered).not.toContain("Context is plain Markdown");
    expect(rendered).toContain("Agents found: claude, codex");
    expect(rendered).toContain("Next: apkit install (run it inside a Project folder)");
  });

  test("emptyWorkspaceProfileCreationDocument uses workspaceSubfolderDisplay and notedCommand", () => {
    const customWorkspace = join(home, "custom-agent-folder");
    const document = emptyWorkspaceProfileCreationDocument(customWorkspace, "~/custom-agent-folder");
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("A Profile needs at least one Context file or Skill, and your Workspace has none yet.");
    expect(rendered).toContain("Add some first:");
    expect(rendered).toContain("Put skill folders in ~/custom-agent-folder/skills/");
    expect(rendered).not.toContain("workspace/skills/");
    expect(rendered).toContain("apkit new context <name> (create a Context file to fill in)");
    expect(rendered).toContain("Then run apkit new profile again.");
  });

  test("the created install receipt states the stable Project path, Profile once, and Hosts", () => {
    const document = installReceiptDocument({
      outcome: "created",
      canonicalProject: projectPath,
      project: projectPath,
      profile: "coding",
      hosts: ["codex", "pi"],
    });
    // The `Next:` action list is the one footer, appended by the install
    // command after body guidance (US-010).
    expect(shapes(document)).toEqual([
      "sentence(success)",
      "key-value:Profile(path)",
      "key-value:Agents",
    ]);
    const installNodes = flattenPresentationNodes(document);
    expect(installNodes[1]).toEqual({
      kind: "key-value",
      key: "  Profile",
      value: { kind: "identifier", value: "coding" },
      category: "path",
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext, {
      home,
      cwd: home,
    });
    expect(rendered).toContain("Installed for ~/projects/demo");
    expect(rendered).not.toContain("Installed coding for");
    // Profile is stated once across the headline and body (US-006).
    expect(rendered.split("coding").length - 1).toBe(1);
    expect(rendered).toContain("Agents: codex, pi");
    expect(rendered).not.toMatch(/generated files:|outputs:|Removed /i);
  });

  test("the replaced install receipt keeps Profile once and arrows only on changed fields", () => {
    const hostsOnly = installReceiptDocument({
      outcome: "replaced",
      canonicalProject: projectPath,
      project: projectPath,
      profile: "coding",
      hosts: ["codex"],
      previous: { profile: "coding", hosts: ["codex", "pi"] },
    });
    // Profile stays stated once even when only Hosts change (US-006).
    expect(shapes(hostsOnly)).toEqual([
      "sentence(success)",
      "key-value:Profile(path)",
      "key-value:Agents",
    ]);
    expect(keyValuesIn(hostsOnly, "  Profile")).toEqual([{
      kind: "key-value",
      key: "  Profile",
      value: { kind: "identifier", value: "coding" },
      category: "path",
    }]);
    expect(keyValuesIn(hostsOnly, "  Agents")).toEqual([{
      kind: "key-value",
      key: "  Agents",
      value: { kind: "identifier", value: "codex, pi → codex" },
    }]);

    const profileChange = installReceiptDocument({
      outcome: "replaced",
      canonicalProject: projectPath,
      project: projectPath,
      profile: "ops",
      hosts: ["codex"],
      previous: { profile: "coding", hosts: ["codex"] },
    });
    expect(keyValuesIn(profileChange, "  Profile")).toEqual([{
      kind: "key-value",
      key: "  Profile",
      value: { kind: "identifier", value: "coding → ops" },
      category: "path",
    }]);
    expect(keyValuesIn(profileChange, "  Agents")).toEqual([{
      kind: "key-value",
      key: "  Agents",
      value: { kind: "identifier", value: "codex" },
    }]);
  });

  test("the unchanged install receipt stays informational on the stable Project path", () => {
    const unchangedInstall = installReceiptDocument({
      outcome: "unchanged",
      canonicalProject: projectPath,
      project: projectPath,
      profile: "coding",
      hosts: ["codex"],
    });
    // One neutral statement (US-003, US-010); no next action.
    expect(shapes(unchangedInstall)).toEqual(["sentence(neutral)"]);
    const rendered = renderPresentationDocument(unchangedInstall, defaultRenderContext, {
      home,
      cwd: home,
    });
    expect(rendered).toContain("Installation unchanged for ~/projects/demo");
  });

  test("install receipt names the Project by its stable path across created, unchanged, and replaced outcomes even inside the project", () => {
    const created = installReceiptDocument({
      outcome: "created",
      canonicalProject: projectPath,
      project: ".",
      profile: "coding",
      hosts: ["codex"],
    });
    expect(flattenPresentationNodes(created)[0]).toEqual({
      kind: "sentence",
      parts: [
        "✔ ",
        "Installed for ",
        {
          kind: "path",
          canonicalPath: projectPath,
          scope: "fleet",
          authoredPath: ".",
        },
      ],
      category: "success",
    });

    const unchanged = installReceiptDocument({
      outcome: "unchanged",
      canonicalProject: projectPath,
      project: ".",
      profile: "coding",
      hosts: ["codex"],
    });
    expect(flattenPresentationNodes(unchanged)[0]).toEqual({
      kind: "sentence",
      parts: [
        "● ",
        "Installation unchanged for ",
        {
          kind: "path",
          canonicalPath: projectPath,
          scope: "fleet",
          authoredPath: ".",
        },
        ".",
      ],
      category: "neutral",
    });

    const replaced = installReceiptDocument({
      outcome: "replaced",
      canonicalProject: projectPath,
      project: ".",
      profile: "ops",
      hosts: ["codex", "claude"],
      previous: { profile: "coding", hosts: ["codex"] },
    });
    expect(flattenPresentationNodes(replaced)[0]).toEqual({
      kind: "sentence",
      parts: [
        "✔ ",
        "Replaced installation for ",
        {
          kind: "path",
          canonicalPath: projectPath,
          scope: "fleet",
          authoredPath: ".",
        },
      ],
      category: "success",
    });
    for (const document of [created, unchanged, replaced]) {
      const rendered = renderPresentationDocument(document, defaultRenderContext, {
        home,
        cwd: home,
      });
      expect(rendered).toContain("~/projects/demo");
    }
  });

  test("the uninstall receipt states forgetting with its compact count", () => {
    const document = uninstallReceiptDocument({
      completed: [{
        canonicalProject: projectPath,
        project: projectPath,
        profile: "coding",
        outputs: [".codex/hooks.json"],
      }],
      skipped: [],
      unattempted: [],
      warnings: [],
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext);
    expect(rendered).toContain("1 Project");
    expect(rendered).toContain("forgot");
    expect(rendered).not.toContain(".codex/hooks.json");
  });

  test("the uninstall execution failure carries retry evidence", () => {
    const document = uninstallExecutionFailureDocument({
      failed: {
        project: "/opt/authored/demo",
        profile: "coding",
        detail: "injected fault",
        selectionRestored: true,
        concurrentSelectionChange: false,
      },
      completed: [],
      unattempted: [],
      retryArguments: [
        { kind: "text", value: "uninstall" },
        { kind: "text", value: "--all" },
      ],
    });
    expect(inlineCommandTexts(document)).toEqual(["apkit uninstall --all"]);
  });
});

describe("missing-Host warnings (US-011, DEC-007, DEC-009)", () => {
  const codexMissing = {
    problem: "Codex CLI was not found on PATH",
    remedy: "install Codex and ensure `codex --version` works before checking status or updating Profiles that require Codex Host capabilities",
    requirement: "The selected Profile requires Codex project delivery",
    copyableValues: ["codex"],
  };
  const claudeMissing = {
    problem: "Claude Code CLI was not found on PATH",
    remedy: "install Claude Code and ensure `claude --version` works before checking status or updating the Profile",
    requirement: "The selected Profile requires Claude Code project delivery",
    copyableValues: ["claude"],
  };

  function hostAttentionWarning(input: {
    readonly problem: string;
    readonly remedy: string;
    readonly requirement: string;
    readonly copyableValues?: readonly string[];
    readonly problemParts?: readonly InlineContent[];
    readonly remedyParts?: readonly InlineContent[];
    readonly requirementParts?: readonly InlineContent[];
  }): ReconciliationWarning {
    return {
      kind: "host-attention",
      copyableValues: input.copyableValues ?? [],
      parts: [`${input.problem}; ${input.remedy}`],
      problem: input.problemParts ?? [input.problem],
      remedy: input.remedyParts ?? [input.remedy],
      requirement: input.requirementParts ?? [input.requirement],
    };
  }

  test("a single Project missing one Host names that Project and keeps the outcome successful", () => {
    const report = machineReport([
      machineProject("~/projects/demo", {
        warnings: [hostAttentionWarning(codexMissing)],
      }),
    ]);
    const install = [...installReceiptDocument({
      canonicalProject: "~/projects/demo",
      hosts: ["codex"],
      outcome: "created",
      profile: "coding",
      project: "~/projects/demo",
    }), ...installWarningNodes(report)];
    const update = applyReportDocument({
      receipt: emptyReport({
        desired: [{
          canonicalProject: "~/projects/demo",
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project: "~/projects/demo",
          resolvedArtifacts: [],
        }],
        items: [{ kind: "addition", project: "~/projects/demo" }],
        outputs: [{ kind: "addition", path: "a.md", project: "~/projects/demo" }],
      }),
      resultingState: report,
    });

    for (const document of [install, update]) {
      const rendered = renderBoundary(document);
      // US-011: the completed outcome stays truthful and separate.
      expect(rendered).toStartWith("✔ ");
      expect(rendered).toContain("Codex CLI was not found on PATH (~/projects/demo)");
      expect(rendered).not.toContain("(1 Project)");
      expect(rendered).toContain("Requirement: The selected Profile requires Codex project delivery");
      expect(rendered).toContain("Remedy: install Codex and ensure `codex --version` works");
      // Never claim Host loading or that the missing Host failed the update.
      expect(rendered).not.toMatch(/proved Host loading|Host loaded the material|update failed because/i);
    }
    expect(renderBoundary(install)).toContain("Installed for ~/projects/demo");
    expect(renderBoundary(update)).toContain("Update complete");
  });

  test("one Host missing across several Projects names every Project once with one remedy", () => {
    const warning = hostAttentionWarning(codexMissing);
    const report = machineReport([
      machineProject("/work/alpha", { warnings: [warning] }),
      machineProject("/work/beta", { warnings: [warning] }),
      machineProject("/work/gamma", { warnings: [warning] }),
    ]);
    const document = applyReportDocument({
      receipt: emptyReport({
        desired: ["/work/alpha", "/work/beta", "/work/gamma"].map((project) => ({
          canonicalProject: project,
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project,
          resolvedArtifacts: [],
        })),
        items: ["/work/alpha", "/work/beta", "/work/gamma"].map((project) => ({ kind: "addition" as const, project })),
        outputs: ["/work/alpha", "/work/beta", "/work/gamma"].map((project) => ({ kind: "addition" as const, path: "a.md", project })),
      }),
      resultingState: report,
    });
    const rendered = renderBoundary(document);
    expect(rendered).toStartWith("✔ Update complete");
    // One warning statement names every affected Project (view identity).
    expect(rendered).toContain("Codex CLI was not found on PATH (alpha, beta, gamma)");
    expect(rendered).not.toContain("(3 Projects)");
    // The identical Adapter-authored remedy appears once.
    expect(rendered.split("Remedy: install Codex").length - 1).toBe(1);
  });

  test("a warning that survived installer host-scope dedup names every affected Project once (#668)", () => {
    // The installer keeps one host-attention warning per Host on the first
    // Project in canonical order; the carrying record's Project is one of the
    // affectedProjects, so the seed must be the only home for the set (no
    // second union path that could double count).
    const warning = {
      ...hostAttentionWarning(codexMissing),
      affectedProjects: ["/fleet/alpha/my-app", "/fleet/beta/my-app", "/fleet/hello"],
    };
    const report = machineReport([
      machineProject("/fleet/alpha/my-app", { warnings: [warning] }),
      machineProject("/fleet/beta/my-app"),
      machineProject("/fleet/hello"),
    ]);
    const document = applyReportDocument({
      receipt: emptyReport({
        desired: ["/fleet/alpha/my-app", "/fleet/beta/my-app", "/fleet/hello"].map((project) => ({
          canonicalProject: project,
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project,
          resolvedArtifacts: [],
        })),
        items: ["/fleet/alpha/my-app", "/fleet/beta/my-app", "/fleet/hello"].map((project) => ({ kind: "addition" as const, project })),
        outputs: ["/fleet/alpha/my-app", "/fleet/beta/my-app", "/fleet/hello"].map((project) => ({ kind: "addition" as const, path: "a.md", project })),
      }),
      resultingState: report,
    });
    const rendered = renderBoundary(document);
    expect(rendered).toContain("Codex CLI was not found on PATH (alpha/my-app, beta/my-app, hello)");
    expect(rendered.split("(alpha/my-app, beta/my-app, hello)").length - 1).toBe(1);
  });

  test("two Hosts keep separate warning lines with their own remedy and requirement", () => {
    const report = machineReport([
      machineProject("/work/alpha", {
        warnings: [hostAttentionWarning({ ...codexMissing, problem: "Codex CLI was not found on PATH" })],
      }),
      machineProject("/work/beta", {
        warnings: [
          hostAttentionWarning({ ...codexMissing, problem: "Codex CLI was not found on PATH" }),
          hostAttentionWarning(claudeMissing),
        ],
      }),
    ]);
    const document = applyReportDocument({
      receipt: emptyReport({
        desired: ["/work/alpha", "/work/beta"].map((project) => ({
          canonicalProject: project,
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project,
          resolvedArtifacts: [],
        })),
        items: ["/work/alpha", "/work/beta"].map((project) => ({ kind: "addition" as const, project })),
        outputs: ["/work/alpha", "/work/beta"].map((project) => ({ kind: "addition" as const, path: "a.md", project })),
      }),
      resultingState: report,
    });
    const rendered = renderBoundary(document);
    expect(rendered).toStartWith("✔ Update complete");
    // Different Hosts: each keeps its own Adapter-authored remedy and requirement.
    expect(rendered).toContain("Codex CLI was not found on PATH (alpha, beta)");
    expect(rendered).toContain("Remedy: install Codex and ensure `codex --version` works");
    expect(rendered).toContain("Requirement: The selected Profile requires Codex project delivery");
    expect(rendered).toContain("Claude Code CLI was not found on PATH (beta)");
    expect(rendered).toContain("Remedy: install Claude Code and ensure `claude --version` works");
    expect(rendered).toContain("Requirement: The selected Profile requires Claude Code project delivery");
    // No synthesized merge of two Host remedies.
    expect(rendered).not.toContain("install Codex and Claude Code");
  });

  test("a fleet-scale missing-Host list names Projects and points at --verbose instead of dropping any", () => {
    const warning = hostAttentionWarning({
      problem: "Pi CLI was not found on PATH",
      remedy: "install Pi and ensure `pi --version` works before checking status or updating the Profile",
      requirement: "The selected Profile requires Pi project delivery",
      copyableValues: ["pi"],
    });
    const projects = Array.from({ length: 12 }, (_, index) => `/fleet/p${index + 1}`);
    const report = machineReport(
      projects.map((project) => machineProject(project, { warnings: [warning] })),
    );
    const document = applyReportDocument({
      receipt: emptyReport({
        desired: projects.map((project) => ({
          canonicalProject: project,
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project,
          resolvedArtifacts: [],
        })),
        items: projects.map((project) => ({ kind: "addition" as const, project })),
        outputs: projects.map((project) => ({ kind: "addition" as const, path: "a.md", project })),
      }),
      resultingState: report,
    });
    const rendered = renderBoundary(document);
    // Canonical sort keeps the see-all pointer truthful and deterministic.
    expect(rendered).toContain("Pi CLI was not found on PATH (p1, p10, p11, p12, … 8 more Projects; use --verbose to see all Projects)");
    expect(rendered).not.toContain("(12 Projects)");
    const verbose = renderBoundary(applyReportDocument({
      receipt: emptyReport(),
      resultingState: report,
    }, { verbose: true }));
    for (const project of projects) {
      expect(verbose).toContain(project);
    }
    expect(verbose).toContain("(/fleet/p1, /fleet/p10");
  });

  test("remedy stays default-colored while the warning statement carries the warning role", () => {
    const report = machineReport([
      machineProject("/work/alpha", { warnings: [hostAttentionWarning(codexMissing)] }),
    ]);
    const document = applyReportDocument({
      receipt: emptyReport({
        desired: [{
          canonicalProject: "/work/alpha",
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project: "/work/alpha",
          resolvedArtifacts: [],
        }],
        items: [{ kind: "addition", project: "/work/alpha" }],
        outputs: [{ kind: "addition", path: "a.md", project: "/work/alpha" }],
      }),
      resultingState: report,
    });
    const items = listPartsIn(document).filter((item) => item.length > 0);
    expect(items).toHaveLength(1);
    expect(flatInlineText(items[0]!)).toContain("Codex CLI was not found on PATH");
    const remedies = flattenPresentationNodes(document).filter((node) =>
      node.kind === "prose" && nodeText(node).startsWith("  Remedy: ")
    );
    expect(remedies).toHaveLength(1);
    expect((remedies[0] as { category?: string }).category).toBeUndefined();
  });

  test("a structurally marked remedy command renders as an atomic command part", () => {
    const report = machineReport([
      machineProject("/work/alpha", {
        warnings: [hostAttentionWarning({
          ...codexMissing,
          remedyParts: [
            "install Codex and ensure ",
            commandPart("codex", [{ kind: "text", value: "--version" }]),
            " works",
          ],
        })],
      }),
    ]);
    const nodes = flattenPresentationNodes([
      ...installWarningNodes(report),
    ]);
    const remedy = nodes.find((node) =>
      node.kind === "prose" && nodeText(node).includes("Remedy:")
    ) as Extract<PresentationNode, { kind: "prose" }> | undefined;
    expect(remedy).toBeDefined();
    expect(remedy!.parts.some((part) =>
      typeof part !== "string" && part.kind === "command" && part.program === "codex"
    )).toBe(true);
  });

  test("a plain-string remedy with markdown backticks is left unparsed", () => {
    const report = machineReport([
      machineProject("/work/alpha", { warnings: [hostAttentionWarning(codexMissing)] }),
    ]);
    const remedy = flattenPresentationNodes(installWarningNodes(report)).find((node) =>
      node.kind === "prose" && nodeText(node).startsWith("  Remedy: ")
    ) as Extract<PresentationNode, { kind: "prose" }> | undefined;
    expect(remedy).toBeDefined();
    // Correction: do not parse markdown backticks out of a plain string.
    expect(flatInlineText(remedy!.parts)).toContain("`codex --version`");
    expect(remedy!.parts.some((part) => typeof part !== "string" && part.kind === "command")).toBe(false);
  });

  test("capabilityWarning carries typed problem, remedy, and requirement for presentation", () => {
    const failure = capabilityFailure(
      "codex",
      "host",
      codexMissing.problem,
      codexMissing.remedy,
    );
    const warning = capabilityWarning("codex", failure);
    expect(warning.problem).toBe(codexMissing.problem);
    expect(warning.remedy).toBe(codexMissing.remedy);
    expect(warning.requirement).toBe(codexMissing.requirement);
  });

  test("a Project in only one report set uses the view's unioned identity (INT-1)", () => {
    // `/teams/alpha/tools` exists only in the receipt; `/teams/beta/tools`
    // only in resulting state. A unioned lookup must give `alpha/tools`
    // (two segments because both end in `tools`), not a full-path fallback
    // and not the one-set basename `tools`.
    const receipt = machineReport([
      machineProject("/teams/alpha/tools", {
        warnings: [hostAttentionWarning(codexMissing)],
      }),
    ]);
    const resultingState = machineReport([
      machineProject("/teams/beta/tools"),
    ]);
    const rendered = renderBoundary(applyReportDocument({ receipt, resultingState }));
    expect(rendered).toContain("Codex CLI was not found on PATH (alpha/tools)");
    expect(rendered).not.toContain("/teams/alpha/tools");
    expect(rendered).not.toContain("Codex CLI was not found on PATH (tools)");
  });

  test("identical machine messages with different typed splits never merge (INT-2)", () => {
    const report = machineReport([
      machineProject("/work/a", {
        warnings: [{
          kind: "host-attention",
          copyableValues: [],
          parts: ["Same message"],
          problem: ["Same message"],
          remedy: ["Remedy A"],
          requirement: ["Requirement A"],
        }],
      }),
      machineProject("/work/b", {
        warnings: [{
          kind: "host-attention",
          copyableValues: [],
          parts: ["Same message"],
          problem: ["Same message"],
          remedy: ["Remedy B"],
          requirement: ["Requirement B"],
        }],
      }),
    ]);
    const rendered = renderBoundary(applyReportDocument({
      receipt: emptyReport({
        desired: ["/work/a", "/work/b"].map((project) => ({
          canonicalProject: project,
          context: "composed",
          outputs: ["a.md"],
          profile: "coding",
          project,
          resolvedArtifacts: [],
        })),
        items: ["/work/a", "/work/b"].map((project) => ({ kind: "addition" as const, project })),
        outputs: ["/work/a", "/work/b"].map((project) => ({ kind: "addition" as const, path: "a.md", project })),
      }),
      resultingState: report,
    }));
    expect(rendered).toContain("Remedy: Remedy A");
    expect(rendered).toContain("Remedy: Remedy B");
    expect(rendered).toContain("Requirement: Requirement A");
    expect(rendered).toContain("Requirement: Requirement B");
    // Two warning statements: the typed splits kept the groups distinct.
    expect(rendered.split("Same message").length - 1).toBe(2);
  });
});

/**
 * Render one node alone: for asserting an atomic inline value survives as one
 * whole line (the structural replacement for the copyable-value list).
 */
function renderedNodeLine(node: PresentationNode): string {
  return renderPresentationDocument([node], { color: false, interactive: false, width: 40 , rows: undefined });
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
    expect(flattenPresentationNodes(document)[2]).toEqual({
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
    const commandLines = flattenPresentationNodes(document)
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
    expect(flattenPresentationNodes(document)[2]).toEqual({
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
    const commandLines = flattenPresentationNodes(document)
      .filter((node) => node.kind === "sentence" && node.category === "command")
      .map(renderedNodeLine);
    for (const example of status.examples) {
      expect(commandLines).toContain(`  apkit ${example}`);
    }
  });

  test("focused command help lists supported Hosts when the command carries them", () => {
    const install = defaultCommands().find((command) => command.name === "install")!;
    const document = commandHelpDocument(install);
    const sections = shapes(document);
    const documentNodes = flattenPresentationNodes(document);
    const examplesIndex = sections.indexOf("heading");
    // The Supported Hosts sentence sits after Examples and before Writes.
    const hostIndex = sections.indexOf("sentence(heading)", examplesIndex + 1);
    expect(sections.indexOf("sentence(heading)", hostIndex + 1)).toBeGreaterThan(hostIndex);
    expect(documentNodes.some((node) =>
      node.kind === "sentence" && nodeText(node).includes(
        `Supported agents: ${install.supportedHosts!.join(", ")}`),
    )).toBe(true);
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
    const machineSyntaxLines = flattenPresentationNodes(document)
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
      "sentence(command)",
      "sentence",
      "spacer",
      "heading",
      "sentence(command)",
      "sentence(command)",
      "sentence(command)",
      "sentence(command)",
    ]);
    // Every route and example line is one atomic command: one whole line each.
    const routeLines = flattenPresentationNodes(document)
      .filter((node) => node.kind === "sentence" && node.category === "command")
      .map(renderedNodeLine);
    expect(routeLines).toEqual([
      "  apkit guide profile",
      "  apkit guide context",
      "  apkit guide skill",
      "  apkit guide --contract",
      "  apkit guide --full",
      "  apkit guide --agent",
      "  apkit init <path>",
      "  apkit new skill <skill>",
      "  apkit guide profile",
      "  apkit install example --agent codex",
    ]);
    // Defect pin (#510): the index title renders as terminal content, not the
    // raw markdown heading. Fails on the pre-#510 rendering.
    const rendered = renderBoundary(document, {
      color: false,
      interactive: true,
      width: 80,
      rows: undefined,
    });
    expect(rendered.split("\n")[0]).toBe("Agent Profile Kit guide");
    expect(rendered).not.toContain("# Agent Profile Kit guide");
  });

  test("the focused guide renders its heading and examples as terminal content, not raw markdown (#510)", () => {
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
      "sentence",
      "sentence(command)",
      "sentence(command)",
      "spacer",
      "sentence",
      "spacer",
      "verbatim",
      "spacer",
      "sentence",
      "spacer",
      "verbatim",
      "spacer",
      "sentence(command)",
      "spacer",
      "sentence",
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
    const guideNodes = flattenPresentationNodes(document);
    // Each example leads with one wrapping sentence, then the verbatim body.
    const exampleIndex = guideNodes.findIndex((node) =>
      node.kind === "sentence" && nodeText(node) === `An example ${example.path}:`);
    expect(exampleIndex).toBeGreaterThan(-1);
    expect(guideNodes[exampleIndex + 2]).toEqual({
      kind: "verbatim",
      text: example.contents,
    });
    expect(guideNodes).toContainEqual({
      kind: "sentence",
      parts: [`An example ${contextExample.path}:`],
    });
    expect(guideNodes).toContainEqual({
      kind: "verbatim",
      text: contextExample.contents,
    });
    // The next action is structured text plus command atoms: prose reflows
    // and commands stay whole without a trailing period on a promoted line.
    expect(guideNodes.at(-3)).toMatchObject({
      kind: "sentence",
      parts: ["Next: from the project you want to try, run ", { kind: "command" }],
    });
    // Defect pins (#510): the raw markdown decoration is gone from rendered
    // output. Every pin fails on the pre-#510 rendering, which printed the
    // literal `# Profile` heading and the ```yaml / ```md fences.
    const rendered = renderBoundary(document, {
      color: false,
      interactive: true,
      width: 80,
      rows: undefined,
    });
    expect(rendered.split("\n")[0]).toBe("Profile");
    expect(rendered).not.toContain("# Profile");
    expect(rendered).not.toContain("```yaml");
    expect(rendered).not.toContain("```md");
    // Example bodies stay copyable: every code line renders whole.
    const renderedLines = rendered.split("\n");
    for (const codeLine of [...example.contents.split("\n"), ...contextExample.contents.split("\n")]) {
      if (codeLine === "") continue;
      expect(renderedLines).toContain(codeLine);
    }
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
        "sentence",
        "sentence(command)",
        "sentence(command)",
        "spacer",
        "sentence",
        "spacer",
        "verbatim",
        "spacer",
        "sentence(command)",
        "spacer",
        "sentence",
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
      // The example body is verbatim content without markdown fences (#510).
      const bodies = document.filter(
        (node): node is Extract<PresentationNode, { readonly kind: "verbatim" }> =>
          node.kind === "verbatim" && nodeText(node).length > 0,
      );
      expect(bodies).toHaveLength(1);
      // The example body is verbatim content without markdown fences (#510).
      expect(bodies[0]!.text).toBe(AUTHORING_EXAMPLES[topic].contents);
      // The full-guide pointer closes the topic as plain prose (#509).
      expect(shapes(document).at(-1)).toBe("sentence");
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
        { kind: "command", program: "apkit", args: [{ kind: "text", value: "init" }, { kind: "text", value: "<path>" }] },
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
        { kind: "command", program: "apkit", args: [{ kind: "text", value: "init" }, { kind: "text", value: "<path>" }] },
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
        " (selected: ",
        {
          kind: "path",
          canonicalPath: "/tmp/legacy-ws",
          authoredPath: "~/legacy-ws",
          scope: "fleet",
        },
        ")",
      ],
    });
  });

  test("focused guide preserves legacy space-containing Workspace path as atomic token under narrow rendering (INT-1)", () => {
    const document = focusedGuideDocument("profile", {
      configurationState: "legacy",
      workspace: {
        canonical: "/tmp/My long shared authoring workspace",
        authored: "~/My long shared authoring workspace",
      },
    });
    const rendered = renderBoundary(document, { color: false, interactive: true, width: 40 , rows: undefined });
    const lines = rendered.split("\n");
    // Ensure the path itself is not broken across lines by the sentence wrapping policy
    expect(lines.some((l) => l.includes("~/My long shared authoring workspace)"))).toBe(true);
    expect(lines.some((l) => l.includes("~/My long shared\n"))).toBe(false);
  });

  test("a guide file body renders verbatim with one trailing newline restored by the writer", () => {
    // The agent workflow reference stays raw markdown: its consumer is an
    // agent, and markdown structure is information to that reader (#510).
    const document = guideFileDocument("# Title\n\nBody line.\n");
    expect(shapes(document)).toEqual(["verbatim"]);
  });
});

describe("guide markdown rendering (#510, US-016)", () => {
  /**
   * The exact lines inside fenced code blocks of a guide body: the copyable
   * command surface whose atomicity the rendering must preserve at every
   * width.
   */
  function extractFencedLines(body: string): readonly string[] {
    const result: string[] = [];
    let inside = false;
    for (const line of body.split("\n")) {
      if (line.startsWith("```")) {
        inside = !inside;
        continue;
      }
      if (inside) result.push(line);
    }
    return result;
  }

  const guideContext = (width: number): TerminalPresentationContext => ({
    color: false,
    interactive: true,
    width,
    rows: undefined,
  });

  const guide = (body: string, width = 80): string =>
    renderBoundary(guideMarkdownDocument(body), guideContext(width));

  test("headings render as terminal headings without markdown decoration", () => {
    expect(guide("# Title\n\n## Section\n")).toBe("Title\n\nSection\n");
    // Defect pin: the pre-#510 rendering printed the literal `#` prefixes.
    expect(guide("# Title\n")).not.toContain("# Title");
  });

  test("paragraphs render as one wrapping sentence with bold markers stripped", () => {
    expect(guide("Line one **with bold** text\nand a continuation.\n")).toBe(
      "Line one with bold text and a continuation.\n",
    );
    // Defect pin: the pre-#510 rendering kept the raw `**` decoration.
    expect(guide("Word **bold** word.\n")).not.toContain("**bold**");
  });

  test("fenced code renders verbatim without fences and stays whole at narrow widths", () => {
    expect(guide("```sh\napkit init ~/workspace --host codex\n```\n")).toBe(
      "apkit init ~/workspace --host codex\n",
    );
    // The long copyable command stays one whole line at every reviewed width;
    // the fence pins fail on the pre-#510 rendering, which printed ```sh.
    const command =
      "apkit install coding ~/projects/tools/agent-profile-kit --host antigravity --host codex --auto-confirm";
    const fenced = `Precede with:\n\n\`\`\`sh\n${command}\n\`\`\`\n`;
    for (const width of [40, 60, 80, 100]) {
      const rendered = guide(fenced, width);
      expect(rendered).not.toContain("```sh");
      expect(rendered.split("\n")).toContain(command);
    }
    // Negative control: the same command as wrapping prose folds at narrow
    // widths, proving the atomicity assertion above can fail (non-vacuous).
    expect(guide(`Precede with ${command} now.\n`, 40).split("\n")).not.toContain(
      command,
    );
  });

  test("bullet lists render as list items with hanging-indent continuation lines joined", () => {
    const body = "- First item **bold**\n  continues here.\n- Second item.\n";
    expect(guide(body)).toBe(
      "- First item bold continues here.\n- Second item.\n",
    );
    // Defect pin: the pre-#510 rendering kept the raw hanging-indent line.
    expect(guide(body)).not.toContain("  continues here.");
  });

  test("the table renders through the existing row-group policy, not raw pipes", () => {
    const body = [
      "| Canonical policy | Output A | Output B |",
      "| --- | --- | --- |",
      "| `allowed` (default) | field A | field B |",
      "| `disabled` | longer field A text that exceeds the measure when wrapped at the reviewed width | field B |",
      "",
    ].join("\n");
    const rendered = guide(body);
    // No raw table syntax survives; cells render as stacked row-group entries.
    expect(rendered).not.toMatch(/^\s*\|.*\|\s*$/m);
    expect(rendered).not.toContain("| --- |");
    expect(rendered).toContain("Canonical policy: `allowed` (default)");
  });

  test("a table that does not fit the row model falls back to verbatim, never mangles", () => {
    const body = "| A | B |\n| --- | --- |\n| one | two |\n| three | four | five |\n";
    const rendered = guide(body);
    expect(rendered).toContain("| A | B |");
    expect(rendered).toContain("| three | four | five |");
  });

  test("a heading directly after a bullet opens a new block instead of joining the item", () => {
    // Pin for the bullet-list heading break (cli/guide-markdown.ts): without
    // it the heading line is silently swallowed into the item's flowing
    // text — the silent-degradation failure mode this policy prevents. The
    // current guide source is blank-separated, so only this pin guards it.
    expect(shapes(guideMarkdownDocument("- Item.\n# Heading\n"))).toEqual([
      "list",
      "spacer",
      "heading",
    ]);
    expect(guide("- Item.\n# Heading\n")).toBe("- Item.\n\nHeading\n");
  });

  test("an unsupported construct fails loudly instead of rendering mangled markdown", () => {
    expect(() => guideMarkdownDocument("```sh\n```\n\n> quoted\n")).toThrow(
      /unsupported/,
    );
    expect(() => guideMarkdownDocument("1. Ordered item\n")).toThrow(
      /unsupported/,
    );
    expect(() => guideMarkdownDocument("Prose.\n\n---\n")).toThrow(
      /unsupported/,
    );
    expect(() => guideMarkdownDocument("```sh\nunclosed\n")).toThrow(
      /fence/,
    );
    expect(() => guideMarkdownDocument("Word **unpaired bold\n")).toThrow(
      /bold/,
    );
    // A nested bullet is an unsupported construct, not a continuation line:
    // the pre-fix bullet path silently joined it into its parent item.
    expect(() =>
      guideMarkdownDocument("- Item.\n  - Nested.\n"),
    ).toThrow(/unsupported/);
    // Unsupported constructs inside a bullet block fail loudly instead of
    // joining the item as prose.
    expect(() =>
      guideMarkdownDocument("- Item.\n> quoted\n"),
    ).toThrow(/unsupported/);
    expect(() =>
      guideMarkdownDocument("- Item.\n1. Ordered.\n"),
    ).toThrow(/unsupported/);
    expect(() => guideMarkdownDocument("- Item.\n---\n")).toThrow(
      /unsupported/,
    );
  });

  test("the complete human guide renders as terminal content at every reviewed width", async () => {
    const body = await humanGuide();
    const fencedCodeLines = extractFencedLines(body);
    const longProseLine =
      "Agent Profile Kit keeps your reusable, cross-project agent material in one";
    for (const width of [40, 60, 80, 100]) {
      const rendered = renderBoundary(
        guideMarkdownDocument(body),
        guideContext(width),
      );
      // Defect pins: raw decoration is gone (fails on the pre-#510 verbatim
      // rendering, which printed headings, fences, and bold markers raw).
      expect(rendered).not.toContain("## Universal Workspace material");
      expect(rendered).not.toContain("```sh");
      expect(rendered).not.toContain("```yaml");
      expect(rendered).not.toContain("```md");
      expect(rendered).not.toContain("**Workspace**");
      // Copyable commands stay atomic: every fenced code line renders whole.
      const renderedLines = rendered.split("\n");
      for (const codeLine of fencedCodeLines) {
        expect(renderedLines).toContain(codeLine);
      }
      // Prose wraps at the measure: the known 78-column source line cannot
      // survive unwrapped at 40 or 60 columns.
      if (width <= 60) {
        expect(renderedLines).not.toContain(longProseLine);
      }
    }
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
        brokenProfileViolations: [],
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
        brokenProfileViolations: [],
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
    test("renders mixed fleet with notice, one row per Project, and next/details", () => {
      const p1 = createRecord({ canonicalProject: "/project-1", project: "/project-1", state: { kind: "removal" } });
      const p2 = createRecord({ canonicalProject: "/project-2", project: "/project-2", state: { kind: "drifted output" }, outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "a.md" }] });
      const p3 = createRecord({ canonicalProject: "/project-3", project: "/project-3", state: { kind: "drifted output" }, outputs: [{ consumingHosts: ["codex"], driftKind: "missing", kind: "update", path: "b.md" }] });
      const p4 = createRecord({ canonicalProject: "/project-4", project: "/project-4", state: { kind: "addition" } });
      const p5 = createRecord({ canonicalProject: "/project-5", project: "/project-5", state: { kind: "stale source" } });
      const p6 = createRecord({ canonicalProject: "/project-6", project: "/project-6", state: { kind: "current" } });

      const report: ReconciliationReport = {
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [p1, p2, p3, p4, p5, p6],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered).toStartWith("⚠ Ready to update\n");
      expect(rendered).toContain("needs attention");
      expect(rendered).toContain("generated files changed");
      expect(rendered).toContain("generated files missing");
      expect(rendered).toContain("not installed yet");
      expect(rendered).toContain("source changed");
      expect(rendered).toContain("up to date");
      for (const project of ["/project-1", "/project-2", "/project-3", "/project-4", "/project-5", "/project-6"]) {
        expect(rendered).toContain(project);
      }
      expect(rendered).not.toContain("settled (");
      expect(rendered).toContain("Next: apkit update");
      expect(rendered).toContain("Details: apkit status --verbose");
    });

    test("contains Blockers concisely while preserving every checked Project row", () => {
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
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [p1, p2],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered).toStartWith("⚠ Cannot update\n");
      expect(rendered).toContain("needs attention");
      expect(rendered).toContain("not installed yet");
      expect(rendered).toContain("/project-1");
      expect(rendered).toContain("/project-2");
      expect(rendered).toContain("Blocker:");
      expect(rendered).toContain("Requirement:");
      expect(rendered).toContain("Remedy:");
      expect(rendered).not.toContain("Scope: Project");
      // Identity is the scope row plus, when evidence exists, its evidence
      // anchor; recovery commands may repeat the scoped Project argument.
      expect(proseOccurrences(document, "/project-1")).toBe(2);
      expect(proseOccurrences(document, "/project-2")).toBe(1);
    });

    test("wholly settled fleet names every checked Project and invents no next action", () => {
      const p1 = createRecord({ canonicalProject: "/project-1", project: "/project-1", state: { kind: "current" } });
      const p2 = createRecord({ canonicalProject: "/project-2", project: "/project-2", state: { kind: "current" } });

      const report: ReconciliationReport = {
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [p1, p2],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered).toStartWith("✔ All Projects are up to date (2 Projects)\n");
      expect(rendered).toContain("up to date");
      expect(rendered).toContain("/project-1");
      expect(rendered).toContain("/project-2");
      expect(rendered).not.toContain("settled (");
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
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [p1],
      };

      const document = lifecycleStatusDocument(report);
      const rendered = renderBoundary(document);

      expect(rendered).toContain("Agent attention required");
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
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [p1],
      };

      const document = lifecycleStatusDocument(report);
      const rendered = renderBoundary(document);

      expect(rendered).toContain("needs attention");
      expect(rendered).toContain("/project-1");
      expect(rendered).toContain("Update will remove generated files for unbound projects.");
      expect(rendered).not.toContain("Blocker:");
      expect(proseOccurrences(document, "/project-1")).toBe(2);
    });

    test("two interleaved removals each keep teardown evidence with their Project among blocked and healthy peers", () => {
      const sharedPath = ".codex/hooks.json";
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
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [beta, removalFirst, alpha, removalSecond, pending, settled],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      // Every checked Project is a scope row; settled is named too (US-007).
      for (const project of ["project-beta", "removal-first", "project-alpha", "removal-second", "pending", "settled"]) {
        expect(rendered).toContain(project);
      }
      expect(rendered).toContain("needs attention");
      expect(rendered).toContain("not installed yet");
      expect(rendered).toContain("up to date");
      // Evidence stays with its Project and never disappears (TEST-005).
      expect(rendered).toContain("tracked by Git");
      expect(rendered).toContain("second.json");
      expect(rendered).toContain("already contains a file Agent Profile Kit did not install");
      expect(rendered.match(/Update will remove generated files for unbound projects\./g)).toHaveLength(2);

      for (const width of [40, 60, 80, 10_000]) {
        const narrow = renderBoundary(document, { ...defaultRenderContext, width });
        const packed = narrow.replace(/\s+/g, " ");
        expect(packed).toContain("tracked by Git");
        expect(packed).toContain("second.json");
        expect(packed).toContain("Update will remove generated files for unbound projects.");
        expect(packed).toContain("already contains a file Agent Profile Kit did not install");
        expect(packed).toContain("up to date");
        // Each Project identity is its scope row plus, when evidence exists,
        // its evidence anchor.
        expect(proseOccurrences(document, "/project-beta")).toBe(2);
        expect(proseOccurrences(document, "/removal-first")).toBe(2);
        expect(proseOccurrences(document, "/project-alpha")).toBe(2);
        expect(proseOccurrences(document, "/removal-second")).toBe(2);
        expect(proseOccurrences(document, "/pending")).toBe(1);
        expect(proseOccurrences(document, "/settled")).toBe(1);
      }
    });

    test("evidence sections bind each blocker remedy to its Project among reversed multi-blocked, removal, pending, and settled peers", () => {
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
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [beta, alpha, removal, pending, settled],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered).toContain("needs attention");
      expect(rendered).toContain("not installed yet");
      expect(rendered).toContain("up to date");
      expect(rendered).not.toContain("Scope: Project");

      // Each remedy stays inside its Project's evidence section.
      const betaStart = rendered.indexOf("project-beta:");
      const alphaStart = rendered.indexOf("project-alpha:");
      const removalStart = rendered.indexOf("project-removal:");
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
      expect(removalSection).toContain("Update will remove generated files for unbound projects.");
      expect(removalSection).not.toContain("Blocker:");

      for (const width of [40, 60, 80, 10_000]) {
        const narrow = renderBoundary(document, { ...defaultRenderContext, width });
        const packed = narrow.replace(/\s+/g, " ");
        expect(packed).toContain("tracked by Git");
        expect(packed).toContain("Manual recovery is required");
        expect(packed).toContain("Update will remove generated files for unbound projects.");
        expect(packed).toContain("project-settled");
        expect(proseOccurrences(document, "project-beta")).toBe(2);
        expect(proseOccurrences(document, "project-alpha")).toBe(2);
        expect(proseOccurrences(document, "project-removal")).toBe(2);
        expect(proseOccurrences(document, "project-pending")).toBe(1);
        expect(proseOccurrences(document, "project-settled")).toBe(1);
      }
    });

    test("healthy mixed fleet names every checked Project including settled ones", () => {
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
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [pMissing, pChanged, pSettled],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      const rendered = renderBoundary(document);

      expect(rendered).toContain("generated files missing");
      expect(rendered).toContain("generated files changed");
      expect(rendered).toContain("up to date");
      expect(rendered).toContain("/project-missing");
      expect(rendered).toContain("/project-changed");
      expect(rendered).toContain("/project-settled");
      expect(proseOccurrences(document, "/project-settled")).toBe(1);
      expect(rendered).toContain("Next: apkit update");
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
        brokenProfileViolations: [],
        globalBlockers: [],
        projects: [p1, p2],
      };

      const document = lifecycleStatusDocument(report, { selection: { kind: "all" } });
      for (const width of [40, 60, 80]) {
        const rendered = renderBoundary(document, { ...defaultRenderContext, width });
        // Identity is the scope row plus, when evidence exists, its evidence
        // anchor; the remedy's scoped command arguments repeat the Project
        // path on purpose (a runnable copy needs it).
        expect(proseOccurrences(document, "project-one")).toBe(2);
        expect(proseOccurrences(document, "project-two")).toBe(1);
      }
    });
  });
});

describe("focused verbose diagnostics (issue #449, spec #373, US-013, DEC-006, DEC-007, TEST-001, TEST-002, TEST-008)", () => {
  test("multi-cause Project retains every underlying cause in verbose diagnostics", () => {
    const multiCauseProject = machineProject("/workspace/multi-cause", {
      blockers: [
        fixtureBlocker("Output conflict detected", "/workspace/multi-cause"),
      ],
      desired: {
        capabilityContracts: { codex: "v2" },
        context: "Sensitive composed context body\nRule 1\nRule 2\n",
        hosts: ["codex", "claude"],
        outputs: [
          ".agent-profile-kit/codex/context.md",
          ".claude/rules/agent-profile-kit.md",
          ".codex/hooks.json",
          ".agent-profile-kit/unchanged.txt",
        ],
        profile: "full-stack",
        resolvedArtifacts: [{ id: "full-stack-rules", type: "context" }],
      },
      repositoryExclusions: [
        {
          current: [],
          installed: false,
          next: ["/.agent-profile-kit/codex/context.md"],
          target: "/workspace/multi-cause/.git/info/exclude",
        },
      ],
      setupSteps: [
        {
          consequence: "Hook approval needed",
          host: "codex",
          kind: "approval-required",
          message: "Approve hook",
          output: ".codex/hooks.json",
          provenance: "transition",
        },
        {
          consequence: "Trust needed",
          host: "claude",
          kind: "trust-required",
          message: "Trust the project in Claude",
          provenance: "standing",
        },
      ],
      outputs: [
        {
          consumingHosts: ["codex"],
          driftKind: "missing",
          kind: "update",
          path: ".agent-profile-kit/codex/context.md",
        },
        {
          consumingHosts: ["claude"],
          driftKind: "changed",
          kind: "update",
          path: ".claude/rules/agent-profile-kit.md",
        },
        {
          consumingHosts: ["codex"],
          kind: "addition",
          path: ".codex/hooks.json",
        },
        {
          consumingHosts: [],
          kind: "unchanged",
          path: ".agent-profile-kit/unchanged.txt",
        },
      ],
      state: { kind: "drifted output", reason: "missing" },
    });

    const report: ReconciliationReport = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [multiCauseProject],
    };

    // Concise status groups under single primary cause (needs attention due to blocker).
    const conciseDoc = lifecycleStatusDocument(report);
    const conciseTexts = presentationTexts(conciseDoc);
    expect(conciseTexts.some((t) => t.includes("needs attention"))).toBe(true);
    expect(conciseTexts.some((t) => t.includes("generated files missing"))).toBe(false);
    expect(conciseTexts.some((t) => t.includes("generated files changed"))).toBe(false);

    // Verbose diagnostics retain EVERY underlying cause across the focused diagnostic sections.
    const verboseDoc = lifecycleStatusDocument(report, { verbose: true });
    const headings = headingsIn(verboseDoc);
    expect(headings).toContain("Blockers:");
    expect(headings).toContain("Projects:");
    expect(headings).toContain("State explanations:");
    expect(headings).toContain("Outputs:");
    expect(headings).toContain("Git exclusions:");
    expect(headings).toContain("Agent setup:");
    expect(headings).toContain("Standing agent setup:");

    // Proves underlying causes are all present in the diagnostic evidence:
    const verboseNodes = flattenPresentationNodes(verboseDoc);
    const verboseTexts = presentationTexts(verboseDoc);

    // 1. Blocker cause is retained in Blockers section:
    expect(verboseTexts.some((t) => t.includes("Output conflict detected"))).toBe(true);

    // 2. Project state is retained in Projects section:
    expect(verboseTexts.some((t) => t.includes("/workspace/multi-cause") && t.includes("needs attention"))).toBe(true);

    // 3. Changed, missing, and added individual outputs are retained with distinct diagnostic kinds:
    const outputLine = (path: string, kind: string) => verboseNodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));
    expect(outputLine("/workspace/multi-cause/.agent-profile-kit/codex/context.md", "missing")).toBe(true);
    expect(outputLine("/workspace/multi-cause/.claude/rules/agent-profile-kit.md", "changed")).toBe(true);
    // The typed addition output carries its source-change cause beside the
    // missing/changed generated files (canonical hasSourceChanged policy):
    expect(outputLine("/workspace/multi-cause/.codex/hooks.json", "addition (source changed)")).toBe(true);
    expect(outputLine("/workspace/multi-cause/.codex/hooks.json", "addition")).toBe(false);

    // Unchanged outputs are omitted from verbose diagnostics:
    expect(outputLine("/workspace/multi-cause/.agent-profile-kit/unchanged.txt", "unchanged")).toBe(false);
    expect(verboseTexts.some((t) => t.includes("unchanged.txt"))).toBe(false);

    // 4. State explanations cover present non-current kinds:
    expect(verboseTexts.some((t) => t.includes("needs attention:"))).toBe(true);

    // 5. Git exclusions are retained:
    expect(verboseTexts.some((t) => t.includes(".git/info/exclude"))).toBe(true);

    // 5. Host setup steps are retained:
    expect(verboseTexts.some((t) => t.includes("Approve hook"))).toBe(true);
    expect(verboseTexts.some((t) => t.includes("Trust the project in Claude"))).toBe(true);

    // 6. Composed context bodies, capability contracts, and per-project setup provenance are omitted:
    expect(headings).not.toContain("Selected setup:");
    expect(verboseNodes.some((node) => node.kind === "verbatim")).toBe(false);
    expect(verboseTexts.some((t) => t.includes("Sensitive composed context body"))).toBe(false);
    expect(verboseTexts.some((t) => t.includes("Capability Contracts"))).toBe(false);
    expect(verboseTexts.some((t) => t.includes("Resolved artifacts"))).toBe(false);
    expect(verboseTexts.some((t) => t.includes("inclusionReasons"))).toBe(false);
  });

  test("omits empty diagnostic sections without emitting (none) placeholders", () => {
    const cleanProject = machineProject("/workspace/clean", {
      desired: {
        context: "Clean context",
        hosts: ["codex"],
        outputs: [".codex/rules.md"],
        profile: "default",
        resolvedArtifacts: [],
      },
      outputs: [
        {
          consumingHosts: ["codex"],
          kind: "unchanged",
          path: ".codex/rules.md",
        },
      ],
      state: { kind: "current" },
    });

    const report: ReconciliationReport = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [cleanProject],
    };

    const verboseDoc = lifecycleStatusDocument(report, { verbose: true });
    const headings = headingsIn(verboseDoc);
    const verboseTexts = presentationTexts(verboseDoc);

    // Empty sections are omitted entirely:
    expect(headings).not.toContain("Outputs:");
    expect(headings).not.toContain("Git exclusions:");
    expect(headings).not.toContain("Blockers:");
    expect(headings).not.toContain("Host setup:");
    expect(headings).not.toContain("Standing Host setup:");
    expect(headings).not.toContain("Selected setup:");

    // No (none) placeholders emitted for omitted sections:
    expect(verboseTexts.some((t) => t.includes("(none)"))).toBe(false);
  });

  test("fleet-scale diagnostic cases retain actionable evidence and natural wrapping without arbitrary line budgets", () => {
    const projects = Array.from({ length: 15 }, (_, i) => {
      const path = `/workspace/project-${String(i).padStart(2, "0")}`;
      if (i % 3 === 0) {
        return machineProject(path, {
          desired: { context: "ctx", hosts: ["codex"], outputs: ["out.md"], profile: "p", resolvedArtifacts: [] },
          outputs: [{ consumingHosts: ["codex"], kind: "addition", path: "out.md" }],
          state: { kind: "addition" },
        });
      } else if (i % 3 === 1) {
        return machineProject(path, {
          desired: { context: "ctx", hosts: ["codex"], outputs: ["out.md"], profile: "p", resolvedArtifacts: [] },
          outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "out.md" }],
          state: { kind: "drifted output", reason: "drift" },
        });
      } else {
        return machineProject(path, {
          desired: { context: "ctx", hosts: ["codex"], outputs: ["out.md"], profile: "p", resolvedArtifacts: [] },
          outputs: [{ consumingHosts: ["codex"], kind: "unchanged", path: "out.md" }],
          state: { kind: "current" },
        });
      }
    });

    const report: ReconciliationReport = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects,
    };

    const verboseDoc = lifecycleStatusDocument(report, { selection: { kind: "all" }, verbose: true });
    for (const width of [40, 80, 120]) {
      const rendered = renderBoundary(verboseDoc, { ...defaultRenderContext, width });
      expect(rendered.length).toBeGreaterThan(0);
      for (let i = 0; i < 15; i++) {
        const path = `/workspace/project-${String(i).padStart(2, "0")}`;
        expect(rendered.includes(path)).toBe(true);
      }
    }
  });

  test("verbose update document renders focused diagnostics with distinct output kinds", () => {
    const multiCauseProject = machineProject("/workspace/multi-cause", {
      desired: {
        context: "Sensitive composed context body",
        hosts: ["codex", "claude"],
        outputs: [
          ".agent-profile-kit/codex/context.md",
          ".claude/rules/agent-profile-kit.md",
          ".codex/hooks.json",
          ".agent-profile-kit/unchanged.txt",
        ],
        profile: "example",
        resolvedArtifacts: [],
      },
      outputs: [
        {
          consumingHosts: ["codex"],
          driftKind: "missing",
          kind: "update",
          path: ".agent-profile-kit/codex/context.md",
        },
        {
          consumingHosts: ["claude"],
          driftKind: "changed",
          kind: "update",
          path: ".claude/rules/agent-profile-kit.md",
        },
        {
          consumingHosts: ["codex"],
          kind: "addition",
          path: ".codex/hooks.json",
        },
        {
          consumingHosts: [],
          kind: "unchanged",
          path: ".agent-profile-kit/unchanged.txt",
        },
      ],
      state: { kind: "drifted output", reason: "missing" },
    });

    const receiptProject = machineProject("/workspace/multi-cause", {
      outputs: [
        {
          consumingHosts: ["codex"],
          kind: "update",
          path: ".agent-profile-kit/codex/context.md",
        },
        {
          consumingHosts: ["claude"],
          kind: "update",
          path: ".claude/rules/agent-profile-kit.md",
        },
        {
          consumingHosts: ["codex"],
          kind: "addition",
          path: ".codex/hooks.json",
        },
      ],
      state: { kind: "update" },
    });

    const receiptReport: ReconciliationReport = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [receiptProject],
    };

    const resultingStateReport: ReconciliationReport = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [multiCauseProject],
    };

    const verboseDoc = applyReportDocument(applyResult(receiptReport, resultingStateReport), { verbose: true });
    const headings = headingsIn(verboseDoc);
    const verboseNodes = flattenPresentationNodes(verboseDoc);
    const verboseTexts = presentationTexts(verboseDoc);

    expect(headings).toContain("Pending:");
    expect(headings).toContain("Updated:");
    expect(headings).not.toContain("Selected setup:");

    const outputLine = (path: string, kind: string) => verboseNodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));

    // Pending section renders distinct drift kinds, and source-change causes
    // stay tied to their affected paths:
    expect(outputLine("/workspace/multi-cause/.agent-profile-kit/codex/context.md", "missing")).toBe(true);
    expect(outputLine("/workspace/multi-cause/.claude/rules/agent-profile-kit.md", "changed")).toBe(true);
    expect(outputLine("/workspace/multi-cause/.codex/hooks.json", "addition (source changed)")).toBe(true);
    expect(outputLine("/workspace/multi-cause/.agent-profile-kit/codex/context.md", "update (source changed)")).toBe(true);
    expect(outputLine("/workspace/multi-cause/.claude/rules/agent-profile-kit.md", "update (source changed)")).toBe(true);
    expect(outputLine("/workspace/multi-cause/.agent-profile-kit/unchanged.txt", "unchanged")).toBe(false);

    // No composed context bodies or provenance:
    expect(verboseNodes.some((node) => node.kind === "verbatim")).toBe(false);
    expect(verboseTexts.some((t) => t.includes("Sensitive composed context body"))).toBe(false);
  });

  test("source-change evidence is recorded and tied to affected paths without unsafe inference", () => {
    // Reconciliation proves the source change with receipt evidence (typed
    // sourceChanged fact); presentation renders it beside the affected path.
    const mixedProject = machineProject("/workspace/mixed-cause", {
      outputs: [
        {
          consumingHosts: ["codex"],
          driftKind: "changed",
          kind: "update",
          path: ".agent-profile-kit/codex/context.md",
          sourceChanged: true,
        },
        {
          // User edit only: no sourceChanged fact, so no source-change claim.
          consumingHosts: ["claude"],
          driftKind: "changed",
          kind: "update",
          path: ".claude/rules/agent-profile-kit.md",
        },
      ],
      state: { kind: "drifted output" },
    });
    const report: ReconciliationReport = { brokenProfileViolations: [], globalBlockers: [], projects: [mixedProject] };

    for (const document of [
      lifecycleStatusDocument(report, { verbose: true }),
      applyReportDocument(applyResult(report, report), { verbose: true }),
    ]) {
      const nodes = flattenPresentationNodes(document);
      const line = (path: string, label: string) => nodes.some((node) =>
        node.kind === "prose" &&
        JSON.stringify(node.parts) === JSON.stringify([
          { kind: "identifier", value: path },
          `: ${label}`,
        ]));

      // Proven source change renders beside the drifted path:
      expect(line("/workspace/mixed-cause/.agent-profile-kit/codex/context.md", "changed (source changed)")).toBe(true);
      // Pure user drift stays bare — no inferred source-change cause:
      expect(line("/workspace/mixed-cause/.claude/rules/agent-profile-kit.md", "changed")).toBe(true);
      expect(line("/workspace/mixed-cause/.claude/rules/agent-profile-kit.md", "changed (source changed)"))
        .toBe(false);
    }
  });

  test("digest-only source-input change renders once at Project scope without per-output attribution", () => {
    // A redundant Skill dependency edge changes the receipt's desired-input
    // digest while every generated projection stays identical; with concurrent
    // drift no output carries a sourceChanged fact, so the Project record owns
    // the cause and verbose renders it once at Project scope.
    const inputChangeProject = machineProject("/workspace/dep-change", {
      outputs: [
        {
          consumingHosts: ["codex"],
          driftKind: "missing",
          kind: "update",
          path: ".agents/skills/base-skill",
        },
      ],
      state: { kind: "drifted output", reason: ".agents/skills/base-skill" },
      sourceInputChanged: true,
    });
    const report: ReconciliationReport = { brokenProfileViolations: [], globalBlockers: [], projects: [inputChangeProject] };

    const verboseDoc = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verboseDoc);
    const line = (value: string, label: string) => nodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value },
        `: ${label}`,
      ]));

    // The unattributable source change renders beside the Project state:
    expect(line(
      "/workspace/dep-change",
      "generated files missing (.agents/skills/base-skill) (source changed)",
    )).toBe(true);
    // The drifted output stays bare — no projection change owns a per-output
    // claim, and the cause renders exactly once (fact-once, DEC-007):
    expect(line("/workspace/dep-change/.agents/skills/base-skill", "missing")).toBe(true);
    expect(line("/workspace/dep-change/.agents/skills/base-skill", "missing (source changed)")).toBe(false);
    expect(presentationTexts(verboseDoc).filter((text) => text.includes("source changed")))
      .toHaveLength(1);

    // The stale-source state already names the cause; no duplicate suffix:
    const staleProject = machineProject("/workspace/dep-stale", {
      state: { kind: "stale source" },
      sourceInputChanged: true,
    });
    const staleDoc = lifecycleStatusDocument(
      { brokenProfileViolations: [], globalBlockers: [], projects: [staleProject] },
      { verbose: true },
    );
    const staleLine = (value: string, label: string) => flattenPresentationNodes(staleDoc).some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value },
        `: ${label}`,
      ]));
    expect(staleLine("/workspace/dep-stale", "source changed")).toBe(true);
    expect(staleLine("/workspace/dep-stale", "source changed (source changed)")).toBe(false);

    // When a changed projection truthfully owns the cause, it stays at the
    // affected path and the Project scope does not repeat it:
    const attributedProject = machineProject("/workspace/dep-attributed", {
      outputs: [
        {
          consumingHosts: ["codex"],
          driftKind: "missing",
          kind: "update",
          path: ".agent-profile-kit/codex/context.md",
          sourceChanged: true,
        },
      ],
      state: { kind: "drifted output" },
      sourceInputChanged: true,
    });
    const attributedDoc = lifecycleStatusDocument(
      { brokenProfileViolations: [], globalBlockers: [], projects: [attributedProject] },
      { verbose: true },
    );
    const attributedLine = (value: string, label: string) =>
      flattenPresentationNodes(attributedDoc).some((node) =>
        node.kind === "prose" &&
        JSON.stringify(node.parts) === JSON.stringify([
          { kind: "identifier", value },
          `: ${label}`,
        ]));
    expect(attributedLine("/workspace/dep-attributed", "drifted output (source changed)")).toBe(false);
    expect(attributedLine(
      "/workspace/dep-attributed/.agent-profile-kit/codex/context.md",
      "missing (source changed)",
    )).toBe(true);
  });
});



describe("bare invocation entry screen (issue #452, US-032, US-035, DEC-020, DEC-021, TEST-015, TEST-020)", () => {
  const wordmark = ["Agent Profile Kit"];

  function bareInfo(overrides: Partial<ApplicationInfo> = {}): ApplicationInfo {
    return {
      configurationState: "current",
      engineVersion: "0.67.0",
      installationState: "/home/.agents/agent-profile-kit/state/manifest.json",
      localConfiguration: "/home/.agents/agent-profile-kit/config.yaml",
      workspace: {
        authored: "/home/.agents/agent-profile-kit/workspace",
        canonical: "/home/.agents/agent-profile-kit/workspace",
      },
      ...overrides,
    };
  }

  const renderedText = (document: PresentationDocument): string =>
    renderBoundary(document).replace(/\s+/g, " ");

  test("a not-configured machine sees that setup is missing and the init command, not the manual (US-032, TEST-015)", () => {
    const document = bareInvocationDocument({
      info: bareInfo({ configurationState: "not-configured", workspace: null }),
      wordmark,
    });
    const text = renderedText(document);
    expect(text).toContain("Agent Profile Kit is not set up");
    expect(text).toContain("apkit init");
    // State screen, not the full manual: no command-listing headings, no
    // usage line, no flag inventory.
    expect(text).not.toContain("First run:");
    expect(text).not.toContain("Common commands:");
    expect(text).not.toContain("More commands:");
    expect(text).not.toContain("Usage:");
    expect(text).not.toContain("apkit bind <profile>");
    // The full surface is reachable, by pointer only.
    expect(text).toContain("apkit --help");
    expect(text).toContain("full command list");
  });

  test("a legacy configuration is told to run init", () => {
    const document = bareInvocationDocument({
      info: bareInfo({ configurationState: "legacy" }),
      wordmark,
    });
    const text = renderedText(document);
    expect(text).toContain("Legacy configuration");
    expect(text).toContain("apkit init");
    expect(text).not.toContain("apkit status");
    expect(text).not.toContain("apkit update");
  });

  test("a configured machine sees its setup state and task commands, not the manual (US-032)", () => {
    const document = bareInvocationDocument({
      info: bareInfo(),
      report: emptyReport({
        desired: [
          { canonicalProject: "/project-a", project: "/project-a", context: "c", outputs: [], profile: "p", resolvedArtifacts: [] },
        ],
        items: [{ kind: "addition", project: "/project-a" }],
      }),
      wordmark,
    });
    const text = renderedText(document);
    // Fleet state from the delivered default scope (issue #436): one never
    // installed Project is pending, summarised by its primary cause.
    expect(text).toContain("not installed yet (1)");
    // Task-relevant human commands only.
    for (const command of ["apkit status", "apkit update", "apkit install", "apkit guide"]) {
      expect(text).toContain(command);
    }
    // Not the full manual.
    expect(text).not.toContain("First run:");
    expect(text).not.toContain("Common commands:");
    expect(text).not.toContain("More commands:");
    expect(text).not.toContain("Usage:");
    expect(text).not.toContain("apkit bind <profile>");
    expect(text).toContain("full command list");
  });

  test("a settled fleet says so and still offers the task commands (US-032)", () => {
    const document = bareInvocationDocument({
      info: bareInfo(),
      report: emptyReport({
        desired: [
          { canonicalProject: "/project-a", project: "/project-a", context: "c", outputs: [], profile: "p", resolvedArtifacts: [] },
        ],
        items: [{ kind: "current", project: "/project-a" }],
      }),
      wordmark,
    });
    const text = renderedText(document);
    expect(text).toContain("up to date");
    expect(text).toContain("apkit status");
    expect(text).toContain("apkit update");
  });

  test("an empty configured fleet points at installing a Project (US-032)", () => {
    const document = bareInvocationDocument({
      info: bareInfo(),
      report: emptyReport(),
      wordmark,
    });
    const text = renderedText(document);
    expect(text).toContain("No Projects are configured");
    expect(text).toContain("apkit install");
  });

  test("the entry screen never lists machine-facing commands (US-035, DEC-021, TEST-020)", () => {
    const cases: PresentationDocument[] = [
      bareInvocationDocument({
        info: bareInfo({ configurationState: "not-configured", workspace: null }),
        wordmark,
      }),
      bareInvocationDocument({ info: bareInfo(), report: emptyReport(), wordmark }),
      bareInvocationDocument({
        info: bareInfo(),
        report: emptyReport({
          desired: [
            { canonicalProject: "/project-a", project: "/project-a", context: "c", outputs: [], profile: "p", resolvedArtifacts: [] },
          ],
        }),
        wordmark,
      }),
    ];
    for (const document of cases) {
      const text = renderedText(document);
      expect(text).not.toContain("machine ");
      expect(text).not.toContain("install-temp");
      expect(text).not.toContain("remove-temp");
    }
  });
});

/**
 * Distinctive definition openers for the five kit concepts US-001 asks first
 * use to explain. Skill is deliberately absent: it is never defined.
 */
const CONCEPT_DEFINITION_MARKERS = [
  { concept: "Workspace", markers: ["Your Workspace folder holds", "Your Workspace is one folder that holds"] },
  { concept: "Project", markers: ["A Project is one working folder"] },
  { concept: "Profile", markers: ["Profiles group Context and Skills", "A Profile is a named selection"] },
  { concept: "Skills", markers: ["Skills are the skills you already use"] },
  { concept: "Context", markers: ["Context is plain Markdown", "Context is always-loaded"] },
  { concept: "agent", markers: ["An agent is a tool"] },
] as const;

/** Which kit concepts a rendered first-use block newly explains. */
function explainedConcepts(text: string): string[] {
  return CONCEPT_DEFINITION_MARKERS
    .filter((entry) => entry.markers.some((marker) => text.includes(marker)))
    .map((entry) => entry.concept);
}

function documentText(document: PresentationDocument): string {
  return flattenPresentationNodes(document)
    .flatMap((node) => node.kind === "list" ? listItemTexts(node) : [nodeText(node)])
    .join("\n");
}

describe("newcomer concept explanations (US-001, DEC-003, #645)", () => {
  const home = homedir();

  test("bare apkit explains Workspace before the recommended setup route", () => {
    const document = bareInvocationDocument({
      info: {
        configurationState: "not-configured",
        workspace: null,
        engineVersion: "0.0.0",
        installationState: "/home/.agents/agent-profile-kit/state/manifest.json",
        localConfiguration: "/home/.agents/agent-profile-kit/config.yaml",
      },
    });
    const text = documentText(document);
    expect(explainedConcepts(text).sort()).toEqual(["Workspace"]);
    expect(text).toContain(
      "Your Workspace folder holds your Context, Skills, and Profiles. You only need one Workspace for all of your Projects.",
    );
    expect(text).toContain(
      "Start by naming the folder that will hold the Workspace. The second command uses the current folder instead.",
    );
    // Recommended route leads; the current-folder form is secondary.
    expect(text.indexOf("apkit init <path>")).toBeGreaterThan(0);
    expect(text.indexOf("apkit init <path>")).toBeLessThan(text.indexOf("apkit init ."));
    // Commands stay on their own footer lines (DEC-009).
    const commandLines = flattenPresentationNodes(document)
      .flatMap((node) => node.kind === "list" ? listItemTexts(node) : [nodeText(node)])
      .filter((line) => line.includes("apkit init"));
    expect(commandLines.length).toBeGreaterThanOrEqual(1);
    for (const line of commandLines) {
      expect(line.trim()).toMatch(/^apkit init (<path>|\.)$/);
    }
    // No Host-loads-everything claim.
    expect(text).not.toMatch(/loads (every|all|your) Workspace/i);
  });

  test("the init location question explains Workspace before the folder choice", () => {
    const document = initLocationDocument({
      destinationPath: join(home, "projects", "demo"),
      authoredPath: "~/projects/demo",
    });
    const text = documentText(document);
    expect(explainedConcepts(text)).toEqual(["Workspace"]);
    expect(text).toContain(
      "Your Workspace folder holds your Context, Skills, and Profiles. You only need one Workspace for all of your Projects.",
    );
    expect(text).toContain("Current folder: ");
  });

  test("the init receipt explains Profile, Skills, and Context (spec #672 DEC-005, #676)", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: join(home, "apkit-workspace"),
      authoredPath: join(home, "apkit-workspace"),
      folderCreated: true,
      detectedHosts: ["codex"],
      configurationWritten: true,
      configurationPath: join(home, ".agents", "agent-profile-kit", "config.yaml"),
      addedParts: ["workspace.yaml", "context", "skills", "profiles"],
      profileCount: 0,
    });
    const text = documentText(document);
    expect(explainedConcepts(text).sort()).toEqual(["Context", "Profile", "Skills"]);
    expect(text).toContain(
      "Profiles group Context and Skills for one kind of work. You can reuse them across Projects.",
    );
    expect(text).toContain(
      "Skills are the skills you already use (open standard). Drop skill folders into",
    );
    expect(text).toContain(
      "Context is plain Markdown in",
    );
    expect(text).not.toMatch(/loads (every|all|your) Workspace/i);
  });

  test("install target and Profile note stay within the two-concept pre-picker budget", () => {
    // Direct install prints the target and the Profile note on one screen
    // before the first picker (US-001, DEC-003): Project + Profile only.
    const prePicker = [
      ...installTargetDocument({
        canonicalProject: join(home, "projects", "demo"),
        authoredProject: "~/projects/demo",
      }),
      ...installProfileSelectionNoteDocument(),
    ];
    const text = documentText(prePicker);
    expect(explainedConcepts(text).sort()).toEqual(["Profile", "Project"]);
    expect(explainedConcepts(text).length).toBeLessThanOrEqual(2);
    expect(text).toContain(
      "A Project is one working folder that receives the installed material.",
    );
    expect(text).toContain(
      "A Profile is a named selection of Context and Skills suited to a kind of work and reusable across projects.",
    );
    // Choosing a Profile does not require understanding Context: the Profile
    // sentence may name Context, but Context is not defined here.
    expect(text).toContain("Context and Skills");
    expect(text).not.toContain("Context is always-loaded");
    expect(text).not.toMatch(/A Skill is |Skill is a /);
    expect(text).not.toMatch(/loads (every|all|your) Workspace/i);
  });

  test("install target names the Project action location by its stable path", () => {
    const document = installTargetDocument({
      canonicalProject: join(home, "projects", "demo"),
      authoredProject: "~/projects/demo",
    });
    const rendered = renderPresentationDocument(document, defaultRenderContext, {
      home,
      cwd: home,
    });
    expect(rendered).toContain("Installing into ~/projects/demo.");
    expect(rendered).not.toContain("Installing into demo");
    // #645's Project sentence stays on this screen.
    expect(rendered).toContain(PROJECT_EXPLANATION_SENTENCE);
  });

  test("the install Host note explains agent without claiming full Workspace loading", () => {
    const text = documentText(installHostSelectionNoteDocument());
    expect(explainedConcepts(text)).toEqual(["agent"]);
    expect(text).toContain(
      "An agent is a tool such as Claude Code or Codex that can use the material you install into a Project.",
    );
    expect(text).toContain("Selecting an agent does not install it.");
    expect(text).not.toMatch(/loads (every|all|your) Workspace/i);
    expect(text).not.toMatch(/A Skill is |Skill is a /);
  });
});

const textArg = (value: string): { readonly kind: "text"; readonly value: string } => ({
  kind: "text",
  value,
});

describe("one useful footer and neutral cancellation (US-003, US-010)", () => {
  test("plain decline and picker cancel print one neutral statement with no remedy or details hint", () => {
    for (const document of [
      installDeclinedDocument("declined"),
      installDeclinedDocument("cancelled"),
      installDeclinedDocument("default"),
      uninstallDeclinedDocument("declined"),
      uninstallDeclinedDocument("cancelled"),
      configureDeclinedDocument("declined"),
      configureDeclinedDocument("cancelled"),
      configurePickerCancelledDocument(),
      initCancelledDocument(),
      initDeclinedDocument(),
      uninstallPickerNoopDocument("cancelled"),
      uninstallPickerNoopDocument("empty-projects"),
      uninstallPickerNoopDocument("empty-hosts"),
    ]) {
      const rendered = renderBoundary(document);
      expect(rendered).not.toContain("apkit:");
      expect(rendered).not.toContain("Details:");
      expect(rendered).not.toContain("Next:");
      expect(rendered).not.toContain("To proceed without asking");
      expect(rendered).not.toContain("To choose again");
      expect(rendered.startsWith("● ")).toBe(true);
      // One neutral statement: a single rendered line of outcome copy.
      expect(rendered.trim().split("\n")).toHaveLength(1);
    }
  });

  test("plain decline and picker cancel state preservation exactly once", () => {
    for (const document of [
      installDeclinedDocument("cancelled"),
      uninstallDeclinedDocument("declined"),
      configureDeclinedDocument("default"),
      initCancelledDocument(),
      uninstallPickerNoopDocument("cancelled"),
    ]) {
      const rendered = renderBoundary(document);
      const preservationClaims = [
        /\bnothing was written\b/,
        /\bnothing was initialized or created\b/,
        /\bNo Project or setting was changed\b/,
        /\bkept the current state\b/,
        /\bbefore any write\b/,
      ].filter((claim) => claim.test(rendered));
      expect(preservationClaims.length).toBe(1);
    }
  });

  test("a declined changed-file gate keeps one Next footer for the explicit flag command", () => {
    const document = applyReplacementDeclinedDocument(
      "declined",
      ["update", "--all", "--replace-changed"].map(textArg),
      { replace: true, remove: false },
    );
    const rendered = renderBoundary(document);
    expect(rendered).not.toContain("apkit:");
    expect(rendered).not.toContain("Details:");
    expect(rendered).toContain("● ");
    // The runnable flag command is the one footer, on its own line (DEC-009, #651).
    expect(rendered).toContain("Next: apkit update --all --replace-changed");
    expect(rendered).not.toContain("To replace changed generated files without asking");

    const cancelled = applyReplacementDeclinedDocument(
      "cancelled",
      ["update", "--all"].map(textArg),
      { replace: true, remove: false },
    );
    const cancelledText = renderBoundary(cancelled);
    expect(cancelledText).not.toContain("apkit:");
    expect(cancelledText).toContain("Next: apkit update --all --replace-changed");
    expect(cancelledText).not.toContain("Details:");
  });

  test("status pending closes with one footer block carrying Next and Details", () => {
    const report = emptyReport({
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });
    const concise = lifecycleStatusDocument(report, {
      selection: { command: "status", kind: "project", match: "exact", target: "/project-a" },
    });
    const rendered = renderBoundary(concise);
    const lines = rendered.split("\n");
    const nextIndex = lines.findIndex((line) => line.startsWith("Next:"));
    const detailsIndex = lines.findIndex((line) => line.startsWith("Details:"));
    expect(nextIndex).toBeGreaterThanOrEqual(0);
    expect(detailsIndex).toBe(nextIndex + 1);
    expect(rendered.match(/Next:/g)).toHaveLength(1);
    expect(rendered.match(/Details:/g)).toHaveLength(1);
  });

  test("healthy status invents no next action", () => {
    const report = emptyReport({
      items: [{ kind: "current", project: "/project-a" }],
    });
    const rendered = renderBoundary(lifecycleStatusDocument(report, {
      selection: { command: "status", kind: "project", match: "exact", target: "/project-a" },
    }));
    expect(rendered).not.toContain("Next:");
    expect(rendered).not.toContain("Details:");
  });
});

describe("update declined diagnostic (US-006, DEC-005)", () => {
  const base = ["update", "--all"] as const;

  test("the remedy names only the operations the gate authorized", () => {
    // Poka-yoke: even a caller that passes both flags cannot print a flag the
    // gate did not authorize (INT-3 / PROD-1).
    const replaceOnly = renderBoundary(
      applyReplacementDeclinedDocument(
        "declined",
        [...base, "--replace-changed", "--remove-changed"].map(textArg),
        { replace: true, remove: false },
      ),
    );
    expect(replaceOnly).toContain("you answered no");
    expect(replaceOnly).toContain("Next: apkit update --all --replace-changed");
    expect(replaceOnly).not.toContain("--remove-changed");
    expect(replaceOnly).not.toContain("To delete changed generated files");

    const removeOnly = renderBoundary(
      applyReplacementDeclinedDocument("declined", [...base, "--remove-changed"].map(textArg), {
        replace: false,
        remove: true,
      }),
    );
    expect(removeOnly).toContain("Next: apkit update --all --remove-changed");
    expect(removeOnly).not.toContain("--replace-changed");

    const both = renderBoundary(
      applyReplacementDeclinedDocument("default", [...base].map(textArg), { replace: true, remove: true }),
    );
    expect(both).toContain("default answer no");
    expect(both).toContain("Next: apkit update --all --replace-changed --remove-changed");
  });

  test("declining stays neutral, never an error notice", () => {
    const document = applyReplacementDeclinedDocument("cancelled", [...base].map(textArg), {
      replace: true,
      remove: false,
    });
    // One standalone neutral statement; no error notice and no `apkit:` label.
    expect(document.every((node) => node.kind !== "notice")).toBe(true);
    expect(renderBoundary(document)).not.toContain("apkit:");
    expect(renderBoundary(document)).toContain("Next: apkit update --all --replace-changed");
  });
});

describe("interactive uninstall declines (INT-1)", () => {
  test("print one neutral statement and carry per-Project retries in the one Next footer", () => {
    const commands = [
      ["uninstall", "--project", "/a", "--auto-confirm"],
      ["uninstall", "--project", "/b", "--auto-confirm"],
    ].map((parts) => parts.map(textArg));
    for (const reason of ["cancelled", "declined", "default"] as const) {
      const document = uninstallInteractiveDeclinedDocument({ reason, commands });
      const rendered = renderBoundary(document);
      expect(rendered).not.toContain("apkit:");
      expect(rendered).not.toContain("Details:");
      expect(rendered).not.toContain("To proceed without asking");
      expect(rendered).not.toContain("No Project or setting was changed");
      expect(rendered.startsWith("● ")).toBe(true);
      expect(rendered).toContain("Next:");
      expect(rendered).toContain("apkit uninstall --project /a --auto-confirm");
      expect(rendered).toContain("apkit uninstall --project /b --auto-confirm");
    }
  });

  test("a late decline keeps completed work in the one statement and retries only the rest", () => {
    const document = uninstallInteractiveDeclinedDocument({
      reason: "declined",
      completedProjects: ["/done"],
      commands: [["uninstall", "--project", "/rest", "--auto-confirm"].map(textArg)],
    });
    const rendered = renderBoundary(document);
    expect(rendered).toContain("/done");
    expect(rendered).toContain("remaining Projects were not attempted");
    expect(rendered).toContain("Next:");
    expect(rendered).toContain("apkit uninstall --project /rest --auto-confirm");
    expect(rendered).not.toContain("Details:");
    expect(rendered).not.toContain("apkit:");
  });
});

describe("status wording consistency and scope accuracy (issue #505, spec #491, US-014, DEC-009, DEC-012, TEST-007)", () => {
  const createRecord = (overrides: Partial<ReconciliationProjectRecord> = {}): ReconciliationProjectRecord => ({
    blockers: [],
    canonicalProject: "/fleet/p1",
    desired: {
      context: "composed",
      hosts: ["codex"],
      outputs: [],
      profile: "coding",
      resolvedArtifacts: [],
    },
    outputs: [],
    project: "/fleet/p1",
    repositoryExclusions: [],
    setupSteps: [],
    state: { kind: "current" },
    warnings: [],
    ...overrides,
  });

  test("successful synchronization uses 'up to date' for whole fleet", () => {
    const p1 = createRecord({ canonicalProject: "/fleet/p1", project: "/fleet/p1", state: { kind: "current" } });
    const p2 = createRecord({ canonicalProject: "/fleet/p2", project: "/fleet/p2", state: { kind: "current" } });
    const p3 = createRecord({ canonicalProject: "/fleet/p3", project: "/fleet/p3", state: { kind: "current" } });
    const report: ReconciliationReport = { brokenProfileViolations: [], globalBlockers: [], projects: [p1, p2, p3] };

    const doc = lifecycleStatusDocument(report, { selection: { kind: "all" } });
    const rendered = renderBoundary(doc);
    expect(rendered).toStartWith("✔ All Projects are up to date (3 Projects)\n");
    expect(rendered).toContain("up to date");
    expect(rendered).not.toContain("Next:");
  });

  test("scoped status output cannot imply unselected Projects were checked", () => {
    // Multi-project fleet where only a subset or single project is inspected
    const p1 = createRecord({ canonicalProject: "/fleet/project-alpha", project: "/fleet/project-alpha", state: { kind: "current" } });
    const p2 = createRecord({ canonicalProject: "/fleet/project-beta", project: "/fleet/project-beta", state: { kind: "current" } });
    const p3 = createRecord({ canonicalProject: "/fleet/project-gamma", project: "/fleet/project-gamma", state: { kind: "current" } });

    // 1. Single-Project scope via --here:
    const hereReport: ReconciliationReport = { brokenProfileViolations: [], globalBlockers: [], projects: [p1] };
    const hereDoc = lifecycleStatusDocument(hereReport, {
      selection: { command: "status", kind: "project", match: "containing", target: "/fleet/project-alpha" },
    });
    const hereRendered = renderBoundary(hereDoc).trim();
    expect(hereRendered).toStartWith("✔ This Project is up to date");
    expect(hereRendered).toContain("up to date");
    expect(hereRendered).not.toContain("All Projects");
    expect(hereRendered).not.toContain("project-beta");
    expect(hereRendered).not.toContain("project-gamma");

    // 2. Single-Project scope via explicit path argument:
    const targetDoc = lifecycleStatusDocument(hereReport, {
      selection: { command: "status", kind: "project", match: "exact", target: "/fleet/project-alpha" },
    });
    const targetRendered = renderBoundary(targetDoc).trim();
    expect(targetRendered).toStartWith("✔ project-alpha is up to date");
    expect(targetRendered).toContain("up to date");
    expect(targetRendered).not.toContain("All Projects");
    expect(targetRendered).not.toContain("project-beta");
    expect(targetRendered).not.toContain("project-gamma");

    // 3. Selected-subset scope (e.g. 2 of 3 projects checked):
    const subsetReport: ReconciliationReport = { brokenProfileViolations: [], globalBlockers: [], projects: [p1, p2] };
    const subsetDoc = lifecycleStatusDocument(subsetReport, {
      selection: { command: "status", kind: "project", match: "containing", target: "/fleet" },
    });
    const subsetRendered = renderBoundary(subsetDoc).trim();
    expect(subsetRendered).toStartWith("✔ Selected Projects are up to date (2 Projects)");
    expect(subsetRendered).toContain("up to date");
    expect(subsetRendered).not.toContain("All Projects");

    // Filtered selection subset:
    const filteredDoc = lifecycleStatusDocument(subsetReport, {
      selection: { kind: "all", filter: "stale" },
    });
    const filteredRendered = renderBoundary(filteredDoc).trim();
    expect(filteredRendered).toStartWith("✔ Selected Projects are up to date (2 Projects)");
    expect(filteredRendered).toContain("up to date");
    expect(filteredRendered).not.toContain("All Projects");
  });

  test("machine JSON facts remain unchanged and byte-identical in meaning", () => {
    const p1 = createRecord({
      canonicalProject: "/fleet/p1",
      project: "/fleet/p1",
      state: { kind: "current" },
    });
    const report: ReconciliationReport = { brokenProfileViolations: [], globalBlockers: [], projects: [p1] };

    const json = JSON.parse(formatLifecycleJson("status", report));
    expect(json.command).toBe("status");
    expect(json.outcome).toBe("clean");
    expect(json.projects[0].state.kind).toBe("current");
  });

  test("detailed human output retains default cause labels and adds specifics without synonyms", () => {
    const notInstalled = createRecord({
      canonicalProject: "/fleet/p-new",
      project: "/fleet/p-new",
      state: { kind: "addition" },
    });
    const changed = createRecord({
      canonicalProject: "/fleet/p-changed",
      project: "/fleet/p-changed",
      state: { kind: "drifted output" },
      outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "file.md" }],
    });
    const missing = createRecord({
      canonicalProject: "/fleet/p-missing",
      project: "/fleet/p-missing",
      state: { kind: "drifted output" },
      outputs: [{ consumingHosts: ["codex"], driftKind: "missing", kind: "update", path: "file.md" }],
    });
    const source = createRecord({
      canonicalProject: "/fleet/p-source",
      project: "/fleet/p-source",
      state: { kind: "stale source" },
    });
    const settled = createRecord({
      canonicalProject: "/fleet/p-settled",
      project: "/fleet/p-settled",
      state: { kind: "current" },
    });
    const blocked = createRecord({
      canonicalProject: "/fleet/p-blocked",
      project: "/fleet/p-blocked",
      state: { kind: "blocked", reason: "occupied output" },
      blockers: [fixtureBlocker("file is occupied", "/fleet/p-blocked")],
    });
    const removal = createRecord({
      canonicalProject: "/fleet/p-removal",
      project: "/fleet/p-removal",
      state: { kind: "removal" },
    });

    const report: ReconciliationReport = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [notInstalled, changed, missing, source, settled, blocked, removal],
    };

    const doc = lifecycleStatusDocument(report, { verbose: true });
    const rendered = renderBoundary(doc);

    // Default cause labels are retained in Projects: section:
    expect(rendered).toContain("/fleet/p-new: not installed yet");
    expect(rendered).toContain("/fleet/p-changed: generated files changed");
    expect(rendered).toContain("/fleet/p-missing: generated files missing");
    expect(rendered).toContain("/fleet/p-source: source changed");
    expect(rendered).toContain("/fleet/p-settled: up to date");

    // Specifics added for needs attention:
    expect(rendered).toContain("/fleet/p-blocked: needs attention (blocked: occupied output)");
    expect(rendered).toContain("/fleet/p-removal: needs attention (removal)");

    // Synonyms must NOT appear as project cause labels:
    expect(rendered).not.toMatch(/\/fleet\/p-new:\s+addition/);
    expect(rendered).not.toMatch(/\/fleet\/p-changed:\s+drifted output/);
    expect(rendered).not.toMatch(/\/fleet\/p-missing:\s+drifted output/);
    expect(rendered).not.toMatch(/\/fleet\/p-source:\s+stale source/);
    expect(rendered).not.toMatch(/\/fleet\/p-settled:\s+current/);

    // State explanations section uses default cause labels:
    expect(rendered).toContain("State explanations:");
    expect(rendered).toContain("- needs attention:");
    expect(rendered).toContain("- generated files changed:");
    expect(rendered).toContain("- generated files missing:");
    expect(rendered).toContain("- not installed yet:");
    expect(rendered).toContain("- source changed:");

    // Synonyms must NOT be explanation keys:
    expect(rendered).not.toContain("- addition:");
    expect(rendered).not.toContain("- drifted output:");
    expect(rendered).not.toContain("- stale source:");
  });
});


describe("status scope inventory (spec #640 US-007, #650, TEST-003, TEST-005)", () => {
  const createRecord = (overrides: Partial<ReconciliationProjectRecord> = {}): ReconciliationProjectRecord => ({
    blockers: [],
    canonicalProject: "/fleet/p1",
    desired: {
      context: "composed",
      hosts: ["codex"],
      outputs: [],
      profile: "coding",
      resolvedArtifacts: [],
    },
    outputs: [],
    project: "/fleet/p1",
    repositoryExclusions: [],
    setupSteps: [],
    state: { kind: "current" },
    warnings: [],
    ...overrides,
  });
  const workspace = { authored: "~/apkit-workspace", canonical: "/home/me/apkit-workspace" };
  const healthyFleet = () => ({
    brokenProfileViolations: [],
    globalBlockers: [],
    projects: [
      createRecord({ canonicalProject: "/fleet/alpha", project: "/fleet/alpha" }),
      createRecord({ canonicalProject: "/fleet/beta", project: "/fleet/beta" }),
      createRecord({ canonicalProject: "/fleet/gamma", project: "/fleet/gamma" }),
      createRecord({ canonicalProject: "/fleet/delta", project: "/fleet/delta" }),
    ],
  });
  const mixedFleet = () => ({
    brokenProfileViolations: [],
    globalBlockers: [],
    projects: [
      createRecord({
        blockers: [fixtureBlocker("occupied output", "/fleet/alpha")],
        canonicalProject: "/fleet/alpha",
        project: "/fleet/alpha",
        state: { kind: "blocked" },
      }),
      createRecord({
        canonicalProject: "/fleet/beta",
        project: "/fleet/beta",
        state: { kind: "drifted output" },
        outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "a.md" }],
      }),
      createRecord({
        canonicalProject: "/fleet/gamma",
        project: "/fleet/gamma",
        state: { kind: "drifted output" },
        outputs: [{ consumingHosts: ["codex"], driftKind: "missing", kind: "update", path: "b.md" }],
      }),
      createRecord({
        canonicalProject: "/fleet/delta",
        project: "/fleet/delta",
        state: { kind: "addition" },
      }),
      createRecord({
        canonicalProject: "/fleet/epsilon",
        project: "/fleet/epsilon",
        state: { kind: "stale source" },
      }),
      createRecord({ canonicalProject: "/fleet/zeta", project: "/fleet/zeta" }),
    ],
  });

  test("healthy fleet names the Workspace and prints one row per checked Project including healthy", () => {
    const document = lifecycleStatusDocument(healthyFleet(), { workspace });
    const rendered = renderBoundary(document, context(100));

    expect(rendered).toStartWith("✔ All Projects are up to date (4 Projects)\n");
    expect(rendered).toContain("Workspace: ~/apkit-workspace");
    expect(rendered).toContain("Project");
    expect(rendered).toContain("Primary Cause");
    for (const project of ["alpha", "beta", "gamma", "delta"]) {
      expect(rendered).toContain(project);
      expect(rendered).toContain("up to date");
    }
    expect((rendered.match(/up to date/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(rendered).not.toContain("Next:");
    expect(rendered).not.toContain("Details:");
  });

  test("mixed Primary Causes print one row per Project with canonical cause labels and keep Blocker evidence", () => {
    const document = lifecycleStatusDocument(mixedFleet(), { workspace });
    const rendered = renderBoundary(document, context(100));

    expect(rendered).toStartWith("⚠ Cannot update\n");
    expect(rendered).toContain("Workspace: ~/apkit-workspace");
    expect(rendered).toContain("needs attention");
    expect(rendered).toContain("generated files changed");
    expect(rendered).toContain("generated files missing");
    expect(rendered).toContain("not installed yet");
    expect(rendered).toContain("source changed");
    expect(rendered).toContain("up to date");
    expect(rendered).toContain("Blocker:");
    expect(rendered).toContain("Requirement:");
    expect(rendered).toContain("Remedy:");
    expect(rendered).toContain("Next:");
    // Rows carry every checked Project; settled is not a bare count.
    expect(rendered).not.toContain("settled (");
  });

  test("mixed Primary Causes render rows in PRIMARY_CAUSE_ORDER then settled (INT-1)", () => {
    const document = lifecycleStatusDocument(mixedFleet(), { workspace });
    const rendered = renderBoundary(document, context(100));

    // Cause labels appear in the promised order: each cause's row is reached
    // before the next cause's row, and settled `up to date` is last.
    const causeOrder = [
      "needs attention",
      "generated files changed",
      "generated files missing",
      "not installed yet",
      "source changed",
    ] as const;
    const causeIndexes = causeOrder.map((label) => rendered.indexOf(label));
    for (let index = 1; index < causeIndexes.length; index += 1) {
      expect(causeIndexes[index]!).toBeGreaterThan(causeIndexes[index - 1]!);
    }
    const settledIndex = rendered.indexOf("up to date");
    expect(settledIndex).toBeGreaterThan(causeIndexes[causeOrder.length - 1]!);

    // Project rows follow the same sequence (alpha…zeta map one-to-one onto
    // the causes above, settled last).
    const projectOrder = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"] as const;
    const projectIndexes = projectOrder.map((name) => rendered.indexOf(name));
    for (let index = 1; index < projectIndexes.length; index += 1) {
      expect(projectIndexes[index]!).toBeGreaterThan(projectIndexes[index - 1]!);
    }
  });

  test("same-cause Projects break ties by canonical Project (INT-1)", () => {
    const sameCause = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [
        // Insertion order is deliberately reverse-canonical.
        createRecord({
          canonicalProject: "/fleet/zulu",
          project: "/fleet/zulu",
          state: { kind: "stale source" },
        }),
        createRecord({
          canonicalProject: "/fleet/alpha",
          project: "/fleet/alpha",
          state: { kind: "stale source" },
        }),
        createRecord({
          canonicalProject: "/fleet/middle",
          project: "/fleet/middle",
          state: { kind: "stale source" },
        }),
      ],
    };
    const document = lifecycleStatusDocument(sameCause, { workspace });
    const rendered = renderBoundary(document, context(100));

    const alphaAt = rendered.indexOf("alpha");
    const middleAt = rendered.indexOf("middle");
    const zuluAt = rendered.indexOf("zulu");
    expect(alphaAt).toBeGreaterThan(-1);
    expect(middleAt).toBeGreaterThan(alphaAt);
    expect(zuluAt).toBeGreaterThan(middleAt);
    // Every row still carries the same canonical cause.
    expect(rendered.match(/source changed/g) ?? []).toHaveLength(3);
  });

  test("pending work without a Blocker uses the warning headline Ready to update", () => {
    const pendingOnly = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [
        createRecord({
          canonicalProject: "/fleet/beta",
          project: "/fleet/beta",
          state: { kind: "addition" },
        }),
        createRecord({ canonicalProject: "/fleet/zeta", project: "/fleet/zeta" }),
      ],
    };
    const document = lifecycleStatusDocument(pendingOnly, { workspace });
    const rendered = renderBoundary(document, context(100));
    expect(rendered).toStartWith("⚠ Ready to update\n");
    expect(rendered).not.toStartWith("✔ ");
  });

  test("a Blocker never sits under a clean headline", () => {
    const document = lifecycleStatusDocument(mixedFleet(), { workspace });
    const rendered = renderBoundary(document, context(100));
    expect(rendered).toStartWith("⚠ ");
    expect(rendered).not.toStartWith("✔ ");
  });

  test("scoped status names only the Projects in that scope with canonical Primary Cause", () => {
    const scoped = {
      brokenProfileViolations: [],
      globalBlockers: [],
      projects: [
        createRecord({
          canonicalProject: "/fleet/beta",
          project: "/fleet/beta",
          state: { kind: "drifted output" },
          outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "a.md" }],
        }),
        createRecord({
          canonicalProject: "/fleet/gamma",
          project: "/fleet/gamma",
          state: { kind: "drifted output" },
          outputs: [{ consumingHosts: ["codex"], driftKind: "missing", kind: "update", path: "b.md" }],
        }),
      ],
    };
    const document = lifecycleStatusDocument(scoped, {
      selection: { kind: "all", filter: "stale" },
      workspace,
    });
    const rendered = renderBoundary(document, context(100));

    expect(rendered).toContain("beta");
    expect(rendered).toContain("gamma");
    expect(rendered).not.toContain("alpha");
    expect(rendered).not.toContain("delta");
    expect(rendered).toContain("generated files changed");
    expect(rendered).toContain("generated files missing");
  });

  test("empty scope is a distinct neutral statement and still names the Workspace", () => {
    const empty = { brokenProfileViolations: [], globalBlockers: [], projects: [] };
    const document = lifecycleStatusDocument(empty, {
      selection: { kind: "all", filter: "stale" },
      workspace,
    });
    const rendered = renderBoundary(document, context(100));

    expect(rendered).toStartWith("● No stale Projects.\n");
    expect(rendered).toContain("Workspace: ~/apkit-workspace");
    expect(rendered).not.toContain("up to date");
    expect(rendered).not.toContain("Next:");
  });

  test("empty unconfigured fleet is neutral and distinct from an empty scope filter", () => {
    const empty = { brokenProfileViolations: [], globalBlockers: [], projects: [] };
    const document = lifecycleStatusDocument(empty, { workspace });
    const rendered = renderBoundary(document, context(100));

    expect(rendered).toStartWith("● No Projects are configured.\n");
    expect(rendered).toContain("Workspace: ~/apkit-workspace");
    expect(rendered).not.toContain("No stale Projects.");
    expect(rendered).toContain("apkit install");
  });

  test("primaryCauseLabel reads classifyPrimaryCause once and never adds synonyms", () => {
    expect(primaryCauseLabel(createRecord())).toBe("up to date");
    expect(primaryCauseLabel(createRecord({ state: { kind: "addition" } }))).toBe("not installed yet");
    expect(primaryCauseLabel(createRecord({ state: { kind: "stale source" } }))).toBe("source changed");
    expect(primaryCauseLabel(createRecord({
      outputs: [{ consumingHosts: ["codex"], driftKind: "changed", kind: "update", path: "a.md" }],
      state: { kind: "drifted output" },
    }))).toBe("generated files changed");
    expect(primaryCauseLabel(createRecord({
      outputs: [{ consumingHosts: ["codex"], driftKind: "missing", kind: "update", path: "a.md" }],
      state: { kind: "drifted output" },
    }))).toBe("generated files missing");
    expect(primaryCauseLabel(createRecord({ blockers: [fixtureBlocker("occupied output", "/fleet/p1")] }))).toBe("needs attention");
  });

  test("at 60 columns scope rows pack greedily onto one line when the fields fit", () => {
    const document = lifecycleStatusDocument(healthyFleet(), { workspace });
    const rendered = renderBoundary(document, context(60));
    const lines = rendered.trimEnd().split("\n");

    expect(rendered).toStartWith("✔ All Projects are up to date (4 Projects)\n");
    // #649's packer: Project + Primary Cause share one line when they fit the measure.
    const packed = lines.filter((line) => line.includes("Primary Cause:") && line.includes("Project:"));
    expect(packed.length).toBeGreaterThanOrEqual(4);
    for (const line of packed) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  test("at 60 columns a blocked fleet keeps complete Blocker evidence and no actionable item disappears", () => {
    const document = lifecycleStatusDocument(mixedFleet(), { workspace });
    const rendered = renderBoundary(document, context(60));

    expect(rendered).toStartWith("⚠ Cannot update\n");
    for (const label of [
      "needs attention",
      "generated files changed",
      "generated files missing",
      "not installed yet",
      "source changed",
      "up to date",
    ]) {
      expect(rendered).toContain(label);
    }
    expect(rendered).toContain("Blocker:");
    expect(rendered).toContain("Remedy:");
    expect(rendered).toContain("alpha");
    expect(rendered).toContain("zeta");
  });

  test("healthy fleet at 100 columns uses the shared header-row seam", () => {
    const document = lifecycleStatusDocument(healthyFleet(), { workspace });
    const rendered = renderBoundary(document, context(100));
    const lines = rendered.trimEnd().split("\n");
    const header = lines.find((line) => line.startsWith("Project") && line.includes("Primary Cause"));
    expect(header).toBeDefined();
  });
});


describe("broken Profile reporting in lifecycle and install views (#606)", () => {
  /** One real missing-reference violation collected through tolerant ingestion. */
  async function brokenFleetViolations(): Promise<{
    readonly cleanup: () => void;
    readonly violations: readonly WorkspaceViolation[];
  }> {
    const workspace = mkdtempSync(join(tmpdir(), "agent-profile-kit-broken-presentation-"));
    mkdirSync(join(workspace, "context"), { recursive: true });
    mkdirSync(join(workspace, "skills"), { recursive: true });
    mkdirSync(join(workspace, "profiles"), { recursive: true });
    writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
    writeFileSync(join(workspace, "context", "notes.md"), "Notes.\n");
    writeFileSync(
      join(workspace, "profiles", "broken.yaml"),
      "context: [gone-context]\nskills: []\n",
    );
    const ingestion = await ingestWorkspaceToleratingReferenceViolations(workspace);
    return {
      cleanup: () => rmSync(workspace, { recursive: true, force: true }),
      violations: brokenProfileViolations(ingestion.brokenProfiles),
    };
  }

  /** A healthy pending Project beside the unbound broken Profile. */
  function pendingReport(violations: readonly WorkspaceViolation[]): ReconciliationReport {
    return {
      ...emptyReport({
        desired: [{
          canonicalProject: "/project-a",
          context: "composed",
          outputs: ["a.md"],
          profile: "healthy",
          project: "/project-a",
          resolvedArtifacts: [],
        }],
        items: [{ kind: "addition", project: "/project-a" }],
        outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
      }),
      brokenProfileViolations: violations,
    };
  }

  test("concise status lists every broken Profile", async () => {
    const { cleanup, violations } = await brokenFleetViolations();
    try {
      const rendered = renderBoundary(lifecycleStatusDocument(pendingReport(violations)));
      expect(rendered).toContain("Broken Profiles (missing reference");
      expect(rendered).toContain("broken");
    } finally {
      cleanup();
    }
  });

  test("concise update lists every broken Profile", async () => {
    const { cleanup, violations } = await brokenFleetViolations();
    try {
      const report = pendingReport(violations);
      const rendered = renderBoundary(applyReportDocument(applyResult(report)));
      expect(rendered).toContain("Broken Profiles (missing reference");
      expect(rendered).toContain("broken");
    } finally {
      cleanup();
    }
  });

  test("verbose status lists every broken Profile", async () => {
    const { cleanup, violations } = await brokenFleetViolations();
    try {
      const rendered = renderBoundary(
        lifecycleStatusDocument(pendingReport(violations), { verbose: true }),
      );
      expect(rendered).toContain("Broken Profiles (missing reference");
      expect(rendered).toContain("broken");
    } finally {
      cleanup();
    }
  });

  test("the blocked install view lists every broken Profile", async () => {
    const { cleanup, violations } = await brokenFleetViolations();
    try {
      const report = asBlockedReport({
        ...emptyReport({ blockers: [fixtureBlocker("occupied output", "/project-a")] }),
        brokenProfileViolations: violations,
      });
      const rendered = renderBoundary(
        installBlockedDocument(report, [{ kind: "text", value: "install" }]),
      );
      expect(rendered).toContain("Broken Profiles (missing reference");
      expect(rendered).toContain("broken");
    } finally {
      cleanup();
    }
  });
});
