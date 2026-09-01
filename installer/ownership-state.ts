import {
  compareCanonicalStrings,
  type RepositoryExclusionRecord,
} from "../schemas/installation-manifest.js";
import {
  OWNERSHIP_STATE_SCHEMA_VERSION,
  type OwnershipReceipt,
  type OwnershipRepositoryExclusionContribution,
  type OwnershipState,
} from "../schemas/ownership-state.js";

export function ordinaryReceipts(state: OwnershipState): readonly OwnershipReceipt[] {
  return state.receipts.filter(
    (receipt) => receipt.lifetime === "ordinary" && receipt.retired !== true,
  );
}

/**
 * The one reader for receipts `unbind` retired: no longer active ownership,
 * invisible to uninstall and receipt replacement, still the sole teardown
 * authority whose recorded detail a later `apply` consumes to prove and remove
 * generated output. Carries exactly the detail the active receipt recorded;
 * retirement adds nothing.
 */
export function retiredReceipts(state: OwnershipState): readonly OwnershipReceipt[] {
  return state.receipts.filter(
    (receipt) => receipt.lifetime === "ordinary" && receipt.retired === true,
  );
}

export function temporaryReceipts(state: OwnershipState): readonly OwnershipReceipt[] {
  return state.receipts.filter((receipt) => receipt.lifetime === "temporary");
}

export function withReceipts(
  state: OwnershipState,
  receipts: readonly OwnershipReceipt[],
): OwnershipState {
  return {
    ...state,
    receipts: [...receipts].sort((left, right) => compareCanonicalStrings(left.project, right.project)),
    schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
  };
}

/** Derive the deterministic on-disk union for every contribution target. */
export function repositoryExclusionRecords(
  state: Pick<OwnershipState, "receipts">,
): readonly RepositoryExclusionRecord[] {
  const byTarget = new Map<string, { entries: readonly string[]; installationId: string }[]>();
  for (const receipt of state.receipts) {
    const contribution = receipt.repositoryExclusion;
    if (contribution === undefined) continue;
    const values = byTarget.get(contribution.target) ?? [];
    values.push({ entries: contribution.entries, installationId: receipt.installationId });
    byTarget.set(contribution.target, values);
  }
  return [...byTarget.entries()]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([target, contributions]) => ({
      contributions: [...contributions].sort((left, right) =>
        compareCanonicalStrings(left.installationId, right.installationId)
      ),
      entries: [...new Set(contributions.flatMap((contribution) => contribution.entries))]
        .sort(compareCanonicalStrings),
      target,
    }));
}

export function withRepositoryExclusion(
  receipts: readonly OwnershipReceipt[],
  installationId: string,
  repositoryExclusion: OwnershipRepositoryExclusionContribution | undefined,
): readonly OwnershipReceipt[] {
  let found = false;
  const next = receipts.map((receipt) => {
    if (receipt.installationId !== installationId) return receipt;
    found = true;
    const { repositoryExclusion: _current, ...withoutContribution } = receipt;
    return repositoryExclusion === undefined
      ? withoutContribution
      : { ...withoutContribution, repositoryExclusion };
  });
  if (!found) throw new Error(`Unknown active Installation ID ${installationId}`);
  return next;
}
