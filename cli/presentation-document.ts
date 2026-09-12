import { homedir } from "node:os";
import type { Writable } from "node:stream";

import { displayPath, projectIdentityChunks, wrapProjectIdentity, type LocationDisplayScope } from "./display-path.js";
import {
  commandPart,
  flatInlineText,
  identifierPart,
  pathPart,
  safeShellQuoted,
  splitInlineLines,
  textPart,
  type CommandArg,
  type CommandPart,
  type CommandPathArg,
  type IdentifierPart,
  type InlineContent,
  type InlinePart,
  type PathPart,
  type TextPart,
} from "./inline-content.js";

export {
  commandPart,
  flatInlineText,
  identifierPart,
  pathPart,
  splitInlineLines,
  textPart,
};
export type {
  CommandArg,
  CommandPart,
  CommandPathArg,
  IdentifierPart,
  InlineContent,
  InlinePart,
  PathPart,
  TextPart,
};
import {
  styleSemanticText,
  TABLE_MINIMUM_WIDTH,
  type SemanticCategory,
  type TerminalPresentationContext,
} from "./terminal-presentation.js";

export type { SemanticCategory };

export type NoticeSeverity = "attention" | "error" | "info" | "success";

export type PresentationRenderOptions = {
  readonly cwd?: string;
  readonly home?: string;
};

export type ProseNode = {
  readonly kind: "prose";
  readonly parts: readonly InlineContent[];
  readonly category?: SemanticCategory;
};

/**
 * One readable sentence: wraps as continuous flowing text, keeping embedded
 * command invocations and copyable values inline and whole instead of
 * promoting them onto dedicated lines. Diagnostics, help and guides use it so
 * an error reads as one sentence rather than one line per protected value.
 */
export type SentenceNode = {
  readonly kind: "sentence";
  readonly parts: readonly InlineContent[];
  readonly category?: SemanticCategory;
};

export type HeadingNode = {
  readonly kind: "heading";
  readonly text: string;
  readonly category?: SemanticCategory;
};

export type IdentifierNode = {
  readonly kind: "identifier";
  readonly value: string;
  readonly category?: SemanticCategory;
};

export type PathNode = {
  readonly kind: "path";
  readonly canonicalPath: string;
  readonly authoredPath?: string;
  readonly scope: LocationDisplayScope;
  /**
   * The shortest-unambiguous identity this view chose for the Project
   * (US-013, DEC-009). When present it is the displayed value: it is never
   * elided, and it wraps at path-segment boundaries rather than overflowing.
   */
  readonly identity?: string;
  readonly category?: SemanticCategory;
};

export type CommandNode = {
  readonly kind: "command";
  readonly program: string;
  readonly args: readonly CommandArg[];
  readonly category?: SemanticCategory;
};

export type KeyValueNode = {
  readonly kind: "key-value";
  readonly key: string;
  readonly value: PresentationNode;
  readonly category?: SemanticCategory;
};

export type ListItemNode = {
  readonly kind: "list-item";
  readonly parts: readonly InlineContent[];
  readonly category?: SemanticCategory;
};

export type NoticeNode = {
  readonly kind: "notice";
  readonly severity: NoticeSeverity;
  readonly nodes: readonly PresentationNode[];
};

export type RowCell = {
  readonly column: string;
  readonly content: PresentationNode;
  readonly numeric?: boolean;
};

export type RowNode = {
  readonly kind: "row";
  readonly cells: readonly RowCell[];
};

export type ColumnGroupNode = {
  readonly kind: "column-group";
  readonly columns: readonly PresentationDocument[];
};

export type VerbatimNode = {
  readonly kind: "verbatim";
  readonly text: string;
};

export type PresentationNode =
  | ProseNode
  | SentenceNode
  | HeadingNode
  | IdentifierNode
  | PathNode
  | CommandNode
  | KeyValueNode
  | ListItemNode
  | NoticeNode
  | RowNode
  | ColumnGroupNode
  | VerbatimNode;

export type PresentationDocument = readonly PresentationNode[];


const NOTICE_CATEGORY: Readonly<Record<NoticeSeverity, SemanticCategory>> = {
  attention: "attention",
  error: "error",
  info: "muted",
  success: "success",
};

