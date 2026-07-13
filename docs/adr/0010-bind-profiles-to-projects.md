---
status: accepted
---

# Bind Profiles to projects and use native Host loading

Agent Profile Kit keeps Profiles portable in the user Workspace, while each machine-local Project Binding selects one Profile and a set of Agent Hosts for exactly one explicit project directory root. An explicit global reconciliation installs a disposable snapshot into whole files and directories that Agent Profile Kit exclusively owns inside each project; the Hosts then load that material through their normal project discovery alongside untouched global and repository-owned configuration. This replaces per-session launch overlays and deliberately gives up simultaneous Profiles in one project in exchange for a smaller runtime-free system, native reliability, and no Host-global writes.

## Consequences

Adapters plan exact project outputs but never write them. The Installer normalizes their combined output set, coalesces byte-identical shared paths, rejects conflicts or unowned destinations, and records one Profile Installation per project. A canonical project root may appear in only one binding. Project paths must be absolute or home-relative, resolve to existing directories, and cannot contain wildcards; there are no implicit directory scans. A non-Git project must launch Codex from its exact bound root for native discovery to be guaranteed. Existing worktrees of a bound Git repository reconcile during `apply`; a worktree created later requires another explicit `apply` before it receives the Profile.

`agent-profile-kit init` creates the empty Workspace and an empty machine-local Project Binding configuration when either is missing, without overwriting existing content. Bindings remain directly authored configuration rather than a second CLI-managed model.

Each installed project carries a minimal Installer-owned marker containing an opaque installation ID, linked to its machine-local Installation Manifest. This permits safe folder moves and makes copied installations fail on duplicate identity; the marker contains no desired state and is removed with the installation.
