import { expect, test } from "bun:test";
import { Writable } from "node:stream";

import { delimitedContext, displayPath } from "../cli/presentation.js";
import { diagnosticDocument } from "../cli/diagnostics.js";
import {
  formatCompactOperationTime,
  omitsOperationDetailsHint,
  operationDetailsDocument,
  operationHistoryEntryDocument,
  operationHistoryListDocument,
  writeLifecycleReport,
} from "../cli/operation-history-presentation.js";
import type { OperationHistoryEntry } from "../installer/operation-history.js";
import { beginLifecycleOperationRecording } from "../cli/operation-recording.js";
import { terminalPresentationContext } from "../cli/terminal-presentation.js";
import {
  type CommandArg,
  commandPart,
  footerNodes,
  identifierPart,
  type InlineContent,
  neutralStatementDocument,
  pathPart,
  renderPresentationDocument,
} from "../cli/presentation-document.js";

const arg = (value: string): CommandArg => ({ kind: "text", value });

const redirected = { color: false, interactive: false, width: 80 , rows: undefined } as const;

test("renders a prose document to text for a terminal presentation context", () => {
  const text = renderPresentationDocument(
    [{ kind: "prose", parts: ["Ready to update."], category: "success" }],
    redirected,
  );
  expect(text).toBe("Ready to update.");
});

test("renders heading, key-value, identifier, and list-item nodes as distinct lines", () => {
  const text = renderPresentationDocument(
    [
      { kind: "heading", text: "Projects (1)" },
      {
        kind: "key-value",
        key: "Workspace",
        value: { kind: "identifier", value: "engineering" },
      },
      { kind: "list-item", parts: ["status reads the selected Project"] },
    ],
    redirected,
  );
  expect(text).toBe(
    [
      "Projects (1)",
      "Workspace: engineering",
      "- status reads the selected Project",
    ].join("\n"),
  );
});

