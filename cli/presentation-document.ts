import { homedir } from "node:os";
import type { Writable } from "node:stream";

import { displayPath, projectIdentityChunks, wrapProjectIdentity, type LocationDisplayScope } from "./display-path.js";
import {
  commandPart,
  flatInlineText,
  identifierPart,
  pathPart,
  shellQuoteArg,
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
  stateHeadlinePrefix,
  STATE_ROLES,
  styleSemanticText,
  TABLE_MINIMUM_WIDTH,
  type SemanticCategory,
  type StateRole,
  type TerminalPresentationContext,
} from "./terminal-presentation.js";

export type { SemanticCategory, StateRole };
export { stateHeadlinePrefix };

/**
 * One list-item element (US-001, review rule 4 and 6): plain inline content,
 * or a command node — the one inline context whose command may carry a note
 * (CommandNode.note). {@link notedCommand} is the one normalizer; the flat and
 * machine projections read only inline content, so a note can never reach
 * them (DEC-004).
 */
export type InlineItemElement = InlineContent | CommandNode;

export type NoticeSeverity = "error" | "neutral" | "success" | "warning";

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
  readonly note?: string;
};

export type KeyValueNode = {
  readonly kind: "key-value";
  readonly key: string;
  readonly value: PresentationNode;
  readonly category?: SemanticCategory;
};

/** One list part: every item renders as a bullet (US-001, review rule 4).
 * A screen part with more than two items is authored as a list, so the
 * renderer — one reader, not N screens — owns the bullet shape; state
 * categories keep their DEC-001 glyph bullets, everything else renders `- `.
 * A list item element may also be a command node: the one inline context whose
 * command may carry a note (CommandNode.note), so a note can never reach the
 * flat or machine projections, which read only inline content (DEC-004). */
