---
status: accepted
---

# Use Project-scoped lifecycle and minimal JSON ownership receipts

## Context

The former YAML Installation State persisted ownership facts beside presentation provenance, complete directory member trees, separate Host representations, intended teardown records, and derived Repository Exclusion Records. Those duplicate and derived fields enlarged the trusted schema and allowed a successful write to exceed the YAML reader's alias limit. Ordinary lifecycle commands also coupled unrelated Projects and duplicated read-only planning.

Issues #238–#254 implement the simplified lifecycle specified by #237. This ADR records the resulting durable boundaries and explicitly supersedes conflicting parts of ADR-0010, ADR-0011, ADR-0014, ADR-0015, ADR-0016, and ADR-0017.

## Decision

- `status` is the authoritative read-only lifecycle command. `status` and `apply` target the current or one explicit Project by default; `--all` is the only fleet scope. Project-scoped blockers do not stop healthy Projects during `apply --all`, while global source, state, and lock failures stop every write.
- Installation State is one strict deterministic JSON document at `~/.agents/agent-profile-kit/state/manifest.json`, published under the lifecycle lock only after the production parser accepts the exact serialized bytes. Publication uses a sibling temporary file and atomic rename.
- A bounded migration reader accepts supported schema-2 through schema-5 YAML from `manifest.yaml`. The next successful state-writing operation publishes schema-6 JSON, verifies it through the production reader, and then retires the YAML source. Legacy readers are temporary pre-1.0 migration code.
- Installation State is durable machine-local ownership evidence, not canonical Workspace source. Generated Profile Installation output remains disposable.
- One active receipt owns the Installation ID, lifetime, canonical Project, Profile ID, desired-input digest, Host receipt map, generated output roots, and optional repository-local exclusion contribution. Ordinary and Temporary Profile Installations use this same shape.
- The Host map is the sole installed-Host representation. Each Host entry owns its Adapter version and Capability Contract. Receipts do not store engine provenance, combined Adapter versions, separate Host arrays, selected Context, dependency inclusion reasons, artifact fingerprints, output origins, member-level changes, or intended teardown.
- A file receipt stores path, type, mode, and content hash. A directory receipt stores path, type, root mode, and one aggregate hash over complete member paths, types, modes, and file bytes. Inspection computes the same aggregate without following symlinks and fails closed on any unreadable, unsafe, missing, unexpected, changed, or mode-drifted content.
- The Installation Marker is lifecycle metadata outside generated output receipts. It remains the project-travelling token that links one Project to one active receipt identity.
- Each active receipt stores its exact repository-local exclusion target and entries. Planning derives the deterministic target union from active receipts. No separate Repository Exclusion Record or stored union exists. The marked section still preserves unrelated bytes and contributor-safe linked-worktree behavior.
- Successful `remove-temp` removes the active receipt and retains only its Installation ID in the compact removed-temporary collection. Repeated removal is idempotent without retaining output, Host, hash, Project, or exclusion detail.
- Project output, Installation State, repository-local exclusion publication, stale removal, rollback, and post-commit verification stay sequential and ownership-proven. Read-only Project work may remain bounded and concurrent; every committed Project receives fresh verification.
- Reconciliation reports and presentation are derived from current planning and nested Project records. Durable ownership state carries no presentation-only provenance.

## Consequences

A state writer cannot publish bytes its supported reader rejects, and aliases or duplicate ownership representations cannot reappear in canonical JSON. Ownership state scales with generated roots rather than complete generated trees or dependency explanation paths.

Pre-0.95.0 binaries cannot read schema-6 JSON. Before migration, users who require rollback must back up `manifest.yaml`; after migration they must restore that backup before running an older binary. Missing or unreadable ownership state is never reconstructed from surviving generated output.

The legacy YAML parser and schema projections remain only for the explicit migration window. Their removal requires the separate human migration gate and pre-1.0 compatibility cleanup tracked by #256 and #257.

### Amendment: close the pre-1.0 YAML migration window

Issue #256 confirmed that the shipped 0.95.0 boundary migrated every known supported Installation State, and issue #257 closed the migration window. Runtime ownership reading now accepts only strict schema-6 `manifest.json`; any leftover `manifest.yaml` fails closed with guidance to use 0.95.0. The legacy YAML readers, compatibility normalizer, transitional serializer, and retired receipt projections no longer exist in production, and ownership is never reconstructed from generated Profile Installation output.

### Amendment: identity, not aggregate-hash equality, grants authority over recorded roots

Issue #363 narrowed this record's rule that inspection fails ownership proof on "any unreadable, unsafe, missing, unexpected, changed, or mode-drifted content". A verified incident showed an Agent Host leaving an empty scratch directory inside an installed Skill root; the aggregate member-set hash changed, and the Project was globally blocked with drift evidence described as a user edit that never happened.

The authority boundary now separates installation identity from content freshness:

- An active Installation Receipt plus an Installation Marker that matches its Installation ID at safe paths proves that each recorded generated output root is Agent Profile Kit-managed disposable output. This identity proof — not current hashes or directory membership — grants authority over the exact recorded roots.
- Current hashes and directory membership determine only whether that output is current. Content, mode, and membership differences are ordinary drift: `status` reports them as non-blocking pending generated-output work, `apply` atomically replaces the whole recorded root from current Workspace source and freshly verifies the result, and removal operations may remove drifted proven roots through their existing transactional boundaries. Unknown descendants are never adopted as canonical source; reconciliation replaces the whole proven root and never merges unknown members.
- The fail-closed boundary remains for unreadable or absent authoritative Installation State, missing or foreign Marker identity when it cannot be safely repaired, unsupported entry types such as symlinks inside a proven root, root type confusion, unreadable output, unsafe root or parent paths, Git-tracked generated paths, occupied unowned destinations, and user-managed or shared files.
- The aggregate hash keeps its freshness role: it distinguishes current from drifted output. It is no longer an authority requirement, and residual ownership Blockers state only what their evidence proves, never asserting a user edit without provenance.
