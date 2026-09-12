---
thing: Agent Profile Kit
phase: active
progress: 0/20
principal_stated_goal: "I just want apkit to be user-friendly to the unfamiliar beginner, be a joy to use, and polished. Only give the user what they need to know at each step but the power to dig deeper if they want to."
started: 2026-09-10
updated: 2026-09-12
---

# Ideal State — Agent Profile Kit

## Problem

Users must navigate internal concepts and excessive output to accomplish a
simple task: use their Profiles across Projects and keep installations updated.
Passing command tests alone has not established a clear, polished experience.
Qualification can also consume repeated work without establishing which tests
actually ran or whether the published package is the package they exercised.

## Vision

An unfamiliar user can get started confidently. Regular users can make changes
efficiently, even across many Projects. The interface feels calm and carefully
finished, with useful guidance at the point of need.
Maintainers can qualify changes efficiently using trustworthy evidence, and
users receive the exact package that passed release qualification.

## Out of Scope

- AI generation of substantive Context or Skill content.
- A built-in text editor; content editing belongs in the user's editor.
- Automatic verification of Profile loading inside an Agent Host.

## Goal

Make apkit intuitive for beginners and efficient for regular users: easy to create Profiles, install them into Projects with chosen Hosts, and update or remove installations. Keep the interface polished, actions predictable, and edits protected. Show what matters now, with deeper detail easy to find.
Qualify changes without unnecessary repeated work or weaker fault detection,
and tie each released package to complete evidence for its supported environment.

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
