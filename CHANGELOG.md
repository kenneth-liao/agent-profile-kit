# Changelog

All notable changes to this repository are documented here.

The format follows Keep a Changelog, and this repository uses Semantic Versioning once versioned packages or tools are introduced.

## [Unreleased]

### Added

- Initialized the Agent Profile Kit monorepo structure.
- Added the schema-versioned `agent-profile-kit init` CLI and npm executable contract ([#2](https://github.com/kenneth-liao/agent-profile-kit/issues/2)).

### Changed

- Marked the PR review follow-up skills for explicit invocation only.
- Simplified Workspace staging to clean only output owned by the running initialization process ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Simplified initialization warnings to their single concurrent-cleanup producer ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).

### Fixed

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
