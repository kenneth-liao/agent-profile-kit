---
thing: Agent Profile Kit
phase: active
progress: 0/101
principal_stated_goal: "I just want apkit to be user-friendly to the unfamiliar beginner, be a joy to use, and polished. Only give the user what they need to know at each step but the power to dig deeper if they want to."
started: 2026-09-10
updated: 2026-10-30
---

# Ideal State — Agent Profile Kit

## Problem

Users must navigate internal concepts and excessive output to accomplish a
simple task: use their Profiles across Projects and keep installations updated.
Passing command tests alone has not established a clear, polished experience.
Qualification can also consume repeated work without establishing which tests
actually ran or whether the published package is the package they exercised.
New users cannot tell where setup puts the Workspace, what a valid Workspace
must contain, or how to use the Context and Skills they already have.
Disposable worker worktrees get no Profile, so orchestrators copy apkit output
into them by hand.
The current engine is large: per-Host Adapters, interactive prompts, and
supervised processes. Each new agent or platform makes it larger.

## Vision

An unfamiliar user can get started confidently. Regular users can make changes
efficiently, even across many Projects. The interface feels calm and carefully
finished, with useful guidance at the point of need.
Maintainers can qualify changes efficiently using trustworthy evidence, and
users receive the exact package that passed release qualification.
A new user turns what they already have, or nothing, into a Workspace they
chose and own, knowing exactly what it must contain.
An orchestrator gives each worker a disposable worktree that already has its
Profile, then removes it without a trace.
apkit is a small engine with no dependencies. It behaves the same on macOS,
Linux, and Windows, and an agent learns it from the tool itself.

## Out of Scope

- AI generation of substantive Context or Skill content.
- A built-in text editor; content editing belongs in the user's editor.
- Automatic verification of Profile loading inside an Agent Host.
- apkit finding, importing, copying, or converting scattered Context and Skill
  files into a Workspace; the user or their agent moves material.
- Recovering Project Bindings after Local Configuration is lost.
- apkit writing Host trust or approval state.
- Automatic worktree discovery, Git hooks, or watchers.
- Prompts inside the engine; the user decides through their agent or with
  flags.
- Agent-specific Context formats; Context reaches every agent through the
  shared `AGENTS.md` delivery.

## Principles

- apkit informs; the user decides. apkit states every change it will make
  and every consequence it can see, then acts on the user's decision. It does
  not choose for the user how their own setup works.

## Goal

Make apkit intuitive for beginners and efficient for regular users: easy to create Profiles, install them into Projects with chosen Hosts, and update or remove installations. Keep the interface polished, actions predictable, and edits protected. Show what matters now, with deeper detail easy to find.
Qualify changes without unnecessary repeated work or weaker fault detection,
and tie each released package to complete evidence for its supported environment.
Let a user start from nothing or from existing material and reach a valid,
connected Workspace in a location they chose, against a published contract that
validation enforces.
Let an orchestrator give a disposable Project one Profile for every Host it
needs with one owned operation, and remove all of it with one owned operation.
Do all of this with a small engine with no dependencies, which behaves the same
on macOS, Linux, and Windows and which an agent learns from the tool itself.

## Claims

- [ ] **ISC-1:** An unfamiliar user, working through their agent, can create a
  Profile without coaching.
  Probe: observe a newcomer and their agent create a Profile using only public
  guidance; needing coaching to complete the task fails the claim. manual
- [ ] **ISC-2:** An unfamiliar user, working through their agent, can install a
  Profile into a Project with their chosen Hosts without coaching.
  Probe: observe that step in the newcomer journey and verify the resulting
  Project/Host selection; coaching or a different selection fails. manual
- [ ] **ISC-3:** An unfamiliar user, working through their agent, can update
  installations after changing their Profile without coaching.
  Probe: observe the change-and-update step using public guidance; failure to
  propagate the intended change without coaching fails. manual
- [ ] **ISC-4:** An unfamiliar user, working through their agent, can remove
  selected installations without coaching.
  Probe: observe selective removal in the newcomer journey; coaching or removal
  of an unselected installation fails. manual
- [ ] **ISC-5:** Repeated lifecycle operations are available through explicit,
  scriptable commands.
  Probe: run the packed CLI's create/install/update/uninstall journey with
  explicit inputs and no TTY; required interactive input fails. bash
- [ ] **ISC-6:** Users, working through their agent, can identify an action's
  affected scope before confirming it.
  Probe: ask the walkthrough participant to identify affected Projects and
  Hosts from what their agent shows before confirmation; compare with actual
  writes. manual
- [ ] **ISC-7.1:** Routine output is concise.
  Probe: principal reviews actual routine-success terminal screens at single-
  Project and fleet scale; unnecessary inventories or repeated facts fail. manual
