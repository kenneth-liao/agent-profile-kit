import {
  applyReconciliation,
  previewReconciliation,
  type ApplyReconciliationResult,
  type ReconciliationReport,
} from "./reconcile.js";
import { buildDesiredState, stateManifestPath } from "./project-plan.js";
import { INSTALLATION_STATE_SCHEMA_VERSION } from "../schemas/installation-manifest.js";
import {
  proveOwnedInstallation,
  readInstallationState,
  readInstallationStateWithMigration,
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
      repositoryExclusions: [],
      schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
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

export async function applyApplication(home: string): Promise<ApplyReconciliationResult> {
  const desired = await buildDesiredState(home);
  return applyReconciliation(home, desired.installations);
}

export async function statusApplication(home: string): Promise<ReconciliationReport> {
  let state;
  try {
    state = await readInstallationState(home);
  } catch (error) {
    // Probe-free desired state: ownership is already malformed, so topology
    // resolution against prior Manifests is unavailable.
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const desiredReport = await previewReconciliation(desired.installations, {
      installations: [],
      repositoryExclusions: [],
      schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
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
  // Resolve Grok multi-Host Context topology from live inspect when possible,
  // otherwise preserve the applied delivery paths recorded on the Manifest.
  const desired = await buildDesiredState(home, {
    checkHostCapability: false,
    previousInstallations: state.installations,
    resolveHostTopology: true,
  });
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
  const loaded = await readInstallationStateWithMigration(home);
  const state = loaded.state;
  if (state.installations.length === 0) {
    if (loaded.migrated) await writeInstallationState(home, state);
    return 0;
  }
  const failures: string[] = [];
  for (const installation of state.installations) {
    const proof = await proveOwnedInstallation(installation);
    if (!proof.owned) {
      failures.push(
        `${installation.project}: ${proof.reason ?? "ownership could not be proven"}`,
      );
    }
  }
  failures.push(...await gitExclusionBlockers(state, [], { validateRecordedInstallations: true }));
  if (failures.length > 0) {
    throw new Error(
      `Uninstall blocked; generated output was not removed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  const transactions: Awaited<ReturnType<typeof stageProvenInstallationRemoval>>[] = [];
  let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
  let stateWriteAttempted = false;
  try {
    for (const installation of state.installations) {
      transactions.push(await stageProvenInstallationRemoval(installation));
    }
    const emptyState = {
      installations: [],
      repositoryExclusions: [],
      schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
    } as const;
    exclusions = await stageGitExclusions(state, emptyState);
    stateWriteAttempted = true;
    await writeInstallationState(home, emptyState);
    await exclusions.commit();
    for (const transaction of transactions) await transaction.commit();
  } catch (error) {
    let rollbackFailure: unknown;
    if (exclusions) {
      try {
        await exclusions.rollback();
      } catch (failure) {
        rollbackFailure = failure;
      }
    }
    for (const transaction of transactions.reverse()) await transaction.rollback();
    let stateRestoreFailure: unknown;
    if (stateWriteAttempted) {
      try {
        await writeInstallationState(home, state);
      } catch (failure) {
        stateRestoreFailure = failure;
      }
    }
    const recoveryMessages = [
      ...(rollbackFailure === undefined
        ? []
        : [`Exclusion rollback failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`]),
      ...(stateRestoreFailure === undefined
        ? []
        : [`Installation State restore failed: ${stateRestoreFailure instanceof Error ? stateRestoreFailure.message : String(stateRestoreFailure)}`]),
    ];
    if (recoveryMessages.length > 0) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${recoveryMessages.join("\n")}`,
      );
    }
    throw error;
  }
  return state.installations.length;
}
