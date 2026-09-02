import {
  applyReconciliation,
  previewReconciliation,
  reconciliationReportWithProjects,
  unreadableInstallationStateReport,
  type ApplyReconciliationResult,
  type ReconciliationReport,
  type ReconciliationScope,
} from "./reconcile.js";
import { createLifecycleGitInspectionContext } from "./lifecycle-git-inspection.js";
import { createLifecycleOwnershipInspectionContext } from "./lifecycle-ownership-inspection.js";
import type { LifecyclePlanningInstrumentation } from "./lifecycle-planning.js";
import { createProjectReadScheduler } from "./project-scheduler.js";
import { buildDesiredState } from "./project-plan.js";
import {
  readInstallationState,
  stageProvenInstallationRemoval,
  writeInstallationState,
} from "./installation-state.js";
import { publishRepositoryExclusions, receiptExclusionContribution } from "./git-exclusions.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import type { LifecycleInstrumentation } from "./qualification-instrumentation.js";
import { compareCanonicalStrings } from "../schemas/installation-manifest.js";
import {
  ordinaryReceipts,
  retiredReceipts,
  temporaryReceipts,
  withReceipts,
} from "./ownership-state.js";
import type { ProjectBindingSelection } from "./local-configuration.js";

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
  /** Injectable process environment for Host capability probes. */
  readonly env?: NodeJS.ProcessEnv;
  readonly instrumentation?: LifecycleInstrumentation;
  readonly selection?: ProjectBindingSelection;
}

function reconciliationScope(
  selection: ProjectBindingSelection | undefined,
): ReconciliationScope {
  return selection?.kind === "project" ? { kind: "project" } : { kind: "all" };
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
  /** Projects whose owned output could not be fully removed; every other Project was still removed. */
  readonly kept: readonly {
    readonly project: string;
    readonly reason: string;
  }[];
  /** Best-effort exclusion bookkeeping failures; teardown itself never stalls. */
  readonly warnings: readonly string[];
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
    warnings: [...new Set(
      desired.installations.flatMap((installation) =>
        installation.warnings.map((warning) => warning.message)
      ),
    )].sort(),
  };
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
    ...(options.env === undefined ? {} : { env: options.env }),
    gitInspection,
    ...planningInstrumentation(instrumentation),
    scheduler,
    ...(options.selection === undefined ? {} : { selection: options.selection }),
  });
  return applyReconciliation(home, desired.installations, {
    scheduler,
    scope: reconciliationScope(options.selection),
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
      ...(options.env === undefined ? {} : { env: options.env }),
      gitInspection,
      ...planningInstrumentation(instrumentation),
      scheduler,
      ...(options.selection === undefined ? {} : { selection: options.selection }),
    });
    return unreadableInstallationStateReport(home, desired.installations, error);
  }
  // Let each Adapter resolve its topology from the prior Manifest and keep
  // desired-state planning probe-free: status performs no Agent Host process
  // execution (DEC-015), and probing happens only during apply.
  const desired = await buildDesiredState(home, {
    checkHostCapability: false,
    ...(options.env === undefined ? {} : { env: options.env }),
    gitInspection,
    ...planningInstrumentation(instrumentation),
    previousInstallations: ordinaryReceipts(state),
    scheduler,
    ...(options.selection === undefined ? {} : { selection: options.selection }),
  });
  const report = await previewReconciliation(desired.installations, state, {
    gitInspection,
    ownershipInspection: createLifecycleOwnershipInspectionContext(instrumentation?.ownership),
    scheduler,
    scope: reconciliationScope(options.selection),
  });
  return reconciliationReportWithProjects(
    report,
    report.projects.map((project) => {
      // Only remap otherwise-healthy states. Drift, ownership, and malformed kinds
      // already diagnose the problem and must keep their precise status labels.
      if (
        project.blockers.length > 0 &&
        (project.state.kind === "addition" || project.state.kind === "current")
      ) {
        return { ...project, state: { ...project.state, kind: "blocked" as const } };
      }
      return project;
    }),
  );
}

export async function uninstallApplication(
  home: string,
  options: {
    /** Injectable Installation State writer; tests use it to inject failures. */
    readonly writeInstallationState?: typeof writeInstallationState;
  } = {},
): Promise<UninstallResult> {
  return withInstallationLifecycleLock(home, "uninstall", () =>
    uninstallApplicationLocked(home, options));
}

