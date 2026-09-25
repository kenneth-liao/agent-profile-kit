# Rendered terminal evidence — 2026-09-24 recapture

Prepared for #680 (TEST-005), refreshed for #695 and refreshed again for #706
to support the principal re-review on #519 under parent spec #672.
**Principal acceptance stays on #519.** This report does not accept or
disposition #519 or #491 (TEST-006, OOS-005); both stay open.

This is the fourth capture under the one committed driver. The first ran
against the packed candidate at `24067a5` and found four product defects plus
two wording divergences; #690 (PR #691, merged as `7156297`) corrected them and
the second capture replaced the evidence at that revision. #693 (PR #696) then
corrected the audit's spacing and details-route gaps and #694 (PR #697) the
docs; the third capture re-ran the driver against a freshly packed candidate at
that new `main` (`414763a`). #699 (PR #702, merged as `e8af13e`), #700 (PR
#703, merged as `8e76349`) and #701 (PR #705, merged as `60f3dd8`) then
corrected the second spec acceptance audit's gaps; this capture re-runs the
same driver against a freshly packed candidate at the newest `main`
(`60f3dd8`) and replaces the evidence in place. Labels and frame IDs are
unchanged, so all four captures compare one to one.

## Provenance

- Product: Agent Profile Kit **0.236.5**, revision
  [`60f3dd8`](https://github.com/kenneth-liao/agent-profile-kit/commit/60f3dd8682649026d9d446ff4d74f7ba40c0984a)
  (origin/main with #673–#679, #690, #693, #694, #699, #700 and #701 merged).
  Packed from this ticket's worktree at that revision with a clean tree and no
  untracked source (the session log sat outside the tree for the pack), so the
  identity record names the product revision and no local evidence.
- Package created with `scripts/create-package-candidate.ts` (the committed
  `prepare-candidate.ts` flow) into a fresh, empty
  `/private/tmp/apkit-706-candidate` — never a reused directory, so no stale
  file can enter the candidate; extracted through `extractPackageArchive`,
  which verifies the identity record against the archive bytes. Identity
  summary:
  [`candidate-identity.json`](evidence/2026-09-24-terminal-recapture/candidate-identity.json).
- Archive SHA-256:
  `1cfdea1421172ae4c253024105c36b09dc2a830dcd116abf04fb11e0a34b40fc`.
- Source fingerprint:
  `5556391b8f611609c065a1ef606ecca1fa6318e332448d0024af5bbf2af084d6`.
- The driver's candidate path now names this fresh directory
  (`capture-terminal-recapture.py` constant `CANDIDATE`); that path change is
  the only driver edit and is not a product-flow change. The #699–#701 fixes
  change text the driver captures, not the questions, answers or commands it
  drives (the live questions keep their wording; the new missing-folder and
  setup-step lines are captured output), so no flow step needed to change. The
  session root stays `/private/tmp/apkit-680-session` and is wiped before each
  run, so every frame's path strings compare one to one with the 414763a
  frames.
- Runtime: Node v22.23.2 (`/opt/homebrew/opt/node@22/bin/node`, spawned as an
  absolute path; node@22 is never exported onto `PATH`); build: Bun 1.4.0.
- Real PTYs: 100×24 and 60×24, `TERM=xterm-256color`, driven by pexpect. Each
  expected prompt/exit had a 12-second timeout and owned-child cleanup.
- Each width used its own disposable HOME and XDG directories under
  `/private/tmp/apkit-680-session/`. Only fixture Projects were installed.
  The session root keeps the previous captures' path length (`apkit-653-session`
  → `apkit-680-session`), so 60-column wrapping stays comparable.
- `PATH` contained controlled Codex/Claude version stubs and system tools; no
  real agent was started. The missing-agent scenario removed both stubs.
- Capture sets `PAGER=cat` so long `details` output lands in full scrollback
  instead of sitting in `less` on a PTY. CLI bytes and styling are unchanged.

## How to rerun

```sh
bun run docs/reviews/evidence/2026-09-24-terminal-recapture/prepare-candidate.ts /private/tmp/apkit-706-candidate

uv run --with pexpect --with pyte --with pillow python \
  docs/reviews/evidence/2026-09-24-terminal-recapture/capture-terminal-recapture.py

uv run --with playwright python \
  docs/reviews/evidence/2026-09-24-terminal-recapture/gallery-check/check-gallery.py
```

Run `prepare-candidate.ts` from a checkout whose tree is exactly the recorded
product revision, into a fresh, empty destination directory (the capture driver
reads that same path). The capture driver is committed beside the evidence as
raw provenance
([`capture-terminal-recapture.py`](evidence/2026-09-24-terminal-recapture/capture-terminal-recapture.py)
and [`prepare-candidate.ts`](evidence/2026-09-24-terminal-recapture/prepare-candidate.ts)),
adapted from the 2026-09-23 pair: `--agent` and `apkit list agents` (D1), the
rewritten install prompts, the guided Profile-creation screens, and full
per-frame labels.

## Evidence and rendering

Open the rendered gallery in **both palettes**:

- [Dark + light toggle](evidence/2026-09-24-terminal-recapture/index.html)
- [Dark only](evidence/2026-09-24-terminal-recapture/index-dark.html)
- [Light only](evidence/2026-09-24-terminal-recapture/index-light.html)

**72 frames** at both widths — every screen of the 2026-09-23 capture plus the
guided Profile-creation screens and the `apkit new context` receipt. The `.ansi`
files are raw PTY output; pyte interpreted wrapping, cursor movement, erasure
and SGR styling as bytes arrived; frames were captured at prompt pauses and
command exit. `.txt` files expose each frame's terminal cells. `frames.json`
indexes the frames and `runs.json` records every command, isolated HOME and
exit. All command exits matched their scenario's expected status (including the
refused inputs, the declined install, the keyboard cancellation and the partial
uninstall).

