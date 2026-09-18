# The Agent Profile Kit Workspace contract

The Workspace is the single canonical source Agent Profile Kit installs from:
plain files you own in one folder. This document is the complete contract for
that folder — every rule below is enforced by Workspace validation, and every
rule Workspace validation enforces is stated here. Read it before building a
Workspace so you or your agent can author valid material first, without
installing apkit.

View this contract any time with `apkit guide --contract`. For authoring
workflows and Host delivery behavior, see the complete Workspace guide
(`apkit guide --full`).

## Workspace structure

A Workspace is a folder containing a `workspace.yaml` Manifest and the three
artifact folders `context/`, `skills/`, and `profiles/`. `apkit init <path>`
adds exactly these parts, and nothing else, to a folder you name.

- A Workspace root must contain a `workspace.yaml` file, and
  `workspace.yaml` must be a file, not a folder.
- `workspace.yaml` must be valid YAML, and it must declare
  `schema_version: 1`. The current Workspace schema version is 1; other
  versions are not supported. `schema_version` must be a positive integer,
  and `workspace.yaml` contains only `schema_version` — no other fields.
- `context/`, `skills/`, and `profiles/` must be directories, not files.
  Each must be a real directory: a dangling symlink is invalid.
- A missing artifact folder is treated as an empty collection.
- Hidden files and folders — names starting with `.` — are ignored
  everywhere: validation never reports them and never looks inside them.
- Every non-hidden entry under the artifact folders must be a real file or
  directory: a symlink is a violation, because validation never follows
  links.
- Empty folders violate nothing: the rules below bind files.

## Context Modules

- Every `.md` file under `context/`, at any depth, is a Context Module.
- Under `context/`, every non-hidden file must be Markdown (`.md`) — anything
  else is a violation. Give the file a `.md` extension or move it out of
  `context/`.
- A Context Module's ID is its path under `context/` without `.md`, with `/`
  between folders (for example `engineering/review-findings`). Moving or
  renaming the file changes its ID by design.
- Every folder and file name under `context/` must be a lowercase kebab-case
  name, because together they form the Context Module ID.
- A Context Module file must not be empty.
- apkit reads no Context frontmatter and requires none: each file's bytes are
  delivered as written, after the generated Context header, so frontmatter
  keys such as `id` or `dependencies` have no effect.

## Skills

A Skill is a standard Agent Skills package: a folder under `skills/` (folders
may group packages) rooted at a `SKILL.md` file. Supporting scripts,
references, and assets stay ordinary package files.

- Under `skills/`, every non-hidden file must belong to a Skill package (a
  folder with a `SKILL.md`); folders may group Skill packages. A file outside
  a Skill package is a violation — move it into a package as a Skill
  Resource, give it its own package, or move it out of `skills/`.

- A Skill's `SKILL.md` must open with YAML frontmatter, and it must close its
  YAML frontmatter. Profile files are YAML mappings, and `SKILL.md`
  frontmatter is a YAML mapping. Profile files and `SKILL.md` frontmatter
  must be valid YAML.
- The frontmatter requires a `name` and a `description`. Required Skill
  fields must be non-empty strings within the Agent Skills length limits:
  `name` at most 64 characters, `description` at most 1024. The `name` is the
  Skill's ID, and it is stable: Artifact IDs are lowercase kebab-case names:
  lowercase letters and digits joined by single hyphens.
- Optional top-level fields keep their standard types when present:
  `license` and `allowed-tools` must be strings, `compatibility` must be a
  string of at most 500 characters, and `metadata`, when present, must be a
  YAML mapping.
- Two Skill packages must not declare the same `name`.
- By default, a Host may invoke a Skill when the model matches its
  description. To require explicit invocation instead, set the standard
  top-level field `disable-model-invocation: true` in `SKILL.md`.
  `disable-model-invocation` must be a boolean: `true` disables model
  invocation; absent or `false` allows it.
- The retired `metadata.agent-profile-kit.model-invocation` key is a
  violation; the standard top-level `disable-model-invocation` field is its
  replacement.
