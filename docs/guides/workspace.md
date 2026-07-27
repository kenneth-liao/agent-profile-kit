# Agent Profile Kit Workspace guide

Agent Profile Kit keeps your reusable, cross-project agent material in one
Workspace. The Workspace is the single canonical source. Profiles select a flat
set of portable artifacts for a kind of work. The Installer installs each bound
Profile into explicitly bound projects as disposable, Host-native output.
Supported Hosts then load that material through ordinary project discovery.

Keep project facts in the relevant project repository. Keep Host preferences,
authentication, credentials, and machine-specific values outside the Workspace.
Edit Workspace files and Local Configuration directly.

## Universal Workspace material

Source ownership and managed delivery are separate:

- The **Workspace** may canonically own both Profile-selected artifacts and
  **unselected universal** artifacts (material useful across every directory or
  kind of work, not only one Profile’s selection). Leaving an artifact unselected
  by every Profile does not make it invalid and does not move its canonical
  source into Host configuration.
- **Profiles** select the artifacts scoped to a kind of work for Agent Profile
  Kit–managed project-bound delivery. A Project Binding selects a project root,
  one Profile, and Hosts; only selected (and Dependency-resolved) artifacts from
  that Profile enter Installation Manifests and the managed lifecycle
  (`preview`, `apply`, `status`, and `uninstall`).