- [ ] **ISC-7.2:** Complete operation details are discoverable when requested.
  Probe: a walkthrough participant retrieves a completed operation's full
  details using public guidance without repeating its writes. manual
- **ISC-8.1:** [DROPPED — see Decisions 2026-10-30]
- **ISC-8.2:** [DROPPED — see Decisions 2026-10-30]
- [ ] **ISC-9:** **Anti:** Independently changed generated files are not
  discarded without explicit consent.
  Probe: interactive and non-interactive install/update/uninstall tests with
  changed files, declined consent, and explicit consent; any unauthorized loss
  fails. bash
- [ ] **ISC-10:** **Anti:** Installation success never implies unverified Host
  loading.
  Probe: check success and handoff output throughout the install/update journey;
  any claim that a Host loaded a Profile without supporting observation fails.
  manual
- [ ] **ISC-11:** **Anti:** Required qualification cannot report success when
  required tests are omitted, fail, or remain incomplete.
  Probe: exercise required qualification with a deliberately omitted test,
  failing test, and interrupted run; any successful qualification fails. bash
- [ ] **ISC-12:** Qualification evidence identifies what was tested well enough
  for another maintainer to reproduce the run.
  Probe: reconstruct a completed qualification from its retained evidence;
  missing source identity, artifact identity when applicable, runtime,
  selection, command, or result fails. manual
- [ ] **ISC-13:** Every published package is byte-identical to the package
  that passed its required release qualification.
  Probe: compare the published package digest with its qualified artifact
  digest; a mismatch or missing qualification evidence fails. bash
- [ ] **ISC-14:** Routine qualification completes within its declared finite
  execution budget on the documented qualification environment.
  Probe: run canonical qualification on that environment; a deadline expiry
  or an unbounded stage fails. bash
- [ ] **ISC-15:** **Anti:** Test optimization does not weaken detection of
  the concrete regressions protected by the changed tests.
  Probe: replay the named representative faults for a test consolidation or
  relocation against retained coverage; an undetected fault fails. bash
- [ ] **ISC-16:** Qualification outcomes do not depend on undeclared ambient
  machine state.
  Probe: vary unselected Host executables and unrelated environment settings
  around isolated fixtures; changed outcomes or unexpected real Host execution
  fails. bash
- [ ] **ISC-17:** Declared runtime and platform support has matching
  qualification evidence.
  Probe: compare the declared support set with retained compatibility results;
  an unsupported claim or unqualified declared member fails. manual
- [ ] **ISC-18:** Routine verification reuses still-valid evidence rather than
  repeating checks without a change or an unresolved hypothesis.
  Probe: inspect implementation and review verification records for a completed
  change; a repeated check without an identified invalidation or hypothesis
  fails. manual
- [ ] **ISC-19:** An unfamiliar user starting with no Context or Skills,
  working through their agent, reaches a valid, connected Workspace without
  coaching.
  Probe: observe a newcomer and their agent from a fresh install using only
  public guidance and CLI output; coaching, or a Workspace that is invalid or
  not connected, fails. manual
- [ ] **ISC-20:** An unfamiliar user with scattered Context and Skill files,
  working through their agent, reaches a valid, connected Workspace that
  contains that material without coaching.
  Probe: observe a newcomer and their agent given prepared scattered material
  and only public guidance; coaching, missing material, or a Workspace that is
  invalid or not connected, fails. manual
- [ ] **ISC-21:** An agent in a fresh session, given only the README link and
  scattered material, reaches a valid, connected Workspace that contains that
  material.
  Probe: run a fresh agent session with only the README link and the material;
  human help, missing material, or a Workspace that is invalid or not connected,
  fails. manual
- [ ] **ISC-22:** On a machine that is not set up, `apkit` names the command
  that connects an existing valid Workspace.
  Probe: in a fresh home, run bare `apkit`, then run the named command without a
  TTY on a valid fixture Workspace; no such command, or a Workspace that is not
  connected afterwards, fails. bash
- [ ] **ISC-23:** **Anti:** apkit never selects a Workspace location that the
  user did not give or confirm.
  Probe: in fresh homes, run every command that creates or selects a Workspace:
  `init` (with and without a path), selecting again, and upgrading legacy Local
  Configuration that has no `workspace` value; any Workspace created or
  selected at a location not given or confirmed fails. bash
- **ISC-24.1:** [DROPPED — see Decisions 2026-10-30]
- **ISC-24.2:** [DROPPED — see Decisions 2026-10-30]
- **ISC-24.3:** [DROPPED — see Decisions 2026-10-30]
- [ ] **ISC-25.1:** `init` without a Workspace path writes nothing.
  Probe: packed CLI `init` without a path in a fresh home; any write fails.
  bash
