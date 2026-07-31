export interface MarkdownDocument {
  readonly path: string;
  readonly source: string;
}

const HISTORICAL_START = "<!-- historical-command-excerpts:start -->";
const HISTORICAL_END = "<!-- historical-command-excerpts:end -->";
const FORMER_COMMAND = /\bagent-profile-kit (?=(?:init|guide|bind|unbind|validate|preview|apply|status|uninstall|--help)\b)/g;

function currentGuidance(path: string, source: string): string | undefined {
  if (path.startsWith("docs/adr/") || path.startsWith("docs/archive/")) return undefined;
  if (path === "CHANGELOG.md") return source.split(/^## \[\d/m, 1)[0]!;
  return source;
}

function maskHistoricalExcerpts(path: string, source: string): {
  readonly masked: string;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  let masked = source;
  let cursor = 0;

  while (true) {
    const start = masked.indexOf(HISTORICAL_START, cursor);
    const unexpectedEnd = masked.indexOf(HISTORICAL_END, cursor);
    if (unexpectedEnd !== -1 && (start === -1 || unexpectedEnd < start)) {
      errors.push(`${path}: unmatched historical command excerpt end marker`);
      cursor = unexpectedEnd + HISTORICAL_END.length;
      continue;
    }
    if (start === -1) break;

    const end = masked.indexOf(HISTORICAL_END, start + HISTORICAL_START.length);
    if (end === -1) {
      errors.push(`${path}: unmatched historical command excerpt start marker`);
      break;
    }
    const afterEnd = end + HISTORICAL_END.length;
    const excerpt = masked.slice(start, afterEnd);
    masked = masked.slice(0, start) + excerpt.replace(/[^\n]/g, " ") + masked.slice(afterEnd);
    cursor = afterEnd;
  }

  return { errors, masked };
}

export function findFormerCommandInvocations(
  documents: readonly MarkdownDocument[],
): readonly string[] {
  const violations: string[] = [];

  for (const document of documents) {
    const guidance = currentGuidance(document.path, document.source);
    if (guidance === undefined) continue;
    const { errors, masked } = maskHistoricalExcerpts(document.path, guidance);
    violations.push(...errors);
    for (const match of masked.matchAll(FORMER_COMMAND)) {
      const line = masked.slice(0, match.index).split("\n").length;
      violations.push(`${document.path}:${line}: ${match[0]!.trim()}`);
    }
  }

  return violations;
}
