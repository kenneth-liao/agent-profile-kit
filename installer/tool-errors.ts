import { MissingProfileError } from "./profile-selection.js";
import {
  SchemaRejectionError,
  type SchemaRejectionReason,
  type WorkspaceManifestRejectionReason,
} from "../schemas/schema-rejections.js";

/**
 * Where a configured path was being resolved when it was rejected. The
 * carried sentences embed this identity as a composed description prefix, so
 * presentation rebuilds the prefix from these typed fields instead of the
 * Installer composing it as prose (DEC-022).
 */
export type ConfiguredPathOrigin =
  | {
      readonly source: "local-configuration";
      readonly configurationPath: string;
      readonly bindingIndex?: number;
    }
  | { readonly source: "init" }
  | { readonly source: "validate" }
  | { readonly source: "install-temp" }
  | { readonly source: "project-target"; readonly command: "update" | "status" | "install" | "uninstall" }
  | { readonly source: "project-binding" };

/**
 * One typed path-shape failure for a configured path (Project root, authored
 * Workspace path, or reserved-path conflict). Identity is carried as typed
 * fields; presentation owns every sentence.
 */
export type ConfiguredPathErrorFact =
  | { readonly kind: "wildcard-path"; readonly origin: ConfiguredPathOrigin; readonly field: string }
  | { readonly kind: "relative-path"; readonly origin: ConfiguredPathOrigin; readonly field: string }
  | {
      readonly kind: "missing-directory";
      readonly origin: ConfiguredPathOrigin;
      readonly field: string;
      readonly authored: string;
    }
  | {
      readonly kind: "dangling-symlink";
      readonly origin: ConfiguredPathOrigin;
      readonly field: string;
      readonly authored: string;
    }
  | {
      readonly kind: "reserved-workspace";
      readonly origin: ConfiguredPathOrigin;
      readonly authored: string;
      readonly label: string;
      readonly path: string;
    }
  | {
      readonly kind: "invalid-workspace";
      readonly origin: ConfiguredPathOrigin;
      readonly authored: string;
      readonly cause: WorkspaceErrorFact;
    };

/** One typed Workspace structural-validation failure. */
export type WorkspaceStructureErrorFact =
  | { readonly kind: "workspace-missing-manifest"; readonly workspace: string }
  | { readonly kind: "workspace-manifest-not-file"; readonly workspace: string }
  | { readonly kind: "workspace-dangling-category"; readonly workspace: string; readonly name: string }
  | { readonly kind: "workspace-category-not-directory"; readonly workspace: string; readonly name: string };

/** One typed Workspace ingestion failure (manifest, artifacts, leftovers). */
export type WorkspaceIngestionErrorFact =
  | WorkspaceStructureErrorFact
  | {
      readonly kind: "duplicate-artifact-name";
      readonly artifactType: CreationArtifactType;
      readonly id: string;
      /** Workspace-relative path of the existing artifact holding the ID (#508). */
      readonly path: string;
      /** Set only when a creation invocation refused on this fact (#508). */
      readonly stage?: "creation";
    }
  | {
      readonly kind: "profile-without-artifacts";
      readonly profile: string;
      /** Sorted available Context Module names, as selection guidance. */
      readonly availableContexts?: readonly string[];
      /** Sorted available Skill names, as selection guidance. */
      readonly availableSkills?: readonly string[];
    }
  | {
      readonly kind: "missing-context-reference";
      readonly profile: string;
      readonly contextId: string;
      /** Workspace-relative file that authored the invalid reference. */
      readonly file: string;
      /** Sorted available Context Module names in the Workspace. */
      readonly available: readonly string[];
      /**
       * Set only when a Profile-creation invocation refused on this fact
       * (#508): the referenced `file` was never created, so human guidance
       * must not direct the user to repair it.
       */
      readonly stage?: "creation";
    }
  | {
      readonly kind: "missing-skill-reference";
      readonly profile: string;
      readonly skillId: string;
      /** Workspace-relative file that authored the invalid reference. */
      readonly file: string;
      /** Sorted available Skill names in the Workspace. */
      readonly available: readonly string[];
      /** Creation-stage marker; see missing-context-reference (#508). */
      readonly stage?: "creation";
    }
  | {
      readonly kind: "leftover-skill-sidecar";
      /** Workspace-relative path of the retired Skill sidecar file. */
      readonly file: string;
    }
  | {
      /** A `.yaml` file under a `profiles/` subdirectory (spec #593 DEC-014, #598). */
      readonly kind: "nested-profile";
      /** Workspace-relative path of the nested Profile file. */
      readonly file: string;
    };

/** Workspace ingestion plus the manifest rejections it composes. */
export type WorkspaceErrorFact = WorkspaceIngestionErrorFact | WorkspaceManifestRejectionReason;

/**
 * The artifact kinds an authoring command can create, named by their display
 * nouns. One home so the typed creation facts and their presentation wording
 * cannot disagree about which artifact a fact describes.
 */
export type CreationArtifactType = "Skill" | "Context Module" | "Profile";

/**
 * Every Installer-authored tool error, as a typed fact: a kind plus the
 * non-prose evidence the error needs — path, Project, Host, Host list, or a
 * nested typed fact. No user-facing sentence is authored here; presentation
 * owns every sentence, keyed by kind.
 */
