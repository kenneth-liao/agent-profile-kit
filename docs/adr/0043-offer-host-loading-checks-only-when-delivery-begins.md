---
status: accepted
---

# Offer Host-loading checks only when Profile delivery begins

## Context

The post-apply Host-loading verification instruction (spec #373 US-041, DEC-025) told the user
how to check that an Agent Host loaded the installed Profile — start a new session and ask it
what Profile material it loaded. It fired wherever the next-launch readiness statement fired,
so every committed update repeated the same optional check: an ordinary repeated content
update handed the user recurring homework for material that was already being delivered.
Conversely, the delivered lifecycle's first-installation action (`install`, ADR-0033) and its
Host addition reported the installed selection without offering the check at all (spec #491
US-017). The relevance rule lived in code commentary ("fires exactly where the readiness
statement fires"), not in a recorded decision.

Agent Profile Kit cannot observe whether a Host loaded a Profile. The check is optional
guidance, not evidence of completed setup, and it is relevant only when the invocation's
committed work actually began a Host's delivery of the Profile in a Project — not when it
refreshed material the Host already consumes.

## Decision

1. **Delivery-begins is the trigger.** The optional loading check is offered on a successful
   lifecycle outcome exactly when the Apply Receipt proves the committed work added generated
   output for a desired Host that had no prior output in that Project: a first installation, a
   Host addition, or a retired receipt's re-delivery. A content change that merely adds a file
   for an already-delivering Host is not a first delivery.
2. **One derivation home.** The relevance condition is derived inside the one function that
   authors the check (`cli/presentation.ts`), reusing the receipt-derived first-delivery
   predicate that gates a standing Host Setup Step's relevance (`isFirstRelevantHostOutput`),
   over the Project's exclusively-consumed outputs. Shared outputs — generated paths delivered
   for several Hosts at once — carry no per-Host delivery history: a Host that newly consumes
   an already-delivered shared path has not begun a delivery of its own, so shared paths are
   not prior-delivery evidence. No surface may decide the check's visibility independently,
   and no second relevance policy is authored; the standing-step policy itself is unchanged.
3. **Routine updates keep the short reminder.** An ordinary repeated content update renders no
   check; the invocation-wide readiness statement ("Profile … will load the next time you
   launch a configured Host from a bound Project root.") remains its closing guidance.
4. **Required setup keeps its own policy.** Transition-triggered and standing Host Setup Steps
   keep their existing relevance rules on the views that render them; this decision changes
   only the optional check.
5. **Machine surfaces are unchanged.** The check stays human-only; JSON payloads, schema
   versions, and exit codes are untouched, and no new typed fact is introduced for the
   condition — the Apply Receipt and resulting state already carry sufficient evidence.

## Consequences

- First installations and Host additions — whether through `install`, an `update` that
  installs a pending Project, or a re-delivered retired receipt — offer the check beside the
  receipt; unchanged installs commit no delivery and render none.
- Users performing routine content updates are no longer handed recurring optional homework;
  they keep the short new-session reminder.
- The check's sentence, its no-observation guarantee (OOS-009), and its never-render rule for
  no-op, blocked, declined, and failed outcomes are unchanged.
