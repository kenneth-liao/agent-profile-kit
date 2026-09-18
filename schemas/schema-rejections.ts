/**
 * Typed rejection facts for every portable schema the Installer ingests:
 * Local Configuration, the Workspace Manifest, and portable artifact sources
 * (Context Modules, Profiles, and Skills).
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
  | { readonly case: "frontmatter-not-open"; readonly artifact: "Skill"; readonly path: string }
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
  | { readonly case: "leftover-model-invocation-metadata"; readonly path: string }
  | {
      /**
       * A Profile carrying an authored `id` field (spec #593 DEC-014, #598):
       * a Profile's ID is its file name; the field is never read. The
       * authored value is carried when it parsed as a string, so the fix can
       * tell the user how to keep an ID that bindings and receipts reference.
       */
      readonly case: "profile-id-field";
      readonly path: string;
      readonly id?: string;
    }
  | {
      /** A Profile file name (without `.yaml`) that is not a valid Artifact ID (spec #593 DEC-014, #598). */
      readonly case: "profile-file-name";
      readonly path: string;
      readonly name: string;
    }
  | {
      /**
       * A Context Module path whose segments cannot form a valid Context ID
       * (spec #593 DEC-004, #600): every folder and the file name (without
       * `.md`) must be a valid Artifact ID. The derived name is carried so the
       * fix can suggest the rename.
       */
      readonly case: "context-module-file-name";
      readonly path: string;
      readonly name: string;
    };

/** Artifact ID validation outside portable-artifact parsing carries its caller label. */
export type ArtifactIdRejectionReason = {
  readonly case: "invalid-artifact-id";
  readonly label: string;
  /** Set when the label names a Context Module ID, whose grammar is `/`-separated segments (spec #593 DEC-004, #600). */
  readonly grammar?: "context";
};

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