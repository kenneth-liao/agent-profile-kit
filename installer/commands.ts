import {
  applyReconciliation,
  previewReconciliation,
  unreadableInstallationStateReport,
  type ApplyReconciliationResult,
  type ReconciliationReport,
} from "./reconcile.js";
import { createLifecycleGitInspectionContext } from "./lifecycle-git-inspection.js";
import { createLifecycleOwnershipInspectionContext } from "./lifecycle-ownership-inspection.js";
import type { LifecyclePlanningInstrumentation } from "./lifecycle-planning.js";
import { createProjectReadScheduler } from "./project-scheduler.js";
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
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import type { LifecycleInstrumentation } from "./qualification-instrumentation.js";
import { canonicalRepositoryExclusionRecord } from "../schemas/installation-manifest.js";
import {
  blockerMessage,
  installationStateUnreadableBlocker,
  normalizeBlocker,
} from "./blockers.js";

export interface ValidationResult {
  readonly bindings: number;
  readonly hosts: readonly string[];
  readonly profiles: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Optional qualification seam for the lifecycle command layer. Production
 * callers omit it; qualification tests inject one aggregate instrumentation set
 * and read deterministic operation counters afterwards. Instrumentation never
 * changes command behavior, ordering, or machine payloads.
 */
export interface LifecycleCommandOptions {
  readonly instrumentation?: LifecycleInstrumentation;
}

/** Conditional planning-instrumentation option (exactOptionalPropertyTypes). */
function planningInstrumentation(
  instrumentation: LifecycleInstrumentation | undefined,
): { readonly planningInstrumentation?: LifecyclePlanningInstrumentation } {
  return instrumentation === undefined
    ? {}
    : { planningInstrumentation: instrumentation.planning };
}

export interface UninstallResult {
  readonly projects: readonly {
    readonly project: string;
    readonly outputs: readonly string[];
    readonly repositoryExclusions: readonly {
      readonly entries: readonly string[];
      readonly target: string;
    }[];
  }[];
}

export async function validateApplication(
  home: string,
  options: LifecycleCommandOptions = {},
): Promise<ValidationResult> {
  const instrumentation = options.instrumentation;
  const desired = await buildDesiredState(home, {
    checkHostCapability: false,
    gitInspection: createLifecycleGitInspectionContext(instrumentation?.git),
    ...planningInstrumentation(instrumentation),
    scheduler: createProjectReadScheduler(),
  });
  return {
    bindings: desired.bindingCount,
    hosts: [...new Set(
      desired.installations.flatMap((installation) => installation.binding.hosts),
    )].sort(),
    profiles: [...desired.workspace.profiles.keys()].sort(),
    warnings: [...new Set(desired.installations.flatMap((installation) => installation.warnings))].sort(),
  };
}

export async function previewApplication(
  home: string,
  options: LifecycleCommandOptions = {},
): Promise<ReconciliationReport> {
  const instrumentation = options.instrumentation;
  const gitInspection = createLifecycleGitInspectionContext(instrumentation?.git);
  const scheduler = createProjectReadScheduler();
  const desired = await buildDesiredState(home, {
    gitInspection,
    ...planningInstrumentation(instrumentation),
    scheduler,
  });
  let state;
  try {
    state = await readInstallationState(home);
  } catch (error) {
    const desiredReport = await previewReconciliation(desired.installations, {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      temporaryInstallations: [],
      schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
    }, { gitInspection });
    return {
      ...desiredReport,
      blockers: [
        normalizeBlocker(installationStateUnreadableBlocker({
          message: error instanceof Error ? error.message : String(error),
          statePath: stateManifestPath(home),
        })),
        ...desiredReport.blockers,
      ],
    };
  }
  return previewReconciliation(desired.installations, state, {
    gitInspection,
    ownershipInspection: createLifecycleOwnershipInspectionContext(instrumentation?.ownership),
    scheduler,
  });
}

export async function applyApplication(
  home: string,
  options: LifecycleCommandOptions = {},
): Promise<ApplyReconciliationResult> {
  const instrumentation = options.instrumentation;
  // Desired-state planning reuses Git topology; apply's preflight and post-commit
  // verification each create a fresh inspection pass for filesystem evidence.
  // One scheduler spans planning and both verification passes so the concurrency
  // boundary cannot drift; all apply writes stay sequential.
  const gitInspection = createLifecycleGitInspectionContext(instrumentation?.git);
  const scheduler = createProjectReadScheduler();
  const desired = await buildDesiredState(home, {
    gitInspection,
    ...planningInstrumentation(instrumentation),
    scheduler,
  });
  return applyReconciliation(home, desired.installations, {
    scheduler,
    createGitInspection: () => createLifecycleGitInspectionContext(instrumentation?.git),
    createOwnershipInspection: () =>
      createLifecycleOwnershipInspectionContext(instrumentation?.ownership),
  });
}

export async function statusApplication(
  home: string,
  options: LifecycleCommandOptions = {},
): Promise<ReconciliationReport> {
  const instrumentation = options.instrumentation;
  const gitInspection = createLifecycleGitInspectionContext(instrumentation?.git);
  const scheduler = createProjectReadScheduler();
  let state;
  try {
    state = await readInstallationState(home);
  } catch (error) {
    // Probe-free desired state: ownership is already malformed, so topology
    // resolution against prior Manifests is unavailable.
    const desired = await buildDesiredState(home, {
      checkHostCapability: false,
      gitInspection,
      ...planningInstrumentation(instrumentation),
      scheduler,
    });
    return unreadableInstallationStateReport(home, desired.installations, error);
  }
  // Let each Adapter resolve dynamic topology from live evidence when possible,
  // otherwise preserve its applied delivery topology from the prior Manifest.
  const desired = await buildDesiredState(home, {
    checkHostCapability: false,
    gitInspection,
    ...planningInstrumentation(instrumentation),
    previousInstallations: state.installations,
    resolveHostTopology: true,
    scheduler,
  });
  const report = await previewReconciliation(desired.installations, state, {
    gitInspection,
    ownershipInspection: createLifecycleOwnershipInspectionContext(instrumentation?.ownership),
    scheduler,
  });
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
      if (item.kind === "addition") {
        return {
          ...item,
          reason: "Profile Installation is not installed; apply will create it",
        };
      }
      return item;
    }),
  };
}