- [ ] **ISC-25.2:** `init` without a Workspace path prints an executable
  command that supplies a path.
  Probe: run the printed command with a valid fixture path supplied; a missing
  or failing command fails. bash
- [ ] **ISC-26:** A relative Workspace path, including `.`, selects the folder
  the user named.
  Probe: packed CLI `init` with `.` and with a relative path, then `check` from
  a different directory; a Workspace other than the named folder fails. bash
- [ ] **ISC-27.1:** `init` adds every missing part of the Workspace structure
  that the contract requires.
  Probe: `init` an empty folder and a folder with unrelated files; any required
  part still missing fails. bash
- [ ] **ISC-27.2:** `init` adds nothing to the chosen folder that the contract
  does not require.
  Probe: compare file trees before and after `init`; any added entry that the
  contract does not require fails. bash
- **ISC-27.3:** [DROPPED — see Decisions 2026-10-30]
- [ ] **ISC-28:** **Anti:** `init` never changes, moves, or deletes an existing
  file in the chosen folder.
  Probe: compare existing entries before and after `init` of valid, incomplete,
  and invalid folders that contain unrelated files; any changed, moved, or
  deleted entry fails. bash
- **ISC-29:** [DROPPED — see Decisions 2026-10-30]
- [ ] **ISC-30:** A user can connect a different Workspace after setup without
  hand-editing Local Configuration.
  Probe: packed CLI connects a second valid Workspace after setup; needing a
  hand edit, or the first Workspace staying selected, fails. bash
- [ ] **ISC-31:** Connecting a Workspace again, the same one or a different one,
  keeps existing Project Bindings.
  Probe: connect the same Workspace, then a different one, on a machine with
  Project Bindings; any lost or changed binding fails. bash
- [ ] **ISC-32:** After connecting a Workspace, every Project Binding whose
  Profile that Workspace lacks is reported.
  Probe: connect a Workspace that lacks a bound Profile; an unreported binding
  fails. bash
- [ ] **ISC-33:** **Anti:** Connecting a Workspace, first or again, never changes
  its files.
  Probe: compare valid Workspaces' file trees before and after first
  connection, connecting the same Workspace again, and connecting a different
  Workspace, with and without a TTY; any change fails. bash
- [ ] **ISC-34:** The Workspace contract is readable from the README before
  installing apkit.
  Probe: from the public README, reach the complete contract without installing
  apkit; failure to reach it fails. manual
- [ ] **ISC-35:** Every rule that Workspace validation enforces is stated in the
  contract.
  Probe: map each validation failure kind to a contract statement; an enforced
  rule the contract does not state fails. manual
- [ ] **ISC-36.1:** The contract includes a valid Workspace example.
  Probe: read the contract; no valid Workspace example fails. manual
- [ ] **ISC-36.2:** The contract includes invalid Workspace examples.
  Probe: read the contract; no invalid Workspace example fails. manual
- [ ] **ISC-36.3:** Each contract example validates as the contract says.
  Probe: validate each contract example; an outcome different from the
  contract's statement fails. bash
- [ ] **ISC-37.1:** The contract states where this machine records the selected
  Workspace location.
  Probe: read the contract; a missing or wrong location fails. manual
- [ ] **ISC-37.2:** The contract states where this machine records Project
  Bindings.
  Probe: read the contract; a missing or wrong location fails. manual
- [ ] **ISC-38:** A standard Agent Skill is valid Workspace material without
  edits.
  Probe: copy real standard Skill packages unchanged into a Workspace and
  validate; any required edit fails. bash
- [ ] **ISC-39:** An existing Markdown instruction file is a valid Context
  Module unchanged.
  Probe: copy real instruction files, such as `CLAUDE.md` and `AGENTS.md`, into
  `context/` as they are and validate; any required rename or edit fails. bash
- [ ] **ISC-40.1:** A folder that is not connected can be validated.
  Probe: packed CLI validates a folder that is not connected in a fresh home; no
  validation report fails. bash
- [ ] **ISC-40.2:** Validating a folder that is not connected creates no Local
  Configuration.
  Probe: compare the fresh home before and after that validation; any created
  Local Configuration fails. bash
- [ ] **ISC-41:** One validation run reports every contract violation in a
  Workspace.
  Probe: validate a Workspace seeded with several violations across categories;
  any violation missing from one run fails. bash
- [ ] **ISC-42.1:** Each reported contract violation names its path.
  Probe: trigger each violation kind; a report without the path fails. bash
- [ ] **ISC-42.2:** Each reported contract violation names the change that fixes
  it.
  Probe: trigger each violation kind; a report without the fix fails. bash
- [ ] **ISC-43:** Failed Workspace validation points to the contract.
  Probe: trigger each violation kind; output without a contract reference fails.
  bash
