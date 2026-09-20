import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatLifecycleJson } from "../cli/presentation.js";
import { blockerWording } from "../cli/blocker-wording.js";
import { brokenProfileViolations } from "../installer/ingest-workspace.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { validateApplication } from "../installer/commands.js";
import { createLifecycleInstrumentation } from "../installer/qualification-instrumentation.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { existsSync } from "node:fs";
import {
  ApplyBlockedError,
  applyReconciliation,
  previewReconciliation,
} from "../installer/reconcile.js";
import { executeInstall, InstallExecutionError } from "../installer/install-application.js";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";
import {
  reportBlockers,
  reportItems,
} from "./support/reconciliation-report.js";
import { workspaceViolationToken } from "../installer/tool-errors.js";

/**
 * Broken-Profile project scope (spec #593 US-007, DEC-009 project scope,
 * #606; TEST-009 modelled at the installer seams): a Profile naming a missing
 * Context Module or Skill blocks only the Projects bound to it as project-
 * scoped `broken-profile` Blockers. Other Projects are planned and updated
 * normally; blocked Projects keep their existing installed output byte-for-
 * byte; `validate` still fails; structure and artifact violations keep making
 * the Workspace invalid for every command (covered by #604/#605 suites).
 */

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function writeSkill(workspace: string, id: string, body = `# ${id}\n`): void {
  mkdirSync(join(workspace, "skills", id), { recursive: true });
  writeFileSync(
    join(workspace, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: Skill ${id}.\n---\n\n${body}`,
  );
}

interface BrokenFleetFixture {
  readonly blockedProject: string;
  readonly healthyProject: string;
  readonly home: string;
  readonly workspace: string;
}

/**
 * One Workspace with a healthy Profile (bound to one Project) and a broken
 * Profile (bound to another). The broken Profile names a missing Context
 * Module and a missing Skill.
 */
async function brokenFleetFixture(prefix: string): Promise<BrokenFleetFixture> {
  const home = temporaryDirectory(prefix);
  const blockedProject = realpathSync(temporaryDirectory(`${prefix}-blocked-`));
  const healthyProject = realpathSync(temporaryDirectory(`${prefix}-healthy-`));
  await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(home, "apkit-workspace");
  writeFileSync(join(workspace, "context", "shared.md"), "Shared rules.\n");
  writeSkill(workspace, "shared-skill");
  writeFileSync(
    join(workspace, "profiles", "healthy.yaml"),
    "context: [shared]\nskills: [shared-skill]\n",
  );
  writeFileSync(
    join(workspace, "profiles", "broken.yaml"),
    "context: [gone-context]\nskills: [gone-skill]\n",
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${blockedProject}\n    profile: broken\n    hosts: [codex]\n  - project: ${healthyProject}\n    profile: healthy\n    hosts: [codex]\n`,
  );
  return { blockedProject, healthyProject, home, workspace: realpathSync(workspace) };
}

describe("broken-Profile project-scoped Blockers (#606)", () => {
  test("desired-state planning blocks only bound Projects and carries the verbatim reference facts", async () => {
    const { blockedProject, healthyProject, home } = await brokenFleetFixture("apkit-606-plan-");
    const desired = await buildDesiredState(home, { checkHostCapability: false });

    expect(desired.brokenProfiles.map(({ profile, file, missingContexts, missingSkills }) => ({
      profile, file, missingContexts, missingSkills,
    }))).toEqual([{
      profile: "broken",
      file: "profiles/broken.yaml",
      missingContexts: ["gone-context"],
      missingSkills: ["gone-skill"],
    }]);
    expect(brokenProfileViolations(desired.brokenProfiles).map(workspaceViolationToken).sort()).toEqual([
      "missing-context-reference",
      "missing-skill-reference",
    ]);

    const blocked = desired.installations.find(
      (installation) => installation.binding.canonicalProject === blockedProject,
    );
    expect(blocked).toMatchObject({
      kind: "blocked",
      brokenProfile: {
        profile: "broken",
        missingContexts: ["gone-context"],
        missingSkills: ["gone-skill"],
      },
    });
    expect("outputs" in blocked! && blocked.outputs).toBe(false);

    const healthy = desired.installations.find(
      (installation) => installation.binding.canonicalProject === healthyProject,
    );
    expect(healthy).toMatchObject({ kind: "planned", profile: { id: "healthy" } });
    expect(healthy && "outputs" in healthy && healthy.outputs.length).toBeGreaterThan(0);
  });

  test("status blocks only the bound Project; the report names every broken Profile", async () => {
    const { blockedProject, healthyProject, home, workspace } = await brokenFleetFixture("apkit-606-status-");
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const report = await previewReconciliation(desired.installations, {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: 9,
    }, { brokenProfileViolations: brokenProfileViolations(desired.brokenProfiles) });

    const blockedRecord = report.projects.find((project) => project.canonicalProject === blockedProject);
    expect(blockedRecord).toMatchObject({ state: { kind: "blocked" } });
    expect(blockedRecord!.outputs).toEqual([]);
    expect(blockedRecord!.blockers).toHaveLength(1);
    expect(blockedRecord!.blockers[0]).toMatchObject({
      kind: "broken-profile",
      scope: "project",
      project: blockedProject,
      brokenProfile: {
        profile: "broken",
        file: "profiles/broken.yaml",
        missingContexts: ["gone-context"],
        missingSkills: ["gone-skill"],
      },
    });
    // The remedy's editor command names the Profile file by absolute path.
    expect(blockerWording(blockedRecord!.blockers[0]!).remedy).toContain(
      join(workspace, "profiles/broken.yaml"),
    );

    const healthyRecord = report.projects.find((project) => project.canonicalProject === healthyProject);
    expect(healthyRecord).toMatchObject({ state: { kind: "addition" } });
    expect(healthyRecord!.blockers).toEqual([]);
    expect(healthyRecord!.outputs.length).toBeGreaterThan(0);

    // The report names every broken Profile even without a bound Project.
    expect(report.brokenProfileViolations.map(workspaceViolationToken).sort()).toEqual([
      "missing-context-reference",
      "missing-skill-reference",
    ]);

    const json = JSON.parse(formatLifecycleJson("status", report));
    expect(json.outcome).toBe("blocked");
    expect(json.brokenProfileViolations).toHaveLength(2);
    // Lifecycle JSON publishes the shared `{rule, path, message}` shape (#606).
    for (const entry of json.brokenProfileViolations) {
      expect(Object.keys(entry).sort()).toEqual(["message", "path", "rule"]);
    }
    expect(json.brokenProfileViolations.map((entry: { rule: string }) => entry.rule).sort()).toEqual([
      "missing-context-reference",
      "missing-skill-reference",
    ]);
  });

  test("update writes the healthy Project and leaves the blocked Project's installed output unchanged", async () => {
    const { blockedProject, healthyProject, home } = await brokenFleetFixture("apkit-606-apply-");
    // One full apply: the healthy Project installs; the blocked Project is
    // skipped and gets nothing written.
    const before = await buildDesiredState(home, { checkHostCapability: false });
    const firstReport = await applyReconciliation(home, before.installations, {
      brokenProfileViolations: brokenProfileViolations(before.brokenProfiles),
    });
    expect(reportItems(firstReport.receipt).find((item) => item.project === healthyProject)?.kind).toBe("addition");
    // No blocked work is planned: the Apply Receipt carries nothing for it.
    expect(reportItems(firstReport.receipt).some((item) => item.project === blockedProject)).toBe(false);
    // The Apply Receipt records only executed work; the blocked Project's
    // blocked state and Blocker live on the resulting-state report.
    expect(reportItems(firstReport.resultingState).find((item) => item.project === blockedProject)?.kind).toBe("blocked");
    expect(
      firstReport.resultingState
        .projects.find((project) => project.canonicalProject === blockedProject)!
        .blockers.map((blocker) => blocker.kind),
    ).toEqual(["broken-profile"]);
    // Seed the blocked Project's existing output: simulate an installation from
    // an earlier release while the Profile was still valid.
    const seededOutput = join(blockedProject, ".agents", "skills", "gone-skill", "SKILL.md");
    mkdirSync(join(blockedProject, ".agents", "skills", "gone-skill"), { recursive: true });
    const seededContent = "# gone-skill\nprevious release content\n";
    writeFileSync(seededOutput, seededContent);
    const seededHash = `sha256:${createHash("sha256").update(seededContent).digest("hex")}`;
    const seededReceipt = {
      desiredInputDigest: seededHash,
      hosts: { codex: { adapterVersion: "test", capabilityContract: "test" } },
      installationId: "seeded-installation-id",
      lifetime: "ordinary" as const,
      outputs: [{
        hash: seededHash,
        mode: 0o644,
        path: ".agents/skills/gone-skill/SKILL.md",
        type: "file" as const,
      }],
      profileId: "broken",
      project: blockedProject,
    };
    const state = await readInstallationState(home);
    await writeInstallationState(home, {
      ...state,
      receipts: [...state.receipts, seededReceipt],
    });
    const seededBytes = readFileSync(seededOutput, "utf8");

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    // With the healthy Project current there is no applicable work left, so
    // apply refuses before any write with the complete blocked report — the
    // existing whole-invocation rule when no selected Project has pending work.
    let blockedReport;
    try {
      await applyReconciliation(home, desired.installations, {
        brokenProfileViolations: brokenProfileViolations(desired.brokenProfiles),
      });
      throw new Error("expected ApplyBlockedError");
    } catch (error) {
      if (!(error instanceof ApplyBlockedError)) throw error;
      blockedReport = error.report;
    }
    const blockedRecord = blockedReport.projects.find(
      (project) => project.canonicalProject === blockedProject,
    );
    expect(blockedRecord!.state).toMatchObject({ kind: "blocked" });
    expect(blockedRecord!.blockers.map((blocker) => blocker.kind)).toEqual(["broken-profile"]);
    // The update report still names every broken Profile (#606).
    expect(blockedReport.brokenProfileViolations.map(workspaceViolationToken).sort()).toEqual([
      "missing-context-reference",
      "missing-skill-reference",
    ]);
    // The blocked Project's existing installed output is unchanged on disk.
    expect(readFileSync(seededOutput, "utf8")).toBe(seededBytes);
    // And its receipt survives verbatim in the projected state.
    const resulting = await readInstallationState(home);
    expect(
      resulting.receipts.find((receipt) => receipt.installationId === "seeded-installation-id"),
    ).toBeDefined();
  });

  test("validate (application mode) still fails while any Profile is broken", async () => {
    const { home } = await brokenFleetFixture("apkit-606-validate-");
    const instrumentation = createLifecycleInstrumentation();
    let thrown: unknown;
    try {
      await validateApplication(home, { instrumentation });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InstallerToolError);
    const fact = (thrown as InstallerToolError).fact;
    if (fact.kind !== "workspace-violations") throw new Error(`expected workspace-violations, got ${fact.kind}`);
    expect(fact.violations.map(workspaceViolationToken).sort()).toEqual([
      "missing-context-reference",
      "missing-skill-reference",
    ]);
    // Fail fast: the Workspace report comes from ingestion, before any Project is planned.
    expect(instrumentation.counts.resolveProfile).toBe(0);
  });

  test("a Workspace whose only problem is an unbound broken Profile still reports it and blocks nobody", async () => {
    const home = temporaryDirectory("apkit-606-unbound-");
    await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(home, "apkit-workspace");
    writeFileSync(join(workspace, "context", "shared.md"), "Shared rules.\n");
    writeFileSync(join(workspace, "profiles", "unbound.yaml"), "context: [gone]\nskills: []\n");
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings: []\n`,
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toEqual([]);
    expect(desired.brokenProfiles.map((broken) => broken.profile)).toEqual(["unbound"]);
    const report = await previewReconciliation(desired.installations, {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: 9,
    }, { brokenProfileViolations: brokenProfileViolations(desired.brokenProfiles) });
    expect(report.projects).toEqual([]);
    expect(reportBlockers(report)).toEqual([]);
    expect(report.brokenProfileViolations).toHaveLength(1);
  });

  test("install of a broken Profile is blocked before any write; nothing is published", async () => {
    const { blockedProject, home } = await brokenFleetFixture("apkit-606-install-");
    const configurationPath = join(home, ".agents", "agent-profile-kit", "config.yaml");
    const before = readFileSync(configurationPath, "utf8");
    let thrown: unknown;
    try {
      await executeInstall(home, { profile: "broken", hosts: ["codex"], project: blockedProject });
      throw new Error("expected install to fail");
    } catch (error) {
      if (!(error instanceof InstallExecutionError)) throw error;
      expect(error.failure.cause).toBeInstanceOf(ApplyBlockedError);
      const blockedReport = (error.failure.cause as ApplyBlockedError).report;
      const record = blockedReport.projects.find(
        (project) => project.canonicalProject === blockedProject,
      );
      expect(record!.blockers.map((blocker) => blocker.kind)).toEqual(["broken-profile"]);
      // The report channel names every broken Profile, including unbound ones.
      expect(blockedReport.brokenProfileViolations.map(workspaceViolationToken).sort()).toEqual([
        "missing-context-reference",
        "missing-skill-reference",
      ]);
    }
    // Nothing was published: no binding, no generated output, no receipt.
    const after = readFileSync(configurationPath, "utf8");
    expect(after).toBe(before);
    expect(existsSync(join(blockedProject, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(blockedProject, ".codex"))).toBe(false);
    expect((await readInstallationState(home)).receipts).toHaveLength(0);
  });

  test("install of a valid Profile succeeds while another Profile is broken", async () => {
    const { healthyProject, home } = await brokenFleetFixture("apkit-606-install-ok-");
    const result = await executeInstall(home, { profile: "healthy", hosts: ["codex"], project: healthyProject });
    const healthyRecord = result.applied.receipt.projects.find(
      (project) => project.canonicalProject === healthyProject,
    );
    expect(healthyRecord!.blockers).toEqual([]);
    expect(reportItems(result.applied.receipt).find((item) => item.project === healthyProject)?.kind).toBe("addition");
    expect(existsSync(join(healthyProject, ".agents", "skills", "shared-skill", "SKILL.md"))).toBe(true);
  });
});