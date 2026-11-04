# Agent Profile Kit Operating Manual

This repository is the open-source Agent Profile Kit engine. It contains the agent-first engine, documentation, and neutral fixtures—not user-owned Workspace material.

## Repository Rules

- Keep one canonical home per fact. Do not duplicate maintained guidance across files.
- Normalize external inputs at the boundary of the tool or skill that ingests them.
- Prefer small, complete changes over broad scaffolding that is not used yet.
- Delegate native discovery, precedence, deduplication, collisions, and resource
  resolution to each Agent Host. The engine uses verified delivery locations
  and must not reconstruct Host resolvers or effective inventories. See
  ADR-0012 and ADR-0055.
- Use test-driven development for behavior changes unless the change is trivial, docs-only, or a throwaway spike.
- Keep per-issue worktrees under `.worktrees/` and never commit local runtime state.
- Until 1.0, follow standard SemVer 0.x: breaking changes bump the **minor** version rather than forcing a premature 1.0. Breaking changes are expected pre-launch and carry no compatibility shims. See ADR-0014.

## Canonical Locations

- `src/` owns the `apkit` command, Workspace validation, verified delivery locations, and installation lifecycle.
- `build.ts` owns the dependency-free Node bundle at `dist/cli.js`.
- `scripts/` owns release tooling: `scripts/release.ts` creates, qualifies, and verifies the release candidate (see `docs/runbooks/github-release.md`).
- `test/` owns engine and CLI journey tests; `test/retained/` owns earlier-release Workspace fixtures and their provenance; `test/migration/` owns what apkit 0.238.0 wrote, with its provenance, for the `migrate` journeys.
- `docs/guides/workspace-contract.md` owns the portable Workspace format, bundled into `apkit contract`.
- `docs/adr/` owns accepted decisions and rationale. Each ADR opens with `status: accepted` or `status: superseded by ADR-NNNN` front matter; a decision that changes part of an ADR adds a dated *Amended* note to it instead of rewriting it.
- `docs/ARCHITECTURE.md` owns living structural facts.
- `docs/USER-JOURNEY.md` owns user-facing CLI surface behavior: the stages and the outcome each stage owes.
- `docs/runbooks/` owns operational playbooks.
- `docs/archive/` owns shipped plans and spent research only.

Personal material belongs in the user's Workspace, not in this repository. A maintained user workflow belongs there as well; the engine installs its material at verified Host-native locations.

When a new category of fact does not fit these locations, record the placement decision in `docs/adr/` before spreading it across the repo.

## Verification

Prefer a focused suite while iterating; for code changes, run the full suite before opening a PR:

- `bun test ./test/<suite>.test.ts` — run an explicitly selected suite (add `-t <filter>` to select tests).
- `bun test` — run all engine and CLI tests at the repository root.
- `bun run build` — typecheck and bundle the CLI for Node.
- `APKIT_CLI=dist/cli.js bun test ./test/cli.test.ts` — run the CLI journeys on Node against the built bundle.

The Bun toolchain version is pinned at package.json `engines.bun`, read by CI through `setup-bun` with `bun-version-file: package.json`. CI runs plain `bun test` on macOS, Linux, and Windows, and runs the built CLI on supported Node lines. CI jobs have finite timeouts. See ADR-0059 for the qualification boundary.

### Evidence validity

- Record the tested revision, runtime, command, selection, and outcome. A failed, interrupted, or incomplete run is never a pass; preserve the original failure when investigating it.
- Re-execution requires changed relevant inputs or an unresolved hypothesis. Documentation and snapshot edits run their affected content, packaging, or rendering checks; they neither automatically require the full suite nor receive a blanket no-test exemption.
- A full-suite timeout starts a bounded investigation with an explicit hypothesis. Rerun only after a relevant change or for a stated discriminating experiment.
- When CI provides final qualification, its tested revision must match the accepted change and its executed coverage must match the required selection. Review reuses still-valid evidence rather than rerunning checks solely because verification moved to a different phase.
- Qualification cleanup targets only child PIDs owned by the invocation; machine-wide process-name termination (such as `pkill` by name) is prohibited.

## Agent skills

### Issue tracker

Issues and PRDs live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the standard canonical triage-label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository with one root glossary and root ADR directory. See `docs/agents/domain.md`.
