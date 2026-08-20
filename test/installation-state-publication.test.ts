import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INSTALLATION_STATE_MAX_BYTES,
  type InstallationState,
} from "../schemas/installation-manifest.js";
import {
  emptyInstallationState,
  writeInstallationState,
} from "../installer/installation-state.js";
import { stateManifestPath } from "../installer/project-plan.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-state-publication-"));
  temporaryDirectories.push(home);
  return home;
}

const hash = `sha256:${"0".repeat(64)}`;

function stateWithEngineVersion(engineVersion: string): InstallationState {
  return {
    ...emptyInstallationState(),
    installations: [{
      adapterVersion: "test-adapter",
      engineVersion,
      hosts: ["codex"],
      hostVersions: { codex: "test-host" },
      installationId: "install-a",
      outputs: [{
        hash,
        mode: 0o644,
        path: ".agent-profile-kit/installation.json",
        type: "file",
      }],
      profileId: "coding",
      project: "/repo/a",
      resolvedArtifacts: [],
      schemaVersion: 3,
      selectedContext: [],
      workspaceInputHash: hash,
    }],
  };
}

describe("Installation State publication", () => {
  test("keeps prior state when exact serialized bytes exceed production reader bounds", async () => {
    const home = isolatedHome();
    await writeInstallationState(home, stateWithEngineVersion("current"));
    const before = readFileSync(stateManifestPath(home), "utf8");

    await expect(writeInstallationState(
      home,
      stateWithEngineVersion("x".repeat(INSTALLATION_STATE_MAX_BYTES)),
    )).rejects.toThrow(/exceeds the .* byte limit/);

    expect(readFileSync(stateManifestPath(home), "utf8")).toBe(before);
  });
});
