---
status: accepted
---

# Install one Temporary Profile Installation for several Hosts

## Context

An orchestrator runs several Agent Hosts in one disposable worker worktree (for
example Claude, Pi, and OpenCode). ADR-0015 limits a Temporary Profile
Installation to one Host, and a Project can hold only one, so the orchestrator
copies apkit output into each worktree by hand (#656). The destination is
ISC-50 to ISC-58 in `ISA.md`.

Antigravity and Grok were not eligible for temporary installation only because
of the scope of #133 and #369, not because of a technical limit. A spike on
e012809 installed and removed both.

## Decision

1. **One installation, one or more Hosts.** A Temporary Profile Installation
   covers one Profile, one or more Hosts, and one explicit Project. `machine
   install-temp` accepts a repeated `--host`; one `machine remove-temp` removes
   the whole installation. Removing a single Host is not supported. The rule of
   one Temporary Profile Installation per Project is unchanged. This amends
   ADR-0015's "one Host".
2. **All or nothing before writes.** Every selected Host is planned and checked
   before the first write. If any Host fails, nothing is written and the
   Blocker names that Host.
3. **Every supported Host is eligible.** The
   `supportsTemporaryProfileInstallation` catalog flag is removed. Eligibility
   follows from being a supported Host, so a new Host cannot be left out.
4. **Removal restores the Project tree.** Every Installation Receipt records
   the Project folders its installation created. `remove-temp` deletes those
   folders deepest first, and only when they are empty. A folder that existed
   before the installation, or that later holds another file, is kept.
5. **One receipt shape.** The created-folder record is on every receipt,
   ordinary and temporary (ADR-0019). Ordinary installations record it
   truthfully when they create folders; only `remove-temp` uses it now.
6. **Versioned machine break.** The temporary receipt replaces its top-level
   `host`, `adapterVersion`, and `hostVersion` with a `hosts` list of per-Host
   records, and Host inventory JSON drops `supportsTemporaryProfileInstallation`.
   The temporary command family's schema version and the SemVer minor version
   increase (ADR-0014, ADR-0023). This amends ADR-0051 §3: wording and
   presentation changes never change the `apkit machine` contract, but a real
   capability change may, as a versioned break.

## Considered Options

- **Several single-Host Temporary Profile Installations in one Project.**
  Rejected: Codex, OpenCode, and Pi share `.agents/skills` (ADR-0018), so two
  receipts would own the same output.
- **Delete every empty parent folder up to the Project root.** Rejected: it also
  deletes empty folders the user had before the installation.
- **Keep single-Host payloads byte-identical and add a second shape for several
  Hosts.** Rejected: every consumer would have to parse two receipt shapes.

## Consequences

- Ordinary `update` does not keep the created-folder record current, and
  ordinary `uninstall` does not use it. Both are follow-up work; until then the
  record on an ordinary receipt reflects only its first installation.
- Receipts written before this change migrate to an empty created-folder list
  through an Installation State schema version increase. Removing an older
  Temporary Profile Installation still leaves its empty folders.
- apkit still writes no Host trust or approval state. A new worktree is a new
  path for each Host, and the orchestrator owns trust.
