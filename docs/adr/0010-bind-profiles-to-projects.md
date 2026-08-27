---
status: accepted
---

# Bind Profiles to projects and use native Host loading

Agent Profile Kit keeps Profiles portable in the user Workspace, while each machine-local Project Binding selects one Profile and a set of Agent Hosts for exactly one explicit project directory root. An explicit global reconciliation installs a disposable snapshot into whole files and directories that Agent Profile Kit exclusively owns inside each project; the Hosts then load that material through their normal project discovery alongside untouched global and repository-owned configuration. This replaces per-session launch overlays and deliberately gives up simultaneous Profiles in one project in exchange for a smaller runtime-free system, native reliability, and no Host-global writes.

## Consequences

Adapters plan exact project outputs but never write them. The Installer normalizes their combined output set, coalesces byte-identical shared paths, rejects conflicts or unowned destinations, and records one Profile Installation per project. A canonical project root may appear in only one binding. Project paths must be absolute or home-relative, resolve to existing directories, and cannot contain wildcards; there are no implicit directory scans. A non-Git project must launch Codex from its exact bound root for native discovery to be guaranteed. Existing worktrees of a bound Git repository reconcile during `apply`; a worktree created later requires another explicit `apply` before it receives the Profile.

`agent-profile-kit init` creates the empty Workspace and an empty machine-local Project Binding configuration when either is missing, without overwriting existing content. Bindings remain machine-local configuration with Local Configuration as the sole canonical home—not a second managed model.

### Amendment: recording-only `bind` authoring command

Post-v1, `agent-profile-kit bind` may append one Project Binding to Local Configuration after the same validation boundary used for hand-authored files (explicit Profile Artifact ID, absolute or home-relative project root, required explicit Hosts, no Host capability checks). The command records desired state only: it never previews, applies, installs, removes, or reconciles project output. An identical binding is idempotent; a conflicting binding for the same canonical project root fails without replacement. Removing a binding is a separate safety boundary (`unbind`) and is not part of this amendment.

Local Configuration publication serializes cooperating `bind` processes with a sidecar lock, validates and edits one exact source snapshot, rechecks those bytes immediately before publication, and atomically replaces the file without a missing-path window. A completed direct edit observed by the recheck is rejected. Hand-editing remains supported when `bind` is not running, but direct editors do not participate in the lock and must not write concurrently with `bind`: portable POSIX regular-file operations provide atomic replacement but no compare-and-swap primitive, so an edit in the final recheck-to-rename syscall window cannot be detected without weakening continuous readability or requiring every reader and writer to join a transaction protocol. This scoped contract replaces the original unqualified concurrent-source-edit guarantee for the recording-only command.

### Amendment: recording-only `unbind` authoring command

Post-v1, `agent-profile-kit unbind [project]` removes one Project Binding from
Local Configuration without reconciling its Profile Installation. Omitting the
project targets the canonical current working directory. An existing explicit
path follows the same absolute/home-relative, wildcard, directory, symlink, and
canonical-root rules as binding ingestion. If the requested path no longer
exists, removal is allowed only when its exact authored spelling matches one
binding; the command never infers an alias or guesses canonical identity.

A missing match is idempotently unchanged. A matching binding is removed only
after the complete Local Configuration and Workspace/Profile model is validated,
with ambiguous canonical or exact-authored matches rejected before any write.
The command edits no Workspace, Host, project, Git, Installation Manifest, or
machine-local installation state. It reports the removed binding and directs the
user to global `preview` and `apply`, which remain the only reconciliation path
for removing no-longer-desired generated output. `unbind` is therefore distinct
from `uninstall`: the former changes desired Project Binding state, while the
latter removes proven generated output and preserves bindings.

`unbind` uses the same cooperating-command sidecar lock, exact source snapshot
recheck, newline/mode preservation, and atomic replacement boundary as `bind`.
A direct editor observed before publication is rejected; as with `bind`, direct
editors do not participate in the lock and must not write concurrently with the
recording command because portable POSIX regular-file operations do not provide
compare-and-swap publication.

Each installed project carries a minimal Installer-owned marker containing an opaque installation ID, linked to its machine-local Installation Manifest. This permits safe folder moves and makes copied installations fail on duplicate identity; the marker contains no desired state and is removed with the installation.

### Amendment: bind only the exact project root

Post-v1, a Project Binding reconciles only its explicit canonical project root.
Git repository membership does not implicitly expand that binding into sibling
worktrees. This supersedes the original consequence that every existing
worktree of a bound Git repository receives a Profile Installation during
`apply`.

