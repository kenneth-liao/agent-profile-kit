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

Initialize your Workspace in a folder you choose, without a global installation:

```sh
npx --package agent-profile-kit apkit init ~/projects/agent-profile-workspace
# Or use the current folder as your Workspace:
npx --package agent-profile-kit apkit init .
```

## First run

```sh
apkit init <path>                      # set up your Workspace in the folder you name (`.` uses the current folder)
apkit install <profile> --host <host>   # install a Profile into the current project
apkit status                            # review the fleet plan
apkit update                            # refresh installations from the Workspace (fleet by default)
apkit uninstall --here --auto-confirm   # remove an installation and forget its selection
```

`apkit update` narrows to one Project with `--here` or `--project <path>`;
`apkit uninstall` targets `--here`, `--project <path>`, or `--all`.

## Learn more

- `apkit --help` — concise summary of every command
- `apkit guide profile` (or `guide context`, `guide skill`) — focused authoring topics
- `apkit guide --contract` — the Workspace contract: every rule validation enforces
- `apkit guide --full` — the complete Workspace guide
- [docs/guides/workspace-contract.md](docs/guides/workspace-contract.md) — the Workspace contract, readable before installing apkit
- [docs/guides/workspace.md](docs/guides/workspace.md) — Workspace authoring guidance