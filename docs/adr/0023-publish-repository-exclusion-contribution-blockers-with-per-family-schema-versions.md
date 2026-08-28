---
status: accepted
---

# Publish the Repository Exclusion Contribution Blocker kind with per-family payload schema versions

Lifecycle evidence must name ownership concepts that actually exist. The earlier `repository-exclusion-record` Blocker kind implied a separately persisted record, but since ADR-0019 each active Installation Receipt owns one optional **Repository Exclusion Contribution** — its exact repository-local exclusion target and entries — and no separate record or target union is persisted; the Installer derives the shared-target union at planning time only.

The structured Blocker kind therefore becomes `repository-exclusion-contribution`, and every emitter, human renderer, and machine serializer uses receipt-owned Repository Exclusion Contribution language without implying separately persisted state. The Blocker normalization boundary rejects the retired kind rather than carrying a compatibility alias; pre-1.0, no compatibility shim is offered (ADR-0014).

Every JSON payload that carries the exhaustive Blocker vocabulary publishes schema version 8. Version lines are per JSON command family, not global: the `status`/`apply` lifecycle payloads and the `install-temp`/`remove-temp` payloads (success receipt, blocked, tool error) each version as one family, so a version number identifies one command's whole JSON contract and a lifecycle-only change cannot re-version temporary output. Both families currently publish 8; that coincidence is not a coupling.

The maintained glossary defines Safe Repair and the receipt-owned Repository Exclusion Contribution boundary. Historical ADR text is not rewritten; earlier records remain historical.
