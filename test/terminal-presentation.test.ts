import { expect, test } from "bun:test";

import {
  agentProfileKitWordmark,
  GLYPHS,
  STATE_ROLES,
  stateGlyph,
  stateHeadlinePrefix,
  styleSemanticText,
  terminalPresentationContext,
} from "../cli/terminal-presentation.js";

test("terminal presentation enables color only for color-capable interactive streams", () => {
  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { TERM: "xterm-256color" },
    ),
  ).toEqual({ interactive: true, width: 80, color: true , rows: undefined });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { TERM: "xterm-256color", NO_COLOR: "1" },
    ),
  ).toEqual({ interactive: true, width: 80, color: false , rows: undefined });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { TERM: "xterm-256color", NO_COLOR: "" },
    ),
  ).toEqual({ interactive: true, width: 80, color: true , rows: undefined });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { TERM: "dumb" },
    ),
  ).toEqual({ interactive: true, width: 80, color: false , rows: undefined });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      {},
    ),
  ).toEqual({ interactive: true, width: 80, color: false , rows: undefined });

  expect(
    terminalPresentationContext(
      { isTTY: false, columns: 0 },
      { TERM: "xterm-256color" },
    ),
  ).toEqual({ interactive: false, width: 80, color: false , rows: undefined });
});

test("DEC-001 roles style names and headings as bold default and reserve state colors for state glyphs and headlines", () => {
  const color = true;
  expect(styleSemanticText("Projects", "heading", color)).toBe("\u001b[1mProjects\u001b[0m");
  expect(styleSemanticText("~/projects/demo", "path", color)).toBe("\u001b[1m~/projects/demo\u001b[0m");
  expect(styleSemanticText("apkit update", "command", color)).toBe("\u001b[36mapkit update\u001b[0m");
  expect(styleSemanticText("secondary", "muted", color)).toBe("\u001b[2msecondary\u001b[0m");
  expect(styleSemanticText("Installed", "success", color)).toBe("\u001b[32mInstalled\u001b[0m");
  expect(styleSemanticText("Host attention required", "warning", color)).toBe("\u001b[33mHost attention required\u001b[0m");
  expect(styleSemanticText("Blocker", "error", color)).toBe("\u001b[31mBlocker\u001b[0m");
  expect(styleSemanticText("Cancelled", "neutral", color)).toBe("Cancelled");
  expect(styleSemanticText("Projects", "heading", color)).not.toContain("\u001b[1;34m");
  expect(styleSemanticText("~/projects/demo", "path", color)).not.toContain("\u001b[35m");
});

test("DEC-001 glyphs cover every state and interaction role for sibling tickets", () => {
  expect(GLYPHS).toEqual({
    success: "✔",
    warning: "⚠",
    error: "✖",
    neutral: "●",
    actionSeparator: "›",
    focus: "❯",
    multiSelectOff: "◻",
    multiSelectOn: "◼",
  });
  expect(STATE_ROLES).toEqual(["success", "warning", "error", "neutral"]);
  for (const role of STATE_ROLES) {
    expect(stateGlyph(role)).toBe(GLYPHS[role]);
    expect(stateHeadlinePrefix(role)).toBe(`${GLYPHS[role]} `);
  }
});

test("state glyphs stay visible without color so every state remains distinguishable", () => {
  expect(stateHeadlinePrefix("error")).toBe("✖ ");
  expect(styleSemanticText(stateHeadlinePrefix("success") + "Installed", "success", false))
    .toBe("✔ Installed");
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
