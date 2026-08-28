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

  test("a stale contribution transaction swaps only its installation entries and preserves unrelated bytes", async () => {
    const repository = gitRepository();
    const exclude = join(repository, ".git", "info", "exclude");
    const authored = "# authored exclusion\n";
    writeFileSync(
      exclude,
      Buffer.from(
        `${authored}` +
        "# BEGIN Agent Profile Kit generated paths\n" +
        "/.agent-profile-kit/codex/context.md\n" +
        "/.codex/hooks.json\n" +
        "/stale-generated\n" +
        "# END Agent Profile Kit generated paths\n",
      ),
    );
    const staged: OwnershipState = {
      ...installationState(repository),
      receipts: installationState(repository).receipts.map((receipt) => ({
        ...receipt,
        repositoryExclusion: {
          entries: ["/.agent-profile-kit/codex/context.md", "/.codex/hooks.json", "/stale-generated"],
          target: receipt.repositoryExclusion!.target,
        },
      })),
    };
    const corrected: OwnershipState = {
      ...staged,
      receipts: staged.receipts.map((receipt) => ({
        ...receipt,
        repositoryExclusion: {
          entries: [
            "/.agent-profile-kit/codex/context.md",
            "/.agent-profile-kit/installation.json",
            "/.codex/hooks.json",
          ],
          target: receipt.repositoryExclusion!.target,
        },
      })),
    };

    const transaction = await stageGitExclusions(staged, corrected);

    expect(readFileSync(exclude, "utf8")).toContain("/stale-generated");
    await transaction.commit();
    const committed = readFileSync(exclude, "utf8");
    expect(committed).not.toContain("/stale-generated");
    expect(committed).toContain("/.codex/hooks.json");
    expect(committed).toContain("/.agent-profile-kit/codex/context.md");
    expect(committed.startsWith(authored)).toBe(true);

    await transaction.rollback();
    expect(readFileSync(exclude, "utf8")).toContain("/stale-generated");
  });
});
