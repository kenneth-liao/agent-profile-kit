---
status: accepted
---

# Replace the public apply command with update

The public lifecycle becomes **install → update → uninstall** (spec #491,
DEC-001). This record covers the `apply` → `update` slice only (ticket #492,
US-002); the `bind` → `install` and `unbind` → `uninstall` renames belong to
their own slices and are not decided here.

## Decision

- **`apkit update` replaces `apkit apply` with identical scope and behavior,**
  plus the ticket-required `--project <path>` narrowing. Fleet default,
  `--here`, one explicit Project path, `--project <path>`, `--all`,
  `--stale`/`--blocked`, `--verbose`, `--json`, and `--replace-changed` share
  one argument-ingestion boundary with `status`, so the read-only plan and
  the write path accept the same narrowing; missing values and conflicting
  scopes (`--project` with `--here`/`--all`/a positional path) are rejected
  before writes. The only intentional machine change is the payload's
  `command` field, which reports `"update"`.
- **Public `apply` is retired without a compatibility shim** (pre-1.0
  breaking-change policy, ADR-0014). Every `apply` form — bare, scoped, and
  `apply --help` / `help apply` — exits `1` with a replacement diagnostic
  (`apply was replaced by update`, pointing at `apkit update`). The retired
  name is a diagnostic, never an alias: nothing executes under it.
- **Human surfaces use update language.** Outcome lines (`Update complete`,
  `Update blocked`, `Ready to update`, `Cannot update`), state explanations
  (`update will …`, `since the last update`), retry/remedy copy, next-action
  commands, and the committed-work heading (`Updated:`) name the command the
  user ran. Focused help, root help, and unbind/uninstall next actions agree.
- **`update` guidance names what it is not.** The command updates installed
  Context and Skills in Projects from the Workspace; it does not upgrade the
  `apkit` executable itself. That distinction lives in the command help and
  the Workspace guide, not in a second upgrade command.
- **Internal canonical vocabulary is preserved** (DEC-001). The Installer
  entrypoint, CLI module function names, the machine payload's `applied`
  snapshot key, and the `Apply Receipt` domain term keep their names; only the
  public command tokens changed. Project Bindings remain the internal
  canonical association untouched by this rename.

## Consequences

Users and scripts invoking `apply` must move to `update`; the retirement
diagnostic names the replacement on every retired form. Machine consumers key
on the `command` field see `"update"` with an otherwise unchanged schema and
the retained `applied` snapshot key. The rename ships as a pre-1.0 breaking
change with a minor version bump and no shim.

Living guidance (`docs/USER-JOURNEY.md`, `docs/ARCHITECTURE.md`,
`docs/guides/workspace.md`, `docs/guides/agent-workflow.md`, `README.md`)
was mechanically updated for the rename, including recaptured journey
excerpts whose captured output now reads with the new command. Full journey
recapture against the delivered CLI belongs to the integrated qualification
slice (#517), which re-proves the excerpts end to end.

## Supersessions

This record supersedes the **`apply`-naming portions of ADR-0010** (and its
amendments): the reconciliation path is invoked as `apkit update`, and
`status` is the read-only `update` plan. ADR-0010's binding model, Project
Binding scope, and recording-only `bind` boundary are unaffected, as are the
`bind`/`unbind` public names owned by sibling slices. Unrelated ownership,
Host Resolution, versioning, and process-executor decisions are intact.