export type ListNode = {
  readonly kind: "list";
  readonly items: readonly (readonly InlineItemElement[])[];
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

/**
 * One screen part authored explicitly (US-001, DEC-002): the document model
 * states its parts, so a builder groups the nodes that belong together — a
 * headline with its facts, a heading with its list, two adjacent sentences —
 * instead of the renderer guessing. The renderer joins parts with exactly one
 * blank line; a part never carries leading or trailing blanks.
 */
export type PartNode = {
  readonly kind: "part";
  readonly nodes: readonly PresentationNode[];
};

export type PresentationNode =
  | ProseNode
  | SentenceNode
  | HeadingNode
  | IdentifierNode
  | PathNode
  | CommandNode
  | KeyValueNode
  | ListNode
  | NoticeNode
  | RowNode
  | ColumnGroupNode
  | PartNode
  | VerbatimNode;

export type PresentationDocument = readonly PresentationNode[];


const NOTICE_ROLE: Readonly<Record<NoticeSeverity, StateRole>> = {
  error: "error",
  neutral: "neutral",
  success: "success",
  warning: "warning",
};

/**
 * One standalone state headline outside a notice: opens with the DEC-001
 * glyph for its role and carries that role's state color. Do not nest it
 * inside a notice — the notice already opens its headline with the glyph.
 */
export function stateHeadline(
  parts: readonly InlineContent[],
  role: StateRole,
): SentenceNode {
  return {
    kind: "sentence",
    parts: [stateHeadlinePrefix(role), ...parts],
    category: role,
  };
}

/** The one shared cancellation statement (spec #677 scope note, screen 14):
 * every interactive command's plain cancel or decline reads exactly this.
 * How the answer was given stays in recorded operation evidence, never on
 * screen. Variants that carry a distinct fact (for example a partial run's
 * completed Projects) keep their own evidence sentence and never reuse this
 * one, because "nothing was changed" would be false there. */
export const CANCELLED_STATEMENT = "Cancelled. Nothing was changed.";

/** The one shared cancellation document (spec #677 scope note, screen 14):
 * the one neutral statement every interactive command's plain cancel or
 * decline prints. There is no per-command wrapper: call sites use this
 * builder directly. Exit codes are unchanged and owned by each command. */
export function cancelledDocument(): PresentationDocument {
  return neutralStatementDocument([CANCELLED_STATEMENT]);
}

/**
 * One neutral outcome statement (US-003, US-010): a clean no-op or a plain
 * decline/cancel ending. It carries no error-like `apkit:` prefix, states
 * preservation once, and never nests a state headline inside a notice.
 */
export function neutralStatementDocument(
  parts: readonly InlineContent[],
): PresentationDocument {
  return [stateHeadline(parts, "neutral")];
}

/**
 * One screen part authored explicitly (US-001, DEC-002): the obvious way to
 * write "these nodes belong together". The renderer joins parts with exactly
 * one blank line, so a headline keeps its facts and two adjacent sentences
 * share one part only when the screen says so here.
 */
export function part(...nodes: readonly PresentationNode[]): PartNode {
  return { kind: "part", nodes };
}

/**
 * One list part (US-001, review rule 4): the one list constructor. Author a
 * list when a screen part has more than two items; every item renders as a
 * bullet — the state category's DEC-001 glyph, or `- ` otherwise. An item
 * element may be a command node carrying a note through {@link notedCommand}.
 */
export function list(
  items: readonly (readonly InlineItemElement[])[],
  category?: SemanticCategory,
): ListNode {
  return category === undefined ? { kind: "list", items } : { kind: "list", items, category };
}

/**
 * One command node (US-001, review rule 6): the node-model command for footer
 * and list-item contexts. It is the only inline-adjacent command whose
 * optional note — attached through {@link notedCommand} — renders beside it.
 */
export function commandNode(
  program: string,
  args: readonly CommandArg[],
  category?: SemanticCategory,
): CommandNode {
  return category === undefined
    ? { kind: "command", program, args }
    : { kind: "command", program, args, category };
}

/**
 * The one home for a next-step note (US-001, review rule 6): the note is
 * display-only, attached to the command it describes, and rendered as
 * `<command> (<note>)` with the command staying copyable at any width. This
 * converter is the one normalization point; notes live nowhere else, and the
 * flat and machine projections never read them (DEC-004).
 */
export function notedCommand(command: CommandNode, note: string): CommandNode {
  const normalized = note.trim();
  return normalized.length === 0 ? command : { ...command, note: normalized };
}

/** The one footer action list (US-010): a single command, or explicit items. */
export type FooterNext =
  | {
      readonly kind: "command";
      readonly value: CommandNode;
    }
  | {
      readonly kind: "actions";
      readonly items: readonly (readonly InlineItemElement[])[];
    };

/**
 * The one shared footer block (US-010, DEC-002): at most one action list,
 * with an optional secondary details route in the same block. Next actions
 * never split between body guidance and this footer; failure remedies stay in
 * the failure body as recovery evidence. The footer is one screen part: the
 * renderer separates it from the body with exactly one blank line.
 */
export function footerNodes(input: {
  readonly next?: FooterNext;
  readonly details?: CommandNode;
}): PartNode {
  const nextNodes: PresentationNode[] =
    input.next === undefined
      ? []
      : input.next.kind === "command"
        ? [{
            kind: "key-value" as const,
            key: "Next",
            value: input.next.value,
            category: "command" as const,
          }]
        : [
            { kind: "heading" as const, text: "Next:" },
            list(input.next.items),
          ];
  const detailsNodes: PresentationNode[] =
    input.details === undefined
      ? []
      : [{
          kind: "key-value" as const,
          key: "Details",
          value: input.details,
          category: "command" as const,
        }];
  if (nextNodes.length === 0 && detailsNodes.length === 0) return part();
  return part(...nextNodes, ...detailsNodes);
}

function prependStateGlyph(node: PresentationNode, role: StateRole): PresentationNode {
  const prefix = stateHeadlinePrefix(role);
  switch (node.kind) {
    case "prose":
    case "sentence":
      return { ...node, parts: [prefix, ...node.parts] };
    case "list":
      return {
        ...node,
        items: node.items.map((item, index) =>
          index === 0 ? [prefix, ...item] : item
        ),
      };
    case "heading":
      return { ...node, text: `${prefix}${node.text}` };
    case "identifier":
      return { ...node, value: `${prefix}${node.value}` };
    default:
      return {
        kind: "sentence",
        parts: [prefix, flatNodeText(node)],
        category: role,
      };
  }
}

/**
 * The one flat document projection: the text form machine-relevant consumers
 * read. Notes are display-only (DEC-004) and never appear here, so a noted
 * command projects exactly like the same command without one.
 */
function flatNodeText(node: PresentationNode): string {
  switch (node.kind) {
    case "prose":
    case "sentence":
      return flatInlineText(node.parts);
    case "part":
      return node.nodes.map(flatNodeText).join("\n");
    case "list":
      return node.items.map((item) => flatInlineText(item)).join("\n");
    case "heading":
      return node.text;
    case "identifier":
      return node.value;
    case "path":
      return node.identity ?? node.authoredPath ?? node.canonicalPath;
    case "command":
      // The note is display-only: the flat projection that machine surfaces
      // consume excludes it, so JSON stays byte-identical (INT-3, PROD-1).
      return [node.program, ...node.args.map((arg) =>
        arg.kind === "text" ? arg.value : arg.authoredPath ?? arg.canonicalPath
      )].join(" ");
    case "key-value":
      return `${node.key}: ${flatNodeText(node.value)}`;
    case "notice":
      return node.nodes.map(flatNodeText).join("\n");
    case "row":
      return node.cells.map((cell) => `${cell.column}: ${flatNodeText(cell.content)}`).join("  ");
    case "column-group":
      return node.columns.map((column) => column.map(flatNodeText).join("\n")).join("\n");
    case "verbatim":
      return node.text;
    default: {
      const exhaustive: never = node;
      throw new Error(`Unknown presentation node ${(exhaustive as PresentationNode).kind}`);
    }
  }
}

function wrapPlainRun(text: string, measure: number): readonly string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= measure) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function renderCommandWithNote(
  node: CommandNode,
  environment: RenderEnvironment,
  prefix = "",
): readonly string[] {
  const rendered = renderCommand(node, environment);
  if (rendered === undefined) {
    return styleLines(
      "Manual recovery is required: this command cannot be printed safely.",
      undefined,
      environment.context.color,
    );
  }
  const category = node.category ?? "command";
  if (node.note === undefined || node.note.length === 0) {
    return [styleSemanticText(`${prefix}${rendered}`, category, environment.context.color)];
  }

  const noteText = `(${node.note})`;
  const singleLine = `${prefix}${rendered} ${noteText}`;
  if (singleLine.length <= environment.context.width) {
    return [styleSemanticText(singleLine, category, environment.context.color)];
  }

  const commandLine = styleSemanticText(`${prefix}${rendered}`, category, environment.context.color);
  const indent = "  ";
  const noteMeasure = Math.max(1, environment.context.width - indent.length);
  const noteLines = wrapPlainRun(noteText, noteMeasure);
  return [
    commandLine,
    ...noteLines.map((line) =>
      styleSemanticText(`${indent}${line}`, category, environment.context.color)
    ),
  ];
}

