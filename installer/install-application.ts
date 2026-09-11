/**
 * Single-Project installation (spec #491 US-001/US-006/US-007/US-008,
 * DEC-001/DEC-002/DEC-004–DEC-006, ticket #494): one action records the
 * Project's desired selection and installs/verifies the generated output.
 *
 * Changed-file consent precedes selection publication (US-007/DEC-005): the
 * prospective installation is planned from the requested selection overlaid
 * in memory — never published — and the shared consent gate reviews those
 * bytes before any configuration or output write. Refusal, decline, or
 * cancellation therefore writes nothing at all.
 *
 * The commit runs under one joint serialization boundary: the Local
 * Configuration lock is held across snapshot re-verification, selection
 * publication, fresh planning, reconciliation, and recovery, with the
 * installation lifecycle lock nested inside (the same lock order as the retired unbind),
 * so a cooperating writer queues instead of interleaving. Prompts and the
 * prospective review stay outside the locks; the commit re-verifies the
 * snapshot and the reviewed bytes and fails closed on any drift.
 *
 * There is exactly one desired-state authority: plans are built from Local
 * Configuration (prospectively overlaid, then freshly re-read after
 * publication) and passed to the write loop, never stored as a second
 * record.
 *
 * Recovery (DEC-006) restores only the snapshot this operation still owns:
 * every post-publication failure before the output commit restores the
 * previous selection (removing a newly added binding, re-publishing the
 * replaced one) after re-proving ownership under the held lock; a concurrent
 * change is left untouched and reported. A post-commit verification failure
 * keeps the committed selection. Restoration failures are carried, never
 * swallowed.
 */
import {
  defaultFileSystem,
  publishBindingUnderLock,
  removeBindingUnderLock,
  type BindProjectFileSystem,
  type BindProjectResult,
} from "./bind-project.js";
import {
  ingestApplication,
  ingestSelectedWorkspace,
  localConfigurationPath,
  normalizeProject,
  requireExistingDirectory,
} from "./local-configuration.js";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  withConfigurationLock,
} from "./local-configuration-publication.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import { buildDesiredState, planDesiredInstallations } from "./project-plan.js";
import type { DesiredInstallation } from "./project-plan.js";
import type { ChangedOutputComparison } from "./changed-output-review.js";
import {
  applyReconciliationWithLifecycleLock,
  previewReconciliation,
  resolveChangedOutputConsent,
  unreadableInstallationStateReport,
  ApplyBlockedError,
  ApplyDeclinedError,
  ApplyReviewStaleError,
  ApplyVerificationError,
  type ApplyReconciliationResult,
  type ChangedOutputConsentRequest,
  type ReconciliationFileSystem,
} from "./reconcile.js";
import { createLifecycleGitInspectionContext } from "./lifecycle-git-inspection.js";
import type { LifecycleGitInspection } from "./lifecycle-git-inspection.js";
import { createLifecycleOwnershipInspectionContext } from "./lifecycle-ownership-inspection.js";
import type { LifecycleOwnershipInspection } from "./lifecycle-ownership-inspection.js";
import { createProjectReadScheduler } from "./project-scheduler.js";
import type { LifecyclePlanningInstrumentation } from "./lifecycle-planning.js";
import type { LifecycleInstrumentation } from "./qualification-instrumentation.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import {
  isSupportedHost,
  SUPPORTED_HOSTS,
  type SupportedHost,
} from "../schemas/local-configuration.js";
import type { ProjectBinding } from "../schemas/local-configuration.js";
import { listProfiles } from "./inventory.js";
import { requireProfile } from "./profile-selection.js";
import { InstallerToolError, type ConfiguredPathOrigin } from "./tool-errors.js";
import { readInstallationState, writeInstallationState } from "./installation-state.js";

export interface InstallSelection {
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
  readonly canonicalProject: string;
  /** Authored spelling of the Project target, for receipts and restore. */
  readonly authoredProject: string;
}

export interface PreviousInstallSelection {
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
  readonly authoredProject: string;
}

export interface InstallPreview extends InstallSelection {
  /** The binding this install replaces; absent for a new installation. */
  readonly previous?: PreviousInstallSelection;
}

