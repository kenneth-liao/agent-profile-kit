/**
 * Injectable prompt seam (DEC-035, TEST-001 interactive flows; spec #640
 * US-004, issue #643).
 *
 * Prompts are a rendering concern at the CLI presentation boundary: the seam
 * takes injectable input and output streams and a clock, mirroring the
 * progress seam, so interactive flows are exercisable without a
 * pseudo-terminal. The single prompt dependency (`@inquirer/core`, ADR-0050)
 * answers the question; this seam owns stream lifecycle, cancellation,
 * answer interpretation, and the shared picker chrome so no consumer
 * re-derives them.
 *
 * Shared picker chrome (US-004, DEC-001 glyphs): every prompt kind uses the
 * same `❯` focus marker, multi-select choices use `◻`/`◼`, one concise
 * control hint reflows at the terminal width without breaking words, and
 * filter text plus selection state stay visible while filtering — never an
 * Instructions block and never repeated control text.
 *
 * Answer contract: an explicit yes accepts; an empty or unrecognized answer
 * declines (the default answer is no — DEC-019/DEC-004); an abort keystroke
 * (Ctrl-C/Ctrl-D), an input error, or an ended input stream cancels.
 */
import {
  createPrompt,
  isBackspaceKey,
  isDownKey,
  isEnterKey,
  isSpaceKey,
  isUpKey,
  useState,
  useRef,
  useKeypress,
  type KeypressEvent,
} from "@inquirer/core";
import { PassThrough, type Readable, type Writable } from "node:stream";

import {
  GLYPHS,
  styleSemanticText,
  terminalPresentationContext,
  type SemanticCategory,
  type TerminalStream,
} from "./terminal-presentation.js";
import { wrapProjectIdentity } from "./display-path.js";

/** Terminal outcome of one confirm prompt. */
export type PromptAnswer = "accepted" | "declined" | "cancelled";

/**
 * Controllable timer seam mirroring the progress seam (DEC-035). The confirm
 * prompt asks synchronously and schedules nothing; later prompt kinds take
 * time-aware behavior through the same seam.
 */
export interface PromptClock {
  setTimeout(callback: () => void, delayMs: number): () => void;
}

export interface ConfirmPromptOptions {
  /** Injectable interactive input stream; TTY evidence is read here. */
  readonly input: Readable;
  /** Injectable output stream for the question. */
  readonly output: Writable;
  readonly clock?: PromptClock;
}

export type ConfirmPrompt = (question: string) => Promise<PromptAnswer>;

/**
 * One labelled choice offered by a choice prompt. Single-select search
 * reuses this shape: every choice is always eligible, so there is no
 * initial-selection state to misrepresent. `annotation` is short per-choice
 * evidence (for example "not found") rendered beside the title without
 * joining filter matching — #644 supplies it without changing this chrome.
 */
export interface PromptChoice<T> {
  readonly title: string;
  readonly value: T;
  readonly annotation?: string;
}

/**
 * One labelled choice offered by a searchable multi-select prompt: the
 * title/value pair plus the caller's initial selection. Choice order is the
 * caller's order. Later consumers (uninstall Project selection #499,
 * configure membership #500, Host detection #644) reuse this seam without
 * new prompt kinds.
 */
export interface SearchableMultiChoice<T> {
  readonly title: string;
  readonly value: T;
  readonly selected?: boolean;
  readonly annotation?: string;
}

export interface SearchableSelectOptions {
  /** Maximum visible suggestions. */
  readonly limit?: number;
  /**
   * Injectable choice filter (TEST-002 / #542 causal discrimination). The
   * product path always uses `searchableSuggest`; tests gate that same
   * export's delivery without replacing the prompt wrapper.
   */
  readonly suggest?: (
    input: string,
    choices: readonly { readonly title: string; readonly value?: unknown }[],
  ) => Promise<readonly { readonly title: string; readonly value?: unknown }[]>;
}
export type SelectAnswer<T> =
  | { readonly kind: "selected"; readonly value: T }
  | { readonly kind: "cancelled" };

/** Terminal outcome of one multiselect prompt. */
export type MultiSelectAnswer<T> =
  | { readonly kind: "selected"; readonly values: readonly T[] }
  | { readonly kind: "cancelled" };

