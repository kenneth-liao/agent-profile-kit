import { execFileSync } from "node:child_process";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packageIdentityRecordPath } from "./support/package-identity.js";
import {
  extractPackageArchive,
  obtainPackageArchive,
  PREPARED_PACKAGE_ARCHIVE_ENV,
  SUPERVISED_INVOCATION_ENV,
  SupervisorPreparationDefectError,
  systemPackageArchiveCommands,
  type PackageArchiveCommands,
  type PackageStageContext,
} from "./support/package-archive.js";
import { runProcess } from "../process/process-executor.js";

/** Pack the staged package into one real tarball through the bounded executor. */
function runPackStage(destination: string, staging: string) {
  return runProcess({
    executable: "tar",
    arguments_: ["-czf", join(destination, "agent-profile-kit-test.tgz"), "-C", staging, "package"],
    deadlineMs: 10_000,
    commandLabel: "fixture pack",
  });
}

/**
 * A real Git repository fixture root with the ignored build-output boundary:
 * the from-source candidate creator captures fingerprints and replaces the
 * ignored build output here, so fallback tests exercise the real boundary.
 */
function fixtureRepository(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-profile-kit-fixture", version: "0.0.0-fixture" }));
  writeFileSync(join(root, "src.txt"), "source\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

/**
 * Deterministic commands whose product is a real tarball (the packed-input
 * guard lists the actual archive content, so an injected pack must pack
 * reality): the build writes one fresh dist bundle; the pack produces the
 * tarball through the shared bounded executor.
 */
function instrumentedCommands(calls: string[]): PackageArchiveCommands {
  const staging = mkdtempSync(join(tmpdir(), "agent-profile-kit-pack-staging-"));
  return {
    build: async () => {
      calls.push("build");
      mkdirSync(join(staging, "package", "dist"), { recursive: true });
      writeFileSync(join(staging, "package", "dist", "cli.js"), 'console.log("FIXTURE-CLI");\n');
    },
    createScriptDisabledArchive: async (_stage: PackageStageContext, destination: string) => {
      calls.push("pack");
      const result = await runPackStage(destination, staging);
      if (result.kind !== "exit" || result.exitCode !== 0) {
        throw new Error(`fixture pack failed: ${result.kind}`);
      }
      return { filename: "agent-profile-kit-test.tgz", files: ["dist/cli.js"] };
    },
  };
}

function directoriesWithPrefix(prefix: string): readonly string[] {
  return readdirSync(tmpdir())
    .filter((entry) => entry.startsWith(prefix))
    .map((entry) => join(tmpdir(), entry));
}

describe("package archive consumer seam", () => {
  test("a prepared package archive causes no build or pack calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-profile-kit-prepared-archive-"));
    const archive = join(root, "prepared.tgz");
    writeFileSync(archive, "prepared");
    const calls: string[] = [];
    const options = {
      environment: { [PREPARED_PACKAGE_ARCHIVE_ENV]: archive },
      commands: instrumentedCommands(calls),
    };

    try {
      const obtained = await obtainPackageArchive(root, "unused-", options);

      expect(obtained.path).toBe(realpathSync(archive));
      expect(calls).toEqual([]);
      obtained.cleanup();
      expect(existsSync(archive)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the local fallback performs one safe build followed by one script-disabled pack", async () => {
    const calls: string[] = [];
    const root = fixtureRepository("agent-profile-kit-fallback-repo-");
    const obtained = await obtainPackageArchive(root, "agent-profile-kit-local-archive-", {
      environment: {},
      commands: instrumentedCommands(calls),
    });

    expect(calls).toEqual(["build", "pack"]);
    expect(existsSync(obtained.path)).toBe(true);
    obtained.cleanup();
    expect(existsSync(obtained.path)).toBe(false);
  });

  test("a failing fallback build leaves no package directory behind", async () => {
    const prefix = "agent-profile-kit-failing-fallback-";
    const before = new Set(directoriesWithPrefix(prefix));
    const commands: PackageArchiveCommands = {
      build: async () => {
        throw new Error("fixture build failed");
      },
      createScriptDisabledArchive: async () => {
        throw new Error("pack must never run after a failed build");
      },
    };

    const root = fixtureRepository("agent-profile-kit-fallback-repo-");
    await expect(
      obtainPackageArchive(root, prefix, { environment: {}, commands }),
    ).rejects.toThrow("fixture build failed");
    expect(directoriesWithPrefix(prefix).filter((path) => !before.has(path))).toEqual([]);
  });

  test("a supervised invocation without a prepared archive fails closed instead of building", async () => {
    const calls: string[] = [];
    await expect(
      obtainPackageArchive("/repository", "agent-profile-kit-tripwire-", {
        environment: { [SUPERVISED_INVOCATION_ENV]: "1" },
        commands: instrumentedCommands(calls),
      }),
    ).rejects.toBeInstanceOf(SupervisorPreparationDefectError);
    // The typed failure names the supervisor defect; no build ran to hide it.
    expect(calls).toEqual([]);
  });

  test("a supervised marker with a prepared archive passes the archive through untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-profile-kit-supervised-supplied-"));
    const archive = join(root, "prepared.tgz");
    writeFileSync(archive, "prepared");
    const calls: string[] = [];
    try {
      const obtained = await obtainPackageArchive(root, "unused-", {
        environment: { [SUPERVISED_INVOCATION_ENV]: "1", [PREPARED_PACKAGE_ARCHIVE_ENV]: archive },
        commands: instrumentedCommands(calls),
      });
      expect(obtained.path).toBe(realpathSync(archive));
      expect(calls).toEqual([]);
      obtained.cleanup();
      expect(existsSync(archive)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the system build stage runs bounded and fails typed on an unreachable repository", async () => {
    // A real repository root is not needed to prove the command wiring: the
    // stage must fail bounded and typed on a nonexistent repository rather
    // than hang or swallow the failure. The pack stage and filename parsing
    // have their own proof below.
    const startedAt = Date.now();
    await expect(
      systemPackageArchiveCommands.build({
        repositoryRoot: "/nonexistent/agent-profile-kit-repository",
        deadlineMs: 2000,
        signal: undefined,
      }),
    ).rejects.toThrow(/package preparation build failed/);
    // The failing stage was bounded by its deadline, not left to hang.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });

  test("the system pack stage runs bounded and returns the packed filename", async () => {
    // A real tarball through the real pack stage: a staged directory with a
    // minimal package is packed through the shared bounded executor and the
    // JSON filename is parsed back.
    const staging = mkdtempSync(join(tmpdir(), "apkit-pack-stage-"));
    const destination = mkdtempSync(join(tmpdir(), "apkit-pack-dest-"));
    try {
      mkdirSync(join(staging, "package", "dist"), { recursive: true });
      writeFileSync(
        join(staging, "package", "package.json"),
        JSON.stringify({ name: "agent-profile-kit-scan-fixture", version: "0.0.0-scan" }),
      );
      const packed = await systemPackageArchiveCommands.createScriptDisabledArchive(
        { repositoryRoot: join(staging, "package"), deadlineMs: 10_000, signal: undefined },
        destination,
      );
      expect(existsSync(join(destination, packed.filename))).toBe(true);
      expect(packed.filename.startsWith("agent-profile-kit-scan-fixture-")).toBe(true);
      // The system pack reports the files it packed; the guard consumes this
      // list rather than archive text.
      expect(packed.files).toContain("package.json");
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
    }
  });
});

describe("validated extraction boundary", () => {
  test("a candidate archive substituted after its record was written is rejected at extraction", async () => {
    const root = fixtureRepository("agent-profile-kit-extraction-repo-");
    const destination = mkdtempSync(join(tmpdir(), "agent-profile-kit-extraction-dest-"));
    const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-extraction-out-"));
    try {
      mkdirSync(join(root, "dist"), { recursive: true });
      const { createPackageCandidate } = await import("./support/package-identity.js");
      const created = await createPackageCandidate({
        repositoryRoot: root,
        destinationDirectory: destination,
        deadlineMs: 30_000,
        signal: undefined,
        commands: instrumentedCommands([]),
      });
      await extractPackageArchive(created.archivePath, extracted);
      expect(existsSync(join(extracted, "package", "dist", "cli.js"))).toBe(true);
      // Substitution after the record was written: the extraction boundary
      // digests the bytes it reads and rejects the mismatch before any
      // consumer can execute different bytes than the record describes.
      writeFileSync(created.archivePath, "substituted after validation");
      await expect(
        extractPackageArchive(created.archivePath, extracted),
      ).rejects.toThrow(/substituted or replaced/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(destination, { recursive: true, force: true });
      rmSync(extracted, { recursive: true, force: true });
    }
  });

  test("extraction without a record fails closed", async () => {
    const root = fixtureRepository("agent-profile-kit-recordless-");
    const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-recordless-out-"));
    try {
      // A real tarball whose record is absent: extraction must fail closed.
      mkdirSync(join(root, "package"), { recursive: true });
      writeFileSync(join(root, "package", "cli.js"), 'console.log("X");\n');
      const staged = join(root, "recordless.tgz");
      const packed = await runPackStage(root, root);
      expect(packed.kind).toBe("exit");
      execFileSync("mv", [join(root, "agent-profile-kit-test.tgz"), staged]);
      expect(existsSync(packageIdentityRecordPath(staged))).toBe(false);
      await expect(
        extractPackageArchive(staged, extracted),
      ).rejects.toThrow(/no package identity record/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(extracted, { recursive: true, force: true });
    }
  });
});