- Other top-level frontmatter fields beyond those apkit reads are accepted
  and ignored — Host-specific fields reach each Host as written, so standard
  Skill packages validate and install unchanged.
- A Skill package must not contain an `agent-profile-kit.yaml` sidecar. The
  sidecar is retired: delete it and list what it declared in a Profile's
  `context` and `skills` lists.

## Profiles

A Profile is the one apkit-specific file and the only place that says what
gets installed together.

- A Profile is a `.yaml` file directly under `profiles/`. Profile files live
  directly in `profiles/`; a `.yaml` file inside a `profiles/` subfolder is a
  violation (move the file up; its file name becomes its ID).
- Under `profiles/`, every non-hidden file must be a `.yaml` Profile directly
  in `profiles/` — a non-`.yaml` file anywhere under `profiles/`, including
  inside a subfolder, is a violation; a `.yml` extension is not accepted.
  Rename the file with a `.yaml` extension or move it out of `profiles/`.
- A Profile's file name, without `.yaml`, must be a lowercase kebab-case
  name; that name is the Profile's ID. A Profile carries no `id` field: its
  ID is its file name without `.yaml` — remove the field, and rename the file
  to change the ID.
- A Profile file contains exactly its `context` and `skills` lists — no other
  fields — and it contains both lists: `context` and `skills`. `context` and
  `skills` are lists of names. The `agents`, `hooks`, and `tools` fields are
  not supported in a Profile.
- A Profile list must not select a name more than once. Every name in a
  Profile's `context` list must be an existing Context Module ID. Every name
  in a Profile's `skills` list must be an existing Skill `name`.
- A Profile must select at least one artifact: its `context` list, its
  `skills` list, or both must be non-empty. Context-only, Skills-only, and
  combined Profiles are all valid.

## Local Configuration

The file `~/.agents/agent-profile-kit/config.yaml` is where this machine
records the selected Workspace path and its Project Bindings (each binding
names one project root, one Profile, and the Hosts to install for). Local
Configuration is machine-local, untracked, and never part of the Workspace.

## Examples

### Valid: a minimal valid Workspace

These four files form a complete, valid Workspace.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- context/example-context.md -->
```markdown
Keep project-specific instructions in the project repository.
```

<!-- skills/example-skill/SKILL.md -->
```markdown
---
name: "example-skill"
description: Summarize a change. Use when asked for a concise change summary.
---

# Summarize a change

Describe what changed, how it was verified, and any follow-up work.
```

<!-- profiles/example.yaml -->
```yaml
context:
  - "example-context"
skills:
  - "example-skill"
```

### Pattern: a Skill that needs specific Context

A Skill that only works with particular Context should say so and stop when
the Context is missing. In the Skill's `SKILL.md` body:

```markdown
# Review a pull request

Requires the Context Module `engineering/review-findings`. If this project's
installed Context does not include it, stop and tell the user to add it to
their Profile instead of proceeding without it.
```

### Invalid: a Workspace without the required Manifest

<!-- expects violations: workspace-missing-manifest -->
A folder whose root has no `workspace.yaml` is not a Workspace; apkit reports
the missing Manifest.

<!-- context/notes.md -->
```markdown
Some notes.
```

### Invalid: an unsupported Manifest schema version

<!-- expects violations: workspace-manifest/unsupported-schema-version -->
Only schema version 1 is supported.

<!-- workspace.yaml -->
```yaml
schema_version: 2
```

### Invalid: a Profile carrying an `id` field

<!-- expects violations: workspace-artifact/profile-id-field -->
A Profile's ID is its file name without `.yaml`; remove the `id` field.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- context/example-context.md -->
```markdown
Keep project-specific instructions in the project repository.
```

<!-- profiles/legacy.yaml -->
```yaml
id: "legacy"
context:
  - "example-context"
skills: []
```

### Invalid: a Profile naming a Context Module that does not exist

<!-- expects violations: missing-context-reference -->
The Profile's `context` list names `missing-notes`, and no Context Module has
that ID.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- profiles/draft.yaml -->
```yaml
context:
  - "missing-notes"
skills: []
```

### Invalid: a Profile naming a Skill that does not exist

