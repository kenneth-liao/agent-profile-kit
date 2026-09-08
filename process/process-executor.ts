import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

/**
 * One bounded, diagnostic process-execution boundary for every child process
 * the repository spawns: packed CLI runs, PTY launches, supervised test
 * runners, and production Adapter CLI probes. Every child is spawned as a
 * process-group leader with a finite deadline; on timeout or cancellation the
 * whole group is terminated within a short cleanup grace period and escalated
 * to SIGKILL when needed, and the result settles only once a group-empty probe
 * passes, so no descendant is left behind.
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
  /** True when the bounded cleanup window expired with the process group still present. */
  readonly cleanupFailed: boolean;
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
  | "output-limit"
  | "cancelled";

/**
 * Explicit cleanup-target policy shared by every executor mode. `runProcess`
 * owns a detached leader and therefore signals and probes its whole process
 * group (`-pid`); `runInteractiveProcess` spawns in the caller's foreground
 * process group and therefore signals and probes only its owned child pid.
 * The escalation/wait logic below is shared; the target is never inferred.
 */
type CleanupTarget =
  | { readonly policy: "process-group"; readonly pid: number }
  | { readonly policy: "owned-process"; readonly pid: number };

export interface ProcessExitResult extends ProcessResultBase {
  readonly kind: "exit";
  readonly exitCode: number;
  readonly signal: null;
  readonly error: null;
  readonly timedOut: false;
  readonly cancelled: false;
  readonly cleanupFailed: false;
}

export interface ProcessSignalResult extends ProcessResultBase {
  readonly kind: "signal";
  readonly exitCode: null;
  readonly signal: string;
  readonly error: null;
  readonly timedOut: false;
  readonly cancelled: false;
  readonly cleanupFailed: false;
}

export interface ProcessSpawnErrorResult extends ProcessResultBase {
  readonly kind: "spawn-error";
  readonly exitCode: null;
  readonly signal: null;
  readonly error: Error;
  readonly timedOut: false;
  readonly cancelled: false;
  readonly cleanupFailed: false;
}

export interface ProcessTimeoutResult extends ProcessResultBase {
  readonly kind: "timeout";
  readonly timedOut: true;
  readonly cancelled: false;
  readonly error: null;
}
export interface ProcessOutputLimitResult extends ProcessResultBase {
  readonly kind: "output-limit";
  readonly timedOut: false;
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
  | ProcessOutputLimitResult
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

/**
 * Per-stream output budget. A child streaming more is terminated through the
 * bounded cleanup lifecycle with kind "output-limit", so a runaway Host or
 * wrapper cannot exhaust memory before its deadline (the restored `execFile`
 * maxBuffer contract).
 */
export const MAX_OUTPUT_BYTES_PER_STREAM = 1024 * 1024;

/**
 * Default per-child deadline for packed-CLI and PTY test launches. Must stay
 * below the repository `bun test` per-test timeout (10s) so the executor's own
 * diagnostics surface before Bun aborts the test.
 */
export const TEST_CHILD_DEADLINE_MS = 8000;

function assertFiniteDeadline(deadlineMs: number): void {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`runProcess deadline must be a positive finite number, got ${deadlineMs}`);
  }
}

