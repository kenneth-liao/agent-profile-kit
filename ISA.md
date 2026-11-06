---
thing: Agent Profile Kit
phase: active
progress: 81/87
principal_stated_goal: "I just want apkit to be user-friendly to the unfamiliar beginner, be a joy to use, and polished. Only give the user what they need to know at each step but the power to dig deeper if they want to."
started: 2026-09-10
updated: 2026-11-05
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
Until 0.239.0, the engine was large: per-Host Adapters, interactive prompts,
and supervised processes. Each new agent or platform made it larger.

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
- Recovering the list of installed folders after Local Configuration is lost.
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

- **ISC-1:** [DROPPED — see Decisions 2026-11-05]
- **ISC-2:** [DROPPED — see Decisions 2026-11-05]
- **ISC-3:** [DROPPED — see Decisions 2026-11-05]
- **ISC-4:** [DROPPED — see Decisions 2026-11-05]
- [x] **ISC-5:** Repeated lifecycle operations are available through explicit,
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
- [x] **ISC-9:** **Anti:** Independently changed generated files are not
  discarded without explicit consent.
  Probe: interactive and non-interactive install/update/uninstall tests with
  changed files, declined consent, and explicit consent; any unauthorized loss
  fails. bash
- [ ] **ISC-10:** **Anti:** Installation success never implies unverified Host
  loading.
  Probe: check success and handoff output throughout the install/update journey;
  any claim that a Host loaded a Profile without supporting observation fails.
  manual
- [x] **ISC-11:** **Anti:** Required qualification cannot report success when
  required tests are omitted, fail, or remain incomplete.
  Probe: exercise required qualification with a deliberately omitted test,
  failing test, and interrupted run; any successful qualification fails. bash
- **ISC-12:** [DROPPED — see Decisions 2026-11-05]
- [x] **ISC-13:** Every package published from 0.239.0 on is byte-identical to
  the package that passed its required release qualification.
  Probe: compare the published package digest with its qualified artifact
  digest; a mismatch or missing qualification evidence fails. bash
- [x] **ISC-14:** Routine qualification completes within its declared finite
  execution budget on the documented qualification environment.
  Probe: run canonical qualification on that environment; a deadline expiry
  or an unbounded stage fails. bash
- [ ] **ISC-15:** **Anti:** Test optimization does not weaken detection of
  the concrete regressions protected by the changed tests.
  Probe: replay the named representative faults for a test consolidation or
  relocation against retained coverage; an undetected fault fails. bash
- [x] **ISC-16:** Qualification outcomes do not depend on undeclared ambient
  machine state.
  Probe: vary unselected Host executables and unrelated environment settings
  around isolated fixtures; changed outcomes or unexpected real Host execution
  fails. bash
- **ISC-17:** [DROPPED — see Decisions 2026-11-05]
- [ ] **ISC-18:** Routine verification reuses still-valid evidence rather than
  repeating checks without a change or an unresolved hypothesis.
  Probe: inspect implementation and review verification records for a completed
  change; a repeated check without an identified invalidation or hypothesis
  fails. manual
- **ISC-19:** [DROPPED — see Decisions 2026-11-05]
- **ISC-20:** [DROPPED — see Decisions 2026-11-05]
- **ISC-21:** [DROPPED — see Decisions 2026-11-05]
- [x] **ISC-22:** On a machine that is not set up, `apkit` names the command
  that connects an existing valid Workspace.
  Probe: in a fresh home, run bare `apkit`, then run the named command without a
  TTY on a valid fixture Workspace; no such command, or a Workspace that is not
  connected afterwards, fails. bash
- [x] **ISC-23:** **Anti:** apkit never selects a Workspace location that the
  user did not give or confirm.
  Probe: in fresh homes, run every command that creates or selects a Workspace:
  `init` (with and without a path), selecting again, and upgrading legacy Local
  Configuration that has no `workspace` value; any Workspace created or
  selected at a location not given or confirmed fails. bash
- **ISC-24.1:** [DROPPED — see Decisions 2026-10-30]
- **ISC-24.2:** [DROPPED — see Decisions 2026-10-30]
- **ISC-24.3:** [DROPPED — see Decisions 2026-10-30]
- [x] **ISC-25.1:** `init` without a Workspace path writes nothing.
  Probe: packed CLI `init` without a path in a fresh home; any write fails.
  bash
- [x] **ISC-25.2:** `init` without a Workspace path prints an executable
  command that supplies a path.
  Probe: run the printed command with a valid fixture path supplied; a missing
  or failing command fails. bash