<!-- expects violations: missing-skill-reference -->
The Profile's `skills` list names `missing-skill`, and no Skill package
declares that `name`.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- profiles/draft.yaml -->
```yaml
context: []
skills:
  - "missing-skill"
```

### Invalid: a Profile inside a nested folder

<!-- expects violations: nested-profile -->
Profiles live directly in `profiles/`; move `profiles/team/coding.yaml` up so
its file name becomes its ID.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- skills/example-skill/SKILL.md -->
```markdown
---
name: "example-skill"
description: Summarize a change. Use when asked for a concise change summary.
---
```

<!-- profiles/team/coding.yaml -->
```yaml
context: []
skills:
  - "example-skill"
```

### Invalid: a Profile that selects nothing

<!-- expects violations: profile-without-artifacts -->
A Profile with both lists empty selects no material.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- profiles/empty.yaml -->
```yaml
context: []
skills: []
```

### Invalid: two Skills with the same name

<!-- expects violations: duplicate-artifact-name -->
Two Skill packages declare the same `name`; Skill names are unique.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- skills/alpha/SKILL.md -->
```markdown
---
name: "summarize-change"
description: Summarize a change. Use when asked for a concise change summary.
---
```

<!-- skills/beta/SKILL.md -->
```markdown
---
name: "summarize-change"
description: Another summary workflow.
---
```

### Invalid: a leftover Skill sidecar

<!-- expects violations: leftover-skill-sidecar -->
`agent-profile-kit.yaml` is retired and no longer read; delete it and list its
content in a Profile's `context` and `skills` lists.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- skills/example-skill/SKILL.md -->
```markdown
---
name: "example-skill"
description: Summarize a change. Use when asked for a concise change summary.
---
```

<!-- skills/example-skill/agent-profile-kit.yaml -->
```yaml
dependencies: []
```

### Invalid: the retired model-invocation metadata key

<!-- expects violations: workspace-artifact/leftover-model-invocation-metadata -->
The `metadata.agent-profile-kit.model-invocation` key is no longer read; move
the policy to the standard top-level `disable-model-invocation` field.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- skills/pinned/SKILL.md -->
```markdown
---
name: "pinned-skill"
description: Review a change on request only.
metadata:
  agent-profile-kit.model-invocation: true
---
```

### Invalid: a non-boolean disable-model-invocation

<!-- expects violations: workspace-artifact/invalid-model-invocation -->
`disable-model-invocation` must be a boolean, not a quoted string.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- skills/pinned/SKILL.md -->
```markdown
---
name: "pinned-skill"
description: Summarize a change on request only.
disable-model-invocation: "true"
---
```

### Invalid: a Skill without a description

<!-- expects violations: workspace-artifact/invalid-field -->
The frontmatter requires a non-empty `description`.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- skills/brief/SKILL.md -->
```markdown
---
name: "brief-skill"
---
```

### Invalid: a Context file name that cannot form a valid Context Module ID

<!-- expects violations: workspace-artifact/context-module-file-name -->
`My Notes.md` contains a space and an uppercase letter; the file name must be
a lowercase kebab-case name.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- context/My Notes.md -->
```markdown
Some notes.
```

### Invalid: an empty Context Module

<!-- expects violations: workspace-artifact/empty-content -->
A Context Module file must not be empty.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- context/empty.md -->
```markdown
```

### Invalid: a non-Markdown file under `context/`

<!-- expects violations: stray-context-file -->
Under `context/`, every non-hidden file must be Markdown (`.md`).

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- context/notes.txt -->
```text
Some notes.
```

### Invalid: a file under `skills/` outside a Skill package

<!-- expects violations: stray-skill-file -->
Under `skills/`, every non-hidden file must belong to a Skill package (a
folder with a `SKILL.md`).

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- skills/README.md -->
```markdown
Notes about the Skills in this Workspace.
```

### Invalid: a Profile file with a `.yml` extension

<!-- expects violations: stray-profile-file -->
Under `profiles/`, every non-hidden file must be a `.yaml` Profile directly
in `profiles/` — a `.yml` extension is not accepted.

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

<!-- profiles/team.yml -->
```yaml
context: []
skills: []
```
