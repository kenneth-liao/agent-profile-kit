import { parse } from "yaml";

export const WORKSPACE_SCHEMA_VERSION = 1;

export const WORKSPACE_MANIFEST = `schema_version: ${WORKSPACE_SCHEMA_VERSION}\n`;

export interface WorkspaceManifest {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
}

export function parseWorkspaceManifest(source: string): WorkspaceManifest {
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw new Error(
      "Workspace Manifest is invalid YAML; correct workspace.yaml before retrying",
    );
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schema_version" in value)
  ) {
    throw new Error(
      `Workspace Manifest must contain schema_version: ${WORKSPACE_SCHEMA_VERSION}`,
    );
  }

  if (
    typeof value.schema_version !== "number" ||
    !Number.isInteger(value.schema_version) ||
    value.schema_version <= 0
  ) {
    throw new Error(
      "Workspace Manifest schema_version must be a positive integer",
    );
  }

  if (value.schema_version !== WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Workspace schema version ${String(value.schema_version)}; this Agent Profile Kit version supports version ${WORKSPACE_SCHEMA_VERSION}. Use an explicit Workspace migration before retrying.`,
    );
  }

  const unknownFields = Object.keys(value).filter(
    (field) => field !== "schema_version",
  );
  if (unknownFields.length > 0) {
    throw new Error(
      `Workspace Manifest schema version ${WORKSPACE_SCHEMA_VERSION} does not allow fields: ${unknownFields.join(", ")}`,
    );
  }

  return { schemaVersion: WORKSPACE_SCHEMA_VERSION };
}
