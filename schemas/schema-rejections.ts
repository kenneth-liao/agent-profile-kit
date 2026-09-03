/**
 * Typed rejection facts for every portable schema the Installer ingests:
 * Local Configuration, the Workspace Manifest, and portable artifact sources
 * (Context Modules, Profiles, Skills, and their typed Artifact references).
 *
 * Every case is a typed fact — path, index, field, Host, supported-Host list —
 * and the schema parsers author no user-facing sentence; presentation owns
 * every sentence keyed by the typed case (DEC-020).
 */

export type WorkspaceArtifactKind = "Context Module" | "Profile" | "Skill";

export type LocalConfigurationRejectionReason =
  | { readonly case: "invalid-yaml"; readonly path: string }
  | { readonly case: "not-a-mapping"; readonly path: string }
  | { readonly case: "unknown-field"; readonly path: string; readonly fields: readonly string[] }
  | { readonly case: "unsupported-schema-version"; readonly path: string }
  | { readonly case: "missing-workspace"; readonly path: string }
  | {
      readonly case: "legacy-schema-version";
      readonly path: string;
      readonly schemaVersion: 1;
      readonly migrationCommand: string;
    }
  | { readonly case: "bindings-not-array"; readonly path: string }
  | { readonly case: "binding-not-mapping"; readonly path: string; readonly index: number }
  | {
      readonly case: "unknown-binding-field";
      readonly path: string;
      readonly index: number;
      readonly fields: readonly string[];
    }
  | { readonly case: "invalid-field"; readonly path: string; readonly field: string }
  | { readonly case: "invalid-binding-field"; readonly path: string; readonly index: number; readonly field: string }
  | { readonly case: "invalid-binding-profile"; readonly path: string; readonly index: number }
  | { readonly case: "hosts-not-array"; readonly path: string; readonly index: number }
  | {
      readonly case: "unsupported-host";
      readonly path: string;
      readonly index: number;
      readonly hostIndex: number;
      readonly host: string;
      readonly supportedHosts: readonly string[];
    };

export type WorkspaceManifestRejectionReason =
  | { readonly case: "invalid-yaml" }
  | { readonly case: "schema-version-missing"; readonly schemaVersion: number }
  | { readonly case: "schema-version-not-positive" }
  | { readonly case: "unsupported-schema-version"; readonly found: string; readonly supported: number }
  | { readonly case: "unknown-fields"; readonly schemaVersion: number; readonly fields: readonly string[] };

export type WorkspaceArtifactRejectionReason =
  | {
      readonly case: "invalid-yaml";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section?: string;
    }
  | {
      readonly case: "not-a-mapping";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section?: string;
    }
  | {
      readonly case: "unknown-fields";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section?: string;
      readonly fields: readonly string[];
    }
  | { readonly case: "obsolete-fields"; readonly path: string; readonly fields: readonly string[] }
  | { readonly case: "missing-field"; readonly path: string; readonly field: string }
  | { readonly case: "not-array-of-names"; readonly path: string; readonly field: string }
  | { readonly case: "duplicate-name"; readonly path: string; readonly field: string }
  | { readonly case: "frontmatter-not-open"; readonly artifact: "Context Module" | "Skill"; readonly path: string }
  | { readonly case: "frontmatter-unclosed"; readonly artifact: WorkspaceArtifactKind; readonly path: string }
  | { readonly case: "empty-content"; readonly path: string }
  | {
      readonly case: "invalid-field";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section: string;
      readonly maximum?: number;
    }
  | {
      readonly case: "invalid-artifact-id";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section: string;
    }
  | { readonly case: "invalid-model-invocation"; readonly path: string; readonly key: string }
  | {
      readonly case: "dependencies-not-array";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section: string;
    }
  | {
      readonly case: "reference-not-mapping";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section: string;
      readonly index: number;
    }
  | {
      readonly case: "reference-extra-fields";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section: string;
      readonly index: number;
    }
  | {
      readonly case: "reference-invalid-id";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section: string;
      readonly index: number;
    }
  | {
      readonly case: "reference-invalid-type";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section: string;
      readonly index: number;
    }
  | {
      readonly case: "duplicate-reference";
      readonly artifact: WorkspaceArtifactKind;
      readonly path: string;
      readonly section: string;
    };

/** Artifact ID validation outside portable-artifact parsing carries its caller label. */
export type ArtifactIdRejectionReason = { readonly case: "invalid-artifact-id"; readonly label: string };

export type SchemaRejectionReason =
  | { readonly schema: "local-configuration"; readonly detail: LocalConfigurationRejectionReason }
  | { readonly schema: "workspace-manifest"; readonly detail: WorkspaceManifestRejectionReason }
  | { readonly schema: "workspace-artifact"; readonly detail: WorkspaceArtifactRejectionReason }
  | { readonly schema: "artifact-id"; readonly detail: ArtifactIdRejectionReason };

/** Focused portable-schema rejection carrying one typed fact. */
export class SchemaRejectionError extends Error {
  readonly reason: SchemaRejectionReason;

  constructor(reason: SchemaRejectionReason) {
    super(`schema rejected: ${reason.schema}/${reason.detail.case}`);
    this.name = "SchemaRejectionError";
    this.reason = reason;
  }
}

export function rejectSchema(reason: SchemaRejectionReason): SchemaRejectionError {
  return new SchemaRejectionError(reason);
}