- [ ] **ISC-44:** **Anti:** A file that apkit skips is never silently ignored.
  Probe: put stray files in `context/`, `skills/`, and `profiles/`, then run
  `check` and `install`; a skipped file without a warning in either output
  fails. bash
- [ ] **ISC-45:** An agent can repair an invalid Workspace using only validation
  output.
  Probe: run a fresh agent session on an invalid Workspace without the guides;
  human help, or a Workspace that is still invalid, fails. manual
- [ ] **ISC-46:** **Anti:** A Workspace that was valid in any earlier release
  never fails validation without the output naming every change needed.
  Probe: validate retained fixtures kept from each release that changed the
  contract, including a realistic-scale fixture with neutral content modeled on
  the principal's Workspace; a failure without a complete change list fails.
  bash
- [ ] **ISC-47.1:** **Anti:** Detecting which Hosts are installed never starts a
  Host program.
  Probe: run every command that detects installed Hosts with fake Host
  executables that write a marker when started; any marker fails. bash
- [ ] **ISC-47.2:** **Anti:** Detecting which Hosts are installed never writes a
  file.
  Probe: compare the isolated home and working directory before and after every
  command that detects installed Hosts; any new or changed file fails. bash
- [ ] **ISC-48:** When apkit connects a Workspace that has errors, it shows the
  complete validation report.
  Probe: connect folders with several violations; output missing any violation
  that `check` reports fails. bash
- [ ] **ISC-49:** The CLI shows the Workspace contract on request.
  Probe: find the contract command from `apkit --help` and run it; output that
  differs from the canonical contract fails. bash
- [ ] **ISC-50:** One command gives a Project a Profile Installation of one
  Profile for several Hosts.
  Probe: packed CLI `install` with two or more Hosts into a linked worktree; a
  selected Host without its outputs, or needing more than one command, fails.
  bash
- [ ] **ISC-51:** One command removes a Profile Installation for all of its
  Hosts.
  Probe: one `remove` after the ISC-50 install; any remaining Host output fails.
  bash
- [ ] **ISC-52:** Every supported Host can receive a Profile Installation.
  Probe: packed CLI `install` for each Host in the Host catalog; any rejected
  supported Host fails. bash
- [ ] **ISC-53:** **Anti:** Removing a Profile Installation never leaves
  anything that its install added, including empty folders.
  Probe: compare the Project tree, including empty folders, before install and
  after removal, for each Host and for a several-Host combination; any
  difference fails. bash
- [ ] **ISC-54:** **Anti:** A Profile Installation in a linked worktree never
  changes the main checkout's Profile Installation.
  Probe: install and remove a Profile Installation in a linked worktree of a
  main checkout that has its own installation; any changed main-checkout output
  or owned exclusion entry fails. bash
- [ ] **ISC-55:** **Anti:** A Profile Installation adds no untracked entry to
  the Project's `git status`, except an instruction file that it creates.
  Probe: compare `git status --porcelain` before and after install for each
  Host, into a repository root and into a subfolder of a repository; any new
  untracked entry other than a created `AGENTS.md` fails. Changes to files the
  user already tracks are allowed. bash
- [ ] **ISC-56:** **Anti:** No output of a Profile Installation lands outside
  its Project without the user's decision.
  Probe: install with a Host folder that is a symlink to a folder outside the
  Project, without and then with the decision granted; a write outside the
  Project before the decision, or a decision output that does not name the
  link and where it leads, fails. bash
- [ ] **ISC-57:** **Anti:** A Profile Installation stays removable after its
  Project is deleted.
  Probe: install for several Hosts, `git worktree remove --force`, then
  `remove`; a failed removal, or the installation still listed by
  `status --all`, fails. bash
- [ ] **ISC-58:** Profile Installations started at the same time in different
  Projects all succeed.
  Probe: start four several-Host `install` runs into separate worktrees at
  once; any failed run or missing installation record fails. bash
- [ ] **ISC-59:** Every lifecycle command behaves the same on macOS, Linux, and
  Windows.
  Probe: run the packed CLI journey in CI on all three; any failure, or a
  different outcome on one platform, fails. bash
- [ ] **ISC-60:** The published package has no runtime dependencies.
  Probe: the packed `package.json` has no `dependencies`, and the bundle
  imports only `node:` built-ins; anything else fails. bash
- [ ] **ISC-61:** The engine starts no child processes.
  Probe: run the full journey with marker-writing fake executables first on
  `PATH`; any marker fails. bash
- [ ] **ISC-62:** The engine has no code path that depends on the operating
  system.
  Probe: `rg` the engine source for `process.platform` and other OS checks; any
  branch on the operating system fails. bash
- [ ] **ISC-63:** An agent learns the whole tool from `guide` alone.
  Probe: run a fresh agent session with only the installed command, no repo or
  docs, through setup, install, update, and remove; needing other docs or human
  help fails. manual
