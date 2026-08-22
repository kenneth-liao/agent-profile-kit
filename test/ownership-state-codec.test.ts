import { describe, expect, test } from "bun:test";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  OWNERSHIP_STATE_LIMITS,
  formatOwnershipState,
  parseOwnershipState,
  type OwnershipState,
} from "../schemas/ownership-state.js";
import { normalizeLegacyOwnershipState } from "../installer/ownership-state-normalization.js";
import {
  formatInstallationState,
  parseInstallationState,
  parseLegacyInstallationState,
  parsePreviousInstallationState,
  parseV4InstallationState,
  type InstallationState,
} from "../schemas/installation-manifest.js";

const hash = `sha256:${"0".repeat(64)}`;

function ordinaryState(): OwnershipState {
  return {
    receipts: [{
      desiredInputDigest: hash,
      hosts: {
        codex: {
          adapterVersion: "codex-project-v3",
          capabilityContract: "native-project-sessionstart-complete-context-v1",
        },
      },
      installationId: "installation-a",
      lifetime: "ordinary",
      outputs: [{
        hash,
        mode: 0o644,
        path: ".codex/hooks.json",
        type: "file",
      }],
      profileId: "engineering",
      project: "/projects/a",
      repositoryExclusion: {
        entries: ["/.codex/hooks.json"],
        target: "/projects/a/.git/info/exclude",
      },
    }],
    removedTemporaryInstallationIds: [],
    schemaVersion: 6,
  };
}