async function uninstallApplicationLocked(
  home: string,
  options: {
    readonly writeInstallationState?: typeof writeInstallationState;
  },
): Promise<UninstallResult> {
  const writeState = options.writeInstallationState ?? writeInstallationState;
  const state = await readInstallationState(home);
  const installations = ordinaryReceipts(state);
  if (installations.length === 0) return { projects: [], kept: [], warnings: [] };
  let stateWriteAttempted = false;
  // One shared Git inspection context for the whole run: each owned root is
  // classified against the live index at most once per uninstall.
  const gitInspection = createLifecycleGitInspectionContext();
  // Each Project is evaluated and removed independently (DEC-007): a Project
  // whose owned output cannot be fully removed is reported and skipped, and
  // never prevents removal for the other Projects.
  const transactions: Awaited<ReturnType<typeof stageProvenInstallationRemoval>>[] = [];
  const removed = new Set<string>();
  const kept: { project: string; reason: string }[] = [];
  const contributions = new Map<string, { readonly entries: readonly string[]; readonly target: string } | undefined>();
  for (const installation of installations) {
    try {
      transactions.push(
        await stageProvenInstallationRemoval(installation, undefined, gitInspection),
      );
    } catch (error) {
      kept.push({
        project: installation.project,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    removed.add(installation.project);
    // Bookkeeping derivation is best-effort (DEC-009): a failure only
    // forfeits this Project's "cleaned exclusions" claim, never the removal.
    try {
      contributions.set(
        installation.project,
        await receiptExclusionContribution(installation.project, installation.outputs, { gitInspection }),
      );
    } catch {
      contributions.set(installation.project, undefined);
    }
  }
  if (removed.size === 0) {
    return { projects: [], kept, warnings: [] };
  }
  const exclusionWarnings: string[] = [];
  const cleanedByProject = new Map<string, readonly string[]>();
  try {
    // Ordinary uninstall retires only the receipts it removed; kept Projects
    // stay installed and their exclusion entries survive publication. Retired
    // receipts (they belong to unbound Projects), Temporary receipts,
    // tombstones, and retired records are preserved alike: teardown of
    // retired output belongs to the next apply.
    const afterOrdinaryUninstall = withReceipts(state, [
      ...installations.filter((installation) => !removed.has(installation.project)),
      ...temporaryReceipts(state),
      ...retiredReceipts(state),
    ]);
    // Flag the attempt before the write: a publish-then-throw must still
    // trigger the restore below.
    stateWriteAttempted = true;
    await writeState(home, afterOrdinaryUninstall);
    // Best-effort exclusion cleanup after the removal: rewrite every derived
    // target's owned section from the surviving receipts. A failure produces
    // one warning and never stalls teardown or returns a tool error.
    const publication = await publishRepositoryExclusions(afterOrdinaryUninstall, {
      gitInspection,
      previousState: state,
    });
    exclusionWarnings.push(...publication.warnings.map((warning) => warning.message));
    // "Cleaned" claims come only from successful publication changes: entries a
    // failed or skipped publication could not remove are never reported as
    // cleaned.
    const survivingByTarget = new Map(
      publication.changes.map((change) => [change.target, new Set(change.next)]),
    );
    for (const [project, contribution] of contributions) {
      if (contribution === undefined || !removed.has(project)) continue;
      const surviving = survivingByTarget.get(contribution.target);
      cleanedByProject.set(
        project,
        surviving === undefined
          ? []
          : contribution.entries.filter((entry) => !surviving.has(entry)),
      );
    }
    for (const transaction of transactions) await transaction.commit();
  } catch (error) {
    for (const transaction of transactions.reverse()) await transaction.rollback();
    // The durable record precedes the removal commit: restore the prior state
    // whenever this run attempted the write, so staged root rollbacks can never
    // strand output whose receipts were already deleted.
    let stateRestoreFailure: unknown;
    if (stateWriteAttempted) {
      try {
        await writeState(home, state);
      } catch (failure) {
        stateRestoreFailure = failure;
      }
    }
    if (stateRestoreFailure !== undefined) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
        `Installation State restore failed: ${stateRestoreFailure instanceof Error ? stateRestoreFailure.message : String(stateRestoreFailure)}`,
      );
    }
    throw error;
  }
  return {
    kept,
    projects: installations.filter((installation) => removed.has(installation.project)).map((installation) => ({
      outputs: installation.outputs.map((output) => output.path).sort(),
      project: installation.project,
      repositoryExclusions: (cleanedByProject.get(installation.project) ?? []).length === 0
        ? []
        : [{
            entries: cleanedByProject.get(installation.project)!,
            target: contributions.get(installation.project)!.target,
          }],
    })),
    warnings: exclusionWarnings.sort(compareCanonicalStrings),
  };
}
