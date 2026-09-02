---
status: accepted
---

# Qualify the CLI as one presentation system with read-only inventory and typed blockers

## Context

The CLI presentation work shipped across the child tickets of spec #154: responsive
root help and guides, TTY-safe semantic color and branding, inventory and info
commands, responsive lifecycle and temporary-installation reports, one short
Project identity, corrected command wording, delayed progress, and an
exhaustively typed blocker contract. Each piece was accepted and delivered on
its own; this ADR records the boundary architecture those pieces now prove
together: the completed CLI is one presentation system, discovery is read-only,
and blockers are structured at their emission boundary.

## Decision

### One trusted terminal-presentation boundary

`cli/terminal-presentation.ts` owns the terminal-presentation context
(interaction mode, available width, color capability) and the rendering policy
(width clamping, `NO_COLOR`, the compact ASCII identity, semantic styling).
The CLI reads terminal state **once per stream at the CLI boundary**
(`cli/index.ts`) and passes the resulting context into every human view: root
and focused help, guides, inventory, info, lifecycle reports, errors, teardown,
and temporary-installation receipts. No human view reads terminal state
independently; machine surfaces (JSON, receipts, exit codes) never touch the
context.

Styling, wrapping, branding, and progress are strictly downstream of semantic
command and report data. They cannot alter reconciliation facts, stored paths,
blocker evidence, or any machine payload. Redirected human output wraps at one
deterministic width and carries no ANSI escapes; JSON is byte-identical
regardless of terminal width, color, or interaction mode; exit codes are
unchanged. Copyable values — paths, opaque identities, command invocations, and
user-authored content — stay whole on dedicated lines when wrapping is required,
and lines that already fit the selected measure are left intact.

### Read-only discovery boundary

`list projects|profiles|hosts|temporary [--json]` and `info [--json]` read
normalized models through the shared Local Configuration and Workspace ingestion
boundaries. They perform no Host, PATH, version, Git, project-output, or
Installation State content probes, write no state, and publish JSON from the
same trusted records their human views render. `list temporary` and ordinary
Project inventory stay separate views, preserving ADR-0015's receipt-owned
temporary lifetime, and `status` remains the ordinary lifecycle diagnostic.

### Typed-blocker boundary

Blockers are one exhaustively typed structured record normalized at the
Installer boundary: closed `kind` and affected-item vocabularies, `scope`
(`global` | `project`), `problem`, `requirement`, `remedy`, and affected-item
evidence. Message-only or unknown-kind input is rejected loudly. Human default
grouping and verbose completeness derive from the same structured records, and
lifecycle plus blocked temporary-installation JSON serialize each blocker
directly from those records (`schemaVersion: 2`) without parsing rendered
prose. Adapter capability evidence stays Adapter-owned at its host/path subset
and is translated to the shared vocabulary at the Installer boundary.

## Consequences

- A new human surface cannot silently escape the width, color, or branding
  policy: it must receive the shared context, and the packed boundary tests
  assert interactive wrapping, pipe determinism, JSON invariance, and exit-code
  stability across surfaces.
- Adding a terminal concern (color, progress, wrapping) cannot change what a
  report means or what JSON emits, because the two paths are structurally
  separated.
- Inventory stays safe to run anywhere: it never probes the machine or mutates
  state, so discovery works before Host setup and inside restricted environments.
- ADR-0010 (global reconciliation), ADR-0014 (task-focused presentation,
  `apkit`, `--json`, uniform exit codes), and ADR-0015 (receipt-owned temporary
  lifetime) remain in force; this ADR records the boundaries they rely on rather
  than rewriting them.

### Amendment: typed-blocker boundary superseded by ADR-0025

Spec #371 (ticket #382) removed the prose-carrying blocker record this ADR
accepted. Blockers are now exhaustively typed records carrying facts only —
closed `kind` and affected-item vocabularies, `scope`, Project identity when
scoped, and affected-item evidence — with no `problem`, `requirement`, or
`remedy` fields; message-only or prose-carrying input is still rejected loudly
at the normalization boundary. Presentation (`cli/blocker-wording.ts`) owns
every user-facing problem, requirement, and remedy sentence, keyed by the typed
kind, and machine JSON publishes that stored wording verbatim. The closed
vocabularies and the one-trusted-normalization-boundary shape are unchanged.
ADR-0025 records the reduction; this ADR's terminal-presentation and read-only
discovery boundaries remain in force.
