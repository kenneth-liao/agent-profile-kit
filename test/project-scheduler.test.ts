import { describe, expect, test } from "bun:test";

import {
  createProjectReadScheduler,
  DEFAULT_PROJECT_CONCURRENCY,
} from "../installer/project-scheduler.js";

/** A promise whose settlement is controlled explicitly by the test. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Track how many scheduler tasks have started; wait for a count without sleeps. */
function startWaiter(): {
  readonly started: () => number;
  readonly onTaskStart: () => void;
  readonly waitFor: (count: number) => Promise<void>;
} {
  let started = 0;
  const listeners = new Set<() => void>();
  return {
    started: () => started,
    onTaskStart: () => {
      started += 1;
      for (const listener of [...listeners]) listener();
    },
    waitFor: (count: number) => {
      if (started >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const listener = (): void => {
          if (started >= count) {
            listeners.delete(listener);
            resolve();
          }
        };
        listeners.add(listener);
      });
    },
  };
}

/**
 * Create `count` gated tasks that each block on an externally released gate,
 * recording the peak number of tasks in flight at any moment.
 */
function gatedTasks(count: number): {
  readonly gates: readonly (() => void)[];
  readonly maxInFlight: () => number;
  readonly tasks: readonly (() => Promise<number>)[];
} {
  const gates = Array.from({ length: count }, deferred);
  let inFlight = 0;
  let maxInFlight = 0;
  const tasks = gates.map((gate, index) => async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate.promise;
    inFlight -= 1;
    return index;
  });
  return {
    gates: gates.map((gate) => gate.release),
    maxInFlight: () => maxInFlight,
    tasks,
  };
}

describe("bounded Project read scheduler", () => {
  test("exposes one fixed product-policy concurrency bound", () => {
    expect(DEFAULT_PROJECT_CONCURRENCY).toBe(4);
  });

  test("overlaps independent reads with deferred readers instead of wall-clock timing", async () => {
    const gated = gatedTasks(8);
    const waiter = startWaiter();
    const scheduler = createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY, waiter);
    const running = scheduler.run(gated.tasks);

    // Four readers are in flight simultaneously: the scheduler overlaps work
    // instead of running each read to completion before the next starts.
    await waiter.waitFor(DEFAULT_PROJECT_CONCURRENCY);
    expect(gated.maxInFlight()).toBe(DEFAULT_PROJECT_CONCURRENCY);
    expect(gated.maxInFlight()).toBeGreaterThan(1);

    // Release the first wave; the second wave starts without exceeding the bound.
    for (const release of gated.gates.slice(0, 4)) release();
    await waiter.waitFor(8);
    expect(gated.maxInFlight()).toBeLessThanOrEqual(DEFAULT_PROJECT_CONCURRENCY);

    for (const release of gated.gates.slice(4)) release();
    await expect(running).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(gated.maxInFlight()).toBeLessThanOrEqual(DEFAULT_PROJECT_CONCURRENCY);
  });

  test("never lets active Project work exceed the fixed concurrency bound", async () => {
    const gated = gatedTasks(12);
    const waiter = startWaiter();
    const scheduler = createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY, waiter);
    const running = scheduler.run(gated.tasks);

    await waiter.waitFor(DEFAULT_PROJECT_CONCURRENCY);
    expect(gated.maxInFlight()).toBe(DEFAULT_PROJECT_CONCURRENCY);

    // Release every gate at once; the peak concurrency observed at any moment
    // must never exceed the bound.
    for (const release of gated.gates) release();
    await expect(running).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(gated.maxInFlight()).toBeLessThanOrEqual(DEFAULT_PROJECT_CONCURRENCY);
  });

  test("propagates a read failure and stops queued reads from starting", async () => {
    const gates = new Map<number, { readonly promise: Promise<void>; readonly release: () => void }>();
    for (const index of [0, 2, 3]) gates.set(index, deferred());
    const failure = new Error("injected read failure");
    let started = 0;
    const tasks = Array.from({ length: 6 }, (_, index) => async () => {
      if (index === 1) throw failure;
      const gate = gates.get(index);
      if (gate) await gate.promise;
      return index;
    });
    const waiter = startWaiter();
    const scheduler = createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY, {
      ...waiter,
      onTaskStart: () => {
        started += 1;
        waiter.onTaskStart();
      },
    });
    const running = scheduler.run(tasks);

    // The failing task (index 1) rejects on its first microtask, so once the
    // initial wave has started the failure is already observed and the
    // remaining workers are blocked on gates for tasks 0, 2, and 3.
    await waiter.waitFor(4);
    expect(started).toBe(4);
    for (const index of [0, 2, 3]) gates.get(index)!.release();
    await expect(running).rejects.toThrow("injected read failure");
    // Tasks 4 and 5 never started after the failure.
    expect(started).toBe(4);
  });

  test("returns results in input order regardless of completion order", async () => {
    const gates = new Map<number, { readonly promise: Promise<void>; readonly release: () => void }>();
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) gates.set(index, deferred());
    const tasks = Array.from({ length: 8 }, (_, index) => async () => {
      await gates.get(index)!.promise;
      return index;
    });
    const scheduler = createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY);

    const running = scheduler.run(tasks);
    // Complete the first wave out of input order (1, 2, 3 before 0), then the
    // second wave; completion order must never leak into the returned results.
    for (const index of [1, 2, 3, 0, 7, 6, 5, 4]) gates.get(index)!.release();
    await expect(running).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("runs a single task and an empty list without error", async () => {
    const scheduler = createProjectReadScheduler(DEFAULT_PROJECT_CONCURRENCY);
    await expect(scheduler.run([async () => 42])).resolves.toEqual([42]);
    await expect(scheduler.run([])).resolves.toEqual([]);
  });

  test("rejects a non-positive concurrency at construction", () => {
    expect(() => createProjectReadScheduler(0)).toThrow(/positive integer/);
    expect(() => createProjectReadScheduler(-1)).toThrow(/positive integer/);
  });
});