export interface MultiSelectOptions {
  /** Minimum number of selected choices before submit is accepted. */
  readonly min?: number;
}

export interface SearchableMultiSelectOptions extends MultiSelectOptions {
  readonly limit?: number;
  readonly suggest?: SearchableSelectOptions["suggest"];
}

/** Raw-mode capability the prompt dependency probes on TTY-shaped inputs. */
type RawModeInput = Readable & {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  unref?(): unknown;
  ref?(): unknown;
};

/** Interactive evidence lives on the injected input stream, read once here. */
export function isInteractiveInput(input: Readable): boolean {
  return (input as RawModeInput).isTTY === true;
}

/** The carriage stream the prompt dependency reads from. */
type CarriageStream = PassThrough & {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
};

type Key = KeypressEvent & { readonly sequence?: string; readonly meta?: boolean };

/** Printable single characters only: control bytes never enter a filter. */
function isTypingKey(key: Key): boolean {
  const sequence = key.sequence;
  return (
    typeof sequence === "string" &&
    sequence.length === 1 &&
    sequence.charCodeAt(0) >= 32 &&
    sequence.charCodeAt(0) !== 127 &&
    key.ctrl !== true &&
    key.meta !== true
  );
}

function isAbortKey(key: Key): boolean {
  return key.sequence === "\x03" || key.sequence === "\x04";
}

/**
 * The shared width and color policy (ADR-0016): the prompt seam is a human
 * rendering boundary, so it takes the same trusted context as every other
 * human view instead of re-deriving terminal policy.
 */
function outputPresentation(output: Writable): { width: number; color: boolean } {
  const context = terminalPresentationContext(output as TerminalStream);
  return { width: context.width, color: context.color };
}

/**
 * The prompt dependency ends its output stream when a question settles. The
 * injected output is owned by the caller and often carries later settled
 * lines and further questions, so the dependency writes into a relay that
 * never closes the caller's stream.
 */
function relayOutput(output: Writable): Writable {
  const relay = new PassThrough();
  relay.pipe(output, { end: false });
  return relay;
}

/**
 * Word wrap that never breaks a word (US-004: the control hint reflows at
 * the terminal width without breaking words).
 */
function wrapOnSpaces(text: string, width: number): string[] {
  if (width <= 0 || text.length <= width) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "" || lines.length === 0) lines.push(line);
  return lines;
}

/**
 * Wrap one choice title inside the measure left beside its row prefix.
 * Locations break at `/` boundaries without losing a character (US-009);
 * other titles break at spaces without breaking a word (US-004).
 */
function wrapRowTitle(title: string, width: number): string[] {
  if (width <= 0 || title.length <= width) return [title];
  return title.includes("/") ? [...wrapProjectIdentity(title, width)] : wrapOnSpaces(title, width);
}

function tint(text: string, category: SemanticCategory | undefined, color: boolean): string {
  return styleSemanticText(text, category, color);
}

/** The shared focus marker, accent-colored as prompt interaction. */
function focusMark(color: boolean): string {
  return tint(`${GLYPHS.focus} `, "command", color);
}

function blankMark(): string {
  return "  ";
}

function checkboxMark(selected: boolean, color: boolean): string {
  const glyph = selected ? GLYPHS.multiSelectOn : GLYPHS.multiSelectOff;
  return tint(`${glyph} `, "command", color);
}

const HINT_SELECT = `↑↓ move ${GLYPHS.actionSeparator} enter select`;
const HINT_MULTI = `↑↓ move ${GLYPHS.actionSeparator} space toggle ${GLYPHS.actionSeparator} enter submit`;
const HINT_SEARCH_SELECT = `type to filter ${GLYPHS.actionSeparator} ${HINT_SELECT}`;
const HINT_SEARCH_MULTI = `type to filter ${GLYPHS.actionSeparator} ${HINT_MULTI}`;

/**
 * One prompt execution on a private carriage, so the injected input stream
 * itself is never mutated and cancellation is safe from any cause: abort
 * keystrokes, an ended input (the dependency's own EOF path never resolves —
 * the seam converts input end into the supported AbortSignal), or a reject.
 */
