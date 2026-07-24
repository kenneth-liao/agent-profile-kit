import { describe, expect, test } from "bun:test";

import { formatLifecycleReport, NON_CURRENT_STATE_ORDER } from "../cli/presentation.js";
import type { ReconciliationKind, ReconciliationReport } from "../installer/reconcile.js";

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

/** Distinctive anchor phrases — not a second home for the full gloss table. */
const STATE_ANCHORS: Readonly<Record<(typeof NON_CURRENT_STATE_ORDER)[number], string>> = {
  addition: "not installed yet",
  "missing output": "not a safe automatic repair",
  update: "rewrite Installer-owned generated outputs",
  "stale source": "Workspace source changed",
  "repairable missing output": "ownership is proven",
  "drifted output": "not treated as a safe automatic rewrite",
  "malformed ownership state": "cannot prove what it owns",
  blocked: "until the listed blocker is resolved",
  removal: "remove proven Installer-owned generated outputs",
};

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
      blockers: [{ message: "/p1: hooks disabled", project: "/p1" }],
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
