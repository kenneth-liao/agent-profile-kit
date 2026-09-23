import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { shellQuoteArg } from "../cli/inline-content.js";
import { commandPart, renderPresentationDocument } from "../cli/presentation-document.js";

/**
 * US-009, #651: one shared shell-quoting function is the only way a command
 * argument is quoted. Printed commands must stay executable when pasted into a
 * real shell — including home-relative paths (where `~` must expand) and paths
 * with spaces or quotes.
 */

function shEval(alreadyQuoted: string, home: string): string {
  return execFileSync("sh", ["-c", `printf %s ${alreadyQuoted}`], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function shResolve(value: string, home: string): string {
  const quoted = shellQuoteArg(value);
  expect(quoted, `shellQuoteArg refused ${JSON.stringify(value)}`).toBeDefined();
  return shEval(quoted!, home);
}

test("shellQuoteArg leaves the home prefix unquoted and single-quotes the remainder", () => {
  expect(shellQuoteArg("~/proj/alpha")).toBe("~/'proj/alpha'");
  expect(shellQuoteArg("~/proj with space")).toBe("~/'proj with space'");
  expect(shellQuoteArg("~/proj/it's")).toBe("~/'proj/it'\\''s'");
  expect(shellQuoteArg("~")).toBe("~");
});

test("shellQuoteArg single-quotes absolute paths as one token", () => {
  expect(shellQuoteArg("/proj/alpha")).toBe("'/proj/alpha'");
  expect(shellQuoteArg("/proj/with space")).toBe("'/proj/with space'");
  expect(shellQuoteArg("/proj/it's")).toBe("'/proj/it'\\''s'");
});

test("shellQuoteArg refuses empty values and control characters", () => {
  expect(shellQuoteArg("")).toBeUndefined();
  expect(shellQuoteArg("line\nbreak")).toBeUndefined();
  expect(shellQuoteArg("bell\u0007")).toBeUndefined();
});

test("a printed command argument resolves to the intended path through a real shell", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "apkit-shell-quote-home-")));
  const cases = [
    join(home, "proj", "alpha"),
    join(home, "proj with space"),
    join(home, "proj", "it's here"),
    join(home, "proj", 'quote"double'),
  ];
  for (const path of cases) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "marker"), "ok");
  }

  for (const path of cases) {
    const homeRelative = `~/${path.slice(home.length + 1)}`;
    expect(shResolve(homeRelative, home)).toBe(path);
    expect(shResolve(path, home)).toBe(path);
  }

  // Bare ~ expands to HOME.
  expect(shResolve("~", home)).toBe(home);
});

test("renderCommand path arguments stay executable at the display spelling", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "apkit-shell-quote-render-")));
  const project = join(home, "projects", "alpha with space");
  mkdirSync(project, { recursive: true });

  const rendered = renderPresentationDocument(
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
    { color: false, interactive: false, width: 80, rows: undefined },
    { home, cwd: home },
  );

  expect(rendered).toBe(`apkit update ~/'projects/alpha with space'`);
  const pathArg = rendered.slice("apkit update ".length);
  expect(shEval(pathArg, home)).toBe(project);
});