async function askQuestion<T>(
  input: RawModeInput,
  output: Writable,
  run: (context: {
    input: Readable;
    output: Writable;
    signal: AbortSignal;
    clearPromptOnDone: boolean;
  }) => Promise<T>,
): Promise<T | undefined> {
  if (
    input.readableEnded ||
    input.destroyed ||
    (input as { writableEnded?: boolean }).writableEnded === true
  ) {
    return undefined;
  }

  input.ref?.();
  const carriage = new PassThrough() as CarriageStream;
  if (input.isTTY === true) {
    carriage.isTTY = true;
    carriage.setRawMode = (mode: boolean) => input.setRawMode?.(mode);
  }

  const controller = new AbortController();
  let cancelledFromInput = false;
  const cancelFromInput = (): void => {
    if (cancelledFromInput) return;
    cancelledFromInput = true;
    controller.abort();
    carriage.end();
  };
  input.once("end", cancelFromInput);
  input.once("close", cancelFromInput);
  input.once("error", cancelFromInput);

  // The prompt dependency defers its first render on modern streams and
  // discards keystrokes that arrive before keypress handlers register. The
  // seam buffers early keystrokes and delivers them after that first render,
  // so an injected write that lands with the question is never lost. Abort
  // bytes are recognized here rather than forwarded: a PTY EOF surfaces as
  // Ctrl-D, and the dependency's readline closes on that byte without
  // settling the question (Ctrl-C is its only built-in abort).
  const early: Array<Buffer | string> = [];
  let delivering = false;
  const onData = (chunk: Buffer | string): void => {
    if (cancelledFromInput) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.includes("\x03") || text.includes("\x04")) {
      cancelFromInput();
      return;
    }
    if (delivering) carriage.write(chunk);
    else early.push(chunk);
  };
  input.on("data", onData);
  // A prior question pauses the injected input on release; an explicitly
  // paused stream does not re-enter flowing mode from a `data` listener
  // alone, so the seam resumes it for this question.
  input.resume();

  // Settle through one promise that handles the dependency's rejection the
  // moment it fires — an abort can land before the caller awaits, and a
  // bare rejected promise would surface as an unhandled rejection.
  const pending = (async (): Promise<T | undefined> => {
    try {
      return await run({
        input: carriage,
        output: relayOutput(output),
        signal: controller.signal,
        clearPromptOnDone: true,
      });
    } catch {
      return undefined;
    }
  })();

  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!cancelledFromInput) {
    delivering = true;
    for (const chunk of early.splice(0)) carriage.write(chunk);
  }

  const releaseInput = (): void => {
    input.removeListener("data", onData);
    input.removeListener("end", cancelFromInput);
    input.removeListener("close", cancelFromInput);
    input.removeListener("error", cancelFromInput);
    input.pause();
    input.unref?.();
    carriage.end();
  };

  try {
    return await pending;
  } finally {
    releaseInput();
  }
}

/** The settled line one prompt leaves behind: success or neutral, never a notice. */
function writeSettledLine(
  output: Writable,
  message: string,
  role: "success" | "neutral",
  answer?: string,
): void {
  if ((output as { writableEnded?: boolean }).writableEnded === true) return;
  const { color } = outputPresentation(output);
  const prefix = tint(`${GLYPHS[role]} `, role, color);
  const body = tint(message, role, color);
  const suffix =
    answer === undefined
      ? ""
      : ` ${tint(GLYPHS.actionSeparator, "command", color)} ${tint(answer, role, color)}`;
  output.write(`\n${prefix}${body}${suffix}\n`);
}

interface PickerRow {
  readonly index: number;
  readonly title: string;
  readonly value: unknown;
  readonly annotation?: string;
}

interface PickerConfig {
  readonly message: string;
  readonly rows: readonly PickerRow[];
  readonly multi: boolean;
  readonly searchable: boolean;
  readonly min: number;
  readonly limit: number;
  readonly initiallySelected: ReadonlySet<number>;
  readonly suggest: NonNullable<SearchableSelectOptions["suggest"]>;
  readonly width: number;
  readonly color: boolean;
}

type PickerResult =
  | { readonly kind: "selected"; readonly index: number }
  | { readonly kind: "selected-multi"; readonly indices: readonly number[] }
  | { readonly kind: "cancelled" };

