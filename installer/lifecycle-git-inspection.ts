import {
  classifyPathsAgainstGitIndex,
  findGitProject,
  listTrackedGitIndex,
  type GitProject,
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
  readExcludeSnapshot(git: GitProject): Promise<GitExcludeSnapshot>;
}

function excludeSnapshotKey(excludeFile: string): string {
  return excludeFile;
}

/**
 * Create one invocation-scoped Git inspection context. Call sites must not add
 * local memoization or fallback readers for the same facts.
 */
export function createLifecycleGitInspectionContext(
  instrumentation: LifecycleGitInspectionInstrumentation = {},
): LifecycleGitInspection {
  const gitProjects = new Map<string, Promise<GitProject | undefined>>();
  /** One index listing per Git worktree root within this pass. */
  const trackedIndexes = new Map<string, Promise<readonly string[]>>();
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

  function listIndex(gitProject: GitProject): Promise<readonly string[]> {
    const existing = trackedIndexes.get(gitProject.root);
    if (existing) return existing;
    instrumentation.onClassifyTrackedPaths?.();
    const pending = listTrackedGitIndex(gitProject);
    trackedIndexes.set(gitProject.root, pending);
    return pending.catch((error) => {
      trackedIndexes.delete(gitProject.root);
      throw error;
    });
  }

  async function classifyTrackedDestinations(
    gitProject: GitProject,
    projectRelativePaths: readonly string[],
  ): Promise<TrackedPathClassification> {
    if (projectRelativePaths.length === 0) return new Set();
    const indexedPaths = await listIndex(gitProject);
    return classifyPathsAgainstGitIndex(gitProject, projectRelativePaths, indexedPaths);
  }

  function readExcludeSnapshot(git: GitProject): Promise<GitExcludeSnapshot> {
    const key = excludeSnapshotKey(git.excludeFile);
    const existing = excludeSnapshots.get(key);
    if (existing) return existing;
    instrumentation.onReadExcludeSnapshot?.();
    const pending = readGitExcludeSnapshot(git);
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
