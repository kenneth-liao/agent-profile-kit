# Changelog

All notable changes to this repository are documented here.

The format follows Keep a Changelog, and this repository uses Semantic Versioning once versioned packages or tools are introduced.

## [Unreleased]

### Added

- Installed Profile Context for Claude Code as an unscoped owned `.claude/rules/agent-profile-kit.md` rule, with Claude-only and combined Codex/Claude bindings through the shared preview/apply/status/uninstall lifecycle and fail-closed Skills until Claude Skill delivery ([#32](https://github.com/kenneth-liao/agent-profile-kit/issues/32)).

- Installed resolved portable Codex Skills at project scope under native `.agents/skills/<Artifact ID>/` discovery, with transitive dependency selection, inclusion reasons in preview and the Installation Manifest, sidecar omission, and shared Context lifecycle ownership ([#31](https://github.com/kenneth-liao/agent-profile-kit/issues/31)).

- Extended Adapter plans and Installer reconciliation to own complete artifact directories as one ownership boundary, with member-level preflight, preview, transactional apply, and proven removal ([#39](https://github.com/kenneth-liao/agent-profile-kit/issues/39)).

- Added Git worktree expansion and repository-local generated-path exclusions while preserving safe project move, copy, and uninstall ownership ([#30](https://github.com/kenneth-liao/agent-profile-kit/issues/30)).

- Added deterministic global reconciliation with normalized multi-Adapter output plans, complete preflight reporting, independently transactional project updates, and ownership-proven removals ([#29](https://github.com/kenneth-liao/agent-profile-kit/issues/29)).

- Added project-bound Context-only Codex lifecycle with Local Configuration ingestion, preview/apply reconciliation, ownership-aware status, and safe uninstall ([#28](https://github.com/kenneth-liao/agent-profile-kit/issues/28)).

- Added typed, transitive cross-artifact Dependency resolution with deterministic plans and auditable Manifest inclusion reasons ([#7](https://github.com/kenneth-liao/agent-profile-kit/issues/7)).
- Initialized the Agent Profile Kit monorepo structure.
- Added the schema-versioned `agent-profile-kit init` CLI and npm executable contract ([#2](https://github.com/kenneth-liao/agent-profile-kit/issues/2)).
- Added bundled human and agent Workspace authoring guides ([#3](https://github.com/kenneth-liao/agent-profile-kit/issues/3)).
- Added Context-only Codex Profile validation, planning, installation, and launch ([#4](https://github.com/kenneth-liao/agent-profile-kit/issues/4)).
- Added transactional Profile Installation status, update, and verified uninstall lifecycle management ([#5](https://github.com/kenneth-liao/agent-profile-kit/issues/5)).
- Added standard Skill package ingestion and validation groundwork, including separate Agent Profile Kit sidecars ([#6](https://github.com/kenneth-liao/agent-profile-kit/issues/6)).
- Added the owned Codex Skill Library, transactional complete-Workspace projection, process-only Profile filtering, conflict protection, and shared lifecycle reporting ([#6](https://github.com/kenneth-liao/agent-profile-kit/issues/6)).

### Changed

- Replaced the unreleased per-session launcher and global Skill projection with native project SessionStart output ([#28](https://github.com/kenneth-liao/agent-profile-kit/issues/28)).

- Profiles now define observable artifact selection while Adapters may use different native delivery mechanisms per artifact category; Codex Skills use a shared owned projection without modifying existing Host state ([#6](https://github.com/kenneth-liao/agent-profile-kit/issues/6)).
- Marked the PR review follow-up skills for explicit invocation only.
- Simplified Workspace staging to clean only output owned by the running initialization process ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Simplified initialization warnings to their single concurrent-cleanup producer ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).

### Fixed

- Report missing repository-local exclusion ownership before repair and publish exclusion changes only after Manifest durability ([#38](https://github.com/kenneth-liao/agent-profile-kit/pull/38)).

- Made repairable-marker status and malformed-state apply errors precise, and decoupled reconciliation from report ordering ([#37](https://github.com/kenneth-liao/agent-profile-kit/pull/37)).

- Recover from interrupted Profile Installation replacement without blocking later updates ([#21](https://github.com/kenneth-liao/agent-profile-kit/pull/21)).
- Report an existing Profile Installation without modifying it ([#20](https://github.com/kenneth-liao/agent-profile-kit/pull/20)).
- Report incomplete Workspace structure with an actionable error without modifying user-owned source ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Preserve initialization failures when staging cleanup also fails ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Keep staging cleanup non-blocking, expose nested cleanup failures, and recognize valid symlinked Workspaces ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Make concurrent initialization converge and report empty Workspace symlink targets clearly ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Atomically replace empty Workspace directories and preserve concurrent-state validation failures ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Enforce initial macOS support at package installation and keep benign concurrent convergence non-blocking ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Quote optional shell commands safely and report unsupported Workspace schema versions with migration guidance ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Report malformed Workspace YAML with an actionable manifest error ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Distinguish malformed schema versions from supported-version migration failures ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Validate the Workspace Manifest path kind before reading it ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Add safe remediation guidance for dangling Workspace symlinks ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Make empty Workspace symlink remediation actionable from the fixed path ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).

### Removed

- Removed the unreleased `plan`, `install`, `update`, and `run` interfaces, launcher, leases, and global Codex Skill projection ([#28](https://github.com/kenneth-liao/agent-profile-kit/issues/28)).
