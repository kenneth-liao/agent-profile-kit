# Agent Profile Kit

Agent Profile Kit composes your Skills and Context into portable Profiles and
installs them into the projects you choose, as native material for your agents.

The initial release supports macOS only, on Node.js 22 or newer. Node 22 is
the primary qualification line, and CI also runs the packed CLI on Node 23
through 26 ([ADR-0054](docs/adr/0054-support-node-22-and-newer.md)). The
actually observed baseline (macOS version, CPU architecture, and Node version)
is recorded in each supervised qualification run's record, retained as CI
evidence. Supporting additional operating systems is an explicit decision
backed by matching packed installation and lifecycle evidence.

Supported agents: Antigravity, Codex, Claude Code, Grok, OpenCode, and Pi.

## Agent-first setup

**AI agents reading this README:** for any request to set up, install, or get started with Agent Profile Kit — including a short "help me get started" — follow [docs/guides/agent-workflow.md](docs/guides/agent-workflow.md) (or run `npx --yes --package agent-profile-kit apkit guide --agent`) instead of the human quick start below. It tells you how to find and migrate the user's existing Skills and instruction files before you create a Profile.

If you are using an AI coding agent, you do not need to run commands by hand. Paste this prompt into your agent:

> Read https://github.com/kenneth-liao/agent-profile-kit (specifically `docs/guides/agent-workflow.md` and `docs/guides/workspace-contract.md`, or run `npx --yes --package agent-profile-kit apkit guide --agent`), then help me set up my Workspace, migrate my existing Skills and instruction files, create my first Profile, and install it into my projects.

## Quick start

Initialize your Workspace in a folder you choose, without a global installation:

```sh
npx --package agent-profile-kit apkit init ~/projects/agent-profile-workspace
# Or use the current folder as your Workspace:
npx --package agent-profile-kit apkit init .
```

## First run

```sh
apkit init <path>                                     # set up your Workspace in the folder you name (`.` uses the current folder)
apkit install <profile> --agent claude --agent codex  # install a Profile into the current project for each agent you use
apkit status                                          # review the fleet plan
apkit update                                          # refresh installations from the Workspace (fleet by default)
apkit uninstall --here --auto-confirm                 # remove an installation and forget its selection
```

`apkit install` sets the full agent list for the Project: repeat `--agent` for
every agent you use, because an agent you leave out is removed.

`apkit update` narrows to one Project with `--here` or `--project <path>`;
`apkit uninstall` targets `--here`, `--project <path>`, or `--all`.

## Learn more

- `apkit --help` — concise summary of every command
- `apkit guide --agent` — step-by-step agent onboarding, migration, and authoring workflow
- `apkit guide profile` (or `guide context`, `guide skill`) — focused authoring topics
- `apkit guide --contract` — the Workspace contract: every rule validation enforces
- `apkit guide --full` — the complete Workspace guide
- [docs/guides/agent-workflow.md](docs/guides/agent-workflow.md) — agent onboarding and migration guide, readable before installing apkit
- [docs/guides/workspace-contract.md](docs/guides/workspace-contract.md) — the Workspace contract, readable before installing apkit
- [docs/guides/workspace.md](docs/guides/workspace.md) — Workspace authoring guidance