# The Agent Profile Kit Workspace contract

The Workspace is the one folder apkit installs from: plain files that you own.
This document is the complete contract for that folder. Every rule that
validation enforces is stated here, and validation enforces every rule stated
here.

Print this contract with `apkit-next contract`. Validate a Workspace with
`apkit-next check`. Every problem that `check` reports names its file and the
change that fixes it.

## Errors and warnings

Validation reports two kinds of finding:

- An **error** means that an install would be wrong or ambiguous. Any error
  blocks every install and update until it is fixed.
- A **warning** names a file that apkit skips. Every warning is shown, and no
  warning blocks an install.

The Errors and Warnings sections below list every code that `check` reports.

## Workspace structure

    apkit-workspace.yaml    marks the Workspace
    context/                Context Modules
    skills/                 Skills
    profiles/               Profiles

- A folder is a Workspace when it has an `apkit-workspace.yaml` file. The file
  may be empty.
- When `apkit-workspace.yaml` is not empty, it must be a YAML mapping. Its
  `schema_version`, when present, must be a whole number of at least 1. A
  missing `schema_version` means version 1. This apkit reads version 1; a
  higher version needs a newer apkit. Other keys are ignored.
- A folder that has `workspace.yaml` but no `apkit-workspace.yaml` is not a
  Workspace. Rename `workspace.yaml` to `apkit-workspace.yaml`.
- A missing `context/`, `skills/`, or `profiles/` folder is empty.
- Other files and folders at the Workspace root are ignored.
- Hidden files and folders (names that start with `.`) are ignored everywhere,
  except inside a Skill package.
- Outside a Skill package, apkit never follows a symlink: it skips it.

## Context Modules

A Context Module is always-on guidance, such as a communication style.

- Every `.md` file under `context/`, at any depth, is a Context Module. Any
  `.md` file name is valid, so a copied `CLAUDE.md` or `AGENTS.md` works as it
  is.
- A Context Module's ID is its path under `context/` without `.md`, with `/`
  between folders. For example, `context/writing/voice.md` has the ID
  `writing/voice`. Moving or renaming the file changes its ID.
- Two Context IDs must not differ only in case, such as `Style` and `style`.
- A file under `context/` that is not `.md` is skipped.
- An empty Context Module (only whitespace) is skipped.
- apkit installs each file's text as it is written. apkit gives no meaning to
  frontmatter in a Context Module.

## Skills

A Skill is a standard Agent Skills package: a folder under `skills/` that has
a `SKILL.md` file. Folders may group packages.

- Every file inside the package folder, hidden files included, is package
  content and is installed with the Skill. Packages do not nest.
- A file under `skills/` that is not inside a package is skipped.
- `SKILL.md` must open with a `---` line and close its YAML frontmatter with a
  second `---` line. The frontmatter must be a valid YAML mapping.
- `name` is required. It must be lowercase kebab-case (lowercase letters and
  digits joined by single hyphens) and at most 64 characters. The `name` is
  the Skill's ID.
- `description` is required. It must be non-empty and at most 1024
  characters.
- `disable-model-invocation` is optional. It must be `true` or `false`. When
  it is `true`, agents use the Skill only when asked.
- Two Skill packages must not declare the same `name`.
- apkit ignores every other frontmatter field and installs it as written.

## Profiles

A Profile says what is installed together. It is the only apkit-specific file.

- A Profile is a `.yaml` or `.yml` file directly in `profiles/`. Its ID is its
  file name without the extension, and the file name must be lowercase
  kebab-case.
- `x.yaml` and `x.yml` must not both exist.
- A Profile file in a subfolder of `profiles/` is skipped. Any other file
  under `profiles/` that is not `.yaml` or `.yml` is skipped.
- A Profile file must be valid YAML. An empty file is a Profile that selects
  nothing.
- A Profile is a mapping that holds only a `context` list and a `skills` list.
  A missing list is empty.
- `context` lists Context IDs. apkit joins Context in list order, so `context`
  has no `all`.
- `skills` lists Skill names, or is `all`. `skills: all` selects every Skill in
  the Workspace, including Skills added later.
- A list must not name the same item twice.
- Every ID in `context` must be a Context Module in the Workspace, and every
  name in `skills` must be a Skill in the Workspace.
- A Profile that selects nothing installs nothing.

## Errors

