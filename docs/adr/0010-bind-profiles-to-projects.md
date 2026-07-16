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

Each installed project carries a minimal Installer-owned marker containing an opaque installation ID, linked to its machine-local Installation Manifest. This permits safe folder moves and makes copied installations fail on duplicate identity; the marker contains no desired state and is removed with the installation.
