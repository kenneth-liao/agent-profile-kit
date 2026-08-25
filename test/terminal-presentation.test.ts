import { expect, test } from "bun:test";

import {
  agentProfileKitWordmark,
  renderHumanOutput,
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

test("human presentation styles semantic lines without changing their words", () => {
  const text = [
    "Commands:",
    "  status",
    "Workspace: ~/.agents/agent-profile-kit/workspace",
    "Initialized Agent Profile Kit Workspace",
    "Updates ready for 1 project (1 file addition).",
    "Apply blocked",
    "Apply completed with blockers",
    "Apply completed with attention",
    "Apply complete",
    "Attention required",
    "Some Projects intentionally uninstalled",
    "Intentionally uninstalled",
    "C:\\projects\\Error: profile",
    "Warnings:",
    "apkit: warning: tracked output",
    "  Blocker: tracked output",
    "",
  ].join("\n");

  const colored = renderHumanOutput(
    text,
    { color: true, interactive: true, width: 80 },
    { commandNames: ["status"] },
  );

  expect(colored).toContain("\u001b[1;34mCommands:\u001b[0m");
  expect(colored).toContain("\u001b[36m  status\u001b[0m");
  expect(colored).toContain("\u001b[35mWorkspace: ~/.agents/agent-profile-kit/workspace\u001b[0m");
  expect(colored).toContain("\u001b[32mInitialized Agent Profile Kit Workspace\u001b[0m");
  expect(colored).toContain(
    "\u001b[32mUpdates ready for 1 project (1 file addition).\u001b[0m",
  );
  expect(colored).toContain("\u001b[31mApply blocked\u001b[0m");
  expect(colored).toContain("\u001b[31mApply completed with blockers\u001b[0m");
  expect(colored).toContain("\u001b[33mApply completed with attention\u001b[0m");
  expect(colored).toContain("\u001b[32mApply complete\u001b[0m");
  expect(colored).toContain("\u001b[33mAttention required\u001b[0m");
  expect(colored).toContain("\u001b[32mSome Projects intentionally uninstalled\u001b[0m");
  expect(colored).toContain("\u001b[32mIntentionally uninstalled\u001b[0m");
  expect(colored).toContain("\u001b[33mWarnings:\u001b[0m");
  expect(colored).toContain("\u001b[33mapkit: warning: tracked output\u001b[0m");
  expect(colored).toContain("\u001b[31m  Blocker: tracked output\u001b[0m");
  expect(colored).toContain("Blocker: tracked output");
  expect(colored).toContain("C:\\projects\\Error: profile");
  expect(colored).not.toContain("\u001b[1;34mC:\\projects\\Error: profile");

  expect(
    renderHumanOutput(text, { color: false, interactive: true, width: 80 }),
  ).toBe(text);
});

test("human presentation does not style indented wrapped prose as a new sentence", () => {
  const colored = renderHumanOutput(
    "A long sentence begins here.\n  The continuation remains ordinary prose.",
    { color: true, interactive: true, width: 40 },
  );

  expect(colored).toContain("\u001b[2mA long sentence begins here.\u001b[0m");
  expect(colored).toContain("\n  The continuation remains ordinary prose.");
  expect(colored).not.toContain("\u001b[2m  The continuation");
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
