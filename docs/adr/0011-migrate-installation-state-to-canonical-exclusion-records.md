---
status: accepted
---

# Migrate Installation State to canonical Repository Exclusion Records

Repository Exclusion Records became the machine-local authority for Git
exclusion ownership in issue #77. The previous Installation State schema (v2)
stored only Installation Manifests, so an immediate v3-only reader would strand
every existing installation and would make a routine upgrade indistinguishable
from lost ownership state.

## Decision

The state boundary keeps an explicit reader for schema v2. When a v2 file is
ingested, the Installer performs a one-time migration using the recorded
project paths and the Git boundary that can be proven for those paths. It
synthesizes one canonical Repository Exclusion Record per target, with each
Manifest's generated outputs as that Installation ID's contribution. This
legacy topology lookup is confined to migration; schema-v3 preview, status,
apply, and uninstall consume stored Repository Exclusion Records and do not
reconstruct ownership from Manifests, ancestors, or Git topology.

Preview and status never publish the migration. The next successful apply or
uninstall writes schema v3, and a failed write remains retryable. A v2 reader
is therefore an expand step, while v3 is the canonical contract after the
first successful lifecycle operation.

## Consequences

Agent Profile Kit 0.24.x can read a 0.23.x Installation State file, but a
0.23.x engine cannot read a v3 file. Operators who may need to downgrade must
retain a copy of `~/.agents/agent-profile-kit/state/manifest.yaml` before the
first 0.24.x apply. The migrated file is disposable machine-local state; it
is not Workspace source and must not be hand-edited.

If the state file is missing or unrecoverably malformed, the Installer does not
adopt existing project output or an existing marked exclusion section. Restore
the state backup first. When no backup exists, stop the CLI, remove only the
known Installer-owned project outputs and Installation Markers after verifying
their paths, and remove only the marked block between `BEGIN Agent Profile Kit
generated paths` and `END Agent Profile Kit generated paths` in each affected
`.git/info/exclude`; preserve all unrelated bytes. Recreate the desired
bindings and run `apply` to establish fresh canonical records. This manual
recovery is intentionally fail-closed because ownership cannot be proven from
the surviving files alone.

### Amendment: retain the installation-time Git classification

An Installation Manifest may retain a `git_project` boolean set at the live
planning boundary. This is a classification fact, not a Repository Exclusion
Record target or entry, and it is used only to fail closed when a deleted Git
project's entire exclusion record is missing. Preview, status, apply, and
uninstall never reconstruct the missing target from ancestors or Git
worktree topology; a non-Git installation remains eligible for ordinary
intentional-deletion retirement when it has no exclusion record.
