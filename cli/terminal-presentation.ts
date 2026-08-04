import type { WriteStream } from "node:tty";

/** The stable width used when human output is redirected or no terminal size exists. */
export const DEFAULT_HUMAN_WIDTH = 80;

/** The smallest readable terminal width supported by human presentation. */
export const MIN_HUMAN_WIDTH = 40;

/** The largest readable measure used for prose in a wide terminal. */
export const MAX_HUMAN_WIDTH = 100;

export interface TerminalPresentationContext {
  readonly interactive: boolean;
  readonly width: number;
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
  return { interactive, width };
}

/** Wrap prose without splitting a word that is itself wider than the measure. */
export function wrapPresentationText(text: string, width: number): readonly string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (current.length > 0 && candidate.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
