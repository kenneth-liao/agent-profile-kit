// The usage guide is built into the command, so an agent learns apkit by
// running `apkit guide`; nothing has to be installed first, and the guide
// always matches the installed version.
import CONTRACT from "../docs/guides/workspace-contract.md" with { type: "text" };
import { nextCommand } from "./output.js";
import { COMMAND } from "./command.js";
import { AGENTS } from "./render.js";

export { COMMAND };

/** The Workspace contract, bundled as written: the one home for the format's rules. */
export { CONTRACT };

/** Where failed validation sends the reader. */
export const CONTRACT_POINTER = nextCommand(["contract"]);

/** Short first-use explanation, shared by the introductory human surfaces. */
export const INTRODUCTION = `Workspace: your source folder for Context and Skills.
Profile: a named selection of Context and Skills to install.
Context: guidance your agents load for every session.`;

export const HELP = `${COMMAND} — install Workspace Profiles into folders for your agents

Agents: run \`${COMMAND} guide\` first. It explains everything below.

Usage:
  ${COMMAND} guide                            The complete guide for agents and people
  ${COMMAND} contract                         The Workspace contract: every format rule
  ${COMMAND} init <path>                      Create (or complete) a Workspace and select it
  ${COMMAND} workspace [<path>]               Show or select the Workspace
  ${COMMAND} setup [--agents <a,b>] [--remove]
                                         Add (or remove) a short apkit note in each agent's user instructions
  ${COMMAND} check                            Validate the Workspace and list what it holds
  ${COMMAND} install <profile> [folder] --agents <a,b>
                                         Install a Profile (folder defaults to the current one)
  ${COMMAND} install <profile> --global --agents <a,b>
                                         Install a Profile for every project (user level)
  ${COMMAND} update [folder | --all]          Re-install from the current Workspace
  ${COMMAND} remove [folder | --global]       Remove everything apkit installed there
  ${COMMAND} status [folder | --all | --global]
                                         Show what is installed and what is out of date
  ${COMMAND} migrate                          Move each Project the old apkit (0.238 or earlier)
                                         installed to this one

Options:
  --agents <a,b>      The agents to install for, or to give the setup note (comma-separated)
  --all               With update or status: every installed folder and the user-level install
  --yes               Allow edits to instruction files the user owns (AGENTS.md, CLAUDE.md, ...),
                      writes through a symlink that leads outside the folder, and taking over
                      a file apkit did not write that has the same content (remove then deletes it).
                      With migrate: also keep each file the old apkit wrote and the user changed
  --remove            With setup: remove the note from every agent
  --global            Install or remove at the user level instead of a project
  --overwrite         Replace or delete files that were changed or not written by apkit
  --json              Machine-readable output (not with help, guide, or contract)
  --workspace <path>  Use this Workspace for one command
                      With migrate: use it instead of the Workspace the old apkit named

Agents: ${Object.keys(AGENTS).join(", ")}
Exit codes: 0 done, 1 error, 2 usage, 3 needs a decision (what needs it was not changed)
`;