export async function uninstallApplication(home: string): Promise<UninstallResult> {
  return withInstallationLifecycleLock(home, "uninstall", () => uninstallApplicationLocked(home));
}

async function uninstallApplicationLocked(home: string): Promise<UninstallResult> {
  const loaded = await readInstallationStateWithMigration(home);
  const state = loaded.state;
  if (state.installations.length === 0) {
    if (loaded.migrated) await writeInstallationState(home, state);
    return { projects: [] };
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
  failures.push(...(await gitExclusionBlockers(state, [], { validateRecordedInstallations: true }))
    .map(blockerMessage));
  if (failures.length > 0) {
    throw new Error(
      `Uninstall blocked; generated output was not removed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  const transactions: Awaited<ReturnType<typeof stageProvenInstallationRemoval>>[] = [];
  const result: UninstallResult = {
    projects: state.installations.map((installation) => ({
      outputs: installation.outputs.map((output) => output.path),
      project: installation.project,
      repositoryExclusions: state.repositoryExclusions.flatMap((record) => {
        const contribution = record.contributions.find(
          (candidate) => candidate.installationId === installation.installationId,
        );
        return contribution === undefined
          ? []
          : [{ entries: contribution.entries, target: record.target }];
      }),
    })),
  };
  let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
  let stateWriteAttempted = false;
  try {
    for (const installation of state.installations) {
      transactions.push(await stageProvenInstallationRemoval(installation));
    }
    // Ordinary uninstall must not erase Temporary Profile Installations or their
    // Repository Exclusion contributions; those lifetimes are receipt-owned.
    const activeTemporaryIds = new Set(
      state.temporaryInstallations
        .filter((installation) => installation.completionState === "installed")
        .map((installation) => installation.temporaryInstallationId),
    );
    const temporaryExclusions = state.repositoryExclusions.flatMap((record) => {
      const contributions = record.contributions.filter((contribution) =>
        activeTemporaryIds.has(contribution.installationId),
      );
      return contributions.length === 0
        ? []
        : [canonicalRepositoryExclusionRecord(record.target, contributions)];
    });
    const afterOrdinaryUninstall = {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: temporaryExclusions,
      schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
      temporaryInstallations: state.temporaryInstallations,
    } as const;
    exclusions = await stageGitExclusions(state, afterOrdinaryUninstall);
    stateWriteAttempted = true;
    await writeInstallationState(home, afterOrdinaryUninstall);
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
  return result;
}
