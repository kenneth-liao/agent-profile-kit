---
status: accepted
---

# Replace the prompt dependency behind the shared seam

## Context

US-004 (spec #640, issue #643) requires one picker style: a common `❯` focus
marker on every prompt kind, `◻`/`◼` multi-select checkboxes, one concise
control hint that reflows at the terminal width without breaking words, and
visible filter and selection state with no Instructions block and no repeated
control text. The single prompt dependency in place since ADR-0034
(`prompts@2.4.2`) cannot deliver that chrome through any public seam.

Concrete blockers in `prompts@2.4.2`:

1. **Checkboxes are hard-coded `◉`/`◯`.** `figures.radioOn`/`radioOff` in
   `prompts/lib/util/figures.js` are module constants with no override API;
   `multiselect.js` and `autocompleteMultiselect.js` render from them.
2. **Multi rows carry no `❯` focus marker.** `select.js` and `autocomplete.js`
   use `figures.pointer` (`❯`), but `renderOption` in both multi-select
   elements marks the cursor with cyan underline only. Adding the shared
   focus marker would mean replacing those render methods.
3. **Confirm chrome is a different style** (`?` plus `(Y/n)`) with no shared
   focus marker and no theme or symbol hook.
4. The public surface is question fields only (`message`, `hint`, `choices`,
   `min`, `suggest`, `limit`, `instructions`). `instructions: false` can
   suppress the Instructions block and the seam can pre-wrap `hint`, but
   neither can satisfy (1)–(3). Overriding chrome would mean importing
   `prompts/lib/elements/*` or mutating `prompts/lib/util/figures.js` —
   private internals, not the existing prompt seam.

Amended OOS-004 allows replacing the single prompt dependency behind the
shared seam when it delivers a better US-004 experience, and forbids running
two prompt frameworks side by side.

## Decision

1. **`@inquirer/core` is the single prompt dependency**, replacing `prompts`
   and `@types/prompts` behind the unchanged `cli/prompts.ts` seam (DEC-035).
   It exposes the supported `createPrompt` extension API plus key helpers,
   injectable `input`/`output` streams and `AbortSignal` cancellation, and
   restores raw mode on settle. Exactly one prompt dependency remains.
2. **The seam owns the shared picker chrome.** Every glyph comes from
   `GLYPHS` in `cli/terminal-presentation.ts` (DEC-001): `❯` focus,
   `›` action separator, `◻`/`◼` multi-select checkboxes. One control hint
   reflows at the terminal width without breaking words. Filter text and
   selection state stay visible while filtering. There is no Instructions
   block and no repeated control text after filtering to one result. Confirm
   and text questions use the same `❯` marker. The line-based confirm keeps
   its y/yes answer contract and the single-key yes/no keeps `(y/N)` with
   default No (DEC-004).
3. **Stream lifecycle stays seam-owned.** Each question runs on a private
   carriage over the injected streams; the seam converts input end into the
   dependency's AbortSignal (its own EOF path never resolves), buffers early
   keystrokes until the first render registers handlers, and never lets the
   dependency close the caller's output. Cancellation on abort keystroke,
   input error, or ended input is unchanged.
4. **The multi-select seam stays #644-ready.** Choice order is the caller's
   order, `selected` carries the initial selection, and `annotation` is
   short per-choice evidence (for example "not found") that renders beside
   the title without joining filter matching. No detection or preselection
   is implemented here (#644 owns those).
5. **ADR-0034's dependency wording is superseded**; its prompt-seam,
   missing-choice, and explicit-operation contracts stand. The lockfile and
   `package.json` change is load-bearing review surface: the added transitive
   packages are `@inquirer/ansi`, `@inquirer/figures`, `@inquirer/type`,
   `cli-width`, `fast-wrap-ansi`, `fast-string-width`,
   `fast-string-truncated-width`, `mute-stream`, and `signal-exit`.

## Consequences

- Picker chrome is one renderer discipline rather than several dependency
  themes kept in sync, so a new prompt kind cannot silently diverge.
- The type-ahead race ADR-0034 recorded as a known limitation is narrowed:
  the seam applies a settled filter only when it is still current, so a
  stale resolve cannot replace a later keystroke's list.
- Qualification stays injectable prompt seams plus real-PTY tests at 100/60
  columns (TEST-002), covering searching, selection retained across
  filtering, keyboard navigation, a refused minimum-selection submit, and
  cancellation.
