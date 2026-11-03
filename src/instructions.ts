// Pure text edits for the two instruction files apkit touches: the marked
// Context block in AGENTS.md and the `@AGENTS.md` import line in CLAUDE.md.
// Line endings follow the file being edited, so Windows files stay CRLF.
// Each removal is the exact inverse of its insertion, so the user's bytes come back.
import { createHash } from "node:crypto";

/** Marker names: `apkit` for a project block and the setup note, `apkit:global` for user-level Context. */
export type Marker = "apkit" | "apkit:global";

/** `tag` is "" or " <8 hex>": a body that holds its own end marker gets a frame it cannot end early. */
const begin = (marker: Marker, tag: string) => `<!-- ${marker}:begin${tag} -->`;
const end = (marker: Marker, tag: string) => `<!-- ${marker}:end${tag} -->`;
const blockPattern = (marker: Marker) =>
  new RegExp(`<!-- ${marker}:begin( [0-9a-f]{8})? -->\\r?\\n([\\s\\S]*?)<!-- ${marker}:end\\1 -->(\\r?\\n)?`);
const IMPORT_LINE = /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*\r?$/m;
const IMPORT_WITH_EOL = /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*(?:\r?\n|$)/m;

export function eolOf(text: string | null): string {
  return text !== null && text.includes("\r\n") ? "\r\n" : "\n";
}

function withEol(text: string, eol: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
}

/** Adds `addition` on a line of its own: one line ending after any text. */
function append(text: string, addition: string, eol: string): string {
  return text === "" ? addition : text + eol + addition;
}

/** Removes `length` characters at `index` and the one line ending `append` put before them. */
function cut(text: string, index: number, length: number): string {
  const start = text.startsWith("\r\n", index - 2) ? index - 2 : text[index - 1] === "\n" ? index - 1 : index;
  return text.slice(0, start) + text.slice(index + length);
}

/** The block body (LF line endings), or null when the file has no block. */
export function readBlock(text: string, marker: Marker = "apkit"): string | null {
  const match = blockPattern(marker).exec(text);
  return match === null ? null : (match[2] ?? "").replace(/\r\n/g, "\n");
}

/** Inserts, replaces, or (with body null) removes the block. */
export function writeBlock(text: string | null, body: string | null, marker: Marker = "apkit"): string {
  const current = text ?? "";
  const eol = eolOf(text);
  const match = blockPattern(marker).exec(current);
  if (body === null) return match === null ? current : cut(current, match.index, match[0].length);
  const tag = body.includes(`<!-- ${marker}:end`) ? ` ${createHash("sha256").update(body).digest("hex").slice(0, 8)}` : "";
  const block = withEol(`${begin(marker, tag)}\n${body}${end(marker, tag)}\n`, eol);
  if (match !== null) {
    return current.slice(0, match.index) + block + current.slice(match.index + match[0].length);
  }
  return append(current, block, eol);
}

export function hasClaudeImport(text: string): boolean {
  return IMPORT_LINE.test(text);
}

export function addClaudeImport(text: string): string {
  const eol = eolOf(text);
  return append(text, `@AGENTS.md${eol}`, eol);
}

export function removeClaudeImport(text: string): string {
  const match = IMPORT_WITH_EOL.exec(text);
  return match === null ? text : cut(text, match.index, match[0].length);
}
