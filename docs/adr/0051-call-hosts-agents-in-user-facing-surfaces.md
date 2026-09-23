---
status: accepted
---

# Call hosts agents in user-facing surfaces

## Context

UX evaluations and user feedback (spec #672, issue #673) revealed that the term
"Host" (or "Agent Host") introduces conceptual overhead for practitioners.
Users conceptualize tools such as Claude Code, Codex, Cursor, and Antigravity as
"agents" or "coding agents" rather than "hosts". Presenting flags like `--host`
and commands like `apkit list hosts` creates friction and fails to match user
mental models.

At the same time, Agent Profile Kit internally adapts portable material to the
distinct execution models and directory layouts of each external environment.
In contributor and architectural contexts, "Agent Host" accurately denotes the
platform environment that hosts the profile material.

Furthermore, automated callers and external integrations depend on the machine
interface (`apkit machine install-temp ... --host <host>`) and machine JSON
payloads.

## Decision

1. **User-facing CLI surface calls supported tools "agents" (Decision D1).**
   - The CLI flags `--host` on user commands (`install`, `uninstall`) are
     replaced with `--agent`.
   - The discovery command `apkit list hosts` is replaced with `apkit list agents`.
   - Per ADR-0014 (no compatibility shims in pre-1.0 SemVer 0.x), the old forms
     fail with unknown-option or unknown-topic errors without compatibility
     aliases.
2. **Human prose, help, guides, and README refer to "agent".**
   - Root help, command help, interactive prompts, receipts, status reports,
     and documentation use "agent" and "Supported agents" rather than "Host" or
     "Supported Hosts".
3. **The `apkit machine` namespace contract is strictly preserved.**
   - The integration interface behind `apkit machine` (`machine install-temp ... --host <host>`,
     `machine list temporary`, `machine remove-temp`) is unchanged. It retains
     `--host` and its existing parameter shapes.
   - Machine JSON output payloads (`topic: "hosts"`, `removedHosts`, etc.)
     remain byte-identical across versions (differing only in `engineVersion`).
4. **Canonical terminology distinction.**
   - User-facing documentation and CLI interfaces use "agent".
   - Architectural, contributor, and adapter-layer documentation continues to use
     "Agent Host" when referring to the external execution environment and its
     capability contracts.