function filterRows(
  config: PickerConfig,
  filter: string,
): Promise<readonly PickerRow[]> {
  if (!config.searchable || filter.trim() === "") {
    return Promise.resolve(config.rows);
  }
  return config.suggest(
    filter,
    config.rows.map((row) => ({ title: row.title, value: row.value })),
  ).then((matches) => {
    // Match back by the suggest input echo (title + value), never by `value`
    // alone: distinct rows may share a value.
    const matched = new Set(
      matches.map((match) => `${match.title}\u0000${String(match.value)}`),
    );
    return config.rows.filter((row) =>
      matched.has(`${row.title}\u0000${String(row.value)}`),
    );
  });
}

/**
 * The one picker chrome shared by single-select, multi-select, and their
 * searchable forms (US-004). Confirm and text prompts use the same focus
 * marker through their question line.
 */
const createPickerPrompt = createPrompt<PickerResult, PickerConfig>((config, done) => {
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<number>>(config.initiallySelected);
  const [visible, setVisible] = useState<readonly PickerRow[]>(config.rows);
  const [pending, setPending] = useState(false);
  const [minError, setMinError] = useState(false);
  const filterRef = useRef(filter);

  const refresh = (nextFilter: string): void => {
    if (!config.searchable) return;
    setPending(true);
    void filterRows(config, nextFilter).then((rows) => {
      // A later keystroke owns the visible list; never apply a stale resolve.
      if (nextFilter !== filterRef.current) return;
      setVisible(rows);
      setCursor(0);
      setPending(false);
    });
  };

  useKeypress((rawKey) => {
    const key = rawKey as Key;
    if (isAbortKey(key)) {
      done({ kind: "cancelled" });
      return;
    }
    if (isEnterKey(key)) {
      if (config.multi) {
        if (selected.size < config.min) {
          setMinError(true);
          return;
        }
        done({
          kind: "selected-multi",
          indices: [...selected].sort((a, b) => a - b),
        });
        return;
      }
      const row = visible[cursor];
      if (row === undefined) return;
      done({ kind: "selected", index: row.index });
      return;
    }
    if (isUpKey(key)) {
      setMinError(false);
      if (visible.length === 0) return;
      setCursor((cursor + visible.length - 1) % visible.length);
      return;
    }
    if (isDownKey(key)) {
      setMinError(false);
      if (visible.length === 0) return;
      setCursor((cursor + 1) % visible.length);
      return;
    }
    if (config.multi && isSpaceKey(key)) {
      setMinError(false);
      const row = visible[cursor];
      if (row === undefined) return;
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(row.index)) next.delete(row.index);
        else next.add(row.index);
        return next;
      });
      return;
    }
    if (isBackspaceKey(key)) {
      if (!config.searchable) return;
      setMinError(false);
      const next = filter.slice(0, -1);
      filterRef.current = next;
      setFilter(next);
      refresh(next);
      return;
    }
    if (config.searchable && isTypingKey(key)) {
      if (config.multi && key.sequence === " ") return;
      setMinError(false);
      const next = filter + (key.sequence ?? "");
      filterRef.current = next;
      setFilter(next);
      refresh(next);
      return;
    }
  });

  const width = config.width;
  const color = config.color;
  const hint = config.searchable
    ? config.multi
      ? HINT_SEARCH_MULTI
      : HINT_SEARCH_SELECT
    : config.multi
      ? HINT_MULTI
      : HINT_SELECT;

  const lines: string[] = [
    `${focusMark(color)}${tint(config.message, "heading", color)}`,
    ...wrapOnSpaces(hint, width).map((line) => tint(line, undefined, color)),
  ];

  if (config.searchable && (filter !== "" || pending)) {
    const delimiter = pending ? "…" : GLYPHS.actionSeparator;
    lines.push(
      `${tint(delimiter, "command", color)}${filter === "" ? "" : ` ${tint(filter, undefined, color)}`}`,
    );
  }

  if (config.multi) {
    lines.push(tint(`${selected.size} selected`, undefined, color));
  }

  if (minError && config.min > 0) {
    lines.push(
      `${tint(`${GLYPHS.warning} `, "warning", color)}${tint(
        `select at least ${config.min}`,
        "warning",
        color,
      )}`,
    );
  }

  const limit = Math.max(1, config.limit);
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(limit / 2), Math.max(0, visible.length - limit)),
  );
  const window = visible.slice(start, start + limit);
  if (window.length === 0) {
    lines.push(tint("no matches", "muted", color));
  }
  const annotatedRows = config.rows.filter((row) => row.annotation !== undefined);
  const maxTitleLength = annotatedRows.length > 0
    ? Math.max(...annotatedRows.map((row) => row.title.length))
    : 0;
  for (const row of window) {
    const isFocus = visible[cursor]?.index === row.index;
    const prefix = config.multi
      ? `${isFocus ? focusMark(color) : blankMark()}${checkboxMark(selected.has(row.index), color)}`
      : `${isFocus ? focusMark(color) : blankMark()}`;
    // `❯ ` plus `◻ ` is four glyph cells in multi; two in single.
    const prefixCells = config.multi ? 4 : 2;
    if (row.annotation !== undefined) {
      const gap = Math.max(2, maxTitleLength + 2 - row.title.length);
      const titleWithGap = `${row.title}${" ".repeat(gap)}`;
      const plainLength = prefixCells + titleWithGap.length + row.annotation.length;
      if (plainLength <= width) {
        lines.push(`${prefix}${tint(titleWithGap, undefined, color)}${tint(row.annotation, "muted", color)}`);
        continue;
      }
      // Tight width: the status still sits on the first line (INT-4). The
      // title hangs: it wraps at the measure that leaves a two-space gap
      // plus the status, and later title lines indent under the prefix.
      const tightMeasure = Math.max(1, width - prefixCells - 2 - row.annotation.length);
      const tightLines = wrapRowTitle(row.title, tightMeasure);
      lines.push(
        `${prefix}${tint(tightLines[0] ?? "", undefined, color)}${tint("  ", undefined, color)}${tint(row.annotation, "muted", color)}`,
      );
      tightLines.slice(1).forEach((titleLine) => {
        lines.push(`${" ".repeat(prefixCells)}${tint(titleLine, undefined, color)}`);
      });
      continue;
    }
    const titleLines = wrapRowTitle(row.title, Math.max(1, width - prefixCells));
    titleLines.forEach((titleLine, lineIndex) => {
      const head = lineIndex === 0 ? prefix : " ".repeat(prefixCells);
      lines.push(`${head}${tint(titleLine, undefined, color)}`);
    });
  }

  return lines.join("\n");
});

