import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterProjectPlan } from "../adapters/project-plan.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  buildDesiredState,
  normalizeAdapterPlans,
  type DesiredInstallation,
  type DesiredProjectOutput,
} from "../installer/project-plan.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { readInstallationState } from "../installer/installation-state.js";
import {
  createLifecycleOwnershipInspectionContext,
  type LifecycleOwnershipInspection,
  type LifecycleOwnershipInspectionInstrumentation,
} from "../installer/lifecycle-ownership-inspection.js";
import {
  reportBlockers,
  reportItems,
  reportOutputs,
} from "./support/reconciliation-report.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function emptyInstrumentation(): LifecycleOwnershipInspectionInstrumentation & {
  readonly counts: {
    inspectDirectory: number;
    inspectFile: number;
    unsafeParent: number;
  };
} {
  const counts = {
    inspectDirectory: 0,
    inspectFile: 0,
    unsafeParent: 0,
  };
  return {
    counts,
    onInspectDirectory: () => {
      counts.inspectDirectory += 1;
    },
    onInspectFile: () => {
      counts.inspectFile += 1;
    },
    onUnsafeParent: () => {
      counts.unsafeParent += 1;
    },
  };
}

function skillDirectoryPlan(
  host: SupportedHost = "codex",
  overrides: {
    readonly bytes?: string;
    readonly path?: string;
  } = {},
): AdapterProjectPlan {
  const skillBytes = overrides.bytes ?? "# Demo Skill\n";
  return {
    host,
    hostVersion: `${host}-v1`,
    outputs: [
      {
        members: [
          {
            bytes: skillBytes,
            mode: 0o644,
            path: "SKILL.md",
            type: "file",
          },
          {
            mode: 0o755,
            path: "scripts",
            type: "directory",
          },
          {
            bytes: "#!/bin/sh\necho demo\n",
            mode: 0o755,
            path: "scripts/run.sh",
            type: "file",
          },
        ],
        mode: 0o755,
        origins: [],
        path: overrides.path ?? ".agents/skills/demo-skill",
        requirements: ["Host discovers Skill package"],
        type: "directory",
      },
    ],
    setupSteps: [],
  };
}

async function contextInstallation(
  home: string,
  project: string,
): Promise<DesiredInstallation> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nShared ownership inspection context.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext: [team-rules]\nskills: []\n",
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
  );
  const desired = await buildDesiredState(home, { checkHostCapability: false });
  const installation = desired.installations[0];
  if (!installation) throw new Error("expected one desired installation");
  return installation;
}

function withDirectoryOutput(
  installation: DesiredInstallation,
  directory: DesiredProjectOutput,
): DesiredInstallation {
  return {
    ...installation,
    outputs: [...installation.outputs, directory].sort((left, right) =>
      left.path.localeCompare(right.path)
    ),
  };
}

function normalizedDirectory(bytes = "# Demo Skill\n"): DesiredProjectOutput {
  const output = normalizeAdapterPlans([skillDirectoryPlan("codex", { bytes })])[0];
  if (!output || output.type !== "directory") throw new Error("expected directory output");
  return output;
}

async function appliedDirectoryInstallation(home: string, project: string): Promise<{
  readonly desired: readonly DesiredInstallation[];
  readonly directory: DesiredProjectOutput;
}> {
  const base = await contextInstallation(home, project);
  const directory = normalizedDirectory();
  const desired = [withDirectoryOutput(base, directory)];
  await applyReconciliation(home, desired);
  return { desired, directory };
}

