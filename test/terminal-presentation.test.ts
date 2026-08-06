import { expect, test } from "bun:test";

import {
  agentProfileKitWordmark,
  renderHumanOutput,
  terminalPresentationContext,
} from "../cli/terminal-presentation.js";

test("terminal presentation enables color only for interactive streams without NO_COLOR", () => {
  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      {},
    ),
  ).toEqual({ interactive: true, width: 80, color: true });

  expect(
    terminalPresentationContext(
      { isTTY: true, columns: 80 },
      { NO_COLOR: "" },
    ),
  ).toEqual({ interactive: true, width: 80, color: false });

  expect(
    terminalPresentationContext(
      { isTTY: false, columns: 0 },
      {},
    ),
  ).toEqual({ interactive: false, width: 80, color: false });
});

test("human presentation styles semantic lines without changing their words", () => {
  const text = [
    "Commands:",
    "  status",
    "Workspace: ~/.agents/agent-profile-kit/workspace",
    "Initialized Agent Profile Kit Workspace",
    "Ready to apply",
    "Apply blocked",
    "Apply completed with blockers",
    "Apply completed with attention",
    "Apply complete",
    "Attention required",
    "Some Projects intentionally uninstalled",
    "Intentionally uninstalled",
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
  expect(colored).toContain("\u001b[32mReady to apply\u001b[0m");
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

  expect(
    renderHumanOutput(text, { color: false, interactive: true, width: 80 }),
  ).toBe(text);
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
