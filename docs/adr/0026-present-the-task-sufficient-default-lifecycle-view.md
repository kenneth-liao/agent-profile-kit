---
status: accepted
---

# Present the task-sufficient default lifecycle view

## Context

Prior default lifecycle presentation balanced concise output and detail by interleaving operation summaries, path caps, and exception sections (ADR-0017, ADR-0020). In multi-project fleets, this resulted in either artificial truncation (`... N more projects; use --verbose`) or verbose listings that obscured why each Project required action. Furthermore, blocked projects concealed actionable peers or required separate focused flags (ADR-0024).

Spec #373 (DEC-041) established the task-sufficient default lifecycle view: human default views must present a lossless, actionable partition of the fleet by primary cause, contain Blocker evidence without hiding actionable peers, and report settled work compactly.

## Decision

1. **Closed Five Primary-Cause Fleet Partition.** Default `status` classifies each actionable Project into exactly one primary cause according to a strict priority hierarchy:
   - **`needs attention`** (highest priority): Projects carrying Blockers, malformed ownership state, blocked state, or pending removal (teardown).
   - **`generated files changed`**: Projects whose extant owned generated files have drifted or been modified on disk.
   - **`generated files missing`**: Projects whose owned generated files are missing from disk.
   - **`not installed yet`**: Projects configured for initial installation (addition).
   - **`source changed`**: Projects whose Workspace source or desired configuration has changed since the last installation.

2. **Complete Actionable Identities.** Every actionable Project in the fleet is listed under its primary cause group. Default presentation wraps paths across terminal lines without artificial length caps or truncation pointers. *Amended by issue #650 (spec #640, US-007): every checked Project — healthy included — is one compact scope row carrying its canonical Primary Cause; this listing supersedes #491 US-013/014's settled-count-only default where they conflict.*

3. **Settled Counts & Wholly Settled Outcome.** Projects requiring no reconciliation work are summarized as a single count line (`settled (N)`) in mixed fleets. When every Project in the checked scope is settled, the view renders a single scope-accurate outcome notice naming only what was checked (`All Projects are up to date (N Projects)` for whole-fleet, `Selected Projects are up to date (N Projects)` for selected subsets, `This Project is up to date` for `--here`, or `<identity> is up to date` for explicit targets) with no breakdown listing and no next action. *Amended by issue #505 (spec #491, US-014, DEC-009, DEC-012). Superseded in part by issue #650 (spec #640, US-007): settled Projects appear as scope rows labeled `up to date`, not as a count-only line, and a wholly settled fleet still names every checked Project.*

4. **Blocker Containment.** Blockers are contained concisely within the status view. Project-scoped and global Blocker evidence (problem, requirement, remedy, scope) is presented without suppressing the primary cause partition of the remaining fleet.

5. **Shared Fleet Identity Policy.** In fleet context (`LocationDisplayScope: "fleet"`), all Project identities are rendered with home-relative paths (e.g. `~/project-a`), never bare `.` or working-directory aliases. *Amended by ADR-0042:* a scanning view (concise `status`, default receipts, `list projects`) now renders each Project by the shortest-unambiguous identity among the Projects that view names, and requested evidence (`--verbose`, `apkit details`, `--json`) keeps the stable home-relative or absolute path. The prohibition on `.` and working-directory aliases is unchanged and now applies to every human view.

6. **Advisory Warnings Independence.** Advisory host-attention warnings (e.g., missing or outdated Host CLIs per ADR-0025) do not classify an otherwise settled Project into `needs attention`. Warnings render inline directly beside command outcomes without a separate titled `Warnings:` section or empty warning block (DEC-010, US-018). *Amended by issue #652 (spec #640, US-011):* a missing-Host warning names the affected Project or Projects through the view's one consistent identity rather than only a count, keeps its Adapter-authored remedy on a separate default-colored line under a truthful completed-outcome headline, groups a genuinely shared identical remedy once without merging different Hosts' remedies, and never claims Host loading was proven or that the missing Host failed the update.

7. **Delivery Distinction for Filtering.** DEC-041 establishes the task-sufficient default view architecture and supersedes the filter policy of ADR-0024. Replacement human filter flags (`--stale` and `--blocked`) are delivered under ticket #455; `--blockers-only` remains in force until that ticket lands. This decision governs the default presentation.

8. **Language and Vocabulary.** This decision extends ADR-0014's user-facing vocabulary standards. Primary cause labels (`needs attention`, `generated files changed`, `generated files missing`, `not installed yet`, `source changed`, and `up to date`) are human presentation policy; detailed views add specifics rather than introducing synonyms (`addition`, `drifted output`, `stale source`, `current`). Machine schemas, exit codes, and typed diagnostic facts are preserved. *Amended by issue #505 (spec #491, US-014, DEC-009, DEC-012).*

## Supersessions

Issue #650 (spec #640, US-007, DEC-010) narrowly supersedes this record's
settled-count-only default listing and ADR-0020's clean-status no-Project-list
rule for `status`: the default status view now names the selected Workspace and
one compact row per checked Project. #491 US-013/014 are superseded to the same
extent. Operation receipts, machine schemas, exit codes, and the primary-cause
labels themselves are unchanged.

This record supersedes:
- **ADR-0017 (grouping and truncation):** Representative Project caps with `--verbose` escape hatches are superseded by complete wrapped primary-cause listings.
- **ADR-0020 (omission of routine detail):** Replaces operation-summary and exception-based presentation with the 5 primary cause fleet partition.
- **ADR-0024 (filter policy):** Superseded by task-sufficient default views that contain Blockers and display complete fleet partitions; replacement filter flags (`--stale` and `--blocked`) are delivered under #455 while `--blockers-only` remains in force until #455 lands.

## Consequences

- The default `status` view is task-sufficient: developers see every actionable Project, the exact primary reason it needs action, and contained Blocker diagnostics in a single invocation.
- Large fleets remain readable without dropping Project identities or requiring immediate `--verbose` flags.
- Machine schemas (v14), exit codes (0 for clean/attention, 2 for blocked), and `--verbose` diagnostics remain stable and unchanged.
