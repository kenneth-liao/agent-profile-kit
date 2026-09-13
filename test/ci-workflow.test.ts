import { execFileSync } from "node:child_process";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { pinnedBunVersion } from "./support/suite-supervisor.js";
import { runProcess } from "../process/process-executor.js";

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
  expect(jobs).toHaveLength(2);
  expect(jobs.every((job) => job.if ===
    "github.event_name != 'pull_request' || github.event.pull_request.draft == false",
  )).toBe(true);
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

test("installs the pinned Bun from its canonical home in every CI job", () => {
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const setupBun = steps.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  expect(setupBun).toHaveLength(2);
  for (const step of setupBun) {
    expect(step.with?.["bun-version-file"]).toBe("package.json");
    expect(step.with?.["bun-version"]).toBeUndefined();
  }
  // One canonical home: CI installs the exact version the supervisor's
  // runner-identity gate enforces.
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
    engines?: { bun?: string };
  };
  expect(pinnedBunVersion()).toBe(manifest.engines?.bun ?? "");
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
    "test/golden-snapshots.test.ts",
    "test/release-boundary.test.ts",
    "test/release-candidate.test.ts",
  ].map((path) => readFileSync(resolve(repositoryRoot, path), "utf8")).join("\n");

  expect(helper).toContain("APKIT_TEST_PACKAGE_ARCHIVE");
  expect(helper).toContain('["run", "build"]');
  expect(helper).toContain('"--ignore-scripts"');
  expect(consumers).not.toContain('["run", "build"]');
  expect(consumers).not.toContain('["pack"');
});

test("fails CI when a snapshot is created or changed without being committed", () => {
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  const clean = steps.find((step) => step.name === "Verify clean generated output");

  expect(clean?.run).toContain("git diff --check");
  expect(clean?.run).toContain("git diff --exit-code");
  expect(clean?.run).toContain('test -z "$(git status --porcelain)"');
  expect(workflowSource).toMatch(/uncommitted snapshot/i);
  expect(workflowSource).toMatch(/load-bearing/i);
  expect(workflowSource).not.toMatch(/--update-snapshots/);
  expect(workflowSource).not.toMatch(/update-snapshots/);
});

test("orchestrates typecheck, the candidate creator, and the supervised suite exactly once", () => {
  const fast = workflow.jobs?.["macos-supported-platform"];
  const steps = fast?.steps ?? [];
  const commands = steps.map((step) => step.run ?? "").join("\n");
  const count = (command: string): number => commands.split(command).length - 1;

  expect(count("bun run typecheck")).toBe(1);
  // The candidate creator is the only build/pack boundary: the workflow must
  // not duplicate the bounded build or pack stages it single-homes.
  expect(count("bun run build:bundle")).toBe(0);
  expect(count("npm pack")).toBe(0);
  expect(count("bun run test\n")).toBe(1);
  expect(commands).not.toContain("bun run test:fleet");
  expect(commands).not.toContain("bun run build\n");
  expect(commands).not.toContain("bun test");
  expect(commands).not.toContain("--timeout");

  const creation = steps.find((step) => step.name === "Create package candidate")?.run ?? "";
  // The record is written at the actual build/pack boundary by the same
  // from-source creator the supervisor and fallback use — never stamped onto
  // a pre-existing archive.
  expect(creation).toContain("scripts/create-package-candidate.ts");
  expect(creation).toContain("APKIT_TEST_PACKAGE_ARCHIVE=");
  expect(creation).toContain("$GITHUB_ENV");
  expect(creation).not.toContain("npm pack");

  const stepNames = steps.map((step) => step.name);
  expect(stepNames.indexOf("Typecheck")).toBeLessThan(stepNames.indexOf("Create package candidate"));
  expect(stepNames.indexOf("Create package candidate")).toBeLessThan(
    stepNames.indexOf("Run test suite"),
  );
  expect(stepNames.some((name) => name?.startsWith("Build production CLI") ?? false)).toBe(false);
});

