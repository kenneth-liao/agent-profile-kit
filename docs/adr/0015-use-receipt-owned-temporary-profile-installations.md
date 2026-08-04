---
status: accepted
---

# Use receipt-owned Temporary Profile Installations

ADR-0010 binds ordinary Profile lifetime to Project Bindings and global
reconciliation. External runners such as Agent Eval Kit need one Profile
installed for one Host in one explicit temporary Project without mutating Local
Configuration, reconciling unrelated projects, or inventing a second binding
schema.

## Decision

Temporary Profile Installations are a deliberate lifetime exception to
ADR-0010's binding-owned model:

1. **Receipt-owned lifetime.** Desired lifetime is owned by a durable temporary
   installation identity and receipt, not by a Project Binding. Public commands
   are `install-temp` and `remove-temp`.
2. **No binding and no global apply.** Temporary install plans and commits only
   the named Project. It never creates, edits, or removes Local Configuration
   or Project Bindings, and never reconciles another project.
3. **Reuse ordinary safety machinery.** Host-native planning remains Adapter
   owned. Ownership preflight, tracked-path protection, transactional
   publication, and contributor-aware Repository Exclusion Records are the same
   Installer boundaries used by ordinary Profile Installations (ADR-0011).
4. **Shared exclusion ownership, separate desired state.** Active temporary
   installation IDs contribute to the same Repository Exclusion Record union as
   ordinary installations. They are stored under Installation State
   `temporary_installations` rather than ordinary `installations[]`, so global
   `apply` and `status` do not treat them as stale binding output. Ordinary
   `uninstall` removes ordinary installations only and preserves temporary
   contributors.
5. **Terminal removed identity.** Successful `remove-temp` deletes owned outputs
   and the exclusion contribution, then retains a minimal terminal identity so
   repeated remove calls remain idempotent without recreating state.
6. **Host Setup Steps and warnings on the live receipt.** Adapter-authored Host
   Setup Steps and configuration warnings are returned on the install-time
   receipt and human presentation. They are operational guidance for that
   preparation, not durable desired state.

## Consequences

- Temporary install is available for automation and manual inspection without
  temporarily mutating ordinary desired state.
- Installation State schema v5 is required once any temporary record is written.
  Older engines cannot read a v5 state file; operators who may downgrade must
  retain a pre-upgrade state backup (see CHANGELOG and ARCHITECTURE).
- Crash recovery after partial publication, disposable removal of modified
  temporary-owned roots, linked-worktree contributor safety, and the shared
  Installation State lifecycle lock are delivered with the recovery slice
  (#137). Claude Code temporary-install Host parity is delivered with the
  Host-parity slice (#136).
- This does not restore session launchers or managed overlays superseded by
  ADR-0010; Hosts still load project material natively after install-temp.
