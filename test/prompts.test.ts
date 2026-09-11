import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import {
  createConfirmPrompt,
  createMultiSelectPrompt,
  createSearchableMultiSelectPrompt,
  createSearchableSelectPrompt,
  createSelectPrompt,
  createTextPrompt,
  createYesNoPrompt,
  isInteractiveInput,
} from "../cli/prompts.js";

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

describe("select prompt seam", () => {
  test("selects the highlighted choice with enter", async () => {
    const input = fakeInteractiveInput();
    const select = createSelectPrompt({ input, output: new PassThrough() });
    const pending = select("Which Profile?", [
      { title: "coding", value: "coding" },
      { title: "ops", value: "ops" },
    ]);
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", value: "coding" });
  });

  test("selects a later choice after down arrows", async () => {
    const input = fakeInteractiveInput();
    const select = createSelectPrompt({ input, output: new PassThrough() });
    const pending = select("Which Profile?", [
      { title: "coding", value: "coding" },
      { title: "ops", value: "ops" },
    ]);
    input.write("\x1b[B\r");
    expect(await pending).toEqual({ kind: "selected", value: "ops" });
  });

  test("renders the question and choice titles on the injected output stream", async () => {
    const input = fakeInteractiveInput();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const select = createSelectPrompt({ input, output });
    const pending = select("Which Profile?", [
      { title: "coding", value: "coding" },
      { title: "ops", value: "ops" },
    ]);
    input.write("\r");
    await pending;
    const written = Buffer.concat(chunks).toString();
    expect(written).toContain("Which Profile?");
    expect(written).toContain("coding");
    expect(written).toContain("ops");
  });

  test("cancels when the input stream ends before an answer", async () => {
    const input = fakeInteractiveInput();
    const select = createSelectPrompt({ input, output: new PassThrough() });
    const pending = select("Which Profile?", [{ title: "coding", value: "coding" }]);
    input.end();
    expect(await pending).toEqual({ kind: "cancelled" });
  });
});

describe("multiselect prompt seam", () => {
  test("toggles choices with space and submits with enter", async () => {
    const input = fakeInteractiveInput();
    const multi = createMultiSelectPrompt({ input, output: new PassThrough() });
    const pending = multi("Which Agent Hosts?", [
      { title: "claude", value: "claude" },
      { title: "codex", value: "codex" },
    ]);
    input.write(" \x1b[B \r");
    expect(await pending).toEqual({ kind: "selected", values: ["claude", "codex"] });
  });

  test("rejects a submit with no selected choice when a minimum is set", async () => {
    const input = fakeInteractiveInput();
    const multi = createMultiSelectPrompt({ input, output: new PassThrough() });
    const pending = multi(
      "Which Agent Hosts?",
      [{ title: "codex", value: "codex" }],
      { min: 1 },
    );
    // An empty submit is refused (min 1); the later cancel still unwinds.
    input.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.end();
    expect(await pending).toEqual({ kind: "cancelled" });
  });

  test("accepts no selection without a minimum", async () => {
    const input = fakeInteractiveInput();
    const multi = createMultiSelectPrompt({ input, output: new PassThrough() });
    const pending = multi("Which Agent Hosts?", [{ title: "codex", value: "codex" }]);
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", values: [] });
  });

  test("renders the question and choice titles on the injected output stream", async () => {
    const input = fakeInteractiveInput();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const multi = createMultiSelectPrompt({ input, output });
    const pending = multi("Which Agent Hosts?", [
      { title: "claude", value: "claude" },
      { title: "codex", value: "codex" },
    ]);
    input.write(" \r");
    await pending;
    const written = Buffer.concat(chunks).toString();
    expect(written).toContain("Which Agent Hosts?");
    expect(written).toContain("claude");
    expect(written).toContain("codex");
  });

  test("cancels when the input stream ends before an answer", async () => {
    const input = fakeInteractiveInput();
    const multi = createMultiSelectPrompt({ input, output: new PassThrough() });
    const pending = multi("Which Agent Hosts?", [{ title: "codex", value: "codex" }]);
    input.end();
    expect(await pending).toEqual({ kind: "cancelled" });
  });
});

