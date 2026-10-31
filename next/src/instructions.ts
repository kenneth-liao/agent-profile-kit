// Pure text edits for the two instruction files apkit touches: the marked
// Context block in AGENTS.md and the `@AGENTS.md` import line in CLAUDE.md.
// Line endings follow the file being edited, so Windows files stay CRLF.

/** Marker names: `apkit` for a project block and the setup note, `apkit:global` for user-level Context. */
export type Marker = "apkit" | "apkit:global";

const begin = (marker: Marker) => `<!-- ${marker}:begin -->`;
const end = (marker: Marker) => `<!-- ${marker}:end -->`;
const blockPattern = (marker: Marker) => new RegExp(`${begin(marker)}\\r?\\n([\\s\\S]*?)${end(marker)}(\\r?\\n)?`);
const IMPORT_LINE = /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*$/m;

export function eolOf(text: string | null): string {
  return text !== null && text.includes("\r\n") ? "\r\n" : "\n";
}

function withEol(text: string, eol: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, eol);
}

/** The block body (LF line endings), or null when the file has no block. */
export function readBlock(text: string, marker: Marker = "apkit"): string | null {
  const match = blockPattern(marker).exec(text);
  return match === null ? null : (match[1] ?? "").replace(/\r\n/g, "\n");
}

/** Inserts, replaces, or (with body null) removes the block. */
export function writeBlock(text: string | null, body: string | null, marker: Marker = "apkit"): string {
  const current = text ?? "";
  const eol = eolOf(text);
  const match = blockPattern(marker).exec(current);
  if (body === null) {
    if (match === null) return current;
    const before = current.slice(0, match.index).replace(/(\r?\n)+$/, eol);
    const after = current.slice(match.index + match[0].length);
    const joined = before + after;
    return joined.trim() === "" ? "" : joined.replace(/(\r?\n)+$/, eol);
  }
  const block = withEol(`${begin(marker)}\n${body}${end(marker)}\n`, eol);
  if (match !== null) {
    return current.slice(0, match.index) + block + current.slice(match.index + match[0].length);
  }
  if (current.trim() === "") return block;
  return current.replace(/(\r?\n)*$/, eol + eol) + block;
}

export function hasClaudeImport(text: string): boolean {
  return IMPORT_LINE.test(text);
}

export function addClaudeImport(text: string): string {
  const eol = eolOf(text);
  if (text.trim() === "") return `@AGENTS.md${eol}`;
  return text.replace(/(\r?\n)*$/, eol + eol) + `@AGENTS.md${eol}`;
}

export function removeClaudeImport(text: string): string {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => IMPORT_LINE.test(line));
  if (index === -1) return text;
  lines.splice(index, 1);
  const joined = lines.join(eol);
  return joined.trim() === "" ? "" : joined.replace(/(\r?\n)+$/, eol);
}
