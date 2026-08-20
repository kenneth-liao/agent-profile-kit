import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";

import {
  formatInstallationState,
  formatInstallationManifest,
  INSTALLATION_STATE_MAX_ALIAS_COUNT,
  INSTALLATION_STATE_MAX_BYTES,
  parseLegacyInstallationState,
  parseInstallationState,
  parsePreviousInstallationState,
  parseV4InstallationState,
  type InstallationState,
} from "../schemas/installation-manifest.js";
import { replaceRepositoryExclusionContribution } from "../installer/git-exclusions.js";

const hash = `sha256:${"0".repeat(64)}`;

function installation(installationId: string, project: string) {
  return {
    adapterVersion: "test-adapter",
    engineVersion: "test-engine",
    hosts: ["codex"],
    hostVersions: { codex: "test-host" },
    installationId,
    outputs: [{ hash, mode: 0o644, path: ".agent-profile-kit/installation.json", type: "file" as const }],
    profileId: "coding",
    project,
    resolvedArtifacts: [],
    schemaVersion: 3 as const,
    selectedContext: [],
    workspaceInputHash: hash,
  };
}

function validState(): InstallationState {
  return {
    intendedTeardowns: [],
    installations: [
      installation("install-a", "/repo/a"),
      installation("install-b", "/repo/b"),
    ],
    repositoryExclusions: [{
      contributions: [
        { entries: ["/repo/b/.owned", "/shared"], installationId: "install-b" },
        { entries: ["/repo/a/.owned", "/shared"], installationId: "install-a" },
      ],
      entries: ["/repo/a/.owned", "/repo/b/.owned", "/shared"],
      target: "/repo/.git/info/exclude",
    }],
    temporaryInstallations: [],
    schemaVersion: 5,
  };
}

describe("Installation State YAML recovery", () => {
  test("reads legitimate state whose shared Dependency paths exceed the YAML default alias limit", () => {
    const sharedReference = { id: "shared-skill", type: "skill" };
    const source = stringify({
      schema_version: 5,
      intended_teardowns: [],
      installations: [{
        ...parse(formatInstallationManifest(installation("install-a", "/repo/a"))),
        resolved_artifacts: [{
          type: "skill",
          id: "shared-skill",
          fingerprint: hash,
          inclusion_reasons: Array.from({ length: 200 }, () => ({
            profile: "coding",
            path: [sharedReference],
          })),
        }],
        output_origins: { ".agent-profile-kit/installation.json": [] },
      }],
      repository_exclusions: [],
      temporary_installations: [],
    });

    expect((source.match(/\*/g) ?? [])).toHaveLength(199);
    expect(parseInstallationState(source).installations[0]?.resolvedArtifacts[0]?.inclusionReasons)
      .toHaveLength(200);
  });

  test("rejects Installation State larger than the explicit file-size limit", () => {
    const source = `${formatInstallationState(validState())}#${"x".repeat(INSTALLATION_STATE_MAX_BYTES)}\n`;

    expect(() => parseInstallationState(source)).toThrow(/exceeds the .* byte limit/);
  });

  test("rejects hostile YAML whose alias expansion exceeds the explicit limit", () => {
    const levels = Math.ceil(Math.log2(INSTALLATION_STATE_MAX_ALIAS_COUNT)) + 1;
    let source = [
      "schema_version: 5",
      "intended_teardowns: []",
      "installations: []",
      "repository_exclusions: []",
      "temporary_installations: []",
      "bomb_0: &bomb_0 [value]",
    ].join("\n");
    for (let level = 1; level <= levels; level += 1) {
      source += `\nbomb_${level}: &bomb_${level} [*bomb_${level - 1}, *bomb_${level - 1}]`;
    }

    expect(Buffer.byteLength(source, "utf8")).toBeLessThan(INSTALLATION_STATE_MAX_BYTES);
    expect(() => parseInstallationState(`${source}\n`)).toThrow(/invalid YAML/);
  });

  test("formats transitional Installation State without YAML aliases", () => {
    const sharedPath = [{ id: "shared-skill", type: "skill" as const }];
    const state: InstallationState = {
      ...validState(),
      installations: [{
        ...installation("install-a", "/repo/a"),
        resolvedArtifacts: [{
          fingerprint: hash,
          inclusionReasons: Array.from({ length: 200 }, () => ({
            path: sharedPath,
            profile: "coding",
          })),
          reference: sharedPath[0]!,
        }],
        outputOrigins: { ".agent-profile-kit/installation.json": [] },
      }],
      repositoryExclusions: [],
    };

    const source = formatInstallationState(state);

    expect(source).not.toMatch(/(?:^|\s)[&*][a-zA-Z0-9_-]+/m);
    expect(parseInstallationState(source).installations).toHaveLength(1);
  });
});

