# Golden snapshot review rule

These snapshots are the measuring apparatus for human rendering. They capture
current packed-CLI output before the presentation document model lands.

When a later change updates a snapshot, the accepted diff is limited to:

- wrapping
- eliding
- alignment
- colour extent

Anything else is a content change: a view gained, lost, reordered, or reworded
facts. That is a defect against the presentation refactor, not an allowed
snapshot update.

Snapshot files are created and changed only on a maintainer machine. CI never
enables snapshot updating; an uncommitted snapshot fails the clean-tree gate.