describe("yes/no prompt seam", () => {
  test("accepts an explicit yes", async () => {
    const input = fakeInteractiveInput();
    const yesNo = createYesNoPrompt({ input, output: new PassThrough() });
    const pending = yesNo("Set up your first Profile now?");
    input.write("y");
    expect(await pending).toBe("accepted");
  });

  test("declines an explicit no", async () => {
    const input = fakeInteractiveInput();
    const yesNo = createYesNoPrompt({ input, output: new PassThrough() });
    const pending = yesNo("Set up your first Profile now?");
    input.write("n");
    expect(await pending).toBe("declined");
  });

  test("takes the default answer — no — on enter", async () => {
    const input = fakeInteractiveInput();
    const yesNo = createYesNoPrompt({ input, output: new PassThrough() });
    const pending = yesNo("Set up your first Profile now?");
    input.write("\r");
    expect(await pending).toBe("declined");
  });

  test("cancels when the input stream ends before an answer", async () => {
    const input = fakeInteractiveInput();
    const yesNo = createYesNoPrompt({ input, output: new PassThrough() });
    const pending = yesNo("Set up your first Profile now?");
    input.end();
    expect(await pending).toBe("cancelled");
  });
});

describe("text prompt seam", () => {
  test("answers with the submitted line", async () => {
    const input = fakeInteractiveInput();
    const text = createTextPrompt({ input, output: new PassThrough() });
    const pending = text("What should the Profile be named?");
    input.write("my-profile\r");
    expect(await pending).toEqual({ kind: "answered", value: "my-profile" });
  });

  test("cancels when the input stream ends before an answer", async () => {
    const input = fakeInteractiveInput();
    const text = createTextPrompt({ input, output: new PassThrough() });
    const pending = text("What should the Profile be named?");
    input.end();
    expect(await pending).toEqual({ kind: "cancelled" });
  });
});

describe("prompt seam interactivity", () => {
  test("reads interactivity from the injected input stream", () => {
    expect(isInteractiveInput(fakeInteractiveInput())).toBe(true);
    expect(isInteractiveInput(new PassThrough())).toBe(false);
  });
});

describe("searchable select prompt seam", () => {
  test("filters choices by typing and selects the match with enter", async () => {
    const input = fakeInteractiveInput();
    const select = createSearchableSelectPrompt({ input, output: new PassThrough() });
    const pending = select("Which Profile?", [
      { title: "coding", value: "coding" },
      { title: "ops", value: "ops" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write("op");
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", value: "ops" });
  });

  test("cancels when the input stream ends before an answer", async () => {
    const input = fakeInteractiveInput();
    const select = createSearchableSelectPrompt({ input, output: new PassThrough() });
    const pending = select("Which Profile?", [{ title: "coding", value: "coding" }]);
    input.end();
    expect(await pending).toEqual({ kind: "cancelled" });
  });

  test("matches string values as well as titles", async () => {
    const input = fakeInteractiveInput();
    const select = createSearchableSelectPrompt({ input, output: new PassThrough() });
    const pending = select("Which Profile?", [
      { title: "First", value: "one" },
      { title: "Second", value: "two" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // "two" appears only in the value, never in a title.
    input.write("two");
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", value: "two" });
  });
});

describe("searchable multiselect prompt seam", () => {
  test("toggles choices with space and submits with enter", async () => {
    const input = fakeInteractiveInput();
    const multi = createSearchableMultiSelectPrompt({ input, output: new PassThrough() });
    const pending = multi(
      "Which Agent Hosts?",
      [
        { title: "claude", value: "claude" },
        { title: "codex", value: "codex" },
      ],
      { min: 1 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write(" \x1b[B ");
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", values: ["claude", "codex"] });
  });

  test("keeps pre-selected choices checked and retains them across filters", async () => {
    const input = fakeInteractiveInput();
    const multi = createSearchableMultiSelectPrompt({ input, output: new PassThrough() });
    const pending = multi("Which Agent Hosts?", [
      { title: "claude", value: "claude", selected: true },
      { title: "codex", value: "codex" },
      { title: "pi", value: "pi" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Filter to "pi", toggle it, clear the filter, then submit: both the
    // pre-selected and the filtered selection survive.
    input.write("pi");
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.write(" ");
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.write("\u007f\u007f");
    await new Promise((resolve) => setTimeout(resolve, 30));
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", values: ["claude", "pi"] });
  });

  test("cancels when the input stream ends before an answer", async () => {
    const input = fakeInteractiveInput();
    const multi = createSearchableMultiSelectPrompt({ input, output: new PassThrough() });
    const pending = multi("Which Agent Hosts?", [{ title: "codex", value: "codex" }]);
    input.end();
    expect(await pending).toEqual({ kind: "cancelled" });
  });

  test("renders the question and choice titles on the injected output stream", async () => {
    const input = fakeInteractiveInput();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi("Which Agent Hosts?", [
      { title: "claude", value: "claude" },
      { title: "codex", value: "codex" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write(" \r");
    await pending;
    const written = Buffer.concat(chunks).toString();
    expect(written).toContain("Which Agent Hosts?");
    expect(written).toContain("claude");
    expect(written).toContain("codex");
  });
});
