import type { WriteStream } from "node:tty";

/** The stable width used when human output is redirected or no terminal size exists. */
export const DEFAULT_HUMAN_WIDTH = 80;

/** The smallest readable terminal width supported by human presentation. */
export const MIN_HUMAN_WIDTH = 40;

/** The largest readable measure used for prose in a wide terminal. */
export const MAX_HUMAN_WIDTH = 100;

/**
 * Width context for human CLI presentation. Root help, focused human guides,
 * lifecycle reports, temporary-installation reports, focused command help,
 * inventory, info, validation, authoring, teardown, and error surfaces all
 * consume this context from the CLI boundary; semantic report construction and
 * machine surfaces remain independent of terminal state.
 */
export interface TerminalPresentationContext {
  readonly color: boolean;
  readonly interactive: boolean;
  readonly width: number;
}

export type SemanticCategory =
  | "attention"
  | "command"
  | "error"
  | "heading"
  | "muted"
  | "path"
  | "success";

const ANSI_RESET = "\u001b[0m";
const ANSI_COLORS: Readonly<Record<SemanticCategory, string>> = {
  attention: "\u001b[33m",
  command: "\u001b[36m",
  error: "\u001b[31m",
  heading: "\u001b[1;34m",
  muted: "\u001b[2m",
  path: "\u001b[35m",
  success: "\u001b[32m",
};

/** Apply a node's authored semantic category after layout. */
export function styleSemanticText(
  text: string,
  category: SemanticCategory | undefined,
  color: boolean,
): string {
  if (!color || category === undefined || text.length === 0) return text;
  return `${ANSI_COLORS[category]}${text}${ANSI_RESET}`;
}

const FULL_WORDMARK = [
  "  /\\  Agent Profile Kit",
  " /__\\ reusable agent material",
] as const;
const NARROW_WORDMARK = ["  /\\ APKIT"] as const;

function longestLine(lines: readonly string[]): number {
  return Math.max(...lines.map((line) => line.length));
}

/** Select a compact ASCII identity that fits the available terminal measure. */
export function agentProfileKitWordmark(width: number): readonly string[] {
  if (longestLine(FULL_WORDMARK) <= width) return FULL_WORDMARK;
  if (longestLine(NARROW_WORDMARK) <= width) return NARROW_WORDMARK;
  return [];
}

function positiveColumns(value: number | string | undefined): number | undefined {
  const columns = typeof value === "number" ? value : Number(value);
  return Number.isInteger(columns) && columns > 0 ? columns : undefined;
}

function clampWidth(width: number): number {
  return Math.min(MAX_HUMAN_WIDTH, Math.max(MIN_HUMAN_WIDTH, width));
}

/**
 * Read terminal state once at the CLI boundary. Renderers receive this trusted
 * context instead of independently consulting process streams or environment.
 */
export function terminalPresentationContext(
  stream: Pick<WriteStream, "isTTY" | "columns"> = process.stdout,
  environment: NodeJS.ProcessEnv = process.env,
): TerminalPresentationContext {
  const interactive = stream.isTTY === true;
  const terminalColumns = positiveColumns(stream.columns);
  const environmentColumns = positiveColumns(environment.COLUMNS);
  const width = interactive
    ? clampWidth(terminalColumns ?? environmentColumns ?? DEFAULT_HUMAN_WIDTH)
    : DEFAULT_HUMAN_WIDTH;
  const terminal = environment.TERM?.toLowerCase();
  const noColor = environment.NO_COLOR !== undefined && environment.NO_COLOR !== "";
  return {
    color: interactive && terminal !== undefined && terminal !== "dumb" && !noColor,
    interactive,
    width,
  };
}

