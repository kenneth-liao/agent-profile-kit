import { afterAll, describe, expect, test } from "bun:test";
import { OWNERSHIP_STATE_SCHEMA_VERSION } from "../schemas/ownership-state.js";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  createLifecycleGitInspectionContext,
  type LifecycleGitInspectionInstrumentation,
} from "../installer/lifecycle-git-inspection.js";
import { buildDesiredState } from "../installer/project-plan.js";
import {
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { readInstallationState } from "../installer/installation-state.js";
import {
  reportBlockers,
  reportItems,
  reportRepositoryExclusionRepairs,
  reportWarnings,
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

function emptyInstrumentation(): LifecycleGitInspectionInstrumentation & {
  readonly counts: {
    classifyTrackedPaths: number;
    findGitProject: number;
    readExcludeSnapshot: number;
  };
} {
  const counts = {
    classifyTrackedPaths: 0,
    findGitProject: 0,
    readExcludeSnapshot: 0,
  };
  return {
    counts,
    onClassifyTrackedPaths: () => {
      counts.classifyTrackedPaths += 1;
    },
    onFindGitProject: () => {
      counts.findGitProject += 1;
    },
    onReadExcludeSnapshot: () => {
      counts.readExcludeSnapshot += 1;
    },
  };
}

function gitRepository(prefix: string): string {
  const path = temporaryDirectory(prefix);
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
  return path;
}

function writeSkill(workspace: string, id: string): void {
  const skillRoot = join(workspace, "skills", id);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${id}\ndescription: Skill ${id}.\n---\n\n# ${id}\n`,
  );
}

async function fleetHome(options: {
  readonly gitProjectCount: number;
  readonly hosts?: readonly string[];
  readonly nestedProjectsPerGit?: number;
  readonly nonGitProjectCount?: number;
  readonly skillCount?: number;
}): Promise<{
  readonly gitProjects: readonly string[];
  readonly home: string;
  readonly nestedProjects: readonly string[];
  readonly nonGitProjects: readonly string[];
}> {
  const home = temporaryDirectory("apk-git-inspect-home-");
  await initializeWorkspace(home);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  const skillCount = options.skillCount ?? 6;
  const skillIds: string[] = [];
  for (let index = 0; index < skillCount; index += 1) {
    const id = `skill-${String(index).padStart(2, "0")}`;
    skillIds.push(id);
    writeSkill(workspace, id);
  }
  writeFileSync(
    join(workspace, "profiles", "engineering.yaml"),
    `id: engineering\ncontext: [team-rules]\nskills: [${skillIds.join(", ")}]\n`,
  );

  const hosts = options.hosts ?? ["codex"];
  const bindingLines: string[] = [];
  const gitProjects: string[] = [];
  const nestedProjects: string[] = [];
  const nestedPerGit = options.nestedProjectsPerGit ?? 0;

  for (let index = 0; index < options.gitProjectCount; index += 1) {
    const repository = gitRepository(`apk-git-inspect-repo-${index}-`);
    gitProjects.push(repository);
    bindingLines.push(
      `  - project: ${repository}\n    profile: engineering\n    hosts: [${hosts.join(", ")}]\n`,
    );
    for (let nested = 0; nested < nestedPerGit; nested += 1) {
      const nestedPath = join(repository, `nested-${nested}`);
      mkdirSync(nestedPath, { recursive: true });
      writeFileSync(join(nestedPath, ".keep"), "");
      nestedProjects.push(nestedPath);
      bindingLines.push(
        `  - project: ${nestedPath}\n    profile: engineering\n    hosts: [${hosts.join(", ")}]\n`,
      );
    }
  }

  const nonGitProjects: string[] = [];
  for (let index = 0; index < (options.nonGitProjectCount ?? 0); index += 1) {
    const project = temporaryDirectory(`apk-git-inspect-nongit-${index}-`);
    nonGitProjects.push(project);
    bindingLines.push(
      `  - project: ${project}\n    profile: engineering\n    hosts: [${hosts.join(", ")}]\n`,
    );
  }

  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${bindingLines.join("")}`,
  );

  return { gitProjects, home, nestedProjects, nonGitProjects };
}

async function previewWithInspection(
  home: string,
  instrumentation: LifecycleGitInspectionInstrumentation,
): Promise<{
  readonly desired: Awaited<ReturnType<typeof buildDesiredState>>;
  readonly report: Awaited<ReturnType<typeof previewReconciliation>>;
}> {
  const gitInspection = createLifecycleGitInspectionContext(instrumentation);
  const desired = await buildDesiredState(home, {
    checkHostCapability: false,
    gitInspection,
  });
  let state;
  try {
    state = await readInstallationState(home);
  } catch {
    state = {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
    } as const;
  }
  const report = await previewReconciliation(desired.installations, state, { gitInspection });
  return { desired, report };
}

describe("lifecycle Git inspection batching", () => {
  test("resolves Git topology once per Project across desired-state and reconciliation", async () => {
    const { home, gitProjects, nonGitProjects } = await fleetHome({
      gitProjectCount: 3,
      nonGitProjectCount: 2,
      skillCount: 4,
    });
    const instrumentation = emptyInstrumentation();

    const { desired, report } = await previewWithInspection(home, instrumentation);

    expect(desired.installations).toHaveLength(gitProjects.length + nonGitProjects.length);
    expect(reportBlockers(report)).toEqual([]);
    // Topology scales with Projects, not generated paths. Non-Git Projects still
    // perform one boundary probe that returns undefined.
    expect(instrumentation.counts.findGitProject).toBe(
      gitProjects.length + nonGitProjects.length,
    );
  });

  test("classifies all planned destinations for one Git Project in one batched index query", async () => {
    const { home, gitProjects } = await fleetHome({
      gitProjectCount: 2,
      skillCount: 8,
    });
    const instrumentation = emptyInstrumentation();

    const { desired, report } = await previewWithInspection(home, instrumentation);
    const generatedPathCount = desired.installations.reduce(
      (total, installation) => total + installation.outputs.length + 1,
      0,
    );

    expect(desired.installations).toHaveLength(2);
    expect(reportBlockers(report)).toEqual([]);
    expect(generatedPathCount).toBeGreaterThan(gitProjects.length * 8);
    // One batched tracked-path query per Git Project, not per generated path.
    expect(instrumentation.counts.classifyTrackedPaths).toBe(gitProjects.length);
  });

  test("batched tracked evidence keeps grouped blocker scope, remedies, and affected paths", async () => {
    const { home, gitProjects } = await fleetHome({
      gitProjectCount: 1,
      skillCount: 3,
    });
    const project = gitProjects[0]!;
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0]!;
    const trackedPaths = [
      ".agent-profile-kit/codex/context.md",
      ".codex/hooks.json",
      ".agents/skills/skill-00",
      ".agents/skills/skill-01",
    ];
    for (const path of trackedPaths) {
      const absolute = join(project, path);
      if (path.endsWith(".md") || path.endsWith(".json")) {
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, "tracked\n");
      } else {
        mkdirSync(absolute, { recursive: true });
        writeFileSync(join(absolute, "SKILL.md"), "tracked\n");
      }
    }
    execFileSync("git", ["-C", project, "add", "."]);
    execFileSync("git", ["-C", project, "commit", "-qm", "track planned paths"]);
    // Working tree may delete files; index still owns them.
    rmSync(join(project, ".agents"), { recursive: true, force: true });
    rmSync(join(project, ".agent-profile-kit"), { recursive: true, force: true });
    rmSync(join(project, ".codex"), { recursive: true, force: true });

    const instrumentation = emptyInstrumentation();
    const gitInspection = createLifecycleGitInspectionContext(instrumentation);
    const report = await previewReconciliation([installation], {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
    }, { gitInspection });

    expect(instrumentation.counts.classifyTrackedPaths).toBe(1);
    expect(reportBlockers(report)).toHaveLength(1);
    const blocker = reportBlockers(report)[0]!;
    expect(blocker.kind).toBe("output-ownership-conflict");
    expect(blocker.scope).toBe("project");
    expect(blocker.project).toBe(project);
    expect(blocker.problem).toContain("tracked by Git");
    expect(blocker.remedy).toContain("will not delete");
    const affected = blocker.affectedItems
      .filter((item) => item.kind === "path")
      .map((item) => item.value)
      .sort();
    expect(affected).toEqual([...trackedPaths].sort());
    expect(blocker.message).toContain("more tracked project");
  });

  test("reads each shared Repository Exclusion target once per reconciliation pass", async () => {
    const home = temporaryDirectory("apk-git-inspect-shared-excl-home-");
    await initializeWorkspace(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
    );
    writeSkill(workspace, "review-pr");
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [team-rules]\nskills: [review-pr]\n",
    );

    const repository = gitRepository("apk-git-inspect-shared-excl-repo-");
    const nested = join(repository, "nested");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, ".keep"), "");
    execFileSync("git", ["-C", repository, "add", "nested/.keep"]);
    execFileSync("git", ["-C", repository, "commit", "-qm", "nested"]);
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n` +
        `  - project: ${repository}\n    profile: engineering\n    hosts: [codex]\n` +
        `  - project: ${nested}\n    profile: engineering\n    hosts: [codex]\n`,
    );

    const first = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, first.installations);
    const state = await readInstallationState(home);
    expect(new Set(state.receipts.flatMap((receipt) =>
      receipt.repositoryExclusion === undefined ? [] : [receipt.repositoryExclusion.target]
    )).size).toBe(1);

    const instrumentation = emptyInstrumentation();
    const gitInspection = createLifecycleGitInspectionContext(instrumentation);
    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      gitInspection,
    });
    const report = await previewReconciliation(desired.installations, state, { gitInspection });

    expect(reportBlockers(report)).toEqual([]);
    expect(reportItems(report).every((item) => item.kind === "current")).toBe(true);
    // One shared exclude target for both nested Projects: blockers and diagnostics
    // must reuse one snapshot rather than re-reading per consumer or Project.
    expect(instrumentation.counts.readExcludeSnapshot).toBe(1);
  });

  test("non-Git Projects skip tracked-path queries and keep ordinary conflict behavior", async () => {
    const { home } = await fleetHome({
      gitProjectCount: 0,
      nonGitProjectCount: 2,
      skillCount: 2,
    });
    const instrumentation = emptyInstrumentation();
    const { desired, report } = await previewWithInspection(home, instrumentation);

    expect(desired.installations.every((installation) => installation.gitProject === undefined)).toBe(true);
    expect(instrumentation.counts.classifyTrackedPaths).toBe(0);
    expect(reportBlockers(report)).toEqual([]);
    expect(reportItems(report).every((item) => item.kind === "addition")).toBe(true);
  });

  test("nested Projects that share one Git root classify through one index listing", async () => {
    const { home, gitProjects, nestedProjects } = await fleetHome({
      gitProjectCount: 1,
      nestedProjectsPerGit: 1,
      skillCount: 3,
    });
    const instrumentation = emptyInstrumentation();
    const { desired, report } = await previewWithInspection(home, instrumentation);

    expect(desired.installations).toHaveLength(gitProjects.length + nestedProjects.length);
    expect(reportBlockers(report)).toEqual([]);
    // One Git worktree root → one index query, even with multiple bound Projects.
    expect(instrumentation.counts.classifyTrackedPaths).toBe(1);
  });

  test("apply post-commit verification uses a fresh Git inspection pass", async () => {
    const { home, gitProjects } = await fleetHome({
      gitProjectCount: 1,
      skillCount: 2,
    });
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const contexts: ReturnType<typeof createLifecycleGitInspectionContext>[] = [];
    const excludeReadsByContext: number[] = [];
    const classifyByContext: number[] = [];

    const report = await applyReconciliation(home, desired.installations, {
      createGitInspection: () => {
        const contextId = contexts.length + 1;
        const context = createLifecycleGitInspectionContext({
          onClassifyTrackedPaths: () => {
            classifyByContext.push(contextId);
          },
          onReadExcludeSnapshot: () => {
            excludeReadsByContext.push(contextId);
          },
        });
        contexts.push(context);
        return context;
      },
    });

    expect(gitProjects).toHaveLength(1);
    expect(contexts.length).toBeGreaterThanOrEqual(2);
    expect(contexts[0]).not.toBe(contexts[contexts.length - 1]);
    expect(new Set(classifyByContext).size).toBeGreaterThanOrEqual(2);
    expect(new Set(excludeReadsByContext).size).toBeGreaterThanOrEqual(2);
    expect(reportBlockers(report.resultingState)).toEqual([]);
    expect(reportRepositoryExclusionRepairs(report.resultingState)).toEqual([]);
    expect(reportItems(report.resultingState).every((item) => item.kind === "current")).toBe(true);
  });

  test("reusing one Git inspection context across apply preflight and verify leaves stale exclusion evidence", async () => {
    const { home } = await fleetHome({
      gitProjectCount: 1,
      skillCount: 2,
    });
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    // Deliberately broken: one shared context caches the pre-write empty exclude
    // snapshot and would prove post-write state from preflight evidence.
    const shared = createLifecycleGitInspectionContext();

    const report = await applyReconciliation(home, desired.installations, {
      createGitInspection: () => shared,
    });

    expect(reportRepositoryExclusionRepairs(report.resultingState).length).toBeGreaterThan(0);
    expect(reportWarnings(report.resultingState).some((warning) =>
      warning.includes("missing its Agent Profile Kit exclusion section")
    )).toBe(true);
  });
});
