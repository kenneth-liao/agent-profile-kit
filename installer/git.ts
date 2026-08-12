import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);

export interface GitProject {
  readonly commonDirectory: string;
  /** Repository-local exclude file shared by every worktree. */
  readonly excludeFile: string;
  readonly root: string;
  /** The bound project path relative to the Git worktree root. */
  readonly relativeProject: string;
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
 */
export async function findGitProject(project: string): Promise<GitProject | undefined> {
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
  const commonDirectory = await execFileAsync(
    "git",
    ["-C", project, "rev-parse", "--git-common-dir"],
    { encoding: "utf8" },
  );
  const root = await realpath(topLevel.stdout.trim());
  const relativeProject = slashPath(relative(root, project));
  if (relativeProject === ".." || relativeProject.startsWith("../")) {
    throw new Error(`Git reported project root ${root} outside bound project ${project}`);
  }
  const authoredCommonDirectory = commonDirectory.stdout.trim();
  const commonPath = isAbsolute(authoredCommonDirectory)
    ? authoredCommonDirectory
    : resolve(project, authoredCommonDirectory);
  await assertRealDirectoryPath(commonPath, `Git common directory for ${project}`);
  const common = await realpath(commonPath);
  return {
    commonDirectory: common,
    excludeFile: join(common, "info", "exclude"),
    root,
    relativeProject,
  };
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
 * Read the complete Git index once for a worktree root. Callers classify planned
 * destinations in memory so Profile size cannot hit the OS argv ceiling.
 * Real inspection failures fail closed.
 */
export async function listTrackedGitIndex(
  gitProject: Pick<GitProject, "root">,
): Promise<readonly string[]> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", gitProject.root, "ls-files", "-z"],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.stdout.length === 0) return [];
    return result.stdout.toString("utf8").split("\0").filter((entry) => entry.length > 0);
  } catch (error) {
    const failure = commandFailure(error);
    throw new Error(
      `Cannot inspect tracked Git index at '${gitProject.root}': ${failure.message}`,
    );
  }
}

/**
 * Classify project-relative destinations against one already-loaded Git index.
 * A destination is tracked when the index owns that exact path or any path
 * beneath it (including deleted working-tree files that remain indexed).
 */
export function classifyPathsAgainstGitIndex(
  gitProject: Pick<GitProject, "relativeProject">,
  projectRelativePaths: readonly string[],
  indexedPaths: readonly string[],
): TrackedPathClassification {
  if (projectRelativePaths.length === 0) return new Set();
  const tracked = new Set<string>();
  for (const path of new Set(projectRelativePaths)) {
    const rootRelative = rootRelativePath(gitProject, path);
    const prefix = `${rootRelative}/`;
    for (const indexed of indexedPaths) {
      if (indexed === rootRelative || indexed.startsWith(prefix)) {
        tracked.add(path);
        break;
      }
    }
  }
  return tracked;
}

/**
 * Classify many project-relative destinations against one Git index in a single
 * batched query. A destination is tracked when the index owns that exact path or
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