function signalTarget(target: CleanupTarget, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target.policy === "process-group" ? -target.pid : target.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function targetIsAlive(target: CleanupTarget): boolean {
  return signalTarget(target, 0);
}

/**
 * Shared bounded termination: SIGTERM, wait one grace period, probe, escalate
 * to SIGKILL, then poll until the target is gone or the window expires. The
 * returned boolean is the `cleanupFailed` evidence: true only when death could
 * not be confirmed within the window. No result ever implies cleanup that did
 * not happen.
 */
function terminateTarget(target: CleanupTarget, graceMs: number): Promise<boolean> {
  return new Promise((settle) => {
    const signalled = signalTarget(target, "SIGTERM");
    if (!signalled && !targetIsAlive(target)) {
      settle(false);
      return;
    }
    setTimeout(() => {
      if (!targetIsAlive(target)) {
        settle(false);
        return;
      }
      signalTarget(target, "SIGKILL");
      const pollDeadline = Date.now() + graceMs;
      const poll = () => {
        if (!targetIsAlive(target)) {
          settle(false);
          return;
        }
        if (Date.now() >= pollDeadline) {
          settle(true);
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    }, graceMs);
  });
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
      cleanupFailed: false,
      stdout: "",
      stderr: "",
      durationMs: elapsed(),
      commandLabel,
    };
  }

  let stdout = "";
  let stderr = "";
  if (options.input !== undefined && child.stdin !== null) {
    // A closed stdin pipe may surface EPIPE; the child's own error is reported
    // through the 'error'/'close' events, so swallow stream-level noise here.
    child.stdin.on("error", () => {});
    child.stdin.write(options.input);
    child.stdin.end();
  }

  return new Promise<ProcessResult>((resolve) => {
    let settled = false;
    // One immutable terminal cause: whichever of timeout/output-limit/
    // cancellation first wins owns the result label; the competing trigger
    // becomes a no-op, so the result never depends on cleanup timing.
    let terminalCause: "timeout" | "output-limit" | "cancelled" | null = null;
    let observedCode: number | null = null;
    let observedSignal: string | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const group = child.pid === undefined ? undefined : -child.pid;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (onAbort !== undefined) {
        abortSignal?.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };

    const outcome = (cleanupFailed: boolean): ProcessResult =>
      terminalCause === "timeout"
        ? {
            kind: "timeout",
            exitCode: observedCode,
            signal: observedSignal,
            error: null,
            timedOut: true,
            cancelled: false,
            cleanupFailed,
            stdout,
            stderr,
            durationMs: elapsed(),
            commandLabel,
          }
        : terminalCause === "output-limit"
        ? {
            kind: "output-limit",
            exitCode: observedCode,
            signal: observedSignal,
            error: null,
            timedOut: false,
            cancelled: false,
            cleanupFailed,
            stdout,
            stderr,
            durationMs: elapsed(),
            commandLabel,
          }
        : {
            kind: "cancelled",
            exitCode: observedCode,
            signal: observedSignal,
            error: null,
            timedOut: false,
            cancelled: true,
            cleanupFailed,
            stdout,
            stderr,
            durationMs: elapsed(),
            commandLabel,
          };

    // Per-stream output budget: retain at most the first budget bytes per
    // stream and terminate an exceeding child through the bounded cleanup
    // lifecycle, so memory stays finite even before the deadline.
    const capture = (stream: "stdout" | "stderr") => {
      let bytes = 0;
      return (chunk: Buffer) => {
        if (bytes >= MAX_OUTPUT_BYTES_PER_STREAM) return;
        const nextLength = bytes + chunk.length;
        if (nextLength > MAX_OUTPUT_BYTES_PER_STREAM) {
          chunk = chunk.subarray(0, MAX_OUTPUT_BYTES_PER_STREAM - bytes);
          bytes = MAX_OUTPUT_BYTES_PER_STREAM;
        } else {
          bytes = nextLength;
        }
        if (stream === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
        if (bytes >= MAX_OUTPUT_BYTES_PER_STREAM && terminalCause === null) {
          beginCleanup("output-limit");
        }
      };
    };
    child.stdout.on("data", capture("stdout"));
    child.stderr.on("data", capture("stderr"));

    child.on("error", (error) => {
      if (terminalCause !== null) return;
      finish({
        kind: "spawn-error",
        exitCode: null,
        signal: null,
        error,
        timedOut: false,
        cancelled: false,
        cleanupFailed: false,
        stdout,
        stderr,
        durationMs: elapsed(),
        commandLabel,
      });
    });

    child.on("close", (code, signal) => {
      observedCode = code;
      observedSignal = signal ?? null;
      if (terminalCause !== null) {
        // Cleanup owns resolution: the leader's close alone cannot prove the
        // group is empty, so terminateGroup's probe settles the result.
        return;
      }
      if (code !== null) {
        finish({
          kind: "exit",
          exitCode: code,
          signal: null,
          error: null,
          timedOut: false,
          cancelled: false,
          cleanupFailed: false,
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
          cleanupFailed: false,
          stdout,
          stderr,
          durationMs: elapsed(),
          commandLabel,
        });
      }
    });

    /**
     * Terminate the complete child process group within the cleanup grace,
     * escalating to SIGKILL, and settle only after the group-empty probe
     * passes. If the bounded window expires with the group still present,
     * settle with `cleanupFailed` so the result never implies cleanup that
     * did not happen. The detached leader makes the whole process group the
     * cleanup target (explicit policy, shared escalation in `terminateTarget`).
     */
    const terminateGroup = () => {
      if (settled || terminalCause === null) return;
      if (group === undefined) {
        finish(outcome(false));
        return;
      }
      void terminateTarget({ policy: "process-group", pid: child.pid! }, options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS)
        .then((cleanupFailed) => {
          if (!settled) finish(outcome(cleanupFailed));
        });
    };

    const beginCleanup = (cause: "timeout" | "output-limit" | "cancelled") => {
      if (settled || terminalCause !== null) return;
      terminalCause = cause;
      terminateGroup();
    };

    const handleAbort = () => beginCleanup("cancelled");
    onAbort = handleAbort;

    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        beginCleanup("cancelled");
      } else {
        abortSignal.addEventListener("abort", handleAbort);
      }
    }

    deadlineTimer = setTimeout(() => beginCleanup("timeout"), options.deadlineMs);
  });
}

export interface InteractiveExecutorOptions {
  readonly executable: string;
  readonly arguments_: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Content written to the child's stdin, then closed (EOF). */
  readonly stdin: string;
  /** Defaults to "inherit": screen output belongs on the terminal, uncaptured. */
  readonly stdoutMode?: "inherit" | "pipe" | "ignore";
  readonly stderrMode?: "inherit" | "pipe" | "ignore";
  /** Grace period after SIGTERM before escalating to SIGKILL (default 500ms). */
  readonly cleanupGraceMs?: number;
  /** Label used in diagnostics to identify the command category. */
  readonly commandLabel?: string;
}

