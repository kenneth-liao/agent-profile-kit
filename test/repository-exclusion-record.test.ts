import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";

import {
  formatInstallationState,
  formatInstallationManifest,
  parseLegacyInstallationState,
  parseInstallationState,
  parsePreviousInstallationState,
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
    schemaVersion: 2 as const,
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
    schemaVersion: 4,
  };
}

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
    expect(() => parseInstallationState(source)).toThrow(/schema_version must be 4/);
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

    expect(parsePreviousInstallationState(stringify(previous))).toEqual({
      installations: current.installations,
      repositoryExclusions: current.repositoryExclusions,
      schemaVersion: 3,
    });
  });

  test("round-trips intended teardown provenance and rejects installed overlap", () => {
    const teardownState: InstallationState = {
      intendedTeardowns: [{ hosts: ["codex"], installationId: "install-c", profileId: "coding", project: "/repo/c" }],
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 4,
    };

    expect(parseInstallationState(formatInstallationState(teardownState))).toEqual(teardownState);
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
