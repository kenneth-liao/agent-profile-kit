import { rejectSchema } from "./schema-rejections.js";

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

export function artifactReferenceKey(reference: ArtifactReference): string {
  return `${reference.type}:${reference.id}`;
}