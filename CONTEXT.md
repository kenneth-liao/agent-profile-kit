# Agent Profile Kit

Agent Profile Kit is the shared language for an agent-independent system of reusable agent material and context.

## Language

**Agent Profile Kit**:
The open-source tool and format that installs a Workspace's Profiles into folders for several Agent Hosts, at Verified Locations, while each maintained fact keeps one canonical home. Its command is `apkit`. It never prompts: a step that needs the user is a Decision.
_Avoid_: Monorepo, universal agent runtime

**Agent Profile Kit Workspace**:
The user's single canonical source of Profiles, Context, and Skills that Agent Profile Kit installs from. It holds plain files the user owns, and it may be a Git repository versioned apart from the tool. There is no default location: `init <path>` creates or completes a Workspace at the path the user gives and selects it, and `workspace <path>` selects an existing one. Local Configuration records the selection. The format is the Workspace contract (`apkit contract`).
_Avoid_: Open-source tool repository, Profile Installation, Host-global second source

**Workspace Manifest**:
The `apkit-workspace.yaml` file that marks a folder as a Workspace. It may be empty; a missing `schema_version` means version 1. A folder with only the older `workspace.yaml` is not a Workspace, and validation names the rename (ADR-0057).
_Avoid_: Installation Manifest, Profile

**Workspace Error**:
A validation finding that would make an install wrong or ambiguous. Any Workspace Error stops every `install` and `update` until it is fixed. A file that apkit skips is a warning instead: every warning is shown, and no warning stops an install (ADR-0057).
_Avoid_: Decision, Blocker

**Agent**:
The user-facing term for an Agent Host (ADR-0051). User-facing surfaces (the `--agents` flag, help output, the guide, and the README) say agent.
_Avoid_: Host (in user-facing surfaces), Agent Profile Kit implementation

**Agent Host**:
An agent product that consumes Agent Profile Kit material: Antigravity, Claude Code, Codex, Grok, OpenCode, or Pi. Contributor and architecture documentation uses this term for the external environment that apkit installs for (ADR-0051).
_Avoid_: Adapter, Agent Profile Kit implementation

**Verified Location**:
A project or user-level path where apkit writes a Host's Skills or Context, kept in one location table in the engine. Each one has a dated live check in which a marker reached a real session of that Host (ADR-0055, ISC-68). A Host is added with a table row and its live check. The live-check record is in `docs/ARCHITECTURE.md`.
_Avoid_: Adapter, Capability Contract, version probe

**Host Resolution**:
An Agent Host's native discovery, precedence, deduplication, and collision behavior across Agent Profile Kit output and other Host-visible material. Agent Profile Kit relies on this behavior rather than reproducing it (ADR-0012, ADR-0055).
_Avoid_: apkit-owned resolver, emulated Host inventory

**Profile Installation**:
One Workspace Profile installed for selected Agent Hosts into one folder: any folder, including a linked worktree. It is generated output with no authority apart from its Workspace source. There is one kind of installation; its Installation Manifest owns it, and `remove` deletes it with the empty folders the install created; a folder that was there before the install stays (ADR-0056).
_Avoid_: Canonical source, live link, Temporary Profile Installation, Project Binding

**User-Level Installation**:
A Profile Installation made with `install --global`: the Profile's Skills go in each Host's user-level Skills folder, and its Context goes in a Context Section of each Host's user-level instruction file. It follows the same consent, hash, and restore rules as a project install, and its Installation Manifest is `global.json` in the apkit home.
_Avoid_: Global apply, Host-global second source

**Installation Manifest**:
The record that owns one Profile Installation: `.agents/apkit.json` in the install folder, or `global.json` in the apkit home for the User-Level Installation. It records the Profile, the Hosts, a content hash of each file apkit wrote, the hash of each Context Section, and, for a project install, the folders the install created, which are the only folders removal deletes. apkit replaces or deletes only what still matches its hash; anything else is a Decision (ADR-0056).
_Avoid_: Installation Receipt, Installation State, Project Binding

**Context Section**:
The marked part of an instruction file that apkit owns: the `apkit` section in a project's `AGENTS.md`, and the `apkit:global` section in a user-level instruction file. When `CLAUDE.md` exists in a project and Claude Code is selected, `CLAUDE.md` gets one `@AGENTS.md` line instead of a section. Text outside the section or line belongs to the user, and an edit to these files needs consent (ADR-0055, ADR-0056).
_Avoid_: Generated instruction file, whole-file ownership

**Setup Note**:
The short marked note that `setup` adds to each installed Host's user-level instructions. It tells every session to run `apkit guide` before it changes Skills, Context, or Profiles, and it names only that command, so a newer guide never makes it stale. `setup --remove` restores each file.
_Avoid_: Host Setup Step, User-Level Installation

