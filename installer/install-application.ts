/**
 * Single-Project installation (spec #491 US-001/US-006/US-007/US-008,
 * DEC-001/DEC-002/DEC-004–DEC-006, ticket #494): one action records the
 * Project's desired selection and installs/verifies the generated output.
 *
 * Selection publication reuses the Local Configuration snapshot-checked
 * boundary (`bindProject` with the requested final selection); output
 * installation reuses the reconciliation write loop (`applyReconciliation`
 * scoped to the one Project) with the shared changed-output consent gate.
 * There is exactly one desired-state authority: the plan is built from the
 * just-published Local Configuration and passed to the write loop, never
 * stored as a second record.
 *
 * Serialization is lock-pair sequencing, not one joint transaction:
 * selection writers serialize on the Local Configuration lock, output
 * writers on the installation lifecycle lock, and the write loop re-ingests
 * Local Configuration under its lock and fails closed on drift, so a
 * concurrent selection edit retries instead of installing stale scope.
 *
 * Recovery (DEC-006) treats the Project's selection and output as one
 * recoverable unit: every post-publication failure before the output commit
 * restores the previous selection (removing a newly added binding,
 * re-publishing the replaced one); a post-commit verification failure keeps
 * the committed selection and reports truthfully. Restoration failures are
 * carried, never swallowed.
 */
import {
  bindProject,
  type BindProjectFileSystem,
  type BindProjectResult,
} from "./bind-project.js";
import { unbindProject } from "./unbind-project.js";
import {
  ingestApplication,
  localConfigurationPath,
  normalizeProject,
  requireExistingDirectory,
} from "./local-configuration.js";
import { buildDesiredState } from "./project-plan.js";
import {
  applyReconciliation,
  ApplyVerificationError,
  type ChangedOutputConsentRequest,
  type ReconciliationFileSystem,
  type ApplyReconciliationResult,
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
import { listProfiles } from "./inventory.js";
import { requireProfile } from "./profile-selection.js";
import { InstallerToolError, type ConfiguredPathOrigin } from "./tool-errors.js";
import { writeInstallationState } from "./installation-state.js";

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
  /** Test-only lock wait timeout (ms) for selection publication. */
  readonly lockTimeoutMs?: number;
}

export interface InstallApplicationResult {
  readonly preview: InstallPreview;
  readonly binding: BindProjectResult;
  readonly applied: ApplyReconciliationResult;
}

