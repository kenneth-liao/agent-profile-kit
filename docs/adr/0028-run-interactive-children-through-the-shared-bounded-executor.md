---
status: accepted
---

# Run interactive children through the shared bounded executor

## Context

ADR-0027 made `process/process-executor.ts` the only sanctioned spawn boundary
and gave every child a finite deadline, captured output, and a detached
process-group lifecycle. Delivering DEC-029 (#448) requires a different child
shape: the configured pager must run without a deadline (a user reads for an
unbounded time), must own the terminal screen (its stdout/stderr cannot be
captured), and must be able to read the terminal directly. Spawning the pager
detached (ADR-0027's standing rule) places it in a background process group,
where a tty read raises SIGTTIN. Hand-rolling a second spawn boundary would
violate ADR-0027; amending an accepted ADR in place would obscure its original
decision.

## Decision

1. **One executor, two typed modes.** `process/process-executor.ts` gains
   `runInteractiveProcess` alongside `runProcess`. The interactive mode spawns
   in the caller's foreground process group (non-detached), inherits
   stdout/stderr by default, pipes supplied content to the child's stdin
   (EPIPE from an early quit is expected; any other stdin error is a distinct
   typed `stdin-error` result), and imposes no deadline. Cancellation runs
   through the same SIGTERM→SIGKILL escalation as `runProcess`, shared via one
   internal `terminateTarget` helper whose explicit target policy keeps the
   two modes from being misrouted: `runProcess` always signals and probes the
   whole process group of its detached leader; `runInteractiveProcess`
   signals and probes only its owned child pid. `cleanupFailed` evidence is
   produced and surfaced identically in both modes.

2. **Foreground-input consequence, accepted.** Because the child shares the
   CLI's foreground process group, terminal input reaches it without SIGTTIN,
   and Ctrl-C reaches both processes. The CLI holds SIGINT/SIGTERM handlers
   for exactly the paging window (removed in a `finally`); a repeated signal
   during cleanup is a no-op, so the child cannot be orphaned by a second
   press. Descendant processes of the child are outside the cleanup claim —
   the executor does not claim descendant-tree cleanup for this mode, and any
   unconfirmed termination surfaces as `cleanupFailed`, never as success.

3. **No deadline, no capture.** The interactive mode has no deadline and
   inherits the terminal, so a legitimate reading session is never killed by
   a timer and screen output is never diverted. The only bounded window is
   the cleanup escalation after an explicit signal or delivery failure.

4. **PAGER normalization boundary.** The configured `PAGER` value is parsed at
   one boundary (`cli/pager.ts`) as argv syntax only: whitespace-separated
   arguments with POSIX quoting (single quotes literal, double quotes with
   backslash escapes, backslash escapes outside quotes). No shell is
   involved; variable/command/operator interpretation is deliberately not
   performed, and rendered guidance reaches the pager through stdin only.
   Malformed quoting is a typed failure with advisory recovery; empty/unset
   `PAGER` falls back to `less`.

## Consequences

- Any interactive child (today: long guidance paging, DEC-029) is bounded in
  exactly one dimension — cleanup after cancellation — while its reading
  lifetime stays unbounded. All other children keep the full ADR-0027
  deadline/group discipline unchanged.
- A CLI crash while paging can orphan the foreground pager; this residual
  risk is accepted for this mode and is surfaced as `cleanupFailed` whenever
  termination was attempted but could not be confirmed.
- The packed-CLI PTY harness reports `rows=0`; long-guidance paging therefore
  requires a known terminal height (device rows or `LINES`), and redirected
  or unknown-height output never pages — a safe default, covered by test.