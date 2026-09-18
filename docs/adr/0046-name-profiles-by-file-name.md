---
status: accepted
---

# Name Profiles by their file name

## Context

ADR-0001 gave every portable artifact a stable typed identity carried inside
the artifact: a Profile's YAML file held an `id` field that named the Profile,
independent of its file name. The field added apkit-only authoring work and a
second identity home: the same Profile had a file name and an authored ID that
could drift apart, and renaming or moving a file silently changed nothing while
editing the field changed the identity that Project Bindings and Installation
Receipts reference (#519 O1–O4, spec #593).

## Decision

1. **A Profile's identity is its file name under `profiles/` without
   `.yaml`.** The parser derives the Artifact ID from the file's path and
   never reads an `id` field; one file per name in one directory makes a
   duplicate Profile ID structurally impossible (spec #593 DEC-014, ticket
   #598).
2. **A Profile file contains only its `context` and `skills` lists.** An `id`
   field in a Profile is a violation naming the file's path and the fix:
   remove the field; when the authored value differs from the file name, the
   fix offers renaming the file to `profiles/<id>.yaml` so the Profile ID that
   Project Bindings and installations reference is kept. apkit never silently
   rebinds an authored ID to a file name: a Profile carrying `id` cannot be
   ingested at all, so no lifecycle command acts on a rebound identity.
3. **Profile file names follow the Artifact ID naming rule**; a file name that
   cannot form a valid Artifact ID is a violation suggesting a rename.
   Profiles in nested folders are not accepted: every `.yaml` under a
   `profiles/` subdirectory is one violation naming its path with the move as
   its fix. `apkit new profile` and `apkit configure profile` write the new
   shape through the one Profile writer.
4. **Compatibility keeps matched identities working.** A 0.204.0-era Profile
   whose authored `id` matched its file name keeps its identity, Project
   Bindings, receipts, and desired-input digest after the `id` line is removed
   — the digest is computed from the parsed selection, not raw file bytes
   (TEST-010). Divergent authored IDs are reported with every change needed
   (DEC-013), never migrated automatically.
5. **This supersedes part of ADR-0001.** ADR-0001's Profile `id` field (typed
   identity carried inside the Profile file) is superseded; its typed
   artifact-identity principle and portable-artifacts-as-canonical-source
   stand. ADR-0045's removal of dependency metadata is unaffected.

## Consequences

- Renaming a Profile file renames its ID by design; guides and validation name
  this so Project Bindings can be updated deliberately.
- The `duplicate-artifact-name` ingestion fact can no longer arise for
  Profiles read from a Workspace; creation refuses an occupied Profile ID with
  that same fact instead of an occupancy error.