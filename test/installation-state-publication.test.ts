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
  readTemporaryInstallations,
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
    schemaVersion: 7,
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

  test("returns empty state when neither current nor retired state exists", async () => {
    expect(await readInstallationState(isolatedHome())).toEqual(emptyInstallationState());
  });

  test("rejects legacy YAML after the migration window closes", async () => {
    const home = isolatedHome();
    const legacyPath = join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml");
    mkdirSync(join(legacyPath, ".."), { recursive: true });
    writeFileSync(legacyPath, "schema_version: 5\n");

    await expect(readInstallationState(home)).rejects.toThrow(
      /legacy YAML Installation State.*migration window is closed.*0\.95\.0.*never reconstructs ownership from generated output/i,
    );
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(stateManifestPath(home))).toBe(false);
  });

  test("rejects a leftover YAML source even when strict JSON also exists", async () => {
    const home = isolatedHome();
    await writeInstallationState(home, stateWithAdapterVersion("current"));
    const legacyPath = join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml");
    writeFileSync(legacyPath, "schema_version: 5\n");

    await expect(readInstallationState(home)).rejects.toThrow(/migration window is closed/i);
    expect(parseOwnershipState(readFileSync(stateManifestPath(home), "utf8"))).toEqual(
      stateWithAdapterVersion("current"),
    );
  });

  test("rejects legacy YAML from read-only temporary inventory", async () => {
    const home = isolatedHome();
    const legacyPath = join(home, ".agents", "agent-profile-kit", "state", "manifest.yaml");
    mkdirSync(join(legacyPath, ".."), { recursive: true });
    writeFileSync(legacyPath, "schema_version: 5\n");

    await expect(readTemporaryInstallations(home)).rejects.toThrow(
      /legacy YAML Installation State.*migration window is closed.*0\.95\.0.*never reconstructs ownership from generated output/i,
    );
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
