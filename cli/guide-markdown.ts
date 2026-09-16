import type { PresentationDocument, PresentationNode } from "./presentation-document.js";
import { textPart, type InlineContent } from "./inline-content.js";

/**
 * One guide heading as terminal content: the authored text without the
 * markdown `#` decoration (#510, DEC-011). The presentation renderer styles
 * headings; this home decides that a guide heading carries no raw prefix.
 */
export function guideHeadingNode(text: string): PresentationNode {
  return { kind: "heading", text };
}

/**
 * One guide code block as verbatim terminal content (the copyability rule,
 * #510/DEC-011): the body is reproduced exactly — never wrapped, never
 * styled, never fence-quoted — so every copyable command stays one whole
 * line at every terminal width.
 */
export function guideCodeBlockNode(contents: string): PresentationNode {
  return { kind: "verbatim", text: contents };
}

/**
 * The one guide-markdown rendering policy (#510, US-016): the complete human
 * Workspace guide renders as terminal content through the presentation
 * document model, inside the existing terminal/pager boundary. Supported
 * constructs are exactly the guide source's vocabulary: ATX headings, fenced
 * code blocks, bullet lists with hanging-indent continuation lines, wrapped
 * paragraphs, and one pipe table (rendered through the existing row-group
 * policy, falling back to verbatim when a table does not fit the row model).
 * Any other markdown construct fails loudly instead of being dropped or
 * mangled — silent degradation of documentation survives review precisely
 * because nothing errors. The agent workflow reference never flows through
 * here: its consumer is an agent, and raw markdown structure is information
 * to that reader.
 */
export function guideMarkdownDocument(body: string): PresentationDocument {
  const lines = body.replace(/\n$/, "").split("\n");
  const nodes: PresentationNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const fence = readFencedBlock(lines, index);
      nodes.push(...spaced(nodes), guideCodeBlockNode(fence.contents));
      index = fence.end;
      continue;
    }
    const heading = atxHeading(line);
    if (heading !== undefined) {
      nodes.push(...spaced(nodes), guideHeadingNode(heading));
      index += 1;
      continue;
    }
    if (isTableLine(line)) {
      const table = readTable(lines, index);
      nodes.push(...spaced(nodes), ...(table ?? [guideCodeBlockNode(verbatimBlock(lines, index))]));
      index = tableEnd(lines, index);
      continue;
    }
    if (/^- /.test(line)) {
      const bullet = readBulletList(lines, index);
      nodes.push(...spaced(nodes), ...bulletNodes(bullet.lines));
      index = bullet.end;
      continue;
    }
    const paragraph = readParagraph(lines, index);
    nodes.push(...spaced(nodes), {
      kind: "sentence",
      parts: inlineContent(paragraph.text),
    });
    index = paragraph.end;
  }
  return nodes;
}

/**
 * Markdown constructs the guide source does not use are unsupported: they
 * fail loudly instead of being dropped, mangled, or silently degraded into
 * plain text (#510).
 */
function assertSupportedLine(line: string): void {
  if (
    /^>/.test(line) ||
    /^\s*\d+[.)]\s/.test(line) ||
    /^(-{3,}|_{3,}|\*{3,}|={3,})\s*$/.test(line)
  ) {
    throw new Error(
      `guide markdown: unsupported construct at line: "${line}"`,
    );
  }
}

/** One blank line before a block that follows other content, so blocks keep
 * the source's visual separation when the renderer joins lines. */
function spaced(nodes: readonly PresentationNode[]): readonly PresentationNode[] {
  return nodes.length === 0 ? [] : [{ kind: "verbatim", text: "" }];
}

