export const ARTIFACT_TYPES = ["context", "skill"] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ArtifactReference {
  readonly id: string;
  readonly type: ArtifactType;
}

const ARTIFACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function requireArtifactId(value: unknown, description: string): string {
  if (typeof value !== "string" || !ARTIFACT_ID.test(value)) {
    throw new Error(
      `${description} must be a lowercase kebab-case name without wildcards`,
    );
  }
  return value;
}

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function requireArtifactType(value: unknown, description: string): ArtifactType {
  if (typeof value !== "string" || !ARTIFACT_TYPES.includes(value as ArtifactType)) {
    throw new Error(`${description} type must be one of: ${ARTIFACT_TYPES.join(", ")}`);
  }
  return value as ArtifactType;
}

export function artifactReferenceKey(reference: ArtifactReference): string {
  return `${reference.type}:${reference.id}`;
}

export function parseArtifactDependencies(
  value: unknown,
  description: string,
): readonly ArtifactReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${description} must be an array of typed Artifact references`);
  }
  const dependencies = value.map((entry, index) => {
    const reference = requireMapping(entry, `${description}[${index}]`);
    const unknown = Object.keys(reference).filter((field) => field !== "type" && field !== "id");
    if (unknown.length > 0 || !("type" in reference) || !("id" in reference)) {
      throw new Error(`${description}[${index}] must contain only type and id`);
    }
    return {
      id: requireArtifactId(reference.id, `${description}[${index}] id`),
      type: requireArtifactType(reference.type, `${description}[${index}]`),
    };
  });
  if (new Set(dependencies.map(artifactReferenceKey)).size !== dependencies.length) {
    throw new Error(`${description} must not contain an Artifact reference more than once`);
  }
  return dependencies;
}
