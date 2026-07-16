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
fixed default path `~/.agents/agent-profile-kit/workspace/` and an empty
machine-local Local Configuration at `~/.agents/agent-profile-kit/config.yaml`
when Local Configuration is absent. Rerunning is safe: it never overwrites
existing Workspace or configuration content, and it does not restore optional
scaffolding that you removed from a valid Workspace.

To keep the Workspace as an independent Git repository elsewhere, set an optional
`workspace` field in Local Configuration to one existing absolute or
home-relative path that already contains a valid `workspace.yaml`:

```yaml
schema_version: 1
workspace: ~/projects/agent-profile-workspace
bindings: []
```

Omitting `workspace` retains the fixed default. Symlinks are supported; relative
paths and wildcards are not. When configuration already selects a custom path,
`init` validates that target and does not create, move, copy, adopt, or repair
it. Changing the path never migrates source automatically.

The current Workspace schema version is 1. Its root `workspace.yaml` contains
only `schema_version: 1`. Local Configuration schema version remains 1 with the
optional `workspace` field.

### CLI compatibility for configurable Workspace path

The optional Local Configuration `workspace` field remains under
`schema_version: 1`, but is understood only by Agent Profile Kit **0.18.0 and
later**. **0.17.x and earlier** reject the unknown field and refuse to load
configuration that uses it.

Removing the field before a downgrade redirects desired-state commands to the
fixed default path (`~/.agents/agent-profile-kit/workspace/`). That can strand
management of Host output that was installed from the custom Workspace while
leaving the custom tree unselected.

Before rolling a machine back to a CLI older than 0.18.0:

1. On **0.18.0+**, reconcile or uninstall with the current configuration so owned
   installations sourced from the custom Workspace are updated or removed while
   the newer CLI still understands the field.
2. If the older CLI must keep managing the same source tree, expose that tree at
   the fixed default path (for example, replace the fixed default with a symlink
   to the custom Workspace—older CLIs already support a symlink there).
3. Remove the `workspace` field from Local Configuration.
4. Confirm `agent-profile-kit validate` succeeds under 0.18+ with the field
   removed (and the fixed default pointing at the intended tree).
5. Only then install the older CLI binary.

Mixed-version consumers cannot share a `config.yaml` that uses the optional
`workspace` field: older engines reject the unknown key. Keep the field only on
machines that have upgraded to 0.18.0+, or use the fixed default (optionally via
symlink) on every machine.

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

This release supports Context Modules and portable Skills for Codex and Claude
Code. Profiles that select Agents, Hooks, or Tools are rejected. A Profile must
select at least one supported artifact overall (Context Module, Skill, or both);
no individual category is mandatory. Context-only, Skills-only, and combined
Profiles are valid.

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

This is the only portable spelling. Claude-native top-level
`disable-model-invocation` and Codex-only `agents/openai.yaml` policy are not
canonical source fields for Agent Profile Kit: migrate Claude-shaped Skills to
the namespaced metadata key above rather than relying on Host-specific
frontmatter. The Installer never rewrites Workspace `SKILL.md` during
validate, preview, or apply.

Adapters translate the trusted policy only in generated Host output:

| Canonical policy | Claude generated output | Codex generated output |
| --- | --- | --- |
| `allowed` (default) | No Host restriction field | No Host restriction field |
| `disabled` | `disable-model-invocation: true` in generated `SKILL.md` | `policy.allow_implicit_invocation: false` in generated `agents/openai.yaml` |

Existing source `agents/openai.yaml` content is preserved. An equivalent
invocation policy coalesces; a conflicting policy fails before any project
write. When any selected Skill disables model invocation, capability preflight
proves each selected Host can enforce it before writes: Claude Code CLI
`2.0.64+` (same floor as unscoped rules and native Skill discovery, which
honors `disable-model-invocation`), and Codex CLI `0.99.0+` (first stable
release with `agents/openai.yaml` `policy.allow_implicit_invocation`; see
openai/codex#11244 / rust-v0.99.0). Unsupported versions fail closed rather
than silently weakening the policy.

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
of supported Hosts (`codex`, `claude`). There are no wildcards, recursive scans,
hidden default projects, Host auto-detection, per-session Profile selection, or
Profile version pins. A project root may appear in only one binding.

Hand-edit `config.yaml`, or record one binding with the authoring-only command
(does not install or reconcile project output):

```sh
agent-profile-kit bind coding --host codex
agent-profile-kit bind coding ~/projects/tools/agent-profile-kit --host codex --host claude
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

For Codex bindings that select Context, explicitly enable lifecycle hooks in
global or project Codex configuration before `preview` or `apply`. Agent Profile
Kit checks this during preflight and rejects reconciliation when hooks are
disabled or unset. Skills-only Codex bindings do not require hooks:

```toml
[features]
hooks = true
```

Run `agent-profile-kit validate` to check the Workspace and every Project Binding.
Review the complete read-only desired state with `agent-profile-kit preview`.
Apply all configured Project Bindings with `agent-profile-kit apply`. These
commands operate on the full binding set; they do not filter by Profile, Host, or
project.

Git is optional. For a Git binding, `apply` installs into the corresponding
project directory of every existing worktree. A worktree created later is
reported missing until the next explicit `apply`.

Generated output is owned whole: complete files and artifact directories whose
Installation Marker and hashes prove Agent Profile Kit ownership. Unrelated project files,
repository-owned instructions, global Host configuration, authentication, trust,
approvals, plugins, and sessions remain untouched. Agent Profile Kit does not
merge selected fields into Host or repository configuration, install a watcher or
Git hook, or modify shared `.gitignore` files.

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

### Global Skills vs project-bound Profiles

This section is the Host-path detail for the
[Universal Workspace material](#universal-workspace-material) boundary.

Agent Profile Kit installs selected Skills only into the bound **project**
(`.agents/skills/<Artifact ID>/` for Codex, `.claude/skills/<Artifact ID>/` for
Claude). It never installs into, adopts, disables, or removes personal/global
Host Skill folders. Unselected Workspace Skills are not installed into projects
either; they may remain valid Workspace source without any APK-managed delivery.

Those global folders remain Host-owned:

- Codex: `~/.agents/skills/` and `~/.codex/skills/`
- Claude Code: `~/.claude/skills/`

If a selected Skill’s Host-visible identity already exists in a selected Host’s
global folder, `preview` and `apply` fail closed before any project write
([#53](https://github.com/kenneth-liao/agent-profile-kit/issues/53)). The blocker
names the Host, Artifact ID, global path, and proposed project path, and asks you
to remove or relocate the unmanaged global copy first (or deselect the Skill
from the Profile). Missing global roots are fine. Unrelated global Skills are
fine. Identical bytes and symlinks from a global folder into the Workspace still
block, because the Host would see global delivery in addition to or instead of
the managed project snapshot.

When migrating from temporary global symlinks into project-bound delivery: keep
the reusable material in the Workspace as its single canonical source, remove the
unmanaged global delivery for Skills you will select into a Profile, then
`apply` so only the project-bound Profile Installation remains. If you prefer
user-managed global delivery for a Skill instead, leave it unselected by every
bound Profile so APK never attempts a project snapshot for that identity.

Claude personal Skills override project Skills by name. Codex can expose both
global and project Skills with the same name. Agent Profile Kit therefore treats
any selected global/project identity collision as a conflict rather than an
implicit precedence rule.

## Status, unbind, and uninstall

Use `agent-profile-kit status` to inspect every bound project. It reports current,
stale source, drifted output, missing output, blocked (including later global
Skill identity collisions), and malformed ownership.

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
