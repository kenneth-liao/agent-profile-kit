export const INSTALLATION_MARKER_SCHEMA_VERSION = 1;
export const INSTALLATION_MARKER_PATH = ".agent-profile-kit/installation.json";

export interface InstallationMarker {
  readonly installationId: string;
  readonly schemaVersion: 1;
}

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

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  description: string,
): void {
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    throw new Error(`${description} does not allow fields: ${unknown.join(", ")}`);
  }
}

export function parseInstallationMarker(source: string): InstallationMarker {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Installation Marker is invalid JSON");
  }
  const marker = requireMapping(value, "Installation Marker");
  requireExactFields(marker, ["schema_version", "installation_id"], "Installation Marker");
  if (marker.schema_version !== INSTALLATION_MARKER_SCHEMA_VERSION) {
    throw new Error(
      `Installation Marker schema_version must be ${INSTALLATION_MARKER_SCHEMA_VERSION}`,
    );
  }
  return {
    installationId: requireString(
      marker.installation_id,
      "Installation Marker installation_id",
    ),
    schemaVersion: INSTALLATION_MARKER_SCHEMA_VERSION,
  };
}

export function formatInstallationMarker(marker: InstallationMarker): string {
  return `${JSON.stringify(
    {
      schema_version: marker.schemaVersion,
      installation_id: marker.installationId,
    },
    null,
    2,
  )}\n`;
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
