import { homedir } from "node:os";

import {
  createCopyableValueProtector,
  displayPath,
  type CopyableValueProtector,
  type LocationDisplayScope,
  wrappedLifecycleLine,
  wrappedSentenceLine,
} from "./presentation.js";
import {
  styleSemanticText,
  type SemanticCategory,
  type TerminalPresentationContext,
} from "./terminal-presentation.js";

export type { SemanticCategory };

export type NoticeSeverity = "attention" | "error" | "info" | "success";

export type PresentationRenderOptions = {
  readonly cwd?: string;
  readonly home?: string;
  /** Report-supplied values whose spaces must survive prose wrapping. */
  readonly copyableValues?: readonly string[];
};

export type ProseNode = {
  readonly kind: "prose";
  /** Transitional: carried text until the site is authored as parts. */
  readonly text?: string;
  readonly parts?: readonly InlineContent[];
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
  /** Transitional: carried text until the site is authored as parts. */
  readonly text?: string;
  readonly parts?: readonly InlineContent[];
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
  readonly category?: SemanticCategory;
};

export type CommandPathArg = {
  readonly kind: "path";
  readonly canonicalPath: string;
  readonly authoredPath?: string;
  readonly scope: LocationDisplayScope;
};

export type CommandArg =
  | { readonly kind: "text"; readonly value: string }
  | CommandPathArg;

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
  /** Transitional: carried child nodes until the site is authored as parts. */
  readonly nodes?: readonly PresentationNode[];
  readonly parts?: readonly InlineContent[];
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

const NOTICE_CATEGORY: Readonly<Record<NoticeSeverity, SemanticCategory>> = {
  attention: "attention",
  error: "error",
  info: "muted",
  success: "success",
};

type RenderEnvironment = {
  readonly context: TerminalPresentationContext;
  readonly copyableValueProtector: CopyableValueProtector | undefined;
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
    copyableValueProtector: options.copyableValues === undefined
      ? undefined
      : createCopyableValueProtector(options.copyableValues),
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
      return wrapInlineNode(node.parts, node.text, environment, "lifecycle")
        .map((line) => styleSemanticText(line, node.category ?? inheritedCategory, context.color));
    case "sentence":
      return wrapInlineNode(node.parts, node.text, environment, "sentence")
        .map((line) => styleSemanticText(line, node.category ?? inheritedCategory, context.color));
    case "heading":
      return styleLines(node.text, node.category ?? "heading", context.color);
    case "identifier":
      return styleLines(node.value, node.category ?? inheritedCategory, context.color);
    case "path":
      return styleLines(
        displayPath(
          node.canonicalPath,
          node.authoredPath ?? node.canonicalPath,
          node.scope,
          environment.cwd,
          environment.home,
          context.width,
        ),
        node.category ?? inheritedCategory ?? "path",
        context.color,
      );
    case "command":
      return styleLines(
        renderCommand(node, environment),
        node.category ?? inheritedCategory ?? "command",
        context.color,
      );
    case "key-value":
      return styleLines(
        `${node.key}: ${renderNode(
          node.value,
          // The rendered prefix is part of the line: values such as commands
          // elide against the width that remains after the key (INT-2).
          withWidth(environment, Math.max(1, context.width - node.key.length - 2)),
          inheritedCategory,
        ).join(" ")}`,
        node.category ?? inheritedCategory,
        context.color,
      );
    case "list-item": {
      const content = node.nodes
        ?.flatMap((child) => renderNode(child, unstyled(environment), inheritedCategory))
        .join(" ");
      return wrapInlineNode(
        node.parts === undefined ? undefined : ["- ", ...node.parts],
        content === undefined ? undefined : `- ${content}`,
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
  const columns: string[] = [];
  const numeric = new Map<string, boolean>();
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!columns.includes(cell.column)) columns.push(cell.column);
      if (cell.numeric === true) numeric.set(cell.column, true);
    }
  }
  const rendered = rows.map((row) => {
    const values = new Map<string, string>();
    for (const cell of row.cells) {
      values.set(cell.column, renderCellContent(cell.content, environment, inheritedCategory));
    }
    return values;
  });
  const widths = columns.map((column) =>
    Math.max(0, ...rendered.map((values) => values.get(column)?.length ?? 0)),
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
          const value = values.get(column) ?? "";
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

function renderStackedRows(
  rows: readonly RowNode[],
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): readonly string[] {
  const lines: string[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      const inlinePrefix = `${cell.column}: `;
      const inlineValue = renderCellContent(
        cell.content,
        withWidth(environment, Math.max(1, environment.context.width - inlinePrefix.length)),
        inheritedCategory,
      );
      const inline = `${inlinePrefix}${inlineValue}`;
      if (inline.length <= environment.context.width) {
        lines.push(styleSemanticText(inline, inheritedCategory, environment.context.color));
        continue;
      }
      lines.push(styleSemanticText(cell.column, inheritedCategory, environment.context.color));
      const indent = "  ";
      const value = renderCellContent(
        cell.content,
        withWidth(environment, Math.max(1, environment.context.width - indent.length)),
        inheritedCategory,
      );
      lines.push(styleSemanticText(`${indent}${value}`, inheritedCategory, environment.context.color));
    }
  }
  return lines;
}

