import { test } from "bun:test";

/**
 * A deliberately stalled test file used to prove the supervised commands bound
 * a real Bun test run and clean up its process group. The test never resolves,
 * so only the supervisor's per-run deadline or an interrupt can end it.
 *
 * The name intentionally avoids Bun's test-discovery markers (`.test.`,
 * `_test_`, `.spec.`, `_spec_`) so the full suite never picks it up; explicit
 * invocations pass it with a `./` path prefix.
 */
test("stall fixture: never resolves", () => {
  return new Promise<void>(() => {});
});
