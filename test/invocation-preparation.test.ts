import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProcess } from "../process/process-executor.js";
import {
  extractPackageArchive,
  obtainPackageArchive,
  PREPARED_PACKAGE_ARCHIVE_ENV,
  SUPERVISED_INVOCATION_ENV,
  type PackageArchiveCommands,
} from "./support/package-archive.js";
import {
  PREPARATION_LOG_FILENAME,
  runSupervisedSuite,
  type SuiteSupervisorResult,
} from "./support/suite-supervisor.js";

/**
 * Real-runner proofs for invocation-owned package preparation (TEST-002's real
 * immutable-candidate consumer path): every test drives the real supervisor's
 * default command (the real pinned Bun executable) over a tiny isolated corpus
 * with injected preparation commands that produce a REAL tarball, and asserts
 * behavior through side-effect markers, the preparation evidence, and the
 * retained run log — never by inspecting constructed argv or source text.
 * Unit-level need derivation lives in test/invocation-candidate.test.ts.
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
const PURE_FILE = "test/pure.test.ts";
const FLEET_CONSUMER = "test/fleet-consumer.test.ts";

/**
 * The consumer fixture: it declares the consumer capability through the marker
 * module (absolute import, as a fixture corpus file would), asserts the
 * supervised marker, extracts the archive it was given, launches Node against
 * the candidate's CLI, and records the received archive path and the CLI's own
 * output. A candidate whose CLI does not print the marker (for example an
 * unrelated repository bundle) fails this consumer.
 */
const consumerSource = (name: string, markerName: string): string => `
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ${JSON.stringify(seamImport("invocation-package-consumer.js"))};
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
 * The fleet consumer fixture: the canonical fleet launch entry resolves its
 * executable through the consumer boundary and executes it under Node. The
 * fixture root may carry a deliberately different or absent dist — neither can
 * be executed, because the launch path has no repository-bundle reference.
 */
const fleetConsumerSource = (markerName: string): string => `
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ${JSON.stringify(seamImport("invocation-package-consumer.js"))};
import { runFleetCli, releaseFleetCliPath } from ${JSON.stringify(join(REPOSITORY_ROOT, "test", "support", "fleet-cli.js"))};

