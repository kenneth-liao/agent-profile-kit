# Retained Workspaces

Workspaces that were valid in an earlier release that changed the Workspace
contract. `test/cli.test.ts` validates each one with the current rules: it must
pass, or fail with every needed change named (ISC-46).

- `compat-0.237.0/` — the format of the first published contract
  (`docs/guides/workspace-contract.md`, 0.237.0, unchanged since). Hand-written
  with neutral content; `apkit validate` from the released engine at ed36c4d
  reported it valid.
- `compat-0.204.0/` — the 0.204.0 Workspaces (`workspace-source` and the
  realistic-scale `workspace-realistic`) and their original provenance and
  reproduction material. Their README says how they were made.
