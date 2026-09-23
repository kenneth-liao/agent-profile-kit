# Rendered terminal evidence — 2026-09-23 recapture

Prepared for #653 (TEST-006) to support the affected visual re-review on #519
under parent spec #640. **Principal acceptance stays on #519.** This report
does not accept, disposition, or close #519 or #491.

## Provenance

- Product: Agent Profile Kit **0.229.0**, revision
  [`35e1708`](https://github.com/kenneth-liao/agent-profile-kit/commit/35e1708bdd6e6d25cb66557dc504a1875ce75e10)
  (origin/main after #641–#652).
- Package created with `scripts/create-package-candidate.ts`; extracted through
  `extractPackageArchive`, which verifies the identity record against the
  archive bytes. Identity summary:
  [`candidate-identity.json`](evidence/2026-09-23-terminal-recapture/candidate-identity.json).
- Archive SHA-256:
  `3e8b140f7cee9b6f28dec301d61465b5d4a42ded265e774552a072615995d712`.
- Runtime: Node v22.23.2 (`/opt/homebrew/opt/node@22/bin/node`, spawned as an
  absolute path; node@22 is never exported onto `PATH`); build: Bun 1.4.0.
- Real PTYs: 100×24 and 60×24, `TERM=xterm-256color`, driven by pexpect.
  Each expected prompt/exit had a 12-second timeout and owned-child cleanup.
- Each width used its own disposable HOME and XDG directories under
  `/private/tmp/apkit-653-session/`. Only fixture Projects were installed.
- `PATH` contained controlled Codex/Claude version stubs and system tools;
  no real Host was started. The missing-Host scenario removed both stubs.
- Capture sets `PAGER=cat` so long `details` output lands in full scrollback
  instead of sitting in `less` on a PTY. CLI bytes and styling are unchanged.

## How to rerun

```sh
bun run docs/reviews/evidence/2026-09-23-terminal-recapture/prepare-candidate.ts /private/tmp/apkit-653-candidate

uv run --with pexpect --with pyte --with pillow python \
  docs/reviews/evidence/2026-09-23-terminal-recapture/capture-terminal-recapture.py
```

The capture driver is committed beside the evidence as raw provenance
([`capture-terminal-recapture.py`](evidence/2026-09-23-terminal-recapture/capture-terminal-recapture.py)
and [`prepare-candidate.ts`](evidence/2026-09-23-terminal-recapture/prepare-candidate.ts)).

## Evidence and rendering

Open the rendered gallery in **both palettes**:

- [Dark + light toggle](evidence/2026-09-23-terminal-recapture/index.html)
- [Dark only](evidence/2026-09-23-terminal-recapture/index-dark.html)
- [Light only](evidence/2026-09-23-terminal-recapture/index-light.html)

**58 frames** at both widths. Labels `01`–`17` keep the 0.217.1 scenario set
and numbering wherever the scenario still exists, so the principal can compare
frame by frame with the previous gallery. New labels `18`–`21` cover the states
this spec affects.

| Label | State |
| --- | --- |
| `01-first-use` | First-use guidance and concept sentences (US-001) |
| `02-setup` | Setup confirmation + receipt, 0-Profile routing (US-002) |
| `05-first-install` | Install receipt, First use / SessionStart, optional check (US-006/012) |
| `06-routine` | Clean no-op update, no details hint (US-010) |
| `07-status` | Workspace + checked-Project rows (US-007) |
| `08-validate` | Validation |
| `09-failure` | Unknown Profile failure + suggestions (US-003) |
| `10-invalid-target` | Missing Project target |
| `11-selection` | Profile picker, detected-Host preselection, filtered multi-select, confirmation, **neutral cancellation** (US-003/004/005) |
| `12-fleet-inventory` | Project inventory |
| `13-fleet-status` | Fleet status rows |
| `14-fleet-update` | Fleet update |
| `15-details-list` | History rows, compact UTC time (US-008) |
| `16-details` | Operation details, exact timestamps, Written (US-008) |
| `17-host-missing-warning` | Missing-Host warnings naming Project view identity (US-011) |
| `18-setup-routing-with-profiles` | Setup routing with ≥1 Profiles → `apkit install` (US-002) |
| `19-list-hosts` | Host inventory (see product defect A) |
| `20-narrow-wrap-command` | Guided install under HOME; `~/'proj/alpha'` quoting at both widths (US-009) |
| `21-details-partial` / `21b-details-partial` | Partial uninstall outcome and its details (US-008) |

The `.ansi` files are raw PTY output. pyte interpreted wrapping, cursor
movement, erasure and SGR styling as bytes arrived; frames were captured at
prompt pauses and command exit. `.txt` files expose each frame's terminal
cells. `frames.json` indexes the frames and `runs.json` records every command,
isolated HOME and exit. All command exits matched their scenario's expected
status (including refused input, declined installation and the partial
uninstall).

Representative stills in both palettes live under
[`images/`](evidence/2026-09-23-terminal-recapture/images/) (`images.json`
indexes them).

## #640 source-finding map

Each row of the #640 ownership table maps to the frames that now show the
correction. Frame IDs are the 100-column gallery; the 60-column twin shares
the label.

| #640 findings | Requirements | Frames showing the correction |
| --- | --- | --- |
| X1, R1, SC1, PD1 | US-001; DEC-003 | `01`, `02`, `03`, `10`, `11`, `13` — Workspace/Project/Profile/Context/Agent Host explained at the action that needs them; Skill never defined |
| R2, R3, SC2, PD2 | US-002; DEC-005 | `03` (settings path `~/.agents/agent-profile-kit/config.yaml`, 0-Profile route `new context` then `new profile`), `21` (≥1 Profiles routes to `apkit install` with no Profile named) |
| X2, S1, S2, R5 | US-003; DEC-001/002 | `01`, `03`, `04`, `08`, `14` — shared glyphs/headlines; remedies and suggestions in default color; success/warning/error reserved for state |
| X3, R7, S3, PD3 | US-004 | `10`, `11`, `12` — one picker chrome: `❯`, `◻`/`◼`, one `›`-separated hint, settled `›` filter line, no Instructions block |
| SC7, detected-Host mockup | US-005; DEC-004 | `11`, `24` — detected Hosts first, annotated `detected` / `not found`, preselected; “Selecting a Host does not install it.” |
| R4, R8, SC3, SC4 | US-006, US-012 | `04`, `13`, `23`, `25`, `26` — stable home-relative/absolute Project path in confirmation and receipt; First use + optional loading check |
| SC5, PD8 | US-007 | `06`, `16`, `35`, `45` — status names the Workspace and one row per checked Project (Project, Primary Cause) |
| R10, R11 | US-008 | `15`, `18`, `19`, `29` — labeled rows / stacked records; compact history time; details exact timestamps and Written/Failed/Skipped/Pending |
| X5, S7 | US-009 | `26`, `55` — command on its own line; `~/'proj/alpha'` intact in emitted bytes; terminal soft wrap only at the physical width |
| X4, R9, PD5 | US-010 | `05` (clean no-op, no details hint), `14` (neutral cancel, one `●` statement), `04`/`26` (one footer with Next + Details) |
| R13, SC6, PD7 | US-011 | `27`, `56` — one `⚠` line per missing Host; identical remedies not merged across Hosts; see product defect B |
| PD4; required-handoff coverage gap | US-012 | `04`, `26` — required Adapter-authored Host Setup Steps under `First use:` including the Codex SessionStart hook; optional loading check names the stable path |
| X6, R6, R12, S4–S6, PD6 | Optional polish (OOS-005) | `01` (banner retained), `08` (error glyph), `29` (single `Time` line when start/end match at second precision) — nits only, not gates |

## Extra qualification

### Picker movement and redraws

Inspected the raw selection byte streams
(`100-11-selection.ansi`, `60-11-selection.ansi`; summary in
[`picker-redraw-findings.json`](evidence/2026-09-23-terminal-recapture/picker-redraw-findings.json)).

- Filter resolution settles on the `›` line (`› cod`); the old
  `Filtered results for:` label and the Instructions block are absent.
- Redraws use line-erase (`EL` / `ESC[2K`) and cursor-up (`CUU` / `ESC[1A`)
  with column home (`CR`), not full-screen clears. No leftover rows were
  observed after filter or focus movement; the terminal cells after each
  redraw match the intended frame.
- The cursor is never hidden during redraw and is shown on prompt exit
  (`ESC[?25h` before the committed answer line).
- Focus `❯` and multi-select `◻`/`◼` are present; annotations sit beside the
  title and are excluded from filter matching (`detected` / `not found`).

### Light/dark readability

Representative frames were rasterized in both palettes under
[`images/`](evidence/2026-09-23-terminal-recapture/images/) and inspected.

- Light palette: default text, commands, success, warning and error inks are
  all ≥6:1 against the frame background. Readable.
- Dark palette: default text, commands, success and warning are readable
  (≥6:1). **Muted secondary text (`#666666`) is ~3.2:1 and error red
  (`#cd3131`) is ~3.6:1 against the dark frame background**, below WCAG AA
  4.5:1 for normal text. Meaning never depends on color alone (glyphs and
  wording carry state), so this is a readability nit rather than a
  correctness failure — worth a palette pass in optional polish.
- No meaning is lost at 60 columns in either palette; stacked rows and
  promoted commands remain distinguishable.

## Product defects

Recorded only; **not fixed in this change**. Turn these into tracked work.

### A — `list hosts` says `installed` where the picker says `detected`

- **Frames:** `22-100-19-list-hosts`, `51-60-19-list-hosts`
- **Contrast:** picker frames `11-100-11-selection-host-picker`,
  `40-60-11-selection-host-picker` annotate `detected` / `not found`.
- **Expectation (DEC-14 / #644):** detection marks use `detected`, never
  `installed` (ambiguous with Project installation).
- **Actual:** `cli/presentation.ts` `hostInventoryDocument` still emits
  `— installed` for detected Hosts on `apkit list hosts`.
- **Scope:** human inventory wording only.

### B — Missing-Host warning names one Project, not the affected set

- **Frames:** `27-100-17-host-missing-warning`, `56-60-17-host-missing-warning`
- **Expectation (US-011, DEC-23 / #652):** each missing-Host warning is its
  own `⚠` line naming the Projects (view identity) whose verification is
  affected.
- **Actual:** `installer/project-plan.ts` keeps one capability warning per
  Host per invocation (DEC-014) and ties keep the first Project in canonical
  order, so the line names a single Project even when several Projects select
  that Host. Affected scope is therefore hidden unless the user runs
  `--verbose`.
- **Note:** one warning per Host (no duplicate Host wording) matches DEC-23;
  the missing piece is the full affected-Project list on that one line.

## Capture notes

- `05-routine` is a clean no-op: one neutral statement, no details hint.
- `14-11-selection` decline is a single `●` statement with no `apkit:` prefix,
  no remedy and no details hint.
- Commands are emitted unbroken in the application bytes
  (`apkit install engineering ~/'proj/alpha' --host claude --host codex
  --auto-confirm`). At 60 columns the terminal soft-wraps `--host` at the
  physical width; US-009 allows terminal soft wrapping and forbids only
  application-inserted breaks inside atoms. `~/'proj/alpha'` stays intact.
- The partial details frame shows Written / Failed / Pending headings and one
  `Time` line when start and end share a second.

## Principal review

Review both widths and both palettes for readability, styling, scope clarity
and progressive disclosure. Record the explicit assessment on #519, citing
these frames and dispositioning every material #640 source finding (table
above). Subjective acceptance stays with the principal. Corrections belong to
their own implementation work and require affected re-review.

The newcomer task (#518) and setup-specific human qualification (#610) remain
separate obligations.
