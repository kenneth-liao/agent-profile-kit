import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { HostSetupStep } from "../adapters/project-plan.js";
import {
  formatBlockedApplyReport,
  formatApplyReport,
  formatApplyVerificationFailure,
  formatLifecycleReport,
  INTERNAL_ONLY_DEFAULT_TERMS,
  NON_CURRENT_STATE_ORDER,
} from "../cli/presentation.js";
import type {
  ApplyReconciliationResult,
  BlockedReconciliationReport,
  ReconciliationKind,
  ReconciliationReport,
} from "../installer/reconcile.js";

function asBlockedReport(report: ReconciliationReport): BlockedReconciliationReport {
  const [blocker, ...remainingBlockers] = report.blockers;
  if (!blocker) throw new Error("blocked report fixture requires a blocker");
  return { ...report, blockers: [blocker, ...remainingBlockers] };
}

type DesiredFixture = Omit<ReconciliationReport["desired"][number], "hosts" | "setupSteps"> & {
  readonly hosts?: ReconciliationReport["desired"][number]["hosts"];
  readonly setupSteps?: ReconciliationReport["desired"][number]["setupSteps"];
};

function emptyReport(
  overrides: Omit<Partial<ReconciliationReport>, "desired"> & {
    readonly desired?: readonly DesiredFixture[];
  } = {},
): ReconciliationReport {
  return {
    blockers: [],
    items: [],
    outputs: [],
    repositoryExclusionRepairs: [],
    repositoryExclusions: [],
    warnings: [],
    ...overrides,
    desired: (overrides.desired ?? []).map((installation) => ({
      hosts: ["codex"],
      setupSteps: [],
      ...installation,
    })),
  };
}

function applyResult(
  receipt: ReconciliationReport,
  resultingState: ReconciliationReport = receipt,
): ApplyReconciliationResult {
  return { receipt, resultingState };
}

