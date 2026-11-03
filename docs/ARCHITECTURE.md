# Agent Profile Kit Architecture

This document owns the living structural facts of the `apkit` engine. Terms
are defined in `CONTEXT.md`; decisions and their reasons are in `docs/adr/`;
the Workspace format is `docs/guides/workspace-contract.md`.

## Purpose

`apkit` installs a Workspace's Profiles into folders for several Agent Hosts.
It is a small command for an agent to drive:

- **No prompts.** A step that needs the user is a Decision: the run changes
  nothing, lists every Decision, and exits 3. The caller runs the command again
  with `--yes` or `--overwrite`.
- **Plain file writes only.** The engine starts no child processes (ISC-61)
  and has no code path that depends on the operating system (ISC-62). It reads
  Git's index file itself instead of running `git`.
- **Verified Locations, no Adapters.** One location table gives each Host's
  project and user-level paths. Each path has a dated live check (ADR-0055,
  [Verified Locations](#verified-locations)).
- **Host Resolution stays with the Host.** The engine relies on each Host's
  own discovery and never rebuilds a resolver or an inventory (ADR-0012).

## Components

| Path | Owns |
|---|---|
| `src/cli.ts` | Argument parsing, the command set, the lock around writing commands, human and `--json` output, exit codes |
| `src/command.ts` | The command name (`apkit`) used in every printed command |
| `src/guide.ts` | `apkit help`, `apkit guide`, and the bundled Workspace contract (`apkit contract`) |
| `src/workspace.ts` | Reading and validating a Workspace; `init` |
| `src/render.ts` | The Host table (project Skills folder and trust behavior), user-level Skills folders, and rendering a Profile into desired files and one Context body |
| `src/install.ts` | The planner and executor: Installation Manifest, Decisions, atomic writes, empty-folder pruning |
| `src/instructions.ts` | Pure text edits: the marked Context Section and the `@AGENTS.md` line in `CLAUDE.md` |
| `src/setup.ts` | User-level instruction files: the Setup Note and the User-Level Installation's Context Sections |
| `src/config.ts` | Local Configuration (`config.json`) and the path of `global.json` |
| `src/gitexclude.ts` | Repository Exclusion Contribution blocks in `.git/info/exclude` |
| `src/gitindex.ts` | Finding a folder's repository and reading whether Git tracks a path (index versions 2 to 4; split and sparse indexes are not read) |
| `src/lock.ts` | One lock per apkit home (ADR-0058) |
| `src/schema.ts` | Refusing a file written by a newer apkit |
| `build.ts` | The dependency-free Node bundle at `dist/cli.js` |
| `test/` | Engine and CLI journey suites; `test/retained/` holds earlier-release Workspaces (ISC-46) |

## Commands

`init`, `workspace`, `check`, `install`, `update`, `remove`, `status`, and
`setup`, plus `help`, `guide`, and `contract`. Flags: `--agents a,b`, `--yes`,
`--overwrite`, `--global`, `--all`, `--remove` (with `setup`), `--json`, and
`--workspace <path>` (one run only). `apkit migrate` moves an installation of
the released engine to this one; see [Migration from the released engine](#migration-from-the-released-engine).

Exit codes: `0` done, `1` error, `2` usage, `3` needs a Decision (nothing was
changed). With `--json`, each command prints one JSON value that is the
complete record of the operation; an error prints `{"error": "..."}`.

Every command except `help`, `guide`, and `contract` first reads Local
Configuration, so a configuration from a newer apkit stops it before anything
is written.

## Workspace ingestion

`loadWorkspace` reads the Workspace once per run into Profiles, Skills, and
Context Modules, plus two lists of findings: Workspace Errors and warnings
(ADR-0057). `install` and `update` stop on any Workspace Error; `check` reports
both lists; `workspace <path>` selects a Workspace even with errors and shows
them. The format and every rule it enforces are in
`docs/guides/workspace-contract.md`, which `guide.ts` bundles byte for byte.

`init <path>` creates the folder if needed and adds what is missing:
`apkit-workspace.yaml`, `context/`, `skills/`, and `profiles/`.

## Rendering

`render` turns one Profile and a set of Hosts into the desired state:

- **Skills.** Each selected Skill's files are copied under each distinct
  Skills folder of the selected Hosts. Project folders: `.claude/skills`
  (Claude Code), `.grok/skills` (Grok), and `.agents/skills` (Antigravity,
  Codex, OpenCode, Pi), so one copy serves every Host that shares a folder. For
  a Skill with `disable-model-invocation: true`, the copy in Codex's folder
  also gets `agents/openai.yaml` with `allow_implicit_invocation: false`,
  merged into the Skill's own file when it has one.
- **Context.** The selected Context Modules are joined in Profile order, each
  after a `<!-- context: <id> -->` line (the ID is encoded so it cannot end the
  comment), under a header that names the Profile. A project body says that
  the project's own instructions take precedence.

## Planning and ownership

Every write follows one rule: replace or delete only what apkit wrote and
nobody changed since. `plan` reads the disk and the previous Installation
Manifest and writes nothing. It returns operations, Decisions, the changes to
instruction files (create, change, or delete, and whether Git tracks each),
and the next manifest. `execute` runs only after every Decision is settled.

- **Installation Manifest.** `.agents/apkit.json` (schema 1) records the
  Profile, the Hosts, a hash of each written file, the hash of the Context
  Section, whether apkit created `AGENTS.md`, whether it added the `CLAUDE.md`
  line, and the installed Context Module IDs. Hashes ignore CRLF versus LF.
  Every field is checked when read, so planning never trusts a path or record
  it did not write.
- **Decisions.** `consent` (an edit to `AGENTS.md`, `CLAUDE.md`, or a
  user-level instruction file) and `outside` (a symlink would take a write or
  deletion outside the folder) are settled by `--yes`. `changed` (a file or
  section apkit wrote was changed) and `unowned` (a file apkit did not write is
  in the way) are settled by `--overwrite`.
- **Context Section.** Context goes in one marked `apkit` section of
  `AGENTS.md`, which every supported Host loads. When `CLAUDE.md` exists and
  Claude Code is selected, `CLAUDE.md` gets one `@AGENTS.md` line, because
  Claude Code reads `CLAUDE.md` instead of `AGENTS.md` when both exist. The
  section never goes in `CLAUDE.md`, because Grok loads both files. A symlinked
  instruction file is written through to its real file. Line endings follow the
  file, and each removal is the exact inverse of its insertion.
- **Writes.** Each file is written to a temp file and renamed into place,
  with short retries for Windows. The manifest is written last.
- **Removal.** Deleting a file prunes the folders it leaves empty, up to the
  install folder. Pruning stops at a link, so a Windows junction is never
  removed. If apkit created `AGENTS.md` and only its section was in it, the
  file is deleted.
- **Two installs in the home folder.** The home folder can hold a project
  install and the User-Level Installation at once. Each keeps its own manifest
  and never deletes a file the other also owns.

## User level

- **Setup Note** (`setup`). One marked note in each installed Host's
  user-level instruction file. A Host counts as installed when its user-level
  folder exists, unless `--agents` names Hosts. The files are listed under
  [Verified Locations](#verified-locations). Local Configuration records each
  file, its note hash, and whether apkit created the file and its folders, so
  `setup --remove` restores each file exactly.
- **User-Level Installation** (`install --global`). Skills go to each Host's
  user-level Skills folder. Context goes in an `apkit:global` section of the
  same files that hold the note, a section of its own so each is added and
  removed alone. A file that both use is deleted when the last section leaves
  it, if apkit created it. The manifest is `global.json` in the apkit home.
  Removal prunes empty folders up to each Host folder, never past it.
- **OpenCode** reads only the first of `~/.config/opencode/AGENTS.md` and
  `~/.claude/CLAUDE.md` that exists. When only `CLAUDE.md` exists, apkit writes
  there, because creating OpenCode's own file would hide the user's `CLAUDE.md`
  from OpenCode.
- **Symlinked user files.** User-level files are often symlinks into a dotfiles
  repository; apkit writes the real file.

## Local Configuration and `--all`

`config.json` in the apkit home (`~/.agents/apkit`, or `APKIT_HOME`) holds the
selected Workspace, the list of installed folders, the Setup Note records, and
the exclude file of each folder's block. `update --all` and `status --all`
visit every listed folder and then the User-Level Installation, if
`global.json` exists. A listed folder that no longer exists is forgotten by
`update` with its exclusion block, as `remove` would.

## Git

- **Exclusion.** In a Git repository, each install folder owns one block in
  the repository's `.git/info/exclude` (the common directory, so linked
  worktrees share it), between `# apkit:begin <folder>` and
  `# apkit:end <folder>`. It lists each installed Skill folder and the
  manifest, as literal patterns. Instruction files are never listed (ISC-87).
- **Tracking.** `gitindex.ts` finds the repository that holds a folder,
  including a linked worktree, and reads path names from its index, so each
  Decision about an instruction file says whether Git tracks it.

## Concurrency

`init`, `workspace`, `install`, `update`, `remove`, and `setup` hold
`<APKIT_HOME>/lock` from their first read to their last write, so runs that
write take turns and each plans against the disk as the previous run left it.
`status`, `check`, `guide`, `contract`, and `help` do not take it. The lock is
taken with an atomic `link`, a stopped owner's lock is taken over, and a run
waits at most 120 seconds (ADR-0058).

## Schema versions

`config.json` and every Installation Manifest carry a schema number
(`src/schema.ts`). An apkit that finds a newer number stops, changes nothing,
and names the update. A newer `schema_version` in `apkit-workspace.yaml` is a
Workspace Error that names the update.

## Migration from the released engine

The released engine (0.238.0 and earlier) kept Local Configuration in
`~/.agents/agent-profile-kit/config.yaml` and receipts in
`state/manifest.json` there. `apkit migrate` reads them, takes over each
recorded Project without losing the user's edits, and installs the same
Profile and agents with this engine; other commands name `apkit migrate` while
that state is not migrated. Once no recorded Project needs a decision or
failed, `migrate` renames the folder to `~/.agents/agent-profile-kit.migrated`
and keeps it, unchanged, as a backup; it never replaces an existing backup.

## Verified Locations

The location table is in `src/render.ts` (project and user-level Skills
folders) and `src/setup.ts` (user-level instruction files). This section is
the dated live-check record for every location in it (ADR-0055, ISC-68). Check
a Host again when it changes how it loads files (ISC-69), and update the date
here.

### Project-level locations

Verified 2026-10-30 in one Git project installed for all six agents. Each
agent, with no tools, quoted both Context markers from the `AGENTS.md` section
and named the marker Skill. A Skill with `disable-model-invocation: true` was
hidden every time.

| Agent | Context | Skills | Evidence |
|---|---|---|---|
| Claude Code | `AGENTS.md` through the `@AGENTS.md` line in `CLAUDE.md` | `.claude/skills` | `claude -p` |
| Antigravity | `AGENTS.md`, in a trusted project | `.agents/skills`, in a trusted project | `agy -p`, and the interactive app after trust |
| Codex | `AGENTS.md`, also in an untrusted project | `.agents/skills`, in a trusted project only | `codex exec` |
| Grok | `AGENTS.md`, in a trusted project only | `.grok/skills`, in a trusted project only | interactive `grok` session |
| OpenCode | `AGENTS.md` | `.agents/skills` | `opencode run` (v2.2.4, `opencode/deepseek-v4.1-flash`) |
| Pi | `AGENTS.md`, also in an untrusted project | `.agents/skills`, in a trusted project only | `pi -p` and `pi -p --approve` (1.4.0) |

The trust column is the source of the `untilTrusted` values in `src/render.ts`
and of the trust lines that `install` prints.

### User-level instruction files

Used by `setup` and `install --global`. Verified 2026-10-30:

| Agent | File | Evidence |
|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR` or `~/.claude`, `CLAUDE.md` | Marker reached the model request |
| Codex | `$CODEX_HOME` or `~/.codex`, `AGENTS.override.md` if present, else `AGENTS.md` | Marker reached the model request |
| OpenCode | `~/.config/opencode/AGENTS.md`, else `~/.claude/CLAUDE.md` (first that exists) | Marker reached the model request, in both orders |
| Pi | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, `AGENTS.md` | Marker reached the model request |
| Grok | `$GROK_HOME` or `~/.grok`, `rules/*.md` (loaded without folder trust) | `grok -p` quoted the marker, in an untrusted folder |
| Antigravity | `~/.gemini/AGENTS.md` or `GEMINI.md` | Live session quoted the marker |

### User-level Skills folders

Used by `install --global`. Verified 2026-10-30:

| Agent | Folder | Evidence |
|---|---|---|
| Claude Code | `~/.claude/skills` | Marker Skill reached the model request |
| Codex | `~/.agents/skills` (also reads `$CODEX_HOME/skills`) | Marker Skill reached the model request |
| OpenCode | `~/.agents/skills` (also `~/.claude/skills`, `~/.config/opencode/skills`) | `opencode debug skill` listed it |
| Pi | `~/.agents/skills` (also `~/.pi/agent/skills`) | Marker Skill reached the model request |
| Grok | `~/.grok/skills` (also `~/.claude/skills`) | `grok -p` named the marker Skill, in an untrusted folder |
| Antigravity | `~/.gemini/config/skills` | Live session listed the marker Skill |

`install --global` was checked live on 2026-10-30 with a Profile holding one
marker Context and one marker Skill, installed for all six agents. In an
untrusted folder with no project instructions, each agent quoted the Context
marker and named the marker Skill without tools: `claude -p` (2.1.314),
`codex exec` (0.164.0), `opencode run` (2.2.4), `pi -p` (1.4.0), `grok -p`
(1.0.70), and `agy -p` (1.4.12). `remove --global` then restored every file.

Grok also reads `~/.claude/CLAUDE.md` by default, so it may see the Setup Note
twice; that is harmless.

### Known gaps

The code writes these locations, but the record above does not show a live
check for them as written (ISC-68):

- **Pi:** `setup.ts` writes `AGENTS.override.md` when it exists in the Pi
  folder; the Pi row names only `AGENTS.md`.
- **Antigravity:** `setup.ts` writes `~/.gemini/AGENTS.md` only; the row also
  names `GEMINI.md`, which apkit never writes.
- **OpenCode:** `setup.ts` uses `$XDG_CONFIG_HOME/opencode` when that variable
  is set; the row names `~/.config/opencode` only.
- **Grok:** `setup.ts` writes `rules/apkit.md`, which the row covers as
  `rules/*.md`.
- **Claude Code and Grok Skills:** `render.ts` follows `$CLAUDE_CONFIG_DIR` and
  `$GROK_HOME` for user-level Skills; the rows name only `~/.claude/skills` and
  `~/.grok/skills`.

## Qualification

Root `bun test` runs every suite; CI runs it on macOS, Linux, and Windows and
runs the CLI journeys on Node against the built bundle. Fixture homes isolate
journeys from real user and Host state. The commands and evidence rules are in
`AGENTS.md` (Verification), and the decision is ADR-0059.