function isSpacerNode(node: PresentationNode): boolean {
  return node.kind === "verbatim" && node.text.trim().length === 0;
}

/**
 * Split a document into its screen parts (US-001, DEC-002): the renderer —
 * one reader, not every screen — joins the parts with exactly one blank
 * line. The model states its parts; no content is inspected:
 *
 * - an authored {@link part} node is one screen part, exactly as the screen
 *   says;
 * - a spacer node is a part boundary — the mechanical conversion for
 *   documents authored before explicit parts;
 * - a list node is one part (its items render as bullets);
 * - consecutive rows and verbatim blocks keep their structural runs (a table
 *   and authored verbatim blocks are never split by a blank line);
 * - every other loose node is a part of one node.
 */
function partitionDocument(
  document: PresentationDocument,
): readonly (readonly PresentationNode[])[] {
  const parts: PresentationNode[][] = [];
  let index = 0;
  const push = (nodes: readonly PresentationNode[]): void => {
    if (nodes.length > 0) parts.push([...nodes]);
  };

  while (index < document.length) {
    const node = document[index]!;
    if (isSpacerNode(node)) {
      index += 1;
      continue;
    }
    if (node.kind === "part") {
      push(node.nodes);
      index += 1;
      continue;
    }
    if (node.kind === "list") {
      push([node]);
      index += 1;
      continue;
    }
    if (node.kind === "row") {
      const run: PresentationNode[] = [node];
      index += 1;
      while (index < document.length) {
        const next = document[index]!;
        if (next.kind !== "row") break;
        run.push(next);
        index += 1;
      }
      push(run);
      continue;
    }
    if (node.kind === "verbatim") {
      const run: PresentationNode[] = [node];
      index += 1;
      while (index < document.length) {
        const next = document[index]!;
        if (next.kind !== "verbatim" || isSpacerNode(next)) break;
        run.push(next);
        index += 1;
      }
      push(run);
      continue;
    }
    push([node]);
    index += 1;
  }
  return parts;
}

