import { isSupportedHost, type SupportedHost } from "../adapters/host-catalog.js";
import {
  OWNERSHIP_STATE_SCHEMA_VERSION,
  formatOwnershipState,
  parseOwnershipState,
  type OwnershipHostReceipt,
  type OwnershipOutputReceipt,
  type OwnershipReceipt,
  type OwnershipRepositoryExclusionContribution,
  type OwnershipState,
} from "../schemas/ownership-state.js";
import {
  INSTALLATION_MARKER_PATH,
  type ProjectInstallationManifest,
  type RepositoryExclusionRecord,
  type TemporaryProfileInstallation,
} from "../schemas/installation-manifest.js";

export interface LegacyOwnershipState {
  readonly installations: readonly ProjectInstallationManifest[];
  readonly repositoryExclusions?: readonly RepositoryExclusionRecord[];
  readonly temporaryInstallations?: readonly TemporaryProfileInstallation[];
}

function legacyAdapterVersionForHost(
  installation: ProjectInstallationManifest,
  host: SupportedHost,
): string {
  const versions = installation.adapterVersion.split("+");
  const version = versions.find((candidate) => candidate.startsWith(`${host}-`)) ??
    (installation.hosts.length === 1 && versions.length === 1 ? versions[0] : undefined);
  if (version === undefined) {
    throw new Error(
      `Legacy Installation ${installation.installationId} does not identify the ${host} Adapter version`,
    );
  }
  return version;
}

function minimalOutputs(
  outputs: ProjectInstallationManifest["outputs"] | TemporaryProfileInstallation["outputs"],
): readonly OwnershipOutputReceipt[] {
  return outputs
    .filter((output) => output.path !== INSTALLATION_MARKER_PATH)
    .map((output) => ({
      hash: output.hash,
      mode: output.mode,
      path: output.path,
      type: output.type,
    }));
}

/**
 * Purely contract supported legacy ownership facts into the final receipt model.
 * Transitional YAML parsing and schema-v2 Git topology recovery remain upstream.
 */
export function normalizeLegacyOwnershipState(state: LegacyOwnershipState): OwnershipState {
  const exclusionByInstallationId = new Map<
    string,
    OwnershipRepositoryExclusionContribution
  >();
  for (const record of state.repositoryExclusions ?? []) {
    for (const contribution of record.contributions) {
      if (exclusionByInstallationId.has(contribution.installationId)) {
        throw new Error(
          `Legacy Installation State records more than one Git exclusion contribution for ${contribution.installationId}`,
        );
      }
      exclusionByInstallationId.set(contribution.installationId, {
        entries: contribution.entries,
        target: record.target,
      });
    }
  }

  const ordinaryReceipts: OwnershipReceipt[] = state.installations.map((installation) => {
    const hosts: Partial<Record<SupportedHost, OwnershipHostReceipt>> = {};
    for (const host of installation.hosts) {
      if (!isSupportedHost(host)) {
        throw new Error(
          `Legacy Installation ${installation.installationId} has unsupported Host '${host}'`,
        );
      }
      const capabilityContract = installation.hostVersions[host];
      if (capabilityContract === undefined) {
        throw new Error(
          `Legacy Installation ${installation.installationId} has no ${host} Capability Contract`,
        );
      }
      hosts[host] = {
        adapterVersion: legacyAdapterVersionForHost(installation, host),
        capabilityContract,
      };
    }
    const repositoryExclusion = exclusionByInstallationId.get(installation.installationId);
    return {
      desiredInputDigest: installation.workspaceInputHash,
      hosts,
      installationId: installation.installationId,
      lifetime: "ordinary",
      outputs: minimalOutputs(installation.outputs),
      profileId: installation.profileId,
      project: installation.project,
      ...(repositoryExclusion === undefined ? {} : { repositoryExclusion }),
    };
  });

  const activeTemporaryReceipts: OwnershipReceipt[] = [];
  const removedTemporaryInstallationIds: string[] = [];
  for (const installation of state.temporaryInstallations ?? []) {
    if (installation.completionState === "removed") {
      removedTemporaryInstallationIds.push(installation.temporaryInstallationId);
      continue;
    }
    const repositoryExclusion = exclusionByInstallationId.get(
      installation.temporaryInstallationId,
    );
    activeTemporaryReceipts.push({
      desiredInputDigest: installation.workspaceInputHash,
      hosts: {
        [installation.host]: {
          adapterVersion: installation.adapterVersion,
          capabilityContract: installation.hostVersion,
        },
      },
      installationId: installation.temporaryInstallationId,
      lifetime: "temporary",
      outputs: minimalOutputs(installation.outputs),
      profileId: installation.profileId,
      project: installation.project,
      ...(repositoryExclusion === undefined ? {} : { repositoryExclusion }),
    });
  }

  const activeReceipts = [...ordinaryReceipts, ...activeTemporaryReceipts];
  const activeIds = new Set(activeReceipts.map((receipt) => receipt.installationId));
  for (const installationId of exclusionByInstallationId.keys()) {
    if (!activeIds.has(installationId)) {
      throw new Error(
        `Legacy Installation State Git exclusion contribution references unknown active Installation ID ${installationId}`,
      );
    }
  }

  return parseOwnershipState(formatOwnershipState({
    receipts: activeReceipts,
    removedTemporaryInstallationIds,
    schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
  }));
}
