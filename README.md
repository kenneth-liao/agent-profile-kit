# Agent Profile Kit

Agent Profile Kit is a user-agnostic CLI and format for composing a user's Skills, Context, Agents, Hooks, and Tools into portable Profiles. Host Adapters generate native Profile output for supported agent products without overwriting their existing configuration or capabilities.

The initial product slice binds Context-only Profiles to explicit local projects and loads them through Codex's native project SessionStart hook. Global Host configuration and repository-owned instructions remain untouched.

## Quick start

Initialize the canonical Workspace without a global installation:

```sh
npx agent-profile-kit init
```

The initial release supports macOS only.

Running the command again is safe: it creates only missing inputs and never overwrites the Workspace or Local Configuration.

## Project-bound Context

The first project-bound slice supports Context Modules and explicit flat Profiles
for Codex. Profiles selecting Skills, Agents, Hooks, or Tools are rejected until
their native project delivery slices land.

```sh
agent-profile-kit validate
agent-profile-kit preview
agent-profile-kit apply
agent-profile-kit status
agent-profile-kit uninstall
```

Project Bindings live in the machine-local
`~/.agents/agent-profile-kit/config.yaml`. Each binding names one existing
absolute or `~/` project root, one Profile, and `codex` as its Host. `preview`
is read-only; `apply` reconciles every binding; `status` reports current, stale,
drifted, missing, and malformed ownership states; `uninstall` removes only
output whose Marker and hashes prove Agent Profile Kit ownership.

See `agent-profile-kit guide` for the Context Module, Skill, and Profile formats.

## Product layout

- `cli/` - the `agent-profile-kit` command.
- `adapters/` - all Host-specific generation and launch integration.
- `installer/` - configuration ingestion, desired-state planning, reconciliation, ownership, and lifecycle orchestration.
- `schemas/` - portable Workspace and artifact schemas.
- `docs/adr/` - accepted architectural and workflow decisions.
- `docs/ARCHITECTURE.md` - the living system structure and delivery model.
- `docs/runbooks/` - operational playbooks for risky or repeatable procedures.
- `docs/archive/` - shipped plans and spent research kept only for provenance.

The existing `commands/`, `context/`, and `skills/` content is legacy migration input. Personal material will move to a user-owned Workspace; reusable material may later become optional content rather than part of the engine.

## User data

Canonical user content lives under `~/.agents/agent-profile-kit/workspace/`. Machine-local Project Bindings live in `config.yaml`; disposable Installation Manifests live under `state/`. Generated Context and hooks live only in bound project-owned paths.

`agent-profile-kit init` creates an empty Workspace with a schema marker, artifact directories, and short human/agent bootstrap files. Current authoring guidance remains owned by the CLI through `agent-profile-kit guide` and `agent-profile-kit guide --agent`; initialization does not copy personal or opinionated starter content.

## Working Principles

This repository favors one canonical home per fact. The open-source repository owns product behavior; each Workspace owns its user's artifacts; generated Profile Installations are never edited as sources.
