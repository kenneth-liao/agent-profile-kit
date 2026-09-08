---
status: accepted
---

# Own one shared bounded process executor

## Context

The repository spawned child processes through two independent mechanisms:
`test/support/process-executor.ts` (`runProcess`) for test-runtime children
(packed CLI runs, PTY launches, supervised test runners), and ad-hoc
`execFile`/`spawn` call sites for production work, including the Adapter CLI
version probes reused by first-run Host detection (#444, DEC-022). The
production probes had no force-kill escalation: a Host executable ignoring
SIGTERM left `execFile`'s promise unsettled, hanging `init` after Workspace
publication. Fixing that boundary by hand would have created a second,
partial process-group terminator alongside the executor that already implements
the complete discipline (process-group leader, finite deadline, SIGTERM to
SIGKILL escalation, group-empty probe, explicit `cleanupFailed` surfacing).

## Decision

1. **One canonical bounded executor.** The dependency-free `runProcess` core
   moves from `test/support/` to a top-level `process/` module
   (`process/process-executor.ts`). It is the only sanctioned way to spawn
   child processes in this repository, for both test runtime and production.
   A new spawn call site requires either `runProcess` or a thin adapter over
   it; hand-rolled `execFile`/`spawn` with ad-hoc timeout handling is a
   defect, not a pattern.

2. **Probe boundary delegates.** `adapters/services/executable.ts`
   (`invokeExecutable`) is a thin promise-semantics adapter over `runProcess`:
   it maps the typed result union onto resolve/reject with captured
   stdout/stderr and preserves the error shapes callers already handle
   (`ENOENT` codes, attached output). Adapter probe reuse is unchanged; each
   Adapter keeps ownership of its executable name, arguments, and parse
   policy (ADR-0012).

3. **Placement.** The repository's canonical locations (AGENTS.md) had no home
   for a cross-cutting runtime execution boundary; `installer/` owns
   installation lifecycle, `adapters/` owns Host-specific projection, and a
   test-support directory cannot serve production code. A top-level `process/`
   module is the minimal new category: one file, node-builtin dependencies
   only, imported by `adapters/`, `test/support/`, and the suite supervisor.

## Consequences

- Any child process a Host executable starts is bounded: a stalled probe can
  delay a command by at most its deadline plus the cleanup grace, never
  indefinitely, and leaves no descendants. A child whose stdout or stderr
  exceeds the executor's 1 MiB per-stream output budget is terminated through
  the same lifecycle (`output-limit` result), restoring `execFile`'s maxBuffer
  contract at the shared boundary.
- Test and production children share one cleanup discipline, so cleanup
  regressions surface once for both axes.
- `TEST_CHILD_DEADLINE_MS` remains exported from the executor as a shared
  default for packed-CLI test launches; production callers pass their own
  policy deadlines.
