---
status: accepted
---

# Keep lifecycle operation history as bounded machine-local diagnostic evidence

`apkit install`, `apkit update`, and `apkit uninstall` automatically retain one
bounded, machine-local record of what each run attempted, so a user can
retrieve an earlier run's evidence without repeating its writes (spec #491,
US-012, DEC-007/DEC-008/DEC-012; ticket #501). This decision records the
placement of that new diagnostic data category before any code stores it.

## Decision

- **One machine-local history file, outside Workspace and Projects.**
  Operation history lives at
  `~/.agents/agent-profile-kit/operation-history.json`, beside Local
  Configuration and the `state/` directory on the same machine root. It is
  never stored in a Workspace, a Project, or a Host-visible location. The
  single home for this path is the engine's history module
  (`installer/operation-history.ts`), which derives it from the shared
  application-directory fact; no other module spells the path.
- **Diagnostic evidence only, never authority.** History is not desired state,
  not ownership evidence, and not an Installation Receipt. It grants no
  authority over generated output, never selects Projects, and never drives
  reconciliation. Local Configuration stays the canonical home for Project
  Bindings and the Workspace selection; Installation State stays the canonical
  home for installation ownership. Deleting the history file changes no
  lifecycle behavior.
- **Bounded structured entries, not JSONL.** The file is one strict JSON
  document (`schemaVersion: 1`, `entries` newest-first) capped at 200 entries.
  Each entry carries the operation ID, command, start/finish times, selected
  scope, outcome, and per-Project committed/removed work, failed work, and
  remaining work, plus changed-output review identity and paths when consent
  reviewed a discard. Entries never contain generated file contents and never
  duplicate rendered output; the file supplies optional evidence that the
  routine report deliberately does not enumerate (DEC-007). The newest entry
  enters first, and the oldest entries are evicted only after the cap is
  exceeded, so the retained window always holds the latest 200 runs.
- **Locked atomic replacement for every append.** Appends and evictions
  re-read, append, evict, and publish under one dedicated exclusive kernel lock
  (`operation-history.lock`, the same Darwin `O_EXLOCK` primitive the
  installation lifecycle lock uses), writing a sibling temporary file and
  atomically renaming it over the destination. Concurrent writers therefore
  cannot lose a retained entry or observe a torn document; a writer never
  overwrites a history file it could not parse.
- **Recording boundary: work committed is evidence retained.** An entry is
  recorded when a lifecycle operation was authorized and attempted — including
  no-ops, partial outcomes, blocked outcomes, execution and verification
  failures — and when the user declines or cancels at an authorization prompt
  (the install/uninstall general confirmation or the interactive changed-file
  consent). An invocation that stops after committing work retains that
  evidence whatever stopped it: an interactive uninstall batch that commits
  earlier picks and then stops on a moved scope, a late authorization refusal,
  or an unexpected error records those completed Projects beside the remaining
  ones. An invocation that committed nothing records nothing: argument and
  usage errors, missing interactive choices, missing non-interactive flags
  (including the missing
  `--auto-confirm`/`--replace-changed`/`--remove-changed` fail-closed
  refusals), a stale-review or changed-scope refusal before any write, an
  uninstall that matches nothing, and every read-only, `configure`, and
  machine-namespace command.
- **Reads never mutate.** `apkit details` — latest, `--list`, one ID, or
  `--json` — reads the stored entries and renders them without touching the
  file, and without rerunning any lifecycle planning or write. The latest
  entry, the compact list, and an empty history exit `0`; an unknown or
  evicted ID, an unreadable or invalid file, and invalid arguments exit `1`.
- **A save failure never hides the run or undoes it.** When the entry cannot
  be published, the command warns on stderr and displays the complete evidence
  of that run — the same scope, committed work, failed work, and remaining
  work the entry would have carried — while successful lifecycle work stays
  committed. History is a convenience, so its failure is never a lifecycle
  failure.

## Consequences

The lifecycle report stays task-focused while complete run evidence remains
retrievable by command; retention is bounded and independent of Workspace
health, so a broken or missing Workspace never destroys or blocks diagnostic
history. Because history is a separate bounded document under its own lock, a
history write can neither contend with nor widen the installation ownership
boundary. Machine-local history is per-user and disposable: a user may delete
it at any time, and the next lifecycle run starts a fresh window. `apkit
configure` continues to record nothing (ADR-0038), and compact default
receipts remain owned by the receipt-presentation work rather than this store.
