---
thing: Agent Profile Kit
phase: active
progress: 0/62
principal_stated_goal: "I just want apkit to be user-friendly to the unfamiliar beginner, be a joy to use, and polished. Only give the user what they need to know at each step but the power to dig deeper if they want to."
started: 2026-09-10
updated: 2026-09-17
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

## Vision

An unfamiliar user can get started confidently. Regular users can make changes
efficiently, even across many Projects. The interface feels calm and carefully
finished, with useful guidance at the point of need.
Maintainers can qualify changes efficiently using trustworthy evidence, and
users receive the exact package that passed release qualification.
A new user turns what they already have, or nothing, into a Workspace they
chose and own, knowing exactly what it must contain.

## Out of Scope

- AI generation of substantive Context or Skill content.
- A built-in text editor; content editing belongs in the user's editor.
- Automatic verification of Profile loading inside an Agent Host.
- apkit finding, importing, copying, or converting scattered Context and Skill
  files into a Workspace; the user or their agent moves material.
- Recovering Project Bindings after Local Configuration is lost.

## Goal

Make apkit intuitive for beginners and efficient for regular users: easy to create Profiles, install them into Projects with chosen Hosts, and update or remove installations. Keep the interface polished, actions predictable, and edits protected. Show what matters now, with deeper detail easy to find.
Qualify changes without unnecessary repeated work or weaker fault detection,
and tie each released package to complete evidence for its supported environment.
Let a user start from nothing or from existing material and reach a valid,
connected Workspace in a location they chose, against a published contract that
validation enforces.

## Claims

- [ ] **ISC-1:** An unfamiliar user can create a Profile without coaching.
  Probe: observe a newcomer create a Profile using only public guidance; needing
  coaching to complete the task fails the claim. manual
- [ ] **ISC-2:** An unfamiliar user can install a Profile into a Project with
  their chosen Hosts without coaching.
  Probe: observe that step in the newcomer journey and verify the resulting
  Project/Host selection; coaching or a different selection fails. manual
- [ ] **ISC-3:** An unfamiliar user can update installations after changing
  their Profile without coaching.
  Probe: observe the change-and-update step using public guidance; failure to
  propagate the intended change without coaching fails. manual
- [ ] **ISC-4:** An unfamiliar user can remove selected installations without
  coaching.
  Probe: observe selective removal in the newcomer journey; coaching or removal
  of an unselected installation fails. manual
- [ ] **ISC-5:** Repeated lifecycle operations are available through explicit,
  scriptable commands.
  Probe: run the packed CLI's create/install/update/uninstall journey with
  explicit inputs and no TTY; required interactive input fails. bash
- [ ] **ISC-6:** Users can identify an action's affected scope before confirming
  it.
  Probe: ask the walkthrough participant to identify affected Projects and
  Hosts from the confirmation view; compare with actual writes. manual
- [ ] **ISC-7.1:** Routine output is concise.
  Probe: principal reviews actual routine-success terminal screens at single-
  Project and fleet scale; unnecessary inventories or repeated facts fail. manual
- [ ] **ISC-7.2:** Complete operation details are discoverable when requested.
  Probe: a walkthrough participant retrieves a completed operation's full
  details using public guidance without repeating its writes. manual
- [ ] **ISC-8.1:** Terminal layouts are readable at normal and narrow widths.
  Probe: principal inspects rendered 100- and 60-column journey screens;
  unreadable layout, ambiguous scope, or broken commands fail. manual
- [ ] **ISC-8.2:** Terminal styling is consistent across the user journey.
  Probe: principal reviews rendered journey screens for consistent emphasis,
  spacing, and outcome styling; approval requires visual evidence, not ANSI
  inspection alone. manual
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
- [ ] **ISC-19:** An unfamiliar user starting with no Context or Skills reaches
  a valid, connected Workspace without coaching.
  Probe: observe a newcomer from a fresh install using only public guidance and
  CLI output; coaching, or a Workspace that is invalid or not connected, fails.
  manual