test("fleet launches execute the invocation candidate", async () => {
  const markers = ${JSON.stringify(join("${BASE}", "markers"))};
  const home = mkdtempSync(join(tmpdir(), "fixture-fleet-home-"));
  try {
    const result = await runFleetCli(home, process.env.PATH ?? "", ["status", "--all"]);
    writeFileSync(join(markers, "${markerName}-output"), result.stdout);
    if (result.kind !== "exit" || result.exitCode !== 0 || !result.stdout.includes("CANDIDATE-CLI-MARKER")) {
      throw new Error(\`the fleet launch did not execute the invocation candidate: \${result.kind} \${result.stdout}\`);
    }
  } finally {
    await releaseFleetCliPath();
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
  for (const file of corpus) {
    writeFileSync(join(base, file.path), file.body.replaceAll("${BASE}", base));
  }
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
      return "candidate.tgz";
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

describe("invocation preparation: real supervisor, real runner, one candidate", () => {
  test("two consumers share one prepared candidate built and packed exactly once", async () => {
    const base = fixtureCorpus([
      { path: CONSUMER_A, body: consumerSource("consumer A", "a") },
      { path: "test/consumer-b.test.ts", body: consumerSource("consumer B", "b") },
    ]);
    const calls: string[] = [];
    const commands = realCandidateCommands("shared", calls);
    const result = await runFullCorpus(base, { packageCommands: commands });
    expect(result.ok).toBe(true);
    // Preparation is bounded, derived, and recorded with its shared budget.
    expect(result.preparation.need).toBe("package");
    expect(result.preparation.status).toBe("prepared");
    expect(result.preparation.durationMs).toBeGreaterThan(0);
    expect(result.preparation.cleanupFailed).toBe(false);
    // Exactly one build and one pack; the pack's remaining budget share is
    // bounded by the build's measured consumption because the stages share
    // one finite budget (the injected build sleeps at least 25ms).
    expect(calls.filter((call) => call.startsWith("build:"))).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith("pack:"))).toHaveLength(1);
    const buildShare = Number(calls.find((call) => call.startsWith("build:"))!.split(":")[1]);
    const packShare = Number(calls.find((call) => call.startsWith("pack:"))!.split(":")[1]);
    expect(buildShare).toBe(30_000);
    expect(packShare).toBeGreaterThan(0);
    expect(packShare).toBeLessThanOrEqual(30_000 - 25);
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
    // The retained run log carries the preparation evidence and its reason.
    const log = readFileSync(result.runs[0]!.logPath, "utf8");
    expect(log).toContain("preparation: need=package status=prepared");
    expect(log).toContain(`archive=${result.preparation.archivePath}`);
    expect(log).toContain("declaring the invocation-package consumer capability");
    expect(log).toMatch(/preparation-cleanup: durationMs=\d+ failed=false/);
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
    }
  });

  test("a failed preparation fails the invocation before any run and retains diagnostics", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const commands: PackageArchiveCommands = {
      build: async () => {
        throw new Error("fixture build failed");
      },
      createScriptDisabledArchive: async () => {
        throw new Error("pack must never run after a failed build");
      },
    };
    const result = await runFullCorpus(base, { packageCommands: commands });
    expect(result.ok).toBe(false);
    expect(result.attemptedRuns).toBe(0);
    expect(result.preparation.status).toBe("failed");
    expect(result.preparation.failure).toContain("fixture build failed");
    expect(result.preparation.candidateDirectory).toBeDefined();
    // The candidate directory the failed preparation owned was cleaned.
    expect(existsSync(result.preparation.candidateDirectory!)).toBe(false);
    const preparationLog = readFileSync(join(result.logDir, PREPARATION_LOG_FILENAME), "utf8");
    expect(preparationLog).toContain("status: failed");
    expect(preparationLog).toContain("fixture build failed");
    // No run log exists: nothing ran after the failed preparation.
    expect(existsSync(join(result.logDir, "run-1.log"))).toBe(false);
  });

  test("an operator-supplied archive passes through untouched with zero preparation", async () => {
    const suppliedRoot = tempDir("apkit-supplied-");
    const suppliedArchive = join(suppliedRoot, "operator.tgz");
    // A real tarball so the consumer can extract and execute it.
    mkdirSync(join(suppliedRoot, "package", "dist"), { recursive: true });
    writeFileSync(
      join(suppliedRoot, "package", "dist", "cli.js"),
      'console.log("CANDIDATE-CLI-MARKER-supplied");\n',
    );
    const packed = await runProcess({
      executable: "tar",
      arguments_: ["-czf", join(suppliedRoot, "operator.tgz"), "-C", suppliedRoot, "package"],
      deadlineMs: 10_000,
      commandLabel: "supplied fixture pack",
    });
    expect(packed.kind).toBe("exit");

    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const calls: string[] = [];
    const previousArchive = process.env[PREPARED_PACKAGE_ARCHIVE_ENV];
    const previousMarker = process.env[SUPERVISED_INVOCATION_ENV];
    process.env[PREPARED_PACKAGE_ARCHIVE_ENV] = suppliedArchive;
    // A top-level operator invocation runs outside any supervised parent, so
    // the nested-invocation marker must be absent for this invocation.
    delete process.env[SUPERVISED_INVOCATION_ENV];
    try {
      const result = await runFullCorpus(base, {
        packageCommands: realCandidateCommands("never", calls),
      });
      expect(result.ok).toBe(true);
      expect(result.preparation.status).toBe("supplied");
      expect(result.preparation.durationMs).toBe(0);
      expect(result.preparation.archivePath).toBe(realpathSync(suppliedArchive));
      expect(calls).toEqual([]);
      // The operator's archive bytes were never rewritten or removed.
      expect(existsSync(suppliedArchive)).toBe(true);
      expect(readFileSync(join(base, "markers", "a-output"), "utf8")).toContain(
        "CANDIDATE-CLI-MARKER-supplied",
      );
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

  test("an abort during preparation is interrupted with the candidate cleaned and no runs", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
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
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();
    const result = await runFullCorpus(
      base,
      { packageCommands: commands },
      controller.signal,
    );
    expect(result.ok).toBe(false);
    expect(result.interrupted).toBe(true);
    expect(result.attemptedRuns).toBe(0);
    expect(result.preparation.status).toBe("interrupted");
    // The abort signal actually reached the build stage: the stage recorded
    // receiving the signal and the invocation did not wait out the fallback.
    expect(calls).toContain("build:30000:signal");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(existsSync(result.preparation.candidateDirectory!)).toBe(false);
    expect(existsSync(join(result.logDir, PREPARATION_LOG_FILENAME))).toBe(true);
  });

  test("an undeclared consumer fails closed instead of building", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    // The consumer file executes in the corpus but declares no capability, so
    // the invocation derives no need, injects no archive, and the supervised
    // consumer must fail loudly with the typed remedy instead of building.
    const undeclaredSource = consumerSource("consumer A", "a").replace(
      seamImport("invocation-package-consumer.js"),
      seamImport("package-archive.js"),
    );
    writeFileSync(join(base, CONSUMER_A), undeclaredSource.replaceAll("${BASE}", base));
    const calls: string[] = [];
    const result = await runFullCorpus(base, {
      packageCommands: realCandidateCommands("never", calls),
    });
    expect(result.ok).toBe(false);
    expect(result.attemptedRuns).toBe(1);
    expect(result.preparation.status).toBe("none");
    expect(calls).toEqual([]);
    expect(result.runs[0]!.result.stderr).toContain("SupervisorPreparationDefectError");
  });

  test("a pure name-filter selection never builds and runs green", async () => {
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
    // The selection's scope is unknowable, so nothing is prepared: the pure
    // filter run completes without any build or pack, and the limit is stated
    // in the retained evidence rather than silently.
    expect(result.ok).toBe(true);
    expect(result.preparation.need).toBe("none");
    expect(result.preparation.status).toBe("none");
    expect(calls).toEqual([]);
    expect(existsSync(join(base, "markers", "pure-selection-runs"))).toBe(true);
    expect(existsSync(join(base, "markers", "a-archive"))).toBe(false);
    const log = readFileSync(result.runs[0]!.logPath, "utf8");
    expect(log).toContain("selection scope cannot be proven");
  });

  test("a consumer-reaching name-filter selection fails closed instead of building", async () => {
    const base = fixtureCorpus([{ path: CONSUMER_A, body: consumerSource("consumer A", "a") }]);
    const calls: string[] = [];
    const result = await runSupervisedSuite({
      mode: "focused",
      bunArguments: ["-t", "consumer A"],
      cwd: base,
      perRunDeadlineMs: 30_000,
      logDir: join(base, "logs"),
      packageCommands: realCandidateCommands("never", calls),
    });
    expect(result.ok).toBe(false);
    expect(result.preparation.status).toBe("none");
    expect(calls).toEqual([]);
    expect(result.runs[0]!.result.stderr).toContain("SupervisorPreparationDefectError");
  });

  test("a flag-only focused selection executes the whole corpus and prepares", async () => {
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
    // so the consumers run and preparation is owed — a provable need, stated
    // truthfully in the evidence.
    expect(result.ok).toBe(true);
    expect(result.preparation.status).toBe("prepared");
    expect(calls.filter((call) => call.startsWith("build:"))).toHaveLength(1);
    expect(readFileSync(join(base, "markers", "a-output"), "utf8")).toContain(
      "CANDIDATE-CLI-MARKER-flagonly",
    );
  });

  test("pure focused selections of consumer-seam and policy tests never prepare", async () => {
    const calls: string[] = [];
    const commands = realCandidateCommands("never", calls);
    const result = await runSupervisedSuite({
      mode: "focused",
      bunArguments: [
        "test/package-archive.test.ts",
        "test/invocation-candidate.test.ts",
        "test/fleet-cli-policy.test.ts",
      ],
      perRunDeadlineMs: 120_000,
      logDir: tempDir("apkit-invocation-logs-"),
      packageCommands: commands,
    });
    expect(result.ok).toBe(true);
    expect(result.preparation.need).toBe("none");
    expect(result.preparation.status).toBe("none");
    expect(calls).toEqual([]);
  });
});
