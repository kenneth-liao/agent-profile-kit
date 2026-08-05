# Agent Profile Kit user journey

The living map of what a person does with the CLI, what each stage owes them,
and where the current surface falls short. See ADR-0013 for why this map exists
here, and ADR-0014 for the presentation decisions accepted against it.

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
a non-Git project, and a disabled-model-invocation Skill. These captured excerpts
predate the `apkit` rename and deliberately preserve the executable spelling that
produced them.

---

## The journey at a glance

| # | Stage | Command | Outcome the stage owes |
|---|-------|---------|------------------------|
| 1 | Discover | `apkit`, `--help`, `-h`, `help`, `help <command>`, `<command> -h`, `<command> --help`, `--version`, `list`, `list projects [--json]`, `list profiles [--json]`, `list temporary [--json]` | Understand the command surface, command-specific guidance, which Projects are configured, which Profiles are available from the selected Workspace, and which Temporary Profile Installations can be removed by identity |
| 2 | Initialize | `init [workspace]` | A valid Workspace and Local Configuration, and a clear next move |
| 3 | Learn the format | `guide [profile\|context\|skill\|--full\|--agent]` | Enough to author a first Context Module, Skill, and Profile |
| 4 | Author | *(no CLI; edit Workspace files)* | A Profile that selects real artifacts |
| 5 | Bind | `bind <profile> [project] --host <host>` | One project associated with one Profile and its Hosts |
| 6 | Verify | `validate` | Confidence that Workspace and configuration are well-formed |
| 7 | Preview | `preview [--verbose] [--json]` | Know exactly what `apply` will write, before it writes |
| 8 | Apply | `apply [--verbose] [--json]` | Generated output on disk, and proof of what changed |
| 9 | Use | *(launch Codex/Claude/Grok/Pi)* | Material loads through native Host discovery |
| 10 | Re-sync | `status [--json]` → `preview` → `apply` | Notice Workspace drift and reconcile it |
| 11 | Recover | `status`, `apply`, `uninstall` | Get unstuck from drifted, missing, or malformed state |
| 12 | Tear down | `uninstall`, `unbind` | Remove output and/or desired state, with the boundary made clear |

Stages 1–8 are the first-run path. Stages 10–12 are the returning-user path.
Stage 4 is the only stage with no CLI surface at all, and stage 9 the only one
the CLI never speaks to.

---

## Stage detail

<!-- historical-command-excerpts:start -->
### 1. Discover

A bare invocation, `--help`, `-h`, and `help` print root help: description,
workflow-grouped commands with two-line syntax and wrapped descriptions, a
four-step quick start, and a pointer to `guide`. The quick start points to
`guide profile` for a valid Profile example and `bind --help` for supported Host
values. Interactive output selects the tty width (falling back to `COLUMNS`)
and clamps readable prose to 40–100 columns; redirected output uses a
deterministic 80-column measure. `--version` prints the engine version. Every
command has focused `help <command>`, `<command> -h`, and `<command> --help`
aliases with identical purpose, syntax, worked examples, write boundary, and
next-action output; binding and temporary-installation help name Hosts from
their canonical capability sets. Unknown commands produce one deterministic
close-match suggestion when available, otherwise only point to `apkit --help`.
Root and per-command help derive from one `COMMANDS` table in
`cli/command-help.ts`, while worked commands derive from the reusable example
set in `cli/examples.ts`.

`list` is the read-only inventory entrypoint: without a topic it shows available
inventory topics and examples, while `list projects` reads Project Bindings from
normalized Local Configuration and `list profiles` reads Profile selections from
the selected Workspace. `list temporary` reads active Temporary Profile
Installations from Installation State, preserving each durable identity alongside
its Project, Profile, and Host so `remove-temp` can target the correct receipt;
it does not enter ordinary Project lifecycle reconciliation. It is distinct from
`status`, which remains the ordinary Project lifecycle diagnostic.

