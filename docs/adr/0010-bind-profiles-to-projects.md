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
