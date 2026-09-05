import { homedir } from "node:os";

import {
  createCopyableValueProtector,
  displayPath,
  wrappedLifecycleLine,
  type CopyableValueProtector,
  type LocationDisplayScope,
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
  readonly text: string;
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
  readonly nodes: readonly PresentationNode[];
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
  readonly copyableValueProtector: CopyableValueProtector;
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
    copyableValueProtector: createCopyableValueProtector(options.copyableValues ?? []),
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
      return wrappedLifecycleLine(node.text, context.width, environment.copyableValueProtector)
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
        .flatMap((child) => renderNode(child, unstyled(environment), inheritedCategory))
        .join(" ");
      return wrappedLifecycleLine(`- ${content}`, context.width, environment.copyableValueProtector)
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

function styleLines(
  text: string,
  category: SemanticCategory | undefined,
  color: boolean,
): readonly string[] {
  return [styleSemanticText(text, category, color)];
}

