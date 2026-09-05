import { readFileSync } from "node:fs";

/**
 * Boundary parser for Bun Snapshot v1 files (the committed golden baseline
 * corpus). Format, verified against this repository's snapshot file: each
 * entry is `exports[\`<key>\`] = \`` followed by the body wrapped in double
 * quotes, terminated by a bare `"` (or a content line ending in `"`) and a
 * `` `; `` line. Content escapes are template-literal escapes (`\X` for the
 * characters Bun escapes); content cannot contain an unescaped backtick, so
 * a line that is exactly `` `; `` unambiguously terminates an entry.
 */

const HEADER = /^exports\[`(.+)`\] = `$/;

export function readSnapshotBodies(path: string | URL): Map<string, string> {
  const bodies = new Map<string, string>();
  const lines = readFileSync(path, "utf8").split("\n");
  let index = 0;
  while (index < lines.length) {
    const header = lines[index]?.match(HEADER);
    if (header === null || header === undefined || header[1] === undefined) {
      index += 1;
      continue;
    }
    const key = header[1];
    const terminator = lines.indexOf("`;", index + 1);
    if (terminator < 0) {
      throw new Error(`snapshot file ${path}: unterminated entry for ${JSON.stringify(key)}`);
    }
    const quoteLine = lines[terminator - 1] ?? "";
    if (!quoteLine.endsWith('"')) {
      throw new Error(`snapshot file ${path}: malformed entry for ${JSON.stringify(key)}`);
    }
    // Body spans the lines between the header and the closing quote. The
    // first body line opens with the wrapper quote; the closing quote is
    // glued to the final content line unless the content ended with its own
    // newline (then the quote sits on its own line).
    let content = lines.slice(index + 1, terminator).join("\n");
    if (!content.startsWith('"')) {
      throw new Error(`snapshot file ${path}: unquoted body for ${JSON.stringify(key)}`);
    }
    content = content.slice(1);
    if (content.endsWith('"')) content = content.slice(0, -1);
    bodies.set(key, unescapeSnapshotContent(content));
    index = terminator + 1;
  }
  return bodies;
}

/** Bun escapes only what a template literal requires: `\`, backtick, `${`. */
function unescapeSnapshotContent(content: string): string {
  return content.replace(/\\(.)/g, (_, character: string) => character);
}