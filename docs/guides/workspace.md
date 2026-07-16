# Agent Profile Kit Workspace guide

Agent Profile Kit keeps your reusable, cross-project agent material in one
Workspace. The Workspace is the canonical source. Profiles select a flat set of
portable artifacts for a kind of work. The Installer installs each bound Profile
into explicitly bound projects as disposable, Host-native output. Supported Hosts
then load that material through ordinary project discovery.

Keep project facts in the relevant project repository. Keep Host preferences,
authentication, credentials, and machine-specific values outside the Workspace.
Edit Workspace files and Local Configuration directly.

## Initialize

`agent-profile-kit init` creates an empty, schema-versioned Workspace at
`~/.agents/agent-profile-kit/workspace/` and an empty machine-local Local
Configuration at `~/.agents/agent-profile-kit/config.yaml` when either is missing.
Rerunning is safe: it never overwrites existing Workspace or configuration
content, and it does not restore optional scaffolding that you removed from a
valid Workspace.

The current Workspace schema version is 1. Its root `workspace.yaml` contains
only `schema_version: 1`.

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
Code. Profiles that select Agents, Hooks, or Tools are rejected.

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
`hooks`, and `tools` must be empty. Profiles do not inherit, use wildcards, or
carry Host settings.

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
hidden default projects, per-session Profile selection, or Profile version pins.
A project root may appear in only one binding.

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

For Codex bindings, explicitly enable lifecycle hooks in global or project Codex
configuration before `preview` or `apply`. Agent Profile Kit checks this during
preflight and rejects reconciliation when hooks are disabled or unset:

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

Agent Profile Kit installs selected Skills only into the bound **project**
(`.agents/skills/<Artifact ID>/` for Codex, `.claude/skills/<Artifact ID>/` for
Claude). It never installs into, adopts, disables, or removes personal/global
Host Skill folders.

Those global folders remain Host-owned:

- Codex: `~/.agents/skills/` and `~/.codex/skills/`
- Claude Code: `~/.claude/skills/`

If a selected Skill’s Host-visible identity already exists in a selected Host’s
global folder, `preview` and `apply` fail closed before any project write. The
blocker names the Host, Artifact ID, global path, and proposed project path, and
asks you to remove or relocate the unmanaged global copy first. Missing global
roots are fine. Unrelated global Skills are fine. Identical bytes and symlinks
from a global folder into the Workspace still block, because the Host would see
global delivery in addition to or instead of the managed project snapshot.

This matters when migrating from temporary global symlinks: move reusable
material into the Workspace as canonical source, remove the unmanaged global
delivery, then `apply` so only the project-bound Profile Installation remains.

Claude personal Skills override project Skills by name. Codex can expose both
global and project Skills with the same name. Agent Profile Kit therefore treats
any selected global/project identity collision as a conflict rather than an
implicit precedence rule.

## Status and uninstall

Use `agent-profile-kit status` to inspect every bound project. It reports current,
stale source, drifted output, missing output, blocked (including later global
Skill identity collisions), and malformed ownership.

To delete generated output, use `agent-profile-kit uninstall`. It removes only
Installation Marker- and hash-proven output and preserves the Workspace, Local
Configuration, global Host configuration, and repository-owned files.

Review personal content before publishing this Workspace. Agent Profile Kit does
not classify private material, and credential values do not belong in a Workspace
regardless of whether you publish it.

For help authoring with an agent, run `agent-profile-kit guide --agent`.
