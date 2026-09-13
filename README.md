# Agent Profile Kit

Agent Profile Kit composes your Skills and Context into portable Profiles and
installs them into the projects you choose, as native material for your Agent
Hosts.

The initial release supports macOS only, on the Node.js 22 line — the package's
declared primary Node runtime; no newer Node release line is claimed. The
actually observed baseline (macOS version, CPU architecture, and Node version)
is recorded in each supervised qualification run's record, retained as CI
evidence. Supporting additional environments is an explicit decision backed by
matching packed installation and lifecycle evidence, never an engine-range
promise.

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
apkit install <profile> --host <host>     # install a Profile into the current project
apkit status                                # review the plan for the bound project
apkit update                                # refresh installations from the Workspace
```

## Learn more

- `apkit --help` — concise summary of every command
- `apkit guide --full` — the complete Workspace guide
- [docs/guides/workspace.md](docs/guides/workspace.md) — Workspace authoring guidance