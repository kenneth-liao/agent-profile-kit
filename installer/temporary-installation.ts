import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  hostRegistrationFor,
  TEMPORARY_INSTALLATION_HOSTS,
  type TemporaryInstallationHost,
} from "../adapters/registry.js";
import type { AdapterDiagnosticWarning, HostSetupStep } from "../adapters/project-plan.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import {
  isSupportedHost,
  type SupportedHost,
} from "../schemas/local-configuration.js";
import {
  formatInstallationMarker,
  INSTALLATION_STATE_SCHEMA_VERSION,
  type TemporaryProfileInstallation,
} from "../schemas/installation-manifest.js";
import {
  replaceRepositoryExclusionContribution,
  stageGitExclusions,
} from "./git-exclusions.js";
import { findGitProject } from "./git.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import {
  newInstallationId,
  readInstallationStateWithMigration,
  removeDisposableOutputs,
  writeInstallationState,
} from "./installation-state.js";
import {
  ingestApplication,
  normalizeProject,
} from "./local-configuration.js";
import { createLifecyclePlanningContext } from "./lifecycle-planning.js";
import { requireProfile } from "./profile-selection.js";
import {
  adapterVersionFor,
  appendDiagnosticWarnings,
  markerPath,
  planRegisteredAdapter,
  normalizeAdapterPlans,
  assertResolvedOutputOrigins,
  type DesiredInstallation,
} from "./project-plan.js";
import {
  desiredOutputConflicts,
  manifestFor,
  nodeFileSystem,
  stageProjectOutputs,
  type ReconciliationFileSystem,
} from "./reconcile.js";
import {
  hostCapabilityBlocker,
  normalizeBlocker,
  temporaryInstallationConflictBlocker,
  temporaryInstallationRemovalBlocker,
  type BlockerInput,
  type ReconciliationBlocker,
} from "./blockers.js";
import { ENGINE_VERSION } from "./version.js";

export {
  isTemporaryInstallationHost,
  TEMPORARY_INSTALLATION_HOSTS,
  type TemporaryInstallationHost,
} from "../adapters/registry.js";

export class TemporaryInstallationBlockedError extends Error {
  readonly #canonical: readonly ReconciliationBlocker[];
  readonly #canonicalProject: string;

  /**
   * Accept one canonical blocker-input collection, normalize it once, and derive
   * the legacy string projection and Error.message from it so the two public
   * views can never diverge. The canonical Project the blocked operation
   * targeted is part of the error's identity, so it is required.
   */
  constructor(inputs: readonly BlockerInput[], canonicalProject: string) {
    const canonical = inputs.map((input) => normalizeBlocker(input));
    super(canonical.map((blocker) => blocker.message).join("\n"));
    this.name = "TemporaryInstallationBlockedError";
    this.#canonical = canonical;
    this.#canonicalProject = canonicalProject;
  }

  /** Legacy message projection consumed by temporary-installation JSON and human output. */
  get blockers(): readonly string[] {
    return this.#canonical.map((blocker) => blocker.message);
  }

  /** Complete structured evidence for each emitted blocker, published in machine JSON. */
  get structured(): readonly ReconciliationBlocker[] {
    return this.#canonical;
  }

  /** Canonical Project root the blocked operation targeted. */
  get canonicalProject(): string {
    return this.#canonicalProject;
  }
}

/**
 * Installation failed after a recoverable Temporary Profile Installation
 * identity was published. Callers must run `remove-temp` with the identity.
 */
export class TemporaryInstallationRecoverableError extends Error {
  readonly removalRequired = true as const;
  readonly temporaryInstallationId: string;

  constructor(temporaryInstallationId: string, message: string) {
    super(message);
    this.name = "TemporaryInstallationRecoverableError";
    this.temporaryInstallationId = temporaryInstallationId;
  }
}

