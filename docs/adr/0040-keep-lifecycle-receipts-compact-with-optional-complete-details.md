---
status: accepted
---

# Keep lifecycle receipts compact with optional complete details

A routine lifecycle run must lead with its outcome, not its audit trail (spec
#491, US-011, DEC-007; ticket #502). The default `update` receipt previously
named every committed generated file with its Project attribution, because
spec #373 (US-027, DEC-018) and #451 required the complete operation listing in
every invocation mode. That requirement produced the fleet receipt the
independent review measured at 133 lines for 16 Projects, where the Project
set rendered once as a summary and again scattered through every file line
(S4). `uninstall` already reports compactly (ADR-0035, ADR-0036); `install`
already states one outcome with its selection (ADR-0033, ADR-0034). This
record gives `update` the same outcome-first shape and defines the one detail
route for every lifecycle receipt.

## Decision

- **One outcome-first default receipt policy for install, update, and
  uninstall.** Each default human receipt states its outcome, then its impact
  once, adds only the required next action and guidance relevant to that
  outcome, and carries no per-file, per-Project, per-operation, or Profile
  inventory and no successful Repository Exclusion bookkeeping. `update`'s
  impact statement is the affected Project count and the changed generated-file
  count in one line (`Updated 2 Projects (3 generated files).`; a
  receipt-proven committed update that left every projection byte-identical —
  a new desired-input digest or an installation-record change — still counts
  its Project as `0 generated files`). `install` keeps its
  established installed/unchanged/replaced outcome with its selection, and
  `uninstall` its removed-Project or removed-Host-and-count statement
  (ADR-0033, ADR-0035, ADR-0036); both keep the shapes already accepted for
  them, plus the shared detail route below.
- **Exceptions keep the identity required to act.** Every default view keeps
  failures, skipped or preserved files, remaining work, and relevant cleanup
  problems exactly as it already did. The `update` receipt additionally names
  each independently changed generated file that this run replaced or deleted
  — the discard the shared consent gate reviewed (ADR-0032) — with its Project
  attribution under `Replaced changed generated files:` / `Removed changed
  generated files:`. Routine committed additions, updates, and removals are
  counted, not enumerated. A failure view never implies that failed work
  completed.
- **One completed-operation detail route.** A default receipt whose run
  retained an operation-history entry (ADR-0039) closes with
  `Details: apkit details`: the read-only command that retrieves that run's
  stored evidence. It is present for every outcome the recording boundary
  retains — including no-ops and interactive cancellations or declines — and
  absent for pre-write refusals that retain nothing. It is written to the same
  stream as the report it closes, so a declined or failed run keeps the pointer
  beside its own diagnostic, and the terminal branch hands the run's recording
  to that writer, which reads its one decision and fails loudly when a report
  is written before its branch decided. A run whose entry could not be saved
  still prints the route, and the save-failure diagnostic states that this run
  is not in the store the route reads while that run's complete evidence
  follows; machine JSON never carries the route.
- **Re-running the command is never the evidence route.** `apkit details`
  reads retained evidence; `apkit update --verbose` plans and describes the
  current run and is never offered as retrieval of an earlier one (DEC-007).
- **The existing evidence tiers are unchanged.** `--verbose` remains the
  complete current-run human view, including the per-Project, per-path, Git,
  warning, Blocker, and Host Setup Step evidence (ADR-0020 tier 2), and it keeps
  the `Updated:`/`Pending:` section structure; because it already prints the
  complete current-run receipt, it omits the default view's detail route.
  Machine JSON remains the complete versioned structured report (tier 3).

## Supersessions

- **Spec #373 US-027/DEC-018 (and #451)** required the complete committed-file
  listing in the default Apply Receipt. For default `install`, `update`, and
  `uninstall` human views that requirement is replaced by this record: the
  listing remains available through `--verbose` and the retained operation.
  Their unaffected facts — the receipt as the pre-update work record, the fresh
  post-commit snapshot as the resulting-state authority, and every machine
  contract — stay in force.
- **ADR-0020** already requires concise output to omit routine generated paths
  and Repository Exclusion bookkeeping, and reserves `--verbose` and JSON for
  complete evidence. This record fixes the receipt's concrete default shape and
  its detail route; tier 2 and tier 3 are untouched.
- **ADR-0026** governs the default `status` partition and its settled-work
  summary. It is unaffected: compact receipts describe work this run committed,
  not the resulting-state inventory.

## Consequences

- Fleet receipts stay bounded by the work committed rather than the fleet size,
  while a user who discarded independent edits can still see exactly which files
  were replaced or removed.
- The complete evidence is one command away and is retained automatically, so
  the default view never has to choose between hiding work and printing an
  audit trail.
- Golden baselines for the affected views change facts on purpose; their
  review rule records the accepted diff (test/__snapshots__/README.md).
