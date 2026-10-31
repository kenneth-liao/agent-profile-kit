---
status: accepted
---

# Let each folder own its Profile Installation

Takes effect at cutover to the engine in `next/`. Until then, ADR-0010,
ADR-0015, and ADR-0052 stay in force for the current engine.

## Context

ADR-0010 ties each Profile Installation to a Project Binding and a global
reconciliation. It owns whole files only and writes nothing outside the
Project. ADR-0015 and ADR-0052 add Temporary Profile Installations as a
separate exception for disposable worktrees. The 2026-10-30 ISA decision folds
that exception into every install (ISC-50 to ISC-58). It also brings `setup`
and `install --global` into scope (ISC-70 to ISC-73), and both write to
user-level Host folders.

## Decision

1. **A manifest in each folder owns its installation.** `.agents/apkit.json`
   in the install folder records the Profile, the Hosts, and a content hash of
   each file that apkit wrote. apkit replaces or deletes only files that still
   match their hash. Anything else needs an explicit decision (ISC-9, ISC-65).
2. **A folder list replaces Project Bindings.** Machine configuration holds the
   selected Workspace and a list of installed folders, used only by `--all`.
   What is installed in a folder is read from that folder's manifest.
3. **One kind of installation.** Any folder, including a linked worktree, gets
   the same installation. There is no separate temporary lifetime, receipt, or
   command family. Removal deletes the folders that the install created when
   they are empty (ISC-53).
4. **A marked section in shared instruction files.** apkit owns one marked
   section in `AGENTS.md`, and one `@AGENTS.md` line in `CLAUDE.md`. Text
   outside them is the user's (ISC-75). Edits to these files need the user's
   consent.
5. **User-level writes are allowed.** `setup` adds a short note, and
   `install --global` installs a Profile's Skills and Context, in each Host's
   user-level folders. They follow the same consent, hash, and restore rules
   (ISC-71, ISC-72).
6. **Git exclusion in `.git/info/exclude`.** In a Git repository, installed
   files go in a marked block for each folder, so they stay out of
   `git status` (ISC-55).

## Considered Options

- **Keep Temporary Profile Installation as a separate concept.** Rejected: it
  existed to avoid Project Bindings and global reconciliation, and this design
  has neither.
- **Own only whole files.** Rejected: every Host reads `AGENTS.md`, so Context
  delivery through one shared file needs a section inside it (ADR-0055).

## Consequences

- At cutover, the Project Binding, Temporary Profile Installation, and
  Installation Receipt terms in `CONTEXT.md` change. Installations made by the
  current engine must be taken over or removed without loss (ISC-66, ISC-67).
- No lock guards the folder list. ISC-58 checks that concurrent installs are
  all still recorded.
- Supersedes ADR-0010, ADR-0015, and ADR-0052 at cutover.
- *Amended 2026-10-30:* §6 hides installed Skill copies and the manifest only. apkit never hides `AGENTS.md` or `CLAUDE.md`, even when it creates them. It says which instruction files it creates or changes and whether Git tracks them, and the user decides what to commit (ISC-55, ISC-86, ISC-87).
- *Amended 2026-10-30:* ADR-0058 supersedes "No lock guards the folder list". One lock now serializes every run that writes, so the folder list and each manifest change one run at a time.
