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
    schemaVersion: 7,
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
      schemaVersion: 7,
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

  test("a moved contribution transaction removes its recorded entries at the old target and publishes the derived union at the new target", async () => {
    const oldRepository = gitRepository();
    const newRepository = gitRepository();
    const oldExclude = join(oldRepository, ".git", "info", "exclude");
    const newExclude = join(newRepository, ".git", "info", "exclude");
    const oldAuthored = "# authored old exclusion\n";
    const newAuthored = "# authored new exclusion\n";
    writeFileSync(
      oldExclude,
      Buffer.from(
        `${oldAuthored}` +
        "# BEGIN Agent Profile Kit generated paths\n" +
        "/.agent-profile-kit/installation.json\n" +
        "/.codex/hooks.json\n" +
        "/legacy-owned-entry\n" +
        "/other/kept-entry\n" +
        "# END Agent Profile Kit generated paths\n",
      ),
    );
    writeFileSync(newExclude, Buffer.from(newAuthored));
    const hash = `sha256:${"0".repeat(64)}`;
    const baseReceipt = {
      desiredInputDigest: hash,
      hosts: {
        codex: { adapterVersion: "test-adapter", capabilityContract: "test-host" },
      },
      installationId: "moved-installation",
      lifetime: "ordinary" as const,
      outputs: [{ hash, mode: 0o644, path: ".codex/hooks.json", type: "file" as const }],
      profileId: "coding",
    };
    const otherReceipt = {
      ...baseReceipt,
      installationId: "other-installation",
      project: join(oldRepository, "other-project"),
      repositoryExclusion: {
        entries: ["/other/kept-entry"],
        target: oldExclude,
      },
    };
    const newTargetNeighborReceipt = {
      ...baseReceipt,
      installationId: "new-target-neighbor",
      project: join(newRepository, "neighbor-project"),
      repositoryExclusion: {
        entries: ["/neighbor/kept-entry"],
        target: newExclude,
      },
    };
    const before: OwnershipState = {
      receipts: [
        otherReceipt,
        newTargetNeighborReceipt,
        {
          ...baseReceipt,
          project: newRepository,
          repositoryExclusion: {
            entries: ["/.agent-profile-kit/installation.json", "/.codex/hooks.json", "/legacy-owned-entry"],
            target: oldExclude,
          },
        },
      ],
      removedTemporaryInstallationIds: [],
      schemaVersion: 7,
    };
    const after: OwnershipState = {
      ...before,
      receipts: before.receipts.map((receipt) =>
        receipt.installationId === "moved-installation"
          ? {
              ...receipt,
              repositoryExclusion: {
                entries: ["/.agent-profile-kit/installation.json", "/.codex/hooks.json"],
                target: newExclude,
              },
            }
          : receipt,
      ),
    };

    // The new target already carries another contributor's recorded union.
    writeFileSync(
      newExclude,
      Buffer.from(
        `${newAuthored}` +
        "# BEGIN Agent Profile Kit generated paths\n" +
        "/neighbor/kept-entry\n" +
        "# END Agent Profile Kit generated paths\n",
      ),
    );

    const transaction = await stageGitExclusions(before, after);

    expect(readFileSync(oldExclude, "utf8")).toContain("/legacy-owned-entry");
    expect(readFileSync(newExclude, "utf8")).not.toContain("/.codex/hooks.json");
    await transaction.commit();
    const committedOld = readFileSync(oldExclude, "utf8");
    expect(committedOld).not.toContain("/legacy-owned-entry");
    expect(committedOld).not.toContain("/.agent-profile-kit/installation.json");
    expect(committedOld).not.toContain("/.codex/hooks.json");
    expect(committedOld).toContain("/other/kept-entry");
    expect(committedOld.startsWith(oldAuthored)).toBe(true);
    const committedNew = readFileSync(newExclude, "utf8");
    expect(committedNew.startsWith(newAuthored)).toBe(true);
    expect(committedNew).toContain("/.agent-profile-kit/installation.json");
    expect(committedNew).toContain("/.codex/hooks.json");
    expect(committedNew).toContain("/neighbor/kept-entry");

    await transaction.rollback();
    expect(readFileSync(oldExclude, "utf8")).toContain("/legacy-owned-entry");
    expect(readFileSync(newExclude, "utf8")).toContain("/neighbor/kept-entry");
    expect(readFileSync(newExclude, "utf8")).not.toContain("/.codex/hooks.json");
  });

  test("a same-Project target move never treats unrecorded new-target bytes as its staged current state", async () => {
    const oldRepository = gitRepository();
    const newRepository = gitRepository();
    const oldExclude = join(oldRepository, ".git", "info", "exclude");
    const newExclude = join(newRepository, ".git", "info", "exclude");
    const hash = `sha256:${"0".repeat(64)}`;
    const receipt = {
      desiredInputDigest: hash,
      hosts: {
        codex: { adapterVersion: "test-adapter", capabilityContract: "test-host" },
      },
      installationId: "moved-installation",
      lifetime: "ordinary" as const,
      outputs: [{ hash, mode: 0o644, path: ".codex/hooks.json", type: "file" as const }],
      profileId: "coding",
      project: newRepository,
      repositoryExclusion: {
        entries: ["/.codex/hooks.json"],
        target: oldExclude,
      },
    };
    const before: OwnershipState = {
      receipts: [receipt],
      removedTemporaryInstallationIds: [],
      schemaVersion: 7,
    };
    const after: OwnershipState = {
      ...before,
      receipts: [{
        ...receipt,
        repositoryExclusion: {
          entries: ["/.agent-profile-kit/installation.json", "/.codex/hooks.json"],
          target: newExclude,
        },
      }],
    };
    // Bytes that match the desired union but that no receipt records at the
    // new target are unprovable; the transaction must reject them instead of
    // silently adopting them as staged current state.
    writeFileSync(
      newExclude,
      Buffer.from(
        "# BEGIN Agent Profile Kit generated paths\n" +
          "/.agent-profile-kit/installation.json\n" +
          "/.codex/hooks.json\n" +
          "# END Agent Profile Kit generated paths\n",
      ),
    );

    await expect(stageGitExclusions(before, after)).rejects.toThrow(
      "Agent Profile Kit exclusion section is modified",
    );
  });

  test("a whole-Project relocation still validates the moved exclusion file at its new target", async () => {
    const oldRepository = gitRepository();
    const newRepository = gitRepository();
    const oldExclude = join(oldRepository, ".git", "info", "exclude");
    const newExclude = join(newRepository, ".git", "info", "exclude");
    const oldAuthored = "# authored old exclusion\n";
    writeFileSync(
      oldExclude,
      Buffer.from(
        `${oldAuthored}` +
        "# BEGIN Agent Profile Kit generated paths\n" +
        "/.codex/hooks.json\n" +
        "# END Agent Profile Kit generated paths\n",
      ),
    );
    // The whole repository moved with the Project, so the new target's file
    // physically carries the recorded section.
    writeFileSync(
      newExclude,
      Buffer.from(
        "# BEGIN Agent Profile Kit generated paths\n" +
          "/.codex/hooks.json\n" +
          "# END Agent Profile Kit generated paths\n",
      ),
    );
    const hash = `sha256:${"0".repeat(64)}`;
    const receipt = {
      desiredInputDigest: hash,
      hosts: {
        codex: { adapterVersion: "test-adapter", capabilityContract: "test-host" },
      },
      installationId: "relocated-installation",
      lifetime: "ordinary" as const,
      outputs: [{ hash, mode: 0o644, path: ".codex/hooks.json", type: "file" as const }],
      profileId: "coding",
    };
    const before: OwnershipState = {
      receipts: [{ ...receipt, project: oldRepository, repositoryExclusion: { entries: ["/.codex/hooks.json"], target: oldExclude } }],
      removedTemporaryInstallationIds: [],
      schemaVersion: 7,
    };
    const after: OwnershipState = {
      ...before,
      receipts: [{ ...receipt, project: newRepository, repositoryExclusion: { entries: ["/.codex/hooks.json"], target: newExclude } }],
    };

    const transaction = await stageGitExclusions(before, after);

    await transaction.commit();
    expect(readFileSync(oldExclude, "utf8")).toBe(oldAuthored);
    expect(readFileSync(newExclude, "utf8")).toContain("/.codex/hooks.json");

    await transaction.rollback();
    expect(readFileSync(oldExclude, "utf8")).toContain("/.codex/hooks.json");
    expect(readFileSync(newExclude, "utf8")).toContain("/.codex/hooks.json");
  });
});
