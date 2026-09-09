import { COMMAND_NAME } from "../installer/version.js";
import { WORKSPACE_MANIFEST_FILE } from "../schemas/workspace-manifest.js";
import { LOCAL_CONFIGURATION_SCHEMA_VERSION } from "../schemas/local-configuration.js";
import type {
  ConfiguredPathErrorFact,
  ConfiguredPathOrigin,
  CreationArtifactType,
  InstallerToolErrorFact,
  InstallerAuthoredError,
  WorkspaceErrorFact,
} from "../installer/tool-errors.js";
import type { LocalConfigurationRejectionReason } from "../schemas/local-configuration.js";
import type {
  SchemaRejectionReason,
  WorkspaceArtifactRejectionReason,
  WorkspaceManifestRejectionReason,
} from "../schemas/schema-rejections.js";
import { MissingProfileError } from "../installer/profile-selection.js";
import {
  ProjectTargetError,
  type ProjectTargetErrorReason,
} from "../installer/local-configuration.js";
import { StateReadFailureError } from "../installer/installation-state.js";
import {
  applyNewcomerSubstitutions,
  describeStateReadFailure,
  substituteInline,
} from "./blocker-wording.js";
import { InstallerToolError, SchemaRejectionError } from "../installer/tool-errors.js";
import { commandPart, flatInlineText, identifierPart, safeShellQuoted, shellSingleQuoted, type CommandArg, type InlineContent } from "./inline-content.js";

/**
 * The `apkit new` kind token for each creatable artifact type, with the noun
 * a residue fact's destination is referred to by. One home so every recovery
 * command names the kind that can actually retry the failed creation.
 */
const CREATION_ARTIFACT_PRESENTATION = {
  "Skill": { kindToken: "skill", residueNoun: "directory" },
  "Context Module": { kindToken: "context", residueNoun: "file" },
} as const satisfies Record<CreationArtifactType, { kindToken: string; residueNoun: string }>;
import { nearestName } from "./nearest-match.js";
import { diagnosticDocument, type DiagnosticDocumentParts } from "./diagnostics.js";
import type { PresentationDocument } from "./presentation-document.js";

/** One carried command argument. */
const arg = (value: string): CommandArg => ({ kind: "text", value });

export class CliArgumentError extends Error {
  constructor(readonly parts: readonly InlineContent[]) {
    super(flatInlineText(parts));
    this.name = "CliArgumentError";
  }
}

