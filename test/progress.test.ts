import { describe, expect, test } from "bun:test";

import {
  beginDelayedProgress,
  DELAYED_PROGRESS_MAX_TICKS,
  DELAYED_PROGRESS_THRESHOLD_MS,
  DELAYED_PROGRESS_TICK_MS,
  PREVIEW_PROGRESS_LABEL,
  STATUS_PROGRESS_LABEL,
  type ProgressClock,
  type ProgressStream,
} from "../cli/progress.js";

/** Records every chunk written to a stream for byte-level assertions. */
class RecordingStream implements ProgressStream {
  readonly chunks: string[] = [];

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  get output(): string {
    return this.chunks.join("");
  }
}

/** A controllable clock: timers fire only when `advance` crosses their due time. */
class FakeClock implements ProgressClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): () => void {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => {
      this.timers.delete(id);
    };
  }

  /** Advance the clock and run every timer whose due time is now reached. */
  advance(delayMs: number): void {
    this.time += delayMs;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.time)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (due === undefined) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

describe("delayed interactive progress", () => {
  test("an inspection completing before the anti-flicker threshold emits no progress bytes", () => {
    const stream = new RecordingStream();
    const clock = new FakeClock();
    const progress = beginDelayedProgress({ clock, operation: STATUS_PROGRESS_LABEL, stream });

    clock.advance(DELAYED_PROGRESS_THRESHOLD_MS - 1);
    progress.finish();

    expect(stream.output).toBe("");
    // The cancelled threshold timer must never fire later.
    clock.advance(10_000);
    expect(stream.output).toBe("");
  });

  test("progress appears only after the anti-flicker threshold and names the operation", () => {
    const stream = new RecordingStream();
    const clock = new FakeClock();
    const progress = beginDelayedProgress({ clock, operation: PREVIEW_PROGRESS_LABEL, stream });

    clock.advance(DELAYED_PROGRESS_THRESHOLD_MS - 1);
    expect(stream.output).toBe("");

    clock.advance(1);
    expect(stream.output).toBe(`\r${PREVIEW_PROGRESS_LABEL}`);
  });

  test("progress ticks are capped and the line is cleared before completion", () => {
    const stream = new RecordingStream();
    const clock = new FakeClock();
    const progress = beginDelayedProgress({ clock, operation: STATUS_PROGRESS_LABEL, stream });

    clock.advance(DELAYED_PROGRESS_THRESHOLD_MS);
    for (let tick = 1; tick <= DELAYED_PROGRESS_MAX_TICKS + 2; tick += 1) {
      clock.advance(DELAYED_PROGRESS_TICK_MS);
    }
    const expectedTicks = ".".repeat(DELAYED_PROGRESS_MAX_TICKS);
    expect(stream.output.endsWith(`\r${STATUS_PROGRESS_LABEL}${expectedTicks}`)).toBe(true);

    progress.finish();
    const finalChunk = stream.chunks[stream.chunks.length - 1]!;
    expect(finalChunk).toMatch(/^\r +\r$/);
    expect(finalChunk.length - 2).toBe(`${STATUS_PROGRESS_LABEL}${expectedTicks}`.length);
  });

  test("finishing clears a visible progress line and leaves no stale bytes after it", () => {
    const stream = new RecordingStream();
    const clock = new FakeClock();
    const progress = beginDelayedProgress({ clock, operation: PREVIEW_PROGRESS_LABEL, stream });

    clock.advance(DELAYED_PROGRESS_THRESHOLD_MS);
    clock.advance(DELAYED_PROGRESS_TICK_MS);
    progress.finish();

    expect(stream.chunks.at(-2)).toBe(`\r${PREVIEW_PROGRESS_LABEL}.`);
    expect(stream.chunks.at(-1)).toMatch(/^\r +\r$/);
  });

  test("finish is idempotent and never writes after the clear", () => {
    const stream = new RecordingStream();
    const clock = new FakeClock();
    const progress = beginDelayedProgress({ clock, operation: STATUS_PROGRESS_LABEL, stream });

    clock.advance(DELAYED_PROGRESS_THRESHOLD_MS);
    progress.finish();
    progress.finish();
    clock.advance(10_000);

    expect(stream.chunks).toHaveLength(2);
    expect(stream.chunks[1]).toMatch(/^\r +\r$/);
  });
});
