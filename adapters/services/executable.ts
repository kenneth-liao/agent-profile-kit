import { runProcess } from "../../process/process-executor.js";

export interface ExecutableInvocationOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly cleanupGraceMs?: number;
}

export interface ExecutableInvocationError extends Error {
  code?: string | number | null;
  stdout?: string;
  stderr?: string;
  signal?: string | null;
}

function invocationError(
  message: string,
  evidence: { readonly code: string | number | null; readonly signal: string | null; readonly stdout: string; readonly stderr: string },
): ExecutableInvocationError {
  const error: ExecutableInvocationError = new Error(message);
  error.code = evidence.code;
  error.signal = evidence.signal;
  error.stdout = evidence.stdout;
  error.stderr = evidence.stderr;
  return error;
}

/**
 * Invoke one executable through the repository bounded process executor and
 * retain its exact UTF-8 stdout and stderr. Completion is bounded: a stalled
 * child is terminated at `timeoutMs`, the whole process group is cleaned up
 * with SIGTERM-to-SIGKILL escalation, and the invocation rejects instead of
 * staying pending (DEC-022 non-gating probe contract).
 */
export async function invokeExecutable(
  executable: string,
  args: readonly string[],
  options: ExecutableInvocationOptions,
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  const result = await runProcess({
    executable,
    arguments_: [...args],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { environment: options.env }),
    deadlineMs: options.timeoutMs,
    ...(options.cleanupGraceMs === undefined ? {} : { cleanupGraceMs: options.cleanupGraceMs }),
    commandLabel: `${executable} ${args.join(" ")}`,
  });
  switch (result.kind) {
    case "exit":
      if (result.exitCode === 0) return { stderr: result.stderr, stdout: result.stdout };
      throw invocationError(
        `Command failed with exit code ${result.exitCode}: ${result.commandLabel}`,
        { code: result.exitCode, signal: null, stdout: result.stdout, stderr: result.stderr },
      );
    case "signal":
      throw invocationError(
        `Command failed with signal ${result.signal}: ${result.commandLabel}`,
        { code: null, signal: result.signal, stdout: result.stdout, stderr: result.stderr },
      );
    case "timeout":
      throw invocationError(
        `Command failed: ${result.commandLabel}\nProcess timed out after ${options.timeoutMs}ms`,
        { code: "ETIMEDOUT", signal: result.signal, stdout: result.stdout, stderr: result.stderr },
      );
    case "spawn-error": {
      const error = result.error as ExecutableInvocationError;
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      throw error;
    }
    case "cancelled":
      // invokeExecutable passes no abort signal, so cancellation cannot occur.
      throw invocationError(`Command was cancelled unexpectedly: ${result.commandLabel}`, {
        code: null,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
      });
  }
}
