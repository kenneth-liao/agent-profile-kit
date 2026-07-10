import { parse } from "yaml";

export const WORKSPACE_SCHEMA_VERSION = 1;

export const WORKSPACE_MANIFEST = `schema_version: ${WORKSPACE_SCHEMA_VERSION}\n`;

export interface WorkspaceManifest {
  readonly schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
}

export function parseWorkspaceManifest(source: string): WorkspaceManifest {
  const value: unknown = parse(source);

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("schema_version" in value) ||
    value.schema_version !== WORKSPACE_SCHEMA_VERSION
  ) {
    throw new Error(
      `Workspace Manifest must contain only schema_version: ${WORKSPACE_SCHEMA_VERSION}`,
    );
  }

  return { schemaVersion: WORKSPACE_SCHEMA_VERSION };
}
