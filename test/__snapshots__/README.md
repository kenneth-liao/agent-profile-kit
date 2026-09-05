# Golden snapshot review rule

These snapshots are the measuring apparatus for human rendering. They capture
the packed-CLI output baseline from before the presentation document model
landed.

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
  capture.
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
workflow (`bun test --update-snapshots test/golden-snapshots.test.ts` on a
maintainer machine, which marks the supervised run via
`APKIT_TEST_UPDATE_SNAPSHOTS`); existing baselines are still checked during
an update run. CI never enables snapshot updating and never sets the marker,
so an uncommitted snapshot fails the clean-tree gate.

Snapshot files are created and changed only on a maintainer machine. CI never
enables snapshot updating; an uncommitted snapshot fails the clean-tree gate.
