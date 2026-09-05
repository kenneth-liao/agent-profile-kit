import type { LocationDisplayScope } from "./display-path.js";

/**
 * The inline part model: a closed union of text, command, path, and
 * identifier parts carried by prose, sentence, and list-item nodes. Every
 * structurally supplied value is an atomic part, so the renderer never
 * re-identifies a value by scanning rendered text (DEC-009). This module is a
 * dependency-free leaf: wording tables (command-help) and the document
 * renderer both consume it without an import cycle.
 */

/** One inline path argument of a command part: elided by the renderer. */
export type CommandPathArg = {
  readonly kind: "path";
  readonly canonicalPath: string;
  readonly authoredPath?: string;
  readonly scope: LocationDisplayScope;
};

export type CommandArg =
  | { readonly kind: "text"; readonly value: string }
  | CommandPathArg;

/** One inline text span of a prose, sentence, or list-item node. */
export type TextPart = {
  readonly kind: "text";
  readonly value: string;
};

/** One inline command invocation: atomic, never split or folded. */
export type CommandPart = {
  readonly kind: "command";
  readonly program: string;
  readonly args: readonly CommandArg[];
};

/** One inline location: atomic, rendered as its authored display string. */
export type PathPart = {
  readonly kind: "path";
  readonly canonicalPath: string;
  readonly authoredPath?: string;
  readonly scope: LocationDisplayScope;
};

/** One inline opaque carried value: atomic, rendered verbatim. */
export type IdentifierPart = {
  readonly kind: "identifier";
  readonly value: string;
};

export type InlinePart = TextPart | CommandPart | PathPart | IdentifierPart;

/** Authoring input for inline content: plain strings are text parts. */
export type InlineContent = string | InlinePart;

export function textPart(value: string): TextPart {
  return { kind: "text", value };
}

export function commandPart(
  program: string,
  args: readonly CommandArg[],
): CommandPart {
  return { kind: "command", program, args };
}

export function pathPart(
  canonicalPath: string,
  scope: LocationDisplayScope,
  authoredPath?: string,
): PathPart {
  return {
    kind: "path",
    canonicalPath,
    scope,
    ...(authoredPath === undefined ? {} : { authoredPath }),
  };
}

export function identifierPart(value: string): IdentifierPart {
  return { kind: "identifier", value };
}

/**
 * Compose one carried message and its structurally supplied values into inline
 * content: each value becomes an atomic identifier part rendered verbatim, so
 * a carried value is never re-identified by scanning rendered text (DEC-009).
 * This is the one normalization boundary where a carried record becomes
 * document nodes; the renderer never scans for values.
 */
export function carriedParts(
  message: string,
  values: readonly string[],
): readonly InlineContent[] {
  const ordered = [...new Set(values)]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  if (ordered.length === 0) return [message];
  const content: InlineContent[] = [];
  let cursor = 0;
  let carry = "";
  const flushCarry = (): void => {
    if (carry.length > 0) {
      content.push(carry);
      carry = "";
    }
  };
  while (cursor < message.length) {
    const match = ordered
      .map((value) => ({ value, index: message.indexOf(value, cursor) }))
      .filter((entry) => entry.index >= 0)
      .sort((left, right) =>
        left.index - right.index || right.value.length - left.value.length
      )
      .at(0);
    if (match === undefined) break;
    carry += message.slice(cursor, match.index);
    flushCarry();
    content.push(identifierPart(match.value));
    cursor = match.index + match.value.length;
  }
  carry += message.slice(cursor);
  flushCarry();
  return content;
}
