import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildDesiredState, stateManifestPath } from "../installer/project-plan.js";
import {
  applyReconciliation,
  ApplyBlockedError,
  ApplyDeclinedError,
} from "../installer/reconcile.js";
import { applyApplication } from "../installer/commands.js";
import { readInstallationState } from "../installer/installation-state.js";
import {
  cleanupTemporaryDirectories,
  prepareDriftedFleet,
  temporaryDirectory,
} from "./support/apply-confirmation-fixture.js";

afterAll(cleanupTemporaryDirectories);

const decline = (): Promise<"declined"> => Promise.resolve("declined");
const cancel = (): Promise<"cancelled"> => Promise.resolve("cancelled");
const accept = (): Promise<"accepted"> => Promise.resolve("accepted");

async function abortedOutcome(
  apply: () => Promise<unknown>,
): Promise<"completed" | ApplyDeclinedError | ApplyBlockedError> {
  try {
    await apply();
    return "completed";
  } catch (error) {
    if (error instanceof ApplyDeclinedError) return error;
    if (error instanceof ApplyBlockedError) return error;
    throw error;
  }
}

describe("changed-output confirmation gate", () => {
  test("the gate names each affected Project and its changed generated files", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-evidence");
    const requests: unknown[] = [];
    await applyReconciliation(fleet.home, fleet.desired, {
      confirmChangedOutputReplacement: async (request) => {
        requests.push(request);
        return "accepted";
      },
    });
    expect(requests).toEqual([
      {
        projects: [
          {
            canonicalProject: fleet.driftedProject,
            project: fleet.driftedProject,
            changedOutputs: [".agent-profile-kit/codex/context.md"],
          },
        ],
      },
    ]);
  });

  test("a declined confirmation aborts the whole invocation before any write", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-decline");
    const outcome = await abortedOutcome(() =>
      applyReconciliation(fleet.home, fleet.desired, { confirmChangedOutputReplacement: decline }));
    expect(outcome).toBeInstanceOf(ApplyDeclinedError);
    // The drifted Project keeps its hand-edited bytes.
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    // The healthy Project was never written.
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
    // The Installation State still holds exactly the pre-invocation receipts.
    const state = await readInstallationState(fleet.home);
    expect(state.receipts.map((receipt) => receipt.project).sort()).toEqual([fleet.driftedProject]);
  });

  test("a cancelled confirmation aborts the whole invocation before any write", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-cancel");
    const outcome = await abortedOutcome(() =>
      applyReconciliation(fleet.home, fleet.desired, { confirmChangedOutputReplacement: cancel }));
    expect(outcome).toBeInstanceOf(ApplyDeclinedError);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
    const state = await readInstallationState(fleet.home);
    expect(state.receipts.map((receipt) => receipt.project).sort()).toEqual([fleet.driftedProject]);
  });

  test("a declined confirmation leaves pending retirement work untouched", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-retire");
    // Install the healthy Project, re-drift the first, then unbind the
    // healthy one: its receipt retires, so the declined invocation would
    // otherwise remove its surviving output.
    await applyReconciliation(fleet.home, fleet.desired, {
      confirmChangedOutputReplacement: accept,
    });
    writeFileSync(fleet.driftedOutputPath, fleet.driftedBytes);
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home: fleet.home, project: fleet.healthyProject });
    const desired = (await buildDesiredState(fleet.home, { checkHostCapability: false })).installations;
    const outcome = await abortedOutcome(() =>
      applyReconciliation(fleet.home, desired, { confirmChangedOutputReplacement: decline }));
    expect(outcome).toBeInstanceOf(ApplyDeclinedError);
    // The retiring receipt and its output are both still present.
    const state = await readInstallationState(fleet.home);
    expect(state.receipts.filter((receipt) => receipt.retired !== true)
      .map((receipt) => receipt.project).sort())
      .toEqual([fleet.driftedProject]);
    expect(state.receipts.filter((receipt) => receipt.retired === true)
      .map((receipt) => receipt.project))
      .toEqual([fleet.healthyProject]);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit", "codex", "context.md")))
      .toBe(true);
  });

  test("an accepted confirmation performs the full invocation and retains replacements", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-accept");
    const report = await applyReconciliation(fleet.home, fleet.desired, {
      confirmChangedOutputReplacement: accept,
    });
    // The drifted file was replaced from Workspace content.
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
    // The healthy Project was installed.
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit", "codex", "context.md")))
      .toBe(true);
    const receiptProjects = report.receipt.projects.map((project) => project.project).sort();
    expect(receiptProjects).toEqual([fleet.driftedProject, fleet.healthyProject].sort());
    const driftedReceipt = report.receipt.projects.find(
      (project) => project.project === fleet.driftedProject,
    );
    expect(driftedReceipt!.outputs).toContainEqual(expect.objectContaining({
      path: ".agent-profile-kit/codex/context.md",
      kind: "update",
      driftKind: "changed",
    }));
  });

  test("an invocation with no changed generated files never asks", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-accept");
    await applyReconciliation(fleet.home, fleet.desired, {
      confirmChangedOutputReplacement: accept,
    });
    let asked = false;
    await applyReconciliation(
      fleet.home,
      (await buildDesiredState(fleet.home, { checkHostCapability: false })).installations,
      {
        confirmChangedOutputReplacement: async () => {
          asked = true;
          return "declined";
        },
      },
    );
    expect(asked).toBe(false);
  });

  test("changed generated files on a Blocked Project are never named for replacement", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-blocked-drift");
    // Only the drifted Project remains bound; it gains a second Host whose
    // output root is occupied by foreign git-tracked bytes, so the Project is
    // Blocked while its generated file stays drifted.
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home: fleet.home, project: fleet.healthyProject });
    const application = join(fleet.home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${fleet.driftedProject}\n    profile: coding\n    hosts: [codex, claude]\n`,
    );
    execFileSync("git", ["init", "--quiet"], { cwd: fleet.driftedProject });
    mkdirSync(join(fleet.driftedProject, ".claude", "rules"), { recursive: true });
    writeFileSync(join(fleet.driftedProject, ".claude", "rules", "agent-profile-kit.md"), "foreign\n");
    execFileSync("git", ["-C", fleet.driftedProject, "add", ".claude/rules/agent-profile-kit.md"]);
    const desired = (await buildDesiredState(fleet.home, { checkHostCapability: false })).installations;
    let asked = false;
    const outcome = await abortedOutcome(() =>
      applyReconciliation(fleet.home, desired, {
        confirmChangedOutputReplacement: async () => {
          asked = true;
          return "declined";
        },
      }));
    expect(asked).toBe(false);
    expect(outcome).toBeInstanceOf(ApplyBlockedError);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
  });

  test("a Blocker present before the gate is never bypassed by acceptance", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-accept-blocked");
    // Corrupt the Installation State: a global Blocker precedes every write.
    writeFileSync(stateManifestPath(fleet.home), "not json");
    let asked = false;
    const outcome = await abortedOutcome(() =>
      applyReconciliation(fleet.home, fleet.desired, {
        confirmChangedOutputReplacement: async () => {
          asked = true;
          return "accepted";
        },
      }));
    expect(asked).toBe(false);
    expect(outcome).toBeInstanceOf(ApplyBlockedError);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
  });

  test("the command layer threads the consent callback through apply", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-gate-command");
    const outcome = await abortedOutcome(() =>
      applyApplication(fleet.home, { confirmChangedOutputReplacement: decline }));
    expect(outcome).toBeInstanceOf(ApplyDeclinedError);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });
});
