---
status: accepted
---

# Support Node.js 22 and newer

## Context

`package.json` declared `engines.node: ">=22 <23"`. The explicit upper bound
kept the package from claiming Node lines that no qualification had run on
(US-007, DEC-010). Before the public launch, common installs are on Node 24 and
Node 26. On those lines, npm prints an `EBADENGINE` warning for every install,
although the packed CLI runs.

## Decision

1. **Open-ended range.** `engines.node` is `">=22"`. Node 22 stays the minimum
   and the primary qualification line: the full CI gate and the release
   workflow run on it.
2. **Evidence per claimed line.** The CI job `packed-cli-node-lines` runs the
   packed CLI release-candidate suite (`test/release-candidate.test.ts`) on Node
   23, 24, 25, and 26 against a fresh candidate, on every pull request and
   `main` push.
3. **New Node lines.** When a new Node major is released, add it to that
   job's matrix. A failure on a new line is fixed forward or recorded as a
   known limitation. The range is not narrowed again without a new decision.

## Considered Options

- **Keep `>=22 <23`.** Rejected: every install on a current Node prints a
  warning that reads as unsupported.
- **A closed range such as `>=22 <27`.** Rejected: it must be raised for every
  Node release and gives the same warning again on Node 27.
- **The full suite on every line.** Rejected: the full gate takes about
  8 minutes per run. The packed CLI suite is the part that runs on the user's
  Node; the rest runs on Bun.

## Consequences

- The README support statement names Node 22 or newer.
- A Node major newer than 26 is claimed before CI has run on it, until it is
  added to the matrix.