- [x] **ISC-26:** A relative Workspace path, including `.`, selects the folder
  the user named.
  Probe: packed CLI `init` with `.` and with a relative path, then `check` from
  a different directory; a Workspace other than the named folder fails. bash
- [x] **ISC-27.1:** `init` adds every missing part of the Workspace structure
  that the contract requires.
  Probe: `init` an empty folder and a folder with unrelated files; any required
  part still missing fails. bash
- [x] **ISC-27.2:** `init` adds nothing to the chosen folder that the contract
  does not require.
  Probe: compare file trees before and after `init`; any added entry that the
  contract does not require fails. bash
- **ISC-27.3:** [DROPPED — see Decisions 2026-10-30]
- [x] **ISC-28:** **Anti:** `init` never changes, moves, or deletes an existing
  file in the chosen folder.
  Probe: compare existing entries before and after `init` of valid, incomplete,
  and invalid folders that contain unrelated files; any changed, moved, or
  deleted entry fails. bash
- **ISC-29:** [DROPPED — see Decisions 2026-10-30]
- [x] **ISC-30:** A user can connect a different Workspace after setup without
  hand-editing Local Configuration.
  Probe: packed CLI connects a second valid Workspace after setup; needing a
  hand edit, or the first Workspace staying selected, fails. bash
- [x] **ISC-31:** Connecting a Workspace again, the same one or a different one,
  keeps the list of installed folders.
  Probe: connect the same Workspace, then a different one, on a machine with
  Profile Installations; any lost or changed listed folder fails. bash
- [x] **ISC-32:** After connecting a Workspace, every Profile Installation whose
  Profile that Workspace lacks is reported.
  Probe: connect a Workspace that lacks an installed Profile; an unreported
  installation fails. bash
- [x] **ISC-33:** **Anti:** Connecting a Workspace, first or again, never changes
  its files.
  Probe: compare valid Workspaces' file trees before and after first
  connection, connecting the same Workspace again, and connecting a different
  Workspace, with and without a TTY; any change fails. bash
- [x] **ISC-34:** The Workspace contract is readable from the README before
  installing apkit.
  Probe: from the public README, reach the complete contract without installing
  apkit; failure to reach it fails. manual
- [x] **ISC-35:** Every rule that Workspace validation enforces is stated in the
  contract.
  Probe: map each validation failure kind to a contract statement; an enforced
  rule the contract does not state fails. manual
- [x] **ISC-36.1:** The contract includes a valid Workspace example.
  Probe: read the contract; no valid Workspace example fails. manual
- [x] **ISC-36.2:** The contract includes invalid Workspace examples.
  Probe: read the contract; no invalid Workspace example fails. manual
- [x] **ISC-36.3:** Each contract example validates as the contract says.
  Probe: validate each contract example; an outcome different from the
  contract's statement fails. bash
- [x] **ISC-37.1:** The contract states where this machine records the selected
  Workspace location.
  Probe: read the contract; a missing or wrong location fails. manual
- [x] **ISC-37.2:** The contract states where this machine records the list
  of installed folders.
  Probe: read the contract; a missing or wrong location fails. manual
- [x] **ISC-38:** A standard Agent Skill is valid Workspace material without
  edits.
  Probe: copy real standard Skill packages unchanged into a Workspace and
  validate; any required edit fails. bash
- [x] **ISC-39:** An existing Markdown instruction file is a valid Context
  Module unchanged.
  Probe: copy real instruction files, such as `CLAUDE.md` and `AGENTS.md`, into
  `context/` as they are and validate; any required rename or edit fails. bash
- [x] **ISC-40.1:** A folder that is not connected can be validated.
  Probe: packed CLI validates a folder that is not connected in a fresh home; no
  validation report fails. bash
- [x] **ISC-40.2:** Validating a folder that is not connected creates no Local
  Configuration.
  Probe: compare the fresh home before and after that validation; any created
  Local Configuration fails. bash
- [x] **ISC-41:** One validation run reports every contract violation in a
  Workspace.
  Probe: validate a Workspace seeded with several violations across categories;
  any violation missing from one run fails. bash
- [x] **ISC-42.1:** Each reported contract violation names its path.
  Probe: trigger each violation kind; a report without the path fails. bash
- [x] **ISC-42.2:** Each reported contract violation names the change that fixes
  it.
  Probe: trigger each violation kind; a report without the fix fails. bash
- [x] **ISC-43:** Failed Workspace validation points to the contract.
  Probe: trigger each violation kind; output without a contract reference fails.
  bash
