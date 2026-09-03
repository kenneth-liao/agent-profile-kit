import { parse } from "yaml";

import { rejectSchema } from "./schema-rejections.js";

export const WORKSPACE_SCHEMA_VERSION = 1;
export const WORKSPACE_MANIFEST_FILE = "workspace.yaml";

export const WORKSPACE_MANIFEST = `schema_version: ${WORKSPACE_SCHEMA_VERSION}\n`;

/**
 * Typed reasons a Workspace Manifest document was rejected. Every case is a
 * typed fact and the parser authors no user-facing sentence; presentation
 * owns every sentence keyed by the typed case (DEC-020).
 */
export type { WorkspaceManifestRejectionReason } from "./schema-rejections.js";

export function parseWorkspaceManifest(source: string): void {
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw rejectSchema({
      schema: "workspace-manifest",
      detail: { case: "invalid-yaml" },
    });
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schema_version" in value)
  ) {
    throw rejectSchema({
      schema: "workspace-manifest",
      detail: {
        case: "schema-version-missing",
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
      },
    });
  }

  const schemaVersion = (value as { schema_version: unknown }).schema_version;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion <= 0
  ) {
    throw rejectSchema({
      schema: "workspace-manifest",
      detail: { case: "schema-version-not-positive" },
    });
  }

  if (schemaVersion !== WORKSPACE_SCHEMA_VERSION) {
    throw rejectSchema({
      schema: "workspace-manifest",
      detail: {
        case: "unsupported-schema-version",
        found: String(schemaVersion),
        supported: WORKSPACE_SCHEMA_VERSION,
      },
    });
  }

  const unknownFields = Object.keys(value).filter(
    (field) => field !== "schema_version",
  );
  if (unknownFields.length > 0) {
    throw rejectSchema({
      schema: "workspace-manifest",
      detail: {
        case: "unknown-fields",
        schemaVersion: WORKSPACE_SCHEMA_VERSION,
        fields: unknownFields,
      },
    });
  }
}