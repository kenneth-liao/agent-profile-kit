import {
  assertCodexProjectCapability,
  detectCodexProjectConfigurationWarnings,
  planCodexProject,
} from "../adapters/codex.js";
import type { HostSetupStep } from "../adapters/project-plan.js";
import {
  isSupportedHost,
  type SupportedHost,
} from "../schemas/local-configuration.js";
import {
  INSTALLATION_STATE_SCHEMA_VERSION,
  type TemporaryProfileInstallation,
} from "../schemas/installation-manifest.js";
import { skillsRequireDisabledModelInvocation } from "../adapters/skill-package.js";
import { requireArtifactId } from "../schemas/dependencies.js";
import {
  replaceRepositoryExclusionContribution,
  stageGitExclusions,
} from "./git-exclusions.js";
import { findGitProject } from "./git.js";
import { hashWorkspaceInputs } from "./hashes.js";
import {
  newInstallationId,
  proveOwnedInstallation,
  readInstallationStateWithMigration,
  stageProvenInstallationRemoval,
  writeInstallationState,
} from "./installation-state.js";
import {
  ingestApplication,
  normalizeProject,
} from "./local-configuration.js";
import { requireProfile } from "./profile-selection.js";
import {
  adapterVersionFor,
  normalizeAdapterPlans,
  type DesiredInstallation,
} from "./project-plan.js";
import { resolveProfileDependencies } from "./resolve-dependencies.js";
import {
  desiredOutputConflicts,
  manifestFor,
  stageProjectOutputs,
} from "./reconcile.js";
import { ENGINE_VERSION } from "./version.js";

/** Hosts accepted by install-temp in the current slice. */
export const TEMPORARY_INSTALLATION_HOSTS = ["codex"] as const;
export type TemporaryInstallationHost = (typeof TEMPORARY_INSTALLATION_HOSTS)[number];

export function isTemporaryInstallationHost(
  value: string,
): value is TemporaryInstallationHost {
  return (TEMPORARY_INSTALLATION_HOSTS as readonly string[]).includes(value);
}

export class TemporaryInstallationBlockedError extends Error {
  readonly blockers: readonly string[];