### Label changes (old → new)

The three labels that still said "host" — plus the two further labels that
matched the same rule — are renamed so the re-review never reads D1's retired
word. Frame-by-frame comparison with the 2026-09-23 gallery uses this table.
This refresh (the `60f3dd8` capture) renames no labels; its 36 labels are the
2026-09-24 names below.

| 2026-09-23 label | 2026-09-24 label |
| --- | --- |
| `11-selection-host-picker` | `11-selection-agent-picker` |
| `11-selection-filtered-host` | `11-selection-filtered-agent` |
| `17-host-missing-warning` | `17-agent-missing-warning` |
| `19-list-hosts` | `19-list-agents` |
| `20-narrow-wrap-command-host-picker` | `20-narrow-wrap-command-agent-picker` |

Every other label is unchanged (`01-first-use`, `02-setup-confirmation`,
`02-setup`, `05-first-install`, `06-routine`, `07-status`, `08-validate`,
`09-failure`, `10-invalid-target`, `11-selection-profile-picker`,
`11-selection-install-confirmation`, `11-selection`, `12-fleet-inventory`,
`13-fleet-status`, `14-fleet-update`, `15-details-list`, `16-details`,
`18-setup-routing-with-profiles-confirmation`, `18-setup-routing-with-profiles`,
`20-narrow-wrap-command-profile-picker`, `20-narrow-wrap-command-confirmation`,
`20-narrow-wrap-command`, `21-details-partial`, `21b-details-partial`).
New labels: `P1-new-profile-empty`, `P2-new-profile-name`,
`P3-new-profile-context`, `P4-new-profile-skills`, `P5-new-profile-created`,
`P5b-new-profile-cancel`, `P6-new-context`.

### Frame index (100-column IDs; the 60-column twin shares the label)

