# Agent Profile Kit user journey

The living map of what a person does with the CLI and what each stage owes
them. See ADR-0013 for why this map exists here, ADR-0014 for the original
presentation decisions accepted against it, ADR-0020 for the quiet, task-first
default-view boundary, and ADR-0026 for the task-sufficient default lifecycle
view delivered by spec #373.

**Scope.** This document owns user-facing CLI surface behavior: the stages and
the outcome each stage owes. It does not own authoring formats
(`docs/guides/workspace.md`), system structure (`docs/ARCHITECTURE.md`),
vocabulary (`CONTEXT.md`), or settled decisions (`docs/adr/`).

**Maintenance — gap register.** Every registered gap has shipped. The closed
gap register was removed from this document; git history is its provenance.
Spec #373 recaptured this map against the delivered task-sufficient surface
(fleet-default lifecycle commands, cause-grouped default views, `--stale` and
`--blocked` narrowing, focused `--verbose` diagnostics, complete update
receipts, bare-invocation setup state, `apkit new`/`apkit open` authoring
commands, changed-output confirmation, and the first-run authoring handoff),
and ticket #461 re-proved the recaptured journey end to end: the integrated
daily-loop journey and the integrated newcomer journey below were executed
against the packed CLI at v0.173.0 and pinned by
`test/release-candidate.test.ts`. The register therefore records no open gaps;
new gaps graduate directly to tracker issues.

**Observation basis.** Every excerpt below was captured from a built CLI run
against sandbox `HOME`s, not derived from source. Coverage: the integrated
daily-loop journey (a seven-Project fleet carrying all five primary causes plus
one multi-cause Project and one Git-tracked Blocker, default-view grouping and
fact-once checks, `--stale`/`--blocked` narrowing with human/machine
agreement, narrowed and full non-interactive applies with complete receipts,
the executed tracked-output Blocker remedy, wholly settled status, and
whole-invocation cancellation through the delivered confirmation gate); and
the integrated newcomer journey (isolated machine, present and absent
controlled Hosts, only printed actions from bare invocation through example
update, real material authoring via the printed handoff commands, binding and
updating the real Profile, advisory absent-Host warnings, and the concrete
Host-loading verification guidance). The interactive changed-output
confirmation in stage 8 and the teardown receipts in stage 12 were captured
from separate interactive PTY sessions of the same packed build (the
confirmation's accept/decline behavior is pinned by the prompt-seam tests in
`test/apply-confirmation.test.ts` and `test/apply-command.test.ts`, and the
teardown non-prompting audit by `test/cli.test.ts`).

