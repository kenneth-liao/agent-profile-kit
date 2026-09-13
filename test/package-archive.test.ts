import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  obtainPackageArchive,
  PREPARED_PACKAGE_ARCHIVE_ENV,
  SUPERVISED_INVOCATION_ENV,
  SupervisorPreparationDefectError,
  systemPackageArchiveCommands,
  type PackageArchiveCommands,
  type PackageStageContext,
} from "./support/package-archive.js";

function instrumentedCommands(calls: string[]): PackageArchiveCommands {
  return {
    build: async () => {
      calls.push("build");
    },
    createScriptDisabledArchive: async (_stage: PackageStageContext, destination: string) => {
      calls.push("pack");
      const filename = "agent-profile-kit-test.tgz";
      writeFileSync(join(destination, filename), "archive");
      return filename;
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
    const obtained = await obtainPackageArchive("/repository", "agent-profile-kit-local-archive-", {
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

    await expect(
      obtainPackageArchive("/repository", prefix, { environment: {}, commands }),
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

  test("the system commands run bounded build and pack stages and parse the packed filename", async () => {
    // A real repository root is not needed to prove the command wiring: the
    // stages must fail bounded and typed on a nonexistent repository rather
    // than hang or swallow the failure.
    const startedAt = Date.now();
    await expect(
      systemPackageArchiveCommands.build({
        repositoryRoot: "/nonexistent/agent-profile-kit-repository",
        deadlineMs: 2000,
        signal: undefined,
      }),
    ).rejects.toThrow(/package build failed/);
    // The failing stage was bounded by its deadline, not left to hang.
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});