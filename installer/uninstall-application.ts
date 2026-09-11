/**
 * Uninstall selection and removal (spec #491 US-003/US-006/US-007/US-008,
 * DEC-001/DEC-003–DEC-006, ticket #496): remove selected Project
 * installations and forget their remembered selection in one per-Project
 * transition.
 *
 * Selection reads Local Configuration bindings without resolving the
 * Workspace, so recovery stays independent of valid source. Scope is
 * explicit (`--here`, `--project`, `--all`, mutually exclusive) intersected
 * by `--profile`; an absent scope selects nothing, never all Projects.
 * Removal and forgetting stay one transition per Project: the binding and
 * its receipt are forgotten only after that Project's output removal
 * succeeds.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isSeq, parseDocument } from "yaml";

import { parseLocalConfiguration, type SupportedHost } from "../schemas/local-configuration.js";
import type { OwnershipReceipt, OwnershipState } from "../schemas/ownership-state.js";
import { flatInlineText } from "../adapters/project-plan.js";
import { comparisonMatchesDigests, type ChangedOutputComparison } from "./changed-output-review.js";
import {
  defaultFileSystem as bindDefaultFileSystem,
  hostsEqual,
  type BindProjectFileSystem,
} from "./bind-project.js";
import type { OwnershipFailureFact } from "./blockers.js";
import { createLifecycleGitInspectionContext, type LifecycleGitInspection } from "./lifecycle-git-inspection.js";
import {
  createLifecycleOwnershipInspectionContext,
  recordedOutputMatches,
  type LifecycleOwnershipInspection,
} from "./lifecycle-ownership-inspection.js";
import { publishRepositoryExclusions } from "./git-exclusions.js";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  publishConfigurationReplacement,
  removeBindingSourceEntry,
  withConfigurationLock,
} from "./local-configuration-publication.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import {
  ordinaryReceipts,
  withReceipts,
} from "./ownership-state.js";
import {
  OwnershipBlockedRemovalError,
  proveOwnedInstallation,
  readInstallationState,
  stageProvenInstallationRemoval,
  StagedRollbackFailureError,
  writeInstallationState,
  type ProvenInstallationRemovalTransaction,
} from "./installation-state.js";
import {
  ApplyConsentRequiredError,
  liveDigestFor,
  resolveChangedOutputConsent,
  type ChangedOutputConsentAnswer,
  type ChangedOutputConsentRequest,
  type ReconciliationProjectOutput,
  type ReconciliationProjectRecord,
} from "./reconcile.js";
import {
  canonicalizePathForComparison,
  expandConfiguredPath,
  isSameOrDescendant,
  localConfigurationPath,
  normalizeProjectBindings,
  ProjectTargetError,
  readLocalConfigurationSource,
  requireCurrentApplicationConfiguration,
  type IngestedProjectBinding,
} from "./local-configuration.js";
import { InstallerToolError, type ConfiguredPathOrigin } from "./tool-errors.js";

export interface PreviewUninstallOptions {
  /** Authored Project path (`--project` or positional). */
  readonly project?: string;
  /** Select the bound Project containing the working directory (`--here`). */
  readonly here?: boolean;
  /** Select every bound Project (`--all`). */
  readonly all?: boolean;
  /** Intersect the scope to installations using this Profile (`--profile`). */
  readonly profile?: string;
  /** Working directory used for `--here`. Defaults to process.cwd(). */
  readonly cwd?: string;
}

export interface UninstallPreviewProject {
  /** Canonical root; absent when the directory is already gone. */
  readonly canonicalProject?: string;
  /** Authored binding spelling, retained for receipts and restore. */
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
  /** The bound root no longer exists: removal is trivially complete. */
  readonly missing: boolean;
}

