import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertRunnerIsPinnedBun,
  runSupervisedSuite,
} from "./support/suite-supervisor.js";
import { TEST_CORPUS_ROOT } from "./support/corpus-inventory.js";

/**
 * Canonical suite selection, proven with the actual runner: every test here
 * drives the real supervisor's default command (the real pinned Bun
 * executable) over a tiny isolated corpus, asserting behavior through
 * side-effect markers, the structured junit execution evidence, and the
 * retained run log — never by inspecting the constructed argv or source text.
 */

const FLEET = "test/fleet-qualification.test.ts";

interface CorpusFile {
  readonly path: string;
  readonly body: string;
}

function corpusFixture(build: (base: string) => readonly CorpusFile[]): string {
  const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
  const testRoot = join(base, TEST_CORPUS_ROOT);
  mkdirSync(testRoot, { recursive: true });
  mkdirSync(join(base, "markers"));
  for (const file of build(base)) {
    writeFileSync(join(base, file.path), file.body);
  }
  return base;
}

const includedFile = (base: string, name = "included"): CorpusFile => ({
  path: `${TEST_CORPUS_ROOT}/${name}.test.ts`,
  body: [
    'import { test } from "bun:test";',
    'import { writeMarker } from "./helpers.js";',
    `test("${name} executes", () => { writeMarker("${join(base, "markers")}", "${name}"); });`,
    "",
  ].join("\n"),
});

const runnerHelper = (base: string): CorpusFile => ({
  path: `${TEST_CORPUS_ROOT}/helpers.ts`,
  body: [
    'import { writeFileSync } from "node:fs";',
    "export function writeMarker(dir: string, name: string): void {",
    '  writeFileSync(`${dir}/${name}`, "1");',
    "}",
    "",
  ].join("\n"),
});

const fleetFile = (base: string): CorpusFile => ({
  path: FLEET,
  body: [
    'import { test } from "bun:test";',
    'import { writeMarker } from "./helpers.js";',
    `test("fleet executes", () => { writeMarker("${join(base, "markers")}", "fleet"); });`,
    "",
  ].join("\n"),
});

async function runFullCorpus(
  base: string,
  overrides: Partial<Parameters<typeof runSupervisedSuite>[0]> = {},
): Promise<Awaited<ReturnType<typeof runSupervisedSuite>>> {
  return runSupervisedSuite({
    mode: "full",
    cwd: base,
    perRunDeadlineMs: 30_000,
    logDir: join(base, "logs"),
    ...overrides,
  });
}

