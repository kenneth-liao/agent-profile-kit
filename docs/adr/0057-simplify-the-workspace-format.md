---
status: accepted
---

# Simplify the Workspace format

Takes effect at cutover to the engine in `next/`. Until then, the current
contract stays in force.

## Context

An audit of the Workspace from a new user's view (2026-10-30) found that most
first-run failures come from format rules, not from the four ideas:

- Context file names must be kebab-case, so a copied `CLAUDE.md` fails.
- A Profile must list both `context` and `skills`, even when one is empty.
- A new Skill needs a second edit in a Profile before it installs.
- Harmless stray files block every install.
- `workspace.yaml` holds only `schema_version: 1`, and its name does not say
  what it is for.
- The contract keeps rules for retired features.

The ISA records the destination (ISC-39, ISC-44, ISC-76 to ISC-85).

## Decision

1. **Any `.md` Context file name.** A Context Module's ID is still its path
   under `context/` without `.md` (ADR-0048), but path segments no longer need
   to be kebab-case. Two IDs that differ only in case are an error, so a
   Workspace behaves the same on case-insensitive file systems. This amends
   ADR-0048 §2.
2. **Lenient Profiles.** A missing `context` or `skills` list is empty. A
   `.yml` extension is accepted. This amends ADR-0046 §2.
3. **`skills: all`.** A Profile may select every Skill in the Workspace.
   Context has no `all`, because Context is joined in list order.
4. **Errors and warnings.** An error means an install would be wrong or
   ambiguous, and it blocks installs. A file that apkit skips is a warning:
   every warning is shown, and none blocks an install. Profiles in subfolders
   and stray files become warnings.
5. **No rules for retired features.** The sidecar and the retired
   model-invocation key leave the contract and the validator. A leftover
   sidecar is ordinary package content.
6. **`apkit-workspace.yaml` marks a Workspace.** The file alone makes a folder
   a Workspace, and it may be empty. A missing `schema_version` means
   version 1. A version that this apkit does not support is an error that
   names the apkit version needed. A folder with only `workspace.yaml` fails,
   and the fix names the rename.

## Considered Options

- **`context: all`.** Rejected: the join order would follow IDs, not intent.
- **A `profiles/` folder as the marker.** Rejected: the name is common, so a
  mistyped path could select the wrong folder.
- **A fixed Workspace folder name.** Rejected: the user chooses the folder
  (ADR-0049).
- **A hidden marker file.** Rejected: it is invisible, and hidden files are
  skipped everywhere else in the format.

## Consequences

- Every existing Workspace must rename `workspace.yaml` once. Validation names
  the rename, so ISC-46 holds.
- Other changes only make validation more permissive, so a Workspace that is
  valid today stays valid apart from the rename.
- A Context ID can now hold characters such as spaces or `-->`. Anything that
  writes an ID into generated output must encode it.
- ADR-0048 §4 (Antigravity rule file names) ends with the Adapters at cutover
  (ADR-0055).