A Host session launched from the bound root can operate on files in another
worktree while retaining the Profile loaded for that session. A worktree that
must support Hosts launched directly from its own root requires its own explicit
Project Binding and otherwise follows the same lifecycle as any explicitly
bound root. The ordinary removal path removes its Project Binding, applies the
ownership-proven output removal, and then deletes the directory. If the user
deletes a bound root first, `unbind` accepts only its exact authored path; that
explicit removal confirms the deletion was intentional, and the next `apply`
retires the absent Profile Installation without attempting project filesystem
deletion. Restoring that project later requires a new Project Binding.
Transient or later-created unbound worktrees are outside the binding's
lifecycle, so their creation and deletion cannot create stale Installation
Manifests or block reconciliation of the bound project.

This narrows the original worktree convenience in favor of the Project
Binding's explicit-root contract: enrollment remains intentional and auditable,
and reconciliation owns no directory the user did not name.

The Installer retains ordinary Git inspection for the exact bound root,
including tracked-path protection and repository-local exclusions, but it does
not enumerate, classify, deduplicate, or report Git worktree topology. A primary
checkout and a linked worktree are indistinguishable at the Project Binding
boundary.

### Amendment: retire an intentionally deleted project

When a project root is absent, its Project Binding remains desired state until
the user explicitly removes it by its exact authored path. That successful
`unbind` is the intent boundary: the next `apply` retires the machine-local
Installation Manifest without requiring the vanished Marker or attempting any
project filesystem deletion. If repository-local exclusion state survives
outside the deleted root, reconciliation removes only the exact entries whose
ownership was recorded for that installation.

Deleting a directory alone never edits Local Configuration. A later restoration
is a new project lifecycle and therefore requires `bind` followed by `apply`.

Repository-local exclusion ownership is recorded in machine-local installation
state when a Git project is applied: the canonical exclusion-file target and
the exact entries attributable to the installation. Cleanup uses that recorded
provenance rather than attempting to rediscover Git through a project root that
may no longer exist. Before changing the exclusion file, reconciliation still
proves its real path and exact Installer-owned section; missing, malformed, or
modified ownership state fails closed.

When multiple explicit Project Bindings resolve to the same canonical
repository-local exclusion file, machine-local state contains one Repository
Exclusion Record for that file. The record maps each contributing Installation ID to its
exact entries, and the on-disk marked section is the deterministic union of all
contributions. Removing one installation removes only its contribution; entries
still required by another installation remain. Parallel ownership records for
the same exclusion target are invalid.

### Amendment: repair absent owned output

For a currently bound Profile Installation whose Installation Marker matches
its machine-local Manifest, `apply` recreates a recorded output that is wholly
absent from the current Workspace source. Absence is a safe desired-state
repair because no existing project data is overwritten.

This repair is allowed only when every surviving owned output remains
ownership-proven and the ordinary tracked-path, parent-path, and unowned-path
checks pass. A modified output, mode drift, unexpected directory member, or
occupied destination remains blocking and is never overwritten silently.

### Amendment: no migration for automatic worktree expansion

Automatic worktree expansion was not released or used by external consumers.
The exact-root implementation replaces it directly and carries no compatibility
reader, state migration, or cleanup command for installations produced by the
development-only behavior. Development installations may be reset and reapplied
from canonical Workspace and Local Configuration source.

### Amendment: replace an existing Project Binding with --replace

The original amendment made a conflicting `bind` fail without replacement,
forcing users through a manual unbind → bind round-trip to restate a binding.
That choice traded one-command usability for avoiding duplicate-binding states
that ingestion already rejects; because Local Configuration permits each
canonical project root in exactly one binding, replacing that single record is
the same poka-yoke boundary, so the restriction added friction without adding
safety.

Post-v1, `agent-profile-kit bind --replace` restates the existing binding for
the requested canonical project root: its Profile and Host set become the exact
desired final set under the same validation rules as a first bind (explicit
Profile Artifact ID, required explicit Hosts in canonical order). An identical
restatement remains idempotently unchanged. The command records desired state
only and never previews, applies, installs, removes, or reconciles project
output; generated files reconcile through the ordinary status → apply path
exactly as after any hand edit of Local Configuration. Omitting `--replace`
keeps the conflicting-bind failure, which names the flag as its remedy.

Replacement edits only the matched binding's Profile and Host values within the
same cooperating-command sidecar lock, exact source snapshot recheck, newline/
mode preservation, and atomic publication boundary as appending. The stored
authored project path, all sibling bindings, and unrelated authored content are
preserved by that publication machinery.