export interface TemporaryInstallationReceipt {
  readonly adapterVersion: string;
  readonly completionState: "installed" | "removed";
  readonly engineVersion: string;
  readonly host: string;
  readonly hostVersion: string;
  readonly outputs: readonly string[];
  readonly profileId: string;
  readonly project: string;
  readonly repositoryExclusion:
    | {
        readonly entries: readonly string[];
        readonly target: string;
      }
    | undefined;
  /** Adapter-authored Host Setup Steps required after successful temporary install. */
  readonly setupSteps: readonly HostSetupStep[];
  readonly temporaryInstallationId: string;
  /** Structured values referenced by configuration warnings on the live receipt. */
  readonly diagnosticValues: readonly string[];
  /** Configuration warnings that do not block install but can prevent Host loading. */
  readonly warnings: readonly string[];
  readonly workspaceInputHash: string;
}

/** Test-only hooks for failure injection at Installer transaction boundaries. */
export interface TemporaryInstallationHooks {
  readonly fileSystem?: Partial<ReconciliationFileSystem>;
  readonly lockTimeoutMs?: number;
  readonly onAfterDurableRecord?: () => Promise<void>;
  readonly onAfterExclusionCommit?: () => Promise<void>;
  readonly onAfterOwnershipToken?: () => Promise<void>;
  readonly onAfterOutputsPublished?: () => Promise<void>;
  readonly onAfterRootDeletes?: () => Promise<void>;
  readonly onBeforeTerminalStateWrite?: () => Promise<void>;
  readonly writeInstallationState?: typeof writeInstallationState;
}

/** First owned project mutation: durable recovery ownership token (Installation Marker). */
async function writeTemporaryOwnershipToken(
  project: string,
  temporaryInstallationId: string,
): Promise<void> {
  const destination = markerPath(project);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(
    destination,
    formatInstallationMarker({
      installationId: temporaryInstallationId,
      schemaVersion: 1,
    }),
    { flag: "wx" },
  );
}

function receiptFromRecord(
  record: TemporaryProfileInstallation,
  repositoryExclusion:
    | TemporaryInstallationReceipt["repositoryExclusion"]
    | undefined,
  options: {
    readonly diagnosticValues?: readonly string[];
    readonly setupSteps?: readonly HostSetupStep[];
    readonly warnings?: readonly string[];
  } = {},
): TemporaryInstallationReceipt {
  return {
    adapterVersion: record.adapterVersion,
    completionState: record.completionState,
    engineVersion: record.engineVersion,
    host: record.host,
    hostVersion: record.hostVersion,
    outputs: record.outputs.map((output) => output.path),
    profileId: record.profileId,
    project: record.project,
    repositoryExclusion,
    setupSteps: options.setupSteps ?? [],
    temporaryInstallationId: record.temporaryInstallationId,
    diagnosticValues: options.diagnosticValues ?? [],
    warnings: options.warnings ?? [],
    workspaceInputHash: record.workspaceInputHash,
  };
}

function exclusionContributionFor(
  state: Awaited<ReturnType<typeof readInstallationStateWithMigration>>["state"],
  installationId: string,
): TemporaryInstallationReceipt["repositoryExclusion"] {
  for (const record of state.repositoryExclusions) {
    const contribution = record.contributions.find(
      (entry) => entry.installationId === installationId,
    );
    if (contribution) {
      return { entries: contribution.entries, target: record.target };
    }
  }
  return undefined;
}

