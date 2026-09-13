import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  QUALIFICATION_RECORD_FILENAME,
  assertRunnerIsPinnedBun,
  junitEvidencePath,
  pinnedBunVersion,
  runSupervisedSuite,
} from "./support/suite-supervisor.js";
import { TEST_CORPUS_ROOT } from "./support/corpus-inventory.js";

/**
 * Canonical suite selection, proven with the actual runner: every test here
 * drives the real supervisor's default command (the real pinned Bun
 * executable) over a tiny isolated corpus, asserting behavior through
 * side-effect markers, the structured junit execution evidence, and the
 * retained run log — never by inspecting the constructed argv or source text.
 * The runner-identity section is the one exception to "real executable": the
 * gate is exercised on the real supervisor seam with the real pin, and the
 * only simulated input is the running-version identity read (no machine can
 * vary it without installing another Bun); its proofs are kept in one
 * describe block so the claim's scope is explicit.
 */

const FLEET = "test/fleet-qualification.test.ts";

interface CorpusFile {
  readonly path: string;
  readonly body: string;
}

/**
 * The source identity contract's scope is Git-derived, so a canonical fixture
 * invocation's base is a Git repository (an unborn HEAD is a valid state; the
 * corpus files are untracked non-ignored content the fingerprint covers).
 */
function gitInit(base: string): void {
  execFileSync("git", ["-C", base, "init", "-q"]);
}

