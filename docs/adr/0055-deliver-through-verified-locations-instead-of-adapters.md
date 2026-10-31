---
status: accepted
---

# Deliver through verified locations instead of Adapters

Takes effect at cutover to the engine in `next/`. Until then, the current
engine keeps its Adapters.

## Context

Each Agent Host has its own Adapter, with Capability Contracts and version
probes. Every new Host or platform makes the engine larger. The 2026-10-30 ISA
decision asks for a much simpler engine that behaves the same on macOS, Linux,
and Windows (ISC-59 to ISC-62).

## Decision

1. **One location table, no Adapters.** The engine keeps one table that gives
   the project and user-level Skills folder for each Host. It has no
   Capability Contracts, no version probes, and starts no Host program.
2. **Context goes in one shared `AGENTS.md` section.** Every supported Host
   reads `AGENTS.md`. When `CLAUDE.md` exists and Claude Code is selected,
   `CLAUDE.md` gets one `@AGENTS.md` line, because Claude Code reads `CLAUDE.md`
   instead of `AGENTS.md` when both exist. The section never goes in
   `CLAUDE.md`, because Grok loads both files and would see it twice.
3. **Evidence replaces detection.** Each location in the table has a dated live
   check: a marker reached a real session of that Host. A check is done again
   when a Host changes how it loads files (ISC-68, ISC-69).
4. **Host Resolution stays with the Host.** ADR-0012's rule stands: the engine
   relies on each Host's own discovery and never rebuilds a resolver or an
   inventory. This decision replaces only the Adapter boundary that ADR-0012
   assumed.

## Considered Options

- **Keep one Adapter per Host.** Rejected: it is the main source of the
  engine's size, and version probes need child processes.
- **Write each Host's own Context file.** Rejected: Hosts that read more than
  one file load the same Context twice. Separate files also need a separate
  rule for each Host.

## Consequences

- A Host change in where it loads files goes unnoticed until a live check is
  done again. ISC-10 still holds: install success never claims that a Host
  loaded anything.
- Adding a Host means adding a table row and its live check, not an Adapter.
