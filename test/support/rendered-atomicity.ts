/**
 * TEST-005 (#429): the atomic-node guarantee asserted as a property over
 * rendered output. Every rendered golden capture passes through
 * `checkAtomicRendering`, which proves that no displayed command or path is
 * fragmented across lines.
 *
 * The oracle for what an atom IS is the capture's own committed golden
 * baseline, per capture: expected spellings are extracted — by syntax, never
 * by English presentation categories — only from the baseline body of that
 * capture. Filesystem-shaped tokens are path spellings; token runs starting
 * at the CLI program name that validate against the command grammar (verbs
 * and argument vocabulary from the CLI command table, host names from host
 * metadata, authoring-example identifiers) are command spellings. The actual
 * output is never mined for spellings, and no global corpus is consulted.
 *
 * Every occurrence of every recognized spelling is validated by source
 * line/column in the actual output. A cross-line occurrence is fragmentation
 * evidence unless it is occurrence-count/position aligned with an identical
 * legal shape in the baseline: the k-th split occurrence of a spelling in the
 * actual output must have exactly the same matched text as the k-th split
 * occurrence of that spelling in the baseline. A baseline split allowance is
 * therefore not reusable elsewhere: one legitimate baseline split plus a
 * second identical split in the actual output is rejected. Intact occurrences
 * always pass, and an intact occurrence elsewhere never excuses a split one.
 * There is no fragmentation-depth limit: a spelling broken across any number
 * of lines is one detectable occurrence.
 *
 * Verbatim tolerance is scoped: only lines inside an actual verbatim region
 * (a run of at least two consecutive lines matching consecutive authored
 * verbatim lines) are exempt, on both sides; a stray line that merely equals
 * one authored line is not exempt.
 *
 * Documented omissions:
 * - A spelling that appears ONLY in fragmented form in the baseline was
 *   reviewed and accepted as legal adjacency there; it is not an enforced
 *   atom, because extraction is baseline-intact only.
 * - A split in the actual output whose exact matched text equals an aligned
 *   baseline split is accepted even if the surrounding context differs;
 *   snapshot equality governs context.
 * - Truncation without continuation (content loss) is a content change, not a
 *   fragmentation, and is caught by snapshot equality.
 */