async function planTemporaryDesiredInstallation(options: {
  readonly home: string;
  readonly host: TemporaryInstallationHost;
  readonly profileId: string;
  readonly project: string;
  readonly authoredProject: string;
}): Promise<DesiredInstallation> {
  const { configuration, workspace } = await ingestApplication(options.home);
  void configuration;
  const profile = requireProfile(workspace.profiles, options.profileId);
  const planning = createLifecyclePlanningContext(workspace);
  const resolvedProfile = planning.resolveProfile(profile);
  const gitProject = await findGitProject(options.project);
  const { hash: sourceHash, fingerprints: artifactFingerprints } =
    await planning.hashWorkspaceInputs(profile, resolvedProfile);
  const blockers: BlockerInput[] = [];
  const warnings: AdapterDiagnosticWarning[] = [];
  const result = await planRegisteredAdapter(
    options.host,
    {
      authoredProject: options.authoredProject,
      checkHostCapability: true,
      home: options.home,
      profileId: profile.id,
      previousInstallation: undefined,
      project: options.project,
      projectRelativeToGitRoot: gitProject?.relativeProject,
      resolvedContexts: resolvedProfile.contexts,
      resolvedSkills: resolvedProfile.skills,
      selectedHosts: [options.host],
    },
    planning,
  );
  for (const error of result.capabilityFailures) {
    blockers.push(hostCapabilityBlocker(error, options.host, options.project));
  }
  appendDiagnosticWarnings(warnings, result.diagnostics);
  const adapterPlan = result.plan;
  const hosts: readonly SupportedHost[] = [options.host];
  const outputs = normalizeAdapterPlans(
    adapterPlan === undefined ? [] : [adapterPlan],
  );
  assertResolvedOutputOrigins(outputs, resolvedProfile);
  return {
    adapterVersion: adapterVersionFor(hosts),
    artifactFingerprints,
    binding: {
      canonicalProject: options.project,
      hosts,
      profile: profile.id,
      project: options.authoredProject,
    },
    blockers,
    engineVersion: ENGINE_VERSION,
    gitProject,
    hostVersions: adapterPlan === undefined
      ? {}
      : { [options.host]: adapterPlan.hostVersion },
    outputs,
    profile,
    resolvedProfile,
    setupSteps: adapterPlan === undefined
      ? []
      : adapterPlan.setupSteps.map((step) => ({
          ...step,
          host: adapterPlan.host,
        })),
    sourceHash,
    warnings,
  };
}

/**
 * Structured lifetime conflicts that block install-temp for one canonical Project.
 * Ordinary installations and active Temporary Profile Installations each block a
 * receipt-owned temporary lifetime (ADR-0015).
 */
export function projectConflictBlockers(
  state: Awaited<ReturnType<typeof readInstallationStateWithMigration>>["state"],
  canonicalProject: string,
): readonly BlockerInput[] {
  const blockers: BlockerInput[] = [];
  const ordinary = state.installations.find(
    (installation) => installation.project === canonicalProject,
  );
  if (ordinary) {
    blockers.push(temporaryInstallationConflictBlocker({
      message:
        "Generated files are already managed through a Project Binding; remove them " +
        "before installing a temporary Profile",
      project: canonicalProject,
    }));
  }
  const activeTemporary = state.temporaryInstallations.find(
    (installation) =>
      installation.completionState === "installed" &&
      installation.project === canonicalProject,
  );
  if (activeTemporary) {
    blockers.push(temporaryInstallationConflictBlocker({
      message:
        "An active Temporary Profile Installation already owns generated files " +
        `(${activeTemporary.temporaryInstallationId})`,
      project: canonicalProject,
      temporaryInstallationId: activeTemporary.temporaryInstallationId,
    }));
  }
  return blockers;
}

/**
 * Install one Profile temporarily into one explicit Project for one Host.
 * Does not create a Project Binding or run global reconciliation.
 */
