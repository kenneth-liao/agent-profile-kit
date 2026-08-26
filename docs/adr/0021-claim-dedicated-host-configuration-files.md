---
status: accepted
---

# Claim dedicated Host configuration files instead of merging user configuration

## Context

Every Agent Host supported before issue #327 exposed a dedicated surface an
Adapter could own outright: a uniquely named rules file, an appended system
file, a hooks output, or a Skill package directory. Codex reads its own
configuration only to warn, and no Adapter has ever written Host configuration.

OpenCode is the first Agent Host whose required portable semantics exist only
inside Host configuration. Its always-on project instructions come from
repository-owned material on a first-match-wins search that an Adapter must not
claim, or from an additive instruction list in OpenCode's own configuration.
Explicit-only Skill invocation exists only as a Skill permission rule in that
same configuration, because OpenCode's Skill frontmatter ignores the portable
`disable-model-invocation` field. Delivering Context or preserving explicit-only
invocation therefore requires writing Host configuration or rejecting the
installation.

The Host fixes the configuration filename, so an Adapter cannot carve out a
uniquely named file the way it owns a dedicated rules file. Merging into a
configuration file the user may own is the obvious alternative and was
considered. The repository-local exclusion contribution is the only existing
precedent for writing into a shared user-owned file, and it is safe only because
the contribution is a contiguous, lexically delimited, byte-verifiable region
whose tampering fails closed. A Host configuration contribution is instead a
scattered set of values inside structures the user also edits, so no equivalent
region exists. Installation Receipts prove ownership by whole-file or
whole-directory hash, and nothing in Installation State can express ownership of
individual keys.

## Decision

- An Adapter that must supply Host configuration claims **one whole
  configuration file** in the least contested slot the Agent Host merges. It
  never parses, merges into, or rewrites a configuration file the user may own.
- The claimed file is ordinary generated output. It is proven by receipt hash,
  contributes to the Repository Exclusion Contribution, and is removed on
  uninstall. Existing unowned material at the claimed path is an Output
  Ownership Conflict, reported with a remedy naming another slot the Host
  merges.
- Adapters delegate combination to the Agent Host's own configuration merge
  rather than reproducing merge semantics, consistent with ADR-0012. An Adapter
  may claim such a file only where the Host merges additively and
  deterministically, and must prove that merge behavior and its ordering at the
  Adapter's minimum supported Host version. Where the Host resolves a rule by
  position, the claimed slot must be proven to occupy the winning position.
- An Adapter writes no configuration file when the selected Profile requires
  nothing from it, so a Profile needing neither Context nor explicit-only
  invocation leaves no configuration footprint.
- Key-level and region-level ownership inside user-authored configuration remain
  deliberately unimplemented. An Adapter that genuinely needs either raises it as
  its own decision rather than introducing a second ownership model behind one
  Host.

OpenCode instantiates this by claiming the JSONC configuration file inside its
project configuration directory, the one slot named by neither OpenCode's
published documentation nor its built-in configuration guidance, leaving the
three slots a user would plausibly author untouched.

## Consequences

Users keep every remaining configuration slot the Agent Host offers, and their
configuration is never read or re-serialized, so comments, key order, and
formatting cannot be lost. Ownership stays whole-file, so no new receipt shape,
contributor model, or semantic diff is introduced, and uninstall stays exact.

A user already occupying the claimed slot is blocked rather than silently
merged with, and must move their keys to another slot the Host merges. This is
the intended failure: it is visible, reversible, and cannot corrupt authored
configuration.

The set of available slots is a Host fact that can change between Host
versions. An Adapter must re-prove slot availability, merge behavior, and
ordering whenever it raises its minimum supported Host version.
