# apkit UI/UX review — 2026-09-09

An independent product review of the `apkit` CLI as a newcomer experiences it,
and as a returning user runs it daily. Observations only. See
[ADR-0029](../adr/0029-keep-dated-observational-reviews-in-docs-reviews.md) for
what this file is and is not: findings here are one reviewer's observations of
one build on one day, not maintained backlog. Work graduates to the issue
tracker.

## 1. Method, environment, and limits

| Item | Value |
| --- | --- |
| Engine under test | `apkit` 0.173.3 (Homebrew-linked `dist/cli.js`) |
| Date | 2026-09-09 |
| Platform | macOS (Darwin 25.6.0), zsh |
| Reviewer model | claude-opus-5, medium effort |
| Terminal widths | 100 and 60 columns |
| Terminal type | `xterm-256color`, real PTY |

**Isolation.** Every tested process ran with a command-scoped `HOME` pointing at
a disposable sandbox, so the reviewer's real Workspace, Local Configuration,
Installation State, and Projects were never read or written. `HOME` is the only
isolation lever the engine offers: the bundle reads exactly `HOME`,
`CODEX_HOME`, `GROK_HOME`, `LOG_STREAM`, and `LOG_TOKENS`, with no dedicated
config override. Host executable and version detection was left real, so
`(installed)` labels in the transcripts reflect this machine. No Host session
was launched and no Host model was called; the review stops at installation and
handoff guidance.

**How the CLI was driven.** All interactive flows ran through a real PTY with a
fixed window size, capturing raw ANSI bytes. Non-interactive behaviour was
tested separately by piping. Raw transcripts are under
[`evidence/`](evidence/), with sandbox paths replaced by `<SANDBOX>`.

**Two limits worth stating plainly.**

- Colour and emphasis were assessed by reading the escape sequences in the
  captured byte stream, not by looking at rendered screenshots. Claims about
  which role gets which colour are byte-level facts; claims about how a palette
  *feels* on a given theme are inference. See
  [`evidence/09-ansi-palette.txt`](evidence/09-ansi-palette.txt).
- A model walking a CLI is not a usability study. Real newcomers get confused in
  ways no simulation predicts, and they abandon tasks a model will grind
  through. Read the friction findings as hypotheses with evidence attached, not
  as measured failure rates.

## 2. Journey coverage

Phase 1 was run before reading `CONTEXT.md`, the ADRs, `docs/USER-JOURNEY.md`,
or any spec. Notes were frozen before Phase 2 began.

Covered, in order: bare `apkit` on an unconfigured machine; `init` both
declining and accepting the guided Profile flow; `guide`, `guide profile`,
`guide context`, `guide skill`, `guide --full`; `new context`, `new skill`,
`new profile`; hand-editing Workspace YAML; `validate` against a mistyped
reference and after repair; `bind` interactively and with explicit flags;
`status`, `status --verbose`, `status --here`, `status --all`, `status --stale`,
`status --blocked`, `status --json`; `apply` first-install, no-op, after a
canonical edit, against drifted output, and against a deleted generated file,
both interactively and piped; `unbind`; `uninstall`; `list projects`,
`list profiles`, `list hosts`, `list --json`; `info`; every per-command
`--help`; `NO_COLOR`; and Ctrl-C cancellation.

Scale: 18 bound Projects across all six supported Hosts, three Profiles, long
basenames (`sandbox-experiments-2025-q1-archive`,
`acme-internal-analytics-pipeline-v2`) and a colliding pair
(`fleet/alpha/service`, `fleet/beta/service`).

Not covered: Windows or Linux, `machine install-temp` and the temporary
installation family, Git-tracked-output Blockers, multi-user or network cases,
and any real Host loading.

Latency was never a problem. At 18 Projects, `status --all` took 0.2s, a full
`apply` 0.86s, `list projects` 0.06s. No progress affordance is needed at this
scale and none is missed.

## 3. What works, and works well

These are not consolation prizes. Several of them are better than what
comparable tools ship.

**The `--help` template.** Every command answers Purpose, Usage, Examples,
**Writes**, and Next, in that order. The `Writes:` line is the single best thing
in this CLI. `apkit unbind` telling you up front that it "Removes one configured
Project from settings; does not remove installed project files" is exactly the
sentence that decides whether a nervous user runs the command.

