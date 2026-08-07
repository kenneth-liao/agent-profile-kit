import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * One bounded, diagnostic process-execution boundary for test-runtime child
 * processes (packed CLI runs, PTY launches, and intentionally concurrent
 * children). Every child is spawned as a process-group leader with a finite
 * deadline; on timeout or cancellation the whole group is terminated within a
 * short cleanup grace period and escalated to SIGKILL when needed, so no
 * descendant is left behind.
 */

export interface ExecutorOptions {
  readonly executable: string;
  readonly arguments_: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Required finite deadline; a stalled child is terminated at this bound. */
  readonly deadlineMs: number;
  /** Optional stdin payload; when absent, stdin is closed immediately (EOF). */
  readonly input?: string;
  /** Grace period after SIGTERM before escalating to SIGKILL (default 500ms). */
  readonly cleanupGraceMs?: number;
  /** Label used in diagnostics to identify the command category. */
  readonly commandLabel?: string;
}

export interface ProcessResultBase {
  readonly kind: ProcessResultKind;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: Error | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly commandLabel: string;
}

export type ProcessResultKind =
  | "exit"
  | "signal"
  | "spawn-error"
  | "timeout"
  | "cancelled";

export interface ProcessExitResult extends ProcessResultBase {
  readonly kind: "exit";
  readonly exitCode: number;
  readonly signal: null;
  readonly error: null;
  readonly timedOut: false;
  readonly cancelled: false;
}

export interface ProcessSignalResult extends ProcessResultBase {
  readonly kind: "signal";
  readonly exitCode: null;
  readonly signal: string;
  readonly error: null;
  readonly timedOut: false;
  readonly cancelled: false;
}

export interface ProcessSpawnErrorResult extends ProcessResultBase {
  readonly kind: "spawn-error";
  readonly exitCode: null;
  readonly signal: null;
  readonly error: Error;
  readonly timedOut: false;
  readonly cancelled: false;
}

export interface ProcessTimeoutResult extends ProcessResultBase {
  readonly kind: "timeout";
  readonly timedOut: true;
  readonly cancelled: false;
  readonly error: null;
}

export interface ProcessCancelledResult extends ProcessResultBase {
  readonly kind: "cancelled";
  readonly timedOut: false;
  readonly cancelled: true;
  readonly error: null;
}

export type ProcessResult =
  | ProcessExitResult
  | ProcessSignalResult
  | ProcessSpawnErrorResult
  | ProcessTimeoutResult
  | ProcessCancelledResult;

type ChildProcessByStdio<TStdout, TStdin, TStderr> = ChildProcess & {
  readonly stdout: TStdout;
  readonly stdin: TStdin;
  readonly stderr: TStderr;
};

/**
 * Spawn one child with stdout/stderr piped for capture. stdin is /dev/null
 * unless input is provided: macOS `script` PTY children fail with
 * tcgetattr/ioctl when their stdin is a socket/pipe, and ordinary CLI children
 * see EOF either way. Piping stdin only when input is supplied keeps both
 * categories working through one executor.
 */
