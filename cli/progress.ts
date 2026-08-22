/**
 * Delayed ephemeral progress for interactive long-running inspections.
 *
 * Progress is a rendering concern at the CLI presentation boundary: it writes
 * only to an interactive terminal stream, appears only after an anti-flicker
 * threshold, and is cleared before the final report. Redirected output, JSON,
 * and non-interactive errors never construct a reporter, so they cannot
 * contain progress bytes (DEC-031, DEC-032).
 */

/** Minimum elapsed time before progress may appear; faster operations never flicker. */
export const DELAYED_PROGRESS_THRESHOLD_MS = 300;

/** Cadence for appending an animation tick to a visible progress line. */
export const DELAYED_PROGRESS_TICK_MS = 500;

/** Cap on animated ticks; the line stays static beyond this so it cannot grow unbounded. */
export const DELAYED_PROGRESS_MAX_TICKS = 3;

/** Operation label for a long-running `status` inspection. */
export const STATUS_PROGRESS_LABEL = "Inspecting Projects";

/** Minimal stream contract so the seam is testable without a real TTY. */
export interface ProgressStream {
  write(chunk: string): unknown;
}

/**
 * Controllable timer seam. Tests inject a fake clock so anti-flicker delay
 * and cleanup are proven without wall-clock sleeps (TEST-011).
 */
export interface ProgressClock {
  setTimeout(callback: () => void, delayMs: number): () => void;
}

const defaultClock: ProgressClock = {
  setTimeout: (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(handle);
  },
};

export interface DelayedProgressOptions {
  readonly stream: ProgressStream;
  readonly operation: string;
  readonly clock?: ProgressClock;
}

export interface DelayedProgressHandle {
  /**
   * Clear any visible progress and cancel the pending timer. Safe to call
   * before the threshold fires; never writes in that case.
   */
  finish(): void;
}

/**
 * Schedule one operation-level progress line on an interactive stream.
 * Nothing is written until the anti-flicker threshold elapses; after that the
 * line is redrawn with up to {@link DELAYED_PROGRESS_MAX_TICKS} animation
 * ticks every {@link DELAYED_PROGRESS_TICK_MS}. `finish()` cancels the pending
 * timer and clears the line (carriage return plus spaces) so the final report
 * starts on a clean line and no progress bytes outlive the operation.
 */
export function beginDelayedProgress(
  options: DelayedProgressOptions,
): DelayedProgressHandle {
  const stream = options.stream;
  const operation = options.operation;
  const clock = options.clock ?? defaultClock;

  let shown = false;
  let ticks = 0;
  let finished = false;
  let pendingCancel: (() => void) | null = null;
  let maxLineWidth = 0;

  const redraw = (): void => {
    const line = `${operation}${".".repeat(ticks)}`;
    maxLineWidth = Math.max(maxLineWidth, line.length);
    stream.write(`\r${line}`);
  };

  const scheduleTick = (): void => {
    pendingCancel = clock.setTimeout(() => {
      ticks += 1;
      redraw();
      if (ticks < DELAYED_PROGRESS_MAX_TICKS) scheduleTick();
    }, DELAYED_PROGRESS_TICK_MS);
  };

  pendingCancel = clock.setTimeout(() => {
    pendingCancel = null;
    shown = true;
    redraw();
    scheduleTick();
  }, DELAYED_PROGRESS_THRESHOLD_MS);

  return {
    finish: () => {
      if (finished) return;
      finished = true;
      if (pendingCancel !== null) {
        pendingCancel();
        pendingCancel = null;
      }
      if (shown) {
        stream.write(`\r${" ".repeat(maxLineWidth)}\r`);
      }
    },
  };
}
