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

export interface GitProjectCheckout extends GitProject {
  readonly project: string;
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

/** Enumerate only Git's authoritative worktree set for the bound repository. */
export async function listGitProjectCheckouts(
  gitProject: GitProject,
): Promise<readonly GitProjectCheckout[]> {
  const result = await execFileAsync(
    "git",
    ["-C", gitProject.root, "worktree", "list", "--porcelain", "-z"],
    { encoding: "utf8" },
  );
  const roots = result.stdout
    .split("\0\0")
    .flatMap((record) => {
      const fields = record.split("\0");
      if (fields.some((field) => field.startsWith("prunable "))) return [];
      const worktree = fields.find((field) => field.startsWith("worktree "));
      return worktree ? [worktree.slice("worktree ".length)] : [];
    });
  const checkouts: GitProjectCheckout[] = [];
  for (const authoredRoot of roots) {
    const root = await realpath(authoredRoot);
    let project = root;
    for (const component of gitProject.relativeProject.split("/").filter(Boolean)) {
      project = join(project, component);
      let stats;
      try {
        stats = await lstat(project);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new Error(
            `Git worktree ${root} is missing bound project directory '${gitProject.relativeProject}'`,
          );
        }
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          `Git worktree ${root} bound project path '${gitProject.relativeProject}' has non-directory or symlink component '${component}'`,
        );
      }
    }
    const canonicalProject = await realpath(project);
    const canonicalRelative = slashPath(relative(root, canonicalProject));
    if (canonicalRelative !== gitProject.relativeProject) {
      throw new Error(`Git worktree ${root} bound project path escapes its lexical checkout mapping`);
    }
    checkouts.push({
      commonDirectory: gitProject.commonDirectory,
      excludeFile: gitProject.excludeFile,
      project: canonicalProject,
      relativeProject: gitProject.relativeProject,
      root,
    });
  }
  return checkouts.sort((left, right) => left.project.localeCompare(right.project));
}

export function gitExcludeEntry(
  gitProject: Pick<GitProject, "relativeProject">,
  outputPath: string,
): string {
  return `/${[gitProject.relativeProject, slashPath(outputPath)].filter(Boolean).join("/")}`;
}

export async function isGitTrackedPath(
  project: string,
  path: string,
): Promise<boolean> {
  const gitProject = await findGitProject(project);
  if (!gitProject) return false;
  const relativePath = slashPath(
    [gitProject.relativeProject, path].filter((part) => part.length > 0).join("/"),
  );
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