| ID | Label | State |
| --- | --- | --- |
| `01` | `01-first-use` | First-use guidance (re-review screen 01) |
| `02` | `02-setup-confirmation` | Setup confirmation (screen 02) |
| `03` | `02-setup` | Setup receipt, 0-Profile routing (screen 03) |
| `04` | `P1-new-profile-empty` | Guided creation with no Context or Skills (P1) |
| `05` | `P6-new-context` | `apkit new context` receipt (P6) |
| `06` | `P2-new-profile-name` | Guided name prompt (P2) |
| `07` | `P3-new-profile-context` | Guided Context picker, toggled (P3) |
| `08` | `P4-new-profile-skills` | Guided Skills picker (P4) |
| `09` | `P5-new-profile-created` | Guided receipt: Context + Skills (P5) |
| `10` | `P5b-new-profile-cancel` | Keyboard cancellation, nothing written |
| `11` | `05-first-install` | Install receipt (screen 04) |
| `12` | `06-routine` | Clean no-op update (screen 05) |
| `13` | `07-status` | Status (screen 06) |
| `14` | `08-validate` | Validation (screen 07) |
| `15` | `09-failure` | Unknown Profile + suggestion (screen 08) |
| `16` | `10-invalid-target` | Missing Project folder (screen 09) |
| `17` | `11-selection-profile-picker` | Profile picker (screen 10) |
| `18` | `11-selection-agent-picker` | Agent picker, detected preselection (screen 11) |
| `19` | `11-selection-filtered-agent` | Filtered multi-select (screen 12) |
| `20` | `11-selection-install-confirmation` | `Install now? (y/N)` (screen 13) |
| `21` | `11-selection` | Decline / neutral cancellation (screen 14) |
| `22` | `12-fleet-inventory` | `list projects` (screen 15) |
| `23` | `13-fleet-status` | Fleet status (screen 06/16) |
| `24` | `14-fleet-update` | Update that changed files (screen 17) |
| `25` | `15-details-list` | Recent runs (screen 18) |
| `26` | `16-details` | One run's details (screen 19) |
| `27` | `18-setup-routing-with-profiles-confirmation` | Complete-Workspace confirmation (screen 20) |
| `28` | `18-setup-routing-with-profiles` | Complete-Workspace receipt (screen 21) |
| `29` | `19-list-agents` | Agent inventory (screen 22) |
| `30` | `20-narrow-wrap-command-profile-picker` | Guided install under HOME |
| `31` | `20-narrow-wrap-command-agent-picker` | Agent picker (screen 11/12 twin) |
| `32` | `20-narrow-wrap-command-confirmation` | Confirmation (screen 13 twin) |
| `33` | `20-narrow-wrap-command` | Receipt with `~/'proj/alpha'` quoting (screen 26) |
| `34` | `17-agent-missing-warning` | Missing-agent warnings (screen 27) |
| `35` | `21-details-partial` | Partial uninstall outcome (screen 28) |
| `36` | `21b-details-partial` | Its details (screen 29) |

60-column twins: `37`–`72` in the same order (e.g. `69-60-20-narrow-wrap-command`).

## Principal-notes map

Each item of the unedited notes block in the
[re-review](2026-09-23-terminal-rereview.md) maps to the frames that show it.
Frame IDs are 100-column; the 60-column twin shares the label.

| Principal note | Frames showing the correction |
| --- | --- |
| Deliberate spacing, relaxed design, no walls of text (general) | `01`, `03`, `11`, `26`, `35` — blank line between headline, what happened, what to know, what to do; `03`'s three concept paragraphs read as separate blocks |
| Casual, friendlier, simpler language (general) | `12` (`Everything is already up to date.`), `14` (`Your Workspace looks good`), `15` (`There's no Profile called 'enginering'.` / `Did you mean`), `24` (`Updated 4 Projects (7 files)`), `26` (`Update op-… succeeded`) |
| "Host" is our word; customer-facing should say "agent" | `03` (`Agents found: claude, codex`), `18`/`19` (`Which agents?`), `29` (`apkit list agents`), `34` (agent-missing warnings), `33` (`--agent` flags in the printed equivalent command), `11`/`28` (`Agents:` rows) |
| No screens for creating a Profile; new users need guidance | `04` (P1 empty-Workspace guidance), `06`–`09` (P2–P5 guided creation), `10` (cancellation), `05` (P6 `new context` → `apkit new profile`) |
| Note 01 — first use concise; what the Workspace holds; where to run init | `01` (Workspace sentence, one Workspace for all Projects, `apkit init <path>` / `apkit init .`, `apkit --help`) |
| Notes 02/03 — drop the settings config line; explain Profiles, Skills, Context; agents found; next step | `02`, `03` (no settings path; three concept paragraphs; `Agents found:`; `apkit new profile` next), `28` (≥1 Profiles: no concepts, `apkit install` next) |
| Note 04 — install receipt; is `Details:` needed after success? | `11`, `33` (no `Details:` on success — D4), `34`, `35` (`Details:` with a note where something went wrong) |