**Teaching by echo.** Interactive `init` and `bind` finish by printing the
non-interactive equivalent of what you just did:

```
Run the same bind without the prompt:
  apkit bind engineering <SANDBOX>/projects/my-app --host claude --host codex
```

This is how a CLI teaches itself. It is applied consistently and it works.

**The `validate` diagnostic.** A one-character typo produces the offending file,
the invalid value, the available names, a near-match suggestion, and the repair
command. Four facts and an action, in six lines. See
[`evidence/08-validate-typo.txt`](evidence/08-validate-typo.txt).

**Cancellation.** Ctrl-C during `bind` prints `bind was cancelled; no
configuration was changed` and leaves the existing binding untouched. Declining
the changed-output confirmation prints `your edits to the named generated files
are preserved`. The tool says what it did *not* do, which is what an anxious
user needs.

**`--replace` shows a diff, not a result.**

```
Replaced configured Project for <SANDBOX>/projects/fleet/api
  Profile: engineering → writing
  Hosts: codex, grok → claude
```

**Wrapping policy.** Prose hard-wraps with a two-space continuation indent;
commands and paths never wrap. At 60 columns the help and guide screens stay
readable and copy-pasteable. `NO_COLOR=1` removed every escape byte.

**`--stale`.** After editing one Context Module, `status --stale` named exactly
the six Projects whose Profile selects it. That is the daily-loop question,
answered in one command.

**The empty state.** A bare `apkit` on an unconfigured machine is three lines
and one command. Hard to improve.

## 4. Findings

Severity uses the repository meanings: **Blocker** makes the change unsafe,
**Should-fix** needs a disposition, **Nit** is optional polish. Product
priority is separate.

### Blockers

---

#### B1 — `uninstall` destroys hand-edited generated files across the whole machine, unprompted

**Priority: high.** Observed and reproduced.

`apkit apply` guards a hand-edited generated file behind an interactive
confirmation that defaults to no. `apkit uninstall` deletes the same bytes,
across every configured Project on the machine, with no confirmation, no
`--dry-run`, and no way to scope to one Project.

Reproduction (sandbox `HOME`, one bound Project):

```
$ apkit apply                       # installs .claude/rules/agent-profile-kit.md
$ echo "MY IRREPLACEABLE NOTE" >> .claude/rules/agent-profile-kit.md
$ apkit status --here
Ready to apply
- generated files changed (1): .
Next: apkit apply --here

$ apkit uninstall
$ ls .claude/rules/
                                    # empty. The note is gone.
```

`status` correctly identified the drift one command earlier. `uninstall` then
removed the file without mentioning it.

This is a requirements-level decision, not an implementation slip.
`docs/USER-JOURNEY.md` stage 12 states that teardown "never prompts — on any
input stream, including an interactive terminal (US-055 teardown clause,
DEC-030, DEC-031)", justified by the claim that "re-binding and re-applying
recovers both". That claim is true for pristine generated output and false for
edited output: re-applying restores Workspace content, which is precisely not
what was lost. So the safety argument that licenses the no-prompt rule does not
cover the case where the rule causes harm.

The `Writes:` line compounds it. `apkit uninstall --help` says it "Removes owned
generated project files and machine-local installation records; keeps the
Workspace and configured Projects." A reader takes "owned" to mean "files apkit
made", not "files apkit made and you then changed".

**Proposed change.** Keep the no-prompt rule for pristine output, which is where
it earns its keep. Make hand-edited output the typed exception the confirmation
gate already recognises, and give teardown the scope arguments `status` and
`apply` already have.

```
$ apkit uninstall
Removing generated files from 16 Projects.

2 files differ from what apkit installed and will be deleted:
  ~ .claude/rules/agent-profile-kit.md   (<SANDBOX>/projects/my-app)
  ~ .agents/rules/agent-profile-kit-010-writing-style.md   (<SANDBOX>/projects/fleet/docs)

? Delete these too? (y/N) ›

Keeping them and removing the rest:  apkit uninstall --keep-changed
Previewing without deleting:         apkit uninstall --dry-run
Limiting the scope:                  apkit uninstall --here
```

