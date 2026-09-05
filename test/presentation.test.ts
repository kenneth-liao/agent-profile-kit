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
  applyExecutionFailureDocument,
  applyReportDocument,
  applyVerificationFailureDocument,
  blockedApplyReportDocument,
  formatApplyJson,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatLifecycleJson,
  formatLifecycleToolErrorJson,
  hostInventoryDocument,
  infoDocument,
  inventoryIndexDocument,
  lifecycleStatusDocument,
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
  OPENCODE_CONFIG_OCCUPIED_REMEDY,
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

/** One structured fixture blocker; global without a project, project-scoped with one. */
function fixtureBlocker(message: string, project?: string): ReconciliationBlocker {
  return project === undefined
    ? normalizeBlocker({
        affectedItems: [],
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
      "blank",
      "key-value(Project)",
      "key-value(Profile):path",
      "key-value(Hosts)",
      "prose:error",
      "prose",
      "prose",
      "prose",
      "blank",
      "notice:error",
      "blank",
      "heading",
      "list-item",
    ]);
    const blocker = flattenPresentationNodes(document).filter((node) =>
      node.kind === "prose"
    ) as Extract<PresentationNode, { kind: "prose" }>[];
    expect(blocker.some((node) => node.category === "error" && nodeText(node).startsWith("  Blocker: "))).toBe(true);
    expect(blocker.some((node) => nodeText(node).startsWith("    Requirement: "))).toBe(true);
    expect(blocker.some((node) => nodeText(node).startsWith("    Remedy: "))).toBe(true);
    expect(blocker.some((node) => nodeText(node).startsWith("    Scope: "))).toBe(true);
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
      "heading:attention",
      "prose",
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
      "Warnings:",
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
      "prose",
      "blank",
      "prose:error",
      "blank",
      "heading",
      "list-item",
    ]);
    expect(flattenPresentationNodes(document).some((node) => node.kind === "path")).toBe(true);
    expect(flattenPresentationNodes(document).some((node) =>
      (node.kind === "prose" || node.kind === "heading") &&
      /occupied output/i.test(nodeText(node))
    )).toBe(true);
    expect(document.some((node) =>
      (node.kind === "heading" || node.kind === "prose") &&
      /Host setup|Warnings:/i.test(nodeText(node))
    )).toBe(false);
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
      "blank",
      "heading:attention",
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
      lifecycleStatusDocument(report, { project }),
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
      lifecycleStatusDocument(report, { project }),
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
        fixtureOwnershipBlocker(
          "The selected generated output cannot be replaced until ownership is resolved.",
          "/project-a",
        ),
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

    const rendered = renderBoundary(
      lifecycleStatusDocument(report),
      { color: true, interactive: true, width: 80 },
    );

    expect(rendered).toContain("\u001b[31mCannot apply\u001b[0m");
    expect(rendered).toContain("\u001b[35m/project-a\u001b[0m");
    expect(rendered).toMatch(/\u001b\[31m  Blocker: [^\u001b]*\u001b\[0m/);
    expect(rendered).toContain("\u001b[33mWarnings:\u001b[0m");
    expect(rendered).toContain("\u001b[31mProjects: 1 · Blockers: 1\u001b[0m");
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

/** Flat text facts of a presentation document, asserted as structure — never
 * as rendered prose. Covers prose, headings, verbatim bodies, and identifiers
 * reached through key-value, list-item and notice nesting. */
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

/** The carried texts following the "Projects:" heading until the next heading:
 * the verbose Project state lines, each naming one identity. */
function projectStateLines(document: PresentationDocument): string[] {
  const nodes = flattenPresentationNodes(document);
  const start = indexWhere(nodes, (node) =>
    node.kind === "heading" && nodeText(node) === "Projects:");
  if (start < 0) return [];
  const texts: string[] = [];
  for (let index = start + 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind === "heading") break;
    texts.push(nodeText(node));
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
      "Review and approve the generated SessionStart hook when Codex asks so the Profile can load.",
      "Trust the bound project in Codex so the Profile can load.",
      "Launch Codex from the exact bound project root so the Profile can load.",
    ]);
    expect(headingsIn(applyReportDocument(applyResult(report, resultingState))))
      .not.toContain("Host setup:");
    expect(headingsIn(applyReportDocument(applyResult(report, resultingState))))
      .not.toContain("Standing Host setup:");
    expect(concise.some((node) =>
      node.kind === "prose" && nodeText(node).startsWith("  Consequence: ")
    )).toBe(false);
    expect(concise.at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });

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
    expect(flattenPresentationNodes(verbose).at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    // Each forbidden concise first-use payload is independently absent.
    expect(listItemsIn(concise)).not.toContain(
      "Trust the bound project in Codex so the Profile can load.",
    );
    expect(listItemsIn(concise)).not.toContain(
      "Launch Codex from the exact bound project root so the Profile can load.",
    );
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
    expect(listItemsIn(concise)).not.toContain(
      "Trust the bound project in Pi so the Profile can load.",
    );
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
    expect(listItemsIn(concise)).not.toContain("Trust the bound project in Codex so the Profile can load.");
    expect(flattenPresentationNodes(concise).at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(concise.at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(listItemsIn(concise)).not.toContain(
      "Grok uses Claude's shared rule path so the Profile can load.",
    );
    expect(flattenPresentationNodes(concise).at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node).includes("becomes active"))).toBe(false);
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node) === "All Projects were already current.")).toBe(true);
    expect(flattenPresentationNodes(
      applyReportDocument(applyResult(report), { verbose: true }),
    ).some((node) => node.kind === "prose" && nodeText(node).includes("becomes active"))).toBe(false);
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
      "Review and approve the generated SessionStart hook when Codex asks so the Profile can load.",
      "Trust the bound project in Codex so the Profile can load.",
      "Trust the bound project in Pi so the Profile can load.",
    ]);
    expect(listItemsIn(concise).filter((text) =>
      text === "Trust the bound project in Codex so the Profile can load."
    )).toHaveLength(1);
    expect(listItemsIn(concise).filter((text) =>
      text === "Trust the bound project in Pi so the Profile can load."
    )).toHaveLength(1);
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
    expect(concise).toContain(
      "Launch Codex from the exact bound project root for 2 projects (use --verbose to see all Projects) so the Profile can load.",
    );

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
    expect(listItemsIn(concise)).not.toContain("Trust the bound project in Codex so the Profile can load.");
    expect(flattenPresentationNodes(concise).at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(concise.at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(presentationTexts(verbose)).not.toContain("use --verbose");
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
    expect(listItemsFrom(failure, firstUse + 1)).toEqual([
      "Trust the bound project in Codex so the Profile can load.",
    ]);
    expect(flattenPresentationNodes(failure).some((node) =>
      node.kind === "prose" && nodeText(node).includes("becomes active")
    )).toBe(false);
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
      lifecycleStatusDocument(report, { project }),
      context(40),
    );
    const wideStatus = renderBoundary(
      lifecycleStatusDocument(report, { project }),
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
    expect(warningListItem?.parts).toEqual([
      "Inspect ",
      { kind: "identifier", value: projectPath },
      " for generated configuration.",
      " (1 Project)",
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
    expect(warningItem?.parts).toEqual([
      "Codex SessionStart hooks are not enabled by ",
      { kind: "identifier", value: globalPath },
      "; generated Profile Context may not load until [features].hooks = true is set in ",
      { kind: "identifier", value: `${projectPath}/.codex/config.toml` },
      " or ",
      { kind: "identifier", value: globalPath },
      " (1 Project)",
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
    expect(warningItem?.parts).toEqual([
      "Antigravity project surface cannot host Context: ",
      { kind: "identifier", value: agentsPath },
      " is a file, not a directory",
      " (1 Project)",
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

test("terminal styling follows lifecycle labels emitted by the formatter", () => {
  const context = { color: true, interactive: true, width: 80 } as const;
  const ready = renderBoundary(lifecycleStatusDocument(identityReport("/project-a")), context);
  const blocked = renderBoundary(
    lifecycleStatusDocument(emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      items: [{ kind: "blocked", project: "/project-a" }],
    })),
    context,
  );

  expect(ready).toContain("Updates ready");
  expect(blocked).toContain("Cannot apply");
});

/** Distinctive anchor phrases — not a second home for the full gloss table. */
const STATE_ANCHORS: Readonly<Record<(typeof NON_CURRENT_STATE_ORDER)[number], string>> = {
  addition: "not installed yet",
  update: "rewrite generated files managed by Agent Profile Kit",
  "stale source": "Workspace source changed",
  "drifted output": "replace it from current",
  "malformed ownership state": "cannot prove what it owns",
  blocked: "Sync cannot change this Project",
  removal: "remove proven generated files managed by Agent Profile Kit",
};

function expectUserFacingVocabulary(view: string): void {
  for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(view).not.toMatch(term);
}

/** The tracked-path group lines of an ownership-conflict Blocker: the prose
 * members following its "Affected paths" node, in document order. */
function trackedPathLines(document: PresentationDocument): string[] {
  const nodes = flattenPresentationNodes(document);
  const start = indexWhere(nodes, (node) =>
    node.kind === "prose" && /^\s*Affected paths \(\d+\):$/.test(nodeText(node)));
  if (start < 0) return [];
  const texts: string[] = [];
  for (let index = start + 1; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    if (node.kind !== "prose" || !nodeText(node).startsWith(`${" ".repeat(6)}- `)) break;
    texts.push(nodeText(node));
  }
  return texts;
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
        node.kind === "prose" && node.category === "error" && nodeText(node).startsWith("  Blocker: "));
      const summaryIndex = indexWhere(nodes, (node) =>
        node.kind === "notice" && (node.nodes ?? []).some((child) =>
          child.kind === "prose" && nodeText(child).startsWith("Projects: ")));
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
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "prose" && node.category === "error" && nodeText(node) ===
        "  Blocker: Cannot verify generated-file ownership: owned output .codex/hooks.json has unsafe parent: /project-a/.codex"
    )).toBe(true);
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
          message: "Cannot verify generated-file ownership: owned output .codex/hooks.json has unsafe parent: /project-a/.codex",
          problem: "Cannot verify generated-file ownership: owned output .codex/hooks.json has unsafe parent: /project-a/.codex",
          project: "/project-a",
          remedy: "Remove the conflicting generated files yourself after verifying the paths, then retry",
          requirement:
            "Agent Profile Kit syncs or removes only files whose ownership is proven by the " +
            "active installation record at safe paths",
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
      node.kind === "prose" && node.category === "error" &&
      nodeText(node).startsWith("  Blocker: "));
    expect(blockerIndex).toBeGreaterThan(-1);
    // Every structured field is its own prose node in the typed evidence block.
    expect(nodeText(nodes[blockerIndex + 1]!)).toBe(
      "    Requirement: Agent Profile Kit syncs or removes only files whose ownership is " +
        "proven by the active installation record at safe paths",
    );
    expect(nodeText(nodes[blockerIndex + 2]!)).toBe(
      "    Remedy: Remove the conflicting generated files yourself after verifying the paths, " +
        "then retry. Run apkit apply to retry.",
    );
    expect(nodeText(nodes[blockerIndex + 3]!)).toBe("    Scope: Project /project-a");
    expect(nodeText(nodes[blockerIndex + 4]!)).toBe("    Affected host: codex");
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
      node.kind === "prose" && node.category === "error" &&
      nodeText(node).startsWith("  Blocker: ")
    )).toHaveLength(1);
    expect(conciseNodes.some((node) =>
      node.kind === "prose" && nodeText(node).startsWith("    Requirement: ")
    )).toBe(true);
    const remedy = conciseNodes.find((node) =>
      node.kind === "prose" && nodeText(node).startsWith("    Remedy: "));
    expect(remedy).toBeDefined();
    expect(nodeText(remedy!)).toContain("keep repository ownership");
    expect(nodeText(remedy!)).toContain("intentionally remove");
    expect(trackedPathLines(concise)).toEqual([
      "      - .agent-profile-kit/codex/context.md",
      "      - .agents/skills/ (12 paths)",
      "      - .claude/rules/agent-profile-kit.md",
      "      - .codex/hooks.json",
    ]);
    expect(presentationTexts(concise).some((text) =>
      text.includes("/project-a/.agents/skills/s08")
    )).toBe(false);
    expect(commandTexts(concise).some((text) => text.includes("rm -r --cached"))).toBe(false);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const verboseTexts = presentationTexts(verbose);

    // Every proven path is an Affected path node; one Requirement; the exact
    // untracking command stays out of the ordinary verbose view.
    expect(verboseTexts).toContain("  Affected path: /project-a/.agents/skills/s11");
    expect(verboseTexts).toContain("  Affected path: /project-a/.agents/skills/s12");
    expect(verboseTexts).toContain("  Affected path: /project-a/.codex/hooks.json");
    expect(verboseTexts.filter((text) => text.startsWith("  Requirement: "))).toHaveLength(1);
    expect(verboseTexts.some((text) => text.includes("more paths"))).toBe(false);
    expect(verboseTexts.some((text) => text.includes("rm -r --cached"))).toBe(false);
    expect(commandTexts(verbose).some((text) => text.includes("rm -r --cached"))).toBe(false);
    // The ordinary verbose remedy points at the focused view through one
    // typed inline command part.
    expect(inlineCommandTexts(flattenPresentationNodes(verbose))).toContain(
      "apkit status --blockers-only --verbose",
    );
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

    expect(presentationTexts(concise)).toContain("    Affected paths (11):");
    expect(trackedPathLines(concise)).toEqual(["      - .agents/skills/ (11 paths)"]);
    expect(presentationTexts(concise).some((text) => text.includes("more path"))).toBe(false);
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
          affectedItems: [],
          detail: "Installation State is unreadable",
          kind: "installation-state-unreadable",
          scope: "global",
        }),
      ],
    });

    const concise = lifecycleStatusDocument(report);
    const nodes = flattenPresentationNodes(concise);

    expect(headingsIn(concise)).toContain("Global blockers:");
    expect(nodes.some((node) =>
      node.kind === "prose" && node.category === "error" &&
      nodeText(node).includes("Blocker: installation record is unreadable")
    )).toBe(true);
    const projectAt = indexWhere(nodes, (node) =>
      node.kind === "key-value" && node.key === "Project");
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
    `git -C '${project}' rm -r --cached -- ${[...paths]
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

    expect(presentationTexts(concise)).toContain("    Affected paths (6):");
    expect(trackedPathLines(concise)).toEqual([
      "      - ./ (2 paths)",
      "      - .agents/skills/ (2 paths)",
      "      - .agents/skills/b/deep.md",
      "      - .codex/hooks.json",
    ]);
    expect(presentationTexts(concise).some((text) => text.includes("(1 path"))).toBe(false);
  });

  test("assigns paths under overlapping prefixes to exactly one group each (#353)", () => {
    const paths = [
      ".a/b/c.txt",
      ".a/b/d/e.txt",
      ".a/b/f.txt",
    ];
    const concise = lifecycleStatusDocument(ownershipReport(paths));

    expect(trackedPathLines(concise)).toEqual([
      "      - .a/b/ (2 paths)",
      "      - .a/b/d/e.txt",
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
    expect(trackedPathLines(first)).toEqual([
      "      - root.md",
      "      - .a/one.md",
      "      - .a/sub/three.md",
      "      - .b/two.md",
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

    const gitCommands = commandTexts(focusedVerbose).filter((text) =>
      text.includes("rm -r --cached"));
    expect(gitCommands).toHaveLength(1);
    // The command node carries the exact invocation; every proven path appears
    // once as its own quoted argument.
    expect(gitCommands[0]).toBe(untrackCommandFor("/project-a", paths));
    expect(gitCommands[0]).toContain("git -C '/project-a' rm -r --cached --");
    expect(gitCommands[0]).toContain("-- '-leading-dash.md'");
    expect(gitCommands[0]).toContain("'weird'\\''name.md'");
  });

  test("focused verbose recovery copy preserves working files and keeps the binding alternative (#353)", () => {
    const focusedVerbose = lifecycleStatusDocument(
      ownershipReport([".codex/hooks.json"]),
      { blockersOnly: true, verbose: true },
    );
    const nodes = flattenPresentationNodes(focusedVerbose);
    const gitIndex = indexWhere(nodes, (node) =>
      node.kind === "command" &&
      commandTexts([node]).includes("git -C '/project-a' rm -r --cached -- '.codex/hooks.json'"));
    expect(gitIndex).toBeGreaterThan(-1);
    // The recovery block frames the exact command with the working-files
    // statement and the binding alternative as prose nodes.
    expect(nodes[gitIndex - 1]).toMatchObject({ kind: "prose" });
    expect(nodes[gitIndex + 1]).toMatchObject({ kind: "prose" });
  });

  test("ordinary concise, focused concise, and ordinary verbose point to focused diagnostics without the command (#353)", () => {
    const report = ownershipReport([".codex/hooks.json", ".agents/skills/s01.md"]);
    const concise = lifecycleStatusDocument(report);
    const focusedConcise = lifecycleStatusDocument(report, { blockersOnly: true });
    const verbose = lifecycleStatusDocument(report, { verbose: true });

    for (const document of [concise, focusedConcise, verbose]) {
      expect(inlineCommandTexts(flattenPresentationNodes(document))).toContain(
        "apkit status --blockers-only --verbose",
      );
      const texts = presentationTexts(document);
      expect(texts.some((text) => text.includes("rm -r --cached"))).toBe(false);
      expect(commandTexts(document).some((text) => text.includes("rm -r --cached"))).toBe(false);
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
    expect(commandTexts(focusedApply).filter((text) => text.includes("rm -r --cached")))
      .toHaveLength(1);
    expect(commandTexts(focusedApply)).toContain(command);

    const blockedApply = blockedApplyReportDocument(
      asBlockedReport(resultingState),
      { blockersOnly: true, verbose: true },
    );
    expect(commandTexts(blockedApply)).toContain(command);

    const executionFailure = applyExecutionFailureDocument({
      detail: "Apply failed while writing the Project",
      failedProject: executionProject(project),
      message: "Apply failed while writing the Project",
      pendingProjects: [],
      receipt,
      resultingState,
    }, { blockersOnly: true, verbose: true });
    expect(commandTexts(executionFailure)).toContain(command);

    const ordinaryVerbose = flattenPresentationNodes(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    expect(inlineCommandTexts(ordinaryVerbose)).toContain(
      "apkit apply --blockers-only --verbose",
    );
    expect(commandTexts(applyReportDocument(applyResult(receipt, resultingState), { verbose: true })))
      .toEqual([]);
  });

  test("focused verbose verification failure prints the command while ordinary verbose only points to it (#353)", () => {
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
    expect(commandTexts(focused).filter((text) => text.includes("rm -r --cached")))
      .toHaveLength(1);
    expect(commandTexts(focused)).toContain(untrackCommandFor("/project-b", paths));

    const ordinary = flattenPresentationNodes(
      applyVerificationFailureDocument(receipt, message, { verbose: true }),
    );
    expect(inlineCommandTexts(ordinary)).toContain(
      "apkit apply --blockers-only --verbose",
    );
    expect(commandTexts(applyVerificationFailureDocument(receipt, message, { verbose: true })))
      .toEqual([]);
  });

  test("large tracked-path sets render lossless groups and one complete command (#353)", () => {
    const paths = [
      ...Array.from({ length: 60 }, (_, index) => `.agents/skills/s${String(index).padStart(3, "0")}`),
      ...Array.from({ length: 60 }, (_, index) => `.codex/prompts/p${String(index).padStart(3, "0")}`),
      ...Array.from({ length: 30 }, (_, index) => `.opencode/agent/o${String(index).padStart(3, "0")}.md`),
    ];
    const concise = lifecycleStatusDocument(ownershipReport(paths));
    expect(trackedPathLines(concise)).toEqual([
      "      - .agents/skills/ (60 paths)",
      "      - .codex/prompts/ (60 paths)",
      "      - .opencode/agent/ (30 paths)",
    ]);

    const focusedVerbose = lifecycleStatusDocument(ownershipReport(paths), {
      blockersOnly: true,
      verbose: true,
    });
    const gitCommands = commandTexts(focusedVerbose).filter((text) =>
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

  test("machine JSON evidence stays byte-identical without any command text (#353)", () => {
    const paths = [".codex/hooks.json", ".agents/skills/s01.md"];
    const report = ownershipReport(paths);

    const json = formatLifecycleJson("status", report);
    expect(json).not.toContain("rm -r --cached");
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

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const projectsIndex = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Projects:");
    expect(projectsIndex).toBeGreaterThan(-1);
    // The identity is a typed identifier part carrying the cwd alias.
    expect(nodes[projectsIndex + 1]).toEqual({
      kind: "prose",
      parts: [{ kind: "identifier", value: "." }, ": addition"],
    });
    expect(presentationTexts(verbose).some((text) => text.includes(project))).toBe(false);
  });

  test("identifies an ancestor project relative to the working directory", () => {
    const project = dirname(process.cwd());
    const report = identityReport(project);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const projectsIndex = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Projects:");
    expect(projectsIndex).toBeGreaterThan(-1);
    expect(nodes[projectsIndex + 1]).toEqual({
      kind: "prose",
      parts: [{ kind: "identifier", value: ".." }, ": addition"],
    });
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
    expect(verboseTexts.some((text) => text.startsWith(".: "))).toBe(false);
    expect(verboseTexts.some((text) => text.startsWith(".: Profile"))).toBe(false);
    // The concise Project key-value never presents a bare cwd alias.
    expect(keyValuesIn(concise, "Project").map((node) => node.value)).not.toContain({
      kind: "prose",
      parts: [{ kind: "identifier", value: "." }, ": "],
    });
    expect(presentationTexts(concise).some((text) => text.startsWith(".: "))).toBe(false);
  });

  test("identifies another home project with a home-relative path", () => {
    const project = join(homedir(), "another-project");
    const report = identityReport(project);

    const verbose = lifecycleStatusDocument(report, { verbose: true });
    const nodes = flattenPresentationNodes(verbose);
    const projectsIndex = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Projects:");
    expect(projectsIndex).toBeGreaterThan(-1);
    expect(nodes[projectsIndex + 1]).toEqual({
      kind: "prose",
      parts: [{ kind: "identifier", value: "~/another-project" }, ": addition"],
    });
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
      node.kind === "prose" && nodeText(node) === "  + 1 generated file addition in ~/receipt-project"
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
    expect(nodes.slice(projects, projects + 3).some((node) =>
      node.kind === "prose" && nodeText(node) === "~/receipt-project: addition"
    )).toBe(true);
    expect(nodes.some((node) =>
      node.kind === "prose" && nodeText(node) === "~/receipt-project/a.md: addition"
    )).toBe(true);
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
      node.kind === "prose" && nodeText(node) === "  + 1 generated file addition in 1 project"
    )).toBe(true);
    expect(conciseNodes.some((node) =>
      node.kind === "prose" && nodeText(node) === "All Projects were already current."
    )).toBe(false);
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
    const projectIndex = indexWhere(nodes, (node) =>
      node.kind === "prose" && nodeText(node) === "~/multi-host-project: Profile coding");
    expect(projectIndex).toBeGreaterThan(-1);
    expect(nodes[projectIndex + 1]).toEqual({
      kind: "prose",
      parts: ["  Hosts: claude, codex"],
    });
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
    expect(stateLines).toContain("~/team-a/project: addition");
    expect(stateLines).toContain("~/team-b/project: addition");
  });

  test("keeps an outside-home project absolute", () => {
    const project = "/var/tmp/outside-home-project";
    const report = identityReport(project);

    expect(projectStateLines(lifecycleStatusDocument(report, { verbose: true }))).toContain(
      `${project}: addition`,
    );
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
    expect(stateLines).toContain(`${authoredProject}: addition`);
    expect(stateLines).not.toContain(`${canonicalProject}: addition`);
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
    expect(stateLines).toContain(`${authoredProject}: addition`);
    expect(stateLines).not.toContain(`${canonicalProject}: addition`);
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

    expect(presentationTexts(concise).some((text) =>
      text.includes("1 file update in ~/aliased-project")
    )).toBe(true);
    expect(presentationTexts(verbose).some((text) =>
      text.includes("(~/aliased-project, /var/tmp/other-project)")
    )).toBe(true);
    expect(presentationTexts(blockedConcise).some((text) =>
      text.includes("Scope: Project ~/aliased-project")
    )).toBe(true);
    for (const document of [concise, verbose, blockedConcise]) {
      expect(presentationTexts(document).some((text) =>
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
    expect(verboseTexts).toContain("/tmp/reconcile/Profile Installation/generated-output: Profile reconcile");
    expect(verboseTexts).toContain("  Outputs: generated-output/reconcile");
    expect(verboseTexts).toContain("/tmp/reconcile/Repository Exclusion/info/exclude: add /generated-output/reconcile");
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

    // The ready summary is a success notice; the drift is a Project exception
    // with its typed State key-value and the destructive removal as a list item.
    expect(noticesIn(concise)).toHaveLength(1);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    const nodes = flattenPresentationNodes(concise);
    const exceptionIndex = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Project exceptions:");
    expect(exceptionIndex).toBeGreaterThan(-1);
    expect(nodes[exceptionIndex + 1]).toEqual({ kind: "prose", parts: ["  /project-a:"] });
    expect(nodes[exceptionIndex + 2]).toEqual({
      kind: "prose",
      parts: ["    State: drifted output (f.md)"],
    });
    expect(nodes[exceptionIndex + 3]).toEqual({ kind: "prose", parts: ["    - e.md"] });
    // The verbose route is a typed command value on the Details key-value.
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
    expect(headingsIn(concise)).not.toContain("Selected setup:");
    expect(headingsIn(concise)).not.toContain("Outputs:");
  });

  test("destructive removal remains visible while routine paths stay suppressed", () => {
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

    // The destructive removal is a Project-exception line; routine paths stay suppressed.
    expect(presentationTexts(concise)).toContain("    - z.md");
    expect(presentationTexts(concise).some((text) =>
      text.includes("m.md") || text.includes("a.md")
    )).toBe(false);
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

  test("keeps attention paths and removals visible ahead of ordinary capped changes", () => {
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

    expect(presentationTexts(concise)).toContain("    - z-removal.md");
    expect(presentationTexts(concise).some((text) => text.includes("a-1.md"))).toBe(false);
    expect(presentationTexts(concise).some((text) => text.includes("more files"))).toBe(false);
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--verbose" }],
    });
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
    expect(presentationTexts(concise)).toContain("    State: drifted output (skill)");

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
      const conciseTexts = presentationTexts(concise);
      expect(headingsIn(concise)).not.toContain("State explanations:");
      if (kind === "blocked") {
        expect(flattenPresentationNodes(concise).some((node) =>
          node.kind === "prose" && node.category === "error" &&
          nodeText(node).startsWith(
            "  Blocker: Cannot verify generated-file ownership: recorded output hooks disabled does not match",
          )
        )).toBe(true);
        expect(conciseTexts.some((text) => text.startsWith("    State:"))).toBe(false);
      } else if (["drifted output", "malformed ownership state", "missing output", "stale source"].includes(kind)) {
        expect(conciseTexts).toContain(`    State: ${kind}`);
      } else {
        expect(noticesIn(concise)[0]!.nodes[0]).toMatchObject({
          kind: "prose",
        });
        expect(noticesIn(concise)[0]).toMatchObject({ severity: "success" });
        expect(nodeText(noticesIn(concise)[0]!.nodes[0] as PresentationNode)).toMatch(
          /^Updates ready for 1 project/,
        );
        expect(conciseTexts.some((text) => text.startsWith("    State:"))).toBe(false);
      }
      const glosses = explanationItems(lifecycleStatusDocument(report, { verbose: true }));
      expect(glosses).toHaveLength(1);
      expect(glosses[0]).toMatch(new RegExp(`^${kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .+`));
      expect(glosses[0]!.length).toBeGreaterThan(`${kind}: `.length);
      expect(glosses[0]).toContain(STATE_ANCHORS[kind]);
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
    expect(presentationTexts(allCurrent).some((text) => text.startsWith("    State:"))).toBe(false);
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
    expect(explanationItems(verbose)).toEqual([
      "stale source: Workspace source changed since the last apply; generated files no longer match current selected setup.",
    ]);
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
    expect(conciseNodes.some((node) =>
      node.kind === "key-value" && node.key === "Project" &&
      (node.value as { readonly canonicalPath?: string }).canonicalPath === "/project-a"
    )).toBe(false);
    const projectB = conciseNodes.find((node) =>
      node.kind === "key-value" && node.key === "Project" &&
      (node.value as { readonly canonicalPath?: string }).canonicalPath === "/project-b");
    expect(projectB).toBeDefined();
    // The binding Profile and Hosts carry their values as typed nodes, and the
    // Blocker evidence follows as an error-category prose node.
    expect(keyValuesIn(concise, "  Profile")[0]!.value).toEqual({
      kind: "identifier",
      value: "coding",
    });
    expect(keyValuesIn(concise, "  Hosts")[0]!.value).toEqual({
      kind: "identifier",
      value: "codex",
    });
    expect(flattenPresentationNodes(concise).some((node) =>
      node.kind === "prose" && node.category === "error" &&
      nodeText(node).startsWith(
        "  Blocker: Cannot verify generated-file ownership: recorded output hooks disabled does not match",
      )
    )).toBe(true);
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
      expect(nodes.slice(blockersHeading, projectsHeading).some((node) =>
        node.kind === "list-item" &&
        nodeText(node).includes("Cannot verify generated-file ownership: recorded output hooks disabled does not match"))
      ).toBe(true);
      expect(nodes.some((node) =>
        node.kind === "prose" && nodeText(node) === "  Scope: Project /project-b"
      )).toBe(true);
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
    expect(projectStateLines(verbose)).toContain("/orphan: removal");
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
      node.kind === "list-item" && nodeText(node).startsWith(`${target}: `));
    expect(nodeText(exclusionLine!)).toBe(
      `${target}: add /.agent-profile-kit/codex/context.md, /.codex/hooks.json; remove /.old-path.md`,
    );
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

    expect(conciseTexts.some((text) =>
      text.startsWith(
        "  Blocker: Cannot verify generated-file ownership: recorded output occupied output does not match",
      )
    )).toBe(true);
    expect(conciseTexts).toContain("Git exclusions: 1 entry to add.");
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
    for (const section of ["Projects:", "Outputs:", "Git exclusions:", "Selected setup:", "Warnings:", "Blockers:", "State explanations:"]) {
      expect(sectionAt(section)).toBeGreaterThan(-1);
    }
    expect(projectStateLines(verbose)).toContain("/project-a: stale source");
    const outputLine = (path: string, kind: string) => nodes.some((node) =>
      node.kind === "prose" &&
      JSON.stringify(node.parts) === JSON.stringify([
        { kind: "identifier", value: path },
        `: ${kind}`,
      ]));
    expect(outputLine("/project-a/.agent-profile-kit/codex/context.md", "update")).toBe(true);
    expect(outputLine("/project-a/.codex/hooks.json", "unchanged")).toBe(true);
    const exclusionLine = nodes.find((node) =>
      node.kind === "list-item" && nodeText(node).startsWith("/project-a/.git/info/exclude: "));
    expect(nodeText(exclusionLine!)).toBe(
      "/project-a/.git/info/exclude: add /.agent-profile-kit/codex/context.md",
    );
    expect(texts).toContain("/project-a: Profile coding");
    expect(texts).toContain("  Hosts: claude, codex");
    expect(texts).toContain("  Resolved artifacts:");
    expect(texts).toContain("    - context:team-rules (coding: selected by profile)");
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
    expect(nodes.some((node) =>
      node.kind === "list-item" &&
      nodeText(node).startsWith(
        "Cannot verify generated-file ownership: recorded output example blocker does not match",
      )
    )).toBe(true);
    expect(texts).toContain("  Scope: Project /project-a");
    expect(texts.some((text) => text.includes("generated-output"))).toBe(false);
    expect(texts.some((text) =>
      text.includes("Git-local exclusions that keep Installer-owned generated paths untracked")
    )).toBe(false);
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
    expect(statusTexts).toContain("Git exclusions: 1 entry to add.");
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
    expect(pendingNodes.some((node) =>
      node.kind === "list-item" &&
      nodeText(node) === "/repo/.git/info/exclude: add /.agent-profile-kit/codex/context.md"
    )).toBe(true);
    expect(pendingNodes.some((node) =>
      node.kind === "list-item" &&
      nodeText(node).includes("remove /.agent-profile-kit/codex/context.md")
    )).toBe(false);

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
    expect(nodes.slice(applied).some((node) =>
      node.kind === "list-item" &&
      nodeText(node) === "/repo/.git/info/exclude: add /.agent-profile-kit/codex/context.md")
    ).toBe(true);
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
    expect(listItemsFrom(nodes, sections[0]! + 1)).toEqual([
      expect.stringContaining("stale source: Workspace source changed"),
      expect.stringContaining("drifted output: An owned generated file differs from its recorded installation"),
    ]);
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
      node.kind === "prose" && nodeText(node) === "  ~ 1 generated file update in /changed"
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
    expect(flattenPresentationNodes(concise).some((node) =>
      node.kind === "notice" && node.severity === "error" &&
      (node.nodes ?? []).some((child) => child.kind === "prose" && nodeText(child).includes("Pending: blocked"))
    )).toBe(true);
    expect(listItemsIn(concise)).toEqual(expect.arrayContaining([
      expect.stringContaining("/project-a: Resolve the reported blocker"),
    ]));
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

    expect(concise.some((node) => node.kind === "prose" && nodeText(node) === "Freshly current: /applied")).toBe(true);
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
      }, { all: true });
      const nodes = flattenPresentationNodes(document);

      // Failure header, Failed Project, and Still pending prose carry the
      // authored home-relative aliases; canonical spellings stay out.
      expect(noticesIn(document)[0]).toMatchObject({ kind: "notice", severity: "error" });
      expect(nodes.some((node) => node.kind === "prose" && nodeText(node) === "Failed Project: ~/failed-alias")).toBe(true);
      expect(nodes.some((node) => node.kind === "prose" && nodeText(node) === "Still pending: ~/pending-alias")).toBe(true);
      expect(nodes.some((node) => "text" in node && nodeText(node).includes(failedCanonical))).toBe(false);
      expect(nodes.some((node) => "text" in node && nodeText(node).includes(pendingCanonical))).toBe(false);
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
    expect(nodes.slice(applied).some((node) => node.kind === "prose" && nodeText(node) === "  + a.md")).toBe(true);
    expect(noticesIn(concise).some((notice) =>
      notice.nodes.some((child) => child.kind === "prose" && nodeText(child) === "Apply complete")
    )).toBe(false);
  });
});

/** The next-action bullets of a lifecycle document, asserted as structure. */
/** The complete next-action guidance of a lifecycle view: the typed "Next"
 * key-value's command invocation when the view carries one, otherwise the
 * list items under the "Next:" heading. */
function nextGuidance(document: PresentationDocument): string[] {
  const next = keyValuesIn(document, "Next")[0];
  if (next !== undefined && next.value.kind === "command") {
    const command = next.value;
    return [
      [command.program,
        ...command.args.map((arg) => arg.kind === "text" ? arg.value : "")]
        .filter((part) => part !== "").join(" "),
    ];
  }
  return documentNextActions(document);
}

function documentNextActions(document: PresentationDocument): string[] {
  const nodes = flattenPresentationNodes(document);
  const headingIndex = nodes.findIndex((node) => node.kind === "heading" && nodeText(node) === "Next:");
  if (headingIndex < 0) return [];
  return nodes.slice(headingIndex + 1)
    .flatMap((node) => node.kind === "list-item" ? [nodeText(node)] : []);
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
    const next = nextGuidance(concise);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/apply/i);
    expect(next[0]).not.toMatch(/status|bind/i);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    // The drift detail stays behind the verbose route; no routine path appears.
    expect(presentationTexts(concise).some((text) =>
      text.startsWith("    State: stale source") || text.includes("a.md")
    )).toBe(false);
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
    const next = nextGuidance(concise);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/apkit apply/);
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
    const statusNext = nextGuidance(status);
    expect(statusNext).toHaveLength(1);
    expect(statusNext[0]).toMatch(/resolve/i);
    expect(statusNext[0]).toMatch(/blocker/i);
    expect(statusNext[0]).toMatch(/apkit status/);
    expect(statusNext[0]).not.toMatch(/apply/i);
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

    const next = documentNextActions(applyReportDocument(applyResult(report)));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/resolve/i);
    expect(next[0]).toMatch(/blocker/i);
    expect(next[0]).toMatch(/apkit apply/);
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

  test("fully current status states that fact once", () => {
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

    const status = lifecycleStatusDocument(current);

    expect(renderBoundary(status)).toBe("All Projects are current (1 Project)\n");
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
    expect(presentationTexts(status).some((text) =>
      text.includes("Host attention required")
    )).toBe(false);
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
    expect(documentNextActions(applyReportDocument(applyResult(current)))).toEqual([]);

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
    expect(documentNextActions(applyReportDocument(applyResult(appliedWithChanges)))).toEqual([]);

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
    const conciseNodes = flattenPresentationNodes(
      applyReportDocument(applyResult(metadataOnlyReceipt, metadataOnlyResult)),
    );
    expect(conciseNodes.some((node) =>
      nodeText(node).includes("no changes were applied") ||
        nodeText(node) === "All Projects were already current."
    )).toBe(false);
    expect(flattenPresentationNodes(
      applyReportDocument(applyResult(metadataOnlyReceipt, metadataOnlyResult), { verbose: true }),
    ).some((node) => nodeText(node).includes(": update"))).toBe(true);
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

    expect(documentNextActions(status)).toEqual([
      "/project-a: After all blockers are resolved, run apkit apply --all.",
      "/project-b: Resolve the reported blocker, then run apkit status again.",
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

    expect(documentNextActions(status)).toEqual([
      "Resolve the reported global blocker, then run apkit status again.",
    ]);
    expect(presentationTexts(status)).not.toContain("Ready to apply.");
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
    expect(nextGuidance(mixedStatus)).toEqual(["apkit apply --all"]);
    // The Details key-value carries the typed fleet-verbose command.
    expect(keyValuesIn(mixedStatus, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [{ kind: "text", value: "status" }, { kind: "text", value: "--all" }, { kind: "text", value: "--verbose" }],
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

    const next = nextGuidance(lifecycleStatusDocument(report));
    expect(next).toEqual([
      "Resolve the reported blocker, then run apkit status again.",
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
        message: "Cannot verify generated-file ownership: recorded output CLI missing does not " +
          "match the recorded installation and no other recorded root proves ownership " +
          "continuity; restore the recorded output or remove the generated files, then retry",
        problem: "Cannot verify generated-file ownership: recorded output CLI missing does not " +
          "match the recorded installation and no other recorded root proves ownership " +
          "continuity; restore the recorded output or remove the generated files, then retry",
        project,
        remedy: "Remove the conflicting generated files yourself after verifying the paths, then retry",
        requirement:
          "Agent Profile Kit syncs or removes only files whose ownership is proven by the " +
          "active installation record at safe paths",
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

    expect(keyValuesIn(document, "Workspace")[0]!.value).toEqual({
      kind: "prose",
      parts: ["Not configured"],
    });
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

    expect(keyValuesIn(document, "Workspace")[0]!.value).toEqual({
      kind: "prose",
      parts: [
        "Legacy configuration; run ",
        { kind: "command", program: "apkit", args: [{ kind: "text", value: "init" }] },
        " (selected: ~/.agents/agent-profile-kit/workspace)",
      ],
    });
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
      expect(lines).toContain(`  apkit list ${topic.name}`);
      expect(lines).toContain(`    ${topic.description}`);
    }

    const machine = machineInventoryIndexDocument();
    expect(machine.map(shape)).toEqual([
      "heading",
      ...MACHINE_INVENTORY_TOPICS.flatMap(() => ["prose:command", "prose"]),
    ]);
  });

  test("project inventory presents each Project as typed path, Profile, and Hosts fields", () => {
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
      "key-value(Project)",
      "key-value(Profile):path",
      "key-value(Hosts)",
      "prose:attention",
      "blank",
      "prose",
    ]);
    const projectField = keyValuesIn(document, "Project")[0]!;
    expect(projectField.value).toEqual({
      kind: "path",
      canonicalPath: project,
      authoredPath: project,
      scope: "fleet",
    });
    const problem = flattenPresentationNodes(document).find((node) =>
      node.kind === "prose" && nodeText(node).startsWith("  Problem: ")
    ) as Extract<PresentationNode, { kind: "prose" }>;
    expect(nodeText(problem)).toBe(
      "  Problem: Configured project root does not exist on this machine and cannot be reconciled.",
    );
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
    const fields = keyValuesIn(document, "Project").map((node) => node.value);
    for (const project of [".", "..", "../alpha"]) {
      expect(fields).toContainEqual({
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
    expect((document[0] as Extract<PresentationNode, { kind: "notice" }>).nodes[0]).toEqual({
      kind: "prose",
      parts: ["No Profiles are available."],
    });
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
    expect(hostLines).toEqual(["  codex", "  claude", "", "Use <host> with apkit bind to select it for a configured Project."].filter((line) => line !== ""));
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
      "key-value(Profiles found)",
      "key-value(Hosts bound)",
      "prose:attention",
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
    expect(keyValuesIn(document, "Profiles found")[0]!.value).toEqual({
      kind: "prose",
      parts: ["none"],
    });
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
    expect(rendered.split("\n")).toEqual([
      "Workspace and settings valid",
      "  (0 Profiles, 0 configured Projects)",
      "Profiles found: none",
      "Hosts bound: none",
      "Next: apkit bind <profile> --host <host>",
    ]);
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

    const prose = flattenPresentationNodes(document)
      .filter((node) => node.kind === "prose")
      .map((node) => nodeText(node));
    expect(prose.filter((line) => line === "  Cleaned Git exclusions:")).toHaveLength(1);
    expect(prose).toContain("  - /.claude/rules/agent-profile-kit.md (/project-a/.git/info/exclude)");
    expect(prose).toContain("  - /.codex/hooks.json (/project-a/.git/info/exclude)");
    expect(prose).toContain("  - /.claude/rules/agent-profile-kit.md (/shared/.git/info/exclude)");
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
      node.kind === "prose" && nodeText(node).startsWith("  - Cannot remove Project at ")
    ) as Extract<PresentationNode, { kind: "prose" }>;
    expect(keptReason.category).toBe("error");
  });

  test("uninstall presents warnings as a titled list of typed list items", () => {
    const document = uninstallResultDocument({
      kept: [],
      projects: [],
      warnings: [
        "/project-a/.git/info/exclude changed during exclusion publication; skipping to preserve unrelated bytes",
      ],
    });

    const items = flattenPresentationNodes(document).filter((node) => node.kind === "list-item");
    expect(items).toHaveLength(1);
    expect(document.map(shape)).toContain("prose:attention");
    expect(flattenPresentationNodes(document).some((node) =>
      node.kind === "prose" && nodeText(node) === "  Cleaned Git exclusions:"
    )).toBe(false);
  });

  test("an uninstall with nothing installed is a single success notice", () => {
    const document = uninstallResultDocument({ projects: [], kept: [], warnings: [] });
    expect(document.map(shape)).toEqual(["notice:success", "blank", "prose"]);
    expect((document[0] as Extract<PresentationNode, { kind: "notice" }>).nodes[0]).toEqual({
      kind: "prose",
      parts: ["No ordinary Agent Profile Kit-owned output is installed."],
    });
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
      "key-value(Profile):path",
      "key-value(Host):path",
      "key-value(Project)",
      "key-value(Temporary installation):path",
      "prose:attention",
      "list-item",
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
          affectedItems: [],
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
      expect(nodeText(prose[0]!)).toBe(
        "apkit: ~/projects/alpha already has an ordinary Profile Installation; remove it before installing a temporary Profile",
      );
      expect(prose[0]!.category).toBe("error");
      expect(nodeText(prose[2]!)).toContain(
        "Cannot remove temporary Profile: owned output .codex/hooks.json is a symlink",
      );
      expect(nodeText(prose[3]!).startsWith("Remedy: ")).toBe(true);
      expect(JSON.stringify(document)).not.toContain(canonical);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("only the first blocked-message line carries the diagnostic prefix", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const canonical = join(home, "projects", "alpha");
      const blockers = [
        normalizeBlocker({
          affectedItems: [],
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
        })),
      ];

      const { document } = temporaryBlockedMessagesDocument(
        blockers,
        canonical,
        "~/projects/alpha",
        process.cwd(),
        home,
      );

      // Exact multi-Blocker line sequence: prefixed problem, remedy, then
      // unprefixed problem and remedy for every further Blocker.
      const lines = flattenPresentationNodes(document)
        .filter((node) => node.kind === "prose")
        .map((node) => nodeText(node));
      expect(lines).toHaveLength(4);
      expect(lines[0]!.startsWith("apkit: ")).toBe(true);
      expect(lines[1]!.startsWith("Remedy: ")).toBe(true);
      expect(lines[2]!.startsWith("apkit: ")).toBe(false);
      expect(lines[3]!.startsWith("Remedy: ")).toBe(true);
      // The rendered diagnostic carries the prefix exactly once.
      expect(lines.filter((line) => (line ?? "").includes("apkit:"))).toHaveLength(1);
      expect(lines[0]!.startsWith(`apkit: ~/projects/alpha`)).toBe(true);
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
          affectedItems: [],
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
      expect(nodeText(prose[0]!)).toBe(
        "apkit: ~/projects/alpha already has an ordinary Profile Installation; remove it before installing a temporary Profile",
      );
      expect(JSON.stringify(document)).not.toContain(canonical);
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
          affectedItems: [],
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
      expect(nodeText(prose[0]!)).toBe(
        "apkit: ~/real-project cannot be resolved: the authored spelling differs from ~/real-project",
      );
      expect(JSON.stringify(document)).not.toContain(canonical);
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
    expect(nextGuidance(concise)).toEqual(["apkit apply --all"]);
    expect(keyValuesIn(concise, "Details")[0]!.value).toEqual({
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "status" },
        { kind: "text", value: "--all" },
        { kind: "text", value: "--verbose" },
      ],
    });
    const conciseTexts = presentationTexts(concise);
    expect(conciseTexts.some((text) => text.includes("Skill review-pr"))).toBe(false);
    expect(conciseTexts.some((text) => text.includes("Workspace changes:"))).toBe(false);
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

    // The operation summary notice leads; each operation is one prose line
    // naming its affected Projects.
    const nodes = flattenPresentationNodes(concise);
    expect(noticesIn(concise)[0]).toMatchObject({ kind: "notice", severity: "success" });
    // flattenPresentationNodes expands the notice's child: the three
    // operation lines follow as consecutive prose nodes.
    expect(nodes.slice(2, 5).map((node) => node.kind)).toEqual(["prose", "prose", "prose"]);
    expect(nodeText(nodes[2]!)).toBe("+ 1 file addition in /project-a");
    expect(nodeText(nodes[3]!)).toBe("~ 3 file updates in /project-a, /project-b");
    expect(nodeText(nodes[4]!)).toBe("- 1 file removal in /project-c");
    expect(presentationTexts(concise).some((text) => text.includes("Projects: 3"))).toBe(false);
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

    const concise = lifecycleStatusDocument(report, { project: "/project-a" });

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
    expect(presentationTexts(concise).some((text) =>
      text.includes(SKILL_PATH) || text.includes("Git exclusion") || text.includes(".git/info/exclude")
    )).toBe(false);
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
      node.kind === "prose" && node.category === "error" &&
      nodeText(node).startsWith("  Blocker: ")
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
      node.kind === "prose" && nodeText(node) === "  ~ 3 generated file updates in 3 projects"
    )).toBe(true);
    expect(nodes.slice(applied).some((node) =>
      node.kind === "key-value" && node.key === "  State"
    )).toBe(false);
    expect(nodes.slice(applied).some((node) =>
      "text" in node && nodeText(node).includes("Skill review-pr")
    )).toBe(false);
  });

  test("generated-root ownership attention remains visible as a Project exception", () => {
    const report = sharedSkillFleet({
      items: [
        { kind: "drifted output" as const, project: "/project-a", reason: SKILL_PATH },
        { kind: "update" as const, project: "/project-b" },
        { kind: "update" as const, project: "/project-c" },
      ],
    });

    const concise = lifecycleStatusDocument(report);
    const nodes = flattenPresentationNodes(concise);
    const exceptionsAt = indexWhere(nodes, (node) =>
      node.kind === "heading" && nodeText(node) === "Project exceptions:");
    expect(exceptionsAt).toBeGreaterThan(-1);
    expect(nodes[exceptionsAt + 1]).toEqual({ kind: "prose", parts: ["  /project-a:"] });
    expect(nodes[exceptionsAt + 2]).toEqual({
      kind: "prose",
      parts: [`    State: drifted output (${SKILL_PATH})`],
    });
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
  test("successful summaries omit zero-value blocker and pending clauses", () => {
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

    const status = lifecycleStatusDocument(report);
    expect(noticesIn(status)[0]).toMatchObject({ kind: "notice", severity: "success" });
    const statusTexts = presentationTexts(status);
    expect(statusTexts.some((text) =>
      /(^|\n)(Projects: 1|Blockers: 0|Changes: none)/.test(text)
    )).toBe(false);

    // Successful changed apply: success notice, receipt evidence, and no
    // zero-value blocker, pending, or change clauses.
    const applied = applyReportDocument(applyResult(report, emptyReport({
      desired: reportDesired(report),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    })));
    expect(noticesIn(applied)[0]).toMatchObject({ kind: "notice", severity: "success" });
    expect(flattenPresentationNodes(applied).some((node) =>
      "text" in node && /^(Blockers: 0|Pending: none|Changes: none)/.test(nodeText(node))
    )).toBe(false);
  });

  test("blocked summaries still show the blocker count", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project: "/project-a", reason: "hooks disabled" }],
      blockers: [fixtureBlocker("/project-a: hooks disabled", "/project-a")],
    });

    const status = lifecycleStatusDocument(report);
    expect(noticesIn(status)[0]).toMatchObject({ kind: "notice", severity: "error" });
    const statusTexts = presentationTexts(status);
    // The aggregate is an error notice carrying the displayed Blocker count.
    expect(statusTexts).toContain("Projects: 1 · Blockers: 1");
    expect(statusTexts.some((text) => text.includes("Blockers: 0"))).toBe(false);

    // Blocked apply: error outcome notice, blocker aggregate with the count,
    // and the Pending: blocked clause.
    const apply = blockedApplyReportDocument(asBlockedReport(report));
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "error" });
    const summaryNotices = noticesIn(apply).filter((notice) =>
      notice.nodes.some((child) => child.kind === "prose" && nodeText(child).includes("Blockers: 1"))
    );
    expect(summaryNotices.length).toBeGreaterThan(0);
    expect(summaryNotices.at(-1)).toMatchObject({ severity: "error" });
    expect(summaryNotices.at(-1)!.nodes.some((child) =>
      child.kind === "prose" && nodeText(child).includes("Pending: blocked")
    )).toBe(true);
  });

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
    expect(nextGuidance(status)).toEqual(["apkit apply --all"]);
    expect(keyValuesIn(status, "Next")).toHaveLength(1);
    expect(presentationTexts(status).some((text) =>
      text.includes("/project-a: apkit apply --all")
    )).toBe(false);
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

    const status = lifecycleStatusDocument(report, { project: "/project-a" });
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
    expect(documentNextActions(status)).toEqual([
      "/project-a: After all blockers are resolved, run apkit apply --all.",
      "/project-b: Resolve the reported blocker, then run apkit status again.",
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
    const nextItems = documentNextActions(status);
    expect(nextItems).toHaveLength(2);
    // The working-directory Project is a typed fleet-scope path part; the
    // renderer resolves it to the home-relative identity (never a cwd alias).
    const nodes = flattenPresentationNodes(status);
    expect(nodes.some((node) =>
      node.kind === "list-item" &&
      node.parts.some((part) => typeof part !== "string" && part.kind === "path" &&
        part.canonicalPath === current && part.scope === "fleet")
    )).toBe(true);
    expect(renderBoundary(status, defaultRenderContext)).toContain(
      `${homeRelative}: After all blockers are resolved, run apkit apply --all.`,
    );
    expect(renderBoundary(status, defaultRenderContext)).not.toContain(".: After all blockers");
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
    expect(nodes.slice(applied).some((node) =>
      node.kind === "prose" && nodeText(node) === "  + 1 generated file addition in 1 project"
    )).toBe(true);
    expect(nodes.some((node) =>
      node.kind === "prose" && nodeText(node) === "All Projects were already current."
    )).toBe(false);
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
    expect(flattenPresentationNodes(apply).some((node) =>
      node.kind === "prose" && nodeText(node) === "All Projects were already current."
    )).toBe(false);
    expect(keyValuesIn(apply, "Project")).toEqual([]);
    expect(keyValuesIn(apply, "  State")).toEqual([]);

    const verbose = flattenPresentationNodes(
      applyReportDocument(applyResult(receipt, resultingState), { verbose: true }),
    );
    expect(verbose.some((node) =>
      node.kind === "list-item" &&
      nodeText(node) === "/repo/.git/info/exclude: add /.agent-profile-kit/codex/context.md")
    ).toBe(true);
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
    expect(stateNodes[0]!.value).toMatchObject({ kind: "prose", parts: ["drifted output (a.md)"] });
    const applied = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Applied:");
    expect(applied).toBeGreaterThan(-1);
    expect(nodes.slice(applied).some((node) =>
      node.kind === "prose" && nodeText(node) === "  ~ 1 generated file update in 1 project"
    )).toBe(true);
    expect(nodes.slice(applied).some((node) => node.kind === "prose" && nodeText(node) === "  ~ a.md")).toBe(true);
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
      node.kind === "prose" && nodeText(node) === "  ~ 2 generated file updates in 2 projects"
    )).toBe(true);
    const projectNodes = keyValuesIn(apply, "Project");
    expect(projectNodes).toHaveLength(1);
    expect(projectNodes[0]!.value).toMatchObject({ kind: "path", canonicalPath: "/project-b" });
    const stateNodes = keyValuesIn(apply, "  State");
    expect(stateNodes).toHaveLength(1);
    expect(stateNodes[0]!.value).toMatchObject({ kind: "prose", parts: ["drifted output"] });
    expect(nodes.slice(applied).some((node) => node.kind === "prose" && nodeText(node) === "  ~ b.md")).toBe(true);
  });

  test("no-op status states current once", () => {
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
    });

    const status = lifecycleStatusDocument(report);
    expect(status.map(shape)).toEqual(["notice:success"]);
    const statusTexts = presentationTexts(status);
    expect(statusTexts.some((text) =>
      /Ready to apply|Blockers: 0|Changes: none|Projects: 1/.test(text)
    )).toBe(false);
  });

  test("no-op apply states current once without readiness", () => {
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
    });

    // No-op apply: exactly the success notice and the already-current
    // statement — no Applied section, no zero-value clauses, no setup.
    const document = applyReportDocument(applyResult(report));
    expect(document).toHaveLength(2);
    expect(noticesIn(document)).toHaveLength(1);
    expect(noticesIn(document)[0]).toMatchObject({ kind: "notice", severity: "success" });
    // The already-current statement is a bare prose node (no structured
    // numeric part exists for it); its wording lives in golden snapshots.
    expect(document[1]).toMatchObject({ kind: "prose" });
    expect(headingsIn(document)).toEqual([]);
    expect(listItemsIn(document)).toEqual([]);
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

    // The adapter warning joins the no-op view as a Warnings heading with a
    // single list item, still without an Applied section.
    const document = applyReportDocument(applyResult(report));
    expect(headingsIn(document)).toEqual(["Warnings:"]);
    expect(listItemsIn(document)).toEqual([
      "Project /project-a carries an adapter warning. (1 Project)",
    ]);
    expect(headingsIn(document)).not.toContain("Applied:");
  });

  test("blocked apply retains pending Git exclusions", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("Project is blocked", "/project-a")],
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
      repositoryExclusions: [{
        current: [],
        next: ["/.agent-profile-kit/codex/context.md"],
        target: "/project-a/.git/info/exclude",
        installed: false,
      }],
    });

    // Blocked apply keeps the pending exclusion clause as a summary line.
    const apply = blockedApplyReportDocument(asBlockedReport(report));
    expect(noticesIn(apply)[0]).toMatchObject({ kind: "notice", severity: "error" });
    expect(flattenPresentationNodes(apply).some((node) =>
      node.kind === "prose" && nodeText(node) === "Git exclusions: 1 entry to add."
    )).toBe(true);
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
    expect(nodes.slice(applied).some((node) =>
      node.kind === "prose" && nodeText(node) === "Git exclusions: 1 entry added."
    )).toBe(true);
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node) === "Freshly current: /project-a")).toBe(true);
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
    const readiness = nodes.filter((node): node is Extract<PresentationNode, { kind: "prose" }> =>
      node.kind === "prose" &&
      nodeText(node).endsWith("will load the next time you launch a configured Host from a bound Project root."));
    expect(readiness).toHaveLength(1);
    expect(nodes.at(-1)).toEqual(readiness[0]);
    expect(nodeText(readiness[0]!)).toBe(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
    expect(nodeText(readiness[0]!)).not.toContain("from /project-a");
    expect(nodeText(readiness[0]!)).not.toContain("from /project-b");
    expect(nodes.some((node) =>
      "text" in node && (nodeText(node).includes("becomes active") || nodeText(node).includes("bound Host"))
    )).toBe(false);
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
    const readiness = nodes.filter((node) =>
      node.kind === "prose" && nodeText(node).endsWith("bound Project root."));
    expect(readiness).toHaveLength(1);
    expect(nodes.at(-1)).toEqual(readiness[0]);
    expect(nodes.some((node) =>
      "text" in node && (nodeText(node).includes("becomes active") || nodeText(node).includes("bound Host"))
    )).toBe(false);
  });

  test("multiple changed Profiles emit count in readiness statement", () => {
    const receipt = emptyReport({
      desired: [
        {
          canonicalProject: "/project-a",
          context: "composed",
          hosts: ["codex"],
          outputs: [".codex/hooks.json"],
          profile: "backend",
          project: "/project-a",
          resolvedArtifacts: [],
          setupSteps: [],
        },
        {
          canonicalProject: "/project-b",
          context: "composed",
          hosts: ["claude"],
          outputs: [".claude/rules/agent-profile-kit.md"],
          profile: "frontend",
          project: "/project-b",
          resolvedArtifacts: [],
          setupSteps: [],
        },
      ],
      items: ["/project-a", "/project-b"].map((project) => ({
        kind: "addition" as const,
        project,
      })),
      outputs: [
        { kind: "addition" as const, path: ".codex/hooks.json", project: "/project-a" },
        { kind: "addition" as const, path: ".claude/rules/agent-profile-kit.md", project: "/project-b" },
      ],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: ["/project-a", "/project-b"].map((project) => ({
        kind: "current" as const,
        project,
      })),
    });

    // Two changed Profiles pluralize the single readiness statement.
    const concise = applyReportDocument(applyResult(receipt, resultingState));
    const nodes = flattenPresentationNodes(concise);
    const readiness = nodes.filter((node) =>
      node.kind === "prose" && nodeText(node).endsWith("bound Project root."));
    expect(readiness).toHaveLength(1);
    expect(nodes.at(-1)).toEqual({
      kind: "prose",
      parts: ["2 Profiles will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(nodes.some((node) => "text" in node && nodeText(node).includes(".."))).toBe(false);
    expect(nodes.at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(nodes.some((node) =>
      "text" in node &&
      (nodeText(node).includes("After completing the Host setup above") ||
        nodeText(node).includes("No further Host setup is required"))
    )).toBe(false);
    expect(nodes.at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(projectStateLines(verbose)).toContain("/project-a: addition");
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
    expect(keyValuesIn(zeroProjects, "Hosts bound")[0]!.value).toEqual({
      kind: "prose",
      parts: ["none"],
    });
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
    const warningHeading = flattenPresentationNodes(result).find((node) =>
      node.kind === "prose" && node.category === "attention" && nodeText(node) === "Warnings:"
    );
    expect(warningHeading).toBeDefined();
    expect(listItemsIn(result)).toContain(
      "/project-a/.git/info/exclude changed during exclusion publication; skipping to preserve unrelated bytes",
    );
    expect(presentationTexts(result).some((text) => text.includes("Cleaned Git exclusions"))).toBe(false);
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
    expect(missingProfile).toContain("Edit Local Configuration directly");
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
          affectedItems: [],
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
    expect(texts.some((text) =>
      text.startsWith(
        "  Blocker: Cannot verify generated-file ownership: owned output .codex/hooks.json has unsafe parent: /project-a/.codex",
      )
    )).toBe(true);
    expect(headingsIn(focused)).toContain("Global blockers:");
    expect(texts.some((text) =>
      text.includes("Blocker: installation record is unreadable")
    )).toBe(true);
    expect(documentNextActions(focused)).toEqual([
      "/project-a: Resolve the reported blocker, then run apkit status again.",
      "Resolve the reported global blocker, then run apkit status again.",
    ]);
    // Footer counts derive exclusively from the displayed Blockers.
    expect(texts).toContain("Blockers: 2 · Affected Projects: 1");
    // No unrelated lifecycle inventory: no warnings, paths, states, setup, or
    // exclusion sections, and no binding Profile detail.
    expect(headingsIn(focused).some((text) =>
      /Warnings:|Host Setup:|Git exclusions/.test(text)
    )).toBe(false);
    expect(texts.some((text) =>
      text.includes("duplicate Skill identity") || text.includes("drifted output") ||
      text.includes("Approve hook") || text.startsWith("    State:")
    )).toBe(false);
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
    // One shared resolution renders once.
    expect(documentNextActions(focused)).toEqual([
      "Resolve the reported blocker, then run apkit status again.",
    ]);
    expect(presentationTexts(focused)).toContain("Blockers: 2 · Affected Projects: 2");
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
    expect(texts.some((text) => text.includes("After all blockers are resolved"))).toBe(false);
    expect(texts).toContain("Blockers: 1 · Affected Projects: 1");
  });

  test("focused verbose view retains complete Blocker fields and affected items without unrelated sections", () => {
    const focused = lifecycleStatusDocument(blockedFleet(), { blockersOnly: true, verbose: true });
    const nodes = flattenPresentationNodes(focused);
    const texts = presentationTexts(focused);

    expect(nodes.some((node) =>
      node.kind === "list-item" && nodeText(node).startsWith(
        "Cannot verify generated-file ownership: owned output .codex/hooks.json has unsafe parent: /project-a/.codex",
      )
    )).toBe(true);
    expect(texts).toContain(
      "  Requirement: Agent Profile Kit syncs or removes only files whose ownership is " +
      "proven by the active installation record at safe paths",
    );
    expect(texts).toContain(
      "  Remedy: Remove the conflicting generated files yourself after verifying the paths, " +
      "then retry. Run apkit apply to retry.",
    );
    expect(texts).toContain("  Scope: Project /project-a");
    expect(texts).toContain("  Affected host: codex");
    expect(nodes.some((node) =>
      node.kind === "list-item" && nodeText(node) === "installation record is unreadable"
    )).toBe(true);
    expect(texts).toContain("  Scope: Global");
    expect(texts).toContain("Blockers: 2 · Affected Projects: 1");
    // No unrelated sections or next guidance.
    for (const section of ["Projects:", "Outputs:", "Selected setup:", "Warnings:", "Host Setup:"]) {
      expect(headingsIn(focused)).not.toContain(section);
    }
    expect(texts.some((text) => text.includes("Git exclusions"))).toBe(false);
    expect(nextGuidance(focused)).toEqual([]);
  });

  test("focused footer omits affected-Project count when only global Blockers are displayed", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("Installation State is unreadable")],
    });

    const concise = lifecycleStatusDocument(report, { blockersOnly: true });
    const verbose = lifecycleStatusDocument(report, { blockersOnly: true, verbose: true });

    expect(headingsIn(concise)).toContain("Global blockers:");
    expect(presentationTexts(concise)).toContain("Blockers: 1");
    expect(presentationTexts(concise).some((text) => text.includes("Affected Projects:"))).toBe(false);
    expect(presentationTexts(verbose)).toContain("Blockers: 1");
    expect(presentationTexts(verbose).some((text) => text.includes("Affected Projects:"))).toBe(false);
  });

  test("a scope with no Blockers reports that outcome without lifecycle inventory", () => {
    const concise = lifecycleStatusDocument(emptyReport(), { blockersOnly: true });
    const verbose = lifecycleStatusDocument(emptyReport(), { blockersOnly: true, verbose: true });

    expect(JSON.stringify(concise)).toBe(JSON.stringify(verbose));
    expect(concise[0]).toMatchObject({ kind: "prose", category: "success" });
    expect(concise[1]).toMatchObject({ kind: "prose", category: "command" });
    expect(inlineCommandTexts(concise)).toEqual(["apkit status"]);
    expect(presentationTexts(concise).some((text) => text.includes("Project"))).toBe(false);

    const fleet = lifecycleStatusDocument(emptyReport(), { all: true, blockersOnly: true });
    expect(inlineCommandTexts(fleet)).toEqual(["apkit status --all"]);
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
    const freshIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node) === "Freshly current: /project-a");
    const pendingIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node) === "Still pending: /project-c");
    const projectIndex = indexWhere(nodes, (node) => node.kind === "key-value" && node.key === "Project");
    const blockerIndex = indexWhere(nodes, (node) => node.kind === "prose" && node.category === "error" && nodeText(node).startsWith("  Blocker: "));
    const footerIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node).startsWith("Blockers: "));
    expect(appliedIndex).toBeGreaterThan(-1);
    expect(freshIndex).toBeGreaterThan(appliedIndex);
    expect(pendingIndex).toBeGreaterThan(freshIndex);
    expect(projectIndex).toBeGreaterThan(pendingIndex);
    expect(blockerIndex).toBeGreaterThan(projectIndex);
    expect(footerIndex).toBeGreaterThan(blockerIndex);
    // Receipt evidence rendered exactly once inside the prefix.
    expect(nodes.filter((node) => node.kind === "heading" && nodeText(node) === "Applied:")).toHaveLength(1);
    expect(nodes.slice(appliedIndex, pendingIndex).some((node) =>
      node.kind === "prose" && nodeText(node) === "  + 1 generated file addition in /project-a"
    )).toBe(true);
    // The strict Blocker filter suppresses ordinary inventory.
    expect(headingsIn(document)).not.toContain("Warnings:");
    expect(headingsIn(document)).not.toContain("Host Setup:");
    expect(headingsIn(document)).not.toContain("Next:");
    expect(nodes.some((node) => "text" in node && nodeText(node).includes("duplicate Skill identity"))).toBe(false);
    expect(nodes.some((node) => "text" in node && (nodeText(node).includes("b.md") || nodeText(node).includes("c.md")))).toBe(false);
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
    const freshIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node) === "Freshly current: /project-a");
    const pendingIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node) === "Still pending: /project-c");
    const blockersHeading = indexWhere(nodes, (node) => node.kind === "heading" && nodeText(node) === "Blockers:");
    const footerIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node).startsWith("Blockers: "));
    expect(appliedIndex).toBeGreaterThan(-1);
    expect(freshIndex).toBeGreaterThan(appliedIndex);
    expect(pendingIndex).toBeGreaterThan(freshIndex);
    expect(blockersHeading).toBeGreaterThan(pendingIndex);
    expect(footerIndex).toBeGreaterThan(blockersHeading);
    // The Blocker bullet keeps every affected item as typed evidence.
    expect(nodes.slice(blockersHeading, footerIndex).some((node) =>
      node.kind === "list-item" &&
      nodeText(node).startsWith("Cannot verify generated-file ownership: owned output .codex/hooks.json"))
    ).toBe(true);
    expect(nodes.slice(blockersHeading, footerIndex).some((node) =>
      node.kind === "prose" && nodeText(node) === "  Affected host: codex"
    )).toBe(true);
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
    expect(noticesIn(concise)).toEqual([
      { kind: "notice", severity: "error", nodes: [{ kind: "prose", parts: ["Apply blocked"] }] },
    ]);
    expect(headingsIn(concise)).toEqual(["Global blockers:"]);
    expect(keyValuesIn(concise, "Project")).toEqual([]);
    expect(flattenPresentationNodes(concise).some((node) =>
      node.kind === "prose" && nodeText(node).startsWith("  Blocker: installation record is unreadable")
    )).toBe(true);
    expect(flattenPresentationNodes(concise).filter((node) =>
      node.kind === "prose" && nodeText(node).startsWith("Blockers: ")
    )).toEqual([{
      kind: "prose",
      parts: ["Blockers: 1"],
      category: "error",
    }]);

    // Verbose: the Blocker bullet with its fields, then the footer.
    const verbose = blockedApplyReportDocument(report, { blockersOnly: true, verbose: true });
    expect(noticesIn(verbose)[0]).toMatchObject({ kind: "notice", severity: "error" });
    expect(headingsIn(verbose)).toEqual(["Blockers:"]);
    expect(listItemsIn(verbose)).toEqual(["installation record is unreadable"]);
    expect(flattenPresentationNodes(verbose).some((node) =>
      node.kind === "prose" && nodeText(node) === "  Scope: Global"
    )).toBe(true);
    expect(flattenPresentationNodes(verbose).some((node) =>
      node.kind === "prose" && nodeText(node).startsWith("Blockers: 1")
    )).toBe(true);
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
    const freshIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node) === "Freshly current: /project-a");
    const blockerIndex = indexWhere(nodes, (node) => node.kind === "prose" && node.category === "error" && nodeText(node).startsWith("  Blocker: "));
    expect(appliedIndex).toBeGreaterThan(-1);
    expect(freshIndex).toBeGreaterThan(appliedIndex);
    expect(blockerIndex).toBeGreaterThan(freshIndex);
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node) === "Failed Project: /project-b")).toBe(true);
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node) === "Still pending: /project-c")).toBe(true);
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
    const freshIndex = concise.findIndex((node) =>
      node.kind === "prose" && nodeText(node) === "Freshly current: /project-a");
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
      nodeText(node) === "  Blocker: Cannot verify generated-file ownership: owned output .codex/hooks.json has unsafe parent: /project-b/.codex");
    expect(blockerIndex).toBeGreaterThan(freshIndex + 2);
    expect(concise[blockerIndex - 1]).toMatchObject({
      kind: "path",
      canonicalPath: "/project-b",
    });

    const verbose = flattenPresentationNodes(
      applyExecutionFailureDocument(failure, { blockersOnly: true, verbose: true }),
    );
    const verboseFreshIndex = verbose.findIndex((node) =>
      node.kind === "prose" && nodeText(node) === "Freshly current: /project-a");
    expect(verboseFreshIndex).toBeGreaterThan(-1);
    expect(verbose[verboseFreshIndex + 1]).toMatchObject({ kind: "verbatim", text: "" });
    expect(verbose[verboseFreshIndex + 2]).toMatchObject({ kind: "heading", text: "Blockers:" });
    expect(verbose[verboseFreshIndex + 3]).toMatchObject({
      kind: "list-item",
      parts: ["Cannot verify generated-file ownership: owned output .codex/hooks.json has unsafe parent: /project-b/.codex"],
    });
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
      node.kind === "prose" && nodeText(node) === "  + 1 generated file addition in 1 project"
    )).toBe(true);
    expect(nodes.slice(appliedIndex).some((node) => node.kind === "prose" && nodeText(node) === "  + a.md (/project-a)")).toBe(true);
    expect(nodes.at(-1)).toEqual({
      kind: "prose",
      parts: ["Profile coding will load the next time you launch a configured Host from a bound Project root."],
    });
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
    expect(notices[0]).toEqual({
      kind: "notice",
      severity: "error",
      nodes: [{ kind: "prose", parts: ["Apply blocked"] }],
    });
    expect(notices.at(-1)).toMatchObject({
      kind: "notice",
      severity: "error",
      nodes: [{ kind: "prose", parts: ["Projects: 1 · Pending: blocked · Blockers: 1"] }],
    });
    const nodes = flattenPresentationNodes(document);
    expect(nodes.some((node) => node.kind === "key-value" && node.key === "Project")).toBe(true);
    expect(nodes.some((node) =>
      node.kind === "prose" && node.category === "error" && nodeText(node).startsWith("  Blocker: ")
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
    const freshlyCurrentIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node) === "Freshly current: /project-a");
    const projectIndex = indexWhere(nodes, (node) => node.kind === "key-value" && node.key === "Project");
    const blockerIndex = indexWhere(nodes, (node) => node.kind === "prose" && node.category === "error" && nodeText(node).startsWith("  Blocker: "));
    const footerIndex = indexWhere(nodes, (node) => node.kind === "prose" && nodeText(node).startsWith("Blockers: "));
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
    expect(noticesIn(document)).toEqual([
      {
        kind: "notice",
        severity: "error",
        nodes: [{ kind: "prose", parts: ["Apply failed at /project-a: write failed"] }],
      },
    ]);
    const nodes = flattenPresentationNodes(document);
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node) === "Failed Project: /project-a")).toBe(true);
    expect(nodes.some((node) => node.kind === "prose" && nodeText(node) === "Still pending: none")).toBe(true);
    expect(headingsIn(document)).toContain("Applied:");
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
    expect(headingsIn(concise)).toContain("Warnings:");
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
    expect(headingsIn(concise)).toContain("Warnings:");
    expect(listItemsIn(concise)).toContain("Codex SessionStart hooks are not enabled (1 Project)");
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
});



describe("blocker wording lives in presentation (DEC-020, US-026, US-027)", () => {
  const project = "/project-a";

  const kindFixtures: readonly {
    readonly label: string;
    readonly blocker: ReconciliationBlocker;
  }[] = [
    {
      blocker: normalizeBlocker({
        affectedItems: [{ kind: "path", value: "state/manifest.json" }],
        detail: "EACCES: permission denied, open 'state/manifest.json'",
        kind: "installation-state-unreadable",
        scope: "global",
      }),
      label: "installation-state-unreadable",
    },
    {
      blocker: normalizeBlocker({
        affectedItems: [{ kind: "path", value: ".codex/hooks.json" }],
        kind: "occupied-output",
        occupied: { case: "drifted-output" },
        project,
        scope: "project",
      }),
      label: "occupied-output",
    },
    {
      blocker: normalizeBlocker({
        action: "verify",
        affectedItems: [],
        failure: { case: "no-ownership-continuity", output: ".agent-profile-kit/codex/context.md" },
        kind: "installation-ownership",
        project,
        scope: "project",
      }),
      label: "installation-ownership",
    },
    {
      blocker: normalizeBlocker(outputOwnershipConflictBlocker({
        paths: [".codex/hooks.json"],
        project,
      })),
      label: "output-ownership-conflict",
    },
    {
      blocker: normalizeBlocker(temporaryInstallationConflictBlocker({
        project,
        temporaryInstallationId: "temp-123",
      })),
      label: "temporary-installation-conflict",
    },
    {
      blocker: normalizeBlocker(temporaryInstallationRemovalBlocker({
        failure: { case: "symlink-output", output: ".codex/hooks.json" },
        outputs: [".codex/hooks.json"],
        project,
      })),
      label: "temporary-installation-removal",
    },
  ];

  const blockedReport = (blocker: ReconciliationBlocker): ReconciliationReport => {
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

  test.each(kindFixtures.map((fixture) => [fixture.label, fixture.blocker] as const))(
    "%s renders human wording free of internal terms with a runnable remedy command",
    (_label, blocker) => {
      for (const options of [{ verbose: false }, { verbose: true }] as const) {
        const document = lifecycleStatusDocument(blockedReport(blocker), {
          blockersOnly: true,
          ...options,
        });
        for (const term of INTERNAL_ONLY_DEFAULT_TERMS) {
          expect(renderBoundary(document)).not.toMatch(term);
        }
      }

      const wording = humanBlockerWording(blocker);
      if (_label === "output-ownership-conflict") {
        // The typed recovery nodes carry the runnable untrack command.
        const focused = lifecycleStatusDocument(blockedReport(blocker), {
          blockersOnly: true,
        });
        expect(
          inlineCommandTexts(flattenPresentationNodes(focused))
            .includes("apkit status --blockers-only --verbose") ||
            commandTexts(focused).some((text) => text.startsWith("git -C "))
        ).toBe(true);
        return;
      }
      expect(flatInlineText(wording.remedy)).toMatch(/apkit [a-z-]+/);
    },
  );

  test.each(kindFixtures.map((fixture) => [fixture.label, fixture.blocker] as const))(
    "%s publishes the verbatim stored wording on the machine surface",
    (_label, blocker) => {
      const payload = JSON.parse(
        formatLifecycleJson("status", blockedReport(blocker)),
      ) as {
        readonly globalBlockers: readonly Record<string, string>[];
        readonly projects: readonly { readonly blockers: readonly Record<string, string>[] }[];
      };
      const published = [...payload.globalBlockers, ...payload.projects[0]!.blockers][0]!;
      const wording = blockerWording(blocker);
      expect(published.message).toBe(wording.message);
      expect(published.problem).toBe(wording.problem);
      expect(published.requirement).toBe(wording.requirement);
      expect(published.remedy).toBe(wording.remedy);
    },
  );

  test("occupied-output renders the adapter remedy key with its carried sentence", () => {
    const blocker = normalizeBlocker(occupiedOutputBlocker({
      occupied: { case: "occupied-destination", occupation: "directory" },
      path: ".opencode/opencode.json",
      project,
      remedyKey: "opencode-config-occupied",
    }));
    const wording = blockerWording(blocker);
    expect(wording.problem).toBe(".opencode/opencode.json is an occupied directory path");
    expect(wording.remedy).toBe(OPENCODE_CONFIG_OCCUPIED_REMEDY);
    expect(wording.remedy).toContain("opencode.json or .opencode/opencode.json");
  });
});

describe("authoring and teardown receipt documents (#390)", () => {
  const home = homedir();
  const projectPath = join(home, "projects", "demo");

  test("the created receipt presents a success headline and the next command", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: `/test/workspace`,
      workspaceScaffolded: true,
    });
    // Selective shape: kinds, categories, order, and atomic values — the
    // carried wording is locked by the golden snapshots.
    expect(shapes(document)).toEqual(["sentence(success)", "sentence(command)"]);
    expect(document[0]).toMatchObject({ kind: "sentence", category: "success" });
    expect(document[1]).toMatchObject({ kind: "sentence", category: "command" });
  });

  test("the created receipt without scaffolding points at validate", () => {
    const document = initReceiptDocument({
      outcome: "created",
      path: `/test/workspace`,
      workspaceScaffolded: false,
    });
    expect(shapes(document)).toEqual(["sentence(success)", "sentence(command)"]);
  });

  test("the migrated and unchanged receipts carry their severities and values", () => {
    const migrated = initReceiptDocument({
      outcome: "migrated",
      path: `/test/workspace`,
    });
    expect(shapes(migrated)).toEqual(["sentence(success)", "sentence(command)"]);
    const unchanged = initReceiptDocument({
      outcome: "unchanged",
      path: `/test/workspace`,
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
    // Every listed syntax line is one atomic command: it renders as one whole
    // line even at the narrowest measure.
    const syntaxLines = (document as PresentationNode[])
      .filter((node) => node.kind === "sentence" && node.category === "command")
      .map(renderedNodeLine);
    for (const command of defaultCommands()) {
      expect(syntaxLines).toContain(`  ${command.syntax}`);
    }
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

  test("the focused guide keeps its fenced examples as verbatim content", () => {
    const document = focusedGuideDocument("profile");
    const example = AUTHORING_EXAMPLES.profile;
    const contextExample = AUTHORING_EXAMPLES.context;
    expect(shapes(document)).toEqual([
      "heading",
      "spacer",
      "sentence",
      "spacer",
      "verbatim",
      "spacer",
      "verbatim",
      "spacer",
      "sentence(heading)",
    ]);
    // Example bodies are true verbatim content: reproduced exactly.
    expect(document[4]).toEqual({
      kind: "verbatim",
      text: `Create \`${example.path}\`:\n\n\`\`\`yaml\n${example.contents}\`\`\``,
    });
    expect(document[6]).toEqual({
      kind: "verbatim",
      text: `Create \`${contextExample.path}\`:\n\n\`\`\`md\n${contextExample.contents}\`\`\``,
    });
    // The carried next action renders whole, as the literal block it came from.
    expect(renderedNodeLine(document.at(-1) as PresentationNode))
      .toBe(TOPIC_GUIDES.profile.next);
  });

  test("the focused context and skill guides end at their next line without extra examples", () => {
    for (const topic of ["context", "skill"] as const) {
      const document = focusedGuideDocument(topic);
      const bodies = document.filter(
        (node): node is Extract<PresentationNode, { readonly kind: "verbatim" }> =>
          node.kind === "verbatim" && nodeText(node).length > 0,
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0]!.text.includes(AUTHORING_EXAMPLES[topic].path)).toBe(true);
      expect(shapes(document).at(-1)).toBe("sentence(heading)");
    }
  });

  test("a guide file body renders verbatim with one trailing newline restored by the writer", () => {
    const document = guideFileDocument("# Title\n\nBody line.\n");
    expect(shapes(document)).toEqual(["verbatim"]);
  });
});
