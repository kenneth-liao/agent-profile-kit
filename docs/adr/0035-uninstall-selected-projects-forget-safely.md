---
status: accepted
---

# Uninstall selected Projects and forget them safely

The public lifecycle becomes **install → update → uninstall** (spec #491,
DEC-001). This record covers the `unbind` → `uninstall` slice only (ticket
#496, US-003/US-006/US-007/US-008, DEC-001/DEC-003/DEC-004/DEC-005/DEC-006/
DEC-012); per-Host removal (#498) and interactive Project selection (#499)
belong to their own slices and are not decided here. The shared changed-output
consent gate belongs to #493 (ADR-0032) and is consumed here, not re-decided.

## Decision

- **Public `unbind` is retired entirely, not kept as a recording-only
  command.** Every `unbind` form — bare, scoped, and `unbind --help` /
  `help unbind` — exits `1` with a replacement diagnostic (`unbind was
  replaced by uninstall`, pointing at `apkit uninstall`). The retired name is
  a diagnostic, never an alias: nothing executes under it (pre-1.0
  breaking-change policy, DEC-001/DEC-012). Retaining a recording-only
  `unbind` would preserve the forbidden two-step teardown (forgetting without
  removing) and a second selection-removal path that bypasses the general
  confirmation, changed-file consent, and recovery this slice delivers.
  Hand-editing Local Configuration remains valid; the internal
  `removeBindingSourceEntry` publication primitive keeps its name (internal
  canonical vocabulary is preserved, as in ADR-0031/ADR-0033).
- **`apkit uninstall [--here | --project <path> | --all] [--profile <name>]
  [--auto-confirm] [--remove-changed] [--json]` removes the selected
  installations and forgets their recorded selection in one per-Project
  action.** Scope is explicit (DEC-003): `--here`, `--project <path>`, and
  `--all` are mutually exclusive, and conflicting scopes are rejected before
  writes. `--profile <name>` alone selects installations using that Profile;
  combined with an explicit scope it intersects (never broadens), and it
  never deletes Workspace source. `--host` is rejected as not yet supported
  (per-Host removal arrives with #498) and `--replace-changed` is rejected
  because uninstall only deletes (use `--remove-changed`). An absent scope
  never implies all Projects: a non-interactive invocation refuses, and a
  bare interactive invocation refuses because interactive selection belongs
  to #499.
- **One general confirmation (DEC-004).** On an interactive terminal
  `uninstall` confirms the selected scope before any write, even with fully
  supplied arguments; `--auto-confirm` answers that general confirmation
  only, never changed-file consent. Missing confirmation refuses before any
  write with the runnable equivalent command as the remedy, and a declined,
  default, or cancelled answer leaves every selected Project untouched.
- **Changed-file consent through the shared gate (DEC-005).** Deleting
  independently changed generated output needs `--remove-changed` (or
  interactive consent through the shared consent gate from ADR-0032 —
  `resolveChangedOutputConsent` plus the one CLI confirmer loop with its
  optional pre-confirmation diff); uninstall performs no replacement, so
  there is no replacement scope to authorize. Missing consent or
  cancellation precedes all writes.
- **One recoverable per-Project unit under a joint boundary (DEC-006).**
  Consent and confirmation precede every write. Each selected Project commits
  sequentially under the same joint boundary as `install` (Local
  Configuration lock held across snapshot re-verification, selection
  forgetting, output removal, and recovery, with the installation lifecycle
  lock nested inside): known Blockers skip while healthy Projects proceed, an
  unexpected write failure stops further work with completed work retained,
  and a failed Project restores its previous selection and output where
  possible (a concurrent change is left untouched and reported; a restoration
  failure is explicit). Outcomes report completed, failed, and unattempted
  Projects with a concrete scope-preserving retry.
- **Forget only after success.** A fully removed Project's selection is
  forgotten only after that Project's output removal succeeds, so a later
  `update` does not recreate it. Removing a selection by hand to keep
  generated files in place stays valid; the next `update` reconciles the
  leftovers.

## Consequences

Users and scripts invoking `unbind` must move to `uninstall`; the retirement
diagnostic names the replacement on every retired form. Scripts must add an
explicit scope with `--auto-confirm` (plus `--remove-changed` for deletions
of changed output); each refusal names the exact remedy. Machine JSON keeps
its own uninstall exit semantics (exit `2` when known Blockers skip healthy
work, `0` when every selected Project completes) with completed, skipped,
failed, and unattempted evidence. The change ships as a pre-1.0 breaking
change with a minor version bump and no shim.

Sibling slices still own their scoped changes and are decided nowhere here:
per-Host removal (#498), interactive uninstall selection (#499), and the
remaining lifecycle slices (#497, #501). Receipt unification and the full
journey recapture against the delivered CLI belong to their later slices
(#517 re-proves the excerpts end to end, as in ADR-0031). A receipt retired
by the removed `unbind` boundary is legacy input only: `update` still honors
it for teardown on older machines, but current `uninstall` never creates one.

Living guidance (`docs/USER-JOURNEY.md`, `docs/ARCHITECTURE.md`,
`docs/guides/workspace.md`, `docs/guides/agent-workflow.md`) was updated for
the rename and the new confirmation, consent, and forget-after-success
behavior.

## Supersessions

This record supersedes the **recording-only `unbind` boundary of ADR-0010**
(and its amendments) per DEC-012: selection removal for immediate uninstall
happens through `uninstall` in one per-Project transition, and a standalone
recording-only public removal command no longer exists. ADR-0010's Project
Binding scope is unaffected, as is the `install` recording boundary owned by
the sibling slice. This record further supersedes **#373's no-prompt teardown
contract** per DEC-012: explicit confirmation (and, for changed output,
explicit consent) replaces silent teardown, with no compatibility shim.
Unrelated ownership, Host Resolution, versioning, and process-executor
decisions are intact.
