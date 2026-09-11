import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildDesiredState } from "../installer/project-plan.js";
import {
  applyReconciliation,
  ApplyBlockedError,
  ApplyConsentRequiredError,
  ApplyDeclinedError,
  ApplyExecutionError,
  ApplyReviewStaleError,
} from "../installer/reconcile.js";
import {
  cleanupTemporaryDirectories,
  prepareDriftedFleet,
  temporaryDirectory,
} from "./support/apply-confirmation-fixture.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { retireBindingByHand } from "./support/retire-receipt.js";

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
    await retireBindingByHand(fleet.home, fleet.driftedProject);
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
    await retireBindingByHand(fleet.home, fleet.healthyProject);
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

  test("concurrently swapped invalid bytes fail the fresh proof instead of executing", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-bytes");
    const { writeFileSync: writeRaw } = await import("node:fs");
    writeRaw(fleet.driftedOutputPath, new Uint8Array([0xff]));
    const outcome = await outcomeOf(() =>
      applyReconciliation(fleet.home, fleet.desired, {
        confirmChangedOutputReplacement: async () => {
          // Both byte sequences decode to U+FFFD: only an exact-byte review
          // identity can tell them apart.
          writeRaw(fleet.driftedOutputPath, new Uint8Array([0xfe]));
          return "accepted";
        },
      }));
    expect(outcome).toBeInstanceOf(ApplyReviewStaleError);
    expect([...readFileSync(fleet.driftedOutputPath)]).toEqual([0xfe]);
    expect(existsSync(join(fleet.healthyProject, ".agent-profile-kit"))).toBe(false);
  });

  test("a concurrently occupied new output is rejected before its Project writes", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-occupy");
    const outcome = await outcomeOf(() =>
      applyReconciliation(fleet.home, fleet.desired, {
        confirmChangedOutputReplacement: async () => {
          // The review names only the drifted Project; this foreign file at
          // the healthy Project's planned-addition path was never reviewed.
          mkdirSync(join(fleet.healthyProject, ".agent-profile-kit", "codex"), { recursive: true });
          writeFileSync(
            join(fleet.healthyProject, ".agent-profile-kit", "codex", "context.md"),
            "foreign bytes\n",
          );
          return "accepted";
        },
      }));
    expect(outcome).toBeInstanceOf(ApplyExecutionError);
    // The foreign bytes survive; no silent replacement happened.
    expect(readFileSync(
      join(fleet.healthyProject, ".agent-profile-kit", "codex", "context.md"),
      "utf8",
    )).toBe("foreign bytes\n");
  });

  test("directory replacement review names user-added members lost to the refresh", async () => {
    const home = temporaryDirectory("agent-profile-kit-consent-dir-home-");
    const project = temporaryDirectory("agent-profile-kit-consent-dir-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    const { mkdirSync: makeDir } = await import("node:fs");
    makeDir(join(workspace, "skills", "review-pr"), { recursive: true });
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nDirectory consent.\n",
    );
    writeFileSync(
      join(workspace, "skills", "review-pr", "SKILL.md"),
      "---\nname: review-pr\ndescription: Review code.\n---\n\nReview.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n` +
        `  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const first = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, first.installations);
    // A user note inside the owned Skill root: the refresh deletes it, so
    // the review must name it before authorization.
    writeFileSync(join(project, ".agents", "skills", "review-pr", "notes.md"), "user note\n");
    const desired = (await buildDesiredState(home, { checkHostCapability: false })).installations;
    const requests: unknown[] = [];
    await applyReconciliation(home, desired, {
      confirmChangedOutputReplacement: async (request) => {
        requests.push(request);
        return "accepted";
      },
    });
    expect(requests).toHaveLength(1);
    const comparisons = (requests[0] as {
      comparisons: { kind: string; path: string; hunks: { heading: string }[] }[];
    }).comparisons;
    const skill = comparisons.find((entry) => entry.path === ".agents/skills/review-pr");
    expect(skill?.kind).toBe("directory");
    expect(skill?.hunks.map((hunk) => hunk.heading).join("\n")).toContain("notes.md");
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "notes.md"))).toBe(false);
  });

  test("a late authorization stop preserves completed/failed/pending evidence", async () => {
    const fleet = await prepareDriftedFleet("agent-profile-kit-consent-late");
    await applyReconciliation(fleet.home, fleet.desired, {
      confirmChangedOutputReplacement: accept,
    });
    // Both Projects need the Workspace change; only the first is drifted, so
    // the gate reviews just the first scope.
    writeFileSync(
      join(fleet.workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated shared.\n",
    );
    const desired = (await buildDesiredState(fleet.home, { checkHostCapability: false })).installations;
    writeFileSync(fleet.driftedOutputPath, fleet.driftedBytes);
    const healthyOutput = join(fleet.healthyProject, ".agent-profile-kit", "codex", "context.md");
    const outcome = await outcomeOf(() =>
      applyReconciliation(fleet.home, desired, {
        confirmChangedOutputReplacement: async () => {
          writeFileSync(healthyOutput, "concurrent edit\n");
          return "accepted";
        },
      }));
    expect(outcome).toBeInstanceOf(ApplyConsentRequiredError);
    const refusal = outcome as ApplyConsentRequiredError;
    expect(refusal.requiredOperations).toEqual(["replace"]);
    expect(refusal.completedProjects).toEqual([fleet.driftedProject]);
    expect(refusal.failedProject).toEqual({
      canonicalProject: fleet.healthyProject,
      project: fleet.healthyProject,
    });
    expect(refusal.pendingProjects).toEqual([]);
    // The first Project committed the new content; the second is preserved.
    expect(readFileSync(fleet.driftedOutputPath, "utf8")).toContain("Updated shared.");
    expect(readFileSync(healthyOutput, "utf8")).toBe("concurrent edit\n");
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
