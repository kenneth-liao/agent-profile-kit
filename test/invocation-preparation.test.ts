import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProcess } from "../process/process-executor.js";
import {
  PackagePreparationStageError,
  extractPackageArchive,
  obtainPackageArchive,
  PREPARED_PACKAGE_ARCHIVE_ENV,
  SUPERVISED_INVOCATION_ENV,
  packedCliNodeExecutable,
  type PackageArchiveCommands,
} from "./support/package-archive.js";
import {
  PACKAGE_REQUEST_CHANNEL_ENV,
  PACKAGE_REQUEST_WAIT_ENV,
} from "./support/package-request-channel.js";
import {
  captureSourceFingerprint,
  createPackageCandidate,
  digestBytes,
  packageIdentityRecordPath,
  type PackageIdentityRecord,
} from "./support/package-identity.js";
import {
  PREPARATION_LOG_FILENAME,
  QUALIFICATION_RECORD_FILENAME,
  QUALIFICATION_RECORD_SCHEMA,
  formatSuiteSummary,
  pinnedBunVersion,
  runSupervisedSuite,
  type SuiteSupervisorResult,
} from "./support/suite-supervisor.js";

/**
 * Real-runner proofs for lazy, supervisor-owned invocation-package
 * preparation (TEST-002's real immutable-candidate consumer path): every test
 * drives the real supervisor's default command (the real pinned Bun
 * executable) over a tiny isolated corpus with injected preparation commands
 * that produce a REAL tarball, and asserts behavior through side-effect
 * markers, the preparation evidence, and the retained run log — never by
 * inspecting constructed argv or source text. The channel protocol's own unit
 * proofs live in test/package-request-channel.test.ts.
 */

const REPOSITORY_ROOT = new URL("..", import.meta.url).pathname;

const temporaryDirectories: string[] = [];
function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Absolute import specifiers a fixture corpus file uses to reach the seam. */
const seamImport = (module: string): string => join(REPOSITORY_ROOT, "test", "support", module);
const executorImport = join(REPOSITORY_ROOT, "process", "process-executor.js");

const CONSUMER_A = "test/consumer-a.test.ts";
const CONSUMER_B = "test/consumer-b.test.ts";
const PURE_FILE = "test/pure.test.ts";
const FLEET_CONSUMER = "test/fleet-consumer.test.ts";

/**
 * The consumer fixture: it uses the real seam, asserts the supervised marker,
 * obtains the archive it was given (through the invocation's request channel —
 * the request IS the consumer declaration), extracts it, launches Node against
 * the candidate's CLI, and records the received archive path and the CLI's own
 * output. A candidate whose CLI does not print the marker (for example an
 * unrelated repository bundle) fails this consumer.
 */
const consumerSource = (name: string, markerName: string): string => `
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPackageArchive,
  obtainPackageArchive,
  supervisedInvocationActive,
} from ${JSON.stringify(seamImport("package-archive.js"))};
import { runProcess } from ${JSON.stringify(executorImport)};

test("${name} executes the invocation candidate", async () => {
  const markers = ${JSON.stringify(join("${BASE}", "markers"))};
  if (!supervisedInvocationActive(process.env)) {
    throw new Error("expected the supervised-invocation marker");
  }
  const archive = await obtainPackageArchive("/unused/repository-root", "unused-");
  writeFileSync(join(markers, "${markerName}-archive"), archive.path);
  const extracted = mkdtempSync(join(tmpdir(), "fixture-consumer-extracted-"));
  try {
    await extractPackageArchive(archive.path, extracted);
    const result = await runProcess({
      executable: "node",
      arguments_: [join(extracted, "package", "dist", "cli.js")],
      deadlineMs: 10_000,
      commandLabel: "candidate consumer",
    });
    const output = result.stdout;
    writeFileSync(join(markers, "${markerName}-output"), output);
    if (result.kind !== "exit" || result.exitCode !== 0 || !output.includes("CANDIDATE-CLI-MARKER")) {
      throw new Error(\`the consumer did not execute the invocation candidate: \${result.kind} \${output}\`);
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
});
`;

/**
 * The record-capturing consumer: identical to the standard consumer, plus a
 * marker carrying the record beside the archive it was given, so tests can
 * assert the admitted identity at its live boundary (the pinned candidate
 * directory dies with the invocation's owned cleanup).
 */
const recordConsumerSource = (name: string, markerName: string): string => `
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPackageArchive,
  obtainPackageArchive,
  supervisedInvocationActive,
} from ${JSON.stringify(seamImport("package-archive.js"))};
import { runProcess } from ${JSON.stringify(executorImport)};

test("${name} executes the invocation candidate", async () => {
  const markers = ${JSON.stringify(join("${BASE}", "markers"))};
  if (!supervisedInvocationActive(process.env)) {
    throw new Error("expected the supervised-invocation marker");
  }
  const archive = await obtainPackageArchive("/unused/repository-root", "unused-");
  writeFileSync(join(markers, "${markerName}-archive"), archive.path);
  writeFileSync(join(markers, "${markerName}-record"), readFileSync(archive.path + ".provenance.json", "utf8"));
  const extracted = mkdtempSync(join(tmpdir(), "fixture-consumer-extracted-"));
  try {
    await extractPackageArchive(archive.path, extracted);
    const result = await runProcess({
      executable: "node",
      arguments_: [join(extracted, "package", "dist", "cli.js")],
      deadlineMs: 10_000,
      commandLabel: "candidate consumer",
    });
    const output = result.stdout;
    writeFileSync(join(markers, "${markerName}-output"), output);
    if (result.kind !== "exit" || result.exitCode !== 0 || !output.includes("CANDIDATE-CLI-MARKER")) {
      throw new Error(\`the consumer did not execute the invocation candidate: \${result.kind} \${output}\`);
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
});
`;

/**
 * The fleet consumer fixture: the canonical fleet launch entry resolves its
 * executable through the consumer boundary and executes it under Node. The
 * fixture root may carry a deliberately different or absent dist — neither can
 * be executed, because the launch path has no repository-bundle reference. The
 * generated home is owned here: it is removed even when the fleet CLI's
 * release fails, and a release failure propagates (never a silent success).
 */
const fleetConsumerSource = (markerName: string): string => `
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFleetCli, releaseFleetCliPath } from ${JSON.stringify(join(REPOSITORY_ROOT, "test", "support", "fleet-cli.js"))};

test("fleet launches execute the invocation candidate", async () => {
  const markers = ${JSON.stringify(join("${BASE}", "markers"))};
  const home = mkdtempSync(join(tmpdir(), "fixture-fleet-home-"));
  writeFileSync(join(markers, "${markerName}-home"), home);
  try {
    const result = await runFleetCli(home, process.env.PATH ?? "", ["status", "--all"]);
    writeFileSync(join(markers, "${markerName}-output"), result.stdout);
    if (result.kind !== "exit" || result.exitCode !== 0 || !result.stdout.includes("CANDIDATE-CLI-MARKER")) {
      throw new Error(\`the fleet launch did not execute the invocation candidate: \${result.kind} \${result.stdout}\`);
    }
  } finally {
    let releaseError: unknown = undefined;
    try {
      await releaseFleetCliPath();
    } catch (error) {
      releaseError = error;
    }
    rmSync(home, { recursive: true, force: true });
    if (releaseError !== undefined) throw releaseError;
  }
});
`;

const pureSource = (name: string): string => `
import { writeFileSync } from "node:fs";
test("${name}", () => {
  writeFileSync(${JSON.stringify(join("${BASE}", "markers"))} + "/${name}", "1");
});
`;

interface CorpusFile {
  readonly path: string;
  readonly body: string;
}

