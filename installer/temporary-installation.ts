
import { dirname } from "node:path";

import {
  hostRegistrationFor,
  TEMPORARY_INSTALLATION_HOSTS,
  type TemporaryInstallationHost,
} from "../adapters/registry.js";
import {
  flatInlineText,
  type AdapterDiagnosticWarning,
  type HostSetupStep,
  type InlineContent,
} from "../adapters/project-plan.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import {
  isSupportedHost,
  type SupportedHost,
} from "../schemas/local-configuration.js";
import type { OwnershipReceipt } from "../schemas/ownership-state.js";
import { publishRepositoryExclusions, type RepositoryExclusionWarning } from "./git-exclusions.js";
import { findGitProject } from "./git.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import {
  newInstallationId,
  readInstallationState,
  removeDisposableOutputs,
  writeInstallationState,
} from "./installation-state.js";
import {
  ingestApplication,
  normalizeProject,
} from "./local-configuration.js";
import { InstallerToolError } from "./tool-errors.js";
import { createLifecycleOwnershipInspectionContext } from "./lifecycle-ownership-inspection.js";
import { createLifecyclePlanningContext } from "./lifecycle-planning.js";
import { requireProfile } from "./profile-selection.js";
import {
  adapterVersionFor,
  appendDiagnosticWarnings,
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
  normalizeBlocker,
  temporaryInstallationConflictBlocker,
  temporaryInstallationRemovalBlocker,
  type BlockerInput,
  type ReconciliationBlocker,
} from "./blockers.js";
import { TemporaryRemovalBlockedError } from "./installation-state.js";
import {
  capabilityWarning,
  type HostCapabilityWarning,
} from "./project-plan.js";
import { ENGINE_VERSION } from "./version.js";
import {
  ordinaryReceipts,
  temporaryReceipts,
  withReceipts,
} from "./ownership-state.js";

export {
  isTemporaryInstallationHost,
  TEMPORARY_INSTALLATION_HOSTS,
  type TemporaryInstallationHost,
} from "../adapters/registry.js";

export class TemporaryInstallationBlockedError extends Error {
  readonly #canonical: readonly ReconciliationBlocker[];
  readonly #canonicalProject: string;

