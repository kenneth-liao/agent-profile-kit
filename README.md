# Agent Profile Kit

Agent Profile Kit is a user-agnostic CLI and format for composing a user's Skills,
Context, Agents, Hooks, and Tools into portable Profiles. Host Adapters generate
native Profile output for supported agent products without overwriting their
existing configuration or capabilities.

Profiles are reusable Workspace selections. Each machine-local Project Binding
installs one Profile into one explicit project for the Hosts you name. Codex,
Claude Code, Grok, and Pi on macOS then load that material through ordinary
native project discovery. Global Host configuration and repository-owned
instructions remain untouched.

This release installs Context Modules and portable Skills for Codex, Claude,
Grok, and Pi. Pi Skills are delivered under `.pi/skills/<Artifact ID>/` with
Host-native resolution alongside user-managed Skills, extensions, and packages.
Disabled model-invocation Skills receive Pi-native
`disable-model-invocation: true` projection while remaining explicitly
activatable by Artifact ID.
A Profile needs at least one supported artifact
(Context, Skills, or both); Context is not mandatory. Profiles selecting
Agents, Hooks, or Tools are rejected until those artifact categories have native
project delivery.

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
project rule and discovers selected Skills under `.claude/skills/`. Grok loads
Context as an unscoped project rule under `.grok/rules/` (or, when Claude is also
bound and Grok Claude rules compatibility is enabled, shares Claude’s
`.claude/rules/agent-profile-kit.md` path so Grok receives one effective copy)
and discovers selected Skills under `.grok/skills/`. Pi loads Profile Context
from the owned `.pi/APPEND_SYSTEM.md` project surface and selected Skills under
`.pi/skills/<Artifact ID>/`; Pi trust and session overrides remain Pi-owned.
Skills-only Profiles install only Skill packages—no Context snapshot,
Codex hooks, or Claude/Grok Context rule—and do not require Context-related Host
capability.

When a Profile includes Context for Codex, review and trust the generated project
SessionStart hook in Codex for each bound project. Lifecycle hooks are enabled by
default. Agent Profile Kit warns when the effective global or project
configuration explicitly disables them, or when the relevant configuration is
malformed or unreadable, because generated Context may not load; the warning
does not block installation. Project configuration takes precedence over global
configuration; when `CODEX_HOME` is set, Codex's global configuration is
`CODEX_HOME/config.toml`, otherwise it is the default `~/.codex/config.toml`.
The deprecated `codex_hooks` alias remains supported.
When Host configuration warnings are the only diagnostics, `preview`, `apply`,
and `status` still exit successfully. Automation that needs loading guarantees
must inspect the `Warnings` section rather than relying on the exit code alone.

Launch Codex, Claude, Grok, or Pi from the bound project. For a non-Git project
with Context, use the exact bound root so Codex can discover the generated
project hook and Context.

```sh
agent-profile-kit bind engineering --host codex
agent-profile-kit bind engineering ~/projects/x --host codex --host claude --host grok --host pi
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
Profile, and one or more Hosts (`codex`, `claude`, `grok`, or `pi`). Host order
and duplicate entries normalize at ingestion. Use `bind` to append one
validated binding, or `unbind` to remove one binding, without reconciling
output; hand-editing `config.yaml` remains supported. `unbind` defaults to the
current working directory and only uses exact authored-path recovery when a
requested project no longer exists. `preview` is read-only and leads with a
ready-to-apply or cannot-apply outcome; `apply` reports the verified resulting
state separately from an Apply Receipt describing the pre-apply work that was
committed; and `status` emphasizes Profile Installations that need attention.
These default views group details by Profile Installation, summarize
generated-output changes (additions, updates, repairs, removals, and drift),
explain non-current Profile Installation states when they appear, describe
Repository Exclusion deltas as Git-local exclusions for Installer-owned
generated paths, keep warnings and blockers visible, and when useful end with
one next-action instruction (status → read-only preview before apply; ready
preview → apply; blocked → resolve and retry the same command; current or
completed/no-op results omit a next step). Add `--verbose` to
`preview`, `apply`, or `status` for complete per-output and desired-state
diagnostics, including resolved artifact inclusion reasons and composed Context.
`uninstall` is different: it removes proven generated Profile Installation
output while preserving bindings.

Older version-1 configuration without `workspace` is migration input only. Run
`agent-profile-kit init` to record the effective Workspace and upgrade it;
`validate`, `preview`, `apply`, `status`, `bind`, and `unbind` fail closed with
that guidance until migration completes. `init` never moves or rewrites the
Workspace source, and a custom authored Workspace path is preserved.

Run `agent-profile-kit` with no arguments or `agent-profile-kit --help` for a
concise summary of every command and the minimal `init` → `bind` → `preview` →
`apply` flow. See `agent-profile-kit guide` for the Context Module, Skill,
Profile, and binding formats, and `agent-profile-kit guide --agent` for
agent-facing authoring boundaries.

## Product layout

- `cli/` - the `agent-profile-kit` command.
- `adapters/` - all Host-specific generation and capability detection.
- `installer/` - configuration ingestion, desired-state planning, reconciliation, ownership, and lifecycle orchestration.
- `schemas/` - portable Workspace and artifact schemas.
- `docs/adr/` - accepted architectural and workflow decisions.
- `docs/ARCHITECTURE.md` - the living system structure and delivery model.
- `docs/USER-JOURNEY.md` - the living map of user-facing CLI stages and their gaps.
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
