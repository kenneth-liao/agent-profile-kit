# Issue #566 — Steps 1 and 2 findings (evidence report)

Branch: `issue-566-supervisor-summary` (worktree `.worktrees/issue-566-supervisor-summary`, from `main` @ b5a2203).
At the time of this report the tree carries **one intended change only**: `test/suite-supervisor.test.ts` (+89/-1). The product file `test/support/suite-supervisor.ts` was fault-injected for verification and then restored; `git status --porcelain` shows only the test file modified.

---

## Step 1 — closing the evidence gap so it reaches the UPLOADED artifact

### What the workflow actually uploads (read from `.github/workflows/ci.yml`)

- `macos-supported-platform` job: `bun run test` under env `APKIT_TEST_DIAGNOSTICS_DIR=${{ runner.temp }}/suite-diagnostics`; then `actions/upload-artifact` (v7.0.1, `if: always()`) uploads **only** `${{ runner.temp }}/suite-diagnostics/` as `supervised-suite-qualification-attempt-${{ github.run_attempt }}`. The fleet job is identical under `supervised-fleet-qualification-attempt-*`.
- The comment in ci.yml states the evidence boundary explicitly: "the artifact contains only what the supervisor wrote."
- Consequence verified in code: `suiteProcessEnvironment` (`test/support/suite-supervisor.ts:818`) **deletes** `APKIT_TEST_DIAGNOSTICS_DIR_ENV` from every supervised child's environment, so a nested test process (the grandchild `bun test` process that runs `test/suite-supervisor.test.ts`) has no path into the outer invocation's diagnostics directory. An in-process capture (a test-local variable or a `/tmp` temp dir) can therefore never appear in the uploaded artifact.
- The channel that DOES reach the artifact: the outer supervisor's `writeRunLog` (`test/support/suite-supervisor.ts:1175`) retains the supervised child's captured **stderr verbatim** under `--- stderr ---` in the uploaded `run-1.log` (confirmed present in the original CI artifact: the assertion failure text from run 34799974423 is in `run-1.log` at lines 178-187 of `/tmp/issue-544-audit/main-run-34799974423/supervised-suite-qualification-attempt-1/run-1.log`).

### Exactly what changed (test file only)

1. `runSupervisorCli` (in the `suite supervisor: finite budget override interface` describe block) gained an optional 4th parameter `innerDiagnosticsDir?: string`. When provided it is injected into the inner supervisor's environment as `APKIT_TEST_DIAGNOSTICS_DIR`, so the inner supervisor writes its own `run-1.log` and `qualification-record.json` to a known location instead of a private `mkdtemp` directory under the process tmpdir that a maintainer can never download.
2. After every `runProcess` result, `runSupervisorCli` calls `announceSupervisorFailureEvidence(result, innerDiagnosticsDir)`. On any nonzero exit or non-exit kind it prints a bounded evidence block onto the **test process's stderr** (which the outer supervisor retains verbatim in the uploaded `run-1.log`). Block contents:
   - `supervisor-cli failure evidence: exit <code>` (or `kind <kind>` for misclassifications such as a `timeout` of the supervisor CLI itself);
   - `--- supervisor stderr ---` — the mechanism-naming stream (bounded to last 16KiB);
   - `--- supervisor stdout ---` (bounded to last 16KiB);
   - `--- supervisor qualification record ---` — the inner supervisor's own `qualification-record.json` verbatim, or the explicit line `(absent — this supervisor never wrote it)`;
   - `--- supervisor run-1 log (head) ---` — first 16KiB of the inner supervisor's run log (its head carries `kind:`/`exitCode:`/`signal:`/`timedOut:`/`effective-policy:`).
   - Each section is capped at 16KiB so the whole block stays far below the executor's 1MiB per-stream capture budget — exceeding it would terminate the outer suite child as `output-limit`, a catastrophic misclassification I checked for explicitly.
   - The announce itself is wrapped in try/catch so an evidence-read failure can never change the test's own outcome.
3. The timeout test (`exhausts an overridden per-run deadline on a real Bun child and reports incomplete qualification`) passes an inner diagnostics dir and additionally asserts the inner supervisor's record exists and represents the timeout as `incomplete` with `runs[0].timedOut === true` (US-001: timeout never represented as successful complete qualification).