function fixtureCorpus(files: readonly CorpusFile[]): string {
  const base = tempDir("apkit-invocation-");
  mkdirSync(join(base, "test"), { recursive: true });
  mkdirSync(join(base, "markers"));
  // The fast-suite exclusion policy names the fleet file; a corpus without it
  // is rejected as a mistyped policy, so every fixture corpus carries the
  // placeholder (it is policy-excluded from the derived selection and never
  // executes under full/stress mode — proven by the absent marker below).
  const corpus = [
    ...files,
    { path: "test/fleet-qualification.test.ts", body: pureSource("fleet-placeholder") },
  ];
  // Run-local artifacts (consumer markers, run logs, junit evidence) are
  // ignored, so the candidate creator's source fingerprint — captured against
  // this Git repository — covers the relevant source only and stays stable
  // while runs execute.
  writeFileSync(join(base, ".gitignore"), "markers/\nlogs/\ndist/\n");
  for (const file of corpus) {
    writeFileSync(join(base, file.path), file.body.replaceAll("${BASE}", base));
  }
  execFileSync("git", ["-C", base, "init", "-q"]); 
  execFileSync("git", ["-C", base, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", base, "config", "user.name", "Agent Profile Kit Tests"]);
  execFileSync("git", ["-C", base, "add", "."]);
  execFileSync("git", ["-C", base, "commit", "-qm", "fixture corpus"]);
  return base;
}

/**
 * Injected preparation commands whose product is a REAL tarball: the build
 * stage stages a package with an executable `dist/cli.js` printing the
 * candidate marker, and the pack stage produces the tarball through the shared
 * bounded executor. Calls record each stage's received budget share so the
 * one-shared-budget rule is observable.
 */
function realCandidateCommands(token: string, calls: string[]): PackageArchiveCommands {
  const staging = tempDir("apkit-invocation-staging-");
  return {
    build: async (stage) => {
      calls.push(`build:${stage.deadlineMs}:${stage.signal === undefined ? "no-signal" : "signal"}`);
      // A small real build delay so the pack stage's remaining budget share is
      // observably smaller than the shared budget in the sharing proof.
      await new Promise((resolve) => setTimeout(resolve, 25));
      mkdirSync(join(staging, "package", "dist"), { recursive: true });
      writeFileSync(
        join(staging, "package", "dist", "cli.js"),
        `console.log("CANDIDATE-CLI-MARKER-${token}");\n`,
      );
    },
    createScriptDisabledArchive: async (stage, destination) => {
      calls.push(`pack:${stage.deadlineMs}`);
      const result = await runProcess({
        executable: "tar",
        arguments_: ["-czf", join(destination, "candidate.tgz"), "-C", staging, "package"],
        deadlineMs: 10_000,
        commandLabel: "fixture pack",
      });
      if (!(result.kind === "exit" && result.exitCode === 0)) {
        throw new Error(`fixture pack failed: ${result.kind}`);
      }
      return { filename: "candidate.tgz", files: ["dist/cli.js"] };
    },
  };
}

async function runFullCorpus(
  base: string,
  overrides: Partial<Parameters<typeof runSupervisedSuite>[0]> = {},
  abortSignal?: AbortSignal,
): Promise<SuiteSupervisorResult> {
  return runSupervisedSuite(
    {
      mode: "full",
      cwd: base,
      perRunDeadlineMs: 30_000,
      logDir: join(base, "logs"),
      ...overrides,
    },
    abortSignal,
  );
}

/** Every private channel directory matching the supervisor's prefix. */
function channelDirectories(): readonly string[] {
  return readdirSync(tmpdir())
    .filter((entry) => entry.startsWith("agent-profile-kit-package-channel-"))
    .map((entry) => join(tmpdir(), entry));
}

describe("invocation preparation: lazy, supervisor-owned, one candidate", () => {
  test("two consumers share one prepared candidate built and packed exactly once", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: consumerSource("consumer A", "a") },
      { path: CONSUMER_B, body: consumerSource("consumer B", "b") },
    ]);
    const before = new Set(channelDirectories());
    const calls: string[] = [];
    const commands = realCandidateCommands("shared", calls);
    const result = await runFullCorpus(base, { packageCommands: commands });
    expect(result.ok).toBe(true);
    // Preparation is bounded, requested, and recorded with its shared budget.
    expect(result.preparation.status).toBe("prepared");
    expect(result.preparation.requests).toBeGreaterThan(0);
    expect(result.preparation.durationMs).toBeGreaterThan(0);
    expect(result.preparation.cleanupFailed).toBe(false);
    // Exactly one build and one pack; the pack's remaining budget share is
    // bounded by the build's measured consumption because the stages share
    // one finite budget (the injected build sleeps at least 25ms, and the
    // shares are read after the directory creation, so the build's share is
    // at most the full budget and never below the sleep it contains).
    expect(calls.filter((call) => call.startsWith("build:"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("pack:"))).toHaveLength(1);
    const buildShare = Number(calls.find((call) => call.startsWith("build:"))!.split(":")[1]);
    const packShare = Number(calls.find((call) => call.startsWith("pack:"))!.split(":")[1]);
    expect(buildShare).toBeGreaterThan(0);
    expect(buildShare).toBeLessThanOrEqual(30_000);
    expect(packShare).toBeGreaterThan(0);
    expect(packShare).toBeLessThanOrEqual(buildShare - 25);
    // Both consumers received the same candidate archive and executed its CLI.
    const archiveA = readFileSync(join(base, "markers", "a-archive"), "utf8");
    const archiveB = readFileSync(join(base, "markers", "b-archive"), "utf8");
    expect(archiveA).toBe(archiveB);
    expect(archiveA).toContain("agent-profile-kit-invocation-candidate-");
    expect(readFileSync(join(base, "markers", "a-output"), "utf8")).toContain(
      "CANDIDATE-CLI-MARKER-shared",
    );
    expect(readFileSync(join(base, "markers", "b-output"), "utf8")).toContain(
      "CANDIDATE-CLI-MARKER-shared",
    );
    // The candidate directory is removed after the invocation; the extracted
    // copies the consumers made are theirs to clean, the candidate is ours.
    expect(result.preparation.candidateDirectory).toBeDefined();
    expect(existsSync(result.preparation.candidateDirectory!)).toBe(false);
    // The retained run log carries the preparation evidence and the model.
    const log = readFileSync(result.runs[0]!.logPath, "utf8");
    expect(log).toContain("preparation: status=prepared");
    expect(log).toContain(`archive=${result.preparation.archivePath}`);
    expect(log).toContain("preparation-model: lazy");
    expect(log).toMatch(/preparation-cleanup: durationMs=\d+ failed=false/);
    // The invocation-private channel is gone after the invocation.
    expect(channelDirectories().filter((path) => !before.has(path))).toEqual([]);
  });

  test("a pure name-filter selection over a mixed corpus never builds and runs green", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: consumerSource("consumer A", "a") },
      { path: PURE_FILE, body: pureSource("pure-selection-runs") },
    ]);
    const calls: string[] = [];
    const result = await runSupervisedSuite({
      mode: "focused",
      bunArguments: ["-t", "pure-selection-runs"],
      cwd: base,
      perRunDeadlineMs: 30_000,
      logDir: join(base, "logs"),
      packageCommands: realCandidateCommands("never", calls),
    });
    // The filter only executes the pure test, so no consumer ever requested
    // the package: no build, no pack, and the evidence states the truth.
    expect(result.ok).toBe(true);
    expect(result.preparation.status).toBe("none");
    expect(result.preparation.requests).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(join(base, "markers", "pure-selection-runs"))).toBe(true);
    expect(existsSync(join(base, "markers", "a-archive"))).toBe(false);
    const log = readFileSync(result.runs[0]!.logPath, "utf8");
    expect(log).toContain("preparation: status=none requests=0");
  });

  test("a consumer-reaching name-filter selection qualifies positively with one preparation", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: consumerSource("consumer A", "a") },
      { path: PURE_FILE, body: pureSource("pure-selection-runs") },
    ]);
    const calls: string[] = [];
    const commands = realCandidateCommands("filtered", calls);
    const result = await runSupervisedSuite({
      mode: "focused",
      bunArguments: ["-t", "consumer A"],
      cwd: base,
      perRunDeadlineMs: 30_000,
      logDir: join(base, "logs"),
      packageCommands: commands,
    });
    // Supported filter selection preserved: the consumer that the filter
    // actually executes triggers exactly one lazy preparation and executes
    // the candidate it was given.
    expect(result.ok).toBe(true);
    expect(result.preparation.status).toBe("prepared");
    expect(result.preparation.requests).toBeGreaterThan(0);
    expect(calls.filter((call) => call.startsWith("build:"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("pack:"))).toHaveLength(1);
    expect(readFileSync(join(base, "markers", "a-output"), "utf8")).toContain(
      "CANDIDATE-CLI-MARKER-filtered",
    );
  });

  test("a pure test filtered inside a named consumer file never builds", async () => {
    const base = fixtureCorpus([
      {
        path: CONSUMER_A,
        body: [
          consumerSource("consumer A", "a"),
          `\ntest("pure-selection-runs", () => {\n  writeFileSync(${JSON.stringify(join("${BASE}", "markers"))} + "/pure-in-consumer", "1");\n});\n`,
        ].join("\n"),
      },
    ]);
    // The consumer file is named explicitly, but the name filter matches only
    // a pure test in it: the consumer body (and its package access) never
    // executes, so no preparation is owed.
    const calls: string[] = [];
    const result = await runSupervisedSuite({
      mode: "focused",
      bunArguments: [CONSUMER_A, "-t", "pure-selection-runs"],
      cwd: base,
      perRunDeadlineMs: 30_000,
      logDir: join(base, "logs"),
      packageCommands: realCandidateCommands("never", calls),
    });
    expect(result.ok).toBe(true);
    expect(result.preparation.status).toBe("none");
    expect(result.preparation.requests).toBe(0);
    expect(calls).toEqual([]);
    expect(existsSync(join(base, "markers", "pure-in-consumer"))).toBe(true);
    expect(existsSync(join(base, "markers", "a-archive"))).toBe(false);
  });

  test("a flag-only focused selection executes the whole corpus and prepares once", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const calls: string[] = [];
    const commands = realCandidateCommands("flagonly", calls);
    const result = await runSupervisedSuite({
      mode: "focused",
      bunArguments: ["--update-snapshots"],
      cwd: base,
      perRunDeadlineMs: 30_000,
      logDir: join(base, "logs"),
      packageCommands: commands,
    });
    // Without any positional argument the runner executes the whole test root,
    // so the consumers run and the lazy request preparation serves them once.
    expect(result.ok).toBe(true);
    expect(result.preparation.status).toBe("prepared");
    expect(calls.filter((call) => call.startsWith("build:"))).toHaveLength(1);
    expect(readFileSync(join(base, "markers", "a-output"), "utf8")).toContain(
      "CANDIDATE-CLI-MARKER-flagonly",
    );
  });

  test("a failed preparation publishes its terminal failure and retains diagnostics", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const commands: PackageArchiveCommands = {
      build: async () => {
        throw new Error("fixture build failed");
      },
      createScriptDisabledArchive: async () => {
        throw new Error("pack must never run after a failed build");
      },
    };
    const startedAt = Date.now();
    const result = await runFullCorpus(base, { packageCommands: commands });
    expect(result.ok).toBe(false);
    expect(result.attemptedRuns).toBe(1);
    expect(result.preparation.status).toBe("failed");
    expect(result.preparation.failure).toContain("fixture build failed");
    expect(existsSync(result.preparation.candidateDirectory!)).toBe(false);
    // The terminal failure reached the waiting consumer immediately: the
    // invocation did not spin until the coordinated wait budget expired.
    expect(Date.now() - startedAt).toBeLessThan(7_000);
    expect(result.runs[0]!.result.stderr).toContain("fixture build failed");
    const preparationLog = readFileSync(join(result.logDir, PREPARATION_LOG_FILENAME), "utf8");
    expect(preparationLog).toContain("status: failed");
    expect(preparationLog).toContain("fixture build failed");
  });

  test("an operator-supplied archive passes through untouched with zero preparation", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: recordConsumerSource("consumer A", "a") },
    ]);
    const suppliedRoot = tempDir("apkit-supplied-");
    // The operator-supplied candidate is created by the one from-source
    // creator against the consuming fixture repository, so its record binds
    // the exact archive bytes and the relevant source at the real boundary.
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    const calls: string[] = [];
    await withSuppliedArchive(created.archivePath, async () => {
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("never", calls),
      });
      expect(result.ok, result.runs[0]?.result.stderr.slice(-800)).toBe(true);
      expect(result.preparation.status).toBe("supplied");
      // The gate's duration is retained truthfully (real Git children ran).
      expect(result.preparation.durationMs).toBeGreaterThan(0);
      // The children received the invocation-owned pinned copy, not the
      // external archive; its record binds the admitted identity.
      const consumedArchive = readFileSync(join(base, "markers", "a-archive"), "utf8");
      expect(consumedArchive.startsWith(join(realpathSync(tmpdir()), "agent-profile-kit-supplied-pinned-"))).toBe(true);
      const pinnedRecord: PackageIdentityRecord = JSON.parse(
        readFileSync(join(base, "markers", "a-record"), "utf8"),
      ) as PackageIdentityRecord;
      expect(pinnedRecord.sourceFingerprint).toBe(created.record.sourceFingerprint);
      expect(calls).toEqual([]);
      // The operator's archive and record were never rewritten or removed.
      expect(existsSync(created.archivePath)).toBe(true);
      expect(existsSync(created.recordPath)).toBe(true);
      expect(readFileSync(join(base, "markers", "a-output"), "utf8")).toContain(
        "CANDIDATE-CLI-MARKER-supplied",
      );
      // The pinned directory died with the invocation's owned cleanup.
      expect(
        readdirSync(tmpdir()).filter((entry) => entry.startsWith("agent-profile-kit-supplied-pinned-")),
      ).toEqual([]);
    });
  });

  test("sequential invocations own fresh candidates with no cross-invocation reuse", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const calls: string[] = [];
    const commands = realCandidateCommands("fresh", calls);
    const first = await runFullCorpus(base, { packageCommands: commands });
    expect(first.ok).toBe(true);
    const firstArchive = readFileSync(join(base, "markers", "a-archive"), "utf8");
    const second = await runFullCorpus(base, { packageCommands: commands });
    expect(second.ok).toBe(true);
    const secondArchive = readFileSync(join(base, "markers", "a-archive"), "utf8");
    expect(secondArchive).not.toBe(firstArchive);
    // Each invocation prepared exactly one build and one pack.
    expect(calls.filter((call) => call.startsWith("build:"))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith("pack:"))).toHaveLength(2);
  });

  test("caught preparation failure cannot qualify a green consumer", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { test, expect } from "bun:test";
import { obtainPackageArchive } from ${JSON.stringify(join(REPOSITORY_ROOT, "test/support/package-archive.js"))};
test("caught consumer", async () => {
  await expect(obtainPackageArchive(process.cwd(), "unused-")).rejects.toThrow("fixture build failed");
});` }]);
    const result = await runFullCorpus(base, { packageCommands: {
      build: async () => { throw new Error("fixture build failed"); },
      createScriptDisabledArchive: async () => { throw new Error("unexpected pack"); },
    } });
    expect(result.runs[0]!.result.kind).toBe("exit");
    expect(result.completedRuns).toBe(1);
    expect(result.preparation.status).toBe("failed");
    expect(result.ok).toBe(false);
  });

  test.each(["failed", "interrupted"] as const)("stress summary reports %s preparation with a green child", async (status) => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { test, expect } from "bun:test";
import { obtainPackageArchive } from ${JSON.stringify(seamImport("package-archive.js"))};
test("caught consumer", async () => {
  await expect(obtainPackageArchive(process.cwd(), "unused-")).rejects.toThrow();
});` }]);
    const result = await runFullCorpus(base, {
      mode: "stress", maxRuns: 1, aggregateDeadlineMs: 30000,
      packageCommands: {
        build: async () => {
          if (status === "failed") throw new Error("fixture build failed");
          const controller = new AbortController();
          controller.abort();
          const cancelled = await runProcess({ executable: process.execPath, arguments_: ["-e", ""], deadlineMs: 1000 }, controller.signal);
          throw new PackagePreparationStageError("build", cancelled);
        },
        createScriptDisabledArchive: async () => { throw new Error("unexpected pack"); },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.completedRuns).toBe(1);
    expect(result.firstFailure).toBeNull();
    expect(result.preparation.status).toBe(status);
    const summary = formatSuiteSummary(result, null);
    expect(summary).toContain(`preparation: ${status}`);
    expect(summary).toContain("after 1/1 green runs");
    expect(summary).toContain(PREPARATION_LOG_FILENAME);
    expect(summary).toContain(result.logDir);
    expect(summary).not.toContain("failed at run");
  });

  test("an abort during preparation is interrupted with owned resources cleaned", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const before = new Set(channelDirectories());
    const calls: string[] = [];
    const commands: PackageArchiveCommands = {
      build: async (stage) => {
        calls.push(`build:${stage.deadlineMs}:${stage.signal === undefined ? "no-signal" : "signal"}`);
        // The signal releases this wait; the fallback timer only bounds a
        // broken signal path, and the proof below asserts propagation.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          stage.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      },
      createScriptDisabledArchive: async () => {
        throw new Error("pack must never run after an interrupted build");
      },
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const startedAt = Date.now();
    const result = await runFullCorpus(base, { packageCommands: commands }, controller.signal);
    expect(result.ok).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(result.preparation.status).toBe("interrupted");
    // The abort signal actually reached the build stage: the stage recorded
    // receiving the signal (its deadline share may have ticked down by the
    // directory creation, so the number is read loosely) and the invocation
    // did not wait out the fallback timer.
    const buildCall = calls.find((call) => call.startsWith("build:"));
    expect(buildCall).toMatch(/^build:\d+:signal$/);
    expect(Number(buildCall!.split(":")[1])).toBeGreaterThan(0);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    // Every owned resource is gone: the candidate, the channel, and nothing
    // was written into a removed directory (the channel is absent).
    expect(existsSync(result.preparation.candidateDirectory!)).toBe(false);
    expect(channelDirectories().filter((path) => !before.has(path))).toEqual([]);
    // The interrupted child's own cleanup evidence is retained, separately
    // from the directory cleanup's.
    const preparationLog = readFileSync(join(result.logDir, PREPARATION_LOG_FILENAME), "utf8");
    expect(preparationLog).toContain("status: interrupted");
    expect(preparationLog).toContain("childCleanupFailed:");
    expect(preparationLog).toContain("childCleanupDurationMs:");
    expect(preparationLog).toContain("interrupted during the build stage");
  });

  test("channel protocol tests remove every channel from their private temporary root", async () => {
    const directory = tempDir("apkit-channel-suite-");
    const result = await runProcess({
      executable: process.execPath,
      arguments_: ["run", "test:focused", "--", "test/package-request-channel.test.ts"],
      cwd: REPOSITORY_ROOT,
      environment: { ...process.env, TMPDIR: directory },
      deadlineMs: 10000,
    });
    expect(result.kind === "exit" && result.exitCode === 0).toBe(true);
    expect(readdirSync(directory).filter((entry) => entry.startsWith("agent-profile-kit-package-channel-"))).toEqual([]);
  });

  test("archive cleanup rejection cannot abandon a fleet extraction", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { mock, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
let owned = "";
mock.module(${JSON.stringify(join(REPOSITORY_ROOT, "test/support/package-archive.js"))}, () => ({
  obtainPackageArchive: async () => ({ path: "fixture", cleanup: () => { throw new Error("archive cleanup fault"); } }),
  packageArchiveRepositoryRoot: () => ".",
  packedCliNodeExecutable: () => "node",
  extractPackageArchive: async (_archive, directory) => { owned = directory; writeFileSync("owned-extraction", directory); mkdirSync(join(directory, "package/dist"), { recursive: true }); writeFileSync(join(directory, "package/dist/cli.js"), ""); },
}));
const { resolveFleetCliPath, releaseFleetCliPath } = await import(${JSON.stringify(join(REPOSITORY_ROOT, "test/support/fleet-cli.js"))});
test("archive cleanup fault", async () => {
  await expect(resolveFleetCliPath()).rejects.toThrow("archive cleanup fault");
  await releaseFleetCliPath();
  expect(existsSync(owned)).toBe(false);
});` }]);
    try {
      const result = await runFullCorpus(base);
      expect(result.ok).toBe(true);
    } finally {
      const marker = join(base, "owned-extraction");
      if (existsSync(marker)) rmSync(readFileSync(marker, "utf8"), { recursive: true, force: true });
    }
  });

  test("explicit and ambient channels stay isolated in both directions and concurrently", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { test, expect } from "bun:test";
import { obtainPackageArchive } from ${JSON.stringify(join(REPOSITORY_ROOT, "test/support/package-archive.js"))};
import { createPackageRequestChannel, publishPackageChannelResponse, removePackageChannel } from ${JSON.stringify(join(REPOSITORY_ROOT, "test/support/package-request-channel.js"))};
test("isolated channels", async () => {
  const channels = [createPackageRequestChannel(), createPackageRequestChannel()];
  try {
    channels.forEach((channel, index) => publishPackageChannelResponse(channel.directory, { status: "prepared", archivePath: "/candidate-" + index + ".tgz" }));
    const environment = (index) => ({ APKIT_TEST_SUPERVISED_INVOCATION: "1", APKIT_TEST_PACKAGE_REQUEST_CHANNEL: channels[index].directory, APKIT_TEST_PACKAGE_REQUEST_WAIT_MS: "1000" });
    Object.assign(process.env, environment(1));
    expect((await obtainPackageArchive(".", "unused", { environment: environment(0) })).path).toBe("/candidate-0.tgz");
    expect((await obtainPackageArchive(".", "unused")).path).toBe("/candidate-1.tgz");
    const results = await Promise.all([obtainPackageArchive(".", "unused", { environment: environment(0) }), obtainPackageArchive(".", "unused"), obtainPackageArchive(".", "unused")]);
    expect(results.map((result) => result.path)).toEqual(["/candidate-0.tgz", "/candidate-1.tgz", "/candidate-1.tgz"]);
  } finally { channels.forEach((channel) => removePackageChannel(channel.directory)); }
});` }]);
    const result = await runFullCorpus(base);
    expect(result.ok).toBe(true);
    expect(result.preparation.status).toBe("none");
  });

  test("consumer waits for preparation permitted by the runner budget", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer", "a") }]);
    const calls: string[] = [];
    const commands = realCandidateCommands("slow", calls);
    const result = await runFullCorpus(base, { perRunDeadlineMs: 12000, packageCommands: {
      ...commands,
      build: async (stage) => { await new Promise((resolve) => setTimeout(resolve, 8300)); await commands.build(stage); },
    } });
    expect(result.ok).toBe(true);
    expect(result.preparation.status).toBe("prepared");
    expect(calls).toHaveLength(2);
  }, 15000);

  test("runner termination aborts in-flight preparation before packing", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer", "a") }]);
    let packed = false;
    let aborted = false;
    const result = await runFullCorpus(base, { perRunDeadlineMs: 400, packageCommands: {
      build: async (stage) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1200);
          stage.signal?.addEventListener("abort", () => { aborted = true; clearTimeout(timer); resolve(); }, { once: true });
        });
      },
      createScriptDisabledArchive: async () => { packed = true; throw new Error("unused pack"); },
    } });
    expect(result.ok).toBe(false);
    expect(aborted).toBe(true);
    expect(packed).toBe(false);
    expect(result.preparation.status).toBe("interrupted");
    expect(existsSync(result.preparation.candidateDirectory!)).toBe(false);
  });

  test("failed preparation keeps directory cleanup failure in final evidence", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer", "a") }]);
    let owned = "";
    try {
      const result = await runFullCorpus(base, { packageCommands: {
        build: async () => {},
        createScriptDisabledArchive: async (_stage, directory) => {
          owned = directory;
          const flag = await runProcess({ executable: "chflags", arguments_: ["uchg", directory], deadlineMs: 2000 });
          if (flag.kind !== "exit" || flag.exitCode !== 0) throw new Error(flag.stderr);
          throw new Error("pack failed after creating owned state");
        },
      } });
      expect(result.ok).toBe(false);
      expect(result.preparation.cleanupFailed).toBe(true);
      expect(result.preparation.candidateDirectory).toBe(owned);
      expect(result.preparation.cleanupFailure).toContain("bounded path removal");
    } finally {
      if (owned) {
        await runProcess({ executable: "chflags", arguments_: ["nouchg", owned], deadlineMs: 2000 });
        rmSync(owned, { recursive: true, force: true });
      }
    }
  });

  test("cancelled preparation retains output and delivers its terminal cause", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { test, expect } from "bun:test";
import { obtainPackageArchive } from ${JSON.stringify(join(REPOSITORY_ROOT, "test/support/package-archive.js"))};
test("cancelled consumer", async () => {
  await expect(obtainPackageArchive(process.cwd(), "unused-")).rejects.toThrow("interrupted during the build stage");
});` }]);
    const result = await runFullCorpus(base, { packageCommands: {
      build: async () => { throw new PackagePreparationStageError("build", {
        kind: "cancelled", commandLabel: "fixture build", exitCode: null, signal: "SIGTERM",
        error: null, timedOut: false, cancelled: true, cleanupFailed: true,
        cleanupDurationMs: 750, durationMs: 10, stdout: "OUTPUT-MARKER", stderr: "ERROR-MARKER",
      }); },
      createScriptDisabledArchive: async () => { throw new Error("unexpected pack"); },
    } });
    expect(result.completedRuns).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.preparation.childCleanupFailed).toBe(true);
    expect(result.preparation.childCleanupDurationMs).toBe(750);
    const log = readFileSync(join(result.logDir, PREPARATION_LOG_FILENAME), "utf8");
    expect(log).toContain("OUTPUT-MARKER");
    expect(log).toContain("ERROR-MARKER");
    expect(existsSync(result.preparation.candidateDirectory!)).toBe(false);
  });

  test("publication and diagnostic failures cannot skip owned cleanup", async () => {
    for (const fault of ["response.json", "preparation.log"]) {
      const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { obtainPackageArchive } from ${JSON.stringify(join(REPOSITORY_ROOT, "test/support/package-archive.js"))};
test("fault", async () => {
  const channel = process.env.APKIT_TEST_PACKAGE_REQUEST_CHANNEL!;
  writeFileSync("channel-path", channel);
  if (${JSON.stringify(fault)} === "response.json") mkdirSync(join(channel, "response.json"));
  try { await obtainPackageArchive(process.cwd(), "unused-"); } catch {}
});` }]);
      const candidatePaths: string[] = [];
      const commands = realCandidateCommands("publication", []);
      if (fault === "preparation.log") mkdirSync(join(base, "logs", fault), { recursive: true });
      try {
        try {
          await runFullCorpus(base, { perRunDeadlineMs: 700, packageCommands: {
            build: fault === "preparation.log" ? async () => { throw new Error("build fault"); } : commands.build,
            createScriptDisabledArchive: async (stage, directory) => {
              candidatePaths.push(directory);
              return commands.createScriptDisabledArchive(stage, directory);
            },
          } });
        } catch (error) { expect(String(error)).toContain("EISDIR"); }
        expect(existsSync(readFileSync(join(base, "channel-path"), "utf8"))).toBe(false);
        for (const directory of candidatePaths) expect(existsSync(directory)).toBe(false);
      } finally {
        // The red probe owns only these exact observed resources.
        for (const directory of candidatePaths) rmSync(directory, { recursive: true, force: true });
        if (existsSync(join(base, "channel-path"))) rmSync(readFileSync(join(base, "channel-path"), "utf8"), { recursive: true, force: true });
      }
    }
  });

  test("an exceptional run-loop exit releases the candidate and the channel", async () => {
    const before = new Set(channelDirectories());
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const candidateDirectories: string[] = [];
    const commands = realCandidateCommands("throwing", []);
    const commandsWithWitness: PackageArchiveCommands = {
      build: commands.build,
      createScriptDisabledArchive: async (stage, destination) => {
        candidateDirectories.push(destination);
        return commands.createScriptDisabledArchive(stage, destination);
      },
    };
    // An exception from the run loop (the retained run log path is a
    // directory, so writing it throws EISDIR) must release every owned
    // resource and preserve the original error.
    mkdirSync(join(base, "logs", "run-1.log"), { recursive: true });
    let thrown: unknown = undefined;
    try {
      await runFullCorpus(base, { packageCommands: commandsWithWitness });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("EISDIR");
    // The candidate the watcher prepared was removed despite the exception,
    // and the invocation's channel died with it.
    expect(candidateDirectories.length).toBe(1);
    expect(existsSync(candidateDirectories[0]!)).toBe(false);
    expect(channelDirectories().filter((path) => !before.has(path))).toEqual([]);
  });

  test("an onRunComplete exception releases the candidate and the channel", async () => {
    const before = new Set(channelDirectories());
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const candidateDirectories: string[] = [];
    const commands = realCandidateCommands("throwing-hook", []);
    const commandsWithWitness: PackageArchiveCommands = {
      build: commands.build,
      createScriptDisabledArchive: async (stage, destination) => {
        candidateDirectories.push(destination);
        return commands.createScriptDisabledArchive(stage, destination);
      },
    };
    let thrown: unknown = undefined;
    try {
      await runFullCorpus(base, {
        packageCommands: commandsWithWitness,
        onRunComplete: () => {
          throw new Error("fixture completion failure");
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("fixture completion failure");
    expect(candidateDirectories.length).toBe(1);
    expect(existsSync(candidateDirectories[0]!)).toBe(false);
    expect(channelDirectories().filter((path) => !before.has(path))).toEqual([]);
  });

  test("a poisoned and an absent repository dist cannot be executed by the fleet launch path", async () => {
    for (const poisoned of [true, false]) {
      const base = fixtureCorpus([{ path: FLEET_CONSUMER, body: fleetConsumerSource("fleet") }]);
      if (poisoned) {
        // A deliberately different repository bundle at the fixture root.
        mkdirSync(join(base, "dist"), { recursive: true });
        writeFileSync(join(base, "dist", "cli.js"), 'console.log("WRONG-BUNDLE-MARKER");\n');
      }
      const calls: string[] = [];
      const token = poisoned ? "poisoned" : "absent";
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands(token, calls),
      });
      expect(result.ok).toBe(true);
      expect(calls.filter((call) => call.startsWith("build:"))).toHaveLength(1);
      expect(readFileSync(join(base, "markers", "fleet-output"), "utf8")).toContain(
        `CANDIDATE-CLI-MARKER-${token}`,
      );
      expect(readFileSync(join(base, "markers", "fleet-output"), "utf8")).not.toContain(
        "WRONG-BUNDLE-MARKER",
      );
      // The policy-excluded placeholder never executed in the full run.
      expect(existsSync(join(base, "markers", "fleet-placeholder"))).toBe(false);
      // The generated fleet home was owned by the fixture and removed even if
      // the fleet CLI's release had failed.
      expect(existsSync(readFileSync(join(base, "markers", "fleet-home"), "utf8"))).toBe(false);
    }
  });

  test("a fleet extraction cleanup failure propagates as a failed qualification", async () => {
    // The fixture child resolves the fleet path, makes its extraction directory
    // unremovable, and its afterAll releases (and therefore throws); the
    // qualification outcome must be nonzero, not a logged-away failure. The
    // parent owns the forced state's recovery.
    const base = fixtureCorpus([
      {
        path: "test/fleet-cleanup-failure.test.ts",
        body: `
import { afterAll, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { runProcess } from ${JSON.stringify(join(REPOSITORY_ROOT, "process", "process-executor.js"))};
import { dirname } from "node:path";
import { resolveFleetCliPath, releaseFleetCliPath } from ${JSON.stringify(join(REPOSITORY_ROOT, "test", "support", "fleet-cli.js"))};

afterAll(async () => {
  // Cleanup failure is qualification failure: the release propagates.
  await releaseFleetCliPath();
});

test("fleet cleanup failure propagates", async () => {
  const cliPath = await resolveFleetCliPath();
  // Make the extraction directory unremovable (immutable flag: deleting the
  // directory or its children fails with EPERM on this platform); the release
  // must fail loudly instead of reporting success.
  writeFileSync("owned-extraction", dirname(dirname(dirname(cliPath))));
  const result = await runProcess({ executable: "chflags", arguments_: ["uchg", dirname(cliPath)], deadlineMs: 2000 });
  if (result.kind !== "exit" || result.exitCode !== 0) throw new Error(result.stderr);
});
`,
      },
    ]);
    const marker = join(base, "owned-extraction");
    const unrelated = tempDir("agent-profile-kit-fleet-cli-extracted-");
    writeFileSync(join(unrelated, "control"), "unrelated invocation");
    try {
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("cleanup-failure", []),
      });
      expect(result.ok).toBe(false);
      expect(result.runs[0]!.result.stderr).toContain("EPERM");
    } finally {
      if (existsSync(marker)) {
        const directory = readFileSync(marker, "utf8");
        const recovery = await runProcess({
          executable: "chflags", arguments_: ["-R", "nouchg", directory], deadlineMs: 2000,
        });
        if (recovery.kind !== "exit" || recovery.exitCode !== 0) throw new Error(recovery.stderr);
        const removal = await runProcess({
          executable: process.execPath,
          arguments_: ["-e", "require('node:fs').rmSync(process.argv[1], {recursive:true, force:true})", directory],
          deadlineMs: 2000,
        });
        expect(removal.kind === "exit" && removal.exitCode === 0).toBe(true);
        expect(existsSync(directory)).toBe(false);
      }
      expect(readFileSync(join(unrelated, "control"), "utf8")).toBe("unrelated invocation");
    }
  });

  test("pure focused selections of consumer-seam and policy tests never prepare", async () => {
    const calls: string[] = [];
    const commands = realCandidateCommands("never", calls);
    const result = await runSupervisedSuite({
      mode: "focused",
      bunArguments: [
        "test/package-archive.test.ts",
        "test/package-request-channel.test.ts",
        "test/fleet-cli-policy.test.ts",
      ],
      perRunDeadlineMs: 120_000,
      logDir: tempDir("apkit-invocation-logs-"),
      packageCommands: commands,
    });
    expect(result.ok).toBe(true);
    expect(result.preparation.status).toBe("none");
    expect(result.preparation.requests).toBe(0);
    expect(calls).toEqual([]);
  });
});
/**
 * Provenance gate: one canonical identity contract for prepared and supplied
 * candidates (TEST-002, #538). A supplied archive qualifies only the source
 * identity its record demonstrably represents; missing, stale, mismatched, or
 * substituted provenance is rejected before qualification, and the prepared
 * candidate is created through the same from-source creator.
 */