function renderCellContent(
  content: PresentationNode,
  environment: RenderEnvironment,
  inheritedCategory?: SemanticCategory,
): string {
  return renderNode(content, unstyled(environment), inheritedCategory).join(" ");
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
  const prefixParts = [node.program];
  const pathArgs: CommandPathArg[] = [];
  for (const arg of node.args) {
    if (arg.kind === "text") prefixParts.push(arg.value);
    else pathArgs.push(arg);
  }
  const prefix = pathArgs.length === 0 ? prefixParts.join(" ") : `${prefixParts.join(" ")} `;
  const remaining = Math.max(1, environment.context.width - prefix.length);
  const renderedArgs = node.args.map((arg) =>
    arg.kind === "text"
      ? arg.value
      : displayPath(
        arg.canonicalPath,
        arg.authoredPath ?? arg.canonicalPath,
        arg.scope,
        environment.cwd,
        environment.home,
        remaining,
      ),
  );
  return [node.program, ...renderedArgs].join(" ");
}

function unstyled(environment: RenderEnvironment): RenderEnvironment {
  return {
    ...environment,
    context: { ...environment.context, color: false },
  };
}

/**
 * Wrap one inline-content node. Authored parts wrap through the renderer's
 * own two policies; carried text still delegates to the string pipeline until
 * every site is authored as parts (transitional).
 */
function wrapInlineNode(
  parts: readonly InlineContent[] | undefined,
  carriedText: string | undefined,
  environment: RenderEnvironment,
  policy: "lifecycle" | "sentence",
): readonly string[] {
  if (parts === undefined) {
    const text = carriedText ?? "";
    const protector = environment.copyableValueProtector ?? createCopyableValueProtector([]);
    return policy === "lifecycle"
      ? wrappedLifecycleLine(text, environment.context.width, protector)
      : wrappedSentenceLine(text, environment.context.width, protector);
  }
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
      return part.authoredPath ?? part.canonicalPath;
    case "identifier":
      return part.value;
  }
}

/** One wrapping unit: a token plus every token glued to it without whitespace. */
type InlineRun = {
  readonly text: string;
  /** A run led by (or containing) an inline command part: lifecycle promotes it. */
  readonly command: boolean;
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
  const tokens: { text: string; atomic: boolean; command: boolean; glued: boolean }[] = [];
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
        });
      }
      return;
    }
    if (start + text.length <= prefixLength) return; // inside the prefix
    tokens.push({
      text: start < prefixLength
        ? text.slice(prefixLength - start)
        : text,
      atomic: true,
      command: part.kind === "command",
      glued: start > prefixLength && start > 0 && !/\s/.test(line.charAt(start - 1)),
    });
  });
  const runs: InlineRun[] = [];
  for (const token of tokens) {
    if (token.glued && runs.length > 0) {
      const run = runs.at(-1)!;
      runs[runs.length - 1] = {
        text: run.text + token.text,
        command: run.command || token.command,
      };
      continue;
    }
    runs.push({ text: token.text, command: token.command });
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
    const candidate = current.length === 0 ? run.text : `${current} ${run.text}`;
    if (current.length > 0 && candidate.length > measure) {
      flush();
      current = run.text;
    } else {
      current = candidate;
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

