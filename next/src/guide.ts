// The usage guide is built into the command, so an agent learns apkit by
// running `apkit-next guide`; nothing has to be installed first, and the guide
// always matches the installed version.
import { COMMAND } from "./command.js";
import { AGENTS } from "./render.js";

export { COMMAND };

export const HELP = `${COMMAND} — install Workspace Profiles into folders for your agents

Agents: run \`${COMMAND} guide\` first. It explains everything below.

Usage:
  ${COMMAND} guide                            The complete guide for agents and people
  ${COMMAND} init <path>                      Create (or complete) a Workspace and select it
  ${COMMAND} workspace [<path>]               Show or select the Workspace
  ${COMMAND} setup [--agents <a,b>] [--remove]
                                              Add (or remove) a short apkit note in each agent's user instructions
  ${COMMAND} check                            Validate the Workspace and list what it holds
  ${COMMAND} install <profile> [folder] --agents <a,b>
                                              Install a Profile (folder defaults to the current one)
  ${COMMAND} install <profile> --global --agents <a,b>
                                              Install a Skills-only Profile for every project (user level)
  ${COMMAND} update [folder | --all]          Re-install from the current Workspace
  ${COMMAND} remove [folder | --global]       Remove everything apkit installed there
  ${COMMAND} status [folder | --all]          Show what is installed and what is out of date

Options:
  --yes               Allow edits to instruction files the user owns (AGENTS.md, CLAUDE.md, ...)
                      and writes through a symlink that leads outside the folder
  --remove            With setup: remove the note from every agent
  --global            Install or remove at the user level instead of a project
  --overwrite         Replace or delete files that were changed or not written by apkit
  --json              Machine-readable output
  --workspace <path>  Use this Workspace for one command

Agents: ${Object.keys(AGENTS).join(", ")}
Exit codes: 0 done, 1 error, 2 usage, 3 needs a decision (nothing was changed)
`;

export const GUIDE = `# Agent Profile Kit guide

The user keeps their Skills and Context in one Workspace folder and groups
them into Profiles. ${COMMAND} installs a Profile into any project folder for
the user's coding agents, keeps installs up to date, and removes them. If you
are an agent: you do the authoring and the conversation; ${COMMAND} does every
install, update, and removal so that the user's own edits are never lost.
Never copy or edit installed files by hand.

## Workspace format

    apkit-workspace.yaml    marks the Workspace; may be empty
    context/<id>.md         a Context Module; folders allowed (id: writing/voice)
    skills/<dir>/SKILL.md   an Agent Skills package; its \`name\` is its id
    profiles/<id>.yaml      context: [ids] and skills: [names] or all; .yml is fine

A missing list is empty. \`skills: all\` selects every Skill, including ones
added later; Context has no \`all\`, because it is joined in list order.
A Context file may have any .md name, so a copied CLAUDE.md is valid as it
is; two Context IDs must not differ only in case. Skill and Profile names are
lowercase kebab-case. Edit these files directly, then run
\`${COMMAND} check\` and fix anything it reports.

- Context is always-on guidance for every session in a project, such as a
  communication style. Keep it short: agents load all of it, every session.
- Skills are procedures an agent loads only when relevant, such as a release
  checklist. Prefer a Skill unless the guidance must apply all the time.

## Commands

All commands are non-interactive. Add --json when you need to parse results.

- Create a Workspace:                \`${COMMAND} init <path>\`
- Select an existing Workspace:      \`${COMMAND} workspace <path>\`
- Tell the user's agents about apkit: \`${COMMAND} setup\`
- Validate and list Profiles:        \`${COMMAND} check\`
- Install into a folder:             \`${COMMAND} install <profile> [folder] --agents <ids>\`
- Install Skills for every project:  \`${COMMAND} install <profile> --global --agents <ids>\`
- Apply Workspace edits everywhere:  \`${COMMAND} update --all\`
- See what is installed or stale:    \`${COMMAND} status --all\`
- Uninstall from a folder:           \`${COMMAND} remove [folder]\`

Agent ids: ${Object.keys(AGENTS).join(", ")}. To change a folder's agents or
Profile, run install again with the new values. The folder defaults to the
current directory.

## First-time setup

1. Ask the user where to keep their Workspace. It is their own folder, so
   never choose it for them. You may suggest a name such as ~/agent-workspace.
   If they already have a Workspace, ask for its path instead.
2. Run \`${COMMAND} init <path>\` for a new Workspace, or
   \`${COMMAND} workspace <path>\` to select an existing one.
3. Run \`${COMMAND} setup\`. It finds the user's installed agents and adds a
   two-line note to each agent's user-level instructions, so future sessions
   know to run \`${COMMAND} guide\` before changing Skills, Context, or
   Profiles. Like any edit to the user's instruction files, it asks for a
   decision first. \`--agents\` limits it to some agents; \`setup --remove\`
   takes the note back out.

Then move the user's material into the Workspace and install a Profile.

## What gets installed

- Skills are copied to each agent's own Skills folder in the project.
- Context goes into one marked section in AGENTS.md, which every supported
  agent reads. If CLAUDE.md exists and Claude Code is selected, CLAUDE.md gets
  one \`@AGENTS.md\` line. Everything else in both files is left as it is.
- In a Git repository, the installed files are listed in .git/info/exclude
  so they stay out of \`git status\` and are never committed by accident.
- \`install --global\` puts a Skills-only Profile in each agent's user-level
  Skills folder, so the Skills are available in every project. Context is
  always installed per project, so --global refuses a Profile with Context.

## Decisions (exit code 3)

When a step needs the user's decision, ${COMMAND} changes nothing, prints the
decisions, and exits with code 3. Explain each one to the user in plain words,
then re-run the same command:

- Add --yes only after the user agrees to the listed edits to their
  instruction files (AGENTS.md, CLAUDE.md, or an agent's user-level file),
  and to any listed writes through a symlink that leads outside the folder.
  Name the link and where it leads.
- Add --overwrite only after the user explicitly agrees to discard the changed
  files it lists. Never pass --overwrite on your own judgment. If the user
  wants to keep a change, move it into the Workspace first, then update.

## After installing

${COMMAND} names each selected agent that does not load what it installed
until the user trusts the folder. Pass those lines on to the user.
Agents pick up installed material in their next session.
`;