- [ ] **ISC-64:** `guide` names every command, flag, and Host id that the CLI
  accepts.
  Probe: compare the CLI parser with the guide text; anything the CLI accepts
  that the guide does not name fails. bash
- [ ] **ISC-65:** **Anti:** A run that stops for a user decision changes no
  file.
  Probe: snapshot the Project and the home folder, trigger each decision case,
  and compare; any change fails. bash
- [ ] **ISC-66:** **Anti:** Moving from the current engine never discards a
  user's edit to an installed file without explicit consent.
  Probe: install with apkit 0.239, edit the generated files, then take over or
  remove with the new engine; any unauthorized loss fails. bash
- [ ] **ISC-67:** A Project installed by the current engine can be taken over
  or removed without the current engine.
  Probe: on that fixture, use only the new engine; needing the current engine,
  or leftover output, fails. bash
- [ ] **ISC-68:** Every location that apkit writes for a Host, at project or
  user level, has a dated live check that the Host loads it.
  Probe: compare the written locations with the live-check record; a location
  without a check fails. manual
- [ ] **ISC-69:** Each live check is newer than the Host's last change to how it
  loads files.
  Probe: compare live-check dates with each Host's release notes; a newer
  loading change fails. manual (after: ISC-68)
- [ ] **ISC-70:** `setup` gives each installed Host's user-level instructions a
  note that points to `guide`.
  Probe: in an isolated home with Host folders, run `setup --yes`; a target
  without the note fails. bash
- [ ] **ISC-71:** **Anti:** `setup` or a global install never hides an existing
  user-level file from a Host.
  Probe: OpenCode with `~/.claude/CLAUDE.md` present; a new file earlier in its
  lookup order fails. bash
- [ ] **ISC-72:** **Anti:** Removing the `setup` note or a global install
  restores each user-level file byte for byte.
  Probe: byte-compare each user-level file before install and after removal;
  any difference fails. bash
- [ ] **ISC-73:** One command installs a Profile's Skills and Context at user
  level for each selected Host.
  Probe: `install --global` with a Profile that has both; any missing Skill or
  Context for a selected Host fails. bash
- [ ] **ISC-74:** `status` reports a Context Module that is installed both
  globally and in the Project.
  Probe: install the Module both ways, then run `status` in the Project; no
  report fails. bash
- [ ] **ISC-75:** **Anti:** apkit never changes text outside its marked section
  in a user's instruction file.
  Probe: edit text around the section, then install, update, and remove; any
  change outside the section fails. bash

- [ ] **ISC-76:** A Context file with any `.md` name is valid, and its ID is
  its path under `context/` without `.md`.
  Probe: validate and install Context files with mixed-case names and names
  with spaces; a rejected file or a different ID fails. bash
- [ ] **ISC-77:** Two Context IDs that differ only in case are an error on
  every platform.
  Probe: validate `Style.md` beside `style.md` on Linux; no error fails. bash
- [ ] **ISC-78:** A Profile without a `context` or `skills` list treats that
  list as empty.
  Probe: validate and install a Skills-only Profile with no `context` list; an
  error fails. bash
- [ ] **ISC-79:** A Profile with a `.yml` extension is valid.
  Probe: validate and install a `.yml` Profile; an error fails. bash
- [ ] **ISC-80:** A Profile with `skills: all` installs every Skill in the
  Workspace, including Skills added after the Profile was written.
  Probe: install, add a Skill, run `update` without editing the Profile; a
  missing Skill fails. bash
- [ ] **ISC-81:** **Anti:** A warning never blocks an install.
  Probe: install with each warning case present; a non-zero exit or missing
  output fails. bash
- [ ] **ISC-82:** Validation reports an error only when an install would be
  wrong or ambiguous.
  Probe: map each error kind to the wrong or ambiguous install it prevents; an
  error kind without one fails. manual
- [ ] **ISC-83:** A folder is a Workspace when it has an `apkit-workspace.yaml`
  file, which may be empty. Its `schema_version` matters only when it is not a
  version this apkit supports.
  Probe: `init`, empty the file, and validate; then set an unsupported
  version; an error for the empty file, or no error naming the needed apkit
  version, fails. bash
- [ ] **ISC-84:** A folder with only the old `workspace.yaml` fails validation,
  and the output names the rename to `apkit-workspace.yaml`.
  Probe: validate that fixture; a pass, or output without the rename, fails.
  bash
- [ ] **ISC-85:** The Workspace contract states no rule for a retired feature.
  Probe: `rg` the contract for retired features, such as the sidecar and the
  retired model-invocation key; any match fails. bash

- [ ] **ISC-86:** Before apkit creates or changes an instruction file, its
  output names the file, says whether it will be created or changed, and says
  whether Git tracks it.
  Probe: run install with `AGENTS.md` and `CLAUDE.md` absent, untracked, and
  tracked; a decision output that misses any of the three facts fails. bash
