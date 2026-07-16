import {
  applyReconciliation,
  previewReconciliation,
  type ReconciliationReport,
} from "./reconcile.js";
import { buildDesiredState, stateManifestPath } from "./project-plan.js";
import {
  proveOwnedInstallation,
  readInstallationState,
  stageProvenInstallationRemoval,
  writeInstallationState,
} from "./installation-state.js";
import { gitExclusionBlockers, stageGitExclusions } from "./git-exclusions.js";

export async function validateApplication(home: string): Promise<{
  readonly bindings: number;
  readonly profiles: number;
  readonly warnings: readonly string[];
}> {
  const desired = await buildDesiredState(home, { checkHostCapability: false });
  return {
    bindings: desired.bindingCount,
    profiles: desired.workspace.profiles.size,
    warnings: [...new Set(desired.installations.flatMap((installation) => installation.warnings))].sort(),
  };
}

export async function previewApplication(home: string): Promise<ReconciliationReport> {
  const desired = await buildDesiredState(home);
  let state;
  try {
    state = await readInstallationState(home);
  } catch (error) {
    const desiredReport = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 2,
    });
    return {
      ...desiredReport,
      blockers: [
        { message: error instanceof Error ? error.message : String(error) },
        ...desiredReport.blockers,
      ],
    };
  }
  return previewReconciliation(desired.installations, state);
}

export async function applyApplication(home: string): Promise<ReconciliationReport> {
  const desired = await buildDesiredState(home);
  return applyReconciliation(home, desired.installations);
}

export async function statusApplication(home: string): Promise<ReconciliationReport> {
  const desired = await buildDesiredState(home, { checkHostCapability: false });
  let state;
  try {
    state = await readInstallationState(home);
  } catch (error) {
    const desiredReport = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 2,
    });
    return {
      ...desiredReport,
      items: [
        ...desiredReport.items,
        {
          kind: "malformed ownership state",
          project: stateManifestPath(home),
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  const report = await previewReconciliation(desired.installations, state);
  const blockedProjects = new Set(
    report.blockers.flatMap((blocker) => blocker.project ? [blocker.project] : []),
  );
  return {
    ...report,
    items: report.items.map((item) => {
      const installation = desired.installations.find(
        (candidate) => candidate.binding.project === item.project,
      );
      const blocked = installation !== undefined &&
        blockedProjects.has(installation.binding.canonicalProject);
      // Only remap otherwise-healthy states. Drift, ownership, and malformed kinds
      // already diagnose the problem and must keep their precise status labels.
      if (blocked && (item.kind === "addition" || item.kind === "current")) {
        return { ...item, kind: "blocked" as const };
      }
      if (item.kind !== "addition") return item;
      return {
        ...item,
        kind: "missing output" as const,
        reason: "Profile Installation is missing",
      };
    }),
  };
}

export async function uninstallApplication(home: string): Promise<number> {
  const state = await readInstallationState(home);
  if (state.installations.length === 0) return 0;
  const failures: string[] = [];
  for (const installation of state.installations) {
    const proof = await proveOwnedInstallation(installation);
    if (!proof.owned) {
      failures.push(
        `${installation.project}: ${proof.reason ?? "ownership could not be proven"}`,
      );
    }
  }
  failures.push(...await gitExclusionBlockers(state));
  if (failures.length > 0) {
    throw new Error(
      `Uninstall blocked; generated output was not removed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  const transactions: Awaited<ReturnType<typeof stageProvenInstallationRemoval>>[] = [];
  let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
  try {
    for (const installation of state.installations) {
      transactions.push(await stageProvenInstallationRemoval(installation));
    }
    exclusions = await stageGitExclusions(state, { installations: [], schemaVersion: 2 });
    await writeInstallationState(home, { installations: [], schemaVersion: 2 });
    for (const transaction of transactions) await transaction.commit();
    await exclusions.commit();
  } catch (error) {
    if (exclusions) await exclusions.rollback();
    for (const transaction of transactions.reverse()) await transaction.rollback();
    throw error;
  }
  return state.installations.length;
}