/** Creator commands for the supplied-identity fixtures: one real tarball. */
function suppliedCreatorCommands(root: string, marker: string): PackageArchiveCommands {
  const staging = tempDir("apkit-supplied-staging-");
  return {
    build: async () => {
      mkdirSync(join(staging, "package", "dist"), { recursive: true });
      writeFileSync(join(staging, "package", "dist", "cli.js"), `console.log("${marker}");\n`);
    },
    createScriptDisabledArchive: async (_stage, destination) => {
      const result = await runProcess({
        executable: "tar",
        arguments_: ["-czf", join(destination, "supplied.tgz"), "-C", staging, "package"],
        deadlineMs: 10_000,
        commandLabel: "supplied fixture pack",
      });
      if (!(result.kind === "exit" && result.exitCode === 0)) {
        throw new Error(`fixture pack failed: ${result.kind}`);
      }
      return { filename: "supplied.tgz", files: ["dist/cli.js"] };
    },
  };
}

async function withSuppliedArchive(archive: string, run: () => Promise<void>): Promise<void> {
  const previousArchive = process.env[PREPARED_PACKAGE_ARCHIVE_ENV];
  const previousMarker = process.env[SUPERVISED_INVOCATION_ENV];
  process.env[PREPARED_PACKAGE_ARCHIVE_ENV] = archive;
  delete process.env[SUPERVISED_INVOCATION_ENV];
  try {
    await run();
  } finally {
    if (previousArchive === undefined) {
      delete process.env[PREPARED_PACKAGE_ARCHIVE_ENV];
    } else {
      process.env[PREPARED_PACKAGE_ARCHIVE_ENV] = previousArchive;
    }
    if (previousMarker === undefined) {
      delete process.env[SUPERVISED_INVOCATION_ENV];
    } else {
      process.env[SUPERVISED_INVOCATION_ENV] = previousMarker;
    }
  }
}

