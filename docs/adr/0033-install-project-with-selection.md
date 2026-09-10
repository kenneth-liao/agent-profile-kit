---
status: accepted
---

# Install one Project with its remembered selection

The public lifecycle becomes **install → update → uninstall** (spec #491,
DEC-001). This record covers the `bind` → `install` slice only (ticket #494,
US-001/US-006/US-007/US-008, DEC-002/DEC-004/DEC-005/DEC-006); the
`unbind` → `uninstall` rename belongs to its own slice and is not decided
here. The shared changed-output consent gate belongs to #493 (ADR-0032) and
is consumed here, not re-decided.

## Decision

- **Public `bind` is retired entirely, not kept as an authoring-only
  command.** Every `bind` form — bare, scoped, and `bind --help` /
  `help bind` — exits `1` with a replacement diagnostic (`bind was replaced
  by install`, pointing at `apkit install`). The retired name is a
  diagnostic, never an alias: nothing executes under it. Retaining a
  recording-only `bind` would preserve the forbidden two-step lifecycle
  (selection without installation) and a second selection-recording path
  that bypasses the general confirmation, changed-file consent, and
  recovery this slice delivers. Hand-editing Local Configuration remains
  valid; the internal `bindProject` publication primitive keeps its name
  (internal canonical vocabulary is preserved, as in ADR-0031).
- **`apkit install <profile> [project] --host <host> ...` records the
  Project's desired selection and installs/verifies the generated output in
  one action.** It targets the current Project by default and supports an
  explicit positional target or `--project <path>` (mutually exclusive).
  Missing Profile/Hosts remain errors on every input stream in this slice;
  searchable missing-choice pickers belong to #495. The requested selection
  is final: replacing an existing installation needs no separate `--replace`
  flag, because the general confirmation (DEC-004) already authorizes the
  stated old → new scope, and changed-file consent (DEC-005) still guards
  every actual planned discard through the shared gate.
- **One desired-state authority.** The plan is built from the just-published
  Local Configuration and passed to the scoped reconciliation write loop;
  no second planned-selection record exists. Serialization is lock-pair
  sequencing: selection writers serialize on the Local Configuration lock,
  output writers on the installation lifecycle lock, and the write loop
  re-ingests Local Configuration under its lock and fails closed on drift,
  so a concurrent selection edit retries instead of installing stale scope.
- **One recoverable per-Project unit (DEC-006).** Every post-publication
  failure before the output commit restores the previous selection where
  possible (a newly added binding is removed; a replaced one is
  re-published); a post-commit verification failure keeps the committed
  selection and reports truthfully. Restoration failures and completed work
  are reported explicitly with the concrete retry command, which never
  silently widens scope.
- **Install output stays compact and command-true.** Success reports the
  installed selection with old → new deltas; failure views name `install`
  and reuse the shared consent sentences with the install label. The fleet
  project-table views stay update-owned; receipt unification belongs to a
  later slice. Machine JSON reports `"install"` with the otherwise unchanged
  lifecycle schema (schema version unchanged: no shape changed, only the
  command value).

## Consequences

Users and scripts invoking `bind` must move to `install`; the retirement
diagnostic names the replacement on every retired form. Scripts that
recorded a selection without installing must add the install step (and
`--auto-confirm` with any needed changed-file flags for non-interactive
use); the refusal names the exact remedy. Re-installing an unchanged
selection re-verifies the output; installing a different selection replaces
it in the same action. The change ships as a pre-1.0 breaking change with a
minor version bump and no shim.

## Supersessions

This record supersedes the **recording-only `bind` boundary of ADR-0010**
(and its amendments) per DEC-012: selection recording for immediate
installation happens through `install`, and a standalone recording-only
public command no longer exists. ADR-0010's Project Binding scope and the
`unbind` removal boundary are unaffected and belong to the uninstall slice.
#373's no-prompt teardown contract is untouched. Unrelated ownership, Host
Resolution, versioning, and process-executor decisions are intact.
