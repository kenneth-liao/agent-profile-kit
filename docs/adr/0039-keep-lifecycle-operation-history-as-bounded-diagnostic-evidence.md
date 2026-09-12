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
  The cap is a bound, not a shape: a document carrying more entries than the
  cap reads as its newest entries, so a future reduction of the cap can never
  make existing evidence permanently unreadable.
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
  overwrites a history file it could not parse. The pre-write parse of the
  exact bytes is the whole publication proof: unlike ownership evidence, a
  diagnostic history does not re-read the document after the rename, because
  under the held lock that re-read could only fail spuriously and would report
  an entry as unsaved after writing it.
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
  machine-namespace command. Every terminal branch decides explicitly —
  `collect` for an attempt, `recordNothing` for a refusal — and a run that
  reaches neither is reported once as a non-fatal internal error instead of
  being silently absent, so a forgotten decision stays visible to tests and
  logs while the run itself is unaffected.
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

## Resource bounds, durability, and identity

The retained count is the only bound: entries carry the generated paths and
Project identities a run actually committed, so one entry's size scales with
that run's fleet, and a serialized-byte cap would evict entries before the
documented 200 and silently shorten the retained window. Each append costs one
parse of the retained document, one serialization, and one pre-write parse of
the bytes being published; the post-rename verification described above is
deliberately absent, and no per-entry round trip is performed beyond that
proof.

Publication is atomic against concurrent writers, not durable against power
loss: the write is not fsynced, so a machine failure can lose the newest entry,
which is acceptable for optional diagnostic evidence. A writer that crashes
between the temporary write and the rename can leave one staging file in the
application directory; it is harmless, bounded by crashes, and never read as
evidence. Deleting the document — the documented remedy for a corrupt file —
also restarts the identity sequence, so an older printed identity can resolve
to a later run; the entry's recorded time is the disambiguator. A future
`schemaVersion: 2` must note that an older engine refuses both reading and
appending while an unsupported document is present, so a downgrade stops
recording until the user removes the file.

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