/**
 * One single-choice prompt: the focused choice is submitted with enter;
 * cancellation follows the shared answer contract.
 */
export function createSelectPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async <T>(
    questionText: string,
    choices: readonly PromptChoice<T>[],
  ): Promise<SelectAnswer<T>> => {
    const { width, color } = outputPresentation(output);
    const result = await askQuestion(input, output, (context) =>
      createPickerPrompt(
        {
          message: questionText,
          rows: choices.map((choice, index) => ({
            index,
            title: choice.title,
            value: choice.value,
            ...(choice.annotation === undefined
              ? {}
              : { annotation: choice.annotation }),
          })),
          multi: false,
          searchable: false,
          min: 0,
          limit: choices.length || 1,
          initiallySelected: new Set(),
          suggest: searchableSuggest,
          width,
          color,
        },
        context,
      ),
    );
    return finishSingle(questionText, choices, result, output);
  };
}

/**
 * One multi-choice prompt: space toggles a choice, enter submits; a refused
 * minimum submit stays open until answered or cancelled.
 */
export function createMultiSelectPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async <T>(
    questionText: string,
    choices: readonly PromptChoice<T>[],
    selection: MultiSelectOptions = {},
  ): Promise<MultiSelectAnswer<T>> => {
    const { width, color } = outputPresentation(output);
    const result = await askQuestion(input, output, (context) =>
      createPickerPrompt(
        {
          message: questionText,
          rows: choices.map((choice, index) => ({
            index,
            title: choice.title,
            value: choice.value,
            ...(choice.annotation === undefined
              ? {}
              : { annotation: choice.annotation }),
          })),
          multi: true,
          searchable: false,
          min: selection.min ?? 0,
          limit: choices.length || 1,
          initiallySelected: new Set(),
          suggest: searchableSuggest,
          width,
          color,
        },
        context,
      ),
    );
    return finishMulti(questionText, choices, result, output);
  };
}

