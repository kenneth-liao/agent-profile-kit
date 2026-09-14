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
      needs?: string | string[];
      outputs?: Record<string, string>;
      permissions?: { contents?: string };
      env?: Record<string, string>;
      "timeout-minutes"?: number;
      steps?: Array<{
        name?: string;
        run?: string;
        uses?: string;
        env?: Record<string, string>;
        with?: Record<string, unknown>;
        if?: string;
        id?: string;
      }>;
    }
  >;
};

const VERIFY_JOB = "verify-release-candidate";
const PUBLISH_JOB = "publish-release";

test("private releases are manual, main-only, fully gated, and attach the packed CLI", () => {
  expect(workflow.on.workflow_dispatch?.inputs?.version?.required).toBe(true);
  // Least privilege by default (#551): only the publishing job holds the
  // release-write grant; the workflow default is read-only.
  expect(workflow.permissions).toEqual({ contents: "read" });

  const jobs = workflow.jobs ?? {};
  expect(Object.keys(jobs)).toEqual([VERIFY_JOB, PUBLISH_JOB]);
  // Verification cannot write a release; publication is a separate boundary.
  expect(jobs[VERIFY_JOB]?.permissions).toEqual({ contents: "read" });
  expect(jobs[PUBLISH_JOB]?.permissions).toEqual({ contents: "write" });
  for (const [id, job] of Object.entries(jobs)) {
    if (id !== PUBLISH_JOB) {
      expect(job.permissions).toEqual({ contents: "read" });
    }
  }
  // The publishing boundary runs only after verification succeeded.
  expect(jobs[PUBLISH_JOB]?.needs).toEqual([VERIFY_JOB]);

  const steps = Object.values(jobs).flatMap((job) => job.steps ?? []);
  const commands = steps.map((step) => step.run ?? "").join("\n");

  expect(Object.values(jobs).every((job) => job.env?.GH_TOKEN === undefined)).toBe(true);
  // Containment is reachable-state arithmetic, not stacked ceilings: a failed
  // suite step (including a supervisor timeout) skips the remaining steps by
  // default, so the 600s suite ceilings never both run after setup. The
  // guards below pin that premise: no suite step may carry its own `if`.
  // The publishing job runs no suite, so it needs only a minutes-scale bound.
  expect(jobs[VERIFY_JOB]?.["timeout-minutes"]).toBe(25);
  expect(jobs[PUBLISH_JOB]?.["timeout-minutes"]).toBe(10);
  expect(
    steps.find((step) => step.name === "Check out release commit")?.with?.["persist-credentials"],
  ).toBe(false);
  // Every checkout in every job — including the write-permission publishing
  // job, where a persisted token would matter most — must leave no token.
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkouts).toHaveLength(2);
  for (const checkout of checkouts) {
    expect(checkout.with?.["persist-credentials"]).toBe(false);
  }
  expect(steps.find((step) => step.name === "Validate release identity")?.env?.GH_TOKEN).toBe(
    "${{ github.token }}",
  );
  // Release qualification runs the same pinned, behaviorally qualified Bun:
  // the workflow reads the canonical pin and never overrides it. Both jobs
  // use Bun only to run the existing scripts — neither may build or pack.
  const setupBun = steps.filter((step) => step.uses?.startsWith("oven-sh/setup-bun@"));
  expect(setupBun).toHaveLength(2);
  for (const step of setupBun) {
    expect(step.with?.["bun-version-file"]).toBe("package.json");
    expect(step.with?.["bun-version"]).toBeUndefined();
  }
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
  const verifySteps = workflow.jobs?.[VERIFY_JOB]?.steps ?? [];
  const verifyCommands = verifySteps.map((step) => step.run ?? "").join("\n");
  const publishSteps = workflow.jobs?.[PUBLISH_JOB]?.steps ?? [];
  const publishCommands = publishSteps.map((step) => step.run ?? "").join("\n");
  const verifyStepNames = verifySteps.map((step) => step.name);
  const publishStepNames = publishSteps.map((step) => step.name);
  const count = (source: string, command: string): number =>
    source.split(command).length - 1;

  // One canonical stage sequence: the creator's single bounded build owns
  // typecheck and bundling once, and no workflow step may pack separately —
  // the published archive must be the creator's exact candidate bytes.
  expect(count(verifyCommands, "bun run typecheck")).toBe(0);
  expect(count(verifyCommands, "bun run build")).toBe(0);
  expect(count(verifyCommands, "bun run build:bundle")).toBe(0);
  expect(count(verifyCommands, "npm pack")).toBe(0);
  expect(count(verifyCommands, "bun run test\n")).toBe(1);
  expect(verifyCommands).toContain("bun run test:fleet");
  // The candidate creation is itself a rebuild+repack: exactly one creator
  // invocation may exist across the whole workflow, so a second one — which
  // would publish bytes other than the qualified candidate — cannot pass.
  expect(count(verifyCommands, "create-package-candidate")).toBe(1);
  expect(count(publishCommands, "create-package-candidate")).toBe(0);

  // The candidate is created once through the shared from-source creator and
  // supplied to every packed consumer through the canonical channel.
  const creation = verifySteps.find((step) => step.name === "Create release candidate") ?? {};
  expect(creation.run).toContain("scripts/create-package-candidate.ts");
  expect(creation.run).toContain("APKIT_TEST_PACKAGE_ARCHIVE=");
  expect(creation.run).toContain("$GITHUB_ENV");
  expect(creation.run).toContain("$GITHUB_OUTPUT");
  const suite = verifySteps.find((step) => step.name === "Run test suite") ?? {};
  expect((suite.env ?? {})['APKIT_TEST_PACKAGE_ARCHIVE']).toBe("${{ env.APKIT_TEST_PACKAGE_ARCHIVE }}");
  expect((suite.env ?? {})['APKIT_TEST_DIAGNOSTICS_DIR']).toContain("${{ runner.temp }}");

  // Retained evidence uses the shared CI policy: both the suite and the
  // fleet run retain their qualification record and supervised diagnostics
  // on every outcome, each under its own upload step. The handoff upload is
  // the publishing boundary's input, not diagnostics: it exists only after
  // the evidence gate succeeded.
  const uploads = verifySteps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  expect(uploads).toHaveLength(3);
  const diagnosticsUploads = uploads.slice(0, 2);
  for (const upload of diagnosticsUploads) {
    expect(upload.if).toBe("always()");
    expect(upload.with?.["if-no-files-found"]).toBe("ignore");
    expect(upload.with?.["retention-days"]).toBe(7);
    expect(String(upload.with?.path)).toContain("${{ runner.temp }}");
  }
  expect(uploads.map((upload) => upload.name)).toEqual([
    "Upload supervised suite qualification evidence",
    "Upload fleet suite qualification evidence",
    "Hand the verified candidate to the publishing boundary",
  ]);
  const handoff = uploads[2];
  expect(handoff?.if).toBe("success()");
  expect(handoff?.with?.["if-no-files-found"]).toBe("error");
  expect(handoff?.with?.["name"]).toBe("release-candidate-handoff");
  expect(String(handoff?.with?.path)).toContain("release-package");

  // Publication consumes the exact qualified bytes: the evidence verification
  // step runs in the read-only verification job, and the publishing boundary
  // re-enforces the same contract on the received candidate and evidence
  // before the release is created.
  const verify = verifySteps.find((step) => step.name === "Verify release candidate evidence");
  expect(verify?.run).toContain("scripts/verify-release-candidate.ts");
  expect(verify?.run).toContain('"$GITHUB_SHA"');
  expect(verify?.run).toContain("qualification-record.json");
  // The accepted record travels beside the candidate into the handoff: the
  // copy runs in the same step, after the gate, into the uploaded directory.
  expect(verify?.run).toContain(
    'cp "$RUNNER_TEMP/suite-diagnostics/qualification-record.json"',
  );
  expect(verify?.run).toContain(
    '"$RUNNER_TEMP/release-package/qualification-record.json"',
  );
  expect(verify?.run?.indexOf("cp ") ?? -1).toBeGreaterThan(
    (verify?.run?.indexOf("scripts/verify-release-candidate.ts") ?? -2),
  );
  expect(verifyStepNames.indexOf("Verify release candidate evidence")).toBeGreaterThan(
    verifyStepNames.indexOf("Run fleet-scale regressions"),
  );
  const boundaryVerify = publishSteps.find(
    (step) => step.name === "Verify the received candidate and evidence",
  );
  expect(boundaryVerify?.run).toContain("scripts/verify-release-candidate.ts");
  expect(boundaryVerify?.run).toContain('"$GITHUB_SHA"');
  expect(boundaryVerify?.run).toContain("qualification-record.json");
  expect(boundaryVerify?.run).toContain("archive-name");
  expect(publishStepNames.indexOf("Verify the received candidate and evidence")).toBeLessThan(
    publishStepNames.indexOf("Create private GitHub Release"),
  );
  // The boundary consumes the workflow's only write-permission job, addressed
  // through the single handoff artifact.
  const download = publishSteps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  expect(download?.with?.["name"]).toBe("release-candidate-handoff");
  expect(String(download?.with?.path)).toContain("${{ runner.temp }}");
  const createRelease = publishSteps.find((step) => step.name === "Create private GitHub Release");
  expect(createRelease?.run).toContain('gh release create "v$VERSION"');
  // Publication consumes the exact received artifact: the release attaches
  // the handoff's identified archive, addressed by the verification job's
  // output name — the same file the boundary gate re-digested.
  expect(createRelease?.run).toContain(
    '$RUNNER_TEMP/candidate/${{ needs.verify-release-candidate.outputs.archive-name }}',
  );
  expect(createRelease?.run).toContain('--target "$GITHUB_SHA"');

  // The publishing job may not rebuild or repack: its entire step sequence —
  // not just the slice between verification and publication — must contain
  // no build, no pack, and no creator invocation.
  expect(count(publishCommands, "bun run build")).toBe(0);
  expect(count(publishCommands, "bun run typecheck")).toBe(0);
  expect(count(publishCommands, "npm pack")).toBe(0);
  expect(count(publishCommands, "create-package-candidate")).toBe(0);
});