- [ ] **ISC-87:** **Anti:** apkit never hides an instruction file from Git.
  Probe: install where apkit creates `AGENTS.md`, then read
  `.git/info/exclude`; any entry for `AGENTS.md` or `CLAUDE.md` fails. bash
- [ ] **ISC-88:** The guide tells agents to get the user's agreement before an
  instruction-file change, and to leave committing to the user.
  Probe: run a fresh agent session on a project that tracks `AGENTS.md`; an
  agent that allows the change without asking, or commits on its own judgment,
  fails. manual

- [ ] **ISC-89:** One `apkit migrate` command moves every Project recorded by
  the current engine to the new engine, with the same Workspace, Profile, and
  Hosts.
  Probe: on a fixture machine with several Projects installed by apkit 0.239,
  run `migrate` with each decision granted; a Project with a different
  Profile, Host set, or Workspace afterwards fails. bash (after: ISC-67)
- [ ] **ISC-90:** **Anti:** After `migrate`, nothing the current engine wrote
  remains, except files the user changed, and no Context is delivered twice.
  Probe: compare each migrated Project with a fresh new-engine install of the
  same Profile, including empty folders, old exclusion blocks, the Codex hook,
  and the OpenCode configuration; any leftover unchanged output fails. bash
- [ ] **ISC-91:** A changed file that the current engine wrote is kept and
  listed as a decision that names the part apkit added.
  Probe: edit `.codex/hooks.json` and `.opencode/opencode.jsonc` before
  `migrate`; a deleted file, or a decision without apkit's part, fails. bash
- [ ] **ISC-92:** After `migrate`, the current engine's state folder is kept,
  renamed as a backup.
  Probe: compare `~/.agents/agent-profile-kit` before migration with
  `~/.agents/agent-profile-kit.migrated` after; a missing or changed file
  fails. bash
- [ ] **ISC-93:** While the current engine's state exists and is not migrated,
  every command names `apkit migrate`.
  Probe: run each command on that fixture machine; output without
  `apkit migrate` fails. bash

- [ ] **ISC-94:** **Anti:** No install or update runs from a Workspace that
  has errors.
  Probe: connect a Workspace with each error kind, then run `install` and
  `update`; any write fails. bash

- [ ] **ISC-95:** After an install, apkit names each selected Host that needs
  the user to trust the Project, and what does not load until then.
  Probe: install for every Host; a Host whose live check (ISC-68) needs trust
  without a line, or a line for a Host that does not need trust, fails. bash
  (after: ISC-68)

## Not yet specified

- What scattered sample material ISC-20 and ISC-21 must contain to represent
  real users (which Host folders and instruction files).
- Whether the agent probes (ISC-21, ISC-45) require a specific agent or Host.
- Whether one Project can hold more than one Profile.
- Whether Host limits on project instruction size, such as the Codex default of
  32 KiB, need a claim on the size of installed Context.

## Decisions

- 2026-09-10 — refined: the principal accepted the concise Goal after reviewing
  the original statement. The approved claim outline separates brevity from
  detail discovery (ISC-7.1/7.2) and readability from styling (ISC-8.1/8.2), so
  those properties can be checked independently.
- 2026-09-10 — Qualification includes an unfamiliar user following public
  guidance without coaching, automated behavior checks, and principal review of
  rendered terminal screens. A simulated walkthrough alone is insufficient.
- 2026-09-10 — Installation success concerns verified generated output and
  relevant Host setup guidance; it does not establish actual Host loading.
- 2026-09-10 — Destination placement follows [ADR-0030](docs/adr/0030-keep-the-project-destination-in-isa.md).
- 2026-09-12 — refined: the principal extended the project destination through
  the testing and release investigation discussion: "I just want to make sure
  we're testing real functionality, the tests are load bearing, and that the
  test suites are designed effectively and efficiently." The principal accepted
  trustworthy qualification, exact-artifact release, bounded execution,
  preserved fault detection, isolation, support evidence, and verification reuse
  as the direction, then authorized this extension before specification.
  Existing user-journey claims and required human evidence remain in force;
  no new claim is closed by accepting the destination.