---

#### B2 — Non-interactive `apply` silently replaces changed generated files

**Priority: high.** Observed and reproduced.

The same bytes that require an explicit `y` on a terminal are overwritten
without a word when stdin is not a TTY, and without `--replace-changed`:

```
$ echo "SECOND TWEAK" >> .claude/rules/agent-profile-kit.md
$ apkit apply < /dev/null
Apply complete

Applied:
  ~ 1 generated file update in 1 project
  ~ .claude/rules/agent-profile-kit.md
    (<SANDBOX>/projects/my-app)
$ tail -1 .claude/rules/agent-profile-kit.md
                                    # the tweak is gone
```

This follows the requirements as written. US-029 scopes the confirmation to "a
user on an interactive terminal"; US-030 requires that non-interactive apply
"never prompt"; US-031 makes `--replace-changed` an *answering* flag rather than
a required one. Nothing in that set says the non-interactive default should be
"replace". The receipt does name the replaced file (US-028 holds), but a receipt
printed after the fact is not consent.

This matters more than it looks. Agents run `apkit` through non-interactive
shells. The population most likely to hit this is the population least likely to
be reading the receipt.

**Proposed change.** Make the non-interactive default *refuse* rather than
replace, and let the existing flag opt in. The prompt stays banned; the safe
answer becomes the default answer.

```
$ apkit apply < /dev/null
apkit: 1 generated file differs from what apkit installed; nothing was written
  ~ .claude/rules/agent-profile-kit.md (<SANDBOX>/projects/my-app)
Your edits are preserved. To replace it with current Workspace content, run
  apkit apply --replace-changed
```

Exit `2`, consistent with the blocker exit code.

### Should-fix

---

#### S1 — Editing a Profile's membership has no command

**Priority: high.** Observed. This sits directly on the stated user goal of
editing canonical material and pushing it everywhere.

`apkit new` creates material and then tells you to do something it gives you no
way to do:

```
$ apkit new context review-standards
Created Context Module review-standards at
  <SANDBOX>/.../workspace/context/review-standards.md
Next: select the Context Module from a Profile, then run apkit validate
```

"Select the Context Module from a Profile" is the one step in the whole journey
with no command behind it. The user must find `profiles/<name>.yaml`, learn the
YAML shape from `apkit guide profile`, and hand-edit a list. `apkit new profile`
accepts `--context` and `--skill`, but only at creation time and it refuses to
overwrite. `apkit open` opens a file manager, not the file.

This also makes the interactive `init` flow strictly more capable than anything
available afterwards: `init` offers a multi-select of Context Modules, and that
picker is unreachable once setup is done.

**Proposed change.** Give the existing selection picker a permanent home.

```
$ apkit edit profile engineering
? Which Context Modules?  (space to toggle, enter to accept)
  ◉ example-context
  ◉ review-standards
  ◯ writing-style
? Which Skills?
  ◉ review-pr

Updated Profile engineering
  Context: example-context, review-standards
  Skills:  review-pr
Run the same edit without the prompt:
  apkit edit profile engineering --context example-context --context review-standards --skill review-pr
Next: apkit status
```

---

#### S2 — Generated project files do not say they are generated

**Priority: high.** Observed.

`.claude/rules/agent-profile-kit.md` opens with:

```
# Agent Profile Kit Context — Profile: engineering
Repository-owned project instructions, including AGENTS.md, take precedence ...
```

Nothing tells the reader the file is disposable, that the canonical source is
elsewhere, or what happens to an edit made here. The product's entire ownership
model — the thing B1 and B2 are about — is communicated only in the CLI, which
is not where someone opening the file in an editor is standing.

**Proposed change.** One banner line, present in every generated text artifact:

```
<!-- Generated by apkit from Profile `engineering`. Edits here are replaced on
     the next `apkit apply`. Edit the Workspace instead: `apkit open`. -->
```

---

#### S3 — `list projects` is a wall, not a table

**Priority: high.** Observed. Shortfall against the acceptance criterion of
US-015 in spec #373, which asks for "one aligned logical row per Project with
all four requested fields and a summary footer".

