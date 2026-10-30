---
name: apkit
description: Manage the user's Agent Profile Kit Workspace and install its Profiles (Skills and Context) into project folders for their coding agents. Use when the user wants to set up a Workspace, add or change Skills, Context, or Profiles, install a Profile into a project, update installed projects after a Workspace change, check what is installed, or remove an installation.
---

# Agent Profile Kit

The user keeps their Skills and Context in one **Workspace** folder and groups
them into **Profiles**. You do the authoring and conversation; the
`apkit-next` command does every install, update, and removal so that the
user's own edits are never lost. Never copy installed files by hand.

## Workspace format

```
workspace.yaml          # exactly: schema_version: 1
context/<id>.md         # Context Module; folders allowed (id: writing/voice)
skills/<dir>/SKILL.md   # Agent Skills package; `name` frontmatter is its id
profiles/<id>.yaml      # context: [ids]  skills: [names]  (both lists required)
```

Names are lowercase kebab-case. Edit these files directly with your file
tools, then run `apkit-next check` and fix anything it reports.

- **Context** is always-on guidance for every session in a project (for
  example communication style). Keep it short: agents load all of it.
- **Skills** are procedures loaded only when relevant (for example a release
  checklist). Prefer a Skill unless the guidance must apply all the time.

## Commands

All commands are non-interactive. Add `--json` when you need to parse results.

| Goal | Command |
|---|---|
| Create a Workspace | `apkit-next init <path>` |
| Select an existing Workspace | `apkit-next workspace <path>` |
| Validate and list Profiles | `apkit-next check` |
| Install into a folder | `apkit-next install <profile> [folder] --agents <ids>` |
| Apply Workspace edits everywhere | `apkit-next update --all` |
| See what is installed / out of date | `apkit-next status --all` |
| Uninstall from a folder | `apkit-next remove [folder]` |

Agent ids: `antigravity`, `claude`, `codex`, `grok`, `opencode`, `pi`. To
change a folder's agents or Profile, run `install` again with the new values.
`folder` defaults to the current directory.

## Decisions (exit code 3)

When a step needs the user's decision, `apkit-next` changes **nothing**,
prints the decisions, and exits with code 3. Explain each one to the user in
plain words, then re-run the same command:

- Add `--yes` only after the user agrees to the edits to `AGENTS.md` or
  `CLAUDE.md` (apkit adds one marked section to `AGENTS.md`, and one
  `@AGENTS.md` line to an existing `CLAUDE.md`).
- Add `--overwrite` only after the user explicitly agrees to discard the
  changed files it lists. Never pass `--overwrite` on your own judgment. If the
  user wants to keep a change, move it into the Workspace first, then update.

## After installing

Tell the user once that some agents load project instructions only in folders
they trust, so they should trust the folder when the agent asks. Agents pick
up the installed material in their next session.