type RenderEnvironment = {
  readonly context: TerminalPresentationContext;
  readonly cwd: string;
  readonly home: string;
};

export function renderPresentationDocument(
  document: PresentationDocument,
  context: TerminalPresentationContext,
  options: PresentationRenderOptions = {},
): string {
  const environment: RenderEnvironment = {
    context,
    cwd: options.cwd ?? process.cwd(),
    home: options.home ?? homedir(),
  };
  return renderNodes(document, environment).join("\n");
}

function renderNodes(
  nodes: readonly PresentationNode[],
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): readonly string[] {
  const lines: string[] = [];
  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];
    if (node === undefined) break;
    if (node.kind === "row") {
      const rows: RowNode[] = [];
      while (index < nodes.length) {
        const candidate = nodes[index];
        if (candidate === undefined || candidate.kind !== "row") break;
        rows.push(candidate);
        index += 1;
      }
      lines.push(...renderRowGroup(rows, environment, inheritedCategory));
      continue;
    }
    lines.push(...renderNode(node, environment, inheritedCategory));
    index += 1;
  }
  return lines;
}

function renderNode(
  node: PresentationNode,
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): readonly string[] {
  const { context } = environment;
  switch (node.kind) {
    case "prose":
      return wrapInlineNode(node.parts, environment, "lifecycle")
        .map((line) => styleSemanticText(line, node.category ?? inheritedCategory, context.color));
    case "sentence":
      return wrapInlineNode(node.parts, environment, "sentence")
        .map((line) => styleSemanticText(line, node.category ?? inheritedCategory, context.color));
    case "heading":
      return styleLines(node.text, node.category ?? "heading", context.color);
    case "identifier":
      return styleLines(node.value, node.category ?? inheritedCategory, context.color);
    case "path": {
      const category = node.category ?? inheritedCategory ?? "path";
      // A view identity renders whole and wraps at path-segment boundaries: it
      // is already the shortest unambiguous label, so eliding it could collide
      // with a sibling identity (US-013, DEC-009).
      const lines = node.identity === undefined
        ? [displayPath(
          node.canonicalPath,
          node.authoredPath ?? node.canonicalPath,
          node.scope,
          environment.cwd,
          environment.home,
          context.width,
        )]
        : wrapProjectIdentity(node.identity, context.width);
      return lines.map((line) => styleSemanticText(line, category, context.color));
    }
    case "command":
      return styleLines(
        renderCommand(node, environment),
        node.category ?? inheritedCategory ?? "command",
        context.color,
      );
    case "key-value": {
      const valueLines = renderNode(
        node.value,
        // The rendered prefix is part of the line: values such as commands
        // elide against the width that remains after the key (INT-2).
        withWidth(environment, Math.max(1, context.width - node.key.length - 2)),
        inheritedCategory,
      );
      // An identity value wraps under its key; every other value keeps the
      // established single-line joining.
      const lines = node.value.kind === "path" && node.value.identity !== undefined
        ? valueLines.map((line, index) => index === 0 ? `${node.key}: ${line}` : `  ${line}`)
        : [`${node.key}: ${valueLines.join(" ")}`];
      return lines.map((line) =>
        styleSemanticText(line, node.category ?? inheritedCategory, context.color)
      );
    }
    case "list-item": {
      return wrapInlineNode(
        ["- ", ...node.parts],
        environment,
        "lifecycle",
      )
        .map((line) => styleSemanticText(line, node.category ?? inheritedCategory, context.color));
    }
    case "notice":
      return renderNodes(node.nodes, environment, NOTICE_CATEGORY[node.severity]);
    case "row":
      return renderRowGroup([node], environment, inheritedCategory);
    case "column-group":
      return renderColumnGroup(node, environment, inheritedCategory);
    case "verbatim":
      return [node.text];
    default: {
      const exhaustive: never = node;
      throw new Error(`Unknown presentation node ${(exhaustive as PresentationNode).kind}`);
    }
  }
}