- [ ] **ISC-20:** An unfamiliar user with scattered Context and Skill files
  reaches a valid, connected Workspace that contains that material without
  coaching.
  Probe: observe a newcomer given prepared scattered material and only public
  guidance; coaching, missing material, or a Workspace that is invalid or not
  connected, fails. manual
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
  setup (accept and decline, with and without a TTY or path), connecting again,
  and upgrading legacy Local Configuration that has no `workspace` value; any
  Workspace created or selected at a location not given or confirmed fails.
  bash
- [ ] **ISC-24.1:** Interactive setup writes nothing before the user confirms
  the chosen folder.
  Probe: hold interactive setup at its confirmation and compare the file tree
  and Local Configuration with the starting state; any write fails. bash
- [ ] **ISC-24.2:** The setup confirmation shows the full path of the chosen
  folder.
  Probe: run interactive setup from folders with long and home-relative paths; a
  shortened or missing path fails. bash
- [ ] **ISC-24.3:** The setup confirmation explains what making the folder the
  Workspace means.
  Probe: principal reviews rendered setup confirmation screens at 100 and 60
  columns; a missing or unclear explanation fails. manual
- [ ] **ISC-25.1:** Setup without a TTY and without a Workspace path writes
  nothing.
  Probe: packed CLI setup without a TTY or path in a fresh home; any write fails.
  bash
- [ ] **ISC-25.2:** Setup without a TTY and without a Workspace path prints an
  executable command that supplies a path.
  Probe: run the printed command with a valid fixture path supplied; a missing
  or failing command fails. bash
- [ ] **ISC-26:** A relative Workspace path, including `.`, selects the folder
  the user named.
  Probe: packed CLI setup with `.` and with a relative path, then `validate` from
  a different directory; a Workspace other than the named folder fails. bash
- [ ] **ISC-27.1:** Accepting setup adds every missing part of the Workspace
  structure that the contract requires.
  Probe: accept setup of an empty folder and of a folder with unrelated files;
  any required part still missing fails. bash
- [ ] **ISC-27.2:** Accepting setup adds nothing to the chosen folder that the
  contract does not require.
  Probe: compare file trees before and after accepting setup; any added entry
  that the contract does not require fails. bash
- [ ] **ISC-27.3:** Declining setup adds nothing.
  Probe: compare file trees and Local Configuration before and after declining;
  any difference fails. bash
- [ ] **ISC-28:** **Anti:** Setup never changes, moves, or deletes an existing
  file in the chosen folder.
  Probe: compare existing entries before and after setup of valid, incomplete,
  and invalid folders that contain unrelated files; any changed, moved, or
  deleted entry fails. bash
- [ ] **ISC-29:** **Anti:** An invalid Workspace is never connected.
  Probe: set up, connect, and connect again to folders with invalid material;
  Local Configuration that selects any of them fails. bash
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
- [ ] **ISC-39:** An existing Markdown instruction file becomes a valid Context
  Module after adding only the metadata the contract states.
  Probe: add only contract-stated metadata to real instruction files and
  validate; any other required edit fails. bash
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
- [ ] **ISC-44:** **Anti:** A file under `context/` or `skills/` that does not
  follow the contract is never silently ignored.
  Probe: validate non-conforming files in both folders; any unreported file
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
- [ ] **ISC-48:** When apkit refuses to connect an invalid Workspace, it shows
  the complete validation report.
  Probe: set up and connect folders with several violations; output missing any
  violation that `validate` reports fails. bash
- [ ] **ISC-49:** The CLI shows the Workspace contract on request.
  Probe: find the contract command from `apkit --help` and run it; output that
  differs from the canonical contract fails. bash

## Not yet specified

- What scattered sample material ISC-20 and ISC-21 must contain to represent
  real users (which Host folders and instruction files).
- Whether the agent probes (ISC-21, ISC-45) require a specific agent or Host.

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