**Decision**:
A planned change that needs the user before apkit writes anything: an edit to a file the user owns, a write through a symlink that leads outside the folder, or taking over a file apkit did not write that already has the same content (allowed by `--yes`), or a file that apkit wrote and someone changed, or a file apkit did not write (replaced only with `--overwrite`). When a Decision is open, the location or Project that needs it is not changed; in a run over several, the others may already be done. The run lists every Decision and exits 3.
_Avoid_: Blocker, prompt, Output Ownership Conflict

**Repository Exclusion Contribution**:
The marked block in a repository's `.git/info/exclude` that keeps one install folder's Skill copies and Installation Manifest out of `git status`. Each install folder owns its own block, so subfolders and linked worktrees that share the exclude file do not overwrite each other. apkit never hides an instruction file; it says which ones it creates or changes and whether Git tracks them, and the user decides what to commit (ADR-0056).
_Avoid_: Shared `.gitignore`, hidden instruction file

**Local Configuration**:
The machine-local file `config.json` in the apkit home (`~/.agents/apkit`, or `APKIT_HOME`). It holds the selected Workspace, the list of installed folders that `--all` uses, the files that hold the Setup Note, the exclude file of each folder's block, and the old engine's changed files that `apkit migrate --yes` left to the user in each folder. What is installed in a folder is read from that folder's Installation Manifest, not from here. The released engine's `~/.agents/agent-profile-kit/config.yaml` and its receipts are input to `apkit migrate` only.
_Avoid_: Project Binding, canonical default, credential value, Profile

**Artifact ID**:
The stable identity of a canonical Agent Profile Kit artifact, unique within its artifact type and independent of its display name. A Skill's Agent Skills `name` is its Artifact ID; a Profile's Artifact ID is its file name under `profiles/` without `.yaml` or `.yml`; a Context Module's Artifact ID is its path under `context/` without `.md`, with `/` between folders. Two Context Module IDs that differ only in case are a Workspace Error.
_Avoid_: Display name, frontmatter-carried identity, organizational path (except a Context Module's path, which is its ID, and a Profile's file name, which is its ID)

**Credential Requirement**:
A semantic declaration that an artifact needs authenticated access, independent of how an Agent Host or system supplies it. Credential values never belong to Agent Profile Kit source, Local Configuration, or an Installation Manifest.
_Avoid_: Token, API key, host credential binding

**Skill**:
The canonical package for a reusable agent workflow, conforming to the portable subset of the Agent Skills open standard. A Skill contains `SKILL.md` and may include supporting scripts, references, and assets.
_Avoid_: Capability, command, hook

**Context**:
Always-loaded declarative facts, preferences, and standing rules selected by a Profile to shape behavior across workflows without prescribing a workflow themselves. Profile Context explicitly defers to repository-owned project instructions when they conflict.
_Avoid_: Skill, procedure

**Context Module**:
An independently reusable unit of Context organized around one reason to change. A Context Module is any Markdown file under `context/`, at any depth and with any `.md` file name; its ID is its path under `context/` without `.md` (ADR-0057). apkit reads no Context frontmatter: each file's bytes are delivered as written, in Profile order, inside the Context Section.
_Avoid_: Profile, generated host instructions, frontmatter-carried identity

**Skill Resource**:
A script, reference, or asset owned and used exclusively by one Skill.
_Avoid_: Tool

**External Capability**:
Functionality supplied by an Agent Host or the surrounding system that Agent Profile Kit material may require but does not own.
_Avoid_: Tool, Skill Resource

**Profile**:
An explicit named selection of Context and Skills suited to a kind of work and reusable across projects. A Profile's Artifact ID is its file name under `profiles/`, and the file holds only its `context` and `skills` lists. A missing list is empty, and `skills: all` selects every Skill in the Workspace; Context has no `all`, because Context is joined in list order (ADR-0057). `install <profile>` installs one Profile into a folder for the Hosts named with `--agents`.
_Avoid_: Agent, Agent Host, Profile Installation

**Activation**:
The event or entrypoint that starts a Skill during use. A user request, command, model selection, or hook can provide an Activation.
_Avoid_: Skill, installation, source update

**Command**:
An Agent Host-specific, user-facing entrypoint that explicitly activates a Skill. A Command does not own workflow instructions independently of the Skill it activates.
_Avoid_: Skill, canonical workflow

## Retired terms

These terms named parts of the released engine that ADR-0055 and ADR-0056 removed. Do not use them for the current engine. Each maps to its successor:

- **Adapter**, **Capability Contract**, **Host Bundle**: Verified Location.
- **Host Setup Step**: Setup Note for the user-level note; the install output's trust lines are presentation, not a domain record.
- **Project Binding**, **Temporary Profile Installation**: Profile Installation and the folder list in Local Configuration.
- **Installation Receipt**, **Installation State**, **Apply Receipt**: Installation Manifest.
- **Installer**: no named concept; the engine's planner is described in `docs/ARCHITECTURE.md`.
- **Blocker**, **Output Ownership Conflict**: Decision, or Workspace Error.
- **Primary Cause**: none; `status` reports each install's result.