export interface InstallApplicationOptions {
  readonly profile: string;
  readonly hosts: readonly string[];
  /** Authored project path; omit to install the working directory. */
  readonly project?: string;
  /** Working directory used when project is omitted. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Injectable process environment for Host capability probes. */
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit per-operation changed-file authorization (DEC-005). */
  readonly removeChanged?: boolean;
  readonly replaceChanged?: boolean;
  /** Injectable changed-output consent; absent means non-interactive refusal. */
  readonly confirmChangedOutputReplacement?:
    (request: ChangedOutputConsentRequest) => Promise<"accepted" | "declined" | "cancelled">;
  readonly instrumentation?: LifecycleInstrumentation;
  /** Test-only filesystem override for selection publication proofs. */
  readonly bindFileSystem?: BindProjectFileSystem;
  /** Test-only filesystem override for generated-output proofs. */
  readonly reconcileFileSystem?: Partial<ReconciliationFileSystem>;
  /** Factories for fresh lifecycle inspection passes; tests use them to fault verification. */
  readonly createGitInspection?: () => LifecycleGitInspection;
  readonly createOwnershipInspection?: () => LifecycleOwnershipInspection;
  /** Injectable Installation State writer; tests use it to inject failures. */
  readonly writeInstallationState?: typeof writeInstallationState;
  /** Test-only lock wait timeout (ms) for the install commit boundary. */
  readonly lockTimeoutMs?: number;
}

export interface InstallApplicationResult {
  readonly preview: InstallPreview;
  readonly binding: BindProjectResult;
  readonly applied: ApplyReconciliationResult;
}

/** Post-publication failure: the original cause plus the recovery outcome. */
export interface InstallFailure {
  /** The original failure (usually a reconciliation error). */
  readonly cause: unknown;
  /** Whether the previous selection was restored (never for post-commit verification). */
  readonly selectionRestored: boolean;
  /** The restoration failure, when restoring itself failed. */
  readonly restoreFailure?: unknown;
  /** True when generated output was committed (verification path or concurrent commit). */
  readonly outputCommitted: boolean;
  /** True when another writer owns the current selection, which was left untouched. */
  readonly concurrentSelectionChange: boolean;
}

export class InstallExecutionError extends Error {
  readonly failure: InstallFailure;

  constructor(failure: InstallFailure) {
    super(failure.cause instanceof Error ? failure.cause.message : String(failure.cause));
    this.name = "InstallExecutionError";
    this.failure = failure;
  }
}

