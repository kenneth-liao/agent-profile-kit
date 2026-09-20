---
status: accepted
---

# Remove the default Workspace location

## Context

ADR-0007 fixed the default Workspace path at `~/.agents/agent-profile-kit/workspace/`
and let zero-argument `init` create a Workspace there. In principal testing on
0.204.0 (#519 O1–O4), users learned where their Workspace went only from the
final receipt, and `init` created a hidden folder they never chose. Spec #593
(DEC-001) decided the user always chooses the Workspace location; ticket #601
removes the fixed default. ADR-0047 point 7 recorded the deferral of the two
already-connected legacy paths — legacy version-1 migration without `workspace`,
and zero-argument `init` selecting the conventional default — to this ticket,
including PR #617 review INT-1: the legacy migration path skipped directory
completion for a manifest-present folder.

## Decision

1. **No default Workspace location exists.** No command creates or selects a
   Workspace at a location the user did not give. The `workspacePath` helper
   and every conventional-default branch are removed, so no code path can name
   the former default (spec #593 DEC-001, ISC-23).
2. **Zero-argument `init` requires an already-selected Workspace.** On a
   machine with no selected Workspace — a fresh home, or a legacy version-1
   Local Configuration without a `workspace` value — zero-argument `init`
   refuses without upgrading or creating anything. A fresh home refuses
   before any write, including the application directories and the
   configuration lock; a legacy file refuses at the freshly-read source
   before the lock (the same rule re-checked on the re-read under the lock
   for the file-swap race). The refusal names the executable forms
   `apkit init <path>` and `apkit init .`. Interactive `init` without a path
   refuses minimally until interactive setup lands (#603). On a machine that
   already selects a Workspace, zero-argument `init` validates that
   selection and selects nothing new; connecting-again semantics remain
   #607's (DEC-002).
3. **Legacy version-1 Local Configuration is upgraded only to a path the user
   gives.** A legacy file with an authored `workspace` keeps that path, as
   before; an explicit request must resolve to the same canonical Workspace.
   A legacy file without `workspace` is never upgraded to a default: a
   zero-argument `init` refuses, and `init <path>` upgrades it to the given
   path, keeping its Project Bindings, comments, line endings, and file mode
   (spec #593 DEC-011, ticket #601). Migration guidance distinguishes the two:
   a file that already carries an authored `workspace` migrates with bare
   `apkit init`; one without names the explicit path form.
4. **The legacy upgrade is a first connection.** Because the upgrade reaches
   setup only with a user-given path, the folder's missing required parts are
   added in place like any explicit first connection — resolving the ADR-0047
   deferral and its INT-1 review note (a manifest-present folder receives its
   missing artifact directories). Already-connected folders never reach setup:
   a configured-machine `init` resolves the selected Workspace without the
   setup transaction.
5. **Rejection guidance names a runnable command.** Desired-state and
   binding-recording commands keep failing closed on legacy configuration; the
   guidance they print names `apkit init <path>` for a legacy file without
   `workspace` and bare `apkit init` for one with an authored path, so no
   printed remedy dead-ends in the zero-argument refusal.
6. **The bare-invocation screen states where setup puts the Workspace.** On a
   machine that is not set up (or a legacy file without `workspace`), bare
   `apkit` says the Workspace is a folder the user chooses, that the current
   directory matters only if chosen, and names `apkit init <path>` and
   `apkit init .` (US-001, ISC-22).

This supersedes ADR-0007's fixed-default sentence only. Ticket #607 (spec #593
DEC-002) supersedes ADR-0007's refusal to select a different Workspace: an
explicit `apkit init <workspace>` connects a different Workspace after
confirmation (or unconditionally with `--yes`), provisions any missing
required parts, updates Local Configuration while preserving all Project
Bindings, and reports missing Profile bindings.

## Consequences

- The application directory, Local Configuration, and Installation State stay
  where they are (OOS-005); only the Workspace default is removed.
- ADR-0047's point-7 deferral is resolved: no setup path selects a location
  the user did not give, and every destination that reaches the setup
  transaction is a first connection at a user-given path.
- Machines configured under earlier releases keep working: a configured
  zero-argument `init` revalidates the selected Workspace, whatever path it
  records.
