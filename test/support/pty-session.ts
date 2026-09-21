/**
 * Canonical real-PTY session for interactive qualification (tickets #495,
 * #499, #500, #542). The controller process is owned by the shared bounded
 * executor (`runInteractiveProcess`, stream stdin): its foreground group, no
 * deadline, and its TERM→KILL escalation are the only cleanup lifecycle —
 * no private spawn, no private kill here. The controller's own absolute
 * watchdog (PER_TEST_TIMEOUT_MS) stays the child-side bound.
 *
 * Synchronization contract (#542): input is sent only after the required
 * prompt/redraw state is OBSERVED. Every wait matches only transcript
 * content appended after a byte offset captured immediately BEFORE the
 * triggering write, so a stale prior render can neither trigger the next
 * input nor let input run ahead of the active question. Matching strips ANSI
 * and collapses whitespace (redraws re-emit content); raw transcript bytes
 * and ANSI are preserved. Trailing partial UTF-8 or escape sequences are
 * transient across polls: they can delay a match by one poll, never fake
 * one. (A multibyte character straddling the captured offset decodes as a
 * stable U+FFFD on every poll — fragments are matched after that boundary,
 * which is why offsets are captured at input boundaries.) No terminal
 * emulator is implemented or needed.
 *
 * The required prompt state for a keystroke is the question prompt itself,
 * never a document fragment that renders before it: the PTY slave starts in
 * canonical mode, so a keystroke written before the prompt enables raw mode
 * is echoed but held un-newlined in the line buffer and is never delivered
 * once ICANON is switched off (PR #622 INT-FLAKE-1) — the prompt then waits
 * forever. Gating on a prompt fragment, never on preceding document text,
 * is what makes a wait's completion a safe signal to write.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import type { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  describeProcessResult,
  runInteractiveProcess,
  type InteractiveProcessResult,
} from "../../process/process-executor.js";
import { PER_TEST_TIMEOUT_MS } from "./suite-supervisor.js";

/** Strip ANSI styling for structural matching (ESC included — fragments
 * like `›writ` straddle the `[39m ` boundary that a bracket-only regex
 * would leave a bare ESC inside of). */