/** Post-publication failure: the original cause plus the restore outcome. */
export interface InstallFailure {
  /** The original failure (usually a reconciliation error). */
  readonly cause: unknown;
  /** Whether the previous selection was restored (never for post-commit verification). */
  readonly selectionRestored: boolean;
  /** The restoration failure, when restoring itself failed. */
  readonly restoreFailure?: unknown;
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
 * Resolve, snapshot, and validate the requested installation without writing
 * anything. The CLI confirms this preview before executing it.
 */
export async function previewInstall(
  home: string,
  options: Pick<
    InstallApplicationOptions,
    "profile" | "hosts" | "project" | "cwd"
  >,
): Promise<InstallPreview> {
  const configurationPath = localConfigurationPath(home);
  const origin: ConfiguredPathOrigin = {
    source: "local-configuration",
    configurationPath,
  };
  const profile = requireArtifactId(options.profile, "install profile");
  const hosts = normalizeInstallHosts(options.hosts);
  const cwd = options.cwd ?? process.cwd();
  const canonicalProject = options.project === undefined
    ? await requireExistingDirectory(cwd, cwd, origin, "project")
    : await normalizeProject(options.project, home, origin);
  const authoredProject = options.project ?? canonicalProject;

  let previous: PreviousInstallSelection | undefined;
  try {
    const application = await ingestApplication(home);
    const existing = application.configuration.bindings.find(
      (binding) => binding.canonicalProject === canonicalProject,
    );
    if (existing !== undefined) {
      previous = {
        profile: existing.profile,
        hosts: existing.hosts,
        authoredProject: existing.project,
      };
    }
  } catch (error) {
    // Only a missing configuration stably means "no previous selection":
    // the publication path below reports that authoritatively. Any other
    // read failure is potentially transient and must fail closed here — a
    // swallowed snapshot would restore the wrong direction (deleting a real
    // previous binding instead of re-publishing it) after a later fault.
    if (
      !(error instanceof InstallerToolError) ||
      error.fact.kind !== "missing-local-configuration"
    ) {
      throw error;
    }
    previous = undefined;
  }

  const profiles = await listProfiles(home);
  requireProfile(new Map(profiles.map((entry) => [entry.id, entry])), profile);

  return {
    profile,
    hosts,
    canonicalProject,
    authoredProject,
    ...(previous === undefined ? {} : { previous }),
  };
}

/** Restore the pre-install selection after a pre-commit failure. */
async function restorePreviousSelection(
  home: string,
  preview: InstallPreview,
  options: Pick<
    InstallApplicationOptions,
    "project" | "cwd" | "bindFileSystem" | "lockTimeoutMs"
  >,
): Promise<void> {
  const shared = {
    ...(options.bindFileSystem === undefined ? {} : { fileSystem: options.bindFileSystem }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
  };
  if (preview.previous === undefined) {
    await unbindProject({
      home,
      ...(options.project === undefined
        ? options.cwd === undefined ? {} : { cwd: options.cwd }
        : { project: options.project }),
      ...shared,
    });
    return;
  }
  await bindProject({
    home,
    profile: preview.previous.profile,
    hosts: preview.previous.hosts,
    project: preview.previous.authoredProject,
    replace: true,
    ...shared,
  });
}

/**
 * Publish the requested final selection, then install and verify the
 * generated output for that one Project. The requested selection is final:
 * replacing an existing binding needs no separate `--replace` flag because
 * the general confirmation (DEC-004) already authorizes the stated scope.
 */
export async function executeInstall(
  home: string,
  options: InstallApplicationOptions,
): Promise<InstallApplicationResult> {
  const preview = await previewInstall(home, options);
  // Publication is one atomic snapshot-checked replacement: on failure
  // nothing was published, so there is nothing to restore — but the failure
  // still reports through the same truthful envelope with a concrete retry.
  let binding: BindProjectResult;
  try {
    binding = await bindProject({
      home,
      profile: preview.profile,
      hosts: preview.hosts,
      ...(options.project === undefined ? {} : { project: options.project }),
      replace: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.bindFileSystem === undefined ? {} : { fileSystem: options.bindFileSystem }),
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    });
  } catch (error) {
    throw new InstallExecutionError({ cause: error, selectionRestored: false });
  }

  try {
    const instrumentation = options.instrumentation;
    const createGitInspection = options.createGitInspection ??
      (() => createLifecycleGitInspectionContext(instrumentation?.git));
    const createOwnershipInspection = options.createOwnershipInspection ??
      (() => createLifecycleOwnershipInspectionContext(instrumentation?.ownership));
    const gitInspection = createGitInspection();
    const scheduler = createProjectReadScheduler();
    const planning: {
      readonly planningInstrumentation?: LifecyclePlanningInstrumentation;
    } = instrumentation === undefined
      ? {}
      : { planningInstrumentation: instrumentation.planning };
    const desired = await buildDesiredState(home, {
      ...(options.env === undefined ? {} : { env: options.env }),
      gitInspection,
      ...planning,
      scheduler,
      selection: {
        command: "install",
        kind: "project",
        match: "exact",
        target: binding.canonicalProject,
      },
    });
    const applied = await applyReconciliation(home, desired.installations, {
      scheduler,
      scope: { kind: "project" },
      ...(options.confirmChangedOutputReplacement === undefined
        ? {}
        : { confirmChangedOutputReplacement: options.confirmChangedOutputReplacement }),
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
    return { preview, binding, applied };
  } catch (error) {
    if (error instanceof ApplyVerificationError) {
      // Post-commit: the new output is committed, so the new selection stays
      // and the failure reports truthfully with a concrete retry.
      throw new InstallExecutionError({ cause: error, selectionRestored: false });
    }
    let restoreFailure: unknown;
    let restored = false;
    try {
      await restorePreviousSelection(home, preview, options);
      restored = true;
    } catch (failure) {
      restoreFailure = failure;
    }
    throw new InstallExecutionError({
      cause: error,
      selectionRestored: restored,
      ...(restoreFailure === undefined ? {} : { restoreFailure }),
    });
  }
}
