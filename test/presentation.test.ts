import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { HostSetupStep } from "../adapters/project-plan.js";
import {
  formatBlockedApplyReport,
  formatApplyExecutionFailure,
  formatApplyReport,
  formatApplyVerificationFailure,
  formatApplyJson,
  formatApplyVerificationFailureJson,
  formatBlockedApplyJson,
  formatInfoHuman,
  formatInventoryIndex,
  formatLifecycleJson,
  formatLifecycleReport,
  formatLifecycleToolErrorJson,
  formatProfileInventoryHuman,
  formatProjectInventoryHuman,
  formatMissingProfileError,
  formatTemporaryInstallationHuman,
  formatTemporaryInventoryHuman,
  formatUninstallResult,
  formatValidationResult,
  presentTemporaryBlockedMessages,
  type TemporaryInstallationReceiptView,
  displayPath,
  lifecycleExitCode,
  DEFAULT_VIEW_LEXICON,
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
          )?.consumingHosts ?? (installation?.hosts ?? []),
          kind: output.kind,
          path: output.path,
        })),
        blockers: fixture.blockers.filter((blocker) =>
          blocker.scope === "project" && canonicalProject(blocker.project) === key
        ),
        warnings: key === firstProject ? fixture.warnings.map((message) => ({
          copyableValues: fixture.diagnosticValues,
          kind: "diagnostic" as const,
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

  test("concise pending status renders no transition or standing Host setup", () => {
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

    const status = formatLifecycleReport("status", report);

    expect(status).toStartWith("Updates ready for 1 project (1 file addition).\n");
    expect(status).toContain("Next: apkit apply");
    expect(status).toContain("Details: apkit status --verbose");
    expect(status).not.toContain("Host setup:");
    expect(status).not.toContain("Standing Host setup:");
    expect(status).not.toContain("Review and approve the generated SessionStart hook");
    expect(status).not.toContain("Trust the bound project in Codex.");
    expect(status).not.toContain("Launch Codex from the exact bound project root:");
    expect(status).not.toContain("Grok uses Claude's shared rule path.");
    expect(status).not.toContain("Consequence:");
  });

  test("concise clean status states current once without setup, Project list, or next action", () => {
    const report = emptyReport({
      desired: ["/project-a", "/project-b"].map((project) =>
        installation(project, [hookApproval(), codexTrust(), rootLaunch()]),
      ),
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "current", project: "/project-b" },
      ],
    });

    const status = formatLifecycleReport("status", report);

    expect(status).toBe("All Projects are current (2 Projects)\n");
    expect(status).not.toContain("Host setup:");
    expect(status).not.toContain("Standing Host setup:");
    expect(status).not.toContain("Trust the bound project in Codex.");
    expect(status).not.toContain("Next:");
    expect(status).not.toContain("Project:");
  });

  test("concise blocked status stays blocker-first and omits Host setup", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "blocked", project: "/project-a" }],
    });

    const status = formatLifecycleReport("status", report);

    expect(status).toStartWith("Cannot apply\n");
    expect(status).toContain("occupied output");
    expect(status).not.toContain("Host setup:");
    expect(status).not.toContain("Standing Host setup:");
    expect(status).not.toContain("Review and approve the generated SessionStart hook");
    expect(status).not.toContain("Trust the bound project in Codex.");
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
    const verbose = formatLifecycleReport("status", report, { context, verbose: true });
    expect(verbose).toContain("Host setup:");
    expect(verbose).toContain("Standing Host setup:");
    expect(verbose).toContain(
      "- Review and approve the generated SessionStart hook when Codex asks.\n" +
        "  Consequence: Declining the hook prevents Profile Context from loading.",
    );
    expect(verbose).toContain(
      "- Trust the bound project in Codex.\n" +
        "  Consequence: Profile Context does not load until the project is trusted.",
    );
    expect(verbose).toContain("Launch Codex from the exact bound project root: /project-a");
    expect(verbose).toContain("Grok uses Claude's shared rule path.");

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

    const verbose = formatLifecycleReport("status", report, { verbose: true });

    // The identical step renders once with compact Project scope; the distinct
    // consequence keeps its own bullet (US-048, US-049).
    expect(verbose.match(/- Trust the bound project in Codex\./g)).toHaveLength(2);
    expect(verbose).toContain("- Trust the bound project in Codex. (/project-a, /project-b)");
    expect(verbose.match(/Profile Context does not load until the project is trusted\./g)).toHaveLength(1);
    expect(verbose.match(/A different consequence remains visible\./g)).toHaveLength(1);
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

    const verbose = formatLifecycleReport("status", report, { verbose: true });

    expect(verbose.split("\n").find((line) => line.startsWith("- Launch Codex from"))).toBe(
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

    expect(apply).toContain("First use:\n");
    expect(apply).not.toContain("Host setup:");
    expect(apply).not.toContain("Standing Host setup:");
    expect(apply).toContain(
      "- Review and approve the generated SessionStart hook when Codex asks so the Profile can load.",
    );
    expect(apply).toContain("- Trust the bound project in Codex so the Profile can load.");
    expect(apply).toContain(
      "- Launch Codex from the exact bound project root so the Profile can load.",
    );
    expect(apply).not.toContain("Declining the hook prevents Profile Context from loading.");
    expect(apply).not.toContain("Grok uses Claude's shared rule path.");
    expect(apply.trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
    const verbose = formatApplyReport(applyResult(report, resultingState), { verbose: true });
    expect(verbose).toContain("Host setup:");
    expect(verbose).toContain("Standing Host setup:");
    expect(verbose).toContain("Grok uses Claude's shared rule path.");
    expect(verbose).toContain("Declining the hook prevents Profile Context from loading.");
    expect(verbose.trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).not.toContain("First use:");
    expect(apply).not.toContain("Trust the bound project in Codex");
    expect(apply).not.toContain("Launch Codex from the exact bound project root");
    const verbose = formatApplyReport(applyResult(receipt, resultingState), { verbose: true });
    expect(verbose).toContain("Standing Host setup:");
    expect(verbose).toContain("Trust the bound project in Codex.");
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).not.toContain("First use:");
    expect(apply).not.toContain("Trust the bound project in Pi");
    const verbose = formatApplyReport(applyResult(receipt, resultingState), { verbose: true });
    expect(verbose).toContain("Standing Host setup:");
    expect(verbose).toContain("Trust the bound project in Pi.");
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));

    expect(apply).not.toContain("First use:");
    expect(apply).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(apply).not.toContain("Host setup:");
    expect(apply).not.toContain("Standing Host setup:");
    expect(apply).not.toContain("Trust the bound project in Codex.");
    expect(apply.trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
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

    expect(formatApplyReport(applyResult(report, resultingState)).trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
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

    expect(apply).not.toContain("First use:");
    expect(apply).not.toContain("Standing Host setup:");
    expect(apply).not.toContain("Grok uses Claude's shared rule path.");
    expect(apply.trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
    const verbose = formatApplyReport(applyResult(report, resultingState), { verbose: true });
    expect(verbose).toContain("Standing Host setup:");
    expect(verbose).toContain("Grok uses Claude's shared rule path.");
  });

  test("no-op apply omits transition setup and the standing reminder", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });

    const output = formatApplyReport(applyResult(report));
    expect(output).not.toContain("becomes active");
    expect(output).not.toContain("First use:");
    expect(output).not.toContain("Host setup:");
    expect(output).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(output).not.toContain("Trust the bound project in Codex.");
    expect(formatApplyReport(applyResult(report), { verbose: true })).not.toContain(
      "becomes active",
    );
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).toContain("First use:\n");
    expect(apply).toContain("- Review and approve the generated SessionStart hook when Codex asks so the Profile can load.\n");
    expect(apply).toContain("- Trust the bound project in Codex so the Profile can load.\n");
    expect(apply).toContain("- Trust the bound project in Pi so the Profile can load.\n");
    expect(apply).not.toContain("/p-1");
    expect(apply).not.toContain("/p-2");
    expect(apply.match(/- Trust the bound project in Codex/g)).toHaveLength(1);
    expect(apply.match(/- Trust the bound project in Pi/g)).toHaveLength(1);
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).toContain(
      "- Launch Codex from the exact bound project root for 2 projects (use --verbose to see all Projects) so the Profile can load.",
    );

    const verbose = formatApplyReport(applyResult(receipt, resultingState), { verbose: true });
    expect(verbose).toContain("- Launch Codex from the exact bound project root: /p-1");
    expect(verbose).toContain("- Launch Codex from the exact bound project root: /p-2");
  });

  test("standing guidance is not triggered by non-host bookkeeping additions or outputs for different hosts", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        hosts: ["claude", "codex"] as const,
        outputs: [".agent-profile-kit/installation.json", ".claude/rules/agent-profile-kit.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [codexTrust()],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [
        { kind: "addition", path: ".agent-profile-kit/installation.json", project: "/project-a" },
        { kind: "addition", path: ".claude/rules/agent-profile-kit.md", project: "/project-a" },
      ],
      outputConsumers: [
        { consumingHosts: [], path: ".agent-profile-kit/installation.json", project: "/project-a" },
        { consumingHosts: ["claude"], path: ".claude/rules/agent-profile-kit.md", project: "/project-a" },
      ],
    });
    const resultingState = emptyReport({
      desired: reportDesired(report),
      items: [{ kind: "current", project: "/project-a" }],
    });

    const apply = formatApplyReport(applyResult(report, resultingState));
    expect(apply).not.toContain("First use:");
    expect(apply).not.toContain("Trust the bound project in Codex");
    expect(apply).toContain(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
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

    const apply = formatApplyReport(applyResult(report, resultingState));
    expect(apply).toContain("First use:\n");
    expect(apply).toContain("- Trust the bound project in Codex (Security warning: remote execution permitted).");
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

    expect(formatApplyReport(applyResult(receipt, resultingState)).trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
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
    expect(formatLifecycleReport("status", report)).toBe(
      "All Projects are current (6 Projects)\n",
    );
    const verbose = formatLifecycleReport("status", report, { verbose: true });
    expect(verbose).toContain(
      "- Trust the bound project in Codex. (/p-1, /p-2, /p-3, /p-4, /p-5, /p-6)",
    );
    expect(verbose).not.toContain("use --verbose");
    expect(verbose.match(/- Trust the bound project in Codex\./g)).toHaveLength(1);
  });

  test("blocked apply suppresses Host setup for work that did not happen", () => {
    const report = emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      desired: [installation("/project-a", [hookApproval(), codexTrust()])],
      items: [{ kind: "blocked", project: "/project-a" }],
    });

    const blockedApply = formatBlockedApplyReport(asBlockedReport(report));
    expect(blockedApply).not.toContain(
      "Review and approve the generated SessionStart hook",
    );
    expect(blockedApply).not.toContain("First use:");
    expect(blockedApply).not.toContain("Host setup:");
    expect(blockedApply).not.toContain("Standing Host setup:");
    expect(blockedApply).not.toContain("Trust the bound project in Codex.");
  });

  test("post-commit verification failure retains apply setup without claiming activation", () => {
    const report = emptyReport({
      desired: [installation("/project-a", [codexTrust()])],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const failure = formatApplyVerificationFailure(report, "Verification failed.");

    expect(failure).toContain("First use:");
    expect(failure).toContain("- Trust the bound project in Codex so the Profile can load.");
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
    const status = formatLifecycleReport("status", report, {
      context: context(40),
      project,
    });
    const emptyStatus = formatLifecycleReport("status", emptyReport(), { context: context(40) });

    expect(status).toContain(project);
    expect(status).toContain("apkit apply");
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
        class: "exclusion-section",
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

    const output = formatLifecycleReport("status", report, {
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
    const output = formatLifecycleReport("status", report, { context: context(40) });

    expect(output).toContain(value);
    expect(output).not.toContain("generated diagnostic path with\n");
  });

  test("wraps prose after a suffixless path without widening the line", () => {
    const path = "/tmp/foo";
    const output = formatLifecycleReport("status", emptyReport({
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
    const output = formatLifecycleReport("status", emptyReport({
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

    expect(output.split("\n").some((line) => line.includes(receipt.project!))).toBe(true);
    expect(output).toContain("- Trust the bound project in Codex.");
    expect(output.split("\n")).toContain(`    ${receipt.temporaryInstallationId}`);
    expect(output).toContain(`apkit remove-temp ${receipt.temporaryInstallationId}`);
    expect(output).toContain("  Consequence: Profile Context does");
    expect(output).toContain(diagnosticValue);
    expect(output).not.toContain("generated diagnostic path with\n");
    expect(output.replace(/\s+/g, " ")).toContain(
      "Consequence: Profile Context does not load until the project is trusted.",
    );
    for (const line of output.trimEnd().split("\n")) {
      if (line.includes(receipt.project!) || line.includes("apkit remove-temp")) continue;
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
  const ready = formatLifecycleReport("status", identityReport("/project-a"));
  const blocked = formatLifecycleReport(
    "status",
    emptyReport({
      blockers: [fixtureBlocker("occupied output", "/project-a")],
      items: [{ kind: "blocked", project: "/project-a" }],
    }),
  );

  expect(ready).toContain("Updates ready");
  expect(renderHumanOutput(ready, context)).toContain(
    "\u001b[32mUpdates ready for 1 project (1 file addition).\u001b[0m",
  );
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
    expect(receipt).toContain("Configured Projects preserved.");
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

    for (const command of ["status", "apply"] as const) {
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
    expect(formatLifecycleReport("status", structured)).toContain(
      "Blocker: Codex CLI is unavailable",
    );
    const machine = machineReport([
      machineProject("/project-a", { blockers: reportBlockers(structured) }),
    ]);
    expect(JSON.parse(formatLifecycleJson("status", machine))).toMatchObject({
      schemaVersion: 12,
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
        warnings: [{ copyableValues: [value], kind: "diagnostic", message }],
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

    const concise = formatLifecycleReport("status", report);

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

    const verbose = formatLifecycleReport("status", report, { verbose: true });

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

    const concise = formatLifecycleReport("status", report);

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

    const verbose = formatLifecycleReport("status", report, { verbose: true });

    expect(verbose).toContain("Projects:\n.: addition\n");
    expect(verbose).not.toContain(`Projects:\n${project}: addition\n`);
  });

  test("identifies an ancestor project relative to the working directory", () => {
    const project = dirname(process.cwd());
    const report = identityReport(project);

    const verbose = formatLifecycleReport("status", report, { verbose: true });

    expect(verbose).toContain("Projects:\n..: addition\n");
    expect(verbose).not.toContain(`Projects:\n${project}: addition\n`);
  });

  test("identifies another home project with a home-relative path", () => {
    const project = join(homedir(), "another-project");
    const report = identityReport(project);

    const verbose = formatLifecycleReport("status", report, { verbose: true });

    expect(verbose).toContain("Projects:\n~/another-project: addition\n");
    expect(verbose).not.toContain(`Projects:\n${project}: addition\n`);
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

    expect(concise).toContain("Applied:\n  + 1 generated file addition in ~/receipt-project");
    expect(concise).not.toContain(`- ${project}:`);

    const verbose = formatApplyReport(applyResult(receipt, emptyReport()), { verbose: true });
    expect(verbose).toContain("Applied:\nProjects:\n~/receipt-project: addition");
    expect(verbose).toContain("~/receipt-project/a.md: addition");
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
    expect(concise).not.toContain("All Projects were already current.");
    expect(concise).toContain("Applied:\n  + 1 generated file addition in 1 project");
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

    const verbose = formatLifecycleReport("status", report, { verbose: true });

    expect(verbose).toContain(
      "~/multi-host-project: Profile coding\n  Hosts: claude, codex\n",
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

    const verbose = formatLifecycleReport("status", report, { verbose: true });

    expect(verbose).toContain("~/team-a/project: addition");
    expect(verbose).toContain("~/team-b/project: addition");
  });

  test("keeps an outside-home project absolute", () => {
    const project = "/var/tmp/outside-home-project";
    const report = identityReport(project);

    expect(formatLifecycleReport("status", report, { verbose: true })).toContain(
      `Projects:\n${project}: addition\n`,
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

    const verbose = formatLifecycleReport("status", aliasedReport, { verbose: true });

    expect(verbose).toContain(`Projects:\n${authoredProject}: addition\n`);
    expect(verbose).not.toContain(`Projects:\n${canonicalProject}: addition\n`);
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

    const verbose = formatLifecycleReport("status", aliasedReport, { verbose: true });

    expect(verbose).toContain(`Projects:\n${authoredProject}: addition\n`);
    expect(verbose).not.toContain(`Projects:\n${canonicalProject}: addition\n`);
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
        formatLifecycleReport("status", report),
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

    const conciseStatus = formatLifecycleReport("status", report);
    expect(conciseStatus).toContain("/tmp/reconcile/generated-output");
    expect(conciseStatus).toContain("'reconcile'");
    expect(conciseStatus).not.toContain(`Project: ${project}`);
    expect(conciseStatus).not.toContain(exclusionTarget);
    expect(conciseStatus).not.toContain(exclusionEntry);

    const apply = formatApplyReport(applyResult(report));
    expect(apply).toContain(`Project: ${project}`);
    expect(apply).toContain("Profile: reconcile");
    expect(apply).toContain("generated-output/reconcile");

    const verbose = formatLifecycleReport("status", report, { verbose: true });
    expect(verbose).toContain(project);
    expect(verbose).toContain("Profile reconcile");
    expect(verbose).toContain("generated-output/reconcile");
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

  test("concise status keeps only drift and destructive-removal paths", () => {
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

    const concise = formatLifecycleReport("status", report);

    expect(concise).toContain(
      "Project exceptions:\n" +
      "  /project-a:\n" +
      "    ! f.md (drifted output)\n" +
      "    - e.md",
    );
    expect(concise).not.toContain("a.md");
    expect(concise).not.toContain("b.md");
    expect(concise).not.toContain("c.md");
    expect(concise).not.toContain("d.md");
    expect(concise).toContain("Details: apkit status --verbose");
    expect(concise).not.toContain("Selected setup:");
    expect(concise).not.toContain("Outputs:");
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

    const concise = formatLifecycleReport("status", report);

    expect(concise).toContain("    - z.md");
    expect(concise).not.toContain("m.md");
    expect(concise).not.toContain("a.md");
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

    const concise = formatLifecycleReport("status", report);

    expect(concise).not.toContain("file-01.md");
    expect(concise).not.toContain("file-12.md");
    expect(concise.match(/Details:/g)).toHaveLength(1);
    expect(concise).toContain("Details: apkit status --verbose");

    const verbose = formatLifecycleReport("status", report, { verbose: true });
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

    const concise = formatLifecycleReport("status", report);

    expect(concise).toContain("! z-attention.md (drifted output)");
    expect(concise).toContain("- z-removal.md");
    expect(concise).not.toContain("a-1.md");
    expect(concise).not.toContain("more files");
    expect(concise).toContain("Details: apkit status --verbose");
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
      } else if (["drifted output", "malformed ownership state", "missing output", "stale source"].includes(kind)) {
        expect(concise).toContain(`State: ${kind}`);
      } else {
        expect(concise).toStartWith("Updates ready for 1 project");
        expect(concise).not.toContain("State:");
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

    for (const command of ["status", "apply"] as const) {
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

    const concise = formatLifecycleReport("status", report);

    expect(concise).not.toContain("Git exclusions:");
    expect(concise).not.toContain(target);
    expect(concise).not.toContain("/.old-path.md");
    expect(concise).toContain("Details: apkit status --verbose");

    const verbose = formatLifecycleReport("status", report, { verbose: true });
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
        class: "exclusion-section",
        entries: ["/.agent-profile-kit/codex/context.md"],
        target: "/repo/.git/info/exclude",
      }],
      warnings: [
        "/repo/.git/info/exclude is missing its Agent Profile Kit exclusion section; apply will restore recorded exact entries",
      ],
    });

    const concise = formatLifecycleReport("status", report);

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

    const verbose = formatLifecycleReport("status", report, { verbose: true });

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
        class: "exclusion-section",
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

    const status = formatLifecycleReport("status", receipt);
    expect(status).toContain("Git exclusions: 1 recorded entry to restore.");
    expect(status).toContain("Details: apkit status --verbose");
    expect(status).not.toContain("/repo/.git/info/exclude");
    expect(status).not.toContain("/.agent-profile-kit/codex/context.md");

    for (const command of ["status"] as const) {
      const verbosePending = formatLifecycleReport(command, receipt, { verbose: true });
      expect(verbosePending).toContain(
        "/repo/.git/info/exclude: will restore 1 recorded Git exclusion entry",
      );
      expect(verbosePending).not.toContain(
        "/repo/.git/info/exclude: restored 1 recorded Git exclusion entry",
      );
    }

    const concise = formatApplyReport(applyResult(receipt, result));
    expect(concise).not.toContain("Git exclusions: 1 recorded entry restored.");
    expect(concise).not.toContain("All Projects were already current.");
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

    const concise = formatApplyExecutionFailure({
      failedProject: "/failed",
      message: "Apply failed",
      pendingProjects: [],
      receipt,
      resultingState,
    });

    expect(concise).toContain("Freshly current: /applied");
    expect(concise).not.toContain("Freshly current: /already-current");
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
    const direct = /^Next: (.+)$/m.exec(reportText);
    if (direct !== null) return [direct[1]!];
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
    expect(next[0]).toMatch(/apply/i);
    expect(next[0]).not.toMatch(/status|bind/i);
    expect(concise).toContain("Updates ready for 1 project (1 file update).");
    expect(concise).not.toContain("State: stale source");
    expect(concise).not.toContain("a.md");
    expect(concise).toContain("Details: apkit status --verbose");
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

    const concise = formatLifecycleReport("status", report);
    const next = nextActionLines(concise);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/apkit apply/);
    expect(concise).toContain("Updates ready for 1 project (1 file addition).");
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

    const status = formatLifecycleReport("status", report);
    const statusNext = nextActionLines(status);
    expect(statusNext).toHaveLength(1);
    expect(statusNext[0]).toMatch(/resolve/i);
    expect(statusNext[0]).toMatch(/blocker/i);
    expect(statusNext[0]).toMatch(/apkit status/);
    expect(statusNext[0]).not.toMatch(/apply/i);
    expect(status).toContain("Cannot apply");
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

    expect(nextActionLines(formatLifecycleReport("status", current))).toEqual([]);
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

    const status = formatLifecycleReport("status", current);

    expect(status).toStartWith("All Projects are current (1 Project)\n");
    expect(status).not.toContain("Host attention required");
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
    // Apply already completed; do not recommend another apply or status.
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
    expect(metadataOnly).not.toContain("All Projects were already current.");
    expect(
      formatApplyReport(applyResult(metadataOnlyReceipt, metadataOnlyResult), { verbose: true }),
    ).toContain("update");
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
        "- /project-a: After all blockers are resolved, run apkit apply --all.\n" +
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
    expect(nextActionLines(mixedStatus)).toEqual(["apkit apply --all"]);
    expect(mixedStatus).toContain("Details: apkit status --all --verbose");
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
    expect(nextActionLines(formatLifecycleReport("status", report, { verbose: true }))).toEqual([]);
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
      }],
    });

    const status = formatLifecycleReport("status", report);
    expect(status).toContain("Updates ready for 1 project.");
    expect(status).not.toContain("Git exclusions:");
    expect(status).toContain("Details: apkit status --verbose");
    expect(nextActionLines(status)).toEqual(["apkit apply"]);
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

  test("lifecycle JSON publishes complete nested Project evidence under schema version 7", () => {
    const blocker = fixtureBlocker("CLI missing", project);
    const report = machineReport([
      machineProject(project, {
        desired,
        state: { kind: "addition" },
        outputs: [{ kind: "addition", path: "a.md", consumingHosts: ["codex"] }],
        blockers: [blocker],
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
        repositoryExclusionRepairs: [{
          class: "exclusion-section",
          entries: ["/.agent-profile-kit/"],
          target: "/project-a/.git/info/exclude",
        }],
      }),
    ]);

    const payload = JSON.parse(formatLifecycleJson("status", report));
    expect(payload.schemaVersion).toBe(12);
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
        kind: "occupied-output",
        message: "CLI missing",
        problem: "CLI missing",
        project,
        remedy: "Resolve the reported blocker, then retry",
        requirement: "Lifecycle commands cannot proceed while blocked",
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
      repositoryExclusionRepairs: [{
        class: "exclusion-section",
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
        warnings: [{ message: "Review A", copyableValues: ["/copy/a"], kind: "diagnostic" }],
        repositoryExclusions: [{
          current: [],
          next: ["/a"],
          target: "/repo-a/.git/info/exclude",
        }],
      }),
      machineProject("/project-b", {
        warnings: [{ message: "Review B", copyableValues: ["/copy/b"], kind: "diagnostic" }],
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
    expect(payload.schemaVersion).toBe(12);
    expect(payload.projects[0].state).toEqual({ kind: "current" });
    expect(payload.applied.projects[0].state).toEqual({ kind: "addition" });
  });

  test("blocked apply JSON has no applied snapshot", () => {
    const report = machineReport([
      machineProject(project, { blockers: [fixtureBlocker("CLI missing", project)] }),
    ]);

    const payload = JSON.parse(formatBlockedApplyJson(report));
    expect(payload).toMatchObject({ command: "apply", outcome: "blocked", schemaVersion: 12 });
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
      schemaVersion: 12,
    });
    expect(payload.projects).toEqual([]);
    expect(payload.applied.projects[0].outputs).toEqual([
      { kind: "addition", path: "a.md", consumingHosts: ["codex"] },
    ]);
  });

  test("tool-error JSON uses the empty nested model", () => {
    for (const command of ["status", "apply"] as const) {
      expect(JSON.parse(formatLifecycleToolErrorJson(command, "missing"))).toEqual({
        schemaVersion: 12,
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
      installationState: "/home/.agents/agent-profile-kit/state/manifest.json",
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
    expect(output).toContain("Installation State: ~/.agents/agent-profile-kit/state/manifest.json");
    // Without a context the deterministic layout is preserved byte-for-byte.
    expect(formatInfoHuman(info, {}, "/home", "/work")).toBe(
      "Engine version: 0.67.0\n" +
        "Workspace: ~/.agents/agent-profile-kit/workspace\n" +
        "Local Configuration: ~/.agents/agent-profile-kit/config.yaml\n" +
        "Installation State: ~/.agents/agent-profile-kit/state/manifest.json\n",
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
        "    Configured Project inventory from settings.\n" +
        "  apkit list profiles\n" +
        "    Profile inventory from the selected Workspace.\n" +
        "  apkit list hosts\n" +
        "    Supported Agent Hosts for configured Projects.\n" +
        "  apkit list temporary\n" +
        "    Active temporary Profile inventory.\n",
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
        "Use apkit status to inspect Project lifecycle diagnostics.\n",
    );
  });

  test("profile and temporary inventory wrap prose at the selected width", () => {
    const profiles = formatProfileInventoryHuman(
      [{ contextModules: 2, id: "engineering", skills: 3 }],
      { context: context(40) },
    );
    for (const line of profiles.split("\n")) {
      if (line.includes("apkit ")) continue;
      expect(line.length, `line exceeds selected width: ${line}`).toBeLessThanOrEqual(40);
    }
    expect(profiles).toContain("Profile: engineering");
    expect(profiles.replace(/\s+/g, " ")).toContain(
      "Use <profile> with apkit bind to select it for a configured Project.",
    );
    expect(profiles).not.toContain("Next:");

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
    expect(temporary.replace(/\s+/g, " ")).toContain(
      "Use apkit remove-temp <temporary-installation-id> to remove one when finished.",
    );
    expect(temporary).not.toContain("Next:");
    expect(formatTemporaryInventoryHuman([], {}, "/home", "/work")).toBe(
      "No temporary Profiles are active.\n" +
        "Use apkit install-temp <profile> <project> --host <host> to create one.\n",
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
    expect(output).toContain("Warning:");
    expect(output).toContain("Next: apkit status");
    expect(formatValidationResult({
      bindings: 0,
      hosts: [],
      profiles: [],
      warnings: [],
    })).toBe(
      "Workspace and settings valid (0 Profiles, 0 configured Projects)\n" +
        "Profiles found: none\n" +
        "Hosts bound: none\n" +
        "Next: apkit bind <profile> --host <host>\n",
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
      "No ordinary Agent Profile Kit-owned output is installed.\n\nConfigured Projects preserved.\n",
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

  test("multi-Project status groups observable operations without inferring artifact causality", () => {
    const concise = formatLifecycleReport("status", sharedSkillFleet());

    expect(concise).toBe(
      "Updates ready for 3 projects (3 file updates).\n" +
        "Next: apkit apply --all\n\n" +
        "Details: apkit status --all --verbose\n",
    );
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

    const concise = formatLifecycleReport("status", report);

    expect(concise).toStartWith(
      "Updates ready for 3 projects.\n" +
        "+ 1 file addition in /project-a\n" +
        "~ 2 file updates in /project-a, /project-b\n" +
        "~ 1 file repair in /project-b\n" +
        "- 1 file removal in /project-c\n",
    );
    expect(concise).not.toContain("Projects: 3");
    expect(concise).not.toContain("Project changes:");
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

    expect(formatLifecycleReport("status", report)).toStartWith(
      "Updates ready for 5 projects (5 file updates).\n",
    );
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
      }],
    });

    const concise = formatLifecycleReport("status", report, { project: "/project-a" });

    expect(concise).toBe(
      "Updates ready for 1 project (1 file update).\n" +
        "Next: apkit apply /project-a\n\n" +
        "Details: apkit status /project-a --verbose\n",
    );
    expect(concise).not.toContain(SKILL_PATH);
    expect(concise).not.toContain("Git exclusion");
    expect(concise).not.toContain(".git/info/exclude");
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

    const concise = formatLifecycleReport("status", report);

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

    expect(formatLifecycleReport("status", report)).toContain(
      "Project exceptions:\n  /project-a:\n    ! .agents/skills/review-pr (drifted output)",
    );
  });

  test("verbose retains complete per-Project operation evidence", () => {
    const verbose = formatLifecycleReport("status", sharedSkillFleet(), { verbose: true });

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

    const status = formatLifecycleReport("status", report);
    expect(status).toContain("Updates ready for 1 project (1 file addition).");
    expect(status).not.toContain("Projects: 1");
    expect(status).not.toContain("Blockers: 0");
    expect(status).not.toContain("Changes: none");

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

    const status = formatLifecycleReport("status", report);
    expect(status).toContain("Cannot apply");
    expect(status).toContain("Blockers: 1");
    expect(status).not.toContain("Blockers: 0");

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

    const status = formatLifecycleReport("status", report);
    expect(status).toContain("Next: apkit apply --all");
    expect(status).not.toContain("/project-a: apkit apply --all");
    expect(status.match(/Next: apkit apply --all/g)).toHaveLength(1);
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

    const status = formatLifecycleReport("status", report, { project: "/project-a" });
    expect(status).toContain("Next: apkit apply /project-a");
    expect(status).toContain("Details: apkit status /project-a --verbose");
    expect(status).not.toContain("/private/project-a");
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
        "- /project-a: After all blockers are resolved, run apkit apply --all.\n" +
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
    expect(apply).toContain("Applied:\n  + 1 generated file addition in 1 project");
    expect(apply).not.toContain("All Projects were already current.");
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
        class: "exclusion-section",
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
    expect(apply).toBe(
      "Apply complete\n\nProfile coding will load the next time you launch a configured Host from a bound Project root.\n",
    );
    expect(apply).not.toContain("All Projects were already current.");
    expect(apply).not.toContain("Project: /repo");
    expect(apply).not.toContain("State: current");

    const verbose = formatApplyReport(applyResult(receipt, resultingState), { verbose: true });
    expect(verbose).toContain("restored 1 recorded Git exclusion entry");
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
    expect(apply).toContain("Applied:\n  ~ 1 generated file update in 1 project");
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
        { kind: "drifted output", path: "b.md", project: "/project-b" },
      ],
    });

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).toContain("Apply completed with attention");
    expect(apply).toContain("Applied:\n  ~ 2 generated file updates in 2 projects");
    expect(apply).toContain("Project: /project-b");
    expect(apply).toContain("State: drifted output");
    expect(apply).toContain("! b.md");
    expect(apply).not.toContain("Project: /project-a");
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

    const status = formatLifecycleReport("status", report);
    expect(status).toBe("All Projects are current (1 Project)\n");
    expect(status).not.toContain("Ready to apply");
    expect(status).not.toContain("Blockers: 0");
    expect(status).not.toContain("Changes: none");
    expect(status).not.toContain("Projects: 1");
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

    const apply = formatApplyReport(applyResult(report));
    expect(apply).toBe(
      "Apply complete\n" +
        "All Projects were already current.\n\n" +
        "Warnings:\n" +
        "- Project /project-a carries an adapter warning.\n",
    );
    expect(apply).not.toContain("Applied:");
    expect(apply).not.toContain("Host setup:");
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
      }],
    });

    const apply = formatBlockedApplyReport(asBlockedReport(report));
    expect(apply).toContain("Apply blocked");
    expect(apply).toContain("Git exclusions: 1 entry to add.");
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).toContain("Apply completed with blockers");
    expect(apply).toContain("Applied:\n\nGit exclusions: 1 entry added.");
    expect(apply).toContain("Freshly current: /project-a");
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
    expect(apply.match(/will load the next time you launch/g)).toHaveLength(1);
    expect(apply).toContain(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
    expect(apply).not.toContain("from /project-a");
    expect(apply).not.toContain("from /project-b");
    expect(apply).not.toContain("becomes active");
    expect(apply).not.toContain("bound Host");
    expect(apply.trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply.match(/will load the next time you launch/g)).toHaveLength(1);
    expect(apply.trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
    expect(apply).not.toContain("becomes active");
    expect(apply).not.toContain("bound Host");
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply.match(/will load the next time you launch/g)).toHaveLength(1);
    expect(apply.trimEnd()).toEndWith(
      "2 Profiles will load the next time you launch a configured Host from a bound Project root.",
    );
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).not.toContain("..");
    expect(apply.trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
    );
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

    const apply = formatApplyReport(applyResult(receipt, resultingState));
    expect(apply).not.toContain("After completing the Host setup above");
    expect(apply).not.toContain("No further Host setup is required");
    expect(apply.trimEnd()).toEndWith(
      "Profile coding will load the next time you launch a configured Host from a bound Project root.",
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

    const verbose = formatLifecycleReport("status", report, { verbose: true });
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
    const payload = JSON.parse(formatLifecycleJson("status", machine)) as {
      readonly command: string;
      readonly outcome: string;
      readonly schemaVersion: number;
    };
    expect(payload).toMatchObject({
      command: "status",
      outcome: "attention",
      schemaVersion: 12,
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
    const zeroProjects = formatValidationResult({
      bindings: 0,
      hosts: [],
      profiles: ["engineering"],
      warnings: [],
    });
    expect(zeroProjects).toContain("Workspace and settings valid (1 Profile, 0 configured Projects)");
    expect(zeroProjects).toContain("Profiles found: engineering");
    expect(zeroProjects).toContain("Hosts bound: none");
    expect(zeroProjects).toContain("Next: apkit bind <profile> --host <host>");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(zeroProjects).not.toMatch(term);

    const oneProject = formatValidationResult({
      bindings: 1,
      hosts: ["codex"],
      profiles: ["engineering"],
      warnings: [],
    });
    expect(oneProject).toContain("Workspace and settings valid (1 Profile, 1 configured Project)");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(oneProject).not.toMatch(term);

    const multiProjects = formatValidationResult({
      bindings: 3,
      hosts: ["codex", "claude"],
      profiles: ["engineering", "design"],
      warnings: [],
    });
    expect(multiProjects).toContain("Workspace and settings valid (2 Profiles, 3 configured Projects)");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(multiProjects).not.toMatch(term);
  });

  test("routine inventory topics and temporary inventory use newcomer lexicon", () => {
    const index = formatInventoryIndex();
    expect(index).toContain("Configured Project inventory from settings.");
    expect(index).toContain("Active temporary Profile inventory.");
    expect(index).not.toContain("Installation State");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(index).not.toMatch(term);

    const emptyTemp = formatTemporaryInventoryHuman([]);
    expect(emptyTemp).toContain("No temporary Profiles are active.");
    expect(emptyTemp).toContain("Use apkit install-temp <profile> <project> --host <host> to create one.");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(emptyTemp).not.toMatch(term);

    const activeTemp = formatTemporaryInventoryHuman([
      {
        host: "codex",
        profileId: "engineering",
        project: "/project-a",
        temporaryInstallationId: "temp-12345",
      },
    ]);
    expect(activeTemp).toContain("Temporary Profiles (1):");
    expect(activeTemp).toContain("Temporary installation: temp-12345");
    expect(activeTemp).toContain("Use apkit remove-temp <temporary-installation-id> to remove one when finished.");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(activeTemp).not.toMatch(term);
  });

  test("routine teardown receipts preserve configured Projects in user-facing vocabulary", () => {
    const uninstall = formatUninstallResult({
      projects: [{
        outputs: [".agent-profile-kit/installation.json", ".codex/hooks.json"],
        project: "/project-a",
        repositoryExclusions: [],
      }],
    });
    expect(uninstall).toContain("Configured Projects preserved.");
    expect(uninstall).toContain("Next: Run apkit unbind for configured Projects you no longer want, or apkit apply to reinstall.");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(uninstall).not.toMatch(term);
  });

  test("empty status references configured Projects in next guidance", () => {
    const empty = formatLifecycleReport("status", emptyReport());
    expect(empty).toContain("No Projects are configured.");
    expect(empty).toContain("Next: Run apkit list projects to inspect configured Projects, or apkit bind <profile> --host <host> to configure one.");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(empty).not.toMatch(term);
  });

  test("temporary install and remove receipts use newcomer lexicon", () => {
    const install = formatTemporaryInstallationHuman("install-temp", {
      completionState: "installed",
      diagnosticValues: [],
      host: "codex",
      outputs: [".codex/hooks.json"],
      profileId: "engineering",
      project: "/project-a",
      repositoryExclusion: undefined,
      setupSteps: [],
      temporaryInstallationId: "temp-987",
      warnings: [],
    });
    expect(install).toContain("Installed temporary Profile");
    expect(install).toContain("Temporary installation: temp-987");
    expect(install).toContain("Next: apkit remove-temp temp-987");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(install).not.toMatch(term);

    const remove = formatTemporaryInstallationHuman("remove-temp", {
      completionState: "removed",
      diagnosticValues: [],
      host: "codex",
      outputs: [],
      repositoryExclusion: undefined,
      setupSteps: [],
      temporaryInstallationId: "temp-987",
      warnings: [],
    });
    expect(remove).toContain("Removed temporary Profile");
    expect(remove).toContain("Temporary installation: temp-987");
    for (const term of INTERNAL_ONLY_DEFAULT_TERMS) expect(remove).not.toMatch(term);
  });

  test("technical surfaces (info, verbose, JSON, actionable recovery) retain canonical domain terms", () => {
    const info = formatInfoHuman({
      configurationState: "current",
      engineVersion: "0.114.0",
      installationState: "/home/user/.agents/agent-profile-kit/state/manifest.json",
      localConfiguration: "/home/user/.agents/agent-profile-kit/config.yaml",
      workspace: { authored: "~/workspace", canonical: "/home/user/workspace" },
    });
    expect(info).toContain("Local Configuration:");
    expect(info).toContain("Installation State:");

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
    const verbose = formatLifecycleReport("status", report, { verbose: true });
    expect(verbose).toContain("Host Setup:");

    const missingProfile = formatMissingProfileError({
      availableProfiles: ["coding"],
      message: "Profile 'unknown' not found",
      name: "MissingProfileError",
      profile: "unknown",
      recoverByEditingLocalConfiguration: true,
    });
    expect(missingProfile).toContain("Edit Local Configuration directly");
  });
});

