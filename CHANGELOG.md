# Changelog

All notable changes to this repository are documented here.

The format follows Keep a Changelog, and this repository uses Semantic Versioning once versioned packages or tools are introduced.

## [Unreleased]

### Added

- Explain concise lifecycle summary terminology: generated-output change units, short non-current Profile Installation state glosses (deduplicated across installations), and Git-local Repository Exclusion purpose while preserving exact path deltas; `--verbose` still exposes complete diagnostics from the same reconciliation report ([#89](https://github.com/kenneth-liao/agent-profile-kit/issues/89)).
- Install resolved portable Skills for Grok projects under `.grok/skills/<Artifact ID>/`, preserving package bytes/modes, projecting `disable-model-invocation` for disabled model-invocation policy, and fail-closed Skill discovery preflight across native, personal, compatibility, plugin, and configured sources ([#87](https://github.com/kenneth-liao/agent-profile-kit/issues/87)).
- Add Grok as a project-bound Agent Host for Profile Context via always-scanned `.grok/rules/` and Claude rules compatibility coalescing ([#86](https://github.com/kenneth-liao/agent-profile-kit/issues/86)).
- Explain every command in root `agent-profile-kit` and `agent-profile-kit --help` output, including a minimal `init` → `bind` → `preview` → `apply` Profile Installation quick start and a pointer to `guide` for deeper authoring; unknown commands and invalid arguments now name the error and show the relevant usage ([#88](https://github.com/kenneth-liao/agent-profile-kit/issues/88)).
- Repair wholly absent owned files and complete artifact directories from current Workspace source when the Installation Marker and every surviving output prove ownership ([#79](https://github.com/kenneth-liao/agent-profile-kit/issues/79)).
- Make Repository Exclusion Records the canonical machine-local ownership source for shared Git exclusion files, including deterministic unions, fail-closed validation, and transactional reconciliation ([#77](https://github.com/kenneth-liao/agent-profile-kit/issues/77)).
- Add concise, outcome-led `bind`, `preview`, `apply`, and `status` output with
  Profile Installation grouping, actionable ownership blockers, and explicit
  `--verbose` lifecycle diagnostics ([#70](https://github.com/kenneth-liao/agent-profile-kit/issues/70)).
- Accept an optional explicit Workspace path in `agent-profile-kit init`, provisioning missing or empty destinations, adopting valid existing Workspaces, and failing closed on canonical selection conflicts ([#69](https://github.com/kenneth-liao/agent-profile-kit/issues/69)).
- Require an explicit Workspace selection in Local Configuration schema version 2; `init` records the conventional default or migrates supported version-1 configuration without implicit read-time migration ([#68](https://github.com/kenneth-liao/agent-profile-kit/issues/68)).

### Changed

- Keep schema-v2 Installation State readable through a one-time Repository Exclusion Record migration, publish schema v3 on the next successful lifecycle operation, and document downgrade/recovery guidance ([#77](https://github.com/kenneth-liao/agent-profile-kit/issues/77)).
- Document the required pre-migration Local Configuration backup and restore procedure for schema-v2 downgrade ([#68](https://github.com/kenneth-liao/agent-profile-kit/issues/68)).
- Document the 0.24.2 Installation State backup and pre-delete apply required for rollback and safe retirement of pre-0.24.2 non-Git installations ([#78](https://github.com/kenneth-liao/agent-profile-kit/issues/78)).

### Fixed

- Report safely repairable output distinctly in compact lifecycle summaries and document its status vocabulary ([#83](https://github.com/kenneth-liao/agent-profile-kit/pull/83)).
- Retire intentionally deleted projects after exact-path `unbind` without requiring a vanished Installation Marker, while preserving shared Git exclusion ownership and failing closed on missing or drifted exclusion sections ([#78](https://github.com/kenneth-liao/agent-profile-kit/issues/78)).
- Surface Installation State restore failures during transactional apply and uninstall instead of silently discarding recovery errors ([#77](https://github.com/kenneth-liao/agent-profile-kit/issues/77)).
- Reconcile each Project Binding only at its exact canonical project root without enrolling sibling Git worktrees ([#76](https://github.com/kenneth-liao/agent-profile-kit/issues/76)).
- Reject Workspace selections that overlap Local Configuration or disposable installation state, including configured and symlinked paths ([#73](https://github.com/kenneth-liao/agent-profile-kit/pull/73)).

## [0.20.0] - 2026-07-16

### Added

- Recording-only `agent-profile-kit bind <profile> [project] --host <host>…` appends one validated Project Binding to Local Configuration (cwd or explicit path, required Hosts, idempotent identical records, fail-closed conflicts, atomic concurrent-safe publish) without reconciling project or Host state; ADR-0010 amended, architecture and guides distinguish authoring from global reconciliation ([#54](https://github.com/kenneth-liao/agent-profile-kit/issues/54)).
- Recording-only `agent-profile-kit unbind [project]` removes one Project Binding by canonical existing-path identity or exact authored spelling for a missing path, preserving Local Configuration safety and leaving generated output for global `preview`/`apply`; ADR-0010, architecture, README, and guides distinguish `unbind` from `uninstall` ([#56](https://github.com/kenneth-liao/agent-profile-kit/issues/56)).

- Optional Local Configuration `workspace` path selects one existing absolute or home-relative Workspace (symlinks resolved once at ingestion); omission retains `~/.agents/agent-profile-kit/workspace/`; `init` never creates or migrates a configured custom target; ADR-0007, glossary, architecture, and guides updated ([#51](https://github.com/kenneth-liao/agent-profile-kit/issues/51)).

- Verified the project-bound initial release candidate: permanent packed-CLI gates on real Node.js (version provenance, multi-Host lifecycle, install-inert package install, distribution boundary, fail-closed unsupported surfaces) plus neutral fixtures for model-invocation policy, Skills-only Profiles, global Skill identity collisions, and optional Workspace scaffolding. Blockers [#49](https://github.com/kenneth-liao/agent-profile-kit/issues/49), [#50](https://github.com/kenneth-liao/agent-profile-kit/issues/50), [#52](https://github.com/kenneth-liao/agent-profile-kit/issues/52), [#53](https://github.com/kenneth-liao/agent-profile-kit/issues/53), and [#55](https://github.com/kenneth-liao/agent-profile-kit/issues/55) are complete; Host qualification remains Codex [#33](https://github.com/kenneth-liao/agent-profile-kit/issues/33) and Claude [#43](https://github.com/kenneth-liao/agent-profile-kit/issues/43). Parent PRD [#27](https://github.com/kenneth-liao/agent-profile-kit/issues/27) ([#35](https://github.com/kenneth-liao/agent-profile-kit/issues/35)).

- Support Skills-only Profiles without Context machinery: a Profile must select at least one supported artifact overall (Context and/or Skills), but no category is mandatory; Skills-only bindings install only selected Skill packages and skip Context outputs and Context-related Host capability requirements; document CLI 0.17.0+ vs older Context-required ingestion for safe downgrade ([#55](https://github.com/kenneth-liao/agent-profile-kit/issues/55)).

### Changed

- Document that universal artifacts may remain canonical Workspace source while Profile selection drives only project-bound delivery; v1 does not own or mutate global Host paths, `status` may still report selected↔global Skill collisions as blocked (#53), and dual delivery fails closed ([#52](https://github.com/kenneth-liao/agent-profile-kit/issues/52)).

- Treat Workspace scaffolding as optional after initialization: only a supported `workspace.yaml` is required; missing artifact directories ingest as empty categories; bootstrap docs are never format requirements; document CLI 0.16.1+ vs older full-scaffold expectations for rollback ([#50](https://github.com/kenneth-liao/agent-profile-kit/issues/50)).

- Published the final project-bound public overview, Workspace guide, and agent workflow for init through native Host use, with packed CLI coverage of both bundled guides ([#34](https://github.com/kenneth-liao/agent-profile-kit/issues/34)).

### Fixed

- Fail closed when a selected project-bound Skill collides with a selected Host's personal/global Skill identity (Codex `~/.agents/skills` and `~/.codex/skills`, Claude `~/.claude/skills`), including identical bytes and Workspace symlinks; `status` reports later overlaps as blocked without mutating global material ([#53](https://github.com/kenneth-liao/agent-profile-kit/issues/53)).

- Reject dangling Workspace category symlinks as structural errors instead of treating them as empty categories ([#50](https://github.com/kenneth-liao/agent-profile-kit/issues/50)).

- Kept personal Workspace and generated migration content outside the public package and added packed-artifact boundary checks ([#16](https://github.com/kenneth-liao/agent-profile-kit/issues/16)).

- Record Claude Capability Contract `native-project-unscoped-rules-skills-v1` for installations that prove unscoped project rules and native Skill discovery ([#42](https://github.com/kenneth-liao/agent-profile-kit/issues/42)).

### Added

- Optional portable Skill model-invocation policy via `metadata.agent-profile-kit.model-invocation`, with Adapter-owned Host projection and capability preflight that rejects Host versions unable to enforce disabled implicit invocation ([#49](https://github.com/kenneth-liao/agent-profile-kit/issues/49)).

- Installed resolved portable Claude Skills at project scope under native `.claude/skills/<Artifact ID>/` discovery, with transitive dependency selection, inclusion reasons in preview and the Installation Manifest, sidecar omission, combined Codex/Claude Host ownership, and shared Context lifecycle ([#42](https://github.com/kenneth-liao/agent-profile-kit/issues/42)).

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
