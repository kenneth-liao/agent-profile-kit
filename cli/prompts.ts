/**
 * Injectable confirm-prompt seam (DEC-035, TEST-001 interactive flows).
 *
 * Prompts are a rendering concern at the CLI presentation boundary: the seam
 * takes injectable input and output streams and a clock, mirroring the
 * progress seam, so interactive flows are exercisable without a
 * pseudo-terminal. The single prompt dependency (DEC-036) answers the
 * question; this seam owns stream lifecycle, cancellation, and answer
 * interpretation so no consumer re-derives them.
 *
 * Answer contract: an explicit yes accepts; an empty or unrecognized answer
 * declines (the default answer is no — DEC-019); an abort keystroke
 * (Ctrl-C/Ctrl-D), an input error, or an ended input stream cancels.
 */
import promptsPackage from "prompts";
import { PassThrough, type Readable, type Writable } from "node:stream";

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

/** One labelled choice offered by a choice prompt. */
export interface PromptChoice<T> {
  readonly title: string;
  readonly value: T;
}

/** Terminal outcome of one select prompt. */
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

/** Raw-mode capability the prompt dependency probes on TTY-shaped inputs. */
type RawModeInput = Readable & {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  unref?(): unknown;
  ref?(): unknown;
};

/** Raw carriage question handed to the prompt dependency. */
interface CarriageQuestion {
  readonly type: "text" | "confirm" | "select" | "multiselect";
  readonly message: string;
  readonly choices?: readonly PromptChoice<unknown>[];
  readonly min?: number;
  /** Default answer for yes/no questions; the offer default is no. */
  readonly initial?: boolean;
  /** Short inline hint; the dependency renders it unwrapped, so keep it narrow. */
  readonly hint?: string;
}

/** The carriage stream the prompt dependency reads from. */
type CarriageStream = PassThrough & {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
};

/** Interactive evidence lives on the injected input stream, read once here. */
export function isInteractiveInput(input: Readable): boolean {
  return (input as RawModeInput).isTTY === true;
}

/**
 * Ask one question through the prompt dependency on a private carriage, so
 * the injected input stream itself is never mutated and cancellation is safe
 * from any cause. Resolves to the raw answer value, or undefined when the
 * question was cancelled (abort keystroke, input error, ended input).
 */
async function askCarriageQuestion<T>(
  input: RawModeInput,
  output: Writable,
  question: CarriageQuestion,
): Promise<T | undefined> {
  // An input that ended before the question was asked can never answer: the
  // prompt dependency's own EOF path never resolves, so cancel immediately.
  if (input.readableEnded || input.destroyed) return undefined;

  // The prompt dependency listens for keypresses and probes raw mode on its
  // input. A private carriage stream carries keystrokes from the injected
  // input, forwarding TTY evidence and raw-mode control, so the injected
  // stream itself is never mutated and cancellation can be synthesized when
  // the input ends (the dependency's own EOF path never resolves).
  // Re-reference the input for this question: release unreferences it so a
  // finished interaction never blocks process exit, and a real TTY would
  // otherwise leave the event loop empty while a later question of the same
  // flow is pending (typed data is still buffered and delivered once ref'd).
  input.ref?.();
  const carriage = new PassThrough() as CarriageStream;
  if (input.isTTY === true) {
    carriage.isTTY = true;
    carriage.setRawMode = (mode: boolean) => input.setRawMode?.(mode);
  }
  // end: false — the answer path ends the carriage itself, so an ended input
  // can still deliver the synthesized abort keystroke.
  input.pipe(carriage, { end: false });

  const pending = promptsPackage({
    type: question.type,
    name: "answer",
    message: question.message,
    ...(question.initial === undefined ? {} : { initial: question.initial }),
    ...(question.choices === undefined ? {} : { choices: [...(question.choices as PromptChoice<unknown>[])] }),
    ...(question.min === undefined ? {} : { min: question.min }),
    ...(question.hint === undefined ? {} : { hint: question.hint }),
    stdin: carriage,
    stdout: output,
  }).then(
    (answers) => answers["answer"] as T | undefined,
    (): T | undefined => undefined,
  );

  // Cancellation before any answer: synthesize the abort keystroke so the
  // prompt dependency unwinds its own readline instead of hanging on a
  // closed stream. Several input events can race; only the first acts.
  let cancelledFromInput = false;
  const cancelFromInput = (): void => {
    if (cancelledFromInput) return;
    cancelledFromInput = true;
    carriage.write("\u0004");
    carriage.end();
  };
  input.once("end", cancelFromInput);
  input.once("close", cancelFromInput);
  input.once("error", cancelFromInput);
  const releaseInput = (): void => {
    input.removeListener("end", cancelFromInput);
    input.removeListener("close", cancelFromInput);
    input.removeListener("error", cancelFromInput);
    input.unpipe(carriage);
    input.pause();
    input.unref?.();
    carriage.end();
  };
  void pending.then(releaseInput);
  return pending;
}

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
    const answer = await askCarriageQuestion<string>(input, output, {
      type: "text",
      message: questionText,
    });
    if (typeof answer !== "string") return "cancelled";
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes" ? "accepted" : "declined";
  };
}

