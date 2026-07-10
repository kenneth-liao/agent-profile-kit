import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface GitProvenance {
  readonly commit: string;
  readonly dirty: boolean;
}

async function git(workspace: string, arguments_: readonly string[]): Promise<string | undefined> {
  try {
    const result = await executeFile("git", ["-C", workspace, ...arguments_], {
      encoding: "utf8",
    });
    return result.stdout;
  } catch {
    return undefined;
  }
}

export async function workspaceGitProvenance(
  workspace: string,
): Promise<GitProvenance | undefined> {
  const commit = (await git(workspace, ["rev-parse", "--verify", "HEAD"]))?.trim();
  if (!commit) return undefined;
  const status = await git(workspace, ["status", "--porcelain"]);
  if (status === undefined) return undefined;
  return { commit, dirty: status.length > 0 };
}
