/**
 * The invocation-package consumer capability declaration.
 *
 * A corpus test file that imports this module declares: when this file
 * executes in a supervised invocation, it consumes the invocation package
 * candidate. Need derivation scans the files that may execute in an
 * invocation for this import (see `test/support/invocation-candidate.ts`);
 * the declaration lives in the consumer file itself — one home per fact —
 * never in a maintained list elsewhere.
 *
 * Two drift directions are bounded, never silent:
 * - A consumer file that omits this declaration and runs under a supervised
 *   invocation fails closed at runtime with a typed error naming the remedy
 *   (`SupervisorPreparationDefectError` from `test/support/package-archive.ts`);
 *   it never builds silently.
 * - A file that keeps this declaration after it stops consuming the package
 *   at worst causes one bounded, visible preparation in a focused selection
 *   that names it; removing the stale declaration is a one-line cleanup.
 */

/** The marker file name need derivation scans for; this module is its home. */
export const INVOCATION_PACKAGE_CONSUMER_MARKER = "invocation-package-consumer";
