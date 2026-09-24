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
import { GLYPHS } from "../cli/terminal-presentation.js";

/** A fake interactive input stream: the prompt seam reads TTY evidence from it. */
function fakeInteractiveInput(): PassThrough & { isTTY: true } {
  const stream = new PassThrough() as PassThrough & { isTTY: true };
  stream.isTTY = true;
  return stream;
}

function collectingOutput(columns?: number): PassThrough & { chunks: Buffer[]; frames: string[] } {
  const stream = new PassThrough() as PassThrough & { chunks: Buffer[]; frames: string[] };
  stream.chunks = [];
  stream.frames = [];
  if (columns !== undefined) {
    (stream as { columns?: number }).columns = columns;
    (stream as { isTTY?: boolean }).isTTY = true;
  }
  stream.on("data", (chunk: Buffer) => {
    stream.chunks.push(chunk);
    stream.frames.push(chunk.toString());
  });
  return stream;
}

function written(output: { chunks: Buffer[] }): string {
  return Buffer.concat(output.chunks).toString();
}

/** Wait until the live picker frame contains `fragment` (never a fixed sleep). */
async function waitForFrame(
  output: { frames: string[] },
  fragment: string,
  deadlineMs = 2000,
): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const frame = lastPickerFrame(output);
    if (frame.includes(fragment)) return frame;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for picker frame fragment: ${fragment}\n--- frame ---\n${frame}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * The last live picker frame (the settled `✔ …` line is a separate write
 * after the prompt clears, so it is never the frame that carries chrome).
 */
function lastPickerFrame(output: { frames: string[] }): string {
  const frames = output.frames.map((frame) =>
    frame.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""),
  );
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index] ?? "";
    if (frame.includes("enter select") || frame.includes("enter submit")) return frame;
  }
  return frames[frames.length - 1] ?? "";
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

  test("renders the question with the shared focus marker", async () => {
    const input = fakeInteractiveInput();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk));
    const confirm = createConfirmPrompt({ input, output });
    const pending = confirm("Replace changed generated files?");
    input.write("y\n");
    await pending;
    const text = Buffer.concat(chunks).toString();
    expect(text).toContain("Replace changed generated files?");
    expect(text).toContain(GLYPHS.focus);
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

  test("marks the focused choice with the shared focus marker", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput();
    const select = createSelectPrompt({ input, output });
    const pending = select("Which Profile?", [
      { title: "coding", value: "coding" },
      { title: "ops", value: "ops" },
    ]);
    input.write("\x1b[B\r");
    await pending;
    const text = written(output);
    expect(text).toContain("Which Profile?");
    expect(text).toContain("coding");
    expect(text).toContain("ops");
    expect(text).toContain(GLYPHS.focus);
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

  test("renders multi-select checkboxes with the shared glyphs", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput();
    const multi = createMultiSelectPrompt({ input, output });
    const pending = multi("Which Agent Hosts?", [
      { title: "claude", value: "claude" },
      { title: "codex", value: "codex" },
    ]);
    input.write(" \r");
    await pending;
    const text = written(output);
    expect(text).toContain(GLYPHS.multiSelectOn);
    expect(text).toContain(GLYPHS.multiSelectOff);
    expect(text).toContain(GLYPHS.focus);
  });

  test("rejects a submit with no selected choice when a minimum is set", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput();
    const multi = createMultiSelectPrompt({ input, output });
    const pending = multi(
      "Which Agent Hosts?",
      [{ title: "codex", value: "codex" }],
      { min: 1 },
    );
    // An empty submit is refused (min 1); the later cancel still unwinds.
    await waitForFrame(output, "enter submit");
    input.write("\r");
    await waitForFrame(output, "select at least 1");
    input.end();
    expect(await pending).toEqual({ kind: "cancelled" });
  });

  test("refuses a minimum-selection submit and stays open until answered", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput();
    const multi = createMultiSelectPrompt({ input, output });
    const pending = multi(
      "Which Agent Hosts?",
      [
        { title: "codex", value: "codex" },
        { title: "pi", value: "pi" },
      ],
      { min: 1 },
    );
    await waitForFrame(output, "enter submit");
    input.write("\r");
    await waitForFrame(output, "select at least 1");
    input.write(" \r");
    expect(await pending).toEqual({ kind: "selected", values: ["codex"] });
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
    const text = Buffer.concat(chunks).toString();
    expect(text).toContain("Which Agent Hosts?");
    expect(text).toContain("claude");
    expect(text).toContain("codex");
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
    const pending = yesNo("Set up this folder as your Workspace?");
    input.write("y");
    expect(await pending).toBe("accepted");
  });

  test("declines an explicit no", async () => {
    const input = fakeInteractiveInput();
    const yesNo = createYesNoPrompt({ input, output: new PassThrough() });
    const pending = yesNo("Set up this folder as your Workspace?");
    input.write("n");
    expect(await pending).toBe("declined");
  });

  test("takes the default answer — no — on enter", async () => {
    const input = fakeInteractiveInput();
    const yesNo = createYesNoPrompt({ input, output: new PassThrough() });
    const pending = yesNo("Set up this folder as your Workspace?");
    input.write("\r");
    expect(await pending).toBe("declined");
  });

  test("renders the shared focus marker and the y/N control hint", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput();
    const yesNo = createYesNoPrompt({ input, output });
    const pending = yesNo("Install as listed?");
    input.write("y");
    await pending;
    const text = written(output);
    expect(text).toContain(GLYPHS.focus);
    expect(text).toContain("(y/N)");
  });

  test("cancels when the input stream ends before an answer", async () => {
    const input = fakeInteractiveInput();
    const yesNo = createYesNoPrompt({ input, output: new PassThrough() });
    const pending = yesNo("Set up this folder as your Workspace?");
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
    const output = collectingOutput();
    const select = createSearchableSelectPrompt({ input, output });
    const pending = select("Which Profile?", [
      { title: "coding", value: "coding" },
      { title: "ops", value: "ops" },
    ]);
    await waitForFrame(output, "enter select");
    input.write("op");
    await waitForFrame(output, "› op");
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
    const output = collectingOutput();
    const select = createSearchableSelectPrompt({ input, output });
    const pending = select("Which Profile?", [
      { title: "First", value: "one" },
      { title: "Second", value: "two" },
    ]);
    await waitForFrame(output, "enter select");
    // "two" appears only in the value, never in a title.
    input.write("two");
    await waitForFrame(output, "› two");
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", value: "two" });
  });
});

