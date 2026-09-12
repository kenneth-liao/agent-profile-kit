---
status: accepted
---

# Configure Profile membership through one validated write path

`apkit configure profile [name]` changes a reusable Profile's Context and
Skill membership with explicit flags or, on an interactive human stream,
searchable pickers preselected from the current membership (spec #491,
US-009/US-005, DEC-002/DEC-004; ticket #500). Both modes feed the same
validated operation; the searchable prompt boundary is reused from #495
with no new prompt kinds. Configure never installs or updates Projects.

## Decision

- **REPLACE per supplied category, no add/remove flags.** Each present
  `--context`/`--skill` flag carries the full new membership for its
  category (repeatable flags accumulate; duplicates are argument errors).
  An omitted flag leaves its category unchanged; a flag with no values
  explicitly empties its category. An overall-empty result is refused
  with the existing `profile-without-artifacts` fact. Every interactive
  outcome is therefore expressible non-interactively, and the printed
  equivalent always lists both categories in full with `--auto-confirm`.
- **One write path.** `configureProfileMembership` (installer/
  configure-profile) is the single home for publication: ingest through
  the shared Workspace boundary, validate selections against it
  (existing missing-reference facts), preflight through the canonical
  Profile schema, then rewrite only the changed `context`/`skills` value
  nodes of the canonical Profile file through a YAML CST edit —
  comments, key order, and the `id` line survive. Validation completes
  before any mutation, so invalid requests leave the source
  byte-identical; a changed-underfoot re-read refuses instead of
  overwriting a concurrent edit. Symlinked Profile files are never
  written through. Changed categories renormalize to canonical sorted
  order (the bind-project Host precedent); an unchanged category keeps
  its authored node byte-identical, and a fully matching request reports
  `changed: false` without writing.
- **DEC-002 collect-only-missing, DEC-004 general confirmation.** A bare
  invocation defaults to the `profile` object; a missing name opens the
  searchable Profile picker (existing IDs only — configure never
  creates). Supplied categories skip their picker. Current membership is
  shown before anything is asked, and the pre-save statement names the
  reusable Profile changing and states that installations update
  separately. Interactive input confirms (explicit yes saves; anything
  else keeps the Profile unchanged) including with fully supplied
  arguments, unless `--auto-confirm` answers it; non-interactive and
  machine-JSON invocations without that flag refuse with the runnable
  equivalent before any write. Cancellation or decline writes nothing.
  A request matching the recorded membership reports it honestly with no
  prompt and no write.
- **Lifecycle machine shape, no new version.** `--json` success publishes
  `{schemaVersion: 15, command: "configure", outcome: "clean", profile,
  changed, previous, membership, equivalent}`; refusals use the shared
  lifecycle error envelope. Completion prints the executable explicit
  equivalent and `apkit update` as the next action. No operation-history
  entry is recorded (DEC-008 covers install/update/uninstall).

## Consequences

Explicit membership typos fail closed: unknown IDs, duplicates, and
empty results refuse with available-name guidance and byte-identical
source. Installed Project output, Local Configuration, Installation
State, and history are structurally untouched by configure — verified by
byte-identical snapshots, not by the absence of a call. Direct file
editing remains supported: configure preserves unrelated authored
content and re-ingests what editors write.