Gaps: ~~[UJ-16](#uj-16)~~ (shipped in [#115](https://github.com/kenneth-liao/agent-profile-kit/issues/115)).

### 2. Initialize

```
$ apkit init
Initialized Agent Profile Kit Workspace and Local Configuration at <workspace>
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
$ agent-profile-kit bind engineering ~/projects/api --host claude --host codex --host grok --host pi
Recorded Project Binding for <project>
  Profile: engineering
  Hosts: claude, codex, grok, pi
Next: agent-profile-kit preview
```

Correct and well scoped; `unchanged` is distinguished from `Recorded`, the
project defaults to the working directory, and `--host` is explicit with no
default. Lifecycle project blocks now echo the selected Hosts, so that identity
remains visible after `bind`.

Gaps: ~~[UJ-07](#uj-07)~~ (shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) and [#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)), ~~[UJ-16](#uj-16)~~,
~~[UJ-20](#uj-20)~~ (shipped in [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116)).

### 6. Verify

```
$ apkit validate
Workspace and Local Configuration valid (1 Profile, 0 Project Bindings)
Profiles found: engineering
Hosts bound: none
```

Gaps: ~~[UJ-17](#uj-17)~~ (shipped in
[#119](https://github.com/kenneth-liao/agent-profile-kit/issues/119)).

### 7. Preview

Leading with the outcome (`Ready to apply` / `Cannot apply`) and closing with one
next action is the right shape. It does not survive scale. Three projects across
four Hosts:

```
Ready to apply
Profile Installations: 3 · Changes: 19 generated-output additions · Blockers: 0

Profile Installation: <api>
  Profile: engineering
  State: addition
  Changes: 13 generated-output additions
…
Repository exclusions:
Git-local exclusions that keep Installer-owned generated paths untracked.
- <api>/.git/info/exclude: add /.agent-profile-kit/codex/context.md, /.agent-profile-kit/installation.json, /.agents/skills/code-review, /.agents/skills/deploy, /.claude/rules/agent-profile-kit.md, /.claude/skills/code-review, /.claude/skills/deploy, /.codex/hooks.json, /.grok/skills/code-review, /.grok/skills/deploy, /.pi/APPEND_SYSTEM.md, /.pi/skills/code-review, /.pi/skills/deploy
```

At capture time, three things broke here. The 13 files were never listed as
files — the exclusion line was the only place any path appeared, as one
~500-character comma-separated run. Project blocks now echo the four Hosts that
produced the files, and changed paths now appear directly beneath each project,
including non-Git projects.

Gaps: ~~[UJ-07](#uj-07)~~ (shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) and [#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)), ~~[UJ-11](#uj-11)~~ (shipped in
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

```
Apply complete
Profile Installations: 3 · Changes: none · Blockers: 0

Profile Installation: <api>
  Profile: engineering
  State: current
…
Apply receipt:
- <api>: 13 generated-output additions
- <scratch>: 2 generated-output additions
- <web>: 4 generated-output additions
```

Separating verified resulting state from the Apply Receipt is architecturally
correct (`CONTEXT.md`, *Apply Receipt*), but `Changes: none` sits nine lines
above a receipt totalling 19 additions. Conditional Host guidance now carries
this journey into Codex, Claude Code, Grok, and Pi.

Gaps: ~~[UJ-04](#uj-04)~~ (shipped in
[#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122)), ~~[UJ-07](#uj-07)~~ (shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) and [#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)), ~~[UJ-20](#uj-20)~~,
~~[UJ-21](#uj-21)~~.

### 9. Use

Setup guidance is reported conditionally by Host *and* by what was installed:

| Host | Requirement after `apply` |
|------|---------------------------|
| Claude Code | None. Rule + Skills load on next launch; no Git dependency. |
| Codex | Codex CLI 0.145.0+ for complete Context delivery, plus project trust **and** native review/trust of the generated `SessionStart` hook — only when Context is installed. Non-Git projects must be launched from the exact bound root. |
| Grok | None, except when co-bound with Claude and rules compatibility is on: Grok reads Claude's rule file and **no `.grok/rules/` is created**. |
| Pi | Native project trust; `--skill` / `--no-skills` runtime overrides fall outside the guarantee. |

**Codex Context floor (0.145.0+).** Context-bearing Codex installs probe
`codex --version` on `preview`/`apply` and refuse writes below the floor (or when
`codex` is missing from `PATH`). Skills-only Codex bindings do not probe. `apply`
is still all-project: one blocked Codex binding blocks every other binding in the
fleet. Recovery when other Hosts must proceed first: drop `codex` from the
Project Binding, re-apply, upgrade Codex to `0.145.0+`, restore the binding, and
apply again. `status`, `validate`, and `uninstall` do not re-probe the CLI, so a
post-apply Codex downgrade is not reported there — upgrade back or re-apply after
restoring a supported CLI if Context stops loading.

Verified: a four-Host `api` project produced `.codex/hooks.json`, and its
`.grok/` directory contained `skills/` **only** — no `rules/`. A Skills-only
Codex project produced no hook at all, so Codex approval guidance must be
conditional on installed Context, not on the Host alone.

Gaps: ~~[UJ-21](#uj-21)~~ (shipped across
[#118](https://github.com/kenneth-liao/agent-profile-kit/issues/118) and
[#125](https://github.com/kenneth-liao/agent-profile-kit/issues/125)).

### 10. Re-sync after a Workspace edit

The tool's best-working loop: `stale source` is detected accurately, the gloss is
useful the first time, and the next action is correct. The fully-current case
says one thing three ways:

```
All Profile Installations are current
Profile Installations: 3 · Changes: none · Blockers: 0
No Profile Installations need attention.
```

Gaps: ~~[UJ-14](#uj-14)~~, ~~[UJ-15](#uj-15)~~ (shipped in
[#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122)).

### 11. Recover

**Repairable missing output** — a deleted generated file with proven ownership —
works well: `status` names the missing paths and `apply` restores them.

**Drifted output** — a hand-edited generated file — is a dead end. `apply`
refuses, `uninstall` refuses, `status` repeats, and the remedy is stated nowhere:

```
  State: drifted output (owned output drifted: .claude/rules/agent-profile-kit.md)
  Blocker: .claude/rules/agent-profile-kit.md is occupied by unowned or drifted output
  Blocker: Cannot reconcile Profile Installation at <project>: owned output drifted: .claude/rules/agent-profile-kit.md
…
Next: Resolve the reported blockers, then run agent-profile-kit preview again.
agent-profile-kit: Apply blocked before writes:
- <project>/.claude/rules/agent-profile-kit.md is occupied by unowned or drifted output
- Cannot reconcile Profile Installation at <project>: owned output drifted: …
```

Deleting the drifted file and running `apply` restores it as a proven repair.
Neither the CLI nor `docs/guides/workspace.md` says so — the guide's recovery
section covers missing/malformed *Installation State*, not drifted output.

**Host CLI missing or outdated** is the likeliest first-run failure, and its
messages are the best-written strings in the tool:

```
Blocker: Claude Code CLI was not found on PATH; install Claude Code and ensure
`claude --version` works before previewing or applying the Profile

Blocker: Claude CLI 1.0.0 does not support unscoped project rules (requires
2.0.64+); upgrade Claude Code before previewing or applying the Profile
```

Problem, requirement, remedy — the target shape for every blocker. The frame
buries them: the same screen still leads with `Changes: 2 generated-output
additions`, lists exclusions that will never be written, and glosses a state that
cannot be reached, leaving the one actionable line in eighth position
(~~[UJ-19](#uj-19)~~, shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117)).

**Mixed states across projects** now retain per-project guidance. With pending
work for `api` and `web` blocked, the run preserves `api`'s next step after the
all-project blocker is resolved and gives `web` its blocker remedy.

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

---

## Gap register

Severity is a maintainer judgement about journey impact, not a schedule.

| ID | Severity | Stage | Gap |
|----|----------|-------|-----|
| ~~[UJ-01](#uj-01)~~ | ~~High~~ | ~~2, 3, 4~~ | ~~`init` next-step dead-ends on an empty Workspace~~ — shipped in [#121](https://github.com/kenneth-liao/agent-profile-kit/issues/121) |
| ~~[UJ-02](#uj-02)~~ | ~~High~~ | ~~11~~ | ~~Drifted output has no stated remedy anywhere~~ — shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117) |
| ~~[UJ-03](#uj-03)~~ | ~~High~~ | ~~12~~ | ~~Post-`uninstall` `status` warns about an intended state~~ — shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124) |
| ~~[UJ-04](#uj-04)~~ | ~~High~~ | ~~8~~ | ~~"Changes" means two things on one `apply` screen~~ — shipped in [#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122) |
| ~~[UJ-19](#uj-19)~~ | ~~High~~ | ~~11~~ | ~~Blocked results lead with a plan that cannot happen~~ — shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117) |
| ~~[UJ-21](#uj-21)~~ | ~~High~~ | ~~8, 9~~ | ~~No post-apply Host guidance; Codex can break silently~~ — shipped across [#118](https://github.com/kenneth-liao/agent-profile-kit/issues/118) and [#125](https://github.com/kenneth-liao/agent-profile-kit/issues/125) |
| ~~[UJ-05](#uj-05)~~ | ~~Med-High~~ | ~~11~~ | ~~Blocked `apply` reports the same blockers three times~~ — shipped in [#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117) |
| ~~[UJ-20](#uj-20)~~ | ~~Med-High~~ | ~~5, 7, 8~~ | ~~Hosts are invisible after `bind`~~ — shipped in [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116) |
| ~~[UJ-22](#uj-22)~~ | ~~Med-High~~ | ~~7~~ | ~~Non-Git project output is never shown at all~~ — shipped in [#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120) |
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

Shipped in [#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124):
`uninstall` now records intended teardown, and `status` renders it without the
unsafe missing-output framing.

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

Shipped across [#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116)
and [#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152): `bind`,
lifecycle project blocks, blockers, warnings, Git exclusions, and verbose
diagnostics use one shortest-unambiguous path presenter, while Local
Configuration, Installation State, JSON, and unrelated authoring output retain
their canonical or authored paths.

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

Shipped in [#123](https://github.com/kenneth-liao/agent-profile-kit/issues/123):
member-level attention records now replace the enclosing directory's
`unchanged` record in verbose output.

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
list. The instance was removed with the cross-Host collision machinery in #110
(see closed issue #111), so no current behavior produces it. Any blocker that can
fire once per selected artifact could reintroduce it.

---

## Accepted presentation principles

Accepted in ADR-0014. Individual fixes are argued from these rather than from
scratch.

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
7. **Show the object, not a count of it** — file paths with `+`/`~`/`-` markers,
   capped with overflow to `--verbose` ([UJ-11](#uj-11), [UJ-22](#uj-22)).
8. **Show identity at the shortest unambiguous length**, including the Hosts the
   user chose ([UJ-07](#uj-07), [UJ-20](#uj-20)).
9. **Teach once, at the point of need** — not on every run ([UJ-15](#uj-15)),
   and carry the journey into the Host ([UJ-21](#uj-21)).
10. **Exit codes agree across commands** for the same state ([UJ-13](#uj-13)).
