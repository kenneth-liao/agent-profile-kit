import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("private releases are manual, main-only, fully gated, and attach the packed CLI", () => {
  const workflow = parse(
    readFileSync(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8"),
  ) as {
    on: { workflow_dispatch?: { inputs?: { version?: { required?: boolean } } } };
    permissions?: { contents?: string };
    jobs?: Record<
      string,
      {
        env?: Record<string, string>;
        "timeout-minutes"?: number;
        steps?: Array<{
          name?: string;
          run?: string;
          uses?: string;
          env?: Record<string, string>;
          with?: Record<string, unknown>;
          if?: string;
        }>;
      }
    >;
  };

  expect(workflow.on.workflow_dispatch?.inputs?.version?.required).toBe(true);
  expect(workflow.permissions).toEqual({ contents: "write" });

  const jobs = Object.values(workflow.jobs ?? {});
  const steps = jobs.flatMap((job) => job.steps ?? []);
  const commands = steps.map((step) => step.run ?? "").join("\n");

  expect(jobs.every((job) => job.env?.GH_TOKEN === undefined)).toBe(true);
  // Containment is reachable-state arithmetic, not stacked ceilings: a failed
  // suite step (including a supervisor timeout) skips the remaining steps by
  // default, so the 600s suite ceilings never both run after setup. The
  // guards below pin that premise: no suite step may carry its own `if`.
  expect(jobs.every((job) => job["timeout-minutes"] === 25)).toBe(true);
  expect(
    steps.find((step) => step.name === "Check out release commit")?.with?.["persist-credentials"],
  ).toBe(false);
  expect(steps.find((step) => step.name === "Validate release identity")?.env?.GH_TOKEN).toBe(
    "${{ github.token }}",
  );
  expect(steps.find((step) => step.name === "Create private GitHub Release")?.env?.GH_TOKEN).toBe(
    "${{ github.token }}",
  );
  expect(commands).toContain('test "$GITHUB_REF" = "refs/heads/main"');
  expect(commands).toContain('test "$REPOSITORY_PRIVATE" = "true"');
  expect(commands).toContain('test "$GITHUB_SHA" = "$MAIN_SHA"');
  expect(commands).toContain('test "$VERSION" = "$PACKAGE_VERSION"');
  expect(commands).toContain('git/ref/tags/v$VERSION');
  expect(commands).toContain('gh release view "v$VERSION"');
  expect(commands).toContain("bun install --frozen-lockfile");
  expect(commands).toContain("bun run typecheck");
  expect(commands).toContain("bun run build");
  expect(commands).toContain("bun run test");
  expect(commands).toContain("bun run test:fleet");
  // The fleet ceiling is only reachable after a green test step: neither
  // suite step may carry its own condition, so a supervisor timeout on the
  // full run skips the fleet stage instead of stacking a second ceiling.
  expect(steps.find((step) => step.name === "Run test suite")?.if).toBeUndefined();
  expect(steps.find((step) => step.name === "Run fleet-scale regressions")?.if).toBeUndefined();
  expect(commands).toContain("git diff --exit-code");
  expect(commands).toContain('test -z "$(git status --porcelain)"');
  expect(commands).toContain("npm pack --ignore-scripts");
  expect(commands).toContain('"$INSTALL_ROOT/node_modules/.bin/apkit" guide');
  expect(commands).toContain("CHANGELOG.md > release-notes.md");
  expect(commands).toContain('gh release create "v$VERSION"');
  expect(commands).toContain('"$PACKAGE_FILE"');
  expect(commands).toContain('--target "$GITHUB_SHA"');

  const createReleaseCommands = steps.find(
    (step) => step.name === "Create private GitHub Release",
  )?.run;
  expect(createReleaseCommands).toContain('MAIN_SHA="$(gh api');
  expect(createReleaseCommands).toContain('test "$GITHUB_SHA" = "$MAIN_SHA"');
  expect(createReleaseCommands!.indexOf('test "$GITHUB_SHA" = "$MAIN_SHA"')).toBeLessThan(
    createReleaseCommands!.indexOf('gh release create "v$VERSION"'),
  );
});
