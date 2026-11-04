# Agent Profile Kit user journey

The living map of what a person or their agent does with `apkit`, and what
each stage owes them. ADR-0013 says why this map exists.

**Scope.** This document owns user-facing CLI surface behavior: the stages,
the outcome each stage owes, and the rules every output follows. It does not
own the Workspace format (`docs/guides/workspace-contract.md`, printed by
`apkit contract`), the agent workflow (`apkit guide`, in `src/guide.ts`),
structure and file locations (`docs/ARCHITECTURE.md`), terms (`CONTEXT.md`),
or decisions (`docs/adr/`).

The primary user is an agent acting for a person. The agent runs `apkit guide`
first, does the authoring and the conversation, and lets `apkit` do every
install, update, and removal.

## The journey at a glance

| # | Stage | Command | Outcome the stage owes |
|---|-------|---------|------------------------|
| 1 | Discover | `npm install -g agent-profile-kit`, `apkit --help`, `apkit guide` | From the README alone, an agent installs `apkit` and learns the whole workflow from `apkit guide`, which matches the installed version. `--help` lists every command, option, agent ID, and exit code. |
| 2 | Learn the format | `apkit contract` | Every Workspace rule that validation enforces, with examples. |
| 3 | Create or select a Workspace | `apkit init <path>`, `apkit workspace [<path>]` | A Workspace at the path the user chose (never a default), selected for later commands. `workspace` without a path shows the selected Workspace's path. `workspace <path>` also shows its problems and each install whose Profile it lacks. |
| 4 | Tell the user's agents | `apkit setup [--agents <a,b>]`, `apkit setup --remove` | A short Setup Note in each installed agent's user-level instructions, so later sessions run `apkit guide` before they change Skills, Context, or Profiles. Adding or removing it is a Decision first. `--remove` restores each file. |
| 5 | Author and validate | Edit Workspace files, then `apkit check` | Each error names its file and the change that fixes it, and blocks installs and updates until fixed. Each warning names a file that `apkit` skips and blocks nothing. `check` lists the Profiles. |
| 6 | Install | `apkit install <profile> [folder] --agents <a,b>`, `apkit install <profile> --global --agents <a,b>` | The Profile's Skills in each selected agent's Skills folder and its Context in one Context Section, for one folder or for every project. Running `install` again with other values changes that folder's Profile or agents. Each instruction file it creates or changes is named, with whether Git tracks it, in the Decision and again after the write. |
| 7 | Use | The agent's next session | Agents load the material natively. `apkit` names each selected agent that does not load it until the user trusts the folder. Where each agent's files go: [`docs/ARCHITECTURE.md` § Verified Locations](ARCHITECTURE.md#verified-locations). |
| 8 | Re-sync | `apkit status [folder \| --all \| --global]`, `apkit update [folder \| --all]` | `status` shows what is installed and what is out of date and changes nothing; `status --global` shows the user-level install alone. `update` re-installs from the current Workspace. `--all` covers every installed folder and the user-level install. |
| 9 | Remove | `apkit remove [folder \| --global]` | Everything `apkit` installed there is gone, with the folders its writes left empty. A folder that holds only macOS Finder's `.DS_Store` file counts as empty. Instruction files keep everything outside the Context Section. |
| 10 | Migrate | `apkit migrate` | For a user of apkit 0.238 or earlier: each recorded Project keeps the same Workspace, Profile, and agents under this engine. See [Migration](#migration). |

## Rules for every stage

- **No prompts.** A step that needs the user is a Decision. The folder or
  Project that needs it is not changed; in a run over several, the others may
  already be done. The run lists every Decision and exits 3. The Next line is
  the exact command to run after the user agrees.
- **`--yes`** allows an edit to a file the user owns (such as `AGENTS.md`,
  `CLAUDE.md`, or an agent's user-level instruction file), a write through
  a symlink that leads outside the folder, and taking over a file `apkit` did
  not write that already has the same content, which `remove` then deletes. An agent passes it only after the
  user agrees.
- **`--overwrite`** replaces or deletes files that someone changed or that
  `apkit` did not write. An agent passes it only after the user explicitly
  agrees to discard the files it lists.
- **The user's edits are never lost.** `apkit` replaces or deletes only a file
  that still matches what it wrote.
- **Git.** Skill copies and the Installation Manifest are listed in the
  repository's `.git/info/exclude`. Instruction files are never hidden: the
  output says whether Git tracks each one, and committing is the user's
  decision.
- **`--json`** makes each operation command print one JSON value that is the
  complete record of the operation. `help`, `guide`, and `contract` print text
  only.
- **Options.** A command stops with exit 2, before it writes, on an
  option it does not take, and names the options it takes. `--help` works with
  every command.
- **Exit codes** agree across commands: `0` done, `1` error, `2` usage, `3`
  needs a Decision.

## Migration

`apkit migrate` moves installs of the released engine (0.238 and earlier) to
this one. The decisions are in spec #728; the mechanism is in
`docs/ARCHITECTURE.md` (Migration from the released engine). What it owes the
user:

- Each recorded Project gets the same Profile and agents, installed by this
  engine, and the same Workspace stays selected. No agent gets the Context
  twice.
- A file the old engine wrote that the user changed is a Decision that names
  the part `apkit` added. `--yes` keeps the file as the user's own and `apkit`
  stops tracking it; `--overwrite` deletes it. `--yes` cannot keep a changed
  file at a path this `apkit` installs again (such as a Skill folder):
  `--overwrite` or moving the changes out settles it.
- The Workspace must be valid only when a Project installs its Profile again.
  If it was moved or is not valid, the error names it and the old
  `config.yaml`; `apkit migrate --workspace <path>` uses another Workspace.
- A Workspace with only the old `workspace.yaml` marker file: the rename to
  `apkit-workspace.yaml` is a Decision.
- A recorded Project folder that no longer exists is reported and skipped.
- After every Project is migrated, the old state folder is kept as a backup
  at `~/.agents/agent-profile-kit.migrated`.
- Until then, every command names `apkit migrate`.

## Output rules

Every human output follows these rules, including output added later:

1. The first output of `init`, `workspace`, and `guide` explains Workspace,
   Profile, and Context in plain words.
2. Each Project is named by its path, even when Projects share a folder name.
3. Every warning names each affected Project or file, not a count. A warning
   that applies to several Projects is printed once, with every Project
   listed.
4. Every next step is the exact command to run, with real arguments and quoted
   paths, on a Next line. Next lines are for the agent: it runs them for the
   user and tells the user, in plain words, what it can do next.
5. User-facing output says "agent", not "Host" (ADR-0051).
6. One run prints one report, and each fact appears once in it.