test("the publishing boundary receives only the verified candidate and evidence (#551)", () => {
  const publishJob = workflow.jobs?.[PUBLISH_JOB];
  const publishSteps = publishJob?.steps ?? [];
  const publishStepNames = publishSteps.map((step) => step.name);

  // Nothing reaches the publishing boundary except the identified handoff:
  // no suite, no fleet run, no candidate creation, no smoke install.
  expect(publishStepNames).toEqual([
    "Check out release commit",
    "Set up Bun",
    "Install dependencies",
    "Receive the verified candidate",
    "Verify the received candidate and evidence",
    "Prepare release notes",
    "Create private GitHub Release",
  ]);
  // The verification job supplies the archive filename through its output;
  // the boundary addresses the received artifact by that name.
  const verifyJob = workflow.jobs?.[VERIFY_JOB];
  expect(verifyJob?.outputs?.["archive-name"]).toBe(
    "${{ steps.candidate.outputs.archive-name }}",
  );
  const creation = verifyJob?.steps?.find((step) => step.name === "Create release candidate");
  expect(creation?.id).toBe("candidate");
  expect(creation?.run).toContain('archive-name=$(basename "$archive_file")');

  // The evidence gate runs in the read-only job before any write-capable
  // stage exists in the run's execution graph.
  const verifyStepNames = verifyJob?.steps?.map((step) => step.name) ?? [];
  expect(verifyStepNames.indexOf("Verify release candidate evidence")).toBeGreaterThan(
    verifyStepNames.indexOf("Smoke-test packed CLI"),
  );
  expect(verifyStepNames.indexOf("Hand the verified candidate to the publishing boundary")).toBe(
    verifyStepNames.length - 1,
  );
});