## Decisions map

| Decision | Frames showing the decision |
| --- | --- |
| **D1** — "agent" on screen and in commands | `03`, `18`, `19`, `21`, `29`, `31`, `32`, `33`, `34` — `Which agents?`, `apkit list agents`, `--agent` in the printed equivalent command, `Agents:` rows, agent-missing warnings. The three labels that said "host" — and the two further labels matching the same rule — are renamed (table above) |
| **D2** — three concepts on setup | `03` — Profiles, Skills and Context paragraphs on one screen (the limit of two is relaxed here only) |
| **D3** — guided `apkit new profile` (P1–P5) | `04` (P1 empty Workspace), `06` (P2 name), `07` (P3 Context picker), `08` (P4 Skills picker), `09` (P5 receipt naming Context and Skills), `10` (cancellation), `05` (P6 `new context` receipt pointing back at `apkit new profile`) |
| **D4** — `Details:` only when something went wrong | Absent on `11`, `12`, `21`, `24`, `26`, `33` (normal successes and the neutral cancellation). Present with a short note on `34` (warning — `see exactly what this run checked`), `35` (partial run — `see exactly what changed`) |
| **D5** — one start-folder line plus per-agent steps | `11` and `33` — `Start your agents from this Project folder, not a subfolder.` for every agent, then one Codex line (`Codex: approve the SessionStart hook when asked, and trust this project.` since #701); agents with nothing extra (Claude) have no line of their own |
| **D6** — never hide just one Project | `34`, `70` — `Used by:` lists four Projects for Claude and five for Codex in full (the 10-Project limit was not reached in this fixture) |

## What changed since 414763a

No product code was changed for this ticket — #706 is docs and evidence only.
#699 (PR #702, merged as `e8af13e`) corrected the second spec acceptance
audit's gap 1; #700 (PR #703, merged as `8e76349`) gaps 2 and 3; #701 (PR
#705, merged as `60f3dd8`) gaps 4 and 5. This section proves what moved on
screen from the frame diff of this capture against the committed 414763a
evidence: same 36 labels, same frame IDs, the session root kept at the exact
previous path so every path string compares one to one. Everything the first
two captures' #690 and #693 corrections established stays fixed (the frames
that proved them are byte-identical or changed only as named below).

### Corrections proven in frames

- **One blank line before every live prompt question (US-001/DEC-002, #699
  gap 1).** The frames the audit named, at both widths (`02`/`38`, `06`/`42`,
  `07`/`43`, `08`/`44`, `17`/`53`, `18`/`54`, `19`/`55`, `20`/`56`, `27`/`63`,
  `30`/`66`, `31`/`67`, `32`/`68`): each live `❯` question now stands one blank
  line below the text before it — `❯ Set up this folder…` under the setup file
  list, `❯ Name your Profile` under the Profile explanation, `❯ Which
  Context?` and `❯ Which Skills?` under their one-line concept notes, `❯ Which
  Profile?`, `❯ Which agents?` and `❯ Install now? (y/N)` under the install
  document (proposed screen 13), and `❯ Use this folder…` under the
  complete-Workspace note. The settled line keeps the question's position, so
  the decline frame (`21`, `57`) and the accepted install receipt (`33`, `69`)
  now read `✔ Agents › claude, codex`, a blank line, then `●/✔ Install now?
  (y/N) …` — no layout jump when the answer settles. Every settled screen the
  rule does not touch keeps its 414763a bytes (`03`, `09`, `10`, `28` / `39`,
  `45`, `46`, `64` among them).
