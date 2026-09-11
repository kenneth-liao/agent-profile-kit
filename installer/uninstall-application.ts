/**
 * Uninstall selection and removal (spec #491 US-003/US-004/US-006/US-007/
 * US-008, DEC-001/DEC-003–DEC-006/DEC-014, tickets #496–#498): remove
 * selected Project installations and forget their remembered selection in
 * one per-Project transition, or narrow individual Hosts within it.
 *
 * Whole-removal selection reads Local Configuration bindings without
 * resolving the Workspace, so recovery stays independent of valid source.
 * Scope is explicit (`--here`, `--project`, `--all`, mutually exclusive)
 * intersected by `--profile`; `--host` narrows removal to those Hosts
 * within the selected scope. An absent scope selects nothing, never all
 * Projects. Removal and forgetting stay one transition per Project: the
 * binding and its receipt are forgotten only after that Project's removal
 * succeeds.
 *
 * A `--host` partial removal re-plans the surviving Hosts from the
 * Workspace (whole-removal stays workspace-independent):
 * `planSurvivingInstallation` is the one surviving-set computation feeding
 * remembered-state update, retention decisions, receipt deltas, and
 * reporting — no second derivation exists. Only output no longer required
 * by the remaining Hosts is removed (DEC-014 whole-file ownership
 * unchanged); removing the last Host routes through the complete-uninstall
 * result path.
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

import {
  isSupportedHost,
  parseLocalConfiguration,
  SUPPORTED_HOSTS,
  type SupportedHost,
} from "../schemas/local-configuration.js";
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
  updateBindingHostsSourceEntry,
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
  ApplyReviewStaleError,
  liveDigestFor,
  ownedOutputFromDesired,
  plannedDigestFor,
  resolveChangedOutputConsent,
  type ChangedOutputConsentAnswer,
  type ChangedOutputConsentRequest,
  type ReconciliationProjectOutput,
  type ReconciliationProjectRecord,
} from "./reconcile.js";
import {
  canonicalizePathForComparison,
  expandConfiguredPath,
  ingestSelectedWorkspace,
  isSameOrDescendant,
  localConfigurationPath,
  normalizeProjectBindings,
  ProjectTargetError,
  readLocalConfigurationSource,
  requireCurrentApplicationConfiguration,
  type IngestedProjectBinding,
} from "./local-configuration.js";
import {
  hashBytes,
  planDesiredInstallations,
  type DesiredInstallation,
  type DesiredProjectOutput,
} from "./project-plan.js";
import type { Workspace } from "./ingest-workspace.js";
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
  /** Narrow removal to these Hosts within the selected scope (`--host`, repeatable). */
  readonly hosts?: readonly string[];
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
  /**
   * Requested Hosts bound by this Project, in `SUPPORTED_HOSTS` order.
   * Present only when a `--host` filter selected this Project (which then
   * guarantees a non-empty intersection); absent means whole-removal.
   */
  readonly removeHosts?: readonly SupportedHost[];
  /** The bound root no longer exists: removal is trivially complete. */
  readonly missing: boolean;
}

/**
 * Normalize requested `--host` values to the deterministic
 * `SUPPORTED_HOSTS` order (the same boundary as install's Host
 * normalization). Unknown Hosts throw the shared `unsupported-host` fact
 * before any write, so presentation suggests the supported names.
 */
export function normalizeUninstallHosts(hosts: readonly string[]): readonly SupportedHost[] {
  if (hosts.length === 0) {
    throw new InstallerToolError({
      kind: "install-host-required",
      supportedHosts: SUPPORTED_HOSTS,
    });
  }
  const seen = new Set<SupportedHost>();
  for (const host of hosts) {
    if (!isSupportedHost(host)) {
      throw new InstallerToolError({
        kind: "unsupported-host",
        host,
        supportedHosts: SUPPORTED_HOSTS,
      });
    }
    seen.add(host);
  }
  return SUPPORTED_HOSTS.filter((host) => seen.has(host));
}

/**
 * The surviving Host selection after removing `removeHosts` from `bound`:
 * one pure set subtraction in `SUPPORTED_HOSTS` order. The partial-removal
 * plan, retention partition, receipt delta, and report all derive from the
 * `planSurvivingInstallation` result built on this set — never recomputed.
 */
