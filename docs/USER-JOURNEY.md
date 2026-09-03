# Agent Profile Kit user journey

The living map of what a person does with the CLI and what each stage owes
them. See ADR-0013 for why this map exists here, ADR-0014 for the original
presentation decisions accepted against it, and ADR-0020 for the current quiet,
task-first default-view boundary.

**Scope.** This document owns user-facing CLI surface behavior: the stages and
the outcome each stage owes. It does not own authoring formats
(`docs/guides/workspace.md`), system structure (`docs/ARCHITECTURE.md`),
vocabulary (`CONTEXT.md`), or settled decisions (`docs/adr/`).

**Maintenance.** Every registered gap has shipped; the closed gap register was
removed from this document, and git history is its provenance. New gaps
graduate directly to tracker issues. Output excerpts elide project paths as
`<project>` so they do not drift.

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
the shipped width fixes
([#156](https://github.com/kenneth-liao/agent-profile-kit/issues/156),
[#159](https://github.com/kenneth-liao/agent-profile-kit/issues/159),
[#166](https://github.com/kenneth-liao/agent-profile-kit/issues/166), and
[#173](https://github.com/kenneth-liao/agent-profile-kit/issues/173)),
blocker grouping
([#167](https://github.com/kenneth-liao/agent-profile-kit/issues/167),
[#168](https://github.com/kenneth-liao/agent-profile-kit/issues/168),
[#169](https://github.com/kenneth-liao/agent-profile-kit/issues/169), and
[#172](https://github.com/kenneth-liao/agent-profile-kit/issues/172)), progress
indication ([#170](https://github.com/kenneth-liao/agent-profile-kit/issues/170)),
read-only inventory and orientation
([#157](https://github.com/kenneth-liao/agent-profile-kit/issues/157),
[#160](https://github.com/kenneth-liao/agent-profile-kit/issues/160),
[#161](https://github.com/kenneth-liao/agent-profile-kit/issues/161),
[#162](https://github.com/kenneth-liao/agent-profile-kit/issues/162), and
[#163](https://github.com/kenneth-liao/agent-profile-kit/issues/163)), visual
hierarchy ([#164](https://github.com/kenneth-liao/agent-profile-kit/issues/164)),
command wording and Project identity
([#165](https://github.com/kenneth-liao/agent-profile-kit/issues/165) and
[#171](https://github.com/kenneth-liao/agent-profile-kit/issues/171)), and the
compact guide index ([#159](https://github.com/kenneth-liao/agent-profile-kit/issues/159)).

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
during `apply`, where a missing or outdated Host CLI produces one advisory
warning per Host per invocation — naming the Host and the strictest version it
requires, regardless of Project count or distinct requirement messages — and never blocks
planning or writing. The
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

### 3. Learn the format

`guide` prints a concise topic index with examples. `guide --full` and
`guide --agent` retain the complete human- and agent-facing guides.
`guide profile`, `guide context`, and `guide skill` each return focused,
terminal-width-aware guidance with a complete copyable example; fenced examples
and copyable values remain intact.

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
one advisory warning for that requirement per invocation, naming Codex and the
required floor, and the material is written regardless (ADR-0025). Skills-only Codex plans do not
probe. `status`, `validate`, and `uninstall` do not probe, so a post-apply
Codex downgrade is not reported there — Context stops loading until a supported
CLI is restored, and the next `apply` warns again.

Verified: a four-Host `api` project produced `.codex/hooks.json`, and its
`.grok/` directory contained `skills/` **only** — no `rules/`. A Skills-only
Codex project produced no hook at all, so Codex approval guidance must be
conditional on installed Context, not on the Host alone.

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
`apply`, a missing or outdated Host CLI produces one advisory warning per Host
per invocation, naming the Host and the strictest version it requires,
regardless of how many Projects select it and how many distinct requirement messages it
produced, and the
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

---

## Accepted presentation principles

Accepted in ADR-0014 and refined by ADR-0020. Individual fixes are argued from
these rather than from scratch.

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
