# Separate the engine from user Workspaces

Amendment: since spec #593 (DEC-001, ticket #601; DEC-002, ticket #607), the fixed default
Workspace path this decision introduced is removed, and ADR-0049 supersedes that part:
no command creates or selects a Workspace at a location the user did not give.
Zero-argument `init` on a machine with no selected Workspace refuses instead
of provisioning the conventional default, and legacy version-1 Local
Configuration without a `workspace` value is upgraded only to a path the user
gives. Ticket #607 supersedes this decision's refusal to select a different
Workspace: an explicit `apkit init <workspace>` on a configured machine
connects a different Workspace after confirmation (or unconditionally with
`--yes`), provisions any missing required parts, updates Local Configuration's
`workspace` field while preserving all Project Bindings, and reports missing
Profile bindings.

The open-source Agent Profile Kit repository owns only the CLI, schemas, Installer, Adapters, documentation, and minimal non-personal fixtures, while each user owns one canonical Workspace. The Workspace may be a Git repository independently of the tool; keeping product code, private content, Workspace versioning, backups, and disposable Host output separate avoids requiring users to fork and edit the tool repository.

The fixed default Workspace path is `~/.agents/agent-profile-kit/workspace/`. Current Local Configuration records exactly one explicit absolute or home-relative `workspace` path, either the conventional default written by zero-argument `init` or a custom path selected by `init <workspace>`. An explicit initialization provisions a missing or empty non-symlink destination, or adopts an existing valid Workspace, and records the authored spelling; it never rewrites existing Workspace source. When Local Configuration already selects a Workspace, an explicit request must resolve to that same canonical directory, including through a symlink alias, or initialization fails closed before source or configuration publication. Path selection is machine-specific and non-secret, so Local Configuration is its canonical home. Changing the configured path never migrates source or resets installation state. Desired-state commands share one Local Configuration ingestion boundary (`ingestApplication`); `init` validates the explicit request and reuses the configured-path resolver for an existing selection; `uninstall` remains installation ownership/state-only and does not resolve a Workspace.

The current Local Configuration schema is version 2 and requires `workspace`. Version 1 files remain accepted only as migration input to `init`: an omitted path migrates to the conventional default, while an authored path is preserved. Migration validates the selected Workspace before atomically replacing only Local Configuration, preserving authored bindings and unrelated user content. Desired-state and binding-recording commands reject legacy configuration with actionable `agent-profile-kit init` guidance rather than migrating implicitly. Operators must retain a pre-migration version-1 backup before running `init`; downgrade is supported only by restoring that backup, not by hand-editing a version-2 schema marker. Older engine versions are not claimed to understand the version-2 file.

ADR-0010 supersedes this decision's original placement of generated output under a sibling `installations/` directory. Project-bound output now lives in exclusively owned paths inside bound projects, with machine-local ownership records under application state.
