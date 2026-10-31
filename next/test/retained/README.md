# Retained Workspaces

Workspaces that were valid in an earlier release that changed the Workspace
contract. `test/cli.check.ts` validates each one with the current rules: it must
pass, or fail with every needed change named (ISC-46).

- `compat-0.237.0/` — the format of the first published contract
  (`docs/guides/workspace-contract.md`, 0.237.0, unchanged since). Hand-written
  with neutral content; `apkit validate` from the released engine at ed36c4d
  reported it valid.
- The 0.204.0 Workspaces are kept once, in
  `../../../test/support/fixtures/compat-0.204.0/` (`workspace-source` and the
  realistic-scale `workspace-realistic`). Their README says how they were made.
  The cutover (#728) moves them here when the root tests retire.
