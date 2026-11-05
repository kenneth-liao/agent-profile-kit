---
status: accepted
---

# Migrate the released engine's installations with one command

Took effect at the agent-first cutover (0.239.0, spec #728).

## Context

Users have Projects that the released engine (0.238.0 and earlier) installed.
Those Projects hold its Context files, its Codex hook, its OpenCode
configuration, and its Skill copies. The cutover deletes that engine from the
repository, so it is no longer there to uninstall them. If the new engine
installs beside them, every agent gets the Context twice, and the old copy
stops being updated.

## Decision

1. **One command, `apkit migrate`.** It reads the released engine's Local
   Configuration (`~/.agents/agent-profile-kit/config.yaml`) and its receipts
   (`state/manifest.json`). For each recorded Project, it deletes each recorded
   output that still matches its hash, removes the old block from
   `.git/info/exclude`, deletes a folder only when nothing but apkit's output
   was in it, and installs the same Profile and agents with this engine.
2. **A changed old output is a Decision.** The Decision names the part apkit
   added. `--overwrite` deletes the file. `--yes` keeps it as the user's own,
   and Local Configuration records that, so a later run does not ask again.
   `--yes` cannot keep a changed file at a path where this engine installs its
   own copy: `--overwrite`, or moving the changes out, settles it.
3. **The same Workspace stays selected.** It is validated only when a Project
   installs its Profile again. `migrate --workspace <path>` uses another
   Workspace. A Workspace with only the old `workspace.yaml` marker is a
   Decision to rename it (ADR-0057).
4. **A missing Project folder is reported and skipped.**
5. **The old state is kept as a backup.** When no recorded Project needs a
   Decision or failed, `migrate` renames the old folder to
   `~/.agents/agent-profile-kit.migrated`. It never replaces an existing
   backup.
6. **Every other command names `apkit migrate`** while the old state folder
   exists. Human output ends with the notice, and each `--json` value carries
   a `migration` field.
7. **Host trust is left alone.** Approvals that the user gave the old Codex
   hook are not changed, because apkit never writes Host trust.
8. **Tested against real output.** Because the old engine is deleted, the
   journeys run against what the published 0.238.0 package wrote
   (`test/migration/`).

## Considered Options

- **Keep the old engine in the package to uninstall its own output.**
  Rejected: it keeps a second engine and its test machinery.
- **Leave old installs for the user to remove by hand.** Rejected: every agent
  would load the Context twice, and a user who edited an old file could lose
  the edit.

## Consequences

- The released engine's `config.yaml` is input to `migrate` only. This
  supersedes the legacy-configuration parts of ADR-0049 §2 to §5. Its rule
  that `init` in a fresh home writes nothing without a path still stands.
- Removing `migrate` later is a separate decision.