export type InstallerToolErrorFact =
  | { readonly kind: "missing-local-configuration"; readonly path: string }
  | {
      readonly kind: "bind-conflict";
      readonly configurationPath: string;
      readonly canonicalProject: string;
      readonly profile: string;
      readonly hosts: readonly string[];
    }
  | {
      readonly kind: "duplicate-canonical-root";
      readonly configurationPath: string;
      readonly bindingIndex: number;
      readonly canonicalProject: string;
    }
  | {
      readonly kind: "duplicate-missing-project";
      readonly configurationPath: string;
      readonly bindingIndex: number;
      readonly project: string;
    }
  | { readonly kind: "bind-host-required"; readonly supportedHosts: readonly string[] }
  | { readonly kind: "install-host-required"; readonly supportedHosts: readonly string[] }
  | { readonly kind: "unsupported-host"; readonly host: string; readonly supportedHosts: readonly string[] }
  | {
      readonly kind: "unsupported-temporary-host";
      readonly host: string;
      readonly supportedHosts: readonly string[];
    }
  | {
      readonly kind: "temporary-host-unsupported";
      readonly host: string;
      readonly supportedHosts: readonly string[];
    }
  | {
      readonly kind: "configuration-lock-busy";
      readonly configurationPath: string;
      readonly operation: string;
    }
  | {
      readonly kind: "lifecycle-lock-busy";
      readonly operation: string;
    }
  | { readonly kind: "configuration-changed-while-planning" }
  | {
      readonly kind: "configuration-changed-before-publication";
      readonly configurationPath: string;
      readonly operation: string;
    }
  | { readonly kind: "temporary-identity-required" }
  | { readonly kind: "unknown-temporary-identity"; readonly temporaryInstallationId: string }
  | { readonly kind: "init-symlink-target-missing"; readonly path: string }
  | { readonly kind: "init-path-not-directory"; readonly path: string }
  | { readonly kind: "init-empty-symlink-target"; readonly path: string }
  | {
      /**
       * `init` was invoked without a Workspace path on a machine that has no
       * selected Workspace (spec #593 #601, DEC-001, ISC-23): a fresh home,
       * or a legacy version-1 Local Configuration without a `workspace`
       * value. There is no default location, so setup refuses before any
       * write instead of selecting a location the user did not give.
       */
      readonly kind: "init-workspace-path-required";
    }
  | {
      /**
       * The named Workspace folder does not exist and its parent directory is
       * missing too (spec #593 #599): nothing is ever written outside the
       * named path, so creating missing parent directories is refused.
       */
      readonly kind: "init-missing-parent-directory";
      readonly path: string;
      readonly parent: string;
    }
  | {
      /**
       * A setup I/O failure after some required parts were already added in
       * place (spec #593 DEC-003, #599). `added` is the exact list of entries
       * the transaction wrote before the failure — the named folder itself
       * when setup provisioned it, then each added part — in write order;
       * existing entries are never touched and Local Configuration was not
       * written. A re-run adds only the still-missing parts.
       */
      readonly kind: "init-partial-setup";
      readonly path: string;
      readonly added: readonly string[];
      readonly cause: string;
    }
  | {
      readonly kind: "init-workspace-selection-conflict";
      readonly requested: string;
      readonly configurationPath: string;
      readonly configuredPath: string;
    }
  | { readonly kind: "foreign-diagnostic"; readonly detail: string }
  | {
      readonly kind: "artifact-path-occupied";
      /** The display noun of the artifact kind being created. */
      readonly artifactType: CreationArtifactType;
      readonly id: string;
      readonly path: string;
    }
  | {
      /**
       * A nested Context Module's intermediate folder exists but is not a
       * real directory (spec #593 DEC-004, #600): never written through.
       * The path is the intermediate folder's absolute location.
       */
      readonly kind: "context-module-parent-not-directory";
      readonly path: string;
    }
  | {
      readonly kind: "artifact-creation-residue";
      /** The display noun of the artifact kind being created. */
      readonly artifactType: CreationArtifactType;
      readonly id: string;
      readonly path: string;
      /**
       * What survives at `path`: material entirely created by the failed
       * creation invocation ("own"), a destination containing entries Agent
       * Profile Kit did not create ("foreign"), or a destination whose
       * contents could not be inspected ("uninspectable").
       */
      readonly contents: "own" | "foreign" | "uninspectable";
    }
  | {
      readonly kind: "workspace-open-failed";
      readonly path: string;
      readonly detail: string;
      readonly cleanupFailed?: boolean;
    }
  | {
      readonly kind: "profile-file-symlink";
      readonly profile: string;
      readonly path: string;
    }
  | ConfiguredPathErrorFact
  | WorkspaceIngestionErrorFact;

/**
 * Typed errors the Installer authors. Presentation renders each through its
 * owned sentence home; unrecognized (non-Installer) errors may still project
 * `error.message`.
 */
export type InstallerAuthoredError =
  | InstallerToolError
  | SchemaRejectionError
  | MissingProfileError;

/** Focused Installer-authored tool failure carrying one typed fact. */
export class InstallerToolError extends Error {
  readonly fact: InstallerToolErrorFact;

  constructor(fact: InstallerToolErrorFact) {
    super(`installer tool error: ${fact.kind}`);
    this.name = "InstallerToolError";
    this.fact = fact;
  }
}
/** Narrow an unknown thrown value to a typed Installer-authored error. */
export function asInstallerAuthoredError(error: unknown): InstallerAuthoredError | undefined {
  if (
    error instanceof InstallerToolError ||
    error instanceof SchemaRejectionError ||
    error instanceof MissingProfileError
  ) {
    return error;
  }
  return undefined;
}

export { SchemaRejectionError };
export type { SchemaRejectionReason };