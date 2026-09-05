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
  formatApplyReport,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatLifecycleJson,
  formatLifecycleReport,
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

test("PROBE ownership", () => {
  const dump = (label: string, doc: unknown) => console.log(label, JSON.stringify(doc));
  const ownershipReport = (paths: readonly string[], project = "/project-a"): ReconciliationReport =>
    emptyReport({
      desired: [{
        canonicalProject: project, context: "composed", outputs: [...paths],
        profile: "coding", project, resolvedArtifacts: [],
      }],
      items: [{ kind: "blocked", project, reason: "tracked path" }],
      blockers: [normalizeBlocker(outputOwnershipConflictBlocker({ paths: [...paths], project }))],
    });
  const paths = [
    ".agents/skills/b/deep.md", ".agents/skills/a.md", ".agents/skills/c.md",
    ".codex/hooks.json", "AGENTS.md", "README.md",
  ];
  dump("D-OWN-CONCISE", lifecycleStatusDocument(ownershipReport(paths)));
  dump("D-OWN-VERBOSE", lifecycleStatusDocument(ownershipReport(paths), { verbose: true }));
  dump("D-OWN-FOCUSED-VERBOSE", lifecycleStatusDocument(ownershipReport(paths), { blockersOnly: true, verbose: true }));
});