function identityReport(
  project: string,
  hosts: ReconciliationReport["desired"][number]["hosts"] = ["codex"],
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

describe("Host Setup Step presentation", () => {
  test("preview renders approval and launch constraints but omits other setup steps", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [
          { host: "codex", kind: "approval-required", message: "Approve the hook." },
          { host: "codex", kind: "trust-required", message: "Trust the project." },
          { host: "codex", kind: "launch-constraint", message: "Launch from the root." },
          { host: "codex", kind: "shared-path", message: "Use the shared path." },
        ],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const preview = formatLifecycleReport("preview", report);

    expect(preview).toContain("Approve the hook.");
    expect(preview).toContain("Launch from the root.");
    expect(preview).not.toContain("Trust the project.");
    expect(preview).not.toContain("Use the shared path.");
    const verbose = formatLifecycleReport("preview", report, { verbose: true });
    expect(verbose).toContain("Approve the hook.");
    expect(verbose).toContain("Launch from the root.");
    expect(verbose).not.toContain("Trust the project.");
    expect(verbose).not.toContain("Use the shared path.");
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
        setupSteps: [{
          host: "codex",
          kind: "launch-constraint",
          message: "Launch from the exact bound project root:",
          path: "bound-project",
        }],
      }],
      items: [{ kind: "addition", project: "/private/project-a" }],
    });

    const preview = formatLifecycleReport("preview", report);

    expect(preview.split("\n").find((line) => line.startsWith("- Launch from"))).toBe(
      "- Launch from the exact bound project root: /project-a",
    );
  });

  test("apply renders every setup kind and closes with next-launch activation guidance", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [
          { host: "codex", kind: "approval-required", message: "Approve the hook." },
          { host: "codex", kind: "trust-required", message: "Trust the project." },
          { host: "codex", kind: "launch-constraint", message: "Launch from the root." },
          { host: "codex", kind: "shared-path", message: "Use the shared path." },
        ],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
    });
    const resultingState = emptyReport({
      desired: report.desired,
      items: [{ kind: "current", project: "/project-a" }],
    });

    const apply = formatApplyReport(applyResult(report, resultingState));

    expect(apply).toContain("Approve the hook.");
    expect(apply).toContain("Trust the project.");
    expect(apply).toContain("Launch from the root.");
    expect(apply).toContain("Use the shared path.");
    expect(apply.trimEnd()).toEndWith(
      "After completing the Host setup above, Profile coding becomes active on the next launch " +
        "of each bound Host (codex) from /project-a.",
    );
    const verbose = formatApplyReport(applyResult(report, resultingState), { verbose: true });
    expect(verbose).toContain("Use the shared path.");
    expect(verbose.trimEnd()).toEndWith(
      "After completing the Host setup above, Profile coding becomes active on the next launch " +
        "of each bound Host (codex) from /project-a.",
    );
  });

  test("no-op apply does not claim next-launch activation", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [{ host: "codex", kind: "trust-required", message: "Trust it." }],
      }],
      items: [{ kind: "current", project: "/project-a" }],
    });

    expect(formatApplyReport(applyResult(report))).not.toContain("becomes active");
    expect(formatApplyReport(applyResult(report), { verbose: true })).not.toContain(
      "becomes active",
    );
  });

  test("status deduplicates repeated steps into one callout per Host", () => {
    const repeatedSteps: readonly HostSetupStep[] = [
      { host: "codex", kind: "approval-required" as const, message: "Approve the hook." },
      { host: "codex", kind: "trust-required" as const, message: "Trust the project." },
    ];
    const report = emptyReport({
      desired: ["/project-a", "/project-b"].map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
        setupSteps: repeatedSteps,
      })),
      items: [
        { kind: "current", project: "/project-a" },
        { kind: "current", project: "/project-b" },
      ],
    });

    const status = formatLifecycleReport("status", report);

    expect(status.match(/Codex setup:/g)).toHaveLength(1);
    expect(status.match(/Approve the hook\./g)).toHaveLength(1);
    expect(status.match(/Trust the project\./g)).toHaveLength(1);
  });

  test("blocked preview and apply suppress post-apply setup while status retains its reminder", () => {
    const report = emptyReport({
      blockers: [{ message: "occupied output", project: "/project-a" }],
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [
          { host: "codex", kind: "approval-required", message: "Approve the hook." },
        ],
      }],
      items: [{ kind: "blocked", project: "/project-a" }],
    });

    expect(formatLifecycleReport("preview", report)).not.toContain("Approve the hook.");
    expect(formatBlockedApplyReport(asBlockedReport(report))).not.toContain("Approve the hook.");
    expect(formatLifecycleReport("status", report)).toContain("Approve the hook.");
  });

  test("post-commit verification failure retains apply setup without claiming activation", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project: "/project-a",
        resolvedArtifacts: [],
        setupSteps: [
          { host: "codex", kind: "trust-required", message: "Trust the project." },
        ],
      }],
      items: [{ kind: "addition", project: "/project-a" }],
    });

    const failure = formatApplyVerificationFailure(report, "Verification failed.");

    expect(failure).toContain("Trust the project.");
    expect(failure).not.toContain("becomes active");
  });
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
      blockers: [{
        message: "/project-a/a.md is occupied by unowned or drifted output",
        project: "/project-a",
      }],
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

  test("uses the short project identity in the apply receipt", () => {
    const project = join(homedir(), "receipt-project");
    const receipt = identityReport(project);

    const concise = formatApplyReport(applyResult(receipt, emptyReport()));

    expect(concise).toContain("- ~/receipt-project: 1 generated file addition\n");
    expect(concise).not.toContain(`- ${project}:`);
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
    const report = emptyReport({
      desired: [first, second].map((project) => ({
        canonicalProject: project,
        context: "composed",
        outputs: ["a.md"],
        profile: "coding",
        project,
        resolvedArtifacts: [],
      })),
      items: [first, second].map((project) => ({ kind: "addition" as const, project })),
      outputs: [first, second].map((project) => ({
        kind: "addition" as const,
        path: "a.md",
        project,
      })),
    });

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("Project: ~/team-a/project\n");
    expect(concise).toContain("Project: ~/team-b/project\n");
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
      ...report,
      desired: report.desired.map((installation) => ({
        ...installation,
        project: authoredProject,
      })),
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
      ...report,
      desired: report.desired.map((installation) => ({
        ...installation,
        project: authoredProject,
      })),
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
          reason: "Profile Installation desired state needs reconciliation",
        }],
        outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
        repositoryExclusions: [{
          current: [],
          next: ["/a.md"],
          target: "/project-a/.git/info/exclude",
        }],
        warnings: [
          "Installer-owned generated output differs from its Installation Manifest Artifact ID; " +
          "reconcile reconciles reconciled reconciling reconciliation",
        ],
        blockers: kind === "blocked"
          ? [
              {
                message: "/project-a: Cannot reconcile Profile Installation desired state",
                project: "/project-a",
              },
              {
                message: "Installer-owned generated output has a Repository Exclusion Artifact ID blocker",
              },
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
      expect(view).toContain(exclusionTarget);
      expect(view).toContain(exclusionEntry);
      expect(view).toContain("/tmp/reconcile/generated-output");
      expect(view).toContain("'reconcile'");
    }
  });

  test("layers vocabulary in apply verification failures", () => {
    const receipt = emptyReport({
      items: [{ kind: "addition", project: "/project-a" }],
      outputs: [{ kind: "addition", path: "a.md", project: "/project-a" }],
    });

    const view = formatApplyVerificationFailure(
      receipt,
      "Cannot reconcile Profile Installation desired state from its Installation Manifest Artifact ID",
    );

    expectUserFacingVocabulary(view);

    const verbose = formatApplyVerificationFailure(
      receipt,
      "Cannot reconcile Profile Installation desired state from its Installation Manifest Artifact ID",
      { verbose: true },
    );
    expect(verbose).toContain(
      "Cannot reconcile Profile Installation desired state from its Installation Manifest Artifact ID",
    );
    expect(verbose).toContain("Repository Exclusions:");
    expect(verbose).toContain("Desired State:");
  });

  test("identifies change counts as generated files without per-output detail", () => {
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
        { kind: "drifted member", path: "f.md", project: "/project-a" },
      ],
    });

    const concise = formatLifecycleReport("preview", report);

    expect(concise).toContain("Changes: 2 generated file additions, 1 generated file update, 1 generated file repair, 1 generated file removal, 1 generated file drift item");
    expect(concise).toContain("  Changes: 2 generated file additions, 1 generated file update, 1 generated file repair, 1 generated file removal, 1 generated file drift item");
    expect(concise).not.toContain("a.md");
    expect(concise).not.toContain("Desired State:");
    expect(concise).not.toContain("Outputs:");
  });

  test("explains every non-current project state only when present", () => {
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
          ? [{ message: "/solo: hooks disabled", project: "/solo" }]
          : [],
      });

      const concise = formatLifecycleReport("status", report);
      if (kind === "blocked") {
        expect(concise).toContain("Blocker: hooks disabled");
        expect(concise).not.toContain("State:");
        expect(concise).not.toContain("State explanations:");
        continue;
      }
      expect(concise).toContain(`State: ${kind}`);
      const glosses = explanationLines(concise);
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
      blockers: [{ message: "/project-b: hooks disabled", project: "/project-b" }],
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
      expect(verbose.indexOf("Blockers:\n- /project-b: hooks disabled")).toBeGreaterThan(-1);
      expect(verbose.indexOf("Blockers:\n- /project-b: hooks disabled")).toBeLessThan(
        verbose.indexOf("Projects:"),
      );
    }
  });

  test("orders state explanations stably by NON_CURRENT_STATE_ORDER when several kinds are present", () => {
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

    const glosses = explanationLines(formatLifecycleReport("status", report));
    const kinds = glosses.map((line) => line.slice(2, line.indexOf(":")));
    expect(kinds).toEqual(NON_CURRENT_STATE_ORDER.filter((kind) => present.includes(kind)));
  });

  test("places state explanations after Diagnostics for unscoped items", () => {
    const report = emptyReport({
      items: [{ kind: "removal", project: "/orphan" }],
    });
    const concise = formatLifecycleReport("status", report);
    const diagnosticsAt = concise.indexOf("Diagnostics:");
    const explanationsAt = concise.indexOf("State explanations:");
    expect(diagnosticsAt).toBeGreaterThan(-1);
    expect(explanationsAt).toBeGreaterThan(diagnosticsAt);
    expect(concise).toContain("- /orphan: removal");
    expect(explanationLines(concise)).toHaveLength(1);
  });

  test("explains Git exclusion deltas while preserving exact paths", () => {
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

    expect(concise).toContain("Git exclusions:");
    expect(concise).toContain(
      "Git-local exclusions that keep generated paths managed by Agent Profile Kit untracked",
    );
    expect(concise).toContain(
      `- ${target}: add /.agent-profile-kit/codex/context.md, /.codex/hooks.json; remove /.old-path.md`,
    );
  });

  test("--verbose still renders complete diagnostics from the same ReconciliationReport", () => {
    const report = emptyReport({
      desired: [{
        canonicalProject: "/project-a",
        context: "Composed context body",
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
      blockers: [{ message: "/project-a: example blocker", project: "/project-a" }],
    });

    const verbose = formatLifecycleReport("preview", report, { verbose: true });

    expect(verbose.startsWith("Cannot apply\n")).toBe(true);
    expect(verbose).toContain("Projects:");
    expect(verbose).toContain("/project-a: stale source");
    expect(verbose).toContain("Outputs:");
    expect(verbose).toContain("/project-a/.agent-profile-kit/codex/context.md: update");
    expect(verbose).toContain("/project-a/.codex/hooks.json: unchanged");
    expect(verbose).toContain("Repository Exclusions:");
    expect(verbose).toContain("/project-a/.git/info/exclude: add /.agent-profile-kit/codex/context.md");
    expect(verbose).toContain("Desired State:");
    expect(verbose).toContain("Profile coding");
    expect(verbose).toContain("Hosts: claude, codex");
    expect(verbose).toContain("Resolved artifacts:");
    expect(verbose).toContain("context:team-rules");
    expect(verbose).toContain("Composed context body");
    expect(verbose).toContain("Warnings:");
    expect(verbose).toContain("example warning");
    expect(verbose).toContain("Blockers:");
    expect(verbose).toContain("/project-a: example blocker");
    // Verbose remains the complete diagnostic view, not the concise glosses.
    expect(verbose).not.toContain("State explanations:");
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
      ...receipt,
      repositoryExclusionRepairs: [],
      warnings: [],
    });

    const verbose = formatApplyReport(applyResult(receipt, result), { verbose: true });

    expect(verbose).not.toContain("apply will restore");
    expect(verbose).toContain("Apply receipt:");
    expect(verbose).toContain("restored 1 recorded Repository Exclusion entry");
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

    expect(concise).toContain("Project: /changed");
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
      blockers: [{ message: "changed after commit", project: "/project-a" }],
    });

    const concise = formatApplyReport(applyResult(emptyReport(), resultingState));

    expect(concise.startsWith("Apply completed with blockers\n")).toBe(true);
    expect(concise).toContain("Next: Resolve the reported blocker");
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
    expect(concise).toContain("Apply receipt:");
    expect(concise).toContain("generated file addition");
    expect(concise).not.toContain("Apply complete");
  });
});

