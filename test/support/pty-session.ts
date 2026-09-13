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
 * one. No terminal emulator is implemented or needed.
 */
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import type { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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
   * executor's TERM→KILL escalation runs. Returns the executor's result so
   * `cleanupFailed` evidence is never swallowed.
   */
  close(): Promise<InteractiveProcessResult>;
  /**
   * Abrupt termination: abort immediately (no polite window) and settle with
   * the executor's typed result. The repaired controller kills and reaps the
   * owned PTY child on TERM and records evidence in the transcript.
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

export async function startPtySession(
  driverArguments: readonly string[],
  columns: number,
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
        String(PER_TEST_TIMEOUT_MS),
        process.execPath,
        driverPath,
        ...driverArguments,
      ],
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
    const exited = await Promise.race([
      execution.then(() => true),
      sleep(5000).then(() => false),
    ]);
    if (!exited) abort.abort();
    return execution;
  };

  return {
    write(data: string): void {
      ownedStdin?.write(data);
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
    close: settle,
    terminate: async () => {
      abort.abort();
      return execution;
    },
    get controllerPid(): number {
      return controllerPid;
    },
    runDirectory,
  };
}