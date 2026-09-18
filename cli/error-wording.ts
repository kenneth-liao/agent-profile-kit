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
  WorkspaceIngestionErrorFact,
} from "../installer/tool-errors.js";
import type { LocalConfigurationRejectionReason } from "../schemas/local-configuration.js";
import type {
  SchemaRejectionReason,
  WorkspaceArtifactRejectionReason,
  WorkspaceManifestRejectionReason,
} from "../schemas/schema-rejections.js";
import { RETIRED_MODEL_INVOCATION_METADATA_FIELD } from "../schemas/skill.js";
import {
  CONTEXT_DIRECTORY,
  CONTEXT_MODULE_EXTENSION,
  PROFILE_DIRECTORY,
  PROFILE_EXTENSION,
  profileIdFromPath,
  suggestedContextModulePath,
} from "../schemas/context-profile.js";
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
import { nearestName, suggestMovedContextModuleId } from "./nearest-match.js";
import { diagnosticDocument, type DiagnosticDocumentParts } from "./diagnostics.js";
import type { PresentationDocument } from "./presentation-document.js";

/** One carried command argument. */
const arg = (value: string): CommandArg => ({ kind: "text", value });

/**
 * The explicit init command forms (spec #593 #601): there is no default
 * Workspace location, so every diagnostic remedy names a path the user
 * gives. One home for the diagnostics' shared remedy; the bare screen
 * authors its own sentence because its lead-in differs (US-001).
 */
function initLocationRemedies(prefix: string): readonly InlineContent[] {
  return [
    prefix,
    commandPart(COMMAND_NAME, [arg("init"), arg("<path>")]),
    " to set up a Workspace in the folder you name, or ",
    commandPart(COMMAND_NAME, [arg("init"), arg(".")]),
    " to use the current folder.",
  ];
}

/**
 * The `apkit new` kind token for each creatable artifact type, with the noun
 * a residue fact's destination is referred to by. One home so every recovery
 * command names the kind that can actually retry the failed creation.
 */
const CREATION_ARTIFACT_PRESENTATION = {
  "Skill": { kindToken: "skill", residueNoun: "directory" },
  "Context Module": { kindToken: "context", residueNoun: "file" },
  "Profile": { kindToken: "profile", residueNoun: "file" },
} as const satisfies Record<CreationArtifactType, { kindToken: string; residueNoun: string }>;

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
    case "validate":
      return [commandPart(COMMAND_NAME, [arg("validate")])];
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

/**
 * The Project-target branch of the configured-path diagnostic family (#507,
 * US-015): every Project-target path failure leads with the actual target and
 * cause; the recorded binding's locator moves to the why section instead of
 * leading, so internal configuration details never precede the failure.
 */
function formatProjectTargetPathDiagnostic(
  fact: Extract<ConfiguredPathErrorFact, { readonly field: string }>,
): DiagnosticDocumentParts {
  const bindingLocator: readonly (readonly InlineContent[])[] | undefined =
    fact.origin.source === "local-configuration" && fact.origin.bindingIndex !== undefined
      ? [
          [`Recorded in Local Configuration ${fact.origin.configurationPath} bindings[${fact.origin.bindingIndex}].`],
        ]
      : undefined;
  switch (fact.kind) {
    case "wildcard-path":
      return {
        happened: ["Project target must be an explicit directory path without wildcards"],
        whatToType: [listProjectsRecovery()],
      };
    case "relative-path":
      return {
        happened: ["Project target must be an absolute path or home-relative path beginning with ~/"],
        whatToType: [listProjectsRecovery()],
      };
    case "missing-directory":
      return {
        happened: [`Project target '${fact.authored}' must be an existing directory`],
        ...(bindingLocator === undefined ? {} : { why: bindingLocator }),
        whatToType: [
          bindingLocator === undefined
            ? ["Create it or pass an existing Project directory."]
            : staleBindingRecovery(fact.authored),
        ],
      };
    case "dangling-symlink":
      return {
        happened: [`Project target '${fact.authored}' is a dangling symlink`],
        ...(bindingLocator === undefined ? {} : { why: bindingLocator }),
        whatToType: [["Restore its target or choose an existing directory."]],
      };
  }
}

