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

type SemanticCategory =
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

const HEADING_PREFIXES = [
  "Commands:",
  "Project quick start:",
  "First run:",
  "Common commands:",
  "More commands:",
  "Inventory:",
  "Teardown:",
  "Machine details:",
  "Temporary installations:",
  "Discovery:",
  "Usage:",
  "Purpose:",
  "Examples:",
  "Writes:",
  "Next:",
  "Supported Hosts:",
  "Topics:",
  "Complete references:",
  "Projects (",
  "Profiles (",
  "Hosts (",
  "Temporary Profile Installations (",
  "Projects:",
  "Diagnostics:",
  "Files:",
  "State explanations:",
  "Codex setup:",
  "Claude setup:",
  "Grok setup:",
  "Pi setup:",
] as const;

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

export interface HumanOutputStyleOptions {
  readonly commandNames?: readonly string[];
}

/**
 * Existing human formatters expose strings rather than categorized line
 * records. These fixed public-label prefixes are the presentation compatibility
 * table until that boundary carries line metadata; they intentionally avoid
 * inferring categories from arbitrary user-controlled text.
 */
function semanticCategory(
  line: string,
  commandNames: readonly string[],
): SemanticCategory | undefined {
  const indented = /^\s/.test(line);
  const text = line.trim();
  if (text.length === 0) return undefined;

  if (text.startsWith("/\\") || text.startsWith("/__\\")) return "heading";
  if (
    commandNames.some((name) => text === name || text.startsWith(`${name} `)) ||
    /^(?:apkit(?:\s|$)|(?:Run|Next:\s+Run)\s+apkit\b)/i.test(text)
  ) {
    return "command";
  }
  if (
    /^(?:Warning(?::|s:)|Attention\b|State:|Problem:|Pending:|Changes:|apkit:\s+warning:)/i
      .test(text)
  ) {
    return "attention";
  }
  if (
    /^(?:Blocker(?::|s:)|Global blockers:|Error:|Failed:|Cannot\b|Apply blocked|Apply completed with blockers|apkit:)/i
      .test(text)
  ) {
    return "error";
  }
  if (/^(?:Apply completed with attention|Attention required)/i.test(text)) return "attention";
  if (
    /^(?:Initialized|Recorded|Migrated|Removed|Installed|Uninstalled|Applied|Ready to apply|Apply complete$|Some Projects intentionally uninstalled|Intentionally uninstalled|All\b|No\b|Workspace and .* valid)/i
      .test(text)
  ) {
    return "success";
  }
  if (
    /^(?:Engine version|Workspace|Local Configuration|Installation State|Project|Profile|Profile Installation|Host|Temporary installation):/i
      .test(text)
  ) {
    return "path";
  }
  if (!indented && /^(?:For\b|Choose\b|This\b|The\b|A\b|An\b)/i.test(text)) return "muted";
  if (HEADING_PREFIXES.some((prefix) => text.startsWith(prefix))) return "heading";
  return undefined;
}

/**
 * Add restrained semantic color to already-rendered human text. The input
 * remains the source of meaning; styling is an additive terminal concern.
 */
export function renderHumanOutput(
  text: string,
  context: TerminalPresentationContext,
  options: HumanOutputStyleOptions = {},
): string {
  if (!context.color) return text;
  let mutedParagraph = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) {
        mutedParagraph = false;
        return line;
      }
      const category = semanticCategory(line, options.commandNames ?? []);
      const styleCategory = category === "muted" && mutedParagraph ? undefined : category;
      if (category === "muted") mutedParagraph = true;
      else if (category !== undefined) mutedParagraph = false;
      return styleCategory === undefined
        ? line
        : `${ANSI_COLORS[styleCategory]}${line}${ANSI_RESET}`;
    })
    .join("\n");
}