/** The text of one ATX heading, or undefined when the line is not a heading. */
function atxHeading(line: string): string | undefined {
  const match = /^(#{1,6})\s+(.+)$/.exec(line);
  return match === null ? undefined : match[2]!.trimEnd();
}

function isTableLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** Whether the line opens a construct the paragraph reader must not join. */
function isStructuralLine(line: string): boolean {
  return (
    line.startsWith("```") ||
    atxHeading(line) !== undefined ||
    /^- /.test(line) ||
    isTableLine(line)
  );
}

/**
 * One inline text span with bold markers stripped outside code spans. An
 * unpaired `**` is a loud failure, never silent raw decoration. Code spans
 * stay literal: backticks remain readable quoting around copyable values.
 */
function inlineContent(text: string): readonly InlineContent[] {
  return [textPart(stripBoldOutsideCodeSpans(text))];
}

function stripBoldOutsideCodeSpans(text: string): string {
  let result = "";
  let index = 0;
  let inCodeSpan = false;
  while (index < text.length) {
    const character = text[index]!;
    if (character === "`") {
      inCodeSpan = !inCodeSpan;
      result += character;
      index += 1;
      continue;
    }
    if (!inCodeSpan && text.startsWith("**", index)) {
      const close = text.indexOf("**", index + 2);
      if (close === -1) {
        throw new Error(`guide markdown: unpaired bold marker in "${text}"`);
      }
      result += text.slice(index + 2, close);
      index = close + 2;
      continue;
    }
    result += character;
    index += 1;
  }
  return result;
}

/** One fenced code block: the exact body between the delimiters; a fence
 * never closed is a loud failure. */
function readFencedBlock(
  lines: readonly string[],
  start: number,
): { readonly contents: string; readonly end: number } {
  const contents: string[] = [];
  let index = start + 1;
  while (index < lines.length && !lines[index]!.startsWith("```")) {
    contents.push(lines[index]!);
    index += 1;
  }
  if (index >= lines.length) {
    throw new Error(
      `guide markdown: unclosed code fence at line ${start + 1}: "${lines[start]}"`,
    );
  }
  return { contents: contents.join("\n"), end: index + 1 };
}

/** The raw source text of the consecutive lines from `start` (verbatim
 * fallback for a construct the row model cannot fit). */
function verbatimBlock(lines: readonly string[], start: number): string {
  const block: string[] = [];
  let index = start;
  while (index < lines.length && lines[index]!.trim() !== "") {
    block.push(lines[index]!);
    index += 1;
  }
  return block.join("\n");
}

/** One flowing paragraph: consecutive non-structural lines joined as prose. */
function readParagraph(
  lines: readonly string[],
  start: number,
): { readonly text: string; readonly end: number } {
  const words: string[] = [];
  let index = start;
  while (index < lines.length && lines[index]!.trim() !== "") {
    if (isStructuralLine(lines[index]!)) break;
    assertSupportedLine(lines[index]!);
    words.push(lines[index]!.trim());
    index += 1;
  }
  return { text: words.join(" "), end: index };
}

/** One bullet list with hanging-indent continuation lines. */
function readBulletList(
  lines: readonly string[],
  start: number,
): { readonly lines: readonly string[]; readonly end: number } {
  const result: string[] = [];
  let index = start;
  while (index < lines.length && lines[index]!.trim() !== "") {
    const line = lines[index]!;
    if (line.startsWith("```") || isTableLine(line)) break;
    result.push(line);
    index += 1;
  }
  return { lines: result, end: index };
}

/** Bullet items as list-item nodes; hanging-indent continuation lines join
 * their item's flowing text; bold markers strip outside code spans. */
function bulletNodes(lines: readonly string[]): readonly PresentationNode[] {
  const itemTexts: string[] = [];
  for (const line of lines) {
    if (/^- /.test(line)) {
      itemTexts.push(line.slice(2).trim());
      continue;
    }
    if (itemTexts.length === 0) {
      throw new Error(`guide markdown: unsupported construct at line: "${line}"`);
    }
    // A deeper bullet level is an unsupported construct, not continuation.
    if (/^\s+- /.test(line)) {
      assertSupportedLine(line.trim());
    }
    itemTexts[itemTexts.length - 1] = `${itemTexts.at(-1)!} ${line.trim()}`.trim();
  }
  return itemTexts.map((text) => ({
    kind: "list-item" as const,
    parts: inlineContent(text),
  }));
}

/** One pipe table as row-group nodes through the existing responsive row
 * policy; a table that does not fit the row model returns undefined and the
 * caller renders it verbatim instead of mangling cells. */
function readTable(
  lines: readonly string[],
  start: number,
): readonly PresentationNode[] | undefined {
  const rows: string[][] = [];
  let index = start;
  while (index < lines.length && isTableLine(lines[index]!)) {
    rows.push(tableCells(lines[index]!));
    index += 1;
  }
  if (rows.length < 2) return undefined;
  const [header, separator, ...body] = rows;
  if (
    header === undefined ||
    separator === undefined ||
    !isTableSeparator(separator) ||
    header.length !== separator.length ||
    body.some((row) => row.length !== header.length)
  ) {
    return undefined;
  }
  return body.map((row) => ({
    kind: "row" as const,
    cells: row.map((cell, cellIndex) => ({
      column: header[cellIndex] ?? "",
      content: {
        kind: "sentence" as const,
        parts: inlineContent(cell.trim()),
      },
    })),
  }));
}

/** The raw source text of the consecutive pipe-table lines from `start`. */
function tableEnd(lines: readonly string[], start: number): number {
  let index = start;
  while (index < lines.length && isTableLine(lines[index]!)) {
    index += 1;
  }
  return index;
}

function tableCells(line: string): string[] {
  return line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
}

function isTableSeparator(cells: readonly string[]): boolean {
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}
