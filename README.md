# Agent Profile Kit

Agent Profile Kit composes your Skills and Context into portable Profiles and
installs them into the projects you choose, as native material for your Agent
Hosts.

The initial release supports macOS only.

Supported Hosts: Antigravity, Codex, Claude Code, Grok, OpenCode, and Pi.

## Quick start

Initialize your Workspace without a global installation:

```sh
npx --package agent-profile-kit apkit init
# Or choose one explicit Workspace path:
npx --package agent-profile-kit apkit init ~/projects/agent-profile-workspace
```

## First run

```sh
apkit init                                  # scaffold your Workspace
apkit bind <profile> --host <host>          # bind a Profile to the current project
apkit status                                # review the plan for the bound project
apkit apply                                 # install the Profile into the project
```

## Learn more

- `apkit --help` — concise summary of every command
- `apkit guide --full` — the complete Workspace guide
- [docs/guides/workspace.md](docs/guides/workspace.md) — Workspace authoring guidance