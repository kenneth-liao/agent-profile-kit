import { expect, test } from "bun:test";

import { delimitedContext, displayPath } from "../cli/presentation.js";
import { diagnosticDocument } from "../cli/diagnostics.js";
import {
  type CommandArg,
  commandPart,
  type InlineContent,
  pathPart,
  renderPresentationDocument,
} from "../cli/presentation-document.js";

const arg = (value: string): CommandArg => ({ kind: "text", value });

const redirected = { color: false, interactive: false, width: 80 } as const;

test("renders a prose document to text for a terminal presentation context", () => {
  const text = renderPresentationDocument(
    [{ kind: "prose", parts: ["Ready to apply."], category: "success" }],
    redirected,
  );
  expect(text).toBe("Ready to apply.");
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
  });
  expect(colored).toContain("\u001b[1;34mProjects (1)\u001b[0m");
  expect(colored).toContain("\u001b[31m2 Blockers\u001b[0m");
  expect(colored).not.toContain("\u001b[1;34m2 Blockers");

  const plain = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 80,
  });
  expect(plain).toBe("Projects (1)\n2 Blockers");
  expect(plain).not.toMatch(/\u001b/);
});

test("wraps prose and carries its style across every wrapped line", () => {
  const sentence =
    "Blocker: generated output is occupied by a foreign file that Agent Profile Kit does not own.";
  const colored = renderPresentationDocument(
    [{ kind: "prose", parts: [sentence], category: "error" }],
    { color: true, interactive: true, width: 40 },
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
    { color: false, interactive: true, width: 100 },
  );
  const lines = text.split("\n");
  expect(lines.length).toBeGreaterThan(1);
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(100);
});

test("never splits a path and elides in the middle through displayPath", () => {
  const home = "/Users/kennethliao";
  const cwd = "/tmp";
  const project = `${home}/projects/deeply/nested/agent-profile-kit`;
  const context = { color: false, interactive: false, width: 40 } as const;
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

test("renders a command on one line by shortening a path argument", () => {
  const home = "/Users/kennethliao";
  const cwd = "/tmp";
  const project = `${home}/projects/deeply/nested/workspaces/agent-profile-kit`;
  const context = { color: false, interactive: false, width: 40 } as const;
  const text = renderPresentationDocument(
    [{
      kind: "command",
      program: "apkit",
      args: [
        { kind: "text", value: "apply" },
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
  const prefix = "apkit apply ";
  expect(text.split("\n")).toHaveLength(1);
  expect(text.startsWith(prefix)).toBe(true);
  expect(text.length).toBeLessThanOrEqual(context.width);
  expect(text.slice(prefix.length)).toBe(
    displayPath(project, project, "fleet", cwd, home, context.width - prefix.length),
  );
});

test("aligns sibling rows into columns and right-aligns numeric cells", () => {
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
    { color: false, interactive: true, width: 80 },
  );
  const lines = text.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]!.endsWith("12")).toBe(true);
  expect(lines[1]!.endsWith(" 3")).toBe(true);
  expect(lines[0]!.length).toBe(lines[1]!.length);
  expect(lines[0]!.indexOf("12")).toBe(lines[1]!.length - 2);
  expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80);
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
    { color: false, interactive: true, width: 20 },
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
    { color: false, interactive: true, width: 100 },
  );
  expect(wide.split("\n")).toHaveLength(1);
  expect(wide).toContain(left);
  expect(wide).toContain(right);
  expect(wide.length).toBeGreaterThan(80);
  expect(wide.length).toBeLessThanOrEqual(100);
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
  });
  expect(wide.split("\n")).toHaveLength(1);
  expect(wide.indexOf("Left column")).toBeLessThan(wide.indexOf("Right column"));

  const narrow = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 18,
  });
  expect(narrow).toBe("Left column\nRight column");
  expect(Math.max(...narrow.split("\n").map((line) => line.length))).toBeLessThanOrEqual(18);
});

test("wraps a sentence continuously with embedded commands inline and whole", () => {
  const sentence =
    "apkit: apkit status Project target '/projects/demo' is not a bound Project; " +
    "run apkit list projects or apkit bind";
  const text = renderPresentationDocument(
    [{ kind: "sentence", parts: [sentence] }],
    { color: false, interactive: false, width: 40 },
  );
  const lines = text.split("\n");
  // The sentence wraps to the measure…
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) {
    expect(line.length).toBeLessThanOrEqual(40);
  }
  // …as one continuous flow: no embedded command is promoted onto its own
  // dedicated line, and no command is split across lines.
  expect(lines).not.toContain("apkit status");
  for (const command of ["apkit status", "apkit list projects", "apkit bind"]) {
    const linesCarrying = lines.filter((line) =>
      command.split(" ").some((word) => line.includes(word)),
    );
    expect(
      linesCarrying.some((line) => line.includes(command)),
      `command '${command}' must stay whole on one line`,
    ).toBe(true);
  }
  expect(lines.map((line) => line.trimStart()).join(" ")).toBe(sentence);
});

test("carries a sentence's category across every wrapped line", () => {
  const sentence = "apkit: apkit status failed because the Project target is not bound.";
  const colored = renderPresentationDocument(
    [{ kind: "sentence", parts: [sentence], category: "error" }],
    { color: true, interactive: false, width: 30 },
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
      happened: [
        "apkit status Project target '/projects/demo' is not a bound Project; " +
          "run apkit list projects or apkit bind",
      ],
      usage: "status [project | --all] [--verbose] [--blockers-only] [--json]",
    }),
    { color: false, interactive: false, width: 80 },
  );
  const lines = text.split("\n");
  // Structural shape, not wording: the label prefixes the first line only,
  // the sentence flows with a hanging indent, and usage renders last as one
  // whole command line (the writer appends the final line terminator).
  expect(lines.at(-1)).toBe("Usage: apkit status [project | --all] [--verbose] [--blockers-only] [--json]");
  const sentence = lines.slice(0, -1).map((line) => line.trimStart()).join(" ");
  expect(sentence.startsWith("apkit: ")).toBe(true);
  expect(lines.slice(1, -1).every((line) => line.startsWith("  "))).toBe(true);
  expect(lines).not.toContain("apkit:");
  expect(lines.at(-1)!.startsWith("Usage: apkit status")).toBe(true);
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
    { color: false, interactive: false, width: 80 },
  );
  const lines = text.split("\n").filter((line) => line.length > 0);
  // Order is the structural shape: happened, then why, then what to type.
  expect(lines[0]!.startsWith("apkit: ")).toBe(true);
  expect(lines.slice(1, 3).every((line) => line.startsWith("caused by: "))).toBe(true);
  expect(lines[3]!.startsWith("Run apkit")).toBe(true);
  expect(lines).toHaveLength(4);
});

test("reproduces verbatim content exactly, including fence escalation, without wrapping or styling", () => {
  const authored = "--- begin Context ---\nquoted body that would wrap at this width\n--- end Context ---\n";
  const fenced = delimitedContext(authored);
  const colored = renderPresentationDocument(
    [{ kind: "verbatim", text: fenced }],
    { color: true, interactive: true, width: 20 },
  );
  expect(colored).toBe(fenced);
  expect(colored).toContain("---- begin Context ----");
  expect(colored).toContain("quoted body that would wrap at this width");
  expect(colored).not.toMatch(/\u001b/);
  expect(colored.split("\n").some((line) => line.length > 20)).toBe(true);
});

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
