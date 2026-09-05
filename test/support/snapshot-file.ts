import { readFileSync } from "node:fs";

/**
 * Boundary parser for Bun Snapshot v1 files (the committed golden baseline
 * corpus). Verified against Bun 1.3 serialization: each entry is
 * `exports[\`<key>\`] = \`` + body + `` `; ``, where the body is wrapped in
 * double quotes (possibly with a leading newline) and every backtick,
 * backslash, and `${` sequence inside it is escaped. Control characters are
 * serialized as hex escapes (`\x1B` for ESC). Content cannot contain an
 * unescaped backtick, so a single scan terminates each entry unambiguously.
 */

const ENTRY = /exports\[`((?:[^`\\]|\\.)*)`\] = `((?:[^`\\]|\\.)*)`;/g;

export function readSnapshotBodies(path: string | URL): Map<string, string> {
  const bodies = new Map<string, string>();
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(ENTRY)) {
    const key = unescapeSnapshotContent(match[1]!);
    // The body is wrapped in double quotes; the serializer separates the
    // wrapper from the entry delimiters with newlines on both sides.
    const body = match[2]!.replace(/^\n/, "").replace(/\n$/, "");
    if (!body.startsWith('"') || !body.endsWith('"')) {
      throw new Error(`snapshot file ${path}: unquoted body for ${JSON.stringify(key)}`);
    }
    bodies.set(key, unescapeSnapshotContent(body.slice(1, -1)));
  }
  if (source.includes("exports[`") && bodies.size === 0) {
    throw new Error(`snapshot file ${path}: contains entries but none parsed`);
  }
  return bodies;
}

/**
 * Bun escapes exactly what its template-literal serializer requires:
 * backslashes, backticks, `${`, and control characters as `\xHH` or
 * `\u…`. Decode the supported forms; unknown escapes decode to their
 * literal character.
 */
function unescapeSnapshotContent(content: string): string {
  return content.replace(
    /\\(x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|.)/g,
    (_, escape: string) => {
      if (escape.startsWith("x")) return String.fromCharCode(parseInt(escape.slice(1), 16));
      if (escape.startsWith("u{")) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
      if (escape.startsWith("u")) return String.fromCharCode(parseInt(escape.slice(1), 16));
      return escape;
    },
  );
}