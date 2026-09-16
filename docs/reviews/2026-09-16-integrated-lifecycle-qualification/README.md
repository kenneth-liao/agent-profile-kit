# Integrated lifecycle qualification — agent-prepared evidence

> **PENDING HUMAN QUALIFICATION — NOT PASSED.** This directory prepares
> TEST-010 for #518 (unfamiliar-user observation) and TEST-011 for #519
> (principal visual review). No human result is claimed here. A model
> walkthrough, green snapshots, or closed child tickets do not substitute for
> human qualification (DEC-013). Results belong to #518/#519.

## Provenance

- Parent spec: #491 ([SPEC] Make apkit intuitive, predictable, and polished
  across the Profile lifecycle). Prepared under ticket #517.
- Build under test: Agent Profile Kit **0.204.0**, bundle built from the #517
  integration branch head via `bun build cli/index.ts --target=node`
  (the same bundle the pack ships, run with the supported Node 22 runtime).
- Date basis: **2026-09-16 UTC** (session/CI timestamps). Local time at capture
  was 2026-09-15; UTC is used everywhere in this directory, including its name.
- Capture method: real runs of the built CLI under `script` PTYs at
  `COLUMNS=100` and `COLUMNS=60`, sandbox `HOME`s with six controlled Host
  executables present (antigravity, claude, codex, grok, opencode, pi) so
  detection labels are deterministic. ANSI styling stripped for readability;
  layout and wording are verbatim. Sandbox paths redacted to `<SANDBOX>`.
  Color-bearing behavior stays pinned by `test/terminal-presentation.test.ts`
  and the retained 2026-09-09 palette evidence; these transcripts judge
  layout, wording, and progressive disclosure.
- Run-local values: operation identities (`op-000001`, …), timestamps, and
  temporary paths differ on every run; structure and wording are the evidence.
- Placement: dated evidence, frozen per ADR-0029 (as established by #516).
  Nothing here is living documentation: no living doc links to this directory
  as current guidance, and the preserved 2026-09-09 review is untouched.

## Contents

- `newcomer-instructions.md` — repeatable uncoached-newcomer procedure for
  #518 (results pending, not passed).
- `screens-100/` — six rendered transcripts at 100 columns.
- `screens-60/` — the same six at 60 columns.

| Screen | Covers | TEST-011 category |
| --- | --- | --- |
| `01-first-use.txt` | bare setup state, guided `init`, first install receipt with loading check | first use |
| `02-routine.txt` | settled update receipt, `status`, `validate` | routine |
| `03-failure.txt` | Profile suggestion, invalid-target diagnostic, declined install | failure |
| `04-selection.txt` | bare-install Profile/Host pickers, declined confirmation | selection |
| `05-fleet.txt` | four-Project inventory (long path, colliding basenames), scoped status, compact update | fleet |
| `06-details.txt` | `details --list`, one retained entry | details |

## Integrated-surface check (AC3, TEST-012 preparation)

Recaptured against the delivered CLI and compared with the living journey map
(`docs/USER-JOURNEY.md`) and the new decisions (ADR-0043, ADR-0044):

- Init ends with one install next action naming the created Profile and no
  Host (`01-first-use.txt`, cf. #511) — matches USER-JOURNEY stage 2.
- First install/Host addition offers the optional loading check; routine
  updates close with the readiness reminder alone (`01` vs `02`, cf. #515 /
  ADR-0043) — matches USER-JOURNEY stage 9.
- Settled wording is `up to date` with scope-accurate counts (`02`, `05`,
  cf. #505) — matches USER-JOURNEY stage 7/10 wording.
- Host inventory labels executable detection installed/not found without
  implying Profile loading (controlled Hosts all present here; absent labels
  remain covered by #512's suite) — matches USER-JOURNEY stage 1 inventory.
- Authoring guides render as terminal content; `guide --agent` stays raw
  markdown (cf. #510 / ADR-0044) — no drift found in the guide routes.
- No documentation update was required by this ticket: the living map already
  describes the delivered surface. Sibling behavior is relied on, not
  re-owned; predecessor suites own the standalone contracts.

## Observations recorded without scope expansion

1. `apkit init --help` and `apkit guide profile` close with the static example
   `apkit install example --host codex`. This is a fixed documentation example,
   not init dynamically selecting the first detected Host (detection here lists
   antigravity first; the receipt itself names no Host per #511). Recorded for
   the spec acceptance audit; no change made — the line belongs to #509's
   guide surface.
2. The #515 follow-up question recorded on #491 stands: the install receipt
   does not surface required Host Setup Steps (they appear later through
   status/verbose/update views). Exercised honestly in `01-first-use.txt`;
   audit-only per maintainer ruling, not fixed here.
3. Automated pins added by #517 (`test/integrated-lifecycle-qualification.test.ts`,
   7 tests, all green): completed-operation evidence survives later no-op and
   cancelled attempts; failed uninstalls and failed selection restores are
   recorded and rendered as failed (never as success) in history and compact
   output, with the same-scope retry; uninstall offers the shared optional
   diff view before deleting changed output; a real install writes the
   generated-source notice into Skill, Context, and Host-configuration
   output; `configure profile` membership edits reach installations through
   the printed update action; partial Host removal keeps the remaining Host
   working with shared output preserved (file-level bound per OOS-003/N6).
   Each pin was verified to fail when its guarantee is broken (code-mutation
   and interaction-ablation spot-checks).

## For #518 and #519

- #518: hand the participant `newcomer-instructions.md` and the 0.204.0 (or
  newer, re-pinned) build. Record version, coaching needed, and completion
  failures. Do not replace an observed failure with an assertion of
  acceptance.
- #519: review `screens-100/` and `screens-60/` for readability, styling,
  scope clarity, and progressive disclosure. Record version and explicit
  assessment. Do not mark accepted while material visual issues remain.