const ANSI_ESCAPE = /\u001B\[[0-9;]*m/g;

import { COMMANDS } from "../../cli/command-help.js";
import { AUTHORING_EXAMPLES } from "../../installer/authoring-examples.js";
import { SUPPORTED_HOSTS } from "../../schemas/local-configuration.js";
import { TEMPORARY_INSTALLATION_HOSTS } from "../../installer/temporary-installation.js";

export interface AtomicityCorpus {
  /** Authored lines reproduced verbatim; scoped to actual verbatim regions. */
  readonly verbatimLines?: readonly string[];
}

const VERBS = new Set<string>();
const MACHINE_VERBS = new Set<string>();
for (const command of COMMANDS) {
  if (command.namespace === undefined) VERBS.add(command.name);
  else MACHINE_VERBS.add(command.name);
}

const COMMAND_WORD = new Set<string>([...VERBS, ...MACHINE_VERBS]);
for (const command of COMMANDS) {
  for (const token of command.syntax.split(/\s+/)) COMMAND_WORD.add(token);
  for (const example of command.examples) {
    for (const token of example.split(/\s+/)) COMMAND_WORD.add(token);
  }
}
for (const host of [...SUPPORTED_HOSTS, ...TEMPORARY_INSTALLATION_HOSTS]) {
  COMMAND_WORD.add(host);
}
for (const example of Object.values(AUTHORING_EXAMPLES)) COMMAND_WORD.add(example.id);

const COMMAND_WORD_RE =
  /^(?:--?[\w][\w-]*|<[^>]+>|\[|\]|--|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Command programs the CLI authors as command nodes: the `apkit` program
 * (cli/command-help.ts) and the Git untrack recovery command
 * (cli/presentation.ts, `git -C <project> rm -r --cached -- <paths>`), whose
 * subcommand vocabulary is mirrored here as grammar metadata.
 */
const PROGRAMS = new Set(["apkit", "git"]);
const GIT_SUBCOMMANDS = new Set(["rm"]);

/** Edge characters that belong to prose, not to the atomic value. Leading
 * brackets and dots are deliberately absent: `[project | --all]` usage tokens
 * and `.agent-profile-kit/…` relative paths are atomic spellings themselves. */
const LEADING_NOISE = new Set(["`", '"', "'", "("]);
const TRAILING_NOISE = new Set(["`", '"', "'", ".", ",", ";", ":", ")"]);

function trimTokenEdges(token: string, keepQuotes = false): string {
  if (token === "." || token === "..") return token;
  let next = token;
  const leading = keepQuotes
    ? new Set([...LEADING_NOISE].filter((edge) => edge !== "'" && edge !== '"'))
    : LEADING_NOISE;
  const trailing = keepQuotes
    ? new Set([...TRAILING_NOISE].filter((edge) => edge !== "'" && edge !== '"'))
    : TRAILING_NOISE;
  while (next.length > 0 && leading.has(next[0]!)) next = next.slice(1);
  while (next.length > 0 && trailing.has(next.at(-1)!)) next = next.slice(0, -1);
  return next;
}

function isPathToken(token: string): boolean {
  return token === "." || token === ".." || (token.includes("/") && token.length > 1);
}

function isPlainGrammarWord(token: string): boolean {
  return COMMAND_WORD.has(token) || COMMAND_WORD_RE.test(token) || isPathToken(token);
}

/** A quoted span is an opaque carried value: always grammar-valid. */
function isGrammarWord(tokens: readonly string[], quoted: ReadonlySet<number>, index: number): boolean {
  return quoted.has(index) || isPlainGrammarWord(tokens[index]!);
}

/** Strip SGR styling; whole-line styling makes stripping lossless for content. */
function stripAnsi(line: string): string {
  return line.replaceAll("\r", "").replace(ANSI_ESCAPE, "");
}

interface StreamLine {
  readonly text: string;
  /** 1-based original line number in the analyzed stream. */
  readonly number: number;
  /** A blank line, or a line inside a verbatim region, is not evidence. */
  readonly analyzable: boolean;
}

/**
 * Verbatim regions are scoped: a line is exempt only when it belongs to a run
 * of at least two consecutive lines matching consecutive authored verbatim
 * lines, so a stray line that equals one authored line stays analyzable.
 */
function verbatimExempt(lines: readonly string[], verbatimLines: readonly string[]): boolean[] {
  const pairs = new Set<string>();
  for (let index = 0; index + 1 < verbatimLines.length; index += 1) {
    pairs.add(`${verbatimLines[index]!}\n${verbatimLines[index + 1]!}`);
  }
  const exempt = lines.map(() => false);
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (pairs.has(`${lines[index]!}\n${lines[index + 1]!}`)) {
      exempt[index] = true;
      exempt[index + 1] = true;
    }
  }
  return exempt;
}

function analyzableLines(stream: string, verbatimLines: readonly string[]): readonly StreamLine[] {
  const raw = stripAnsi(stream).split("\n");
  const exempt = verbatimExempt(raw, verbatimLines);
  return raw.map((line, index) => ({
    text: line,
    number: index + 1,
    analyzable: line.trim().length > 0 && !exempt[index]!,
  }));
}

/** One command spelling: the maximal grammar-valid run led by an authored program. */
function commandSpelling(
  tokens: readonly string[],
  quoted: ReadonlySet<number>,
  start: number,
): string | undefined {
  const program = tokens[start];
  if (program === undefined || !PROGRAMS.has(program)) return undefined;
  const first = tokens[start + 1];
  if (first === undefined || !isGrammarWord(tokens, quoted, start + 1)) return undefined;
  const parts = [program, first];
  let index = start + 2;
  while (index < tokens.length) {
    const token = tokens[index]!;
    const allowed = quoted.has(index) || isPlainGrammarWord(token) ||
      (program === "git" && GIT_SUBCOMMANDS.has(token));
    if (!allowed) break;
    parts.push(token);
    index += 1;
  }
  return parts.join(" ");
}

/**
 * Spellings recognized from intact content of the baseline body. Tokens glued
 * into a quoted span (shell-quoted paths with spaces) are merged back
 * into one token without changing internal whitespace. The quoted form is
 * what is recognized and guarded.
 */
function extractSpellings(lines: readonly string[]): readonly string[] {
  const found = new Set<string>();
  for (const line of lines) {
    // Root help authors command.syntax directly, without an apkit prefix.
    // Use that canonical syntax, only when its complete bytes occur here.
    for (const command of COMMANDS) {
      if (line.includes(command.syntax)) found.add(command.syntax);
    }
    // Unquoted paths may contain spaces. Rendered bytes cannot distinguish a
    // path's last word from adjacent prose, so guard each baseline-intact
    // prefix within the same single-spaced field. Punctuation, column gaps,
    // quotes and flags terminate the field; no English labels are consulted.
    for (const match of line.matchAll(/(?:^|[\s(])((?:~?\/|\.{1,2}\/|\.[^\s/]+\/|[^\s'"():;,]+\/)[^\s'"(),;:]+(?: [^\s'"(),;:-][^\s'"(),;:]*)*)/g)) {
      const words = match[1]!.split(" ");
      for (let count = 1; count <= words.length; count += 1) {
        found.add(trimTokenEdges(words.slice(0, count).join(" ")));
      }
    }
    const rawTokens = line.match(/(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s'"])+/g) ?? [];
    const quoted = new Set<number>(
      rawTokens.flatMap((token, index) => (/^['"]/.test(token) ? [index] : [])),
    );
    for (const [index, token] of rawTokens.entries()) {
      // Quoted spans keep their quotes: the quoted form is the renderer's
      // atomic form, and the spelling must match the raw text. Other tokens
      // shed prose punctuation.
      const trimmed = quoted.has(index) ? trimTokenEdges(token, true) : trimTokenEdges(token);
      if (isPathToken(trimmed) || (quoted.has(index) && trimmed.length > 1)) found.add(trimmed);
    }
    const tokens = rawTokens.map((token, index) =>
      quoted.has(index) ? trimTokenEdges(token, true) : trimTokenEdges(token),
    );
    for (let index = 0; index < tokens.length; index += 1) {
      const spelling = commandSpelling(tokens, quoted, index);
      if (spelling !== undefined) found.add(spelling);
    }
  }
  return [...found];
}

/** The baseline-intact spelling oracle, exposed for mutation-test evidence. */
export function collectSpellings(
  baseline: string,
  corpus: AtomicityCorpus = {},
): readonly string[] {
  return extractSpellings(
    analyzableLines(baseline, corpus.verbatimLines ?? [])
      .filter((line) => line.analyzable)
      .map((line) => line.text),
  );
}

/**
 * A spelling matches rendered text with renderer-legal breaks: any internal
 * space may be a wrapped line break (with continuation indent), and any
 * character boundary may carry a line break when the renderer folded an
 * atomic token mid-token. Both shapes are fragmentation when they occur.
 */
function spellingPattern(spelling: string): RegExp {
  const pieces = spelling.split(" ").map((token) =>
    [...token].map((character) => escapeRegExp(character)).join("(?:\\n *)?")
  );
  return new RegExp(pieces.join("(?: |\\n *)"), "g");
}

function escapeRegExp(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Occurrence {
  readonly matchText: string;
  readonly start: { readonly number: number; readonly column: number };
  readonly end: { readonly number: number; readonly column: number };
  readonly fragmented: boolean;
}

function occurrences(
  stream: string,
  spelling: string,
  verbatimLines: readonly string[],
): readonly Occurrence[] {
  const lines = analyzableLines(stream, verbatimLines);
  const streamText = lines.map((line) => line.text).join("\n");
  const found: Occurrence[] = [];
  const pattern = spellingPattern(spelling);
  pattern.lastIndex = 0;
  for (;;) {
    const match = pattern.exec(streamText);
    if (match === null) break;
    const start = locate(lines, match.index);
    const end = locate(lines, match.index + match[0].length - 1);
    const touchesUnanalyzable = lines
      .slice(start.index, end.index + 1)
      .some((line) => !line.analyzable);
    found.push({
      matchText: match[0],
      start: { number: start.number, column: start.column },
      end: { number: end.number, column: end.column },
      fragmented: start.number !== end.number && !touchesUnanalyzable,
    });
    pattern.lastIndex = match.index + 1;
  }
  return found;
}

/**
 * Split occurrences align by position among all occurrences of the spelling:
 * the k-th occurrence in the actual output must correspond to the k-th
 * occurrence in the baseline. An occurrence is a defect when it is
 * fragmented, the baseline has no k-th occurrence, the baseline k-th
 * occurrence was intact, or its matched text differs from the baseline k-th
 * occurrence's matched text. A baseline allowance is therefore bound to its
 * position and shape and cannot be reused elsewhere.
 */
function alignedWithBaseline(
  occurrence: Occurrence,
  baseline: readonly Occurrence[],
  ordinal: number,
): boolean {
  const counterpart = baseline[ordinal];
  return (
    counterpart !== undefined &&
    counterpart.fragmented === occurrence.fragmented &&
    counterpart.matchText === occurrence.matchText
  );
}

export function checkAtomicRendering(
  actual: string,
  baseline: string,
  corpus: AtomicityCorpus = {},
): void {
  const verbatimLines = corpus.verbatimLines ?? [];
  const spellings = new Set<string>(extractSpellings(
    analyzableLines(baseline, verbatimLines).filter((line) => line.analyzable).map((line) => line.text),
  ));
  const defects: string[] = [];
  for (const spelling of spellings) {
    const baselineOccurrences = occurrences(baseline, spelling, verbatimLines);
    const actualOccurrences = occurrences(actual, spelling, verbatimLines);
    for (const [ordinal, occurrence] of actualOccurrences.entries()) {
      if (!occurrence.fragmented) continue;
      if (!alignedWithBaseline(occurrence, baselineOccurrences, ordinal)) {
        defects.push(
          `${JSON.stringify(spelling)} fragmented from line ${occurrence.start.number}` +
            ` column ${occurrence.start.column} to line ${occurrence.end.number}` +
            ` column ${occurrence.end.column} with no position-aligned baseline allowance`,
        );
      }
    }
  }
  if (defects.length > 0) {
    throw new Error(`Atomic rendering violated:\n${defects.join("\n")}`);
  }
}

function locate(
  lines: readonly StreamLine[],
  offset: number,
): { readonly index: number; readonly number: number; readonly column: number } {
  let cursor = 0;
  for (const [index, line] of lines.entries()) {
    const end = cursor + line.text.length;
    if (offset <= end) return { index, number: line.number, column: offset - cursor + 1 };
    cursor = end + 1;
  }
  throw new Error(`Offset ${offset} outside analyzed stream`);
}