export async function installTemporaryProfile(options: {
  readonly home: string;
  readonly host: string;
  readonly profile: string;
  readonly project: string;
  readonly hooks?: TemporaryInstallationHooks;
}): Promise<TemporaryInstallationReceipt> {
  const host = options.host;
  if (!isSupportedHost(host)) {
    throw new Error(
      `unsupported Agent Host '${host}'; temporary installation supports: ${TEMPORARY_INSTALLATION_HOSTS.join(", ")}`,
    );
  }
  const registration = hostRegistrationFor(host);
  if (!registration.supportsTemporaryProfileInstallation) {
    throw new Error(
      `temporary installation does not yet support Agent Host '${host}'; supported Hosts: ${TEMPORARY_INSTALLATION_HOSTS.join(", ")}`,
    );
  }
  const temporaryHost: TemporaryInstallationHost = registration.host;
  const profileId = requireArtifactId(options.profile, "install-temp profile");
  const canonicalProject = await normalizeProject(
    options.project,
    options.home,
    "install-temp",
  );
  const desired = await planTemporaryDesiredInstallation({
    authoredProject: options.project,
    home: options.home,
    host: temporaryHost,
    profileId,
    project: canonicalProject,
  });
  const writeState = options.hooks?.writeInstallationState ?? writeInstallationState;

  return withInstallationLifecycleLock(
    options.home,
    "install-temp",
    async () => {
      const loaded = await readInstallationStateWithMigration(options.home);
      const state = loaded.state;
      const structuredBlockers: BlockerInput[] = [
        ...desired.blockers,
        ...projectConflictBlockers(state, canonicalProject),
      ];

      const temporaryInstallationId = newInstallationId();
      structuredBlockers.push(
        ...(await desiredOutputConflicts(desired, undefined, temporaryInstallationId)),
      );
      if (structuredBlockers.length > 0) {
        throw new TemporaryInstallationBlockedError(structuredBlockers, canonicalProject);
      }

      const manifest = manifestFor(desired, temporaryInstallationId);
      const temporaryRecord: TemporaryProfileInstallation = {
        adapterVersion: manifest.adapterVersion,
        completionState: "installed",
        engineVersion: manifest.engineVersion,
        ...(manifest.gitProject === undefined ? {} : { gitProject: manifest.gitProject }),
        host: temporaryHost,
        hostVersion: manifest.hostVersions[temporaryHost]!,
        outputs: manifest.outputs,
        profileId: manifest.profileId,
        project: manifest.project,
        temporaryInstallationId,
        workspaceInputHash: manifest.workspaceInputHash,
      };

      const nextState = {
        intendedTeardowns: [],
        installations: state.installations,
        repositoryExclusions: replaceRepositoryExclusionContribution(
          state.repositoryExclusions,
          temporaryInstallationId,
          desired.gitProject,
          manifest.outputs,
        ),
        schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION as 5,
        temporaryInstallations: [
          ...state.temporaryInstallations.filter(
            (installation) =>
              installation.temporaryInstallationId !== temporaryInstallationId,
          ),
          temporaryRecord,
        ],
      };

      let durableRecorded = false;
      let ownershipTokenPublished = false;
      let outputsPublished = false;
      let exclusionsCommitted = false;
      let transaction: Awaited<ReturnType<typeof stageProjectOutputs>> | undefined;
      let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;

      try {
        // Durable recovery identity before any owned project mutation can be orphaned.
        await writeState(options.home, nextState);
        durableRecorded = true;
        await options.hooks?.onAfterDurableRecord?.();

        // First owned project mutation: Installation Marker as recovery ownership token
        // so later partial publication (or marker-last staging) still proves ownership.
        await writeTemporaryOwnershipToken(canonicalProject, temporaryInstallationId);
        ownershipTokenPublished = true;
        await options.hooks?.onAfterOwnershipToken?.();

        const fileSystem: ReconciliationFileSystem = {
          ...nodeFileSystem,
          ...options.hooks?.fileSystem,
        };
        transaction = await stageProjectOutputs(
          desired,
          manifest,
          undefined,
          fileSystem,
        );
        outputsPublished = true;
        await options.hooks?.onAfterOutputsPublished?.();

        exclusions = await stageGitExclusions(state, nextState);
        await exclusions.commit();
        exclusionsCommitted = true;
        await options.hooks?.onAfterExclusionCommit?.();

        await transaction.commit();
      } catch (error) {
        if (exclusions && !exclusionsCommitted) {
          try {
            await exclusions.rollback();
          } catch {
            // Preserve the primary failure; exclusion rollback is best-effort.
          }
        }
        if (transaction && outputsPublished) {
          try {
            await transaction.rollback();
          } catch {
            // Preserve the primary failure.
          }
        }

        const failureMessage = error instanceof Error ? error.message : String(error);
        const removalRequired = durableRecorded && ownershipTokenPublished;
        if (removalRequired) {
          throw new TemporaryInstallationRecoverableError(
            temporaryInstallationId,
            `Temporary Profile Installation ${temporaryInstallationId} requires removal after a partial publication failure: ${failureMessage}`,
          );
        }
        if (durableRecorded) {
          try {
            await writeState(options.home, state);
          } catch {
            // Preserve the primary failure.
          }
        }
        throw error;
      }

      return receiptFromRecord(
        temporaryRecord,
        exclusionContributionFor(nextState, temporaryInstallationId),
        {
          diagnosticValues: [...new Set(
            desired.warnings.flatMap((warning) => warning.copyableValues),
          )].sort(),
          setupSteps: desired.setupSteps,
          warnings: desired.warnings.map((warning) => warning.message),
        },
      );
    },
    options.hooks?.lockTimeoutMs === undefined
      ? {}
      : { lockTimeoutMs: options.hooks.lockTimeoutMs },
  );
}

