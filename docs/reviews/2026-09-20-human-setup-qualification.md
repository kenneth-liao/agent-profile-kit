> **PENDING HUMAN QUALIFICATION - NOT PASSED**
>
> This file prepares the human qualification for [#610](https://github.com/kenneth-liao/agent-profile-kit/issues/610)
> (TEST-012 human runs: ISC-19, ISC-20, ISC-24.3). No human session has run. No
> claim in this file is met. This file is never edited with results; results go
> in a new dated review file (see the result template below).

# Human setup qualification — preparation — 2026-09-20

Preparation material for the human qualification ticket
[#610](https://github.com/kenneth-liao/agent-profile-kit/issues/610), a child of
spec [#593](https://github.com/kenneth-liao/agent-profile-kit/issues/593). It
contains the provenance and capture method for the rendered setup confirmation
screens that the principal reviews under ISC-24.3, the limitations of that
capture, and the checklists a facilitator needs to run the uncoached newcomer
sessions for ISC-19 and ISC-20.

Observations only. See
[ADR-0029](../adr/0029-keep-dated-observational-reviews-in-docs-reviews.md):
this is a dated observational artifact for ticket #610, not maintained backlog,
and nothing here claims a human result.

---

## 1. Provenance

- **Revision:** `main` at `46f30f7` (`46f30f70771130a53257763cd448a65e2e497ec5`),
  with no tracked changes; the only untracked content at capture time was the
  evidence files themselves.
- **Package version:** 0.217.0 (`package.json` at that revision).
- **Node:** v22.23.2 (`/opt/homebrew/opt/node@22`), matching `engines.node`
  `">=22 <23"`. The packed CLI executed under this Node.
- **Packing:** the release candidate was packed exactly as
  `test/release-candidate.test.ts` packs it, through the stages of
  `test/support/package-archive.ts`: `bun run build` (bundle `dist/cli.js`,
  script-disabled) followed by `npm pack --ignore-scripts --silent`, producing
  `agent-profile-kit-0.217.0.tgz`, sha256
  `f88dcc663da419cf3b5a68ee1c4ebf9953012467d4cdef027e0f9dee366beef3`. A fresh
  pack produced from `46f30f7` on the capture machine was byte-identical to the
  archive used for the captures (same sha256).

## 2. Capture method (exactly as done)

Eighteen real-PTY captures, nine scenarios at each of 100 and 60 terminal
columns, are committed under:

- `docs/reviews/evidence/2026-09-20-screens-100/01-…-09.txt`
- `docs/reviews/evidence/2026-09-20-screens-60/01-…-09.txt`

Each file records one scenario. Annotation lines start with `#` and are kept
separate from the verbatim program output. The command line is shown as
`$ apkit …`. Files for scenarios 01–07 and 09 have two parts, clearly separated by
`# --- Part … ---` lines:

- **Part 1** is the transcript up to the moment the setup confirmation prompt
  is waiting for an answer, before the answer is sent — what a user would see
  with the confirmation waiting.
- **Part 2** is the same run after the user declined the confirmation.

Scenario 08 is a pre-confirmation refusal, so it has a single verbatim part and
no confirmation prompt. Every scenario declined the confirmation, so no
captured run wrote anything.

Mechanics:

1. **Real PTY.** Each run executed the packed CLI under
   `test/support/pty-controller.py`, which allocates a genuine pseudo-terminal
   (`pty.fork`) so the child sees raw-mode keypresses and the real terminal
   width, with `TERM=xterm-256color` and the target width, and an absolute
   20-second watchdog that kills the child and records `PTY-CONTROLLER-WATCHDOG`
   / exit 124 if a prompt ever hangs.
2. **Isolated home, asserted.** Every `apkit` run used a fresh, disposable
   `HOME` folder created for that one run inside a throwaway sandbox directory
   under `/private/tmp`. Before each run the capture driver asserted that
   `HOME` equals exactly that folder and appended the assertion to a capture
   log retained in the sandbox. `apkit` never ran with the real user's home,
   and the real user's `~/.agents` was never read or hashed.
3. **Snapshot at the confirmation.** The driver drove each run over the real
   PTY and, for every scenario with a confirmation prompt, read the transcript
   when the confirmation appeared and before sending the answer (Part 1); the
   answer was then declined and the full transcript read at exit (Part 2). For
   screens 01 and 02, in which earlier questions were already answered inside
   the same run, the driver applied exactly the erase-in-line and
   carriage-return/overwrite codes the prompt library emits, so a prompt line
   rewritten in place keeps only its final answered form — what a real
   terminal would show.
4. **No hand composition.** The only post-processing was: applying those
   erase-in-line and carriage-return codes as above; removing all other escape
   sequences (colors, cursor show/hide, save/restore-cursor); removing
   `PTY-CONTROLLER` controller lines; and replacing the sandbox path with
   `<SANDBOX>` and each run's home folder with `<SANDBOX_HOME>`. No screen is
   composed, drawn, or edited by hand; all text comes from real runs.
5. **Seeded connections.** Screens 05 and 06 require a machine that is already
   connected; the driver seeded that connection non-interactively with the same
   packed release candidate (with the same asserted `HOME`) before the
   interactive run.

Scenarios:

| File | Scenario |
| --- | --- |
| `01-first-connection-current-folder` | Unconfigured machine; current folder is non-empty with project files and `.git`; user accepts the current folder, then declines the confirmation. |
| `02-first-connection-custom-path` | Unconfigured machine; user declines the current folder and types a custom path (`~/my-workspace`) to a folder that does not exist yet, then declines the confirmation. |
| `03-first-connection-explicit-valid` | Path argument to an existing folder that already satisfies the Workspace contract; location question is skipped. |
| `04-first-connection-explicit-new` | Path argument to a folder that does not exist yet, inside an existing parent; confirmation notes folder creation. |
| `05-connect-different-valid` | Machine already connected to `workspace-a`; connecting to existing valid `workspace-b` (#607). |
| `06-connect-different-new` | Machine already connected to `workspace-a`; connecting to a folder that does not exist yet (#607). |
| `07-first-connection-consolidate-valid-material` | Folder already contains valid `context/` and `skills/`; confirmation lists exactly the missing parts. |
| `08-refusal-invalid-scattered-material` | Raw sample material with uppercase names in `context/`; init refuses before any confirmation or write. Pre-confirmation refusal, not a confirmation screen. |
| `09-connect-different-partial-target` | Machine already connected to `workspace-a`; connecting to a folder that already holds valid `context/` and `skills/`; the confirmation lists exactly the missing parts (`workspace.yaml` and `profiles/`). The connect-different analog of screen 07. |

## 3. Limitations

1. **Unpublished release candidate.** The install command is
   facilitator-provided: the goal sheets instruct
   `npm install -g <PATH_TO_PACKED_RELEASE_CANDIDATE_TARBALL>` because the
   release candidate is unpublished and a newcomer cannot obtain it from a
   public registry.
2. **Nested terminal.** The captures were made inside a nested terminal — a
   Herdr pane — see [#626](https://github.com/kenneth-liao/agent-profile-kit/issues/626):
   on this machine, real-PTY behavior under that nesting differs from CI (two
   real-PTY tests fail locally in every full-suite run but pass in CI). The
   screen text is a faithful transcript of the runs as made, but a plain
   terminal could render cosmetic differences. The final qualifier for the
   repository's own checks is CI on the PR head; the local full suite was not
   run for the same reason.
3. **All confirmations declined.** Every captured run declined the setup
   confirmation, so no screen shows the output after acceptance, and no
   captured run wrote anything. The after-acceptance journey is exercised by
   the #609 agent runs and remains for the human runs to observe.
4. **Location question coverage.** Only screen 02 shows the "Which folder
   should be your Workspace?" prompt; screens 03–08 pass the folder as a
   command argument, so that prompt is not rendered there. Conversely, the
   unanswered form of the first question in screens 01–02 does not appear
   anywhere, because each capture snapshot is taken when the *confirmation*
   prompt is already waiting and earlier questions appear only in their final
   answered form (their rewrite semantics are applied, as described in the
   capture method).
5. **Typed path length.** The typed path in screen 02 (`~/my-workspace`) was
   chosen so the answered prompt line fits a 60-column terminal; the value is
   arbitrary and the capture is otherwise unmodified.
6. **Not captured.** Nothing about a newcomer's actual behavior, timing, or
   comprehension — the captures show machine output only. No human session has
   run; ISC-19, ISC-20, and ISC-24.3 have no evidence beyond this preparation.
7. **The captures are point-in-time evidence for the product wording of head
   `e18f359` and are guarded by no automated check.** The checks cited in this
   PR (typecheck and the release-boundary/package-archive tests) exercise the
   renderer, never the committed `.txt` bytes, so a hand-edited capture file
   would pass them. The committed captures were audited by hand during review:
   every verbatim line was traced to the `cli/` sources, no verbatim line is
   wider than its terminal width, and the 60- and 100-column files wrap
   visibly differently as real output would. That audit covers only the files
   as committed; any later edit to a capture file is not covered by it, and
   the review is not maintained (ADR-0029).

## 4. Facilitator checklist

For each human session (ISC-19 no-material, ISC-20 sample material):

- [ ] **Pack the release candidate from `main` at run time.** Do not reuse an
      older tarball: check out a fresh `main`, run `bun run build`, then
      `npm pack --ignore-scripts`, as `test/release-candidate.test.ts` packs
      it.
- [ ] **Fresh environment.** Each newcomer runs in an environment with no
      prior Agent Profile Kit state: no Local Configuration, no existing
      Workspace, nothing pre-installed except what the sheet says.
- [ ] **SAFETY WARNING — read before agreeing to host a session.** On the
      principal's own computer, the newcomer must use a separate OS user
      account or a virtual machine, never the principal's own user account:
      `apkit init` run in the principal's home re-points the principal's real
      Local Configuration. This risk applies to every machine that already has
      a connected apkit installation, not only the principal's.
- [ ] **Hand over only the sheet.** Choose
      [`evidence/2026-09-20-newcomer-no-material.md`](evidence/2026-09-20-newcomer-no-material.md)
      or
      [`evidence/2026-09-20-newcomer-sample-material.md`](evidence/2026-09-20-newcomer-sample-material.md),
      fill in `<PATH_TO_PACKED_RELEASE_CANDIDATE_TARBALL>` (and
      `<PATH_TO_SAMPLE_MATERIAL>` for the material sheet), and give the
      newcomer the file's content, nothing else.
- [ ] **Observe without intervening.** Note start and end times and anything
      the newcomer says or asks.

**What counts as coaching** — any one of these fails the uncoached requirement
of ISC-19 / ISC-20:

- Naming, suggesting, or explaining any `apkit` command, flag, prompt, or
  output line.
- Suggesting or choosing a Workspace folder location, or answering any setup
  prompt for the newcomer.
- Interpreting the README or the CLI output for the newcomer, or telling them
  what to do next.
- Touching the newcomer's keyboard, editing their files, or fixing a mistake
  before the newcomer says they are stuck or done.

General computer help that never mentions Agent Profile Kit — OS account
login, terminal basics — is not coaching. Installing Node is part of the
recorded result, not coaching, as long as no Agent Profile Kit guidance is
given.

**After the newcomer says they are done**, the facilitator checks that the
Workspace is valid and connected:

- [ ] `apkit validate <the newcomer's Workspace folder>` exits 0.
- [ ] The machine's Local Configuration connects that Workspace (for example,
      `apkit status` shows the configured Workspace as that folder).
- [ ] For the material session only: every file of the provided sample
      material is present inside the Workspace.
- [ ] Record the answers in the result template (section 6).

**Pass and fail conditions**, quoted exactly from the probes in `ISA.md`:

> **ISC-19:** An unfamiliar user starting with no Context or Skills reaches
> a valid, connected Workspace without coaching.
> Probe: observe a newcomer from a fresh install using only public guidance and
> CLI output; coaching, or a Workspace that is invalid or not connected, fails.

> **ISC-20:** An unfamiliar user with scattered Context and Skill files
> reaches a valid, connected Workspace that contains that material without
> coaching.
> Probe: observe a newcomer given prepared scattered material and only public
> guidance; coaching, missing material, or a Workspace that is invalid or not
> connected, fails.

> **ISC-24.3:** The setup confirmation explains what making the folder the
> Workspace means.
> Probe: principal reviews rendered setup confirmation screens at 100 and 60
> columns; a missing or unclear explanation fails.

For ISC-24.3 the principal reviews the committed screens in
`evidence/2026-09-20-screens-100/` and `evidence/2026-09-20-screens-60/`.

## 5. Material-approval checklist (TEST-013)

TEST-013 in the spec reads, exactly:

> **TEST-013** — Scattered sample material for TEST-001 and TEST-012 is neutral: instruction files in project folders (a root `AGENTS.md`, a `CLAUDE.md`, and a nested instruction file) and standard Skills in more than one Host folder, including one Skill with Host-specific frontmatter and one Skill with `references/` and `scripts/` Skill Resources. The principal approves the material before human runs. Qualification runs use the packed release candidate built from `main`, with the README read on `main`.

The material under review is [`test/support/fixtures/scattered-sample/`](../../test/support/fixtures/scattered-sample/)
— its [`README.md`](../../test/support/fixtures/scattered-sample/README.md)
(provenance and specification note, kept outside `material/`) and its
[`material/`](../../test/support/fixtures/scattered-sample/material) folder:

- `material/AGENTS.md`, `material/CLAUDE.md`, `material/docs/AGENTS.md` —
  instruction files in project folders, including a nested one.
- `material/.claude/skills/code-review/SKILL.md` — a standard Skill package
  with Host-specific frontmatter.
- `material/.agents/skills/build-helper/` — a standard Skill package with
  `references/reference.md` and `scripts/build.sh` Skill Resources.

Approval boxes for the principal:

- [ ] The material matches TEST-013 as quoted above (neutral; instruction
      files in project folders; standard Skills in more than one Host folder,
      including one with Host-specific frontmatter and one with `references/`
      and `scripts/` Skill Resources).
- [ ] The material represents what real users have.
- [ ] The material is approved for the human runs; any requested change goes
      back to #608 before a newcomer session starts.

The second box is the principal's judgment to record because `ISA.md` lists
the material's realism under **Not yet specified**, exactly:

> - What scattered sample material ISC-20 and ISC-21 must contain to represent
>   real users (which Host folders and instruction files).

Qualification runs must additionally use the packed release candidate built
from `main`, with the README read on `main` (facilitator checklist, first box).

## 6. Result template (unfilled)

Record the results of each human session in a **new** dated review file
(`docs/reviews/YYYY-MM-DD-<subject>.md`). **This file is never edited with
results.** Copy this block once per session and fill every field:

```markdown
## Human session — <date>

- Ticket: #610 (TEST-012 human runs)
- Sheet used: no material / sample material
- OS: <name and version>
- Node version: <version>
- Who installed Node: <the newcomer / the facilitator before the session / already present>
- Pack used: <archive file name and sha256, packed from main at run time>
- Coaching observed: <none / what happened and what was said>
- Outcome: <valid and connected Workspace reached: yes / no; for the material
  session, all provided material present: yes / no>
- Facilitator checks: <apkit validate exit code; connected Workspace observed;
  material presence>
- Duration: <start and end time>
- Notes: <questions asked, mistakes made and recovered, anything else
  observed>
```

ISC-24.3 is recorded separately by the principal: a verdict on whether the
rendered confirmation screens at 100 and 60 columns explain what making the
folder the Workspace means, referencing the screen files by path.

## 7. Sanitization statement

Every `apkit` execution for this review ran with `HOME` set to a dedicated
disposable folder inside a throwaway sandbox directory under `/private/tmp`,
never the real user's home; the capture driver asserted `HOME` equality before
each run and appended every assertion to a capture log retained in that
sandbox. The real user's `~/.agents` was never read or hashed, and no real
Local Configuration was modified. In the committed evidence, the sandbox path
appears only as `<SANDBOX>` and each run's home folder only as
`<SANDBOX_HOME>`. All new files in this change were checked for absolute
`/Users/` paths, the real username, the sandbox directory name, email
addresses, JWTs (`eyJ`), API keys (`sk-`), `Bearer` tokens, and token fields;
none are present.