/** The structured diagnostic parts for one typed configured-path failure. */
export function formatConfiguredPathErrorDiagnostic(fact: ConfiguredPathErrorFact): DiagnosticDocumentParts {
  if ("field" in fact && fact.field === "project") {
    return formatProjectTargetPathDiagnostic(fact);
  }
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
    case "leftover-skill-sidecar":
      return `Skill sidecar ${fact.file} is no longer read; list the needed Context Modules and Skills in a Profile's 'context' and 'skills' lists, then delete the file from the Workspace (version control can recover it if you need the old list)`;
    case "nested-profile":
      return `Profile ${fact.file} is inside a nested folder; Profiles live directly in the ${PROFILE_DIRECTORY} folder — move the file to ${PROFILE_DIRECTORY}${fact.file.split("/").pop()} (that file name without '${PROFILE_EXTENSION}' becomes its ID)`;
  }
}

/** Maximum number of available choices displayed inline before explicit overflow count. */
const MAX_DISPLAYED_AVAILABLE_CHOICES = 10;

/** Formats an available-choices list, capping at 10 items with explicit overflow. */
function formatAvailableChoices(label: string, items: readonly string[]): string {
  if (items.length <= MAX_DISPLAYED_AVAILABLE_CHOICES) {
    return `Available ${label}s: ${items.join(", ")}.`;
  }
  const visible = items.slice(0, MAX_DISPLAYED_AVAILABLE_CHOICES);
  const remaining = items.length - MAX_DISPLAYED_AVAILABLE_CHOICES;
  return `Available ${label}s: ${visible.join(", ")} (and ${remaining} more).`;
}

/**
 * The single canonical did-you-mean suggestion sentence shared across
 * diagnostics (DEC-017, US-015): nearest name within edit distance 2. Context
 * Module references add the moved-file rule (spec #593 US-006, #600): a
 * folder move changes the path-derived ID beyond any small edit distance, so
 * the Context-aware selection applies there.
 */
function nameSuggestionSentence(
  invalid: string,
  candidates: readonly string[],
  label?: string,
): string | undefined {
  const suggestion =
    label === "Context Module"
      ? suggestMovedContextModuleId(invalid, candidates)
      : nearestName(invalid, candidates);
  return suggestion !== undefined ? `Did you mean '${suggestion}'?` : undefined;
}

/**
 * The structured duplicate-Artifact-ID diagnostic (US-015, #508): what happened
 * names the existing artifact's real path carried by the fact, why states what
 * was unchanged, and what to type offers editing the existing file or another
 * name — creation never gains an overwrite prompt. At creation time the
 * remedy names the retry command for the rejecting artifact kind; at ingestion
 * time (validate and lifecycle planning) it directs to editing the conflicting
 * files and re-running validation, never a fabricated creation retry.
 */
function duplicateArtifactNameDiagnostic(
  fact: Extract<WorkspaceIngestionErrorFact, { kind: "duplicate-artifact-name" }>,
): DiagnosticDocumentParts {
  const happened = [
    `A ${fact.artifactType} named '${fact.id}' already exists at ${fact.path}`,
  ];
  if (fact.stage === "creation") {
    return {
      happened,
      why: [["Nothing was created or changed."]],
      whatToType: [[
        `Edit ${fact.path}, or choose a different name and run `,
        commandPart(COMMAND_NAME, [
          arg("new"),
          arg(CREATION_ARTIFACT_PRESENTATION[fact.artifactType].kindToken),
          arg("<name>"),
        ]),
        ".",
      ]],
    };
  }
  return {
    happened,
    why: [["Nothing was created or changed."]],
    whatToType: [[
      `Edit one of the conflicting files so each ${fact.artifactType} has a unique Artifact ID, then run `,
      commandPart(COMMAND_NAME, [arg("validate")]),
      ".",
    ]],
  };
}

/**
 * The refused-creation missing-reference diagnostic (US-015, #508): what
 * happened reports the actual state — the Profile was not created — and never
 * names the uncreated Profile file as a repair target; the remedy is the
 * runnable create-or-select recovery for the missing reference.
 */
