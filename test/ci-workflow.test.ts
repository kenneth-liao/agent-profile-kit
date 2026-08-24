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
