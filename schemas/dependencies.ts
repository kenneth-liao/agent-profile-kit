import { rejectSchema, type WorkspaceArtifactKind } from "./schema-rejections.js";

export const ARTIFACT_TYPES = ["context", "skill"] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ArtifactReference {
  readonly id: string;
  readonly type: ArtifactType;
}

const ARTIFACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export { ARTIFACT_ID };

export function requireArtifactId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ARTIFACT_ID.test(value)) {
    throw rejectSchema({
      schema: "artifact-id",
      detail: { case: "invalid-artifact-id", label },
    });
  }
  return value;
}

export interface ArtifactParseOrigin {
  readonly artifact: WorkspaceArtifactKind;
  readonly path: string;
  readonly section: string;
}

export function parseArtifactDependencies(
  value: unknown,
  origin: ArtifactParseOrigin,
): readonly ArtifactReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: {
        case: "dependencies-not-array",
        artifact: origin.artifact,
        path: origin.path,
        section: origin.section,
      },
    });
  }
  const dependencies = value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw rejectSchema({
        schema: "workspace-artifact",
        detail: {
          case: "reference-not-mapping",
          artifact: origin.artifact,
          path: origin.path,
          section: origin.section,
          index,
        },
      });
    }
    const reference = entry as Record<string, unknown>;
    const unknown = Object.keys(reference).filter((field) => field !== "type" && field !== "id");
    if (unknown.length > 0 || !("type" in reference) || !("id" in reference)) {
      throw rejectSchema({
        schema: "workspace-artifact",
        detail: {
          case: "reference-extra-fields",
          artifact: origin.artifact,
          path: origin.path,
          section: origin.section,
          index,
        },
      });
    }
    if (typeof reference.id !== "string" || !ARTIFACT_ID.test(reference.id)) {
      throw rejectSchema({
        schema: "workspace-artifact",
        detail: {
          case: "reference-invalid-id",
          artifact: origin.artifact,
          path: origin.path,
          section: origin.section,
          index,
        },
      });
    }
    if (
      typeof reference.type !== "string" ||
      !ARTIFACT_TYPES.includes(reference.type as ArtifactType)
    ) {
      throw rejectSchema({
        schema: "workspace-artifact",
        detail: {
          case: "reference-invalid-type",
          artifact: origin.artifact,
          path: origin.path,
          section: origin.section,
          index,
        },
      });
    }
    return {
      id: reference.id,
      type: reference.type as ArtifactType,
    };
  });
  if (new Set(dependencies.map(artifactReferenceKey)).size !== dependencies.length) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: {
        case: "duplicate-reference",
        artifact: origin.artifact,
        path: origin.path,
        section: origin.section,
      },
    });
  }
  return dependencies;
}

export function artifactReferenceKey(reference: ArtifactReference): string {
  return `${reference.type}:${reference.id}`;
}