/**
 * Remove one Temporary Profile Installation by durable identity.
 * Idempotent for a successfully removed identity. Discards modifications and
 * new members inside complete temporary-owned directories without traversing
 * outside recorded roots.
 */
export async function removeTemporaryProfile(options: {
  readonly home: string;
  readonly temporaryInstallationId: string;
  readonly hooks?: TemporaryInstallationHooks;
}): Promise<TemporaryInstallationReceipt> {
  const temporaryInstallationId = options.temporaryInstallationId.trim();
  if (temporaryInstallationId.length === 0) {
    throw new Error("remove-temp requires a temporary installation identity");
  }
  const writeState = options.hooks?.writeInstallationState ?? writeInstallationState;

  return withInstallationLifecycleLock(
    options.home,
    "remove-temp",
    async () => {
      const loaded = await readInstallationStateWithMigration(options.home);
      const state = loaded.state;
      const existing = state.temporaryInstallations.find(
        (installation) => installation.temporaryInstallationId === temporaryInstallationId,
      );
      if (!existing) {
        throw new Error(
          `unknown temporary installation identity '${temporaryInstallationId}'`,
        );
      }
      if (existing.completionState === "removed") {
        return receiptFromRecord(existing, undefined);
      }

      const removedRecord: TemporaryProfileInstallation = {
        adapterVersion: existing.adapterVersion,
        completionState: "removed",
        engineVersion: existing.engineVersion,
        ...(existing.gitProject === undefined ? {} : { gitProject: existing.gitProject }),
        host: existing.host,
        hostVersion: existing.hostVersion,
        outputs: [],
        profileId: existing.profileId,
        project: existing.project,
        temporaryInstallationId: existing.temporaryInstallationId,
        workspaceInputHash: existing.workspaceInputHash,
      };
      const nextState = {
        intendedTeardowns: [],
        installations: state.installations,
        repositoryExclusions: replaceRepositoryExclusionContribution(
          state.repositoryExclusions,
          temporaryInstallationId,
          undefined,
          [],
        ),
        schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION as 5,
        temporaryInstallations: state.temporaryInstallations.map((installation) =>
          installation.temporaryInstallationId === temporaryInstallationId
            ? removedRecord
            : installation
        ),
      };

      let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
      let exclusionsCommitted = false;
      try {
        // Direct idempotent deletes — no process-private stage that can be orphaned.
        await removeDisposableOutputs({
          installationId: existing.temporaryInstallationId,
          outputs: existing.outputs,
          project: existing.project,
        });
        await options.hooks?.onAfterRootDeletes?.();
        exclusions = await stageGitExclusions(state, nextState);
        // Commit exclusion cleanup before the terminal state write so an interrupted
        // remove leaves an `installed` record that retry can finish.
        await exclusions.commit();
        exclusionsCommitted = true;
        await options.hooks?.onBeforeTerminalStateWrite?.();
        await writeState(options.home, nextState);
      } catch (error) {
        if (exclusions && !exclusionsCommitted) {
          try {
            await exclusions.rollback();
          } catch {
            // Preserve the primary failure.
          }
        }
        if (error instanceof Error && error.message.startsWith("Cannot remove Temporary")) {
          throw new TemporaryInstallationBlockedError([
            temporaryInstallationRemovalBlocker({
              message: error.message,
              outputs: existing.outputs.map((output) => output.path),
              project: existing.project,
            }),
          ], existing.project);
        }
        throw error;
      }

      return receiptFromRecord(removedRecord, undefined);
    },
    options.hooks?.lockTimeoutMs === undefined
      ? {}
      : { lockTimeoutMs: options.hooks.lockTimeoutMs },
  );
}