describe("supplied candidate provenance", () => {
  test("a supplied archive with no record is rejected before qualification", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    rmSync(created.recordPath);
    const calls: string[] = [];
    await withSuppliedArchive(created.archivePath, async () => {
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("never", calls),
      });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(0);
      expect(result.preparation.status).toBe("failed");
      expect(result.preparation.failure).toContain("rejected");
      expect(calls).toEqual([]);
    });
  });

  test("a substituted supplied archive is rejected before qualification", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    writeFileSync(created.archivePath, "substituted bytes");
    const calls: string[] = [];
    await withSuppliedArchive(created.archivePath, async () => {
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("never", calls),
      });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(0);
      expect(result.preparation.failure).toContain("rejected");
      expect(calls).toEqual([]);
    });
  });

  test("a stale supplied record is rejected before qualification", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    writeFileSync(join(base, "test", "consumer-a.test.ts"), "mutated after capture\n");
    const calls: string[] = [];
    await withSuppliedArchive(created.archivePath, async () => {
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("never", calls),
      });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(0);
      expect(result.preparation.failure).toContain("rejected");
      expect(calls).toEqual([]);
    });
  });
});

describe("prepared candidate provenance", () => {
  test("the prepared candidate carries an identity record created from source", async () => {
    // The candidate directory dies with the invocation, so the record is
    // observed at its live boundary: the consumer reads the record beside the
    // archive before its validated extraction, and the qualification is green
    // — extraction already proved the digest bound held.
    const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPackageArchive,
  obtainPackageArchive,
  supervisedInvocationActive,
} from ${JSON.stringify(seamImport("package-archive.js"))};
import { runProcess } from ${JSON.stringify(executorImport)};

test("consumer A executes the invocation candidate", async () => {
  const markers = ${JSON.stringify(join("${BASE}", "markers"))};
  if (!supervisedInvocationActive(process.env)) {
    throw new Error("expected the supervised-invocation marker");
  }
  const archive = await obtainPackageArchive("/unused/repository-root", "unused-");
  writeFileSync(join(markers, "record"), readFileSync(archive.path + ".provenance.json", "utf8"));
  const extracted = mkdtempSync(join(tmpdir(), "fixture-consumer-extracted-"));
  try {
    await extractPackageArchive(archive.path, extracted);
    const result = await runProcess({
      executable: "node",
      arguments_: [join(extracted, "package", "dist", "cli.js")],
      deadlineMs: 10_000,
      commandLabel: "candidate consumer",
    });
    const output = result.stdout;
    if (result.kind !== "exit" || result.exitCode !== 0 || !output.includes("CANDIDATE-CLI-MARKER")) {
      throw new Error(\`the consumer did not execute the invocation candidate: \${result.kind} \${output}\`);
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
});
` }]);
    const commands = realCandidateCommands("recorded", []);
    const result = await runFullCorpus(base, { packageCommands: commands });
    expect(result.ok).toBe(true);
    const record = JSON.parse(readFileSync(join(base, "markers", "record"), "utf8")) as {
      schema: number;
      archiveDigest: string;
      sourceFingerprint: string;
    };
    expect(record.schema).toBe(1);
    expect(record.archiveDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("source mutated between capture and pack disqualifies the candidate", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: consumerSource("consumer A", "a") },
      { path: PURE_FILE, body: pureSource("pure") },
    ]);
    const calls: string[] = [];
    const commands = realCandidateCommands("unstable", calls);
    const result = await runFullCorpus(base, {
      packageCommands: {
        ...commands,
        build: async (stage) => {
          await commands.build(stage);
          writeFileSync(join(base, PURE_FILE), "mutated during preparation\n");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.preparation.status).toBe("failed");
    expect(result.preparation.failure).toContain("unstable source");
    expect(existsSync(result.preparation.candidateDirectory!)).toBe(false);
  });
});

/**
 * Review-driven regressions (independent merge review at 1c9f9ad): the
 * admitted supplied identity is pinned through consumption, the supplied
 * gate shares the invocation's budget and signal with truthful lifecycle
 * evidence, and new Git/dist stages retain the #537 typed stage evidence.
 */

describe("supplied candidate admission pinning", () => {
  test("a candidate pair replaced after admission is not consumed: consumers execute the admitted bytes", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPackageArchive,
  obtainPackageArchive,
  supervisedInvocationActive,
} from ${JSON.stringify(seamImport("package-archive.js"))};
import {
  createPackageCandidate,
} from ${JSON.stringify(seamImport("package-identity.js"))};
import { runProcess } from ${JSON.stringify(executorImport)};

test("consumer A executes the invocation candidate", async () => {
  const markers = ${JSON.stringify(join("${BASE}", "markers"))};
  if (!supervisedInvocationActive(process.env)) {
    throw new Error("expected the supervised-invocation marker");
  }
  const archive = await obtainPackageArchive("/unused/repository-root", "unused-");
  writeFileSync(join(markers, "a-archive"), archive.path);
  writeFileSync(join(markers, "pinned-record"), readFileSync(archive.path + ".provenance.json", "utf8"));
  // After admission, replace the ENTIRE external candidate pair (archive and
  // its record) with a legitimately created source-B candidate: the shared
  // creator builds a real B archive whose bytes and record are self-consistent.
  const externalArchive = readFileSync(join(markers, "external"), "utf8");
  const bRoot = mkdtempSync(join(tmpdir(), "apkit-swap-b-dest-"));
  const staging = mkdtempSync(join(tmpdir(), "apkit-swap-b-staging-"));
  mkdirSync(join(staging, "package", "dist"), { recursive: true });
  writeFileSync(join(staging, "package", "dist", "cli.js"), 'console.log("CANDIDATE-CLI-MARKER-B");\\n');
  const b = await createPackageCandidate({
    repositoryRoot: process.cwd(),
    destinationDirectory: bRoot,
    deadlineMs: 30_000,
    signal: undefined,
    commands: {
      build: async () => {
        writeFileSync(join(staging, "package", "dist", "cli.js"), 'console.log("CANDIDATE-CLI-MARKER-B");\\n');
      },
      createScriptDisabledArchive: async (_stage, destination) => {
        const result = await runProcess({
          executable: "tar",
          arguments_: ["-czf", join(destination, "b.tgz"), "-C", staging, "package"],
          deadlineMs: 10_000,
          commandLabel: "fixture B pack",
        });
        if (!(result.kind === "exit" && result.exitCode === 0)) {
          throw new Error(\`fixture B pack failed: \${result.kind}\`);
        }
        return { filename: "b.tgz", files: ["dist/cli.js"] };
      },
    },
  });
  // Replace both external files after admission.
  writeFileSync(externalArchive, readFileSync(b.archivePath));
  writeFileSync(externalArchive + ".provenance.json", readFileSync(b.recordPath));
  writeFileSync(join(markers, "replaced"), "1");
  // The consumer must execute the admitted (pinned) bytes, never the
  // replacement pair.
  const extracted = mkdtempSync(join(tmpdir(), "fixture-consumer-extracted-"));
  try {
    await extractPackageArchive(archive.path, extracted);
    const result = await runProcess({
      executable: "node",
      arguments_: [join(extracted, "package", "dist", "cli.js")],
      deadlineMs: 10_000,
      commandLabel: "candidate consumer",
    });
    const output = result.stdout;
    writeFileSync(join(markers, "a-output"), output);
    if (!output.includes("CANDIDATE-CLI-MARKER-A") || output.includes("CANDIDATE-CLI-MARKER-B")) {
      throw new Error(\`the consumer executed a replacement candidate: \${output}\`);
    }
  } finally {
    rmSync(extracted, { recursive: true, force: true });
    rmSync(bRoot, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
  }
});
` }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-A"),
    });
    // The external archive path is known to the fixture before the invocation.
    writeFileSync(join(base, "markers", "external"), created.archivePath);
    const calls: string[] = [];
    await withSuppliedArchive(created.archivePath, async () => {
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("never", calls),
      });
      expect(result.ok, result.runs[0]?.result.stderr.slice(-800)).toBe(true);
      // The external pair really was replaced after admission: its digest no
      // longer matches the admitted record's artifact digest, yet the pinned
      // record (captured during the run) still binds the admitted bytes.
      expect(existsSync(join(base, "markers", "replaced"))).toBe(true);
      const pinnedRecord: PackageIdentityRecord = JSON.parse(
        readFileSync(join(base, "markers", "pinned-record"), "utf8"),
      ) as PackageIdentityRecord;
      expect(digestBytes(readFileSync(created.archivePath))).not.toBe(pinnedRecord.archiveDigest);
      // The consumer executed the admitted bytes.
      expect(readFileSync(join(base, "markers", "a-output"), "utf8")).toContain("CANDIDATE-CLI-MARKER-A");
    });
  });
});

describe("supplied validation lifecycle", () => {
  test("an aborted invocation classifies supplied validation as interrupted with truthful duration", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    const controller = new AbortController();
    controller.abort();
    await withSuppliedArchive(created.archivePath, async () => {
      const result = await runFullCorpus(base, {}, controller.signal);
      // The gate shares the invocation's signal: an aborted invocation cannot
      // wait out the validation children's fixed deadline.
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(0);
      expect(result.preparation.status).toBe("interrupted");
      expect(result.preparation.durationMs).toBeGreaterThan(0);
      expect(result.preparation.failure).toContain("interrupted");
    });
  }, 15_000);

  test("a failed Git capture stage retains the typed #537 evidence", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    // Make the dist removal stage unremovable: the typed stage error carries
    // the complete child result, and the evidence keeps its cleanup fields.
    const dist = join(base, "dist");
    mkdirSync(dist, { recursive: true });
    const flag = await runProcess({
      executable: "chflags", arguments_: ["uchg", dist], deadlineMs: 2000,
      commandLabel: "fixture chflags",
    });
    expect(flag.kind).toBe("exit");
    let recovered = false;
    try {
      const created = await createPackageCandidate({
        repositoryRoot: base,
        destinationDirectory: suppliedRoot,
        deadlineMs: 30_000,
        signal: undefined,
        commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
      });
      void created;
      throw new Error("expected the creator to fail on the unremovable dist stage");
    } catch (error) {
      expect(String(error)).toContain("build-output replacement");
      const stageError = error as { result?: { cleanupFailed?: boolean; stdout?: string; stderr?: string; kind?: string } };
      expect(stageError.result).toBeDefined();
      expect(stageError.result!.kind).toBeDefined();
      expect(typeof stageError.result!.stdout).toBe("string");
      // Cleanup evidence fields exist on the typed result.
      expect(stageError.result!.cleanupFailed).toBe(false);
    } finally {
      const recovery = await runProcess({
        executable: "chflags", arguments_: ["-R", "nouchg", dist], deadlineMs: 2000,
      });
      recovered = recovery.kind === "exit" && recovery.exitCode === 0;
    }
    expect(recovered).toBe(true);
  });
});

/**
 * Re-review regressions (independent review at 6dd95f1): admission work is
 * deducted from the first run's budget, Git captures settle sequentially
 * through one shared deadline, and a failed partial-pin cleanup retains its
 * owned path, cause, and duration in the zero-run evidence.
 */

describe("admission budget accounting", () => {
  test("admission duration is deducted from the first run's budget", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: `
import { test } from "bun:test";
test("consumer A executes the invocation candidate", async () => {
  await new Promise((resolve) => setTimeout(resolve, 1400));
});
` }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    // Every admission Git child sleeps 300ms: three sequential captures make
    // admission cost ~900ms of the 2000ms policy. The 1400ms child completes
    // inside a fresh perRun budget but outside the remaining share after
    // admission — with the deduction the run is bounded and incomplete,
    // without it the invocation overruns the policy and reports success.
    // (The run's recorded duration includes the executor's kill grace after
    // the deadline fires, so the bound is asserted against perRun, not
    // against the deducted share.)
    const shim = tempDir("apkit-admission-shim-");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(shim, "git"), `#!/bin/sh\nsleep 0.3\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(join(shim, "git"), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${shim}:${previousPath}`;
    try {
      await withSuppliedArchive(created.archivePath, async () => {
        const result = await runFullCorpus(base, { perRunDeadlineMs: 2000 });
        expect(result.ok).toBe(false);
        expect(result.attemptedRuns).toBe(1);
        expect(result.runs[0]!.result.kind).toBe("timeout");
        expect(result.runs[0]!.result.durationMs).toBeLessThan(2000);
        expect(result.preparation.durationMs).toBeGreaterThan(0);
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, 30_000);

  test("an invocation budget exhausted before validation fails the gate with zero runs", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    await withSuppliedArchive(created.archivePath, async () => {
      const result = await runFullCorpus(base, { perRunDeadlineMs: 5 });
      expect(result.ok).toBe(false);
      expect(result.attemptedRuns).toBe(0);
      expect(result.preparation.status).toBe("failed");
      const evidence = `${result.preparation.failure ?? ""} ${result.preparation.diagnostics ?? ""}`;
      expect(evidence).toMatch(/exhausted|source capture/);
    });
  }, 20_000);
});

describe("sequential bounded source capture", () => {
  function gitShim(
    directory: string,
    realGit: string,
    mode: "all" | "fail-second",
  ): string {
    mkdirSync(directory, { recursive: true });
    const script = mode === "all"
      ? `#!/bin/sh\nprintf 'x\\n' >> "${join(directory, "count")}"\nsleep 0.3\nexec ${JSON.stringify(realGit)} "$@"\n`
      : `#!/bin/sh\nprintf '%s\\n' "$$" >> "${join(directory, "count")}"\nif [ -f "${join(directory, "second")}" ]; then\n  sleep 0.4\n  echo INJECTED-GIT-FAILURE >&2\n  exit 1\nfi\ntouch "${join(directory, "second")}"\nexec ${JSON.stringify(realGit)} "$@"\n`;
    writeFileSync(join(directory, "git"), script);
    chmodSync(join(directory, "git"), 0o755);
    return directory;
  }

  test("capture children run sequentially inside one shared deadline and all settle before return", async () => {
    const root = fixtureCorpus([]);
    const shim = gitShim(tempDir("apkit-identity-shim-"), execFileSync("which", ["git"], { encoding: "utf8" }).trim(), "all");
    const previousPath = process.env.PATH;
    process.env.PATH = `${shim}:${previousPath}`;
    try {
      const startedAt = Date.now();
      const capture = await captureSourceFingerprint({ repositoryRoot: root, deadlineMs: 30_000, signal: undefined });
      const elapsed = Date.now() - startedAt;
      // One child at a time: three sequential Git children each slept 300ms.
      expect(readdirSync(shim).filter((entry) => entry === "count").length).toBe(1);
      expect(readFileSync(join(shim, "count"), "utf8").split("\n").filter((line) => line.length > 0)).toHaveLength(3);
      expect(capture.entryCount).toBeGreaterThan(0);
      expect(elapsed).toBeGreaterThanOrEqual(900);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, 20_000);

  test("a failing capture child settles before the capture returns and later children never start", async () => {
    const root = fixtureCorpus([]);
    const shim = gitShim(tempDir("apkit-identity-shim-"), execFileSync("which", ["git"], { encoding: "utf8" }).trim(), "fail-second");
    const previousPath = process.env.PATH;
    process.env.PATH = `${shim}:${previousPath}`;
    try {
      const startedAt = Date.now();
      await expect(
        captureSourceFingerprint({ repositoryRoot: root, deadlineMs: 30_000, signal: undefined }),
      ).rejects.toThrow(/source capture failed/);
      // The capture returned only after the failing child settled.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
      // The third child never started.
      const count = readFileSync(join(shim, "count"), "utf8").split("\n").filter((line) => line.length > 0);
      expect(count).toHaveLength(2);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, 20_000);
});

describe("partial-pin cleanup evidence", () => {
  test("a failed pin retains the owned path, cause, and cleanup duration in zero-run evidence", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    const pinCalls: string[] = [];
    // A controlled removal command fails the owned pin-directory cleanup.
    const shim = tempDir("apkit-pin-rm-shim-");
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, "rm"), "#!/bin/sh\necho INJECTED-CLEANUP-FAILURE >&2\nexit 7\n");
    execFileSync("chmod", ["+x", join(shim, "rm")]);
    const previousPath = process.env.PATH;
    process.env.PATH = `${shim}:${previousPath}`;
    let leftover = "";
    try {
      let result: SuiteSupervisorResult | undefined;
      await withSuppliedArchive(created.archivePath, async () => {
        result = await runFullCorpus(base, {
          packageCommands: realCandidateCommands("never", pinCalls),
          pinSuppliedCandidate: async () => {
            throw new Error("INJECTED-PIN-WRITE-FAILURE");
          },
        });
      });
      const completed = result!;
      expect(completed.ok).toBe(false);
      expect(completed.attemptedRuns).toBe(0);
      // The cleanup outcome is owning evidence, not defaults: truthful
      // duration, failure flag, cause, and the retained owned path.
      expect(completed.preparation.cleanupFailed).toBe(true);
      expect(completed.preparation.cleanupDurationMs).toBeGreaterThan(0);
      expect(completed.preparation.cleanupFailure).toContain("INJECTED-CLEANUP-FAILURE");
      expect(completed.preparation.cleanupFailure).toContain("agent-profile-kit-supplied-pinned-");
      // The zero-run summary and the retained preparation log carry the
      // cleanup cause and path, not only the original pin error.
      const summary = formatSuiteSummary(completed, null);
      expect(summary).toContain("INJECTED-PIN-WRITE-FAILURE");
      expect(summary).toContain("INJECTED-CLEANUP-FAILURE");
      const log = readFileSync(join(completed.logDir, PREPARATION_LOG_FILENAME), "utf8");
      expect(log).toContain("cleanupFailed: true");
      expect(log).toContain("INJECTED-CLEANUP-FAILURE");
      const pathMatch = log.match(/owned pin directory '([^']+)'/);
      expect(pathMatch).not.toBeNull();
      leftover = pathMatch![1]!;
      // Ownership is not cleared on failed removal: the path stays retained.
      expect(existsSync(leftover)).toBe(true);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      // The probe-owned leftover is removed after inspection.
      if (leftover !== "") rmSync(leftover, { recursive: true, force: true });
    }
  }, 20_000);

  test("delayed pin cleanup measures both outcomes without double-counting admission", async () => {
    for (const failCleanup of [true, false]) {
      const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
      const suppliedRoot = tempDir("apkit-supplied-");
      const created = await createPackageCandidate({
        repositoryRoot: base,
        destinationDirectory: suppliedRoot,
        deadlineMs: 30_000,
        signal: undefined,
        commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
      });
      // Every removal sleeps 200ms before succeeding or failing: a delayed
      // successful cleanup must report its real cost (never a zero default),
      // and the admission duration must exclude cleanup on both paths.
      const shim = tempDir("apkit-pin-rm-shim-");
      writeFileSync(
        join(shim, "rm"),
        `#!/bin/sh\n/bin/sleep 0.2\n${failCleanup ? "echo INJECTED-CLEANUP-FAILURE >&2\nexit 7\n" : 'exec /bin/rm "$@"\n'}`,
      );
      chmodSync(join(shim, "rm"), 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${shim}:${previousPath}`;
      let leftover = "";
      try {
        let result: SuiteSupervisorResult | undefined;
        await withSuppliedArchive(created.archivePath, async () => {
          result = await runFullCorpus(base, {
            perRunDeadlineMs: 2000,
            pinSuppliedCandidate: async (validation, directory) => {
              // A partial pin: owned bytes land before the failure.
              writeFileSync(join(directory, "partial.tgz"), validation.bytes);
              throw new Error("INJECTED-PIN-WRITE-FAILURE");
            },
          });
        });
        const completed = result!;
        expect(completed.ok).toBe(false);
        expect(completed.attemptedRuns).toBe(0);
        expect(completed.preparation.failure).toContain("INJECTED-PIN-WRITE-FAILURE");
        // The 200ms removal delay is reported on both outcomes.
        expect(completed.preparation.cleanupDurationMs).toBeGreaterThanOrEqual(150);
        // Non-overlap oracle: admission and cleanup partition the wall time,
        // so their sum cannot exceed the aggregate (plus timer granularity).
        expect(completed.preparation.durationMs + completed.preparation.cleanupDurationMs)
          .toBeLessThanOrEqual(completed.aggregateDurationMs + 10);
        if (failCleanup) {
          expect(completed.preparation.cleanupFailed).toBe(true);
          expect(completed.preparation.cleanupFailure).toContain("INJECTED-CLEANUP-FAILURE");
          const pathMatch = (completed.preparation.cleanupFailure ?? "").match(/owned pin directory '([^']+)'/);
          expect(pathMatch).not.toBeNull();
          leftover = pathMatch![1]!;
          expect(existsSync(leftover)).toBe(true);
        } else {
          expect(completed.preparation.cleanupFailed).toBe(false);
          expect(completed.preparation.cleanupFailure).toBeUndefined();
          expect(completed.preparation.candidateDirectory).toBeUndefined();
        }
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (leftover !== "") rmSync(leftover, { recursive: true, force: true });
      }
    }
  }, 60_000);
});


/**
 * Qualification records (#539): the supervisor projects one compact structured
 * record from its canonical outcome and the admitted identity — the
 * predecessor identity contract is the only provenance authority, the source
 * identity is fixed at admission (one authoritative snapshot per invocation,
 * including actual uncommitted worktree bytes for no-candidate invocations),
 * and a candidate is admitted only when its own identity record reconciles
 * with the admission snapshot.
 */
describe("qualification records: admitted identity", () => {
  const recordPath = (base: string): string => join(base, "logs", QUALIFICATION_RECORD_FILENAME);

  test("the record consumes the prepared candidate's retained identity record", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: recordConsumerSource("consumer A", "a") },
    ]);
    const commands = realCandidateCommands("recorded", []);
    const result = await runFullCorpus(base, { packageCommands: commands });
    expect(result.ok).toBe(true);
    const prepared: PackageIdentityRecord = JSON.parse(
      readFileSync(join(base, "markers", "a-record"), "utf8"),
    ) as PackageIdentityRecord;
    const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
      schema: number;
      source: { kind: string; repositoryHead: string | null; sourceFingerprint: string; reconciliation?: string; archiveDigest?: string };
      artifact?: { archivePath: string; archiveDigest: string };
    };
    expect(record.schema).toBe(QUALIFICATION_RECORD_SCHEMA);
    // The candidate's identity record is consumed, not recomputed or relabeled;
    // the source identity carries only source facts — the digest lives on the
    // artifact alone.
    expect(record.source.kind).toBe("candidate-record");
    expect(record.source.sourceFingerprint).toBe(prepared.sourceFingerprint);
    expect(record.source.repositoryHead).toBe(prepared.repositoryHead);
    expect(record.source.reconciliation).toBe("record-equals-admission-capture");
    expect(record.source).not.toHaveProperty("archiveDigest");
    expect(record.artifact!.archiveDigest).toBe(prepared.archiveDigest);
    expect(record.artifact!.archivePath).toBe(readFileSync(join(base, "markers", "a-archive"), "utf8"));
  });

  test("a supplied candidate's validated record is the retained admitted authority", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: recordConsumerSource("consumer A", "a") },
    ]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    await withSuppliedArchive(created.archivePath, async () => {
      const calls: string[] = [];
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("never", calls),
      });
      expect(result.ok).toBe(true);
      expect(result.preparation.status).toBe("supplied");
      const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
        source: { kind: string; sourceFingerprint: string; reconciliation?: string };
        artifact?: { archivePath: string; archiveDigest: string };
      };
      // The validated record was reconciled against a fresh admission capture
      // of the consuming checkout; the pinned record is what is projected.
      expect(record.source.kind).toBe("candidate-record");
      expect(record.source.sourceFingerprint).toBe(created.record.sourceFingerprint);
      expect(record.source.reconciliation).toBe("record-validated-against-admission-capture");
      expect(record.source).not.toHaveProperty("archiveDigest");
      expect(record.artifact!.archiveDigest).toBe(created.record.archiveDigest);
      expect(record.artifact!.archivePath).toBe(readFileSync(join(base, "markers", "a-archive"), "utf8"));
    });
  });

  test("a pure focused invocation captures its source identity at admission without preparation", async () => {
    const base = fixtureCorpus([{ path: PURE_FILE, body: pureSource("pure-focused-record") }]);
    const result = await runSupervisedSuite({
      mode: "focused",
      cwd: base,
      bunArguments: ["test/pure.test.ts"],
      perRunDeadlineMs: 30_000,
      logDir: join(base, "logs"),
    });
    expect(result.ok).toBe(true);
    const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
      source: { kind: string; sourceFingerprint: string; entryCount: number; repositoryHead: string | null };
      preparation: { status: string; requests: number };
      artifact?: unknown;
      runtime: { packedCli?: unknown; suiteRunner: { kind: string; version: string; executable: string } };
      ok: boolean;
      status: string;
    };
    // No candidate: the admission capture is the source identity, preparation
    // never happened, and no packed runtime is claimed.
    expect(record.source.kind).toBe("admitted-source");
    expect(record.source.entryCount).toBeGreaterThan(0);
    expect(record.preparation).toMatchObject({ status: "none", requests: 0 });
    expect(record.artifact).toBeUndefined();
    expect(record.runtime.packedCli).toBeUndefined();
    expect(record.ok).toBe(true);
    expect(record.status).toBe("complete");
    // The record names the runtime that actually executed the suite: the
    // canonical pinned Bun at the supervisor's own executable.
    expect(record.runtime.suiteRunner).toEqual({
      kind: "pinned-bun",
      version: pinnedBunVersion(),
      executable: process.execPath,
    });
    // The admission snapshot stays the source identity: the unchanged source
    // fingerprints identically after the run.
    const after = await captureSourceFingerprint({ repositoryRoot: base, deadlineMs: 10_000, signal: undefined });
    expect(record.source.sourceFingerprint).toBe(after.digest);
  });

  test("the record's source identity covers actual uncommitted worktree bytes", async () => {
    const base = fixtureCorpus([{ path: PURE_FILE, body: pureSource("uncommitted") }]);
    const runFocused = async (): Promise<{ fingerprint: string }> => {
      const result = await runSupervisedSuite({
        mode: "focused",
        cwd: base,
        bunArguments: ["test/pure.test.ts"],
        perRunDeadlineMs: 30_000,
        logDir: join(base, "logs"),
      });
      expect(result.ok).toBe(true);
      const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
        source: { sourceFingerprint: string };
      };
      return { fingerprint: record.source.sourceFingerprint };
    };
    const before = await runFocused();
    // One actual uncommitted byte change is part of the admitted identity.
    appendFileSync(join(base, "test", "pure.test.ts"), "// uncommitted edit\n");
    const after = await runFocused();
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test("source changed after admission is rejected before consumers execute", async () => {
    const base = fixtureCorpus([
      {
        path: CONSUMER_A,
        body: `
import { appendFileSync, writeFileSync } from "node:fs";
import { obtainPackageArchive, supervisedInvocationActive } from ${JSON.stringify(seamImport("package-archive.js"))};

test("mutating consumer requests the candidate", async () => {
  const markers = ${JSON.stringify(join("${BASE}", "markers"))};
  if (!supervisedInvocationActive(process.env)) {
    throw new Error("expected the supervised-invocation marker");
  }
  // Mutate tracked source after the invocation's admission capture and before
  // filing the request: the lazy preparation must reject the candidate built
  // from the changed source instead of attributing it to the admitted one.
  appendFileSync(${JSON.stringify(join("${BASE}", "test", "pure.test.ts"))}, "// changed after admission\\n");
  const archive = await obtainPackageArchive("/unused/repository-root", "unused-");
  writeFileSync(join(markers, "a-archive"), archive.path);
});
`,
      },
      { path: PURE_FILE, body: pureSource("pure") },
    ]);
    const before = await captureSourceFingerprint({ repositoryRoot: base, deadlineMs: 10_000, signal: undefined });
    const calls: string[] = [];
    const commands = realCandidateCommands("changed", calls);
    const result = await runFullCorpus(base, { packageCommands: commands });
    expect(result.ok).toBe(false);
    // The preparation was rejected with both digests in the cause.
    expect(result.preparation.status).toBe("failed");
    expect(result.preparation.failure).toContain("differs from the invocation's admitted source identity");
    expect(result.preparation.failure).toContain(before.digest.slice(0, 12));
    // No candidate was admitted: the record's source stays the admission
    // snapshot and no artifact digest is attributed.
    const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
      source: { kind: string; sourceFingerprint: string };
      artifact?: unknown;
      status: string;
      ok: boolean;
    };
    expect(record.source.kind).toBe("admitted-source");
    expect(record.source.sourceFingerprint).toBe(before.digest);
    expect(record.artifact).toBeUndefined();
    expect(record.ok).toBe(false);
    expect(record.status).toBe("incomplete");
  });

  test("an injected probe observation is recorded at the candidate admission boundary", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: consumerSource("consumer A", "a") },
    ]);
    const commands = realCandidateCommands("probed", []);
    const result = await runFullCorpus(base, {
      packageCommands: commands,
      packedRuntimeProbe: async (context) => {
        expect(context.executable).toBe(packedCliNodeExecutable());
        return { kind: "probe", executable: context.executable, version: "v9.9.9-fixture" };
      },
    });
    expect(result.ok).toBe(true);
    const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
      runtime: { packedCli?: { kind: string; executable: string; version: string } };
    };
    expect(record.runtime.packedCli).toEqual({
      kind: "probe",
      executable: packedCliNodeExecutable(),
      version: "v9.9.9-fixture",
    });
  });

  test("an unavailable packed runtime observation keeps outcomes but fails qualification", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: consumerSource("consumer A", "a") },
    ]);
    const commands = realCandidateCommands("unobserved", []);
    const result = await runFullCorpus(base, {
      packageCommands: commands,
      packedRuntimeProbe: async (context) => ({
        kind: "unavailable",
        executable: context.executable,
        cause: "fixture probe failure",
      }),
    });
    // The consumer actually executed and the run outcome is retained; the
    // owed runtime evidence is unavailable, so qualification is not complete.
    expect(readFileSync(join(base, "markers", "a-output"), "utf8")).toContain("CANDIDATE-CLI-MARKER-unobserved");
    expect(result.ok).toBe(false);
    expect(result.runs[0]!.result.kind).toBe("exit");
    if (result.runs[0]!.result.kind === "exit") {
      expect(result.runs[0]!.result.exitCode).toBe(0);
    }
    const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
      status: string;
      ok: boolean;
      reason?: string;
      runtime: { packedCli?: { kind: string; cause: string } };
      runs: unknown[];
    };
    expect(record.runtime.packedCli!.kind).toBe("unavailable");
    expect(record.runtime.packedCli!.cause).toContain("fixture probe failure");
    expect(record.status).toBe("incomplete");
    expect(record.ok).toBe(false);
    expect(record.reason).toContain("packed CLI runtime");
    expect(record.runs).toHaveLength(1);
  });

  test("an exhausted budget before admission fails the capture with zero runs", async () => {
    const base = fixtureCorpus([{ path: PURE_FILE, body: pureSource("budget") }]);
    const result = await runSupervisedSuite({
      mode: "full",
      cwd: base,
      perRunDeadlineMs: 1,
      logDir: join(base, "logs"),
    });
    expect(result.ok).toBe(false);
    expect(result.attemptedRuns).toBe(0);
    const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
      status: string;
      ok: boolean;
      reason?: string;
      source: { kind: string; cause: string };
      preparation: { status: string };
    };
    expect(record.status).toBe("incomplete");
    expect(record.ok).toBe(false);
    // The bounded capture consumed the invocation's whole budget (no fresh
    // floor): the cause names the exhausted stage, whether the budget check
    // or the bounded git child hit it first.
    expect(record.reason).toMatch(/budget exhausted|source capture failed/);
    // The capture failure stops unqualified execution: no runs, explicit cause.
    expect(record.source.kind).toBe("unavailable");
    expect(record.source.cause).toMatch(/budget exhausted|source capture failed/);
    expect(record.preparation.status).toBe("none");
  });

  test("a pre-aborted canonical invocation records unavailable source with its cause", async () => {
    const base = fixtureCorpus([{ path: PURE_FILE, body: pureSource("pre-abort") }]);
    const controller = new AbortController();
    controller.abort();
    const result = await runSupervisedSuite(
      { mode: "full", cwd: base, perRunDeadlineMs: 30_000, logDir: join(base, "logs") },
      controller.signal,
    );
    expect(result.interrupted).toBe(true);
    expect(result.attemptedRuns).toBe(0);
    const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
      status: string;
      source: { kind: string; cause: string };
    };
    expect(record.status).toBe("interrupted");
    expect(record.source.kind).toBe("unavailable");
    expect(record.source.cause).toContain("aborted");
  });
});

/** One more consumer variant: it also records its delivered request-wait budget. */
const waitingConsumerSource = (name: string, markerName: string): string => `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { obtainPackageArchive, supervisedInvocationActive } from ${JSON.stringify(seamImport("package-archive.js"))};
import { PACKAGE_REQUEST_WAIT_ENV } from ${JSON.stringify(seamImport("package-request-channel.js"))};

test("${name} executes the invocation candidate", async () => {
  const markers = ${JSON.stringify(join("${BASE}", "markers"))};
  if (!supervisedInvocationActive(process.env)) {
    throw new Error("expected the supervised-invocation marker");
  }
  writeFileSync(join(markers, "${markerName}-wait"), process.env[PACKAGE_REQUEST_WAIT_ENV] ?? "missing");
  const archive = await obtainPackageArchive("/unused/repository-root", "unused-");
  writeFileSync(join(markers, "${markerName}-archive"), archive.path);
});
`;

describe("qualification records: admission budget and capture failures", () => {
  const recordPath = (base: string): string => join(base, "logs", QUALIFICATION_RECORD_FILENAME);

  test("the admission capture is deducted from the first run's budget", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: waitingConsumerSource("consumer A", "a") },
    ]);
    // Every admission Git child sleeps 150ms: the three sequential capture
    // children make admission cost ~500ms of the 3000ms policy, so the first
    // run's delivered budget must be visibly smaller than the policy — the
    // existing supplied-path deduction, extended to the admission capture.
    const shim = tempDir("apkit-capture-shim-");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(shim, "git"), `#!/bin/sh\nsleep 0.15\nexec ${JSON.stringify(realGit)} "$@"\n`);
    chmodSync(join(shim, "git"), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${shim}:${previousPath}`;
    try {
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("deducted", []),
        perRunDeadlineMs: 3000,
      });
      expect(
        result.ok,
        JSON.stringify({
          kind: result.runs[0]?.result.kind,
          exit: result.runs[0]?.result.kind === "exit" ? result.runs[0].result.exitCode : null,
          timedOut: result.runs[0]?.result.timedOut,
          preparation: result.preparation.status,
          failure: result.preparation.failure,
          stderr: (result.runs[0]?.result.stderr ?? "").slice(-500),
        }),
      ).toBe(true);
      const wait = Number(readFileSync(join(base, "markers", "a-wait"), "utf8"));
      // The child received the per-run budget minus admission (including the
      // capture): visibly below the 3000ms policy by more than the three
      // shimmed captures could ever take, and above the exhausted floor.
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(3000);
      expect(wait).toBeLessThan(2600);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }, 30_000);

  test("a failed source capture stops unqualified execution with zero runs", async () => {
    const base = fixtureCorpus([{ path: PURE_FILE, body: pureSource("capture-fail") }]);
    // A malformed .git gitfile makes every Git child fail outside the
    // unborn-HEAD allowance: the identity contract cannot capture, so no run
    // may start.
    rmSync(join(base, ".git"), { recursive: true, force: true });
    writeFileSync(join(base, ".git"), "gitdir: /nonexistent\n");
    const result = await runSupervisedSuite({
      mode: "full",
      cwd: base,
      perRunDeadlineMs: 30_000,
      logDir: join(base, "logs"),
    });
    expect(result.ok).toBe(false);
    expect(result.attemptedRuns).toBe(0);
    const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
      status: string;
      ok: boolean;
      source: { kind: string; cause: string };
    };
    expect(record.status).toBe("incomplete");
    expect(record.ok).toBe(false);
    expect(record.source.kind).toBe("unavailable");
    expect(record.source.cause).toContain("source capture");
  });

  test("a seam invocation with a supplied archive claims no packed runtime", async () => {
    const base = fixtureCorpus([{ path: PURE_FILE, body: pureSource("seam-supplied") }]);
    const suppliedRoot = tempDir("apkit-supplied-");
    const created = await createPackageCandidate({
      repositoryRoot: base,
      destinationDirectory: suppliedRoot,
      deadlineMs: 30_000,
      signal: undefined,
      commands: suppliedCreatorCommands(base, "CANDIDATE-CLI-MARKER-supplied"),
    });
    await withSuppliedArchive(created.archivePath, async () => {
      const result = await runSupervisedSuite({
        mode: "full",
        cwd: base,
        suiteCommand: ["sh", "-c", "exit 0", "seam"],
        perRunDeadlineMs: 30_000,
        logDir: join(base, "logs"),
      });
      expect(result.ok).toBe(true);
      const record = JSON.parse(readFileSync(recordPath(base), "utf8")) as {
        runtime: { packedCli?: unknown; suiteRunner: { kind: string } };
        source: { kind: string; reconciliation?: string };
      };
      // The validated record is still the retained admitted authority, but a
      // seam invocation that never runs the packed CLI claims no packed
      // runtime.
      expect(record.source.kind).toBe("candidate-record");
      expect(record.source.reconciliation).toBe("record-validated-against-admission-capture");
      expect(record.runtime.packedCli).toBeUndefined();
      expect(record.runtime.suiteRunner.kind).toBe("injected-fixture");
    });
  });
});
