import { describe, expect, test } from "bun:test";

import {
  compareChangedDirectory,
  compareChangedFile,
  comparisonMatchesDigests,
  digestBytes,
  historyRecordFor,
} from "../installer/changed-output-review.js";

describe("shared changed-output comparison", () => {
  test("a replacement renders change hunks with context, not the whole file", () => {
    const prefix = Array.from({ length: 210 }, (_, index) => `stable line ${index}`);
    const current = [...prefix, `  "mcp": { "linear": {} }`, `}`].join("\n") + "\n";
    const planned = [...prefix, `}`].join("\n") + "\n";
    const comparison = compareChangedFile({
      operation: "replace",
      path: ".opencode/opencode.jsonc",
      planned,
      project: "/tmp/project",
      current,
    });
    const rendered = comparison.hunks.flatMap((hunk) => [hunk.heading, ...hunk.lines]).join("\n");
    // The configuration-key loss is visible even though it sits past line 200.
    expect(rendered).toContain(`"mcp"`);
    // The 210 identical prefix lines are context, not repeated wholesale.
    expect(comparison.hunks.length).toBeLessThan(5);
    expect(comparison.hunks.every((hunk) => hunk.lines.length <= 120)).toBe(true);
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

  test("review identity binds exact bytes, not decoded text", () => {
    const first = compareChangedFile({
      operation: "replace",
      path: "a.bin",
      project: "/tmp/p",
      current: new Uint8Array([0xff]),
      planned: "planned\n",
    });
    const second = compareChangedFile({
      operation: "replace",
      path: "a.bin",
      project: "/tmp/p",
      current: new Uint8Array([0xfe]),
      planned: "planned\n",
    });
    // Both decode to U+FFFD, but the reviews must differ.
    expect(first.reviewId).not.toBe(second.reviewId);
    expect(comparisonMatchesDigests(first, digestBytes(new Uint8Array([0xff])), digestBytes("planned\n"))).toBe(true);
    expect(comparisonMatchesDigests(first, digestBytes(new Uint8Array([0xfe])), digestBytes("planned\n"))).toBe(false);
    expect(new TextDecoder().decode(new Uint8Array([0xff]))).toBe(
      new TextDecoder().decode(new Uint8Array([0xfe])),
    );
  });

  test("a deletion renders removed lines as hunks", () => {
    const comparison = compareChangedFile({
      operation: "remove",
      path: "old-output.md",
      project: "/tmp/project",
      current: "hello\nworld\n",
    });
    const rendered = comparison.hunks.flatMap((hunk) => hunk.lines).join("\n");
    expect(rendered).toContain("-hello");
    expect(rendered).toContain("-world");
  });

  test("a directory review carries member-level evidence without contents", () => {
    const comparison = compareChangedDirectory({
      operation: "replace",
      path: ".agents/skills/demo",
      project: "/tmp/project",
      currentHash: "sha256:aaa",
      plannedHash: "sha256:bbb",
      members: [
        { path: "SKILL.md", status: "changed" },
        { path: "notes.md", status: "removed" },
        { path: "reference.md", status: "added" },
      ],
    });
    const rendered = comparison.hunks.flatMap((hunk) => [hunk.heading, ...hunk.lines]).join("\n");
    expect(rendered).toContain("SKILL.md");
    expect(rendered).toContain("notes.md");
    expect(rendered).toContain("reference.md");
    expect(comparisonMatchesDigests(comparison, "sha256:aaa", "sha256:bbb")).toBe(true);
    expect(comparisonMatchesDigests(comparison, "sha256:changed", "sha256:bbb")).toBe(false);
    const record = historyRecordFor(comparison);
    expect(JSON.stringify(record)).not.toContain("aaa");
    expect(record.reviewId).toBe(comparison.reviewId);
  });

  test("the same inputs produce the same review", () => {
    const input = {
      operation: "replace" as const,
      path: "a.md",
      project: "/tmp/p",
      current: "one\ntwo\n",
      planned: "one\nthree\n",
    };
    expect(compareChangedFile(input).reviewId).toBe(compareChangedFile(input).reviewId);
  });
});

describe("shared directory member comparison policy", () => {
  test("the policy classifies the live/planned union without installer help", async () => {
    const { compareDirectoryMembers } = await import("../installer/changed-output-review.js");
    const members = await compareDirectoryMembers(
      [
        { path: "SKILL.md", type: "file", mode: 0o644 },
        { path: "notes.md", type: "file", mode: 0o644 },
        { path: "scripts", type: "directory", mode: 0o755 },
        { path: "scripts/run.sh", type: "file", mode: 0o755 },
      ],
      [
        { path: "SKILL.md", type: "file", mode: 0o644, bytes: "# New\n" },
        { path: "reference.md", type: "file", mode: 0o644, bytes: "# Ref\n" },
        { path: "scripts", type: "directory", mode: 0o755 },
        { path: "scripts/run.sh", type: "file", mode: 0o755, bytes: "#!/bin/sh\necho demo\n" },
      ],
      async (memberPath) =>
        memberPath === "SKILL.md"
          ? new TextEncoder().encode("# Old\n")
          : memberPath === "scripts/run.sh"
            ? new TextEncoder().encode("#!/bin/sh\necho demo\n")
            : new TextEncoder().encode("user note\n"),
    );
    const byPath = new Map(members.map((member) => [member.path, member]));
    expect(byPath.get("SKILL.md")?.status).toBe("changed");
    expect(byPath.get("SKILL.md")?.hunks?.flatMap((hunk) => hunk.lines).join("\n")).toContain("-# Old");
    expect(byPath.get("notes.md")?.status).toBe("removed");
    expect(byPath.get("reference.md")?.status).toBe("added");
    // Unchanged members and covered directory entries carry no evidence.
    expect(byPath.has("scripts/run.sh")).toBe(false);
    expect(byPath.has("scripts")).toBe(false);
  });

  test("every removed member stays reachable through paging windows", async () => {
    const { compareDirectoryMembers, compareChangedDirectory } = await import(
      "../installer/changed-output-review.js"
    );
    const removed = Array.from({ length: 201 }, (_, index) => `note-${index}.md`);
    const members = await compareDirectoryMembers(
      removed.map((path) => ({ path, type: "file" as const, mode: 0o644 })),
      [],
      async () => new TextEncoder().encode("user note\n"),
    );
    expect(members).toHaveLength(201);
    const comparison = compareChangedDirectory({
      operation: "remove",
      path: ".agents/skills/demo",
      project: "/tmp/project",
      currentHash: "sha256:aaa",
      members,
    });
    const lines = comparison.hunks.flatMap((hunk) => [hunk.heading, ...hunk.lines]);
    // Paging windows over the shared hunks reach every member: nothing is
    // permanently dropped before display limits apply.
    const pageLines = 60;
    const pages: string[] = [];
    for (let start = 0; start < lines.length; start += pageLines) {
      pages.push(lines.slice(start, start + pageLines).join("\n"));
    }
    expect(lines.join("\n")).toContain("note-200.md");
    expect(pages.some((page) => page.includes("note-200.md"))).toBe(true);
    expect(pages.some((page) => page.includes("note-99.md"))).toBe(true);
    expect(lines.join("\n")).not.toContain("not shown");
  });
});
