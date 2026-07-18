# Agent Profile Kit

Agent Profile Kit is a user-agnostic CLI and format for composing a user's Skills,
Context, Agents, Hooks, and Tools into portable Profiles. Host Adapters generate
native Profile output for supported agent products without overwriting their
existing configuration or capabilities.

Profiles are reusable Workspace selections. Each machine-local Project Binding
installs one Profile into one explicit project for the Hosts you name. Codex and
Claude Code on macOS then load that material through ordinary native project
discovery. Global Host configuration and repository-owned instructions remain
untouched.

This release installs Context Modules and portable Skills. A Profile needs at
least one supported artifact (Context, Skills, or both); Context is not
mandatory. Profiles selecting Agents, Hooks, or Tools are rejected until those
artifact categories have native project delivery.

## Quick start

Initialize the canonical Workspace without a global installation:

```sh
npx agent-profile-kit init
# Or choose one explicit absolute or home-relative Workspace path:
npx agent-profile-kit init ~/projects/agent-profile-workspace
```

The initial release supports macOS only.

Running the command again is safe: it scaffolds a missing or empty non-symlink
destination, adopts a valid existing Workspace without rewriting it, and never
overwrites the current Local Configuration. An explicit path must resolve to the
same canonical Workspace already selected by Local Configuration; a different
selection fails closed. Supported legacy configuration is upgraded only by this
explicit `init` command.

## Project-bound Context and Skills

Codex loads Context through a native project SessionStart hook and discovers
selected Skills under `.agents/skills/`. Claude Code loads Context as an unscoped
project rule and discovers selected Skills under `.claude/skills/`. Skills-only
Profiles install only Skill packages—no Context snapshot, Codex hooks, or Claude
Context rule—and do not require Context-related Host capability.

When a Profile includes Context for Codex, Codex must trust each bound project
and have lifecycle hooks explicitly enabled in its global or project
configuration:

```toml
[features]
hooks = true
```

Launch Codex or Claude from the bound project. For a non-Git project with
Context, use the exact bound root so Codex can discover the generated project
hook and Context.

```sh
agent-profile-kit bind engineering --host codex
agent-profile-kit bind engineering ~/projects/x --host codex --host claude
agent-profile-kit unbind ~/projects/x
agent-profile-kit validate
agent-profile-kit preview
agent-profile-kit apply
agent-profile-kit status
agent-profile-kit preview --verbose   # complete reconciliation diagnostics
agent-profile-kit uninstall
```

Project Bindings and the explicit Workspace selection live in the machine-local
`~/.agents/agent-profile-kit/config.yaml`. Current Local Configuration uses
`schema_version: 2` and requires one existing absolute or home-relative (`~/…`)
`workspace` path plus Project Bindings:

```yaml
schema_version: 2
workspace: ~/.agents/agent-profile-kit/workspace
bindings: []
```

Each binding names one existing absolute or home-relative project root, one
Profile, and one or more Hosts (`codex`, `claude`). Use `bind` to append one
validated binding, or `unbind` to remove one binding, without reconciling
output; hand-editing `config.yaml` remains supported. `unbind` defaults to the
current working directory and only uses exact authored-path recovery when a
requested project no longer exists. `preview` is read-only and leads with a
ready-to-apply or cannot-apply outcome; `apply` reports what reconciliation
completed; and `status` emphasizes Profile Installations that need attention.
These default views group details by Profile Installation, summarize output
changes, and keep warnings and blockers visible. Add `--verbose` to
`preview`, `apply`, or `status` for complete per-output and desired-state
diagnostics, including resolved artifact inclusion reasons and composed Context.
`uninstall` is different: it removes proven generated Profile Installation
output while preserving bindings.

Older version-1 configuration without `workspace` is migration input only. Run
`agent-profile-kit init` to record the effective Workspace and upgrade it;
`validate`, `preview`, `apply`, `status`, `bind`, and `unbind` fail closed with
that guidance until migration completes. `init` never moves or rewrites the
Workspace source, and a custom authored Workspace path is preserved.

See `agent-profile-kit guide` for the Context Module, Skill, Profile, and binding
formats, and `agent-profile-kit guide --agent` for agent-facing authoring
boundaries.

## Product layout

- `cli/` - the `agent-profile-kit` command.
- `adapters/` - all Host-specific generation and capability detection.
- `installer/` - configuration ingestion, desired-state planning, reconciliation, ownership, and lifecycle orchestration.
- `schemas/` - portable Workspace and artifact schemas.
- `docs/adr/` - accepted architectural and workflow decisions.
- `docs/ARCHITECTURE.md` - the living system structure and delivery model.
- `docs/guides/` - bundled human and agent Workspace guidance served by the CLI.
- `docs/runbooks/` - operational playbooks for risky or repeatable procedures.
- `docs/archive/` - shipped plans and spent research kept only for provenance.

User-owned Workspaces hold Profiles and artifacts. The open-source engine ships
product code, schemas, and documentation rather than a personal Workspace.

## User data

Canonical user content lives in one selected Workspace. The fixed default is
`~/.agents/agent-profile-kit/workspace/`; zero-argument `init` records that path
explicitly, while `init <workspace>` may provision or adopt another absolute or
home-relative Workspace path. Machine-local Project Bindings and that explicit
path live in `config.yaml`; disposable Installation
Manifests live under `state/`. Generated Context, hooks, rules, and Skills live
only in bound project-owned paths.

`agent-profile-kit init` creates an empty default Workspace with a schema marker,
artifact directories, short human/agent bootstrap files, and a version-2
configuration that records the default path when configuration is absent. With
an explicit path, it applies the same scaffold to a missing or empty non-symlink
destination, or adopts a valid existing Workspace without changing its source.
When configuration already selects a Workspace, an explicit path must be an
equivalent canonical alias; `init` never switches the selection. When it finds
supported legacy configuration, it upgrades only the local configuration after
validating the effective target. Current authoring guidance remains
owned by the CLI through `agent-profile-kit guide` and
`agent-profile-kit guide --agent`; initialization does not copy personal or
opinionated starter content.

## Working Principles

This repository favors one canonical home per fact. The open-source repository
owns product behavior; each Workspace owns its user's artifacts; generated
Profile Installations are never edited as sources.
