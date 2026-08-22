# Agent Profile Kit

Agent Profile Kit is a user-agnostic CLI and format for composing a user's Skills,
Context, Agents, Hooks, and Tools into portable Profiles. Host Adapters generate
native Profile output for supported agent products without overwriting their
existing configuration or capabilities.

Profiles are reusable Workspace selections. Each machine-local Project Binding
installs one Profile into one explicit project for the Hosts you name.
Antigravity, Codex, Claude Code, Grok, and Pi on macOS then load that material
through ordinary native project discovery. Global Host configuration and repository-owned
instructions remain untouched.

This release installs Profile Context for Antigravity, Codex, Claude, Grok,
and Pi, and portable Skills for Antigravity, Codex, Claude, Grok, and Pi.
Antigravity, Codex, and Pi consume one qualified shared package under
`.agents/skills/<Artifact ID>/`, alongside Host-native resolution and
user-managed Skills. Disabled model-invocation Skills receive the shared
Host-policy projection while remaining explicitly activatable by Artifact ID.
A Profile contains only `id`, `context`, and `skills` and needs at least one
supported artifact (Context, Skills, or both); Context is not mandatory. Agents,
Hooks, and Tools are not delivered. Before using 0.84.0 or later, existing
Workspace authors must remove obsolete empty `agents`, `hooks`, and `tools`
placeholders; run `apkit guide --full` for migration guidance.

## Quick start

Initialize the canonical Workspace without a global installation:

```sh
npx --package agent-profile-kit apkit init
# Or choose one explicit absolute or home-relative Workspace path:
npx --package agent-profile-kit apkit init ~/projects/agent-profile-workspace
```

The initial release supports macOS only.

