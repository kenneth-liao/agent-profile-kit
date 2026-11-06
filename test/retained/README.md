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
- `compat-0.16.0/` — optional scaffolding (#50): minimal and partial
  Workspaces, validated by 0.16.0. Its provenance explains the correction from
  the ticket's 0.20.0 release attribution.
- `compat-0.84.0/` — reduced Profile schema (#239), validated by 0.84.0.
  Its provenance explains the correction from the ticket's 0.95.0 attribution.
- `standard-skills/` — unchanged published Apache-2.0 Skill packages and
  licenses, pinned upstream revisions and SHA-256 manifest (ISC-38).

## Reproduce historical validity for the added early releases

From an issue worktree, create a fresh scratch folder outside all checkouts.
Use `git archive <revision> | tar -x -C <scratch>/<version>` to extract each
historical revision, with these directories created first:

| Version | Revision |
| --- | --- |
| 0.16.0 | `f2ec1c1e4fc7bd0acb342eb16b643776dc5a1929` |
| 0.84.0 | `ca468af769016c16148cb925b39b39fb567868af` |

In each extracted directory run `bun install --ignore-scripts`, then
`bun build cli/index.ts --target=node --packages=bundle --outfile=dist/cli.js --silent`.
This uses historical source and lockfile dependencies, without running install
hooks. Run `python3 test/retained/verify-historical.py <scratch>` from the current
issue worktree. The helper copies only the retained fixtures into disposable
homes with the historical Local Configuration schema and invokes each built
CLI's `validate` command on Node. All three runs must exit 0. The historical
engines are provenance tools, not CI dependencies; CI runs today's CLI against
the retained fixtures without downloading or building old versions.
