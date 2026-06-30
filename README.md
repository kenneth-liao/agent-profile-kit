# Agent Kit

Agent Kit is the monorepo and single source of truth for agent commands, shared context, tools, skills, and operating guidance used across this system.

## Layout

- `commands/` - reusable agent commands and command definitions.
- `context/` - shared context packages and cross-project knowledge.
- `skills/` - agent skills and skill documentation.
- `tools/` - local tools, scripts, and integrations for agent workflows.
- `docs/adr/` - accepted architectural and workflow decisions.
- `docs/runbooks/` - operational playbooks for risky or repeatable procedures.
- `docs/archive/` - shipped plans and spent research kept only for provenance.

## Working Principles

This repository favors one canonical home per fact. When adding content, place it in the directory that owns that kind of fact rather than duplicating it across docs or scripts.