export function survivingHostsForRemoval(
  bound: readonly SupportedHost[],
  removeHosts: readonly SupportedHost[],
): readonly SupportedHost[] {
  const removed = new Set(removeHosts);
  return bound.filter((host) => !removed.has(host));
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

function toPreviewProject(
  binding: IngestedProjectBinding,
  removeHosts?: readonly SupportedHost[],
): UninstallPreviewProject {
  return {
    ...(binding.canonicalProject === undefined
      ? {}
      : { canonicalProject: binding.canonicalProject }),
    project: binding.project,
    profile: binding.profile,
    hosts: binding.hosts,
    ...(removeHosts === undefined ? {} : { removeHosts }),
    missing: binding.missing,
  };
}

/**
 * Resolve the uninstall scope to bound Projects without writing anything and
 * without resolving the Workspace. Profile membership intersects the scope
 * and never broadens it, and `--host` narrows each Project to its requested
 * bound Hosts: a filter matching nothing resolves to an empty preview,
 * which the command layer reports truthfully with no writes.
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

  // Scope-resolution errors precede filter intersection (DEC-003): an
  // unbound or ambiguous `--here`/`--project` target throws before
  // `--profile` is applied. The filter intersects the selected scope — a
  // scope that fails to resolve selects nothing to intersect — so a
  // location ambiguity is never silently resolved by the filter into a
  // removal the review never showed.
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
  // `--host` narrows removal to those Hosts within the selected scope
  // (DEC-003): a filter matching no bound Host of a Project drops that
  // Project, never broadens to its whole installation. Unknown Hosts fail
  // before any write through the shared normalization boundary.
  const narrowed = new Map<IngestedProjectBinding, readonly SupportedHost[]>();
  if (options.hosts !== undefined) {
    const requested = new Set(normalizeUninstallHosts(options.hosts));
    for (const binding of selected) {
      const bound = binding.hosts.filter((host) => requested.has(host));
      if (bound.length > 0) narrowed.set(binding, bound);
    }
    selected = [...narrowed.keys()];
    // A vanished root has no survivors to serve: its teardown converges
    // to forgetting like whole-removal of vanished roots, instead of
    // narrowing a selection for a Project that is gone.
    for (const binding of [...narrowed.keys()]) {
      if (binding.missing) narrowed.delete(binding);
    }
  }
  return {
    projects: [...selected]
      .map((binding) => toPreviewProject(binding, narrowed.get(binding)))
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
   * Explicit replacement authorization (DEC-005): answers rewrites of
   * retained shared output that discard independent changes on the
   * `--host` partial path. Never answers the general confirmation, which
   * lives in the command layer (DEC-004).
   */
  readonly replaceChanged?: boolean;
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
   * replacement scope (whole-removal performs no replacements) and never
   * answers the general confirmation, which lives in the command layer
   * (DEC-004).
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
  /**
   * Hosts removed by a `--host` partial removal, in `SUPPORTED_HOSTS`
   * order. Absent on the whole-removal path (and on a last-Host removal,
   * which uses the complete-uninstall result). Retained shared output is
   * not listed: only deletions are.
   */
  readonly removedHosts?: readonly SupportedHost[];
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
  /** Requested bound Hosts (`--host` filter); absent means whole-removal. */
  readonly removeHosts?: readonly SupportedHost[];
  /** Absent when no ordinary receipt names the Project: forget-only. */
  readonly receipt?: OwnershipReceipt;
}

/** A partial item whose surviving Host set is non-empty (last-Host removal
 * stays on the complete path). */
function isPartialWorkItem(item: UninstallWorkItem): boolean {
  return item.removeHosts !== undefined &&
    survivingHostsForRemoval(item.hosts, item.removeHosts).length > 0;
}

/** Scope identity for the confirmation-to-commit comparison (INT-2):
 * canonical identity, profile, hosts, and removed Hosts — anything the
 * review showed. */