/**
 * One yes/no question bound to the given streams: y accepts, n declines, and
 * enter takes the default answer. The default is no (an offer, not a
 * requirement), so an unattended enter never commits optional work. The
 * answer contract otherwise matches the confirm seam, including cancellation
 * on abort, input error, or an ended input stream.
 */
export function createYesNoPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async (questionText: string): Promise<PromptAnswer> => {
    const answer = await askCarriageQuestion<boolean>(input, output, {
      type: "confirm",
      message: questionText,
      initial: false,
    });
    if (typeof answer !== "boolean") return "cancelled";
    return answer ? "accepted" : "declined";
  };
}

/** One answered free-text question. */
export type TextAnswer =
  | { readonly kind: "answered"; readonly value: string }
  | { readonly kind: "cancelled" };

/**
 * One free-text question bound to the given streams: the typed line is
 * submitted with enter; cancellation follows the shared answer contract.
 * Every question owns its own carriage and release, so one prompt object can
 * ask several questions.
 */
export function createTextPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async (questionText: string): Promise<TextAnswer> => {
    const answer = await askCarriageQuestion<string>(input, output, {
      type: "text",
      message: questionText,
    });
    return typeof answer === "string"
      ? { kind: "answered", value: answer }
      : { kind: "cancelled" };
  };
}

/**
 * One single-choice prompt bound to the given streams: the highlighted
 * choice is submitted with enter; cancellation follows the shared answer
 * contract. Every question owns its own carriage and release, so one prompt
 * object can ask several questions.
 */
export function createSelectPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async <T>(
    questionText: string,
    choices: readonly PromptChoice<T>[],
  ): Promise<SelectAnswer<T>> => {
    const answer = await askCarriageQuestion<T>(input, output, {
      type: "select",
      message: questionText,
      choices,
      hint: "\u2191/\u2193, enter.",
    });
    return answer === undefined ? { kind: "cancelled" } : { kind: "selected", value: answer };
  };
}

/**
 * One multi-choice prompt bound to the given streams: space toggles a
 * choice, enter submits; a refused minimum submit stays open until answered
 * or cancelled. Every question owns its own carriage and release, so one
 * prompt object can ask several questions.
 */
export function createMultiSelectPrompt(options: ConfirmPromptOptions) {
  const input = options.input as RawModeInput;
  const output = options.output;

  return async <T>(
    questionText: string,
    choices: readonly PromptChoice<T>[],
    selection: MultiSelectOptions = {},
  ): Promise<MultiSelectAnswer<T>> => {
    const answer = await askCarriageQuestion<readonly T[]>(input, output, {
      type: "multiselect",
      message: questionText,
      choices,
      ...(selection.min === undefined ? {} : { min: selection.min }),
    });
    return answer === undefined
      ? { kind: "cancelled" }
      : { kind: "selected", values: [...answer] };
  };
}
