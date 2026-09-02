import {
  classifyPathsAgainstGitIndex,
  findGitWorktree,
  listTrackedGitIndex,
  proveGitExclusionTarget,
  UnprovableGitTopologyError,
  type GitProject,
  type GitWorktree,
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
    worktree: GitWorktree,
    projectRelativePaths: readonly string[],
  ): Promise<TrackedPathClassification>;
  findGitProject(project: string): Promise<GitProject | undefined>;
  findGitWorktree(project: string): Promise<GitWorktree | undefined>;
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
  const worktrees = new Map<string, Promise<GitWorktree | undefined>>();
  const gitProjects = new Map<string, Promise<GitProject | undefined>>();
  /** One index listing per Git worktree root within this pass. */
  const trackedIndexes = new Map<string, Promise<readonly string[]>>();
  const excludeSnapshots = new Map<string, Promise<GitExcludeSnapshot>>();

  function findWorktree(project: string): Promise<GitWorktree | undefined> {
    const existing = worktrees.get(project);
    if (existing) return existing;
    instrumentation.onFindGitProject?.();
    const pending = findGitWorktree(project);
    worktrees.set(project, pending);
    return pending.catch((error) => {
      worktrees.delete(project);
      throw error;
    });
  }

  function findProject(project: string): Promise<GitProject | undefined> {
    const existing = gitProjects.get(project);
    if (existing) return existing;
    // One worktree resolution per Project per invocation: the exclusion-target
    // proof composes on top of it, so exclusion readers and worktree consumers
    // never run a second topology inspection.
    const pending = findWorktree(project).then(async (worktree) =>
      worktree === undefined ? undefined : { ...worktree, ...await proveGitExclusionTarget(project) }
    );
    gitProjects.set(project, pending);
    return pending.catch((error) => {
      // An unprovable topology is one invocation-scoped fact: keep the
      // rejection cached so every consumer shares one inspection and one
      // warning source. Other failures stay uncached for retry.
      if (error instanceof UnprovableGitTopologyError) throw error;
      gitProjects.delete(project);
      throw error;
    });
  }

  function listIndex(worktree: GitWorktree): Promise<readonly string[]> {
    const existing = trackedIndexes.get(worktree.root);
    if (existing) return existing;
    instrumentation.onClassifyTrackedPaths?.();
    const pending = listTrackedGitIndex(worktree);
    trackedIndexes.set(worktree.root, pending);
    return pending.catch((error) => {
      trackedIndexes.delete(worktree.root);
      throw error;
    });
  }

  async function classifyTrackedDestinations(
    worktree: GitWorktree,
    projectRelativePaths: readonly string[],
  ): Promise<TrackedPathClassification> {
    if (projectRelativePaths.length === 0) return new Set();
    const indexedPaths = await listIndex(worktree);
    return classifyPathsAgainstGitIndex(worktree, projectRelativePaths, indexedPaths);
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
    findGitWorktree: findWorktree,
    readExcludeSnapshot,
  };
}
