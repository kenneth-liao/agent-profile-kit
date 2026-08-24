import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowSource = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");
const workflow = parse(workflowSource) as {
  on?: {
    pull_request?: { types?: string[] };
    push?: { branches?: string[] };
  };
  permissions?: Record<string, string>;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  jobs?: Record<
    string,
    {
      if?: string;
      "runs-on"?: string;
      "timeout-minutes"?: number;
      permissions?: Record<string, string>;
      steps?: Array<{
        name?: string;
        uses?: string;
        run?: string;
        id?: string;
        if?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

test("runs the complete gate for ready pull-request activity and main pushes only", () => {
  expect(workflow.on?.pull_request?.types).toEqual([
    "opened",
    "synchronize",
    "reopened",
    "ready_for_review",
  ]);
  expect(workflow.on?.push?.branches).toEqual(["main"]);

  const jobs = Object.values(workflow.jobs ?? {});
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.if).toBe(
    "github.event_name != 'pull_request' || github.event.pull_request.draft == false",
  );
});

test("retains the bounded macOS gate and superseded-run cancellation", () => {
  const jobs = Object.values(workflow.jobs ?? {});

  expect(jobs.every((job) => job["runs-on"] === "macos-15")).toBe(true);
  expect(jobs.every((job) => job["timeout-minutes"] === 15)).toBe(true);
  expect(workflow.concurrency).toEqual({
    group: "ci-${{ github.workflow }}-${{ github.ref }}",
    "cancel-in-progress": true,
  });
});

test("gives pull-request code no privileged event, write permission, or workflow secret", () => {
  expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["pull_request", "push"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.values(workflow.jobs ?? {}).every((job) => job.permissions === undefined)).toBe(true);
  expect(workflowSource).not.toMatch(/\bsecrets(?:\.|\[)/);
});

test("does not persist checkout credentials for contributor-controlled code", () => {
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));

  expect(checkouts.length).toBeGreaterThan(0);
  expect(checkouts.every((checkout) => checkout.with?.["persist-credentials"] === false)).toBe(true);
});

test("installs the frozen dependency graph without lifecycle scripts or a dependency cache", () => {
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const install = steps.find((step) => step.name === "Install dependencies");
  const setupNode = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));

  expect(install?.run).toBe("bun install --frozen-lockfile --ignore-scripts");
  expect(setupNode?.with?.["package-manager-cache"]).toBe(false);
  expect(steps.some((step) => step.uses?.startsWith("actions/cache@"))).toBe(false);
  expect(workflowSource).not.toMatch(/^\s*cache:/m);
});

test("uploads explicit supervised diagnostics only after unsuccessful test execution", () => {
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const suite = steps.find((step) => step.name === "Run test suite");
  expect(suite).toEqual({
    name: "Run test suite",
    id: "test_suite",
    env: {
      APKIT_TEST_DIAGNOSTICS_DIR: "${{ runner.temp }}/suite-diagnostics",
    },
    run: "bun run test",
  });

  const upload = steps.find((step) => step.name === "Upload failed suite diagnostics");
  expect(upload?.if).toBe(
    "(failure() && steps.test_suite.outcome == 'failure') || (cancelled() && steps.test_suite.outcome == 'cancelled')",
  );
  expect(upload?.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
  expect(workflowSource).toMatch(
    /uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+(?:\.\d+){1,2}/,
  );
  expect(upload?.with).toEqual({
    name: "supervised-suite-diagnostics-attempt-${{ github.run_attempt }}",
    path: "${{ runner.temp }}/suite-diagnostics/*.log",
    "if-no-files-found": "ignore",
    "retention-days": 7,
  });
});

test("package scripts keep local typecheck, build, and supervised tests independently usable", () => {
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  expect(manifest.scripts.typecheck).toBe("tsc -p tsconfig.json --noEmit");
  expect(manifest.scripts.build).toBe("bun run typecheck && bun run build:bundle");
  expect(manifest.scripts["build:bundle"]).toBe(
    "bun build cli/index.ts --target=node --packages=bundle --outfile=dist/cli.js --silent",
  );
  expect(manifest.scripts.test).toBe("bun run test/support/suite-supervisor.ts full");
});

test("package consumers reuse the CI archive but retain a local build-and-pack fallback", () => {
  const helper = readFileSync(
    resolve(repositoryRoot, "test/support/package-archive.ts"),
    "utf8",
  );
  const consumers = [
    "test/cli.test.ts",
    "test/fleet-qualification.test.ts",
    "test/release-boundary.test.ts",
    "test/release-candidate.test.ts",
  ].map((path) => readFileSync(resolve(repositoryRoot, path), "utf8")).join("\n");

  expect(helper).toContain("APKIT_TEST_PACKAGE_ARCHIVE");
  expect(helper).toContain('["run", "build"]');
  expect(helper).toContain('"--ignore-scripts"');
  expect(consumers).not.toContain('["run", "build"]');
  expect(consumers).not.toContain('["pack"');
});

test("orchestrates typecheck, bundle, archive, and the supervised suite exactly once", () => {
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const commands = steps.map((step) => step.run ?? "").join("\n");
  const count = (command: string): number => commands.split(command).length - 1;

  expect(count("bun run typecheck")).toBe(1);
  expect(count("bun run build:bundle")).toBe(1);
  expect(count("npm pack")).toBe(1);
  expect(count("bun run test")).toBe(1);
  expect(commands).not.toContain("bun run build\n");
  expect(commands).not.toContain("bun test");
  expect(commands).not.toContain("--timeout");

  const archive = steps.find((step) => step.name === "Create package archive")?.run ?? "";
  expect(archive).toContain("npm pack --silent --ignore-scripts");
  expect(archive).toContain("APKIT_TEST_PACKAGE_ARCHIVE=");
  expect(archive).toContain("$GITHUB_ENV");
  expect(archive).not.toContain("--dry-run");

  const stepNames = steps.map((step) => step.name);
  expect(stepNames.indexOf("Typecheck")).toBeLessThan(stepNames.indexOf("Build production CLI"));
  expect(stepNames.indexOf("Build production CLI")).toBeLessThan(
    stepNames.indexOf("Create package archive"),
  );
  expect(stepNames.indexOf("Create package archive")).toBeLessThan(
    stepNames.indexOf("Run test suite"),
  );
});
