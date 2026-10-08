# Triage labels

Engineering skills use canonical category and state roles. This repository uses the same strings in GitHub.

## Category roles

| Canonical role | GitHub label | Meaning |
| --- | --- | --- |
| `bug` | `bug` | Something is broken |
| `enhancement` | `enhancement` | New feature or improvement |

## State roles

| Canonical role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer needs to evaluate the issue |
| `needs-info` | `needs-info` | Waiting for more information |
| `ready-for-tickets` | `ready-for-tickets` | Settled spec ready for ticket decomposition |
| `ready-for-agent` | `ready-for-agent` | Fully specified and ready for an AFK agent |
| `ready-for-human` | `ready-for-human` | Requires human implementation or interaction |
| `wontfix` | `wontfix` | Will not be actioned |

Every triaged issue carries exactly one role from each table.

## Delivery

- A ticket is on the implementation frontier only when it is open, ready, unclaimed (none of the issue tracker's active-work signals), has no integration-merge record, and every blocker is done under `/to-tickets`' rule for when a blocker is done.
- A spec's repository-change tickets merge into the spec's integration branch (named by `/to-tickets`) with no change request of their own, and stay open. One spec change request takes that branch into the usual base branch. A standalone ticket ships in its own change request into the usual base branch. `docs/agents/issue-tracker.md` gives only the platform mechanics: opening a change request and how it closes issues.
- Repository-change delivery of a spec's ticket requires its ticket branch merged into the spec's integration branch, then the spec change request merged into the usual base branch, which closes the ticket. Merging into the integration branch alone is not delivery; the ticket stays open until then.
- Whoever merges a ticket branch into the integration branch records an **integration-merge record** on the ticket at once: a comment naming the integration branch and the merge commit. The ticket branch and worktree may be removed after the merge, so this record is the durable signal that keeps the open ticket off the frontier and lets its dependents start.
- Repository-change delivery of a standalone ticket (no parent spec) requires its own merged change request and a closed tracker item.
- Human-only or external-artifact delivery requires the recorded qualification or artifact named by its acceptance criteria and a closed item; no artificial change request is needed. Mixed work requires both kinds of evidence. Supersession or administrative closure is not delivery.
- The spec acceptance audit is the Spec axis of the final `code-review` over the whole integration branch, checked against every requirement the spec owns. There is no separate closer. Merging the spec change request after that review reports Ready authorizes closing the spec; the next rule says when it closes.
- The spec change request closes the spec and its delivered tickets when no other required child remains. When a human-only or non-repository child remains, it closes only its delivered tickets. The spec then closes when the last remaining child records its delivery evidence: whoever closes that child confirms every required child has its evidence and closes the spec too. A spec with no repository change follows the same rule without a change request. Closed children alone are otherwise insufficient.
