---
status: superseded by ADR-0025
---

# Publish the Repository Exclusion Contribution Blocker kind with per-family payload schema versions

Lifecycle evidence must name ownership concepts that actually exist. The earlier `repository-exclusion-record` Blocker kind implied a separately persisted record, but since ADR-0019 each active Installation Receipt owns one optional **Repository Exclusion Contribution** — its exact repository-local exclusion target and entries — and no separate record or target union is persisted; the Installer derives the shared-target union at planning time only.

The structured Blocker kind therefore becomes `repository-exclusion-contribution`, and every emitter, human renderer, and machine serializer uses receipt-owned Repository Exclusion Contribution language without implying separately persisted state. The Blocker normalization boundary rejects the retired kind rather than carrying a compatibility alias; pre-1.0, no compatibility shim is offered (ADR-0014).

*Superseded in place (ADR-0025):* the Repository Exclusion Contribution became best-effort bookkeeping that can never produce a Blocker, and the exclusion Blocker kinds this record published — including `repository-exclusion-contribution` — were removed from the typed Blocker class entirely. The normalization boundary no longer carries this kind at all. This record remains the historical account of that family's delivery; ADR-0025 owns the removal rationale.

Every JSON payload that carries the exhaustive Blocker vocabulary publishes schema version 8. Version lines are per JSON command family, not global: the `status`/`apply` lifecycle payloads and the `install-temp`/`remove-temp` payloads (success receipt, blocked, tool error) each version as one family, so a version number identifies one command's whole JSON contract and a lifecycle-only change cannot re-version temporary output. Both families currently publish 8; that coincidence is not a coupling.

*Superseded in place:* the "currently publish 8" statement no longer holds. The lifecycle family now publishes `schemaVersion: 14` and the temporary-installation family `schemaVersion: 9`, each carrying its family's whole JSON contract. The per-family versioning principle itself remains in force; only the current version numbers were superseded by later deliveries.

The maintained glossary defines Safe Repair and the receipt-owned Repository Exclusion Contribution boundary.

*Superseded in place:* ADR-0025 removed Safe Repair as an authority boundary and the receipt-recorded exclusion boundary entirely — the vocabulary is removed from the product and the glossary rather than kept as a term. The maintained glossary (`CONTEXT.md`) now defines Repository Exclusion Contribution as derived best-effort bookkeeping that never produces a Blocker; ADR-0025 owns that reduced boundary. The sentence above is preserved as the historical view at this record's acceptance.

Historical ADR text is not rewritten; earlier records remain historical.