function finishMulti<T>(
  questionText: string,
  choices: readonly (PromptChoice<T> | SearchableMultiChoice<T>)[],
  result: PickerResult | undefined,
  output: Writable,
): MultiSelectAnswer<T> {
  if (result === undefined || result.kind === "cancelled") {
    writeSettledLine(output, questionText, "neutral");
    return { kind: "cancelled" };
  }
  if (result.kind !== "selected-multi") {
    writeSettledLine(output, questionText, "neutral");
    return { kind: "cancelled" };
  }
  const values = result.indices
    .map((index) => choices[index])
    .filter((choice) => choice !== undefined);
  writeSettledLine(
    output,
    questionText,
    "success",
    values.map((choice) => choice.title).join(", "),
  );
  return { kind: "selected", values: values.map((choice) => choice.value) };
}

/** The single-select settle path: every outcome leaves exactly one settled line. */
function finishSingle<T>(
  questionText: string,
  choices: readonly PromptChoice<T>[],
  result: PickerResult | undefined,
  output: Writable,
): SelectAnswer<T> {
  if (result === undefined || result.kind !== "selected") {
    writeSettledLine(output, questionText, "neutral");
    return { kind: "cancelled" };
  }
  const choice = choices[result.index];
  if (choice === undefined) {
    writeSettledLine(output, questionText, "neutral");
    return { kind: "cancelled" };
  }
  writeSettledLine(output, questionText, "success", choice.title);
  return { kind: "selected", value: choice.value };
}

/**
 * One answered free-text question: the typed line is submitted with enter;
 * cancellation follows the shared answer contract.
 */
export function createTextPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async (questionText: string): Promise<TextAnswer> => {
    const { width, color } = outputPresentation(output);
    const answer = await askQuestion(input, output, (context) =>
      textPrompt({ message: questionText, width, color }, context),
    );
    if (answer === undefined) {
      writeSettledLine(output, questionText, "neutral");
      return { kind: "cancelled" };
    }
    writeSettledLine(output, questionText, "success", answer);
    return { kind: "answered", value: answer };
  };
}

/** One answered free-text question. */
export type TextAnswer =
  | { readonly kind: "answered"; readonly value: string }
  | { readonly kind: "cancelled" };

interface TextConfig {
  readonly message: string;
  readonly width: number;
  readonly color: boolean;
  /** Single-key y/n with enter taking the default (yes/no prompts). */
  readonly yesNo?: boolean;
}

const textPrompt = createPrompt<string | undefined, TextConfig>((config, done) => {
  const [value, setValue] = useState("");

  useKeypress((rawKey) => {
    const key = rawKey as Key;
    if (isAbortKey(key)) {
      done(undefined);
      return;
    }
    if (config.yesNo === true) {
      const ch = (key.sequence ?? "").toLowerCase();
      if (ch === "y") {
        done("y");
        return;
      }
      if (ch === "n") {
        done("n");
        return;
      }
      if (isEnterKey(key)) {
        done("n");
        return;
      }
      return;
    }
    if (isEnterKey(key)) {
      done(value);
      return;
    }
    if (isBackspaceKey(key)) {
      setValue(value.slice(0, -1));
      return;
    }
    if (isTypingKey(key)) {
      setValue(value + (key.sequence ?? ""));
    }
  });

  const color = config.color;
  const marker = focusMark(color);
  const question = config.yesNo === true ? `${config.message} (y/N)` : config.message;
  const questionLines = wrapOnSpaces(question, config.width);
  const lines = questionLines.map((line, index) =>
    index === 0 ? `${marker}${tint(line, "heading", color)}` : tint(line, "heading", color),
  );
  if (config.yesNo !== true && value !== "") {
    lines.push(`${marker}${tint(value, undefined, color)}`);
  }
  return lines.join("\n");
});

/**
 * One confirm prompt bound to the given streams. Every question owns its own
 * carriage and release, so one prompt object can ask several questions and
 * cancellation is safe from any cause: the answer resolves and the streams
 * are released, so no pending prompt can outlive the interaction.
 */
export function createConfirmPrompt(options: ConfirmPromptOptions): ConfirmPrompt {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async (questionText) => {
    const { width, color } = outputPresentation(output);
    const answer = await askQuestion(input, output, (context) =>
      textPrompt({ message: questionText, width, color }, context),
    );
    if (answer === undefined) {
      writeSettledLine(output, questionText, "neutral");
      return "cancelled";
    }
    const normalized = answer.trim().toLowerCase();
    const accepted = normalized === "y" || normalized === "yes";
    writeSettledLine(output, questionText, "success", accepted ? "yes" : "no");
    return accepted ? "accepted" : "declined";
  };
}

