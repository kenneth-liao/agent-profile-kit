import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { HostSetupStep } from "../adapters/project-plan.js";
import {
  formatBlockedApplyReport,
  formatApplyReport,
  formatApplyVerificationFailure,
  formatApplyJson,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatHostInventoryHuman,
  formatInfoHuman,
  formatInventoryIndex,
  formatLifecycleJson,
  formatLifecycleReport,
  formatLifecycleToolErrorJson,
  formatProfileInventoryHuman,
  formatProjectInventoryHuman,
  formatTemporaryInstallationHuman,
  formatTemporaryInventoryHuman,
  formatUninstallResult,
  formatValidationResult,
  presentTemporaryBlockedMessages,
  type TemporaryInstallationReceiptView,
  displayPath,
  lifecycleExitCode,
  INTERNAL_ONLY_DEFAULT_TERMS,
  NON_CURRENT_STATE_ORDER,
} from "../cli/presentation.js";
import type { ApplicationInfo } from "../installer/info.js";
import {
  renderHumanOutput,
  type TerminalPresentationContext,
} from "../cli/terminal-presentation.js";
import {
  normalizeBlocker,
  outputOwnershipConflictBlocker,
  type ReconciliationBlocker,
} from "../installer/blockers.js";
import type {
  OutputConsumerEvidence,
  OutputReconciliationItem,
  ReconciliationItem,
  ReconciliationKind,
  ReconciliationProjectRecord,
  ReconciliationReport,
} from "../installer/reconcile.js";
import type {
  RepositoryExclusionChange,
  RepositoryExclusionRepair,
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
        kind: "installation-state-unreadable",
        problem: message,
        remedy: "Resolve the reported blocker, then retry",
        requirement: "Lifecycle commands cannot proceed while blocked",
        scope: "global",
      })
    : normalizeBlocker({
        affectedItems: [],
        kind: "occupied-output",
        problem: message
          .replaceAll(`${project}/`, "")
          .replaceAll(`${project}: `, "")
          .replaceAll(project, "this Project"),
        remedy: "Resolve the reported blocker, then retry",
        requirement: "Lifecycle commands cannot proceed while blocked",
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
  readonly repositoryExclusionRepairs: readonly RepositoryExclusionRepair[];
  readonly repositoryExclusions: readonly RepositoryExclusionChange[];
  readonly diagnosticValues: readonly string[];
  readonly warnings: readonly string[];
}

function emptyReport(overrides: Partial<FlatFixture> = {}): ReconciliationReport {
  const fixture: FlatFixture = {
    blockers: [],
    desired: [],
    items: [],
    outputConsumers: [],
    outputs: [],
    repositoryExclusionRepairs: [],
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
          )?.consumingHosts ?? [],
          kind: output.kind,
          path: output.path,
        })),
        blockers: fixture.blockers.filter((blocker) =>
          blocker.scope === "project" && canonicalProject(blocker.project) === key
        ),
        warnings: key === firstProject ? fixture.warnings.map((message) => ({
          copyableValues: fixture.diagnosticValues,
          message,
        })) : [],
        repositoryExclusionRepairs: key === firstProject ? fixture.repositoryExclusionRepairs : [],
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

function machineProject(
  project: string,
  overrides: Partial<ReconciliationProjectRecord> = {},
): ReconciliationProjectRecord {
  return {
    canonicalProject: project,
    project,
    state: { kind: "current" },
    outputs: [],
    blockers: [],
    warnings: [],
    setupSteps: [],
    repositoryExclusionRepairs: [],
    repositoryExclusions: [],
    ...overrides,
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
    repositoryExclusion: undefined,
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

  test("renders each setup action separately from its consequence", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [codexTrust()])],
      items: [{ kind: "addition", project: "/project-a" }],
    });

    const context: TerminalPresentationContext = {
      color: false,
      interactive: false,
      width: 80,
    };
    const status = formatLifecycleReport("status", report, { context });

    expect(status).toContain("Standing Host setup:");
    expect(status).toContain(
      "- Trust the bound project in Codex.\n" +
        "  Consequence: Profile Context does not load until the project is trusted.",
    );
  });

  test("deduplicates identical setup steps without collapsing distinct consequences", () => {
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

    const status = formatLifecycleReport("status", report);

    // The identical step renders once with compact Project scope; the distinct
    // consequence keeps its own bullet (US-048, US-049).
    expect(status.match(/- Trust the bound project in Codex\./g)).toHaveLength(2);
    expect(status).toContain("- Trust the bound project in Codex. (/project-a, /project-b)");
    expect(status.match(/Profile Context does not load until the project is trusted\./g)).toHaveLength(1);
    expect(status.match(/A different consequence remains visible\./g)).toHaveLength(1);
  });

  test("preview shows transition-triggered approval only when its output changes", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: hookPath, project: "/project-a" }],
    });
    const preview = formatLifecycleReport("preview", report);
    expect(preview).toContain(
      "Review and approve the generated SessionStart hook when Codex asks.",
    );

    // An unrelated change must not replay transition-triggered setup (US-046).
    const unrelated = emptyReport({
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "update", project: "/project-a" }],
      outputs: [{ kind: "update", path: "a.md", project: "/project-a" }],
    });
    const unrelatedPreview = formatLifecycleReport("preview", unrelated);
    expect(unrelatedPreview).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(unrelatedPreview).not.toContain("Host setup:");
  });

  test("preview never renders standing steps", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [hookApproval(), codexTrust(), rootLaunch(), sharedPath()])],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: hookPath, project: "/project-a" }],
    });
    const preview = formatLifecycleReport("preview", report);
    expect(preview).toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(preview).not.toContain("Trust the bound project in Codex.");
    expect(preview).not.toContain("Launch Codex from the exact bound project root:");
    expect(preview).not.toContain("Grok uses Claude's shared rule path.");
    expect(preview).not.toContain("Standing Host setup:");
    const verbose = formatLifecycleReport("preview", report, { verbose: true });
    expect(verbose).toContain("Trust the bound project in Codex.");
  });

  test("renders typed bound-project paths through the canonical path presenter", () => {
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

    const status = formatLifecycleReport("status", report);

    expect(status.split("\n").find((line) => line.startsWith("- Launch Codex from"))).toBe(
      "- Launch Codex from the exact bound project root: /project-a",
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

    const apply = formatApplyReport(applyResult(report, resultingState));

    expect(apply.split("\n")).toContain("Host setup:");
    expect(apply).toContain(
      "Review and approve the generated SessionStart hook when Codex asks.",
    );
    expect(apply).toContain("Declining the hook prevents Profile Context from loading.");
    expect(apply).toContain("Standing Host setup:");
    expect(apply).toContain("Trust the bound project in Codex.");
    expect(apply).toContain("Launch Codex from the exact bound project root: /project-a");
    expect(apply).toContain("Grok uses Claude's shared rule path.");
    expect(apply.trimEnd()).toEndWith(
      "After completing the Host setup above, Profile coding becomes active on the next launch " +
        "of each bound Host (codex) from /project-a.",
    );
    const verbose = formatApplyReport(applyResult(report, resultingState), { verbose: true });
    expect(verbose).toContain("Grok uses Claude's shared rule path.");
    expect(verbose.trimEnd()).toEndWith(
      "After completing the Host setup above, Profile coding becomes active on the next launch " +
        "of each bound Host (codex) from /project-a.",
    );
  });

  test("apply does not replay transition setup for unrelated applied work", () => {
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));

    expect(apply).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(apply.split("\n")).not.toContain("Host setup:");
    expect(apply).toContain("Standing Host setup:");
    expect(apply).toContain("Trust the bound project in Codex.");
  });

  test("setup-free apply says no further Host setup is required", () => {
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

    expect(formatApplyReport(applyResult(report, resultingState)).trimEnd()).toEndWith(
      "No further Host setup is required. Profile coding becomes active on the next launch " +
        "of each bound Host (claude) from /project-a.",
    );
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

    const apply = formatApplyReport(applyResult(report, resultingState));

    expect(apply).toContain("Standing Host setup:");
    expect(apply).toContain("Grok uses Claude's shared rule path.");
    expect(apply.trimEnd()).toEndWith(
      "No further Host setup is required. Profile coding becomes active on the next launch " +
        "of each bound Host (claude, grok) from /project-a.",
    );
  });

  test("no-op apply omits transition setup and the standing reminder", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    const output = formatApplyReport(applyResult(report));
    expect(output).not.toContain("becomes active");
    expect(output).not.toContain("Host setup:");
    expect(output).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(output).not.toContain("Trust the bound project in Codex.");
    expect(formatApplyReport(applyResult(report), { verbose: true })).not.toContain(
      "becomes active",
    );
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
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
    });

    expect(formatApplyReport(applyResult(receipt, resultingState)).trimEnd()).toEndWith(
      "After completing the Host setup above, Profile coding becomes active on the next launch " +
        "of each bound Host (codex) from /project-a.",
    );
  });

  test("status shows one standing reminder and never replays transition setup", () => {
    const repeatedSteps: readonly HostSetupStep[] = [hookApproval(), codexTrust(), rootLaunch()];
    const report = emptyReport({
      desired: ["/project-a", "/project-b"].map((project) => ({
        ...installation(project, repeatedSteps),
      })),
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "current", project: "/project-b" },
      ],
    });

    const status = formatLifecycleReport("status", report);

    expect(status.match(/Standing Host setup:/g)).toHaveLength(1);
    expect(status.match(/Trust the bound project in Codex\./g)).toHaveLength(1);
    expect(status).toContain("- Launch Codex from the exact bound project root: /project-a");
    expect(status).toContain("- Launch Codex from the exact bound project root: /project-b");
    expect(status).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
  });

  test("capped standing reminder scope defers to --verbose beyond the short list", () => {
    const projects = ["/p-1", "/p-2", "/p-3", "/p-4", "/p-5", "/p-6"].map((project) =>
      installation(project, [codexTrust()]),
    );
    const report = emptyReport({
      desired: projects,
      items: projects.map((desired) => ({ kind: "current", project: desired.project })),
    });

    const status = formatLifecycleReport("status", report);

    expect(status).toContain(
      "- Trust the bound project in Codex. (/p-1, /p-2, /p-3, /p-4, … 2 more Projects; use --verbose to see all Projects)",
    );
    expect(status.match(/- Trust the bound project in Codex\./g)).toHaveLength(1);

    // The verbose surface honors the concise pointer: every Project appears and
    // the escape-hatch text is gone (DEC-034, US-041).
    const verbose = formatLifecycleReport("status", report, { verbose: true });
    expect(verbose).toContain(
      "- Trust the bound project in Codex. (/p-1, /p-2, /p-3, /p-4, /p-5, /p-6)",
    );
    expect(verbose).not.toContain("use --verbose");
    expect(verbose.match(/- Trust the bound project in Codex\./g)).toHaveLength(1);
  });

  test("blocked preview and apply suppress transition setup while status retains the standing reminder", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "blocked", project: "/project-a" }],
    });

    expect(formatLifecycleReport("preview", report)).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(formatLifecycleReport("preview", report)).not.toContain(
      "Trust the bound project in Codex.",
    );
    expect(formatBlockedApplyReport(asBlockedReport(report))).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(formatLifecycleReport("status", report)).toContain("Standing Host setup:");
    expect(formatLifecycleReport("status", report)).toContain(
      "Trust the bound project in Codex.",
    );
  });

  test("post-commit verification failure retains apply setup without claiming activation", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [codexTrust()])],
      items: [{ kind: "addition", project: "/project-a" }],
    });

    const failure = formatApplyVerificationFailure(report, "Verification failed.");

    expect(failure).toContain("Standing Host setup:");
    expect(failure).toContain("Trust the bound project in Codex.");
    expect(failure).not.toContain("becomes active");
  });
});

