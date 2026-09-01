export interface RepositoryExclusionContribution {
  readonly entries: readonly string[];
  readonly installationId: string;
}

/** One derived expected section for a repository-local Git exclusion file. */
export interface RepositoryExclusionRecord {
  readonly target: string;
  readonly contributions: readonly RepositoryExclusionContribution[];
  readonly entries: readonly string[];
}

/** Stable byte-order comparator shared by canonical state and on-disk unions. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseFileMode(value: unknown, description: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    throw new Error(`${description} must be an integer permission mode between 0 and 0777`);
  }
  return value as number;
}

/** Build one derived expected record from active receipt contributions. */
export function canonicalRepositoryExclusionRecord(
  target: string,
  contributions: readonly RepositoryExclusionContribution[],
): RepositoryExclusionRecord {
  const canonicalContributions = [...contributions]
    .map((contribution) => ({
      entries: [...new Set(contribution.entries)].sort(compareCanonicalStrings),
      installationId: contribution.installationId,
    }))
    .sort((left, right) => compareCanonicalStrings(left.installationId, right.installationId));
  return {
    contributions: canonicalContributions,
    entries: [...new Set(canonicalContributions.flatMap((contribution) => contribution.entries))]
      .sort(compareCanonicalStrings),
    target,
  };
}
