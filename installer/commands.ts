import {
  applyReconciliation,
  filterSelectedProjects,
  previewReconciliation,
  reconciliationReportWithProjects,
  unreadableInstallationStateReport,
  type ApplyReconciliationResult,
  type ChangedOutputConsentAnswer,
  type ChangedOutputConsentRequest,
  type ReconciliationReport,
  type ReconciliationScope,
} from "./reconcile.js";
import { createLifecycleGitInspectionContext } from "./lifecycle-git-inspection.js";
import { createLifecycleOwnershipInspectionContext } from "./lifecycle-ownership-inspection.js";
import type { LifecyclePlanningInstrumentation } from "./lifecycle-planning.js";
import { createProjectReadScheduler } from "./project-scheduler.js";
import { buildDesiredState } from "./project-plan.js";
import {
  OwnershipBlockedRemovalError,
  readInstallationState,
  StagedRollbackFailureError,
  stageProvenInstallationRemoval,
  writeInstallationState,
} from "./installation-state.js";
import type { OwnershipFailureFact } from "./blockers.js";
import { publishRepositoryExclusions, receiptExclusionContribution } from "./git-exclusions.js";
import { flatInlineText } from "../adapters/project-plan.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import type { LifecycleInstrumentation } from "./qualification-instrumentation.js";
import { compareCanonicalStrings } from "../schemas/canonical.js";
import {
  ordinaryReceipts,
  retiredReceipts,
  temporaryReceipts,
  withReceipts,
} from "./ownership-state.js";
import type { ProjectBindingSelection } from "./local-configuration.js";
import type { ConfiguredPathOrigin, WorkspaceViolation } from "./tool-errors.js";
import { expandWorkspaceArgument, requireExistingDirectory } from "./local-configuration.js";
import { brokenProfileViolations, collectWorkspaceViolations } from "./ingest-workspace.js";
import type { InfoWorkspaceLocation } from "./info.js";

export interface ValidationResult {
  readonly bindings: number;
  readonly hosts: readonly string[];
  readonly profiles: readonly string[];
  readonly warnings: readonly string[];
  /** The connected Workspace the run checked, as Local Configuration authored it (#629). */
  readonly workspace: InfoWorkspaceLocation;
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
  /** Injectable changed-output replacement consent for apply (DEC-019). */
  readonly confirmChangedOutputReplacement?:
    (request: ChangedOutputConsentRequest) => Promise<ChangedOutputConsentAnswer>;
  /**
   * Explicit per-operation changed-file authorization (DEC-005). Neither flag
   * authorizes the other operation; `--auto-confirm` answers no changed-file
   * scope and is never threaded here.
   */
  readonly removeChanged?: boolean;
  readonly replaceChanged?: boolean;
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

/**
 * The read-only validation outcome for one explicitly authored Workspace
 * folder (spec #593 DEC-009, #604): a valid Workspace carries its found
 * artifacts; an invalid one carries the complete collected violation list —
 * an invalid Workspace is a result of validation, not an exceptional failure.
 */
export type WorkspaceFolderValidation =
  | {
      readonly outcome: "valid";
      readonly path: string;
      readonly contexts: readonly string[];
      readonly profiles: readonly string[];
      readonly skills: readonly string[];
    }
  | {
      readonly outcome: "invalid";
      readonly path: string;
      readonly violations: readonly WorkspaceViolation[];
    };

/**
 * Validate the Workspace folder at an explicitly authored path without reading
 * or writing Local Configuration (#595): any folder, connected or not. The
 * shared expansion rule makes every relative form, including `.`, name the
 * folder the user ran from; the canonical realpath is the validated identity.
 * Path-shape failures (an absent directory, a dangling symlink) remain
 * thrown tool errors; contract violations are a result.
 */
export async function validateWorkspaceFolder(
  home: string,
  authored: string,
): Promise<WorkspaceFolderValidation> {
  const origin: ConfiguredPathOrigin = { source: "validate" };
  const expanded = expandWorkspaceArgument(authored, home, origin);
  const canonical = await requireExistingDirectory(expanded, authored, origin, "workspace");
  const collection = await collectWorkspaceViolations(canonical);
  if (collection.outcome === "valid") {
    return {
      outcome: "valid",
      path: canonical,
      contexts: [...collection.workspace.contexts.keys()].sort(),
      profiles: [...collection.workspace.profiles.keys()].sort(),
      skills: [...collection.workspace.skills.keys()].sort(),
    };
  }
  return { outcome: "invalid", path: canonical, violations: collection.violations };
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
    // `validate` still fails while any Profile is broken (spec #593 US-007, #606).
    rejectReferenceViolations: true,
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
        installation.kind === "planned"
          ? installation.warnings.map((warning) => flatInlineText(warning.parts))
          : [],
      ),
    )].sort(),
    workspace: { authored: desired.authoredWorkspace, canonical: desired.workspace.path },
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
    brokenProfileViolations: brokenProfileViolations(desired.brokenProfiles),
    scheduler,
    scope: reconciliationScope(options.selection),
    ...(options.selection?.filter === undefined ? {} : { filter: options.selection.filter }),
    ...(options.confirmChangedOutputReplacement === undefined
      ? {}
      : { confirmChangedOutputReplacement: options.confirmChangedOutputReplacement }),
    ...(options.replaceChanged === undefined ? {} : { replaceChanged: options.replaceChanged }),
    ...(options.removeChanged === undefined ? {} : { removeChanged: options.removeChanged }),
    createGitInspection: () => createLifecycleGitInspectionContext(instrumentation?.git),
    createOwnershipInspection: () =>
      createLifecycleOwnershipInspectionContext(instrumentation?.ownership),
  });
}

/** The read-only status outcome: the reconciliation report plus the Workspace
 * the run checked (spec #640 US-007). Machine JSON serializes `report` only. */
export interface StatusApplicationResult {
  readonly report: ReconciliationReport;
  /** The selected Workspace as Local Configuration authored it (#629). */
  readonly workspace: InfoWorkspaceLocation;
}

export async function statusApplication(
  home: string,
  options: LifecycleCommandOptions = {},
): Promise<StatusApplicationResult> {
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
    return {
      report: await unreadableInstallationStateReport(
        home,
        desired.installations,
        error,
        brokenProfileViolations(desired.brokenProfiles),
      ),
      workspace: {
        authored: desired.authoredWorkspace,
        canonical: desired.workspace.path,
      },
    };
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
    brokenProfileViolations: brokenProfileViolations(desired.brokenProfiles),
    gitInspection,
    ownershipInspection: createLifecycleOwnershipInspectionContext(instrumentation?.ownership),
    scheduler,
    scope: reconciliationScope(options.selection),
  });
  // One selected-Project contract: narrowing membership is trimmed once here,
  // so the human view, machine JSON, and write scope share it (DEC-006).
  const selected = filterSelectedProjects(report, options.selection?.filter);
  return {
    report: reconciliationReportWithProjects(
      selected,
      selected.projects.map((project) => {
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
    ),
    workspace: {
      authored: desired.authoredWorkspace,
      canonical: desired.workspace.path,
    },
  };
}
