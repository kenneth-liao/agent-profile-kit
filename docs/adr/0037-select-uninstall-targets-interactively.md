---
status: accepted
---

# Select uninstall targets interactively

Bare and Host-only interactive `uninstall` collects its scope through the
searchable Project picker with nothing pre-selected, then one per-flow
whole-versus-Host removal mode (spec #491, US-003/US-004/US-005,
DEC-003–DEC-005; ticket #499). The explicit operation from #496–#498
(ADR-0035/ADR-0036) is unchanged and remains the single path that previews,
confirms, consents, commits, and recovers; this slice only completes its
scope on an interactive human stream.

## Decision

- **The picker opens only where no scope exists.** Bare invocations and
  Host-only invocations without a Project scope route into selection on an
  interactive terminal; every scoped invocation — including lone
  `--profile`, which keeps its explicit fleet-wide flow — is untouched.
  Non-interactive and machine-JSON input keep the delivered #496/#498
  refusals: missing choices stay missing (DEC-004).
- **Nothing is pre-selected; empty and cancel never widen.** The Project
  picker starts with no Projects checked, so bound Projects are never
  silently picked. Submitting nothing is a no-op diagnostic with zero
  writes — never `--all` — and cancellation at any picker leaves
  everything untouched with neutral styling.
- **One removal mode per flow; repeat runs mix modes.** After Project
  choice the flow offers whole-installation versus selected-Host removal
  for the picked Projects, stated in the question framing. The chosen mode
  stays visible per Project in the pre-execution review (removed and kept
  Hosts named). A carried `--host` filter proposes Host-mode removal of
  those Hosts — reviewed at the mode question and the confirmation —
  never silently applied.
- **Picked scope executes as explicit per-Project equivalents.** Each
  picked Project commits through the unchanged #496–#498 contract with its
  own single-resolution guard, under the same joint lock boundary; a fleet
  re-resolution before each commit fails the remainder closed when a
  concurrent binding change widened or narrowed it (INT-2 for picks), with
  retries omitting `--auto-confirm`. The general confirmation still fires
  unless `--auto-confirm` answers it (which answers no pick), and changed
  deletions/rewrites consume the shared consent gate with its
  delete-vs-rewrite distinction — no second comparison policy.
- **One runnable command per picked Project.** A single combined line
  cannot express per-Project narrowing, so success, decline, consent, and
  scope-change outcomes each print one executable equivalent per picked
  Project, carrying the mode, Hosts, and actually-authorized consent
  flags. Host narrowing keeps the explicit drop rule: a picked Project
  with no host intersection is dropped, never broadened; dropping all of
  them reports no match with no writes.
- **Qualification is real PTY as well as injected streams (TEST-003).**
  Keyboard behavior (toggle, filter, submit, cancel) and 60/80-column
  rendering are exercised through the `pty.fork` controller with human
  keystroke timing; the TEST-004 consent matrix covers the picked partial
  path (accept, decline, and missing-flag refusal with zero writes).

## Consequences

ADR-0035's "bare interactive invocation refuses" and ADR-0036's
"Host-only interactive use refuses" hold only for non-interactive and
machine-JSON input now; interactive humans pick. `uninstall` help syntax
is unchanged — it documents the explicit contract, which is also the
printed equivalent of every picked Project.
