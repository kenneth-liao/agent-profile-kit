import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyPathsAgainstGitIndex,
  hasTrackedGitDescendants,
  listTrackedGitIndex,
  type GitProject,
} from "../installer/git.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
}

function gitProject(root: string, relativeProject = ""): GitProject {
  return {
    commonDirectory: join(root, ".git"),
    excludeFile: join(root, ".git", "info", "exclude"),
    relativeProject,
    root,
  };
}

function syntheticIndex(size: number, extras: readonly string[] = []): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index < size; index += 1) {
    paths.push(`vendor/pkg-${String(index).padStart(6, "0")}/src/lib.ts`);
  }
  paths.push(...extras);
  return paths.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

describe("Git tracked-index classification", () => {
  test("classifies exact paths and directory descendants against a large synthetic index", () => {
    const indexed = syntheticIndex(100_000, [
      ".agents/skills/demo-skill/SKILL.md",
      ".agent-profile-kit/codex/context.md",
      "owned/member.txt",
      "packages/tool/README.md",
    ]);
    const destinations = [
      ".agents/skills/demo-skill",
      ".agent-profile-kit/codex/context.md",
      "owned",
      "packages/tool",
      "missing-output",
      ...Array.from({ length: 2_000 }, (_, index) => `planned/output-${index}.md`),
    ];

    const tracked = classifyPathsAgainstGitIndex(
      gitProject("/repo"),
      destinations,
      indexed,
    );

    expect(tracked.has(".agents/skills/demo-skill")).toBe(true);
    expect(tracked.has(".agent-profile-kit/codex/context.md")).toBe(true);
    expect(tracked.has("owned")).toBe(true);
    expect(tracked.has("packages/tool")).toBe(true);
    expect(tracked.has("missing-output")).toBe(false);
    expect(tracked.has("planned/output-0.md")).toBe(false);
    // Destination count must not change asymptotic behavior of the index scan.
    expect(tracked.size).toBe(4);
  });

  test("honors nested Project relative roots when matching the shared index", () => {
    const indexed = syntheticIndex(10_000, [
      "nested/.agents/skills/demo-skill/SKILL.md",
      "nested/owned/member.txt",
      "other/project/file.ts",
    ]);

    const tracked = classifyPathsAgainstGitIndex(
      gitProject("/repo", "nested"),
      [".agents/skills/demo-skill", "owned", "other/project"],
      indexed,
    );

    expect([...tracked].sort()).toEqual([
      ".agents/skills/demo-skill",
      "owned",
    ]);
  });

  test("does not treat a path-prefix sibling as a descendant", () => {
    const indexed = ["foobar/file.ts", "foo/file.ts"].sort();
    const tracked = classifyPathsAgainstGitIndex(
      gitProject("/repo"),
      ["foo", "foobar", "fo"],
      indexed,
    );
    expect(tracked.has("foo")).toBe(true);
    expect(tracked.has("foobar")).toBe(true);
    expect(tracked.has("fo")).toBe(false);
  });

  test("streams the live Git index without a fixed whole-output buffer ceiling", async () => {
    const project = temporaryDirectory("apk-git-index-stream-");
    execFileSync("git", ["init", "-q", project]);
    execFileSync("git", ["-C", project, "config", "user.email", "tests@example.com"]);
    execFileSync("git", ["-C", project, "config", "user.name", "Agent Profile Kit Tests"]);
    writeFileSync(join(project, "README.md"), "fixture\n");
    writeFileSync(join(project, "tracked.txt"), "tracked\n");
    execFileSync("git", ["-C", project, "add", "README.md", "tracked.txt"]);
    execFileSync("git", ["-C", project, "commit", "-qm", "fixture"]);

    const indexed = await listTrackedGitIndex(gitProject(project));
    expect(indexed).toEqual(["README.md", "tracked.txt"]);
    const tracked = classifyPathsAgainstGitIndex(
      gitProject(project),
      ["tracked.txt", "missing.txt", "README.md"],
      indexed,
    );
    expect([...tracked].sort()).toEqual(["README.md", "tracked.txt"]);
  });

  test("hasTrackedGitDescendants fails closed when Git index inspection errors", async () => {
    const project = temporaryDirectory("apk-git-index-fail-");
    execFileSync("git", ["init", "-q", project]);
    writeFileSync(join(project, "README.md"), "fixture\n");
    execFileSync("git", ["-C", project, "add", "README.md"]);
    execFileSync("git", ["-C", project, "commit", "-qm", "fixture"]);
    mkdirSync(join(project, "owned"), { recursive: true });
    writeFileSync(join(project, "owned", "member.txt"), "tracked\n");
    execFileSync("git", ["-C", project, "add", "owned/member.txt"]);

    const bin = temporaryDirectory("apk-git-index-fake-git-");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\nif printf '%s' "$*" | grep -q 'ls-files'; then\n  echo "injected ls-files failure" >&2\n  exit 128\nfi\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      await expect(hasTrackedGitDescendants(project, "owned")).rejects.toThrow(
        "Cannot inspect tracked Git descendants under 'owned'",
      );
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
