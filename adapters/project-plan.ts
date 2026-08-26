import type { ArtifactReference } from "../schemas/dependencies.js";
import type { SupportedHost } from "../schemas/local-configuration.js";

export type ProjectOutputEntryType = "directory" | "file";

/** A regular file inside an owned artifact directory. Paths are relative to the directory root. */
export interface ProposedDirectoryFileMember {
  /** Exact file contents. Prefer Uint8Array for non-UTF-8 package members. */
  readonly bytes: string | Uint8Array;
  readonly mode: number;
  readonly path: string;
  readonly type: "file";
}

/** A subdirectory inside an owned artifact directory. Paths are relative to the directory root. */
export interface ProposedDirectoryDirectoryMember {
  readonly mode: number;
  readonly path: string;
  readonly type: "directory";
}

export type ProposedDirectoryMember =
  | ProposedDirectoryDirectoryMember
  | ProposedDirectoryFileMember;

/** A single owned regular file at a project-relative path. */
export interface ProposedProjectFileOutput {
  /** Exact file contents. Prefer Uint8Array for non-UTF-8 package members. */
  readonly bytes: string | Uint8Array;
  readonly mode: number;
  /**
   * Canonical Artifact references that generated this output. Zero, one, or
   * multiple references are allowed; identity is never derived from paths.
   */
  readonly origins: readonly ArtifactReference[];
  readonly path: string;
  readonly remedy?: string;
  readonly requirements: readonly string[];
  readonly type: "file";
}

/**
 * One complete owned artifact directory. The Installer treats the directory as
 * a single ownership boundary whose regular-file members carry exact bytes and modes.
 */
export interface ProposedProjectDirectoryOutput {
  readonly members: readonly ProposedDirectoryMember[];
  readonly mode: number;
  /** Canonical Artifact references that generated this output. */
  readonly origins: readonly ArtifactReference[];
  readonly path: string;
  readonly remedy?: string;
  readonly requirements: readonly string[];
  readonly type: "directory";
}

export type ProposedProjectOutput =
  | ProposedProjectDirectoryOutput
  | ProposedProjectFileOutput;

export type HostSetupStepKind =
  | "approval-required"
  | "launch-constraint"
  | "shared-path"
  | "trust-required";

/**
 * Whether a Host Setup Step is caused by the current lifecycle transition or
 * is a standing constraint. Adapters classify every step at this boundary so
 * every presenter consumes one trusted provenance (DEC-036).
 */
export type HostSetupProvenance = "transition" | "standing";

/**
 * A Host Setup Step that becomes relevant only when its associated generated
 * output is added, updated, or repaired by the current change.
 */
export interface AdapterTransitionSetupStep {
  readonly consequence?: string;
  readonly kind: HostSetupStepKind;
  readonly message: string;
  readonly path?: "bound-project";
  /**
   * The exact generated output path whose addition, update, or repair makes
   * this step newly relevant. One canonical Adapter-owned reference, never
   * inferred from generated path naming.
   */
  readonly output: string;
  readonly provenance: "transition";
}

/** A persistent Host constraint presented as a compact standing reminder. */
export interface AdapterStandingSetupStep {
  readonly consequence?: string;
  readonly kind: HostSetupStepKind;
  readonly message: string;
  readonly path?: "bound-project";
  readonly provenance: "standing";
}

export type AdapterHostSetupStep = AdapterTransitionSetupStep | AdapterStandingSetupStep;

export type HostSetupStep = AdapterHostSetupStep & { readonly host: SupportedHost };

/** Adapter-authored warning plus the values its human presentation must keep intact. */
export interface AdapterDiagnosticWarning {
  readonly copyableValues: readonly string[];
  readonly message: string;
}

export interface AdapterProjectPlan {
  readonly host: SupportedHost;
  readonly hostVersion: string;
  readonly outputs: readonly ProposedProjectOutput[];
  readonly setupSteps: readonly AdapterHostSetupStep[];
}
