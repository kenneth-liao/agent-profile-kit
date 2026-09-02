# Agent Profile Kit user journey

The living map of what a person does with the CLI, what each stage owes them,
and where the current surface falls short. See ADR-0013 for why this map exists
here, ADR-0014 for the original presentation decisions accepted against it,
and ADR-0020 for the current quiet, task-first default-view boundary.

**Scope.** This document owns user-facing CLI surface behavior: stages, the
outcome each stage owes, and the gap register. It does not own authoring formats
(`docs/guides/workspace.md`), system structure (`docs/ARCHITECTURE.md`),
vocabulary (`CONTEXT.md`), or settled decisions (`docs/adr/`).

**Maintenance.** Stages reference gap IDs; the register below is the single home
for each gap's description and severity. A gap graduates by becoming a tracker
issue that cites its ID, and is struck when that issue closes. Output excerpts
elide project paths as `<project>` so they do not drift.

**Observation basis.** Every excerpt below was captured from a built CLI run
against sandbox `HOME`s, not derived from source. Coverage: cold start; authoring;
bind; validate; preview; apply; stale source; hand-edited drift; deleted output;
uninstall; unbind; missing and outdated Host CLIs; and a three-project,
four-Host installation (Claude, Codex, Grok, Pi) including a Skills-only Profile,
a non-Git project, and a disabled-model-invocation Skill. First-run excerpts in stages 1, 2, and 5–8, plus the temporary install and
remove receipts in stage 13, were recaptured from the packed newcomer journey
([#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307)).
Older recovery and teardown excerpts remain historical and preserve the
executable spelling that produced them. The presentation-gap evidence pass behind spec #154 measured root
help at 129 columns, focused help at 167, focused guides at 154, and blocked
lifecycle output at 201; a real 12-Project `status` took about 4.9 seconds,
`preview` about 9.2 seconds, and a blocked run carried 42 blockers (41 per-path
instances of one tracked-output class). Those observations are the basis for
[UJ-24](#uj-24) through [UJ-30](#uj-30).

Fleet-scale qualification (spec #193, ticket #205): the same 12-Project
workload — one shared Profile across mixed Host sets, alternating Git and plain
roots — is now an isolated, packed qualification fixture (`test/support/
fleet-fixture.ts`) proven end to end for a shared Skill update plus a Host
addition. The compact lifecycle groups observable additions, updates, repairs,
and removals with generated-file and affected-Project counts, without inferring
Workspace Artifact or Project Binding causality. Member-level attention stays
visible as Project exceptions, and one collapsed next action closes the run. Comparable packed-CLI qualification used the same
isolated 12-Project HOME, Workspace, Local Configuration, Project roots,
controlled Host executables, and v0.63.0 Apply Receipt for both versions after
one shared Skill update and one Pi Host addition. After one unmeasured warm-up per command, five runs on the same
machine measured: v0.63.0 `validate` 0.107s, `status --json` 0.640s, and
`preview --json` 0.710s mean; v0.79.0 measured 0.064s, 0.101s, and 0.110s
respectively. Min/max ranges were 0.105–0.109s, 0.629–0.644s, and
0.693–0.737s before versus 0.062–0.067s, 0.100–0.104s, and 0.107–0.113s
after. These are release evidence, not CI timing gates; repeatable in-process
samples remain available through `installer/benchmark.ts`, while operation
budgets are enforced structurally (see ADR-0017).

Newcomer journey qualification (spec #292, ticket #307): the complete quiet,
task-first newcomer flow — bare help → init → validate → bind → ready status →
changed apply → current status, followed by temporary install → exact printed
remove command → removal — is qualified end-to-end through the packed CLI
boundary (`test/release-candidate.test.ts`) against isolated settings, Workspace,
Git and non-Git Projects, controlled Host executables, and ownership receipts.
The first-run excerpts below were captured from that packed run.

---

## The journey at a glance

| # | Stage | Command | Outcome the stage owes |
|---|-------|---------|------------------------|
| 1 | Discover | `apkit`, `--help`, `-h`, `help`, `help <command>`, `<command> -h`, `<command> --help`, `--version`, `info [--json]`, `list`, `list projects [--json]`, `list profiles [--json]`, `list hosts [--json]` | Understand the command surface, command-specific guidance, where the engine and application locations live, which Projects are configured, which Profiles are available from the selected Workspace, and which Hosts are supported; machine-facing commands stay out of this list entirely (DEC-019) |
| 2 | Initialize | `init [workspace]` | A valid Workspace and Local Configuration, and a clear next move |
| 3 | Learn the format | `guide [profile\|context\|skill\|--full\|--agent]` | Enough to author a first Context Module, Skill, and Profile |
| 4 | Author | *(no CLI; edit Workspace files)* | A Profile that selects real artifacts |
| 5 | Bind | `bind <profile> [project] --host <host> [--replace]` | One project associated with one Profile and its Hosts, or an existing binding restated with `--replace` |
| 6 | Verify | `validate` | Confidence that Workspace and configuration are well-formed |
| 7 | Plan | `status [project \| --all] [--verbose] [--blockers-only] [--json]` | See current state, pending work, predictable blockers, warnings, Host guidance, and exactly what `apply` would attempt without writing; `--blockers-only` shows a focused Blocker-only view (combines with `--verbose`, not `--json`) |
| 8 | Apply | `apply [project \| --all] [--verbose] [--blockers-only] [--json]` | Generated output for the current Project, one explicit Project, or the explicitly selected fleet, and proof of what changed; `--blockers-only` shows a focused Blocker-only view that always keeps the Applied receipt and failed or pending Projects visible, and with no Blockers the ordinary receipt view renders unchanged |
| 9 | Use | *(launch Antigravity/Codex/Claude/Grok/Pi)* | Material loads through native Host discovery |
| 10 | Re-sync | `status [project \| --all] [--blockers-only] [--json]` → `apply [project \| --all]` | Notice Workspace drift, resolve predictable blockers, and reconcile the intended Project scope |
| 11 | Recover | `status`, `apply`, `uninstall` | Get unstuck from drifted, missing, or malformed state |
| 12 | Tear down | `uninstall`, `unbind` | Remove output and/or desired state, with the boundary made clear |
| 13 | Temporary Profile Installations | `machine install-temp <profile> <project> --host <host> [--json]`, `machine list temporary [--json]`, `machine remove-temp <temporary-installation-id> [--json]` | One Profile installed for one Host in one explicit Project for a receipt-owned lifetime, discoverable by identity, and removable idempotently; invoked through the machine-facing namespace (DEC-019) |

Stages 1–8 are the first-run path. Stages 10–12 are the returning-user path.
Stage 4 is the only stage with no CLI surface at all, and stage 9 the only one
the CLI never speaks to. Stage 13 is the receipt-owned temporary flow, usable
alongside either path.

`status` is the single authoritative read-only Project lifecycle plan. It uses
the same selected scope and normalized desired plan as `apply` and performs no
Agent Host process execution (ADR-0025): Host capability probing happens only
during `apply`, where a capability failure produces one advisory warning per
identical failure per invocation and never blocks planning or writing. The
former separate plan command was removed before 1.0.

---

## Stage detail

<!-- historical-command-excerpts:start -->
### 1. Discover

A bare invocation, `--help`, `-h`, and `help` print root help: description, a
four-step first run, common commands, then secondary inventory, teardown,
machine-detail, and temporary-installation commands under `More commands`:

```
$ apkit --help
Agent Profile Kit composes reusable agent material into host-native projects.

Usage: apkit <command> [arguments]

First run:
  apkit init
  apkit bind <profile> --host <host>
  apkit status
  apkit apply

  Choose a Profile with apkit guide profile; see apkit bind --help for supported
  Host values.

Common commands:
  init [workspace]
    Initialize or adopt the canonical Workspace and settings
…
More commands:
  Inventory:
  list [projects|profiles|hosts [--json]]
    List read-only inventory for Projects, Profiles, or Hosts
…
```

Each catalog command retains its syntax and wrapped description. The first run points
to `guide profile` for a valid Profile example and `bind --help` for supported
Host values. Machine-facing commands (temporary installation and its inventory)
appear nowhere in this default list; they are documented in stage 13 and
listed by `apkit machine --help` (DEC-019). Interactive output selects the tty width (falling back to `COLUMNS`)
and clamps readable prose to 40–100 columns; redirected output uses a
deterministic 80-column measure. Color is used only for color-capable
interactive human output; `TERM=dumb`, an unset `TERM`, and a non-empty
`NO_COLOR` disable ANSI styling. The compact ASCII identity appears only in
interactive bare/root help, while the agent guide, redirected output, and all
JSON remain plain. `--version` prints the engine version. Every command has focused
`help <command>`, `<command> -h`, and `<command> --help`
aliases with identical purpose, syntax, worked examples, write boundary, and
next-action output; binding and temporary-installation help name Hosts from
their canonical capability sets. Unknown commands produce one deterministic
close-match suggestion when available, otherwise only point to `apkit --help`.
Root and per-command help derive from one `COMMANDS` table in
`cli/command-help.ts`, while worked commands derive from the reusable example
set in `cli/examples.ts`.

`list` is the read-only inventory entrypoint: without a topic it names each
available inventory topic once with one human description, while focused `list`
help retains JSON syntax and examples. `list projects` reads Project Bindings from
normalized Local Configuration, `list profiles` reads Profile selections from
the selected Workspace, and `list hosts` leads with the canonical Hosts supported
for configured Projects without probing the machine. Temporary-install eligibility
remains available in focused `machine install-temp` help and Host inventory JSON.
`machine list temporary` reads active Temporary Profile Installations from Installation
State, preserving each durable identity alongside its Project, Profile, and Host
so `machine remove-temp` can target the correct receipt; it does not enter ordinary
Project lifecycle reconciliation. Focused human inventory uses instructional
`Use …` guidance instead of presenting an optional or redundant command as
`Next:`; Host inventory explains that `apkit bind` selects a listed Host for a
configured Project. `info [--json]` reports the engine version and
the selected Workspace, Local Configuration, and Installation State locations
without reading bindings, artifacts, credentials, or Installation State
contents. It is distinct from `status`, which remains the ordinary Project
lifecycle diagnostic.

Gaps: ~~[UJ-16](#uj-16)~~ (shipped in [#115](https://github.com/kenneth-liao/agent-profile-kit/issues/115)).

### 2. Initialize

```
$ apkit init
Initialized Agent Profile Kit Workspace and settings at
<workspace>
Next: from the project you want to try, run apkit bind example --host codex
```

Scaffolds `workspace.yaml`, six artifact directories, a bindable `example`
Profile and its Context Module, `README.md`, `AGENTS.md`, `.gitignore`, and a
`schema_version: 2` `config.yaml`. Re-running is safe, and does not restore a
removed example or overwrite any valid existing Workspace.

Gaps: ~~[UJ-01](#uj-01)~~ (shipped in [#121](https://github.com/kenneth-liao/agent-profile-kit/issues/121)), ~~[UJ-10](#uj-10)~~ (shipped in
[#119](https://github.com/kenneth-liao/agent-profile-kit/issues/119)).

### 3. Learn the format

`guide` prints a concise topic index with examples. `guide --full` and
`guide --agent` retain the complete human- and agent-facing guides.
`guide profile`, `guide context`, and `guide skill` each return focused,
terminal-width-aware guidance with a complete copyable example; fenced examples
and copyable values remain intact.

Gaps: ~~[UJ-01](#uj-01)~~ (shipped in [#121](https://github.com/kenneth-liao/agent-profile-kit/issues/121)).

### 4. Author

No CLI surface. The user must produce structured content from memory:

```
context/standards.md        id in frontmatter
skills/<name>/SKILL.md      name (= Artifact ID) + description in frontmatter
profiles/<id>.yaml          id, context[], skills[], and three mandatorily empty arrays
```

The focused guide topics show that a Profile needs all five arrays with three
empty, that a Context Module's identity is frontmatter `id`, and that a Skill's
`name` is its Artifact ID without requiring the full guide.

### 5. Bind

```
$ apkit bind example <project> --host codex
Recorded configured Project for <project>
  Profile: example
  Hosts: codex
Next: apkit status
```

```
$ apkit bind ops <project> --host codex --host opencode --replace
Replaced configured Project for <project>
  Profile: coding → ops
  Hosts: codex → codex, opencode
Next: apkit status
```

Correct and well scoped; additional `--host` values are recorded the same way,
`unchanged` is distinguished from `Recorded`, the project defaults to the
working directory, and `--host` is explicit with no default. Lifecycle project blocks now echo the selected Hosts, so that identity
remains visible after `bind`. A conflicting bind without `--replace` fails and
names the flag; passing `--replace` restates the existing binding's Profile and
Host set in one command (shown old → new above) while reconciling generated
output through the ordinary status → apply path.

Gaps: ~~[UJ-07](#uj-07)~~ (shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) and [#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)), ~~[UJ-16](#uj-16)~~,
~~[UJ-20](#uj-20)~~ (shipped in [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116)).

### 6. Verify

```
$ apkit validate
Workspace and settings valid (1 Profile, 0 configured Projects)
Profiles found: example
Hosts bound: none
Next: apkit bind <profile> --host <host>
```

Successful validation derives its next action from the configured Project count:
zero points to `apkit bind`, while one or more points to `apkit status`. Warnings
remain visible without changing that branch, and validation remains read-only.

Gaps: ~~[UJ-17](#uj-17)~~ (shipped in
[#119](https://github.com/kenneth-liao/agent-profile-kit/issues/119)).

### 7. Plan

Unblocked pending `status` now presents one compact decision at both single-
Project and fleet scope. When every non-zero file operation affects the same
Project scope, one outcome line carries all counts. Differing scopes use one
compact line per operation without an aggregate that repeats those totals.
Routine generated paths and successful Git exclusion bookkeeping move behind
`--verbose`; drift, ownership, destructive-removal, warning, Blocker, and Git
attention keep the identity needed to act. The selected invocation determines
one apply command and, when detail is suppressed, one matching verbose route:

```
$ apkit status <project>
Updates ready for 1 project (3 file additions).
Next: apkit apply <project>

Details: apkit status <project> --verbose
```

The same compact decision scales to a fleet:

```
Updates ready for 14 projects (96 file updates).
Next: apkit apply --all

Details: apkit status --all --verbose
```

Verbose retains the full per-Project, per-path, Git, and Host Setup Step
evidence, and versioned JSON remains unchanged. Concise pending `status` does
not pre-announce post-apply setup.

Interactive previews that outlast a short anti-flicker threshold show delayed
operation-level progress on the terminal line; the line is cleared before the
report, and redirected output and JSON never carry progress bytes.

Gaps: ~~[UJ-32](#uj-32)~~ (shipped across
[#301](https://github.com/kenneth-liao/agent-profile-kit/issues/301),
[#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303),
[#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304), and
[#305](https://github.com/kenneth-liao/agent-profile-kit/issues/305));
~~[UJ-33](#uj-33)~~ (shipped across
[#302](https://github.com/kenneth-liao/agent-profile-kit/issues/302) and
[#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304)); ~~[UJ-07](#uj-07)~~ (shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) and [#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)), ~~[UJ-11](#uj-11)~~ (shipped in
[#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120)),
~~[UJ-12](#uj-12)~~ (shipped in
[#123](https://github.com/kenneth-liao/agent-profile-kit/issues/123)),
~~[UJ-15](#uj-15)~~ (shipped in
[#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122)),
~~[UJ-18](#uj-18)~~ (shipped in
[#123](https://github.com/kenneth-liao/agent-profile-kit/issues/123)),
~~[UJ-20](#uj-20)~~, ~~[UJ-22](#uj-22)~~ (shipped in
[#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120)).

### 8. Apply

`apply` defaults to the bound Project containing the current working directory,
accepts one explicit existing absolute or home-relative bound Project root, and
requires `--all` for the complete fleet. Scoped apply does not plan, probe,
inspect, report, or write unrelated Projects; it rewrites the owned section of a
shared Git exclusion target from the receipts that will exist after the
operation, preserving unrelated bytes (best-effort bookkeeping, ADR-0025).
`apply --all` stops every write for a global
Blocker, but leaves Project-scoped blocked Projects untouched while committing
and freshly verifying healthy Projects sequentially. A partial blocker result
exits `2`; a tool or verification failure exits `1` and identifies committed,
failed, and still-pending Project work.

After an edit or when `status` reports changes, the user runs:

```
$ apkit apply
```

`apply` performs atomic reconciliation across all selected Projects: it writes
Host configuration files, rewrites the Agent Profile Kit-owned Git exclusion
section as a cache, and prints the summary:

```
$ apkit apply <project>
Apply complete

Applied:
  + 3 generated file additions in 1 project

First use:
- Review and approve the generated SessionStart hook when Codex asks so the
  Profile can load.
- Trust the bound project in Codex so the Profile can load.

Profile example will load the next time you launch a configured Host from a
  bound Project root.
```

A multi-Project apply shows:

```
Apply complete

Applied:
  + 19 generated file additions across 3 projects

First use:
- Review and approve the generated SessionStart hook when Codex asks so the Profile can load.
- Trust the bound project in Codex so the Profile can load.

Profile coding will load the next time you launch a configured Host from a bound Project root.
```

Verbose apply retains the full per-Project inventory:

```
Apply complete

Applied:
Projects:
<api>: addition
<scratch>: addition
<web>: addition
Outputs:
<api>/.codex/hooks.json: addition
<api>/.claude/rules/agent-profile-kit.md: addition
<scratch>/.claude/rules/agent-profile-kit.md: addition
<web>/.claude/rules/agent-profile-kit.md: addition

Host Setup:
Host setup:
- Review and approve the generated SessionStart hook when Codex asks. (<api>)
  Consequence: Declining the hook prevents Profile Context from loading.
Standing Host setup:
- Trust the bound project in Codex. (<api>)
  Consequence: Profile Context does not load until the project is trusted.

Profile coding will load the next time you launch a configured Host from a bound Project root.
```

Separating verified resulting state from the Apply Receipt is architecturally
correct (`CONTEXT.md`, *Apply Receipt*), and the receipt is now grouped and
preview-consistent: `Applied:` lists the same operation groups with the same
symbols and counts as the preceding preview, never reprints verified-current
Project blocks, and is followed by change-relevant first-use guidance and invocation-wide
next-launch readiness (once per apply invocation, never split by Host or Project set). Conditional Host
guidance carries this journey into Codex, Claude Code, Grok, Pi, and Antigravity.

Gaps: ~~[UJ-32](#uj-32)~~ (status and receipt impact shipped in
[#301](https://github.com/kenneth-liao/agent-profile-kit/issues/301) and
[#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303); first-use apply
note shipped in [#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304);
invocation-wide readiness shipped in
[#305](https://github.com/kenneth-liao/agent-profile-kit/issues/305));
~~[UJ-33](#uj-33)~~ (shipped across
[#302](https://github.com/kenneth-liao/agent-profile-kit/issues/302) and
[#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304));
~~[UJ-35](#uj-35)~~ (shipped in
[#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303));
~~[UJ-04](#uj-04)~~ (shipped in
[#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122)),
~~[UJ-07](#uj-07)~~ (shipped across
[#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) and
[#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)),
~~[UJ-20](#uj-20)~~, ~~[UJ-21](#uj-21)~~.

### 9. Use

Setup guidance is reported conditionally by Host *and* by what was installed:

| Host | Requirement after `apply` |
|------|---------------------------|
| Claude Code | None. Rule + Skills load on next launch; no Git dependency. |
| Codex | Codex CLI 0.145.0+ for complete Context delivery, plus project trust **and** native review/trust of the generated `SessionStart` hook — only when Context is installed. Non-Git projects must be launched from the exact bound root. |
| Grok | None, except when co-bound with Claude and rules compatibility is on: Grok reads Claude's rule file and **no `.grok/rules/` is created**. |
| OpenCode | OpenCode CLI 1.18.23+. Profile Context loads via `.opencode/opencode.jsonc` referencing `.agent-profile-kit/opencode/context.md`, and Skills load from `.agents/skills/`. Restart running OpenCode sessions to load updated configuration. |
| Pi | Native project trust; `--skill` / `--no-skills` runtime overrides fall outside the guarantee. |
| Antigravity | `agy` 1.1.13+ and native project trust. Profile Context loads from deterministic always-on `.agents/rules/` files and Skills from the qualified shared `.agents/skills/` packages. |

**Codex Context floor (0.145.0+).** Context-bearing Codex plans probe
`codex --version` during `apply`; a missing, unreadable, or older CLI produces
one advisory warning per invocation naming Codex and the required floor, and
the material is written regardless (ADR-0025). Skills-only Codex plans do not
probe. `status`, `validate`, and `uninstall` do not probe, so a post-apply
Codex downgrade is not reported there — Context stops loading until a supported
CLI is restored, and the next `apply` warns again.

Verified: a four-Host `api` project produced `.codex/hooks.json`, and its
`.grok/` directory contained `skills/` **only** — no `rules/`. A Skills-only
Codex project produced no hook at all, so Codex approval guidance must be
conditional on installed Context, not on the Host alone.

Gaps: ~~[UJ-21](#uj-21)~~ (shipped across
[#118](https://github.com/kenneth-liao/agent-profile-kit/issues/118) and
[#125](https://github.com/kenneth-liao/agent-profile-kit/issues/125)).

### 10. Re-sync after a Workspace edit

`status` uses the same Project selection as `apply`: current Project by default,
one explicit absolute or home-relative bound root, or `--all` for the fleet.
Ambiguous, unbound, missing, relative, wildcard, and non-directory targets fail
with command guidance before Project inspection. The tool's best-working loop:
`stale source` is detected accurately, the gloss is useful the first time, and
the next action is correct. A fully-current single Project states that fact once
(`All Projects are current (1 Project)`); a fully-current fleet uses the same
shape (`All Projects are current (12 Projects)`). Neither emits a Host setup
reminder, Project list, or next action. Verbose status and JSON retain every Adapter-authored Host
Setup Step and its typed provenance. Interactive status inspections that outlast
a short anti-flicker threshold show delayed operation-level progress on the
terminal line; the line is cleared before the report, and redirected output and
JSON never carry progress bytes.

Gaps: ~~[UJ-32](#uj-32)~~ (shipped across
[#301](https://github.com/kenneth-liao/agent-profile-kit/issues/301),
[#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303),
[#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304), and
[#305](https://github.com/kenneth-liao/agent-profile-kit/issues/305));
~~[UJ-33](#uj-33)~~ (shipped across
[#302](https://github.com/kenneth-liao/agent-profile-kit/issues/302) and
[#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304)); ~~[UJ-14](#uj-14)~~, ~~[UJ-15](#uj-15)~~ (shipped in
[#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122)).

### 11. Recover

**Missing output** — a deleted generated file — is ordinary pending work:
`status` names the missing paths and `apply` restores them.

**Drifted output** — a generated file whose bytes, modes, or members differ from
the recorded installation — is ordinary pending work: `status` reports it as
non-blocking `drifted output` state and `apply` replaces the whole recorded root
from current Workspace source, discarding unknown members such as host scratch
directories. Removal paths (`uninstall`, stale removal, `machine remove-temp`) may
remove drifted proven roots without a manual pre-clean. Identity or path-safety
failures — changed extant roots with no continuity anchor, a symlinked root, an unsafe
parent — remain Blockers, and their evidence states only what was proven, never
asserting a user edit without provenance.

**Host CLI missing or outdated** no longer blocks anything (ADR-0025): during
`apply`, one advisory warning per identical Host capability failure per
invocation names the Host and its required version — a missing or outdated CLI
fails identically for every Project, so it emits once per invocation — and the
Host's material is written regardless. `status`,
`validate`, and `uninstall` never probe. The historical excerpt below showed
these conditions as Blockers with problem/requirement/remedy prose; that
gating and the Installer-authored prose no longer exist — presentation owns
every Blocker and warning sentence, keyed by the typed kind:

```
Blocker: Claude Code CLI was not found on PATH; install Claude Code and ensure
`claude --version` works before previewing or applying the Profile

Blocker: Claude CLI 1.0.0 does not support unscoped project rules (requires
2.0.64+); upgrade Claude Code before previewing or applying the Profile
```

**Mixed states across projects** now retain per-project guidance. With pending
work for `api` and `web` blocked, the run preserves `api`'s next step after the
all-project blocker is resolved and gives `web` its blocker remedy.

**Focused Blocker Recovery (`--blockers-only`).** When diagnosing or resolving blockers across single projects or the entire fleet, `--blockers-only` strictly isolates displayed blockers and their direct next steps without leaking unblocked project inventories, setup steps, or warnings:

```
$ apkit status --all --blockers-only
Cannot apply

Project:
  <project-b>
  Blocker: These generated paths are tracked by Git, so Agent Profile Kit
    cannot write to them without conflicting with repository ownership.
    Requirement: Generated files must be exclusively managed by Agent Profile
      Kit; repository-owned paths cannot be replaced.
    Remedy: Choose one: keep repository ownership and change the Project
      Binding or its Host selection so Agent Profile Kit does not plan output at
      these paths, or intentionally remove the conflicting paths from repository
      ownership yourself before retrying. Agent Profile Kit will not delete,
      untrack, adopt, or overwrite repository-owned material.
    Scope: Project
      <project-b>
    Affected paths (5):
      - .agents/skills/ (2 paths)
      - .claude/rules/agent-profile-kit.md
      - .claude/skills/ (2 paths)
    Recovery command: run
      apkit status --blockers-only --verbose
      to see the exact untracking command.

Blockers: 1 · Affected Projects: 1

Next:
- <project-b>:
  Resolve the reported blocker, then run
  apkit status
  again.
```

Under `--blockers-only --verbose`, the complete structured blocker evidence includes copyable Git untracking commands staging removal from Git ownership while preserving working files:

```
$ apkit status --all --blockers-only --verbose
Cannot apply

Blockers:
- These generated paths are tracked by Git, so Agent Profile Kit cannot write to
  them without conflicting with repository ownership.
  Requirement: Generated files must be exclusively managed by Agent Profile
    Kit; repository-owned paths cannot be replaced.
  Remedy: Choose one: keep repository ownership and change the configured
    Project or its Host selection so Agent Profile Kit does not plan output at these
    paths, or intentionally remove the conflicting paths from repository
    ownership yourself before retrying. Agent Profile Kit will not delete,
    untrack, adopt, or overwrite repository-owned material.
  Scope: Project
    <project-b>
  Affected path:
    <project-b>/.agents/skills/deploy-helper
  Affected path:
    <project-b>/.agents/skills/review-pr
  Affected path:
    <project-b>/.claude/rules/agent-profile-kit.md
  Affected path:
    <project-b>/.claude/skills/deploy-helper
  Affected path:
    <project-b>/.claude/skills/review-pr
  Recovery: run the command below yourself; Agent Profile Kit never executes
    it. It stages removal of these paths from Git ownership (the Git index)
    while the working files are preserved:
    git -C '<project-b>' rm -r --cached -- '.agents/skills/deploy-helper' '.agents/skills/review-pr' '.claude/rules/agent-profile-kit.md' '.claude/skills/deploy-helper' '.claude/skills/review-pr'
  Alternatively, change or remove the configured Project.

Blockers: 1 · Affected Projects: 1
```

During a focused partial apply (`apkit apply --all --blockers-only`), healthy projects and their pending restorations commit while blocked projects remain untouched. The resulting report retains the committed `Applied:` receipt prefix before remaining blockers, so writes are never hidden.

Gaps: ~~[UJ-02](#uj-02)~~, ~~[UJ-05](#uj-05)~~, ~~[UJ-06](#uj-06)~~ (shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117)), ~~[UJ-07](#uj-07)~~ (shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) and [#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)),
~~[UJ-11](#uj-11)~~ (shipped in
[#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120)),
~~[UJ-13](#uj-13)~~ (shipped in
[#126](https://github.com/kenneth-liao/agent-profile-kit/issues/126)),
~~[UJ-19](#uj-19)~~ (shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117)), ~~[UJ-23](#uj-23)~~ (shipped in
[#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122)).

### 12. Tear down

`uninstall` removes proven output and preserves bindings; `unbind` removes the
binding and preserves output. The boundary is sound and documented in the guide,
but neither command's output states it, and the follow-on state alarms:

```
$ agent-profile-kit uninstall
Uninstalled 1 Profile Installation

$ agent-profile-kit status
Attention required
…
  State: missing output (Profile Installation is missing)
State explanations:
- missing output: … this is not a safe automatic repair.
```

`unbind` then closes with `Next: agent-profile-kit preview && agent-profile-kit
apply`, which reports zero installations and no changes.

Gaps: ~~[UJ-03](#uj-03)~~, ~~[UJ-08](#uj-08)~~, ~~[UJ-09](#uj-09)~~
(shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124)).
<!-- historical-command-excerpts:end -->

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

The temporary identity survives on the receipt and in `machine list temporary`, so
`machine remove-temp` stays discoverable without touching ordinary Project lifecycle
state or Local Configuration. Width, styling, and wrapping behave exactly like
the ordinary lifecycle surfaces through the shared presentation boundary
(ADR-0016).

Gaps: ~~[UJ-24](#uj-24)~~, ~~[UJ-27](#uj-27)~~, ~~[UJ-34](#uj-34)~~
(shipped in [#162](https://github.com/kenneth-liao/agent-profile-kit/issues/162),
[#166](https://github.com/kenneth-liao/agent-profile-kit/issues/166),
[#171](https://github.com/kenneth-liao/agent-profile-kit/issues/171), and
[#300](https://github.com/kenneth-liao/agent-profile-kit/issues/300)).

---

## Gap register

Severity is a maintainer judgement about journey impact, not a schedule.

| ID | Severity | Stage | Gap |
|----|----------|-------|-----|
| ~~[UJ-33](#uj-33)~~ | ~~High~~ | ~~8~~ | ~~Concise `apply` still labels persistent Host constraints as standing unfinished setup~~ — status suppression shipped in [#302](https://github.com/kenneth-liao/agent-profile-kit/issues/302), apply first-use shipped in [#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304); qualified in [#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307) |
| ~~[UJ-35](#uj-35)~~ | ~~High~~ | ~~8~~ | ~~A successful changed `apply` can say the Project was already current while its Apply Receipt proves work was completed~~ — shipped in [#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303); qualified in [#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307) |
| ~~[UJ-32](#uj-32)~~ | ~~Med-High~~ | ~~8~~ | ~~Routine apply output still repeats setup and readiness facts instead of one task-first decision~~ — status compact decision shipped in [#301](https://github.com/kenneth-liao/agent-profile-kit/issues/301); apply receipt lead shipped in [#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303); first-use apply note shipped in [#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304); invocation-wide readiness shipped in [#305](https://github.com/kenneth-liao/agent-profile-kit/issues/305); qualified in [#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307) |
| ~~[UJ-34](#uj-34)~~ | ~~Medium~~ | ~~13~~ | ~~Next-action surfaces fork the primary path~~ — shipped in [#297](https://github.com/kenneth-liao/agent-profile-kit/issues/297), [#298](https://github.com/kenneth-liao/agent-profile-kit/issues/298), [#299](https://github.com/kenneth-liao/agent-profile-kit/issues/299), and [#300](https://github.com/kenneth-liao/agent-profile-kit/issues/300); qualified in [#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307) |
| ~~[UJ-01](#uj-01)~~ | ~~High~~ | ~~2, 3, 4~~ | ~~`init` next-step dead-ends on an empty Workspace~~ — shipped in [#121](https://github.com/kenneth-liao/agent-profile-kit/issues/121) |
| ~~[UJ-02](#uj-02)~~ | ~~High~~ | ~~11~~ | ~~Drifted output has no stated remedy anywhere~~ — shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117) |
| ~~[UJ-03](#uj-03)~~ | ~~High~~ | ~~12~~ | ~~Post-`uninstall` `status` warns about an intended state~~ — shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124) |
| ~~[UJ-04](#uj-04)~~ | ~~High~~ | ~~8~~ | ~~"Changes" means two things on one `apply` screen~~ — shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122) |
| ~~[UJ-19](#uj-19)~~ | ~~High~~ | ~~11~~ | ~~Blocked results lead with a plan that cannot happen~~ — shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117) |
| ~~[UJ-21](#uj-21)~~ | ~~High~~ | ~~8, 9~~ | ~~No post-apply Host guidance; Codex can break silently~~ — shipped across [#118](https://github.com/kenneth-liao/agent-profile-kit/issues/118) and [#125](https://github.com/kenneth-liao/agent-profile-kit/issues/125) |
| ~~[UJ-24](#uj-24)~~ | ~~High~~ | ~~1, 3, 7, 11~~ | ~~Fixed-width output overflows any real terminal and ignores `COLUMNS`~~ — shipped in [#156](https://github.com/kenneth-liao/agent-profile-kit/issues/156), [#159](https://github.com/kenneth-liao/agent-profile-kit/issues/159), [#166](https://github.com/kenneth-liao/agent-profile-kit/issues/166), and [#173](https://github.com/kenneth-liao/agent-profile-kit/issues/173) |
| ~~[UJ-25](#uj-25)~~ | ~~High~~ | ~~11~~ | ~~One blocker class repeats once per path and buries the remedy~~ — shipped in [#167](https://github.com/kenneth-liao/agent-profile-kit/issues/167), [#168](https://github.com/kenneth-liao/agent-profile-kit/issues/168), [#169](https://github.com/kenneth-liao/agent-profile-kit/issues/169), and [#172](https://github.com/kenneth-liao/agent-profile-kit/issues/172) |
| ~~[UJ-26](#uj-26)~~ | ~~High~~ | ~~7, 10~~ | ~~Long inspections leave the terminal blank~~ — shipped in [#170](https://github.com/kenneth-liao/agent-profile-kit/issues/170) |
| ~~[UJ-05](#uj-05)~~ | ~~Med-High~~ | ~~11~~ | ~~Blocked `apply` reports the same blockers three times~~ — shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117) |
| ~~[UJ-20](#uj-20)~~ | ~~Med-High~~ | ~~5, 7, 8~~ | ~~Hosts are invisible after `bind`~~ — shipped in [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) |
| ~~[UJ-22](#uj-22)~~ | ~~Med-High~~ | ~~7~~ | ~~Non-Git project output is never shown at all~~ — shipped in [#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120) |
| ~~[UJ-27](#uj-27)~~ | ~~Med-High~~ | ~~1~~ | ~~No read-only inventory or orientation surface for Projects, Profiles, Hosts, temporary identities, or locations~~ — shipped in [#157](https://github.com/kenneth-liao/agent-profile-kit/issues/157), [#160](https://github.com/kenneth-liao/agent-profile-kit/issues/160), [#161](https://github.com/kenneth-liao/agent-profile-kit/issues/161), [#162](https://github.com/kenneth-liao/agent-profile-kit/issues/162), and [#163](https://github.com/kenneth-liao/agent-profile-kit/issues/163) |
| ~~[UJ-28](#uj-28)~~ | ~~Med-High~~ | ~~1~~ | ~~No visual hierarchy, semantic color, or compact product identity~~ — shipped in [#164](https://github.com/kenneth-liao/agent-profile-kit/issues/164) |
| ~~[UJ-29](#uj-29)~~ | ~~Med-High~~ | ~~1, 12~~ | ~~Command wording and Project identity are inconsistent across surfaces~~ — wording shipped in [#165](https://github.com/kenneth-liao/agent-profile-kit/issues/165); identity shipped in [#171](https://github.com/kenneth-liao/agent-profile-kit/issues/171) (alongside [UJ-07](#uj-07)) |
| ~~[UJ-30](#uj-30)~~ | ~~Med-High~~ | ~~3~~ | ~~The full guide prints hundreds of lines without a compact index~~ — shipped in [#159](https://github.com/kenneth-liao/agent-profile-kit/issues/159) |
| ~~[UJ-31](#uj-31)~~ | ~~Med-High~~ | ~~7, 8, 10~~ | ~~A fleet-wide lifecycle repeats identical Profile, Host, path, next-action, and readiness facts per Project and performs the same Workspace, Host, Git, and ownership work repeatedly~~ — shipped across [#194](https://github.com/kenneth-liao/agent-profile-kit/issues/194), [#195](https://github.com/kenneth-liao/agent-profile-kit/issues/195), [#196](https://github.com/kenneth-liao/agent-profile-kit/issues/196), [#197](https://github.com/kenneth-liao/agent-profile-kit/issues/197), [#198](https://github.com/kenneth-liao/agent-profile-kit/issues/198), [#199](https://github.com/kenneth-liao/agent-profile-kit/issues/199), [#200](https://github.com/kenneth-liao/agent-profile-kit/issues/200), [#201](https://github.com/kenneth-liao/agent-profile-kit/issues/201), [#202](https://github.com/kenneth-liao/agent-profile-kit/issues/202), [#203](https://github.com/kenneth-liao/agent-profile-kit/issues/203), and [#204](https://github.com/kenneth-liao/agent-profile-kit/issues/204); qualified in [#205](https://github.com/kenneth-liao/agent-profile-kit/issues/205) |
| ~~[UJ-06](#uj-06)~~ | ~~Medium~~ | ~~11~~ | ~~One blocker fact rendered three ways per screen~~ — shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117) |
| ~~[UJ-07](#uj-07)~~ | ~~Medium~~ | ~~5, 7, 11~~ | ~~Absolute paths remain in bind, blocker, exclusion, and diagnostic lines~~ — shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) and [#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152) |
| ~~[UJ-08](#uj-08)~~ | ~~Medium~~ | ~~12~~ | ~~`uninstall` output omits what it did and what it kept~~ — shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124) |
| ~~[UJ-09](#uj-09)~~ | ~~Medium~~ | ~~12~~ | ~~`unbind` recommends a no-op next step~~ — shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124) |
| ~~[UJ-10](#uj-10)~~ | ~~Medium~~ | ~~2, 5~~ | ~~Missing-Profile error names paths, not available Profiles~~ — shipped in [#119](https://github.com/kenneth-liao/agent-profile-kit/issues/119) |
| ~~[UJ-11](#uj-11)~~ | ~~Medium~~ | ~~7, 11~~ | ~~Change counter buckets unknown output kinds as drift~~ — shipped in [#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120) |
| ~~[UJ-12](#uj-12)~~ | ~~Medium~~ | ~~7~~ | ~~`preview --verbose` contradicts itself on one path~~ — shipped in [#123](https://github.com/kenneth-liao/agent-profile-kit/issues/123) |
| ~~[UJ-13](#uj-13)~~ | ~~Medium~~ | ~~11~~ | ~~`status` exits 0 with blockers; `preview` exits 1~~ — shipped in [#126](https://github.com/kenneth-liao/agent-profile-kit/issues/126) |
| ~~[UJ-23](#uj-23)~~ | ~~Medium~~ | ~~11~~ | ~~One aggregate next-action stalls unblocked projects~~ — shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122) |
| ~~[UJ-14](#uj-14)~~ | ~~Low-Med~~ | ~~10~~ | ~~Happy-path `status` says the same thing three times~~ — shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122) |
| ~~[UJ-15](#uj-15)~~ | ~~Low-Med~~ | ~~7, 10~~ | ~~State explanations re-teach vocabulary every run~~ — shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122) |
| ~~[UJ-16](#uj-16)~~ | ~~Low~~ | ~~1, 5~~ | ~~No `--version`, `-h`, `help`, or per-command `--help`~~ — root discovery shipped in [#115](https://github.com/kenneth-liao/agent-profile-kit/issues/115); focused aliases, Host guidance, and concise typo recovery shipped in [#158](https://github.com/kenneth-liao/agent-profile-kit/issues/158) |
| ~~[UJ-17](#uj-17)~~ | ~~Low~~ | ~~6~~ | ~~`validate` prints "1 Profiles" and names nothing~~ — shipped in [#119](https://github.com/kenneth-liao/agent-profile-kit/issues/119) |
| ~~[UJ-18](#uj-18)~~ | ~~Low~~ | ~~7~~ | ~~`--verbose` inlines composed Context without a separator~~ — shipped in [#123](https://github.com/kenneth-liao/agent-profile-kit/issues/123) |

### ~~UJ-32~~

The `status` portion shipped in
[#301](https://github.com/kenneth-liao/agent-profile-kit/issues/301): pending
single-Project and fleet views now render one scope-correct impact decision,
one matching apply command, and at most one matching verbose route while routine
paths and successful Git bookkeeping remain diagnostic detail. The apply receipt lead
portion shipped in [#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303),
first-use guidance shipped in [#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304),
and invocation-wide readiness shipped in [#305](https://github.com/kenneth-liao/agent-profile-kit/issues/305):
successful changed apply leads from the Apply Receipt, provides one action-grouped
first-use note when relevant, and ends with exactly one invocation-wide Profile loading
readiness statement. Qualified in
[#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307) by the packed
newcomer journey.

### ~~UJ-33~~

The concise `status` portion shipped in
[#302](https://github.com/kenneth-liao/agent-profile-kit/issues/302): pending,
clean, and blocked concise status render no transition-triggered or standing
Host Setup Steps, while verbose status and JSON retain every Adapter-authored
step and its typed provenance. The concise `apply` portion shipped in
[#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304): first-use
guidance renders as one action-grouped note with plain reasons, standing trust
and root-launch reminders are omitted on routine updates, shared-path layout
notes stay behind `--verbose`, and deduplicated fleet actions omit Project-path
matrices while verbose and JSON retain every Adapter-authored step. Qualified in
[#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307) by the packed
newcomer journey.

### ~~UJ-34~~

Root help now leads with the four-step first run, then separates common commands
from secondary inventory, teardown, machine-detail, and temporary-installation
commands ([#294](https://github.com/kenneth-liao/agent-profile-kit/issues/294)).
The no-topic inventory menu now names each topic once with one human description,
with JSON examples retained in focused `list` help
([#295](https://github.com/kenneth-liao/agent-profile-kit/issues/295)). Host
inventory now leads with the canonical Hosts supported for configured Projects,
while focused temporary help and JSON retain temporary-install eligibility
([#296](https://github.com/kenneth-liao/agent-profile-kit/issues/296)). Focused
inventory now uses instructional usage guidance instead of optional or redundant
`Next:` actions, and Host inventory explains how `apkit bind` selects a listed
Host for a configured Project
([#297](https://github.com/kenneth-liao/agent-profile-kit/issues/297)). Focused
`init` help and successful scaffold initialization now derive the same
`apkit bind example --host codex` route from the existing scaffolded example
Profile ([#298](https://github.com/kenneth-liao/agent-profile-kit/issues/298)).
Successful validation now derives guidance from the result it produced: no
configured Projects points to `apkit bind`, while one or more points to
`apkit status`; warnings stay visible and validation stays read-only
([#299](https://github.com/kenneth-liao/agent-profile-kit/issues/299)). Temporary
install success now prints the exact `apkit machine remove-temp <actual-id>` command
using the durable identity created by that operation
([#300](https://github.com/kenneth-liao/agent-profile-kit/issues/300)). Qualified
in [#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307) by the
packed newcomer journey.

### ~~UJ-35~~
~~A successful first apply can lead from the freshly current verification and say
that the selected Project was already current, then show non-empty work in the
Apply Receipt. Both records have distinct authority, but this ordering makes the
resulting-state sentence contradict the command's completed work. Only a true
no-op receipt can support "already current."~~

Shipped in [#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303):
`apply` now leads from its committed Apply Receipt impact before setup guidance,
summarizes affected Project and generated-file counts once in concise output,
omits routine Git exclusion bookkeeping from concise success, and reserves
"already current" exclusively for a true no-op apply. Qualified in
[#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307) by the packed
newcomer journey.

### ~~UJ-01~~
~~`init` closes with an unusable next step because a fresh Workspace holds zero
Profiles, while the only authoring route is the full guide.~~

Shipped in [#121](https://github.com/kenneth-liao/agent-profile-kit/issues/121):
`init` now scaffolds a bindable example and names its successful bind command;
focused Profile, Context Module, and Skill guides provide copyable examples.

### ~~UJ-02~~
~~A hand-edited generated file blocks `apply` *and* `uninstall`, leaving no
CLI-reachable exit. The working remedy — delete the file, then `apply`, which
reclassifies it as a proven `repairable missing output` — is stated by neither
the blocker text, the state gloss, nor the guide.~~

Shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117):
drift blockers protect the edit, state both recovery routes once, and name the
same lifecycle command to retry.

### ~~UJ-03~~
~~After a successful `uninstall` the binding remains by design, so the next
`status` reports `Attention required`, `missing output (Profile Installation is
missing)`, and `this is not a safe automatic repair`. Deliberate teardown and
unexplained loss render identically, though a Marker removed by the Installer
itself is a distinguishable state.~~

Shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124), then simplified in [#242](https://github.com/kenneth-liao/agent-profile-kit/issues/242):
`uninstall` now removes ordinary ownership state without writing separate teardown
provenance. Because the preserved Project Binding remains desired state, `status`
reports the Project as not installed and eligible for `apply`, without unsafe
missing-output framing.

### ~~UJ-04~~
~~`apply` prints `Changes: none` (pending work against post-apply state) above
`Apply receipt: … 19 generated-output additions` (work just committed). Both are
correct per the Apply Receipt model; sharing the bare word "Changes" is what
misleads. Distinct labels — `Pending` versus `Applied` — carry the same model
without the collision.~~

Shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122):
concise and verbose apply reports label verified remaining work `Pending` and
committed receipt work `Applied`.

### ~~UJ-05~~
<!-- historical-command-excerpts:start -->
~~A blocked `apply` writes the concise report to stdout, re-runs `preview` as a
diagnostic, then rethrows so `cli/index.ts` prints the blockers again to stderr.
The closing line reads `Next: …run agent-profile-kit preview again` because the
fallback formats a `preview` report — naming a command the user did not run.~~
<!-- historical-command-excerpts:end -->

Shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117):
a blocked `apply` emits one report and command-specific retry guidance.

### ~~UJ-06~~
~~For a single drifted file, the `State:` reason, the path-scoped blocker, and the
installation-scoped blocker each restate one fact. The redundancy is upstream of
presentation, in how blockers are emitted.~~

Shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117):
the underlying condition emits one blocker before presentation.

### ~~UJ-07~~
~~Project headers and apply receipts now use short, unambiguous identities. Bind,
blocker, exclusion-target, warning, and verbose diagnostic lines can still carry
the full absolute project root; a blocked run can therefore repeat it several
times.~~

Shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116),
[#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152), and
[#171](https://github.com/kenneth-liao/agent-profile-kit/issues/171): `bind`,
lifecycle project blocks, blockers, warnings, Git exclusions, verbose
diagnostics, `unbind` teardown, temporary-installation receipts and blocked
output, and `uninstall` Git-exclusion targets use one shortest-unambiguous path
presenter, while Local Configuration, Installation State, receipts, JSON, and
unrelated authoring output retain their canonical or authored paths.
Blocked temporary-installation diagnostics fall back to a home-relative or full
identity when run from inside the Project, preventing a bare `.` from losing the
blocked message's subject.

### ~~UJ-08~~
~~`Uninstalled 1 Profile Installation` omits the project, the outputs removed, the
exclusion entries cleaned, and that bindings were preserved — so `status` will
immediately report pending additions. Compare `unbind`, which names its effects.~~

Shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124):
`uninstall` now lists each project, removed generated path, cleaned Git exclusion
entry, and the preserved Project Bindings.

### ~~UJ-09~~
~~`unbind` closes with `Next: preview && apply`. When the unbound project was the
only installation and its output was already removed, that sequence reports zero
installations and no changes. The next step should depend on whether generated
output actually survives the unbind.~~

Shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124):
`unbind` now recommends global reconciliation only while an installed Manifest
remains for the removed binding.

### ~~UJ-10~~
~~`profile 'engineering' does not exist in Workspace <workspace>` leads with the
config path, carries a second absolute path, and never lists what *does* exist.
Naming available Profiles — or stating there are none and pointing at the format
guidance — turns a dead end into a next step.~~

Shipped in [#119](https://github.com/kenneth-liao/agent-profile-kit/issues/119):
missing-Profile errors now list the Workspace's available Profiles or state that
none exist and point at `apkit guide`.

### ~~UJ-11~~
~~`summarizeOutputs` in `cli/presentation.ts` matches `addition`, `update`,
`removal`, `repair`, and `unchanged`, then counts every remaining kind as drift.
A `missing member` is therefore reported as a "drift item", so one missing Skill
plus one drifted rule renders as `2 generated-output drift items`. The
fall-through is also the shape that lets a future output kind silently
mis-render.~~

Shipped in [#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120):
output kinds are summarized exhaustively and changed paths render with an
explicit marker in concise reports.

### ~~UJ-12~~
~~`preview --verbose` lists the same Skill path as both `unchanged` and `missing
member`, because directory-level and member-level records print into one flat
list. A reader cannot tell which is authoritative.~~

Shipped in [#123](https://github.com/kenneth-liao/agent-profile-kit/issues/123),
then superseded by [#241](https://github.com/kenneth-liao/agent-profile-kit/issues/241):
directory ownership attention now replaces the enclosing directory's
`unchanged` record with one aggregate-root drift record; member-level records
are no longer reconstructed.

### ~~UJ-13~~
~~`status` exits 0 while printing `Attention required` and two blockers; `preview`
exits 1 on the same state. Automation cannot gate on `status`, and the two
read-only commands disagree about what a blocker means.~~

Shipped in [#126](https://github.com/kenneth-liao/agent-profile-kit/issues/126):
`preview`, `apply`, and `status` share exit codes `0` (no tool error and no
blockers; JSON `outcome` may still be `attention`) / `1` tool error /
`2` blockers, and accept `--json` for machine-readable reports.

### ~~UJ-14~~
~~A fully-current `status` prints the outcome line, the aggregate line, and `No
Profile Installations need attention.` — three renderings of one fact, in the
state users hit most often.~~

Shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122):
a fully current concise status states that fact once.

### ~~UJ-15~~
~~The `State explanations:` block reprints full definitions every invocation.
Valuable on first encounter, noise by the tenth.~~

Shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122):
concise reports retain state names while state definitions appear only under
the explicit `--verbose` view.

### ~~UJ-16~~
~~`--version` and `-h` are rejected as unknown commands, `help` is not a command,
and per-command help does not exist. `bind --help` is additionally parsed as a
Profile named `--help`, because `parseBindArguments` accepts `arguments_[0]`
without a leading-dash check.~~

Shipped in [#115](https://github.com/kenneth-liao/agent-profile-kit/issues/115)
and extended in [#158](https://github.com/kenneth-liao/agent-profile-kit/issues/158):
root discovery supports the conventional aliases and engine version, every
command explains itself through identical focused-help aliases, supported Host
values are visible at the command boundary, close typos receive one
deterministic suggestion, and unmatched commands point to concise help without
dumping the root menu. Leading-dash values still fail before positional
parsing.

### ~~UJ-17~~
~~`(1 Profiles, 0 Project Bindings)` has a plural agreement bug — `plural()` in
`cli/presentation.ts` already solves this and is unused here — and reports counts
without naming the Profiles found or Hosts bound, which is what `validate` is run
to confirm.~~

Shipped in [#119](https://github.com/kenneth-liao/agent-profile-kit/issues/119):
`validate` now lists the Profiles found and unique Hosts bound while rendering
Profile and Project Binding counts grammatically.

### ~~UJ-18~~
~~`--verbose` prints composed Context inline under `Context:` with no delimiter,
so multi-module Context runs together with surrounding report structure and
cannot be scanned or copied cleanly.~~

Shipped in [#123](https://github.com/kenneth-liao/agent-profile-kit/issues/123):
sentence-case `--- begin Context ---` / `--- end Context ---`-style fences
delimit each composed Context in verbose output. The fence grows when its text
appears inside the Context, so scanners can identify the outer boundary without
escaping Workspace content.

### ~~UJ-19~~
~~When a run is blocked, the report still leads with work that cannot happen. A
missing Claude CLI yields a header of `Changes: 2 generated-output additions`, an
exclusions block listing files that will never be written, and a state gloss
promising `apply will create its Installer-owned generated outputs` — pushing the
one remedy-bearing line to eighth position. The plan is hypothetical while a
blocker stands and should not lead.~~

Shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117):
blocked lifecycle reports lead with the blocker and suppress hypothetical plan
detail.

### ~~UJ-20~~
~~Hosts were echoed once, by `bind`, and never again. `preview`, `apply`, and
`status` showed `Profile: engineering` and a file count for a project bound to
four Hosts, with no indication of which Hosts produced which output.~~

Shipped in [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116):
each lifecycle project block now carries the Hosts recorded by its Project
Binding through the ReconciliationReport presentation seam.

### ~~UJ-21~~
~~No post-apply Host guidance was available.~~ Codex guidance shipped in
[#118](https://github.com/kenneth-liao/agent-profile-kit/issues/118): Host Setup
Steps warn about generated `SessionStart` hook approval, project trust, and the
non-Git exact-root launch constraint, while Skills-only Profiles emit no hook
guidance. Cross-Host guidance shipped in
[#125](https://github.com/kenneth-liao/agent-profile-kit/issues/125): Grok names
Claude's coalesced rule path, Pi names native project trust, and setup-free
installs state that no further Host setup is required.

### ~~UJ-22~~
~~A non-Git project's generated output appears nowhere. Because file paths surface
only inside the Repository Exclusion block, and non-Git projects contribute no
exclusion entries, a bound non-Git project shows a bare count and nothing else —
even under `preview`, whose entire job is to say what will be written.~~

Shipped in [#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120):
concise reports list changed paths from the reconciliation plan for Git and
non-Git projects alike.

### ~~UJ-23~~
~~The next-action line is deliberately one conservative aggregate. Across projects
that behaves poorly: with one project carrying otherwise-actionable pending work
and another blocked, the run instructs the user only to resolve blockers and
conceals the first project's next step after the all-project blocker is resolved.~~

Shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122):
next-action guidance is derived per project, preserves otherwise-actionable work
alongside blocked work without claiming it can apply independently, and is
omitted for projects with nothing to change.

### ~~UJ-24~~
~~Output is laid out for one fixed width: root help reaches 129 columns, focused
help 167, focused guides 154, and blocked lifecycle output 201. Setting
`COLUMNS=60` or `COLUMNS=160` changes nothing; the CLI has no terminal-width
model and leaves wrapping to the terminal.~~

Shipped across
[#156](https://github.com/kenneth-liao/agent-profile-kit/issues/156) (root help),
[#159](https://github.com/kenneth-liao/agent-profile-kit/issues/159) (guides),
[#166](https://github.com/kenneth-liao/agent-profile-kit/issues/166) (lifecycle
and temporary reports), and
[#173](https://github.com/kenneth-liao/agent-profile-kit/issues/173)
(inventory, info, validation, focused help, authoring, and teardown): prose
wraps to the interactive terminal measure with a clamped readable range and a
deterministic redirected width, while copyable paths, commands, and identities
stay whole on dedicated lines. ADR-0016 records the boundary.

### ~~UJ-25~~
~~At scale, one blocker class repeats once per affected path and buries the
remedy: a real 12-Project `status` produced 42 blockers, 41 of them per-path
instances of the same tracked-output ownership conflict, each restating a
201-column explanation.~~

Shipped in
[#167](https://github.com/kenneth-liao/agent-profile-kit/issues/167) and
[#169](https://github.com/kenneth-liao/agent-profile-kit/issues/169) (typed
emitters), [#168](https://github.com/kenneth-liao/agent-profile-kit/issues/168)
(grouped tracked-output conflicts with one explanation and a capped affected
list), and [#172](https://github.com/kenneth-liao/agent-profile-kit/issues/172)
(the exhaustive structured contract and `schemaVersion: 2` JSON). The blocker
watch item below remains active for any blocker family that can fire once per
selected artifact.

### ~~UJ-26~~
~~A multi-Project `status` (~4.9s) or `preview` (~9.2s) leaves the interactive
terminal blank until the report arrives, so the command appears hung.~~

Shipped in [#170](https://github.com/kenneth-liao/agent-profile-kit/issues/170):
interactive long-running `status` and `preview` show delayed, ephemeral,
operation-level progress after a short anti-flicker threshold, cleared before
the final report; redirected output, JSON, and non-interactive errors never
carry progress bytes.

### ~~UJ-27~~
~~There is no CLI way to ask which Projects are bound, which Profiles exist,
which Hosts are supported, which Temporary Profile Installations are active, or
where the Workspace, Local Configuration, and Installation State live. `status`
intentionally hides current Projects, and during an active temporary
installation it can report no Projects while the identity `machine remove-temp` needs is
unreachable.~~

Shipped in [#157](https://github.com/kenneth-liao/agent-profile-kit/issues/157)
(`info`), [#160](https://github.com/kenneth-liao/agent-profile-kit/issues/160)
(`list projects`), [#161](https://github.com/kenneth-liao/agent-profile-kit/issues/161)
(`list profiles`), [#163](https://github.com/kenneth-liao/agent-profile-kit/issues/163)
(`list hosts`), and [#162](https://github.com/kenneth-liao/agent-profile-kit/issues/162)
(`machine list temporary`): read-only inventory and location views never probe Hosts or
write state, and `machine list temporary` recovers the durable identity for
`machine remove-temp` without entering ordinary reconciliation.

### ~~UJ-28~~
~~Interactive output has no visual hierarchy beyond blank lines and indentation:
no semantic color, no compact product identity, and no distinction between
headings, commands, paths, outcomes, warnings, blockers, and consequences.~~

Shipped in [#164](https://github.com/kenneth-liao/agent-profile-kit/issues/164):
TTY-safe semantic styling and a compact ASCII identity appear only for
color-capable interactive human output, `NO_COLOR` and `TERM=dumb` disable ANSI,
and redirected output, JSON, errors, and the agent guide stay plain.

### ~~UJ-29~~
~~Root help describes `uninstall` as removing Projects, and human Project
identity drifts: lifecycle output shows a concise home-relative Project while
`init`, `uninstall`, `unbind`, and temporary-installation output return to long
authored or canonical paths.~~

Shipped in [#165](https://github.com/kenneth-liao/agent-profile-kit/issues/165)
(wording): command summaries are authored task language and `uninstall`
describes removing proven owned output while preserving Projects and bindings;
and in [#171](https://github.com/kenneth-liao/agent-profile-kit/issues/171)
(identity): every human command uses the one shortest-unambiguous Project
presenter, recorded alongside [UJ-07](#uj-07).

### ~~UJ-30~~
~~The full no-argument `guide` prints a 651-line document, so requesting guidance
unexpectedly floods the terminal.~~

Shipped in [#159](https://github.com/kenneth-liao/agent-profile-kit/issues/159):
no-argument `guide` prints a concise topic index, `guide --full` keeps the
complete human guide, `guide --agent` keeps the agent reference, and focused
topics stay complete and copyable at terminal width.

### ~~UJ-31~~
~~A fleet-wide lifecycle repeats the same Profile, Hosts, paths, next actions,
and readiness facts once per Project, and performs the same Workspace,
Host-capability, Git, and ownership work repeatedly, so a 12-Project
synchronization takes seconds and prints a wall of repeated text.~~

Shipped across the fleet-synchronization tickets
[#194](https://github.com/kenneth-liao/agent-profile-kit/issues/194),
[#195](https://github.com/kenneth-liao/agent-profile-kit/issues/195),
[#196](https://github.com/kenneth-liao/agent-profile-kit/issues/196),
[#197](https://github.com/kenneth-liao/agent-profile-kit/issues/197),
[#198](https://github.com/kenneth-liao/agent-profile-kit/issues/198),
[#199](https://github.com/kenneth-liao/agent-profile-kit/issues/199),
[#200](https://github.com/kenneth-liao/agent-profile-kit/issues/200),
[#201](https://github.com/kenneth-liao/agent-profile-kit/issues/201),
[#202](https://github.com/kenneth-liao/agent-profile-kit/issues/202),
[#203](https://github.com/kenneth-liao/agent-profile-kit/issues/203), and
[#204](https://github.com/kenneth-liao/agent-profile-kit/issues/204): one
invocation-scoped lifecycle resolves each shared Profile, Host capability, Git
topology, and owned output once per command, independent Project reads run
through one bounded scheduler, apply still verifies resulting state freshly,
reconciliation publishes observable output operations, and multi-Project
reports group each operation with its affected Projects without inferring
artifact causality. Qualified in
[#205](https://github.com/kenneth-liao/agent-profile-kit/issues/205) with the
isolated 12-Project packed journey, structural operation budgets, recorded warm
samples, and ADR-0017.

---

## Watch items

Observed concerns that are deliberately **not** registered gaps and not ticketed,
because their only known instance no longer reproduces. A gate protecting a
failure that cannot be named concretely is debt, not protection. Promote one to
the register only when it recurs against current behavior.

**Blocker class repetition.** A pre-#110 `status` reported 21 near-identical
blockers — 11 Skill-collision and 10 discovery-root — each restating its full
explanation, for two underlying classes. This is distinct from
[UJ-06](#uj-06): those are legitimately separate blockers, so deduplication does
not apply; what they want is grouping into one explanation plus the affected
list. The later recurrence against 41 tracked-output conflicts (see #154) is
registered as the shipped gap [UJ-25](#uj-25): it is grouped at its emission
boundary into one typed blocker with one explanation and a capped affected-path
list ([#168](https://github.com/kenneth-liao/agent-profile-kit/issues/168)), so
the tracked-output family cannot repeat its explanation. Other per-path emitters
(occupied destinations, ownership failures) remain ungrouped, keeping this
watch active: any blocker that can fire once per selected artifact could
reintroduce it.

---

## Accepted presentation principles

Accepted in ADR-0014 and refined by ADR-0020. Individual fixes are argued from
these rather than from scratch.

1. **One fact, one rendering per screen** ([UJ-06](#uj-06), [UJ-14](#uj-14)), and
   one command run produces one report ([UJ-05](#uj-05)).
2. **Every refusal names its remedy.** A blocker the user cannot act on is an
   incomplete blocker ([UJ-02](#uj-02), [UJ-10](#uj-10)).
3. **When blocked, the blocker is the report.** Hypothetical plan detail is
   demoted or suppressed ([UJ-19](#uj-19)).
4. **Never warn about a state the user just requested** ([UJ-03](#uj-03)).
5. **A next step must change something**, and must not stall work that is ready
   ([UJ-09](#uj-09), [UJ-23](#uj-23)).
6. **Distinct concepts get distinct words.** Presentation must not overload one
   term for two of them ([UJ-04](#uj-04)).
7. **Summarize routine impact; disclose actionable identity.** Exact generated
   paths and Git bookkeeping are verbose by default, while blockers, warnings,
   drift, ownership attention, and repair or failure retain the identity needed
    to act ([UJ-11](#uj-11), [UJ-22](#uj-22), ~~[UJ-32](#uj-32)~~).
8. **Show identity at the shortest unambiguous length**, including the Hosts the
   user chose ([UJ-07](#uj-07), [UJ-20](#uj-20)).
9. **Teach once, at the point of need** — not on every run ([UJ-15](#uj-15)),
   and carry the journey into the Host without presenting unobserved Host state
   as unfinished setup ([UJ-21](#uj-21), ~~[UJ-33](#uj-33)~~).
10. **Exit codes agree across commands** for the same state ([UJ-13](#uj-13)).