| Code | Rule | Fix |
| --- | --- | --- |
| `workspace-missing-manifest` | A Workspace has an `apkit-workspace.yaml` file. | Create the file; it may be empty. Or select the right folder. |
| `workspace-old-manifest` | The marker is `apkit-workspace.yaml`, not `workspace.yaml`. | Rename `workspace.yaml` to `apkit-workspace.yaml`. |
| `workspace-manifest` | `apkit-workspace.yaml` is empty or a YAML mapping, and `schema_version` is a whole number of at least 1. | Fix the YAML, or set `schema_version: 1`. |
| `workspace-unsupported-version` | `schema_version` is one that this apkit reads. | Update apkit. |
| `context-id-case-collision` | Two Context IDs do not differ only in case. | Rename one of the files. |
| `invalid-frontmatter` | `SKILL.md` opens and closes valid YAML frontmatter. | Add or fix the frontmatter. |
| `invalid-field` | A Skill has a valid `name` and `description`. | Set the field as the rule says. |
| `invalid-model-invocation` | `disable-model-invocation` is `true` or `false`. | Set it to `true` or `false`, or remove it. |
| `duplicate-artifact-name` | Each Skill `name` is unique. | Rename one of the Skills. |
| `profile-file-name` | A Profile file name is lowercase kebab-case. | Rename the file. |
| `duplicate-profile` | One file defines each Profile. | Keep one of `x.yaml` and `x.yml`. |
| `invalid-yaml` | A Profile file is valid YAML. | Fix the YAML. |
| `invalid-profile` | A Profile holds only a `context` list of IDs and a `skills` list of names or `all`. | Remove other keys, and fix the lists. |
| `duplicate-selection` | A Profile list names each item once. | Remove the repeated item. |
| `missing-context-reference` | Each Context ID in a Profile exists. | Use the module's path ID, or add the module. |
| `missing-skill-reference` | Each Skill name in a Profile exists. | Use the Skill's `name`, or add the Skill. |

## Warnings

| Code | Skipped file | Fix |
| --- | --- | --- |
| `stray-context-file` | A file under `context/` that is not `.md`. | Give it a `.md` extension, or move it out of `context/`. |
| `empty-content` | An empty Context Module. | Add text, or delete the file. |
| `stray-skill-file` | A file under `skills/` outside every Skill package. | Move it into a package, or out of `skills/`. |
| `symlink` | A symlink outside a Skill package. | Replace it with the real file or folder. |
| `profile-in-subfolder` | A Profile file in a subfolder of `profiles/`. | Move it directly into `profiles/`. |
| `stray-profile-file` | A file under `profiles/` that is not `.yaml` or `.yml`. | Rename it, or move it out of `profiles/`. |
| `profile-without-artifacts` | Nothing: a Profile that selects nothing installs nothing. | Add items to its lists, or delete it. |

## Examples

Each example lists every file it holds. A file is a comment that names its
path, followed by one code block with its text. The comment after an example
heading names the errors or warnings that `check` reports. An example with no
such comment reports none.

### Valid: a small Workspace

<!-- apkit-workspace.yaml -->
```yaml
```

<!-- context/CLAUDE.md -->
```markdown
Answer in short, plain sentences.
```

<!-- context/engineering/review.md -->
```markdown
List each review finding with its file and line.
```

<!-- skills/review-pr/SKILL.md -->
```markdown
---
name: review-pr
description: Review a pull request. Use when asked to review a change.
disable-model-invocation: true
---

# Review a pull request

Follow references/checklist.md.
```

<!-- skills/review-pr/references/checklist.md -->
```markdown
- Tests pass.
```

<!-- profiles/engineering.yaml -->
```yaml
context:
  - CLAUDE
  - engineering/review
skills: all
```

<!-- profiles/writing.yml -->
```yaml
context: [CLAUDE]
```

### Valid: skipped files are warnings

<!-- expects warnings: stray-context-file, stray-skill-file, stray-profile-file -->

<!-- apkit-workspace.yaml -->
```yaml
schema_version: 1
```

<!-- context/notes.txt -->
```text
Draft notes.
```

<!-- skills/README.md -->
```markdown
My Skills.
```

<!-- skills/summarize/SKILL.md -->
```markdown
---
name: summarize
description: Summarize a change when asked.
---

Describe what changed and how it was verified.
```

<!-- profiles/README.md -->
```markdown
My Profiles.
```

<!-- profiles/default.yaml -->
```yaml
skills: [summarize]
```

### Invalid: the old marker file

<!-- expects errors: workspace-old-manifest -->

<!-- workspace.yaml -->
```yaml
schema_version: 1
```

### Invalid: a Workspace from a newer apkit

<!-- expects errors: workspace-unsupported-version -->

<!-- apkit-workspace.yaml -->
```yaml
schema_version: 2
```

### Invalid: Skills that agents cannot load

<!-- expects errors: invalid-frontmatter, invalid-field, invalid-model-invocation -->

<!-- apkit-workspace.yaml -->
```yaml
```

<!-- skills/no-frontmatter/SKILL.md -->
```markdown
# A Skill without frontmatter
```

<!-- skills/bad-name/SKILL.md -->
```markdown
---
name: Bad Name
description: A name with capitals and a space.
---
```

<!-- skills/maybe/SKILL.md -->
```markdown
---
name: maybe
description: An invocation choice that is not true or false.
disable-model-invocation: sometimes
---
```

### Invalid: Profiles that cannot be installed

<!-- expects errors: profile-file-name, invalid-profile, duplicate-selection, missing-context-reference, missing-skill-reference -->

<!-- apkit-workspace.yaml -->
```yaml
```

<!-- context/style.md -->
```markdown
Be brief.
```

<!-- profiles/My Profile.yaml -->
```yaml
context: [style]
```

<!-- profiles/all-context.yaml -->
```yaml
context: all
```

<!-- profiles/twice.yaml -->
```yaml
context: [style, style]
```

<!-- profiles/missing.yaml -->
```yaml
context: [voice]
skills: [review-pr]
```