function spawnChild(options: {
  readonly executable: string;
  readonly arguments_: readonly string[];
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly input?: string;
}): ChildProcessByStdio<Readable, Writable | null, Readable> {
  if (options.input !== undefined) {
    return spawn(options.executable, [...options.arguments_], {
      cwd: options.cwd,
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
  }
  return spawn(options.executable, [...options.arguments_], {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

const DEFAULT_CLEANUP_GRACE_MS = 500;
const MAX_EVIDENCE_CHARS = 400;

function assertFiniteDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`runProcess deadline must be a positive finite number, got ${deadlineMs}`);
  }
}

/**
 * Run one child as a process-group leader, capture its output, and resolve with
 * a typed result that distinguishes normal exit, signal termination, spawn
 * failure, timeout, and cancellation. On timeout or cancellation the complete
 * child process group is terminated within the cleanup grace, escalating from
 * SIGTERM to SIGKILL, and no descendant is left running.
 */
export async function runProcess(
  options: ExecutorOptions,
  abortSignal?: AbortSignal,
): Promise<ProcessResult> {
  assertFiniteDeadline(options.deadlineMs);
  const commandLabel = options.commandLabel ?? options.executable;
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  let child: ChildProcessByStdio<Readable, Writable | null, Readable>;
  try {
    child = spawnChild(options);
  } catch (error) {
    return {
      kind: "spawn-error",
      exitCode: null,
      signal: null,
      error: error as Error,
      timedOut: false,
      cancelled: false,
      stdout: "",
      stderr: "",
      durationMs: elapsed(),
      commandLabel,
    };
  }

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  if (options.input !== undefined && child.stdin !== null) {
    // A closed stdin pipe may surface EPIPE; the child's own error is reported
    // through the 'error'/'close' events, so swallow stream-level noise here.
    child.stdin.on("error", () => {});
    child.stdin.write(options.input);
    child.stdin.end();
  }

  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (onAbort !== undefined) {
        abortSignal?.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };

    child.on("error", (error) => {
      finish({
        kind: "spawn-error",
        exitCode: null,
        signal: null,
        error,
        timedOut: false,
        cancelled: false,
        stdout,
        stderr,
        durationMs: elapsed(),
        commandLabel,
      });
    });

    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          kind: "timeout",
          exitCode: code,
          signal: signal ?? null,
          error: null,
          timedOut: true,
          cancelled: false,
          stdout,
          stderr,
          durationMs: elapsed(),
          commandLabel,
        });
      } else if (cancelled) {
        finish({
          kind: "cancelled",
          exitCode: code,
          signal: signal ?? null,
          error: null,
          timedOut: false,
          cancelled: true,
          stdout,
          stderr,
          durationMs: elapsed(),
          commandLabel,
        });
      } else if (code !== null) {
        finish({
          kind: "exit",
          exitCode: code,
          signal: null,
          error: null,
          timedOut: false,
          cancelled: false,
          stdout,
          stderr,
          durationMs: elapsed(),
          commandLabel,
        });
      } else {
        finish({
          kind: "signal",
          exitCode: null,
          signal: signal ?? "unknown",
          error: null,
          timedOut: false,
          cancelled: false,
          stdout,
          stderr,
          durationMs: elapsed(),
          commandLabel,
        });
      }
    });

    /**
     * Terminate the complete child process group within the cleanup grace,
     * escalating to SIGKILL, and always resolve so the executor itself can
     * never hang past the deadline plus two grace periods.
     */
    const terminateGroup = () => {
      if (settled) return;
      const grace = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
      const group = child.pid === undefined ? undefined : -child.pid;
      const outcome = (): ProcessResult =>
        timedOut
          ? {
              kind: "timeout",
              exitCode: null,
              signal: null,
              error: null,
              timedOut: true,
              cancelled: false,
              stdout,
              stderr,
              durationMs: elapsed(),
              commandLabel,
            }
          : {
              kind: "cancelled",
              exitCode: null,
              signal: null,
              error: null,
              timedOut: false,
              cancelled: true,
              stdout,
              stderr,
              durationMs: elapsed(),
              commandLabel,
            };
      if (group === undefined) {
        finish(outcome());
        return;
      }
      let termSent = false;
      try {
        process.kill(group, "SIGTERM");
        termSent = true;
      } catch {
        // Group already gone; 'close' will fire momentarily or finish below.
        termSent = false;
      }
      if (!termSent) {
        finish(outcome());
        return;
      }
      setTimeout(() => {
        if (settled) return;
        try {
          process.kill(group, "SIGKILL");
        } catch {
          // Group already gone.
        }
        setTimeout(() => {
          if (settled) return;
          finish(outcome());
        }, grace);
      }, grace);
    };

    const onAbort = () => {
      cancelled = true;
      terminateGroup();
    };

    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        cancelled = true;
        terminateGroup();
      } else {
        abortSignal.addEventListener("abort", onAbort);
      }
    }

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, options.deadlineMs);
  });
}

function snippet(value: string): string {
  const trimmed =
    value.length > MAX_EVIDENCE_CHARS
      ? `${value.slice(0, MAX_EVIDENCE_CHARS)}…`
      : value;
  return JSON.stringify(trimmed);
}

/** One-line, complete evidence summary for assertion failures. */
export function describeProcessResult(result: ProcessResult): string {
  const parts = [`kind=${result.kind}`, `command=${result.commandLabel}`];
  if (result.exitCode !== null) parts.push(`exitCode=${result.exitCode}`);
  if (result.signal !== null) parts.push(`signal=${result.signal}`);
  if (result.timedOut) parts.push("timedOut");
  if (result.cancelled) parts.push("cancelled");
  if (result.error !== null) parts.push(`error=${result.error.message}`);
  parts.push(`durationMs=${result.durationMs}`);
  parts.push(`stdout=${snippet(result.stdout)}`);
  parts.push(`stderr=${snippet(result.stderr)}`);
  return parts.join(" ");
}

/**
 * Assert a process exited normally with the expected code; on any other
 * outcome the failure output carries the complete exit, signal, error,
 * timeout, stdout, and stderr evidence instead of a bare `status: null`.
 */
export function expectExitCode(
  result: ProcessResult,
  expected: number,
  context = "process",
): void {
  if (result.kind !== "exit") {
    throw new Error(
      `${context}: expected exit code ${expected} but the process did not exit normally — ${describeProcessResult(result)}`,
    );
  }
  if (result.exitCode !== expected) {
    throw new Error(
      `${context}: expected exit code ${expected} but got ${result.exitCode} — ${describeProcessResult(result)}`,
    );
  }
}
