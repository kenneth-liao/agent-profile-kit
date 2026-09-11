---
status: accepted
---

# Remove individual Hosts from an installation

Per-Host removal with final partial-removal semantics (ticket #498,
US-004/US-008, DEC-003/DEC-005/DEC-006/DEC-014): `uninstall --host`
narrows removal to the requested Hosts within the selected Project/Profile
scope. Whole-removal behavior from ADR-0035 is unchanged; interactive
Project selection still belongs to #499 and Host Resolution is untouched
(ADR-0012). The shared changed-output consent gate belongs to #493
(ADR-0032) and is consumed here, not re-decided; US-020/TEST-014 stay owned
there.

## Decision

- **`apkit uninstall [--here | --project <path> | --all] [--profile <name>]
  [--host <host>]... [--auto-confirm] [--remove-changed]
  [--replace-changed] [--json]` removes only the requested Hosts' selection
  and no-longer-needed output.** `--host` repeats and normalizes to
  `SUPPORTED_HOSTS` order through the same boundary as install; unknown
  Hosts fail before any write with the shared `unsupported-host` fact. The
  filter narrows within the selected scope and never broadens it: a Project
  whose bound Hosts miss every requested Host drops out, and an empty
  intersection reports the truthful no-match outcome with no writes. A
  `--host` filter never provides scope — Host-only non-interactive use
  requires an explicit Project scope (a `--profile` selector provides one),
  and Host-only interactive use refuses with the runnable scoped equivalent
  (zero writes), composing with ADR-0035's bare-interactive refusal until
  #499 delivers interactive Project selection.
- **One surviving-set computation feeds everything
  (`planSurvivingInstallation`).** The partial path — and only the partial
  path — resolves the Workspace to re-plan the surviving Hosts; whole-removal
  stays workspace-independent. Surviving Hosts are the bound set minus the
  requested set; the re-plan's desired installation is the sole authority
  for the remembered-state narrowing, the retain/delete/rewrite partition,
  the receipt delta, and the report. No independent
  "required-by-survivors" check exists that could disagree with the re-plan.
  An unresolvable Workspace or a failed survivor plan skips that Project
  explicitly with recovery (fix the Workspace or remove the whole
  installation) while healthy Projects proceed; retention is never guessed.
  A vanished Project root narrows the remembered selection with no output
  work — converging to whole-removal forgetting would drop Hosts the user
  never named, against the narrows-never-broadens invariant. Deletions are
  trivially complete there; a non-empty rewrite set fails closed (the
  deleted directory is never recreated) with recovery instead.
- **Shared output retention under whole-file ownership (DEC-014).**
  Recorded roots absent from the surviving plan are removed; roots the plan
  rewrites are replaced; byte-identical roots are never touched. No
  owned-key merge, no new ownership evidence, no Host resolver. Removing
  the last Host routes through the complete-uninstall result path (same
  receipt/selection/output handling as full removal), not a separate
  deletion implementation. Success reports the removed Host and affected
  count (US-011); machine JSON carries the removed Hosts additively.
- **Conditional changed-file consent (DEC-005).** Whole-removal keeps
  ADR-0035's `--replace-changed` rejection (its message now points at the
  partial path); with `--host`, `--remove-changed` authorizes changed
  deletions and `--replace-changed` authorizes changed survivor rewrites —
  each conditional on the actual plan computed through the shared gate. A
  clean rewrite requires no `--replace-changed`; a partial with no changed
  deletions requires no `--remove-changed`. A non-interactive refusal names
  precisely the missing authorizations with one actionable command;
  `--auto-confirm` covers the clean portions only. The optional
  pre-confirmation diff is #493's shared view, not a second comparison
  policy.
- **Sequential per-Project recovery (DEC-006).** The partial commit holds
  the same joint boundary as whole-removal (Local Configuration lock outer,
  installation lifecycle lock nested): fresh ownership proof, changed-file
  authorization against the reviewed bytes (stale reviews stop with the
  partial outcome), staged root-granular output transition, then
  binding-narrowing plus receipt-narrowing publication. A fault restores the
  prior Host selection/output where possible with explicit restoration
  evidence (`selectionRestored`, `restoreError`,
  `concurrentSelectionChange`); completed/failed/unattempted report with a
  scope-preserving retry that keeps `--host` and omits `--auto-confirm`.

## Consequences

- Partial removal re-plans against the current Workspace source, so a
  survivor rewrite can carry ordinary source updates alongside the Host
  narrowing; clean rewrites need no consent flag (US-007), and changed
  rewrites are reviewed like any replacement.
- The narrowed receipt keeps its installation identity with the surviving
  Hosts' contracts and the surviving plan's outputs, so a later `update`
  continues that installation without recreating removed Hosts.
- Operation history stays diagnostic: no file contents, no new placement.
