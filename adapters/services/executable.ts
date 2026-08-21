import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecutableInvocationOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

/** Invoke one executable and retain its exact UTF-8 stdout and stderr. */
export async function invokeExecutable(
  executable: string,
  args: readonly string[],
  options: ExecutableInvocationOptions,
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  const { stdout, stderr } = await execFileAsync(executable, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    encoding: "utf8",
    timeout: options.timeoutMs,
  });
  return { stderr, stdout };
}