- [x] **ISC-44:** **Anti:** A file that apkit skips is never silently ignored,
  except a hidden file.
  Probe: put stray files in `context/`, `skills/`, and `profiles/`, then run
  `check` and `install`; a skipped file that is not hidden, without a warning
  in either output, fails. bash
- **ISC-45:** [DROPPED — see Decisions 2026-11-05]
- [x] **ISC-46:** **Anti:** A Workspace that was valid in any earlier release
  never fails validation without the output naming every change needed.
  Probe: validate retained fixtures kept from each release that changed the
  contract, including a realistic-scale fixture with neutral content modeled on
  the principal's Workspace; a failure without a complete change list fails.
  bash
- [x] **ISC-47.1:** **Anti:** Detecting which Hosts are installed never starts a
  Host program.
  Probe: run every command that detects installed Hosts with fake Host
  executables that write a marker when started; any marker fails. bash
- [x] **ISC-47.2:** **Anti:** Detecting which Hosts are installed never writes a
  file.
  Probe: compare the isolated home and working directory before and after every
  command that detects installed Hosts; any new or changed file fails. bash
- [x] **ISC-48:** When apkit connects a Workspace that has errors, it shows the
  complete validation report.
  Probe: connect folders with several violations; output missing any violation
  that `check` reports fails. bash
- [x] **ISC-49:** The CLI shows the Workspace contract on request.
  Probe: find the contract command from `apkit --help` and run it; output that
  differs from the canonical contract fails. bash
- [x] **ISC-50:** One command gives a Project a Profile Installation of one
  Profile for several Hosts.
  Probe: packed CLI `install` with two or more Hosts into a linked worktree; a
  selected Host without its outputs, or needing more than one command, fails.
  bash
- [x] **ISC-51:** One command removes a Profile Installation for all of its
  Hosts.
  Probe: one `remove` after the ISC-50 install; any remaining Host output fails.
  bash
- [x] **ISC-52:** Every supported Host can receive a Profile Installation.
  Probe: packed CLI `install` for each Host in the Host catalog; any rejected
  supported Host fails. bash
- [x] **ISC-53:** **Anti:** Removing a Profile Installation never leaves
  anything that its install added, including empty folders.
  Probe: compare the Project tree, including empty folders, before install and
  after removal, for each Host and for a several-Host combination; any
  difference fails. bash
- [x] **ISC-54:** **Anti:** A Profile Installation in a linked worktree never
  changes the main checkout's Profile Installation.
  Probe: install and remove a Profile Installation in a linked worktree of a
  main checkout that has its own installation; any changed main-checkout output
  or owned exclusion entry fails. bash
- [x] **ISC-55:** **Anti:** A Profile Installation adds no untracked entry to
  the Project's `git status`, except an instruction file that it creates.
  Probe: compare `git status --porcelain` before and after install for each
  Host, into a repository root and into a subfolder of a repository; any new
  untracked entry other than a created `AGENTS.md` fails. Changes to files the
  user already tracks are allowed. bash
- [x] **ISC-56:** **Anti:** No output of a Profile Installation lands outside
  its Project without the user's decision.
  Probe: install with a Host folder that is a symlink to a folder outside the
  Project, without and then with the decision granted; a write outside the
  Project before the decision, or a decision output that does not name the
  link and where it leads, fails. bash
- [x] **ISC-57:** **Anti:** A Profile Installation stays removable after its
  Project is deleted.
  Probe: install for several Hosts, `git worktree remove --force`, then
  `remove`; a failed removal, or the installation still listed by
  `status --all`, fails. bash
- [x] **ISC-58:** Profile Installations started at the same time in different
  Projects all succeed.
  Probe: start four several-Host `install` runs into separate worktrees at
  once; any failed run or missing installation record fails. bash
- [x] **ISC-59:** Every lifecycle command behaves the same on macOS, Linux, and
  Windows.
  Probe: run the packed CLI journey in CI on all three; any failure, or a
  different outcome on one platform, fails. bash
- [x] **ISC-60:** The published package has no runtime dependencies.
  Probe: the packed `package.json` has no `dependencies`, and the bundle
  imports only `node:` built-ins; anything else fails. bash
- [x] **ISC-61:** The engine starts no child processes.
  Probe: run the full journey with marker-writing fake executables first on
  `PATH`; any marker fails. bash
- [x] **ISC-62:** The engine has no code path that depends on the operating
  system.
  Probe: `rg` the engine source for `process.platform` and other OS checks; any
  branch on the operating system fails. bash
- **ISC-63:** [DROPPED — see Decisions 2026-11-05]
- [x] **ISC-64:** `guide` names every command, flag, and Host id that the CLI
  accepts.
  Probe: compare the CLI parser with the guide text; anything the CLI accepts
  that the guide does not name fails. bash