test("the candidate creation entry writes one record beside the archive from source", () => {
  const entry = readFileSync(
    resolve(repositoryRoot, "scripts/create-package-candidate.ts"),
    "utf8",
  );
  // One home: the entry invokes the shared creator with the system stage
  // commands; it never packs or digests an archive on its own.
  expect(entry).toContain("createPackageCandidate");
  expect(entry).toContain("systemPackageArchiveCommands");
  expect(entry).not.toContain("npm pack");
  expect(entry).not.toContain("tar");
  // The candidate's destination comes from the caller; the record is written
  // by the creator, not by this entry.
  expect(entry).not.toContain("provenance.json");
});


test("runs fleet-scale regressions in a separate job without raising the fast deadline", () => {
  const fast = workflow.jobs?.["macos-supported-platform"];
  const fleet = workflow.jobs?.["fleet-scale-regressions"];

  expect(fast?.["timeout-minutes"]).toBe(15);
  expect(fleet?.["runs-on"]).toBe("macos-15");
  expect(fleet?.["timeout-minutes"]).toBe(15);
  expect(fleet?.if).toBe(fast?.if);

  const fleetSteps = fleet?.steps ?? [];
  const fleetCommands = fleetSteps.map((step) => step.run ?? "").join("\n");
  expect(fleetCommands).toContain("bun run test:fleet");
  expect(fleetCommands).not.toMatch(/(^|\n)bun run test(\n|$)/);
  expect(fleetCommands).not.toContain("bun test");
  expect(fleetCommands).not.toContain("--timeout");
  expect(fleetCommands).not.toContain("--update-snapshots");
  expect(fleetCommands).not.toContain("build:bundle");
  expect(fleetSteps.some((step) => step.name === "Install dependencies")).toBe(true);
  // The fleet job's canonical qualification prepares its own candidate through
  // the invocation: one typecheck, bundle, and pack inside `test:fleet`, so no
  // prebundling step may duplicate it.
  expect(fleetSteps.some((step) => step.name === "Build production CLI")).toBe(false);
});

test("the candidate creation entry creates the record beside the archive from source", async () => {
  const { createRepositoryPackageCandidate } = await import("../scripts/create-package-candidate.js");
  const root = mkdtempSync(join(tmpdir(), "apkit-ci-entry-repo-"));
  const destination = mkdtempSync(join(tmpdir(), "apkit-ci-entry-dest-"));
  try {
    execFileSync("git", ["-C", root, "init", "-q"]);
    execFileSync("git", ["-C", root, "config", "user.email", "tests@example.com"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Agent Profile Kit Tests"]);
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "agent-profile-kit-entry-fixture", version: "0.0.0-entry" }));
    writeFileSync(join(root, "src.txt"), "source\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    const staging = mkdtempSync(join(tmpdir(), "apkit-ci-entry-staging-"));
    mkdirSync(join(staging, "package", "dist"), { recursive: true });
    writeFileSync(join(staging, "package", "dist", "cli.js"), 'console.log("ENTRY-CLI");\n');
    const created = await createRepositoryPackageCandidate(destination, {
      build: async () => {
        writeFileSync(join(staging, "package", "dist", "cli.js"), 'console.log("ENTRY-CLI");\n');
      },
      createScriptDisabledArchive: async (_stage, directory) => {
        const result = await runProcess({
          executable: "tar",
          arguments_: ["-czf", join(directory, "entry.tgz"), "-C", staging, "package"],
          deadlineMs: 10_000,
          commandLabel: "fixture pack",
        });
        if (!(result.kind === "exit" && result.exitCode === 0)) {
          throw new Error(`fixture pack failed: ${result.kind}`);
        }
        return { filename: "entry.tgz", files: ["dist/cli.js"] };
      },
    });
    const record = JSON.parse(readFileSync(created.recordPath, "utf8")) as { schema: number };
    expect(record.schema).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
  }
});
