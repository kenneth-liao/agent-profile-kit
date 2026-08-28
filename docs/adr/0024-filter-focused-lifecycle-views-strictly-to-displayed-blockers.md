---
status: accepted
---

# Filter focused lifecycle views strictly to displayed Blockers

An ordinary blocked `status` report interleaves Blocker evidence with the complete lifecycle inventory — output operations, selected setup, warnings, Host Setup Steps — so a fleet with two Blockers can produce thousands of lines before the user reaches the conditions that actually stop `apply` (spec #345, ticket #351). The accepted decision, implementing spec #345 Decision 5:

- `--blockers-only` is a **strict Blocker filter**, not an attention or warning filter. It renders every global and Project Blocker in the selected scope and suppresses unrelated Project state, output, selected setup, warning, and Host Setup Step inventory. Warning filtering is a separate concern (spec #345, sibling tickets) and never rides on this flag.
- **Footer counts derive exclusively from the displayed Blockers**: the Blocker count and, when at least one Project-scoped Blocker is displayed, the count of distinct affected Projects. No Installation total or any figure derived from unrelated lifecycle inventory appears in the focused view, so the footer can never contradict what the view shows.
- `--blockers-only --verbose` retains every affected item and complete Blocker field while still omitting unrelated lifecycle sections. It keeps the same outcome line, footer, and section set as the concise focused view, minus next actions, matching the existing verbose contract in which only concise views carry next actions.
- A scope with no Blockers reports exactly that outcome — `No blockers.` with a scope-aware pointer back to the unfiltered view — and never expands ordinary lifecycle inventory. Exit codes, Project selection, wrapping, color, progress, ordinary concise and verbose output, and JSON are unchanged.
- `--blockers-only --json` **fails at argument parsing**, before any lifecycle inspection, with focused usage guidance. JSON remains the complete machine report: no filtered or summarized machine schema exists, because automation that wants only Blockers can project them from the complete payload, while a filtered machine surface would fork the payload contract that hosts and scripts depend on.

The filter is presentation only. It never changes what the lifecycle inspects, plans, or writes; a partial `apply` receipt and its pending or failed Project scope remain visible under every human filter because writes must never be hidden (spec #345 Decision 6).

The maintained glossary (`CONTEXT.md`) owns the canonical Blocker definition; this record owns the filter's semantics and rationale.
