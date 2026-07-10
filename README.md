# Agent Profile Kit

Agent Profile Kit is a user-agnostic CLI and format for composing a user's Skills, Context, Agents, Hooks, and Tools into portable Profiles. Host Adapters generate native Profile Installations for supported agent products without modifying their global configuration.

## Quick start

Initialize the canonical Workspace without a global installation:

```sh
npx agent-profile-kit init
```

The initial release supports macOS only.

Running the command again against the valid Workspace is safe and reports it unchanged.

## Context and Skills Codex tracer

The first Profile tracer supports Context Modules, standard Agent Skills, and
explicit flat Profiles. Validate the Workspace, inspect the generated Context,
Skills, and Codex capability, install disposable output, then launch it from the
target project:

```sh
agent-profile-kit validate
agent-profile-kit plan --profile coding --host codex
agent-profile-kit install --profile coding --host codex
agent-profile-kit status --profile coding --host codex
agent-profile-kit run --profile coding --host codex -- --model o3
```

After editing the Workspace, run `agent-profile-kit update` to explicitly
regenerate every verified installed Profile/Host pair. `status` distinguishes
source changes from edits to generated output. To remove disposable output,
run `agent-profile-kit uninstall --profile coding --host codex`; it deletes
only an installation whose Manifest confirms that identity.

See `agent-profile-kit guide` for the Context Module, Skill, and Profile formats.

## Product layout

- `cli/` - the `agent-profile-kit` command.
- `adapters/` - all Host-specific generation and launch integration.
- `installer/` - validation, planning, installation, update, status, uninstall, and launch orchestration.
- `schemas/` - portable Workspace and artifact schemas.
- `docs/adr/` - accepted architectural and workflow decisions.
- `docs/ARCHITECTURE.md` - the living system structure and delivery model.
- `docs/runbooks/` - operational playbooks for risky or repeatable procedures.
- `docs/archive/` - shipped plans and spent research kept only for provenance.

The existing `commands/`, `context/`, and `skills/` content is legacy migration input. Personal material will move to a user-owned Workspace; reusable material may later become optional content rather than part of the engine.

## User data

Canonical user content lives under `~/.agents/agent-profile-kit/workspace/`. Disposable Host-specific output lives separately under `~/.agents/agent-profile-kit/installations/`.

`agent-profile-kit init` creates an empty Workspace with a schema marker, artifact directories, and short human/agent bootstrap files. Current authoring guidance remains owned by the CLI through `agent-profile-kit guide` and `agent-profile-kit guide --agent`; initialization does not copy personal or opinionated starter content.

## Working Principles

This repository favors one canonical home per fact. The open-source repository owns product behavior; each Workspace owns its user's artifacts; generated Profile Installations are never edited as sources.