- [x] **ISC-65:** **Anti:** A run that stops for a user decision changes no
  file.
  Probe: snapshot the Project and the home folder, trigger each decision case,
  and compare; any change fails. bash
- [x] **ISC-66:** **Anti:** Moving from the old engine (apkit 0.238.0) never discards a
  user's edit to an installed file without explicit consent.
  Probe: install with apkit 0.238.0, edit the generated files, then take over or
  remove with the current apkit; any unauthorized loss fails. bash
- [x] **ISC-67:** A Project installed by the old engine can be taken over or
  removed without the old engine.
  Probe: on that fixture, use only the current apkit; needing the old engine,
  or leftover output, fails. bash
- **ISC-68:** [DROPPED — see Decisions 2026-11-05]
- **ISC-69:** [DROPPED — see Decisions 2026-11-05]
- [x] **ISC-70:** `setup` gives each installed Host's user-level instructions a
  note that points to `guide`.
  Probe: in an isolated home with Host folders, run `setup --yes`; a target
  without the note fails. bash
- [x] **ISC-71:** **Anti:** `setup` or a global install never hides an existing
  user-level file from a Host.
  Probe: OpenCode with `~/.claude/CLAUDE.md` present; a new file earlier in its
  lookup order fails. bash
- [x] **ISC-72:** **Anti:** Removing the `setup` note or a global install
  restores each user-level file byte for byte.
  Probe: byte-compare each user-level file before install and after removal;
  any difference fails. bash
- [x] **ISC-73:** One command installs a Profile's Skills and Context at user
  level for each selected Host.
  Probe: `install --global` with a Profile that has both; any missing Skill or
  Context for a selected Host fails. bash
- [x] **ISC-74:** `status` reports a Context Module that is installed both
  globally and in the Project.
  Probe: install the Module both ways, then run `status` in the Project; no
  report fails. bash
- [x] **ISC-75:** **Anti:** apkit never changes text outside its marked section
  in a user's instruction file.
  Probe: edit text around the section, then install, update, and remove; any
  change outside the section fails. bash

- [x] **ISC-76:** A Context file with any `.md` name is valid, and its ID is
  its path under `context/` without `.md`.
  Probe: validate and install Context files with mixed-case names and names
  with spaces; a rejected file or a different ID fails. bash
- [x] **ISC-77:** Two Context IDs that differ only in case are an error on
  every platform.
  Probe: validate `Style.md` beside `style.md` on Linux; no error fails. bash
- [x] **ISC-78:** A Profile without a `context` or `skills` list treats that
  list as empty.
  Probe: validate and install a Skills-only Profile with no `context` list; an
  error fails. bash
- [x] **ISC-79:** A Profile with a `.yml` extension is valid.
  Probe: validate and install a `.yml` Profile; an error fails. bash
- [x] **ISC-80:** A Profile with `skills: all` installs every Skill in the
  Workspace, including Skills added after the Profile was written.
  Probe: install, add a Skill, run `update` without editing the Profile; a
  missing Skill fails. bash
- [x] **ISC-81:** **Anti:** A warning never blocks an install.
  Probe: install with each warning case present; a non-zero exit or missing
  output fails. bash
- [x] **ISC-82:** Validation reports an error only when an install would be
  wrong or ambiguous.
  Probe: map each error kind to the wrong or ambiguous install it prevents; an
  error kind without one fails. manual
- [x] **ISC-83:** A folder is a Workspace when it has an `apkit-workspace.yaml`
  file, which may be empty. Its `schema_version` matters only when it is not a
  version this apkit supports.
  Probe: `init`, empty the file, and validate; then set an unsupported
  version; an error for the empty file, or no error that says a newer apkit
  is needed, fails. bash
- [x] **ISC-84:** A folder with only the old `workspace.yaml` fails validation,
  and the output names the rename to `apkit-workspace.yaml`.
  Probe: validate that fixture; a pass, or output without the rename, fails.
  bash
- [x] **ISC-85:** The Workspace contract states no rule for a retired feature.
  Probe: `rg` the contract for retired features, such as the sidecar and the
  retired model-invocation key; any match fails. bash

- [x] **ISC-86:** Before apkit creates or changes an instruction file, its
  output names the file, says whether it will be created or changed, and says
  whether Git tracks it.
  Probe: run install with `AGENTS.md` and `CLAUDE.md` absent, untracked, and
  tracked; a decision output that misses any of the three facts fails. bash
