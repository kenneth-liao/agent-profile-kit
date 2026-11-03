# Agent Profile Kit

Agent Profile Kit keeps your Skills and Context in one folder and installs
them into your projects for each coding agent you use.

- **Workspace:** your source folder for Context and Skills.
- **Profile:** a named selection of Context and Skills to install.
- **Context:** guidance your agents load for every session.

The command is `apkit`. It installs a Profile into a project folder, or for
every project, keeps installs up to date, and removes them. It never loses an
edit you made: a change it cannot make safely is a decision for you.

Supported agents: Antigravity, Claude Code, Codex, Grok, OpenCode, and Pi.
Supported systems: macOS, Linux, and Windows, on Node.js 22 or newer.

## For AI agents: start here

If a user asks you to set up, install, or get started with Agent Profile Kit:

1. Install `apkit` from npm:

   ```sh
   npm install -g agent-profile-kit
   ```

2. Run `apkit guide` and follow it. The guide is built into the command and
   always matches the installed version. It tells you how to create or select
   the user's Workspace, run `apkit setup`, and install a Profile.

The guide is the full set of rules. The ones that matter most:

- `apkit` never prompts. When a step needs the user, it does not change the
  folder or Project that needs it, lists each decision, and exits with code 3. Explain each decision to the
  user in plain words.
- Ask the user before you pass `--yes`. It allows edits to the user's own
  instruction files (such as `AGENTS.md` and `CLAUDE.md`).
- Never pass `--overwrite` on your own judgment. It discards changed files.
- For each instruction file that you create or change, tell the user whether
  Git tracks it.
- Committing is the user's decision. Never stage, commit, or push installed
  files or instruction-file changes unless the user asks.

To read the guide before you install anything, run
`npx --package agent-profile-kit apkit guide`.

## For people

You do not need to run the commands yourself. Paste this prompt into your
coding agent:

> Read https://github.com/kenneth-liao/agent-profile-kit and help me get
> started with Agent Profile Kit.

## Existing users: run `apkit migrate`

If you used apkit 0.238 or earlier, install the new version and run
`apkit migrate` once. Until you do, every `apkit` command reminds you.

```sh
npm install -g agent-profile-kit
apkit migrate
```

What `migrate` keeps and which decisions it asks for:
[docs/USER-JOURNEY.md § Migration](docs/USER-JOURNEY.md#migration).

## Commands

`apkit --help` lists every command, option, agent ID, and exit code.
[docs/USER-JOURNEY.md](docs/USER-JOURNEY.md) maps each stage and what it owes
you.

## Learn more

- `apkit guide`: how to set up, author, install, and report back.
- `apkit contract`, also at
  [docs/guides/workspace-contract.md](docs/guides/workspace-contract.md): the
  Workspace format and every rule that `apkit check` enforces.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the engine works and
  where each agent's files go.