test("the handoff is the publishing boundary's only candidate input, from this run alone (#551)", () => {
  const publishJob = workflow.jobs?.[PUBLISH_JOB];
  const publishSteps = publishJob?.steps ?? [];

  // Cross-run artifact resolution exists only through the `run-id` input;
  // absent it, download-artifact can resolve only artifacts of this run, so
  // a stale handoff from an earlier run cannot reach the publishing job.
  const download = publishSteps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  expect(download?.with?.["name"]).toBe("release-candidate-handoff");
  expect(download?.with?.["run-id"]).toBeUndefined();
  expect(download?.with?.["github-token"]).toBeUndefined();
  expect(download?.with?.["merge-multiple"]).toBeUndefined();
  expect(download?.with?.["pattern"]).toBeUndefined();

  // The boundary re-digests the DOWNLOADED bytes: its verify invocation
  // addresses the download path, never a path inherited from the verify
  // job's runner, and passes this run's release revision ($GITHUB_SHA) as
  // the expected revision — the same canonical gate's `wrong-revision`
  // branch rejects a handoff whose record binds a different revision.
  const verify = publishSteps.find(
    (step) => step.name === "Verify the received candidate and evidence",
  );
  expect(verify?.run).toContain('candidate_dir="$RUNNER_TEMP/candidate"');
  expect(verify?.run).toContain('$candidate_dir/${{ needs.verify-release-candidate.outputs.archive-name }}');
  expect(verify?.run).not.toContain("release-package");
  expect(verify?.run).not.toContain("suite-diagnostics");
  const verifyRun = verify?.run ?? "";
  const gateInvocation = verifyRun.indexOf("scripts/verify-release-candidate.ts");
  expect(gateInvocation).toBeGreaterThan(-1);
  expect(verifyRun.indexOf('"$GITHUB_SHA"')).toBeGreaterThan(gateInvocation);
  expect(verifyRun.indexOf('"$candidate_dir/qualification-record.json"')).toBeGreaterThan(
    verifyRun.indexOf('"$GITHUB_SHA"'),
  );
});
