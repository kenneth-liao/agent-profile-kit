import { describe, expect, test } from "bun:test";

import {
  compareChangedOutput,
  comparisonMatchesCurrent,
  historyRecordFor,
} from "../installer/changed-output-review.js";

describe("shared changed-output comparison", () => {
  test("a replacement diff shows the bytes at stake without storing them for history", () => {
    const comparison = compareChangedOutput({
      operation: "replace",
      path: ".opencode/opencode.jsonc",
      planned: `{\n  "$schema": "x"\n}\n`,
      project: "/tmp/project",
      current: `{\n  "$schema": "x",\n  "mcp": { "linear": {} }\n}\n`,
    });
    expect(comparison.operation).toBe("replace");
    expect(comparison.diffLines.join("\n")).toContain(`"mcp"`);
    expect(comparison.reviewId).toMatch(/^[0-9a-f]{64}$/);
    const record = historyRecordFor(comparison);
    expect(record).toEqual({
      operation: "replace",
      path: ".opencode/opencode.jsonc",
      project: "/tmp/project",
      reviewId: comparison.reviewId,
    });
    expect(JSON.stringify(record)).not.toContain("linear");
  });

  test("a deletion diff marks every current line removed", () => {
    const comparison = compareChangedOutput({
      operation: "remove",
      path: "old-output.md",
      project: "/tmp/project",
      current: "hello\nworld\n",
      planned: undefined,
    });
    expect(comparison.diffLines.join("\n")).toContain("-hello");
    expect(comparison.diffLines.join("\n")).toContain("-world");
  });

  test("a directory review binds the aggregate hashes without dumping member bytes", () => {
    const comparison = compareChangedOutput({
      contentKind: "directory",
      operation: "replace",
      path: ".agents/skills/demo",
      project: "/tmp/project",
      current: "sha256:aaa",
      planned: "sha256:bbb",
    });
    expect(comparison.diffLines.join("\n")).toContain(".agents/skills/demo");
    expect(comparison.reviewId).toMatch(/^[0-9a-f]{64}$/);
    expect(comparisonMatchesCurrent(comparison, "sha256:aaa", "sha256:bbb")).toBe(true);
    expect(comparisonMatchesCurrent(comparison, "sha256:changed", "sha256:bbb")).toBe(false);
  });

  test("the same inputs produce the same review and mismatched bytes fail the fresh check", () => {
    const input = {
      operation: "replace" as const,
      path: "a.md",
      project: "/tmp/p",
      current: "one\ntwo\n",
      planned: "one\nthree\n",
    };
    const first = compareChangedOutput(input);
    const second = compareChangedOutput(input);
    expect(second.reviewId).toBe(first.reviewId);
    expect(comparisonMatchesCurrent(first, input.current, input.planned)).toBe(true);
    expect(comparisonMatchesCurrent(first, "one\nCHANGED\n", input.planned)).toBe(false);
    expect(comparisonMatchesCurrent(first, input.current, "one\nOTHER\n")).toBe(false);
  });
});
