import { COMMAND_NAME } from "../installer/version.js";
import type {
  CommandArg,
  PresentationDocument,
  PresentationNode,
} from "./presentation-document.js";

/**
 * The carried parts of one CLI-boundary diagnostic, in presentation order:
 * what happened, why, and what to type. Every part is carried wording — this
 * module gives the error surface its structural shape; it never rewrites a
 * message. The `apkit:` label prefixes the first line only.
 */
export interface DiagnosticDocumentParts {
  /** What happened: the carried error sentence. */
  readonly happened: string;
  /** Why: carried cause or recovery detail lines. */
  readonly why?: readonly string[];
  /**
   * What to type: carried guidance lines. An empty string carries the blank
   * line of the source diagnostic as a structural separator.
   */
  readonly whatToType?: readonly string[];
  /** The command usage line, rendered as one atomic command node. */
  readonly usage?: string;
}

/** The presentation document for one CLI-boundary diagnostic (DEC-018). */
export function diagnosticDocument(parts: DiagnosticDocumentParts): PresentationDocument {
  const nodes: PresentationNode[] = [
    {
      kind: "notice",
      severity: "error",
      nodes: [
        { kind: "sentence", text: `${COMMAND_NAME}: ${parts.happened}` },
        ...(parts.why ?? []).map((line): PresentationNode => ({
          kind: "sentence",
          text: line,
        })),
      ],
    },
  ];
  for (const line of parts.whatToType ?? []) {
    nodes.push(
      line.length === 0
        ? { kind: "verbatim", text: "" }
        : { kind: "sentence", text: line },
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
export function carriedErrorParts(text: string): {
  readonly happened: string;
  readonly why: readonly string[];
} {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const [happened, ...why] = lines;
  return { happened: happened ?? "", why };
}