- Agent Profile Kit v1 does not install, project, synchronize, or remove material in
  personal/global Host roots. Global Host delivery is not APK-owned state: it is
  outside Project Bindings and Installation Manifests, and `apply` / `uninstall`
  never adopt, record as managed output, or mutate those paths. `status` does not
  treat global roots as managed output, but it may still report a project
  installation as blocked when a selected Skill’s Host-visible identity collides
  with personal or global delivery (see
  [#53](https://github.com/kenneth-liao/agent-profile-kit/issues/53)).
- You may still manage native global delivery yourself—for example by symlinking
  a Host Skill root entry to canonical Workspace source—but that delivery is
  user-managed Host configuration, not Agent Profile Kit–owned state. Agent
  Profile Kit never adopts, tracks, or uninstalls those global paths.
- A Skill must not be both universally delivered in a Host global root and
  selected into a bound Profile for that Host. When a selected Skill’s
  Host-visible identity already exists in a selected Host’s personal/global Skill
  root, `preview` and `apply` fail closed (see
  [#53](https://github.com/kenneth-liao/agent-profile-kit/issues/53)). Prefer one
  delivery path: either project-bound Profile selection or user-managed global
  delivery, not both.

Future Agent Profile Kit–managed global delivery would need an explicit ADR that
revisits the no-global-output boundary. Closing this guidance does not put that
feature on the backlog.

## Initialize

`agent-profile-kit init` creates an empty, schema-versioned Workspace at the
fixed default path `~/.agents/agent-profile-kit/workspace/` and a version-2
machine-local Local Configuration at `~/.agents/agent-profile-kit/config.yaml`
that explicitly records that path when Local Configuration is absent. Pass one
explicit absolute or home-relative path to choose another destination:

```sh
agent-profile-kit init ~/projects/agent-profile-workspace
```

When Local Configuration is absent, an explicit missing or empty non-symlink
destination is fully scaffolded and recorded. A valid existing Workspace,
including a symlink alias, is adopted without changing its source. Rerunning is
safe: it never overwrites the Workspace or current configuration, and it does
not restore optional scaffolding that you removed from a valid Workspace.

To keep the Workspace as an independent Git repository elsewhere, set the
required `workspace` field in Local Configuration to one existing absolute or
home-relative path that already contains a valid `workspace.yaml`:

```yaml
schema_version: 2
workspace: ~/projects/agent-profile-workspace
bindings: []
```

Symlinks are supported; relative paths and wildcards are not. When Local
Configuration already selects a Workspace, an explicit `init <workspace>` path
must resolve to that same canonical directory, including through an alias;
otherwise initialization fails closed without changing either source or
configuration. Zero-argument `init` validates the selected custom path and does
not create, move, copy, adopt, or repair it. Initialization never migrates
Workspace source automatically.

The current Workspace schema version is 1. Its root `workspace.yaml` contains
only `schema_version: 1`. Local Configuration schema version is 2 and its
`workspace` field is required.

### Legacy Local Configuration migration and version compatibility

Version-1 Local Configuration without `workspace` is supported only as migration
input. Run `agent-profile-kit init` to upgrade it before using `validate`,
`preview`, `apply`, `status`, `bind`, or `unbind`. Those commands never migrate
the file implicitly: they fail closed with actionable `agent-profile-kit init`
guidance while leaving migration to the explicit `init` command.

For a legacy file that omitted `workspace`, migration records the conventional
default `~/.agents/agent-profile-kit/workspace/`. For a legacy file with an
authored path, migration preserves that path. `init` validates the selected
Workspace before atomically replacing only Local Configuration, preserving
Project Bindings, comments, line endings, and file mode; it never moves or
rewrites Workspace source. If validation fails, the configuration remains
unchanged.

Before migrating, make and retain a copy of the version-1 Local Configuration:

```sh
config_dir="$HOME/.agents/agent-profile-kit"
cp -p "$config_dir/config.yaml" "$config_dir/config.yaml.before-schema-v2"
```

Keep this backup until the current CLI has been validated in normal use.
Rollback is unsupported without it. To use the immediately previous CLI release
(0.20.x), stop using the current CLI, restore the copy, and then run that older
binary:

```sh
config_dir="$HOME/.agents/agent-profile-kit"
cp -p "$config_dir/config.yaml.before-schema-v2" "$config_dir/config.yaml"
agent-profile-kit validate
```

The restored file preserves the pre-migration Workspace selection and Project
Bindings. This reverses only the Local Configuration schema transition; it does
not undo later Workspace content changes. Do not hand-edit a version-2 file's
schema marker while relying on an older binary to preserve it.

Older engine versions that understand only Local Configuration schema version 1
are not compatible with the migrated version-2 file. Before rolling back to
one, use the backup procedure above and ensure the effective Workspace is
available at the expected path.

Mixed-version consumers cannot share a migrated `config.yaml`: older engines
reject the version-2 schema. Keep the migrated file with current binaries, or
coordinate an explicit rollback using the retained pre-migration version-1
configuration.

### Required structure vs initialization scaffolding

A valid Workspace needs only a supported `workspace.yaml`. That Manifest is the
Workspace marker. Missing artifact directories are treated as empty categories;
present ones are validated and ingested normally. `README.md`, `AGENTS.md`, and
`.gitignore` are optional user-owned files that the engine never requires.

When creating a **new** Workspace, `init` still scaffolds a friendly layout so
you can discover where material belongs:

- artifact directories `profiles/`, `context/`, `skills/`, `agents/`, `hooks/`,
  and `tools/` (with `.gitkeep` placeholders)
- short bootstrap `README.md` and `AGENTS.md` pointers to the current guides
- a starter `.gitignore`

Those scaffolded entries are for discoverability only. Delete unused empty
directories or bootstrap docs if you prefer a minimal tree; validation, preview,
status, apply, and uninstall keep working. Do not treat generated Host output as
source material.

### CLI compatibility for minimal Workspaces

Optional scaffolding is a **CLI** behavior change, not a change to the Workspace
Manifest schema (`schema_version` remains `1`). Agent Profile Kit **0.16.1 and
later** accept Manifest-only and partial category layouts (with present category
paths, including symlinks, required to resolve to directories). **0.15.x and
earlier** still require every artifact directory plus `README.md`, `AGENTS.md`,
and `.gitignore`.

Before rolling a machine back to a CLI older than 0.16.1, restore a full layout
so the older tool can validate the Workspace:

1. Ensure `workspace.yaml` still contains `schema_version: 1`.
2. Recreate any missing category directories: `profiles/`, `context/`,
   `skills/`, `agents/`, `hooks/`, and `tools/` (empty directories are enough;
   `.gitkeep` is optional).
3. Restore any missing bootstrap files the older release required:
   `README.md`, `AGENTS.md`, and `.gitignore`.

A mixed-version environment (some machines on 0.16.1+, others on 0.15 or older)
is safe only when every shared Workspace still includes that full layout, or
when every consumer has upgraded to 0.16.1+.

## Author the Workspace

This release supports Context Modules and portable Skills for Codex, Claude
Code, and Grok. Profiles that select Agents, Hooks, or Tools are rejected. A
Profile must select at least one supported artifact overall (Context Module,
Skill, or both); no individual category is mandatory. Context-only, Skills-only,
and combined Profiles are valid.

A Context Module is a Markdown file under `context/` with frontmatter containing
one stable, lowercase kebab-case `id`; the Markdown body is the Context. A Skill
is a standard Agent Skills package under `skills/`, rooted at `SKILL.md`; its
standard `name` is its stable Artifact ID. The frontmatter needs a lowercase
hyphenated `name` and a non-empty `description`. Scripts, references, and assets
remain ordinary standard Skill content. If a Skill needs Agent Profile Kit-only
dependency metadata, put it in an optional `agent-profile-kit.yaml` sidecar.

### Skill model-invocation policy

By default, Hosts may invoke a Skill implicitly when the model matches its
description. To require explicit user invocation while keeping the Skill
available on request, set optional standard namespaced metadata:

```yaml
metadata:
  agent-profile-kit.model-invocation: disabled
```

Accepted values are the strings `allowed` and `disabled`. Absence normalizes to
`allowed`. Invalid types or values fail at Workspace ingestion.

This is the only portable spelling. Host-native top-level
`disable-model-invocation` and Codex-only `agents/openai.yaml` policy are not
canonical source fields for Agent Profile Kit: migrate Host-shaped Skills to
the namespaced metadata key above rather than relying on Host-specific
frontmatter. The Installer never rewrites Workspace `SKILL.md` during
validate, preview, or apply.

Adapters translate the trusted policy only in generated Host output:

| Canonical policy | Claude / Grok generated output | Codex generated output |
| --- | --- | --- |
| `allowed` (default) | No Host restriction field | No Host restriction field |
| `disabled` | `disable-model-invocation: true` in generated `SKILL.md` | `policy.allow_implicit_invocation: false` in generated `agents/openai.yaml` |

Existing source `agents/openai.yaml` content is preserved. An equivalent
invocation policy coalesces; a conflicting policy fails before any project
write. When any selected Skill disables model invocation, capability preflight
proves each selected Host can enforce it before writes: Claude Code CLI
`2.0.64+` (same floor as unscoped rules and native Skill discovery, which
honors `disable-model-invocation`), Grok CLI `0.2.0+` (same floor as project
rules and native Skill discovery, which honors `disable-model-invocation`),
and Codex CLI `0.99.0+` (first stable release with `agents/openai.yaml`
`policy.allow_implicit_invocation`; see openai/codex#11244 / rust-v0.99.0).
Unsupported versions fail closed rather than silently weakening the policy.

Artifacts may declare required Dependencies with explicit typed references. Put
Context Module Dependencies in their frontmatter and Skill Dependencies in each
Skill's Agent Profile Kit sidecar. Each reference contains `type` (`context` or
`skill`) and its stable `id`. Dependencies are resolved transitively and every
resolved reason is retained in preview and the machine-local Installation
Manifest.

A Profile is a YAML file under `profiles/` with an `id` and explicit `context`,
`skills`, `agents`, `hooks`, and `tools` arrays. In this release `agents`,
`hooks`, and `tools` must be empty. At least one of `context` or `skills` must
be non-empty. A Skills-only Profile installs only selected Skill packages and
Installer lifecycle metadata—no Context snapshot, Codex SessionStart hooks, or
Claude Context rule. Host capability preflight follows the selected categories
(Skills-only does not require Context machinery). Profiles do not inherit, use
wildcards, or carry Host settings.

### CLI compatibility for Skills-only Profiles

Skills-only Profiles remain under Workspace `schema_version: 1`, but the shape is
accepted only by Agent Profile Kit **0.17.0 and later**. **0.16.x and earlier**
still require every Profile to select at least one Context Module and reject
Skills-only Profiles at Workspace ingestion. A binary rollback onto a Workspace
that still contains Skills-only Profiles makes normal validate/preview/apply/
status fail at ingestion and can leave previously installed Host-native Skills
stranded until source is converted or the install is cleaned with a 0.17+ CLI.

Before rolling a machine back to a CLI older than 0.17.0:

1. On **0.17.0+**, either convert each Skills-only Profile so `context` selects
   at least one Context Module, or temporarily remove Project Bindings that use
   those Profiles and run `apply` / `uninstall` so owned Skill packages and
   installation metadata are removed while the newer CLI still understands them.
2. Confirm `agent-profile-kit validate` succeeds after the conversion or cleanup.
3. Only then install the older CLI binary.

A mixed-version environment is safe only when every shared Workspace Profile
still selects at least one Context Module, or when every consumer has upgraded
to 0.17.0+.

```md
---
id: engineering-rules
dependencies:
  - type: context
    id: security-rules
---
Keep project facts in the project repository.
```

```yaml
# skills/review-pr/agent-profile-kit.yaml
dependencies:
  - type: skill
    id: write-release-notes
```

```yaml
id: coding
context:
  - engineering-rules
skills:
  - review-pr
agents: []
hooks: []
tools: []
```

```md
<!-- skills/review-pr/SKILL.md -->
---
name: review-pr
description: Review a pull request. Use when asked to review code changes.
---

# Review a pull request
```

```md
<!-- skills/to-spec/SKILL.md — explicit-only invocation -->
---
name: to-spec
description: Turn the current conversation into a spec.
metadata:
  agent-profile-kit.model-invocation: disabled
---

# To spec
```

## Bind projects in Local Configuration

Project Bindings live only in machine-local
`~/.agents/agent-profile-kit/config.yaml`. Each binding names exactly one
existing absolute or home-relative project root, one Profile, and a non-empty set
of supported Hosts (`codex`, `claude`, `grok`). There are no wildcards, recursive scans,
hidden default projects, Host auto-detection, per-session Profile selection, or
Profile version pins. A project root may appear in only one binding.

Hand-edit `config.yaml`, or record one binding with the authoring-only command
(does not install or reconcile project output):

```sh
agent-profile-kit bind coding --host codex
agent-profile-kit bind coding ~/projects/tools/agent-profile-kit --host codex --host claude --host grok
```

Omit the project argument to use the current working directory. At least one
`--host` flag is required. An identical binding is left unchanged; a different
Profile or Host set for the same project fails instead of overwriting. Do not
hand-edit `config.yaml` while `bind` is running: `bind` commands serialize with
each other, but a text editor does not participate in that lock. After binding,
run `validate`, then `preview` and `apply` separately.

Remove desired state with the recording-only command:

```sh
agent-profile-kit unbind
agent-profile-kit unbind ~/projects/tools/agent-profile-kit
```

Omitting the project targets the canonical current working directory. Existing
paths use the same canonical-root rules as bindings, including symlink aliases.
When a project no longer exists, `unbind` can remove a binding only when the
argument exactly matches its authored `project` spelling; it never guesses an
alias. `unbind` edits Local Configuration only and leaves generated output for
the next global `preview` and `apply`. Cooperating `bind` and `unbind` commands
serialize and publish atomically; do not hand-edit the file concurrently.

```yaml
schema_version: 1
bindings:
  - project: ~/projects/tools/agent-profile-kit
    profile: coding
    hosts:
      - codex
      - claude
  - project: /Users/you/work/customer-portal
    profile: coding
    hosts:
      - claude
```

## Validate, preview, and apply

For Codex bindings that select Context, review and trust the generated project
SessionStart hook in Codex for each bound project. Lifecycle hooks are enabled by
default. Agent Profile Kit checks the effective global and project configuration
during preflight and rejects reconciliation only when hooks are explicitly
disabled. Project configuration takes precedence over global configuration, and
the deprecated `codex_hooks` alias remains supported. Skills-only Codex bindings
do not require hooks.

Run `agent-profile-kit validate` to check the Workspace and every Project Binding.
Review the concise read-only reconciliation outcome with
`agent-profile-kit preview`. It leads with whether reconciliation can proceed,
groups changes and blockers by Profile Installation, and summarizes
generated-output additions, updates, repairs, removals, and drift without
listing every unchanged output. Non-current Profile Installation states such as
`stale source`, `blocked`, or `removal` get a short explanation when present
(once per distinct state across installations). Repository Exclusion deltas are
Git-local exclusions that keep Installer-owned generated paths untracked; the
exact exclusion target and added or removed paths remain listed. When action is
useful, concise results end with one next-action line derived from the same
attention surface as the report body: actionable `status` points to read-only
`preview` before `apply`; a ready `preview` recommends `apply`; a blocked result
tells you to resolve the reported blocker and retry the same command you just
ran; current status and completed or no-op `apply` results omit a next step.
Multi-project outcomes emit one conservative instruction for the aggregate. Apply all configured Project Bindings with
`agent-profile-kit apply`; its result describes what reconciliation completed.
Use `agent-profile-kit status` to focus on installations needing attention.
These commands operate on the full binding set; they do not filter by Profile,
Host, or project.

For complete per-output and desired-state diagnostics, including resolved
artifact inclusion reasons and composed Context, append `--verbose` to
`preview`, `apply`, or `status`. Warnings, blockers, drift reasons, and removal
intent remain visible in the concise view. Git-tracked-path blockers explain
that repository-owned content is not replaced because generated Profile
Installation output must be exclusively Installer-owned.

Git is optional. For a Git binding, `apply` installs only into the exact bound
project directory. The Installer uses Git for tracked-path protection and local
exclusions but does not inspect or report worktree topology. Bind any additional
root explicitly only when Hosts must be launched directly from that root; it
then follows the same lifecycle as any other binding.

For every bound project root, the ordinary removal order is:

```sh
agent-profile-kit unbind /path/to/project
agent-profile-kit apply
# Now delete the project directory.
```

If the project directory was deleted first, run `unbind` with its exact authored
path. That explicit action confirms the deletion was intentional; the next
`apply` retires its machine-local installation record without attempting
project filesystem deletion and cleans any separately surviving local Git
exclusions whose ownership was recorded. Restoring the project later requires a
new `bind` and `apply`.

Pre-release installations created by older development builds that expanded a
binding across worktrees are reset and reapplied; the CLI carries no migration
or compatibility workflow for that development-only state.

Generated output is owned whole: complete files and artifact directories whose
Installation Marker and hashes prove Agent Profile Kit ownership. Unrelated project files,
repository-owned instructions, global Host configuration, authentication, trust,
approvals, plugins, and sessions remain untouched. Agent Profile Kit does not
merge selected fields into Host or repository configuration, install a watcher or
Git hook, or modify shared `.gitignore` files.

For a currently bound installation with a matching Marker, `apply` recreates a
recorded output that is completely missing when all surviving owned output is
unchanged and normal path-conflict checks pass. Existing modified output and
unexpected directory members remain blockers and are never overwritten.

## Use Hosts natively

After `apply`, launch Codex or Claude Code from the bound project the way you
normally would. Agent Profile Kit does not launch Hosts or manage their
authentication, trust, approvals, plugins, or sessions.

### Codex

Codex receives Profile Context through a native project SessionStart hook and
discovers selected Skills under `.agents/skills/<Artifact ID>/`. Before launching
Codex, trust each bound project in Codex — project trust is Host-owned and is not
configured by Agent Profile Kit. Ordinary launches from a Git project's bound
directory or its descendants receive that material. For a non-Git project, launch
Codex from the exact bound root; launching from a descendant is outside the
support guarantee.

### Claude Code

Claude Code receives Profile Context as an unscoped owned project rule under
`.claude/rules/` and discovers selected Skills under
`.claude/skills/<Artifact ID>/`. Ordinary Claude launches in the bound project
load that material. Claude project rules do not depend on Git.

### Precedence and conflicts

Repository-owned project instructions take precedence over Profile Context on
conflict. Agent Profile Kit does not detect or resolve contradictions in prose;
conflicting guidance remains visible to you and the Host. Global Host
configuration and repository-owned files stay live and unchanged.

### Installation State compatibility and recovery

Agent Profile Kit 0.24.x reads the previous schema-2 machine-local Installation
State and synthesizes Repository Exclusion Records at the state boundary. The
read is non-mutating: `preview` and `status` do not rewrite the file. The first
successful `apply` or `uninstall` publishes schema 3, which older 0.23.x
engines cannot read. Before upgrading, keep a copy of the state file if a
downgrade may be needed:

```sh
state_dir="$HOME/.agents/agent-profile-kit/state"
cp -p "$state_dir/manifest.yaml" "$state_dir/manifest.yaml.before-schema-v3"
```

Agent Profile Kit 0.24.2 also records the installation-time `git_project`
classification in each Installation Manifest without changing the Manifest
schema version. It reads older Manifests that omit this field, but older
engines reject a Manifest written with it because they require exact fields.
Before the first 0.24.2 `apply`, keep a second state backup for rollback:

```sh
cp -p "$state_dir/manifest.yaml" "$state_dir/manifest.yaml.before-0.24.2"
```

If rollback is needed after a 0.24.2 `apply`, stop using the newer CLI, restore
`manifest.yaml.before-0.24.2` to `manifest.yaml`, and then use the older binary.
The backup restores machine-local ownership state; it does not undo Workspace
source or project-file changes made after the backup.

For installations created before 0.24.2, run one live `agent-profile-kit apply`
while each bound project root still exists. This records `git_project: false`
for non-Git installations. Without that classification, deleting a non-Git
root before `unbind` leaves no durable proof that its missing exclusion record
was unnecessary, so intentional-deletion retirement fails closed.

If the current state file is missing or malformed, do not delete or adopt
surviving generated files. Restore the backup and retry. Without a backup,
stop the CLI and manually remove only the verified Installer-owned project
outputs and `.agent-profile-kit/installation.json` Markers, then remove only
the marked block between `# BEGIN Agent Profile Kit generated paths` and
`# END Agent Profile Kit generated paths` in each affected `.git/info/exclude`.
Keep every unrelated exclusion byte. Recreate the desired Project Bindings and
run `agent-profile-kit apply` to establish fresh v3 ownership records. A wiped
state cannot safely be reconstructed from output bytes alone.

### Global Skills vs project-bound Profiles

This section is the Host-path detail for the
[Universal Workspace material](#universal-workspace-material) boundary.

Agent Profile Kit installs selected Skills only into the bound **project**
(`.agents/skills/<Artifact ID>/` for Codex, `.claude/skills/<Artifact ID>/` for
Claude, `.grok/skills/<Artifact ID>/` for Grok). It never installs into, adopts,
disables, or removes personal/global Host Skill folders. Unselected Workspace
Skills are not installed into projects either; they may remain valid Workspace
source without any APK-managed delivery.

Those global folders remain Host-owned:

- Codex: `~/.agents/skills/` and `~/.codex/skills/`
- Claude Code: `~/.claude/skills/`
- Grok: `~/.grok/skills/` (plus enabled compatibility roots and configured
  `[skills].paths`; see `grok inspect`)

If a selected Skill’s Host-visible identity already exists in a selected Host’s
global folder, `preview` and `apply` fail closed before any project write
([#53](https://github.com/kenneth-liao/agent-profile-kit/issues/53),
[#87](https://github.com/kenneth-liao/agent-profile-kit/issues/87)). The blocker
names the Host, Artifact ID, conflicting evidence, and asks you to remove or
relocate the unmanaged copy first (or deselect the Skill from the Profile).
Missing global roots are fine. Unrelated global Skills are fine. Identical bytes
and symlinks from a global folder into the Workspace still block, because the
Host would see global delivery in addition to or instead of the managed project
snapshot.

When migrating from temporary global symlinks into project-bound delivery: keep
the reusable material in the Workspace as its single canonical source, remove the
unmanaged global delivery for Skills you will select into a Profile, then
`apply` so only the project-bound Profile Installation remains. If you prefer
user-managed global delivery for a Skill instead, leave it unselected by every
bound Profile so APK never attempts a project snapshot for that identity.

Claude personal Skills override project Skills by name. Codex can expose both
global and project Skills with the same name. Grok deduplicates by name across
native, personal, plugin, and compatibility roots. Agent Profile Kit therefore
treats any selected global/project identity collision as a conflict rather than
an implicit precedence rule.

## Status, unbind, and uninstall

Use `agent-profile-kit status` to inspect every bound project. It reports current,
stale source, repairable missing output, drifted output, missing output, blocked
(including later global Skill identity collisions), and malformed ownership.

Use `agent-profile-kit unbind [project]` to remove desired Project Binding state.
It does not delete generated output. Run the global `preview` and `apply` to
review and reconcile the former installation.

To delete generated output directly, use `agent-profile-kit uninstall`. It
removes only Installation Marker- and hash-proven output and preserves the
Workspace and Local Configuration, including Project Bindings. `unbind` changes
desired state; `uninstall` removes proven output. Neither command modifies
personal/global Host configuration or repository-owned files.

Review personal content before publishing this Workspace. Agent Profile Kit does
not classify private material, and credential values do not belong in a Workspace
regardless of whether you publish it.

For help authoring with an agent, run `agent-profile-kit guide --agent`.
