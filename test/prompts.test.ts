import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { createConfirmPrompt, isInteractiveInput } from "../cli/prompts.js";

/** A fake interactive input stream: the prompt seam reads TTY evidence from it. */
function fakeInteractiveInput(): PassThrough & { isTTY: true } {
  const stream = new PassThrough() as PassThrough & { isTTY: true };
  stream.isTTY = true;
  return stream;
}

describe("confirm prompt seam", () => {
  test("accepts an explicit yes answer", async () => {
    const input = fakeInteractiveInput();
    const confirm = createConfirmPrompt({ input, output: new PassThrough() });
    const pending = confirm("Replace changed generated files?");
    input.write("y\n");
    expect(await pending).toBe("accepted");
  });

  test("accepts an uppercase yes answer", async () => {
    const input = fakeInteractiveInput();
    const confirm = createConfirmPrompt({ input, output: new PassThrough() });
    const pending = confirm("Replace changed generated files?");
    input.write("Y\n");
    expect(await pending).toBe("accepted");
  });

  test("accepts a spelled-out yes answer", async () => {
    const input = fakeInteractiveInput();
    const confirm = createConfirmPrompt({ input, output: new PassThrough() });
    const pending = confirm("Replace changed generated files?");
    input.write("yes\n");
    expect(await pending).toBe("accepted");
  });

  test("declines an explicit no answer", async () => {
    const input = fakeInteractiveInput();
    const confirm = createConfirmPrompt({ input, output: new PassThrough() });
    const pending = confirm("Replace changed generated files?");
    input.write("n\n");
    expect(await pending).toBe("declined");
  });

  test("declines an empty answer — the default is no", async () => {
    const input = fakeInteractiveInput();
    const confirm = createConfirmPrompt({ input, output: new PassThrough() });
    const pending = confirm("Replace changed generated files?");
    input.write("\n");
    expect(await pending).toBe("declined");
  });

  test("declines an unrecognized answer instead of guessing", async () => {
    const input = fakeInteractiveInput();
    const confirm = createConfirmPrompt({ input, output: new PassThrough() });
    const pending = confirm("Replace changed generated files?");
    input.write("maybe\n");
    expect(await pending).toBe("declined");
  });

  test("cancels when the input stream ends before an answer", async () => {
    const input = fakeInteractiveInput();
    const confirm = createConfirmPrompt({ input, output: new PassThrough() });
    const pending = confirm("Replace changed generated files?");
    input.end();
    expect(await pending).toBe("cancelled");
  });

  test("cancels when the input stream already ended before the question is asked", async () => {
    const input = fakeInteractiveInput();
    const confirm = createConfirmPrompt({ input, output: new PassThrough() });
    input.end();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await confirm("Replace changed generated files?")).toBe("cancelled");
  });

  test("renders the question on the injected output stream", async () => {
    const input = fakeInteractiveInput();
    const output = new PassThrough();
    const confirm = createConfirmPrompt({ input, output });
    const pending = confirm("Replace changed generated files?");
    input.write("y\n");
    await pending;
    const written = output.read()?.toString() ?? "";
    expect(written).toContain("Replace changed generated files?");
  });

  test("accepts an injectable clock without using wall time", async () => {
    const input = fakeInteractiveInput();
    let scheduled = 0;
    const confirm = createConfirmPrompt({
      input,
      output: new PassThrough(),
      clock: {
        setTimeout: (callback, _delayMs) => {
          scheduled += 1;
          const handle = globalThis.setTimeout(callback, 0);
          return () => globalThis.clearTimeout(handle);
        },
      },
    });
    const pending = confirm("Replace changed generated files?");
    input.write("y\n");
    expect(await pending).toBe("accepted");
    expect(scheduled).toBe(0);
  });
});

describe("prompt seam interactivity", () => {
  test("reads interactivity from the injected input stream", () => {
    expect(isInteractiveInput(fakeInteractiveInput())).toBe(true);
    expect(isInteractiveInput(new PassThrough())).toBe(false);
  });
});
