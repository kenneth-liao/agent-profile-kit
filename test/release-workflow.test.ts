import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { pinnedBunVersion } from "./support/suite-supervisor.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

test("private releases are manual, main-only, fully gated, and attach the packed CLI", () => {
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
  // Release qualification runs the same pinned, behaviorally qualified Bun:
  // the workflow reads the canonical pin and never overrides it.
  const setupBun = steps.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  expect(setupBun).toHaveLength(1);
  expect(setupBun[0]?.with?.["bun-version-file"]).toBe("package.json");
  expect(setupBun[0]?.with?.["bun-version"]).toBeUndefined();
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
    engines?: { bun?: string };
  };
  expect(pinnedBunVersion()).toBe(manifest.engines?.bun ?? "");
  // Release qualification qualifies the same declared primary Node line; the
  // filter/length loop pins every setup-node step, not only the first.
  const setupNodes = steps.filter((step) => step.uses?.startsWith("actions/setup-node@"));
  expect(setupNodes).toHaveLength(1);
  for (const step of setupNodes) {
    expect(step.with?.["node-version"]).toBe("22");
  }
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
  expect(commands).toContain("bun run test");
  expect(commands).toContain("bun run test:fleet");
  // The fleet ceiling is only reachable after a green test step: neither
  // suite step may carry its own condition, so a supervisor timeout on the
  // full run skips the fleet stage instead of stacking a second ceiling.
  expect(steps.find((step) => step.name === "Run test suite")?.if).toBeUndefined();
  expect(steps.find((step) => step.name === "Run fleet-scale regressions")?.if).toBeUndefined();
  expect(commands).toContain("git diff --exit-code");
  expect(commands).toContain('test -z "$(git status --porcelain)"');
  expect(commands).toContain('"$INSTALL_ROOT/node_modules/.bin/apkit" guide');
  expect(commands).toContain("CHANGELOG.md > release-notes.md");
  expect(commands).toContain('gh release create "v$VERSION"');
  expect(commands).toContain('"$APKIT_TEST_PACKAGE_ARCHIVE"');
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

test("the release path builds and packs once and publishes exactly the qualified candidate (#550)", () => {
  const job = Object.values(workflow.jobs ?? {})[0];
  const steps = job?.steps ?? [];
  const commands = steps.map((step) => step.run ?? "").join("\n");
  const stepNames = steps.map((step) => step.name);
  const count = (command: string): number => commands.split(command).length - 1;

  // One canonical stage sequence: the creator's single bounded build owns
  // typecheck and bundling once, and no workflow step may pack separately —
  // the published archive must be the creator's exact candidate bytes.
  expect(count("bun run typecheck")).toBe(0);
  expect(count("bun run build")).toBe(0);
  expect(count("bun run build:bundle")).toBe(0);
  expect(count("npm pack")).toBe(0);
  expect(count("bun run test\n")).toBe(1);
  expect(commands).toContain("bun run test:fleet");
  // The candidate creation is itself a rebuild+repack: exactly one creator
  // invocation may exist, so a second one anywhere in the workflow — which
  // would publish bytes other than the qualified candidate — cannot pass.
  expect(count("create-package-candidate")).toBe(1);

  // The candidate is created once through the shared from-source creator and
  // supplied to every packed consumer through the canonical channel.
  const creation = steps.find((step) => step.name === "Create release candidate")?.run ?? "";
  expect(creation).toContain("scripts/create-package-candidate.ts");
  expect(creation).toContain("APKIT_TEST_PACKAGE_ARCHIVE=");
  expect(creation).toContain("$GITHUB_ENV");
  const suite = steps.find((step) => step.name === "Run test suite") ?? {};
  expect((suite.env ?? {})['APKIT_TEST_PACKAGE_ARCHIVE']).toBe("${{ env.APKIT_TEST_PACKAGE_ARCHIVE }}");
  expect((suite.env ?? {})['APKIT_TEST_DIAGNOSTICS_DIR']).toContain("${{ runner.temp }}");

  // Retained evidence uses the shared CI policy: both the suite and the
  // fleet run retain their qualification record and supervised diagnostics
  // on every outcome, each under its own upload step.
  const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(uploads).toHaveLength(2);
  for (const upload of uploads) {
    expect(upload.if).toBe("always()");
    expect(upload.with?.["if-no-files-found"]).toBe("ignore");
    expect(upload.with?.["retention-days"]).toBe(7);
    expect(String(upload.with?.path)).toContain("${{ runner.temp }}");
  }
  expect(uploads.map((upload) => upload.name)).toEqual([
    "Upload supervised suite qualification evidence",
    "Upload fleet suite qualification evidence",
  ]);

  // Publication consumes the exact qualified bytes: the evidence verification
  // step runs against the candidate, the release revision, and the retained
  // qualification record, and runs before the release is created.
  const verify = steps.find((step) => step.name === "Verify release candidate evidence");
  expect(verify?.run).toContain("scripts/verify-release-candidate.ts");
  expect(verify?.run).toContain('"$GITHUB_SHA"');
  expect(verify?.run).toContain("qualification-record.json");
  expect(stepNames.indexOf("Verify release candidate evidence")).toBeGreaterThan(
    stepNames.indexOf("Run fleet-scale regressions"),
  );
  expect(stepNames.indexOf("Verify release candidate evidence")).toBeLessThan(
    stepNames.indexOf("Create private GitHub Release"),
  );

  // No rebuild or repack may sit between qualification and publication.
  const verifyIndex = stepNames.indexOf("Verify release candidate evidence");
  const createIndex = stepNames.indexOf("Create private GitHub Release");
  expect(verifyIndex).toBeGreaterThan(stepNames.indexOf("Run test suite"));
  for (const step of steps.slice(verifyIndex, createIndex + 1)) {
    expect(step.run ?? "").not.toContain("bun run build");
    expect(step.run ?? "").not.toContain("npm pack");
    // The creator is the rebuild+repack; its invocation must not reappear
    // between verification and publication.
    expect(step.run ?? "").not.toContain("create-package-candidate");
  }
});
