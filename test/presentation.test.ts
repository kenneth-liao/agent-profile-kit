import { describe, expect, test } from "bun:test";

import { formatLifecycleReport } from "../cli/presentation.js";
import type { ReconciliationReport } from "../installer/reconcile.js";

function emptyReport(overrides: Partial<ReconciliationReport> = {}): ReconciliationReport {
  return {
    blockers: [],
    desired: [],
    items: [],
    outputs: [],
    repositoryExclusions: [],
    warnings: [],
    ...overrides,
  };
}

describe("formatLifecycleReport concise terminology", () => {
  test("identifies change counts as generated-output units without per-output detail", () => {
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

    expect(concise).toContain("Changes: 2 generated-output additions, 1 generated-output update, 1 generated-output repair, 1 generated-output removal, 1 generated-output drift item");
    expect(concise).toContain("  Changes: 2 generated-output additions, 1 generated-output update, 1 generated-output repair, 1 generated-output removal, 1 generated-output drift item");
    expect(concise).not.toContain("a.md");
    expect(concise).not.toContain("Desired State:");
    expect(concise).not.toContain("Outputs:");
  });

  test("explains every non-current Profile Installation state only when present", () => {
    const explanations: ReadonlyArray<{
      readonly kind:
        | "addition"
        | "update"
        | "stale source"
        | "repairable missing output"
        | "drifted output"
        | "malformed ownership state"
        | "blocked"
        | "removal"
        | "missing output";
      readonly text: string;
    }> = [
      {
        kind: "addition",
        text: "The Profile Installation is not installed yet; apply will create its Installer-owned generated outputs.",
      },
      {
        kind: "update",
        text: "Desired state changed for this Profile Installation; apply will rewrite Installer-owned generated outputs to match.",
      },
      {
        kind: "stale source",
        text: "Workspace source changed since the last apply; generated outputs no longer match current desired state.",
      },
      {
        kind: "repairable missing output",
        text: "An owned generated output is wholly missing, but ownership is proven; apply will recreate it from current Workspace source.",
      },
      {
        kind: "drifted output",
        text: "An owned generated output no longer matches its Installation Manifest hash and is not treated as a safe automatic rewrite.",
      },
      {
        kind: "malformed ownership state",
        text: "Ownership metadata is incomplete or inconsistent, so the Installer cannot prove what it owns.",
      },
      {
        kind: "blocked",
        text: "Reconciliation cannot change this Profile Installation until the listed blocker is resolved.",
      },
      {
        kind: "removal",
        text: "No Project Binding remains for this installation; apply will remove proven Installer-owned generated outputs.",
      },
      {
        kind: "missing output",
        text: "The Profile Installation is absent or its generated outputs are missing without proven Installer ownership; this is not a safe automatic repair.",
      },
    ];

    for (const { kind, text } of explanations) {
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
      expect(concise).toContain(`State: ${kind}`);
      expect(concise).toContain("State explanations:");
      expect(concise).toContain(`- ${kind}: ${text}`);
      // Only this state's explanation should appear for a single-state report.
      const explanationLines = concise
        .split("\n")
        .filter((line) =>
          line.startsWith("- ") &&
          explanations.some((entry) => line.startsWith(`- ${entry.kind}:`)),
        );
      expect(explanationLines).toHaveLength(1);
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

  test("emits each shared state explanation once across multiple Profile Installations", () => {
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
    expect(concise).toContain("Profile Installation: /project-a");
    expect(concise).toContain("Profile Installation: /project-b");
    expect(concise.match(/^- stale source: /gm)).toHaveLength(1);
    expect(concise.match(/^- blocked: /gm)).toHaveLength(1);
    // Project-specific states, change counts, and blockers stay on each installation.
    expect(concise).toMatch(
      /Profile Installation: \/project-a\n  Profile: coding\n  State: stale source\n  Changes: 1 generated-output update\n/,
    );
    expect(concise).toMatch(
      /Profile Installation: \/project-b\n  Profile: coding\n  State: stale source\n  State: blocked \(hooks disabled\)\n  Changes: 1 generated-output addition, 1 generated-output update\n  Blocker: hooks disabled\n/,
    );
  });

  test("explains Repository Exclusion deltas as Git-local exclusions while preserving exact paths", () => {
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

    expect(concise).toContain("Repository exclusions:");
    expect(concise).toContain(
      "Git-local exclusions that keep Installer-owned generated paths untracked",
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
});
