import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OWNERSHIP_STATE_LIMITS,
  parseOwnershipState,
  type OwnershipState,
} from "../schemas/ownership-state.js";
import {
  emptyInstallationState,
  readInstallationState,
  writeInstallationState,
} from "../installer/installation-state.js";
import { legacyStateManifestPath, stateManifestPath } from "../installer/project-plan.js";
import {
  formatInstallationState,
  type InstallationState,
} from "../schemas/installation-manifest.js";

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

function stateWithAdapterVersion(adapterVersion: string): OwnershipState {
  return {
    receipts: [{
      desiredInputDigest: hash,
      hosts: {
        codex: {
          adapterVersion,
          capabilityContract: "test-host",
        },
      },
      installationId: "install-a",
      lifetime: "ordinary",
      outputs: [{
        hash,
        mode: 0o644,
        path: ".codex/hooks.json",
        type: "file",
      }],
      profileId: "coding",
      project: "/repo/a",
    }],
    removedTemporaryInstallationIds: [],
    schemaVersion: 6,
  };
}

describe("Installation State publication", () => {
  test("publishes canonical JSON that the production reader accepts exactly", async () => {
    const home = isolatedHome();
    const state = stateWithAdapterVersion("test-adapter");

    await writeInstallationState(home, state);

    const path = stateManifestPath(home);
    expect(path.endsWith("/manifest.json")).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source.startsWith("{\n")).toBe(true);
    expect(parseOwnershipState(source)).toEqual(state);
    expect(await readInstallationState(home)).toEqual(state);
    expect(existsSync(join(path, "..", "manifest.yaml"))).toBe(false);
  });

  test("retires supported YAML only after publishing production-readable JSON", async () => {
    const home = isolatedHome();
    const legacy: InstallationState = {
      intendedTeardowns: [],
      installations: [{
        adapterVersion: "codex-project-v3",
        engineVersion: "0.94.1",
        hosts: ["codex"],
        hostVersions: { codex: "test-host" },
        installationId: "install-a",
        outputs: [{
          hash,
          mode: 0o644,
          path: ".agent-profile-kit/installation.json",
          type: "file",
        }, {
          hash,
          mode: 0o644,
          path: ".codex/hooks.json",
          type: "file",
        }],
        profileId: "coding",
        project: "/repo/a",
        resolvedArtifacts: [],
        schemaVersion: 3,
        selectedContext: [],
        workspaceInputHash: hash,
      }],
      repositoryExclusions: [],
      schemaVersion: 5,
      temporaryInstallations: [],
    };
    const legacyPath = legacyStateManifestPath(home);
    mkdirSync(join(legacyPath, ".."), { recursive: true });
    writeFileSync(legacyPath, formatInstallationState(legacy));

    const loaded = await readInstallationState(home);
    expect(loaded.receipts[0]?.outputs.map((output) => output.path)).toEqual([
      ".codex/hooks.json",
    ]);
    await writeInstallationState(home, loaded);

    expect(parseOwnershipState(readFileSync(stateManifestPath(home), "utf8"))).toEqual(loaded);
    expect(existsSync(legacyPath)).toBe(false);
  });

  test("keeps prior state when exact serialized bytes exceed production reader bounds", async () => {
    const home = isolatedHome();
    await writeInstallationState(home, stateWithAdapterVersion("current"));
    const before = readFileSync(stateManifestPath(home), "utf8");

    await expect(writeInstallationState(
      home,
      stateWithAdapterVersion("x".repeat(OWNERSHIP_STATE_LIMITS.maxBytes)),
    )).rejects.toThrow(/exceeds the .* byte limit/);

    expect(readFileSync(stateManifestPath(home), "utf8")).toBe(before);
  });
});