- **`install` into a missing folder now reads like `update` and `uninstall`
  (US-007, #700 gap 2).** Frames `16`, `52`: `✖ The folder <path> doesn't
  exist.` / `Create it first, or pick a folder that exists.` replaces `✖
  Project target '<path>' must be an existing directory` / `Create it or pass
  an existing Project directory.`
- **The install receipt's Codex setup step in plain words (US-001/US-005,
  #701).** Frames `11`, `47`, `33`, `69`: `- Codex: approve the SessionStart
  hook when asked, and trust this project.` (proposed screens 04/26 exactly)
  replaces `- Codex: Review and approve the generated SessionStart hook when
  Codex asks; Trust the bound project in Codex.`. The start-folder line
  (`Start your agents from this Project folder, not a subfolder.`) is
  unchanged.

### Corrections this journey does not exercise

The journey proves these #700/#701 corrections with tests, not frames — the
screens they fix are not among the 36 labels (and were not at 414763a either):

- **"Host" in runtime remedies (gap 3).** No agent's `--version` fails in this
  journey: the stubs report versions on every `update`, and the missing-agent
  scenario (`34`, `70`) removes both stubs, taking the missing-executable path
  whose wording was already "agent" (byte-identical since 414763a). The
  newcomer Host→agent substitution on the update, install and `apkit details`
  surfaces leaves no frame delta either — `14-fleet-update` (`24`, `60`) is
  byte-identical and the details frames change only by the run-local values
  below. Pinned by `test/agent-wording.test.ts`.
- **#701's other human surfaces** — the update/apply `First use:` lines and
  the verbose `Agent setup:` sections. The journey's one changed update (`24`,
  `60`) re-delivers Context only and prints no `First use:` lines; byte-
  identical. Pinned by `test/host-setup-steps-machine-pin.test.ts` and the
  golden snapshots.

### Full label delta (frame diff at both widths)

**Changed — 16 labels.** One blank line before the live question (#699 gap 1):
`02-setup-confirmation`, `P2-new-profile-name`, `P3-new-profile-context`,
`P4-new-profile-skills`, `11-selection-profile-picker`,
`11-selection-agent-picker`, `11-selection-filtered-agent`,
`11-selection-install-confirmation`,
`18-setup-routing-with-profiles-confirmation`,
`20-narrow-wrap-command-profile-picker`, `20-narrow-wrap-command-agent-picker`,
`20-narrow-wrap-command-confirmation`. Settled confirm keeping the question's
position (#699): `11-selection`. Missing-folder wording (#700 gap 2):
`10-invalid-target`. Plain Codex setup-step line (#701): `05-first-install`.
Both #699's settled-confirm blank and #701's setup-step line:
`20-narrow-wrap-command`.

**Changed only in run-local values — 2 labels.** `16-details` (the local human
time of day) and `21b-details-partial` (the local human time and the raw
`mkdtemp` suffix inside the unchanged `EACCES` evidence kept in details).

**Unchanged — 18 labels.** `01-first-use`, `02-setup`, `P1-new-profile-empty`,
`P6-new-context`, `P5-new-profile-created`, `P5b-new-profile-cancel`,
`06-routine`, `07-status`, `08-validate`, `09-failure`, `12-fleet-inventory`,
`13-fleet-status`, `14-fleet-update`, `15-details-list`,
`18-setup-routing-with-profiles`, `19-list-agents`, `17-agent-missing-warning`,
`21-details-partial` — byte-identical to the committed frames. The settled
screens `02-setup`, `P5-new-profile-created` and `P5b-new-profile-cancel` keep
their bytes because the #699 separator blank is byte-identical to the #693
fresh-part blank there; `17-agent-missing-warning` and `21-details-partial`
confirm #700's remedy rewords never reach these screens.

### New defects

**None found.** Every changed frame's delta is one of the #699–#701 corrections
above or a run-local value; every other frame is byte-identical, and the
browser check reports one terminal row per line with a working Dark/Light
toggle on all 72 frames.

## Observations (not gated; disposition at the principal's or orchestrator's call)

Still true at `60f3dd8` — the frames that show each are byte-identical since
414763a (or, for the name-prompt and soft-wrap ones, changed only by the
corrections above); #690's, #693's and this capture's "not included" lists keep
each one deliberate or settled.

- **`validate` still prints `Settings: ~/.agents/agent-profile-kit/config.yaml`**
  (frame `14`) where proposed screen 07 omits it. Deliberate:
  `cli/presentation.ts` `validationResultDocument` documents that the one
  remaining hand edit (OOS-003) needs that path. The notes' request was applied
  to setup (`02`, `03`).
- **Missing-agent warnings name `Claude`** (frames `34`, `70`) where proposed
  screen 27 says `Claude Code`. The one name home
  (`adapters/host-catalog.ts` `displayName`) is "Claude".
- **`list agents` lists alphabetically** (frame `29`: antigravity, claude,
  codex, …) where proposed screen 22 lists detected agents first, matching the
  picker's order (frame `18`).
- **The live name prompt is a two-line widget** (`❯ Name your Profile` /
  `❯ engineering`, frame `06`) rather than the mockup's single
  `❯ Name your Profile › engineering` line. The settled form
  (`✔ Name › engineering`) matches. The prompt tests pin the settled form and
  forbid the inline `›` form on the live question (`test/prompts.test.ts`).
- **Dark-palette contrast nit carried forward:** muted and error inks sit below
  4.5:1 against the dark frame background (palette unchanged). Meaning never
  depends on color alone.
- **Terminal soft wrap at 60 columns** splits `--agent` across rows in the
  printed equivalent command (frame `69`); the application bytes keep `--agent`
  and `~/'proj/alpha'` intact (US-009 allows terminal soft wrapping).

## Gallery check (real browser)

[`gallery-check/check-gallery.py`](evidence/2026-09-24-terminal-recapture/gallery-check/check-gallery.py)
opens `index.html` in headless Chromium (Playwright) and asserts from real
layout — not from the HTML source:

- **One terminal row per line.** For all 72 frames: `white-space: pre`; the
  text row count equals the terminal row count of the frame's `.txt` cells
  (joined rows would drop newlines); the rendered block height equals
  rows × line-height + padding + border (a wrapped row would make it taller).
  850 rows checked, zero mismatches.
- **Dark/Light toggle switches the frames.** Default renders dark; the Light
  button sets the palette, flips the page background to `#f4f4f4`, hides the
  dark frames and shows the light ones; the Dark button restores the inverse.
- Evidence: [`gallery-check.json`](evidence/2026-09-24-terminal-recapture/gallery-check/gallery-check.json)
  (machine-readable result), toggle stills `gallery-dark-toggle.png` /
  `gallery-light-toggle.png`, and per-frame close-ups in both palettes under
  [`gallery-check/`](evidence/2026-09-24-terminal-recapture/gallery-check/).

Representative dark/light stills rendered from the captured cells also live
under [`images/`](evidence/2026-09-24-terminal-recapture/images/)
(`images.json` indexes them). Picker redraws were inspected from the raw byte
streams again
([`picker-redraw-findings.json`](evidence/2026-09-24-terminal-recapture/picker-redraw-findings.json)):
the settled `›` filter line appears, the old `Filtered results for:` label and
the Instructions block are absent, redraws use line-erase and cursor-up (not
full-screen clears), and the cursor is restored wherever hidden — including the
new guided pickers.

## Principal review

Review both widths and both palettes for readability, styling, scope clarity and
progressive disclosure. The screen map above links every proposed screen
(01–29, P1–P6) to its frame; the label-change table keeps the 2026-09-23
comparison one to one. Since 414763a the blank line before every live prompt
question (#699), the missing-folder wording on `install` (#700) and the plain
Codex setup-step line on the install receipt (#701) changed (each proven in
the frames named above); the rest of the gallery is byte-identical, the #690
and #693 corrections included. Disposition the remaining observations, and
record the acceptance decision on #519. **#519 and #491 stay open until the
principal decides** (TEST-006, OOS-005).