- 2026-09-17 — refined: after hands-on first-use testing (#519 O1–O4), the
  principal extended the destination to Workspace setup: "we should build around
  those 2 starting points because I think that's where most clients will start,
  most users will start and we should optimize around that." The starting points
  are no material, and scattered existing material (the expected common path).
  Connecting an existing valid Workspace is included. Accepted:
  - No default Workspace location. Interactive setup asks whether to use the
    current folder or a given path. Without a TTY, a path is required.
  - Setup offers to add only the missing parts of the Workspace structure to any
    chosen folder. Other files do not matter and are never changed.
  - Context Modules and Skills both stay supported. The contract may require
    minimal documented metadata. Validation names what is missing so that the
    user or their agent can fix it.
  - One canonical contract, linked from the README and shown by the CLI.
  - Before 1.0, a contract change may make an existing Workspace invalid only if
    validation names every change needed (ISC-46).
  - Host detection stays advisory (ISC-47.1, ISC-47.2).
  - Contradicts ADR-0007 (fixed default Workspace path; refusal to select a
    different Workspace) and `docs/USER-JOURNEY.md` stage 2 (`init` creates the
    Workspace at that default path). A superseding ADR and a journey update are
    required before that behaviour changes.
  - Dead end: the fixed default `~/.agents/agent-profile-kit/workspace/`.
    ADR-0007 names it but records no reason for it, and in testing the user
    learned the location only from the final receipt (O1).
  - Dead end: recovering Project Bindings after Local Configuration is lost. It
    needs a second home for that fact.
- 2026-09-24 — refined: from #656, the principal extended the destination to
  disposable worker worktrees: "An orchestrator can give one disposable worktree
  the same Profile for every Host it needs with one owned operation, and remove
  all of it with one owned operation. No hand copies." Accepted:
  - Automation first, behind `apkit machine`. A person can run it too; the
    existing ISC-7.1, ISC-7.2, ISC-8.1, and ISC-8.2 probes include the
    temporary installation screens, so they get no separate claims.
  - Every supported Host is in scope (ISC-52). Antigravity and Grok were
    excluded only by the scope of #133 and #369; a spike on e012809 installed
    and removed both.
  - Removal leaves the Project as it was, including empty folders (ISC-53).
    This changes current removal behaviour for every Host.
  - Contradicts ADR-0015 and the `CONTEXT.md` Temporary Profile Installation
    term ("one Host"); recorded in
    [ADR-0052](docs/adr/0052-install-one-temporary-profile-for-several-hosts.md).
  - Dead end: several single-Host Temporary Profile Installations in one
    Project; see
    [ADR-0052](docs/adr/0052-install-one-temporary-profile-for-several-hosts.md).
  - Dead end: a manual claim that observes a real orchestration run. Output
    probes are the proof; ISC-10 is unchanged.
  - The ISC-56, ISC-57, and ISC-58 probes already passed for single-Host Claude
    installs on a8a1f60, so those claims were sharpened to several-Host
    installations, which is the destination.
- 2026-10-30 — refined: from the agent-first prototype in `next/`, the
  principal extended the destination. The aim was to "see if we could rebuilt
  the agent profile kit in a much simpler way that was platform agnostic."
  Accepted:
  - Agent-first. The user works through their agent, and the agent runs apkit.
    The engine never prompts. ISC-1–4, 6, 19, and 20 now say "working through
    their agent". ISC-23, 25.x, and 27.x name `init`.
  - Dead end: interactive setup and terminal styling. ISC-8.1, 8.2, 24.1–24.3,
    and 27.3 are dropped. ISC-7.1 and 7.2 stay, because agents read the output
    too.
  - macOS, Linux, and Windows support is part of the destination (ISC-59).
  - "Simpler" means no runtime dependencies, no child processes, no
    OS-dependent code, and a tool that an agent learns from `guide` alone
    (ISC-60–64). Dead end: a source line budget, because it is easy to game.
  - Temporary Profile Installation is no longer a separate concept. ISC-50–58
    now apply to every Profile Installation. ISC-55 allows changes to files
    the user already tracks.
  - Context reaches every Host through one `AGENTS.md` section. Host-specific
    Context formats are out of scope. Because this depends on how each Host
    loads files, every written location needs a dated live check (ISC-68,
    ISC-69). ISC-10 and the Out of Scope line on automatic loading checks are
    unchanged.
  - Cutover takes over or removes current installations without the current
    engine and without losing user edits (ISC-66, ISC-67).
  - `setup` and `install --global` are in scope. Global installs include
    Context: the user owns the Profile and removes Context from it if that is
    too broad (ISC-70–74). Dead end: refusing Context in `--global`.
  - The qualification and release claims ISC-11–18 are unchanged.
  - Contradicts ADR-0012 (Adapters own Host-specific output), ADR-0015 and
    ADR-0052 (Temporary Profile Installation), and the `CONTEXT.md` Temporary
    Profile Installation term. Superseding ADRs and a glossary update are
    needed before cutover.
- 2026-10-30 — The 2026-10-30 direction is recorded in
  [ADR-0055](docs/adr/0055-deliver-through-verified-locations-instead-of-adapters.md)
  and [ADR-0056](docs/adr/0056-let-each-folder-own-its-installation.md). Both
  take effect at cutover. ADR-0010 also conflicts (Project Bindings, owning
  whole files only, no user-level writes), so ADR-0056 supersedes it as well.
  ADR-0012 is amended, not superseded: Host Resolution stays with the Host.
  The `CONTEXT.md` terms change in the cutover change.
- 2026-10-30 — refined: after an audit of the Workspace for new users, the
  principal chose to simplify the Workspace format before cutover. Accepted:
  - Any `.md` Context file name is valid; IDs that differ only in case are an
    error (ISC-39, ISC-76, ISC-77).
  - A missing Profile list is empty, and `.yml` is accepted (ISC-78, ISC-79).
  - An error means an install would be wrong or ambiguous. A file that apkit
    skips is a warning, which is always shown and never blocks an install
    (ISC-44, ISC-81, ISC-82).
  - `skills: all` selects every Skill (ISC-80).
  - Rules for retired features leave the contract and the validator (ISC-85).
    This only makes validation more permissive, so ISC-46 still holds.
  - The marker becomes `apkit-workspace.yaml`. Being a Workspace depends only
    on that file; the version matters only when it is unsupported (ISC-83,
    ISC-84).
  - Dead end: `context: all`. Context order matters, so Context stays listed.
  - Dead end: a `profiles/` folder as the marker. The name is too common.
  - Dead end: a fixed Workspace folder name. The user chooses the folder
    (ISC-23).
  - Dead end: a hidden marker file. It is invisible, and hidden files are
    skipped everywhere else.
- 2026-10-30 — The Workspace format change is recorded in
  [ADR-0057](docs/adr/0057-simplify-the-workspace-format.md), which takes
  effect at cutover and amends ADR-0046 and ADR-0048.
- 2026-10-30 — A parity test showed that the shared `AGENTS.md` delivery
  leaves ` M AGENTS.md` and ` M CLAUDE.md` in `git status` when a project
  tracks those files. The current engine leaves `git status` clean. The
  principal accepted this: most users are individuals, and projects that track
  those files are out of scope for now. Supporting teams is later work.
  Dead end: per-Host untracked Context files when the project tracks
  `AGENTS.md`; it keeps the per-Host table that ADR-0055 removes.
- 2026-10-30 — refined: a risk audit found that all seven of the principal's
  own Projects track `AGENTS.md` or `CLAUDE.md`, so the earlier Out of Scope
  line on such projects was wrong and is removed. The principal chose to keep
  the shared `AGENTS.md` delivery and make it transparent instead: apkit says
  which instruction files it creates or changes and whether Git tracks them,
  the agent asks the user, and the user decides what to commit (ISC-86,
  ISC-88). apkit hides installed Skill copies and its manifest from Git, but
  never an instruction file, even one it creates (ISC-55, ISC-87).
  Dead end: per-Host untracked Context files, again; they keep the per-Host
  table that ADR-0055 removes.
- 2026-10-30 — Moving from the current engine is one explicit
  `apkit migrate` (ISC-89 to ISC-93). It uses the current engine's receipts:
  each output that still matches its hash is deleted, including the Codex hook,
  the OpenCode configuration, and the Host rules files. A changed file is kept
  as a decision that names apkit's part. Folders are deleted only when nothing
  but apkit's output was in them. The old state folder is renamed as a backup.
  apkit leaves trust approvals for the old Codex hook alone.
  Dead end: migrating automatically on the first command; it acts before the
  user or agent sees the plan. Dead end: a manual cleanup guide; it breaks
  ISC-67.
- 2026-10-30 — refined: a symlink that leads an output outside the Project
  becomes an exit-3 decision that names the link and where it leads, not a
  refusal (ISC-56). The principal: "the user should have the full control over
  how their own setup works. Again, apkit just needs to be explicit about what
  it changes and potential consequences it sees and flag those." This and the
  tracked-file decision are recorded as the first Principle.
  Dead end: refusing every symlink, as the current engine does. Dead end:
  refusing only links that leave the Project.
- 2026-10-30 — refined: a Workspace with errors can be connected. apkit shows
  the complete validation report (ISC-48) and blocks every install and update
  until the errors are fixed (ISC-94). ISC-29 is dropped: the
  `apkit-workspace.yaml` marker already stops a mistyped path, and the user
  decides when to fix their Workspace.
- 2026-10-30 — Trust guidance stays specific to each Host, as in the current
  engine, with wording from the new live checks (ISC-95): Codex and Pi load
  Context without trust but project Skills only with it, and Grok loads
  nothing until trusted. Antigravity loaded without trust in print mode and
  needs an interactive check before its trust line is dropped.
  Dead end: one general trust line; a Host can silently miss Skills.
  The remaining audit risks (two runs on one folder, a Project install into
  the home folder, version drift, agents passing `--overwrite` on their own)
  go to the cutover spec as tests, not destination changes.
