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

The current tracer supports Context-only Codex Profiles. A Context Module is a
Markdown file under `context/` with frontmatter containing one stable,
lowercase kebab-case `id`; the Markdown body is the Context. A Profile is a
YAML file under `profiles/` with an `id` and explicit `context`, `skills`,
`agents`, `hooks`, and `tools` arrays. In this tracer, `skills`, `agents`,
`hooks`, and `tools` must be empty. Profiles do not inherit, use wildcards, or
carry Host settings.

```md
---
id: engineering-rules
---
Keep project facts in the project repository.
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

Run `agent-profile-kit validate`, then preview the generated Context with
`agent-profile-kit plan --profile coding --host codex`. Installation is
explicit: `agent-profile-kit install --profile coding --host codex`. Launch an
installed Profile from the intended project with
`agent-profile-kit run --profile coding --host codex -- <native Codex arguments>`.
The launcher adds only the selected Context using Codex's per-process
developer-instructions override; ordinary global and project Codex configuration
remains Host-owned.

Review personal content before publishing this Workspace. Agent Profile Kit
does not classify private material, and credential values do not belong in a
Workspace regardless of whether you publish it.

For help authoring with an agent, run `agent-profile-kit guide --agent`.