export const GUIDE = `# Agent Profile Kit guide

${INTRODUCTION}

The user keeps their Skills and Context in one Workspace folder and groups
them into Profiles. ${COMMAND} installs a Profile into any project folder for
the user's coding agents, keeps installs up to date, and removes them. If you
are an agent: you do the authoring and the conversation; ${COMMAND} does every
install, update, and removal so that the user's own edits are never lost.
Never copy or edit installed files by hand. Work on the user's behalf: run
${COMMAND} yourself and tell the user, in plain words, what happened and what
you can do for them. The user does not need to learn its commands unless they
ask.

## Workspace format

    apkit-workspace.yaml    marks the Workspace; may be empty
    context/<id>.md         a Context Module; any .md name (id: writing/voice)
    skills/<dir>/SKILL.md   an Agent Skills package; its \`name\` is its id
    profiles/<id>.yaml      context: [ids] and skills: [names] or all

The Workspace contract states every rule, with examples. Read it with
\`${COMMAND} contract\` before you author or repair a Workspace. Edit these
files directly, then run \`${COMMAND} check\`. Fix every error it reports:
errors block installs. Warnings name files apkit skips; they never block an
install.

- Context is always-on guidance for every session in a project, such as a
  communication style. Keep it short: agents load all of it, every session.
- Skills are procedures an agent loads only when relevant, such as a release
  checklist. Prefer a Skill unless the guidance must apply all the time.

## Commands

All commands are non-interactive. Add --json when you need to parse results;
help, guide, and contract still print text. Run \`${COMMAND} help\` or add
--help to any command for usage. On check, install, update, status, or migrate,
--workspace <path> uses that Workspace for one command without changing the
selected Workspace.

- Read this guide:                   \`${COMMAND} guide\`
- Read the Workspace contract:       \`${COMMAND} contract\`
- Create a Workspace:                \`${COMMAND} init <path>\`
- Select an existing Workspace:      \`${COMMAND} workspace <path>\`
- Tell the user's agents about apkit: \`${COMMAND} setup\`
- Validate and list Profiles:        \`${COMMAND} check\`
- Install into a folder:             \`${COMMAND} install <profile> [folder] --agents <ids>\`
- Install for every project:         \`${COMMAND} install <profile> --global --agents <ids>\`
- Apply Workspace edits everywhere:  \`${COMMAND} update --all\`
- See what is installed or stale:    \`${COMMAND} status --all\`
- Uninstall from a folder:           \`${COMMAND} remove [folder]\`
- Move installs from the old apkit:  \`${COMMAND} migrate\`

Agent ids: ${Object.keys(AGENTS).join(", ")}. To change a folder's agents or
Profile, run \`${COMMAND} install <profile> <folder> --agents <ids>\` with the
new values. The folder defaults to the current directory.

## First-time setup

Do these steps once, before any install.

1. Ask the user where to keep their Workspace. It is their own folder, so
   never choose it for them. You may suggest a name such as ~/agent-workspace.
   If they already have a Workspace, ask for its path instead.
2. Run \`${COMMAND} init <path>\` for a new Workspace, or
   \`${COMMAND} workspace <path>\` to select an existing one. ${COMMAND}
   remembers the selected Workspace, so later commands need no --workspace.
   A Workspace with problems is selected too: \`${COMMAND} workspace\` lists
   them, and installs and updates wait until they are fixed. It also names
   each install whose Profile the Workspace lacks.
3. Run \`${COMMAND} setup\`. It finds the user's installed agents and adds a
   two-line note to each agent's user-level instructions, so future sessions
   know to run \`${COMMAND} guide\` before changing Skills, Context, or
   Profiles. Like any edit to the user's instruction files, it asks for a
   decision first. \`--agents\` limits it to some agents; \`setup --remove\`
   takes the note back out.

Only after setup, bring in the user's existing material and install a Profile.

## Bring in the user's existing material

Most users already have Skills and instructions spread across their agents and
projects. After setup, offer to gather them into the Workspace:

1. Look where agents keep them: each agent's user-level Skills folder and
   user-level instruction file (the files \`${COMMAND} setup\` named), and the
   projects the user names (their AGENTS.md, CLAUDE.md, and agent Skills
   folders). Skip what ${COMMAND} installed: a Skill whose name the Workspace
   already has, and each section of an instruction file between an
   \`<!-- apkit:...begin -->\` line and its end line.
2. Show the user what you found, by path: Skills, and guidance that could
   become Context Modules. Ask which to bring in.
3. Copy each one they choose into the Workspace: a Skill folder to
   skills/<dir>/, and guidance for many projects to context/<id>.md. Leave
   guidance for one project in that project. Do not delete or change the
   originals.
4. Run \`${COMMAND} check\` and fix what it reports. Then propose a Profile
   that groups the material, and write it after the user agrees.
5. Where an original lies at a path that ${COMMAND} installs to (such as a
   Skill folder), installing is a decision: ${COMMAND} then manages that path,
   and a later remove deletes it.

## What gets installed

- Skills are copied to each agent's own Skills folder in the project.
- Context goes into one marked section in AGENTS.md, which every supported
  agent reads. If CLAUDE.md exists and Claude Code is selected, CLAUDE.md gets
  one \`@AGENTS.md\` line. Everything else in both files is left as it is.
- In a Git repository (at its root, in a subfolder, or in a linked worktree),
  the copied Skills and apkit's manifest are listed in the repository's
  .git/info/exclude so they stay out of \`git status\` and are never committed
  by accident. Instruction files are never hidden.
- \`install --global\` installs a Profile for every project: Skills go in each
  agent's user-level Skills folder, and Context goes in a marked section of
  each agent's user-level instruction file (the files setup uses). It never
  creates a file that would hide one the agent already reads, and
  \`remove --global\` restores each file exactly. It is kept apart from any
  install in the home folder itself; \`update --all\` and \`status --all\` include it.

## Decisions (exit code 3)

When a step needs the user's decision, ${COMMAND} does not change the folder or
Project that needs it, prints the decisions, and exits with code 3. With several
folders or Projects in one run, the others may already be done. Explain each one to the user in plain words.
The Next line gives the complete command to run after the user agrees.
Next lines are for you to run, not for the user to type.

- For each listed instruction file (AGENTS.md, CLAUDE.md, or an agent's
  user-level file), tell the user whether it will be created, changed, or
  deleted, and whether Git tracks it. A change to a tracked file shows up in
  the user's next commit. For each listed write through a symlink that leads
  outside the folder, name the link and where it leads. For each file
  ${COMMAND} would take over, tell the user that a later remove deletes it.
  Add --yes only after the user agrees.
- Add --overwrite only after the user explicitly agrees to discard the files
  it lists: files that were changed, or that ${COMMAND} did not write. Never pass --overwrite on your own judgment. If the user
  wants to keep a change, move it into the Workspace first, then update.

## After installing

${COMMAND} names each selected agent that does not load what it installed
until the user trusts the folder. Pass those lines on to the user.
Agents pick up installed material in their next session.
Committing is the user's decision: never stage, commit, or push installed
files or instruction-file changes unless the user asks.

## When you finish

End with a short summary in plain words, not a list of every file and step:

- What changed: set up, installed, updated, or removed. Name each Project by
  its path, even when Projects have the same folder name.
- Each warning once, with every affected Project or file listed by path.
- Each instruction file created or changed in a Git repository, whether Git
  tracks it, and that committing it is the user's call.
- Every line ${COMMAND} printed about trusting a folder, and that agents pick
  up changes in their next session.
- In one or two sentences, how it works: the Workspace holds the user's
  Context Modules and Skills, a Profile selects some of them, and ${COMMAND}
  installs a Profile into a project, or for every project, and keeps it up
  to date.
- In plain words, what you can do for them next, as offers: bring in Skills
  and instructions they already have elsewhere, create or change a Profile,
  install a Profile into another project or for every project, and update
  every install after they edit the Workspace.

Do not give the user commands to run, and leave ${COMMAND}'s Next lines out
of the summary: you run ${COMMAND} for them. Give a command, other paths, or
details only if the user asks.
`;
