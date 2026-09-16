# Golden snapshot review rule

These snapshots are the measuring apparatus for human rendering. They capture
the packed-CLI output baseline from before the presentation document model
landed. Volatile values that are not part of the reviewed rendering are
stabilized before capture: home paths, installation identities, and retained
operation times.

When a later change updates a snapshot, the accepted diff is limited to:

- wrapping
- eliding
- alignment
- colour extent
- the corrected sentence structure of previously shattered error diagnostics
  (#390 only: errors that rendered one line per protected value now render as
  one readable sentence)

Anything else is a content change: a view gained, lost, reordered, or reworded
facts. That is a defect against the presentation refactor, not an allowed
snapshot update.

## Atomicity gate (TEST-005, #429)

Every golden capture also passes through the rendered-atomicity property
(`test/support/rendered-atomicity.ts`): no displayed command or path is
fragmented across lines. The property is **baseline-relative**, not
syntax-only:

- Expected atom spellings are extracted — by filesystem/command syntax, never
  by English presentation categories — only from that capture's own committed
  golden baseline body, never from a global corpus and never from the actual
  capture. Root-help syntax comes from the canonical command table; quoted
  values preserve either quote form and internal spaces. Unquoted spaced paths
  are ambiguous in rendered text, so the gate conservatively guards each
  intact path prefix within a single-spaced field (ending at punctuation,
  quotes, flags or a column gap). This can also guard adjacent prose; an
  unchanged baseline wrap still has its position-aligned allowance.
- Every occurrence of every recognized spelling is located by source
  line/column in the actual output. A cross-line occurrence is a defect unless
  it is position-aligned with an identical legal shape in the baseline: the
  k-th occurrence of a spelling in the actual output must match the k-th
  occurrence in the baseline (intact, or split with the same matched text).
  A baseline split allowance is therefore bound to its position and shape and
  cannot be reused elsewhere.
- Verbatim tolerance is scoped: only runs of at least two consecutive lines
  matching consecutive authored verbatim lines (composed Context, guide code
  fences, full guide bodies) are exempt.
- Known limitations: a spelling that appears only in fragmented form in the
  baseline was reviewed and accepted there and is not an enforced atom;
  truncation without continuation is a content change caught by snapshot
  equality, not by this property.

A capture without a committed baseline fails the gate in ordinary runs. New
baselines are created only through the explicit local snapshot-update
workflow, `bun run test:focused -- --update-snapshots
test/golden-snapshots.test.ts` on a maintainer machine: the supervised run
forwards Bun's own flag and marks the child (`APKIT_TEST_UPDATE_SNAPSHOTS`),
which the gate requires before allowing baseline creation. Existing
baselines are still checked during an update run. CI never enables snapshot
updating and never sets the marker, so an uncommitted snapshot fails the
clean-tree gate.

Snapshot files are created and changed only on a maintainer machine. CI never
enables snapshot updating; an uncommitted snapshot fails the clean-tree gate.

## Accepted content change: compact lifecycle receipts (#502, ADR-0040)

US-011 deliberately replaces the default `update` receipt with one
outcome-first impact statement and one completed-operation
`Details: apkit details` route, and adds that route to the already-compact
`install`/`uninstall` receipts; `update`'s per-file inventory moves to
`--verbose` and to the retained operation. The affected baselines changed facts
on purpose, and the accepted diff is reviewed on the #502 change request. This
note exists so the bounded-diff rule above stays about accidental presentation
drift rather than blocking an accepted requirement change. The complete
per-file receipt stays covered by the verbose-update unit tests and the
retained-operation suite.

## Accepted content change: focused Profile detail route (#513)

US-018 deliberately adds one discoverability pointer to the `list profiles`
inventory tail — `Run apkit list profiles <profile> to see one Profile's
Context and Skill names.` — alongside the existing install guidance. The
pointer is omitted when zero Profiles exist. The `info` baselines changed only
because the engine version moved with the same change. The affected baselines
changed facts on purpose, and the accepted diff is reviewed on the #513 change
request.

## Accepted content change: one coherent authoring lifecycle (#509)

US-016/US-019 deliberately re-teach the authoring lifecycle. Root help routes
to all three focused guide topics and drops the retired public-bind word
"bindings" from its guidance line (DEC-001). The `guide` index adds the
scaffold example route. The focused guide topics lead with the
`apkit new`/`configure` commands, explain the resulting files through the
canonical examples, and close with one next lifecycle action plus the
`guide --full` pointer. The `new` receipts end in one executable next action
(select-into-a-Profile for Skills and Context Modules; install for Profiles,
naming the Profile actually created), matching the initialization handoff
shape delivered by #511. The full guide's scaffolded-example line references
the delivered `install` command instead of the removed `bind` command (DEC-001).
The affected baselines changed facts on purpose, and the accepted diff is
reviewed on the #509 change request. The `info` baselines changed only because
the engine version moved with the same change.
