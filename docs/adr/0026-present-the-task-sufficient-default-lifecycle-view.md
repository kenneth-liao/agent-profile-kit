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

2. **Complete Actionable Identities.** Every actionable Project in the fleet is listed under its primary cause group. Default presentation wraps paths across terminal lines without artificial length caps or truncation pointers.

3. **Settled Counts & Wholly Settled Outcome.** Projects requiring no reconciliation work are summarized as a single count line (`settled (N)`) in mixed fleets. When every Project in the fleet is settled, the view renders a single outcome notice (`All Projects are current (N Projects)`) with no breakdown listing and no next action.

4. **Blocker Containment.** Blockers are contained concisely within the status view. Project-scoped and global Blocker evidence (problem, requirement, remedy, scope) is presented without suppressing the primary cause partition of the remaining fleet.

5. **Shared Fleet Identity Policy.** In fleet context (`LocationDisplayScope: "fleet"`), all Project identities are rendered with home-relative paths (e.g. `~/project-a`), never bare `.` or working-directory aliases.

6. **Advisory Warnings Independence.** Advisory host-attention warnings (e.g., missing or outdated Host CLIs per ADR-0025) do not classify an otherwise settled Project into `needs attention`. Warnings render inline directly beside command outcomes without a separate titled `Warnings:` section or empty warning block (DEC-010, US-018).

7. **Delivery Distinction for Filtering.** DEC-041 establishes the task-sufficient default view architecture and supersedes the filter policy of ADR-0024. Replacement human filter flags (`--stale` and `--blocked`) are delivered under ticket #455; `--blockers-only` remains in force until that ticket lands. This decision governs the default presentation.

8. **Language and Vocabulary.** This decision extends ADR-0014's user-facing vocabulary standards. Primary cause labels (`needs attention`, `generated files changed`, `generated files missing`, `not installed yet`, `source changed`) are human presentation policy; versioned machine schemas, exit codes, and typed diagnostic facts are preserved.

## Supersessions

This record supersedes:
- **ADR-0017 (grouping and truncation):** Representative Project caps with `--verbose` escape hatches are superseded by complete wrapped primary-cause listings.
- **ADR-0020 (omission of routine detail):** Replaces operation-summary and exception-based presentation with the 5 primary cause fleet partition.
- **ADR-0024 (filter policy):** Superseded by task-sufficient default views that contain Blockers and display complete fleet partitions; replacement filter flags (`--stale` and `--blocked`) are delivered under #455 while `--blockers-only` remains in force until #455 lands.

## Consequences

- The default `status` view is task-sufficient: developers see every actionable Project, the exact primary reason it needs action, and contained Blocker diagnostics in a single invocation.
- Large fleets remain readable without dropping Project identities or requiring immediate `--verbose` flags.
- Machine schemas (v14), exit codes (0 for clean/attention, 2 for blocked), and `--verbose` diagnostics remain stable and unchanged.
