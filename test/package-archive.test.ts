import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureProductionBundle,
  obtainPackageArchive,
  PREPARED_PACKAGE_ARCHIVE_ENV,
  type PackageArchiveCommands,
} from "./support/package-archive.js";

function instrumentedCommands(calls: string[]): PackageArchiveCommands {
  return {
    build: () => calls.push("build"),
    createScriptDisabledArchive: (_repositoryRoot, destination) => {
      calls.push("pack");
      const filename = "agent-profile-kit-test.tgz";
      writeFileSync(join(destination, filename), "archive");
      return filename;
    },
  };
}

test("a prepared package archive causes no build or pack calls", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-profile-kit-prepared-archive-"));
  const archive = join(root, "prepared.tgz");
  writeFileSync(archive, "prepared");
  const calls: string[] = [];
  const options = {
    environment: { [PREPARED_PACKAGE_ARCHIVE_ENV]: archive },
    commands: instrumentedCommands(calls),
  };

  try {
    ensureProductionBundle(root, options);
    const obtained = obtainPackageArchive(root, "unused-", options);

    expect(obtained.path).toBe(realpathSync(archive));
    expect(calls).toEqual([]);
    obtained.cleanup();
    expect(existsSync(archive)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the local fallback performs one safe build followed by one script-disabled pack", () => {
  const calls: string[] = [];
  const obtained = obtainPackageArchive("/repository", "agent-profile-kit-local-archive-", {
    environment: {},
    commands: instrumentedCommands(calls),
  });

  expect(calls).toEqual(["build", "pack"]);
  expect(existsSync(obtained.path)).toBe(true);
  obtained.cleanup();
  expect(existsSync(obtained.path)).toBe(false);
});