function corpusFixture(build: (base: string) => readonly CorpusFile[]): string {
  const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
  const testRoot = join(base, TEST_CORPUS_ROOT);
  mkdirSync(testRoot, { recursive: true });
  mkdirSync(join(base, "markers"));
  for (const file of build(base)) {
    writeFileSync(join(base, file.path), file.body);
  }
  gitInit(base);
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
      expect(existsSync(junitEvidencePath(result.logDir, 1))).toBe(true);
      // The qualification record identifies the admitted source and the
      // derived selection the run actually executed.
      const record = JSON.parse(
        readFileSync(join(base, "logs", QUALIFICATION_RECORD_FILENAME), "utf8"),
      ) as {
        source: { kind: string };
        selection: { selectedCount: number; selectionDigest: string; excluded: readonly string[]; named: readonly string[] };
      };
      expect(record.source.kind).toBe("admitted-source");
      expect(record.selection).toMatchObject({
        selectedCount: 1,
        excluded: [FLEET],
        named: [],
      });
      expect(record.selection.selectionDigest).toMatch(/^[0-9a-f]{64}$/);
      const log = readFileSync(run.logPath, "utf8");
      expect(log).toMatch(/^runtime: bun \d+\.\d+\.\d+ \(\S+\) \S+ \S+$/m);
      expect(log).toContain(`selection: mode=full test-root=${TEST_CORPUS_ROOT} selected=1 excluded=1`);
      expect(log).toContain(`selection-excluded: ${FLEET}`);
      expect(log).toContain("coverage: status=complete executed=1 skipped=0 missing=0 unexpected=0");
      const junit = readFileSync(junitEvidencePath(result.logDir, 1), "utf8");
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
      gitInit(base);
      const result = await runFullCorpus(base);
      expect(result.ok).toBe(false);
      expect(result.firstFailure).not.toBeNull();
      expect(result.firstFailure?.result.kind).toBe("exit");
      if (result.firstFailure?.result.kind === "exit") {
        expect(result.firstFailure.result.exitCode).toBe(1);
      }
      expect(existsSync(junitEvidencePath(result.logDir, 1))).toBe(true);
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
    gitInit(base);
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
    gitInit(base);
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
    gitInit(base);
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
      // Rejection happens before any run: the diagnostics directory (created
      // before the first run starts) and its evidence never come to exist.
      expect(existsSync(join(base, "logs"))).toBe(false);
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
      // Rejection happens before any run: the diagnostics directory never
      // comes to exist.
      expect(existsSync(join(base, "logs"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects an unparseable bunfig.toml because unknown configuration is never trusted", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(
      join(testRoot, "a.test.ts"),
      'import { test } from "bun:test";\ntest("a", () => {});\n',
    );
    // A bunfig whose test policy cannot be read cannot be proven harmless:
    // swallowing the parse error would treat garbage as "no [test] section".
    writeFileSync(join(base, "bunfig.toml"), "not toml [\nroot = \"unclosed\n");
    try {
      await expect(runFullCorpus(base)).rejects.toThrow(/does not parse as TOML/);
      expect(existsSync(join(base, "logs"))).toBe(false);
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
    gitInit(base);
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
      expect(existsSync(junitEvidencePath(explicit.logDir, 1))).toBe(true);

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

  test("explicitly named policy-excluded files keep a live execution gate and truthful evidence", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(
      join(testRoot, "passing.test.ts"),
      'import { test } from "bun:test";\ntest("passing", () => {});\n',
    );
    // The canonical fleet run names the policy-excluded file explicitly.
    writeFileSync(
      join(base, FLEET),
      'import { test } from "bun:test";\ntest("fleet", () => {});\n',
    );
    gitInit(base);
    try {
      const fleet = await runSupervisedSuite({
        mode: "focused",
        bunArguments: [FLEET],
        cwd: base,
        perRunDeadlineMs: 30_000,
        logDir: join(base, "logs"),
      });
      expect(fleet.ok).toBe(true);
      const run = fleet.runs[0]!;
      expect(run.coverage?.status).toBe("complete");
      expect(run.coverage?.executedFiles).toBe(1);
      const log = readFileSync(run.logPath, "utf8");
      expect(log).toContain("selection: mode=focused explicit-selection named=1");
      expect(log).toContain(`selection-named: ${FLEET}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a focused run without a name filter gates skipped required coverage strictly", async () => {
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
    gitInit(base);
    try {
      const result = await runSupervisedSuite({
        mode: "focused",
        bunArguments: [`${TEST_CORPUS_ROOT}/skippy.test.ts`],
        cwd: base,
        perRunDeadlineMs: 30_000,
        logDir: join(base, "logs"),
      });
      expect(result.ok).toBe(false);
      expect(result.runs[0]!.coverage?.status).toBe("incomplete");
      expect(result.runs[0]!.coverage?.skippedTests).toBe(1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("an explicitly named corpus file without executed evidence fails the focused gate", async () => {
    const base = mkdtempSync(join(tmpdir(), "apkit-selection-"));
    const testRoot = join(base, TEST_CORPUS_ROOT);
    mkdirSync(testRoot);
    writeFileSync(
      join(testRoot, "passing.test.ts"),
      'import { test } from "bun:test";\ntest("passing", () => {});\n',
    );
    writeFileSync(join(testRoot, "empty.test.ts"), "export const neverRun = true;\n");
    writeFileSync(join(base, FLEET), 'export const placeholder = 1;\n');
    gitInit(base);
    try {
      const result = await runSupervisedSuite({
        mode: "focused",
        bunArguments: [
          `${TEST_CORPUS_ROOT}/passing.test.ts`,
          `${TEST_CORPUS_ROOT}/empty.test.ts`,
        ],
        cwd: base,
        perRunDeadlineMs: 30_000,
        logDir: join(base, "logs"),
      });
      expect(result.ok).toBe(false);
      expect(result.runs[0]!.coverage?.status).toBe("incomplete");
      expect(result.runs[0]!.coverage?.missing).toContain(`${TEST_CORPUS_ROOT}/empty.test.ts`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("reused diagnostics cannot complete a run from a previous invocation's evidence", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "apkit-selection-reused-"));
    const first = mkdtempSync(join(tmpdir(), "apkit-selection-a-"));
    const second = mkdtempSync(join(tmpdir(), "apkit-selection-b-"));
    try {
      for (const [base, name] of [
        [first, "alpha"],
        [second, "beta"],
      ] as const) {
        const testRoot = join(base, TEST_CORPUS_ROOT);
        mkdirSync(testRoot);
        writeFileSync(
          join(testRoot, `${name}.test.ts`),
          `import { test } from "bun:test";\ntest("${name}", () => {});\n`,
        );
        writeFileSync(join(base, FLEET), 'export const placeholder = 1;\n');
        gitInit(base);
      }
      // Corpus A completes first and leaves its evidence behind.
      const firstRun = await runSupervisedSuite({
        mode: "full",
        cwd: first,
        perRunDeadlineMs: 30_000,
        logDir,
      });
      expect(firstRun.ok).toBe(true);
      // Corpus B reuses the same diagnostics directory. The stale evidence
      // names alpha's file, which is not in B's selection; only B's own fresh
      // evidence may complete the run.
      const secondRun = await runSupervisedSuite({
        mode: "full",
        cwd: second,
        perRunDeadlineMs: 30_000,
        logDir,
      });
      expect(secondRun.ok).toBe(true);
      expect(secondRun.runs[0]!.coverage).toEqual({
        status: "complete",
        executedFiles: 1,
        skippedTests: 0,
        missing: [],
        unexpected: [],
      });
    } finally {
      rmSync(logDir, { recursive: true, force: true });
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe("runner identity: the pinned Bun version", () => {
  /**
   * What each proof carries — stated honestly, no fabricated runner: (1) the
   * invocation gate is exercised on the real supervisor seam
   * (`prepareSuiteInvocation`, which every canonical invocation passes
   * through) with the real pin read from the real package.json; the only
   * simulated input is the running-version identity read, which no machine
   * can vary without installing another Bun. (2) Real supervised runs record
   * the canonical pinned identity in the retained run log. (3) The identity
   * boundary itself rejects from the canonical pin, never a literal.
   */
  test("the supervisor's invocation gate rejects a runner identity that is not the canonical pin", async () => {
    const base = corpusFixture((base) => [runnerHelper(base), includedFile(base), fleetFile(base)]);
    try {
      const pinned = pinnedBunVersion();
      const realVersion = process.versions.bun;
      expect(realVersion).toBe(pinned);
      try {
        process.versions.bun = "1.2.17";
        await expect(runFullCorpus(base)).rejects.toThrow(`pinned Bun ${pinned}`);
        // Rejection happens before any run: the diagnostics directory never
        // comes to exist and no evidence is written.
        expect(existsSync(join(base, "logs"))).toBe(false);
      } finally {
        process.versions.bun = realVersion;
      }
      // The real, pinned runner passes the same gate and qualifies.
      const result = await runFullCorpus(base);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("a real supervised run records the canonical pinned identity in its log", async () => {
    const base = corpusFixture((base) => [runnerHelper(base), includedFile(base), fleetFile(base)]);
    try {
      const result = await runFullCorpus(base);
      expect(result.ok).toBe(true);
      const log = readFileSync(result.runs[0]!.logPath, "utf8");
      expect(log).toContain(`runtime: bun ${pinnedBunVersion()} (`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("the identity boundary rejects from the canonical pin, never a literal", () => {
    const pinned = pinnedBunVersion();
    expect(() => assertRunnerIsPinnedBun(pinned, "1.2.17")).toThrow(`pinned Bun ${pinned}`);
    expect(() => assertRunnerIsPinnedBun(pinned, undefined)).toThrow(`pinned Bun ${pinned}`);
    expect(() => assertRunnerIsPinnedBun(pinned, pinned)).not.toThrow();
  });
});