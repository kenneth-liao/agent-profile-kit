---
status: accepted
---

# Guide installation through searchable choices

Interactive `install` collects only its missing Profile/Host choices through
searchable pickers (spec #491, US-001/US-005/US-006, DEC-002/DEC-004; ticket
#495). The explicit operation from #494 (ADR-0033) is unchanged and remains
the single path that previews, confirms, consents, commits, and recovers;
this slice only completes its inputs on an interactive human stream.

## Decision

- **Pickers complete only missing choices.** Supplied Profile/Hosts skip
  their picker. Non-interactive and machine-JSON invocations never prompt:
  missing choices keep the delivered #494 refusals. `--auto-confirm`
  answers only the later general confirmation, never a missing choice
  (DEC-004).
- **The target is named before anything is asked.** A bare interactive
  install prints the current-directory Project target first, then the
  Profile picker, then the Host picker.
- **One prompt seam, extended — no second prompt framework.** The
  injectable carriage seam gains searchable single/multi selection backed
  by the single prompt dependency's autocomplete kinds with a
  case-insensitive substring filter that preserves canonical order.
  Cancellation, stream lifecycle, and the clock contract are unchanged.
  The reusable `SearchableChoice` shape (title/value plus optional
  description and initial `selected`) is shared: uninstall Project
  selection (#499) and configure membership (#500) reuse it without new
  prompt kinds or their features.
- **Advisory detection, pre-checked existing Hosts, empty new defaults.**
  A Detected Agent Hosts notice (mirroring the initialization receipt)
  precedes the Host picker; titles stay bare Host identities so filtering
  matches the Host, never the evidence text, and every Host stays
  selectable — detection never gates. An existing installation pre-checks
  its Hosts; a new installation starts with nothing checked, so detected
  Hosts are never silently selected. At least one Host must be selected.
- **Picked values flow into the unchanged explicit operation.** Preview,
  general confirmation with the old → new scope, shared changed-file
  consent, joint commit boundary, and recovery are exactly #494's.
  Cancellation at any picker writes nothing. A guided success prints the
  executable fully specified equivalent (with consent flags when the flow
  authorized them); explicit installs keep the #494 echo contract.
- **Qualification is real PTY as well as injected streams (TEST-003).**
  Keyboard behavior and width are exercised through a `pty.fork`
  controller with human keystroke timing. Known limitation: filter text
  and Enter pasted in a single chunk can submit the pre-filter highlight
  — the dependency resolves its async filter after synchronously
  dispatched keypresses. Human typing (separate reads) cannot trigger it;
  no workaround is built around the dependency.

## Consequences

ADR-0033's "missing choices remain errors" holds only for
non-interactive/machine-JSON input now; interactive humans are guided.
`install` help syntax is unchanged — it documents the explicit contract,
which is also the printed equivalent of every guided install.
