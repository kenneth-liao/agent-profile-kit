import { COMMAND_NAME } from "../installer/version.js";
import type {
  CommandArg,
  NoticeSeverity,
  PresentationDocument,
  PresentationNode,
} from "./presentation-document.js";
import type { InlineContent } from "./inline-content.js";
import { splitInlineLines } from "./inline-content.js";

/**
 * The carried parts of one CLI-boundary diagnostic, in presentation order:
 * what happened, why, and what to type. Every part is carried inline content —
 * this module gives the error surface its structural shape; it never rewrites
 * a message. The `apkit:` label prefixes the first line only.
 */
export interface DiagnosticDocumentParts {
  /** What happened: the carried error sentence. */
  readonly happened: readonly InlineContent[];
  /** Why: carried cause or recovery detail lines. */
  readonly why?: readonly (readonly InlineContent[])[];
  /**
   * What to type: carried guidance lines. An empty line carries the blank
   * line of the source diagnostic as a structural separator.
   */
  readonly whatToType?: readonly (readonly InlineContent[])[];
  /** The command usage line, rendered as one atomic command node. */
  readonly usage?: string;
  /** Severity of the diagnostic notice; errors default, warnings pass "attention". */
  readonly severity?: NoticeSeverity;
}

/** The presentation document for one CLI-boundary diagnostic (DEC-018). */
export function diagnosticDocument(parts: DiagnosticDocumentParts): PresentationDocument {
  const nodes: PresentationNode[] = [
    {
      kind: "notice",
      severity: parts.severity ?? "error",
      nodes: [
        { kind: "sentence", parts: [`${COMMAND_NAME}: `, ...parts.happened] },
        ...(parts.why ?? []).map((line): PresentationNode => ({
          kind: "sentence",
          parts: line,
        })),
      ],
    },
  ];
  for (const line of parts.whatToType ?? []) {
    nodes.push(
      line.length === 0
        ? { kind: "verbatim", text: "" }
        : { kind: "sentence", parts: line },
    );
  }
  if (parts.usage !== undefined) {
    nodes.push({
      kind: "key-value",
      key: "Usage",
      value: { kind: "command", program: COMMAND_NAME, args: usageCommandArgs(parts.usage) },
    });
  }
  return nodes;
}

function usageCommandArgs(syntax: string): readonly CommandArg[] {
  return syntax
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token): CommandArg => ({ kind: "text", value: token }));
}

/** Splits one carried multi-line error into its what-happened and why parts. */
export function carriedErrorParts(content: readonly InlineContent[]): {
  readonly happened: readonly InlineContent[];
  readonly why: readonly (readonly InlineContent[])[];
} {
  const lines = splitInlineLines(content).filter((line) => line.length > 0);
  const [happened, ...why] = lines;
  return { happened: happened ?? [], why };
}