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
  /**
   * The shortest-unambiguous identity this view chose for the Project
   * (US-013, DEC-009). Display only: the machine-text projection still
   * publishes the canonical/authored path.
   */
  readonly identity?: string;
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
 * POSIX single-quote a value so a copied command survives spaces and special
 * characters. Internal primitive for {@link shellQuoteArg}; command authoring
 * never calls this directly (#651).
 */
function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The one shared shell-quoting function: the only way a command argument is
 * quoted (US-009, #651). A printed argument must stay executable when pasted
 * into a real shell.
 *
 * - Empty values and control characters are refused (`undefined`), so the
 *   remedy degrades to honest manual-recovery prose instead of emitting an
 *   unsafe command (#440).
 * - A home-relative spelling keeps its `~` / `~/` prefix unquoted so the shell
 *   expands it; only the remainder is single-quoted (`~/'proj with space'`).
 *   Quoting the whole `~/…` spelling would freeze `~` and break the command.
 * - Every other value is POSIX single-quoted as one token.
 */
export function shellQuoteArg(value: string): string | undefined {
  if (value.length === 0) return undefined;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  if (value === "~") return "~";
  if (value.startsWith("~/")) {
    const remainder = value.slice(2);
    if (remainder.length === 0) return "~/";
    return `~/${shellSingleQuoted(remainder)}`;
  }
  return shellSingleQuoted(value);
}

/**
 * The plain-text projection of inline content: atomic parts render verbatim.
 * Machine surfaces publish carried sentences through this projection so the
 * parts authoring stays the single home of the wording (DEC-009).
 */
export function flatInlineText(content: readonly InlineContent[]): string {
  return content.map(flatInlinePart).join("");
}

function flatInlinePart(part: InlineContent): string {
  if (typeof part === "string") return part;
  switch (part.kind) {
    case "text":
      return part.value;
    case "command":
      return [part.program, ...part.args.map(flatCommandArg)].join(" ");
    case "path":
      return part.authoredPath ?? part.canonicalPath;
    case "identifier":
      return part.value;
  }
}

function flatCommandArg(arg: CommandArg): string {
  return arg.kind === "text" ? arg.value : (arg.authoredPath ?? arg.canonicalPath);
}

/**
 * Split inline content at carried newlines into one part list per line, so a
 * multi-line carried message becomes one document node per line without the
 * renderer re-identifying the line structure (DEC-009).
 */
export function splitInlineLines(
  content: readonly InlineContent[],
): readonly (readonly InlineContent[])[] {
  const lines: InlineContent[][] = [[]];
  for (const part of content) {
    if (typeof part !== "string") {
      lines.at(-1)!.push(part);
      continue;
    }
    const segments = part.split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) lines.push([]);
      if (segment.length > 0) lines.at(-1)!.push(segment);
    });
  }
  return lines;
}
