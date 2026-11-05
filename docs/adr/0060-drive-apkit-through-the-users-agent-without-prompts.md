---
status: accepted
---

# Drive apkit through the user's agent, without prompts

Took effect at the agent-first cutover (0.239.0, spec #728).

## Context

The released engine was built for a person at a terminal. It had searchable
pickers, guided Profile creation, `configure profile`, `open`, `info`, `list`,
operation history with `details`, a pager, terminal styling, and three output
tiers. Each was a separate surface to keep correct, and an agent cannot answer
a prompt.

The 2026-10-30 ISA decision makes the product agent-first: the user works
through their agent, and the agent runs apkit (ISC-1 to ISC-4, ISC-6, ISC-19,
ISC-20). Prompts inside the engine are out of scope. "Simpler" includes a tool
that an agent learns from `guide` alone (ISC-60 to ISC-64). Interactive setup
and terminal styling are dead ends.

## Decision

1. **apkit never prompts.** A step that needs the user is a Decision. The
   location or Project that needs it is not changed; in a run over several,
   the others may already be done. The run lists every Decision and exits 3.
   Its Next line is the exact command to run after the user agrees.
2. **Two consent flags.** `--yes` allows an edit to a file the user owns, a
   write through a symlink that leads outside the folder, and taking over a
   file apkit did not write that has the same content. `--overwrite` replaces
   or deletes a file that someone changed or that apkit did not write. An
   agent passes either one only after the user agrees.
3. **One small command set.** `init`, `workspace`, `setup`, `check`,
   `install`, `update`, `remove`, `status`, `guide`, `contract`, and
   `migrate`, with `--agents a,b`, `--yes`, `--overwrite`, `--global`,
   `--all`, `--remove`, `--json`, and `--workspace <path>`. `new`,
   `configure`, `open`, `info`, `list`, and `details` do not return: the agent
   edits Workspace files, and `check`, `status --all`, `workspace`, and
   `--json` cover the rest.
4. **The guide is built in.** `apkit guide` is the complete workflow for an
   agent, and it always matches the installed version. `apkit contract` prints
   the Workspace contract.
5. **One report per run.** Human output is one report, and each fact appears
   once in it. `--json` prints one JSON value that is the complete record of
   the operation. No run history is kept: ISC-7.2 is met by `--json` at the
   time of the run. There is no verbose tier, pager, or interactive styling.
6. **Exit codes agree across commands.** `0` done, `1` error, `2` usage, `3`
   needs a Decision. A command stops with exit 2, before it writes, on an
   option it does not take.

`docs/USER-JOURNEY.md` owns the stages and the rules every output follows.

## Considered Options

- **Keep prompts, with a non-interactive mode for agents.** Rejected: two
  surfaces to keep correct, and the ISA records interactive setup as a dead
  end.
- **Keep operation history and `details`.** Rejected: it needs retained state
  and retention rules, and the `--json` record of the run already holds every
  fact.

## Consequences

- A person who runs apkit without an agent decides with the same flags and
  reads the same Next lines.
- This supersedes the interactive and presentation decisions of the released
  engine: ADR-0016 and ADR-0017 (with ADR-0059), ADR-0020, ADR-0026,
  ADR-0032 to ADR-0040, ADR-0042 to ADR-0044, and ADR-0050. It amends
  ADR-0014, ADR-0031, and ADR-0051.