Terminal width, interactive color and branding, `NO_COLOR`, and machine-output
behavior are documented in the [Discover stage of the user journey](docs/USER-JOURNEY.md#1-discover).

Running the command again is safe: it scaffolds a missing or empty non-symlink
destination, adopts a valid existing Workspace without rewriting it, and never
overwrites the current Local Configuration. An explicit path must resolve to the
same canonical Workspace already selected by Local Configuration; a different
selection fails closed. Supported legacy configuration is upgraded only by this
explicit `init` command. A new Workspace includes a bindable `example` Profile
and Context Module; follow the printed `apkit bind example --host codex` next
step from the project you want to try. If you remove the example, later `init`
runs do not restore it.

## Project-bound Context and Skills

Antigravity loads Profile Context through deterministic always-on rules under
`.agents/rules/` and requires `agy` 1.1.13+. Each rule preserves either the
Profile envelope or one complete Context Module and stays within Antigravity's
12,000-character limit. Antigravity also discovers selected Skills through the
qualified shared `.agents/skills/<Artifact ID>/` package; trust remains
Host-owned. Codex loads complete Context through a native project SessionStart hook (the
Adapter requires Codex CLI 0.145.0 or newer for direct delivery) and discovers
selected Skills under `.agents/skills/`. Claude Code loads Context as an unscoped
project rule and discovers selected Skills under `.claude/skills/`. Grok loads
Context as an unscoped project rule under `.grok/rules/` (or, when Claude is also
bound and Grok Claude rules compatibility is enabled, shares Claude’s
`.claude/rules/agent-profile-kit.md` path so Grok receives one effective copy)
and discovers selected Skills under `.grok/skills/`. Pi loads Profile Context
from the owned `.pi/APPEND_SYSTEM.md` project surface and consumes selected
Skills from the shared `.agents/skills/<Artifact ID>/` package; Pi trust and
session overrides remain Pi-owned.
Skills-only Profiles install only selected Skill packages for Hosts that support
them. They do not install Context snapshots, Codex hooks, or Claude/Grok Context
rules, and do not require Context-related Host capability. Antigravity Skills-only
bindings check only the shared `.agents` and `.agents/skills` surfaces.

When a Profile includes Context for Codex, review and trust the generated project
SessionStart hook in Codex for each bound project. Codex injects that Context on
session start, clear, and compact — not on resume — so a reopened conversation
keeps the Context it started with; start a new session or clear to pick up a
changed Profile after `apply`. Lifecycle hooks are enabled by
default. Agent Profile Kit warns when the effective global or project
configuration explicitly disables them, or when the relevant configuration is
malformed or unreadable, because generated Context may not load; the warning
does not block installation. Project configuration takes precedence over global
configuration; when `CODEX_HOME` is set, Codex's global configuration is
`CODEX_HOME/config.toml`, otherwise it is the default `~/.codex/config.toml`.
The deprecated `codex_hooks` alias remains supported.
When Host configuration warnings are the only diagnostics, `preview`, `apply`,
and `status` still exit successfully. Automation that needs loading guarantees
must inspect the `Warnings` section (or JSON `warnings`) rather than relying on
the exit code alone.

Machine-readable command contracts:

- `info --json` prints a `schemaVersion: 1` object with the engine version,
  configuration state (`current`, `legacy`, or `not-configured`), and the
  selected Workspace, Local Configuration, and Installation State locations.
  A selected Workspace preserves both its authored and canonical paths. The
  command reads no Workspace artifacts, Project Bindings, Host state, or
  Installation State contents, and never changes state.
- `list projects --json` prints a `schemaVersion: 1` object with the engine
  version and every configured Project Binding's authored Project path,
  canonical path when resolvable, Profile, ordered Hosts, and per-binding
  normalization problem. One invalid Project root does not hide other bindings.
  The command reads no Workspace artifacts, Git state, project output,
  Installation State, or Host capabilities, and never changes state.
- `list profiles --json` prints a `schemaVersion: 1` object with the engine
  version and every valid Profile ID plus its selected Context Module and Skill
  counts, ordered deterministically by Profile ID. It reads the normalized
  selected Workspace only; it does not inspect Project roots, Git state,
  project output, Installation State, or Host capabilities, and never changes
  state.
- `list hosts --json` prints a `schemaVersion: 1` object with the engine version
  and every supported Agent Host in canonical order, including whether
  Temporary Profile Installation is supported. It reads capability constants
  only; it does not inspect PATH, Host versions, configuration, Project roots,
  or project output, and never changes state.
- `list temporary --json` prints a `schemaVersion: 1` object with the engine
  version and active Temporary Profile Installation identities, canonical
  Project paths, Profile IDs, and Hosts. Removed identities and ordinary
  installations are omitted. It reads Installation State only and never runs
  reconciliation or changes state.
- Lifecycle `--json` on `preview`, `apply`, and `status` prints a `schemaVersion: 6`
  object with global Blockers and one deterministic record per Project. Each
  Project record keeps desired identity, state, output operations with consuming
  Hosts, structured warnings with copyable values, Host Setup Steps, Project
  Blockers, and repository-exclusion evidence together. Blockers serialize
  `kind`, `scope`, Project identity when scoped, derived `message`, `problem`,
  `requirement`, `remedy`, and `affectedItems`. Apply keeps an `applied` nested
  snapshot distinct from the freshly verified resulting Project records; failed
  Project transactions also identify the failed and still-pending Projects.
  Blocked `install-temp`/`remove-temp` JSON retains its own versioned structured
  blocker contract. Combined with `--verbose`, machine output wins.
- Exit codes: `0` no tool error and no blockers (JSON `outcome` may still be
  `attention` for pending work), `1` tool error (JSON `outcome: "error"` with
  an `error` string when `--json` was accepted), `2` blockers present.
  Parse stdout as JSON only on exit `0` or `2`, or when exit `1` still emitted
  a JSON object under `--json`.

Launch Antigravity, Codex, Claude, Grok, or Pi from the bound project. For a
non-Git project with Context, use the exact bound root so Codex can discover the
generated project hook and Context. Antigravity receives Context through
always-on `.agents/rules/` files and Skills through `.agents/skills/`.

```sh
apkit bind engineering --host codex
apkit bind engineering ~/projects/x --host antigravity --host codex --host claude --host grok --host pi
apkit unbind ~/projects/x
apkit info
apkit info --json
apkit list
apkit list projects
apkit list projects --json
apkit list profiles
apkit list profiles --json
apkit list hosts
apkit list hosts --json
apkit list temporary
apkit list temporary --json
apkit validate
apkit preview
apkit apply                 # bound Project containing the current directory
apkit apply ~/projects/x    # one explicit bound Project
apkit apply --all           # complete fleet
apkit status
apkit status --all
apkit preview --verbose   # complete reconciliation diagnostics
apkit preview --json      # machine-readable report + uniform exit codes
apkit uninstall
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
Profile, and one or more Hosts (`antigravity`, `codex`, `claude`, `grok`, or
`pi`). Host order and duplicate entries normalize at ingestion. Use `bind` to append one
validated binding, or `unbind` to remove one binding, without reconciling
output; hand-editing `config.yaml` remains supported. `unbind` defaults to the
current working directory and only uses exact authored-path recovery when a
requested project no longer exists. `preview` remains a fleet-wide read-only
plan and leads with a ready-to-apply or cannot-apply outcome. `apply` and
`status` default to the bound Project containing the current directory, accept
one explicit existing absolute or home-relative bound root, and require `--all`
for the complete fleet. A scoped command does not plan, probe, inspect, report,
or write unrelated Projects. `apply` reports the verified resulting state
separately from an Apply Receipt describing the pre-apply work that was
committed; `status` emphasizes selected Profile Installations that need attention.
These default views group details by Profile Installation, list changed file
paths with `+`, `~`, `-`, or `!` markers (capped with an overflow pointer to
`--verbose`), explain non-current Profile Installation states when they appear,
summarize pending Git exclusion work in one clause, keep warnings and blockers
visible, and when useful end with
one next-action instruction (status → read-only preview before apply; ready
fleet preview → `apply --all`; blocked → resolve and retry the same command; current or
completed/no-op results omit a next step). Add `--verbose` to
`preview`, `apply`, or `status` for complete per-output and desired-state
diagnostics, including exact Git exclusion paths, resolved artifact inclusion
reasons, and composed Context.
`uninstall` is different: it names and removes proven generated Profile
Installation output while preserving bindings. A following `status` identifies
that deliberate teardown without treating it as unexplained missing output.

Older version-1 configuration without `workspace` is migration input only. Run
`apkit init` to record the effective Workspace and upgrade it;
`validate`, `preview`, `apply`, `status`, `bind`, and `unbind` fail closed with
that guidance until migration completes. `init` never moves or rewrites the
Workspace source, and a custom authored Workspace path is preserved. `info`
reports `Workspace: Legacy configuration; run apkit init` (and
`configurationState: "legacy"` under `--json`) until that migration completes.

Run `apkit` with no arguments or `apkit --help` for a concise summary of every
command and the minimal `init` → `bind` → `preview` → `apply --all` flow. Focused help
is available as `apkit help <command>`, `apkit <command> -h`, or
`apkit <command> --help`; use `apkit bind --help` to see supported Hosts. Use
`apkit guide profile`, `apkit guide context`, or `apkit guide skill` for a short
copyable example. Run `apkit guide` for the topic index, `apkit guide --full`
for the complete Workspace guide, and `apkit guide --agent` for agent-facing
authoring boundaries.

## Product layout

- `cli/` - the `apkit` command.
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

`apkit init` creates a default Workspace with a schema marker, artifact
directories, a bindable example Profile and Context Module, short human/agent
bootstrap files, and a version-2 configuration that records the default path
when configuration is absent. With an explicit path, it applies the same
scaffold to a missing or empty non-symlink destination, or adopts a valid
existing Workspace without changing its source.
When configuration already selects a Workspace, an explicit path must be an
equivalent canonical alias; `init` never switches the selection. When it finds
supported legacy configuration, it upgrades only the local configuration after
validating the effective target. Current authoring guidance remains
owned by the CLI through its focused `apkit guide <topic>` and complete
`apkit guide --full` forms;
initialization copies only the neutral canonical example, never personal
material.

## Working Principles

This repository favors one canonical home per fact. The open-source repository
owns product behavior; each Workspace owns its user's artifacts; generated
Profile Installations are never edited as sources.