describe("shared picker chrome (US-004)", () => {
  test("searchable select shows one control hint and no Instructions block", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput(80);
    const select = createSearchableSelectPrompt({ input, output });
    const pending = select("Which Profile?", [
      { title: "coding", value: "coding" },
      { title: "ops", value: "ops" },
    ]);
    await waitForFrame(output, "enter select");
    input.write("\r");
    await pending;
    const frame = lastPickerFrame(output);
    expect(frame).toContain(GLYPHS.focus);
    expect(frame).not.toContain("Instructions");
    expect(frame).not.toContain("Type to filter, ");
    expect(frame.split("enter select").length - 1).toBe(1);
  });

  test("the control hint reflows at 60 columns without breaking words", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput(60);
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi(
      "Which Agent Hosts?",
      [
        { title: "claude", value: "claude" },
        { title: "codex", value: "codex" },
      ],
      { min: 0 },
    );
    await waitForFrame(output, "enter submit");
    input.write("\r");
    await pending;
    const frame = lastPickerFrame(output);
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
    // Word tokens of the hint survive intact (no mid-word breaks).
    expect(frame.replace(/\s+/g, " ")).toContain("space toggle");
    expect(frame.replace(/\s+/g, " ")).toContain("enter submit");
  });

  test("the control hint wraps at the narrowest measure without breaking words", async () => {
    // The searchable-multi hint is wider than MIN_HUMAN_WIDTH, so this is a
    // real reflow (the 60-column case above may fit on one line).
    const input = fakeInteractiveInput();
    const output = collectingOutput(40);
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi(
      "Which Agent Hosts?",
      [
        { title: "claude", value: "claude" },
        { title: "codex", value: "codex" },
      ],
      { min: 0 },
    );
    await waitForFrame(output, "enter submit");
    input.write("\r");
    await pending;
    const frame = lastPickerFrame(output);
    const hintLines = frame.split("\n").filter((line) => line.includes("move") || line.includes("toggle") || line.includes("submit") || line.includes("filter"));
    expect(hintLines.length).toBeGreaterThan(1);
    for (const line of frame.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    const squashed = frame.replace(/\s+/g, " ");
    expect(squashed).toContain("type to filter");
    expect(squashed).toContain("space toggle");
    expect(squashed).toContain("enter submit");
  });

  test("filter text and selection state stay visible while filtering", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput(80);
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi(
      "Which Agent Hosts?",
      [
        { title: "claude", value: "claude", selected: true },
        { title: "codex", value: "codex" },
        { title: "pi", value: "pi" },
      ],
      { min: 0 },
    );
    input.write("pi");
    await waitForFrame(output, "1 selected");
    const frame = lastPickerFrame(output);
    expect(frame).toContain("pi");
    expect(frame).toContain("1 selected");
    input.write("\r");
    await pending;
  });

  test("no repeated control text appears after filtering to one result", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput(80);
    const select = createSearchableSelectPrompt({ input, output });
    const pending = select("Which Profile?", [
      { title: "coding", value: "coding" },
      { title: "ops", value: "ops" },
    ]);
    input.write("ops");
    await waitForFrame(output, "› ops");
    const frame = lastPickerFrame(output);
    expect(frame).not.toContain("Instructions");
    expect(frame).not.toContain("Filtered results for:");
    expect(frame.split("enter select").length - 1).toBe(1);
    input.write("\r");
    await pending;
  });

  test("annotations render beside titles without joining filter matching", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput(80);
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi(
      "Which Agent Hosts?",
      [
        { title: "codex", value: "codex", annotation: "not found" },
        { title: "pi", value: "pi", annotation: "installed" },
      ],
      { min: 0 },
    );
    await waitForFrame(output, "not found");
    const frame = lastPickerFrame(output);
    expect(frame).toContain("not found");
    expect(frame).toContain("installed");
    expect(frame).toMatch(/codex {2}not found/);
    expect(frame).toMatch(/pi {5}installed/);
    // Filtering on the annotation text must not match any choice.
    input.write("found");
    await waitForFrame(output, "no matches");
    expect(lastPickerFrame(output)).toContain("no matches");
    input.end();
    await pending;
  });

  test("picker choices show status on the same line at 100 and 60 columns", async () => {
    for (const columns of [100, 60]) {
      const input = fakeInteractiveInput();
      const output = collectingOutput(columns);
      const multi = createSearchableMultiSelectPrompt({ input, output });
      const pending = multi(
        "Which agents?",
        [
          { title: "claude", value: "claude", annotation: "detected" },
          { title: "codex", value: "codex", annotation: "detected" },
          { title: "antigravity", value: "antigravity", annotation: "not found" },
          { title: "pi", value: "pi", annotation: "not found" },
        ],
        { min: 0 },
      );
      await waitForFrame(output, "not found");
      const frame = lastPickerFrame(output);
      const lines = frame.split("\n");
      const claudeLine = lines.find((l) => l.includes("claude"))!;
      const codexLine = lines.find((l) => l.includes("codex"))!;
      const antigravityLine = lines.find((l) => l.includes("antigravity"))!;
      const piLine = lines.find((l) => l.includes("pi"))!;

      expect(claudeLine).toMatch(/claude {7}detected/);
      expect(codexLine).toMatch(/codex {8}detected/);
      expect(antigravityLine).toMatch(/antigravity {2}not found/);
      expect(piLine).toMatch(/pi {11}not found/);
      input.end();
      await pending;
    }
  });
});