export type InteractiveProcessResultKind =
  | "exit"
  | "signal"
  | "spawn-error"
  | "stdin-error"
  | "cancelled";

/**
 * Typed result of one interactive child. There is no timeout kind: an
 * interactive child (a pager a user is reading) has no deadline by design;
 * the only bounded lifecycle is cleanup after cancellation or a delivery
 * failure. `cleanupFailed` preserves evidence of termination that could not
 * be confirmed — it is never swallowed and never implies success.
 */
export interface InteractiveProcessResult {
  readonly kind: InteractiveProcessResultKind;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: Error | null;
  readonly cleanupFailed: boolean;
  readonly durationMs: number;
  readonly commandLabel: string;
}

/**
 * Run one interactive child (a pager) in the caller's foreground process
 * group so it can read the terminal directly (no detached spawn, no SIGTTIN),
 * with stdout/stderr inherited by default and the supplied content piped to
 * its stdin. No deadline: the child runs until it exits or the caller aborts.
 * Cancellation terminates the owned child pid through the shared escalation
 * logic (`terminateTarget`, explicit "owned-process" policy) and preserves
 * `cleanupFailed` evidence. EPIPE from a child quitting before draining stdin
 * is an ordinary early quit; any other stdin error is a distinct typed
 * failure, never swallowed.
 */
export async function runInteractiveProcess(
  options: InteractiveExecutorOptions,
  abortSignal?: AbortSignal,
): Promise<InteractiveProcessResult> {
  const commandLabel = options.commandLabel ?? options.executable;
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  let child: ChildProcess;
  try {
    child = spawn(options.executable, [...options.arguments_], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.environment === undefined ? {} : { env: options.environment }),
      stdio: [
        "pipe",
        options.stdoutMode ?? "inherit",
        options.stderrMode ?? "inherit",
      ],
    });
  } catch (error) {
    return {
      kind: "spawn-error",
      exitCode: null,
      signal: null,
      error: error as Error,
      cleanupFailed: false,
      durationMs: elapsed(),
      commandLabel,
    };
  }

  return new Promise<InteractiveProcessResult>((resolve) => {
    let settled = false;
    let terminalCause: "stdin-error" | "cancelled" | null = null;
    let observedCode: number | null = null;
    let observedSignal: string | null = null;
    let stdinError: Error | null = null;
    let onAbort: (() => void) | undefined;

    const finish = (result: InteractiveProcessResult) => {
      if (settled) return;
      settled = true;
      if (onAbort !== undefined) abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const base = (cleanupFailed: boolean) => ({
      exitCode: observedCode,
      signal: observedSignal,
      cleanupFailed,
      durationMs: elapsed(),
      commandLabel,
    });

    // EPIPE is the child quitting before draining stdin — expected. Any other
    // stdin error is content-delivery failure: stop the child through the
    // bounded lifecycle and report it as its own typed kind.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || terminalCause !== null) return;
      stdinError = error;
      beginCleanup("stdin-error");
    });

    child.on("error", (error) => {
      if (terminalCause !== null) return;
      finish({
        kind: "spawn-error",
        exitCode: null,
        signal: null,
        error,
        cleanupFailed: false,
        durationMs: elapsed(),
        commandLabel,
      });
    });

    child.on("close", (code, signal) => {
      observedCode = code;
      observedSignal = signal ?? null;
      if (terminalCause !== null) {
        // Cleanup owns resolution: terminateCleanup settles below.
        return;
      }
      if (code !== null) {
        finish({ kind: "exit", error: null, ...base(false) });
      } else {
        finish({ kind: "signal", error: null, ...base(false) });
      }
    });

    const terminateCleanupSettled = (cleanupFailed: boolean) => {
      if (settled) return;
      if (terminalCause === "stdin-error") {
        finish({
          kind: "stdin-error",
          exitCode: observedCode,
          signal: observedSignal,
          error: stdinError,
          cleanupFailed,
          durationMs: elapsed(),
          commandLabel,
        });
        return;
      }
      finish({
        kind: "cancelled",
        exitCode: observedCode,
        signal: observedSignal,
        error: null,
        cleanupFailed,
        durationMs: elapsed(),
        commandLabel,
      });
    };

    const beginCleanup = (cause: "stdin-error" | "cancelled") => {
      if (terminalCause !== null) return;
      terminalCause = cause;
      if (child.pid === undefined) {
        terminateCleanupSettled(false);
        return;
      }
      terminateTarget(
        { policy: "owned-process", pid: child.pid },
        options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS,
      ).then(terminateCleanupSettled);
    };

    const handleAbort = () => beginCleanup("cancelled");
    onAbort = handleAbort;
    if (abortSignal !== undefined) {
      if (abortSignal.aborted) {
        beginCleanup("cancelled");
      } else {
        abortSignal.addEventListener("abort", handleAbort);
      }
    }

    child.stdin?.write(options.stdin);
    child.stdin?.end();
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
  if (result.cleanupFailed) parts.push("cleanupFailed");
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
