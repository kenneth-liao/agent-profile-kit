import { describe, expect, test } from "bun:test";

import { replaceRepositoryExclusionContribution } from "../installer/git-exclusions.js";

const hash = `sha256:${"0".repeat(64)}`;

describe("Repository Exclusion Contribution ownership", () => {
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
