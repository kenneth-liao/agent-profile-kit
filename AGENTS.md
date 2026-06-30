# Agent Kit Operating Manual

This repository is the canonical home for agent commands, shared context, tools, skills, and workflow guidance used on this system.

## Repository Rules

- Keep one canonical home per fact. Do not duplicate maintained guidance across files.
- Normalize external inputs at the boundary of the tool or skill that ingests them.
- Prefer small, complete changes over broad scaffolding that is not used yet.
- Use test-driven development for behavior changes unless the change is trivial, docs-only, or a throwaway spike.
- Keep per-issue worktrees under `.worktrees/` and never commit local runtime state.

## Canonical Locations

- `commands/` owns reusable command definitions.
- `context/` owns shared context packages and cross-project knowledge.
- `skills/` owns agent skills and their documentation.
- `tools/` owns local tools, scripts, and integrations.
- `docs/adr/` owns accepted decisions and rationale.
- `docs/runbooks/` owns operational playbooks.
- `docs/archive/` owns shipped plans and spent research only.

When a new category of fact does not fit these locations, record the placement decision in `docs/adr/` before spreading it across the repo.