function renderColumnGroup(
  node: ColumnGroupNode,
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): readonly string[] {
  const rendered = node.columns.map((column) =>
    renderNodes(column, unstyled(environment), inheritedCategory),
  );
  const widths = rendered.map((lines) => Math.max(0, ...lines.map((line) => line.length)));
  const alignedWidth =
    widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * Math.max(0, rendered.length - 1);
  if (alignedWidth > environment.context.width) {
    return rendered.flat();
  }
  const height = Math.max(0, ...rendered.map((lines) => lines.length));
  const lines: string[] = [];
  for (let row = 0; row < height; row += 1) {
    lines.push(
      styleSemanticText(
        rendered
          .map((columnLines, index) => (columnLines[row] ?? "").padEnd(widths[index] ?? 0))
          .join(" ".repeat(COLUMN_GAP))
          .trimEnd(),
        inheritedCategory,
        environment.context.color,
      ),
    );
  }
  return lines;
}

const COLUMN_GAP = 2;

function renderRowGroup(
  rows: readonly RowNode[],
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): readonly string[] {
  // Below the table minimum the inventory uses separated compact entries
  // instead of a squeezed table (US-013), whatever the content would fit.
  if (environment.context.width < TABLE_MINIMUM_WIDTH) {
    return renderStackedRows(rows, environment, inheritedCategory);
  }
  const columns: string[] = [];
  const numeric = new Map<string, boolean>();
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!columns.includes(cell.column)) columns.push(cell.column);
      if (cell.numeric === true) numeric.set(cell.column, true);
    }
  }
  const rendered = rows.map((row) => {
    const values = new Map<string, readonly string[]>();
    for (const cell of row.cells) {
      values.set(cell.column, renderCellLines(cell.content, environment, inheritedCategory));
    }
    return values;
  });
  // A cell that needs more than one line cannot sit in an aligned row without
  // corrupting its value, so the group uses compact entries instead.
  if (rendered.some((values) =>
    [...values.values()].some((lines) => lines.length > 1)
  )) {
    return renderStackedRows(rows, environment, inheritedCategory);
  }
  const widths = columns.map((column) =>
    Math.max(0, ...rendered.map((values) => values.get(column)?.[0]?.length ?? 0)),
  );
  const alignedWidth =
    widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * Math.max(0, columns.length - 1);
  if (alignedWidth > environment.context.width) {
    return renderStackedRows(rows, environment, inheritedCategory);
  }
  return rendered.map((values) =>
    styleSemanticText(
      columns
        .map((column, index) => {
          const value = values.get(column)?.[0] ?? "";
          const width = widths[index] ?? 0;
          const padded = numeric.get(column) === true
            ? value.padStart(width)
            : value.padEnd(width);
          return padded;
        })
        .join(" ".repeat(COLUMN_GAP))
        .trimEnd(),
      inheritedCategory,
      environment.context.color,
    ),
  );
}

/**
 * One compact entry per row: field lines separated by a blank line so entries
 * stay visibly distinct, and an identity value wraps under its field label
 * instead of overflowing or being elided into ambiguity (US-013).
 */
function renderStackedRows(
  rows: readonly RowNode[],
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): readonly string[] {
  const lines: string[] = [];
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push("");
    for (const cell of row.cells) {
      const inlinePrefix = `${cell.column}: `;
      const inlineValue = renderCellLines(
        cell.content,
        withWidth(environment, Math.max(1, environment.context.width - inlinePrefix.length)),
        inheritedCategory,
      );
      const inline = `${inlinePrefix}${inlineValue[0] ?? ""}`;
      if (inlineValue.length === 1 && inline.length <= environment.context.width) {
        lines.push(styleSemanticText(inline, inheritedCategory, environment.context.color));
        continue;
      }
      lines.push(styleSemanticText(cell.column, inheritedCategory, environment.context.color));
      const indent = "  ";
      const valueLines = renderCellLines(
        cell.content,
        withWidth(environment, Math.max(1, environment.context.width - indent.length)),
        inheritedCategory,
      );
      for (const valueLine of valueLines) {
        lines.push(styleSemanticText(`${indent}${valueLine}`, inheritedCategory, environment.context.color));
      }
    }
  });
  return lines;
}

function renderCellLines(
  content: PresentationNode,
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): readonly string[] {
  return renderNode(content, unstyled(environment), inheritedCategory);
}