  constructor(blockers: readonly string[]) {
    super(blockers.join("\n"));
    this.name = "TemporaryInstallationBlockedError";
    this.blockers = blockers;
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
  /** Configuration warnings that do not block install but can prevent Host loading. */
  readonly warnings: readonly string[];
  readonly workspaceInputHash: string;
}

function receiptFromRecord(
  record: TemporaryProfileInstallation,
  repositoryExclusion:
    | TemporaryInstallationReceipt["repositoryExclusion"]
    | undefined,
  options: {
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
  const resolvedProfile = resolveProfileDependencies(
    profile,
    workspace.contexts,
    workspace.skills,
  );
  if (profile.agents.length > 0 || profile.hooks.length > 0 || profile.tools.length > 0) {
    throw new Error(
      `Profile '${profile.id}' selects unsupported artifact categories; Agents, Hooks, and Tools are not supported in the project-bound slice`,
    );
  }
  const gitProject = await findGitProject(options.project);
  const sourceHash = await hashWorkspaceInputs(profile, resolvedProfile);
  const blockers: string[] = [];
  const warnings: string[] = [];
  const requireDisabledModelInvocation = skillsRequireDisabledModelInvocation(
    resolvedProfile.skills,
  );
  const requireContext = resolvedProfile.contexts.length > 0;
  try {
    await assertCodexProjectCapability(options.home, options.project, {
      requireContext,
      requireDisabledModelInvocation,
    });
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }
  if (requireContext) {
    warnings.push(
      ...(await detectCodexProjectConfigurationWarnings(options.home, options.project)),
    );
  }
  const contextPath = [
    gitProject?.relativeProject ?? "",
    ".agent-profile-kit",
    "codex",
    "context.md",
  ].filter((part) => part.length > 0).join("/");
  const adapterPlan = await planCodexProject(
    profile.id,
    resolvedProfile.contexts,
    resolvedProfile.skills,
    {
      contextPath,
      ...(!gitProject && requireContext
        ? { requiresBoundRootLaunch: true }
        : {}),
    },
  );
  const hosts: readonly SupportedHost[] = [options.host];
  return {
    adapterVersion: adapterVersionFor(hosts),
    binding: {
      canonicalProject: options.project,
      hosts,
      profile: profile.id,
      project: options.authoredProject,
    },
    blockers,
    engineVersion: ENGINE_VERSION,
    gitProject,
    hostVersions: { [options.host]: adapterPlan.hostVersion },
    outputs: normalizeAdapterPlans([adapterPlan]),
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
 * Install one Profile temporarily into one explicit Project for one Host.
 * Does not create a Project Binding or run global reconciliation.
 */
export async function installTemporaryProfile(options: {
  readonly home: string;
  readonly host: string;
  readonly profile: string;
  readonly project: string;
}): Promise<TemporaryInstallationReceipt> {
  if (!isSupportedHost(options.host)) {
    throw new Error(
      `unsupported Agent Host '${options.host}'; temporary installation supports: ${TEMPORARY_INSTALLATION_HOSTS.join(", ")}`,
    );
  }
  if (!isTemporaryInstallationHost(options.host)) {
    throw new Error(
      `temporary installation does not yet support Agent Host '${options.host}'; supported Hosts: ${TEMPORARY_INSTALLATION_HOSTS.join(", ")}`,
    );
  }
  const profileId = requireArtifactId(options.profile, "install-temp profile");
  const canonicalProject = await normalizeProject(
    options.project,
    options.home,
    "install-temp",
  );
  const desired = await planTemporaryDesiredInstallation({
    authoredProject: options.project,
    home: options.home,
    host: options.host,
    profileId,
    project: canonicalProject,
  });
  const loaded = await readInstallationStateWithMigration(options.home);
  const state = loaded.state;
  const blockers = [...desired.blockers];

  const ordinary = state.installations.find(
    (installation) => installation.project === canonicalProject,
  );
  if (ordinary) {
    blockers.push(
      `${canonicalProject} already has an ordinary Profile Installation; remove it before installing a temporary Profile`,
    );
  }
  const activeTemporary = state.temporaryInstallations.find(
    (installation) =>
      installation.completionState === "installed" &&
      installation.project === canonicalProject,
  );
  if (activeTemporary) {
    blockers.push(
      `${canonicalProject} already has an active Temporary Profile Installation (${activeTemporary.temporaryInstallationId})`,
    );
  }

  const temporaryInstallationId = newInstallationId();
  blockers.push(
    ...(await desiredOutputConflicts(desired, undefined, temporaryInstallationId)),
  );
  if (blockers.length > 0) {
    throw new TemporaryInstallationBlockedError(blockers);
  }

  const manifest = manifestFor(desired, temporaryInstallationId);
  const temporaryRecord: TemporaryProfileInstallation = {
    adapterVersion: manifest.adapterVersion,
    completionState: "installed",
    engineVersion: manifest.engineVersion,
    ...(manifest.gitProject === undefined ? {} : { gitProject: manifest.gitProject }),
    host: options.host,
    hostVersion: manifest.hostVersions[options.host]!,
    outputs: manifest.outputs,
    profileId: manifest.profileId,
    project: manifest.project,
    temporaryInstallationId,
    workspaceInputHash: manifest.workspaceInputHash,
  };

  const nextState = {
    intendedTeardowns: state.intendedTeardowns,
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
        (installation) => installation.temporaryInstallationId !== temporaryInstallationId,
      ),
      temporaryRecord,
    ],
  };

  let transaction: Awaited<ReturnType<typeof stageProjectOutputs>> | undefined;
  let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
  let stateWriteAttempted = false;
  try {
    transaction = await stageProjectOutputs(desired, manifest, undefined);
    exclusions = await stageGitExclusions(state, nextState);
    stateWriteAttempted = true;
    await writeInstallationState(options.home, nextState);
    await exclusions.commit();
    await transaction.commit();
  } catch (error) {
    if (exclusions) {
      try {
        await exclusions.rollback();
      } catch {
        // Preserve the primary failure; exclusion rollback is best-effort.
      }
    }
    if (transaction) await transaction.rollback();
    if (stateWriteAttempted) {
      try {
        await writeInstallationState(options.home, state);
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
      setupSteps: desired.setupSteps,
      warnings: desired.warnings,
    },
  );
}

/**
 * Remove one Temporary Profile Installation by durable identity.
 * Idempotent for a successfully removed identity.
 */
export async function removeTemporaryProfile(options: {
  readonly home: string;
  readonly temporaryInstallationId: string;
}): Promise<TemporaryInstallationReceipt> {
  const temporaryInstallationId = options.temporaryInstallationId.trim();
  if (temporaryInstallationId.length === 0) {
    throw new Error("remove-temp requires a temporary installation identity");
  }
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

  const proof = await proveOwnedInstallation({
    adapterVersion: existing.adapterVersion,
    engineVersion: existing.engineVersion,
    ...(existing.gitProject === undefined ? {} : { gitProject: existing.gitProject }),
    hosts: [existing.host],
    hostVersions: { [existing.host]: existing.hostVersion },
    installationId: existing.temporaryInstallationId,
    outputs: existing.outputs,
    profileId: existing.profileId,
    project: existing.project,
    resolvedArtifacts: [],
    schemaVersion: 2,
    selectedContext: [],
    workspaceInputHash: existing.workspaceInputHash,
  });
  if (!proof.owned) {
    throw new TemporaryInstallationBlockedError([
      `${existing.project}: ${proof.reason ?? "ownership could not be proven"}`,
    ]);
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
    intendedTeardowns: state.intendedTeardowns,
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

  let transaction: Awaited<ReturnType<typeof stageProvenInstallationRemoval>> | undefined;
  let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
  let stateWriteAttempted = false;
  try {
    transaction = await stageProvenInstallationRemoval({
      adapterVersion: existing.adapterVersion,
      engineVersion: existing.engineVersion,
      ...(existing.gitProject === undefined ? {} : { gitProject: existing.gitProject }),
      hosts: [existing.host],
      hostVersions: { [existing.host]: existing.hostVersion },
      installationId: existing.temporaryInstallationId,
      outputs: existing.outputs,
      profileId: existing.profileId,
      project: existing.project,
      resolvedArtifacts: [],
      schemaVersion: 2,
      selectedContext: [],
      workspaceInputHash: existing.workspaceInputHash,
    });
    exclusions = await stageGitExclusions(state, nextState);
    stateWriteAttempted = true;
    await writeInstallationState(options.home, nextState);
    await exclusions.commit();
    await transaction.commit();
  } catch (error) {
    if (exclusions) {
      try {
        await exclusions.rollback();
      } catch {
        // Preserve the primary failure.
      }
    }
    if (transaction) await transaction.rollback();
    if (stateWriteAttempted) {
      try {
        await writeInstallationState(options.home, state);
      } catch {
        // Preserve the primary failure.
      }
    }
    throw error;
  }

  return receiptFromRecord(removedRecord, undefined);
}
