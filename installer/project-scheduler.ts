/**
 * One invocation-scoped scheduler for independent read-only Project work.
 *
 * DEC-014/DEC-015: independent Project planning and inspection run through one
 * fixed bounded-concurrency scheduler, while Installation State publication,
 * Project writes, Repository Exclusion publication, commit sequencing, rollback,
 * and failure recovery keep their existing ordered safety boundaries and never
 * pass through this executor. The scheduler is a pure executor: it holds no
 * Project, Git, or filesystem evidence, so one instance may run the planning,
 * preflight, and post-commit verification passes of a single lifecycle
 * invocation while each pass still creates fresh inspection contexts.
 */

/** Fixed product-policy concurrency bound for independent Project reads. */
export const DEFAULT_PROJECT_CONCURRENCY = 4;

/** Instrumentation fired only when the scheduler starts or completes a task. */
export interface ProjectSchedulerInstrumentation {
  readonly onTaskStart?: () => void;
  readonly onTaskComplete?: () => void;
}

/** One bounded executor for independent read-only Project tasks. */
export interface ProjectReadScheduler {
  /**
   * Run every task with at most the configured concurrency active at once.
   * Results are returned in input order so scheduling order is never observable
   * downstream. A task failure rejects the whole run: the error propagates,
   * in-flight tasks settle, and no queued task starts afterwards.
   */
  run<T>(tasks: readonly (() => Promise<T>)[]): Promise<readonly T[]>;
}

/**
 * Create one Project read scheduler with a fixed concurrency bound. Production
 * callers use the default product policy; tests may construct a lower bound to
 * prove the concurrency contract deterministically.
 */
export function createProjectReadScheduler(
  concurrency: number = DEFAULT_PROJECT_CONCURRENCY,
  instrumentation: ProjectSchedulerInstrumentation = {},
): ProjectReadScheduler {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `Project read scheduler concurrency must be a positive integer, got ${concurrency}`,
    );
  }
  return {
    async run<T>(tasks: readonly (() => Promise<T>)[]): Promise<readonly T[]> {
      if (tasks.length === 0) return [];
      const results = new Array<T>(tasks.length);
      const workerCount = Math.min(concurrency, tasks.length);
      let nextIndex = 0;
      let settled = false;
      let failure: { readonly error: unknown; readonly index: number } | undefined;
      async function worker(): Promise<void> {
        while (!settled) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= tasks.length) return;
          instrumentation.onTaskStart?.();
          try {
            results[index] = await tasks[index]!();
          } catch (error) {
            settled = true;
            // First-in-input-order failure wins so the propagated diagnostic is
            // deterministic (canonical Project first) rather than scheduling-racy.
            if (failure === undefined || index < failure.index) {
              failure = { error, index };
            }
            return;
          } finally {
            instrumentation.onTaskComplete?.();
          }
        }
      }
      await Promise.all(Array.from({ length: workerCount }, worker));
      if (failure !== undefined) throw failure.error;
      return results;
    },
  };
}