The footer shipped. The aligned row did not. Each Project gets four unaligned,
unseparated lines, so 18 Projects is 77 lines
([`evidence/05-list-projects-60col.txt`](evidence/05-list-projects-60col.txt)):

```
Projects (18):

Project: /tmp/.../projects/my-app
Profile: engineering
Hosts: claude, codex
State: configured
Project: /…/fleet/acme-internal-analytics-pipeline-v2
Profile: writing
Hosts: antigravity, claude
State: configured
...
18 Projects configured.
```

Note also that path elision is inconsistent inside one listing — some rows keep
the full path, some are middle-elided with `/…/`, and an elided path is not
copyable.

**Proposed change.** One row per Project, columns aligned, path elided only from
the left and only when the row does not fit:

```
Projects (18)

PROJECT                                       PROFILE      HOSTS               STATE
my-app                                        engineering  claude, codex       configured
fleet/acme-internal-analytics-pipeline-v2     writing      antigravity, claude configured
fleet/acme-internal-analytics-pipeline-v3     engineering  claude, codex       configured
fleet/alpha/service                           engineering  claude              configured
...
18 Projects · 2 Profiles · 6 Hosts · all under <SANDBOX>/projects
```

At 60 columns, drop the HOSTS column to a second dim line rather than wrapping
the table.

---

#### S4 — The fleet apply receipt groups by filename instead of by Project

**Priority: high.** Observed. Fleet apply over 16 Projects printed 133 lines
([`evidence/03-apply-bare-fleet-receipt.txt`](evidence/03-apply-bare-fleet-receipt.txt)):

```
Applied:
  + 66 generated file additions in
    <SANDBOX>/projects/fleet/acme-internal-analytics-pipeline-v2,
    ... 15 more paths ...
  + .agent-profile-kit/codex/context.md
    (<SANDBOX>/projects/fleet/acme-internal-analytics-pipeline-v3)
  + .agent-profile-kit/codex/context.md (<SANDBOX>/projects/fleet/api)
  + .agent-profile-kit/codex/context.md
    (<SANDBOX>/projects/fleet/mobile-android)
  ... 60 further lines ...
```

The full Project list is printed once, then effectively printed a second time
scattered through 66 file lines. Grouping by filename is the wrong axis: a user
asks "did my 16 repos get updated", not "which repos got a `context.md`".
ADR-0020 requires that a semantic fact render once, and the Project set renders
twice here.

**Proposed change.** Lead with the shape of the change, then per-Project counts,
and move the file inventory to `--verbose`:

```
Apply complete

Applied to 16 Projects · 66 files added
  engineering (10 Projects, 5 files each)   claude, codex, grok, opencode, pi
  writing      (6 Projects, ~3 files each)  antigravity, claude, grok, opencode

Every configured Project is now current.
Per-file detail: apkit apply --verbose
```

---

#### S5 — `uninstall` prints 263 lines and repeats the same absolute path per entry

**Priority: medium.** Observed
([`evidence/04-uninstall-fleet.txt`](evidence/04-uninstall-fleet.txt)). Every
cleaned Git exclusion carries the full absolute path of its own
`.git/info/exclude`, once per entry:

```
  Cleaned Git exclusions:
  - /.agent-profile-kit/codex/context.md
    (<SANDBOX>/projects/fleet/acme-internal-analytics-pipeline-v3/.git/info/exclude)
  - /.agents/skills/review-pr
    (<SANDBOX>/projects/fleet/acme-internal-analytics-pipeline-v3/.git/info/exclude)
```

ADR-0020 classifies Repository Exclusion bookkeeping as verbose evidence. It is
appearing in the default teardown view.

**Proposed change.** Default to a per-Project count line; keep the inventory for
`--verbose`.

---

#### S6 — Two state vocabularies for the same facts

**Priority: medium.** Observed.

ADR-0026 defines a closed five-cause partition for the default view:
`needs attention`, `generated files changed`, `generated files missing`,
`not installed yet`, `source changed`. That is a good vocabulary and it is
delivered. But `--verbose` speaks a different one for the same conditions:
`addition`, `drifted output`, `stale source`, `current`. And the settled outcome
introduces a sixth word, `settled`, that appears nowhere else.

