import { findGitProject, type GitProject } from "./git.js";
import {
  classifyTrackedGitDestinations,
  type TrackedPathClassification,
} from "./git.js";
import {
  readGitExcludeSnapshot,
  type GitExcludeSnapshot,
} from "./git-exclusions.js";

/**
 * Instrumentation fired only when the invocation context performs real work
 * (cache miss). Tests inject counters; production callers omit this.
 */
export interface LifecycleGitInspectionInstrumentation {
  readonly onClassifyTrackedPaths?: () => void;
  readonly onFindGitProject?: () => void;
  readonly onReadExcludeSnapshot?: () => void;
}

/**
 * One invocation-scoped reader for Git topology, batched tracked-path
 * classification, and Repository Exclusion target snapshots. Discarded when
 * the lifecycle command exits; never persisted or shared across commands.
 */
export interface LifecycleGitInspection {
  classifyTrackedDestinations(
    gitProject: GitProject,
    projectRelativePaths: readonly string[],
  ): Promise<TrackedPathClassification>;
  findGitProject(project: string): Promise<GitProject | undefined>;
  readExcludeSnapshot(
    git: GitProject,
    allowMissingTarget?: boolean,
  ): Promise<GitExcludeSnapshot>;
}

function excludeSnapshotKey(excludeFile: string, allowMissingTarget: boolean): string {
  return `${excludeFile}\0${allowMissingTarget ? "1" : "0"}`;
}

/**
 * Create one invocation-scoped Git inspection context. Call sites must not add
 * local memoization or fallback readers for the same facts.
 */
export function createLifecycleGitInspectionContext(
  instrumentation: LifecycleGitInspectionInstrumentation = {},
): LifecycleGitInspection {
  const gitProjects = new Map<string, Promise<GitProject | undefined>>();
  const trackedClassifications = new Map<string, Promise<TrackedPathClassification>>();
  const excludeSnapshots = new Map<string, Promise<GitExcludeSnapshot>>();

  function findProject(project: string): Promise<GitProject | undefined> {
    const existing = gitProjects.get(project);
    if (existing) return existing;
    instrumentation.onFindGitProject?.();
    const pending = findGitProject(project);
    gitProjects.set(project, pending);
    return pending.catch((error) => {
      gitProjects.delete(project);
      throw error;
    });
  }

  function classifyTrackedDestinations(
    gitProject: GitProject,
    projectRelativePaths: readonly string[],
  ): Promise<TrackedPathClassification> {
    const uniquePaths = [...new Set(projectRelativePaths)].sort();
    const key = `${gitProject.root}\0${gitProject.relativeProject}\0${uniquePaths.join("\n")}`;
    const existing = trackedClassifications.get(key);
    if (existing) return existing;
    instrumentation.onClassifyTrackedPaths?.();
    const pending = classifyTrackedGitDestinations(gitProject, uniquePaths);
    trackedClassifications.set(key, pending);
    return pending.catch((error) => {
      trackedClassifications.delete(key);
      throw error;
    });
  }

  function readExcludeSnapshot(
    git: GitProject,
    allowMissingTarget = false,
  ): Promise<GitExcludeSnapshot> {
    const key = excludeSnapshotKey(git.excludeFile, allowMissingTarget);
    const existing = excludeSnapshots.get(key);
    if (existing) return existing;
    instrumentation.onReadExcludeSnapshot?.();
    const pending = readGitExcludeSnapshot(git, allowMissingTarget);
    excludeSnapshots.set(key, pending);
    return pending.catch((error) => {
      excludeSnapshots.delete(key);
      throw error;
    });
  }

  return {
    classifyTrackedDestinations,
    findGitProject: findProject,
    readExcludeSnapshot,
  };
}