describe("responsive lifecycle presentation", () => {
  const context = (width: number): TerminalPresentationContext => ({
    color: false,
    interactive: true,
    width,
  });

  test("wraps clean, attention, blocked, and applied lifecycle prose to the selected width", () => {
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
        fixtureBlocker(
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
      const views = [
        formatLifecycleReport("status", clean, { context: context(width) }),
        formatLifecycleReport("status", attention, { context: context(width) }),
        formatLifecycleReport("status", blocked, { context: context(width) }),
        formatApplyReport(applyResult(receipt, applied), { context: context(width) }),
      ];

      for (const view of views) {
        for (const line of view.trimEnd().split("\n")) {
          expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("keeps copyable Project paths and command invocations intact while wrapping prose", () => {
    const project = "/tmp/agent profile kit/project with a long name";
    const report = identityReport(project);
    const preview = formatLifecycleReport("preview", report, { context: context(40) });
    const emptyStatus = formatLifecycleReport("status", emptyReport(), { context: context(40) });

    expect(preview).toContain(project);
    expect(preview).toContain("apkit apply");
    expect(emptyStatus).toContain("apkit list projects");
    expect(emptyStatus).toContain("apkit bind <profile> --host <host>");
    expect(emptyStatus).toContain("\n  apkit list projects\n");
    expect(emptyStatus).toContain("\n  apkit bind <profile> --host <host>\n");

    const punctuatedCommand = formatApplyVerificationFailure(
      emptyReport(),
      "Run apkit bind <profile> --host <host>.",
      { context: context(40) },
    );
    expect(punctuatedCommand).toContain("\n  apkit bind <profile> --host <host>.\n");
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
      repositoryExclusionRepairs: [{
        entries: ["/tmp/owned path.md"],
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
    });

    const output = formatLifecycleReport("preview", report, {
      context: context(40),
      verbose: true,
    });

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
    });
    const output = formatLifecycleReport("preview", report, { context: context(40) });

    expect(output).toContain(value);
    expect(output).not.toContain("generated diagnostic path with\n");
  });

  test("wraps prose after a suffixless path without widening the line", () => {
    const path = "/tmp/foo";
    const output = formatLifecycleReport("preview", emptyReport({
      warnings: [`Inspect ${path} and then explain this warning with enough prose to wrap cleanly.`],
    }), { context: context(40) });

    expect(output).toContain(path);
    for (const line of output.trimEnd().split("\n")) {
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
  });

  test("preserves a typed path without relying on warning prose", () => {
    const path = "~/untyped project with spaces";
    const warning = `Inspect ${path} before continuing with this diagnostic.`;
    const output = formatLifecycleReport("preview", emptyReport({
      diagnosticValues: [path],
      warnings: [warning],
    }), {
      context: context(40),
    });

    expect(output).toContain(path);
    expect(output).not.toContain("untyped project with\n");
  });

  test("wraps temporary-installation setup guidance while preserving its receipt values", () => {
    const diagnosticValue = "generated diagnostic path with spaces";
    const receipt: TemporaryInstallationReceiptView = {
      adapterVersion: "codex-project-v2",
      completionState: "installed",
      engineVersion: "0.62.0",
      host: "codex",
      hostVersion: "native-project-sessionstart-v1",
      outputs: [".agent-profile-kit/codex/context.md"],
      profileId: "coding",
      project: "/tmp/temporary project with spaces",
      repositoryExclusion: undefined,
      setupSteps: [{
        consequence: "Profile Context does not load until the project is trusted.",
        host: "codex",
        kind: "trust-required",
        message: "Trust the bound project in Codex.",
        provenance: "standing",
      }],
      temporaryInstallationId: "temporary-installation-opaque-id",
      diagnosticValues: [diagnosticValue],
      warnings: [`Inspect ${diagnosticValue} before continuing with this diagnostic.`],
      workspaceInputHash: "workspace-hash",
    };

    const output = formatTemporaryInstallationHuman("install-temp", receipt, {
      context: context(40),
    });

    expect(output.split("\n").some((line) => line.includes(receipt.project))).toBe(true);
    expect(output).toContain("- Trust the bound project in Codex.");
    expect(output.split("\n")).toContain(`    ${receipt.temporaryInstallationId}`);
    expect(output).toContain("  Consequence: Profile Context does");
    expect(output).toContain(diagnosticValue);
    expect(output).not.toContain("generated diagnostic path with\n");
    expect(output.replace(/\s+/g, " ")).toContain(
      "Consequence: Profile Context does not load until the project is trusted.",
    );
    for (const line of output.trimEnd().split("\n")) {
      if (line.includes(receipt.project)) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
  });
});

describe("temporary-installation Project identity presentation", () => {
  test("presents the temporary-installation Project through the canonical path presenter", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const project = join(home, "projects", "alpha");
      const receipt = temporaryReceipt({ project });

      const install = formatTemporaryInstallationHuman(
        "install-temp",
        receipt,
        {},
        process.cwd(),
        home,
      );
      const remove = formatTemporaryInstallationHuman(
        "remove-temp",
        receipt,
        {},
        process.cwd(),
        home,
      );

      expect(install).toContain("Project: ~/projects/alpha\n");
      expect(install).not.toContain(project);
      expect(remove).toContain("Project: ~/projects/alpha\n");
      expect(remove).not.toContain(project);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("presents the temporary-installation Project relative to the working directory", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const project = join(home, "projects", "alpha");
      const receipt = temporaryReceipt({ project });

      const inside = formatTemporaryInstallationHuman(
        "install-temp",
        receipt,
        {},
        project,
        home,
      );
      const ancestor = formatTemporaryInstallationHuman(
        "install-temp",
        receipt,
        {},
        join(project, "nested"),
        home,
      );

      expect(inside).toContain("Project: .\n");
      expect(inside).not.toContain(project);
      expect(ancestor).toContain("Project: ..\n");
      expect(ancestor).not.toContain(project);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("keeps same-basename temporary-installation Projects distinct", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const first = temporaryReceipt({ project: join(home, "team-a", "project") });
      const second = temporaryReceipt({ project: join(home, "team-b", "project") });

      const install = formatTemporaryInstallationHuman(
        "install-temp",
        first,
        {},
        process.cwd(),
        home,
      ) +
        formatTemporaryInstallationHuman("install-temp", second, {}, process.cwd(), home);

      expect(install).toContain("Project: ~/team-a/project\n");
      expect(install).toContain("Project: ~/team-b/project\n");
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("presents bound-project Host Setup Steps through the canonical path presenter", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const project = join(home, "projects", "alpha");
      const receipt = temporaryReceipt({
        project,
        setupSteps: [{
          host: "codex",
          kind: "launch-constraint",
          message: "Launch Codex from the exact bound project root:",
          path: "bound-project",
          provenance: "standing",
        }],
      });

      const install = formatTemporaryInstallationHuman(
        "install-temp",
        receipt,
        {},
        process.cwd(),
        home,
      );

      expect(install.split("\n").find((line) => line.startsWith("- Launch Codex from"))).toBe(
        "- Launch Codex from the exact bound project root: ~/projects/alpha",
      );
      expect(install).not.toContain(project);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("presents temporary-installation blocked messages through the canonical path presenter", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const canonical = join(home, "projects", "alpha");
      const messages = [
        `${canonical} already has an ordinary Profile Installation; remove it before installing a temporary Profile`,
        `Cannot remove Temporary Profile Installation at ${canonical}: owned output .codex/hooks.json is a symlink`,
      ];

      const { presented, text: rendered } = presentTemporaryBlockedMessages(
        messages,
        canonical,
        "~/projects/alpha",
        process.cwd(),
        home,
      );

      expect(presented).toBe("~/projects/alpha");
      expect(rendered).toContain(
        "~/projects/alpha already has an ordinary Profile Installation",
      );
      expect(rendered).toContain(
        "Cannot remove Temporary Profile Installation at ~/projects/alpha:",
      );
      expect(rendered).not.toContain(canonical);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("keeps the Project subject in blocked messages when running from inside it", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const canonical = join(home, "projects", "alpha");
      const messages = [
        `${canonical} already has an ordinary Profile Installation; remove it before installing a temporary Profile`,
      ];

      const rendered = presentTemporaryBlockedMessages(
        messages,
        canonical,
        canonical,
        canonical,
        home,
      ).text;

      expect(rendered).toContain(
        "~/projects/alpha already has an ordinary Profile Installation",
      );
      expect(rendered).not.toMatch(/^\. /);
      expect(rendered).not.toContain(canonical);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test("replaces both canonical and authored-absolute Project spellings in blocked messages", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-temp-home-"));
    try {
      const canonical = join(home, "real-project");
      const authored = join(home, "alias-project");
      const messages = [
        `${authored} cannot be resolved: the authored spelling differs from ${canonical}`,
      ];

      const rendered = presentTemporaryBlockedMessages(
        messages,
        canonical,
        authored,
        process.cwd(),
        home,
      ).text;

      expect(rendered).toContain(
        "~/real-project cannot be resolved: the authored spelling differs from ~/real-project",
      );
      expect(rendered).not.toContain(canonical);
      expect(rendered).not.toContain(authored);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });
});

test("terminal styling follows lifecycle labels emitted by the formatter", () => {
  const context = { color: true, interactive: true, width: 80 } as const;
  const ready = formatLifecycleReport("preview", identityReport("/project-a"));
  const blocked = formatLifecycleReport(
    "preview",
    emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      items: [{ kind: "blocked", project: "/project-a" }],
    }),
  );

  expect(ready).toContain("Ready to apply");
  expect(renderHumanOutput(ready, context)).toContain("\u001b[32mReady to apply\u001b[0m");
  expect(blocked).toContain("Cannot apply");
  expect(renderHumanOutput(blocked, context)).toContain("\u001b[31mCannot apply\u001b[0m");
});

/** Distinctive anchor phrases — not a second home for the full gloss table. */
const STATE_ANCHORS: Readonly<Record<(typeof NON_CURRENT_STATE_ORDER)[number], string>> = {
  addition: "not installed yet",
  "missing output": "not a safe automatic repair",
  update: "rewrite generated files managed by Agent Profile Kit",
  "stale source": "Workspace source changed",
  "repairable missing output": "ownership is proven",
  "drifted output": "not treated as a safe automatic rewrite",
  "malformed ownership state": "cannot prove what it owns",
  blocked: "Sync cannot change this Project",
  removal: "remove proven generated files managed by Agent Profile Kit",
};

function expectUserFacingVocabulary(view: string): void {
  for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(view).not.toMatch(term);
}

function explanationLines(reportText: string): string[] {
  const start = reportText.indexOf("State explanations:\n");
  if (start < 0) return [];
  const after = reportText.slice(start + "State explanations:\n".length);
  const lines: string[] = [];
  for (const line of after.split("\n")) {
    if (!line.startsWith("- ")) break;
    lines.push(line);
  }
  return lines;
}

describe("formatLifecycleReport concise terminology", () => {
  test("renders the uninstall receipt from removed ownership facts", () => {
    const receipt = formatUninstallResult({
      projects: [{
        outputs: [".agent-profile-kit/installation.json", ".codex/hooks.json"],
        project: "/project-a",
        repositoryExclusions: [
          {
            entries: ["/.agent-profile-kit/installation.json", "/.codex/hooks.json"],
            target: "/project-a/.git/info/exclude",
          },
          {
            entries: ["/.agent-profile-kit/installation.json"],
            target: "/shared/.git/info/exclude",
          },
        ],
      }],
    });

    expect(receipt).toContain("Project: /project-a");
    expect(receipt).toContain("Removed generated paths:");
    expect(receipt).toContain("Cleaned Git exclusions:");
    expect(receipt.match(/Cleaned Git exclusions:/g)).toHaveLength(1);
    expect(receipt).toContain("Project Bindings preserved.");
  });

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

    for (const command of ["preview", "apply", "status"] as const) {
      const concise = command === "apply"
        ? formatBlockedApplyReport(asBlockedReport(report))
        : formatLifecycleReport(command, report);

      expect(concise.indexOf("Blocker:")).toBeLessThan(concise.indexOf("Projects:"));
      expect(concise).not.toContain("Changes:");
      expect(concise).not.toContain("State:");
    }
  });

  test("structured blocker evidence drives human and machine views from one record", () => {
    const structured = emptyReport({
      blockers: [normalizeBlocker({
        affectedItems: [{ kind: "host", value: "codex" }],
        kind: "host-capability",
        problem: "Codex CLI is unavailable",
        remedy: "Install a supported Codex CLI, then retry",
        requirement: "The selected Profile requires Codex project delivery",
        project: "/project-a",
        scope: "project",
      })],
    });

    // Human views keep the message projection; machine JSON publishes the
    // complete structured evidence without parsing rendered prose.
    expect(formatLifecycleReport("preview", structured)).toContain(
      "Blocker: Codex CLI is unavailable",
    );
    const machine = machineReport([
      machineProject("/project-a", { blockers: reportBlockers(structured) }),
    ]);
    expect(JSON.parse(formatLifecycleJson("preview", machine))).toMatchObject({
      schemaVersion: 5,
      globalBlockers: [],
      projects: [{
        project: "/project-a",
        blockers: [{
          affectedItems: [{ kind: "host", value: "codex" }],
          kind: "host-capability",
          message: "Codex CLI is unavailable",
          problem: "Codex CLI is unavailable",
          project: "/project-a",
          remedy: "Install a supported Codex CLI, then retry",
          requirement: "The selected Profile requires Codex project delivery",
          scope: "project",
        }],
      }],
    });
  });

  test("renders every structured blocker field directly from nested Project evidence", () => {
    const report = machineReport([
      machineProject("/project-a", {
        blockers: [normalizeBlocker({
          affectedItems: [{ kind: "host", value: "codex" }],
          kind: "host-capability",
          problem: "Codex CLI is unavailable",
          remedy: "Install a supported Codex CLI, then retry",
          requirement: "The selected Profile requires Codex project delivery",
          project: "/project-a",
          scope: "project",
        })],
        state: { kind: "blocked", reason: "Host capability unavailable" },
      }),
    ]);

    const concise = formatLifecycleReport("status", report);

    expect(concise).toContain("Blocker: Codex CLI is unavailable");
    expect(concise).toContain("Requirement: The selected Profile requires Codex project delivery");
    expect(concise).toContain("Remedy: Install a supported Codex CLI, then retry");
    expect(concise).toContain("Scope: Project /project-a");
    expect(concise).toContain("Affected host: codex");
  });

  test("preserves task-authored warning text and typed copyable values without translation", () => {
    const value = "generated diagnostic value with spaces";
    const message = `Use reconcile as authored; inspect ${value} before continuing.`;
    const report = machineReport([
      machineProject("/project-a", {
        warnings: [{ copyableValues: [value], message }],
      }),
    ]);

    const output = formatLifecycleReport("status", report, { context: {
      color: false,
      interactive: true,
      width: 40,
    } });

    expect(output).toContain("Use reconcile as authored;");
    expect(output).toContain(value);
    expect(output).not.toContain("generated diagnostic value with\n");
    expect(output).not.toContain("Use sync as authored");
  });

  test("groups tracked-output ownership conflicts into one explained blocker with capped paths", () => {
    const project = "/project-a";
    const paths = [
      ".agent-profile-kit/codex/context.md",
      ".agent-profile-kit/installation.json",
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

    const concise = formatLifecycleReport("preview", report);

    expect(concise.match(/Blocker:/g)).toHaveLength(1);
    expect(concise).toContain("Blocker: These generated paths are tracked by Git");
    expect(concise).toContain("Requirement:");
    expect(concise).toContain("Remedy:");
    expect(concise).toContain("keep repository ownership");
    expect(concise).toContain("intentionally remove");
    expect(concise).toContain("Affected paths:");
    expect(concise).toContain("- .agents/skills/s08");
    expect(concise).not.toContain("/project-a/.agents/skills/s08");
    expect(concise).not.toContain(".agents/skills/s11");
    expect(concise).toContain("… 5 more paths; use --verbose to see all paths");

    const verbose = formatLifecycleReport("preview", report, { verbose: true });

    expect(verbose).toContain("/project-a/.agents/skills/s11");
    expect(verbose).toContain("/project-a/.agents/skills/s12");
    expect(verbose).toContain("/project-a/.codex/hooks.json");
    expect(verbose.match(/Requirement:/g)).toHaveLength(1);
    expect(verbose).not.toContain("more paths");
  });

  test("renders a single-path overflow pointer for ownership conflicts", () => {
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

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("… 1 more path; use --verbose to see all paths");
    expect(concise).not.toContain("1 more paths");
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
          kind: "host-capability",
          problem: "Installation State is unreadable",
          remedy: "Restore or repair Installation State, then retry",
          requirement: "Lifecycle commands require readable Installation State",
          scope: "global",
        }),
      ],
    });

    const concise = formatLifecycleReport("status", report);

    expect(concise).toContain("Global blockers:");
    expect(concise).toContain("Blocker: Installation State is unreadable");
    expect(concise.indexOf("Project: /project-a")).toBeGreaterThan(-1);
    expect(concise.indexOf("Project: /project-a")).toBeLessThan(
      concise.indexOf("Global blockers:"),
    );
  });

  test("identifies the working-directory project as dot", () => {
    const project = process.cwd();
    const report = identityReport(project);

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("Project: .\n");
    expect(concise).not.toContain(`Project: ${project}\n`);
  });

  test("identifies an ancestor project relative to the working directory", () => {
    const project = dirname(process.cwd());
    const report = identityReport(project);

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("Project: ..\n");
    expect(concise).not.toContain(`Project: ${project}\n`);
  });

  test("identifies another home project with a home-relative path", () => {
    const project = join(homedir(), "another-project");
    const report = identityReport(project);

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("Project: ~/another-project\n");
    expect(concise).not.toContain(`Project: ${project}\n`);
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
      expect(displayPath(canonicalProject, canonicalProject, "/outside", logicalHome)).toBe(
        "~/projects/project",
      );
      expect(displayPath(canonicalProject, canonicalProject, logicalCwd, logicalHome)).toBe("..");
    } finally {
      rmSync(logicalHome, { force: true });
      rmSync(physicalHome, { force: true, recursive: true });
    }
  });

  test("lists committed paths under the short project identity in the apply receipt", () => {
    const project = join(homedir(), "receipt-project");
    const receipt = identityReport(project);

    const concise = formatApplyReport(applyResult(receipt, emptyReport()));

    expect(concise).toContain("- ~/receipt-project:\n  + a.md\n");
    expect(concise).not.toContain(`- ${project}:`);
  });

  test("labels remaining and committed apply work distinctly", () => {
    const receipt = identityReport("/project-a");
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    const concise = formatApplyReport(applyResult(receipt, resultingState));

    expect(concise).not.toContain("Pending: none");
    expect(concise).toContain("Applied:\n- /project-a:\n  + a.md");
    expect(concise).not.toContain("Changes:");
    expect(concise).not.toContain("Apply receipt:");

    const verbose = formatApplyReport(applyResult(receipt, resultingState), { verbose: true });
    expect(verbose).toContain("Pending:\n");
    expect(verbose).toContain("Applied:\n");
    expect(verbose).not.toContain("Resulting state:");
    expect(verbose).not.toContain("Apply receipt:");
  });

  test("names the Hosts recorded by each Project Binding", () => {
    const project = join(homedir(), "multi-host-project");
    const report = identityReport(project, ["claude", "codex"]);

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain(
      "Project: ~/multi-host-project\n  Profile: coding\n  Hosts: claude, codex\n",
    );
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

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain(
      "Project changes:\n  + 2 generated file additions in ~/team-a/project, ~/team-b/project",
    );
  });

  test("keeps an outside-home project absolute", () => {
    const project = "/var/tmp/outside-home-project";
    const report = identityReport(project);

    expect(formatLifecycleReport("preview", report)).toContain(`Project: ${project}\n`);
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

    const concise = formatLifecycleReport("preview", aliasedReport);

    expect(concise).toContain(`Project: ${authoredProject}\n`);
    expect(concise).not.toContain(`Project: ${canonicalProject}\n`);
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

    const concise = formatLifecycleReport("preview", aliasedReport);

    expect(concise).toContain(`Project: ${authoredProject}\n`);
    expect(concise).not.toContain(`Project: ${canonicalProject}\n`);
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
        formatLifecycleReport("preview", report),
        formatApplyReport(applyResult(report)),
        formatLifecycleReport("status", report),
      ];

      for (const view of defaultViews) {
        expectUserFacingVocabulary(view);
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
        next: [exclusionEntry],
        target: exclusionTarget,
      }],
      warnings: [`Review /tmp/reconcile/generated-output for Profile 'reconcile'`],
    });

    for (const view of [
      formatLifecycleReport("preview", report),
      formatApplyReport(applyResult(report)),
      formatLifecycleReport("status", report),
    ]) {
      expect(view).toContain(`Project: ${project}`);
      expect(view).toContain("Profile: reconcile");
      expect(view).toContain("generated-output/reconcile");
      expect(view).toContain("/tmp/reconcile/generated-output");
      expect(view).toContain("'reconcile'");
    }

    const verbose = formatLifecycleReport("preview", report, { verbose: true });
    expect(verbose).toContain(exclusionTarget);
    expect(verbose).toContain(exclusionEntry);
  });

  test("renders task-authored apply verification failures without semantic translation", () => {
    const receipt = emptyReport({
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const message = "Cannot verify the selected Project setup from its installation record";
    const view = formatApplyVerificationFailure(receipt, message);

    expect(view).toContain(message);
    expectUserFacingVocabulary(view);

    const verbose = formatApplyVerificationFailure(receipt, message, { verbose: true });
    expect(verbose).toContain(message);
    expect(verbose).toContain("Git exclusions:");
    expect(verbose).toContain("Selected setup:");
  });

  test("non-Git preview lists reconciliation-plan paths with action markers", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a", "b", "c", "d", "e"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [
        { kind: "addition", path: "a.md", project: "/project-a" },
        { kind: "addition", path: "b.md", project: "/project-a" },
        { kind: "update", path: "c.md", project: "/project-a" },
        { kind: "repair", path: "d.md", project: "/project-a" },
        { kind: "removal", path: "e.md", project: "/project-a" },
        { kind: "drifted output", path: "f.md", project: "/project-a" },
      ],
    });

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain(
      "  Files:\n" +
      "  ! f.md (drifted output)\n" +
      "  - e.md\n" +
      "  ~ c.md\n" +
      "  + a.md\n" +
      "  + b.md\n" +
      "  + d.md",
    );
    expect(concise).not.toContain("Selected setup:");
    expect(concise).not.toContain("Outputs:");
  });

  test("orders path priority groups deterministically", () => {
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

    const concise = formatLifecycleReport("preview", report);

    expect(concise.indexOf("- z.md")).toBeLessThan(concise.indexOf("~ m.md"));
    expect(concise.indexOf("~ m.md")).toBeLessThan(concise.indexOf("+ a.md"));
  });

  test("caps generated file paths with an overflow pointer to --verbose", () => {
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

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("+ file-10.md");
    expect(concise).not.toContain("+ file-11.md");
    expect(concise).toContain("… 2 more files; use --verbose to see all paths");

    const verbose = formatLifecycleReport("preview", report, { verbose: true });
    expect(verbose).toContain("/project-a/file-11.md: addition");
    expect(verbose).toContain("/project-a/file-12.md: addition");
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
        { kind: "drifted output", path: "z-attention.md", project },
        { kind: "removal", path: "z-removal.md", project },
      ],
    });

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("! z-attention.md (drifted output)");
    expect(concise).toContain("- z-removal.md");
    expect(concise.indexOf("! z-attention.md")).toBeLessThan(concise.indexOf("+ a-1.md"));
    expect(concise.indexOf("- z-removal.md")).toBeLessThan(concise.indexOf("+ a-1.md"));
    expect(concise).toContain("… 2 more files; use --verbose to see all paths");
  });

  test("verbose output keeps generated-root attention authoritative", () => {
    const project = "/project-a";
    const report = emptyReport({
      outputs: [
        { kind: "drifted output", path: "skill", project },
        { kind: "unchanged", path: "context.md", project },
      ],
    });

    const concise = formatLifecycleReport("status", report);
    expect(concise).toContain("! skill (drifted output)");

    const verbose = formatLifecycleReport("status", report, { verbose: true });
    expect(verbose).toContain("/project-a/skill: drifted output");
    expect(verbose).toContain("/project-a/context.md: unchanged");
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

      const concise = formatLifecycleReport("status", report);
      expect(concise).not.toContain("State explanations:");
      if (kind === "blocked") {
        expect(concise).toContain("Blocker: hooks disabled");
        expect(concise).not.toContain("State:");
      } else {
        expect(concise).toContain(`State: ${kind}`);
      }
      const glosses = explanationLines(formatLifecycleReport("status", report, { verbose: true }));
      expect(glosses).toHaveLength(1);
      expect(glosses[0]).toMatch(new RegExp(`^- ${kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: .+`));
      expect(glosses[0]!.length).toBeGreaterThan(`- ${kind}: `.length);
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
    const allCurrent = formatLifecycleReport("status", currentOnly);
    expect(allCurrent).not.toContain("State explanations:");
    expect(allCurrent).not.toContain("State: current");
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

    const concise = formatLifecycleReport("status", report);
    const verbose = formatLifecycleReport("status", report, { verbose: true });

    expect(concise).not.toContain("State explanations:");
    expect(verbose).toContain(
      "State explanations:\n- stale source: Workspace source changed since the last apply",
    );
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

    const concise = formatLifecycleReport("status", report);
    expect(concise).not.toContain("Project: /project-a");
    expect(concise).toContain("Project: /project-b");
    expect(concise).not.toContain("State explanations:");
    expect(concise).not.toContain("Changes:");
    expect(concise).toMatch(
      /Project: \/project-b\n  Profile: coding\n  Hosts: codex\n  Blocker: hooks disabled\n/,
    );

    for (const command of ["preview", "apply", "status"] as const) {
      const verbose = command === "apply"
        ? formatBlockedApplyReport(asBlockedReport(report), { verbose: true })
        : formatLifecycleReport(command, report, { verbose: true });
      expect(verbose.indexOf("Blockers:\n- hooks disabled")).toBeGreaterThan(-1);
      expect(verbose).toContain("Scope: Project /project-b");
      expect(verbose.indexOf("Blockers:\n- /project-b: hooks disabled")).toBeLessThan(
        verbose.indexOf("Projects:"),
      );
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

    const glosses = explanationLines(formatLifecycleReport("status", report, { verbose: true }));
    const kinds = glosses.map((line) => line.slice(2, line.indexOf(":")));
    expect(kinds).toEqual(NON_CURRENT_STATE_ORDER.filter((kind) => present.includes(kind)));
  });

  test("places verbose state definitions after Projects for unscoped items", () => {
    const report = emptyReport({
      items: [{ kind: "removal", project: "/orphan" }],
    });
    const verbose = formatLifecycleReport("status", report, { verbose: true });
    const projectsAt = verbose.indexOf("Projects:");
    const explanationsAt = verbose.indexOf("State explanations:");
    expect(projectsAt).toBeGreaterThan(-1);
    expect(explanationsAt).toBeGreaterThan(projectsAt);
    expect(verbose).toContain("/orphan: removal");
    expect(explanationLines(verbose)).toHaveLength(1);
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
        next: ["/.agent-profile-kit/codex/context.md", "/.codex/hooks.json"],
        target,
      }],
    });

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("Git exclusions: 2 entries to add, 1 entry to remove.");
    expect(concise).not.toContain(target);
    expect(concise).not.toContain("/.old-path.md");

    const verbose = formatLifecycleReport("preview", report, { verbose: true });
    expect(verbose).toContain(
      `- ${target}: add /.agent-profile-kit/codex/context.md, /.codex/hooks.json; remove /.old-path.md`,
    );
  });

  test("blocked reports retain the pending Git exclusion repair clause", () => {
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
      repositoryExclusionRepairs: [{
        entries: ["/.agent-profile-kit/codex/context.md"],
        target: "/repo/.git/info/exclude",
      }],
      warnings: [
        "/repo/.git/info/exclude is missing its Agent Profile Kit exclusion section; apply will restore recorded exact entries",
      ],
    });

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("Blocker: occupied output");
    expect(concise).toContain("Git exclusions: 1 recorded entry to restore.");
    expect(concise).not.toContain("/repo/.git/info/exclude");
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
      }],
      warnings: ["example warning"],
      blockers: [fixtureBlocker("/project-a: example blocker", "/project-a")],
    });

    const verbose = formatLifecycleReport("preview", report, { verbose: true });

    expect(verbose.startsWith("Cannot apply\n")).toBe(true);
    expect(verbose).toContain("Projects:");
    expect(verbose).toContain("/project-a: stale source");
    expect(verbose).toContain("Outputs:");
    expect(verbose).toContain("/project-a/.agent-profile-kit/codex/context.md: update");
    expect(verbose).toContain("/project-a/.codex/hooks.json: unchanged");
    expect(verbose).toContain("Git exclusions:");
    expect(verbose).toContain("/project-a/.git/info/exclude: add /.agent-profile-kit/codex/context.md");
    expect(verbose).toContain("Selected setup:");
    expect(verbose).toContain("Profile coding");
    expect(verbose).toContain("Hosts: claude, codex");
    expect(verbose).toContain("Resolved artifacts:");
    expect(verbose).toContain("context:team-rules");
    expect(verbose).toContain(
      "  Context:\n" +
      "---- begin Context ----\n" +
      "First Context Module\n" +
      "--- end Context ---\n" +
      "Second Context Module\n" +
      "---- end Context ----\n",
    );
    expect(verbose).toContain("Warnings:");
    expect(verbose).toContain("example warning");
    expect(verbose).toContain("Blockers:");
    expect(verbose).toContain("- example blocker");
    expect(verbose).toContain("Scope: Project /project-a");
    expect(verbose).toContain("State explanations:");
    expect(verbose).not.toContain("generated-output");
    expect(verbose).not.toContain("Git-local exclusions that keep Installer-owned generated paths untracked");
  });

  test("verbose apply keeps repaired exclusion guidance in the receipt tense", () => {
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
      repositoryExclusionRepairs: [{
        entries: ["/.agent-profile-kit/codex/context.md"],
        target: "/repo/.git/info/exclude",
      }],
      warnings: [
        "/repo/.git/info/exclude is missing its Agent Profile Kit exclusion section; apply will restore recorded exact entries",
      ],
    });
    const result = emptyReport({
      desired: reportDesired(receipt),
      items: reportItems(receipt),
      outputs: reportOutputs(receipt),
      repositoryExclusionRepairs: [],
      warnings: [],
    });

    const preview = formatLifecycleReport("preview", receipt);
    expect(preview).toContain("Git exclusions: 1 recorded entry to restore.");
    expect(preview).not.toContain("/repo/.git/info/exclude");
    expect(preview).not.toContain("/.agent-profile-kit/codex/context.md");

    for (const command of ["preview", "status"] as const) {
      const verbosePending = formatLifecycleReport(command, receipt, { verbose: true });
      expect(verbosePending).toContain(
        "/repo/.git/info/exclude: will restore 1 recorded Git exclusion entry",
      );
      expect(verbosePending).not.toContain(
        "/repo/.git/info/exclude: restored 1 recorded Git exclusion entry",
      );
    }

    const concise = formatApplyReport(applyResult(receipt, result));
    expect(concise).toContain("Git exclusions: 1 recorded entry restored.");
    expect(concise).not.toContain("Project: /repo");
    expect(concise).not.toContain("State: current");
    expect(concise).not.toContain("/repo/.git/info/exclude");
    expect(concise).not.toContain("/.agent-profile-kit/codex/context.md");

    const verbose = formatApplyReport(applyResult(receipt, result), { verbose: true });

    expect(verbose).not.toContain("apply will restore");
    expect(verbose).toContain("Applied:");
    expect(verbose).toContain("restored 1 recorded Git exclusion entry");
  });

  test("verbose apply explains non-current states once across pending and applied sections", () => {
    const receipt = emptyReport({
      items: [{ kind: "stale source", project: "/repo" }],
    });
    const resultingState = emptyReport({
      items: [{ kind: "repairable missing output", project: "/repo" }],
    });

    const verbose = formatApplyReport(applyResult(receipt, resultingState), { verbose: true });

    expect(verbose.match(/State explanations:/g)).toHaveLength(1);
    expect(explanationLines(verbose)).toEqual([
      expect.stringContaining("stale source: Workspace source changed"),
      expect.stringContaining("repairable missing output: An owned generated file is wholly missing, but ownership is proven"),
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

    const concise = formatApplyReport(applyResult(receipt, resultingState));

    expect(concise).toContain("Applied:\n  ~ 1 generated file update in /changed");
    expect(concise).not.toContain("Project: /changed");
    expect(concise).not.toContain("Project: /untouched");
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

    const concise = formatApplyReport(applyResult(emptyReport(), resultingState));

    expect(concise.startsWith("Apply completed with blockers\n")).toBe(true);
    expect(concise).toContain("Pending: blocked");
    expect(concise).toContain("- /project-a: Resolve the reported blocker");
  });

  test("verification failures print the completed receipt without claiming current state", () => {
    const receipt = emptyReport({
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const concise = formatApplyVerificationFailure(
      receipt,
      "Apply committed; post-apply verification failed: transient read",
    );

    expect(concise.startsWith("Apply committed; post-apply verification failed: transient read\n")).toBe(true);
    expect(concise).toContain("Applied:");
    expect(concise).toContain("+ a.md");
    expect(concise).not.toContain("Apply complete");
  });
});

describe("formatLifecycleReport next-action guidance", () => {
  function nextActionLines(reportText: string): string[] {
    const next = reportText.indexOf("Next:\n");
    if (next < 0) return [];
    return reportText
      .slice(next + "Next:\n".length)
      .split("\n\n", 1)[0]!
      .split("\n")
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2));
  }

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

    const concise = formatLifecycleReport("status", report);
    const next = nextActionLines(concise);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/preview/i);
    expect(next[0]).toMatch(/apply/i);
    expect(next[0]).toMatch(/read-only/i);
    expect(next[0]).not.toMatch(/bind/i);
    expect(concise).toContain("Attention required");
    expect(concise).toContain("State: stale source");
    expect(concise).toContain("~ a.md");
  });

  test("ready preview recommends apply", () => {
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

    const concise = formatLifecycleReport("preview", report);
    const next = nextActionLines(concise);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/apkit apply/);
    expect(concise).toContain("Ready to apply");
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

    const statusNext = nextActionLines(formatLifecycleReport("status", report));
    expect(statusNext).toHaveLength(1);
    expect(statusNext[0]).toMatch(/resolve/i);
    expect(statusNext[0]).toMatch(/blocker/i);
    expect(statusNext[0]).toMatch(/apkit status/);
    expect(statusNext[0]).not.toMatch(/apply/i);
  });

  test("blocked preview retries preview without recommending apply", () => {
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

    const preview = formatLifecycleReport("preview", report);
    const previewNext = nextActionLines(preview);
    expect(previewNext).toHaveLength(1);
    expect(previewNext[0]).toMatch(/resolve/i);
    expect(previewNext[0]).toMatch(/blocker/i);
    expect(previewNext[0]).toMatch(/apkit preview/);
    expect(previewNext[0]).not.toMatch(/apply/i);
    expect(preview).toContain("Cannot apply");
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

    const next = nextActionLines(formatApplyReport(applyResult(report)));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/resolve/i);
    expect(next[0]).toMatch(/blocker/i);
    expect(next[0]).toMatch(/apkit apply/);
  });

  test("current status and current preview emit no next action", () => {
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

    expect(nextActionLines(formatLifecycleReport("status", current))).toEqual([]);
    expect(nextActionLines(formatLifecycleReport("preview", current))).toEqual([]);
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

    const status = formatLifecycleReport("status", current);

    expect(status).toBe("All Projects are current (1 Project)\n");
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
    expect(nextActionLines(formatApplyReport(applyResult(current)))).toEqual([]);

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
    // Apply already completed; do not recommend another apply or preview.
    expect(nextActionLines(formatApplyReport(applyResult(appliedWithChanges)))).toEqual([]);

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
    const metadataOnly = formatApplyReport(applyResult(metadataOnlyReceipt, metadataOnlyResult));
    expect(metadataOnly).not.toContain("no changes were applied");
    expect(metadataOnly).toContain("Project update");
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

    const status = formatLifecycleReport("status", mixedBlocked);

    expect(status).toContain(
      "Next:\n" +
        "- /project-a: After all blockers are resolved, run apkit preview to review the planned changes " +
        "(read-only), then apply when ready.\n" +
        "- /project-b: Resolve the reported blocker, then run apkit status again.",
    );
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

    const status = formatLifecycleReport("status", globallyBlocked);

    expect(status).toContain(
      "Next:\n- Resolve the reported global blocker, then run apkit status again.",
    );
    expect(status).not.toContain("Ready to apply.");
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

    const mixedStatus = formatLifecycleReport("status", mixedActionable);
    expect(nextActionLines(mixedStatus)).toHaveLength(1);
    expect(nextActionLines(mixedStatus)[0]).toMatch(/^\/project-b:/);
    expect(nextActionLines(mixedStatus)[0]).toMatch(/preview/i);
    expect(nextActionLines(mixedStatus)[0]).not.toMatch(/bind/i);
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

    expect(nextActionLines(formatLifecycleReport("status", report, { verbose: true }))).toEqual([]);
    expect(nextActionLines(formatLifecycleReport("preview", report, { verbose: true }))).toEqual([]);
  });

  test("exclusion-only deltas stay consistent with all-current outcome and emit no next action", () => {
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
      }],
    });

    const status = formatLifecycleReport("status", report);
    expect(status).toContain("All Projects are current (1 Project)");
    expect(status).not.toContain("No Projects need attention.");
    expect(nextActionLines(status)).toEqual([]);

    const preview = formatLifecycleReport("preview", report);
    expect(preview).toContain("Nothing to sync; all Projects are current.");
    expect(nextActionLines(preview)).toEqual([]);
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

    const status = formatLifecycleReport("status", report);
    expect(status).toBe("All Projects are current (1 Project)\n");
    expect(nextActionLines(status)).toEqual([]);
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

    const next = nextActionLines(formatLifecycleReport("status", report));
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

  test("lifecycle JSON publishes complete nested Project evidence under schema version 5", () => {
    const blocker = fixtureBlocker("CLI missing", project);
    const report = machineReport([
      machineProject(project, {
        desired,
        state: { kind: "addition" },
        outputs: [{ kind: "addition", path: "a.md", consumingHosts: ["codex"] }],
        blockers: [blocker],
        warnings: [{ message: "Review /copy/me", copyableValues: ["/copy/me"] }],
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
        repositoryExclusionRepairs: [{
          entries: ["/.agent-profile-kit/"],
          target: "/project-a/.git/info/exclude",
        }],
      }),
    ]);

    const payload = JSON.parse(formatLifecycleJson("preview", report));
    expect(payload.schemaVersion).toBe(5);
    expect(payload.command).toBe("preview");
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
        kind: "occupied-output",
        message: "CLI missing",
        problem: "CLI missing",
        project,
        remedy: "Resolve the reported blocker, then retry",
        requirement: "Lifecycle commands cannot proceed while blocked",
        scope: "project",
      }],
      warnings: [{ message: "Review /copy/me", copyableValues: ["/copy/me"] }],
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
      repositoryExclusionRepairs: [{
        entries: ["/.agent-profile-kit/"],
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
        warnings: [{ message: "Review A", copyableValues: ["/copy/a"] }],
        repositoryExclusions: [{
          current: [],
          next: ["/a"],
          target: "/repo-a/.git/info/exclude",
        }],
      }),
      machineProject("/project-b", {
        warnings: [{ message: "Review B", copyableValues: ["/copy/b"] }],
        repositoryExclusions: [{
          current: ["/old-b"],
          next: ["/b"],
          target: "/repo-b/.git/info/exclude",
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
        warnings: [{ message: "Review A", copyableValues: ["/copy/a"] }],
        repositoryExclusions: [{
          current: [], next: ["/a"], target: "/repo-a/.git/info/exclude",
        }],
      },
      {
        project: "/project-b",
        warnings: [{ message: "Review B", copyableValues: ["/copy/b"] }],
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
    expect(payload.schemaVersion).toBe(5);
    expect(payload.projects[0].state).toEqual({ kind: "current" });
    expect(payload.applied.projects[0].state).toEqual({ kind: "addition" });
  });

  test("blocked apply JSON has no applied snapshot", () => {
    const report = machineReport([
      machineProject(project, { blockers: [fixtureBlocker("CLI missing", project)] }),
    ]);

    const payload = JSON.parse(formatBlockedApplyJson(report));
    expect(payload).toMatchObject({ command: "apply", outcome: "blocked", schemaVersion: 5 });
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
      schemaVersion: 5,
    });
    expect(payload.projects[0].outputs).toEqual([
      { kind: "addition", path: "a.md", consumingHosts: ["codex"] },
    ]);
    expect(payload.applied.projects[0].outputs).toEqual(payload.projects[0].outputs);
  });

  test("tool-error JSON uses the empty nested model", () => {
    for (const command of ["preview", "apply", "status"] as const) {
      expect(JSON.parse(formatLifecycleToolErrorJson(command, "missing"))).toEqual({
        schemaVersion: 5,
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

describe("responsive inventory, info, validation, and teardown human surfaces", () => {
  const context = (width: number): TerminalPresentationContext => ({
    color: false,
    interactive: true,
    width,
  });

  test("info wraps prose at the selected width and keeps location lines whole", () => {
    const info: ApplicationInfo = {
      configurationState: "current",
      engineVersion: "0.67.0",
      installationState: "/home/.agents/agent-profile-kit/state/manifest.yaml",
      localConfiguration: "/home/.agents/agent-profile-kit/config.yaml",
      workspace: {
        authored: "/home/.agents/agent-profile-kit/workspace",
        canonical: "/home/.agents/agent-profile-kit/workspace",
      },
    };
    const output = formatInfoHuman(info, { context: context(40) }, "/home", "/work");
    for (const line of output.split("\n")) {
      if (/^(?:Engine version|Workspace|Local Configuration|Installation State):/.test(line)) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
    expect(output).toContain("Workspace: ~/.agents/agent-profile-kit/workspace");
    expect(output).toContain("Local Configuration: ~/.agents/agent-profile-kit/config.yaml");
    expect(output).toContain("Installation State: ~/.agents/agent-profile-kit/state/manifest.yaml");
    // Without a context the deterministic layout is preserved byte-for-byte.
    expect(formatInfoHuman(info, {}, "/home", "/work")).toBe(
      "Engine version: 0.67.0\n" +
        "Workspace: ~/.agents/agent-profile-kit/workspace\n" +
        "Local Configuration: ~/.agents/agent-profile-kit/config.yaml\n" +
        "Installation State: ~/.agents/agent-profile-kit/state/manifest.yaml\n",
    );
  });

  test("inventory index wraps topic descriptions at the selected width", () => {
    const output = formatInventoryIndex({ context: context(40) });
    for (const line of output.split("\n")) {
      if (line.includes("apkit ")) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
    expect(formatInventoryIndex()).toBe(
      "Inventory topics:\n" +
        "  apkit list projects\n" +
        "    Project inventory from Local Configuration.\n" +
        "    JSON example: apkit list projects --json\n" +
        "  apkit list profiles\n" +
        "    Profile inventory from the selected Workspace.\n" +
        "    JSON example: apkit list profiles --json\n" +
        "  apkit list hosts\n" +
        "    Supported Agent Host inventory with Temporary Profile Installation eligibility.\n" +
        "    JSON example: apkit list hosts --json\n" +
        "  apkit list temporary\n" +
        "    Active Temporary Profile Installation inventory from Installation State.\n" +
        "    JSON example: apkit list temporary --json\n",
    );
  });

  test("project inventory wraps a long problem clause while keeping Project identity whole", () => {
    const project = "/home/projects/a-very-long-project-identity";
    const output = formatProjectInventoryHuman(
      [{
        canonicalProject: project,
        hosts: ["claude", "codex"],
        problem: "Configured project root does not exist on this machine and cannot be reconciled.",
        profile: "engineering",
        project,
      }],
      { context: context(40) },
      "/home",
      "/work",
    );
    for (const line of output.split("\n")) {
      if (line.includes("apkit ") || line.includes("~/projects/")) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
    expect(output).toContain("Project: ~/projects/a-very-long-project-identity");
    expect(formatProjectInventoryHuman(
      [{
        canonicalProject: project,
        hosts: ["claude", "codex"],
        problem: "Configured project root does not exist on this machine and cannot be reconciled.",
        profile: "engineering",
        project,
      }],
      {},
      "/home",
      "/work",
    )).toBe(
      "Projects (1):\n" +
        "\n" +
        "Project: ~/projects/a-very-long-project-identity\n" +
        "  Profile: engineering\n" +
        "  Hosts: claude, codex\n" +
        "  Problem: Configured project root does not exist on this machine and cannot be reconciled.\n" +
        "\n" +
        "Next: Run apkit status for Project lifecycle diagnostics.\n",
    );
  });

  test("host, profile, and temporary inventory wrap prose at the selected width", () => {
    const hosts = formatHostInventoryHuman(
      [
        { host: "claude", supportsTemporaryProfileInstallation: true },
        { host: "grok", supportsTemporaryProfileInstallation: false },
      ],
      { context: context(40) },
    );
    for (const line of hosts.split("\n")) {
      if (line.includes("apkit ") || line.includes("Temporary Profile Installation:")) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
    expect(hosts).toContain("Host: claude");
    expect(hosts).toContain("Temporary Profile Installation: supported");

    const profiles = formatProfileInventoryHuman(
      [{ contextModules: 2, id: "engineering", skills: 3 }],
      { context: context(40) },
    );
    for (const line of profiles.split("\n")) {
      if (line.includes("apkit ")) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
    expect(profiles).toContain("Profile: engineering");

    const temporary = formatTemporaryInventoryHuman(
      [{
        host: "codex",
        profileId: "coding",
        project: "/home/projects/temporary-project",
        temporaryInstallationId: "temporary-installation-opaque-id",
      }],
      { context: context(40) },
      "/home",
      "/work",
    );
    for (const line of temporary.split("\n")) {
      if (line.includes("apkit ") || line.includes("~/projects/") || line.startsWith("Temporary installation:")) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
    expect(temporary).toContain("Project: ~/projects/temporary-project");
    expect(formatTemporaryInventoryHuman([], {}, "/home", "/work")).toBe(
      "No Temporary Profile Installations are active.\n" +
        "Next: Run apkit install-temp <profile> <project> --host <host>.\n",
    );
  });

  test("validation wraps long warning prose and keeps the count clause whole", () => {
    const output = formatValidationResult({
      bindings: 2,
      hosts: ["claude", "codex"],
      profiles: ["engineering"],
      warnings: [
        "This is an unusually long validation warning that must wrap cleanly at a narrow terminal measure.",
      ],
    }, { context: context(40) });
    for (const line of output.split("\n")) {
      if (line.includes("apkit ") || line.includes("(2 Profile")) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
    expect(formatValidationResult({
      bindings: 0,
      hosts: [],
      profiles: [],
      warnings: [],
    })).toBe(
      "Workspace and Local Configuration valid (0 Profiles, 0 Project Bindings)\n" +
        "Profiles found: none\n" +
        "Hosts bound: none\n",
    );
  });

  test("uninstall wraps prose at the selected width, keeps paths whole, and preserves the empty state", () => {
    const output = formatUninstallResult({
      projects: [{
        outputs: [".agent-profile-kit/codex/context.md"],
        project: "/home/projects/api",
        repositoryExclusions: [],
      }],
    }, { context: context(40) });
    expect(output).toContain("Project: /home/projects/api");
    expect(output).toContain(".agent-profile-kit/codex/context.md");
    const prose = output.split("\n").find((line) => line.startsWith("Removed proven"));
    expect(prose).toBeDefined();
    expect(prose!.length).toBeLessThanOrEqual(40);

    expect(formatUninstallResult({ projects: [] })).toBe(
      "No ordinary Agent Profile Kit-owned output is installed.\n\nProject Bindings preserved.\n",
    );
    const wrappedEmpty = formatUninstallResult({ projects: [] }, { context: context(40) });
    for (const line of wrappedEmpty.split("\n")) {
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
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

  test("multi-Project preview groups observable operations without inferring artifact causality", () => {
    const concise = formatLifecycleReport("preview", sharedSkillFleet());

    expect(concise).toContain("Ready to apply\n");
    expect(concise).toContain("Project changes:\n  ~ 3 generated file updates in 3 projects");
    expect(concise).not.toContain("Skill review-pr");
    expect(concise).not.toContain("Workspace changes:");
    expect(concise).not.toContain("Project: /project-a");
    expect(concise).not.toContain("Project: /project-b");
    expect(concise).not.toContain("Project: /project-c");
    expectUserFacingVocabulary(concise);
  });

  test("fleet summaries group each observable operation with its affected Projects", () => {
    const report = sharedSkillFleet({
      outputs: [
        { kind: "addition", path: ".agents/skills/new-skill", project: "/project-a" },
        { kind: "update", path: SKILL_PATH, project: "/project-a" },
        { kind: "update", path: SKILL_PATH, project: "/project-b" },
        { kind: "repair", path: CONTEXT_PATH, project: "/project-b" },
        { kind: "removal", path: ".agents/skills/old-skill", project: "/project-c" },
      ],
    });

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain(
      "Project changes:\n" +
        "  + 1 generated file addition in /project-a\n" +
        "  ~ 2 generated file updates in /project-a, /project-b\n" +
        "  ~ 1 generated file repair in /project-b\n" +
        "  - 1 generated file removal in /project-c",
    );
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

    expect(formatLifecycleReport("preview", report)).toContain(
      "~ 5 generated file updates in /project-a, /project-b, /project-c, /project-d, … 1 more Project; use --verbose to see all Projects",
    );
  });

  test("single-Project runs remain Project-first", () => {
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
    });

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("Project: /project-a\n  Profile: coding\n  Hosts: codex");
    expect(concise).not.toContain("Project changes:");
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

    const concise = formatLifecycleReport("preview", report);

    expect(concise.startsWith("Cannot apply\n")).toBe(true);
    expect(concise).toContain("Blocker:");
    expect(concise).not.toContain("Project changes:");
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

    const apply = formatApplyReport({ receipt, resultingState });

    expect(apply).toContain("Applied:\n  ~ 3 generated file updates in 3 projects");
    expect(apply).not.toContain("State: current");
    expect(apply).not.toContain("Skill review-pr");
  });

  test("generated-root ownership attention remains visible as a Project exception", () => {
    const report = sharedSkillFleet({
      outputs: [
        ...reportOutputs(sharedSkillFleet()),
        {
          kind: "drifted output" as const,
          path: SKILL_PATH,
          project: "/project-a",
        },
      ],
    });

    expect(formatLifecycleReport("preview", report)).toContain(
      "Project exceptions:\n  /project-a:\n    ! .agents/skills/review-pr (drifted output)",
    );
  });

  test("verbose retains complete per-Project operation evidence", () => {
    const verbose = formatLifecycleReport("preview", sharedSkillFleet(), { verbose: true });

    expect(verbose).toContain("/project-a/.agents/skills/review-pr: update");
    expect(verbose).toContain("/project-b/.agents/skills/review-pr: update");
    expect(verbose).toContain("/project-c/.agents/skills/review-pr: update");
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

    const preview = formatLifecycleReport("preview", report);
    expect(preview).toContain("Ready to apply");
    expect(preview).toContain("Projects: 1 · Changes: 1 generated file addition");
    expect(preview).not.toContain("Blockers: 0");
    expect(preview).not.toContain("Changes: none");

    const applied = formatApplyReport(applyResult(report, emptyReport({
      desired: reportDesired(report),
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    })));
    expect(applied).toContain("Apply complete");
    expect(applied).not.toContain("Blockers: 0");
    expect(applied).not.toContain("Pending: none");
    expect(applied).not.toContain("Changes: none");
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

    const preview = formatLifecycleReport("preview", report);
    expect(preview).toContain("Cannot apply");
    expect(preview).toContain("Blockers: 1");
    expect(preview).not.toContain("Blockers: 0");

    const apply = formatBlockedApplyReport(asBlockedReport(report));
    expect(apply).toContain("Apply blocked");
    expect(apply).toContain("Blockers: 1");
    expect(apply).toContain("Pending: blocked");
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

    const preview = formatLifecycleReport("preview", report);
    expect(preview).toContain("Next:\n- Run apkit apply --all.");
    expect(preview).not.toContain("/project-a: Run apkit apply --all.");
    expect(preview.match(/Run apkit apply --all\./g)).toHaveLength(1);
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

    const preview = formatLifecycleReport("preview", report);
    expect(preview).toContain("- /project-a: Run apkit apply --all.");
    expect(preview).not.toContain("/private/project-a: Run apkit apply --all.");
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

    const status = formatLifecycleReport("status", report);
    expect(status).toContain(
      "Next:\n" +
        "- /project-a: After all blockers are resolved, run apkit preview to review the planned changes " +
        "(read-only), then apply when ready.\n" +
        "- /project-b: Resolve the reported blocker, then run apkit status again.",
    );
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).toContain("Apply complete");
    expect(apply).toContain("Applied:\n- /project-a:\n  + a.md");
    expect(apply).not.toContain("Project: /project-a");
    expect(apply).not.toContain("State: current");
    expect(apply).not.toContain("State: addition");
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
      repositoryExclusionRepairs: [{
        entries: ["/.agent-profile-kit/codex/context.md"],
        target: "/repo/.git/info/exclude",
      }],
    });
    const resultingState = emptyReport({
      desired: reportDesired(receipt),
      items: [{ kind: "current", project: "/repo" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/repo" }],
    });

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).toContain("Apply complete");
    expect(apply).toContain("Git exclusions: 1 recorded entry restored.");
    expect(apply).not.toContain("Project: /repo");
    expect(apply).not.toContain("State: current");
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
      items: [{ kind: "drifted output", project: "/project-a" }],
      outputs: [{ kind: "drifted output", path: "a.md", project: "/project-a" }],
    });

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).toContain("Apply completed with attention");
    expect(apply).toContain("Project: /project-a");
    expect(apply).toContain("State: drifted output");
    expect(apply).toContain("! a.md");
    expect(apply).toContain("Applied:\n- /project-a:\n  ~ a.md");
  });

  test("no-op preview states current once", () => {
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

    const preview = formatLifecycleReport("preview", report);
    expect(preview).toBe("Nothing to sync; all Projects are current.\n");
    expect(preview).not.toContain("Ready to apply");
    expect(preview).not.toContain("Blockers: 0");
    expect(preview).not.toContain("Changes: none");
    expect(preview).not.toContain("Projects: 1");
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

    const apply = formatApplyReport(applyResult(report));
    expect(apply).toBe("Apply complete\nAll Projects were already current.\n");
    expect(apply).not.toContain("Pending: none");
    expect(apply).not.toContain("Applied: none");
    expect(apply).not.toContain("Blockers: 0");
    expect(apply).not.toContain("becomes active");
    expect(apply).not.toContain("Host setup:");
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply.match(/becomes active on the next launch/g)).toHaveLength(1);
    expect(apply).toContain(
      "After completing the Host setup above, Profile coding becomes active on the next launch " +
        "of each bound Host (codex) in 2 projects.",
    );
    expect(apply).not.toContain("from /project-a");
    expect(apply).not.toContain("from /project-b");
  });

  test("setup-dependent readiness appears only when setup remains relevant", () => {
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).not.toContain("After completing the Host setup above");
    expect(apply).toContain(
      "No further Host setup is required. Profile coding becomes active on the next launch " +
        "of each bound Host (codex) from /project-a.",
    );
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

    const verbose = formatLifecycleReport("preview", report, { verbose: true });
    expect(verbose).toContain("Projects:");
    expect(verbose).toContain("/project-a: addition");
    expect(verbose).toContain("Outputs:");
    expect(verbose).toContain("/project-a/a.md: addition");
    expect(verbose).toContain("Selected setup:");
    expect(verbose).toContain("Blockers:");
    expect(verbose).not.toContain("Next:");

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
    const payload = JSON.parse(formatLifecycleJson("preview", machine)) as {
      readonly command: string;
      readonly outcome: string;
      readonly schemaVersion: number;
    };
    expect(payload).toMatchObject({
      command: "preview",
      outcome: "attention",
      schemaVersion: 5,
    });
    expect(lifecycleExitCode(report)).toBe(0);
    expect(lifecycleExitCode(emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
    }))).toBe(2);
  });
});