export interface UninstallPreview {
  readonly projects: readonly UninstallPreviewProject[];
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Resolve one existing directory target to its canonical root, classifying
 * rejections as typed uninstall facts. A missing path returns undefined so
 * the caller can fall back to exact authored-spelling matching (a deleted
 * root is still forgettable); every other rejection throws.
 */
async function resolveExistingTarget(
  home: string,
  target: string,
): Promise<string | undefined> {
  const origin: ConfiguredPathOrigin = { source: "project-target", command: "uninstall" };
  if (["*", "?", "[", "]"].some((wildcard) => target.includes(wildcard))) {
    throw new ProjectTargetError({ case: "wildcard-target", command: "uninstall", target });
  }
  if (target !== "~" && !target.startsWith("~/") && !isAbsolute(target)) {
    throw new ProjectTargetError({ case: "relative-target", command: "uninstall", target });
  }
  const expanded = expandConfiguredPath(target, home, origin, "project");
  let entryStats;
  try {
    entryStats = await lstat(expanded);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const followed = await stat(expanded);
    if (!followed.isDirectory()) {
      throw new ProjectTargetError({ case: "missing-target", command: "uninstall", target });
    }
  } catch (error) {
    if (error instanceof ProjectTargetError) throw error;
    if (entryStats.isSymbolicLink() && hasErrorCode(error, "ENOENT")) {
      throw new ProjectTargetError({
        case: "dangling-symlink-target",
        command: "uninstall",
        target,
      });
    }
    throw error;
  }
  try {
    return await realpath(expanded);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function toPreviewProject(binding: IngestedProjectBinding): UninstallPreviewProject {
  return {
    ...(binding.canonicalProject === undefined
      ? {}
      : { canonicalProject: binding.canonicalProject }),
    project: binding.project,
    profile: binding.profile,
    hosts: binding.hosts,
    missing: binding.missing,
  };
}

/**
 * Resolve the uninstall scope to bound Projects without writing anything and
 * without resolving the Workspace. Profile membership intersects the scope
 * and never broadens it: a filter matching nothing resolves to an empty
 * preview, which the command layer reports truthfully with no writes.
 */
export async function previewUninstall(
  home: string,
  options: PreviewUninstallOptions = {},
): Promise<UninstallPreview> {
  const { path, source } = await readLocalConfigurationSource(home);
  const parsed = requireCurrentApplicationConfiguration(
    parseLocalConfiguration(source, localConfigurationPath(home)),
    path,
  );
  const bindings = await normalizeProjectBindings(home, parsed.bindings, path, {
    allowMissingProjects: true,
    kind: "application",
    profiles: new Map(),
    requireProfiles: false,
  });

  let selected: readonly IngestedProjectBinding[];
  if (options.all === true) {
    selected = bindings;
  } else if (options.here === true) {
    selected = await selectContaining(bindings, options.cwd ?? process.cwd());
  } else if (options.project !== undefined) {
    selected = await selectExact(home, bindings, options.project);
  } else {
    // An absent scope selects nothing, never all Projects (DEC-003/DEC-004).
    // A lone `--profile` is itself a scope: it selects installations using
    // that Profile, which the intersection below then keeps (DEC-003).
    selected = options.profile === undefined ? [] : bindings;
  }

  if (options.profile !== undefined) {
    selected = selected.filter((binding) => binding.profile === options.profile);
  }
  return {
    projects: [...selected]
      .map(toPreviewProject)
      .sort((left, right) => {
        const leftKey = left.canonicalProject ?? left.project;
        const rightKey = right.canonicalProject ?? right.project;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  };
}

async function selectContaining(
  bindings: readonly IngestedProjectBinding[],
  cwd: string,
): Promise<readonly IngestedProjectBinding[]> {
  const canonicalTarget = await resolveExistingTarget("", cwd);
  if (canonicalTarget === undefined) {
    throw new ProjectTargetError({ case: "missing-target", command: "uninstall", target: cwd });
  }
  const matches = bindings.filter(
    (binding) =>
      binding.canonicalProject !== undefined &&
      isSameOrDescendant(canonicalTarget, binding.canonicalProject),
  );
  if (matches.length === 0) {
    throw new ProjectTargetError({ case: "unbound-target", command: "uninstall", target: cwd });
  }
  if (matches.length > 1) {
    throw new ProjectTargetError({ case: "ambiguous-target", command: "uninstall", target: cwd });
  }
  return matches;
}

async function selectExact(
  home: string,
  bindings: readonly IngestedProjectBinding[],
  target: string,
): Promise<readonly IngestedProjectBinding[]> {
  const canonicalTarget = await resolveExistingTarget(home, target);
  if (canonicalTarget === undefined) {
    // A deleted root is still forgettable, but only by its exact authored
    // spelling already present in Local Configuration (cf. unbind).
    const authored = bindings.filter((binding) => binding.project === target);
    if (authored.length === 0) {
      throw new ProjectTargetError({ case: "missing-target", command: "uninstall", target });
    }
    return authored;
  }
  const matches = bindings.filter(
    (binding) => binding.canonicalProject === canonicalTarget,
  );
  if (matches.length === 0) {
    throw new ProjectTargetError({ case: "unbound-target", command: "uninstall", target });
  }
  return matches;
}

/** The selection changed between confirmation and commit: fail closed
 * before any lifecycle write, so unshown Projects are never removed. */
export class UninstallScopeChangedError extends Error {
  readonly current: readonly { readonly canonicalProject?: string; readonly project: string }[];

  constructor(
    current: readonly { readonly canonicalProject?: string; readonly project: string }[],
  ) {
    super("the uninstall scope changed during confirmation; re-run to review the current scope");
    this.name = "UninstallScopeChangedError";
    this.current = current;
  }
}

export interface ExecuteUninstallOptions extends PreviewUninstallOptions {
  /**
   * The scope the user already reviewed (INT-2): when provided, the
   * selection is re-resolved and the run fails closed when it differs, so
   * a binding added between confirmation and commit is never removed
   * without ever having been shown.
   */
  readonly confirmedPreview?: UninstallPreview;
  /**
   * Explicit deletion authorization (DEC-005): answers removal of
   * independently changed generated output without asking. Never answers
   * replacement scope (uninstall performs no replacements) and never answers
   * the general confirmation, which lives in the command layer (DEC-004).
   */
  readonly removeChanged?: boolean;
  /** Injectable changed-output consent; absent means non-interactive refusal. */
  readonly confirmChangedOutputReplacement?:
    (request: ChangedOutputConsentRequest) => Promise<ChangedOutputConsentAnswer>;
  /** Factories for fresh lifecycle inspection passes; tests use them to fault verification. */
  readonly createGitInspection?: () => LifecycleGitInspection;
  readonly createOwnershipInspection?: () => LifecycleOwnershipInspection;
  /** Injectable Installation State writer; tests use it to inject failures. */
  readonly writeInstallationState?: typeof writeInstallationState;
  /** Test-only filesystem override for selection publication proofs. */
  readonly bindFileSystem?: BindProjectFileSystem;
  /** Test-only lock wait timeout (ms) for the per-Project commit boundary. */
  readonly lockTimeoutMs?: number;
}

export interface UninstallCompletedProject {
  readonly canonicalProject?: string;
  /** Authored binding spelling, for scope-preserving retry commands. */
  readonly project: string;
  readonly profile: string;
  /** Removed recorded output roots, project-relative and ordered. */
  readonly outputs: readonly string[];
}

export interface UninstallSkippedProject {
  readonly canonicalProject?: string;
  readonly project: string;
  readonly profile: string;
  readonly reason: OwnershipFailureFact | string;
}

/** Recovery evidence for one failed removal (DEC-006, cf. install). */
export interface UninstallFailedProject {
  readonly canonicalProject?: string;
  readonly project: string;
  readonly profile: string;
  readonly detail: string;
  /** The previous selection still names this Project after recovery. */
  readonly selectionRestored: boolean;
  /** The restoration failure, when restoring itself failed. */
  readonly restoreError?: string;
  /** True when another writer owns the current selection, left untouched. */
  readonly concurrentSelectionChange: boolean;
}

export interface UninstallUnattemptedProject {
  readonly canonicalProject?: string;
  readonly project: string;
  readonly profile: string;
}

export interface UninstallApplicationResult {
  readonly completed: readonly UninstallCompletedProject[];
  readonly skipped: readonly UninstallSkippedProject[];
  /** Present when an unexpected failure stopped further work. */
  readonly failed?: UninstallFailedProject;
  readonly unattempted: readonly UninstallUnattemptedProject[];
  readonly warnings: readonly string[];
}

interface UninstallWorkItem {
  readonly canonicalProject?: string;
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
  /** Absent when no ordinary receipt names the Project: forget-only. */
  readonly receipt?: OwnershipReceipt;
}

/** Scope identity for the confirmation-to-commit comparison (INT-2):
 * canonical identity, profile, and hosts — anything the review showed. */
function uninstallScopeKey(entry: {
  readonly canonicalProject?: string;
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly string[];
}): string {
  return JSON.stringify([
    entry.canonicalProject ?? entry.project,
    entry.profile,
    [...entry.hosts].sort(),
  ]);
}

/**
 * Remove the selected installations and forget their remembered selection.
 * One recoverable transition per Project, processed sequentially in preview
 * order (DEC-006):
 *
 * - Phase A (no locks, no writes) proves removal authority per Project and
 *   runs the one shared changed-output consent gate over the whole selected
 *   scope. Refusal, decline, or cancellation throws before any lifecycle
 *   write. Projects with known ownership Blockers are skipped here while
 *   healthy Projects proceed.
 * - Phase B commits each Project under one joint boundary (the Local
 *   Configuration lock outer, the installation lifecycle lock nested — the
 *   same order as install/unbind): staged output removal, then selection
 *   forgetting, then staging commit. The binding and receipt are forgotten
 *   only after that Project's removal succeeds. An unexpected write failure
 *   stops further work: completed Projects stay completed, the failed
 *   Project restores its previous selection/output where possible, and the
 *   rest report as unattempted with a concrete scope-preserving retry.
 */
export async function executeUninstall(
  home: string,
  options: ExecuteUninstallOptions = {},
): Promise<UninstallApplicationResult> {
  const fileSystem = options.bindFileSystem ?? bindDefaultFileSystem;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const configurationPath = localConfigurationPath(home);
  const writeState = options.writeInstallationState ?? writeInstallationState;
  const createGitInspection = options.createGitInspection ?? createLifecycleGitInspectionContext;
  const createOwnershipInspection = options.createOwnershipInspection ??
    createLifecycleOwnershipInspectionContext;
  const removeAuthorized = options.removeChanged === true;

  const preview = await previewUninstall(home, options);
  if (options.confirmedPreview !== undefined) {
    const confirmed = options.confirmedPreview.projects.map(uninstallScopeKey).sort();
    const fresh = preview.projects.map(uninstallScopeKey).sort();
    if (confirmed.length !== fresh.length || confirmed.some((key, index) => key !== fresh[index])) {
      throw new UninstallScopeChangedError(
        preview.projects.map((entry) => ({
          ...(entry.canonicalProject === undefined
            ? {}
            : { canonicalProject: entry.canonicalProject }),
          project: entry.project,
        })),
      );
    }
  }
  if (preview.projects.length === 0) {
    return { completed: [], skipped: [], unattempted: [], warnings: [] };
  }
  const before = await readInstallationState(home);
  const receiptsByProject = new Map(
    ordinaryReceipts(before).map((receipt) => [receipt.project, receipt]),
  );
  const items: UninstallWorkItem[] = [];
  for (const entry of preview.projects) {
    const base = {
      ...(entry.canonicalProject === undefined
        ? {}
        : { canonicalProject: entry.canonicalProject }),
      project: entry.project,
      profile: entry.profile,
      hosts: entry.hosts,
    };
    // Deleted roots resolve through their surviving ancestors to rejoin
    // their receipt, so forgetting removes the record together with the
    // binding instead of orphaning it.
    const effective = await removalCanonicalProject(home, base).catch(() => undefined);
    const receipt = effective === undefined ? undefined : receiptsByProject.get(effective);
    items.push(receipt === undefined ? base : { ...base, receipt });
  }

  const gitInspection = createGitInspection();
  const phaseAOwnership = createOwnershipInspection();
  const skipped: UninstallSkippedProject[] = [];
  const blockedProjects = new Set<string>();
  const reportProjects: ReconciliationProjectRecord[] = [];
  const workable: UninstallWorkItem[] = [];
  for (const item of items) {
    if (item.receipt === undefined) {
      // No ordinary receipt names this Project: nothing to remove, the
      // commit only forgets the binding.
      workable.push(item);
      continue;
    }
    const proof = await proveOwnedInstallation(item.receipt, phaseAOwnership, gitInspection);
    if (!proof.owned) {
      // A known Project Blocker: skip while healthy Projects proceed.
      skipped.push({
        ...(item.canonicalProject === undefined ? {} : { canonicalProject: item.canonicalProject }),
        project: item.project,
        profile: item.profile,
        reason: proof.failure ?? "unproven",
      });
      blockedProjects.add(item.receipt.project);
      continue;
    }
    reportProjects.push(await removalReportProject(item.receipt, item.project, phaseAOwnership));
    workable.push(item);
  }

  // One invocation-wide consent gate (DEC-005): reached only after the
  // ownership checks above, so no consent can bypass a Blocker; placed
  // before the first write, so refusal, decline, or cancellation leaves
  // every selected Project untouched. Uninstall performs no replacements,
  // so only deletion needs authorization.
  const consent = await resolveChangedOutputConsent({
    before,
    blockedProjects,
    ...(options.confirmChangedOutputReplacement === undefined
      ? {}
      : { confirmChangedOutputReplacement: options.confirmChangedOutputReplacement }),
    desired: [],
    ownershipInspection: phaseAOwnership,
    removeAuthorized,
    replaceAuthorized: false,
    report: { globalBlockers: [], projects: reportProjects },
  });

  const completed: UninstallCompletedProject[] = [];
  const warnings: string[] = [];
  let workingState = before;
  let failed: UninstallFailedProject | undefined;
  let failedIndex = workable.length;
  for (const [index, item] of workable.entries()) {
    const pendingAfter = workable.slice(index + 1).map((entry) => ({
      ...(entry.canonicalProject === undefined
        ? {}
        : { canonicalProject: entry.canonicalProject }),
      project: entry.project,
      profile: entry.profile,
    }));
    const outcome = await commitUninstallProject(home, {
      bindFileSystem: fileSystem,
      completedProjects: completed.map((entry) => entry.canonicalProject ?? entry.project),
      confirmState: workingState,
      createOwnershipInspection,
      gitInspection,
      item,
      lockTimeoutMs,
      pendingAfter,
      removeAuthorized,
      reviewedScope: consent.reviewedScope,
      writeState,
    });
    workingState = outcome.state;
    if ("completed" in outcome) {
      completed.push(outcome.completed);
      if (outcome.warning !== undefined) warnings.push(outcome.warning);
      continue;
    }
    if ("skipped" in outcome) {
      skipped.push(outcome.skipped);
      continue;
    }
    failed = outcome.failed;
    failedIndex = index;
    break;
  }

  // Best-effort exclusion cleanup from the surviving receipts, mirroring the
  // previous uninstall surface: a failure produces warnings and never stalls
  // teardown or changes the outcome.
  try {
    const publication = await publishRepositoryExclusions(workingState, {
      gitInspection,
      previousState: before,
    });
    warnings.push(...publication.warnings.map((warning) => flatInlineText(warning.parts)));
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }

  return {
    completed,
    skipped,
    ...(failed === undefined ? {} : { failed }),
    unattempted: workable.slice(failedIndex + (failed === undefined ? 0 : 1)).map((entry) => ({
      ...(entry.canonicalProject === undefined
        ? {}
        : { canonicalProject: entry.canonicalProject }),
      project: entry.project,
      profile: entry.profile,
    })),
    warnings: [...new Set(warnings)].sort(),
  };
}

/** One removal-review record for the shared consent gate (DEC-005): every
 * recorded output as a `removal` kind, classified by live inspection through
 * the same ownership proof the update path uses — no second policy. */
async function removalReportProject(
  receipt: OwnershipReceipt,
  authoredProject: string,
  ownership: LifecycleOwnershipInspection,
): Promise<ReconciliationProjectRecord> {
  const outputs: ReconciliationProjectOutput[] = [];
  for (const recorded of receipt.outputs) {
    const inspected = await ownership.inspectOutput(receipt.project, recorded);
    outputs.push({
      consumingHosts: [],
      ...(recordedOutputMatches(inspected, recorded)
        ? {}
        : inspected.kind === "missing"
          ? { driftKind: "missing" as const }
          : { driftKind: "changed" as const }),
      kind: "removal",
      path: recorded.path,
    });
  }
  return {
    blockers: [],
    canonicalProject: receipt.project,
    outputs,
    project: authoredProject,
    repositoryExclusions: [],
    setupSteps: [],
    state: { kind: "removal" },
    warnings: [],
  };
}

interface CommitUninstallProjectOptions {
  readonly bindFileSystem: BindProjectFileSystem;
  readonly completedProjects: readonly string[];
  readonly confirmState: OwnershipState;
  readonly createOwnershipInspection: () => LifecycleOwnershipInspection;
  readonly gitInspection: LifecycleGitInspection;
  readonly item: UninstallWorkItem;
  readonly lockTimeoutMs: number;
  readonly pendingAfter: readonly { readonly canonicalProject?: string; readonly project: string }[];
  readonly removeAuthorized: boolean;
  readonly reviewedScope: ReadonlyMap<string, ChangedOutputComparison>;
  readonly writeState: typeof writeInstallationState;
}

type CommitUninstallProjectOutcome =
  | {
      readonly state: OwnershipState;
      readonly completed: UninstallCompletedProject;
      readonly warning?: string;
    }
  | { readonly state: OwnershipState; readonly skipped: UninstallSkippedProject }
  | { readonly state: OwnershipState; readonly failed: UninstallFailedProject };

/** Canonical removal identity: the receipt's recorded root, else the
 * binding's canonical root, else reconstructed from the authored spelling
 * (deleted roots resolve through their surviving ancestors). */
async function removalCanonicalProject(home: string, item: UninstallWorkItem): Promise<string> {
  if (item.receipt !== undefined) return item.receipt.project;
  if (item.canonicalProject !== undefined) return item.canonicalProject;
  return canonicalizePathForComparison(
    expandConfiguredPath(
      item.project,
      home,
      { source: "local-configuration", configurationPath: localConfigurationPath(home) },
      "project",
    ),
  );
}

function failedProjectResult(
  item: UninstallWorkItem,
  canonicalProject: string,
  failure: {
    readonly detail: string;
    readonly selectionRestored: boolean;
    readonly restoreError?: string;
    readonly concurrentSelectionChange: boolean;
  },
): UninstallFailedProject {
  return {
    canonicalProject,
    project: item.project,
    profile: item.profile,
    detail: failure.detail,
    selectionRestored: failure.selectionRestored,
    ...(failure.restoreError === undefined ? {} : { restoreError: failure.restoreError }),
    concurrentSelectionChange: failure.concurrentSelectionChange,
  };
}

/** Every recorded root is already absent from disk: a vanished Project
 * root converges instead of failing the removal it trivially completes. */
async function allRecordedOutputsAbsent(receipt: OwnershipReceipt): Promise<boolean> {
  for (const recorded of receipt.outputs) {
    try {
      await lstat(join(receipt.project, recorded.path));
      return false;
    } catch (error) {
      if (
        error instanceof Error && "code" in error &&
        (error.code === "ENOENT" || error.code === "ENOTDIR")
      ) {
        continue;
      }
      return false;
    }
  }
  return true;
}

async function commitUninstallProject(
  home: string,
  options: CommitUninstallProjectOptions,
): Promise<CommitUninstallProjectOutcome> {
  const { item } = options;
  const configurationPath = localConfigurationPath(home);
  const fileSystem = options.bindFileSystem;

  let canonicalProject: string;
  try {
    canonicalProject = await removalCanonicalProject(home, item);
  } catch (error) {
    return {
      state: options.confirmState,
      failed: failedProjectResult(item, item.canonicalProject ?? item.project, {
        detail: error instanceof Error ? error.message : String(error),
        selectionRestored: true,
        concurrentSelectionChange: false,
      }),
    };
  }

  // No ordinary receipt names this Project: the commit only forgets the
  // binding under the joint boundary; there is no output to stage.
  if (item.receipt === undefined) {
    return commitForgetOnly(home, options, configurationPath, canonicalProject);
  }

  const receipt = item.receipt;
  // The destructive work happens inside the joint boundary (the same lock
  // order as install): the Local Configuration lock outer, the installation
  // lifecycle lock nested. The per-Project proof, changed-file
  // authorization, and output staging all run under both locks, so a
  // concurrent install or update cannot regenerate output mid-staging and
  // leave it ownerless; the binding and receipt are forgotten only after
  // the staged removal proves the output is gone from its live roots, with
  // rollback in the same boundary.
  try {
    return await withConfigurationLock(
      configurationPath,
      fileSystem,
      options.lockTimeoutMs,
      "uninstall",
      () =>
        withInstallationLifecycleLock(home, "uninstall", async () => {
          // Fresh ownership proof immediately before the first mutation,
          // plus changed-file authorization against the reviewed bytes
          // (cf. update's proveProjectWrites). A newly Blocked Project is
          // skipped while healthy Projects proceed; drift that was never
          // authorized stops the invocation with its partial outcome, like
          // update's late consent refusal.
          const ownership = options.createOwnershipInspection();
          const proof = await proveOwnedInstallation(receipt, ownership, options.gitInspection);
          if (!proof.owned) {
            return {
              state: await readInstallationState(home),
              skipped: {
                canonicalProject,
                project: item.project,
                profile: item.profile,
                reason: proof.failure ?? "unproven",
              },
            };
          }
          const newlyChanged: string[] = [];
          for (const recorded of receipt.outputs) {
            const inspected = await ownership.inspectOutput(receipt.project, recorded);
            if (recordedOutputMatches(inspected, recorded)) continue;
            if (inspected.kind === "missing") continue;
            const review = options.reviewedScope.get(`${receipt.project}\0${recorded.path}`);
            if (
              review !== undefined &&
              comparisonMatchesDigests(review, liveDigestFor(inspected, recorded.type), "deletion")
            ) {
              continue;
            }
            if (options.removeAuthorized) continue;
            newlyChanged.push(recorded.path);
          }
          if (newlyChanged.length > 0) {
            throw new ApplyConsentRequiredError(
              ["remove"],
              [{
                canonicalProject: receipt.project,
                changedOutputs: [],
                project: item.project,
                removedOutputs: newlyChanged.sort(),
              }],
              {
                completedProjects: [...options.completedProjects],
                failedProject: { canonicalProject: receipt.project, project: item.project },
                pendingProjects: options.pendingAfter.map((entry) => ({
                  canonicalProject: entry.canonicalProject ?? entry.project,
                  project: entry.project,
                })),
              },
            );
          }

          let transaction: ProvenInstallationRemovalTransaction | undefined;
          try {
            transaction = await stageProvenInstallationRemoval(receipt, ownership, options.gitInspection);
          } catch (error) {
            if (error instanceof OwnershipBlockedRemovalError) {
              return {
                state: await readInstallationState(home),
                skipped: {
                  canonicalProject,
                  project: item.project,
                  profile: item.profile,
                  reason: error.failure,
                },
              };
            }
            if (error instanceof StagedRollbackFailureError) {
              // Staged bytes are retained while the records are untouched:
              // the restoration failure is explicit and nothing was forgotten.
              const detail = error.message;
              return {
                state: await readInstallationState(home),
                failed: failedProjectResult(item, canonicalProject, {
                  detail,
                  selectionRestored: true,
                  restoreError: detail,
                  concurrentSelectionChange: false,
                }),
              };
            }
            // A vanished root converges: staging rolls itself back on
            // partial failure, so absent recorded roots mean nothing
            // remains to remove.
            if (await allRecordedOutputsAbsent(receipt)) {
              transaction = {
                commit: async () => undefined,
                rollback: async () => undefined,
              };
            } else {
              const detail = error instanceof Error ? error.message : String(error);
              return {
                state: await readInstallationState(home),
                failed: failedProjectResult(item, canonicalProject, {
                  detail,
                  selectionRestored: true,
                  concurrentSelectionChange: false,
                }),
              };
            }
          }

          try {
            const joint = await readJointUninstallSnapshot(
              home,
              fileSystem,
              configurationPath,
              item,
              canonicalProject,
            );
            if (joint.converged) {
              // A concurrent run completed this removal while its outputs
              // were staged here: committing drops the staged bytes and the
              // outcome reports the completed removal truthfully.
              let warning: string | undefined;
              try {
                await transaction!.commit();
              } catch (error) {
                warning = error instanceof Error ? error.message : String(error);
              }
              return {
                state: joint.state,
                completed: {
                  canonicalProject,
                  project: item.project,
                  profile: item.profile,
                  outputs: receipt.outputs.map((output) => output.path).sort(),
                },
                ...(warning === undefined ? {} : { warning }),
              };
            }
            const nextSource = joint.splice();
            const sourceStats = await fileSystem.stat(configurationPath);
            const mode = sourceStats.mode & 0o777;
            await publishConfigurationReplacement(
              configurationPath,
              joint.source,
              nextSource,
              mode,
              fileSystem,
              `Local Configuration ${configurationPath}`,
              "uninstall",
            );
            let publishedState: OwnershipState;
            try {
              publishedState = withReceipts(
                joint.state,
                joint.state.receipts.filter(
                  (entry) => entry.installationId !== receipt.installationId,
                ),
              );
              await options.writeState(home, publishedState);
            } catch (error) {
              // The binding is already forgotten: restore it from the exact
              // source snapshot so a failed uninstall mutates nothing.
              let restoreError: string | undefined;
              try {
                await publishConfigurationReplacement(
                  configurationPath,
                  nextSource,
                  joint.source,
                  mode,
                  fileSystem,
                  `Local Configuration ${configurationPath}`,
                  "uninstall",
                );
              } catch (restoreFailure) {
                restoreError = restoreFailure instanceof Error
                  ? restoreFailure.message
                  : String(restoreFailure);
              }
              throw new UninstallRestoreError(
                error instanceof Error ? error.message : String(error),
                restoreError,
              );
            }
            let warning: string | undefined;
            try {
              await transaction!.commit();
            } catch (error) {
              // The output is removed and the selection forgotten; only
              // staging cleanup failed. Success stands with an explicit warning.
              warning = error instanceof Error ? error.message : String(error);
            }
            return {
              state: publishedState,
              completed: {
                canonicalProject,
                project: item.project,
                profile: item.profile,
                outputs: receipt.outputs.map((output) => output.path).sort(),
              },
              ...(warning === undefined ? {} : { warning }),
            };
          } catch (error) {
            if (error instanceof UninstallConcurrentChangeError) {
              let restoreError: string | undefined;
              try {
                await transaction!.rollback();
              } catch (rollbackFailure) {
                restoreError = rollbackFailure instanceof Error
                  ? rollbackFailure.message
                  : String(rollbackFailure);
              }
              return {
                state: await readInstallationState(home),
                failed: failedProjectResult(item, canonicalProject, {
                  detail: restoreError === undefined
                    ? error.message
                    : `${error.message}\n${restoreError}`,
                  selectionRestored: true,
                  ...(restoreError === undefined ? {} : { restoreError }),
                  concurrentSelectionChange: true,
                }),
              };
            }
            let restoreError: string | undefined;
            if (error instanceof UninstallRestoreError) {
              restoreError = error.restoreError;
            }
            try {
              await transaction!.rollback();
            } catch (rollbackFailure) {
              const detail = rollbackFailure instanceof Error
                ? rollbackFailure.message
                : String(rollbackFailure);
              restoreError = restoreError === undefined ? detail : `${restoreError}\n${detail}`;
            }
            const detail = error instanceof Error ? error.message : String(error);
            return {
              state: await readInstallationState(home),
              failed: failedProjectResult(item, canonicalProject, {
                detail,
                // The binding was restored unless its restoration itself
                // failed; the receipt was never deleted because its write
                // did not succeed.
                selectionRestored: restoreError === undefined,
                ...(restoreError === undefined ? {} : { restoreError }),
                concurrentSelectionChange: false,
              }),
            };
          }
        }, { lockTimeoutMs: options.lockTimeoutMs }),
    );
  } catch (error) {
    // The late consent refusal carries its partial outcome to the command
    // layer; lock-acquisition failures stop before anything was staged.
    if (error instanceof ApplyConsentRequiredError) throw error;
    return {
      state: options.confirmState,
      failed: failedProjectResult(item, canonicalProject, {
        detail: error instanceof Error ? error.message : String(error),
        selectionRestored: true,
        concurrentSelectionChange: false,
      }),
    };
  }
}

/** A concurrent writer owns the current selection, which was left untouched. */
class UninstallConcurrentChangeError extends Error {
  constructor(project: string) {
    super(
      `the Project selection for ${project} changed while uninstalling; it was left untouched — re-run uninstall for the current selection`,
    );
    this.name = "UninstallConcurrentChangeError";
  }
}

/** A record write failed after the binding was already forgotten. */
class UninstallRestoreError extends Error {
  readonly restoreError: string | undefined;

  constructor(message: string, restoreError: string | undefined) {
    super(message);
    this.name = "UninstallRestoreError";
    this.restoreError = restoreError;
  }
}

interface JointUninstallSnapshot {
  readonly source: string;
  readonly splice: () => string;
  readonly index: number;
  readonly state: OwnershipState;
}

/**
 * Re-read the binding and receipt under the joint lock and verify this
 * Project still owns the snapshotted selection (cf. install's snapshot
 * re-verification). A concurrent change throws instead of overwriting; a
 * concurrently completed removal reports converged.
 */
async function readJointUninstallSnapshot(
  home: string,
  fileSystem: BindProjectFileSystem,
  configurationPath: string,
  item: UninstallWorkItem,
  canonicalProject: string,
): Promise<{ readonly converged: true; readonly state: OwnershipState } | (JointUninstallSnapshot & { readonly converged?: false })> {
  let source: string;
  try {
    source = await fileSystem.readFile(configurationPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new InstallerToolError({
        kind: "missing-local-configuration",
        path: configurationPath,
      });
    }
    throw error;
  }
  const parsed = requireCurrentApplicationConfiguration(
    parseLocalConfiguration(source, configurationPath),
    configurationPath,
  );
  const bindings = await normalizeProjectBindings(home, parsed.bindings, configurationPath, {
    allowMissingProjects: true,
    kind: "application",
    profiles: new Map(),
    requireProfiles: false,
  });
  const index = bindings.findIndex(
    (binding) =>
      binding.canonicalProject === canonicalProject ||
      (binding.missing && binding.project === item.project),
  );
  const state = await readInstallationState(home);
  const currentReceipt = item.receipt === undefined
    ? undefined
    : ordinaryReceipts(state).find((entry) => entry.installationId === item.receipt!.installationId);
  if (index === -1) {
    // Forgotten by a concurrent run: converged when its receipt is gone too.
    if (currentReceipt === undefined) return { converged: true as const, state };
    throw new UninstallConcurrentChangeError(item.project);
  }
  const current = bindings[index]!;
  if (
    current.profile !== item.profile ||
    current.project !== item.project ||
    !hostsEqual(current.hosts, item.hosts)
  ) {
    throw new UninstallConcurrentChangeError(item.project);
  }
  const document = parseDocument(source);
  const bindingsNode = document.get("bindings");
  if (!isSeq(bindingsNode)) {
    throw new Error("Local Configuration bindings must be an array");
  }
  return {
    source,
    splice: () => removeBindingSourceEntry(source, bindingsNode, index),
    index,
    state,
  };
}

async function commitForgetOnly(
  home: string,
  options: CommitUninstallProjectOptions,
  configurationPath: string,
  canonicalProject: string,
): Promise<CommitUninstallProjectOutcome> {
  const { item } = options;
  const fileSystem = options.bindFileSystem;
  const completed = {
    canonicalProject,
    project: item.project,
    profile: item.profile,
    outputs: [] as readonly string[],
  };
  try {
    await withConfigurationLock(
      configurationPath,
      fileSystem,
      options.lockTimeoutMs,
      "uninstall",
      () =>
        withInstallationLifecycleLock(home, "uninstall", async () => {
          const joint = await readJointUninstallSnapshot(
            home,
            fileSystem,
            configurationPath,
            item,
            canonicalProject,
          );
          if (joint.converged) return;
          const nextSource = joint.splice();
          const sourceStats = await fileSystem.stat(configurationPath);
          const mode = sourceStats.mode & 0o777;
          await publishConfigurationReplacement(
            configurationPath,
            joint.source,
            nextSource,
            mode,
            fileSystem,
            `Local Configuration ${configurationPath}`,
            "uninstall",
          );
        }, { lockTimeoutMs: options.lockTimeoutMs }),
    );
    return { state: options.confirmState, completed };
  } catch (error) {
    if (error instanceof UninstallConcurrentChangeError) {
      return {
        state: options.confirmState,
        failed: failedProjectResult(item, canonicalProject, {
          detail: error.message,
          selectionRestored: true,
          concurrentSelectionChange: true,
        }),
      };
    }
    return {
      state: options.confirmState,
      failed: failedProjectResult(item, canonicalProject, {
        detail: error instanceof Error ? error.message : String(error),
        selectionRestored: true,
        concurrentSelectionChange: false,
      }),
    };
  }
}
