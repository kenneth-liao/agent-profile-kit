---
status: accepted
---

# Use one qualified shared Skill projector for compatible Hosts

## Context

Codex and the planned compatible Agent Hosts discover Skills from the same
`.agents/skills/<Artifact ID>` project surface. A complete package planned
independently by each Adapter can therefore disagree at one owned directory
when a Skill disables implicit model invocation: Codex requires
`agents/openai.yaml`, while another Host may require a top-level
`disable-model-invocation` field. The Installer must not merge those
Host-specific representations, and canonical Workspace policy must not be
weakened to make independently planned outputs coalesce.

## Decision

Introduce one narrow shared Skill projector at the Adapter boundary. It
composes the complete qualified package once, omits the Agent Profile Kit-only
sidecar, preserves unrelated package members, bytes, modes, and Codex metadata,
and emits a stable shape that does not depend on which qualified shared-path
consumers are selected. A disabled-invocation package carries both the
Host-native top-level restriction and Codex's
`policy.allow_implicit_invocation: false`; an allowed package adds no
restriction. Generated policy fields carry deterministic explanatory YAML
comments.

The canonical Workspace
`metadata.agent-profile-kit.model-invocation` value remains authoritative.
Absent or matching Codex policy coalesces. Malformed, wrong-type, or
contradictory `agents/openai.yaml` policy is an Adapter capability failure that
the Installer translates into one project-scoped structured Blocker naming both
authorities and a Workspace repair remedy before reconciliation can write.

Each participating Adapter still proves that its Host preserves the complete
shared package and its required semantics. The Installer only normalizes exact
shared output equality, ownership, and lifecycle state. Native Host discovery,
precedence, deduplication, collision diagnostics, and effective inventory
remain Host-owned under ADR-0002 and ADR-0012.

Codex is the first consumer. Temporary Codex installations call the same
projector as ordinary Codex planning; Pi migration and Antigravity integration
remain separate tickets.

## Consequences

- One disabled Skill has one stable generated package for future qualified
  shared-path consumers instead of competing complete-directory projections.
- A Host Adapter can reject a package it cannot preserve without moving Host
  compatibility rules into the Installer.
- Generated output is disposable; the Workspace remains the only maintained
  source of Skill policy and content.
- Existing generated Codex packages gain the shared top-level policy field on
  the next successful reconciliation when the canonical policy is disabled.

## Amendment: migrate Pi Skills to the qualified shared package

Ticket #229 makes Pi the second consumer. Pi plans the same shared package and
qualified discovery requirement as Codex, while its Context remains on
`.pi/APPEND_SYSTEM.md`. The Installer migrates existing owned Pi Skill roots
from `.pi/skills/<Artifact ID>/` to `.agents/skills/<Artifact ID>/` on the next
safe ordinary `apply`; modified old output and occupied or unowned new
destinations remain ownership blockers. No standing `shared-path` Host Setup
Step is emitted. Reconciliation evidence records every consuming Host for each
normalized output path, and Antigravity remains a later consumer.
