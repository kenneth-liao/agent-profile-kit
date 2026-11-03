---
status: accepted
---

# Qualify the agent-first engine with plain tests

## Context

The agent-first cutover (#728, #751) removes the released engine's Adapters,
Host executable probes, interactive prompts, pager, fleet reconciliation,
and their test infrastructure. ADR-0055 replaces Adapters with verified
locations. The engine starts no child processes; CLI journey tests start
isolated CLI and Git children to exercise the public behavior.

The shared executor and suite supervisor protected the removed engine's
process and qualification boundaries. Keeping them would retain a second
engine's infrastructure and macOS-specific qualification policy after those
boundaries have gone.

## Decision

1. **Run plain tests.** Root `bun test` discovers every engine suite. Focused
   runs select files or test names directly. Tests keep their explicit journey
   budgets; CI jobs impose finite execution timeouts. No suite supervisor,
   fleet runner, stress runner, or shared process executor remains.
2. **Qualify supported environments.** CI runs plain tests on macOS, Linux,
   and Windows, builds the Node bundle, and exercises the public CLI journeys
   on Node. The root package manifest is the canonical runtime declaration.
   Fixture homes isolate the journeys from real user and Host state.
3. **Preserve behavioral evidence.** Moving a test does not excuse dropping
   its protected behavior. Earlier-release Workspaces live in `test/retained/`
   and remain subject to ISC-46. A runner failure, omitted selection, or
   interrupted job is not successful qualification. Valid evidence is reused
   until relevant inputs change or an unresolved hypothesis requires a run.
4. **Separate execution from release evidence.** Plain runner results and CI
   job outcomes replace the old supervised qualification contract. The small
   qualification record and publishing the exact tested tarball are owned by
   #752; removing the old runner does not waive ISC-11 through ISC-18 or the
   release artifact contract.

This supersedes ADR-0027 and ADR-0028 in full, and the supervisor-related
qualification machinery of ADR-0016 and ADR-0017. Their unrelated historical
presentation and lifecycle decisions are not redefined here.

## Consequences

- `src/` is the only engine; `build.ts` builds its Node bundle. Engine and
  journey tests live in `test/`, with compatibility material in
  `test/retained/`. These replace the old component and test-support locations
  in the operating manual.
- Test-only subprocesses use Node's child-process API. There is no shared
  process-group cleanup guarantee from the deleted executor. CI's job timeout
  bounds a stuck run, and such a run must be reported as incomplete.
- Cross-platform and built-Node results, rather than a macOS runner-identity
  gate, establish support. Local evidence records the runtime actually used;
  CI reads the pinned Bun version from `package.json`.