A user who moves from `status` to `status --verbose` to find out more is handed
a new dictionary at the exact moment they are already confused. Two of the pairs
are not even obviously synonymous: is `stale source` the same thing as `source
changed`?

**Proposed change.** Make `--verbose` use the same five cause names as the
default view and add detail beneath them, rather than renaming them. If the
verbose names carry a distinction the concise names lose, say what it is.

---

#### S7 — The same Project renders as two different paths in one view

**Priority: medium.** Observed. After `unbind`:

```
- needs attention (1):
  /private/tmp/claude-501/apkit-review/projects/fleet/api
    Apply will remove generated files for unbound projects.
- source changed (6):
  /tmp/claude-501/apkit-review/projects/fleet/acme-internal-analytics-pipeline-v2,
```

Two spellings of the same root, in adjacent lines of one list. `list --json`
shows the cause: each Project carries both `canonicalProject`
(`/private/tmp/...`) and `project` (`/tmp/...`), and different formatters reach
for different fields.

This is the repository's own single-source-of-truth rule failing at the
presentation boundary: one fact, two homes, and readers disagree. It also breaks
scanning and de-duplication for a user grepping their fleet.

**Proposed change.** Pick the display identity once at the presentation
boundary, per ADR-0016's single-context rule, and let no human view read
`canonicalProject`.

---

#### S8 — Scoped views claim to speak for all Projects

**Priority: medium.** Observed. In one bound Project, with 17 others configured:

```
$ apkit status --here
All Projects are current (1 Project)
```

ADR-0026 defines that sentence for the wholly-settled *fleet*. It is being reused
verbatim for `--here` and for single-Project scope, where it says something
false and alarming: a user who just narrowed to one directory is told every
Project is fine.

**Proposed change.** Let the sentence name its scope. `This Project is current`
for `--here`, `<name> is current` for an explicit Project, and reserve
`All Projects are current (N Projects)` for the fleet.

---

#### S9 — `bind` offers no near-match for a mistyped Profile or Host

**Priority: medium.** Observed. Spec #373's problem statement asserts that
"`bind` and unknown-command handling both already offer near-matches", and
US-025 asks for the same behaviour on referenced names. `validate` and
`new profile --context` both do it. `bind` does not, at any edit distance:

```
$ apkit bind enginering --host claude
apkit: Profile 'enginering' does not exist in this Workspace.
Available Profiles: engineering, example, writing.

$ apkit bind engineering --host claud
apkit: unsupported Agent Host 'claud'
supported Hosts: antigravity, claude, codex, grok, opencode, pi
```

The Host error also breaks the sentence-casing every other diagnostic follows.

**Proposed change.** Route both through the suggestion path `validate` already
uses, and capitalise consistently:

```
apkit: Profile 'enginering' does not exist in this Workspace.
Available Profiles: engineering, example, writing.
Did you mean 'engineering'?
```

---

#### S10 — Three error messages are assembled wrong

**Priority: medium.** Observed. These are separate defects with one shape: the
message is composed from fragments that were written for a different context.

`status` against a path that does not exist stutters its own name and its own
noun:

```
apkit: apkit status Project target project
  '<SANDBOX>/projects/fleet/nonexistent' must be an existing directory
```

`bind` against a missing directory leads with a configuration file path, which
is exactly the failure US-023 exists to prevent, and buries the actual cause in
the last clause:

```
apkit: Local Configuration
  <SANDBOX>/home/.agents/agent-profile-kit/config.yaml
  project '<SANDBOX>/projects/nope' must be an existing directory
```

`new profile` with a mistyped `--context` reuses `validate`'s wording, so it
describes a file it did not create and tells the user to correct it:

```
apkit: Profile 'p2' in profiles/p2.yaml selects missing Context Module
  'writting-style'.
...
Correct profiles/p2.yaml, then run apkit validate.
```

No `p2.yaml` exists; the command correctly wrote nothing. The user is sent to
repair a file that is not there.

**Proposed change (the `bind` case, as the pattern for all three):**

```
apkit: '<SANDBOX>/projects/nope' is not a directory, so it cannot be bound.
Create it first, or bind a directory that exists:
  apkit bind engineering <path> --host claude
```

