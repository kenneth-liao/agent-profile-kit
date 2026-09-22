/** The stable width used when human output is redirected or no terminal size exists. */
export const DEFAULT_HUMAN_WIDTH = 80;

/** The smallest readable terminal width supported by human presentation. */
export const MIN_HUMAN_WIDTH = 40;

/** The largest readable measure used for prose in a wide terminal. */
export const MAX_HUMAN_WIDTH = 100;

/**
 * The narrowest measure that still renders a row group as an aligned table
 * (US-013, DEC-009). Below it — and whenever content cannot fit — human views
 * render one separated compact entry per row instead of a squeezed table.
 * It is the default human measure, so redirected output stays a table.
 */
export const TABLE_MINIMUM_WIDTH = DEFAULT_HUMAN_WIDTH;

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
  /**
   * The terminal height in rows when interactive and known; undefined when
   * redirected or unreported. The long-guidance paging decision consumes it;
   * it is never a layout width.
   */
  readonly rows: number | undefined;
}

/**
 * DEC-001 semantic roles authored at formatter sites. State colors are
 * reserved for state glyphs and headlines; names and headings are bold
 * default; `command` is the single accent; `muted` is secondary text only.
 */
export type SemanticCategory =
  | "command"
  | "error"
  | "heading"
  | "muted"
  | "neutral"
  | "path"
  | "success"
  | "warning";

/** Roles that open with a state glyph and may carry a state color. */
export type StateRole = "success" | "warning" | "error" | "neutral";

export const STATE_ROLES = ["success", "warning", "error", "neutral"] as const;

/** DEC-001 glyphs shared by every human surface. */
export const GLYPHS = {
  success: "✔",
  warning: "⚠",
  error: "✖",
  neutral: "●",
  actionSeparator: "›",
  focus: "❯",
  multiSelectOff: "◻",
  multiSelectOn: "◼",
} as const;

export function stateGlyph(role: StateRole): string {
  return GLYPHS[role];
}

export function stateHeadlinePrefix(role: StateRole): string {
  return `${GLYPHS[role]} `;
}

const ANSI_RESET = "\u001b[0m";
const ANSI_COLORS: Readonly<Record<SemanticCategory, string | undefined>> = {
  command: "\u001b[36m",
  error: "\u001b[31m",
  heading: "\u001b[1m",
  muted: "\u001b[2m",
  neutral: undefined,
  path: "\u001b[1m",
  success: "\u001b[32m",
  warning: "\u001b[33m",
};

/** Apply a node's authored semantic category after layout. */
export function styleSemanticText(
  text: string,
  category: SemanticCategory | undefined,
  color: boolean,
): string {
  if (!color || category === undefined || text.length === 0) return text;
  const ansi = ANSI_COLORS[category];
  if (ansi === undefined) return text;
  return `${ansi}${text}${ANSI_RESET}`;
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
/** The minimal terminal-evidence shape every human stream carries. */
export interface TerminalStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
}

export function terminalPresentationContext(
  stream: TerminalStream = process.stdout,
  environment: NodeJS.ProcessEnv = process.env,
): TerminalPresentationContext {
  const interactive = stream.isTTY === true;
  const terminalColumns = positiveColumns(stream.columns);
  const environmentColumns = positiveColumns(environment.COLUMNS);
  const width = interactive
    ? clampWidth(terminalColumns ?? environmentColumns ?? DEFAULT_HUMAN_WIDTH)
    : DEFAULT_HUMAN_WIDTH;
  const terminalRows = positiveColumns(stream.rows);
  const environmentRows = positiveColumns(environment.LINES);
  // Unknown height stays unknown: long-guidance paging requires a known
  // screen size and never pages on a guess.
  const rows = interactive ? (terminalRows ?? environmentRows) : undefined;
  const terminal = environment.TERM?.toLowerCase();
  const noColor = environment.NO_COLOR !== undefined && environment.NO_COLOR !== "";
  return {
    color: interactive && terminal !== undefined && terminal !== "dumb" && !noColor,
    interactive,
    width,
    rows,
  };
}