describe("final JSON ownership-state codec", () => {
  test("serializes one ordinary receipt and parses the exact bytes deterministically", () => {
    const source = formatOwnershipState(ordinaryState());

    expect(source.startsWith("{\n")).toBe(true);
    expect(source).toContain('"schema_version": 6');
    expect(source).toContain('"desired_input_digest"');
    expect(parseOwnershipState(source)).toEqual(ordinaryState());
    expect(formatOwnershipState(parseOwnershipState(source))).toBe(source);
  });

  test("canonicalizes receipt, Host, output, exclusion, and tombstone ordering", () => {
    const state = ordinaryState();
    const second = {
      ...state.receipts[0]!,
      hosts: {
        pi: { adapterVersion: "pi-project-v2", capabilityContract: "pi-contract" },
        claude: { adapterVersion: "claude-project-v1", capabilityContract: "claude-contract" },
      },
      installationId: "installation-b",
      outputs: [
        { hash, mode: 0o644, path: "z-output", type: "file" as const },
        { hash, mode: 0o644, path: "a-output", type: "file" as const },
      ],
      project: "/projects/b",
      repositoryExclusion: {
        entries: ["/z-output", "/a-output"],
        target: "/projects/b/.git/info/exclude",
      },
    };
    const source = formatOwnershipState({
      receipts: [second, state.receipts[0]!],
      removedTemporaryInstallationIds: ["removed-z", "removed-a"],
      schemaVersion: 6,
    });
    const parsed = parseOwnershipState(source);

    expect(parsed.receipts.map((receipt) => receipt.installationId)).toEqual([
      "installation-a",
      "installation-b",
    ]);
    expect(Object.keys(parsed.receipts[1]!.hosts)).toEqual(["claude", "pi"]);
    const unordered = JSON.parse(source);
    unordered.receipts[1].hosts = {
      pi: unordered.receipts[1].hosts.pi,
      claude: unordered.receipts[1].hosts.claude,
    };
    expect(Object.keys(parseOwnershipState(JSON.stringify(unordered)).receipts[1]!.hosts)).toEqual([
      "claude",
      "pi",
    ]);
    expect(parsed.receipts[1]!.outputs.map((output) => output.path)).toEqual(["a-output", "z-output"]);
    expect(parsed.receipts[1]!.repositoryExclusion?.entries).toEqual(["/a-output", "/z-output"]);
    expect(parsed.removedTemporaryInstallationIds).toEqual(["removed-a", "removed-z"]);
    expect(formatOwnershipState(parsed)).toBe(source);
  });

  test("rejects unknown and missing fields at every ownership-state level", () => {
    const value = JSON.parse(formatOwnershipState(ordinaryState()));
    value.receipts[0].outputs[0].members = [];
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/does not allow fields: members/);

    delete value.receipts[0].outputs[0].members;
    delete value.receipts[0].hosts.codex.capability_contract;
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/requires field 'capability_contract'/);

    const duplicateField = formatOwnershipState(ordinaryState()).replace(
      '      "installation_id": "installation-a",',
      '      "installation_id": "first",\n      "installation_id": "installation-a",',
    );
    expect(() => parseOwnershipState(duplicateField)).toThrow(/field 'installation_id' more than once/);
  });

  test("rejects duplicate active, removed, Project, and output identities", () => {
    const value = JSON.parse(formatOwnershipState(ordinaryState()));
    value.receipts.push({ ...value.receipts[0], project: "/projects/b" });
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/Installation ID more than once/);

    value.receipts[1].installation_id = "installation-b";
    value.receipts[1].project = "/projects/a";
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/active Project more than once/);

    value.receipts.pop();
    value.receipts[0].outputs.push({ ...value.receipts[0].outputs[0] });
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/output.*path more than once/);

    value.receipts[0].outputs.pop();
    value.removed_temporary_installation_ids = ["installation-a"];
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/active and removed Installation IDs/);
  });

  test("rejects lifecycle metadata, overlapping roots, and malformed ownership facts", () => {
    const value = JSON.parse(formatOwnershipState(ordinaryState()));
    value.receipts[0].outputs[0].path = ".agent-profile-kit/installation.json";
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/Installation Marker.*not a generated output/);

    value.receipts[0].outputs = [{
      hash,
      mode: 0o755,
      path: ".agents/skills",
      type: "directory",
    }, {
      hash,
      mode: 0o755,
      path: ".agents/skills/review",
      type: "directory",
    }];
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/overlapping output roots/);

    value.receipts[0].outputs = [{ hash: "sha256:nope", mode: 0o644, path: "../escape", type: "file" }];
    expect(() => parseOwnershipState(JSON.stringify(value))).toThrow(/SHA-256|safe relative Project path/);
  });

  test("normalizes every supported legacy YAML schema to one minimal receipt", () => {
    const legacy: InstallationState = {
      intendedTeardowns: [],
      installations: [{
        adapterVersion: "claude-project-v1+codex-project-v3",
        engineVersion: "0.94.0",
        hosts: ["claude", "codex"],
        hostVersions: {
          claude: "native-project-unscoped-rules-v1",
          codex: "native-project-sessionstart-complete-context-v1",
        },
        installationId: "installation-a",
        outputOrigins: {
          ".agent-profile-kit/installation.json": [],
          ".agents/skills/review": [{ id: "review", type: "skill" }],
        },
        outputs: [{
          hash,
          members: [{ hash, mode: 0o644, path: "SKILL.md", type: "file" }],
          mode: 0o755,
          path: ".agents/skills/review",
          type: "directory",
        }, {
          hash,
          mode: 0o644,
          path: ".agent-profile-kit/installation.json",
          type: "file",
        }],
        profileId: "engineering",
        project: "/projects/a",
        resolvedArtifacts: [{
          fingerprint: hash,
          inclusionReasons: [{ profile: "engineering", path: [] }],
          reference: { id: "review", type: "skill" },
        }],
        schemaVersion: 3,
        selectedContext: [],
        workspaceInputHash: hash,
      }],
      repositoryExclusions: [{
        contributions: [{ entries: ["/.agents/skills/review"], installationId: "installation-a" }],
        entries: ["/.agents/skills/review"],
        target: "/projects/a/.git/info/exclude",
      }],
      schemaVersion: 5,
      temporaryInstallations: [],
    };

    const expected: OwnershipState = {
      receipts: [{
        desiredInputDigest: hash,
        hosts: {
          claude: {
            adapterVersion: "claude-project-v1",
            capabilityContract: "native-project-unscoped-rules-v1",
          },
          codex: {
            adapterVersion: "codex-project-v3",
            capabilityContract: "native-project-sessionstart-complete-context-v1",
          },
        },
        installationId: "installation-a",
        lifetime: "ordinary",
        outputs: [{
          hash,
          mode: 0o755,
          path: ".agents/skills/review",
          type: "directory",
        }],
        profileId: "engineering",
        project: "/projects/a",
        repositoryExclusion: {
          entries: ["/.agents/skills/review"],
          target: "/projects/a/.git/info/exclude",
        },
      }],
      removedTemporaryInstallationIds: [],
      schemaVersion: 6 as const,
    };
    expect(normalizeLegacyOwnershipState(legacy)).toEqual(expected);

    const v5Value = parseYaml(formatInstallationState(legacy)) as Record<string, unknown>;
    const v4Value: Record<string, unknown> = { ...v5Value, schema_version: 4 };
    delete v4Value.temporary_installations;
    const v3Value: Record<string, unknown> = { ...v4Value, schema_version: 3 };
    delete v3Value.intended_teardowns;
    const v2Value: Record<string, unknown> = { ...v3Value, schema_version: 2 };
    delete v2Value.repository_exclusions;

    expect(normalizeLegacyOwnershipState(parseInstallationState(stringifyYaml(v5Value)))).toEqual(expected);
    expect(normalizeLegacyOwnershipState(parseV4InstallationState(stringifyYaml(v4Value)))).toEqual(expected);
    expect(normalizeLegacyOwnershipState(parsePreviousInstallationState(stringifyYaml(v3Value)))).toEqual(expected);
    expect(normalizeLegacyOwnershipState(parseLegacyInstallationState(stringifyYaml(v2Value)))).toEqual({
      ...expected,
      receipts: expected.receipts.map(({ repositoryExclusion: _omitted, ...receipt }) => receipt),
    });
  });

  test("rejects legacy exclusion contributions without one active receipt owner", () => {
    const legacy: InstallationState = {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [{
        contributions: [{ entries: ["/.agents/skills/review"], installationId: "orphan" }],
        entries: ["/.agents/skills/review"],
        target: "/projects/a/.git/info/exclude",
      }],
      schemaVersion: 5,
      temporaryInstallations: [],
    };
    expect(() => normalizeLegacyOwnershipState(legacy)).toThrow(/unknown active Installation ID orphan/);
  });

  test("rejects JSON before parsing when the file or nesting bound is exceeded", () => {
    expect(() => parseOwnershipState(" ".repeat(OWNERSHIP_STATE_LIMITS.maxBytes + 1))).toThrow(
      /exceeds the .* byte limit/,
    );
    const nested = "[".repeat(OWNERSHIP_STATE_LIMITS.maxNestingDepth + 1) +
      "]".repeat(OWNERSHIP_STATE_LIMITS.maxNestingDepth + 1);
    expect(() => parseOwnershipState(nested)).toThrow(/nesting exceeds/);
  });

  test("bounds total collections, paths, and decoded string bytes", () => {
    const collectionHeavy = JSON.parse(formatOwnershipState({
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: 6,
    }));
    collectionHeavy.removed_temporary_installation_ids = Array.from(
      { length: OWNERSHIP_STATE_LIMITS.maxCollectionEntries + 1 },
      (_, index) => `removed-${index}`,
    );
    expect(() => parseOwnershipState(JSON.stringify(collectionHeavy))).toThrow(/collection entries exceed/);

    const stringHeavy = JSON.parse(formatOwnershipState(ordinaryState()));
    stringHeavy.receipts[0].installation_id = "é".repeat(
      Math.floor(OWNERSHIP_STATE_LIMITS.maxStringBytes / 2) + 1,
    );
    expect(() => parseOwnershipState(JSON.stringify(stringHeavy))).toThrow(/string exceeds/);

    const pathHeavy = JSON.parse(formatOwnershipState(ordinaryState()));
    pathHeavy.receipts[0].repository_exclusion.entries = Array.from(
      { length: OWNERSHIP_STATE_LIMITS.maxPaths + 1 },
      (_, index) => `/generated-${index}`,
    );
    expect(() => parseOwnershipState(JSON.stringify(pathHeavy))).toThrow(/paths exceed/);
  });

  test("coalesces active temporary lifetime with ordinary receipts and compacts removed identities", () => {
    const legacy: InstallationState = {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 5,
      temporaryInstallations: [{
        adapterVersion: "claude-project-v1",
        completionState: "installed",
        engineVersion: "0.94.0",
        host: "claude",
        hostVersion: "native-project-unscoped-rules-v1",
        outputs: [{ hash, mode: 0o644, path: ".claude/rules/profile.md", type: "file" }, {
          hash,
          mode: 0o644,
          path: ".agent-profile-kit/installation.json",
          type: "file",
        }],
        profileId: "engineering",
        project: "/projects/temp",
        temporaryInstallationId: "temporary-active",
        workspaceInputHash: hash,
      }, {
        adapterVersion: "codex-project-v3",
        completionState: "removed",
        engineVersion: "0.94.0",
        host: "codex",
        hostVersion: "native-project-skills-v1",
        outputs: [],
        profileId: "engineering",
        project: "/projects/removed",
        temporaryInstallationId: "temporary-removed",
        workspaceInputHash: hash,
      }],
    };

    const normalized = normalizeLegacyOwnershipState(legacy);
    expect(normalized.receipts).toEqual([expect.objectContaining({
      installationId: "temporary-active",
      lifetime: "temporary",
      outputs: [{ hash, mode: 0o644, path: ".claude/rules/profile.md", type: "file" }],
    })]);
    expect(normalized.removedTemporaryInstallationIds).toEqual(["temporary-removed"]);
  });
});
