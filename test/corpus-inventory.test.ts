import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { enumerateTestCorpus, TEST_CORPUS_ROOT } from "./support/corpus-inventory.js";

/**
 * The repository test-corpus policy is anchored at the existing test root:
 * one module derives the current test files under `<base>/test` and applies
 * the fast-suite exclusion policy, so full/fleet selection and execution
 * evidence share this one inventory. The suffix set is the runner-proven set
 * (each form verified as discovered by `bun test`), not a guessed glob, and a
 * conformance check proves the inventory agrees with the real runner's own
 * discovery on a suffix-rich corpus.
 */

const SUFFIXES = [
  "included.test.ts",
  "tsx.included.test.tsx",
  "js.included.test.js",
  "jsx.included.test.jsx",
  "mjs.included.test.mjs",
  "cjs.included.test.cjs",
  "mts.included.test.mts",
  "cts.included.test.cts",
  "spec.included.spec.ts",
  "underscore.included_test.ts",
  "underscore.spec.included_spec.ts",
] as const;

function suffixCorpus(base: string, extra?: (base: string) => void): string {
  const testRoot = join(base, TEST_CORPUS_ROOT);
  mkdirSync(testRoot, { recursive: true });
  for (const name of SUFFIXES) {
    writeFileSync(
      join(testRoot, name),
      'import { test } from "bun:test";\ntest("placeholder", () => {});\n',
    );
  }
  // Non-test material at the test root is never corpus.
  writeFileSync(join(testRoot, "helper.ts"), "export const helper = true;\n");
  writeFileSync(join(testRoot, "dash-form.test-nope.ts"), "export const x = 1;\n");
  extra?.(testRoot);
  return testRoot;
}

function extra(testRoot: string): void {
  const nested = join(testRoot, "nested");
  mkdirSync(nested);
  writeFileSync(
    join(nested, "nested.test.ts"),
    'import { test } from "bun:test";\ntest("nested runs", () => {});\n',
  );
}

describe("corpus inventory: derivation at the test root", () => {
  test("derives every proven test-file suffix, including nested, and nothing else", () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-corpus-"));
    try {
      suffixCorpus(base, extra);
      const inventory = enumerateTestCorpus(base, []);
      const paths = inventory.selected;
      for (const name of SUFFIXES) {
        expect(paths, name).toContain(join(TEST_CORPUS_ROOT, name).split("\\").join("/"));
      }
      expect(paths).toContain(`${TEST_CORPUS_ROOT}/nested/nested.test.ts`);
      expect(paths).not.toContain(`${TEST_CORPUS_ROOT}/helper.ts`);
      expect(paths.some((path) => path.endsWith("dash-form.test-nope.ts"))).toBe(false);
      expect(paths).toHaveLength(SUFFIXES.length + 1);
      // Deterministic order for evidence records.
      expect([...paths].sort((a, b) => a.localeCompare(b))).toEqual([...paths]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("applies the exclusion policy and rejects a pattern that matches nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-corpus-"));
    try {
      const testRoot = join(base, TEST_CORPUS_ROOT);
      mkdirSync(testRoot);
      writeFileSync(
        join(testRoot, "fleet-qualification.test.ts"),
        'import { test } from "bun:test";\ntest("fleet", () => {});\n',
      );
      writeFileSync(
        join(testRoot, "included.test.ts"),
        'import { test } from "bun:test";\ntest("included", () => {});\n',
      );
      const excluded = enumerateTestCorpus(base, ["test/fleet-qualification.test.ts"]);
      expect(excluded.files).toEqual([
        `${TEST_CORPUS_ROOT}/fleet-qualification.test.ts`,
        `${TEST_CORPUS_ROOT}/included.test.ts`,
      ]);
      expect(excluded.selected).toEqual([`${TEST_CORPUS_ROOT}/included.test.ts`]);
      expect(excluded.excluded).toEqual([`${TEST_CORPUS_ROOT}/fleet-qualification.test.ts`]);

      expect(() => enumerateTestCorpus(base, ["test/does-not-exist.test.ts"])).toThrow(
        /match nothing/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects a test root with no derived files instead of selecting nothing", () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-corpus-"));
    try {
      expect(() => enumerateTestCorpus(base, [])).toThrow(/no test files/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("corpus inventory: agreement with the real runner", () => {
  test("bun's own discovery derives exactly the inventory on a suffix-rich corpus", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-corpus-conformance-"));
    try {
      suffixCorpus(base, extra);
      const { selected } = enumerateTestCorpus(base, []);
      const discovered = await import("../process/process-executor.js").then(({ runProcess }) =>
        runProcess({
          executable: process.execPath,
          arguments_: ["test"],
          cwd: base,
          deadlineMs: 120_000,
          commandLabel: "corpus conformance discovery",
        }),
      );
      expect(discovered.kind).toBe("exit");
      if (discovered.kind !== "exit" || discovered.exitCode !== 0) {
        throw new Error(`bun discovery run failed: ${discovered.kind}`);
      }
      const summary = /Ran (\d+) tests across (\d+) files\./.exec(
        `${discovered.stdout}\n${discovered.stderr}`,
      );
      expect(summary?.[2]).toBe(String(selected.length));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});