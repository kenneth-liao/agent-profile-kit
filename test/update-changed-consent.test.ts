import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildDesiredState } from "../installer/project-plan.js";
import {
  applyReconciliation,
  ApplyBlockedError,
  ApplyConsentRequiredError,
  ApplyDeclinedError,
  ApplyReviewStaleError,
} from "../installer/reconcile.js";
import {
  cleanupTemporaryDirectories,
  prepareDriftedFleet,
} from "./support/apply-confirmation-fixture.js";

afterAll(cleanupTemporaryDirectories);

const accept = (): Promise<"accepted"> => Promise.resolve("accepted");

async function outcomeOf(apply: () => Promise<unknown>): Promise<unknown> {
  try {
    await apply();
    return "completed";
  } catch (error) {
    return error;
  }
}

describe("update changed-file authorization", () => {
  test("missing non-interactive consent refuses before any selected lifecycle write", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-refuse");
    const outcome = await outcomeOf(() =>
      applyReconciliation(fleet.home, fleet.desired, {}));
    expect(outcome).toBeInstanceOf(ApplyConsentRequiredError);
    expect((outcome as ApplyConsentRequiredError).requiredOperations).toEqual(["replace"]);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("--replace-changed authorizes replacement without a prompt", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-flag");
    let asked = false;
    const report = await applyReconciliation(fleet.home, fleet.desired, {
      replaceChanged: true,
      confirmChangedOutputReplacement: async () => {
        asked = true;
        return "accepted";
      },
    });
    expect(asked).toBe(false);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Confirmation fixture.");
    expect(report.receipt.projects.length).toBe(2);
  });

  test("--remove-changed does not authorize replacement", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-no-cross");
    const outcome = await outcomeOf(() =>
      applyReconciliation(fleet.home, fleet.desired, { removeChanged: true }));
    expect(outcome).toBeInstanceOf(ApplyConsentRequiredError);
    expect((outcome as ApplyConsentRequiredError).requiredOperations).toEqual(["replace"]);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
  });

  test("deletion of drifted output requires --remove-changed, and --replace-changed does not cover it", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-remove");
    await applyReconciliation(fleet.home, fleet.desired, {
      confirmChangedOutputReplacement: accept,
    });
    // Hand-edit again, then retire the drifted Project: its surviving output
    // becomes a deletion whose disk bytes differ from the receipt.
    writeFileSync(fleet.driftedOutputPath, fleet.driftedBytes);
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home: fleet.home, project: fleet.driftedProject });
    const desired = (await buildDesiredState(fleet.home, { checkHostCapability: false })).installations;
    const refused = await outcomeOf(() =>
      applyReconciliation(fleet.home, desired, { replaceChanged: true }));
    expect(refused).toBeInstanceOf(ApplyConsentRequiredError);
    expect((refused as ApplyConsentRequiredError).requiredOperations).toEqual(["remove"]);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    const completed = await applyReconciliation(fleet.home, desired, { removeChanged: true });
    // The removal itself is the applied work; the healthy Project was already
    // current so it is not part of the applied receipt.
    expect(completed.receipt.projects.map((project) => project.project))
      .toContain(fleet.driftedProject);
    expect(existsSync(fleet.driftedOutputPath)).toBe(false);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit", "codex", "context.md")))
      .toBe(true);
  });

  test("answering flags never bypass a Blocker", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-blocked");
    const { unbindProject } = await import("../installer/unbind-project.js");
    await unbindProject({ home: fleet.home, project: fleet.healthyProject });
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync } = await import("node:fs");
    writeFileSync(
      fleet.configPath,
      `schema_version: 2\nworkspace: ${fleet.workspace}\nbindings:\n  - project: ${fleet.driftedProject}\n    profile: coding\n    hosts: [codex, claude]\n`,
    );
    execFileSync("git", ["init", "--quiet"], { cwd: fleet.driftedProject });
    mkdirSync(join(fleet.driftedProject, ".claude", "rules"), { recursive: true });
    writeFileSync(join(fleet.driftedProject, ".claude", "rules", "agent-profile-kit.md"), "foreign\n");
    execFileSync("git", ["-C", fleet.driftedProject, "add", ".claude/rules/agent-profile-kit.md"]);
    const replanned = (await buildDesiredState(fleet.home, { checkHostCapability: false })).installations;
    let asked = false;
    const outcome = await outcomeOf(() =>
      applyReconciliation(fleet.home, replanned, {
        replaceChanged: true,
        removeChanged: true,
        confirmChangedOutputReplacement: async () => {
          asked = true;
          return "accepted";
        },
      }));
    expect(asked).toBe(false);
    expect(outcome).toBeInstanceOf(ApplyBlockedError);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
  });

  test("a disk change between review and write fails safe instead of executing", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-stale");
    const outcome = await outcomeOf(() =>
      applyReconciliation(fleet.home, fleet.desired, {
        confirmChangedOutputReplacement: async () => {
          writeFileSync(fleet.driftedOutputPath, "concurrent edit\n");
          return "accepted";
        },
      }));
    expect(outcome).toBeInstanceOf(ApplyReviewStaleError);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe("concurrent edit\n");
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("a declined answer still aborts the whole invocation before any write", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-decline");
    const outcome = await outcomeOf(() =>
      applyReconciliation(fleet.home, fleet.desired, {
        confirmChangedOutputReplacement: async () => "declined",
      }));
    expect(outcome).toBeInstanceOf(ApplyDeclinedError);
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toBe(fleet.driftedBytes);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });
});