  /**
   * Accept one canonical blocker-input collection and normalize it once. The
   * blockers carry typed facts only; presentation owns every rendered sentence.
   * The canonical Project the blocked operation targeted is part of the error's
   * identity, so it is required.
   */
  constructor(inputs: readonly BlockerInput[], canonicalProject: string) {
    const canonical = inputs.map((input) => normalizeBlocker(input));
    super(`temporary installation blocked: ${canonicalProject}`);
    this.name = "TemporaryInstallationBlockedError";
    this.#canonical = canonical;
    this.#canonicalProject = canonicalProject;
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
  readonly adapterVersion?: string;
  readonly completionState: "installed" | "removed";
  readonly engineVersion?: string;
  readonly host?: string;
  readonly hostVersion?: string;
  readonly outputs: readonly string[];
  readonly profileId?: string;
  readonly project?: string;
  /** Adapter-authored Host Setup Steps required after successful temporary install. */
  readonly setupSteps: readonly HostSetupStep[];
  readonly temporaryInstallationId: string;
  /** Structured values referenced by configuration warnings on the live receipt. */
  readonly diagnosticValues: readonly string[];
  /** Configuration warnings that do not block install but can prevent Host loading. */
  readonly warnings: readonly string[];
  readonly warningParts?: readonly (readonly InlineContent[])[];
  readonly workspaceInputHash?: string;
}

/** Test-only hooks for failure injection at Installer transaction boundaries. */
export interface TemporaryInstallationHooks {
  readonly fileSystem?: Partial<ReconciliationFileSystem>;
  readonly lockTimeoutMs?: number;
  readonly onAfterDurableRecord?: () => Promise<void>;
  readonly onAfterExclusionCommit?: () => Promise<void>;
  readonly onAfterOutputsPublished?: () => Promise<void>;
  readonly onAfterRootDeletes?: () => Promise<void>;
  readonly onBeforeTerminalStateWrite?: () => Promise<void>;
  readonly writeInstallationState?: typeof writeInstallationState;
}

function receiptFromRecord(
  record: OwnershipReceipt,
  completionState: "installed" | "removed",
  options: {
    readonly diagnosticValues?: readonly string[];
    readonly setupSteps?: readonly HostSetupStep[];
    readonly warnings?: readonly string[];
    readonly warningParts?: readonly (readonly InlineContent[])[];
  } = {},
): TemporaryInstallationReceipt {
  const host = Object.keys(record.hosts)[0]! as SupportedHost;
  const hostReceipt = record.hosts[host]!;
  return {
    adapterVersion: hostReceipt.adapterVersion,
    completionState,
    engineVersion: ENGINE_VERSION,
    host,
    hostVersion: hostReceipt.capabilityContract,
    outputs: completionState === "installed" ? record.outputs.map((output) => output.path) : [],
    profileId: record.profileId,
    project: record.project,
    setupSteps: options.setupSteps ?? [],
    temporaryInstallationId: record.installationId,
    diagnosticValues: options.diagnosticValues ?? [],
    warnings: options.warnings ?? [],
    ...(options.warningParts === undefined ? {} : { warningParts: options.warningParts }),
    workspaceInputHash: record.desiredInputDigest,
  };
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
  const capabilityWarnings: HostCapabilityWarning[] = [];
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
  for (const failure of result.capabilityFailures) {
    capabilityWarnings.push(capabilityWarning(options.host, failure));
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
    capabilityWarnings,
    engineVersion: ENGINE_VERSION,
    gitProject,
    hostVersions: { [options.host]: adapterPlan.hostVersion },
    outputs,
    profile,
    resolvedProfile,
    setupSteps: adapterPlan.setupSteps.map((step) => ({
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
  state: Awaited<ReturnType<typeof readInstallationState>>,
  canonicalProject: string,
): readonly BlockerInput[] {
  const blockers: BlockerInput[] = [];
  const ordinary = ordinaryReceipts(state).find(
    (installation) => installation.project === canonicalProject,
  );
  if (ordinary) {
    blockers.push(temporaryInstallationConflictBlocker({
      project: canonicalProject,
    }));
  }
  const activeTemporary = temporaryReceipts(state).find(
    (installation) => installation.project === canonicalProject,
  );
  if (activeTemporary) {
    blockers.push(temporaryInstallationConflictBlocker({
      project: canonicalProject,
      temporaryInstallationId: activeTemporary.installationId,
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
    throw new InstallerToolError({
      kind: "unsupported-temporary-host",
      host,
      supportedHosts: TEMPORARY_INSTALLATION_HOSTS,
    });
  }
  const registration = hostRegistrationFor(host);
  if (!registration.supportsTemporaryProfileInstallation) {
    throw new InstallerToolError({
      kind: "temporary-host-unsupported",
      host,
      supportedHosts: TEMPORARY_INSTALLATION_HOSTS,
    });
  }
  const temporaryHost: TemporaryInstallationHost = registration.host;
  const profileId = requireArtifactId(options.profile, "install-temp profile");
  const canonicalProject = await normalizeProject(
    options.project,
    options.home,
    { source: "install-temp" },
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
      const state = await readInstallationState(options.home);
      const structuredBlockers: BlockerInput[] = [
        ...projectConflictBlockers(state, canonicalProject),
      ];

      const temporaryInstallationId = newInstallationId();
      structuredBlockers.push(
        ...(await desiredOutputConflicts(
          desired,
          undefined,
          createLifecycleOwnershipInspectionContext(),
          undefined,
          // The durable Receipt precedes Project mutation, so every recorded
          // destination must be proven absent here: adopting pre-existing
          // byte-identical bytes would give the recovery removal authority
          // over material this install never published.
          { adoptByteIdentical: false },
        )),
      );
      if (structuredBlockers.length > 0) {
        throw new TemporaryInstallationBlockedError(structuredBlockers, canonicalProject);
      }

      const temporaryRecord: OwnershipReceipt = {
        ...manifestFor(desired, temporaryInstallationId),
        lifetime: "temporary",
      };
      const nextState = withReceipts(state, [
        ...state.receipts.filter(
          (receipt) => receipt.installationId !== temporaryInstallationId,
        ),
        temporaryRecord,
      ]);

      let durableRecorded = false;
      let outputsPublished = false;
      const publicationWarnings: RepositoryExclusionWarning[] = [];
      let transaction: Awaited<ReturnType<typeof stageProjectOutputs>> | undefined;

      try {
        // Durable recovery identity before any owned project mutation can be orphaned.
        await writeState(options.home, nextState);
        durableRecorded = true;
        await options.hooks?.onAfterDurableRecord?.();

        const fileSystem: ReconciliationFileSystem = {
          ...nodeFileSystem,
          ...options.hooks?.fileSystem,
        };
        transaction = await stageProjectOutputs(
          desired,
          temporaryRecord,
          undefined,
          fileSystem,
        );
        outputsPublished = true;
        await options.hooks?.onAfterOutputsPublished?.();

        // Best-effort exclusion publication from the temporary receipt's
        // recorded output roots; a failure is a warning, never a Blocker.
        const publication = await publishRepositoryExclusions(nextState, {
          includedProjects: new Set([canonicalProject]),
          previousState: state,
        });
        publicationWarnings.push(...publication.warnings);
        await options.hooks?.onAfterExclusionCommit?.();

        await transaction.commit();
      } catch (error) {
        if (transaction && outputsPublished) {
          try {
            await transaction.rollback();
          } catch {
            // Preserve the primary failure.
          }
        }

        const failureMessage = error instanceof Error ? error.message : String(error);
        // The durable state record is the recovery token: once it exists the
        // partial installation must stay recoverable through remove-temp.
        const removalRequired = durableRecorded;
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
        "installed",
        {
          diagnosticValues: [...new Set([
            ...desired.warnings.flatMap((warning) => warning.copyableValues),
            ...desired.capabilityWarnings.flatMap((entry) => entry.warning.copyableValues),
          ])].sort(),
          setupSteps: desired.setupSteps,
          warnings: [
            ...desired.warnings.map((warning) => flatInlineText(warning.parts)),
            ...desired.capabilityWarnings.map((entry) => flatInlineText(entry.warning.parts)),
            ...publicationWarnings.map((warning) => flatInlineText(warning.parts)),
          ],
          warningParts: [
            ...desired.warnings.map((warning) => warning.parts),
            ...desired.capabilityWarnings.map((entry) => entry.warning.parts),
            ...publicationWarnings.map((warning) => warning.parts),
          ],
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
    throw new InstallerToolError({ kind: "temporary-identity-required" });
  }
  const writeState = options.hooks?.writeInstallationState ?? writeInstallationState;

  return withInstallationLifecycleLock(
    options.home,
    "remove-temp",
    async () => {
      const state = await readInstallationState(options.home);
      const existing = temporaryReceipts(state).find(
        (installation) => installation.installationId === temporaryInstallationId,
      );
      if (!existing) {
        if (state.removedTemporaryInstallationIds.includes(temporaryInstallationId)) {
          return {
            completionState: "removed",
            outputs: [],
            setupSteps: [],
            temporaryInstallationId,
            diagnosticValues: [],
            warnings: [],
          };
        }
        throw new InstallerToolError({
          kind: "unknown-temporary-identity",
          temporaryInstallationId,
        });
      }
      const nextState = {
        ...withReceipts(
          state,
          state.receipts.filter(
            (receipt) => receipt.installationId !== temporaryInstallationId,
          ),
        ),
        removedTemporaryInstallationIds: [
          ...state.removedTemporaryInstallationIds,
          temporaryInstallationId,
        ],
      };

      const publicationWarnings: RepositoryExclusionWarning[] = [];
      try {
        // Direct idempotent deletes — no process-private stage that can be orphaned.
        await removeDisposableOutputs({
          installationId: existing.installationId,
          outputs: existing.outputs,
          project: existing.project,
        });
        await options.hooks?.onAfterRootDeletes?.();
        // Best-effort exclusion cleanup before the terminal state write so an
        // interrupted remove leaves an `installed` record that retry can finish.
        const publication = await publishRepositoryExclusions(nextState, {
          includedProjects: new Set([existing.project]),
          previousState: state,
        });
        publicationWarnings.push(...publication.warnings);
        await options.hooks?.onBeforeTerminalStateWrite?.();
        await writeState(options.home, nextState);
      } catch (error) {
        if (error instanceof TemporaryRemovalBlockedError) {
          throw new TemporaryInstallationBlockedError([
            temporaryInstallationRemovalBlocker({
              failure: error.failure,
              outputs: existing.outputs.map((output) => output.path),
              project: existing.project,
            }),
          ], existing.project);
        }
        throw error;
      }

      return receiptFromRecord(existing, "removed", {
        warnings: publicationWarnings.map((warning) => flatInlineText(warning.parts)),
        warningParts: publicationWarnings.map((warning) => warning.parts),
      });
    },
    options.hooks?.lockTimeoutMs === undefined
      ? {}
      : { lockTimeoutMs: options.hooks.lockTimeoutMs },
  );
}
