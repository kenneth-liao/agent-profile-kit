---
status: superseded by ADR-0055 and ADR-0057
---

# Use portable Hook semantics and focused MCP Tools

Superseded at the agent-first cutover (0.239.0) by [ADR-0055](0055-deliver-through-verified-locations-instead-of-adapters.md) and [ADR-0057](0057-simplify-the-workspace-format.md).

Canonical Hooks declare lifecycle intent and a required observational, advisory, enforcing, or transforming effect, while model-callable Agent Tools use focused MCP servers grouped by integration or cohesive responsibility. Adapters must preserve Hook effects or reject them, and deterministic support code remains an ordinary Internal Utility, avoiding false event equivalence, a monolithic tool server, and unnecessary protocol overhead.
