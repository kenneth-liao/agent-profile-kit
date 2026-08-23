import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageGitExclusions } from "../installer/git-exclusions.js";
import type { OwnershipState } from "../schemas/ownership-state.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function gitRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "agent-profile-kit-exclusion-stage-"));
  temporaryDirectories.push(repository);
  execFileSync("git", ["init", "-q", repository]);
  return realpathSync(repository);
}

function installationState(project: string): OwnershipState {
  const hash = `sha256:${"0".repeat(64)}`;
  const target = join(project, ".git", "info", "exclude");
  return {
    receipts: [{
      desiredInputDigest: hash,
      hosts: {
        codex: { adapterVersion: "test-adapter", capabilityContract: "test-host" },
      },
      installationId: "test-installation",
      lifetime: "ordinary",
      outputs: [{ hash, mode: 0o644, path: ".codex/hooks.json", type: "file" }],
      profileId: "coding",
      project,
      repositoryExclusion: { entries: ["/.codex/hooks.json"], target },
    }],
    removedTemporaryInstallationIds: [],
    schemaVersion: 6,
  };
}

describe("Git exclusion transaction", () => {
  test("staging is read-only and commit publishes the derived receipt union", async () => {
    const repository = gitRepository();
    const exclude = join(repository, ".git", "info", "exclude");
    const authored = Buffer.from("# authored exclusion\n");
    writeFileSync(exclude, authored);
    const empty: OwnershipState = {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: 6,
    };

    const transaction = await stageGitExclusions(empty, installationState(repository));

    expect(readFileSync(exclude).equals(authored)).toBe(true);
    await transaction.commit();
    expect(readFileSync(exclude, "utf8")).toContain("/.codex/hooks.json");
    await transaction.rollback();
    expect(readFileSync(exclude).equals(authored)).toBe(true);
  });
});