- [x] **ISC-87:** **Anti:** apkit never hides an instruction file from Git.
  Probe: install where apkit creates `AGENTS.md`, then read
  `.git/info/exclude`; any entry for `AGENTS.md` or `CLAUDE.md` fails. bash
- **ISC-88:** [DROPPED — see Decisions 2026-11-05]

- [x] **ISC-89:** One `apkit migrate` command moves every Project recorded by
  the old engine to the current apkit, with the same Workspace, Profile, and
  Hosts.
  Probe: on a fixture machine with several Projects installed by apkit 0.238.0,
  run `migrate` with each decision granted; a Project with a different
  Profile, Host set, or Workspace afterwards fails. bash (after: ISC-67)
- [x] **ISC-90:** **Anti:** After `migrate`, nothing the old engine wrote
  remains, except files the user changed, and no Context is delivered twice.
  Probe: compare each migrated Project with a fresh current-apkit install of the
  same Profile, including empty folders, old exclusion blocks, the Codex hook,
  and the OpenCode configuration; any leftover unchanged output fails. bash
- [x] **ISC-91:** A changed file that the old engine wrote is kept and
  listed as a decision that names the part apkit added.
  Probe: edit `.codex/hooks.json` and `.opencode/opencode.jsonc` before
  `migrate`; a deleted file, or a decision without apkit's part, fails. bash
- [x] **ISC-92:** After `migrate`, the old engine's state folder is kept,
  renamed as a backup.
  Probe: compare `~/.agents/agent-profile-kit` before migration with
  `~/.agents/agent-profile-kit.migrated` after; a missing or changed file
  fails. bash
- [x] **ISC-93:** While the old engine's state exists and is not migrated,
  every command except `apkit migrate` itself names `apkit migrate`.
  Probe: run each command on that fixture machine; output without
  `apkit migrate` fails. bash

- [x] **ISC-94:** **Anti:** No install or update runs from a Workspace that
  has errors.
  Probe: connect a Workspace with each error kind, then run `install` and
  `update`; any write fails. bash

- [x] **ISC-95:** After an install, apkit names each selected Host that needs
  the user to trust the Project, and what does not load until then.
  Probe: install for every Host; a Host whose trust column in the
  `docs/ARCHITECTURE.md` Verified Locations table needs trust without a line,
  or a line for a Host that does not need trust, fails. bash

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
- 2026-10-30 — Tests before the cutover spec. A fresh Claude Code session and a
  fresh Codex session, given only the `apkit-next` command, learned the tool
  from `guide`, stopped at the exit-3 decision for a tracked `AGENTS.md`, and
  asked the user. Neither passed `--yes` nor committed. Neither said that Git
  tracks the file (ISC-86, ISC-88 are still open). Codex cut off an `AGENTS.md`
  of about 52 KB at its 32 KiB default without a warning. Antigravity loaded
  Context and Skills in its interactive app after it asked for, and was given,
  trust, so it keeps its trust line (ISC-95).
  Dead end: a claim or a Host limits table for installed Context size. The
  principal: Host size limits are each Host's own behaviour, and a user can
  already write an instruction file of any size. The guide's advice to keep
  Context short stays. The fog item is closed.
- 2026-10-30 — Cutover shape, chosen before the specs:
  - The commands `new`, `configure`, `open`, `info`, `list`, and `details` do
    not return; the agent edits files, and `check`, `status --all`,
    `workspace`, and `--json` cover the rest. ISC-7.2 is met by `--json`
    output at the time of the run.
  - The prototype's command and flag names stay (`check`, `remove`,
    `--agents a,b`, `--yes`, `--overwrite`), as a breaking minor release under
    ADR-0014.
  - `next/` becomes the only engine at the repository root; the current
    engine's code and tests are deleted.
  - Release qualification keeps exact-artifact release and a qualification
    record (ISC-11 to ISC-18) but replaces the supervised test runner with
    plain `bun test`, because the new engine starts no child processes.
  - Two specs: first the Workspace format and the remaining engine gaps in
    `next/`, then migration and cutover.
