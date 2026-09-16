---
status: accepted
---

# Render guide content as terminal content with verbatim copyable code

## Context

Guide output rendered raw markdown into the terminal: literal `#` heading
prefixes, `**bold**` markers, and ` ```yaml `/` ```sh ` code fences (#510,
US-016, DEC-011; review finding S12). At narrow widths the complete human guide
overflowed the presentation measure — its verbatim file body is never wrapped,
so a 60-column terminal soft-wrapped prose mid-word. The focused guides carried
the same decoration around their examples. The agent workflow reference
(`guide --agent`) serves a different consumer — an assisting agent — for whom
markdown structure is information, not decoration.

## Decision

1. **One rendering-policy home.** `cli/guide-markdown.ts` owns how guide
   markdown renders as terminal content. ATX headings render through heading
   nodes without the `#` prefix; paragraphs and bullet items (with
   hanging-indent continuation lines) render as wrapping sentence nodes with
   bold markers stripped outside code spans; the one pipe table renders
   through the existing responsive row-group policy, falling back to verbatim
   when a table does not fit the row model; fenced code blocks render as
   verbatim nodes with the delimiters removed. The complete human guide
   (`guide --full`) flows through this home. Unsupported markdown constructs
   fail loudly instead of being dropped or mangled — silent degradation of
   documentation survives review precisely because nothing errors.
2. **Verbatim code is the copyability rule.** Code bodies are reproduced
   exactly — never wrapped, never styled, never fence-quoted — so a copyable
   command stays one whole line at every terminal width.
3. **Focused guides author through the same shapers.** `cli/guides.ts`
   composes focused guide headings and example bodies through the shared
   heading and code-block nodes; no second rendering path exists.
4. **The agent reference stays raw markdown.** `guide --agent` reproduces
   `docs/guides/agent-workflow.md` byte-exactly (the pre-existing verbatim
   document policy). Markdown structure is information to its agent consumer.
5. **Machine surfaces unchanged.** Rendering is human-only: no `--json`
   payload, typed fact, or exit code changes (DEC-009), and paging behavior is
   unchanged — long interactive guidance still pages, redirected output never
   pages.

## Consequences

- Guide terminal output is readable at normal and narrow widths, and prose
  wraps at the presentation measure through the existing pipeline (ADR-0016).
- A future guide edit that uses an unsupported markdown construct fails
  loudly at the command instead of silently degrading.
- This decision operates entirely inside the presentation-document pipeline;
  it changes no semantic report data and introduces no second output path.