function uninstallScopeKey(entry: {
  readonly canonicalProject?: string;
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly string[];
  readonly removeHosts?: readonly string[];
}): string {
  return JSON.stringify([
    entry.canonicalProject ?? entry.project,
    entry.profile,
    [...entry.hosts].sort(),
    [...(entry.removeHosts ?? [])].sort(),
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
  const replaceAuthorized = options.replaceChanged === true;

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
      ...(entry.removeHosts === undefined ? {} : { removeHosts: entry.removeHosts }),
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
  // Surviving-Host plans keyed by receipt canonical Project: the one
  // computation per partial Project feeding the consent report, the
  // commit-time authorization, retention, receipt delta, and reporting.
  const survivingPlans = new Map<string, SurvivingHostPlan>();
  const desiredInstallations: DesiredInstallation[] = [];
  // The Workspace resolves only when a partial removal needs it (A2):
  // whole-removal never touches source, and an unresolvable Workspace
  // skips the partial Projects explicitly instead of guessing retention.
  let workspace: Workspace | undefined;
  let workspaceFailure: string | undefined;
  const skipItem = (
    item: UninstallWorkItem,
    reason: OwnershipFailureFact | string,
    receiptProject?: string,
  ): void => {
    skipped.push({
      ...(item.canonicalProject === undefined ? {} : { canonicalProject: item.canonicalProject }),
      project: item.project,
      profile: item.profile,
      reason,
    });
    if (receiptProject !== undefined) blockedProjects.add(receiptProject);
  };
  for (const item of items) {
    if (item.receipt === undefined) {
      // No ordinary receipt names this Project: nothing to remove. A
      // whole-removal commit only forgets the binding; a partial commit
      // only narrows its remembered Hosts.
      workable.push(item);
      continue;
    }
    const proof = await proveOwnedInstallation(item.receipt, phaseAOwnership, gitInspection);
    if (!proof.owned) {
      // A known Project Blocker: skip while healthy Projects proceed.
      skipItem(item, proof.failure ?? "unproven", item.receipt.project);
      continue;
    }
    if (!isPartialWorkItem(item)) {
      reportProjects.push(await removalReportProject(item.receipt, item.project, phaseAOwnership));
      workable.push(item);
      continue;
    }
    // Partial path: re-plan the survivors once (Phase A, no writes). A
    // planning failure skips this Project explicitly with recovery —
    // retention is never guessed.
    if (workspace === undefined && workspaceFailure === undefined) {
      try {
        workspace = await ingestSelectedWorkspace(home);
      } catch (error) {
        workspaceFailure = error instanceof Error ? error.message : String(error);
      }
    }
    if (workspace === undefined) {
      skipItem(
        item,
        `cannot plan the surviving Hosts without the Workspace (${workspaceFailure ?? "unavailable"}); fix the Workspace selection or remove the whole installation instead`,
        item.receipt.project,
      );
      continue;
    }
    try {
      const plan = await planSurvivingInstallation(home, workspace, item, item.receipt);
      await assertSurvivorAdditionsFree(item.receipt, plan, item.project);
      survivingPlans.set(item.receipt.project, plan);
      desiredInstallations.push(plan.desired);
      reportProjects.push(
        await partialRemovalReportProject(item.receipt, item.project, item.removeHosts!, plan, phaseAOwnership),
      );
      workable.push(item);
    } catch (error) {
      skipItem(
        item,
        `cannot plan the surviving Hosts: ${error instanceof Error ? error.message : String(error)}`,
        item.receipt.project,
      );
    }
  }

  // One invocation-wide consent gate (DEC-005): reached only after the
  // ownership checks above, so no consent can bypass a Blocker; placed
  // before the first write, so refusal, decline, or cancellation leaves
  // every selected Project untouched. Whole-removal performs no
  // replacements, so only deletion needs authorization there; the partial
  // path additionally authorizes survivor rewrites through
  // `--replace-changed`, conditional on the actual plan — clean portions
  // need no flag, because the gate only collects planned discards of
  // independently changed files (all four changed/clean × delete/rewrite
  // cells).
  const consent = await resolveChangedOutputConsent({
    before,
    blockedProjects,
    ...(options.confirmChangedOutputReplacement === undefined
      ? {}
      : { confirmChangedOutputReplacement: options.confirmChangedOutputReplacement }),
    desired: desiredInstallations,
    ownershipInspection: phaseAOwnership,
    removeAuthorized,
    replaceAuthorized,
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
    const surviving = item.receipt === undefined
      ? undefined
      : survivingPlans.get(item.receipt.project);
    const outcome = surviving === undefined
      ? await commitUninstallProject(home, {
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
      })
      : await commitPartialUninstallProject(home, {
        bindFileSystem: fileSystem,
        completedProjects: completed.map((entry) => entry.canonicalProject ?? entry.project),
        confirmState: workingState,
        createOwnershipInspection,
        gitInspection,
        item,
        lockTimeoutMs,
        pendingAfter,
        plan: surviving,
        removeAuthorized,
        replaceAuthorized,
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

/**
 * The one surviving-set computation for a partial Host removal (ticket
 * #498 risk boundary): re-plan the surviving Hosts from the Workspace and
 * return the surviving Hosts together with their desired installation.
 * Remembered-state update, retention decisions, receipt deltas, and
 * reporting all read this result — no second derivation exists, so the
 * survivor selection and the shared-output retention cannot disagree.
 */
export interface SurvivingHostPlan {
  readonly survivingHosts: readonly SupportedHost[];
  readonly desired: DesiredInstallation;
}

export async function planSurvivingInstallation(
  home: string,
  workspace: Workspace,
  item: {
    readonly project: string;
    readonly profile: string;
    readonly hosts: readonly SupportedHost[];
    readonly removeHosts?: readonly SupportedHost[];
    readonly canonicalProject?: string;
  },
  previous: OwnershipReceipt,
): Promise<SurvivingHostPlan> {
  const survivingHosts = survivingHostsForRemoval(item.hosts, item.removeHosts ?? []);
  if (survivingHosts.length === 0) {
    throw new Error("planSurvivingInstallation needs at least one surviving Host");
  }
  const canonicalProject = item.canonicalProject ?? previous.project;
  const installations = await planDesiredInstallations(
    home,
    [{
      canonicalProject,
      hosts: survivingHosts,
      profile: item.profile,
      project: item.project,
    }],
    workspace,
    { previousInstallations: [previous] },
  );
  const desired = installations[0];
  if (desired === undefined) {
    throw new Error(`surviving-Host plan produced no installation for ${item.project}`);
  }
  return { survivingHosts, desired };
}

/** Receipt evidence equals the surviving plan at one recorded path: same
 * entry type, mode, and content hash — so the root is retained byte-identical. */
function survivorOutputMatchesReceipt(
  recorded: OwnershipReceipt["outputs"][number],
  planned: DesiredProjectOutput,
): boolean {
  return recorded.type === planned.type &&
    recorded.mode === planned.mode &&
    recorded.hash === planned.hash;
}

/**
 * A survivor-planned path with no receipt is adoptable without a write
 * only when absent, or a file with byte-identical content and mode. An
 * occupied path whose bytes differ is an ownership conflict the partial
 * commit must not silently adopt or overwrite.
 */
async function isAdoptableSurvivorAddition(
  project: string,
  planned: DesiredProjectOutput,
): Promise<boolean> {
  const absolute = join(project, planned.path);
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  if (planned.type === "file" && entry.isFile()) {
    const current = await readFile(absolute);
    const currentMode = entry.mode & 0o777;
    if (hashBytes(current) === planned.hash && currentMode === planned.mode) return true;
  }
  return false;
}

/**
 * Preflight for survivor-planned paths with no receipt: an occupied path
 * whose bytes differ is an ownership conflict, so Phase A skips the
 * Project explicitly instead of guessing retention. Exported as a test
 * seam: adapter planning rarely produces additions, so integration cannot
 * deterministically occupy one.
 */
export async function assertSurvivorAdditionsFree(
  receipt: OwnershipReceipt,
  plan: SurvivingHostPlan,
  authoredProject: string,
): Promise<void> {
  const recordedPaths = new Set(receipt.outputs.map((output) => output.path));
  for (const planned of plan.desired.outputs) {
    if (recordedPaths.has(planned.path)) continue;
    if (await isAdoptableSurvivorAddition(receipt.project, planned)) continue;
    throw new Error(
      `surviving Host output '${planned.path}' for ${authoredProject} is occupied by unowned content; ` +
        `remove it or remove the whole installation instead`,
    );
  }
}

/**
 * One partial-removal review record for the shared consent gate (DEC-005):
 * recorded outputs absent from the surviving plan are `removal` (changed
 * ones need `--remove-changed`); recorded outputs the surviving plan
 * rewrites are `update` (changed ones need `--replace-changed`); retained
 * byte-identical roots are `unchanged` with no drift (no write is planned,
 * so no consent); clean rewrites carry no drift (a clean rewrite must not
 * require `--replace-changed`). Additions that Phase A proved free carry no
 * drift. Live classification reuses the same ownership inspection as the
 * whole-removal record — no second policy.
 */
async function partialRemovalReportProject(
  receipt: OwnershipReceipt,
  authoredProject: string,
  removeHosts: readonly SupportedHost[],
  plan: SurvivingHostPlan,
  ownership: LifecycleOwnershipInspection,
): Promise<ReconciliationProjectRecord> {
  const plannedByPath = new Map(plan.desired.outputs.map((output) => [output.path, output]));
  const recordedPaths = new Set(receipt.outputs.map((output) => output.path));
  const outputs: ReconciliationProjectOutput[] = [];
  for (const recorded of receipt.outputs) {
    const planned = plannedByPath.get(recorded.path);
    const inspected = await ownership.inspectOutput(receipt.project, recorded);
    if (planned === undefined) {
      outputs.push({
        consumingHosts: [...removeHosts],
        ...(recordedOutputMatches(inspected, recorded)
          ? {}
          : inspected.kind === "missing"
            ? { driftKind: "missing" as const }
            : { driftKind: "changed" as const }),
        kind: "removal",
        path: recorded.path,
      });
      continue;
    }
    if (survivorOutputMatchesReceipt(recorded, planned)) {
      outputs.push({
        consumingHosts: [...planned.consumingHosts],
        kind: "unchanged",
        path: recorded.path,
      });
      continue;
    }
    outputs.push({
      consumingHosts: [...planned.consumingHosts],
      ...(recordedOutputMatches(inspected, recorded)
        ? {}
        : inspected.kind === "missing"
          ? { driftKind: "missing" as const }
          : { driftKind: "changed" as const }),
      kind: "update",
      path: recorded.path,
    });
  }
  for (const planned of plan.desired.outputs) {
    if (recordedPaths.has(planned.path)) continue;
    outputs.push({
      consumingHosts: [...planned.consumingHosts],
      kind: "addition",
      path: planned.path,
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

interface CommitPartialUninstallProjectOptions {
  readonly bindFileSystem: BindProjectFileSystem;
  readonly completedProjects: readonly string[];
  readonly confirmState: OwnershipState;
  readonly createOwnershipInspection: () => LifecycleOwnershipInspection;
  readonly gitInspection: LifecycleGitInspection;
  readonly item: UninstallWorkItem;
  readonly lockTimeoutMs: number;
  readonly pendingAfter: readonly { readonly canonicalProject?: string; readonly project: string }[];
  /** The one surviving-set computation this commit serves (never re-derived). */
  readonly plan: SurvivingHostPlan;
  readonly removeAuthorized: boolean;
  readonly replaceAuthorized: boolean;
  readonly reviewedScope: ReadonlyMap<string, ChangedOutputComparison>;
  readonly writeState: typeof writeInstallationState;
}

/** One staged partial transition: moved prior roots restore on rollback,
 * newly written roots are removed, and the staging tree is cleaned up. */
interface StagedPartialTransition {
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

async function writeStagedDesiredOutput(
  staged: string,
  output: DesiredProjectOutput,
): Promise<{ readonly memberDirectories: readonly string[] } | undefined> {
  if (output.type === "file") {
    await mkdir(dirname(staged), { recursive: true });
    await writeFile(staged, output.bytes, { mode: output.mode });
    await chmod(staged, output.mode);
    return undefined;
  }
  await mkdir(staged, { recursive: true });
  const members = [...output.members].sort((left, right) => left.path.localeCompare(right.path));
  for (const member of members) {
    const memberPath = join(staged, member.path);
    if (member.type === "directory") {
      await mkdir(memberPath, { recursive: true });
      continue;
    }
    await mkdir(dirname(memberPath), { recursive: true });
    await writeFile(memberPath, member.bytes, { mode: member.mode });
    await chmod(memberPath, member.mode);
  }
  return {
    memberDirectories: members
      .filter((member) => member.type === "directory")
      .map((member) => member.path),
  };
}

async function applyExactDirectoryModes(
  root: string,
  output: Extract<DesiredProjectOutput, { readonly type: "directory" }>,
): Promise<void> {
  const modes = [
    ...output.members
      .filter((member) => member.type === "directory")
      .map((member) => ({ mode: member.mode, path: member.path })),
    { mode: output.mode, path: "" },
  ].sort((left, right) => {
    const depth = right.path.split("/").filter(Boolean).length -
      left.path.split("/").filter(Boolean).length;
    return depth !== 0 ? depth : right.path.localeCompare(left.path);
  });
  for (const entry of modes) {
    await chmod(entry.path.length === 0 ? root : join(root, entry.path), entry.mode);
  }
}

/**
 * Stage one partial Host removal at root granularity (DEC-014 whole-file
 * ownership: complete roots move, never member merges): deletions move to
 * the staging tree, rewrites/additions are built staged then published
 * over a backup of the prior root. Retained byte-identical roots are
 * never touched.
 */
async function stagePartialTransition(
  project: string,
  deletions: readonly string[],
  writes: readonly DesiredProjectOutput[],
): Promise<StagedPartialTransition> {
  const stage = await mkdtemp(join(project, ".agent-profile-kit-partial-"));
  const backup = join(stage, ".backup");
  const incoming = join(stage, ".new");
  const moved: string[] = [];
  const installed: string[] = [];
  const installedTrees = new Map<string, readonly string[]>();
  let settled = false;
  const cleanup = async (): Promise<void> => {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  };
  const rollback = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    const restoreFailures: unknown[] = [];
    for (const path of installed.reverse()) {
      const members = installedTrees.get(path);
      if (members !== undefined) {
        await chmod(path, 0o755).catch(() => undefined);
        for (const relative of members) {
          await chmod(join(path, relative), 0o755).catch(() => undefined);
        }
      }
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const path of moved.reverse()) {
      const prior = join(backup, path.slice(project.length + 1));
      try {
        await rename(prior, path);
      } catch (error) {
        restoreFailures.push(error);
      }
    }
    if (restoreFailures.length > 0) {
      throw new StagedRollbackFailureError(
        `staged partial output restore failed; staged bytes retained at ${stage}`,
        restoreFailures,
      );
    }
    await cleanup();
  };
  try {
    for (const relativePath of deletions) {
      const path = join(project, relativePath);
      try {
        await lstat(path);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      // Deletions rest in the backup tree: rollback restores every moved
      // root from `backup`, so staging anywhere else would strand bytes.
      const staged = join(backup, relativePath);
      await mkdir(dirname(staged), { recursive: true });
      await rename(path, staged);
      moved.push(path);
    }
    for (const output of writes) {
      const staged = join(incoming, output.path);
      const tree = await writeStagedDesiredOutput(staged, output);
      const destination = join(project, output.path);
      try {
        await lstat(destination);
        const prior = join(backup, output.path);
        await mkdir(dirname(prior), { recursive: true });
        await rename(destination, prior);
        moved.push(destination);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) throw error;
      }
      await mkdir(dirname(destination), { recursive: true });
      await rename(staged, destination);
      installed.push(destination);
      if (tree !== undefined) installedTrees.set(destination, tree.memberDirectories);
      if (output.type === "directory") await applyExactDirectoryModes(destination, output);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackFailure) {
      if (rollbackFailure instanceof StagedRollbackFailureError) throw rollbackFailure;
      throw error;
    }
    throw error;
  }
  return {
    rollback,
    commit: async () => {
      if (settled) return;
      settled = true;
      await cleanup();
    },
  };
}

/**
 * Commit one `--host` partial removal under the joint boundary (the same
 * lock order as whole-removal): fresh ownership proof, changed-file
 * authorization against the reviewed bytes (removals via `--remove-changed`,
 * survivor rewrites via `--replace-changed`), staged output transition,
 * then remembered-selection narrowing. The binding keeps the Project with
 * the surviving Hosts and the receipt narrows to the surviving plan —
 * both derived from the one `planSurvivingInstallation` result.
 */
async function commitPartialUninstallProject(
  home: string,
  options: CommitPartialUninstallProjectOptions,
): Promise<CommitUninstallProjectOutcome> {
  const { item, plan } = options;
  const configurationPath = localConfigurationPath(home);
  const fileSystem = options.bindFileSystem;
  const { survivingHosts, desired } = plan;

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

  if (item.receipt === undefined) {
    return commitNarrowOnly(home, options, configurationPath, canonicalProject);
  }
  const receipt = item.receipt;
  const plannedByPath = new Map(desired.outputs.map((output) => [output.path, output]));
  const recordedPaths = new Set(receipt.outputs.map((output) => output.path));
  const deletions = receipt.outputs
    .filter((recorded) => !plannedByPath.has(recorded.path))
    .map((recorded) => recorded.path)
    .sort();
  const writes = desired.outputs.filter((output) => {
    const recorded = receipt.outputs.find((entry) => entry.path === output.path);
    return recorded === undefined || !survivorOutputMatchesReceipt(recorded, output);
  });

  try {
    return await withConfigurationLock(
      configurationPath,
      fileSystem,
      options.lockTimeoutMs,
      "uninstall",
      () =>
        withInstallationLifecycleLock(home, "uninstall", async () => {
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
          // Changed-file authorization for every recorded root about to be
          // mutated. Retained byte-identical roots are never written, so
          // their drift needs no authorization — the retention decision
          // comes from the surviving plan, not from drift.
          const newlyChanged: string[] = [];
          const newlyRemoved: string[] = [];
          const authorize = (
            path: string,
            isRemoval: boolean,
            liveDigest: string,
            plannedDigest: string,
          ): void => {
            const review = options.reviewedScope.get(`${receipt.project}\0${path}`);
            if (review !== undefined) {
              if (comparisonMatchesDigests(review, liveDigest, plannedDigest)) return;
              throw new ApplyReviewStaleError({
                completedProjects: [...options.completedProjects],
                failedProject: { canonicalProject: receipt.project, project: item.project },
                pendingProjects: options.pendingAfter.map((entry) => ({
                  canonicalProject: entry.canonicalProject ?? entry.project,
                  project: entry.project,
                })),
              });
            }
            if (isRemoval ? options.removeAuthorized : options.replaceAuthorized) return;
            (isRemoval ? newlyRemoved : newlyChanged).push(path);
          };
          for (const recorded of receipt.outputs) {
            const planned = plannedByPath.get(recorded.path);
            if (planned !== undefined && survivorOutputMatchesReceipt(recorded, planned)) continue;
            const inspected = await ownership.inspectOutput(receipt.project, recorded);
            if (recordedOutputMatches(inspected, recorded)) continue;
            if (inspected.kind === "missing") continue;
            const isRemoval = planned === undefined;
            authorize(
              recorded.path,
              isRemoval,
              liveDigestFor(inspected, recorded.type),
              plannedDigestFor(planned, isRemoval),
            );
          }
          if (newlyChanged.length > 0 || newlyRemoved.length > 0) {
            throw new ApplyConsentRequiredError(
              [
                ...(newlyChanged.length > 0 ? ["replace" as const] : []),
                ...(newlyRemoved.length > 0 ? ["remove" as const] : []),
              ],
              [{
                canonicalProject: receipt.project,
                changedOutputs: newlyChanged.sort(),
                project: item.project,
                removedOutputs: newlyRemoved.sort(),
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
          // Survivor-planned paths with no receipt must still be
          // adoptable (absent, or byte-identical): Phase A proved this,
          // and the joint lock held since covers no interleaving writer —
          // re-check before staging so a race fails closed with nothing
          // staged. The same adoption rule applies here as in Phase A.
          for (const output of desired.outputs) {
            if (recordedPaths.has(output.path)) continue;
            if (await isAdoptableSurvivorAddition(receipt.project, output)) continue;
            return {
              state: await readInstallationState(home),
              failed: failedProjectResult(item, canonicalProject, {
                detail: `surviving Host output '${output.path}' is occupied by content written after the review; re-run uninstall to review the current state`,
                selectionRestored: true,
                concurrentSelectionChange: false,
              }),
            };
          }

          let transition: StagedPartialTransition | undefined;
          try {
            transition = await stagePartialTransition(receipt.project, deletions, writes);
          } catch (error) {
            if (error instanceof StagedRollbackFailureError) {
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

          try {
            const joint = await readJointUninstallSnapshot(
              home,
              fileSystem,
              configurationPath,
              item,
              canonicalProject,
            );
            if (joint.converged) {
              // A concurrent run forgot this Project while its outputs
              // were staged here: committing drops the staged bytes. The
              // requested Hosts are gone with the installation.
              let warning: string | undefined;
              try {
                await transition!.commit();
              } catch (error) {
                warning = error instanceof Error ? error.message : String(error);
              }
              return {
                state: joint.state,
                completed: {
                  canonicalProject,
                  project: item.project,
                  profile: item.profile,
                  outputs: deletions,
                  removedHosts: item.removeHosts ?? [],
                },
                ...(warning === undefined ? {} : { warning }),
              };
            }
            const nextSource = joint.narrowHosts(survivingHosts);
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
              const narrowedReceipt: OwnershipReceipt = {
                ...receipt,
                desiredInputDigest: desired.sourceHash,
                hosts: Object.fromEntries(survivingHosts.map((host) => [host, {
                  adapterVersion: desired.adapterVersion,
                  capabilityContract: desired.hostVersions[host]!,
                }])),
                outputs: desired.outputs.map(ownedOutputFromDesired),
              };
              publishedState = withReceipts(
                joint.state,
                joint.state.receipts.map((entry) =>
                  entry.installationId === receipt.installationId ? narrowedReceipt : entry
                ),
              );
              await options.writeState(home, publishedState);
            } catch (error) {
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
              await transition!.commit();
            } catch (error) {
              warning = error instanceof Error ? error.message : String(error);
            }
            return {
              state: publishedState,
              completed: {
                canonicalProject,
                project: item.project,
                profile: item.profile,
                outputs: deletions,
                removedHosts: item.removeHosts ?? [],
              },
              ...(warning === undefined ? {} : { warning }),
            };
          } catch (error) {
            if (error instanceof UninstallConcurrentChangeError) {
              let restoreError: string | undefined;
              try {
                await transition!.rollback();
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
              await transition!.rollback();
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
                selectionRestored: restoreError === undefined,
                ...(restoreError === undefined ? {} : { restoreError }),
                concurrentSelectionChange: false,
              }),
            };
          }
        }, { lockTimeoutMs: options.lockTimeoutMs }),
    );
  } catch (error) {
    if (error instanceof ApplyConsentRequiredError) throw error;
    if (error instanceof ApplyReviewStaleError) throw error;
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

/**
 * Narrow a receipt-less binding's remembered Hosts (partial removal with
 * nothing installed): the commit only rewrites the Host list under the
 * joint boundary. No output moves, so no consent and no Workspace plan.
 */
async function commitNarrowOnly(
  home: string,
  options: CommitPartialUninstallProjectOptions,
  configurationPath: string,
  canonicalProject: string,
): Promise<CommitUninstallProjectOutcome> {
  const { item, plan } = options;
  const fileSystem = options.bindFileSystem;
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
          const nextSource = joint.narrowHosts(plan.survivingHosts);
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
    return {
      state: options.confirmState,
      completed: {
        canonicalProject,
        project: item.project,
        profile: item.profile,
        outputs: [],
        removedHosts: item.removeHosts ?? [],
      },
    };
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
  /** Rewrite the entry's Host list (partial removal narrows the selection). */
  readonly narrowHosts: (hosts: readonly SupportedHost[]) => string;
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
    narrowHosts: (hosts) => updateBindingHostsSourceEntry(source, document, bindingsNode, index, hosts),
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