function trimPartLines(lines: readonly string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start]!.trim().length === 0) {
    start += 1;
  }
  let end = lines.length;
  while (end > start && lines[end - 1]!.trim().length === 0) {
    end -= 1;
  }
  return lines.slice(start, end);
}

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
  const parts = partitionDocument(document);
  const renderedParts = parts
    .map((part) => trimPartLines(renderNodes(part, environment)))
    .filter((lines) => lines.length > 0);
  return renderedParts.map((lines) => lines.join("\n")).join("\n\n");
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
      return wrapInlineNode(
        node.parts,
        environment,
        "lifecycle",
        node.category ?? inheritedCategory,
      );
    case "sentence":
      return wrapInlineNode(
        node.parts,
        environment,
        "sentence",
        node.category ?? inheritedCategory,
      );
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
    case "command": {
      return renderCommandWithNote(
        { ...node, category: node.category ?? inheritedCategory ?? "command" },
        environment,
      );
    }
    case "key-value": {
      if (node.value.kind === "command") {
        // The value keeps its own command styling (INT-1); the key re-styles
        // the whole line with the key's category (DEC-001). Notes wrap inside
        // the width that remains after the key (INT-2).
        const commandCategory = node.value.category ?? inheritedCategory ?? "command";
        const valueLines = renderCommandWithNote(
          { ...node.value, category: commandCategory },
          withWidth(environment, Math.max(1, context.width - node.key.length - 2)),
        );
        const head = `${node.key}: ${valueLines[0] ?? ""}`;
        const lines = [head, ...valueLines.slice(1)];
        return lines.map((line) =>
          styleSemanticText(line, node.category ?? inheritedCategory, context.color)
        );
      }
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
    case "list": {
      // The one list rule (US-001): every item renders as a bullet — the
      // state category's DEC-001 glyph, or `- ` otherwise. A part with more
      // than two items is authored as a list, so the renderer owns the
      // bullet shape and no screen calls a helper.
      const category = node.category ?? inheritedCategory;
      const bullet = category !== undefined && STATE_ROLES.includes(category as StateRole)
        ? stateHeadlinePrefix(category as StateRole)
        : "- ";
      const lines: string[] = [];
      for (const item of node.items) {
        lines.push(
          ...wrapInlineNode(
            [bullet, ...item.flatMap(inlineItemParts)],
            environment,
            "lifecycle",
            category,
          ),
        );
      }
      return lines;
    }
    case "part":
      return renderNodes(node.nodes, environment, inheritedCategory);
    case "notice": {
      const role = NOTICE_ROLE[node.severity];
      const [headline, ...body] = node.nodes;
      const lines: string[] = [];
      if (headline !== undefined) {
        lines.push(...renderNode(prependStateGlyph(headline, role), environment, role));
      }
      // Notice body is default-colored actionable or supporting content;
      // only the headline carries state color (DEC-001).
      if (body.length > 0) {
        lines.push(...renderNodes(body, environment));
      }
      return lines;
    }
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
    Math.max(
      column.length,
      ...rendered.map((values) => values.get(column)?.[0]?.length ?? 0),
    ),
  );
  const alignedWidth =
    widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * Math.max(0, columns.length - 1);
  if (alignedWidth > environment.context.width) {
    return renderStackedRows(rows, environment, inheritedCategory);
  }
  const layoutLine = (cells: readonly string[]): string =>
    styleSemanticText(
      cells
        .map((value, index) => {
          const width = widths[index] ?? 0;
          return numeric.get(columns[index] ?? "") === true
            ? value.padStart(width)
            : value.padEnd(width);
        })
        .join(" ".repeat(COLUMN_GAP))
        .trimEnd(),
      inheritedCategory,
      environment.context.color,
    );
  // The header labels each column (US-008) and shares the value alignment.
  const header = styleSemanticText(
    columns
      .map((column, index) => {
        const width = widths[index] ?? 0;
        return numeric.get(column) === true ? column.padStart(width) : column.padEnd(width);
      })
      .join(" ".repeat(COLUMN_GAP))
      .trimEnd(),
    "heading",
    environment.context.color,
  );
  return [
    header,
    ...rendered.map((values) =>
      layoutLine(columns.map((column) => values.get(column)?.[0] ?? "")),
    ),
  ];
}