Earlier qualification evidence remains recorded for provenance. Fleet-scale
qualification (spec #193, ticket #205): the 12-Project workload — one shared
Profile across mixed Host sets, alternating Git and plain roots — is an
isolated, packed qualification fixture (`test/support/fleet-fixture.ts`)
proven end to end for a shared Skill update plus a Host addition. Comparable
packed-CLI timing measured v0.63.0 `validate` 0.107s, `status --json` 0.640s,
and `preview --json` 0.710s mean versus 0.064s, 0.101s, and 0.110s after the
quiet-output redesign. These are release evidence, not CI timing gates;
repeatable in-process samples remain available through
`installer/benchmark.ts`, while operation budgets are enforced structurally
(see ADR-0017).

Newcomer journey qualification (spec #292, ticket #307) established the
complete quiet, task-first newcomer flow through the packed CLI boundary
(`test/release-candidate.test.ts`); spec #373 ticket #461 recaptured that
coverage against the new surface with the two integrated journeys above rather
than duplicating it.

---

## The journey at a glance

| # | Stage | Command | Outcome the stage owes |
|---|-------|---------|------------------------|
| 1 | Discover | `apkit` (setup state), `--help`, `-h`, `help`, `help <command>`, `<command> -h`, `<command> --help`, `--version`, `-v`, `info [--json]`, `list`, `list projects [--json]`, `list profiles [--json]`, `list hosts [--json]`, `new skill <name>`, `new context <name>`, `new profile <name>`, `open` | Understand what is set up right now, the command surface, command-specific guidance, where the engine and application locations live, which Projects are configured, which Profiles are available from the selected Workspace, and which Hosts are supported; machine-facing commands stay out of this list entirely (DEC-020, DEC-021) |
| 2 | Initialize | `init [workspace]` | A valid Workspace and Local Configuration, the Workspace location in actionable home-relative form, the Hosts found on this machine, and a clear next move tailored to what is installed |
| 3 | Learn the format | `guide [profile\|context\|skill\|--full\|--agent]` | Enough to author a first Context Module, Skill, and Profile, with the Workspace location stated before any "create this file" instruction |
| 4 | Author | `new skill <name>`; `new context <name>`; `new profile <name> --context <id> --skill <id>`; `open`; edit Workspace files | Valid material created at its printed path without prompting, an explicit command to open the configured Workspace, and a Profile that selects real artifacts |
| 5 | Install | `install <profile> [project] --host <host> [--project <path>] [--auto-confirm] [--replace-changed] [--remove-changed] [--json]` | One Project installed with one Profile and its Hosts in a single action: the selection is recorded and the generated output installed and verified together, after an interactive confirmation; installing a different selection for the same Project replaces it in the same action |
| 6 | Verify | `validate` | Confidence that Workspace and configuration are well-formed, with invalid references explained down to the offending file and available names |
| 7 | Plan | `status [project \| --here \| --all] [--stale \| --blocked] [--verbose] [--json]` | The complete read-only update plan for the selected scope, grouped by primary cause, with settled work counted, Blockers as rows in the same frame, and exactly the selected Projects named |
| 8 | Update | `update [project \| --here \| --all] [--stale \| --blocked] [--replace-changed] [--verbose] [--json]` | Generated output for the selected Projects, a complete receipt of every committed operation, and on an interactive terminal a confirmation before any changed generated file is replaced |
| 9 | Use | *(launch Antigravity/Codex/Claude/Grok/OpenCode/Pi)* | Material loads through native Host discovery, and the Apply Receipt states one concrete Project-local action that checks whether the Host loaded the Profile |
| 10 | Re-sync | `status` → `update` (optionally narrowed) | Notice Workspace drift, resolve predictable blockers, and reconcile the intended Project scope with unchanged unselected Projects |
| 11 | Recover | `status`, `update`, `uninstall` | Get unstuck from drifted, missing, or blocked state through printed runnable remedies |
| 12 | Tear down | `uninstall`, `unbind` | Remove output and/or desired state without prompting, with the boundary made clear |
| 13 | Temporary Profile Installations | `machine install-temp <profile> <project> --host <host> [--json]`, `machine list temporary [--json]`, `machine remove-temp <temporary-installation-id> [--json]` | One Profile installed for one Host in one explicit Project for a receipt-owned lifetime, discoverable by identity, and removable idempotently; invoked through the machine-facing namespace (DEC-021) |

Stages 1–8 are the first-run path; an update that installed the scaffolded
example Profile hands off to stage 4's authoring commands so the first run ends
where the user was heading (DEC-024). Stages 10–12 are the returning-user
path. Stage 9 is the only stage the CLI never speaks to: the receipt states
how to check Host loading, it never claims Agent Profile Kit observed the
loading (OOS-009). Stage 13 is the receipt-owned temporary flow, usable
alongside either path. `new` never prompts; the teardown commands never
prompt (DEC-030, DEC-031).

`status` is the single authoritative read-only Project lifecycle plan. It
defaults to the complete fleet and uses the same selected scope and normalized
desired plan as `update` (DEC-001); `--stale` and `--blocked` select the same
Projects for reports and writes (DEC-006). It performs no Agent Host process
execution (ADR-0025): Host capability probing is advisory and happens during
`update` (and first-run `init` for machine-tailored guidance per DEC-022),
where a missing or outdated Host CLI produces one advisory inline warning per
Host per invocation — naming the Host and the strictest version it requires,
regardless of Project count or distinct requirement messages — and never
blocks planning, writing, or initialization or changes the exit code. The
former separate plan command, and the former `--blockers-only` view, were
removed before 1.0.

---

## Stage detail

<!-- recaptured-journey-excerpts:start -->
### 1. Discover

An uninitialized machine answers a bare invocation with setup state and the
one command that changes it:

```
$ apkit
Agent Profile Kit is not set up on this machine.
Next: Run apkit init to set it up.

Run apkit --help for the full command list.
```

A configured machine sees its fleet summarized by primary-cause counts plus
the settled count, followed by a short task-relevant command list:

```
$ apkit
- needs attention (1)
- not installed yet (1)
- settled (4)

Common next steps:
  apkit status
    Show the complete read-only update plan for the complete fleet, the
      containing Project, or one explicit Project
  apkit update
    Sync the complete fleet, the containing Project, or one explicit Project
  apkit install
    Install a Profile with Agent Hosts into a Project and remember the
      selection
  apkit guide
    Show a topic index, full Workspace guidance, or one focused authoring
      example

Run apkit --help for the full command list.
```

A wholly settled fleet renders as one count line (`3 Projects up to date.`).
`--help` keeps the full command list without flag inventories (US-034, DEC-020), and per-command help remains the authoritative flag
reference. Machine-facing commands (temporary installation and its inventory)
appear nowhere in the default list; they are documented in stage 13 and listed
by `apkit machine --help` (DEC-021). Interactive output selects the tty width
(falling back to `COLUMNS`) and clamps readable prose to 40–100 columns;
redirected output uses a deterministic 80-column measure. Color is used only
for color-capable interactive human output; `TERM=dumb`, an unset `TERM`, and
a non-empty `NO_COLOR` disable ANSI styling. `--version` and `-v` print the
engine version. Every command has focused `help <command>`, `<command> -h`,
and `<command> --help` aliases with identical purpose, syntax, worked
examples, write boundary, and next-action output. Unknown commands produce one
deterministic close-match suggestion when available, otherwise only point to
`apkit --help`. Root and per-command help derive from one `COMMANDS` table in
`cli/command-help.ts`.

`list` is the read-only inventory entrypoint: without a topic it names each
available inventory topic once with one human description. `list projects`
presents one aligned row per Project with its short identity, Profile, Hosts,
and configuration state, followed by a summary footer:

```
$ apkit list projects
Projects (2):

<project>  example  codex   configured
<project>  example  claude  configured

2 Projects configured.
Use apkit status to inspect Project lifecycle diagnostics.
```

`list profiles` reads Profile selections from the selected Workspace, and
`list hosts` leads with the canonical Hosts supported for configured Projects
without probing the machine:

```
$ apkit list hosts
Supported Hosts:
  antigravity
  claude
  codex
  grok
  opencode
  pi

Use <host> with apkit install to select it for a Project.
```

Temporary-install eligibility remains available in focused `machine
install-temp` help and Host inventory JSON. `machine list temporary` reads
active Temporary Profile Installations from Installation State, preserving
each durable identity alongside its Project, Profile, and Host so `machine
remove-temp` can target the correct receipt; it does not enter ordinary
Project lifecycle reconciliation. `info [--json]` reports the engine version
and the selected Workspace, Local Configuration, and Installation State
locations without reading bindings, artifacts, credentials, or Installation
State contents. It is distinct from `status`, which remains the ordinary
Project lifecycle diagnostic.

### 2. Initialize

```
$ apkit init
Initialized Agent Profile Kit Workspace and settings at
  ~/.agents/agent-profile-kit/workspace
A Profile is a named selection of Context and Skills to adapt for your
  projects.
Detected Agent Hosts: claude, codex, opencode
Next: from the project you want to try, run apkit install example --host claude
```

Scaffolds `workspace.yaml`, six artifact directories, an installable `example`
Profile and its Context Module, `README.md`, `AGENTS.md`, `.gitignore`, and a
`schema_version: 2` `config.yaml`. Re-running is safe, and does not restore a
removed example or overwrite any valid existing Workspace. The Workspace
location is stated in actionable home-relative form (US-036), the receipt
explains what a Profile is in one sentence at the moment one is first needed
(US-033), and detection is advisory: it names the supported Agent Hosts found
on the machine (US-037) and never blocks. When no supported Agent Host is
detected, the receipt says so plainly and does not suggest binding to an
absent Host (US-038, DEC-023); the suggested first `bind` names a Host the
machine actually has (US-039).

### 3. Learn the format

`guide` prints a concise authoring-first topic index with examples
(US-049, DEC-028):

```
$ apkit guide
# Agent Profile Kit guide

Choose a focused authoring topic, read the complete human guide, or open the
  agent workflow reference.

Topics:
  apkit guide profile
    Profile: A Profile selects reusable material for a kind of work through
      its context and skills lists.
  apkit guide context
    Context Module: A Context Module is an independently reusable unit of
      always-loaded guidance. Profiles select it by its frontmatter `id`.
  apkit guide skill
    Skill: A Skill is a reusable workflow package. Profiles select it by its
      frontmatter `name`, and its description tells an Agent Host when the
      workflow applies.

Complete references:
  apkit guide --full
    Complete human Workspace guide
  apkit guide --agent
    Agent workflow reference

Examples:
  apkit init
  apkit guide profile
  apkit install example --host codex
```

`guide --full` and `guide --agent` retain the complete human- and
agent-facing guides. `guide profile`, `guide context`, and `guide skill` each
return focused, terminal-width-aware guidance that states the configured
Workspace location before asking the user to create anything there
(US-048, DEC-028):

```
$ apkit guide profile
# Profile

A Profile selects reusable material for a kind of work through its context and
  skills lists.

Workspace: ~/.agents/agent-profile-kit/workspace

Create `profiles/example.yaml`:
…
```

Long interactive guidance is paged through the configured pager, while
redirected output preserves its content and never invokes a pager
(US-050, DEC-029).

### 4. Author

`apkit new` scaffolds one artifact of a named kind into the configured
Workspace and prints the actual full path of the created file, without
prompting or opening an editor (US-042–046, DEC-026):

```
$ apkit new skill deploy-helper
Created Skill deploy-helper at
  <workspace>/skills/deploy-helper/SKILL.md
Next: select the Skill from a Profile, then run apkit validate

$ apkit new context review-standards
Created Context Module review-standards at
  <workspace>/context/review-standards.md
Next: select the Context Module from a Profile, then run apkit validate

$ apkit new profile release --context review-standards --skill deploy-helper
Created Profile release at
  <workspace>/profiles/release.yaml
  Context: review-standards
  Skills: deploy-helper
Available Context Modules: example-context, review-standards
Available Skills: deploy-helper
Next: run apkit validate, then bind the Profile to a Project
```

Profile creation resolves every selected name through the Workspace boundary:
unknown selections are refused with the available names and a nearest-name
suggestion, and zero selections are refused with the same guidance. The
focused guide topics show that a Profile selects material through its context
and skills lists, that a Context Module's identity is frontmatter `id`, and
that a Skill's `name` is its Artifact ID without requiring the full guide.
`apkit open` opens the configured Workspace in the system file manager as an
explicit command (US-047, DEC-027); artifact creation never opens it as a
side effect.

### 5. Install

```
$ apkit install example <project> --host codex --auto-confirm
Installed example for <project>
  Profile: example
  Hosts: codex
Next: apkit status
```

```
$ apkit install ops <project> --host codex --host claude --auto-confirm
Replaced installation ops for <project>
  Profile: example → ops
  Hosts: codex → claude, codex
Next: apkit status
```

An interactive `install` shows the proposed scope and asks for confirmation
before any write; `--auto-confirm` answers that confirmation. Replacing or
deleting independently changed generated files additionally needs
`--replace-changed`/`--remove-changed`. On failure the previous selection is
restored where possible and the retry is printed.

Correct and well scoped; additional `--host` values are recorded the same way,
`unchanged` is distinguished from `Recorded`, the project defaults to the
working directory, and `--host` is explicit with no default. A conflicting
bind without `--replace` fails and names the flag; passing `--replace`
restates the existing binding's Profile and Host set in one command (shown
old → new above) while reconciling generated output through the ordinary
status → update path.

On an interactive terminal, `bind` asks only for the missing required Profile
and Host arguments (US-051, DEC-030, DEC-031): the Profile choice is preceded
by a one-sentence explanation of what a Profile is, the Host choices carry
advisory installed/absent detection evidence (US-053), a completed flow
records the binding and prints the equivalent fully specified command with the
Project path and every `--host` flag explicit (US-052, DEC-032), and
cancellation exits before any configuration change (DEC-033). A fully
specified bind never prompts.

### 6. Verify

```
$ apkit validate
Workspace and settings valid (2 Profiles, 6 configured Projects)
Profiles found: example, release
Hosts bound: claude, codex, grok
Next: apkit status
```

Successful validation derives its next action from the configured Project
count: zero points to `apkit install`, while one or more points to `apkit
status`. Validation remains read-only. Invalid Workspace references are
explained down to the offending file, the invalid value, and the available
names, with a nearest-name suggestion when one exists (US-025, US-026,
DEC-017):

```
$ apkit validate
apkit: Profile 'broken' in profiles/broken.yaml selects missing Context Module
  'team-rulez'.
Available Context Modules: example-context, review-standards.
Restore the Context Module, or remove or update Profile 'broken'.
Correct profiles/broken.yaml, then run apkit validate.
```

### 7. Plan

`status` defaults to the complete fleet and groups every actionable Project
under exactly one primary cause — needs attention, generated files changed,
generated files missing, not installed yet, or source changed — naming every
affected Project by short identity, while settled Projects are summarised as a
count (US-001–003, US-006, US-016, DEC-002, ADR-0026). A Project with several
causes at once appears once, under its highest-priority cause; verbose
diagnostics retain every underlying cause. Group counts plus the settled count
account for every Project exactly once (US-016):

```
$ apkit status
Cannot update
- needs attention (1):
  <project>
    Blocker: .agent-profile-kit/codex/context.md and 1 more files are tracked
      by Git, so Agent Profile Kit cannot write to them.
      Requirement: Agent Profile Kit must exclusively manage its generated
        files; Git-tracked paths cannot be replaced.
      Remedy: Choose one. To let Agent Profile Kit manage these files, run
        git --literal-pathspecs -C '<project>' rm -r --cached -- '.agent-profile-kit/codex/context.md' '.codex/hooks.json'
        — it stages their removal from the Git index while the files stay on
        disk; commit afterwards to keep the change — then run
        apkit update '<project>'.
        To keep Git ownership instead, run
        apkit unbind '<project>'.
      Affected paths (2):
        - .agent-profile-kit/codex/context.md
        - .codex/hooks.json
- generated files changed (2): <project>, <project>
- generated files missing (1): <project>
- not installed yet (1): <project>
- source changed (1): <project>
- settled (1)

Projects: 7 · Blockers: 1

Next:
- Resolve the reported blocker, then run apkit status again.
```

A Blocker never suppresses pending work for other Projects and never replaces
the fleet summary (US-005, DEC-005); Blocker rows render inside the same frame
with their runnable remedy (US-021, DEC-013). When nothing is blocked, the
pending view presents one compact decision:

```
$ apkit status
Ready to update
- not installed yet (2): <project>, <project>
Next: apkit update

Details: apkit status --verbose
```

Narrowing replaces verbosity as the route to a smaller question (US-011,
DEC-006): `--stale` selects existing installations needing updates or
restoration, excluding never-installed and Blocked Projects; `--blocked`
selects Projects with Project-scoped Blockers. The flags are mutually
exclusive, compose with fleet, `--here`, and explicit Project scope, and
select the same Projects for reports and update writes (shown in stage 10).
Each selected view states one primary next action naming the selected scope
(US-007), and every copyable command argument is executable as printed: the
Project identity renders home-relative or absolute — never the cwd-relative
alias, never middle-elided — as one shell-quoted POSIX token, so a path
containing spaces survives the shell that runs it and the printed action
never dead-ends.

```
$ apkit status --stale
Ready to update
- generated files missing (1): <project>
- source changed (1): <project>
Next: apkit update --stale

Details: apkit status --stale --verbose
```

`--verbose` is the focused diagnostic view (US-013): per-Project state,
per-output causes, Blocker evidence with scope and affected paths, Git
exclusion attention, and actionable Host Setup Steps — omitting the composed
Context bodies, unchanged output paths, and Capability Contract identifiers
that narrowing replaced. Machine JSON (`--json`, `schemaVersion: 15`) keeps
its meanings and exit codes unchanged and agrees with the human selection
(US-060, US-061, DEC-040).

Scope errors remain forks in the road rather than walls (US-024, DEC-016):

```
$ apkit status --here
apkit: directory '/private/tmp' is not configured as a Project
Run apkit install to configure this directory as a Project.
Run apkit list projects to list configured Projects.
Usage: apkit status [project | --here | --all] [--stale | --blocked] [--verbose] [--json]
```

An uninitialized machine is told plainly and given the initialization command;
configuration paths do not lead the explanation (US-023, DEC-015):

```
$ apkit status
apkit: Agent Profile Kit is not set up on this machine
Run apkit init to set it up.
```

Interactive previews that outlast a short anti-flicker threshold show delayed
operation-level progress on the terminal line; the line is cleared before the
report, and redirected output and JSON never carry progress bytes.

### 8. Update

`update` shares `status`'s selection: the complete fleet by default, `--here`
for the bound Project containing the current working directory, one explicit
existing absolute or home-relative bound Project root, or `--stale`/`--blocked`
for the narrowed selection. Scoped update does not plan, probe, inspect,
report, or write unrelated Projects; it rewrites the owned section of a shared
Git exclusion target from the receipts that will exist after the operation,
preserving unrelated bytes (best-effort bookkeeping, ADR-0025). `update` on
fleet scope stops every write for a global Blocker, but leaves Project-scoped
blocked Projects untouched while committing and freshly verifying healthy
Projects sequentially. A partial blocker result exits `2`; a tool or
verification failure exits `1` and identifies committed, failed, and
still-pending Project work.

`apkit update` refreshes the installed Context and Skills in your Projects from
the Workspace; it does not upgrade the `apkit` executable itself.

The Apply Receipt is the authoritative record of what update actually did,
distinct from the resulting-state report (US-027, DEC-018): it names every
committed file operation with its Project attribution, including replacement
of a changed generated file, in every invocation mode (US-028):

```
$ apkit update
Update complete

Updated:
  + 3 generated file additions in 2 projects
  + .agent-profile-kit/codex/context.md (<project>)
  + .claude/rules/agent-profile-kit.md (<project>)
  + .codex/hooks.json (<project>)

First use:
- Review and approve the generated SessionStart hook when Codex asks so the
  Profile can load.
- Trust the bound project in Codex so the Profile can load.

Profile example will load the next time you launch a configured Host from a
  bound Project root.
To check that claude and codex loaded Profile example, start a new session of
  each configured Host in each updated Project and ask each Host what Profile
  material it loaded; the installed material should appear in the answers.
```

The first-run example update closes with a concrete handoff to authoring real
material (US-040, DEC-024); routine applies do not repeat it:

```
Now author your own:
  apkit new skill <skill>
  apkit new context <context>
  apkit new profile <profile> --context <context> --skill <skill>
```

A non-interactive update with the explicit answering flag replaces a
hand-edited generated file and prompts nothing (US-007, DEC-005, TEST-004):

```
$ apkit update <project> --replace-changed
Update complete

Updated:
  ~ 1 generated file update in 1 project
  ~ .agent-profile-kit/codex/context.md (<project>)
…
```

Without the applicable flag, a non-interactive update refuses before any
selected lifecycle write and prints the runnable remedy (US-007, DEC-005):

```
$ apkit update <project>
apkit: update needs explicit changed-file consent before any write
  ~ .agent-profile-kit/codex/context.md (<project>)
No Project or setting was changed.
To proceed without asking, run
  apkit update <project> --replace-changed
```

On an interactive terminal, update asks before replacing or deleting changed
generated files, even when all scope arguments are supplied (US-006, US-007,
DEC-005, DEC-019). The review names the affected files with Project
attribution and the planned operation before any invocation write, and the
default answer is no; declining, the default, or cancellation aborts the
entire invocation without writes — rendered in neutral styling with the
answer named — including writes for other selected Projects. The review
offers an optional current-on-disk versus planned diff: viewing or leaving it
grants no consent and returns to the same scope (US-020). The explicit
answering flags `--replace-changed` (replacement) and `--remove-changed`
(deletion) each permit only their own operation without prompting and never
bypass an ownership or path-safety Blocker; `--auto-confirm` answers neither:

```
$ apkit update <project>
Changed generated files:
  ~ .agent-profile-kit/codex/context.md (<project>)
Replacing overwrites these files with current Workspace content.
Type d to view the current on-disk versus planned diff before deciding (d again for more pages).
? Replace or delete these generated files as listed? (y/N)
apkit: update was cancelled before any write
No Project or setting was changed; your edits to the named generated files are
  preserved.
To replace changed generated files without asking, run
  apkit update <project> --replace-changed
```

Verbose update retains the full per-Project inventory, and machine JSON keeps
its keys and meanings (US-060). The receipt is grouped and
preview-consistent: `Updated:` lists the same operation groups with the same
symbols and counts as the preceding preview, and is followed by
change-relevant first-use guidance and the invocation-wide next-launch
readiness (once per update invocation, never split by Host or Project set).

### 9. Use

A successful update states one concrete Project-local action that checks
whether the Agent Host loaded the Profile (US-041, DEC-025): start a new
session of the configured Host in the updated Project and ask it what Profile
material it loaded — the installed material should appear in the answer.
Agent Profile Kit never claims it observed that loading (OOS-009). Beyond
that check, setup guidance is reported conditionally by Host *and* by what
was installed:

| Host | Requirement after `update` |
|------|---------------------------|
| Claude Code | None. Rule + Skills load on next launch; no Git dependency. |
| Codex | Codex CLI 0.145.0+ for complete Context delivery, plus project trust **and** native review/trust of the generated `SessionStart` hook — only when Context is installed. Non-Git projects must be launched from the exact bound root. |
| Grok | None, except when co-bound with Claude and rules compatibility is on: Grok reads Claude's rule file and **no `.grok/rules/` is created**. |
| OpenCode | OpenCode CLI 1.18.23+. Profile Context loads via `.opencode/opencode.jsonc` referencing `.agent-profile-kit/opencode/context.md`, and Skills load from `.agents/skills/`. Restart running OpenCode sessions to load updated configuration. |
| Pi | Native project trust; `--skill` / `--no-skills` runtime overrides fall outside the guarantee. |
| Antigravity | `agy` 1.1.13+ and native project trust. Profile Context loads from deterministic always-on `.agents/rules/` files and Skills from the qualified shared `.agents/skills/` packages. |

**Codex Context floor (0.145.0+).** Context-bearing Codex plans probe
`codex --version` during `update`; a missing, unreadable, or older CLI produces
one advisory warning for that requirement per invocation, naming Codex and the
required floor, and the material is written regardless (ADR-0025).
Skills-only Codex plans do not probe. `status`, `validate`, and `uninstall`
do not probe, so a post-update Codex downgrade is not reported there — Context
stops loading until a supported CLI is restored, and the next `update` warns
again.

### 10. Re-sync after a Workspace edit

`status` and `update` share one Project selection (US-009, DEC-001): the
complete fleet by default, `--here` for the containing Project, one explicit
absolute or home-relative bound root, `--stale`/`--blocked` for the narrowed
selections, or `--all` for explicit fleet scope. Ambiguous, unbound, missing,
relative, wildcard, and non-directory targets fail with command guidance
before Project inspection. The tool's best-working loop: `stale source` is
detected accurately, the cause group names the Project, and the next action is
correct. A fully-current single Project states that fact once
(`All Projects are current (1 Project)`); a fully-current fleet uses the same
shape (`All Projects are current (7 Projects)`). Neither emits a Host setup
reminder, Project list, or next action (US-004). Verbose status and JSON
retain the underlying causes; every fact is stated once per view (US-008,
DEC-007). Interactive status inspections that outlast a short anti-flicker
threshold show delayed operation-level progress on the terminal line; the line
is cleared before the report, and redirected output and JSON never carry
progress bytes.

### 11. Recover

**Missing output** — a deleted generated file — is ordinary pending work:
`status` names the missing paths under `generated files missing` and `update`
restores them.

**Drifted output** — a generated file whose bytes, modes, or members differ
from the recorded installation — is ordinary pending work: `status` groups it
under `generated files changed` and `update` replaces the whole recorded root
from current Workspace source, naming the replacement in the receipt and
discarding unknown members such as host scratch directories. Removal paths
(`uninstall`, stale removal, `machine remove-temp`) may remove drifted proven
roots without a manual pre-clean. Identity or path-safety failures — changed
extant roots with no continuity anchor, a symlinked root, an unsafe parent —
remain Blockers, and their evidence states only what was proven, never
asserting a user edit without provenance.

**Host CLI missing or outdated** no longer blocks anything (ADR-0025):
during `update`, a missing or outdated Host CLI produces one advisory warning
per Host per invocation, rendered inline with the outcome — no warnings
heading, no empty warning section — and never changes the exit code
(US-017–019, DEC-010, DEC-011):

```
$ apkit update <project>
Update complete
- Grok inspect --json output is not valid JSON; upgrade Grok Build or fix the
  CLI before checking status or updating the Profile (1 Project)

Updated:
  + 1 generated file addition in <project>
  …
```

The historical excerpt below showed these conditions as Blockers with
problem/requirement/remedy prose; that gating and the Installer-authored prose
no longer exist — presentation owns every Blocker and warning sentence, keyed
by the typed kind:

```
Blocker: Claude Code CLI was not found on PATH; install Claude Code and ensure
`claude --version` works before previewing or updating the Profile
```

**Blockers render as rows with runnable remedies** (US-020–021, DEC-013).
Every Blocker kind offers a command the user can run, derived from its
evidence; the tracked-output remedy stages the removal from the Git index
while the files stay on disk:

```
Blocker: .agent-profile-kit/codex/context.md and 1 more files are tracked
  by Git, so Agent Profile Kit cannot write to them.
  Requirement: Agent Profile Kit must exclusively manage its generated
    files; Git-tracked paths cannot be replaced.
  Remedy: Choose one. To let Agent Profile Kit manage these files, run
    git --literal-pathspecs -C '<project>' rm -r --cached -- '.agent-profile-kit/codex/context.md' '.codex/hooks.json'
    — it stages their removal from the Git index while the files stay on
    disk; commit afterwards to keep the change — then run
    apkit update '<project>'.
    To keep Git ownership instead, run
    apkit unbind '<project>'.
```

The evidence-derived recovery command is carried inline in every view —
concise, verbose, and the machine JSON remedy — so no view redirects to
another view to see the exact command. When a remedy cannot name a runnable
command, recovery states the manual action plainly rather than prose about
hidden state. Errors follow one shape across every command: what happened,
why, then one or more commands to run (US-022, DEC-014).

During a narrowed or fleet update, Project-scoped blocked Projects remain
untouched while healthy Projects commit sequentially and freshly verify; a
partial blocker result exits `2` and retains the committed `Updated:` receipt
before remaining blockers, so writes are never hidden.

### 12. Tear down

`uninstall` removes proven output and preserves bindings; `unbind` removes the
binding and retires the installation receipt ("Generated files remain until
update"). Neither command prompts — on any input stream, including an
interactive terminal (US-055 teardown clause, DEC-030, DEC-031) — and
re-binding and re-updating recovers both:

```
$ apkit unbind <project>
Removed configured Project for <project>
  Profile: release
  Hosts: claude
Generated files remain until update
Next: apkit status --all

$ apkit uninstall
Removed proven Agent Profile Kit-owned output from 4 Projects.

Project: <project>
  Removed generated paths:
  - .agent-profile-kit/codex/context.md
  - .codex/hooks.json
  Cleaned Git exclusions:
  - /.agent-profile-kit/codex/context.md (<project>/.git/info/exclude)
  - /.codex/hooks.json (<project>/.git/info/exclude)
…
Configured Projects preserved.
Next: Run
  apkit unbind
  for configured Projects you no longer want, or
  apkit update
  to reinstall.
```

An output whose ownership cannot be proven is kept and reported, not deleted
silently:

```
Kept 1 Project whose owned output could not be fully removed:

Project: <project>
  - recorded output .claude/rules/agent-profile-kit.md does not match the
    recorded installation and no other recorded root proves ownership
    continuity; restore the recorded output or remove the generated files, then
    retry
```

The follow-on `status` names the resulting state once in its cause group —
the former duplicated `State:` plus attention-line pairing is gone
(US-008, DEC-007).

### 13. Temporary Profile Installations

A side journey for automation or one-off inspection, owned by a temporary
installation receipt rather than a Project Binding (ADR-0015):

```
$ apkit machine install-temp example <project> --host codex
Installed temporary Profile
  Profile: example
  Host: codex
  Project: <project>
  Temporary installation: <temporary-installation-id>
Codex setup:
- Review and approve the generated SessionStart hook when Codex asks.
  Consequence: Declining the hook prevents Profile Context from loading.
- Trust the bound project in Codex.
  Consequence: Profile Context does not load until the project is trusted.
- Launch Codex from the exact bound project root: <project>
  Consequence: Launching from a descendant prevents Profile Context from
    loading.
Next: apkit machine remove-temp <temporary-installation-id>

$ apkit machine list temporary
Temporary Profiles (1):

Temporary installation: <temporary-installation-id>
  Project: <project>
  Profile: example
  Host: codex

$ apkit machine remove-temp <temporary-installation-id>
Removed temporary Profile
  Temporary installation: <temporary-installation-id>
  Project: <project>
```

The temporary identity survives on the receipt and in `machine list
temporary`, so `machine remove-temp` stays discoverable without touching
ordinary Project lifecycle state or Local Configuration. Width, styling, and
wrapping behave exactly like the ordinary lifecycle surfaces through the
shared presentation boundary (ADR-0016).
<!-- recaptured-journey-excerpts:end -->

---

## Accepted presentation principles

Accepted in ADR-0014 and refined by ADR-0020 and ADR-0026. Individual fixes
are argued from these rather than from scratch.

1. **One fact, one rendering per screen**, and one command run produces one
   report.
2. **Every refusal names its remedy.** A blocker the user cannot act on is an
   incomplete blocker.
3. **When blocked, the blocker is the report.** Hypothetical plan detail is
   demoted or suppressed.
4. **Never warn about a state the user just requested.**
5. **A next step must change something**, and must not stall work that is
   ready.
6. **Distinct concepts get distinct words.** Presentation must not overload one
   term for two of them.
7. **Summarize routine impact; disclose actionable identity.** Exact generated
   paths and Git bookkeeping are verbose by default, while blockers, warnings,
   drift, ownership attention, and repair or failure retain the identity needed
   to act.
8. **Show identity at the shortest unambiguous length**, including the Hosts
   the user chose.
9. **Teach once, at the point of need** — not on every run, and carry the
   journey into the Host without presenting unobserved Host state as unfinished
   setup.
10. **Exit codes agree across commands** for the same state.
11. **Prompts are predictable and teach by use.** Exactly bind, init, and the
    update confirmation interact; every completed prompt flow prints the
    equivalent fully specified command, and everything else — including
    teardown — never prompts (DEC-030–032).