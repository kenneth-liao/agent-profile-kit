import { expect, test } from "bun:test";

import {
  agentProfileKitWordmark,
  terminalPresentationContext,
} from "../cli/terminal-presentation.js";

test("terminal presentation enables color only for color-capable interactive streams", () => {
  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { TERM: "xterm-256color" },
    ),
  ).toEqual({ interactive: true, width: 80, color: true });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { TERM: "xterm-256color", NO_COLOR: "1" },
    ),
  ).toEqual({ interactive: true, width: 80, color: false });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { TERM: "xterm-256color", NO_COLOR: "" },
    ),
  ).toEqual({ interactive: true, width: 80, color: true });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { TERM: "dumb" },
    ),
  ).toEqual({ interactive: true, width: 80, color: false });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      {},
    ),
  ).toEqual({ interactive: true, width: 80, color: false });

  expect(
    terminalPresentationContext(
      { isTTY: false, columns: 0 },
      { TERM: "xterm-256color" },
    ),
  ).toEqual({ interactive: false, width: 80, color: false });
});

test("the Agent Profile Kit wordmark chooses a fitting ASCII form or omits itself", () => {
  const ordinary = agentProfileKitWordmark(40);
  expect(ordinary.join("\n")).toContain("Agent Profile Kit");
  expect(Math.max(...ordinary.map((line) => line.length))).toBeLessThanOrEqual(40);

  const narrow = agentProfileKitWordmark(10);
  expect(narrow.join("\n")).toContain("APKIT");
  expect(Math.max(...narrow.map((line) => line.length))).toBeLessThanOrEqual(10);

  expect(agentProfileKitWordmark(3)).toEqual([]);
});