/**
 * One yes/no question bound to the given streams: y accepts, n declines, and
 * enter takes the default answer. The default is no (an offer, not a
 * requirement), so an unattended enter never commits optional work (DEC-004).
 */
export function createYesNoPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async (questionText: string): Promise<PromptAnswer> => {
    const { width, color } = outputPresentation(output);
    const answer = await askQuestion(input, output, (context) =>
      textPrompt(
        {
          message: questionText,
          width,
          color,
          yesNo: true,
        },
        context,
      ),
    );
    if (answer === undefined) {
      writeSettledLine(output, questionText, "neutral");
      return "cancelled";
    }
    const accepted = answer.trim().toLowerCase() === "y";
    writeSettledLine(output, questionText, "success", accepted ? "yes" : "no");
    return accepted ? "accepted" : "declined";
  };
}

/**
 * Case-insensitive substring filter for searchable selection. Matches the
 * title (and string values) and preserves choice order, so Profile/Host/Project
 * inventories stay in their canonical order while typing narrows them. An
 * empty query returns every choice. Annotations never join matching.
 */
export function searchableSuggest(
  input: string,
  choices: readonly { readonly title: string; readonly value?: unknown }[],
): Promise<readonly { readonly title: string; readonly value?: unknown }[]> {
  const needle = input.trim().toLowerCase();
  if (needle === "") return Promise.resolve(choices);
  return Promise.resolve(
    choices.filter((choice) =>
      choice.title.toLowerCase().includes(needle) ||
        (typeof choice.value === "string" &&
          (choice.value as string).toLowerCase().includes(needle))
    ),
  );
}

/**
 * One searchable single-choice prompt: typing filters the choices, arrows
 * navigate, enter submits; cancellation follows the shared answer contract.
 * Selection is never pre-checked (#644 owns detected-Host preselection).
 */
export function createSearchableSelectPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async <T>(
    questionText: string,
    choices: readonly PromptChoice<T>[],
    search: SearchableSelectOptions = {},
  ): Promise<SelectAnswer<T>> => {
    const { width, color } = outputPresentation(output);
    const result = await askQuestion(input, output, (context) =>
      createPickerPrompt(
        {
          message: questionText,
          rows: choices.map((choice, index) => ({
            index,
            title: choice.title,
            value: choice.value,
            ...(choice.annotation === undefined
              ? {}
              : { annotation: choice.annotation }),
          })),
          multi: false,
          searchable: true,
          min: 0,
          limit: search.limit ?? 10,
          initiallySelected: new Set(),
          suggest: search.suggest ?? searchableSuggest,
          width,
          color,
        },
        context,
      ),
    );
    return finishSingle(questionText, choices, result, output);
  };
}

/**
 * One searchable multi-choice prompt: typing filters the choices, arrows
 * navigate, space toggles, enter submits. Selections persist across filter
 * changes (a selected choice filtered out of view stays selected); a refused
 * minimum submit stays open until answered or cancelled. Callers mark initial
 * selection with `selected` and keep their own choice order; `annotation` is
 * short per-choice evidence that never joins filter matching (#644).
 */
export function createSearchableMultiSelectPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async <T>(
    questionText: string,
    choices: readonly SearchableMultiChoice<T>[],
    selection: SearchableMultiSelectOptions = {},
  ): Promise<MultiSelectAnswer<T>> => {
    const { width, color } = outputPresentation(output);
    const initiallySelected = new Set<number>();
    choices.forEach((choice, index) => {
      if (choice.selected === true) initiallySelected.add(index);
    });
    const result = await askQuestion(input, output, (context) =>
      createPickerPrompt(
        {
          message: questionText,
          rows: choices.map((choice, index) => ({
            index,
            title: choice.title,
            value: choice.value,
            ...(choice.annotation === undefined
              ? {}
              : { annotation: choice.annotation }),
          })),
          multi: true,
          searchable: true,
          min: selection.min ?? 0,
          limit: selection.limit ?? 10,
          initiallySelected,
          suggest: selection.suggest ?? searchableSuggest,
          width,
          color,
        },
        context,
      ),
    );
    return finishMulti(questionText, choices, result, output);
  };
}