---

#### S11 — `new` reports a duplicate as a bare string

**Priority: low.** Observed.

```
$ apkit new skill review-pr
apkit: Skill name 'review-pr' is duplicated
```

No path, no cause, no command. US-022 asks every failure to state what happened,
why, and what to type. Proposed:

```
apkit: a Skill named 'review-pr' already exists.
  <SANDBOX>/.../workspace/skills/review-pr/SKILL.md
apkit new never overwrites existing material. Either edit that file, or choose
another name:
  apkit new skill review-pr-strict
```

---

#### S12 — `guide --full` is a specification, and beginners are pointed at it

**Priority: medium.** Observed. Root `--help` closes with:

```
For deeper Workspace authoring guidance (Context Modules, Skills, Profiles, and
bindings), run
  apkit guide --full.
```

That command prints 633 unpaged lines opening on ownership theory:

```
- The **Workspace** may canonically own both Profile-selected artifacts and
  **unselected universal** artifacts ...
- Agent Profile Kit v1 does not install, project, synchronize, or remove
  material in personal/global Host roots. Global Host delivery is not APK-owned
  state ...
```

Spec #373 cut the same document from 704 lines by adding the three focused
topics, and those topics are genuinely good: short, concrete, copy-pasteable,
and they state the Workspace path before asking you to create a file (US-048
delivered). But the long document was left in place, still carrying the
implementer's voice, and root help still routes the newcomer to it rather than
to `apkit guide`.

Two smaller things travel with this. The focused guides teach hand-authoring
(`Create context/example-context.md:`) and never mention `apkit new`, which is
the command that does it for you. And the guides render raw Markdown in the
terminal — a literal `# Profile` heading and literal ```` ```yaml ```` fences.

**Proposed change.** Point root help at `apkit guide`, not `guide --full`. Have
each focused topic lead with the scaffold command and show the resulting file as
the explanation, not the instruction:

```
# Context Module

A Context Module is a reusable block of always-loaded guidance.

  apkit new context review-standards

creates this, in ~/.agents/agent-profile-kit/workspace/context/:

  ─────────────────────────────────────────
   ---
   id: review-standards
   dependencies: []
   ---
   Keep project-specific instructions in the project repository.
  ─────────────────────────────────────────

Edit the text, then add it to a Profile: apkit edit profile <name>
```

---

#### S13 — `init` ends with two contradicting next steps

**Priority: medium.** Observed
([`evidence/01-init-interactive.txt`](evidence/01-init-interactive.txt)). After
creating a Profile named `engineering`, the guided flow prints:

```
Initialized Agent Profile Kit Workspace and settings at ~/.agents/...
A Profile is a named selection of Context and Skills to adapt for your projects.
Detected Agent Hosts: antigravity, claude, codex, grok, opencode, pi
Next: from the project you want to try, run apkit bind example --host antigravity
Created Profile engineering at
  <SANDBOX>/.../workspace/profiles/engineering.yaml
  Context: example-context
Available Context Modules: example-context
Available Skills: none
Next: run apkit validate, then bind the Profile to a Project
```

Two `Next:` lines. The first arrives before the user is told their Profile was
created, names `example` instead of the Profile they just made, and picks
`antigravity` because it sorts first among detected Hosts — satisfying US-039's
"names a detected Host" while ignoring which Host the user actually uses. The
one-sentence Profile explanation (US-033) is printed a second time here, after
the choice it exists to inform.

**Proposed change.** One receipt, one next step, naming what the user made:

```
Workspace ready at ~/.agents/agent-profile-kit/workspace
Created Profile engineering
  Context: example-context
  Skills:  none

Found on this machine: antigravity, claude, codex, grok, opencode, pi

Next: from a project you want to try it in, run
  apkit bind engineering --host <host>
```

---

#### S14 — Routine applies reprint the first-run verification paragraph

**Priority: low.** Observed. Every successful changed apply, including the
hundredth, closes with:

```
Profile engineering will load the next time you launch a configured Host from a
  bound Project root.
To check that claude and codex loaded Profile engineering, start a new session
  of each configured Host in <SANDBOX>/projects/my-app and ask each Host what
  Profile material it loaded; the installed material should appear in the
  answers.