function normalizeInstallHosts(hosts: readonly string[]): readonly SupportedHost[] {
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
 * The current binding for one canonical Project, without writing anything.
 * A missing configuration stably means "no previous selection"; any other
 * read failure is potentially transient and fails closed, so a swallowed
 * snapshot can never restore the wrong direction after a later fault.
 */
async function readPreviousSelection(
  home: string,
  canonicalProject: string,
): Promise<PreviousInstallSelection | undefined> {
  try {
    const application = await ingestApplication(home);
    const existing = application.configuration.bindings.find(
      (binding) => binding.canonicalProject === canonicalProject,
    );
    if (existing === undefined) return undefined;
    return {
      profile: existing.profile,
      hosts: existing.hosts,
      authoredProject: existing.project,
    };
  } catch (error) {
    if (
      !(error instanceof InstallerToolError) ||
      error.fact.kind !== "missing-local-configuration"
    ) {
      throw error;
    }
    return undefined;
  }
}

/** Canonical-order selection equality for snapshot ownership checks. */
export function sameInstallSelection(
  left: PreviousInstallSelection | undefined,
  right: PreviousInstallSelection | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.profile === right.profile &&
    left.authoredProject === right.authoredProject &&
    left.hosts.length === right.hosts.length &&
    left.hosts.every((host, index) => host === right.hosts[index]);
}

/** The resolved install target without any Profile/Host choice: the
 * canonical and authored Project plus the existing selection when one is
 * recorded. Guided pickers (#495) read this before asking anything, so a
 * bare interactive install names its target first and pre-checks the
 * existing Hosts; callers pass the resolved target into `previewInstall`
 * so naming, picking, and preview share one resolution instead of
 * re-reading it. */
export interface InstallTarget {
  readonly canonicalProject: string;
  readonly authoredProject: string;
  readonly previous?: PreviousInstallSelection;
}

export async function resolveInstallTarget(
  home: string,
  options: Pick<InstallApplicationOptions, "project" | "cwd">,
): Promise<InstallTarget> {
  const configurationPath = localConfigurationPath(home);
  const origin: ConfiguredPathOrigin = {
    source: "local-configuration",
    configurationPath,
  };
  const cwd = options.cwd ?? process.cwd();
  const canonicalProject = options.project === undefined
    ? await requireExistingDirectory(cwd, cwd, origin, "project")
    : await normalizeProject(options.project, home, origin);
  const authoredProject = options.project ?? canonicalProject;
  const previous = await readPreviousSelection(home, canonicalProject);
  return {
    canonicalProject,
    authoredProject,
    ...(previous === undefined ? {} : { previous }),
  };
}

/**
 * Resolve, snapshot, and validate the requested installation without writing
 * anything. The CLI confirms this preview before executing it. Callers that
 * already resolved the target (the guided flow) pass it so the preview
 * cannot drift from what was named and picked; otherwise it is resolved
 * here through the same boundary.
 */
export async function previewInstall(
  home: string,
  options: Pick<
    InstallApplicationOptions,
    "profile" | "hosts" | "project" | "cwd"
  > & {
    readonly target?: InstallTarget;
  },
): Promise<InstallPreview> {
  const profile = requireArtifactId(options.profile, "install profile");
  const hosts = normalizeInstallHosts(options.hosts);
  const target = options.target ?? await resolveInstallTarget(home, options);

  const profiles = await listProfiles(home);
  requireProfile(new Map(profiles.map((entry) => [entry.id, entry])), profile);

  return {
    profile,
    hosts,
    canonicalProject: target.canonicalProject,
    authoredProject: target.authoredProject,
    ...(target.previous === undefined ? {} : { previous: target.previous }),
  };
}

/**
 * Plan the requested selection overlaid in memory, without publishing
 * anything. The returned installation carries the exact bytes consent reviews.
 */
async function planProspectiveInstallation(
  home: string,
  preview: InstallPreview,
  options: Pick<
    InstallApplicationOptions,
    "env" | "instrumentation" | "createGitInspection"
  >,
): Promise<DesiredInstallation> {
  const workspace = await ingestSelectedWorkspace(home);
  const gitInspection = (options.createGitInspection ??
    (() => createLifecycleGitInspectionContext(options.instrumentation?.git)))();
  const scheduler = createProjectReadScheduler();
  const bindings: readonly ProjectBinding[] = [{
    canonicalProject: preview.canonicalProject,
    project: preview.authoredProject,
    profile: preview.profile,
    hosts: [...preview.hosts],
  }];
  const installations = await planDesiredInstallations(home, bindings, workspace, {
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.instrumentation === undefined
      ? {}
      : { planningInstrumentation: options.instrumentation.planning }),
    gitInspection,
    scheduler,
  });
  const installation = installations.find(
    (entry) => entry.binding.canonicalProject === preview.canonicalProject,
  );
  if (installation === undefined) {
    throw new Error(`install planning produced no installation for ${preview.canonicalProject}`);
  }
  return installation;
}

/**
 * The commit-time review matches the consented review only when every
 * compared path carries the same operation and the same reviewed byte
 * identity. Any added, removed, or re-drifted path refuses as stale.
 */
function commitMatchesProspectiveReview(
  prospective: readonly ChangedOutputComparison[],
  commit: readonly ChangedOutputComparison[],
): boolean {
  if (prospective.length !== commit.length) return false;
  const prospectiveIds = new Map(
    prospective.map((comparison) => [
      `${comparison.project}\0${comparison.path}\0${comparison.operation}`,
      comparison.reviewId,
    ]),
  );
  return commit.every((comparison) =>
    prospectiveIds.get(
      `${comparison.project}\0${comparison.path}\0${comparison.operation}`,
    ) === comparison.reviewId
  );
}

/**
 * Install the requested final selection and verify the generated output for
 * that one Project. The requested selection is final: replacing an existing
 * binding needs no separate `--replace` flag because the general confirmation
 * (DEC-004) already authorizes the stated scope.
 */