describe("suite selection: full mode through the real supervisor and selected Bun", () => {
  test("executes included tests, structurally excludes the fleet selection, and retains evidence", async () => {
    const base = corpusFixture((base) => [runnerHelper(base), includedFile(base), fleetFile(base)]);
    try {
      const result = await runFullCorpus(base);
      expect(result.ok).toBe(true);
      // Inclusion is observed behavior, not output parsing.
      expect(existsSync(join(base, "markers", "included"))).toBe(true);
      // Exclusion is observed in the corpus, not inferred from arguments.
      expect(existsSync(join(base, "markers", "fleet"))).toBe(false);
      const run = result.runs[0]!;
      expect(run.coverage).toEqual({
        status: "complete",
        executedFiles: 1,
        skippedTests: 0,
        missing: [],
        unexpected: [],
      });
      expect(existsSync(join(result.logDir, "run-1.junit.xml"))).toBe(true);
      const log = readFileSync(run.logPath, "utf8");
      expect(log).toMatch(/^runtime: bun \d+\.\d+\.\d+ \(\S+\) \S+ \S+$/m);
      expect(log).toContain(`selection: mode=full test-root=${TEST_CORPUS_ROOT} selected=1 excluded=1`);
      expect(log).toContain(`selection-excluded: ${FLEET}`);
      expect(log).toContain("coverage: status=complete executed=1 skipped=0 missing=0 unexpected=0");
      const junit = readFileSync(join(result.logDir, "run-1.junit.xml"), "utf8");
      expect(junit).toContain(`file="${TEST_CORPUS_ROOT}/included.test.ts"`);
      expect(junit).not.toContain(`file="${FLEET}"`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a failure in an included test propagates to qualification", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    try {
      const testRoot = join(base, TEST_CORPUS_ROOT);
      mkdirSync(testRoot);
      writeFileSync(
        join(testRoot, "included.test.ts"),
        [
          'import { test, expect } from "bun:test";',
          'test("included fails", () => { expect(1).toBe(2); });',
          "",
        ].join("\n"),
      );
      writeFileSync(join(base, FLEET), 'export const placeholder = 1;\n');
      const result = await runFullCorpus(base);
      expect(result.ok).toBe(false);
      expect(result.firstFailure).not.toBeNull();
      expect(result.firstFailure?.result.kind).toBe("exit");
      if (result.firstFailure?.result.kind === "exit") {
        expect(result.firstFailure.result.exitCode).toBe(1);
      }
      expect(existsSync(join(result.logDir, "run-1.junit.xml"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an incomplete execution (stalled included test) is never complete qualification", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(
      join(testRoot, "stall.test.ts"),
      [
        'import { test } from "bun:test";',
        'test("stalls", async () => { await new Promise(() => {}); });',
        "",
      ].join("\n"),
    );
    writeFileSync(join(base, FLEET), 'export const placeholder = 1;\n');
    try {
      const result = await runFullCorpus(base, { perRunDeadlineMs: 700, cleanupGraceMs: 200 });
      expect(result.ok).toBe(false);
      expect(result.runs[0]!.result.kind).toBe("timeout");
      expect(result.runs[0]!.result.cleanupFailed).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a required file that executes zero tests is exposed as missing coverage", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(
      join(testRoot, "passing.test.ts"),
      'import { test } from "bun:test";\ntest("passing", () => {});\n',
    );
    writeFileSync(join(testRoot, "empty.test.ts"), "export const neverRun = true;\n");
    writeFileSync(join(base, FLEET), 'export const placeholder = 1;\n');
    try {
      const result = await runFullCorpus(base);
      expect(result.ok).toBe(false);
      const run = result.runs[0]!;
      expect(run.coverage?.status).toBe("incomplete");
      expect(run.coverage?.missing).toContain(`${TEST_CORPUS_ROOT}/empty.test.ts`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("skipped required coverage cannot be reported as a green qualification", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(
      join(testRoot, "skippy.test.ts"),
      [
        'import { test, expect } from "bun:test";',
        'test("runs", () => { expect(1).toBe(1); });',
        'test.skip("deliberately skipped", () => { expect(1).toBe(1); });',
        "",
      ].join("\n"),
    );
    writeFileSync(join(base, FLEET), 'export const placeholder = 1;\n');
    try {
      const result = await runFullCorpus(base);
      expect(result.ok).toBe(false);
      const run = result.runs[0]!;
      expect(run.coverage?.status).toBe("incomplete");
      expect(run.coverage?.skippedTests).toBeGreaterThan(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects an invocation whose required selection is empty before starting", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(join(testRoot, "fleet-qualification.test.ts"), 'export const placeholder = 1;\n');
    try {
      await expect(runFullCorpus(base)).rejects.toThrow(/selection cannot be empty/);
      // Rejection happens before any run: no logs, no junit evidence.
      expect(existsSync(join(base, "run-1.junit.xml"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects a bunfig.toml [test] section that could silently change required selection", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(
      join(testRoot, "a.test.ts"),
      'import { test } from "bun:test";\ntest("a", () => {});\n',
    );
    writeFileSync(join(base, "bunfig.toml"), "[test]\nroot = \"elsewhere\"\n");
    try {
      await expect(runFullCorpus(base)).rejects.toThrow(/bunfig\.toml.*\[test\]/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("suite selection: focused mode evidence", () => {
  test("explicitly selected files execute and filters never declare intentional selection missing", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(
      join(testRoot, "targeted.test.ts"),
      [
        'import { test, expect } from "bun:test";',
        'test("targeted case", () => { expect(1).toBe(1); });',
        'test("other case", () => { expect(1).toBe(1); });',
        "",
      ].join("\n"),
    );
    writeFileSync(join(base, FLEET), 'export const placeholder = 1;\n');
    try {
      const explicit = await runSupervisedSuite({
        mode: "focused",
        bunArguments: [`${TEST_CORPUS_ROOT}/targeted.test.ts`],
        cwd: base,
        perRunDeadlineMs: 30_000,
        logDir: join(base, "logs"),
      });
      expect(explicit.ok).toBe(true);
      expect(explicit.runs[0]!.coverage?.status).toBe("complete");
      expect(explicit.runs[0]!.coverage?.executedFiles).toBe(1);
      expect(existsSync(join(explicit.logDir, "run-1.junit.xml"))).toBe(true);

      const filtered = await runSupervisedSuite({
        mode: "focused",
        bunArguments: ["-t", "other case"],
        cwd: base,
        perRunDeadlineMs: 30_000,
        logDir: join(base, "logs-filtered"),
      });
      // A name filter intentionally runs fewer tests than the corpus; that is
      // explicit selection, not missing coverage.
      expect(filtered.ok).toBe(true);
      expect(filtered.runs[0]!.coverage?.status).toBe("complete");

      const empty = await runSupervisedSuite({
        mode: "focused",
        bunArguments: [`${TEST_CORPUS_ROOT}/targeted.test.ts`, "-t", "no such case"],
        cwd: base,
        perRunDeadlineMs: 30_000,
        logDir: join(base, "logs-empty"),
      });
      // A selected file whose filter runs zero tests is not a green
      // qualification: the runner itself exits nonzero, and zero runnable
      // coverage can never be reported complete.
      expect(empty.ok).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("runner identity: the pinned Bun version", () => {
  test("rejects an unpinned runner identity before it can produce a misleading pass", () => {
    expect(() => assertRunnerIsPinnedBun("1.4.0", "1.2.17")).toThrow(/pinned Bun 1\.4\.0/);
    expect(() => assertRunnerIsPinnedBun("1.4.0", undefined)).toThrow(/pinned Bun 1\.4\.0/);
    expect(() => assertRunnerIsPinnedBun("1.4.0", "1.4.0")).not.toThrow();
  });
});