# Agent Profile Kit Operating Manual

This repository is the open-source Agent Profile Kit engine. Its current personal and reusable artifact content is legacy migration input and is not part of the target public product boundary.

## Repository Rules

- Keep one canonical home per fact. Do not duplicate maintained guidance across files.
- Normalize external inputs at the boundary of the tool or skill that ingests them.
- Prefer small, complete changes over broad scaffolding that is not used yet.
- Use test-driven development for behavior changes unless the change is trivial, docs-only, or a throwaway spike.
- Keep per-issue worktrees under `.worktrees/` and never commit local runtime state.

## Canonical Locations

- `cli/` owns the `agent-profile-kit` command and user-facing orchestration.
- `adapters/` owns Host-specific generation and launch integration.
- `installer/` owns shared validation, planning, lifecycle, and launcher orchestration.
- `schemas/` owns portable Workspace and artifact schemas.
- `docs/adr/` owns accepted decisions and rationale.
- `docs/ARCHITECTURE.md` owns living structural facts.
- `docs/runbooks/` owns operational playbooks.
- `docs/archive/` owns shipped plans and spent research only.

`commands/`, `context/`, and `skills/` are legacy migration input. Do not add new personal content to the open-source engine. A maintained user workflow belongs in the user's Workspace; an Adapter may generate Host-specific activation interfaces from it.

When a new category of fact does not fit these locations, record the placement decision in `docs/adr/` before spreading it across the repo.
