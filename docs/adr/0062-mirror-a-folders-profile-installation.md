---
status: accepted
---

# Mirror a folder's Profile Installation

Accepted 2026-11-15 with the ISA decision of that date (ISC-96 to ISC-104).
It takes effect with the release that ships the command.

## Context

An orchestrator makes a disposable linked worktree for each worker. The worker
needs the Skills that the orchestrator's own checkout has.

ADR-0056 gives every folder the same installation, taken from the Workspace.
For a worker worktree that has two faults:

- The Workspace can be newer than the checkout's installation. The worker then
  runs other Skill versions than the orchestrator in the same run.
- The worktree's tracked `AGENTS.md` holds the Context Section its branch
  committed. When that differs from the Workspace, `install` stops for a
  Decision, and its next step changes a tracked file that a worker can commit.

Orchestrators worked around this with symbolic links to the checkout's Skill
folders, found by reading apkit's Repository Exclusion Contribution. A change
of that block's marks broke the links without a message.

## Decision

1. **A second kind of installation, the Mirrored Installation.** One command
   gives a folder the installed files of a named folder: the same Profile,
   every Host, and the same bytes (ISC-96). Its source is the named folder's
   Profile Installation, not the Workspace.
2. **Copies of Skills only.** It writes no instruction file and changes no
   tracked file (ISC-97). It makes no symbolic link (ISC-98).
3. **The caller names the folder to mirror.** apkit does not find a main
   checkout, and it creates no worktree. The engine still starts no program
   and has no Git dependency (ISC-61).
4. **Owned by the folder alone.** The folder's Installation Manifest records
   that it is a mirror and of which folder. Local Configuration does not list
   it, so `--all` never sees it (ISC-101) and nothing outlives the folder
   (ISC-100).
5. **A snapshot.** A mirror does not follow the named folder. Running the
   command again brings it level (ISC-102). `install` and `update` in a
   mirrored folder are a Decision (ISC-103).

## Considered Options

- **A Profile Installation in each worktree (ADR-0056 as it is).** Rejected:
  the two faults in Context.
- **Symbolic links to the named folder's installation.** Rejected: they need
  special rights on Windows (ISC-59), and a pattern that ends in `/` does not
  match a link, so the links show in `git status`.
- **A command that only lists the installed paths**, for a script to link or
  copy. Rejected: the copying stays outside apkit, which is the hand copy the
  destination ends.
- **One kind of installation with a source flag.** Rejected: the mirror
  differs in its source, in `--all`, and in what outlives it. A name says
  that more plainly than a flag.

## Consequences

- Amends ADR-0056 point 3. `CONTEXT.md` gains the Mirrored Installation term.
- The Installation Manifest format gains the mirror's source folder.
- Two points are open in the ISA's Not yet specified: a named folder with
  installations in its subfolders, and a mirror in a repository other than
  the named folder's.
