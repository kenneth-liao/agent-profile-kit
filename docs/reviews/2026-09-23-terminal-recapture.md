# Rendered terminal evidence — 2026-09-23 recapture

Prepared for #653 (TEST-006) to support the affected visual re-review on #519
under parent spec #640. **Principal acceptance stays on #519.** This report
does not accept, disposition, or close #519 or #491.

## Provenance

- Product: Agent Profile Kit **0.229.2**, revision
  [`e241646`](https://github.com/kenneth-liao/agent-profile-kit/commit/e24164604465db1154c0f40f67df2c8ab685738a)
  (origin/main after the #668/#669 fixes, merged as PR #670 and PR #671). This
  is the post-fix recapture: the first capture (0.229.0 at
  [`35e1708`](https://github.com/kenneth-liao/agent-profile-kit/commit/35e1708bdd6e6d25cb66557dc504a1875ce75e10))
  found product defects A and B below; both are fixed on this revision and
  re-verified by this capture.
- Package created with `scripts/create-package-candidate.ts`; extracted through
  `extractPackageArchive`, which verifies the identity record against the
  archive bytes. The recorded candidate was created from a detached checkout
  of the revision above, so the identity record names the product revision.
  Identity summary:
  [`candidate-identity.json`](evidence/2026-09-23-terminal-recapture/candidate-identity.json).
- Archive SHA-256:
  `ded0579a55446a0bb4e003fb5b7c3c435f13eded0f34c8b113e34bb72c56ee84`.
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
| `19-list-hosts` | Host inventory (`detected` / `not found`, matching the picker — fixed by #669) |
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
| R13, SC6, PD7 | US-011 | `27`, `56` — one `⚠` line per missing Host; identical remedies not merged across Hosts; the line names the affected Projects (fixed by #668) |
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
  with column home (`CR`), not full-screen clears — 94 erase operations per
  selection stream in both widths. No leftover rows were
  observed after filter or focus movement; the terminal cells after each
  redraw match the intended frame.
- The cursor is never hidden during redraw and is shown on prompt exit
  (`ESC[?25h` before the committed answer line).
- Focus `❯` and multi-select `◻`/`◼` are present; annotations sit beside the
  title and are excluded from filter matching (`detected` / `not found`).
- Confirmed again on this recapture; summary in
  [`picker-redraw-findings.json`](evidence/2026-09-23-terminal-recapture/picker-redraw-findings.json)
  (settled filter observed, no old label, no Instructions block, cursor
  restored wherever hidden).

### Light/dark readability

Representative frames were rasterized in both palettes under
[`images/`](evidence/2026-09-23-terminal-recapture/images/) and inspected.

- Light palette: default text (17.4:1), muted (6.1:1), commands (6.4:1),
  success (6.6:1), warning (6.3:1) and error (6.5:1) inks are all ≥6:1
  against the white frame background. Readable.
- Dark palette: default text (14.6:1), success (7.4:1), warning (13.6:1) and
  commands — rendered in cyan `#11a8cd` (6.6:1) — are readable. **Muted
  secondary text (`#666666`, 3.2:1) and error red (`#cd3131`, 3.6:1) sit
  below WCAG AA 4.5:1 against the dark frame background**, as in the first
  capture (palette unchanged). Meaning never depends on color alone (glyphs
  and wording carry state), so this is a readability nit rather than a
  correctness failure — worth a palette pass in optional polish.
- No meaning is lost at 60 columns in either palette; stacked rows and
  promoted commands remain distinguishable.

## Product defects

The first capture (0.229.0 at `35e1708`) found two product defects inside
#640's scope. Both were recorded here, tracked as #668 and #669, fixed and
merged on main, and are **verified fixed by this recapture**. No new product
defects were found in this capture.

### A — `list hosts` said `installed` where the picker says `detected` — **fixed by #669 (PR #671)**

- **Frames:** `22-100-19-list-hosts`, `51-60-19-list-hosts`
- **Was:** `cli/presentation.ts` `hostInventoryDocument` emitted `— installed`
  for detected Hosts on `apkit list hosts`, while the picker frames
  (`11-100-11-selection-host-picker`, `40-60-11-selection-host-picker`)
  annotate `detected` / `not found` (DEC-14 / #644: detection marks never say
  `installed`).
- **Now:** both frames print `claude — detected` and `codex — detected`,
  matching the picker wording.

### B — Missing-Host warning named one Project, not the affected set — **fixed by #668 (PR #670)**

- **Frames:** `27-100-17-host-missing-warning`, `56-60-17-host-missing-warning`
- **Was:** `installer/project-plan.ts` kept one capability warning per Host
  per invocation (DEC-014) and ties kept the first Project in canonical order,
  so the `⚠` line named a single Project even when several Projects select
  that Host, hiding the affected scope unless the user ran `--verbose`.
- **Now (US-011, DEC-23 / #652):** each `⚠` line names the affected Projects —
  for example `(alpha, acme-internal-analytics-pipeline-v2, alpha/my-app,
  beta/my-app)`. The concise default view caps the rendered list at four
  Projects and, when more exist, appends an explicit counter with a remedy
  pointer (`… 1 more Project; use --verbose to see all Projects`); `--verbose`
  names every affected Project. One `⚠` line per Host (no duplicate Host
  wording) is unchanged, per DEC-23.

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
  `Time` line when start and end share a second. In this capture the `update`
  behind frame `19-100-16-details` also completed within one second, so that
  frame shows the single `Time` line too (the first capture's run straddled a
  second boundary and showed `Started` / `Finished`).
- Diffing this capture's frames against the first capture's shows changes
  only in the two fixed surfaces (frames `22`/`51` and `27`/`56`),
  timestamps, the single-`Time` line above, and random `mkdtemp` suffixes —
  no other CLI output changed.
- The driver fails fast when the evidence directory's committed
  `candidate-identity.json` does not name the candidate being captured, and
  republishes the identity record beside the frames after each run, so the
  committed provenance and the frames always come from the same archive.

## Principal review

Review both widths and both palettes for readability, styling, scope clarity
and progressive disclosure. Record the explicit assessment on #519, citing
these frames and dispositioning every material #640 source finding (table
above). Subjective acceptance stays with the principal. Corrections belong to
their own implementation work and require affected re-review.

The newcomer task (#518) and setup-specific human qualification (#610) remain
separate obligations.
