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

- `apkit` never prompts. When a step needs the user, it changes nothing,
  lists each decision, and exits with code 3. Explain each decision to the
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
`apkit migrate` once:

```sh
npm install -g agent-profile-kit
apkit migrate
```

- Each Project the old apkit installed keeps the same Workspace, Profile, and
  agents.
- If you changed a file the old apkit wrote, `migrate` changes nothing for
  that Project and asks you to decide. `--yes` keeps the file as your own, and
  apkit stops tracking it. `--overwrite` deletes it.
- If your Workspace has only the old `workspace.yaml` marker file, renaming it
  to `apkit-workspace.yaml` is a decision too.
- A Project folder that no longer exists is reported and skipped.
- When every Project is migrated, your old apkit state is kept as a backup at
  `~/.agents/agent-profile-kit.migrated`.

Until you migrate, every `apkit` command reminds you to run `apkit migrate`.

## Commands

```text
apkit guide                                  The complete guide for agents and people
apkit contract                               The Workspace contract: every format rule
apkit init <path>                            Create (or complete) a Workspace and select it
apkit workspace [<path>]                     Show or select the Workspace
apkit setup [--agents <a,b>] [--remove]      Add (or remove) a short apkit note in each agent's user instructions
apkit check                                  Validate the Workspace and list what it holds
apkit install <profile> [folder] --agents <a,b>
                                             Install a Profile (folder defaults to the current one)
apkit install <profile> --global --agents <a,b>
                                             Install a Profile for every project
apkit update [folder | --all]                Re-install from the current Workspace
apkit remove [folder | --global]             Remove everything apkit installed there
apkit status [folder | --all]                Show what is installed and what is out of date
apkit migrate                                Move each Project the old apkit installed to this one
```

Add `--json` to any command for machine-readable output. Exit codes: `0`
done, `1` error, `2` usage, `3` needs a decision (nothing was changed).
`apkit --help` prints the full list of options.

## Learn more

- `apkit guide`: how to set up, author, install, and report back.
- `apkit contract`, also at
  [docs/guides/workspace-contract.md](docs/guides/workspace-contract.md): the
  Workspace format and every rule that `apkit check` enforces.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the engine works and
  where each agent's files go.