describe("searchable multiselect prompt seam", () => {
  test("toggles choices with space and submits with enter", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput();
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi(
      "Which Agent Hosts?",
      [
        { title: "claude", value: "claude" },
        { title: "codex", value: "codex" },
      ],
      { min: 1 },
    );
    await waitForFrame(output, "enter submit");
    input.write(" ");
    await waitForFrame(output, "1 selected");
    input.write("\x1b[B ");
    await waitForFrame(output, "2 selected");
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", values: ["claude", "codex"] });
  });

  test("keeps pre-selected choices checked and retains them across filters", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput();
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi("Which Agent Hosts?", [
      { title: "claude", value: "claude", selected: true },
      { title: "codex", value: "codex" },
      { title: "pi", value: "pi" },
    ]);
    // Filter to "pi", toggle it, clear the filter, then submit: both the
    // pre-selected and the filtered selection survive.
    await waitForFrame(output, "1 selected");
    input.write("pi");
    await waitForFrame(output, "› pi");
    input.write(" ");
    await waitForFrame(output, "2 selected");
    input.write("\u007f\u007f");
    await waitForFrame(output, "codex");
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
    const output = collectingOutput();
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi(
      "Which Agent Hosts?",
      [
        { title: "claude", value: "claude" },
        { title: "codex", value: "codex" },
      ],
      { min: 1 },
    );
    await waitForFrame(output, "claude");
    input.write(" \r");
    await pending;
    const text = written(output);
    expect(text).toContain("Which Agent Hosts?");
    expect(text).toContain("claude");
    expect(text).toContain("codex");
  });

  test("preserves caller choice order for #644-style preselection", async () => {
    const input = fakeInteractiveInput();
    const output = collectingOutput(80);
    const multi = createSearchableMultiSelectPrompt({ input, output });
    const pending = multi("Which Agent Hosts?", [
      { title: "claude", value: "claude", selected: true, annotation: "not found" },
      { title: "codex", value: "codex", annotation: "installed" },
      { title: "pi", value: "pi" },
    ]);
    const text = await waitForFrame(output, "enter submit");
    expect(text.indexOf("claude")).toBeLessThan(text.indexOf("codex"));
    expect(text.indexOf("codex")).toBeLessThan(text.indexOf("pi"));
    input.write("\r");
    expect(await pending).toEqual({ kind: "selected", values: ["claude"] });
  });
});