export async function executeInstall(
  home: string,
  options: InstallApplicationOptions,
): Promise<InstallApplicationResult> {
  const fileSystem = options.bindFileSystem ?? defaultFileSystem;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const configurationPath = localConfigurationPath(home);
  const toInstallError = (cause: unknown): InstallExecutionError =>
    new InstallExecutionError({
      cause,
      selectionRestored: false,
      outputCommitted: false,
      concurrentSelectionChange: false,
    });

  // Fresh preview snapshot for ownership: the CLI preview above only served
  // the confirmation display.
  const preview = await previewInstall(home, options);

  // Phase A (no locks, no writes): plan the prospective installation and run
  // the shared consent gate against it. Refusal, decline, or cancellation
  // throws before any configuration or output write.
  const prospective = await planProspectiveInstallation(home, preview, options);
  const instrumentation = options.instrumentation;
  const createGitInspection = options.createGitInspection ??
    (() => createLifecycleGitInspectionContext(instrumentation?.git));
  const createOwnershipInspection = options.createOwnershipInspection ??
    (() => createLifecycleOwnershipInspectionContext(instrumentation?.ownership));
  let before;
  try {
    before = await readInstallationState(home);
  } catch (error) {
    throw toInstallError(
      new ApplyBlockedError(await unreadableInstallationStateReport(home, [prospective], error)),
    );
  }
  const consent = await (async () => {
    try {
      // One inspection instance serves the preflight report and the review
      // construction, mirroring the update path.
      const phaseAOwnership = createOwnershipInspection();
      const preflight = await previewReconciliation([prospective], before, {
        gitInspection: createGitInspection(),
        ownershipInspection: phaseAOwnership,
        scheduler: createProjectReadScheduler(),
        scope: { kind: "project" },
      });
      if (preflight.globalBlockers.length > 0) {
        throw new ApplyBlockedError(preflight);
      }
      const ourRecord = preflight.projects.find(
        (project) => project.canonicalProject === preview.canonicalProject,
      );
      if (ourRecord === undefined) {
        throw new Error(`install plan produced no record for ${preview.canonicalProject}`);
      }
      if (ourRecord.blockers.length > 0) {
        throw new ApplyBlockedError(preflight);
      }
      return await resolveChangedOutputConsent({
        before,
        blockedProjects: new Set<string>(),
        ...(options.confirmChangedOutputReplacement === undefined
          ? {}
          : { confirmChangedOutputReplacement: options.confirmChangedOutputReplacement }),
        desired: [prospective],
        ownershipInspection: phaseAOwnership,
        removeAuthorized: options.removeChanged === true,
        replaceAuthorized: options.replaceChanged === true,
        report: preflight,
      });
    } catch (error) {
      throw toInstallError(error);
    }
  })();

  // Commit under one joint boundary: the configuration lock is held across
  // snapshot re-verification, selection publication, fresh planning,
  // reconciliation, and recovery, with the lifecycle lock nested inside
  // (the same lock order as the retired unbind). Prompts stay outside; the commit
  // re-verifies the snapshot and the reviewed bytes instead. A lock the
  // commit never acquires still reports through the same envelope: nothing
  // was published, so there is nothing to restore.
  try {
    return await withConfigurationLock(
      configurationPath,
      fileSystem,
      lockTimeoutMs,
      "install",
      async () => {
        // The lifecycle lock nests inside the configuration lock (the same
        // order as the retired unbind) and is retained through reconciliation AND
        // selection recovery, so lifecycle writers queue instead of
        // interleaving with either phase.
        return withInstallationLifecycleLock(home, "install", async () => {
          let published: PreviousInstallSelection | undefined;
          try {
            // 1. Re-verify the snapshot this operation owns; fail closed on drift.
            const current = await readPreviousSelection(home, preview.canonicalProject);
            if (!sameInstallSelection(current, preview.previous)) {
              throw new InstallerToolError({
                kind: "configuration-changed-before-publication",
                configurationPath,
                operation: "install",
              });
            }
            // 2. Publish through the shared locked boundary.
            const binding = await publishBindingUnderLock(
              configurationPath,
              fileSystem,
              "install",
              {
                home,
                profile: preview.profile,
                hosts: preview.hosts,
                canonicalProject: preview.canonicalProject,
                storedProject: preview.authoredProject,
                replace: true,
              },
            );
            published = {
              profile: binding.profile,
              hosts: binding.hosts,
              authoredProject: binding.project,
            };
            // 3. Fresh authoritative plan from the published configuration.
            const commitScheduler = createProjectReadScheduler();
            const planning: {
              readonly planningInstrumentation?: LifecyclePlanningInstrumentation;
            } = instrumentation === undefined
              ? {}
              : { planningInstrumentation: instrumentation.planning };
            const desired = await buildDesiredState(home, {
              ...(options.env === undefined ? {} : { env: options.env }),
              gitInspection: createGitInspection(),
              ...planning,
              scheduler: commitScheduler,
              selection: {
                command: "install",
                kind: "project",
                match: "exact",
                target: binding.canonicalProject,
              },
            });
            // 4. Programmatic commit confirmer: the commit authorizes exactly the
            // reviewed bytes, never a moved review and never a second prompt.
            let commitStale = false;
            const commitConfirmer = async (
              commitRequest: ChangedOutputConsentRequest,
            ): Promise<"accepted" | "declined" | "cancelled"> => {
              if (commitMatchesProspectiveReview(consent.comparisons, commitRequest.comparisons)) {
                return "accepted";
              }
              commitStale = true;
              return "declined";
            };
            // 5. Reconcile (lifecycle lock nested inside the held lock).
            let applied: ApplyReconciliationResult;
            try {
              applied = await applyReconciliationWithLifecycleLock(home, desired.installations, {
                scheduler: commitScheduler,
                scope: { kind: "project" },
                confirmChangedOutputReplacement: commitConfirmer,
                ...(options.replaceChanged === undefined ? {} : { replaceChanged: options.replaceChanged }),
                ...(options.removeChanged === undefined ? {} : { removeChanged: options.removeChanged }),
                createGitInspection,
                createOwnershipInspection,
                ...(options.reconcileFileSystem === undefined
                  ? {}
                  : { fileSystem: options.reconcileFileSystem }),
                ...(options.writeInstallationState === undefined
                  ? {}
                  : { writeInstallationState: options.writeInstallationState }),
              });
            } catch (error) {
              if (error instanceof ApplyDeclinedError && commitStale) {
                throw new ApplyReviewStaleError({
                  completedProjects: [],
                  failedProject: {
                    canonicalProject: preview.canonicalProject,
                    project: preview.authoredProject,
                  },
                  pendingProjects: [],
                });
              }
              throw error;
            }
            // 6. Post-verify ownership (defense in depth; exclusion guarantees it).
            const currentAfter = await readPreviousSelection(home, preview.canonicalProject);
            if (!sameInstallSelection(currentAfter, published)) {
              throw new InstallerToolError({
                kind: "configuration-changed-before-publication",
                configurationPath,
                operation: "install",
              });
            }
            return { preview, binding, applied };
          } catch (error) {
            if (error instanceof ApplyVerificationError) {
              // Post-commit: the new output is committed, so the new selection stays
              // and the failure reports truthfully with a concrete retry.
              throw new InstallExecutionError({
                cause: error,
                selectionRestored: false,
                outputCommitted: true,
                concurrentSelectionChange: false,
              });
            }
            const postVerifyMismatch = error instanceof InstallerToolError &&
              error.fact.kind === "configuration-changed-before-publication" &&
              published !== undefined;
            // Restore only the snapshot still owned: a concurrent change is left
            // untouched and reported instead of blindly overwritten.
            let restoreFailure: unknown;
            let restored = false;
            let concurrent = false;
            if (published !== undefined && !postVerifyMismatch) {
              let currentNow: PreviousInstallSelection | undefined;
              try {
                currentNow = await readPreviousSelection(home, preview.canonicalProject);
              } catch (readError) {
                throw new InstallExecutionError({
                  cause: error,
                  selectionRestored: false,
                  restoreFailure: readError,
                  outputCommitted: false,
                  concurrentSelectionChange: false,
                });
              }
              if (!sameInstallSelection(currentNow, published)) {
                concurrent = true;
              } else {
                try {
                  if (preview.previous === undefined) {
                    await removeBindingUnderLock(
                      home,
                      configurationPath,
                      fileSystem,
                      "install",
                      preview.canonicalProject,
                    );
                  } else {
                    await publishBindingUnderLock(configurationPath, fileSystem, "install", {
                      home,
                      profile: preview.previous.profile,
                      hosts: preview.previous.hosts,
                      canonicalProject: preview.canonicalProject,
                      storedProject: preview.previous.authoredProject,
                      replace: true,
                    });
                  }
                  restored = true;
                } catch (failure) {
                  restoreFailure = failure;
                }
              }
            }
            throw new InstallExecutionError({
              cause: error,
              selectionRestored: restored,
              ...(restoreFailure === undefined ? {} : { restoreFailure }),
              outputCommitted: postVerifyMismatch,
              concurrentSelectionChange: concurrent || postVerifyMismatch,
            });
          }
          },
        { lockTimeoutMs },
        );
      },
    );
  } catch (error) {
    if (error instanceof InstallExecutionError) throw error;
    throw new InstallExecutionError({
      cause: error,
      selectionRestored: false,
      outputCommitted: false,
      concurrentSelectionChange: false,
    });
  }
}