- 2026-11-03 — refined: macOS Finder's `.DS_Store` file is not the user's
  content. A folder that holds only apkit's output and a `.DS_Store` file
  counts as empty when apkit removes the folders its writes emptied. The
  live 0.239.0-rc.1 migration (#762) left `.agent-profile-kit/` in four
  Projects only because Finder had written that file, and the principal asked
  for it to be fixed. A folder with any other file stays.
- 2026-11-05 — refined: after the 0.239 cutover, the principal dropped every
  claim that needed a newcomer walkthrough, a fresh agent session, a record
  review, or a live Host check: ISC-1–4, 12, 17, 19–21, 45, 63, 68, 69, and 88.
  The two fog items that defined those walkthroughs (ISC-20, 21, and 45) are
  removed with them. ISC-95 now checks the trust lines against the trust column
  of the Verified Locations table in `docs/ARCHITECTURE.md`, not against
  ISC-68. Also accepted:
  - ISC-13 covers packages published from 0.239.0 on. Earlier releases had no
    qualification record.
  - ISC-44 excludes hidden files, which apkit skips without a warning on
    purpose (#605).
  - ISC-83 asks for "a newer apkit is needed": apkit cannot know which future
    version reads a newer `schema_version`.
  - ISC-93 excludes `migrate`, which does not repeat its own notice.
  - The migration claims (ISC-66, 67, 89–93) stay until 1.0, then are dropped.
  - One folder holds one Profile. A Profile already selects any mix of Context
    and Skills, so stacking Profiles adds nothing. The fog item is closed.
  - The beginner Goal stays unchanged. Without the walkthrough claims, it is
    covered by the scripted lifecycle claims and ISC-6, ISC-7.1, and ISC-7.2.

## Verification

Test names are at @41c818a, `bun test` (Bun 1.4.4) and CI run 42143427215 unless the line says otherwise.

- ISC-5: `test/cli.test.ts` "the daily loop: select, check, install, edit, update everywhere, remove"
- ISC-9: `test/cli.test.ts` "the daily loop: select, check, install, edit, update everywhere, remove"; "no run overwrites a file that the user changed"; "install, update, and remove preserve changed generated files until --overwrite" (the CLI never prompts; consent is a flag)
- ISC-11: `test/release.test.ts` "failing, skipped, omitted-file and interrupted plain test runs cannot record success"
- ISC-13: 2026-11-05: the npm tarballs of 0.239.0-rc.1 to 0.239.1 match the digest in each release's `qualification-record.json`
- ISC-14: CI run 42127574355 @2dd146d: every job passed within its `timeout-minutes` (10)
- ISC-16: `test/cli.test.ts` "antigravity: unselected programs and unrelated environment settings do not change isolated outcomes"; "claude: unselected programs and unrelated environment settings do not change isolated outcomes"; "codex: unselected programs and unrelated environment settings do not change isolated outcomes"; "grok: unselected programs and unrelated environment settings do not change isolated outcomes"; "opencode: unselected programs and unrelated environment settings do not change isolated outcomes"; "pi: unselected programs and unrelated environment settings do not change isolated outcomes"
- ISC-22: 2026-11-05 manual run of `dist/cli.js` @2dd146d: bare `apkit` names `apkit workspace [<path>]`; running it in a fresh home selected the fixture
- ISC-23: `test/cli.test.ts` "only caller-supplied paths select a Workspace, including migration without a legacy selection"
- ISC-25.1: `test/cli.test.ts` "`init` and `workspace` without a path, and `--help`, write nothing in a fresh home (ISC-25.1)"
- ISC-25.2: 2026-11-05 manual run @2dd146d: `init` prints `apkit init <path>`; with a path supplied it exits 0 and selects the Workspace
- ISC-26: `test/cli.test.ts` "init . selects that folder when check runs elsewhere"; "init nested/my workspace selects that folder when check runs elsewhere"
- ISC-27.1: `test/cli.test.ts` "init completes empty, unrelated-file, and partial folders with only the contract structure"
- ISC-27.2: `test/cli.test.ts` "init completes empty, unrelated-file, and partial folders with only the contract structure"
- ISC-28: `test/cli.test.ts` "init preserves every existing entry in valid, incomplete, and invalid folders with unrelated files"
- ISC-30: 2026-11-05 manual run @2dd146d: `workspace <B>` after `<A>`; Local Configuration names B
- ISC-31: 2026-11-05 manual run @2dd146d: reconnecting A, then B, kept both Profile Installations in Local Configuration
- ISC-32: `test/cli.test.ts` "selecting a Workspace that lacks an installed Profile names each affected folder"
- ISC-33: 2026-11-05 manual run @2dd146d: file and folder trees of A and B unchanged after first, repeat, and different connection
- ISC-34: 2026-11-05 manual read @fd0ee11: `README.md` § Learn more links `docs/guides/workspace-contract.md`, the complete contract, with no install
- ISC-35: 2026-11-05 manual map @fd0ee11 of each check in `src/workspace.ts` to a contract statement, none missing; `test/contract.test.ts` "states every code validation reports, as an error or a warning" (#791)
- ISC-36.1: `test/contract.test.ts` "has valid and invalid examples"
- ISC-36.2: `test/contract.test.ts` "has valid and invalid examples"
- ISC-36.3: `test/contract.test.ts` "<example> validates as the contract says"
- ISC-37.1: 2026-11-05 manual read (#791): contract § Where this machine records it names `workspace` in `config.json` in the apkit home, as `src/config.ts` writes it
- ISC-37.2: 2026-11-05 manual read (#791): the same section names `installs`, and `global.json` for the user-level install, as `src/config.ts` and `src/location.ts` write them
- ISC-38: `test/cli.test.ts` "published Skills validate unchanged, including allowed-tools, compatibility, metadata and Resources"
- ISC-39: `test/workspace.test.ts` "any .md name is a Context Module, and its ID is its path without .md"
- ISC-40.1: `test/cli.test.ts` "a skipped file is a warning: check and install show it, and it never blocks an install"
- ISC-40.2: 2026-11-05 manual run @2dd146d: `check --workspace` in a fresh home left the home empty
- ISC-41: `test/cli.test.ts` "a Workspace with errors can be selected and shows every error; installs and updates wait until it is fixed"
- ISC-42.1: `test/cli.test.ts` "check names every offending path, its fix, and the contract"
- ISC-42.2: `test/cli.test.ts` "check names every offending path, its fix, and the contract"
- ISC-43: `test/cli.test.ts` "check names every offending path, its fix, and the contract"
- ISC-44: `test/cli.test.ts` "a skipped file is a warning: check and install show it, and it never blocks an install"
- ISC-46: `test/cli.test.ts` "0.20.0 minimal: one CLI check names every needed change, and those changes suffice"; "0.20.0 partial: one CLI check names every needed change, and those changes suffice"; "0.95.0: one CLI check names every needed change, and those changes suffice"; "0.204.0 source: one CLI check names every needed change, and those changes suffice"; "0.204.0 realistic: one CLI check names every needed change, and those changes suffice"; "0.237.0: one CLI check names every needed change, and those changes suffice"
- ISC-47.1: `test/cli.test.ts` "detecting all six agents starts no program and changes neither home nor working folder"; "the engine source never starts a program: no child_process, Bun.spawn, or Bun.$"
- ISC-47.2: `test/cli.test.ts` "detecting all six agents starts no program and changes neither home nor working folder"
- ISC-48: `test/cli.test.ts` "init and workspace select Workspaces with errors and show the complete check report (ISC-48)"
- ISC-49: 2026-11-05 manual run @2dd146d: `--help` names `apkit contract`; its output is byte-identical to `docs/guides/workspace-contract.md`
- ISC-50: `test/cli.test.ts` "one install gives a linked worktree every selected agent's outputs, and one remove leaves it as it was, empty folders included" (all six agents; also with `APKIT_CLI=dist/cli.js`)
- ISC-51: `test/cli.test.ts` "one install gives a linked worktree every selected agent's outputs, and one remove leaves it as it was, empty folders included" (also with `APKIT_CLI=dist/cli.js`)
- ISC-52: `test/cli.test.ts` "deletes every unchanged old output and installs the same Profile, agents, and Workspace: the Project matches a fresh install" (all six Hosts)
- ISC-53: `test/cli.test.ts` "one install gives a linked worktree every selected agent's outputs, and one remove leaves it as it was, empty folders included" (each agent and all six together, beside the user's empty `.claude/` and `.agents/`); "an update records each folder it creates and none that was there; removal deletes only those"
- ISC-54: `test/cli.test.ts` "install and remove in a linked worktree leave the main checkout's installation as it was"
- ISC-55: `test/cli.test.ts` "for each agent, an install into a repository root and a subfolder adds no untracked entry but the AGENTS.md it creates"; "one install gives a linked worktree every selected agent's outputs, and one remove leaves it as it was, empty folders included" (linked worktree root)
- ISC-56: `test/cli.test.ts` "a symlink that leads outside the Project needs a decision before any write there"
- ISC-57: `test/cli.test.ts` "remove forgets a deleted linked worktree and drops its block"
- ISC-58: `test/cli.test.ts` "four several-agent installs into four linked worktrees at once all succeed and are all listed" (all six agents)
- ISC-59: CI run 42127574355 @2dd146d: tests and Node 22 CLI passed on ubuntu, macOS, and Windows
- ISC-60: 2026-11-05: published 0.239.1 `package.json` has no dependencies; its bundle imports only `node:` modules
- ISC-61: `test/cli.test.ts` "the full lifecycle including retained migration starts no program"; "the engine source never starts a program: no child_process, Bun.spawn, or Bun.$"
- ISC-62: `test/cli.test.ts` "the bundle imports only node: built-ins and never checks the operating system" with `APKIT_CLI=dist/cli.js`; `rg` of `src/` found no OS check
- ISC-64: `test/cli.test.ts` "the guide covers every command, flag, and agent the CLI accepts"
- ISC-65: `test/cli.test.ts` "each project install Decision preserves the complete Project, home and Workspace trees"; "outside-folder install, update and removal Decisions preserve links and their targets as well as home"; "global install, update, removal and setup Decisions preserve every home file including both registries"; "migration Decisions preserve complete home, Project, Workspace and old-state trees"
- ISC-66: `test/cli.test.ts` "a changed Codex hook and OpenCode configuration are a decision that names apkit's part, and nothing changes"; "a changed Skill folder and Markdown output are listed with their origin; --yes cannot keep a Skill this apkit installs again"
- ISC-67: `test/cli.test.ts` "a Project the old engine installed is removed by the current apkit alone: after migrate and remove it matches the Project before the old install"; takeover: "deletes every unchanged old output and installs the same Profile, agents, and Workspace: the Project matches a fresh install"
- ISC-70: `test/cli.test.ts` "setup --yes gives every detected agent's user-level file a note that points to guide (all six agents)"
- ISC-71: `test/cli.test.ts` "setup and a global install for OpenCode never create a file earlier in its lookup order than ~/.claude/CLAUDE.md"
- ISC-72: `test/cli.test.ts` "setup --remove and remove --global restore each agent's user-level file byte for byte, with CRLF and no final newline"
- ISC-73: `test/cli.test.ts` "install --global puts a Profile's Context in each agent's user-level file, after consent"
- ISC-74: `test/cli.test.ts` "status names Context installed both at user level and in the Project, and never blocks"
- ISC-75: `test/cli.test.ts` "user text before and after instruction sections survives install, update, and remove with LF and CRLF"
- ISC-76: `test/cli.test.ts` "any .md Context name installs, and an encoded ID keeps the marked section intact"
- ISC-77: `test/workspace.test.ts` "two Context IDs that differ only in case are an error" on Linux CI
- ISC-78: `test/cli.test.ts` "lenient Profiles: a missing list is empty, .yml is a Profile, and skills: all follows the Workspace"
- ISC-79: `test/cli.test.ts` "lenient Profiles: a missing list is empty, .yml is a Profile, and skills: all follows the Workspace"
- ISC-80: `test/cli.test.ts` "lenient Profiles: a missing list is empty, .yml is a Profile, and skills: all follows the Workspace"
- ISC-81: `test/cli.test.ts` "a skipped file is a warning: check and install show it, and it never blocks an install"
- ISC-82: `test/validation-cases.ts` `ERROR_KINDS` names the wrong or ambiguous install each error kind prevents; `test/workspace.test.ts` "<code> is an error: it prevents …" and "every code the validator reports is a documented error kind or a warning"; a repeated Skill is a warning (#791)
- ISC-83: 2026-11-05 manual run @2dd146d: `init`, then an emptied `apkit-workspace.yaml`, passes `check`; `schema_version: 99` names a newer apkit
- ISC-84: `test/cli.test.ts` "apkit-workspace.yaml marks a Workspace; the old workspace.yaml names the rename"
- ISC-85: `test/contract.test.ts` "states no rule for a retired feature"
- ISC-86: `test/cli.test.ts` "instruction-file decisions cover absent, untracked, and tracked AGENTS.md and CLAUDE.md"
- ISC-87: `test/cli.test.ts` "an AGENTS.md apkit creates is never hidden from Git"
- ISC-89: `test/cli.test.ts` "one run migrates every Project with its own Profile and agents, then keeps the old state as a backup, unchanged"
- ISC-90: `test/cli.test.ts` "deletes every unchanged old output and installs the same Profile, agents, and Workspace: the Project matches a fresh install"
- ISC-91: `test/cli.test.ts` "a changed Codex hook and OpenCode configuration are a decision that names apkit's part, and nothing changes"
- ISC-92: `test/cli.test.ts` "one run migrates every Project with its own Profile and agents, then keeps the old state as a backup, unchanged"
- ISC-93: `test/cli.test.ts` "with unmigrated old state, every command names `apkit migrate`, and none changes the old state"
- ISC-94: `test/cli.test.ts` "install and update leave every file and folder unchanged"
- ISC-95: `test/cli.test.ts` "an install names each selected agent that needs the folder trusted, and what waits for it"; values match the Verified Locations trust column
