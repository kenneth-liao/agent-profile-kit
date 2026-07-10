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
artifacts. Later CLI releases add validation and installation support for those
artifact formats. Do not treat generated Host output as source material.

Review personal content before publishing this Workspace. Agent Profile Kit
does not classify private material, and credential values do not belong in a
Workspace regardless of whether you publish it.

For help authoring with an agent, run `agent-profile-kit guide --agent`.