describe("Repository Exclusion Record schema", () => {
  test("keeps schema-v2 state available to the explicit migration boundary", () => {
    const source = stringify({
      schema_version: 2,
      installations: [parse(formatInstallationManifest(installation("install-a", "/repo/a")))],
    });

    expect(parseLegacyInstallationState(source)).toEqual({
      installations: [installation("install-a", "/repo/a")],
      schemaVersion: 2,
    });
    expect(() => parseInstallationState(source)).toThrow(/schema_version must be 5/);
  });

  test("round-trips contributions and formats their union deterministically", () => {
    const parsed = parseInstallationState(formatInstallationState(validState()));

    expect(parsed.repositoryExclusions).toEqual([{
      contributions: [
        { entries: ["/repo/a/.owned", "/shared"], installationId: "install-a" },
        { entries: ["/repo/b/.owned", "/shared"], installationId: "install-b" },
      ],
      entries: ["/repo/a/.owned", "/repo/b/.owned", "/shared"],
      target: "/repo/.git/info/exclude",
    }]);
  });

  test("keeps schema-v3 state available to the intended-teardown migration boundary", () => {
    const current = parseInstallationState(formatInstallationState(validState()));
    const previous = parse(formatInstallationState(current)) as Record<string, unknown>;
    previous.schema_version = 3;
    delete previous.intended_teardowns;
    delete previous.temporary_installations;

    expect(parsePreviousInstallationState(stringify(previous))).toEqual({
      installations: current.installations,
      repositoryExclusions: current.repositoryExclusions,
      schemaVersion: 3,
    });
  });

  test("keeps schema-v4 state available to the temporary-installation migration boundary", () => {
    const current = parseInstallationState(formatInstallationState(validState()));
    const previous = parse(formatInstallationState(current)) as Record<string, unknown>;
    previous.schema_version = 4;
    delete previous.temporary_installations;

    expect(parseV4InstallationState(stringify(previous))).toEqual({
      intendedTeardowns: current.intendedTeardowns,
      installations: current.installations,
      repositoryExclusions: current.repositoryExclusions,
      schemaVersion: 4,
    });
  });

  test("round-trips intended teardown provenance and rejects installed overlap", () => {
    const teardownState: InstallationState = {
      intendedTeardowns: [{ hosts: ["codex", "claude"], installationId: "install-c", profileId: "coding", project: "/repo/c" }],
      installations: [],
      repositoryExclusions: [],
      temporaryInstallations: [],
      schemaVersion: 5,
    };

    expect(parseInstallationState(formatInstallationState(teardownState))).toEqual({
      ...teardownState,
      intendedTeardowns: [{ ...teardownState.intendedTeardowns[0]!, hosts: ["claude", "codex"] }],
    });
    expect(() => formatInstallationState({
      ...validState(),
      intendedTeardowns: [{ hosts: ["codex"], installationId: "install-a", profileId: "coding", project: "/repo/a" }],
    })).toThrow(/both installed and intentionally uninstalled/);
  });

  test.each([
    "duplicate exclusion targets",
    "duplicate contributors",
    "contributors across targets",
    "malformed absolute targets",
    "invalid root-anchored entries",
    "empty contributions",
    "wildcard entries",
    "inconsistent stored unions",
  ])("rejects %s", (caseName) => {
    const state = validState();
    const record = state.repositoryExclusions[0]!;
    const invalid: InstallationState = caseName === "duplicate exclusion targets"
      ? { ...state, repositoryExclusions: [record, { ...record }] }
      : caseName === "duplicate contributors"
        ? {
            ...state,
            repositoryExclusions: [{
              ...record,
              contributions: [...record.contributions, record.contributions[0]!],
            }],
          }
        : caseName === "contributors across targets"
          ? {
              ...state,
              repositoryExclusions: [
                record,
                {
                  target: "/other/.git/info/exclude",
                  contributions: [{
                    entries: ["/repo/a/.owned", "/shared"],
                    installationId: "install-a",
                  }],
                  entries: ["/repo/a/.owned", "/shared"],
                },
              ],
            }
        : caseName === "malformed absolute targets"
          ? { ...state, repositoryExclusions: [{ ...record, target: "/repo/../repo/.git/info/exclude" }] }
          : caseName === "invalid root-anchored entries"
            ? {
                ...state,
                repositoryExclusions: [{
                  ...record,
                  contributions: [{
                    ...record.contributions[0]!,
                    entries: ["relative/path"],
                  }],
                  entries: ["relative/path"],
                }],
              }
            : caseName === "empty contributions"
              ? {
                  ...state,
                  repositoryExclusions: [{
                    ...record,
                    contributions: [{ ...record.contributions[0]!, entries: [] }],
                    entries: [],
                  }],
                }
              : caseName === "wildcard entries"
                ? {
                    ...state,
                    repositoryExclusions: [{
                      ...record,
                      contributions: [{ ...record.contributions[0]!, entries: ["/repo/*"] }],
                      entries: ["/repo/*"],
                    }],
                  }
            : {
                ...state,
                repositoryExclusions: [{ ...record, entries: ["/not-the-union"] }],
              };

    expect(() => formatInstallationState(invalid)).toThrow();
    expect(() => parseInstallationState(formatInstallationState(validState()))).not.toThrow();
  });
});

describe("Repository Exclusion Record ownership", () => {
  test("updates one installation contribution without removing shared entries", () => {
    const git = { excludeFile: "/repo/.git/info/exclude", relativeProject: "" };
    const output = {
      hash,
      mode: 0o644,
      path: ".owned",
      type: "file" as const,
    };
    const first = replaceRepositoryExclusionContribution([], "install-a", git, [output]);
    const withSecond = replaceRepositoryExclusionContribution(first, "install-b", git, [output]);

    expect(withSecond[0]?.entries).toEqual(["/.owned"]);
    const withoutFirst = replaceRepositoryExclusionContribution(withSecond, "install-a", undefined, []);
    expect(withoutFirst).toEqual(withSecond.map((record) => ({
      ...record,
      contributions: record.contributions.filter(
        (contribution) => contribution.installationId === "install-b",
      ),
    })));
  });
});