function withWidth(
  environment: RenderEnvironment,
  width: number,
): RenderEnvironment {
  return {
    ...environment,
    context: { ...environment.context, width },
  };
}

function renderCommand(node: CommandNode, environment: RenderEnvironment): string {
  // A copyable command argument must be executable as printed: the identity
  // renders fully spelled — home-relative or absolute, never middle-elided —
  // and shell-quoted as one POSIX token through the shared quoting boundary,
  // so a path containing spaces survives the shell that runs it. Long
  // commands render past the width exactly like the remedy commands, whose
  // quoted path tokens are already spelled out in full (US-007, review
  // INT-1 cycle 2 and RE-1 on #489; ADR-0028's argv-only quoting precedent).
  return [node.program, ...node.args.map((arg) => {
    if (arg.kind === "text") return arg.value;
    const display = displayPath(
      arg.canonicalPath,
      arg.authoredPath ?? arg.canonicalPath,
      arg.scope,
      environment.cwd,
      environment.home,
    );
    return safeShellQuoted(display) ?? display;
  })].join(" ");
}

function unstyled(environment: RenderEnvironment): RenderEnvironment {
  return {
    ...environment,
    context: { ...environment.context, color: false },
  };
}

/**
 * Wrap one inline-content node through the renderer's own two wrapping
 * policies: lifecycle promotes authored command invocations onto dedicated
 * lines; sentence keeps them inline and whole.
 */
function wrapInlineNode(
  parts: readonly InlineContent[],
  environment: RenderEnvironment,
  policy: "lifecycle" | "sentence",
): readonly string[] {
  return wrapInlineParts(normalizeParts(parts), environment, policy);
}

function normalizeParts(content: readonly InlineContent[]): readonly InlinePart[] {
  return content.map((part) =>
    typeof part === "string" ? textPart(part) : part
  );
}

/** Render one inline part verbatim: atomic parts never fold or elide. */
function renderInlinePart(part: InlinePart, environment: RenderEnvironment): string {
  switch (part.kind) {
    case "text":
      return part.value;
    case "command":
      return renderCommand(
        { kind: "command", program: part.program, args: part.args },
        environment,
      );
    case "path":
      return part.identity ?? displayPath(
        part.canonicalPath,
        part.authoredPath ?? part.canonicalPath,
        part.scope,
        environment.cwd,
        environment.home,
      );
    case "identifier":
      return part.value;
  }
}

/** One wrapping unit: a token plus every token glued to it without whitespace. */
type InlineRun = {
  readonly text: string;
  /** A run led by (or containing) an inline command part: lifecycle promotes it. */
  readonly command: boolean;
  /**
   * True when this run continues the previous one with no separator. Identity
   * chunks carry it so a long identity may break at a path-segment boundary
   * without gaining or losing a character.
   */
  readonly glue: boolean;
};

function wrapInlineParts(
  parts: readonly InlinePart[],
  environment: RenderEnvironment,
  policy: "lifecycle" | "sentence",
): readonly string[] {
  const { context } = environment;
  const rendered = parts.map((part) => renderInlinePart(part, environment));
  const line = rendered.join("");
  if (line.trim().length === 0) return [line];

  const indentation = line.match(/^\s*/)?.[0] ?? "";
  const content = line.slice(indentation.length);
  const bullet = policy === "lifecycle" && content.startsWith("- ") ? "- " : "";
  const measure = Math.max(1, context.width - indentation.length - 2);
  if (content.slice(bullet.length).length <= measure) return [line];

  const runs = inlineRuns(parts, rendered, line, indentation.length + bullet.length);
  const wrapped = wrapRuns(runs, measure, policy);
  return wrapped.map((part, index) =>
    `${index === 0 ? indentation + bullet : `${indentation}  `}${part}`
  );
}

/**
 * Tokenize rendered inline content into wrapping runs. Whitespace separates
 * runs; parts glued directly to neighbouring text (trailing punctuation,
 * brackets) join that neighbour's run, so a run breaks exactly where one
 * protected word did before.
 */
