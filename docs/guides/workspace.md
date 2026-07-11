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

The current Codex tracer supports Context Modules, Skills, and Agents. A Context Module is a
Markdown file under `context/` with frontmatter containing one stable,
lowercase kebab-case `id`; the Markdown body is the Context. A Skill is a
standard Agent Skills package under `skills/`, rooted at `SKILL.md`; its
standard `name` is its stable Artifact ID. The frontmatter needs a lowercase
hyphenated `name` and a non-empty `description`. Scripts, references, and
assets remain ordinary standard Skill content. If a Skill needs Agent Profile
Kit-only metadata, put it in an optional `agent-profile-kit.yaml` sidecar.

Artifacts may declare required Dependencies with explicit typed references. Put
Context Module Dependencies in their frontmatter and Skill Dependencies in each
Skill's Agent Profile Kit sidecar, and Agent Dependencies in Agent frontmatter.
Each reference contains `type` (`agent`, `context`, or `skill`) and its stable
`id`. Dependencies are resolved transitively, so a
Profile installs each resolved artifact once; `plan` shows every inclusion
reason and the Installation Manifest records them.

Codex does not yet offer a supported process-scoped Skill discovery path.
Agent Profile Kit therefore transactionally mirrors every valid Workspace
Skill into its dedicated `~/.agents/skills/agent-profile-kit/` Codex Skill
Library. Standard Skill content is copied unchanged; the Agent Profile Kit
sidecar is not copied. Managed launches pass a process-only filter that enables
the Profile's resolved library Skills—its explicit selection plus transitive
Dependencies—and disables the other Agent Profile
Kit-managed library Skills. Ordinary Codex launches can discover the complete
library. Agent Profile Kit never writes Codex configuration or changes existing
user, project, admin, system, or plugin capabilities, and it refuses unowned
library destinations or conflicting existing Skill names.

A portable Agent is a directory under `agents/` rooted at `AGENT.md`. Its
frontmatter declares a stable `id`, a short `description`, optional typed
Dependencies, and required `filesystem`, `network`, and `approval` boundaries.
Its Markdown body is the delegated role. Codex renders each selected or resolved
Agent inside the Profile Installation and rejects planning if it cannot register
that role. The supported requirements are `read-only` or `workspace-write`
filesystem access, `disabled` or `enabled` network access (enabled network
requires `workspace-write`), and `untrusted`, `on-request`, or `never` approval.
No model or other Host preference belongs in an Agent.

A Profile is a YAML file under `profiles/` with an `id` and explicit `context`,
`skills`, `agents`, `hooks`, and `tools` arrays. Hooks and Tools must be empty
in this tracer. Profiles do not inherit, use wildcards, or
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

```markdown
<!-- agents/security-reviewer/AGENT.md -->
---
id: security-reviewer
description: Review changes for security flaws.
execution_requirements:
  filesystem: read-only
  network: disabled
  approval: untrusted
---

# Security reviewer

Inspect proposed changes for security flaws.
```

```md
<!-- skills/review-pr/SKILL.md -->
---
name: review-pr
description: Review a pull request. Use when asked to review code changes.
---

# Review a pull request
```

Run `agent-profile-kit validate`, then preview the generated Context, selected
Skills, and complete Codex Skill Library changes with
`agent-profile-kit plan --profile coding --host codex`. Installation is
explicit: `agent-profile-kit install --profile coding --host codex`. Launch an
installed Profile from the intended project with
`agent-profile-kit run --profile coding --host codex -- <native Codex arguments>`.
The launcher adds the selected Context using Codex's per-process
developer-instructions override, filters only Agent Profile Kit-owned Skills,
and registers only the Profile's resolved Agents from its Profile Installation.
for that process; ordinary global and project Codex configuration and unrelated
Skills remain Host-owned.

Use `agent-profile-kit status --profile coding --host codex` to inspect a
Profile Installation and shared Codex Skill Library. It reports their freshness
and drift separately. Regeneration is always
explicit: `agent-profile-kit update` refreshes every verified installed
Profile/Host pair and never runs during launch. To delete generated output,
use `agent-profile-kit uninstall --profile coding --host codex`; it removes
only Manifest-verified output and removes the shared Skill Library only with the
final installed Codex Profile. Removing that final Profile fails safely while
a managed Codex run is still using a leased Skill generation; retry after the
run exits.

Review personal content before publishing this Workspace. Agent Profile Kit
does not classify private material, and credential values do not belong in a
Workspace regardless of whether you publish it.

For help authoring with an agent, run `agent-profile-kit guide --agent`.