function capitalize(text: string): string {
  return `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/**
 * Presentation-owned tool-error wording, keyed by the typed error facts the
 * Installer emits (DEC-020). The Installer authors no user-facing sentence.
 * Machine surfaces publish plain-text projections; human surfaces render
 * structured diagnostic documents (DEC-014).
 */

function configuredPathDescription(origin: ConfiguredPathOrigin): readonly InlineContent[] {
  switch (origin.source) {
    case "local-configuration":
      return origin.bindingIndex === undefined
        ? [`Local Configuration ${origin.configurationPath}`]
        : [`Local Configuration ${origin.configurationPath} bindings[${origin.bindingIndex}]`];
    case "init":
      return [commandPart(COMMAND_NAME, [arg("init")])];
    case "install-temp":
      return ["install-temp"];
    case "project-target":
      return [commandPart(COMMAND_NAME, [arg(origin.command)]), " Project target"];
    case "project-binding":
      return ["Project Binding"];
  }
}

function danglingSymlinkRecovery(field: string): string {
  return field === "workspace"
    ? "restore its target or choose an existing Workspace directory"
    : "restore its target or choose an existing directory";
}

/** The carried sentence parts for one typed configured-path failure. */
export function formatConfiguredPathError(fact: ConfiguredPathErrorFact): readonly InlineContent[] {
  const description = configuredPathDescription(fact.origin);
  switch (fact.kind) {
    case "wildcard-path":
      return [...description, ` ${fact.field} must be an explicit directory path without wildcards`];
    case "relative-path":
      return [...description, ` ${fact.field} must be an absolute path or home-relative path beginning with ~/`];
    case "missing-directory":
      return [...description, ` ${fact.field} '${fact.authored}' must be an existing directory`];
    case "dangling-symlink":
      return [...description, ` ${fact.field} '${fact.authored}' is a dangling symlink; ${danglingSymlinkRecovery(fact.field)}`];
    case "reserved-workspace":
      return [...description, ` workspace '${fact.authored}' is reserved for ${fact.label} at ${fact.path}`];
    case "invalid-workspace":
      return [...description, ` workspace '${fact.authored}' is not a valid Agent Profile Kit Workspace: ${formatWorkspaceIngestionError(fact.cause)}`];
  }
}

/** The structured diagnostic parts for one typed configured-path failure. */
export function formatConfiguredPathErrorDiagnostic(fact: ConfiguredPathErrorFact): DiagnosticDocumentParts {
  const description = configuredPathDescription(fact.origin);
  switch (fact.kind) {
    case "wildcard-path":
      return { happened: [...description, ` ${fact.field} must be an explicit directory path without wildcards`] };
    case "relative-path":
      return { happened: [...description, ` ${fact.field} must be an absolute path or home-relative path beginning with ~/`] };
    case "missing-directory":
      return { happened: [...description, ` ${fact.field} '${fact.authored}' must be an existing directory`] };
    case "dangling-symlink":
      return {
        happened: [...description, ` ${fact.field} '${fact.authored}' is a dangling symlink`],
        whatToType: [[capitalize(danglingSymlinkRecovery(fact.field)), "."]],
      };
    case "reserved-workspace":
      return { happened: [...description, ` workspace '${fact.authored}' is reserved for ${fact.label} at ${fact.path}`] };
    case "invalid-workspace":
      return {
        happened: [...description, ` workspace '${fact.authored}' is not a valid Agent Profile Kit Workspace`],
        why: [[formatWorkspaceIngestionError(fact.cause)]],
      };
  }
}

/** The carried sentence for one typed Workspace ingestion failure. */
export function formatWorkspaceIngestionError(fact: WorkspaceErrorFact): string {
  if ("case" in fact) return formatWorkspaceManifestError(fact);
  switch (fact.kind) {
    case "workspace-missing-manifest":
      return `Workspace is incomplete at ${fact.workspace}: missing required file '${WORKSPACE_MANIFEST_FILE}'`;
    case "workspace-manifest-not-file":
      return `Workspace is invalid at ${fact.workspace}: '${WORKSPACE_MANIFEST_FILE}' must be a file`;
    case "workspace-dangling-category":
      return `Workspace is invalid at ${fact.workspace}: '${fact.name}' is a dangling symlink; remove it or restore its target directory`;
    case "workspace-category-not-directory":
      return `Workspace is invalid at ${fact.workspace}: '${fact.name}' must be a directory`;
    case "duplicate-artifact-name":
      return `${fact.artifactType} name '${fact.id}' is duplicated`;
    case "profile-without-artifacts":
      return `Profile '${fact.profile}' must select at least one supported artifact (Context Module or Skill)`;
    case "missing-context-reference":
      return `Profile '${fact.profile}' in ${fact.file} selects missing Context Module '${fact.contextId}'. ` +
        `Restore the Context Module, or remove or update Profile '${fact.profile}'. ` +
        (fact.available.length === 0
          ? "No Context Modules exist in the Workspace"
          : `Available Context Modules: ${fact.available.join(", ")}`);
    case "missing-skill-reference":
      return `Profile '${fact.profile}' in ${fact.file} selects missing Skill '${fact.skillId}'. ` +
        (fact.available.length === 0
          ? "No Skills exist in the Workspace"
          : `Available Skills: ${fact.available.join(", ")}`);
    case "missing-dependency-reference":
      return `${fact.file} references missing ${fact.label} '${fact.id}'. ` +
        (fact.available.length === 0
          ? `No ${fact.label}s exist in the Workspace`
          : `Available ${fact.label}s: ${fact.available.join(", ")}`);
    case "dependency-cycle":
      return `Dependency cycle: ${fact.cycle}`;
  }
}

/**
 * The shared invalid-reference diagnostic (US-025/026, DEC-017): what happened
 * names the offending file and invalid value, why suggests the nearest name
 * through the shared nearest-name selection and lists the available names, and
 * what to type offers the runnable recovery command.
 */
function missingReferenceDiagnostic(evidence: {
  readonly happened: readonly string[];
  readonly invalid: string;
  readonly label: string;
  readonly available: readonly string[];
  readonly file: string;
  /** Restore-or-remove remedy preserved from the predecessor wording. */
  readonly remedy: string;
}): DiagnosticDocumentParts {
  const why: (readonly InlineContent[])[] = [
    [evidence.available.length === 0
      ? `No ${evidence.label}s exist in the Workspace.`
      : `Available ${evidence.label}s: ${evidence.available.join(", ")}.`],
  ];
  const suggestion = nearestName(evidence.invalid, evidence.available);
  if (suggestion !== undefined) {
    why.push([`Did you mean '${suggestion}'?`]);
  }
  return {
    happened: [...evidence.happened],
    why,
    whatToType: [
      [evidence.remedy],
      ["Correct ", identifierPart(evidence.file), ", then run ", commandPart(COMMAND_NAME, [arg("validate")]), "."],
    ],
  };
}

/** The structured diagnostic parts for one typed Workspace ingestion failure. */
export function formatWorkspaceIngestionErrorDiagnostic(fact: WorkspaceErrorFact): DiagnosticDocumentParts {
  if ("case" in fact) {
    return { happened: [formatWorkspaceManifestError(fact)] };
  }
  switch (fact.kind) {
    case "workspace-missing-manifest":
      return { happened: [`Workspace is incomplete at ${fact.workspace}: missing required file '${WORKSPACE_MANIFEST_FILE}'`] };
    case "workspace-manifest-not-file":
      return { happened: [`Workspace is invalid at ${fact.workspace}: '${WORKSPACE_MANIFEST_FILE}' must be a file`] };
    case "workspace-dangling-category":
      return {
        happened: [`Workspace is invalid at ${fact.workspace}: '${fact.name}' is a dangling symlink`],
        whatToType: [["Remove it or restore its target directory."]],
      };
    case "workspace-category-not-directory":
      return { happened: [`Workspace is invalid at ${fact.workspace}: '${fact.name}' must be a directory`] };
    case "duplicate-artifact-name":
      return { happened: [`${fact.artifactType} name '${fact.id}' is duplicated`] };
    case "profile-without-artifacts":
      return { happened: [`Profile '${fact.profile}' must select at least one supported artifact (Context Module or Skill)`] };
    case "missing-context-reference":
      return missingReferenceDiagnostic({
        happened: [
          `Profile '${fact.profile}' in ${fact.file} selects missing Context Module '${fact.contextId}'.`,
        ],
        invalid: fact.contextId,
        label: "Context Module",
        available: fact.available,
        file: fact.file,
        remedy: `Restore the Context Module, or remove or update Profile '${fact.profile}'.`,
      });
    case "missing-skill-reference":
      return missingReferenceDiagnostic({
        happened: [
          `Profile '${fact.profile}' in ${fact.file} selects missing Skill '${fact.skillId}'.`,
        ],
        invalid: fact.skillId,
        label: "Skill",
        available: fact.available,
        file: fact.file,
        remedy: `Restore the Skill, or remove or update Profile '${fact.profile}'.`,
      });
    case "missing-dependency-reference":
      return missingReferenceDiagnostic({
        happened: [`${fact.file} references missing ${fact.label} '${fact.id}'.`],
        invalid: fact.id,
        label: fact.label,
        available: fact.available,
        file: fact.file,
        remedy: `Restore the missing ${fact.label}, or remove the dependency reference.`,
      });
    case "dependency-cycle":
      return { happened: [`Dependency cycle: ${fact.cycle}`] };
  }
}

/** The carried sentence parts for one typed Local Configuration rejection. */
export function formatLocalConfigurationError(
  reason: LocalConfigurationRejectionReason,
): readonly InlineContent[] {
  switch (reason.case) {
    case "invalid-yaml":
      return [`Local Configuration ${reason.path} is invalid YAML`];
    case "not-a-mapping":
      return [`Local Configuration ${reason.path} must be a YAML mapping`];
    case "unknown-field":
      return [`Local Configuration ${reason.path} does not allow fields: ${reason.fields.join(", ")}`];
    case "unsupported-schema-version":
      return [`Local Configuration ${reason.path} schema_version must be ${LOCAL_CONFIGURATION_SCHEMA_VERSION}`];
    case "missing-workspace":
      return [`Local Configuration ${reason.path} workspace is required for schema_version ${LOCAL_CONFIGURATION_SCHEMA_VERSION}; add an explicit Workspace path and retry`];
    case "legacy-schema-version":
      return [
        `Local Configuration ${reason.path} uses legacy schema_version ${reason.schemaVersion}; run `,
        identifierPart(reason.migrationCommand),
        " to migrate it",
      ];
    case "bindings-not-array":
      return [`Local Configuration ${reason.path} bindings must be an array`];
    case "binding-not-mapping":
      return [`Local Configuration ${reason.path} bindings[${reason.index}] must be a YAML mapping`];
    case "unknown-binding-field":
      return [`Local Configuration ${reason.path} bindings[${reason.index}] does not allow fields: ${reason.fields.join(", ")}`];
    case "invalid-field":
      return [`Local Configuration ${reason.path} ${reason.field} must be a non-empty string`];
    case "invalid-binding-field":
      return [`Local Configuration ${reason.path} bindings[${reason.index}] ${reason.field} must be a non-empty string`];
    case "invalid-binding-profile":
      return [`Local Configuration ${reason.path} bindings[${reason.index}] profile must be a lowercase kebab-case name without wildcards`];
    case "hosts-not-array":
      return [`Local Configuration ${reason.path} bindings[${reason.index}] hosts must be a non-empty array`];
    case "unsupported-host":
      return [`Local Configuration ${reason.path} bindings[${reason.index}] hosts[${reason.hostIndex}] unsupported Agent Host '${reason.host}'; supported Hosts: ${reason.supportedHosts.join(", ")}`];
  }
}

/** The carried sentence for one typed Workspace Manifest rejection. */
export function formatWorkspaceManifestError(reason: WorkspaceManifestRejectionReason): string {
  switch (reason.case) {
    case "invalid-yaml":
      return "Workspace Manifest is invalid YAML; correct workspace.yaml before retrying";
    case "schema-version-missing":
      return `Workspace Manifest must contain schema_version: ${reason.schemaVersion}`;
    case "schema-version-not-positive":
      return "Workspace Manifest schema_version must be a positive integer";
    case "unsupported-schema-version":
      return `Unsupported Workspace schema version ${reason.found}; this Agent Profile Kit version supports version ${reason.supported}. Use an explicit Workspace migration before retrying.`;
    case "unknown-fields":
      return `Workspace Manifest schema version ${reason.schemaVersion} does not allow fields: ${reason.fields.join(", ")}`;
  }
}

/** The carried sentence parts for one typed portable-schema rejection. */
export function formatSchemaRejection(reason: SchemaRejectionReason): readonly InlineContent[] {
  switch (reason.schema) {
    case "local-configuration":
      return formatLocalConfigurationError(reason.detail);
    case "workspace-manifest":
      return [formatWorkspaceManifestError(reason.detail)];
    case "workspace-artifact":
      return [formatWorkspaceArtifactError(reason.detail)];
    case "artifact-id":
      return [`${reason.detail.label} must be a lowercase kebab-case name without wildcards`];
  }
}

/**
 * The carried sentence for one typed portable-artifact parse rejection.
 * The composed description prefix rebuilds from typed artifact identity:
 * `<kind> <path>[ <section>][<index>]`.
 */
export function formatWorkspaceArtifactError(reason: WorkspaceArtifactRejectionReason): string {
  const artifact = "artifact" in reason ? reason.artifact : undefined;
  const path = "path" in reason ? reason.path : "";
  const section = "section" in reason ? reason.section : undefined;
  const index = "index" in reason ? reason.index : undefined;
  const description =
    artifact === undefined
      ? `Profile ${path}`
      : `${artifact} ${path}${section === undefined ? "" : ` ${section}`}${
          index === undefined ? "" : `[${index}]`
        }`;
  switch (reason.case) {
    case "invalid-yaml":
      return `${description} is invalid YAML`;
    case "not-a-mapping":
      return `${description} must be a YAML mapping`;
    case "unknown-fields":
      return `${description} does not allow fields: ${reason.fields.join(", ")}`;
    case "obsolete-fields":
      return `Profile ${reason.path} no longer supports fields: ${reason.fields.join(", ")}. ` +
        "Remove these obsolete Profile fields; earlier releases allowed them only as empty placeholders";
    case "missing-field":
      return `Profile ${reason.path} must contain ${reason.field}`;
    case "not-array-of-names":
      return `${description} must be an array of names`;
    case "duplicate-name":
      return `${description} must not select a name more than once`;
    case "frontmatter-not-open":
      return `${reason.artifact} ${reason.path} must start with YAML frontmatter`;
    case "frontmatter-unclosed":
      return `${reason.artifact} ${reason.path} must close its YAML frontmatter`;
    case "empty-content":
      return `Context Module ${reason.path} must contain Context`;
    case "invalid-field":
      return `${description} must be a non-empty string${reason.maximum === undefined ? "" : ` no longer than ${reason.maximum} characters`}`;
    case "invalid-artifact-id":
      return `${description} must be a lowercase kebab-case name without wildcards`;
    case "invalid-model-invocation":
      return `Skill ${reason.path} metadata.${reason.key} must be the string 'allowed' or 'disabled'`;
    case "dependencies-not-array":
      return `${description} must be an array of typed Artifact references`;
    case "reference-not-mapping":
      return `${description} must be a YAML mapping`;
    case "reference-extra-fields":
      return `${description} must contain only type and id`;
    case "reference-invalid-id":
      return `${description} id must be a lowercase kebab-case name without wildcards`;
    case "reference-invalid-type":
      return `${description} type must be one of: context, skill`;
    case "duplicate-reference":
      return `${description} must not contain an Artifact reference more than once`;
  }
}

/**
 * The carried detail of one typed cause inside a composed sentence: the raw
 * message for the pre-existing typed MissingProfileError (its sentence home
 * composes around it), the presentation sentence for every other typed cause.
 */
function carriedCauseDetail(cause: InstallerAuthoredError): readonly InlineContent[] {
  if (cause instanceof MissingProfileError) {
    return [missingProfileSentence(cause.profile)];
  }
  const sentence = installerErrorSentence(cause);
  return sentence ?? [cause.message];
}

/** The carried Missing Profile sentence, composed from typed fields (DEC-020). */
function missingProfileSentence(profile: string): string {
  return `Profile '${profile}' does not exist in this Workspace`;
}

/**
 * Presentation-owned Missing Profile wording, composed from the typed
 * {@link MissingProfileError} fields; the error's own message is opaque.
 */
export function formatMissingProfileError(error: MissingProfileError): readonly InlineContent[] {
  const heading = [`${missingProfileSentence(error.profile)}.`];
  const recovery: readonly InlineContent[] = error.recoverByEditingLocalConfiguration
    ? [" Edit Local Configuration directly if this stale binding must be removed."]
    : [];
  if (error.availableProfiles.length === 0) {
    const next: readonly InlineContent[] = error.recoverByEditingLocalConfiguration
      ? recovery
      : [" Run ", commandPart(COMMAND_NAME, [arg("guide"), arg("profile")]), " to learn how to add a Profile."];
    return [...heading, " No Profiles exist in the Workspace.", ...next];
  }
  return [...heading, ` Available Profiles: ${error.availableProfiles.join(", ")}.`, ...recovery];
}

/** Structured diagnostic for Missing Profile (DEC-014). */
export function formatMissingProfileErrorDiagnostic(error: MissingProfileError): DiagnosticDocumentParts {
  const heading = [`${missingProfileSentence(error.profile)}.`];
  const why: (readonly InlineContent[])[] = error.availableProfiles.length === 0
    ? [["No Profiles exist in the Workspace."]]
    : [[`Available Profiles: ${error.availableProfiles.join(", ")}.`]];
  const whatToType: (readonly InlineContent[])[] = [];
  if (error.recoverByEditingLocalConfiguration) {
    whatToType.push(["Edit Local Configuration directly if this stale binding must be removed."]);
  } else if (error.availableProfiles.length === 0) {
    whatToType.push(["Run ", commandPart(COMMAND_NAME, [arg("guide"), arg("profile")]), " to learn how to add a Profile."]);
  }
  return {
    happened: heading,
    why,
    ...(whatToType.length > 0 ? { whatToType } : {}),
  };
}

/** The carried sentence parts for one typed Installer tool-error fact. */
export function formatInstallerToolError(fact: InstallerToolErrorFact): readonly InlineContent[] {
  switch (fact.kind) {
    case "missing-local-configuration":
      return [`Local Configuration is missing at ${fact.path}; run `, commandPart(COMMAND_NAME, [arg("init")])];
    case "bind-conflict":
      return [`Local Configuration ${fact.configurationPath} already binds canonical project '${fact.canonicalProject}' to profile '${fact.profile}' hosts [${fact.hosts.join(", ")}]; pass --replace to restate its Profile and Hosts`];
    case "stale-binding-removal":
      return [...carriedCauseDetail(fact.cause), "; edit Local Configuration directly if this stale or malformed binding must be removed"];
    case "duplicate-canonical-root":
      return [`Local Configuration ${fact.configurationPath} bindings[${fact.bindingIndex}] project resolves to duplicate canonical root '${fact.canonicalProject}'`];
    case "duplicate-missing-project":
      return [`Local Configuration ${fact.configurationPath} bindings[${fact.bindingIndex}] duplicates missing project path '${fact.project}'`];
    case "bind-host-required":
      return [`bind requires at least one --host flag; supported Hosts: ${fact.supportedHosts.join(", ")}`];
    case "unsupported-host":
      return [`unsupported Agent Host '${fact.host}'; supported Hosts: ${fact.supportedHosts.join(", ")}`];
    case "unsupported-temporary-host":
      return [`unsupported Agent Host '${fact.host}'; temporary installation supports: ${fact.supportedHosts.join(", ")}`];
    case "temporary-host-unsupported":
      return [`temporary installation does not yet support Agent Host '${fact.host}'; supported Hosts: ${fact.supportedHosts.join(", ")}`];
    case "lifecycle-lock-busy":
      return [`Installation lifecycle is busy; another ${fact.operation} holds the lock — retry`];
    case "configuration-lock-busy":
      return [`Local Configuration ${fact.configurationPath} is busy; another ${fact.operation} holds the lock — retry`];
    case "configuration-changed-while-planning":
      return ["Local Configuration changed while apply was planning; retry apply"];
    case "configuration-changed-before-publication":
      return [`Local Configuration ${fact.configurationPath} changed before ${fact.operation} publication; retry after the other edit completes`];
    case "temporary-identity-required":
      return ["remove-temp requires a temporary installation identity"];
    case "unknown-temporary-identity":
      return [`unknown temporary installation identity '${fact.temporaryInstallationId}'`];
    case "init-symlink-target-missing":
      return [`Cannot initialize ${fact.path}: the Workspace symlink target does not exist; remove the symlink or restore its target before retrying`];
    case "init-path-not-directory":
      return [`Cannot initialize ${fact.path}: the Workspace path exists and is not a directory`];
    case "init-empty-symlink-target":
      return [`Cannot initialize ${fact.path}: the Workspace symlink target is empty; remove the symlink and run init, or populate its target with a valid Workspace before retrying`];
    case "init-not-workspace-directory":
      return [`Cannot initialize ${fact.path}: directory is non-empty and is not an Agent Profile Kit Workspace`];
    case "init-workspace-selection-conflict":
      return [`Cannot initialize Workspace '${fact.requested}': Local Configuration ${fact.configurationPath} already selects a different Workspace at ${fact.configuredPath}; refusing to change the canonical selection`];
    case "foreign-diagnostic":
      return [fact.detail];
    case "artifact-path-occupied":
      return [`${fact.artifactType} '${fact.id}' already has material at ${fact.path}; choose a different name or remove the existing material first`];
    case "artifact-creation-residue": {
      const retry = commandPart(COMMAND_NAME, [
        arg("new"),
        arg(CREATION_ARTIFACT_PRESENTATION[fact.artifactType].kindToken),
        arg(fact.id),
      ]);
      if (fact.contents === "own") {
        return [
          `${fact.artifactType} creation left incomplete Agent Profile Kit material at ${fact.path}; remove it and run `,
          retry,
        ];
      }
      if (fact.contents === "foreign") {
        return [
          `${fact.artifactType} creation left ${fact.path} containing material Agent Profile Kit did not create; review it before removing anything, then run `,
          retry,
        ];
      }
      return [
        `${fact.artifactType} creation left ${fact.path} and its contents could not be inspected; restore access or review it before removing anything, then run `,
        retry,
      ];
    }
    case "workspace-open-failed": {
      const extra = fact.cleanupFailed ? "; opener cleanup failed" : "";
      return [`Could not open Workspace at ${fact.path}: ${fact.detail}${extra}`];
    }
    case "workspace-missing-manifest":
    case "workspace-manifest-not-file":
    case "workspace-dangling-category":
    case "workspace-category-not-directory":
    case "duplicate-artifact-name":
    case "profile-without-artifacts":
    case "missing-context-reference":
    case "missing-skill-reference":
    case "missing-dependency-reference":
    case "dependency-cycle":
      return [formatWorkspaceIngestionError(fact)];
    default:
      return formatConfiguredPathError(fact);
  }
}

/** The structured diagnostic parts for one typed Installer tool-error fact (DEC-014, DEC-015). */
export function formatInstallerToolErrorDiagnostic(fact: InstallerToolErrorFact): DiagnosticDocumentParts {
  switch (fact.kind) {
    case "missing-local-configuration":
      return {
        happened: ["Agent Profile Kit is not set up on this machine"],
        whatToType: [["Run ", commandPart(COMMAND_NAME, [arg("init")]), " to set it up."]],
      };
    case "bind-conflict":
      return {
        happened: [`Local Configuration ${fact.configurationPath} already binds canonical project '${fact.canonicalProject}' to profile '${fact.profile}' hosts [${fact.hosts.join(", ")}]`],
        whatToType: [["Pass --replace to restate its Profile and Hosts."]],
      };
    case "stale-binding-removal":
      return {
        happened: carriedCauseDetail(fact.cause),
        whatToType: [["Edit Local Configuration directly if this stale or malformed binding must be removed."]],
      };
    case "duplicate-canonical-root":
      return { happened: [`Local Configuration ${fact.configurationPath} bindings[${fact.bindingIndex}] project resolves to duplicate canonical root '${fact.canonicalProject}'`] };
    case "duplicate-missing-project":
      return { happened: [`Local Configuration ${fact.configurationPath} bindings[${fact.bindingIndex}] duplicates missing project path '${fact.project}'`] };
    case "bind-host-required":
      return {
        happened: ["bind requires at least one --host flag"],
        why: [[`supported Hosts: ${fact.supportedHosts.join(", ")}`]],
      };
    case "unsupported-host":
      return {
        happened: [`unsupported Agent Host '${fact.host}'`],
        why: [[`supported Hosts: ${fact.supportedHosts.join(", ")}`]],
      };
    case "unsupported-temporary-host":
      return {
        happened: [`unsupported Agent Host '${fact.host}'`],
        why: [[`temporary installation supports: ${fact.supportedHosts.join(", ")}`]],
      };
    case "temporary-host-unsupported":
      return {
        happened: [`temporary installation does not yet support Agent Host '${fact.host}'`],
        why: [[`supported Hosts: ${fact.supportedHosts.join(", ")}`]],
      };
    case "lifecycle-lock-busy":
      return {
        happened: [`Installation lifecycle is busy; another ${fact.operation} holds the lock`],
        whatToType: [["Retry once the other operation completes."]],
      };
    case "configuration-lock-busy":
      return {
        happened: [`Local Configuration ${fact.configurationPath} is busy; another ${fact.operation} holds the lock`],
        whatToType: [["Retry once the other operation completes."]],
      };
    case "configuration-changed-while-planning":
      return {
        happened: ["Local Configuration changed while apply was planning"],
        whatToType: [["Retry apply."]],
      };
    case "configuration-changed-before-publication":
      return {
        happened: [`Local Configuration ${fact.configurationPath} changed before ${fact.operation} publication`],
        whatToType: [["Retry after the other edit completes."]],
      };
    case "temporary-identity-required":
      return { happened: ["remove-temp requires a temporary installation identity"] };
    case "unknown-temporary-identity":
      return { happened: [`unknown temporary installation identity '${fact.temporaryInstallationId}'`] };
    case "init-symlink-target-missing":
      return {
        happened: [`Cannot initialize ${fact.path}: the Workspace symlink target does not exist`],
        whatToType: [["Remove the symlink or restore its target before retrying."]],
      };
    case "init-path-not-directory":
      return { happened: [`Cannot initialize ${fact.path}: the Workspace path exists and is not a directory`] };
    case "init-empty-symlink-target":
      return {
        happened: [`Cannot initialize ${fact.path}: the Workspace symlink target is empty`],
        whatToType: [["Remove the symlink and run init, or populate its target with a valid Workspace before retrying."]],
      };
    case "init-not-workspace-directory":
      return { happened: [`Cannot initialize ${fact.path}: directory is non-empty and is not an Agent Profile Kit Workspace`] };
    case "init-workspace-selection-conflict":
      return { happened: [`Cannot initialize Workspace '${fact.requested}': Local Configuration ${fact.configurationPath} already selects a different Workspace at ${fact.configuredPath}; refusing to change the canonical selection`] };
    case "foreign-diagnostic":
      return { happened: [fact.detail] };
    case "artifact-path-occupied":
      return {
        happened: [`${fact.artifactType} '${fact.id}' already has material at ${fact.path}`],
        whatToType: [[
          `Choose a different ${fact.artifactType} name or remove the existing material first, then run `,
          commandPart(COMMAND_NAME, [arg("new"), arg(CREATION_ARTIFACT_PRESENTATION[fact.artifactType].kindToken), arg("<different-name>")]),
          ".",
        ]],
      };
    case "artifact-creation-residue": {
      const retry = commandPart(COMMAND_NAME, [
        arg("new"),
        arg(CREATION_ARTIFACT_PRESENTATION[fact.artifactType].kindToken),
        arg(fact.id),
      ]);
      if (fact.contents === "own") {
        return {
          happened: [`${fact.artifactType} creation left incomplete Agent Profile Kit material at ${fact.path}`],
          whatToType: [[
            "Remove it, then run ",
            retry,
            " to retry.",
          ]],
        };
      }
      if (fact.contents === "foreign") {
        return {
          happened: [`${fact.artifactType} creation left ${fact.path} containing material Agent Profile Kit did not create`],
          whatToType: [[
            `Review the material, remove only what you determine is unwanted together with the ${CREATION_ARTIFACT_PRESENTATION[fact.artifactType].residueNoun}, then run `,
            retry,
            " to retry.",
          ]],
        };
      }
      return {
        happened: [`${fact.artifactType} creation left ${fact.path}; its contents could not be inspected`],
        whatToType: [[
          `Restore access to the ${CREATION_ARTIFACT_PRESENTATION[fact.artifactType].residueNoun} or review its contents before removing anything, then run `,
          retry,
          " to retry.",
        ]],
      };
    }
    case "workspace-open-failed": {
      const whyLines: (readonly InlineContent[])[] = [[fact.detail]];
      if (fact.cleanupFailed) {
        whyLines.push(["The opener process could not be cleaned up completely."]);
      }
      const quotedPath = safeShellQuoted(fact.path) ?? shellSingleQuoted(fact.path);
      return {
        happened: [`Could not open Workspace at ${fact.path}`],
        why: whyLines,
        whatToType: [[
          "Run ",
          commandPart("cd", [arg(quotedPath)]),
          " to inspect the Workspace directory.",
        ]],
      };
    }
    case "workspace-missing-manifest":
    case "workspace-manifest-not-file":
    case "workspace-dangling-category":
    case "workspace-category-not-directory":
    case "duplicate-artifact-name":
    case "profile-without-artifacts":
    case "missing-context-reference":
    case "missing-skill-reference":
    case "missing-dependency-reference":
    case "dependency-cycle":
      return formatWorkspaceIngestionErrorDiagnostic(fact);
    default:
      return formatConfiguredPathErrorDiagnostic(fact);
  }
}

/**
 * Presentation-owned canonical sentence parts for the Installer's typed
 * ProjectTargetError.
 */
export function formatProjectTargetError(
  reason: ProjectTargetErrorReason,
): readonly InlineContent[] {
  switch (reason.case) {
    case "ambiguous-target":
      return [
        commandPart(COMMAND_NAME, [arg(reason.command)]),
        ` Project target '${reason.target}' is ambiguous because it ` +
          "matches multiple Project Bindings; pass one exact Project root or run ",
        commandPart(COMMAND_NAME, [arg("list"), arg("projects")]),
      ];
    case "dangling-symlink-target":
      return [
        commandPart(COMMAND_NAME, [arg(reason.command)]),
        ` Project target project '${reason.target}' is a dangling ` +
          "symlink; restore its target or choose an existing directory",
      ];
    case "missing-target":
      return [
        commandPart(COMMAND_NAME, [arg(reason.command)]),
        ` Project target project '${reason.target}' must be an ` +
          "existing directory",
      ];
    case "relative-target":
      return [
        commandPart(COMMAND_NAME, [arg(reason.command)]),
        " Project target project must be an absolute path or " +
          "home-relative path beginning with ~/",
      ];
    case "unbound-target":
      return [
        commandPart(COMMAND_NAME, [arg(reason.command)]),
        ` Project target '${reason.target}' is not a bound Project; ` +
          "run ",
        commandPart(COMMAND_NAME, [arg("list"), arg("projects")]),
        " or ",
        commandPart(COMMAND_NAME, [arg("bind")]),
      ];
    case "wildcard-target":
      return [
        commandPart(COMMAND_NAME, [arg(reason.command)]),
        " Project target project must be an explicit directory " +
          "path without wildcards",
      ];
  }
}

/** Human rendering of a ProjectTargetError: newcomer terms, guard-clean. */
export function formatProjectTargetErrorForHuman(
  reason: ProjectTargetErrorReason,
): readonly InlineContent[] {
  return substituteInline(formatProjectTargetError(reason));
}

/** Structured diagnostic for ProjectTargetError (DEC-014, DEC-016). */
export function formatProjectTargetErrorDiagnostic(
  reason: ProjectTargetErrorReason,
): DiagnosticDocumentParts {
  switch (reason.case) {
    case "unbound-target":
      return {
        happened: [`directory '${reason.target}' is not configured as a Project`],
        whatToType: [
          ["Run ", commandPart(COMMAND_NAME, [arg("bind")]), " to configure this directory as a Project."],
          ["Run ", commandPart(COMMAND_NAME, [arg("list"), arg("projects")]), " to list configured Projects."],
        ],
      };
    case "ambiguous-target":
      return {
        happened: [
          commandPart(COMMAND_NAME, [arg(reason.command)]),
          ` Project target '${reason.target}' is ambiguous because it matches multiple configured Projects`,
        ],
        whatToType: [
          ["Pass one exact Project root or run ", commandPart(COMMAND_NAME, [arg("list"), arg("projects")]), "."],
        ],
      };
    case "dangling-symlink-target":
      return {
        happened: [
          commandPart(COMMAND_NAME, [arg(reason.command)]),
          ` Project target project '${reason.target}' is a dangling symlink`,
        ],
        whatToType: [["Restore its target or choose an existing directory."]],
      };
    case "missing-target":
      return {
        happened: [
          commandPart(COMMAND_NAME, [arg(reason.command)]),
          ` Project target project '${reason.target}' must be an existing directory`,
        ],
      };
    case "relative-target":
      return {
        happened: [
          commandPart(COMMAND_NAME, [arg(reason.command)]),
          " Project target project must be an absolute path or home-relative path beginning with ~/",
        ],
      };
    case "wildcard-target":
      return {
        happened: [
          commandPart(COMMAND_NAME, [arg(reason.command)]),
          " Project target project must be an explicit directory path without wildcards",
        ],
      };
  }
}

/**
 * The presentation sentence parts for one typed Installer-authored error, or
 * undefined when the error was not Installer-authored and may still project
 * `error.message`.
 */
export function installerErrorSentence(error: unknown): readonly InlineContent[] | undefined {
  if (error instanceof InstallerToolError) return formatInstallerToolError(error.fact);
  if (error instanceof SchemaRejectionError) return formatSchemaRejection(error.reason);
  return undefined;
}

/** Resolves any error into structured diagnostic parts (DEC-014). */
export function errorDiagnosticParts(
  error: unknown,
  options?: { usage?: string },
): DiagnosticDocumentParts {
  const parts = resolveErrorDiagnosticParts(error);
  if (options?.usage !== undefined) {
    return { ...parts, usage: options.usage };
  }
  return parts;
}

function resolveErrorDiagnosticParts(error: unknown): DiagnosticDocumentParts {
  if (error instanceof InstallerToolError) {
    const diagnostic = formatInstallerToolErrorDiagnostic(error.fact);
    return {
      ...diagnostic,
      happened: substituteInline(diagnostic.happened),
      ...(diagnostic.why ? { why: diagnostic.why.map(substituteInline) } : {}),
      ...(diagnostic.whatToType
        ? { whatToType: diagnostic.whatToType.map(substituteInline) }
        : {}),
    };
  }
  if (error instanceof ProjectTargetError) {
    const diagnostic = formatProjectTargetErrorDiagnostic(error.reason);
    return {
      ...diagnostic,
      happened: substituteInline(diagnostic.happened),
      ...(diagnostic.why ? { why: diagnostic.why.map(substituteInline) } : {}),
      ...(diagnostic.whatToType
        ? { whatToType: diagnostic.whatToType.map(substituteInline) }
        : {}),
    };
  }
  if (error instanceof MissingProfileError) {
    const diagnostic = formatMissingProfileErrorDiagnostic(error);
    return {
      ...diagnostic,
      happened: substituteInline(diagnostic.happened),
      ...(diagnostic.why ? { why: diagnostic.why.map(substituteInline) } : {}),
      ...(diagnostic.whatToType
        ? { whatToType: diagnostic.whatToType.map(substituteInline) }
        : {}),
    };
  }
  if (error instanceof SchemaRejectionError) {
    return { happened: substituteInline(formatSchemaRejection(error.reason)) };
  }
  if (error instanceof StateReadFailureError) {
    return { happened: [applyNewcomerSubstitutions(describeStateReadFailure(error.failure))] };
  }
  if (error instanceof CliArgumentError) {
    return { happened: substituteInline(error.parts) };
  }
  if (error instanceof AggregateError) {
    const causes = Array.from(error.errors, (cause) => errorDiagnosticParts(cause).happened);
    return {
      happened: substituteInline([error.message]),
      why: causes.map((cause) => substituteInline(["caused by: ", ...cause])),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { happened: substituteInline([message]) };
}

/** Formats any error as a complete presentation document (DEC-014). */
export function errorDiagnosticDocument(
  error: unknown,
  options?: { usage?: string },
): PresentationDocument {
  return diagnosticDocument(errorDiagnosticParts(error, options));
}

/** The plain-text projection of an error for machine tool-error payloads. */
export function formatErrorParts(error: unknown): readonly InlineContent[] {
  const authored = installerErrorSentence(error);
  if (authored !== undefined) return authored;
  if (error instanceof CliArgumentError) return error.parts;
  if (error instanceof MissingProfileError) return formatMissingProfileError(error);
  if (error instanceof ProjectTargetError) return formatProjectTargetError(error.reason);
  if (error instanceof StateReadFailureError) return [describeStateReadFailure(error.failure)];
  if (error instanceof AggregateError) {
    const causes = Array.from(error.errors, formatErrorParts);
    return [error.message, ...causes.map((cause) => ["\ncaused by: ", ...cause]).flat()];
  }
  const message = error instanceof Error ? error.message : String(error);
  return [message];
}

/** Machine projection: plain-text string representation. */
export function formatError(error: unknown): string {
  return flatInlineText(formatErrorParts(error));
}