function inlineRuns(
  parts: readonly InlinePart[],
  rendered: readonly string[],
  line: string,
  prefixLength: number,
): readonly InlineRun[] {
  const tokens: {
    text: string;
    atomic: boolean;
    command: boolean;
    glued: boolean;
    glue: boolean;
  }[] = [];
  let offset = 0;
  parts.forEach((part, index) => {
    const text = rendered[index] ?? "";
    const start = offset;
    offset += text.length;
    if (text.length === 0) return;
    if (part.kind === "text") {
      for (const match of text.matchAll(/\S+/g)) {
        const tokenStart = start + (match.index ?? 0);
        const tokenEnd = tokenStart + match[0].length;
        if (tokenEnd <= prefixLength) continue; // indentation or bullet prefix
        tokens.push({
          text: match[0],
          atomic: false,
          command: false,
          glued: tokenStart > prefixLength && tokenStart > 0 &&
            !/\s/.test(line.charAt(tokenStart - 1)),
          glue: false,
        });
      }
      return;
    }
    if (start + text.length <= prefixLength) return; // inside the prefix
    if (part.kind === "path" && part.identity !== undefined) {
      // One token per identity segment: the run may break between segments
      // (never inside a copyable value) and each later segment continues the
      // identity without a separator.
      let chunkStart = start;
      for (const chunk of projectIdentityChunks(text)) {
        const chunkEnd = chunkStart + chunk.length;
        if (chunkEnd > prefixLength) {
          tokens.push({
            text: chunkStart < prefixLength ? chunk.slice(prefixLength - chunkStart) : chunk,
            atomic: true,
            command: false,
            glued: chunkStart > prefixLength && chunkStart > 0 &&
              !/\s/.test(line.charAt(chunkStart - 1)),
            glue: chunkStart > start,
          });
        }
        chunkStart = chunkEnd;
      }
      return;
    }
    tokens.push({
      text: start < prefixLength
        ? text.slice(prefixLength - start)
        : text,
      atomic: true,
      command: part.kind === "command",
      glued: start > prefixLength && start > 0 && !/\s/.test(line.charAt(start - 1)),
      glue: false,
    });
  });
  const runs: InlineRun[] = [];
  for (const token of tokens) {
    // An identity chunk that continues a previous chunk must stay its own run
    // so the wrapper may break at a path-segment boundary.
    if (token.glued && !token.glue && runs.length > 0) {
      const run = runs.at(-1)!;
      runs[runs.length - 1] = {
        text: run.text + token.text,
        command: run.command || token.command,
        glue: run.glue,
      };
      continue;
    }
    runs.push({ text: token.text, command: token.command, glue: token.glue });
  }
  return runs;
}

function wrapRuns(
  runs: readonly InlineRun[],
  measure: number,
  policy: "lifecycle" | "sentence",
): readonly string[] {
  const lines: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) {
      lines.push(current);
      current = "";
    }
  };
  for (const run of runs) {
    if (policy === "lifecycle" && run.command) {
      flush();
      lines.push(run.text);
      continue;
    }
    let remainder = run.text;
    while (remainder.length > 0) {
      const separator = current.length === 0 ? "" : run.glue ? "" : " ";
      if (current.length + separator.length + remainder.length <= measure) {
        current += separator + remainder;
        break;
      }
      if (current.length > 0) {
        flush();
        continue;
      }
      if (run.glue) {
        // A path segment wider than the measure cannot fit whole; split it at
        // the measure so the identity stays complete without overflowing.
        lines.push(remainder.slice(0, measure));
        remainder = remainder.slice(measure);
        continue;
      }
      // Other over-measure runs keep their established whole-line behaviour.
      lines.push(remainder);
      break;
    }
  }
  flush();
  return lines;
}

function styleLines(
  text: string,
  category: SemanticCategory | undefined,
  color: boolean,
): readonly string[] {
  return [styleSemanticText(text, category, color)];
}


/**
 * The one boundary render for human output: the document receives exactly one
 * terminating newline and a view ending in a blank line is never doubled.
 * Every human-stream writer calls this instead of re-deriving the rule.
 */
export function writeHumanDocument(
  stream: Writable,
  document: PresentationDocument,
  context: TerminalPresentationContext,
  options: PresentationRenderOptions = {},
): void {
  const rendered = renderPresentationDocument(document, context, options);
  stream.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);
}
