import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Worktree facts provable from the bound Project alone: the worktree root and
 * the bound project path relative to it. These never depend on the exclusion
 * target and stay available when only the common directory is unprovable.
 */
export interface GitWorktree {
  readonly root: string;
  /** The bound project path relative to the Git worktree root. */
  readonly relativeProject: string;
}

export interface GitProject extends GitWorktree {
  readonly commonDirectory: string;
  /** Repository-local exclude file shared by every worktree. */
  readonly excludeFile: string;
}

function slashPath(path: string): string {
  return path.split(sep).join("/");
}

function commandFailure(error: unknown): { readonly code?: number; readonly message: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  const code = "code" in error && typeof error.code === "number" ? error.code : undefined;
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
  return { ...(code === undefined ? {} : { code }), message: stderr || error.message };
}

async function hasGitBoundary(project: string): Promise<boolean> {
  let directory = project;
  while (true) {
    try {
      await lstat(join(directory, ".git"));
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/**
 * Git is present but its topology cannot be proven: the authored common
 * directory resolves through a symlink or non-directory component. Per DEC-009
 * this failure never blocks an installation — callers treat Git topology as
 * unavailable, skip Repository Exclusion Contribution, and surface one
 * warning. It is distinct from a corrupt Git boundary, which still fails
 * closed.
 */
export class UnprovableGitTopologyError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "UnprovableGitTopologyError";
  }
}

export async function assertRealDirectoryPath(path: string, description: string): Promise<void> {
  const root = resolve(path, "/");
  let current = root;
  const relativePath = relative(root, path);
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${description} has non-directory or symlink component ${current}`);
    }
  }
}

/**
 * Return the Git worktree containing a project, or undefined for non-Git
 * projects. Git is an optional project surface, so an ordinary directory with
 * no Git boundary is not an ingestion error; a broken boundary fails closed.
 * Worktree identity is provable independently of the exclusion target: the
 * root and relative Project path stay available when the authored common
 * directory is unprovable (DEC-009), so tracked-path classification and
 * Adapter topology keep working while Repository Exclusion Contribution is
 * skipped.
 */
export async function findGitWorktree(project: string): Promise<GitWorktree | undefined> {
  let topLevel;
  try {
    topLevel = await execFileAsync(
      "git",
      ["-C", project, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
  } catch (error) {
    if (!(await hasGitBoundary(project))) return undefined;
    const failure = commandFailure(error);
    throw new Error(`Cannot inspect Git worktree at ${project}: ${failure.message}`);
  }
  const root = await realpath(topLevel.stdout.trim());
  const relativeProject = slashPath(relative(root, project));
  if (relativeProject === ".." || relativeProject.startsWith("../")) {
    throw new Error(`Git reported project root ${root} outside bound project ${project}`);
  }
  return { root, relativeProject };
}

/** Prove the exclusion target from a resolved worktree: common directory plus exclude file. */
export async function proveGitExclusionTarget(project: string): Promise<{
  readonly commonDirectory: string;
  readonly excludeFile: string;
}> {
  const commonDirectory = await execFileAsync(
    "git",
    ["-C", project, "rev-parse", "--git-common-dir"],
    { encoding: "utf8" },
  );
  const authoredCommonDirectory = commonDirectory.stdout.trim();
  const commonPath = isAbsolute(authoredCommonDirectory)
    ? authoredCommonDirectory
    : resolve(project, authoredCommonDirectory);
  try {
    await assertRealDirectoryPath(commonPath, `Git common directory for ${project}`);
  } catch (error) {
    throw new UnprovableGitTopologyError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
  const common = await realpath(commonPath);
  return {
    commonDirectory: common,
    excludeFile: join(common, "info", "exclude"),
  };
}

/**
 * Return the Git worktree with a proven exclusion target, or undefined for
 * non-Git projects. Throws UnprovableGitTopologyError when only the common
 * directory is unprovable; callers in the exclusion path treat that as one
 * warning, while every worktree/index consumer resolves findGitWorktree
 * instead so tracked classification stays fail-closed.
 */
export async function findGitProject(project: string): Promise<GitProject | undefined> {
  const worktree = await findGitWorktree(project);
  if (worktree === undefined) return undefined;
  const target = await proveGitExclusionTarget(project);
  return { ...worktree, ...target };
}

export function gitExcludeEntry(
  gitProject: Pick<GitProject, "relativeProject">,
  outputPath: string,
): string {
  return `/${[gitProject.relativeProject, slashPath(outputPath)].filter(Boolean).join("/")}`;
}

function rootRelativePath(gitProject: Pick<GitProject, "relativeProject">, path: string): string {
  return slashPath(
    [gitProject.relativeProject, path].filter((part) => part.length > 0).join("/"),
  );
}

/** Exact project-relative paths that are tracked themselves or have tracked descendants. */
export type TrackedPathClassification = ReadonlySet<string>;

/**
 * Sorted Git index paths for one worktree root. Built by streaming `git ls-files`
 * so repository size is not bounded by a fixed whole-output buffer.
 */
export type GitTrackedIndex = readonly string[];

/** First index of a value >= needle in a sorted ascending string array. */
function lowerBound(sorted: readonly string[], needle: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sorted[mid]! < needle) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * True when the sorted index owns `rootRelative` exactly or any path beneath it.
 * Uses one binary search so classification is O(log index) per destination.
 */
function indexOwnsPathOrDescendant(
  sortedIndex: GitTrackedIndex,
  rootRelative: string,
): boolean {
  const start = lowerBound(sortedIndex, rootRelative);
  if (start >= sortedIndex.length) return false;
  const candidate = sortedIndex[start]!;
  if (candidate === rootRelative) return true;
  return candidate.startsWith(`${rootRelative}/`);
}

/**
 * Stream the complete Git index once for a worktree root. Paths are returned in
 * ascending order for binary-search classification. Real inspection failures
 * fail closed. Does not buffer the whole stdout through `execFile`/`maxBuffer`.
 */
export async function listTrackedGitIndex(
  gitProject: Pick<GitProject, "root">,
): Promise<GitTrackedIndex> {
  return await new Promise<GitTrackedIndex>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "git",
      ["-C", gitProject.root, "ls-files", "-z"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const paths: string[] = [];
    let stdoutCarry = "";
    let stderr = "";
    let settled = false;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      const failure = commandFailure(error);
      rejectPromise(new Error(
        `Cannot inspect tracked Git index at '${gitProject.root}': ${failure.message}`,
      ));
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const combined = `${stdoutCarry}${chunk}`;
      const parts = combined.split("\0");
      stdoutCarry = parts.pop() ?? "";
      for (const part of parts) {
        if (part.length > 0) paths.push(part);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (stdoutCarry.length > 0) paths.push(stdoutCarry);
      if (code === 0) {
        // `git ls-files` is sorted; keep the contract explicit for synthetic indexes.
        paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
        resolvePromise(paths);
        return;
      }
      const detail = stderr.trim() ||
        (signal ? `terminated by signal ${signal}` : `exit ${code ?? "unknown"}`);
      rejectPromise(new Error(
        `Cannot inspect tracked Git index at '${gitProject.root}': ${detail}`,
      ));
    });
  });
}

/**
 * Classify project-relative destinations against one already-loaded sorted Git
 * index. A destination is tracked when the index owns that exact path or any
 * path beneath it (including deleted working-tree files that remain indexed).
 * Work is O(index build already paid + destinations × log index).
 */
export function classifyPathsAgainstGitIndex(
  gitProject: Pick<GitProject, "relativeProject">,
  projectRelativePaths: readonly string[],
  sortedIndex: GitTrackedIndex,
): TrackedPathClassification {
  if (projectRelativePaths.length === 0) return new Set();
  const tracked = new Set<string>();
  for (const path of new Set(projectRelativePaths)) {
    const rootRelative = rootRelativePath(gitProject, path);
    if (indexOwnsPathOrDescendant(sortedIndex, rootRelative)) tracked.add(path);
  }
  return tracked;
}

/**
 * Classify many project-relative destinations against one Git index in a single
 * streamed query. A destination is tracked when the index owns that exact path or
 * any path beneath it (including deleted working-tree files that remain indexed).
 * Real inspection failures fail closed.
 */
export async function classifyTrackedGitDestinations(
  gitProject: GitProject,
  projectRelativePaths: readonly string[],
): Promise<TrackedPathClassification> {
  if (projectRelativePaths.length === 0) return new Set();
  const indexedPaths = await listTrackedGitIndex(gitProject);
  return classifyPathsAgainstGitIndex(gitProject, projectRelativePaths, indexedPaths);
}

export async function isGitTrackedPath(
  project: string,
  path: string,
): Promise<boolean> {
  const gitProject = await findGitProject(project);
  if (!gitProject) return false;
  const relativePath = rootRelativePath(gitProject, path);
  try {
    const result = await execFileAsync(
      "git",
      ["-C", gitProject.root, "ls-files", "--error-unmatch", "--", relativePath],
      { encoding: "utf8" },
    );
    return result.stdout.trim().length > 0;
  } catch (error) {
    const failure = commandFailure(error);
    if (failure.code === 1) return false;
    throw new Error(`Cannot inspect tracked Git path '${relativePath}': ${failure.message}`);
  }
}

/**
 * True when Git tracks the path itself or any path under it (including deleted
 * working-tree files that remain in the index). Real inspection failures fail closed.
 */
export async function hasTrackedGitDescendants(
  project: string,
  path: string,
): Promise<boolean> {
  const gitProject = await findGitProject(project);
  if (!gitProject) return false;
  const relativePath = rootRelativePath(gitProject, path);
  try {
    const indexedPaths = await listTrackedGitIndex(gitProject);
    return classifyPathsAgainstGitIndex(gitProject, [path], indexedPaths).has(path);
  } catch (error) {
    const failure = commandFailure(error);
    // Preserve the historical single-path diagnostic surface used by callers and tests.
    const detail = failure.message.replace(
      /^Cannot inspect tracked Git index at '[^']+':\s*/,
      "",
    );
    throw new Error(
      `Cannot inspect tracked Git descendants under '${relativePath}': ${detail}`,
    );
  }
}
