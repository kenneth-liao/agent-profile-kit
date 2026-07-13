# Agent Profile Kit Workspace guide

Agent Profile Kit keeps your reusable, cross-project agent material in one
Workspace. The Workspace is your canonical source; Profiles select a flat set
of portable artifacts for a kind of work, and Host-specific installations are
generated disposable output.

Keep project facts in the relevant project repository. Keep Host preferences,
authentication, credentials, and machine-specific values outside the
Workspace. Edit Workspace files directly; `agent-profile-kit init` creates an
empty, schema-versioned Workspace at
`~/.agents/agent-profile-kit/workspace/`, the fixed application location.

The current Workspace schema version is 1. Its root `workspace.yaml` contains
only `schema_version: 1`; the `profiles/`, `context/`, `skills/`, `agents/`,
`hooks/`, and `tools/` directories identify the canonical homes for portable
artifacts. Do not treat generated Host output as source material.

The initial Codex project slice supports Context Modules. A Context Module is a
Markdown file under `context/` with frontmatter containing one stable,
lowercase kebab-case `id`; the Markdown body is the Context. A Skill is a
standard Agent Skills package under `skills/`, rooted at `SKILL.md`; its
standard `name` is its stable Artifact ID. The frontmatter needs a lowercase
hyphenated `name` and a non-empty `description`. Scripts, references, and
assets remain ordinary standard Skill content. If a Skill needs Agent Profile
Kit-only metadata, put it in an optional `agent-profile-kit.yaml` sidecar.

Artifacts may declare required Dependencies with explicit typed references. Put
Context Module Dependencies in their frontmatter and Skill Dependencies in each
Skill's Agent Profile Kit sidecar. Each reference contains `type` (`context` or
`skill`) and its stable `id`. Dependencies are resolved transitively and every
resolved reason is retained in the machine-local Installation Manifest. Profiles
selecting Skills, Agents, Hooks, or Tools are rejected by this initial slice.

A Profile is a YAML file under `profiles/` with an `id` and explicit `context`,
`skills`, `agents`, `hooks`, and `tools` arrays. In this initial slice, `agents`,
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
skills: []
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

Run `agent-profile-kit validate`, then review the complete read-only desired
state with `agent-profile-kit preview`. Apply all configured Project Bindings
explicitly with `agent-profile-kit apply`. Ordinary Codex launches from a bound
project receive the generated Context through its native project SessionStart
hook; Agent Profile Kit does not launch Codex or modify global configuration.

Use `agent-profile-kit status` to inspect every bound project. It reports
current, stale source, drifted output, missing output, and malformed ownership.
To delete generated output, use `agent-profile-kit uninstall`; it removes only
Marker- and hash-proven output and preserves the Workspace, Local Configuration,
global Host configuration, and repository-owned files.

Review personal content before publishing this Workspace. Agent Profile Kit
does not classify private material, and credential values do not belong in a
Workspace regardless of whether you publish it.

For help authoring with an agent, run `agent-profile-kit guide --agent`.