function creationMissingReferenceDiagnostic(evidence: {
  readonly profile: string;
  readonly invalid: string;
  readonly label: CreationArtifactType;
  readonly available: readonly string[];
}): DiagnosticDocumentParts {
  const why: (readonly InlineContent[])[] = [
    [evidence.available.length === 0
      ? `No ${evidence.label}s exist in the Workspace.`
      : formatAvailableChoices(evidence.label, evidence.available)],
  ];
  const suggestion = nameSuggestionSentence(evidence.invalid, evidence.available, evidence.label);
  if (suggestion !== undefined) {
    why.push([suggestion]);
  }
  return {
    happened: [
      `Profile '${evidence.profile}' was not created: it selects missing ${evidence.label} '${evidence.invalid}'`,
    ],
    why,
    whatToType: [[
      `Create it with `,
      commandPart(COMMAND_NAME, [
        arg("new"),
        arg(CREATION_ARTIFACT_PRESENTATION[evidence.label].kindToken),
        arg("<name>"),
      ]),
      `, or select an available name, then run `,
      commandPart(COMMAND_NAME, [arg("new"), arg("profile"), arg(evidence.profile)]),
      ` again.`,
    ]],
  };
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
      : formatAvailableChoices(evidence.label, evidence.available)],
  ];
  const suggestion = nameSuggestionSentence(evidence.invalid, evidence.available, evidence.label);
  if (suggestion !== undefined) {
    why.push([suggestion]);
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
      return duplicateArtifactNameDiagnostic(fact);
    case "profile-without-artifacts": {
      const contextGuidance = fact.availableContexts === undefined
        ? ""
        : (fact.availableContexts.length === 0
          ? " No Context Modules exist in the Workspace."
          : ` Available Context Modules: ${fact.availableContexts.join(", ")}.`);
      const skillGuidance = fact.availableSkills === undefined
        ? ""
        : (fact.availableSkills.length === 0
          ? " No Skills exist in the Workspace."
          : ` Available Skills: ${fact.availableSkills.join(", ")}.`);
      return {
        happened: [`Profile '${fact.profile}' must select at least one supported artifact (Context Module or Skill)`],
        ...(contextGuidance === "" && skillGuidance === "" ? {} : {
          why: [
            [`${contextGuidance}${skillGuidance}`.trim()],
          ],
        }),
      };
    }
    case "missing-context-reference":
      return fact.stage === "creation"
        ? creationMissingReferenceDiagnostic({
            profile: fact.profile,
            invalid: fact.contextId,
            label: "Context Module",
            available: fact.available,
          })
        : missingReferenceDiagnostic({
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
      return fact.stage === "creation"
        ? creationMissingReferenceDiagnostic({
            profile: fact.profile,
            invalid: fact.skillId,
            label: "Skill",
            available: fact.available,
          })
        : missingReferenceDiagnostic({
            happened: [
              `Profile '${fact.profile}' in ${fact.file} selects missing Skill '${fact.skillId}'.`,
            ],
            invalid: fact.skillId,
            label: "Skill",
            available: fact.available,
            file: fact.file,
            remedy: `Restore the Skill, or remove or update Profile '${fact.profile}'.`,
          });
    case "leftover-skill-sidecar":
      return {
        happened: [`Skill sidecar ${fact.file} is no longer read.`],
        whatToType: [
          ["List the needed Context Modules and Skills in a Profile's 'context' and 'skills' lists, then delete the file; version control can recover it if you need the old list."],
        ],
      };
    case "nested-profile":
      return {
        happened: [`Profile ${fact.file} is inside a nested folder.`],
        whatToType: [
          [`Profiles live directly in the ${PROFILE_DIRECTORY} folder; move the file to ${PROFILE_DIRECTORY}${fact.file.split("/").pop()}, whose name without '${PROFILE_EXTENSION}' becomes its ID.`],
        ],
      };
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
    case "unsupported-host": {
      const suggestion = nameSuggestionSentence(reason.host, reason.supportedHosts);
      const suggestionText = suggestion !== undefined ? `; ${suggestion}` : "";
      return [`Local Configuration ${reason.path} bindings[${reason.index}] hosts[${reason.hostIndex}] unsupported Agent Host '${reason.host}'; supported Hosts: ${reason.supportedHosts.join(", ")}${suggestionText}`];
    }
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
      return reason.detail.grammar === "context"
        ? [`${reason.detail.label} must be a Context Module ID: lowercase kebab-case segments joined by '/'`]
        : [`${reason.detail.label} must be a lowercase kebab-case name without wildcards`];
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
      // Context references use the path grammar (spec #593 DEC-004, #600);
      // every other artifact reference stays flat.
      return reason.section === "context"
        ? `${description} must be a Context Module ID: lowercase kebab-case segments joined by '/'`
        : `${description} must be a lowercase kebab-case name without wildcards`;
    case "profile-id-field": {
      // The fix keeps existing Project Bindings and Installation Receipts
      // working: an authored id that differs from the file name can be kept
      // by renaming the file, never by silently rebinding the ID (#598).
      // The formatter is total: profileIdFromPath's path-shape guard cannot
      // throw for any fact parseProfile raises, and a non-canonical path
      // simply omits the rename clause.
      let fileName: string | undefined;
      try {
        fileName = profileIdFromPath(path);
      } catch {
        fileName = undefined;
      }
      const base =
        `Profile ${path} must not contain an 'id' field; a Profile's ID is its file name without '.yaml'. Remove the 'id' field`;
      if (reason.id === undefined || reason.id === fileName) return base;
      return `${base}, or rename the file to ${PROFILE_DIRECTORY}${reason.id}${PROFILE_EXTENSION} to keep the Profile ID '${reason.id}' that Project Bindings and installations reference`;
    }
    case "profile-file-name":
      return `Profile ${reason.path} must have a file name that is a lowercase kebab-case name without wildcards; rename the file so its name without '.yaml' is the Profile ID`;
    case "context-module-file-name": {
      // The ID is the path (spec #593 DEC-004, #600): the fix renames the
      // segments so the derived ID is valid. One home derives the suggestion
      // so it cannot drift from the grammar.
      const suggested = suggestedContextModulePath(reason.name);
      const base =
        `Context Module ${reason.path} must have a path whose folders and file name are lowercase kebab-case names without wildcards (they form the Context Module ID)`;
      return suggested === undefined
        ? `${base}; rename the file and its folders so every segment is a valid ID`
        : `${base}; rename the file to ${suggested}`;
    }
    case "invalid-model-invocation":
      return `Skill ${reason.path} ${reason.key} must be a boolean; set it to true to disable model invocation, or remove the field to allow invocation`;
    case "leftover-model-invocation-metadata":
      return `Skill ${reason.path} ${RETIRED_MODEL_INVOCATION_METADATA_FIELD} is no longer read; move the policy to the standard top-level field 'disable-model-invocation' (true disables model invocation), then remove the metadata key`;
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
  const choicesText = formatAvailableChoices("Profile", error.availableProfiles);
  const suggestion = nameSuggestionSentence(error.profile, error.availableProfiles);
  const suggestionText = suggestion !== undefined ? ` ${suggestion}` : "";
  return [...heading, ` ${choicesText}${suggestionText}`, ...recovery];
}

/** Structured diagnostic for Missing Profile (DEC-014). */
export function formatMissingProfileErrorDiagnostic(error: MissingProfileError): DiagnosticDocumentParts {
  const heading = [`${missingProfileSentence(error.profile)}.`];
  const why: (readonly InlineContent[])[] = error.availableProfiles.length === 0
    ? [["No Profiles exist in the Workspace."]]
    : [[formatAvailableChoices("Profile", error.availableProfiles)]];
  const suggestion = nameSuggestionSentence(error.profile, error.availableProfiles);
  if (suggestion !== undefined) {
    why.push([suggestion]);
  }
  const whatToType: (readonly InlineContent[])[] = [];
  if (error.recoverByEditingLocalConfiguration) {
    whatToType.push(["Edit Local Configuration directly if this stale binding must be removed."]);
  } else if (error.availableProfiles.length === 0) {
    whatToType.push(["Run ", commandPart(COMMAND_NAME, [arg("guide"), arg("profile")]), " to learn how to add a Profile."]);
  } else if (suggestion === undefined) {
    whatToType.push([
      "Run ",
      commandPart(COMMAND_NAME, [arg("list"), arg("profiles")]),
      " to inspect available Profiles.",
    ]);
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
      return [`Local Configuration is missing at ${fact.path}; run `, commandPart(COMMAND_NAME, [arg("init"), arg("<path>")])];
    case "bind-conflict":
      return [`Local Configuration ${fact.configurationPath} already binds canonical project '${fact.canonicalProject}' to profile '${fact.profile}' hosts [${fact.hosts.join(", ")}]; pass --replace to restate its Profile and Hosts`];
    case "duplicate-canonical-root":
      return [`Local Configuration ${fact.configurationPath} bindings[${fact.bindingIndex}] project resolves to duplicate canonical root '${fact.canonicalProject}'`];
    case "duplicate-missing-project":
      return [`Local Configuration ${fact.configurationPath} bindings[${fact.bindingIndex}] duplicates missing project path '${fact.project}'`];
    case "bind-host-required":
      return [`bind requires at least one --host flag; supported Hosts: ${fact.supportedHosts.join(", ")}`];
    case "install-host-required":
      return [`install requires at least one --host flag; supported Hosts: ${fact.supportedHosts.join(", ")}`];
    case "unsupported-host": {
      const suggestion = nameSuggestionSentence(fact.host, fact.supportedHosts);
      const suggestionText = suggestion !== undefined ? `; ${suggestion}` : "";
      return [`unsupported Agent Host '${fact.host}'; supported Hosts: ${fact.supportedHosts.join(", ")}${suggestionText}`];
    }
    case "unsupported-temporary-host": {
      const suggestion = nameSuggestionSentence(fact.host, fact.supportedHosts);
      const suggestionText = suggestion !== undefined ? `; ${suggestion}` : "";
      return [`unsupported Agent Host '${fact.host}'; temporary installation supports: ${fact.supportedHosts.join(", ")}${suggestionText}`];
    }
    case "temporary-host-unsupported": {
      const suggestion = nameSuggestionSentence(fact.host, fact.supportedHosts);
      const suggestionText = suggestion !== undefined ? `; ${suggestion}` : "";
      return [`temporary installation does not yet support Agent Host '${fact.host}'; supported Hosts: ${fact.supportedHosts.join(", ")}${suggestionText}`];
    }
    case "lifecycle-lock-busy":
      return [`Installation lifecycle is busy; another ${fact.operation} holds the lock — retry`];
    case "configuration-lock-busy":
      return [`Local Configuration ${fact.configurationPath} is busy; another ${fact.operation} holds the lock — retry`];
    case "configuration-changed-while-planning":
      return ["Local Configuration changed while update was planning; retry update"];
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
    case "init-missing-parent-directory":
      return [`Cannot initialize ${fact.path}: parent directory ${fact.parent} does not exist; nothing was written`];
    case "init-partial-setup": {
      // The provisioned folder is named by the fact's path, so it renders
      // separately from the workspace-relative parts it contains.
      const parts = fact.added[0] === fact.path ? fact.added.slice(1) : fact.added;
      const wrote = fact.added.length === 0
        ? "nothing was added"
        : `setup ${fact.added[0] === fact.path ? "created the folder and added" : "added"} ${parts.join(", ")}`;
      return [`Cannot initialize ${fact.path}: ${fact.cause}; ${wrote} and stopped — existing files are unchanged, and re-running init adds only the still-missing parts`];
    }
    case "init-workspace-selection-conflict":
      return [`Cannot initialize Workspace '${fact.requested}': Local Configuration ${fact.configurationPath} already selects a different Workspace at ${fact.configuredPath}; refusing to change the canonical selection`];
    case "init-workspace-path-required":
      return ["init without a path would choose a Workspace location for you; setup uses a folder you choose and never selects one itself"];
    case "foreign-diagnostic":
      return [fact.detail];
    case "artifact-path-occupied":
      return [`${fact.artifactType} '${fact.id}' already has material at ${fact.path}; choose a different name or remove the existing material first`];
    case "context-module-parent-not-directory":
      return [`Context Module folder ${fact.path} must be a directory; remove it or replace it with a folder, then run `, commandPart(COMMAND_NAME, [arg("new"), arg("context"), arg("<context>")])];
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
    case "profile-file-symlink":
      return [`Profile '${fact.profile}' at ${fact.path} is a symlink; configure never writes through links`];
    case "workspace-missing-manifest":
    case "workspace-manifest-not-file":
    case "workspace-dangling-category":
    case "workspace-category-not-directory":
    case "duplicate-artifact-name":
    case "profile-without-artifacts":
    case "missing-context-reference":
    case "missing-skill-reference":
    case "leftover-skill-sidecar":
    case "nested-profile":
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
        whatToType: [initLocationRemedies("Run ")],
      };
    case "init-workspace-path-required":
      return {
        happened: ["init without a path would choose a Workspace location for you; setup uses a folder you choose and never selects one itself"],
        whatToType: [initLocationRemedies("Run ")],
      };
    case "bind-conflict":
      return {
        happened: [`Local Configuration ${fact.configurationPath} already binds canonical project '${fact.canonicalProject}' to profile '${fact.profile}' hosts [${fact.hosts.join(", ")}]`],
        whatToType: [["Pass --replace to restate its Profile and Hosts."]],
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
    case "install-host-required":
      return {
        happened: ["install requires at least one --host flag"],
        why: [[`supported Hosts: ${fact.supportedHosts.join(", ")}`]],
      };
    case "unsupported-host": {
      const suggestion = nameSuggestionSentence(fact.host, fact.supportedHosts);
      const why: (readonly InlineContent[])[] = [
        [`Supported Hosts: ${fact.supportedHosts.join(", ")}.`],
      ];
      if (suggestion !== undefined) {
        why.push([suggestion]);
      }
      return {
        happened: [`Unsupported Agent Host '${fact.host}'`],
        why,
        ...(suggestion === undefined
          ? {
              whatToType: [
                [
                  "Run ",
                  commandPart(COMMAND_NAME, [arg("list"), arg("hosts")]),
                  " to inspect supported Hosts.",
                ],
              ],
            }
          : {}),
      };
    }
    case "unsupported-temporary-host": {
      const suggestion = nameSuggestionSentence(fact.host, fact.supportedHosts);
      const why: (readonly InlineContent[])[] = [
        [`Temporary installation supports: ${fact.supportedHosts.join(", ")}.`],
      ];
      if (suggestion !== undefined) {
        why.push([suggestion]);
      }
      return {
        happened: [`Unsupported Agent Host '${fact.host}'`],
        why,
        ...(suggestion === undefined
          ? {
              whatToType: [
                [
                  "Run ",
                  commandPart(COMMAND_NAME, [arg("list"), arg("hosts")]),
                  " to inspect supported Hosts.",
                ],
              ],
            }
          : {}),
      };
    }
    case "temporary-host-unsupported": {
      const suggestion = nameSuggestionSentence(fact.host, fact.supportedHosts);
      const why: (readonly InlineContent[])[] = [
        [`Supported Hosts: ${fact.supportedHosts.join(", ")}.`],
      ];
      if (suggestion !== undefined) {
        why.push([suggestion]);
      }
      return {
        happened: [`Temporary installation does not yet support Agent Host '${fact.host}'`],
        why,
        ...(suggestion === undefined
          ? {
              whatToType: [
                [
                  "Run ",
                  commandPart(COMMAND_NAME, [arg("list"), arg("hosts")]),
                  " to inspect supported Hosts.",
                ],
              ],
            }
          : {}),
      };
    }
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
        happened: ["Local Configuration changed while update was planning"],
        whatToType: [["Retry update."]],
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
    case "init-missing-parent-directory":
      return {
        happened: [`Cannot initialize ${fact.path}: parent directory ${fact.parent} does not exist`],
        whatToType: [["Create the parent folder first, or choose a path whose parent exists; nothing was written."]],
      };
    case "init-partial-setup": {
      const parts = fact.added[0] === fact.path ? fact.added.slice(1) : fact.added;
      const wrote = fact.added.length === 0
        ? ["nothing was added"]
        : fact.added[0] === fact.path
          ? ["setup created the folder and added ", parts.join(", ")]
          : ["setup added ", parts.join(", ")];
      return {
        happened: [`Cannot initialize ${fact.path}: ${fact.cause}; `, ...wrote, " and stopped"],
        whatToType: [[
          "Existing files are unchanged and Local Configuration was not written; re-run ",
          commandPart(COMMAND_NAME, [arg("init"), arg(fact.path)]),
          " to add only the still-missing parts.",
        ]],
      };
    }
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
    case "context-module-parent-not-directory":
      return {
        happened: [`Context Module folder ${fact.path} must be a directory`],
        whatToType: [[
          "Remove it or replace it with a folder, then run ",
          commandPart(COMMAND_NAME, [arg("new"), arg("context"), arg("<context>")]),
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
    case "profile-file-symlink":
      return {
        happened: [`Profile '${fact.profile}' at ${fact.path} is a symlink; configure never writes through links`],
        whatToType: [["Replace the link with a regular file, or edit its target directly, then re-run configure."]],
      };
    case "workspace-missing-manifest":
    case "workspace-manifest-not-file":
    case "workspace-dangling-category":
    case "workspace-category-not-directory":
    case "duplicate-artifact-name":
    case "profile-without-artifacts":
    case "missing-context-reference":
    case "missing-skill-reference":
    case "leftover-skill-sidecar":
    case "nested-profile":
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
        commandPart(COMMAND_NAME, [arg("install")]),
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

/**
 * The one runnable Project-discovery recovery shared by every Project-target
 * rejection (US-015, #507): one home so the family cannot drift, phrased once
 * so the guidance does not repeat the verb it names.
 */
function listProjectsRecovery(): readonly InlineContent[] {
  return [
    "Run ",
    commandPart(COMMAND_NAME, [arg("list"), arg("projects")]),
    " to see configured Projects.",
  ];
}

/** The carried command line for one stale recorded Project binding (#507). */
function staleBindingRecovery(authored: string): readonly InlineContent[] {
  return [
    "Restore the directory, or run ",
    commandPart(COMMAND_NAME, [
      arg("uninstall"),
      arg("--project"),
      arg(shellSingleQuoted(authored)),
    ]),
    " to remove its stale record.",
  ];
}

/** Structured diagnostic for ProjectTargetError (DEC-014, DEC-016, #507). */
export function formatProjectTargetErrorDiagnostic(
  reason: ProjectTargetErrorReason,
): DiagnosticDocumentParts {
  switch (reason.case) {
    case "unbound-target":
      return {
        happened: [`Directory '${reason.target}' is not configured as a Project`],
        whatToType: [
          ["Run ", commandPart(COMMAND_NAME, [arg("install")]), " to configure this directory as a Project."],
          listProjectsRecovery(),
        ],
      };
    case "ambiguous-target":
      return {
        happened: [
          `Project target '${reason.target}' is ambiguous because it matches multiple configured Projects`,
        ],
        whatToType: [
          ["Pass one exact Project root or run ", commandPart(COMMAND_NAME, [arg("list"), arg("projects")]), "."],
        ],
      };
    case "dangling-symlink-target":
      return {
        happened: [`Project target '${reason.target}' is a dangling symlink`],
        whatToType: [["Restore its target or choose an existing directory."], listProjectsRecovery()],
      };
    case "missing-target":
      return {
        happened: [`Project target '${reason.target}' must be an existing directory`],
        whatToType: [listProjectsRecovery()],
      };
    case "relative-target":
      return {
        happened: [
          "Project target must be an absolute path or home-relative path beginning with ~/",
        ],
        whatToType: [listProjectsRecovery()],
      };
    case "wildcard-target":
      return {
        happened: ["Project target must be an explicit directory path without wildcards"],
        whatToType: [listProjectsRecovery()],
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