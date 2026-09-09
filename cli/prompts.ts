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

const defaultClock: PromptClock = {
  setTimeout: (callback, delayMs) => {
    const handle = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(handle);
  },
};

export interface ConfirmPromptOptions {
  /** Injectable interactive input stream; TTY evidence is read here. */
  readonly input: Readable;
  /** Injectable output stream for the question. */
  readonly output: Writable;
  readonly clock?: PromptClock;
}

export type ConfirmPrompt = (question: string) => Promise<PromptAnswer>;

/** Raw-mode capability the prompt dependency probes on TTY-shaped inputs. */
type RawModeInput = Readable & {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  unref?(): unknown;
};

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
 * One confirm prompt bound to the given streams. Cancellation is safe from
 * any cause: the answer resolves and both streams are released, so no
 * pending prompt can outlive the interaction.
 */
export function createConfirmPrompt(options: ConfirmPromptOptions): ConfirmPrompt {
  const clock = options.clock ?? defaultClock;
  void clock;
  const input = options.input as RawModeInput;
  const output = options.output;

  // The prompt dependency listens for keypresses and probes raw mode on its
  // input. A private carriage stream carries keystrokes from the injected
  // input, forwarding TTY evidence and raw-mode control, so the injected
  // stream itself is never mutated and cancellation can be synthesized when
  // the input ends (the dependency's own EOF path never resolves).
  const carriage = new PassThrough() as CarriageStream;
  if (input.isTTY === true) {
    carriage.isTTY = true;
    carriage.setRawMode = (mode: boolean) => input.setRawMode?.(mode);
  }
  // end: false — the answer path ends the carriage itself, so an ended input
  // can still deliver the synthesized abort keystroke.
  input.pipe(carriage, { end: false });

  return (question) => {
    // An input that ended before the question was asked can never answer: the
    // prompt dependency's own EOF path never resolves, so cancel immediately.
    if (input.readableEnded || input.destroyed) return Promise.resolve("cancelled");
    const pending = promptsPackage({
      type: "text",
      name: "answer",
      message: question,
      stdin: carriage,
      stdout: output,
    }).then(
      (answers): PromptAnswer => {
        const answer = answers["answer"];
        if (typeof answer !== "string") return "cancelled";
        const normalized = answer.trim().toLowerCase();
        return normalized === "y" || normalized === "yes" ? "accepted" : "declined";
      },
      (): PromptAnswer => "cancelled",
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
  };
}
