import { describe, expect, test } from "bun:test";

import { reconcileGitExcludeBytes } from "../installer/git-exclusions.js";

const path = "/repo/.git/info/exclude";

function section(entries: readonly string[], newline = "\n", finalNewline = true): Buffer {
  const source = [
    "# BEGIN Agent Profile Kit generated paths",
    ...entries,
    "# END Agent Profile Kit generated paths",
  ].join(newline) + (finalNewline ? newline : "");
  return Buffer.from(source, "ascii");
}

describe("Git repository-local exclusion bytes", () => {
  test.each([
    { name: "empty", unrelated: Buffer.alloc(0) },
    { name: "LF with final newline", unrelated: Buffer.from("# authored\n*.tmp\n") },
    { name: "LF without final newline", unrelated: Buffer.from("# authored\n*.tmp") },
    { name: "CRLF with final newline", unrelated: Buffer.from("# authored\r\n*.tmp\r\n") },
    { name: "CRLF without final newline", unrelated: Buffer.from("# authored\r\n*.tmp") },
    { name: "non-UTF8 unrelated bytes", unrelated: Buffer.from([0xff, 0x00, 0x61]) },
  ])("round-trips $name unrelated bytes exactly", ({ unrelated }) => {
    const installed = reconcileGitExcludeBytes(unrelated, path, [], ["/.owned"]);
    const removed = reconcileGitExcludeBytes(installed, path, ["/.owned"], []);

    expect(removed.equals(unrelated)).toBe(true);
  });

  test.each([
    section(["/.owned"], "\n", true),
    section(["/.owned"], "\n", false),
    section(["/.owned"], "\r\n", true),
    section(["/.owned"], "\r\n", false),
  ])("recognizes LF/CRLF sections with and without final newline", (source) => {
    expect(reconcileGitExcludeBytes(source, path, ["/.owned"], []).length).toBe(0);
  });

  test.each([
    Buffer.from("# BEGIN Agent Profile Kit generated paths\n/.owned\n"),
    Buffer.from("# END Agent Profile Kit generated paths\n"),
    Buffer.concat([section(["/.owned"]), section(["/.owned"])]),
    Buffer.from("# BEGIN Agent Profile Kit generated paths altered\n/.owned\n# END Agent Profile Kit generated paths\n"),
  ])("rejects partial, duplicate, or malformed marker sections", (source) => {
    expect(() => reconcileGitExcludeBytes(source, path, ["/.owned"], [])).toThrow("malformed or duplicate");
  });

  test.each([
    section(["/.other"]),
    section(["/.owned", "/.owned"]),
    section(["# comment", "/.owned"]),
    section([]),
  ])("rejects modified marked-section contents", (source) => {
    expect(() => reconcileGitExcludeBytes(source, path, ["/.owned"], [])).toThrow("is modified");
  });

  test("rejects changing an owned-separator header to an ordinary header", () => {
    const installed = reconcileGitExcludeBytes(Buffer.from("authored without EOF newline"), path, [], ["/.owned"]);
    const tampered = Buffer.from(
      installed.toString("utf8").replace(
        "# BEGIN Agent Profile Kit generated paths (separator owned)",
        "# BEGIN Agent Profile Kit generated paths",
      ),
    );

    expect(() => reconcileGitExcludeBytes(tampered, path, ["/.owned"], [])).toThrow("separator header");
  });

  test("rejects changing an ordinary header to an owned-separator header", () => {
    const installed = reconcileGitExcludeBytes(Buffer.from("authored with EOF newline\n"), path, [], ["/.owned"]);
    const tampered = Buffer.from(
      installed.toString("utf8").replace(
        "# BEGIN Agent Profile Kit generated paths",
        "# BEGIN Agent Profile Kit generated paths (separator owned)",
      ),
    );

    expect(() => reconcileGitExcludeBytes(tampered, path, ["/.owned"], [])).toThrow("separator");
  });

  test("preserves unrelated Agent Profile Kit comments byte-for-byte", () => {
    const unrelated = Buffer.from(
      "# BEGIN Agent Profile Kit notes\r\nkeep this\r\n# END Agent Profile Kit notes\r\n",
    );
    const installed = reconcileGitExcludeBytes(unrelated, path, [], ["/.owned"]);
    const removed = reconcileGitExcludeBytes(installed, path, ["/.owned"], []);

    expect(removed.equals(unrelated)).toBe(true);
  });
});
