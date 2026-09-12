import { expect, test } from "bun:test";
import { Writable } from "node:stream";

import { delimitedContext, displayPath } from "../cli/presentation.js";
import { diagnosticDocument } from "../cli/diagnostics.js";
import {
  operationDetailsDocument,
  writeLifecycleReport,
} from "../cli/operation-history-presentation.js";
import { beginLifecycleOperationRecording } from "../cli/operation-recording.js";
import { terminalPresentationContext } from "../cli/terminal-presentation.js";
import {
  type CommandArg,
  commandPart,
  identifierPart,
  type InlineContent,
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
  expect(colored).toContain("\u001b[1;34mProjects (1)\u001b[0m");
  expect(colored).toContain("\u001b[31m2 Blockers\u001b[0m");
  expect(colored).not.toContain("\u001b[1;34m2 Blockers");

  const plain = renderPresentationDocument(document, {
    color: false,
    interactive: true,
    width: 80,
    rows: undefined,
  });
  expect(plain).toBe("Projects (1)\n2 Blockers");
  expect(plain).not.toMatch(/\u001b/);
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
  // INT-1 cycle 2 on #489).
  // Shell-quoted as one POSIX token through the shared quoting boundary
  // (review RE-1 on #489).
  expect(text.slice(prefix.length)).toBe(
    `'${displayPath(project, project, "fleet", cwd, home)}'`,
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
    { color: false, interactive: true, width: 80 , rows: undefined },
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

test("wraps a sentence continuously with embedded commands inline and whole", () => {
  const sentence =
    "apkit: apkit status Project target '/projects/demo' is not a bound Project; " +
    "run apkit list projects or apkit bind";
  const text = renderPresentationDocument(
    [{ kind: "sentence", parts: [sentence] }],
    { color: false, interactive: false, width: 40 , rows: undefined },
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
  expect(lines[0]).toBe("apkit: something failed");
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

  const retained = beginLifecycleOperationRecording();
  retained.collect({ outcome: "no-op", scope: { selection: "all" }, projects: [] });
  stream.chunks.length = 0;
  writeLifecycleReport(stream, document, context, retained);
  expect(stream.text()).toContain("Report.");
  expect(stream.text()).toContain("Details: apkit details");

  // `--verbose` prints the complete current-run receipt and omits the route.
  stream.chunks.length = 0;
  writeLifecycleReport(stream, document, context, retained, false);
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
  expect(normal).toBe("alpha\nbeta");
});
