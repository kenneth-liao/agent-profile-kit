import type { LifecycleGitInspectionInstrumentation } from "./lifecycle-git-inspection.js";
import type { LifecyclePlanningInstrumentation } from "./lifecycle-planning.js";
import type { LifecycleOwnershipInspectionInstrumentation } from "./lifecycle-ownership-inspection.js";

/**
 * Deterministic operation counters for one lifecycle invocation.
 *
 * Each counter fires only when an invocation-scoped context performs real work
 * (a cache miss), so the counts prove the operation budgets of the fleet
 * synchronization design (DEC-020 of the fleet-synchronization spec): unique
 * Profiles, Hosts, and Projects are resolved once per invocation, while owned
 * generated outputs are inspected once per reconciliation pass. Production
 * callers omit instrumentation entirely; qualification tests inject one set
 * and assert the budgets are structurally bounded rather than timing-gated.
 */
export interface LifecycleOperationCounts {
  /** Unique Profile resolution work. */
  readonly composeContext: number;
  /** One batched tracked-path classification per Git worktree root. */
  readonly classifyTrackedPaths: number;
  /** Unique Project Git-topology resolution work. */
  readonly findGitProject: number;
  /** Unique Profile input fingerprinting work. */
  readonly hashWorkspaceInputs: number;
  /** Owned directory outputs inspected. */
  readonly inspectDirectory: number;
  /** Owned file outputs inspected. */
  readonly inspectFile: number;
  /** Unique Host projection work. */
  readonly planHost: number;
  /** Unique machine-level Host capability probes. */
  readonly probeHostCapability: number;
  /** Unique Repository Exclusion target snapshots. */
  readonly readExcludeSnapshot: number;
  /** Unique Skill package source reads. */
  readonly readSkillPackage: number;
  /** Unique Profile resolution work. */
  readonly resolveProfile: number;
  /** Unsafe-parent evidence probes. */
  readonly unsafeParent: number;
}

/** One aggregate instrumentation set spanning every invocation-scoped context. */
export interface LifecycleInstrumentation {
  readonly counts: LifecycleOperationCounts;
  readonly git: LifecycleGitInspectionInstrumentation;
  readonly ownership: LifecycleOwnershipInspectionInstrumentation;
  readonly planning: LifecyclePlanningInstrumentation;
}

/**
 * Create one aggregate instrumentation set. Tests pass its sub-instrumentation
 * into the lifecycle contexts and read `counts` afterwards; the set holds no
 * state beyond the counters and is safe to share across the planning,
 * reconciliation, preflight, and post-commit verification passes of one
 * invocation.
 */
export function createLifecycleInstrumentation(): LifecycleInstrumentation {
  const counts = {
    classifyTrackedPaths: 0,
    composeContext: 0,
    findGitProject: 0,
    hashWorkspaceInputs: 0,
    inspectDirectory: 0,
    inspectFile: 0,
    planHost: 0,
    probeHostCapability: 0,
    readExcludeSnapshot: 0,
    readSkillPackage: 0,
    resolveProfile: 0,
    unsafeParent: 0,
  } as { -readonly [K in keyof LifecycleOperationCounts]: number };
  const planning: LifecyclePlanningInstrumentation = {
    onComposeContext: () => {
      counts.composeContext += 1;
    },
    onHashWorkspaceInputs: () => {
      counts.hashWorkspaceInputs += 1;
    },
    onPlanHost: () => {
      counts.planHost += 1;
    },
    onProbeHostCapability: () => {
      counts.probeHostCapability += 1;
    },
    onReadSkillPackage: () => {
      counts.readSkillPackage += 1;
    },
    onResolveProfile: () => {
      counts.resolveProfile += 1;
    },
  };
  const git: LifecycleGitInspectionInstrumentation = {
    onClassifyTrackedPaths: () => {
      counts.classifyTrackedPaths += 1;
    },
    onFindGitProject: () => {
      counts.findGitProject += 1;
    },
    onReadExcludeSnapshot: () => {
      counts.readExcludeSnapshot += 1;
    },
  };
  const ownership: LifecycleOwnershipInspectionInstrumentation = {
    onInspectDirectory: () => {
      counts.inspectDirectory += 1;
    },
    onInspectFile: () => {
      counts.inspectFile += 1;
    },
    onUnsafeParent: () => {
      counts.unsafeParent += 1;
    },
  };
  return { counts, git, ownership, planning };
}
