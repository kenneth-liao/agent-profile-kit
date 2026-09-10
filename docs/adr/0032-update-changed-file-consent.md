---
status: accepted
---

# Require explicit per-operation changed-file consent during update

The update lifecycle must discard independently changed generated files only
with explicit consent (spec #491, US-006/US-007/US-020, DEC-004/DEC-005/
DEC-014). This record covers the update slice only (ticket #493); install and
uninstall consume the shared comparison contract in their own slices and are
not decided here.

## Decision

- **Replacement needs `--replace-changed`; deletion needs `--remove-changed`,
  applied per operation.** Either flag answers only its own discard
  operation, including replacements and removals that result from changed Host
  selection. Neither flag authorizes the other operation, and neither bypasses
  an ownership or path-safety Blocker: the consent gate runs after every
  Blocker check and before the first write. `--auto-confirm` answers the
  install/uninstall general confirmation only (DEC-004) and authorizes neither
  changed-file operation; update itself has no general confirmation, so
  routine source updates stay prompt-free.
- **Missing non-interactive consent refuses before any selected lifecycle
  write.** A non-interactive (or machine-JSON) invocation whose selected
  scope holds changed output that no flag covers raises a consent refusal
  naming the missing operations, with the runnable equivalent command as the
  remedy. The refusal precedes every configuration and generated-output
  write, including pending retirement work. This intentionally changes the
  pre-1.0 non-interactive replacement behavior owned by #373 (recorded under
  DEC-012): silent replacement is gone, with no compatibility shim.
- **Declined, default, and cancelled answers leave the whole invocation
  untouched.** The declined/default/cancelled diagnostic renders in neutral
  (`info`) styling, names the answer given (explicit no, default no, or
  cancellation), preserves another healthy pending Project, and prints the
  fully specified equivalent command. The prompt extends the existing
  injectable-streams prompt seam (a text question answered `y`/`d`/`n`), so no
  second consent framework exists.
- **One shared current-disk-versus-planned comparison contract
  (`installer/changed-output-review.ts`).** The changed-output review offers a
  discoverable optional diff before authorization and before writes, covering
  replacement, deletion, and the user-added configuration-key loss case (for
  example, a hand-added `mcp` block that whole-file replacement would drop).
  Viewing or leaving the diff grants no consent and returns to the same
  scope. File roots compare by contextual change hunks: only changed line
  ranges with surrounding context become hunks, so display limits can never
  bury every change, and repeated views page through the remaining hunks.
  Generated directory roots carry member-level evidence from the shared
  member comparison policy (`compareDirectoryMembers`: live/planned union,
  type/mode decisions, binary/large rules, text hunks), callable with any
  inspection-backed reader — added/removed members by path, changed text
  members with hunks, binary/large/unreadable members marked without dumping
  bytes — so dependent install/uninstall flows reuse the policy instead of
  reimplementing it. Every non-unchanged member stays in the evidence; the
  shared paging path bounds the view, so no count cap permanently drops a
  path.
  Review identity binds exact byte digests (files) and aggregate hashes
  (directories); decoded text is rendering only. The comparison is in-memory
  review evidence only: history records carry the deterministic review
  identity and paths, never file contents (DEC-014, OOS-006). Dependent
  install/uninstall flows consume this contract rather than implementing
  their own comparison.
- **Fresh safety at commit.** Per Project, immediately before its first
  mutation, update re-proves ownership and path safety for every output about
  to be mutated (preflight evidence predates the consent window, so a
  concurrently occupied new destination blocks its own Project) and
  authorizes every drifted root against the review or the answering flags.
  Reviewed bytes that moved stop the invocation (stale review); drift that
  was never authorized refuses it (missing consent), carrying
  completed/failed/pending evidence so a late stop reports committed work
  instead of claiming no writes. Completed Projects stay committed (DEC-006);
  re-running reviews the current bytes anew. A full
  three-way historical reconstruction is not required, and no authorship is
  inferred from the difference (DEC-014). Whole-file ownership (ADR-0021) is
  unchanged: no owned-key merge and no ownership marker are introduced here.

## Consequences

Scripts that relied on non-interactive silent replacement must add
`--replace-changed` (or `--remove-changed` for deletions); the refusal names
the exact remedy. Interactive users see the operation (`~` replacement, `-`
deletion) per file, an optional diff on `d`, and a neutral declined/default/
cancelled diagnostic. Machine JSON reports the refusal as a tool error
without prompting. The change ships as a pre-1.0 breaking change with a
minor version bump and no shim.

## Supersessions

This record supersedes **#373's non-interactive changed-file replacement
contract** (per DEC-012) for update: explicit per-operation flags replace
silent replacement. US-028/DEC-019's replacement-only gate is extended, not
replaced: the gate now covers deletion with the same invocation-wide abort
semantics. #490's informed-consent proposal is absorbed as the shared
comparison contract; its ownership-marker and owned-key-merge proposals are
not adopted (whole-file ownership per ADR-0021 stands). Unrelated ownership,
Host Resolution, versioning, and process-executor decisions are intact.