export function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Collapse all whitespace so wrapped terminal lines still match. */
export function squash(text: string): string {
  return plain(text).replace(/\s+/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PtySession {
  /** Write keystrokes to the controller's forwarded PTY input. */
  write(data: string): void;
  /** Raw transcript so far (append-only log of PTY output). */
  transcript(): string;
  /** Current transcript size in bytes — capture BEFORE the triggering write. */
  transcriptLength(): number;
  /**
   * Wait until `fragment` appears in content appended after `after` bytes.
   * Capture the offset with `transcriptLength()` immediately before the
   * triggering input write; never reuse a wait's completion as the next
   * offset — unrelated output emitted between polls must stay visible to
   * later waits. With `raw: true` the fragment is matched against the raw
   * bytes (ANSI preserved) — for observables that live only in styling,
   * such as a multiselect highlight move.
   */
  waitForTranscript(
    fragment: string,
    options?: { readonly after?: number; readonly deadlineMs?: number; readonly raw?: boolean },
  ): Promise<{ readonly text: string }>;
  /**
   * Polite close: end owned stdin, wait a bounded window, then abort so the
   * executor's TERM→KILL escalation runs. The teardown contract is enforced
   * here: a `cleanupFailed` result, a controller failure, a watchdog firing,
   * or any non-natural-exit outcome throws with the retained diagnostics —
   * a failed teardown can never pass qualification (#542 review,
   * INT-BOUNDARY-1). Exit 0 is required unless the caller explicitly declares
   * another expected child exit at session creation.
   */
  close(): Promise<InteractiveProcessResult>;
  /**
   * Explicit intentional abort: abort immediately (no polite window) and
   * settle with the executor's typed result. The contract is enforced: the
   * result must be `cancelled` with confirmed cleanup — anything else throws
   * with retained diagnostics.
   */
  terminate(): Promise<InteractiveProcessResult>;
  /** The executor-owned controller pid. */
  readonly controllerPid: number;
  /** Run directory holding the transcript; callers own its removal. */
  readonly runDirectory: string;
}

// Transcript waits derive from the canonical per-test timeout policy
// (PER_TEST_TIMEOUT_MS): the diagnostic below stays reachable because bun
// kills the test only after this deadline passes.
const TRANSCRIPT_DEADLINE_MS = Math.floor(PER_TEST_TIMEOUT_MS * 0.8);

// The allocated PTY is the terminal under test, so its TERM is supplied
// explicitly here, never inherited (the terminal-configuration policy in
// controlled-environment.ts): an ambient TERM=dumb turns prompt styling off
// and starves the raw ANSI waits (#626). The rest of the ambient environment
// passes through deliberately — this seam has no fixture HOME or PATH.
const PTY_TERM = "xterm-256color";

export interface PtySessionOptions {
  /** Natural child outcome required by close (for example 1 for Ctrl-C). */
  readonly expectedExitCode?: number;
  /** Watchdog for the owned PTY child, in milliseconds. Defaults to the
   * canonical per-test policy; normalized to whole controller seconds once,
   * at this boundary. */
  readonly watchdogMs?: number;
}

function teardownContractError(
  result: InteractiveProcessResult,
  transcript: string,
  expectation: string,
): Error {
  return new Error(
    `PTY session teardown contract violated (expected ${expectation})\n`
    + describeProcessResult(result)
    + `\n--- transcript tail ---\n${plain(transcript).slice(-2000)}`,
  );
}

export async function startPtySession(
  driverArguments: readonly string[],
  columns: number,
  options: PtySessionOptions = {},
): Promise<PtySession> {
  if (Bun.which("python3") === null) {
    throw new Error("PTY tests require python3 for the pty-controller");
  }
  const runDirectory = mkdtempSync(join(tmpdir(), "agent-profile-kit-pty-run-"));
  const transcriptPath = join(runDirectory, "transcript.log");
  const controllerPath = join(import.meta.dir, "pty-controller.py");
  const driverPath = join(import.meta.dir, "searchable-pty-driver.ts");
  const abort = new AbortController();
  let ownedStdin: Writable | undefined;
  let controllerPid = 0;
  const execution = runInteractiveProcess(
    {
      executable: "python3",
      arguments_: [
        controllerPath,
        transcriptPath,
        String(columns),
        // The controller measures its watchdog in whole seconds — normalize
        // the canonical millisecond policy exactly once, here.
        String(Math.round((options.watchdogMs ?? PER_TEST_TIMEOUT_MS) / 1000)),
        process.execPath,
        driverPath,
        ...driverArguments,
      ],
      environment: { ...process.env, TERM: PTY_TERM },
      stdin: {
        kind: "stream",
        onStarted: (owned) => {
          ownedStdin = owned.stdin;
          controllerPid = owned.pid;
        },
      },
      stdoutMode: "ignore",
      stderrMode: "ignore",
      commandLabel: "pty-controller",
    },
    abort.signal,
  );

  const readTranscript = (): string => {
    try {
      return readFileSync(transcriptPath, "utf8");
    } catch {
      return "";
    }
  };

  const settle = async (): Promise<InteractiveProcessResult> => {
    // Polite close begins with EOF on the owned stdin (EPIPE from a child
    // that already quit is expected); the bounded window and abort follow.
    try {
      ownedStdin?.end();
    } catch {
      // The driver may already have exited.
    }
    const exited = await Promise.race([
      execution.then(() => true),
      sleep(5000).then(() => false),
    ]);
    if (!exited) abort.abort();
    return execution;
  };

  const enforceNaturalTeardown = (result: InteractiveProcessResult): InteractiveProcessResult => {
    const transcript = readTranscript();
    if (result.cleanupFailed) {
      throw teardownContractError(result, transcript, "confirmed owned-process cleanup");
    }
    if (result.kind !== "exit") {
      throw teardownContractError(result, transcript, "a naturally exited controller");
    }
    if (transcript.includes("PTY-CONTROLLER-WATCHDOG")) {
      // A watchdog firing under polite close is an unintended bounded-child
      // outcome; the evidence marker makes it unambiguous.
      throw teardownContractError(result, transcript, "no watchdog firing");
    }
    const expectedExitCode = options.expectedExitCode ?? 0;
    if (result.exitCode !== expectedExitCode
      || !transcript.endsWith(`PTY-CONTROLLER-EXIT status=${expectedExitCode} signals=0\n`)) {
      throw teardownContractError(result, transcript, `completed child exit ${expectedExitCode}`);
    }
    return result;
  };

  const enforceCancelledTeardown = (result: InteractiveProcessResult): InteractiveProcessResult => {
    if (result.kind !== "cancelled" || result.cleanupFailed) {
      throw teardownContractError(
        result,
        readTranscript(),
        "an intentionally aborted session with confirmed cleanup",
      );
    }
    return result;
  };

  // Once one contract was enforced (e.g. an intentional terminate), later
  // close() calls return that already-enforced result instead of re-running
  // the natural-exit contract against an aborted session.
  let enforcedTeardown: InteractiveProcessResult | undefined;

  return {
    write(data: string): void {
      if (ownedStdin === undefined) {
        throw new Error("PTY session stdin is not started; wait for the session to start before writing");
      }
      ownedStdin.write(data);
    },
    transcript: readTranscript,
    transcriptLength(): number {
      try {
        return readFileSync(transcriptPath).length;
      } catch {
        return 0;
      }
    },
    async waitForTranscript(fragment, options = {}) {
      const wanted = squash(fragment);
      const deadline = Date.now() + (options.deadlineMs ?? TRANSCRIPT_DEADLINE_MS);
      for (;;) {
        // The controller opens the transcript after pty.fork; until then the
        // file is absent — a normal pre-first-output state to poll through.
        let bytes: Buffer;
        try {
          bytes = readFileSync(transcriptPath).subarray(options.after ?? 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          bytes = Buffer.alloc(0);
        }
        // A trailing incomplete escape sequence must not leak its bytes into
        // the matchable text; completed sequences strip in squash anyway.
        const fresh = bytes
          .toString("utf8")
          .replace(/\x1b(?:\[[0-9;?]*[ -/]*)?$/, "");
        const matched = options.raw === true
          ? fresh.includes(fragment)
          : squash(fresh).includes(wanted);
        if (matched) return { text: readTranscript() };
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for PTY fragment: ${fragment}\n--- transcript ---\n${plain(readTranscript()).slice(-2000)}`,
          );
        }
        await sleep(100);
      }
    },
    close: async () => {
      if (enforcedTeardown !== undefined) return enforcedTeardown;
      const result = enforceNaturalTeardown(await settle());
      if (enforcedTeardown === undefined) enforcedTeardown = result;
      return result;
    },
    terminate: async () => {
      abort.abort();
      const result = enforceCancelledTeardown(await execution);
      enforcedTeardown = result;
      return result;
    },
    get controllerPid(): number {
      return controllerPid;
    },
    runDirectory,
  };
}