describe("one shared ownership inspection per generated output per pass", () => {
  test("walks each owned directory once across ownership proof and root diagnostics", async () => {
    const home = temporaryDirectory("apk-own-inspect-dir-once-home-");
    const project = temporaryDirectory("apk-own-inspect-dir-once-project-");
    const { desired } = await appliedDirectoryInstallation(home, project);
    const installation = desired[0]!;
    const expectedFiles = installation.outputs.filter(
      (output) => output.type === "file",
    ).length;
    const expectedDirectories = installation.outputs.filter(
      (output) => output.type === "directory",
    ).length;
    expect(expectedDirectories).toBeGreaterThan(0);

    const instrumentation = emptyInstrumentation();
    const ownershipInspection = createLifecycleOwnershipInspectionContext(instrumentation);
    const report = await previewReconciliation(
      desired,
      await readInstallationState(home),
      { ownershipInspection },
    );

    expect(reportBlockers(report)).toEqual([]);
    expect(reportItems(report).every((item) => item.kind === "current")).toBe(true);
    // Ownership proof and output planning consume the same directory result.
    // Each output path also resolves its unsafe-parent evidence once even though
    // ownership proof and output planning both consult it.
    expect(instrumentation.counts.inspectFile).toBe(expectedFiles);
    expect(instrumentation.counts.inspectDirectory).toBe(expectedDirectories);
    expect(instrumentation.counts.unsafeParent).toBe(installation.outputs.length);
  });

  test("directory drift reports one generated root while sharing one directory walk", async () => {
    const home = temporaryDirectory("apk-own-inspect-drift-home-");
    const project = temporaryDirectory("apk-own-inspect-drift-project-");
    const { desired } = await appliedDirectoryInstallation(home, project);
    const directory = desired[0]!.outputs.find((output) => output.type === "directory");
    if (!directory || directory.type !== "directory") throw new Error("expected directory output");
    const member = join(project, directory.path, "SKILL.md");
    writeFileSync(member, "# Drifted\n");
    mkdirSync(join(project, directory.path, "extra"), { recursive: true });
    writeFileSync(join(project, directory.path, "extra", "note.txt"), "unexpected\n");

    const instrumentation = emptyInstrumentation();
    const ownershipInspection = createLifecycleOwnershipInspectionContext(instrumentation);
    const report = await previewReconciliation(
      desired,
      await readInstallationState(home),
      { ownershipInspection },
    );

    expect(reportOutputs(report)).toContainEqual({
      kind: "update",
      path: directory.path,
      project,
    });
    expect(reportOutputs(report).every((item) => !item.path.startsWith(`${directory.path}/`))).toBe(true);
    // Identity-proven drift is non-blocking pending refresh work.
    expect(reportBlockers(report)).toEqual([]);
    // Ownership proof and root diagnostics share one directory walk; the
    // ordinary file outputs are each read once by ownership proof.
    expect(instrumentation.counts.inspectDirectory).toBe(1);
    expect(instrumentation.counts.inspectFile).toBe(
      desired[0]!.outputs.filter(
        (output) => output.type === "file",
      ).length,
    );
  });

  test("apply preflight and post-commit verification each use a fresh ownership inspection pass", async () => {
    const home = temporaryDirectory("apk-own-inspect-apply-home-");
    const project = temporaryDirectory("apk-own-inspect-apply-project-");
    const { desired } = await appliedDirectoryInstallation(home, project);
    const contexts: LifecycleOwnershipInspection[] = [];
    const fileReadsByContext: number[] = [];
    const directoryWalksByContext: number[] = [];

    const report = await applyReconciliation(home, desired, {
      createOwnershipInspection: () => {
        const contextId = contexts.length + 1;
        const context = createLifecycleOwnershipInspectionContext({
          onInspectFile: () => fileReadsByContext.push(contextId),
          onInspectDirectory: () => directoryWalksByContext.push(contextId),
        });
        contexts.push(context);
        return context;
      },
    });

    expect(contexts.length).toBeGreaterThanOrEqual(2);
    expect(contexts[0]).not.toBe(contexts[contexts.length - 1]);
    // Preflight and post-commit verification each perform their own real reads.
    expect(new Set(fileReadsByContext).size).toBeGreaterThanOrEqual(2);
    expect(new Set(directoryWalksByContext).size).toBeGreaterThanOrEqual(2);
    expect(reportBlockers(report.resultingState)).toEqual([]);
    expect(reportItems(report.resultingState).every((item) => item.kind === "current")).toBe(true);
  });

  test("one shared context re-inspects a path only when the expected output identity changes", async () => {
    const home = temporaryDirectory("apk-own-inspect-content-key-home-");
    const project = temporaryDirectory("apk-own-inspect-content-key-project-");
    await appliedDirectoryInstallation(home, project);
    const state = await readInstallationState(home);
    const recorded = state.receipts[0]?.outputs.find((output) => output.type === "directory");
    if (!recorded || recorded.type !== "directory") throw new Error("expected directory output");

    const instrumentation = emptyInstrumentation();
    const ownershipInspection = createLifecycleOwnershipInspectionContext(instrumentation);
    await ownershipInspection.inspectOutput(project, recorded);
    await ownershipInspection.inspectOutput(project, recorded);
    expect(instrumentation.counts.inspectDirectory).toBe(1);

    const changedHash = { ...recorded, hash: "changed-directory-hash" };
    await ownershipInspection.inspectOutput(project, changedHash);
    expect(instrumentation.counts.inspectDirectory).toBe(2);
  });

  test("an unreadable owned directory fails closed with an ownership blocker", async () => {
    const home = temporaryDirectory("apk-own-inspect-unreadable-home-");
    const project = temporaryDirectory("apk-own-inspect-unreadable-project-");
    const { desired } = await appliedDirectoryInstallation(home, project);
    const directory = desired[0]!.outputs.find((output) => output.type === "directory");
    if (!directory || directory.type !== "directory") throw new Error("expected directory output");
    chmodSync(join(project, directory.path), 0o000);
    try {
      const report = await previewReconciliation(
        desired,
        await readInstallationState(home),
        { ownershipInspection: createLifecycleOwnershipInspectionContext() },
      );
      // An unreadable existing tree fails closed: ownership is revoked, so
      // apply cannot rename and replace it.
      expect(reportItems(report).some((item) => item.kind === "drifted output")).toBe(true);
      expect(reportBlockers(report).some((blocker) =>
        blocker.kind === "installation-ownership"
      )).toBe(true);
    } finally {
      chmodSync(join(project, directory.path), 0o755);
    }
  });

  test("an unreadable owned file fails closed with an ownership blocker", async () => {
    const home = temporaryDirectory("apk-own-inspect-unreadable-file-home-");
    const project = temporaryDirectory("apk-own-inspect-unreadable-file-project-");
    const { desired } = await appliedDirectoryInstallation(home, project);
    const contextPath = join(project, ".agent-profile-kit", "codex", "context.md");
    chmodSync(contextPath, 0o000);
    try {
      const report = await previewReconciliation(
        desired,
        await readInstallationState(home),
        { ownershipInspection: createLifecycleOwnershipInspectionContext() },
      );
      expect(reportItems(report).some((item) => item.kind === "drifted output")).toBe(true);
      expect(reportBlockers(report).some((blocker) =>
        blocker.kind === "installation-ownership"
      )).toBe(true);
    } finally {
      chmodSync(contextPath, 0o644);
    }
  });

  test("a traversal-level failure with an extant root fails closed with an ownership blocker", async () => {
    const home = temporaryDirectory("apk-own-inspect-traversal-home-");
    const project = temporaryDirectory("apk-own-inspect-traversal-project-");
    const { desired } = await appliedDirectoryInstallation(home, project);
    // Simulate a child vanishing between readdir and lstat during the walk:
    // traversal-level ENOENT while the root itself remains present. An extant
    // root that cannot be walked never proves ownership continuity.
    const ownershipInspection = createLifecycleOwnershipInspectionContext({}, {
      walkDirectory: async () => {
        throw Object.assign(new Error("injected traversal ENOENT"), { code: "ENOENT" });
      },
    });
    const report = await previewReconciliation(
      desired,
      await readInstallationState(home),
      { ownershipInspection },
    );

    expect(reportItems(report).some((item) => item.kind === "drifted output")).toBe(true);
    expect(reportBlockers(report).some((blocker) =>
      blocker.kind === "installation-ownership"
    )).toBe(true);
  });

  test("stale-installation removal proves ownership with fresh evidence after earlier project commits", async () => {
    const home = temporaryDirectory("apk-own-inspect-stale-fresh-home-");
    const keep = temporaryDirectory("apk-own-inspect-stale-fresh-keep-");
    const stale = temporaryDirectory("apk-own-inspect-stale-fresh-stale-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nStale removal proof context.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n` +
        `  - project: ${keep}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${stale}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const keepInstallation = desired.installations.find(
      (item) => item.binding.canonicalProject === keep,
    );
    if (!keepInstallation) throw new Error("expected keep installation");
    // Retire the stale Project's receipt the way unbind does, so the stale
    // removal pass below consumes a retiring record under the current
    // desired-state serialization contract.
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home, project: stale });

    const contexts: LifecycleOwnershipInspection[] = [];
    const readsByContext: number[] = [];
    const report = await applyReconciliation(home, [keepInstallation], {
      createOwnershipInspection: () => {
        const contextId = contexts.length;
        const context = createLifecycleOwnershipInspectionContext({
          onInspectDirectory: () => {
            readsByContext[contextId] = (readsByContext[contextId] ?? 0) + 1;
          },
          onInspectFile: () => {
            readsByContext[contextId] = (readsByContext[contextId] ?? 0) + 1;
          },
        });
        contexts.push(context);
        return context;
      },
    });

    // Preflight, the stale-removal pass, and post-commit verification are
    // distinct passes; the destructive removal proves ownership from evidence
    // captured after preflight rather than reusing the preflight cache.
    expect(contexts.length).toBeGreaterThanOrEqual(3);
    expect(readsByContext[1] ?? 0).toBeGreaterThan(0);
    expect((await readInstallationState(home)).receipts.map((item) => item.project)).toEqual([keep]);
    expect(reportItems(report.resultingState).every((item) => item.kind === "current")).toBe(true);
  });

  test("stale removal re-proves identity fresh and removes output drifted after preflight", async () => {
    const home = temporaryDirectory("apk-own-inspect-stale-mutate-home-");
    const keep = temporaryDirectory("apk-own-inspect-stale-mutate-keep-");
    const stale = temporaryDirectory("apk-own-inspect-stale-mutate-stale-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nStale mutation proof context.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n` +
        `  - project: ${keep}\n    profile: coding\n    hosts: [codex]\n` +
        `  - project: ${stale}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const keepInstallation = desired.installations.find(
      (item) => item.binding.canonicalProject === keep,
    );
    if (!keepInstallation) throw new Error("expected keep installation");
    // Retire the stale Project's receipt the way unbind does, so the stale
    // removal pass below consumes a retiring record under the current
    // desired-state serialization contract.
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home, project: stale });
    const staleContextPath = join(stale, ".agent-profile-kit", "codex", "context.md");
    const drifted = "# Drifted by a concurrent process after preflight\n";

    // The factory is invoked for preflight, the stale-removal pass, and post-commit
    // verification. The stale-removal context mutates the stale output immediately
    // before its fresh proof reads it, modelling a change made after preflight.
    let contextIndex = 0;
    let mutated = false;
    const report = await applyReconciliation(home, [keepInstallation], {
      createOwnershipInspection: () => {
        const index = contextIndex;
        contextIndex += 1;
        const inner = createLifecycleOwnershipInspectionContext();
        const wrapped: LifecycleOwnershipInspection = {
          unsafeParent: (project, relativePath) => inner.unsafeParent(project, relativePath),
          inspectOutput: async (project, output) => {
            if (
              index === 1 &&
              !mutated &&
              project === stale &&
              output.path === ".agent-profile-kit/codex/context.md"
            ) {
              mutated = true;
              writeFileSync(staleContextPath, drifted);
            }
            return inner.inspectOutput(project, output);
          },
        };
        return wrapped;
      },
    });

    expect(mutated).toBe(true);
    // The stale-removal pass re-proves identity from fresh evidence; freshness
    // drift never revokes removal authority, so the drifted output is removed.
    expect(existsSync(staleContextPath)).toBe(false);
    expect((await readInstallationState(home)).receipts.map((item) => item.project)).toEqual([keep]);
    expect(reportItems(report.resultingState).every((item) => item.kind === "current")).toBe(true);
  });
});