```

US-041 asks for a concrete verification action and ADR-0020 permits first-use
guidance "only when the Apply Receipt makes that guidance relevant". A routine
re-sync after a one-word Context edit does not make it relevant. The
authoring-handoff teaching (US-040) is correctly suppressed on routine applies;
this paragraph is not.

**Proposed change.** Print it on first install into a Project and after a Host
set change. Otherwise close on the receipt.

---

#### S15 — The Host picker does not preselect, and does not name its target

**Priority: low.** Observed. `apkit bind writing` in a Project already bound to
`codex, grok` shows all six Hosts unchecked and never states which directory it
is about to bind. A user re-binding to add one Host must remember and re-check
the existing ones, and a user in the wrong directory gets no warning.

**Proposed change.** Title the picker with the target, and preselect what is
already bound:

```
Binding <SANDBOX>/projects/fleet/api  (currently: engineering · codex, grok)
? Which Agent Hosts?  (space to toggle, enter to accept)
  ◯ antigravity (installed)
  ◯ claude (installed)
  ◉ codex (installed)
  ◉ grok (installed)
```

---

#### S16 — The README documents a scope the CLI does not have

**Priority: medium.** Observed.

```sh
apkit status                                # review the plan for the bound project
apkit apply                                 # install the Profile into the project
```

Both are fleet-scoped. DEC-001 made that deliberate and `docs/USER-JOURNEY.md`
records it, but the README still describes the pre-#373 behaviour. A newcomer
following the README from inside one repository will run a command that writes
into every configured Project on the machine and be told, by the document that
sent them there, that it touched one.

**Proposed change.** Correct the comments and say the default out loud:

```sh
apkit bind <profile> --host <host>   # bind this project to a Profile
apkit status                         # what needs updating, across every bound project
apkit apply                          # bring every bound project up to date
apkit apply --here                   # ...or just this one
```

---

#### S17 — `uninstall`'s default view speaks the ownership model

**Priority: low.** Observed.

```
Removed proven Agent Profile Kit-owned output from 16 Projects.
```

ADR-0014 set the newcomer vocabulary at Workspace, Profile, Project, Host, and
"apkit owns what it generates", with a test asserting internal terms stay out of
default views. "Proven … -owned output" is the ownership-proof model surfacing
in the one command where a nervous user is reading hardest. Audited against the
rest of the default surface, `status --all` is clean — no "proven", "canonical",
"receipt", "reconcile", or "Installation". Teardown is the outlier.

**Proposed change.** `Removed apkit-generated files from 16 Projects.`

### Nits

- **N1.** Declining the changed-output confirmation prints its two-line receipt
  in red and exits `0`. Nothing went wrong; red says otherwise. The selected
  answer also renders as an empty string rather than `no`.
- **N2.** `apkit new --help` usage repeats the verb:
  `apkit new skill|context <name> | new profile <name> [...]`.
- **N3.** `apkit new --help` closes with `Next: Add the created artifact to a
  Profile with apkit guide, then run apkit validate`. `guide` adds nothing to
  anything.
- **N4.** `list hosts` prints six bare names. `init` and the `bind` picker both
  label Hosts `(installed)`; the command whose job is listing Hosts does not.
- **N5.** `list profiles` shows `Context Modules: 1 / Skills: 0` rather than the
  names, so it cannot answer "which Profile has my review skill in it".
- **N6.** `uninstall` leaves empty `.claude/rules/` and `.claude/skills/`
  directories behind.
- **N7.** The scaffolded `example.yaml` uses unquoted YAML scalars; files
  written by `apkit new` quote them. Two house styles in material the user is
  told to hand-edit.
- **N8.** `unbind` and scoped `status` identify a Project as `.`, which is not a
  name a reader can act on when it appears in a receipt.
- **N9.** The Workspace `README.md` is four lines and forwards to `guide --full`.
  Someone who just ran `apkit open` is standing in the directory with no map of
  what `context/`, `skills/`, and `profiles/` are for.
- **N10.** `HOME` is the only lever that isolates configuration. There is no
  `APKIT_HOME` or config-path override, which makes safe experimentation and
  sandboxed automation harder than it needs to be.

## 5. Requirements versus implementation

Attributing each cluster, after reading `CONTEXT.md`, ADR-0013/0014/0016/0017/
0020/0022/0026, `docs/USER-JOURNEY.md`, and specs #292, #372 and #373.

**Decided this way on purpose.** B1 (DEC-030/031, journey stage 12), B2
(US-029/030/031), the fleet default scope in S16 (DEC-001/US-009), and the
"All Projects are current" sentence in S8 (ADR-0026) all follow accepted
requirements. Three of the four are worth reopening; the fourth, fleet default
scope, is a good decision that its own README undermines.

**Implementation falls short of an accepted requirement.** S3 against US-015's
aligned row; S9 against US-025 and spec #373's own premise about `bind`; S4 and
S5 against ADR-0020's fact-once and verbose-evidence rules; S10 against US-022
and US-023; S17 against ADR-0014's vocabulary boundary.

**Nobody decided.** S1 (no membership-editing command), S2 (no generated-file
banner), S6 (two state vocabularies), S7 (two path renderings), S12's routing of
newcomers to `guide --full`, and S13's double `Next:` are gaps between accepted
decisions rather than departures from them. `docs/USER-JOURNEY.md` reports an
empty gap register with every registered gap shipped, which is accurate for what
was registered. These are the things nobody thought to register.

**One assumption worth challenging.** `docs/USER-JOURNEY.md` records that the
newcomer and daily-loop journeys were re-proved end to end at v0.173.0 and are
pinned by `test/release-candidate.test.ts`. Those tests do pass, and the surface
they pin is genuinely much better than what spec #373 described. But every
finding above was found on a build where those tests are green. Passing an
acceptance test proves the surface does what the story said; it does not prove
the story asked for the right thing, and it cannot see a gap between two stories
— which is where most of section 4 lives. The most valuable single change to the
qualification method would be to run the journeys on a *hostile* fixture: a
Project with hand-edited output, a mistyped name at every prompt, an 18-Project
fleet, and a non-interactive shell.

## 6. Overall assessment and recommended direction

`apkit` is a well-built CLI with an unusually disciplined presentation layer,
and it is one honest conversation away from being genuinely pleasant for a
beginner. The help template, the echoed non-interactive commands, the
`validate` diagnostic, the cancellation receipts, and `--stale` are all better
than the category norm. Colour is restrained and role-consistent, wrapping holds
at 60 columns, `NO_COLOR` works, and nothing is slow. The vocabulary discipline
of ADR-0014 is visible and mostly holding.

The gap is not polish. It is that the tool's own ownership model — apkit owns
what it generates, the Workspace is canonical, generated files are disposable —
is enforced inconsistently at exactly the moments it costs a user something.
`apply` guards hand-edited output on a terminal and discards it in a pipe.
`uninstall` discards it everywhere. The generated file itself never mentions the
model at all. A beginner learns this rule by losing something.

Three lines of work, in order.

**First, make ownership consistent and legible.** One rule for hand-edited
output across `apply` and `uninstall`, in every input mode, defaulting to
preserve (B1, B2). A banner in every generated file that names the canonical
source (S2). This is the difference between a tool that is safe and a tool that
*feels* safe, and the second one is what gets adopted.

**Second, close the authoring loop.** `apkit edit profile` is the missing verb
(S1). With it, the guides can lead with `apkit new` and `apkit edit` instead of
teaching YAML by hand (S12), `init` can stop being the only place the selection
picker exists, and the stated user goal — edit canonical material, push it
everywhere — becomes a two-command loop with no file-hunting in the middle.

**Third, make fleet views scale like fleet views.** One aligned row per Project
in `list` (S3), Project-first grouping and counts in the apply receipt (S4),
verbose-only exclusion bookkeeping in teardown (S5), one state vocabulary (S6),
and one path rendering (S7). Every one of these is already the right shape
somewhere in the codebase — `status --here --verbose` renders clean relative
paths, `--stale` answers the real daily question, ADR-0026's five causes are a
good closed set. The work is mostly making the good version the only version.

The error-message defects in S9 through S11 are small and independent, and they
are the cheapest confidence the product can buy.
