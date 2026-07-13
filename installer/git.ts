import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";

const execFileAsync = promisify(execFile);

export interface GitProject {
  readonly root: string;
  /** The bound project path relative to the Git worktree root. */
  readonly relativeProject: string;
}

function slashPath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Return the Git worktree containing a project, or undefined for non-Git
 * projects. Git is an optional project surface, so a failed rev-parse is not
 * itself an ingestion error.
 */
export async function findGitProject(project: string): Promise<GitProject | undefined> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", project, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    );
    const root = await realpath(result.stdout.trim());
    const relativeProject = slashPath(relative(root, project));
    if (relativeProject === ".." || relativeProject.startsWith("../")) return undefined;
    return { root, relativeProject };
  } catch {
    return undefined;
  }
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
  } catch {
    return false;
  }
}