### How the artifact path was verified (not just in-process)

I injected fault E1A (see below) at the **real product site** `test/support/suite-supervisor.ts` (`if (process.env.E1A_FAULT === "1") throw new Error("E1A: injected watcher.stop failure");` after `await watcher.stop()` in the run loop's `finally`), then ran the real outer supervisor over the real test file:

```
E1A_FAULT=1 bun run test:focused -- test/suite-supervisor.test.ts -t "exhausts an overridden"
```

Outer run exited 1 (expected: the faulted supervisor made the test fail). The outer supervisor's retained `run-1.log` (`/var/folders/dk/.../agent-profile-kit-test-focused-X8iMux/run-1.log`) contained, verbatim:

```
--- stderr ---

test/suite-supervisor.test.ts:
supervisor-cli failure evidence: exit 1

--- supervisor stderr ---
suite supervisor: E1A: injected watcher.stop failure


--- supervisor stdout ---
suite focused: run 1/1 starting (per-run deadline 500ms, overrides: APKIT_TEST_PER_RUN_DEADLINE_MS=500)


--- supervisor qualification record ---
(absent — this supervisor never wrote it)

--- supervisor run-1 log (head) ---
=== suite run 1/1 (focused) ===
runtime: bun 1.4.0 (/Users/kennethliao/.bun/bin/bun) darwin arm64
selection: mode=focused explicit-selection named=0
...
effective-policy: mode=focused per-run=500ms aggregate=500ms max-runs=1
...
kind: timeout
exitCode: null
signal: SIGTERM
timedOut: true
cancelled: false
cleanupFailed: false
cleanupDurationMs: 502
error: null
durationMs: 956
```

This is exactly what a maintainer downloads after a CI failure: exit code, the supervisor's stderr (cause), the supervisor's stdout (missing summary visible), the record-presence fact (names the skipped-finalize branch), and the run-log head (the run was truthfully recorded as a timeout before the escape). The same directory shape is what ci.yml uploads.

Afterwards: `rm test/support/__e1-scratch-supervisor.ts && git checkout -- test/support/suite-supervisor.ts`; `git status --porcelain` → only ` M test/suite-supervisor.test.ts`. The family was re-run green: `bun run test:focused -- test/suite-supervisor.test.ts -t "finite budget override interface"` → `1 run, exit 0 in 3.8s`.

---

## Step 2 — E1 and E2

### E1 — escape-path viability (scratch copy, real supervisor logic, real Bun child)

Setup: one scratch copy of the real supervisor at `test/support/__e1-scratch-supervisor.ts` (deleted afterwards) with **two env-gated injected faults** so a fault-free control run was also possible:

- **E1A site** — in `runSupervisedSuite`'s `finally`, immediately after the unwrapped cleanup call:
  ```ts
  if (watcher !== null) {
    await watcher.stop();
    if (process.env.E1A_FAULT === "1") throw new Error("E1A: injected watcher.stop failure");
  ```
  (This is the exact currently-unwrapped site: `test/support/suite-supervisor.ts:2172-2176` on main — `await watcher.stop();` has no try/catch, so a throw here escapes the `finally`, aborts the remaining bounded removals, and propagates out of `runSupervisedSuite`.)
- **E1B site** — in `writeRunLog`, before its first write:
  ```ts
  if (process.env.E1B_FAULT === "1") throw new Error("E1B: injected writeRunLog failure");
  ```
  (A throw inside the run-loop `try` is caught into `invocationError` at `suite-supervisor.ts:2184-2186`; `finalizeInvocation` then writes the qualification record and **throws `AggregateError`** when `invocationError !== undefined` (`suite-supervisor.ts:2507-2514`), which rejects `main`'s await into the rejection handler.)

Command per case (real supervisor entry point, real stall fixture `test/support/fixtures/stall-suite-fixture.ts`, 500ms deadline, explicit inner diagnostics dir, PATH stripped as the test does):

```
env E1A_FAULT=1|E1B_FAULT=1|(unset) APKIT_TEST_PER_RUN_DEADLINE_MS=500 \
  APKIT_TEST_DIAGNOSTICS_DIR=/tmp/issue-566-e1/<case> PATH="/usr/bin:/bin" \
  /Users/kennethliao/.bun/bin/bun run test/support/__e1-scratch-supervisor.ts focused \
  -- ./test/support/fixtures/stall-suite-fixture.ts \
  >stdout.txt 2>stderr.txt
```

Observed, verbatim (Bun 1.4.0, both same as the CI runner's supervisor runtime):

**control (no fault)** — exit 1:
```
stdout:
suite focused: run 1/1 starting (per-run deadline 500ms, overrides: APKIT_TEST_PER_RUN_DEADLINE_MS=500)
suite focused: 1 run, failed (timeout) in 1.1s — log: /tmp/issue-566-e1/control/run-1.log
stderr: (empty)
files: qualification-record.json, run-1.log
```
The written timeout path prints the truthful summary. (Note: redirected to a file here; the piped variant is covered in E2 below.)

**E1A (watcher.stop throws in the finally)** — exit 1:
```
stdout:
suite focused: run 1/1 starting (per-run deadline 500ms, overrides: APKIT_TEST_PER_RUN_DEADLINE_MS=500)
stderr:
suite supervisor: E1A: injected watcher.stop failure
files: run-1.log        ← run log written (inside the try), record ABSENT (finalize never reached)
```
Its `run-1.log` head shows the run was truthfully recorded before the escape: `kind: timeout`, `signal: SIGTERM`, `timedOut: true`, `cleanupDurationMs: 502`.

**E1B (writeRunLog throws in the run loop)** — exit 1:
```
stdout:
suite focused: run 1/1 starting (per-run deadline 500ms, overrides: APKIT_TEST_PER_RUN_DEADLINE_MS=500)
stderr:
suite supervisor: Error: E1B: injected writeRunLog failure
files: qualification-record.json   (record present), run-1.log ABSENT (never written)
record excerpt: "status": "incomplete", "reason": "Error: E1B: injected writeRunLog failure"
```

**Match with the CI signature — EXACT, not approximate, for both faults.** CI run 34799974423 observed: stdout = `"suite focused: run 1/1 starting (per-run deadline 500ms, overrides: APKIT_TEST_PER_RUN_DEADLINE_MS=500)\n"` and nothing else; exit code nonzero (the `exitCode !== 0` assertion passed); `kind` was `"exit"` (not a timeout of the 30s outer cap); no summary. Both E1A and E1B produce precisely that: start line only, exit 1, supervisor's own summary missing, rejection message on stderr.

### E2 — flush-truncation hypothesis (negative result, with power numbers)

Hypothesis: `printSummary`'s stdout write loses a race against the synchronous `process.exit(code)` at the entry point (`.then((code) => process.exit(code))`), truncating the summary under a piped, loaded capture.

Runner: Bun **1.4.0** locally — the same version `engines.bun` pins and the CI runner used (`/Users/kennethliao/.bun/bin/bun`, macOS arm64, Darwin 24.x local vs macOS 15.7.9 runner — OS differs, Bun identical).

Load: deliberate CPU contention with 6 spinner processes (`sh -c 'while :; do :; done'`) on a 14-core machine, running for the duration of each loaded loop.

Iterations actually run (all through the real bounded executor `runProcess`, i.e. real pipe capture, except where noted):

| Experiment | Child | Iterations | Load | Truncations (summary line lost) |
|---|---|---|---|---|
| minimal two-write child: start line → 50ms sleep → summary → `process.exit(1)` | `/tmp/issue-566-e2/child.ts` | 60 | none | **0** |
| same, 100ms sleep | same | 200 | 6 spinners | **0** |
| 64KiB-summary child (pipe-buffer-scale write, the classic truncation trigger), 100ms sleep | `/tmp/issue-566-e2/child-big.ts` | 120 | 6 spinners | **0** |
| real, unmodified supervisor, stdout+stderr redirected to files (not pipes) | `test/support/suite-supervisor.ts` | 60 | 6 spinners | **0** |
| real, unmodified supervisor spawned through the real executor's pipe capture (the exact CI capture path) | same | 40 | 6 spinners | **0** |

Totals: **480 piped iterations plus 60 file-redirected iterations; 0 truncations in every variant.** Driver scripts retained at `/tmp/issue-566-e2/driver.ts` and `/tmp/issue-566-e2/driver-real.ts`; per-iteration diagnostics printed on any loss (none occurred).

Honest power statement: the experiment reliably detects gross truncation (a lost final write), and it exercised both small and 64KiB writes, both idle and loaded conditions, and the exact capture machinery of the failing test. What it cannot guarantee: the CI runner's specific concurrent conditions (Actions runner hypervisor, disk/CPU pressure patterns, 98-file suite telemetry in the same process) may differ in ways 480 local iterations do not span; and a rare race could still exist below ~1/480 observed frequency. I therefore state H2 as **not demonstrated**, not as **impossible** — but with no demonstrated instance, hardening it is not licensed.

---

## Explicit conclusion

**Which hypothesis the evidence supports: H1 (escaping rejection).** Deterministically reproduced at two distinct, real code sites with the exact CI signature, and the mechanism is confirmed in the code: `finalizeInvocation` throws `AggregateError` after writing the record when `invocationError !== undefined`, and `main` awaits `runSupervisedSuite` with no catch, so `printSummary` (`test/support/suite-supervisor.ts:2733`) is deterministically skipped on any escaping rejection. The issue's premise that "finalizeInvocation still prints a summary on internal error" is **not true of the written code**: the retained record stays truthful, the stdout summary does not.

**Residual uncertainty about the original CI instance (explicit):** the single CI run cannot be retroactively attributed with certainty. The inner supervisor's own stderr and qualification record were not retained in that run — that is precisely the gap step 1 closes. This investigation did not observe the CI failure; it observed that H1 is a demonstrated deterministic producer of the exact signature, and that H2 was not reproducible in 480+ attempts on the same Bun version. The report does not claim the CI run *was* H1.

**Why H2 is not being hardened:** per the approved condition ("fix only what you demonstrate"), H2 produced zero truncations across every variant tried, including the exact capture path, on the exact pinned Bun version. Adding flush-before-exit machinery without a demonstrated failure would be defensive hardening that widens the change surface (against the minimal-change/DEC-002 constraints) and cannot be shown to protect a failure that has been shown to occur. If a future occurrence is captured with step-1's evidence block showing **empty supervisor stderr + record present + summary missing**, that signature names H2 and licenses the flush fix then — the retained evidence will make that attribution unambiguous.

---

## Step 3 outcome (appended at implementation time)

Correction implemented on top of the named mechanism (H1 only; H2 untouched, per the not-demonstrated evidence above):

1. `main` catches a rejected `runSupervisedSuite` and emits the truthful summary **on stdout** — `suite <mode>: failed (internal error: <cause>)` plus `— logs: <diagnostics dir>` when finalization attached it — with the raw cause on stderr and a nonzero exit. `finalizeInvocation`'s thrown `AggregateError` now carries `logDir` so the summary can point at the retained record.
2. The entry-point rejection handler (the originally-named defect site) also emits a stdout failure line before `process.exit(1)` — the last-resort completion guarantee, so no completion path can exit without a stdout summary.
3. The invocation `finally`'s watcher-stop site is wrapped: a `watcher.stop()`/`evidence()` failure is recorded as `cleanupFailed`/`cleanupFailure` evidence and cleanup **continues to its bounded removals** — fixing, as a direct consequence, the aborted-removals resource leak E1A demonstrated. No further leak handling was needed; nothing was expanded beyond that.

TDD: the shipped red test (`internal errors still reach the reader`) triggers the same completion path through a real caller-supplied misconfiguration (an existing **file** as `APKIT_TEST_DIAGNOSTICS_DIR` — the first evidence write fails into `invocationError`, finalization throws). Before the fix it reproduced the exact CI signature on the real product (stdout = start line only, exit 1, `suite supervisor: EEXIST: ...` on stderr); after the fix it observes the stdout summary and stderr cause.

Condition-4 proof (real product file, temporary env-gated injection, restored afterwards): recorded in the PR description and the retained run logs.
