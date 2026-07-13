import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertRealDirectoryPath } from "../installer/git.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe("Git metadata directory boundary", () => {
  test("a canonical ancestor replaced by a symlink fails the reusable pre-write proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-profile-kit-git-boundary-"));
    const external = mkdtempSync(join(tmpdir(), "agent-profile-kit-git-boundary-external-"));
    temporaryDirectories.push(root, external);
    const ancestor = join(realpathSync(root), "repository");
    const common = join(ancestor, ".git");
    mkdirSync(common, { recursive: true });
    await expect(assertRealDirectoryPath(common, "Git common directory")).resolves.toBeUndefined();
    renameSync(ancestor, join(root, "original-repository"));
    symlinkSync(external, ancestor);

    await expect(assertRealDirectoryPath(common, "Git common directory"))
      .rejects.toThrow("non-directory or symlink component");
  });
});
