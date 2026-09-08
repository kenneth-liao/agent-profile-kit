import {
  type ProcessResult,
  runProcess,
} from "../../process/process-executor.js";

export interface ExecutableInvocationOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly cleanupGraceMs?: number;
}

export interface ExecutableInvocationError extends Error {
  code?: string | number | null;
  stdout?: string | undefined;
  stderr?: string | undefined;
  signal?: string | null;
  /** True when the bounded cleanup window expired with the group still present. */
  cleanupFailed?: boolean;
}

function invocationError(
  message: string,
  evidence: {
    readonly code: string | number | null;
    readonly signal: string | null;
    readonly stdout: string | undefined;
    readonly stderr: string | undefined;
    readonly cleanupFailed: boolean;
  },
): ExecutableInvocationError {
  const error: ExecutableInvocationError = new Error(message);
  error.code = evidence.code;
  error.signal = evidence.signal;
  error.cleanupFailed = evidence.cleanupFailed;
  // An unclean bounded termination must not carry captured output: Adapter
  // version resolvers recover parseable `stdout` into successful detection,
  // and a cleanup failure can never become a detected Host.
  if (!evidence.cleanupFailed) {
    error.stdout = evidence.stdout;
    error.stderr = evidence.stderr;
  }
  return error;
}

/**
 * Map one bounded executor result onto the probe's promise semantics: the
 * exact UTF-8 stdout and stderr on clean exit, or the rejection error. Pure
 * and exported for direct mapping coverage (including executor outcomes that
 * cannot be forced deterministically in a real process, such as an unclean
 * timeout). Unclean terminations surface `cleanupFailed` distinctly and drop
 * captured output.
 */
export function mapProcessResult(
  result: ProcessResult,
  timeoutMs: number,
): { readonly stderr: string; readonly stdout: string } | ExecutableInvocationError {
  const unclean = result.cleanupFailed;
  switch (result.kind) {
    case "exit":
      if (result.exitCode === 0) return { stderr: result.stderr, stdout: result.stdout };
      return invocationError(
        `Command failed with exit code ${result.exitCode}: ${result.commandLabel}`,
        { code: result.exitCode, signal: null, stdout: result.stdout, stderr: result.stderr, cleanupFailed: false },
      );
    case "signal":
      return invocationError(
        `Command failed with signal ${result.signal}: ${result.commandLabel}`,
        { code: null, signal: result.signal, stdout: result.stdout, stderr: result.stderr, cleanupFailed: false },
      );
    case "timeout":
      return invocationError(
        `Command failed: ${result.commandLabel}\nProcess timed out after ${timeoutMs}ms${unclean ? " and process-group cleanup failed" : ""}`,
        { code: "ETIMEDOUT", signal: result.signal, stdout: result.stdout, stderr: result.stderr, cleanupFailed: unclean },
      );
    case "output-limit":
      return invocationError(
        `Command failed: ${result.commandLabel}\nstdout or stderr exceeded the per-stream output budget${unclean ? " and process-group cleanup failed" : ""}`,
        { code: "ENOBUFS", signal: result.signal, stdout: result.stdout, stderr: result.stderr, cleanupFailed: unclean },
      );
    case "spawn-error": {
      const error = result.error as ExecutableInvocationError;
      error.stdout = result.stdout;
      error.stderr = result.stderr;
      return error;
    }
    case "cancelled":
      // invokeExecutable passes no abort signal, so cancellation cannot occur.
      return invocationError(`Command was cancelled unexpectedly: ${result.commandLabel}`, {
        code: null,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
        cleanupFailed: unclean,
      });
  }
}

/**
 * Invoke one executable through the repository bounded process executor and
 * retain its exact UTF-8 stdout and stderr. Completion is bounded: a stalled
 * child is terminated at `timeoutMs`, a stream exceeding the per-stream output
 * budget terminates the child, the whole process group is cleaned up with
 * SIGTERM-to-SIGKILL escalation, and the invocation rejects instead of staying
 * pending (DEC-022 non-gating probe contract).
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
  const mapped = mapProcessResult(result, options.timeoutMs);
  if (mapped instanceof Error) throw mapped;
  return mapped;
}