describe("formatLifecycleReport next-action guidance", () => {
  function nextActionLines(reportText: string): string[] {
    return reportText.split("\n").filter((line) => line.startsWith("Next:"));
  }

  test("actionable status recommends read-only preview before apply without rebinding", () => {
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
      blockers: [{ message: "/project-a: hooks disabled", project: "/project-a" }],
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
      blockers: [{ message: "/project-a: hooks disabled", project: "/project-a" }],
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
      blockers: [{ message: "/project-a: hooks disabled", project: "/project-a" }],
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
      desired: current.desired,
      items: [{ kind: "update", project: "/project-a", reason: "desired output changed" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    const metadataOnlyResult = emptyReport({
      desired: current.desired,
      items: [{ kind: "current", project: "/project-a" }],
      outputs: [{ kind: "unchanged", path: "a.md", project: "/project-a" }],
    });
    const metadataOnly = formatApplyReport(applyResult(metadataOnlyReceipt, metadataOnlyResult));
    expect(metadataOnly).not.toContain("no changes were applied");
    expect(metadataOnly).toContain("Project update");
  });

  test("mixed multi-project blockers take precedence over actionable peers", () => {
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
      blockers: [{ message: "/project-b: hooks disabled", project: "/project-b" }],
    });

    const statusNext = nextActionLines(formatLifecycleReport("status", mixedBlocked));
    expect(statusNext).toHaveLength(1);
    expect(statusNext[0]).toMatch(/resolve/i);
    expect(statusNext[0]).toMatch(/apkit status/);
    expect(statusNext[0]).not.toMatch(/apply/i);

    const previewNext = nextActionLines(formatLifecycleReport("preview", mixedBlocked));
    expect(previewNext).toHaveLength(1);
    expect(previewNext[0]).toMatch(/apkit preview/);
    expect(previewNext[0]).not.toMatch(/apply/i);
  });

  test("mixed multi-project actionable outcomes emit one aggregate next action", () => {
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
    expect(status).toContain("All Projects are current");
    expect(status).toContain("No Projects need attention.");
    expect(nextActionLines(status)).toEqual([]);

    const preview = formatLifecycleReport("preview", report);
    expect(preview).toContain("Nothing to sync; all Projects are current.");
    expect(nextActionLines(preview)).toEqual([]);
  });

  test("status with a desired installation but no reconciliation item still recommends preview", () => {
    // groupNeedsAttention treats status + empty items as attention; next action must agree.
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
    expect(status).toContain("Project: /project-a");
    const next = nextActionLines(status);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/preview/i);
    expect(next[0]).not.toMatch(/bind/i);
  });

  test("plural blockers wording when more than one blocker is present", () => {
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
        { message: "/a: hooks disabled", project: "/a" },
        { message: "/b: tracked path", project: "/b" },
      ],
    });

    const next = nextActionLines(formatLifecycleReport("status", report));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatch(/blockers/);
    expect(next[0]).not.toMatch(/blocker,/);
  });
});
