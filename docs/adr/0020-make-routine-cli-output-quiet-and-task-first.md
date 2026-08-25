---
status: accepted
---

# Make routine CLI output quiet and task-first

## Context

The CLI presentation system already provides responsive human output, complete
structured evidence, and fleet-scale grouping. Routine output can still put the
same impact in both a summary and an operation section, show persistent Host
constraints as if Agent Profile Kit had observed unfinished setup, and describe
a freshly current post-apply state before the Apply Receipt that proves work was
just completed. Discovery surfaces can likewise put complete inventories and
implementation vocabulary ahead of the first task.

Agent Profile Kit cannot inspect whether Host-owned trust or approval has been
completed. Repeating a standing Host Setup Step on every clean `status` therefore
does not prove safety; it presents an unknown Host state as an outstanding Agent
Profile Kit task.

## Decision

Human and machine presentation have three explicit tiers:

1. **Concise human output** is the default. It presents the command outcome,
   affected scope or impact, one next action when one exists, and optional
   first-use guidance, in that order. A semantic fact renders once. Routine
   generated paths, Project matrices, Repository Exclusion bookkeeping, Host
   Setup Step provenance, and separately labeled consequences are omitted.
   Blockers, warnings, ownership attention, drift, destructive-removal
   attention, and Git repair or failure retain the identity required to act.
2. **Verbose human output** is the complete diagnostic view. It retains the
   exact Project and generated-path evidence, Git exclusion work, warnings,
   Blockers, desired setup, and all Adapter-authored Host Setup Steps with their
   provenance and consequences.
3. **JSON output** remains the versioned machine view. It retains the complete
   structured report, schemas, terminology, exit-code meaning, and stdout/stderr
   contract independently of human simplification.

A concise clean `status` states that the selected Project scope is current once.
It emits no Host setup reminder and no next action. A pending concise `status`
does not pre-announce post-apply setup.

A successful changed `apply` leads from the Apply Receipt, because that receipt
is the authority for work completed by the command. The freshly verified
reconciliation remains authoritative for resulting state, but it cannot produce
an "already current" claim when the receipt contains generated-file or
Repository Exclusion work. That phrase is reserved for a true no-op apply.
Equivalent next-launch outcomes render once for the invocation rather than once
per exact Host or Project set.

Concise `apply` may show first-use trust, approval, or launch guidance only when
the Apply Receipt makes that guidance relevant. Presentation groups it by user
action and Host, states the action and reason once, and does not expose
`transition` or `standing` as headings. Adapters remain the only authors of Host
Setup Steps; presentation does not infer Host requirements or completion from
installed files.

We accept that clean concise status no longer attempts to prevent a silent
Host-owned trust or approval failure. Agent Profile Kit cannot inspect that
completion, so the disclosure routes are first-use apply guidance, verbose
status, focused guidance, and native Host prompts. Persisting or detecting Host
trust remains out of scope.

## Superseded decisions

This ADR supersedes only the conflicting default-view rules below; the remaining
parts of ADR-0014 and ADR-0017 stay accepted.

- **ADR-0014:** routine generated paths are no longer required in concise output;
  `apply` no longer renders every Host Setup Step; and `status` no longer retains
  a standing Host reminder. Its Adapter ownership, blocker-first reports,
  user-facing language, `--verbose`, JSON, and uniform exit-code decisions
  remain in force.
- **ADR-0017:** single-Project concise output is no longer required to retain
  Project-first generated-path detail; concise grouping may omit routine path
  evidence rather than being strictly additive; successful Repository Exclusion
  work is verbose evidence; readiness is invocation-wide rather than grouped by
  exact Host scope; and persistent standing reminders are not part of concise
  status or routine apply. Its invocation-scoped reuse, bounded read concurrency,
  sequential mutation, deterministic ordering, fresh verification, and
  structural qualification decisions remain in force.

## Consequences

- Routine output can stay short without weakening Blockers or ownership safety.
- Complete human and machine evidence remains available without creating a
  second Host setup model.
- Apply presentation must keep completed work and resulting state distinct while
  leading with the fact most relevant to the command just run.
- Future concise evidence exceptions must extend the typed exception policy;
  local formatters cannot restore routine detail as a fallback.
- Width, color, `NO_COLOR`, progress, Adapter output plans, reconciliation,
  ownership, and Host Resolution are unchanged.