/**
 * One compact labeled record per row: fields pack onto as few lines as their
 * values allow — about two lines when they fit — separated by a blank line so
 * records stay visibly distinct. No fact is dropped (US-008). A value that
 * cannot sit on one line keeps its label line and wraps beneath it instead of
 * overflowing or being elided into ambiguity (US-013).
 */
function renderStackedRows(
  rows: readonly RowNode[],
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): readonly string[] {
  const lines: string[] = [];
  rows.forEach((row, rowIndex) => {
    if (rowIndex > 0) lines.push("");
    const indent = "  ";
    type StackedField = { readonly inline: string | undefined; readonly label: string; readonly valueLines: readonly string[] };
    const fields: StackedField[] = row.cells.map((cell) => {
      const inlinePrefix = `${cell.column}: `;
      const inlineValue = renderCellLines(
        cell.content,
        withWidth(environment, Math.max(1, environment.context.width - inlinePrefix.length)),
        inheritedCategory,
      );
      const inline = `${inlinePrefix}${inlineValue[0] ?? ""}`;
      if (inlineValue.length === 1 && inline.length <= environment.context.width) {
        return { inline, label: cell.column, valueLines: inlineValue };
      }
      return {
        inline: undefined,
        label: cell.column,
        valueLines: renderCellLines(
          cell.content,
          withWidth(environment, Math.max(1, environment.context.width - indent.length)),
          inheritedCategory,
        ),
      };
    });

    let current = "";
    const flush = (): void => {
      if (current === "") return;
      lines.push(styleSemanticText(current, inheritedCategory, environment.context.color));
      current = "";
    };
    for (const field of fields) {
      if (field.inline === undefined) {
        flush();
        lines.push(styleSemanticText(field.label, inheritedCategory, environment.context.color));
        for (const valueLine of field.valueLines) {
          lines.push(
            styleSemanticText(`${indent}${valueLine}`, inheritedCategory, environment.context.color),
          );
        }
        continue;
      }
      const candidate = current === ""
        ? field.inline
        : `${current}${" ".repeat(COLUMN_GAP)}${field.inline}`;
      if (candidate.length <= environment.context.width) {
        current = candidate;
        continue;
      }
      flush();
      current = field.inline;
    }
    flush();
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

/**
 * Render one copyable command, or refuse it: a path argument that cannot be
 * shell-quoted fails the whole command closed so the raw value never appears
 * unquoted in a copyable line (PROD-1, #440).
 */
function renderCommand(node: CommandNode, environment: RenderEnvironment): string | undefined {
  // A copyable command argument must be executable as printed: the identity
  // renders fully spelled — home-relative or absolute, never middle-elided —
  // and shell-quoted as one POSIX token through the shared quoting boundary,
  // so a path containing spaces survives the shell that runs it. Long
  // commands render past the width exactly like the remedy commands, whose
  // quoted path tokens are already spelled out in full (US-007, review
  // INT-1 cycle 2 and RE-1 on #489; ADR-0028's argv-only quoting precedent).
  const args: string[] = [];
  for (const arg of node.args) {
    if (arg.kind === "text") {
      args.push(arg.value);
      continue;
    }
    if (
      arg.canonicalPath.length === 0 ||
      /[\u0000-\u001f\u007f]/.test(arg.canonicalPath)
    ) {
      return undefined;
    }
    const display = displayPath(
      arg.canonicalPath,
      arg.authoredPath ?? arg.canonicalPath,
      arg.scope,
      environment.cwd,
      environment.home,
    );
    const quoted = shellQuoteArg(display);
    if (quoted === undefined) return undefined;
    args.push(quoted);
  }
  return [node.program, ...args].join(" ");
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
 * lines; sentence keeps them inline and whole. Actionable guidance stays in
 * the default color while embedded command invocations take the accent
 * (DEC-001); an authored line category still paints the whole line.
 */
function wrapInlineNode(
  parts: readonly InlineContent[],
  environment: RenderEnvironment,
  policy: "lifecycle" | "sentence",
  category: SemanticCategory | undefined,
): readonly string[] {
  return wrapInlineParts(normalizeParts(parts), environment, policy, category);
}

/**
 * One list-item element becomes inline content (DEC-004, review rule 6): a
 * command node's note — the one note home, `CommandNode.note`, normalized
 * through {@link notedCommand} — renders as breakable text beside the atomic
 * command (`<command> (<note>)`), exactly like the footer's noted command. A
 * command node without a note renders as its bare inline command.
 */
function inlineItemParts(element: InlineItemElement): readonly InlineContent[] {
  if (typeof element === "string" || element.kind !== "command") return [element];
  if (!("note" in element)) return [element];
  if (element.note === undefined || element.note.length === 0) return [element];
  return [element, textPart(` (${element.note})`)];
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
    case "command": {
      const rendered = renderCommand(
        { kind: "command", program: part.program, args: part.args },
        environment,
      );
      return rendered ?? "";
    }
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

function inlinePartCategory(
  part: InlinePart,
  category: SemanticCategory | undefined,
): SemanticCategory | undefined {
  if (category !== undefined) return category;
  return part.kind === "command" ? "command" : undefined;
}

function inlineRunCategory(
  run: InlineRun,
  category: SemanticCategory | undefined,
): SemanticCategory | undefined {
  if (category !== undefined) return category;
  return run.command ? "command" : undefined;
}

function styleInlineParts(
  parts: readonly InlinePart[],
  rendered: readonly string[],
  category: SemanticCategory | undefined,
  color: boolean,
): string {
  const line = rendered.join("");
  if (category !== undefined) return styleSemanticText(line, category, color);
  return parts.map((part, index) =>
    styleSemanticText(rendered[index] ?? "", inlinePartCategory(part, category), color)
  ).join("");
}

function styleInlineRuns(
  runs: readonly InlineRun[],
  category: SemanticCategory | undefined,
  color: boolean,
): string {
  if (category !== undefined) {
    return styleSemanticText(
      runs.map((run, index) =>
        `${index === 0 || run.glue ? "" : " "}${run.text}`
      ).join(""),
      category,
      color,
    );
  }
  let output = "";
  runs.forEach((run, index) => {
    const separator = index === 0 ? "" : run.glue ? "" : " ";
    output += separator;
    output += styleSemanticText(run.text, inlineRunCategory(run, category), color);
  });
  return output;
}

function wrapInlineParts(
  parts: readonly InlinePart[],
  environment: RenderEnvironment,
  policy: "lifecycle" | "sentence",
  category: SemanticCategory | undefined,
): readonly string[] {
  const { context } = environment;
  const rendered = parts.map((part) => renderInlinePart(part, environment));
  const line = rendered.join("");
  if (line.trim().length === 0) return [styleSemanticText(line, category, context.color)];

  const indentation = line.match(/^\s*/)?.[0] ?? "";
  const content = line.slice(indentation.length);
  const bullet = policy === "lifecycle" &&
    (content.startsWith("- ") || STATE_ROLES.some((role) => content.startsWith(stateHeadlinePrefix(role))))
    ? content.slice(0, content.indexOf(" ") + 1)
    : "";
  const measure = Math.max(1, context.width - indentation.length - 2);
  if (content.slice(bullet.length).length <= measure) {
    return [styleInlineParts(parts, rendered, category, context.color)];
  }

  const runs = inlineRuns(parts, rendered, line, indentation.length + bullet.length);
  const wrapped = wrapRuns(runs, measure, policy);
  return wrapped.map((runLine, index) => {
    const prefix = `${index === 0 ? indentation + bullet : `${indentation}  `}`;
    return styleSemanticText(prefix, category, context.color) +
      styleInlineRuns(runLine, category, context.color);
  });
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
      // Punctuation after a command stays a separate glued run so a promoted
      // command line can drop a sentence terminator without rewriting command
      // text (PROD-3), and a clause comma can continue on the next line.
      const punctuationAfterCommand = run.command && isPunctuationToken(token.text);
      if (!punctuationAfterCommand) {
        runs[runs.length - 1] = {
          text: run.text + token.text,
          command: run.command || token.command,
          glue: run.glue,
        };
        continue;
      }
    }
    runs.push({
      text: token.text,
      command: token.command,
      glue: token.glue || (token.glued && runs.at(-1)?.command === true),
    });
  }
  return runs;
}

/** A trailing period must never ride on a promoted command line. */
const SENTENCE_PUNCTUATION = /^[.]$/;
const PUNCTUATION_TOKEN = /^[.,;:]+$/;

function isSentencePunctuation(text: string): boolean {
  return SENTENCE_PUNCTUATION.test(text);
}

function isPunctuationToken(text: string): boolean {
  return PUNCTUATION_TOKEN.test(text);
}

/**
 * A line that is only a copyable command (plus glued sentence punctuation)
 * drops those separator punctuation runs: the line is the paste target, and a
 * trailing period would join the final argument (#651). Command-run text is
 * never rewritten (PROD-3).
 */
function finalizeCommandLine(line: readonly InlineRun[]): InlineRun[] {
  if (!line.some((run) => run.command)) return [...line];
  if (!line.every((run) => run.command || isSentencePunctuation(run.text))) {
    return [...line];
  }
  return line.filter((run) => !isSentencePunctuation(run.text));
}

function wrapRuns(
  runs: readonly InlineRun[],
  measure: number,
  policy: "lifecycle" | "sentence",
): InlineRun[][] {
  const lines: InlineRun[][] = [];
  let current: InlineRun[] = [];
  const currentLength = (): number => {
    let length = 0;
    current.forEach((run, index) => {
      length += run.text.length + (index === 0 || run.glue ? 0 : 1);
    });
    return length;
  };
  const flush = (): void => {
    if (current.length > 0) {
      lines.push(finalizeCommandLine(current));
      current = [];
    }
  };
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index]!;
    // A command is atomic and only leaves the line when it does not fit beside
    // the prose already on it (US-009 "when needed"; RE-1). Fitting commands
    // stay inline; over-measure commands keep their whole-line behaviour.
    let remainder = run.text;
    while (remainder.length > 0) {
      const separator = current.length === 0 || run.glue ? 0 : 1;
      if (currentLength() + separator + remainder.length <= measure) {
        current.push({ text: remainder, command: run.command, glue: run.glue });
        break;
      }
      if (current.length > 0) {
        flush();
        continue;
      }
      if (run.glue) {
        // A path segment wider than the measure cannot fit whole; split it at
        // the measure so the identity stays complete without overflowing.
        lines.push(finalizeCommandLine([{ text: remainder.slice(0, measure), command: run.command, glue: run.glue }]));
        remainder = remainder.slice(measure);
        continue;
      }
      // Over-measure atomic runs stay whole on their own line. A following
      // sentence terminator is dropped with that line (never command text).
      lines.push(finalizeCommandLine([{ text: remainder, command: run.command, glue: run.glue }]));
      while (index + 1 < runs.length && isSentencePunctuation(runs[index + 1]!.text)) {
        index += 1;
      }
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
