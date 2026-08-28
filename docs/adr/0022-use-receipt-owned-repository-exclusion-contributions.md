---
status: accepted
---

# Use Safe Repair glossary and receipt-owned Repository Exclusion Contributions in Blocker contracts

Lifecycle evidence must name ownership concepts that actually exist. The earlier `repository-exclusion-record` Blocker kind implied a separately persisted record, but since ADR-0019 each active Installation Receipt owns one optional **Repository Exclusion Contribution** — its exact repository-local exclusion target and entries — and no separate record or target union is persisted; the Installer derives the shared-target union at planning time only.

The structured Blocker kind therefore becomes `repository-exclusion-contribution`, and every emitter, human renderer, and machine serializer uses receipt-owned Repository Exclusion Contribution language without implying separately persisted state. Every lifecycle or blocked-lifecycle JSON payload that carries the exhaustive Blocker vocabulary publishes schema version 8, and the Blocker normalization boundary rejects the retired kind rather than carrying a compatibility alias. Pre-1.0, no compatibility shim is offered (ADR-0014).

A **Safe Repair** is the deterministic restoration of Agent Profile Kit-owned output or lifecycle metadata from existing durable ownership evidence when no user-managed bytes or repository ownership change. It uses the ordinary `status` → `apply` lifecycle: `status` performs no writes and presents eligible repairs as pending work, and `apply` reproves and commits them through the normal lock, transaction, rollback, and post-commit verification boundaries. Missing or stale contributions can be repaired automatically only when durable receipt evidence proves the exact resulting contribution; any condition lacking evidence or authority stays a Blocker, and Agent Profile Kit never adds a general repair command, reconstructs ownership from surviving generated output, silently adopts unowned material, or changes Git ownership.

The maintained glossary (Safe Repair, Repository Exclusion Contribution) and this record define the boundary. Historical ADR text is not rewritten; earlier records remain historical.
