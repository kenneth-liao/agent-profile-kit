---
status: accepted
---

# Set up a chosen folder by adding only the missing parts

## Context

`init` provisioned a Workspace by staging a whole directory under a temporary
name in the destination's **parent** and renaming it into place. The staged
scaffold carried example material — an example Profile, Context Module,
`README.md`, `AGENTS.md`, `.gitignore`, and `.gitkeep` placeholders — and a
non-empty folder without `workspace.yaml` was refused outright. In principal
testing on 0.204.0 (#519 O1–O4), users learned where their Workspace went only
from the final receipt, could not reuse a folder they already had, and
received apkit-specific example files they had not asked for. The setup flow
also validated only the Workspace structure, so a folder with an invalid
Profile could be connected (spec #593, US-002–US-003, DEC-003, DEC-011).

## Decision

1. **The user names the folder; setup adds only what the Workspace structure
   requires.** A Workspace is `workspace.yaml`, `context/`, `skills/`, and
   `profiles/`. Setup decides by contract validity only — not by whether the
   folder is empty — and adds exactly the missing parts in place. Staging and
   renaming a whole directory is removed (spec #593 DEC-003, ticket #599).
2. **Setup validates the folder's would-be state before any write.** The
   on-disk manifest is ingested when present; a missing manifest is supplied
   in memory as the canonical manifest setup would write, so an invalid folder
   is refused with its violation and zero writes — no transient `workspace.yaml`,
   no rollback of apkit's own writes. Local Configuration is recorded only
   after the folder validates (DEC-011, ISC-29).
3. **Setup writes no example Profile, Context Module, README, AGENTS.md, or
   any other file the structure does not require.** The old bootstrap docs and
   example pair are gone; examples live in the contract and guides through the
   single authoring-examples authority (`installer/authoring-examples.ts`).
4. **Existing entries are never changed, moved, or deleted** — including for
   invalid folders (ISC-28). A failure after some parts were added reports
   exactly what was added; a re-run adds only the still-missing parts
   (`init-partial-setup`), so setup is resumable.
5. **Nothing is ever written outside the named path.** A named path that does
   not exist is created only when its parent directory exists — and the
   receipt reports the creation; when the parent is missing too, setup refuses
   with the path reported. A non-directory, dangling symlink, or symlink to an
   empty directory is refused as before. The conventional-default bootstrap
   (whose parents are the application directory itself) keeps provisioning
   until the fixed default location is removed by #601.
6. **Relative Workspace arguments are accepted** (`init .`, `init <relative
   path>`; ISC-26). Home-relative spellings keep recording their authored
   `~/…` form; working-directory-relative forms record the resolved absolute
   folder, so later commands from another directory select the same Workspace.
7. **Completion on already-connected legacy paths is deferred.** The gate that
   completes a manifest-present folder's missing directories is first
   connection, so the two legacy paths that reach setup with the structure
   already connected — legacy version-1 migration without `workspace`, and
   zero-argument `init` with Local Configuration selecting the conventional
   default — do not complete a partial folder. Both paths are removed by
   #601 (DEC-001, DEC-011 legacy), and completing an already-connected
   Workspace is connecting-again semantics owned by #607 (DEC-002); this
   deferral is recorded instead of widening #599 into #601's scope.
   First-connection and explicit-path setup always complete the folder.
8. **First-Profile guidance narrows to its purpose.** Because setup no longer
   scaffolds example material, the guided offer fires only for a destination
   that already has material but no Profile (DEC-003); the planned-example-
   scaffold machinery is removed. Connecting-again behavior (previewing and
   completing an already-configured Workspace) remains #607's.
   **Superseded by ticket #646 (spec #640 US-002, DEC-005, DEC-010):** setup
   never creates or guides a first Profile. The guided offer and its preview
   path are removed entirely; the handoff routes from the resulting content
   (zero Profiles lead to Profile creation; existing Profiles lead to bare
   install). This supersedes spec #491 US-016 and this point's guided-first-
   Profile requirement only; the add-only-missing-parts rules above remain
   binding.

## Consequences

- A folder with unrelated files — or scattered material the user moved in —
  becomes a Workspace in place; nothing else in it is touched.
- This supersedes ADR-0007's provisioning sentence in part: explicit
  initialization no longer provisions missing parent directories, and the
  staged-directory mechanism is gone. The fixed default path and its removal
  are #601's, with their own superseding ADR.
- A re-run of `init` never rewrites current source or restores a deleted
  optional entry; it adds only still-missing required parts.
