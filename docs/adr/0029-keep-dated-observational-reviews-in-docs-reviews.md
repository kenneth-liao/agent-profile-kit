---
status: accepted
---

# Keep dated observational reviews in `docs/reviews`

## Context

An independent UI/UX walkthrough of the packed CLI produced a substantial
written record: what a newcomer sees, where the surface helps, and where it
gets in the way. The existing documentation map has no home for that kind of
artifact. `docs/USER-JOURNEY.md` is the living map of what each stage *owes*
the user and is maintained against the delivered surface; a dated review is an
outside observation of one build at one moment and would rot that map if
merged into it. `docs/adr/` owns settled decisions, and a review proposes
nothing settled. `docs/guides/` is end-user material. `docs/archive/` is for
work that has already shipped or been decided. The issue tracker owns work and
its state, and a review is not a backlog.

Introducing a new documentation category requires a placement decision, so this
record makes it before the category exists.

## Decision

1. **`docs/reviews/` is the home for dated observational reviews.** One file
   per review, named `YYYY-MM-DD-<subject>.md`. Supporting raw transcripts live
   under `docs/reviews/evidence/`.

2. **A review records observations, not maintained backlog.** Its findings are
   what one reviewer saw against one build at one date. Nothing in
   `docs/reviews/` is updated to stay true as the product changes, and no living
   document links to it as current guidance.

3. **Work and state stay in the issue tracker.** A finding that deserves action
   graduates to a tracker issue that cites the review file and finding ID. The
   review is never edited to record that an issue was opened, assigned, or
   closed.

4. **A review is not a decision.** A review may argue against an accepted ADR;
   that argument changes nothing until a later ADR accepts it. Reviews never
   amend `CONTEXT.md`, `docs/USER-JOURNEY.md`, or any ADR by being written.

5. **A spent review archives only after its load-bearing conclusions have
   graduated** — to an ADR for a decision, `CONTEXT.md` for a term or
   invariant, `docs/ARCHITECTURE.md` for a structural fact, or a tracker issue
   for work — and nothing links to it as current guidance. It then moves to
   `docs/archive/reviews/` with `git mv`.

## Consequences

- The documentation map gains one category with an explicit and narrow purpose,
  so a review cannot drift into being a second journey map or a second backlog.
- Review findings are cheap to keep and easy to date-check, because staleness is
  expected rather than a defect.
- A reader who wants current truth is never sent to `docs/reviews/`; the living
  homes in the documentation map remain authoritative.
