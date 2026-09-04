# Agent Profile Kit Operating Manual

This repository is the open-source Agent Profile Kit engine. It contains product code, schemas, adapters, installer behavior, documentation, and neutral fixtures—not user-owned Workspace material.

## Repository Rules

- Keep one canonical home per fact. Do not duplicate maintained guidance across files.
- Normalize external inputs at the boundary of the tool or skill that ingests them.
- Prefer small, complete changes over broad scaffolding that is not used yet.
- Delegate native discovery, precedence, deduplication, collisions, and resource
  resolution to each Agent Host. Adapters detect only the capabilities needed
  to project portable material and must not reconstruct Host resolvers or
  effective inventories. See ADR-0012.
- Use test-driven development for behavior changes unless the change is trivial, docs-only, or a throwaway spike.
- Keep per-issue worktrees under `.worktrees/` and never commit local runtime state.
- Until 1.0, follow standard SemVer 0.x: breaking changes bump the **minor** version rather than forcing a premature 1.0. Breaking changes are expected pre-launch and carry no compatibility shims. See ADR-0014.

## Canonical Locations

- `cli/` owns the `apkit` command and user-facing orchestration.
- `adapters/` owns Host-specific project output planning and capability detection.
- `installer/` owns shared validation, reconciliation planning, ownership, and installation lifecycle.
- `schemas/` owns portable Workspace and artifact schemas.
- `docs/adr/` owns accepted decisions and rationale.
- `docs/ARCHITECTURE.md` owns living structural facts.
- `docs/USER-JOURNEY.md` owns user-facing CLI surface behavior: the stages and the outcome each stage owes.
- `docs/runbooks/` owns operational playbooks.
- `docs/archive/` owns shipped plans and spent research only.

Personal material belongs in the user's Workspace, not in this repository. A maintained user workflow belongs there as well; an Adapter may generate Host-native project files from it.

When a new category of fact does not fit these locations, record the placement decision in `docs/adr/` before spreading it across the repo.

## Verification

Prefer a focused suite while iterating and run the full suite before opening a PR:

- `bun run test:focused -- <paths-or-filters>` — one explicitly selected run under the supervised lifecycle.
- `bun run test` — one full-suite run under the supervised lifecycle.
- `bun run test:fleet` — fleet-scale regressions outside the fast suite's deadline.
- `bun run test:stress` — up to ten sequential full-suite runs for repeated qualification.

All four supervise the test runner through the repository's bounded process executor and report one concise summary with a retained diagnostic log. Prefer these canonical commands over invoking the runner directly or writing custom timeout or repetition loops.

## Agent skills

### Issue tracker

Issues and PRDs live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the standard canonical triage-label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with one root glossary and root ADR directory. See `docs/agents/domain.md`.
