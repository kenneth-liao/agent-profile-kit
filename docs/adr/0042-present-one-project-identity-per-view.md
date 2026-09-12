---
status: accepted
---

# Present one Project identity per view

A newcomer reading `apkit list projects` and the lifecycle receipts cannot scan
a fleet when every row repeats a long path, and a receipt that names a Project
as `.` names nothing at all (spec #491, US-013, DEC-009). This record states the
display-identity policy and the inventory layout that render it; ADR-0026's
fleet identity rule is amended accordingly. Canonical paths, authored
spellings, selection, consent, and machine contracts are unchanged.

## Decision

- **One identity per view, computed once.** `cli/display-path.ts` owns
  `projectIdentityLookup`: for the Projects one view renders, each Project
  receives the shortest trailing run of path segments its stable display shares
  with no other Project in that view. A view that names a single Project
  therefore names it by the first segment that exists — its basename — and
  Projects outside the view can never lengthen a displayed identity. A display
  shared by two records keeps the stable spelling for both instead of inventing
  an ambiguous label.
- **The identity is a display alias, never a machine fact.** It is carried as an
  optional `identity` on the path node/part, so `flatInlineText`, `--json`,
  stored records, and the canonical/authored fields keep their own values. Every
  reference inside one document consumes the same lookup, including blocker and
  warning prose, so a view cannot name one Project two ways.
- **No cwd-relative Project alias.** `displayPath` with `"project"` scope now
  relativizes only a location *strictly inside* the working directory; a Project
  root renders its stable spelling. The `.`/`..`/`../…` alias that made receipts
  unreadable is deleted. A path *beneath* a Project keeps the shared location
  policy — the stable spelling in requested evidence, the
  working-directory-relative spelling in a scanning view — and is never
  rewritten into the Project's alias.
- **Scanning views shorten; requested evidence and commands do not.** Concise
  `status`, the default receipts and their failure/exception views,
  `list projects`, and `machine list temporary` render view identities.
  `--verbose`, `apkit details`, `--json`, and the changed-file consent review
  that authorizes a discard render the stable home-relative/absolute path, and
  every executable command argument stays fully spelled and shell-quoted
  (ADR-0028's copyable-token rule). Adapter-authored Host setup instructions
  also keep the stable path: they name an exact filesystem location the user
  must act on, not a scanning label.
- **A view identity is never elided; it wraps.** Rendering an identity wider
  than the measure breaks it at path-segment boundaries and, only when one
  segment alone cannot fit, at the measure — losing no character, so a sibling
  identity can never become indistinguishable through elision (ADR-0016's
  middle-elision policy still applies to full evidence paths and their
  copyable values).
- **Row groups share one responsive rule.** Any presentation row group (the
  Project inventory and `apkit details --list`) renders one separated compact
  entry per row below that measure and whenever its cells cannot fit, so a
  squeezed table is never a fallback.
- **The Project inventory is one table or separated entries, never a wall.**
  `list projects` prints the heading `Projects:` without a count; the single
  count lives in the summary footer. `TABLE_MINIMUM_WIDTH` (80, the
  `DEFAULT_HUMAN_WIDTH` measure) is the breakpoint: below it the inventory always
  renders one separated compact entry per Project (`Project:`/`Profile:`/
  `Hosts:`/`State:` lines, one blank line between entries), and at or above it
  the rows align when they fit, falling back to the same compact entries when
  content would not. The State cell carries the short word `configured` or
  `problem`; a problem's complete typed sentence and repair locator render once,
  after the entries, under the same identity the row carries.

## Consequences

- A fleet is scannable at 100 and 80 columns and readable as separated entries
  at 60 and 40 columns; long paths no longer collapse the table, and no identity
  is silently shortened into another Project's label.
- The full evidence remains one flag away (`--verbose`, `apkit details`,
  `--json`), and copied commands and quoted paths still execute.
- ADR-0026 decision 5's home-relative fleet identity is superseded for scanning
  views by this per-view policy; its prohibition on bare `.` or working-directory
  aliases now holds for every human view, not only fleet scope.
- A future human surface must choose a view identity explicitly (or render the
  stable spelling); reading `canonicalProject` directly is no longer a way to
  render a Project.
