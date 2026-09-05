import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readSnapshotBodies } from "./support/snapshot-file.js";

describe("bun snapshot v1 boundary parser", () => {
  test("extracts bodies by full exports key, unescaping backticks", () => {
    const directory = mkdtempSync(join(tmpdir(), "apkit-snap-parse-"));
    try {
      const path = `${directory}/file.snap`;
      writeFileSync(
        path,
        [
          "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots",
          "",
          "exports[`suite view one: body-one 1`] = `",
          `"--- stdout ---`,
          "Next: run \\`apkit bind example --host codex\\`.",
          `--- stderr ---`,
          `"`,
          "`;",
          "",
          "exports[`suite view two: body-two 1`] = `",
          `"plain content line`,
          `second line"`,
          "`;",
          "",
        ].join("\n"),
      );
      const bodies = readSnapshotBodies(path);
      expect(bodies.size).toBe(2);
      expect(bodies.get("suite view one: body-one 1")).toBe(
        "--- stdout ---\nNext: run `apkit bind example --host codex`.\n--- stderr ---\n",
      );
      expect(bodies.get("suite view two: body-two 1")).toBe("plain content line\nsecond line");
      expect(bodies.get("absent key")).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("parses the committed golden baseline corpus", () => {
    const path = new URL("./__snapshots__/golden-snapshots.test.ts.snap", import.meta.url);
    const bodies = readSnapshotBodies(path);
    expect(bodies.size).toBeGreaterThan(0);
    const rootHelp = bodies.get("golden snapshots of every human view root help: root-help 1");
    expect(rootHelp).toBeDefined();
    expect(rootHelp!.startsWith("--- stdout ---")).toBe(true);
    expect(rootHelp).toContain("--- stderr ---");
  });
});