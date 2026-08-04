import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageGitExclusions } from "../installer/git-exclusions.js";
import type { InstallationState } from "../schemas/installation-manifest.js";

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

function installationState(project: string): InstallationState {
  const hash = `sha256:${"0".repeat(64)}`;
  return {
    intendedTeardowns: [],
    installations: [{
      adapterVersion: "test-adapter",
      engineVersion: "test-engine",
      hosts: ["codex"],
      hostVersions: { codex: "test-host" },
      installationId: "test-installation",
      outputs: [{
        hash,
        mode: 0o644,
        path: ".agent-profile-kit/installation.json",
        type: "file",
      }],
      profileId: "coding",
      project,
      resolvedArtifacts: [],
      schemaVersion: 2,
      selectedContext: [],
      workspaceInputHash: hash,
    }],
    repositoryExclusions: [{
      target: join(project, ".git", "info", "exclude"),
      contributions: [{
        installationId: "test-installation",
        entries: ["/.agent-profile-kit/installation.json"],
      }],
      entries: ["/.agent-profile-kit/installation.json"],
    }],
    temporaryInstallations: [],
    schemaVersion: 5,
  };
}

describe("Git exclusion transaction", () => {
  test("staging is read-only and commit publishes the planned exclusion bytes", async () => {
    const repository = gitRepository();
    const exclude = join(repository, ".git", "info", "exclude");
    const authored = Buffer.from("# authored exclusion\n");
    writeFileSync(exclude, authored);
    const empty: InstallationState = {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 5,
      temporaryInstallations: [],
    };

    const transaction = await stageGitExclusions(empty, installationState(repository));

    expect(readFileSync(exclude).equals(authored)).toBe(true);

    await transaction.commit();

    expect(readFileSync(exclude, "utf8")).toContain("/.agent-profile-kit/installation.json");

    await transaction.rollback();

    expect(readFileSync(exclude).equals(authored)).toBe(true);
  });
});
