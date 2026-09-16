# Uncoached-newcomer instructions (TEST-010 preparation)

> **PENDING HUMAN QUALIFICATION — NOT PASSED.** This procedure prepares the
> observation owned by #518. The participant's result — version tested,
> coaching needed, where completion failed — is recorded on #518 after the
> session, never here and never in advance. Do not coach the participant.
> Do not substitute an agent simulation.

## Before the session (facilitator only)

1. Provision one machine (or sandbox `HOME`) with the version-pinned build
   installed and first on `PATH`. Record the exact version
   (`apkit --version`); the prepared screens in this directory were captured
   against **0.204.0** — re-pin the version on #518 if it differs.
2. Confirm no `~/.agents/agent-profile-kit/` state exists (fresh newcomer).
3. Prepare one empty directory to serve as the participant's Project.
4. Give the participant nothing but this section onwards. No hints, no
   corrections, no answering "what do I type". Note every intervention with
   its step number.

## Participant procedure

You are trying Agent Profile Kit, which installs reusable agent material
(Context and Skills, bundled as Profiles) into your Projects for your Agent
Hosts. Work only from what the tool itself prints.

1. **Discover.** Run `apkit` with no arguments. Follow the one command it
   tells you to run. Write down what it said.
2. **Initialize.** The setup walks you through creating your first Profile.
   Accept the offer, name it `engineering`, keep the offered Context
   selection. Write down the exact next action it prints at the end.
3. **First install.** From inside your empty Project directory, run the exact
   next action from step 2, answering any questions it asks (choose whatever
   Hosts you like). Read the whole receipt, including anything it says about
   checking your Agent Host and about further evidence.
4. **Routine.** Run `apkit update --all`, then `apkit status`. In one
   sentence each, say what the tool did.
5. **Investigate.** Run `apkit details --list`, then `apkit details` for the
   install entry. Say what the install committed.
6. **Change and re-sync.** Open the installed generated files, change one by
   hand (add a line), then run `apkit update --all` again. Follow the tool's
   review flow; look at the offered comparison before deciding. Say what you
   decided and why.
7. **Change Hosts.** Install the same Profile into the same Project again,
   choosing one more Host than before. Then remove one Host while keeping the
   installation working for the others (the removal command's help lists the
   scope options). Say what each receipt reports.
8. **Tear down.** Remove the installation completely. Confirm with the tool's
   own status that nothing of yours remains installed, and say how you know.

## After the session (facilitator only)

Record on #518, not in this file:

- Tested version (`apkit --version` output).
- Per step: completed unaided / completed with coaching (quote the
  intervention) / failed (quote the tool output and the participant's words).
- Whether any printed next action did not run as printed.
- Whether any guidance contradicted another command's guidance.
- Whether any receipt disagreed with `apkit details` for the same run.

Failures require correction and requalification of the affected steps. An
observed failure is evidence, never acceptance.