test("styles a notice by its severity rather than as a heading", () => {
  const document = [
    { kind: "heading" as const, text: "Projects (1)" },
    {
      kind: "notice" as const,
      severity: "error" as const,
      nodes: [{ kind: "prose" as const, parts: ["2 Blockers"] }],
    },
  ];

  const colored = renderPresentationDocument(document, {
    color: true,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  expect(colored).toContain("\u001b[1mProjects (1)\u001b[0m");
  expect(colored).toContain("\u001b[31m✖ 2 Blockers\u001b[0m");
  expect(colored).not.toContain("\u001b[1;34mProjects (1)");
  expect(colored).not.toContain("\u001b[1;34m2 Blockers");

  const plain = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  expect(plain).toBe("Projects (1)\n✖ 2 Blockers");
  expect(plain).not.toMatch(/\u001b/);
});

test("opens every state notice with its glyph and colors only the headline", () => {
  const document = [
    {
      kind: "notice" as const,
      severity: "warning" as const,
      nodes: [
        { kind: "prose" as const, parts: ["Host attention required"] },
        { kind: "prose" as const, parts: ["Trust the bound project in Codex."] },
        { kind: "sentence" as const, parts: ["Run ", { kind: "command" as const, program: "apkit", args: [{ kind: "text" as const, value: "status" }] }, " to verify."] },
      ],
    },
  ];

  const colored = renderPresentationDocument(document, {
    color: true,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  const lines = colored.split("\n");
  expect(lines[0]).toBe("\u001b[33m⚠ Host attention required\u001b[0m");
  expect(lines[1]).toBe("Trust the bound project in Codex.");
  expect(lines[2]).toContain("Run ");
  expect(lines[2]).toContain("\u001b[36mapkit status\u001b[0m");
  expect(lines[2]).not.toContain("\u001b[33m");
  expect(lines[2]).not.toContain("\u001b[2m");
  for (const role of [
    ["success", "✔", "\u001b[32m"],
    ["error", "✖", "\u001b[31m"],
    ["neutral", "●", ""],
  ] as const) {
    const rendered = renderPresentationDocument([{
      kind: "notice",
      severity: role[0],
      nodes: [{ kind: "prose", parts: ["State"] }],
    }], { color: true, interactive: true, width: 80, rows: undefined });
    if (role[2] === "") {
      expect(rendered).toBe(`${role[1]} State`);
    } else {
      expect(rendered).toBe(`${role[2]}${role[1]} State\u001b[0m`);
    }
  }
});

test("renders actionable guidance in the default color with commands in the accent", () => {
  const document = diagnosticDocument({
    happened: ["Profile 'codng' was not found"],
    why: [["Available Profiles: coding, writing"]],
    whatToType: [["Run ", { kind: "command" as const, program: "apkit", args: [{ kind: "text" as const, value: "list" }, { kind: "text" as const, value: "profiles" }] }, " to inspect them."]],
  });

  const colored = renderPresentationDocument(document, {
    color: true,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  const lines = colored.split("\n");
  expect(lines[0]).toBe("\u001b[31m✖ apkit: Profile 'codng' was not found\u001b[0m");
  expect(lines[1]).toBe("Available Profiles: coding, writing");
  expect(lines[1]).not.toMatch(/\u001b\[2m/);
  expect(lines[1]).not.toMatch(/\u001b\[31m/);
  expect(lines[2]).toContain("\u001b[36mapkit list profiles\u001b[0m");
  expect(lines[2]).not.toMatch(/\u001b\[2m/);
  expect(colored).not.toContain("Did you mean");
});

test("keeps nearest-match suggestions outside error and muted coloring", () => {
  const document = diagnosticDocument({
    happened: ["Profile 'codng' was not found"],
    why: [["Did you mean 'coding'?"], ["Available Profiles: coding, writing"]],
    whatToType: [["Choose an available Profile, then run ", { kind: "command" as const, program: "apkit", args: [{ kind: "text" as const, value: "install" }] }, "."]],
  });

  const colored = renderPresentationDocument(document, {
    color: true,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  const plain = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  for (const guidance of ["Did you mean 'coding'?", "Available Profiles: coding, writing"]) {
    expect(plain).toContain(guidance);
    expect(colored).toContain(guidance);
    const line = colored.split("\n").find((candidate) => candidate.includes(guidance))!;
    expect(line).not.toContain("\u001b[31m");
    expect(line).not.toContain("\u001b[2m");
    expect(line).not.toContain("\u001b[33m");
  }
});

test("wraps prose and carries its style across every wrapped line", () => {
  const sentence =
    "Blocker: generated output is occupied by a foreign file that Agent Profile Kit does not own.";
  const colored = renderPresentationDocument(
    [{ kind: "prose", parts: [sentence], category: "error" }],
    { color: true, interactive: true, width: 40 , rows: undefined },
  );
  const lines = colored.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(line.startsWith("\u001b[31m")).toBe(true);
    expect(line.endsWith("\u001b[0m")).toBe(true);
    expect(stripAnsi(line).length).toBeLessThanOrEqual(40);
  }
  expect(stripAnsi(colored).split("\n").map((line) => line.trim()).join(" ")).toBe(sentence);
});

test("holds prose to the selected measure on a wide terminal", () => {
  const sentence = Array.from({ length: 20 }, (_, index) => `word${index}`).join(" ");
  const text = renderPresentationDocument(
    [{ kind: "prose", parts: [sentence] }],
    { color: false, interactive: true, width: 100 , rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(100);
});

test("never splits a path and elides in the middle through displayPath", () => {
  const home = "/Users/kennethliao";
  const cwd = "/tmp";
  const project = `${home}/projects/deeply/nested/agent-profile-kit`;
  const context = { color: false, interactive: false, width: 40 , rows: undefined } as const;
  const text = renderPresentationDocument(
    [{
      kind: "path",
      canonicalPath: project,
      authoredPath: project,
      scope: "fleet",
    }],
    context,
    { cwd, home },
  );
  const displayed = displayPath(project, project, "fleet", cwd, home, context.width);
  expect(text).toBe(displayed);
  expect(text.split("\n")).toHaveLength(1);
  expect(text.length).toBeLessThanOrEqual(context.width);
  expect(text).toContain("…");
  expect(text.endsWith("agent-profile-kit")).toBe(true);
});

test("renders a command argument fully spelled, never middle-elided", () => {
  const home = "/Users/kennethliao";
  const cwd = "/tmp";
  const project = `${home}/projects/deeply/nested/workspaces/agent-profile-kit`;
  const context = { color: false, interactive: false, width: 40 , rows: undefined } as const;
  const text = renderPresentationDocument(
    [{
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "update" },
        {
          kind: "path",
          canonicalPath: project,
          authoredPath: project,
          scope: "fleet",
        },
      ],
    }],
    context,
    { cwd, home },
  );
  const prefix = "apkit update ";
  expect(text.split("\n")).toHaveLength(1);
  expect(text.startsWith(prefix)).toBe(true);
  // A copyable command token is executable as printed: the identity renders
  // fully spelled — never middle-elided, however wide that renders (review
  // INT-1 cycle 2 on #489) — and is quoted through the one shared shell-quoting
  // boundary so `~` still expands (#651).
  expect(text.slice(prefix.length)).toBe(
    `~/'projects/deeply/nested/workspaces/agent-profile-kit'`,
  );
});

test("aligns sibling rows into columns under a header row and right-aligns numeric cells", () => {
  const text = renderPresentationDocument(
    [
      {
        kind: "row",
        cells: [
          { column: "project", content: { kind: "identifier", value: "alpha" } },
          { column: "files", content: { kind: "identifier", value: "12" }, numeric: true },
        ],
      },
      {
        kind: "row",
        cells: [
          { column: "project", content: { kind: "identifier", value: "workspace" } },
          { column: "files", content: { kind: "identifier", value: "3" }, numeric: true },
        ],
      },
    ],
    { color: false, interactive: true, width: 80 , rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe("project    files");
  expect(lines[1]!.endsWith("12")).toBe(true);
  expect(lines[2]!.endsWith(" 3")).toBe(true);
  expect(lines[1]!.length).toBe(lines[2]!.length);
  expect(lines[1]!.indexOf("12")).toBe(lines[2]!.length - 2);
  expect(lines[0]!.endsWith("files")).toBe(true);
  expect(lines[0]!.length).toBe(lines[1]!.length);
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80);
});

test("prints a header row labeling each aligned column at the table measure", () => {
  const text = renderPresentationDocument(
    [
      {
        kind: "row",
        cells: [
          { column: "Project", content: { kind: "identifier", value: "demo" } },
          { column: "Profile", content: { kind: "identifier", value: "example" } },
          { column: "Hosts", content: { kind: "identifier", value: "codex" } },
          { column: "State", content: { kind: "identifier", value: "configured" } },
        ],
      },
    ],
    { color: false, interactive: true, width: 100, rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe("Project  Profile  Hosts  State");
  expect(lines[1]).toBe("demo     example  codex  configured");
});

test("packs labeled compact records at a narrow width without dropping facts", () => {
  const row = {
    kind: "row" as const,
    cells: [
      { column: "Project", content: { kind: "identifier" as const, value: "demo" } },
      { column: "Profile", content: { kind: "identifier" as const, value: "example" } },
      { column: "Hosts", content: { kind: "identifier" as const, value: "codex" } },
      { column: "State", content: { kind: "identifier" as const, value: "configured" } },
    ],
  };
  const text = renderPresentationDocument([row, row], {
    color: false,
    interactive: true,
    width: 60,
    rows: undefined,
  });
  const lines = text.split("\n");
  // Two records, each about two lines, with a blank line so they stay distinct.
  expect(lines.filter((line) => line.length === 0)).toHaveLength(1);
  expect(lines[lines.length - 1]!.length).toBeGreaterThan(0);
  const records = text.split("\n\n");
  expect(records).toHaveLength(2);
  for (const record of records) {
    const recordLines = record.split("\n");
    expect(recordLines.length).toBeLessThanOrEqual(2);
    expect(recordLines.join(" ")).toContain("Project: demo");
    expect(recordLines.join(" ")).toContain("Profile: example");
    expect(recordLines.join(" ")).toContain("Hosts: codex");
    expect(recordLines.join(" ")).toContain("State: configured");
  }
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(60);
});

test("degrades rows to stacked pairs when aligned columns will not fit", () => {
  const document = [
    {
      kind: "row" as const,
      cells: [
        {
          column: "project",
          content: { kind: "identifier" as const, value: "agent-profile-kit" },
        },
        {
          column: "path",
          content: {
            kind: "identifier" as const,
            value: "~/projects/agent-profile-kit",
          },
        },
      ],
    },
  ];
  const text = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 40,
    rows: undefined,
  });
  expect(text).toBe([
    "project: agent-profile-kit",
    "path: ~/projects/agent-profile-kit",
  ].join("\n"));
  expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(40);
});

test("elides a stacked path cell instead of splitting it", () => {
  const home = "/Users/kennethliao";
  const project = `${home}/projects/deeply/nested/workspaces/agent-profile-kit`;
  const text = renderPresentationDocument(
    [{
      kind: "row",
      cells: [
        {
          column: "project",
          content: { kind: "identifier", value: "agent-profile-kit" },
        },
        {
          column: "path",
          content: {
            kind: "path",
            canonicalPath: project,
            authoredPath: project,
            scope: "fleet",
          },
        },
      ],
    }],
    { color: false, interactive: true, width: 20 , rows: undefined },
    { cwd: "/tmp", home },
  );
  const lines = text.split("\n");
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(20);
  expect(text).toContain("…");
  const pathLine = lines.find((line) => line.includes("…"));
  expect(pathLine).toBeDefined();
  expect(pathLine!.endsWith("kit")).toBe(true);
});

test("lets rows use the full terminal width while prose stays at 80", () => {
  const left = "L".repeat(45);
  const right = "R".repeat(45);
  const wide = renderPresentationDocument(
    [{
      kind: "row",
      cells: [
        { column: "left", content: { kind: "identifier", value: left } },
        { column: "right", content: { kind: "identifier", value: right } },
      ],
    }],
    { color: false, interactive: true, width: 100 , rows: undefined },
  );
  const lines = wide.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe("left".padEnd(45) + "  " + "right");
  expect(wide).toContain(left);
  expect(wide).toContain(right);
  expect(Math.max(...lines.map((line) => line.length))).toBeGreaterThan(80);
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(100);
});

test("lays out a column group side by side and stacks when it will not fit", () => {
  const document = [{
    kind: "column-group" as const,
    columns: [
      [{ kind: "prose" as const, parts: ["Left column"] }],
      [{ kind: "prose" as const, parts: ["Right column"] }],
    ],
  }];
  const wide = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  expect(wide.split("\n")).toHaveLength(1);
  expect(wide.indexOf("Left column")).toBeLessThan(wide.indexOf("Right column"));

  const narrow = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 18,
    rows: undefined,
  });
  expect(narrow).toBe("Left column\nRight column");
  expect(Math.max(...narrow.split("\n").map((line) => line.length))).toBeLessThanOrEqual(18);
});

test("wraps a sentence continuously with embedded command words inline and whole", () => {
  // Plain prose that merely mentions commands: words reflow at the measure and
  // never split mid-word. Structurally supplied command atoms are covered by
  // the dedicated-copyable tests below (US-009).
  const sentence =
    "apkit: apkit status Project target '/projects/demo' is not a bound Project; " +
    "run apkit list projects or apkit bind";
  const text = renderPresentationDocument(
    [{ kind: "sentence", parts: [sentence] }],
    { color: false, interactive: false, width: 40 , rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line).not.toMatch(/\S\n/);
  }
  expect(lines.map((line) => line.trimStart()).join(" ")).toBe(sentence);
});

test("keeps a fitting prose+command node on one line without promoting the command", () => {
  // US-009, RE-1: "Use apkit status to inspect Project lifecycle diagnostics."
  // is 58 characters and fits a 60-column measure. Promotion would orphan
  // "Use" above the command (#651).
  const text = renderPresentationDocument(
    [{
      kind: "prose",
      parts: [
        "Use ",
        commandPart("apkit", [arg("status")]),
        " to inspect Project lifecycle diagnostics.",
      ],
    }],
    { color: false, interactive: false, width: 60, rows: undefined },
  );
  expect(text).toBe("Use apkit status to inspect Project lifecycle diagnostics.");
});

test("keeps a fitting command inline when a longer sentence wraps around it (RE-1)", () => {
  // The node must wrap, but `apkit status` still fits beside its lead-in on
  // one measure line: the command is not promoted when it fits (RE-1).
  const text = renderPresentationDocument(
    [{
      kind: "sentence",
      parts: [
        "See ",
        commandPart("apkit", [arg("status")]),
        " for details about this Project's lifecycle and every pending work item.",
      ],
    }],
    { color: false, interactive: false, width: 60, rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.some((line) => line.includes("See apkit status for details"))).toBe(true);
  expect(lines).not.toContain("apkit status");
});

test("places a command on its own line when it does not fit beside the prose, without sentence punctuation", () => {
  // US-009, RE-1: the command is promoted only when it does not fit; a
  // promoted command line never carries a trailing period (it would paste as
  // part of the final argument).
  const text = renderPresentationDocument(
    [{
      kind: "sentence",
      parts: [
        "Next: from the project you want to try, run ",
        commandPart("apkit", [arg("install"), arg("example"), arg("--host"), arg("codex")]),
        ".",
      ],
      category: "command",
    }],
    { color: false, interactive: false, width: 60, rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines[0]).toBe("Next: from the project you want to try, run");
  expect(lines).toHaveLength(2);
  const commandLine = lines[1]!.trim();
  expect(commandLine).toBe("apkit install example --host codex");
  for (const line of lines) {
    expect(line.trimEnd()).not.toMatch(/[.,;:]$/);
  }
});

test("fail-closed manual-recovery prose is actionable default colour (ORCH-1)", () => {
  const colored = renderPresentationDocument(
    [{
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "update" },
        { kind: "path", canonicalPath: "", scope: "fleet" },
      ],
    }],
    { color: true, interactive: true, width: 80, rows: undefined },
    { home: "/home", cwd: "/home" },
  );
  expect(colored).toContain("Manual recovery is required");
  // Remedies use the default colour — never muted (DEC-001, ORCH-1).
  expect(colored).not.toContain("\u001b[2m");
});

test("moves trailing sentence punctuation off a promoted command line", () => {
  const text = renderPresentationDocument(
    [{
      kind: "list-item",
      parts: [
        "Run ",
        commandPart("apkit", [arg("update"), { kind: "path", canonicalPath: "/projects/alpha/with/a/long/copyable/path", scope: "fleet" }]),
        ".",
      ],
    }],
    { color: false, interactive: false, width: 40, rows: undefined },
  );
  const lines = text.split("\n");
  const commandLine = lines.find((line) => line.includes("apkit update"));
  expect(commandLine).toBeDefined();
  expect(commandLine!.trimEnd()).not.toMatch(/[.,;:]$/);
  expect(commandLine!.trim()).toMatch(/^apkit update /);
  expect(lines.join("\n")).toContain("- Run");
});

test("never rewrites command-run text when dropping separator punctuation (PROD-3)", () => {
  const text = renderPresentationDocument(
    [{
      kind: "sentence",
      parts: [
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ",
        commandPart("apkit", [arg("status.")]),
        ".",
      ],
    }],
    { color: false, interactive: false, width: 40, rows: undefined },
  );
  const lines = text.split("\n");
  const commandLine = lines.find((line) => line.includes("apkit status"));
  expect(commandLine).toBeDefined();
  // The authored command text keeps its period; only the separator run drops.
  expect(commandLine!.trim()).toBe("apkit status.");
});

test("keeps an over-measure copyable command or path whole on one line", () => {
  const longPath = "/projects/alpha/with/a/very/long/copyable/path/that/exceeds/the/measure/segment";
  const text = renderPresentationDocument(
    [{
      kind: "sentence",
      parts: [
        "Update it with ",
        commandPart("apkit", [
          arg("update"),
          { kind: "path", canonicalPath: longPath, scope: "fleet" },
        ]),
        " after resolving the blocker.",
      ],
    }],
    { color: false, interactive: false, width: 60, rows: undefined },
  );
  const lines = text.split("\n");
  const commandLine = lines.find((line) => line.includes("apkit update"));
  expect(commandLine).toBeDefined();
  expect(commandLine).toContain(longPath);
  expect(commandLine!.trimEnd()).not.toMatch(/[.,;:]$/);
  for (const line of lines) {
    if (line.includes("apkit update")) continue;
    expect(line.length).toBeLessThanOrEqual(60);
  }
});

test("carries a sentence's category across every wrapped line", () => {
  const sentence = "apkit: apkit status failed because the Project target is not bound.";
  const colored = renderPresentationDocument(
    [{ kind: "sentence", parts: [sentence], category: "error" }],
    { color: true, interactive: false, width: 30 , rows: undefined },
  );
  const lines = colored.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(line.startsWith("\u001b[31m")).toBe(true);
    expect(line.endsWith("\u001b[0m")).toBe(true);
  }
});

test("renders a diagnostic document as what happened, why, and what to type", () => {
  const text = renderPresentationDocument(
    diagnosticDocument({
      happened: ["something failed"],
      whatToType: [
        ["Run ", commandPart("apkit", [arg("first-recovery")]), " to recover."],
        ["Run ", commandPart("apkit", [arg("second-recovery")]), " as an alternative."],
      ],
      usage: "status [project | --all] [--stale | --blocked] [--verbose] [--json]",
    }),
    { color: false, interactive: false, width: 80 , rows: undefined },
  );
  const lines = text.split("\n");
  // Structural shape, not unstructured string: happened in notice, then
  // whatToType lines, and usage last as one whole command line.
  expect(lines[0]).toBe("✖ apkit: something failed");
  expect(lines[1]).toBe("Run apkit first-recovery to recover.");
  expect(lines[2]).toBe("Run apkit second-recovery as an alternative.");
  expect(lines[3]).toBe("Usage: apkit status [project | --all] [--stale | --blocked] [--verbose] [--json]");
});

test("renders diagnostic cause lines after what happened and before what to type", () => {
  const text = renderPresentationDocument(
    diagnosticDocument({
      happened: ["apply failed"],
      why: [["caused by: one bad thing"], ["caused by: another bad thing"]],
      whatToType: [[
        "Run ",
        commandPart("apkit", [{ kind: "text", value: "--help" }]),
        " for available commands.",
      ]],
    }),
    { color: false, interactive: false, width: 80 , rows: undefined },
  );
  const lines = text.split("\n").filter((line) => line.length > 0);
  // Order is the structural shape: happened, then why, then what to type.
  expect(lines[0]!.startsWith("✖ apkit: ")).toBe(true);
  expect(lines.slice(1, 3).every((line) => line.startsWith("caused by: "))).toBe(true);
  expect(lines[3]!.startsWith("Run apkit")).toBe(true);
  expect(lines).toHaveLength(4);
});

test("reproduces verbatim content exactly, including fence escalation, without wrapping or styling", () => {
  const authored = "--- begin Context ---\nquoted body that would wrap at this width\n--- end Context ---\n";
  const fenced = delimitedContext(authored);
  const colored = renderPresentationDocument(
    [{ kind: "verbatim", text: fenced }],
    { color: true, interactive: true, width: 20 , rows: undefined },
  );
  expect(colored).toBe(fenced);
  expect(colored).toContain("---- begin Context ----");
  expect(colored).toContain("quoted body that would wrap at this width");
  expect(colored).not.toMatch(/\u001b/);
  expect(colored.split("\n").some((line) => line.length > 20)).toBe(true);
});

test("atomic inline parts preserve their AST shape and are never split across lines by wrapping", () => {
  const dynamicIdentifier = identifierPart("/path with spaces/and identifiers/that must stay whole");
  const dynamicCommand = commandPart("apkit", [
    { kind: "text", value: "machine" },
    { kind: "text", value: "install-temp" },
    { kind: "text", value: "--profile" },
    { kind: "text", value: "coding-v2" },
  ]);
  const dynamicPath = pathPart(
    "/var/log/my test app/diagnostics.log",
    "fleet",
  );

  expect(dynamicIdentifier).toEqual({
    kind: "identifier",
    value: "/path with spaces/and identifiers/that must stay whole",
  });
  expect(dynamicCommand).toEqual({
    args: [
      { kind: "text", value: "machine" },
      { kind: "text", value: "install-temp" },
      { kind: "text", value: "--profile" },
      { kind: "text", value: "coding-v2" },
    ],
    kind: "command",
    program: "apkit",
  });
  expect(dynamicPath).toEqual({
    canonicalPath: "/var/log/my test app/diagnostics.log",
    kind: "path",
    scope: "fleet",
  });

  const doc = [
    {
      kind: "prose" as const,
      parts: [
        "Please check ",
        dynamicIdentifier,
        " and run ",
        dynamicCommand,
        " before checking ",
        dynamicPath,
        ".",
      ],
    },
  ];

  const rendered = renderPresentationDocument(doc, {
    color: false,
    interactive: false,
    width: 60,
    rows: undefined,
  });

  const lines = rendered.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(60);
  }

  // The dynamic values with spaces must remain whole on single lines, not split across wrapped lines
  expect(lines.some((line) => line.includes("/path with spaces/and identifiers/that must stay whole"))).toBe(true);
  expect(lines.some((line) => line.includes("/var/log/my test app/diagnostics.log"))).toBe(true);
});

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}


test("renders the completed-operation detail route as one copyable command", () => {
  const document = operationDetailsDocument();

  const plain = renderPresentationDocument(document, redirected);
  // The route is separated from the receipt above it by one blank line.
  expect(plain.startsWith("\n")).toBe(true);
  expect(plain.trim()).toBe("Details: apkit details");
  expect(plain).not.toMatch(/\u001b/);

  const colored = renderPresentationDocument(document, {
    color: true,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  // The command stays one whole token on one line whatever the width.
  const stripped = colored.replace(/\u001b\[[0-9;]*m/g, "");
  expect(stripped.trim()).toBe("Details: apkit details");
});

test("footerNodes carries one action list with an optional secondary details route", () => {
  const command = (value: string) =>
    ({ kind: "command" as const, program: "apkit", args: [arg(value)] });

  const both = renderPresentationDocument(
    [
      { kind: "prose", parts: ["Body."] },
      ...footerNodes({ next: { kind: "command", value: command("status") }, details: command("details") }),
    ],
    redirected,
  );
  // One footer block: blank line after the body, then Next and Details with
  // no second blank line between them (US-010).
  expect(both).toBe("Body.\n\nNext: apkit status\nDetails: apkit details");

  const actions = renderPresentationDocument(
    [
      { kind: "prose", parts: ["Body."] },
      ...footerNodes({
        next: { kind: "actions", items: [["Run ", command("update"), " again."]] },
        details: command("details"),
      }),
    ],
    redirected,
  );
  expect(actions).toBe(
    "Body.\n\nNext:\n- Run apkit update again.\nDetails: apkit details",
  );

  const detailsOnly = renderPresentationDocument(
    [
      { kind: "prose", parts: ["Body."] },
      ...footerNodes({ details: command("details") }),
    ],
    redirected,
  );
  expect(detailsOnly).toBe("Body.\n\nDetails: apkit details");

  expect(footerNodes({})).toEqual([]);
});

test("neutralStatementDocument is one statement without an apkit: prefix", () => {
  const document = neutralStatementDocument([
    "Install was declined; nothing was written.",
  ]);
  const plain = renderPresentationDocument(document, redirected);
  expect(plain).toBe("● Install was declined; nothing was written.");
  expect(plain).not.toContain("apkit:");
  expect(document).toHaveLength(1);
});

test("omits the details hint only for clean no-ops and cancellations", () => {
  expect(omitsOperationDetailsHint("no-op", false)).toBe(true);
  expect(omitsOperationDetailsHint("cancelled", false)).toBe(true);
  // Warning-carrying endings keep the route (US-010: warnings keep actionable
  // guidance and recovery evidence).
  expect(omitsOperationDetailsHint("no-op", true)).toBe(false);
  expect(omitsOperationDetailsHint("cancelled", true)).toBe(false);
  expect(omitsOperationDetailsHint("succeeded", false)).toBe(false);
  expect(omitsOperationDetailsHint("failed", false)).toBe(false);
  expect(omitsOperationDetailsHint("partial", false)).toBe(false);
  expect(omitsOperationDetailsHint("blocked", false)).toBe(false);
});

test("keeps the details route on a no-op report that carries warnings", () => {
  class Sink extends Writable {
    readonly chunks: Buffer[] = [];
    override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
      this.chunks.push(chunk);
      callback();
    }
    text(): string {
      return Buffer.concat(this.chunks).toString();
    }
  }
  const stream: Sink & { isTTY?: boolean } = new Sink();
  stream.isTTY = false;
  const context = terminalPresentationContext(stream);
  const document = [
    ...neutralStatementDocument(["All Projects were already current."]),
    {
      kind: "list-item" as const,
      parts: ["Grok inspect --json output is not valid JSON."],
      category: "warning" as const,
    },
  ];

  const retained = beginLifecycleOperationRecording();
  retained.collect({ outcome: "no-op", scope: { selection: "all" }, projects: [] });
  writeLifecycleReport(stream, document, context, retained);
  expect(stream.text()).toContain("All Projects were already current.");
  expect(stream.text()).toContain("Details: apkit details");
});

test("writes the retained-operation route onto the report's own stream only for a retained run", () => {
  class Sink extends Writable {
    readonly chunks: Buffer[] = [];
    override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
      this.chunks.push(chunk);
      callback();
    }
    text(): string {
      return Buffer.concat(this.chunks).toString();
    }
  }
  const stream: Sink & { isTTY?: boolean } = new Sink();
  stream.isTTY = false;
  const context = terminalPresentationContext(stream);
  const document = [{ kind: "prose" as const, parts: ["Report."] }];

  // A clean no-op omits the details hint even when the run was retained
  // (US-010, DEC-010): retrieval stays available through `apkit details`.
  const noOp = beginLifecycleOperationRecording();
  noOp.collect({ outcome: "no-op", scope: { selection: "all" }, projects: [] });
  stream.chunks.length = 0;
  writeLifecycleReport(stream, document, context, noOp);
  expect(stream.text()).toContain("Report.");
  expect(stream.text()).not.toContain("Details:");

  // A neutral cancellation omits the hint for the same reason.
  const cancelled = beginLifecycleOperationRecording();
  cancelled.collect({
    outcome: "cancelled",
    scope: { selection: "all" },
    projects: [],
    cancelledReason: "declined",
  });
  stream.chunks.length = 0;
  writeLifecycleReport(stream, document, context, cancelled);
  expect(stream.text()).not.toContain("Details:");

  // Successful and failed retained runs keep the route.
  for (const outcome of ["succeeded", "failed", "partial", "blocked"] as const) {
    const retained = beginLifecycleOperationRecording();
    retained.collect({ outcome, scope: { selection: "all" }, projects: [] });
    stream.chunks.length = 0;
    writeLifecycleReport(stream, document, context, retained);
    expect(stream.text()).toContain("Report.");
    expect(stream.text()).toContain("Details: apkit details");
  }

  // `--verbose` prints the complete current-run receipt and omits the route.
  const verboseSource = beginLifecycleOperationRecording();
  verboseSource.collect({ outcome: "succeeded", scope: { selection: "all" }, projects: [] });
  stream.chunks.length = 0;
  writeLifecycleReport(stream, document, context, verboseSource, false);
  expect(stream.text()).toContain("Report.");
  expect(stream.text()).not.toContain("Details:");

  // A deliberate pre-write refusal retained nothing, so nothing is advertised.
  const refused = beginLifecycleOperationRecording();
  refused.recordNothing("test refusal");
  stream.chunks.length = 0;
  writeLifecycleReport(stream, document, context, refused);
  expect(stream.text()).toContain("Report.");
  expect(stream.text()).not.toContain("Details:");

  // A report written before its branch decided is a developer error: fail
  // loudly instead of silently dropping the route (INT-2).
  const undecided = beginLifecycleOperationRecording();
  expect(() => writeLifecycleReport(stream, document, context, undecided)).toThrow(
    /before the run's operation-history decision/,
  );
});

test("attaches the details route to an existing Next footer as one block", () => {
  class Sink extends Writable {
    readonly chunks: Buffer[] = [];
    override _write(chunk: Buffer, _encoding: string, callback: () => void): void {
      this.chunks.push(chunk);
      callback();
    }
    text(): string {
      return Buffer.concat(this.chunks).toString();
    }
  }
  const stream: Sink & { isTTY?: boolean } = new Sink();
  stream.isTTY = false;
  const context = terminalPresentationContext(stream);
  const document = [
    { kind: "prose" as const, parts: ["Report."] },
    ...footerNodes({
      next: {
        kind: "command",
        value: { kind: "command", program: "apkit", args: [arg("status")] },
      },
    }),
  ];

  const retained = beginLifecycleOperationRecording();
  retained.collect({ outcome: "succeeded", scope: { selection: "all" }, projects: [] });
  writeLifecycleReport(stream, document, context, retained);
  const text = stream.text();
  expect(text).toBe("Report.\n\nNext: apkit status\nDetails: apkit details\n");
  expect(text.match(/Details:/g)).toHaveLength(1);
  expect(text.match(/Next:/g)).toHaveLength(1);
});

test("holds the compact receipt impact and its route intact at a narrow width", () => {
  const document = [
    { kind: "prose" as const, parts: ["Updated 12 Projects (22 generated files)."] },
    ...operationDetailsDocument(),
  ];

  const narrow = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 60,
    rows: undefined,
  });
  // The impact count and the copyable detail command never split.
  expect(narrow).toContain("Updated 12 Projects (22 generated files).");
  expect(narrow).toContain("Details: apkit details");
});

test("renders a view identity without eliding it and wraps it at segment boundaries", () => {
  const identity = "group-b/nested-nested-nested/nested-nested/app";
  const text = renderPresentationDocument(
    [{
      kind: "path",
      canonicalPath: "/tmp/places/app",
      authoredPath: "/tmp/places/app",
      scope: "fleet",
      identity,
    }],
    { color: false, interactive: true, width: 24, rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.every((line) => line.length <= 24)).toBe(true);
  expect(lines.join("")).toBe(identity);
  expect(text).not.toContain("…");
});

test("wraps an identity value under its key instead of overflowing", () => {
  const identity = "group-b/nested-nested-nested/app";
  const text = renderPresentationDocument(
    [{
      kind: "key-value",
      key: "Project",
      value: {
        kind: "path",
        canonicalPath: "/tmp/places/app",
        authoredPath: "/tmp/places/app",
        scope: "fleet",
        identity,
      },
    }],
    { color: false, interactive: true, width: 24, rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines[0]!.startsWith("Project: ")).toBe(true);
  expect(lines.slice(1).every((line) => line.startsWith("  "))).toBe(true);
  expect(lines.every((line) => line.length <= 24)).toBe(true);
  expect(
    lines[0]!.replace("Project: ", "") +
      lines.slice(1).map((line) => line.trimStart()).join(""),
  ).toBe(identity);
});

test("wraps an inline identity at segment boundaries", () => {
  const identity = "group-b/nested-nested-nested/app";
  const text = renderPresentationDocument(
    [{
      kind: "list-item",
      parts: [{ kind: "path", canonicalPath: "/tmp/places/app", scope: "fleet", identity }],
    }],
    { color: false, interactive: true, width: 20, rows: undefined },
  );
  const lines = text.split("\n");
  expect(lines[0]!.startsWith("- ")).toBe(true);
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.every((line) => line.length <= 20)).toBe(true);
  expect(
    lines[0]!.slice(2) +
      lines.slice(1).map((line) => line.slice(2)).join(""),
  ).toBe(identity);
});

test("separates compact entries below the table minimum width", () => {
  const rows = ["alpha", "beta"].map((name) => ({
    kind: "row" as const,
    cells: [{ column: "project", content: { kind: "identifier" as const, value: name } }],
  }));
  const narrow = renderPresentationDocument(rows, {
    color: false,
    interactive: true,
    width: 60,
    rows: undefined,
  });
  expect(narrow).toBe("project: alpha\n\nproject: beta");
  const normal = renderPresentationDocument(rows, {
    color: false,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  expect(normal).toBe("project\nalpha\nbeta");
});

function historyEntry(overrides: Partial<OperationHistoryEntry> & Pick<OperationHistoryEntry, "outcome">): OperationHistoryEntry {
  const base: OperationHistoryEntry = {
    id: "op-000001",
    command: "install",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    outcome: "succeeded",
    scope: { selection: "project", profile: "example", hosts: ["codex"] },
    projects: [{
      project: "/tmp/demo",
      canonicalProject: "/tmp/demo",
      result: "completed",
      written: [".codex/hooks.json"],
    }],
  };
  return { ...base, ...overrides };
}

test("formatCompactOperationTime is deterministic UTC buckets with an injected now", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");
  expect(formatCompactOperationTime("2026-01-01T11:59:30.000Z", now)).toBe("just now");
  expect(formatCompactOperationTime("2026-01-01T11:57:00.000Z", now)).toBe("3m ago");
  expect(formatCompactOperationTime("2026-01-01T09:00:00.000Z", now)).toBe("3h ago");
  expect(formatCompactOperationTime("2025-12-30T12:00:00.000Z", now)).toBe("2d ago");
  expect(formatCompactOperationTime("2025-12-01T12:00:00.000Z", now)).toBe("2025-12-01");
  expect(formatCompactOperationTime("not-a-time", now)).toBe("not-a-time");
});

test("details show one exact Time when start and end are identical, never a duration", () => {
  const rendered = renderPresentationDocument(
    operationHistoryEntryDocument(historyEntry({ outcome: "succeeded" })),
    redirected,
    { home: "/home", cwd: "/work" },
  );
  expect(rendered).toContain("Time: 2026-01-01T00:00:00Z");
  expect(rendered).not.toContain("→");
  expect(rendered).not.toContain("Started:");
  expect(rendered).not.toContain("Finished:");
  expect(rendered).not.toContain("duration");
});

test("details keep one Time line for a sub-second interval at second display precision", () => {
  // Display identity is second precision (US-008): 0.5s is not a
  // user-meaningful duration, so it must not print identical Started and
  // Finished endpoints. Millisecond evidence stays in --json/--verbose.
  const rendered = renderPresentationDocument(
    operationHistoryEntryDocument(historyEntry({
      outcome: "succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.500Z",
    })),
    redirected,
    { home: "/home", cwd: "/work" },
  );
  expect(rendered).toContain("Time: 2026-01-01T00:00:00Z");
  expect(rendered).not.toContain("Started:");
  expect(rendered).not.toContain("Finished:");
  expect(rendered).not.toContain("→");
});

test("details show exact Started and Finished timestamps when they differ", () => {
  const rendered = renderPresentationDocument(
    operationHistoryEntryDocument(historyEntry({
      outcome: "partial",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:12.000Z",
    })),
    redirected,
    { home: "/home", cwd: "/work" },
  );
  expect(rendered).toContain("Started: 2026-01-01T00:00:00Z");
  expect(rendered).toContain("Finished: 2026-01-01T00:00:12Z");
  expect(rendered).not.toContain("Time:");
  expect(rendered).not.toContain("→");
});

test("details use user-facing file-work headings that keep committed, pending and failed distinct", () => {
  const rendered = renderPresentationDocument(
    operationHistoryEntryDocument(historyEntry({
      outcome: "partial",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:12.000Z",
      projects: [
        {
          project: "/tmp/written",
          canonicalProject: "/tmp/written",
          result: "completed",
          written: [".codex/hooks.json"],
        },
        {
          project: "/tmp/failed",
          canonicalProject: "/tmp/failed",
          result: "failed",
          failure: "write refused",
        },
        {
          project: "/tmp/skipped",
          canonicalProject: "/tmp/skipped",
          result: "skipped",
          failure: "declined changed file",
        },
        {
          project: "/tmp/pending",
          canonicalProject: "/tmp/pending",
          result: "unattempted",
        },
      ],
    })),
    redirected,
    { home: "/home", cwd: "/work" },
  );
  expect(rendered).toContain("Written:");
  expect(rendered).toContain("Failed:");
  expect(rendered).toContain("Skipped:");
  expect(rendered).toContain("Pending:");
  expect(rendered).not.toContain("Committed:");
  expect(rendered).not.toContain("Remaining:");
  expect(rendered).toContain("+ .codex/hooks.json");
  expect(rendered).toContain("write refused");
  expect(rendered).toContain("declined changed file");
  expect(rendered).toContain("/tmp/pending");
});

test("the details headline glyph matches each operation outcome", () => {
  const glyphs = {
    succeeded: "✔",
    partial: "⚠",
    blocked: "⚠",
    failed: "✖",
    "no-op": "●",
    cancelled: "●",
  } as const;
  const projectsFor = (outcome: keyof typeof glyphs) => {
    if (outcome === "no-op") {
      return [{ project: "/tmp/demo", canonicalProject: "/tmp/demo", result: "unchanged" as const }];
    }
    if (outcome === "cancelled") {
      return [{ project: "/tmp/demo", canonicalProject: "/tmp/demo", result: "unattempted" as const }];
    }
    if (outcome === "blocked") {
      return [{
        project: "/tmp/demo",
        canonicalProject: "/tmp/demo",
        result: "unattempted" as const,
        failure: "needs attention",
      }];
    }
    return undefined;
  };
  for (const [outcome, glyph] of Object.entries(glyphs)) {
    const key = outcome as keyof typeof glyphs;
    const extra = projectsFor(key);
    const rendered = renderPresentationDocument(
      operationHistoryEntryDocument(historyEntry({
        outcome: key,
        ...(extra === undefined ? {} : { projects: extra }),
      })),
      redirected,
      { home: "/home", cwd: "/work" },
    );
    expect(rendered.startsWith(glyph)).toBe(true);
  }
});

test("history rows carry compact human time and label every column at the table measure", () => {
  const now = Date.parse("2026-01-01T00:05:00.000Z");
  const rendered = renderPresentationDocument(
    operationHistoryListDocument([historyEntry({ outcome: "succeeded" })], now),
    { color: false, interactive: true, width: 100, rows: undefined },
    { home: "/home", cwd: "/work" },
  );
  const lines = rendered.split("\n");
  expect(lines[0]).toBe("Operation history (1):");
  expect(lines[1]).toBe("");
  expect(lines[2]).toMatch(/^Operation\s+Time\s+Command\s+Outcome\s+Scope$/);
  expect(lines[3]).toContain("op-000001");
  expect(lines[3]).toContain("5m ago");
  expect(lines[3]).toContain("install");
  expect(lines[3]).toContain("succeeded");
  expect(rendered).not.toContain("2026-01-01T00:00:00Z");
});

test("history rows pack into compact labeled records at 60 columns", () => {
  const now = Date.parse("2026-01-01T00:05:00.000Z");
  const rendered = renderPresentationDocument(
    operationHistoryListDocument([
      historyEntry({ outcome: "succeeded" }),
      historyEntry({ id: "op-000002", outcome: "failed" }),
    ], now),
    { color: false, interactive: true, width: 60, rows: undefined },
    { home: "/home", cwd: "/work" },
  );
  const records = rendered.split("\n\n");
  expect(records.length).toBeGreaterThanOrEqual(3);
  for (const record of records.slice(1, 3)) {
    const recordLines = record.split("\n");
    expect(recordLines.length).toBeLessThanOrEqual(2);
    expect(recordLines.join(" ")).toContain("Operation:");
    expect(recordLines.join(" ")).toContain("Time:");
    expect(recordLines.join(" ")).toContain("Command:");
    expect(recordLines.join(" ")).toContain("Outcome:");
    expect(recordLines.join(" ")).toContain("Scope:");
  }
  expect(rendered).toContain("op-000001");
  expect(rendered).toContain("op-000002");
  expect(Math.max(...rendered.split("\n").map((line) => line.length))).toBeLessThanOrEqual(60);
});
