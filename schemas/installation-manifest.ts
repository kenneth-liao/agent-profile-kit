import { parse, stringify } from "yaml";
import { basename, dirname, isAbsolute, normalize, posix, win32 } from "node:path";

import {
  ARTIFACT_TYPES,
  artifactReferenceKey,
  requireArtifactId,
  type ArtifactReference,
  type ArtifactType,
} from "./dependencies.js";
import { isSupportedHost, SUPPORTED_HOSTS, type SupportedHost } from "./local-configuration.js";

export const INSTALLATION_MANIFEST_SCHEMA_VERSION = 3;
/** Manifest schema written before artifact fingerprints and output origins were recorded. */
export const INSTALLATION_MANIFEST_LEGACY_SCHEMA_VERSION = 2;
export const INSTALLATION_STATE_LEGACY_SCHEMA_VERSION = 2;
export const INSTALLATION_STATE_PREVIOUS_SCHEMA_VERSION = 3;
/** Schema version that introduced intended teardown provenance without temporary installations. */
export const INSTALLATION_STATE_V4_SCHEMA_VERSION = 4;
export const INSTALLATION_STATE_SCHEMA_VERSION = 5;
/** Maximum UTF-8 bytes accepted from transitional Installation State. */
export const INSTALLATION_STATE_MAX_BYTES = 8 * 1024 * 1024;
/** Maximum expanded YAML aliases accepted from supported transitional Installation State. */
export const INSTALLATION_STATE_MAX_ALIAS_COUNT = 100_000;
export const INSTALLATION_MARKER_SCHEMA_VERSION = 1;
export const INSTALLATION_MARKER_PATH = ".agent-profile-kit/installation.json";

/** A regular file recorded under an owned artifact directory. Paths are relative to the directory root. */
export interface OwnedDirectoryFileMember {
  readonly hash: string;
  readonly mode: number;
  readonly path: string;
  readonly type: "file";
}

/** A subdirectory recorded under an owned artifact directory. Paths are relative to the directory root. */
export interface OwnedDirectoryDirectoryMember {
  readonly mode: number;
  readonly path: string;
  readonly type: "directory";
}

export type OwnedDirectoryMember =
  | OwnedDirectoryDirectoryMember
  | OwnedDirectoryFileMember;

export interface OwnedFileOutput {
  readonly hash: string;
  readonly mode: number;
  readonly path: string;
  readonly type: "file";
}

/**
 * One complete Installer-owned artifact directory. The directory hash covers every
 * recorded member so ownership can be proven from the Manifest plus on-disk contents.
 */
export interface OwnedDirectoryOutput {
  readonly hash: string;
  readonly members: readonly OwnedDirectoryMember[];
  readonly mode: number;
  readonly path: string;
  readonly type: "directory";
}

export type OwnedOutput = OwnedDirectoryOutput | OwnedFileOutput;

export interface ResolvedArtifactRecord {
  /**
   * Normalized canonical source fingerprint recorded as receipt evidence. Absent
   * on legacy manifests ingested without provenance; a current manifest either
   * carries a fingerprint for every resolved artifact or none at all.
   */
  readonly fingerprint?: string;
  readonly inclusionReasons: readonly {
    readonly path: readonly ArtifactReference[];
    readonly profile: string;
  }[];
  readonly reference: ArtifactReference;
}

export interface ProjectInstallationManifest {
  readonly adapterVersion: string;
  readonly engineVersion: string;
  /** Whether the installation was planned from a Git project boundary. */
  readonly gitProject?: boolean;
  readonly hosts: readonly string[];
  readonly hostVersions: Readonly<Record<string, string>>;
  readonly installationId: string;
  /**
   * Typed source origins for every owned output, keyed by exact output path.
   * A value may hold zero, one, or multiple canonical Artifact references;
   * the Installer-owned Marker always holds zero. Absent on legacy manifests
   * that predate provenance recording; when present, evidence is complete and
   * consistent with `resolvedArtifacts`.
   */
  readonly outputOrigins?: Readonly<Record<string, readonly ArtifactReference[]>>;
  readonly outputs: readonly OwnedOutput[];
  readonly profileId: string;
  readonly project: string;
  readonly resolvedArtifacts: readonly ResolvedArtifactRecord[];
  readonly schemaVersion: 3;
  readonly selectedContext: readonly string[];
  readonly workspaceInputHash: string;
}

export interface InstallationMarker {
  readonly installationId: string;
  readonly schemaVersion: 1;
}

export interface RepositoryExclusionContribution {
  readonly entries: readonly string[];
  readonly installationId: string;
}

/** Canonical machine-local ownership for one repository-local Git exclusion file. */
export interface RepositoryExclusionRecord {
  /** Canonical absolute path to the repository-local exclusion file. */
  readonly target: string;
  /** Exact root-anchored entries attributable to each Installation ID. */
  readonly contributions: readonly RepositoryExclusionContribution[];
  /** Sorted, deduplicated union expected in the Installer-owned section. */
  readonly entries: readonly string[];
}

/** Provenance retained after uninstall removes an owned Profile Installation. */
export interface IntendedTeardown {
  readonly hosts: readonly string[];
  readonly installationId: string;
  readonly profileId: string;
  readonly project: string;
}

/**
 * Temporary Profile Installation completion state.
 * `installed` is active and owns outputs/exclusions; `removed` is a terminal
 * identity retained only so idempotent remove-temp can succeed without recreating state.
 */
export type TemporaryInstallationCompletionState = "installed" | "removed";

/**
 * Durable Temporary Profile Installation record. Lifetime is owned by this receipt
 * identity rather than a Project Binding. Active records contribute to Repository
 * Exclusion ownership via `temporaryInstallationId`.
 */
export interface TemporaryProfileInstallation {
  readonly adapterVersion: string;
  readonly completionState: TemporaryInstallationCompletionState;
  readonly engineVersion: string;
  /** Whether the installation was planned from a Git project boundary. */
  readonly gitProject?: boolean;
  readonly host: SupportedHost;
  readonly hostVersion: string;
  /** Owned outputs; empty once removed. */
  readonly outputs: readonly OwnedOutput[];
  readonly profileId: string;
  readonly project: string;
  readonly temporaryInstallationId: string;
  readonly workspaceInputHash: string;
}

export interface InstallationState {
  readonly intendedTeardowns: readonly IntendedTeardown[];
  readonly installations: readonly ProjectInstallationManifest[];
  readonly repositoryExclusions: readonly RepositoryExclusionRecord[];
  readonly schemaVersion: 5;
  readonly temporaryInstallations: readonly TemporaryProfileInstallation[];
}

/** Stable byte-order comparator shared by canonical state and on-disk unions. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(value: unknown, description: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${description} must be a boolean`);
  }
  return value;
}

function requireStringArray(value: unknown, description: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${description} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${description} must not contain a value more than once`);
  }
  return value;
}

function requireHash(value: unknown, description: string): string {
  const hash = requireString(value, description);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${description} must be a SHA-256 hash`);
  }
  return hash;
}

export function parseFileMode(value: unknown, description: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    throw new Error(`${description} must be an integer permission mode between 0 and 0777`);
  }
  return value as number;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  description: string,
): void {
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    throw new Error(`${description} does not allow fields: ${unknown.join(", ")}`);
  }
}

function parseYaml(
  source: string,
  description: string,
  options?: { readonly maxAliasCount: number },
): unknown {
  try {
    return parse(source, options);
  } catch {
    throw new Error(`${description} is invalid YAML`);
  }
}

function parseInstallationStateYaml(source: string): unknown {
  if (Buffer.byteLength(source, "utf8") > INSTALLATION_STATE_MAX_BYTES) {
    throw new Error(
      `Installation State exceeds the ${INSTALLATION_STATE_MAX_BYTES} byte limit`,
    );
  }
  return parseYaml(source, "Installation State", {
    maxAliasCount: INSTALLATION_STATE_MAX_ALIAS_COUNT,
  });
}

function requireRelativeOutputPath(value: unknown, description: string): string {
  const path = requireString(value, description);
  if (
    path.startsWith("/") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "." || part === ".." || part === "")
  ) {
    throw new Error(`${description} must be a normalized safe relative project path`);
  }
  return path;
}

function requireAbsoluteNormalizedPath(value: unknown, description: string): string {
  const path = requireString(value, description);
  if (
    !isAbsolute(path) ||
    normalize(path) !== path ||
    /^[A-Za-z]:/.test(path) ||
    path.includes("\\") ||
    path.endsWith("/")
  ) {
    throw new Error(`${description} must be a normalized absolute path`);
  }
  if (basename(path) !== "exclude" || basename(dirname(path)) !== "info" || basename(dirname(dirname(path))) !== ".git") {
    throw new Error(`${description} must be a canonical Git repository-local exclusion-file target`);
  }
  return path;
}

function requireExclusionEntry(value: unknown, description: string): string {
  const entry = requireString(value, description);
  if (
    !entry.startsWith("/") ||
    entry.includes("\\") ||
    /[*?\[\]]/.test(entry) ||
    /[\u0000-\u001f\u007f]/.test(entry) ||
    entry.split("/").some((part, index) => index > 0 && (part.length === 0 || part === "." || part === "..")) ||
    posix.normalize(entry) !== entry
  ) {
    throw new Error(`${description} must be a normalized root-anchored exclusion entry`);
  }
  return entry;
}

function requireExclusionEntries(value: unknown, description: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} must be an array`);
  }
  const entries = value.map((entry, index) =>
    requireExclusionEntry(entry, `${description}[${index}]`),
  );
  if (entries.length === 0) {
    throw new Error(`${description} must be a non-empty array`);
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${description} must not contain an entry more than once`);
  }
  return entries;
}

function sortedEntries(entries: readonly string[]): readonly string[] {
  return [...entries].sort(compareCanonicalStrings);
}

/** Build one canonical record from already-normalized generated contributions. */
export function canonicalRepositoryExclusionRecord(
  target: string,
  contributions: readonly RepositoryExclusionContribution[],
): RepositoryExclusionRecord {
  const canonicalContributions = [...contributions]
    .map((contribution) => ({
      entries: sortedEntries([...new Set(contribution.entries)]),
      installationId: contribution.installationId,
    }))
    .sort((left, right) => compareCanonicalStrings(left.installationId, right.installationId));
  return {
    contributions: canonicalContributions,
    entries: sortedEntries([...new Set(canonicalContributions.flatMap((contribution) => contribution.entries))]),
    target,
  };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function parseRepositoryExclusionRecords(value: unknown): readonly RepositoryExclusionRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Installation State repository_exclusions must be an array");
  }
  const seenContributorIds = new Set<string>();
  const records = value.map((entry, index) => {
    const description = `Installation State repository_exclusions[${index}]`;
    const record = requireMapping(entry, description);
    requireExactFields(record, ["target", "contributions", "entries"], description);
    const target = requireAbsoluteNormalizedPath(record.target, `${description} target`);
    if (!Array.isArray(record.contributions) || record.contributions.length === 0) {
      throw new Error(`${description} contributions must be a non-empty array`);
    }
    const contributions = record.contributions.map((entry, contributionIndex) => {
      const contributionDescription = `${description} contributions[${contributionIndex}]`;
      const contribution = requireMapping(entry, contributionDescription);
      requireExactFields(contribution, ["installation_id", "entries"], contributionDescription);
      return {
        entries: sortedEntries(requireExclusionEntries(
          contribution.entries,
          `${contributionDescription} entries`,
        )),
        installationId: requireString(
          contribution.installation_id,
          `${contributionDescription} installation_id`,
        ),
      };
    });
    const recordContributorIds = contributions.map((contribution) => contribution.installationId);
    if (new Set(recordContributorIds).size !== recordContributorIds.length) {
      throw new Error(`${description} must not contain an Installation ID more than once`);
    }
    for (const contributorId of recordContributorIds) {
      if (seenContributorIds.has(contributorId)) {
        throw new Error(
          `Installation State repository_exclusions must not contain Installation ID ${contributorId} more than once`,
        );
      }
      seenContributorIds.add(contributorId);
    }
    const entries = sortedEntries(requireExclusionEntries(record.entries, `${description} entries`));
    const union = sortedEntries([...new Set(contributions.flatMap((contribution) => contribution.entries))]);
    if (!sameStringArray(entries, union)) {
      throw new Error(`${description} entries must equal the sorted union of contributions`);
    }
    return {
      contributions: [...contributions].sort((left, right) =>
        compareCanonicalStrings(left.installationId, right.installationId),
      ),
      entries: union,
      target,
    };
  });
  const targets = records.map((record) => record.target);
  if (new Set(targets).size !== targets.length) {
    throw new Error("Installation State repository_exclusions must not contain a target more than once");
  }
  return [...records].sort((left, right) => compareCanonicalStrings(left.target, right.target));
}

function requireArtifactReference(value: unknown, description: string): ArtifactReference {
  const reference = requireMapping(value, description);
  requireExactFields(reference, ["type", "id"], description);
  if (typeof reference.type !== "string" || !ARTIFACT_TYPES.includes(reference.type as ArtifactType)) {
    throw new Error(`${description} type must be one of: ${ARTIFACT_TYPES.join(", ")}`);
  }
  return {
    id: requireArtifactId(reference.id, `${description} id`),
    type: reference.type as ArtifactType,
  };
}

function parseResolvedArtifacts(value: unknown): readonly ResolvedArtifactRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Installation Manifest resolved_artifacts must be an array");
  }
  const records = value.map((entry, index) => {
    const description = `Installation Manifest resolved_artifacts[${index}]`;
    const artifact = requireMapping(entry, description);
    requireExactFields(artifact, ["type", "id", "inclusion_reasons", "fingerprint"], description);
    if (!Array.isArray(artifact.inclusion_reasons) || artifact.inclusion_reasons.length === 0) {
      throw new Error(`${description} inclusion_reasons must be a non-empty array`);
    }
    const inclusionReasons = artifact.inclusion_reasons.map((entry, reasonIndex) => {
      const reasonDescription = `${description} inclusion_reasons[${reasonIndex}]`;
      const reason = requireMapping(entry, reasonDescription);
      requireExactFields(reason, ["profile", "path"], reasonDescription);
      if (!Array.isArray(reason.path)) {
        throw new Error(`${reasonDescription} path must be an array`);
      }
      return {
        path: reason.path.map((reference, pathIndex) =>
          requireArtifactReference(reference, `${reasonDescription} path[${pathIndex}]`),
        ),
        profile: requireArtifactId(reason.profile, `${reasonDescription} profile`),
      };
    });
    return {
      ...(artifact.fingerprint === undefined
        ? {}
        : { fingerprint: requireHash(artifact.fingerprint, `${description} fingerprint`) }),
      inclusionReasons,
      reference: requireArtifactReference(
        { id: artifact.id, type: artifact.type },
        description,
      ),
    };
  });
  const keys = records.map((record) => artifactReferenceKey(record.reference));
  if (new Set(keys).size !== keys.length) {
    throw new Error("Installation Manifest resolved_artifacts must not contain an Artifact more than once");
  }
  return records;
}

function parseOwnedDirectoryMembers(
  value: unknown,
  description: string,
): readonly OwnedDirectoryMember[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} members must be an array`);
  }
  const members = value.map((entry, index) => {
    const memberDescription = `${description} members[${index}]`;
    const member = requireMapping(entry, memberDescription);
    if (member.type === "file") {
      requireExactFields(member, ["path", "type", "mode", "hash"], memberDescription);
      return {
        hash: requireHash(member.hash, `${memberDescription} hash`),
        mode: parseFileMode(member.mode, `${memberDescription} mode`),
        path: requireRelativeOutputPath(member.path, `${memberDescription} path`),
        type: "file" as const,
      };
    }
    if (member.type === "directory") {
      requireExactFields(member, ["path", "type", "mode"], memberDescription);
      return {
        mode: parseFileMode(member.mode, `${memberDescription} mode`),
        path: requireRelativeOutputPath(member.path, `${memberDescription} path`),
        type: "directory" as const,
      };
    }
    throw new Error(`${memberDescription} type must be 'file' or 'directory'`);
  });
  const paths = members.map((member) => member.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error(`${description} members must not contain a path more than once`);
  }
  return [...members].sort((left, right) => left.path.localeCompare(right.path));
}

function parseOwnedOutput(entry: unknown, description: string): OwnedOutput {
  const output = requireMapping(entry, description);
  if (output.type === "file") {
    requireExactFields(output, ["path", "type", "mode", "hash"], description);
    return {
      hash: requireHash(output.hash, `${description} hash`),
      mode: parseFileMode(output.mode, `${description} mode`),
      path: requireRelativeOutputPath(output.path, `${description} path`),
      type: "file" as const,
    };
  }
  if (output.type === "directory") {
    requireExactFields(output, ["path", "type", "mode", "hash", "members"], description);
    return {
      hash: requireHash(output.hash, `${description} hash`),
      members: parseOwnedDirectoryMembers(output.members, description),
      mode: parseFileMode(output.mode, `${description} mode`),
      path: requireRelativeOutputPath(output.path, `${description} path`),
      type: "directory" as const,
    };
  }
  throw new Error(`${description} type must be 'file' or 'directory'`);
}

function parseOutputs(value: unknown): readonly OwnedOutput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Installation Manifest outputs must be a non-empty array");
  }
  const outputs = value.map((entry, index) =>
    parseOwnedOutput(entry, `Installation Manifest outputs[${index}]`),
  );
  const paths = outputs.map((output) => output.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Installation Manifest outputs must not contain a path more than once");
  }
  if (!paths.includes(INSTALLATION_MARKER_PATH)) {
    throw new Error("Installation Manifest outputs must include the Installation Marker");
  }
  return outputs;
}

function parseHostVersions(value: unknown): Readonly<Record<string, string>> {
  const mapping = requireMapping(value, "Installation Manifest host_versions");
  const result: Record<string, string> = {};
  for (const [host, version] of Object.entries(mapping)) {
    result[host] = requireString(version, `Installation Manifest host_versions.${host}`);
  }
  return result;
}

function parseHosts(value: unknown): readonly string[] {
  const hosts = requireStringArray(value, "Installation Manifest hosts");
  if (hosts.length === 0 || hosts.some((host) => !isSupportedHost(host))) {
    throw new Error(
      `Installation Manifest hosts must contain only supported Hosts: ${SUPPORTED_HOSTS.join(", ")}`,
    );
  }
  return SUPPORTED_HOSTS.filter((host) => hosts.includes(host));
}

function parseOutputOrigins(
  value: unknown,
  outputs: readonly OwnedOutput[],
  resolvedArtifacts: readonly ResolvedArtifactRecord[],
): Readonly<Record<string, readonly ArtifactReference[]>> {
  const mapping = requireMapping(value, "Installation Manifest output_origins");
  const knownArtifacts = new Set(
    resolvedArtifacts.map((artifact) => artifactReferenceKey(artifact.reference)),
  );
  const outputPaths = new Set(outputs.map((output) => output.path));
  const result: Record<string, readonly ArtifactReference[]> = {};
  for (const [path, originsValue] of Object.entries(mapping)) {
    const description = `Installation Manifest output_origins.${path}`;
    if (!outputPaths.has(path)) {
      throw new Error(`${description} references unknown output path '${path}'`);
    }
    if (!Array.isArray(originsValue)) {
      throw new Error(`${description} must be an array of Artifact references`);
    }
    const origins = originsValue.map((entry, index) =>
      requireArtifactReference(entry, `${description}[${index}]`),
    );
    const keys = origins.map(artifactReferenceKey);
    if (new Set(keys).size !== keys.length) {
      throw new Error(`${description} must not contain an Artifact reference more than once`);
    }
    for (const origin of origins) {
      if (!knownArtifacts.has(artifactReferenceKey(origin))) {
        throw new Error(
          `${description} references artifact '${artifactReferenceKey(origin)}' that is not recorded in resolved_artifacts`,
        );
      }
    }
    result[path] = origins;
  }
  for (const path of outputPaths) {
    if (!(path in result)) {
      throw new Error(`Installation Manifest output_origins must cover output '${path}'`);
    }
  }
  return result;
}

function parseManifestMapping(value: unknown): ProjectInstallationManifest {
  const manifest = requireMapping(value, "Installation Manifest");
  const schemaVersion = manifest.schema_version;
  if (
    schemaVersion !== INSTALLATION_MANIFEST_SCHEMA_VERSION &&
    schemaVersion !== INSTALLATION_MANIFEST_LEGACY_SCHEMA_VERSION
  ) {
    throw new Error(
      `Installation Manifest schema_version must be ${INSTALLATION_MANIFEST_LEGACY_SCHEMA_VERSION} or ${INSTALLATION_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  const isCurrent = schemaVersion === INSTALLATION_MANIFEST_SCHEMA_VERSION;
  requireExactFields(
    manifest,
    isCurrent
      ? [
          "schema_version",
          "installation_id",
          "project",
          "profile_id",
          "selected_context",
          "resolved_artifacts",
          "hosts",
          "host_versions",
          "adapter_version",
          "engine_version",
          "git_project",
          "workspace_input_hash",
          "outputs",
          "output_origins",
        ]
      : [
          "schema_version",
          "installation_id",
          "project",
          "profile_id",
          "selected_context",
          "resolved_artifacts",
          "hosts",
          "host_versions",
          "adapter_version",
          "engine_version",
          "git_project",
          "workspace_input_hash",
          "outputs",
        ],
    "Installation Manifest",
  );
  const selectedContext = manifest.selected_context;
  if (!Array.isArray(selectedContext)) {
    throw new Error("Installation Manifest selected_context must be an array");
  }
  const contextIds = selectedContext.map((id, index) =>
    requireArtifactId(id, `Installation Manifest selected_context[${index}]`),
  );
  if (new Set(contextIds).size !== contextIds.length) {
    throw new Error("Installation Manifest selected_context must not contain an Artifact ID more than once");
  }
  const hosts = parseHosts(manifest.hosts);
  const hostVersions = parseHostVersions(manifest.host_versions);
  const hostVersionKeys = Object.keys(hostVersions).sort();
  if (hostVersionKeys.length !== hosts.length || hostVersionKeys.some((host, index) => host !== hosts.slice().sort()[index])) {
    throw new Error("Installation Manifest host_versions must match hosts exactly");
  }
  const resolvedArtifacts = parseResolvedArtifacts(manifest.resolved_artifacts);
  const outputs = parseOutputs(manifest.outputs);
  let outputOrigins: Readonly<Record<string, readonly ArtifactReference[]>> | undefined;
  if (isCurrent && "output_origins" in manifest) {
    outputOrigins = parseOutputOrigins(manifest.output_origins, outputs, resolvedArtifacts);
  }
  const anyFingerprint = resolvedArtifacts.some(
    (artifact) => artifact.fingerprint !== undefined,
  );
  if (outputOrigins !== undefined && resolvedArtifacts.some((artifact) => artifact.fingerprint === undefined)) {
    throw new Error(
      "Installation Manifest output_origins requires a fingerprint for every resolved artifact",
    );
  }
  if (outputOrigins === undefined && anyFingerprint) {
    throw new Error(
      "Installation Manifest resolved_artifacts fingerprints require output_origins",
    );
  }
  return {
    adapterVersion: requireString(manifest.adapter_version, "Installation Manifest adapter_version"),
    engineVersion: requireString(manifest.engine_version, "Installation Manifest engine_version"),
    ...(manifest.git_project === undefined
      ? {}
      : { gitProject: requireBoolean(manifest.git_project, "Installation Manifest git_project") }),
    hosts,
    hostVersions,
    installationId: requireString(manifest.installation_id, "Installation Manifest installation_id"),
    ...(outputOrigins === undefined ? {} : { outputOrigins }),
    outputs,
    profileId: requireArtifactId(manifest.profile_id, "Installation Manifest profile_id"),
    project: requireAbsoluteProject(manifest.project),
    resolvedArtifacts,
    schemaVersion: INSTALLATION_MANIFEST_SCHEMA_VERSION,
    selectedContext: contextIds,
    workspaceInputHash: requireHash(manifest.workspace_input_hash, "Installation Manifest workspace_input_hash"),
  };
}

function requireAbsoluteProject(value: unknown, description = "Installation Manifest project"): string {
  const project = requireString(value, description);
  if (!isAbsolute(project) || normalize(project) !== project) {
    throw new Error(`${description} must be a normalized absolute path`);
  }
  return project;
}

export function parseInstallationManifest(source: string): ProjectInstallationManifest {
  return parseManifestMapping(parseYaml(source, "Installation Manifest"));
}

function parseInstallations(value: unknown): readonly ProjectInstallationManifest[] {
  if (!Array.isArray(value)) {
    throw new Error("Installation State installations must be an array");
  }
  const installations = value.map(parseManifestMapping);
  const ids = installations.map((installation) => installation.installationId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Installation State must not contain an installation more than once");
  }
  const projects = installations.map((installation) => installation.project);
  if (new Set(projects).size !== projects.length) {
    throw new Error("Installation State must not contain a project more than once");
  }
  return installations;
}

function activeTemporaryInstallationIds(
  temporaryInstallations: readonly TemporaryProfileInstallation[],
): ReadonlySet<string> {
  return new Set(
    temporaryInstallations
      .filter((installation) => installation.completionState === "installed")
      .map((installation) => installation.temporaryInstallationId),
  );
}

function requireKnownRepositoryExclusionContributors(
  installations: readonly ProjectInstallationManifest[],
  repositoryExclusions: readonly RepositoryExclusionRecord[],
  temporaryInstallations: readonly TemporaryProfileInstallation[] = [],
): void {
  const installationIds = new Set([
    ...installations.map((installation) => installation.installationId),
    ...activeTemporaryInstallationIds(temporaryInstallations),
  ]);
  for (const record of repositoryExclusions) {
    for (const contribution of record.contributions) {
      if (!installationIds.has(contribution.installationId)) {
        throw new Error(
          `Installation State repository_exclusions target ${record.target} references unknown Installation ID ${contribution.installationId}`,
        );
      }
    }
  }
}

function parseTemporaryInstallations(
  value: unknown,
): readonly TemporaryProfileInstallation[] {
  if (!Array.isArray(value)) {
    throw new Error("Installation State temporary_installations must be an array");
  }
  const installations = value.map((entry, index) => {
    const description = `Installation State temporary_installations[${index}]`;
    const record = requireMapping(entry, description);
    const allowedFields = [
      "temporary_installation_id",
      "completion_state",
      "profile_id",
      "host",
      "project",
      "adapter_version",
      "engine_version",
      "host_version",
      "workspace_input_hash",
      "outputs",
      "git_project",
    ] as const;
    requireExactFields(record, allowedFields, description);
    for (const field of [
      "temporary_installation_id",
      "completion_state",
      "profile_id",
      "host",
      "project",
      "adapter_version",
      "engine_version",
      "host_version",
      "workspace_input_hash",
      "outputs",
    ] as const) {
      if (!(field in record)) {
        throw new Error(`${description} requires field '${field}'`);
      }
    }
    const completionState = requireString(
      record.completion_state,
      `${description} completion_state`,
    );
    if (completionState !== "installed" && completionState !== "removed") {
      throw new Error(`${description} completion_state must be 'installed' or 'removed'`);
    }
    const host = requireString(record.host, `${description} host`);
    if (!isSupportedHost(host)) {
      throw new Error(
        `${description} host must be one of: ${SUPPORTED_HOSTS.join(", ")}`,
      );
    }
    const outputs = Array.isArray(record.outputs)
      ? record.outputs.map((output, outputIndex) =>
        parseOwnedOutput(output, `${description} outputs[${outputIndex}]`),
      )
      : (() => {
        throw new Error(`${description} outputs must be an array`);
      })();
    if (completionState === "installed") {
      if (outputs.length === 0) {
        throw new Error(`${description} outputs must be non-empty while installed`);
      }
      const paths = outputs.map((output) => output.path);
      if (new Set(paths).size !== paths.length) {
        throw new Error(`${description} outputs must not contain a path more than once`);
      }
      if (!paths.includes(INSTALLATION_MARKER_PATH)) {
        throw new Error(`${description} outputs must include the Installation Marker while installed`);
      }
    } else if (outputs.length !== 0) {
      throw new Error(`${description} outputs must be empty once removed`);
    }
    return {
      adapterVersion: requireString(record.adapter_version, `${description} adapter_version`),
      completionState: completionState as TemporaryInstallationCompletionState,
      engineVersion: requireString(record.engine_version, `${description} engine_version`),
      ...(record.git_project === undefined
        ? {}
        : { gitProject: requireBoolean(record.git_project, `${description} git_project`) }),
      host,
      hostVersion: requireString(record.host_version, `${description} host_version`),
      outputs,
      profileId: requireArtifactId(record.profile_id, `${description} profile_id`),
      project: requireAbsoluteProject(record.project, `${description} project`),
      temporaryInstallationId: requireString(
        record.temporary_installation_id,
        `${description} temporary_installation_id`,
      ),
      workspaceInputHash: requireHash(
        record.workspace_input_hash,
        `${description} workspace_input_hash`,
      ),
    };
  });
  if (
    new Set(installations.map((installation) => installation.temporaryInstallationId)).size !==
      installations.length
  ) {
    throw new Error(
      "Installation State must not contain a temporary installation more than once",
    );
  }
  const activeProjects = installations
    .filter((installation) => installation.completionState === "installed")
    .map((installation) => installation.project);
  if (new Set(activeProjects).size !== activeProjects.length) {
    throw new Error(
      "Installation State must not contain more than one active temporary installation per project",
    );
  }
  return installations;
}

function temporaryInstallationValue(
  installation: TemporaryProfileInstallation,
): Record<string, unknown> {
  return {
    temporary_installation_id: installation.temporaryInstallationId,
    completion_state: installation.completionState,
    profile_id: installation.profileId,
    host: installation.host,
    project: installation.project,
    adapter_version: installation.adapterVersion,
    engine_version: installation.engineVersion,
    host_version: installation.hostVersion,
    workspace_input_hash: installation.workspaceInputHash,
    outputs: installation.outputs.map((output) =>
      output.type === "file"
        ? {
            path: output.path,
            type: output.type,
            mode: output.mode,
            hash: output.hash,
          }
        : {
            path: output.path,
            type: output.type,
            mode: output.mode,
            hash: output.hash,
            members: output.members.map((member) =>
              member.type === "file"
                ? {
                    path: member.path,
                    type: member.type,
                    mode: member.mode,
                    hash: member.hash,
                  }
                : {
                    path: member.path,
                    type: member.type,
                    mode: member.mode,
                  },
            ),
          },
    ),
    ...(installation.gitProject === undefined ? {} : { git_project: installation.gitProject }),
  };
}

function requireDistinctTemporaryAndOrdinaryIds(
  installations: readonly ProjectInstallationManifest[],
  temporaryInstallations: readonly TemporaryProfileInstallation[],
): void {
  const ordinaryIds = new Set(installations.map((installation) => installation.installationId));
  for (const temporary of temporaryInstallations) {
    if (ordinaryIds.has(temporary.temporaryInstallationId)) {
      throw new Error(
        "Installation State temporary installation IDs must not collide with ordinary Installation IDs",
      );
    }
  }
}

function requireDistinctInstalledAndTeardownState(
  installations: readonly ProjectInstallationManifest[],
  intendedTeardowns: readonly IntendedTeardown[],
): void {
  const installationIds = new Set(installations.map((installation) => installation.installationId));
  const installationProjects = new Set(installations.map((installation) => installation.project));
  for (const teardown of intendedTeardowns) {
    if (installationIds.has(teardown.installationId) || installationProjects.has(teardown.project)) {
      throw new Error(
        "Installation State cannot record one installation as both installed and intentionally uninstalled",
      );
    }
  }
}

export function formatInstallationManifest(
  manifest: ProjectInstallationManifest,
): string {
  return stringify(manifestValue(manifest));
}

function manifestValue(manifest: ProjectInstallationManifest): Record<string, unknown> {
  return {
    schema_version: manifest.schemaVersion,
    installation_id: manifest.installationId,
    project: manifest.project,
    profile_id: manifest.profileId,
    selected_context: manifest.selectedContext,
    resolved_artifacts: manifest.resolvedArtifacts.map((artifact) => ({
      type: artifact.reference.type,
      id: artifact.reference.id,
      ...(artifact.fingerprint === undefined
        ? {}
        : { fingerprint: artifact.fingerprint }),
      inclusion_reasons: artifact.inclusionReasons.map((reason) => ({
        profile: reason.profile,
        path: reason.path,
      })),
    })),
    hosts: manifest.hosts,
    host_versions: manifest.hostVersions,
    adapter_version: manifest.adapterVersion,
    engine_version: manifest.engineVersion,
    ...(manifest.gitProject === undefined ? {} : { git_project: manifest.gitProject }),
    workspace_input_hash: manifest.workspaceInputHash,
    outputs: manifest.outputs.map((output) =>
      output.type === "file"
        ? {
            path: output.path,
            type: output.type,
            mode: output.mode,
            hash: output.hash,
          }
        : {
            path: output.path,
            type: output.type,
            mode: output.mode,
            hash: output.hash,
            members: output.members.map((member) =>
              member.type === "file"
                ? {
                    path: member.path,
                    type: member.type,
                    mode: member.mode,
                    hash: member.hash,
                  }
                : {
                    path: member.path,
                    type: member.type,
                    mode: member.mode,
                  },
            ),
          },
    ),
    ...(manifest.outputOrigins === undefined
      ? {}
      : { output_origins: manifest.outputOrigins }),
  };
}

export function parseInstallationState(source: string): InstallationState {
  const value = parseInstallationStateYaml(source);
  const state = requireMapping(value, "Installation State");
  requireExactFields(
    state,
    [
      "schema_version",
      "intended_teardowns",
      "installations",
      "repository_exclusions",
      "temporary_installations",
    ],
    "Installation State",
  );
  if (state.schema_version !== INSTALLATION_STATE_SCHEMA_VERSION) {
    throw new Error(`Installation State schema_version must be ${INSTALLATION_STATE_SCHEMA_VERSION}`);
  }
  const installations = parseInstallations(state.installations);
  const intendedTeardowns = parseIntendedTeardowns(state.intended_teardowns);
  const temporaryInstallations = parseTemporaryInstallations(state.temporary_installations);
  const repositoryExclusions = parseRepositoryExclusionRecords(state.repository_exclusions);
  requireDistinctInstalledAndTeardownState(installations, intendedTeardowns);
  requireDistinctTemporaryAndOrdinaryIds(installations, temporaryInstallations);
  requireKnownRepositoryExclusionContributors(
    installations,
    repositoryExclusions,
    temporaryInstallations,
  );
  return {
    intendedTeardowns,
    installations,
    repositoryExclusions,
    schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
    temporaryInstallations,
  };
}

/** Parse schema v4 before temporary installations were retained. */
export function parseV4InstallationState(source: string): {
  readonly intendedTeardowns: readonly IntendedTeardown[];
  readonly installations: readonly ProjectInstallationManifest[];
  readonly repositoryExclusions: readonly RepositoryExclusionRecord[];
  readonly schemaVersion: 4;
} {
  const value = parseInstallationStateYaml(source);
  const state = requireMapping(value, "Installation State");
  requireExactFields(
    state,
    ["schema_version", "intended_teardowns", "installations", "repository_exclusions"],
    "Installation State",
  );
  if (state.schema_version !== INSTALLATION_STATE_V4_SCHEMA_VERSION) {
    throw new Error(
      `Installation State v4 schema_version must be ${INSTALLATION_STATE_V4_SCHEMA_VERSION}`,
    );
  }
  const installations = parseInstallations(state.installations);
  const intendedTeardowns = parseIntendedTeardowns(state.intended_teardowns);
  const repositoryExclusions = parseRepositoryExclusionRecords(state.repository_exclusions);
  requireDistinctInstalledAndTeardownState(installations, intendedTeardowns);
  requireKnownRepositoryExclusionContributors(installations, repositoryExclusions);
  return {
    intendedTeardowns,
    installations,
    repositoryExclusions,
    schemaVersion: 4,
  };
}

function parseIntendedTeardowns(value: unknown): readonly IntendedTeardown[] {
  if (!Array.isArray(value)) {
    throw new Error("Installation State intended_teardowns must be an array");
  }
  const teardowns = value.map((entry, index) => {
    const description = `Installation State intended_teardowns[${index}]`;
    const teardown = requireMapping(entry, description);
    requireExactFields(teardown, ["installation_id", "project", "profile_id", "hosts"], description);
    return {
      hosts: parseHosts(teardown.hosts),
      installationId: requireString(teardown.installation_id, `${description} installation_id`),
      profileId: requireArtifactId(teardown.profile_id, `${description} profile_id`),
      project: requireAbsoluteProject(teardown.project, `${description} project`),
    };
  });
  if (new Set(teardowns.map((teardown) => teardown.installationId)).size !== teardowns.length) {
    throw new Error("Installation State must not contain an intended teardown Installation ID more than once");
  }
  if (new Set(teardowns.map((teardown) => teardown.project)).size !== teardowns.length) {
    throw new Error("Installation State must not contain an intended teardown project more than once");
  }
  return teardowns;
}

/** Parse schema v3 before intended teardown provenance was retained. */
export function parsePreviousInstallationState(source: string): {
  readonly installations: readonly ProjectInstallationManifest[];
  readonly repositoryExclusions: readonly RepositoryExclusionRecord[];
  readonly schemaVersion: 3;
} {
  const value = parseInstallationStateYaml(source);
  const state = requireMapping(value, "Installation State");
  requireExactFields(
    state,
    ["schema_version", "installations", "repository_exclusions"],
    "Installation State",
  );
  if (state.schema_version !== INSTALLATION_STATE_PREVIOUS_SCHEMA_VERSION) {
    throw new Error(
      `Installation State previous schema_version must be ${INSTALLATION_STATE_PREVIOUS_SCHEMA_VERSION}`,
    );
  }
  const installations = parseInstallations(state.installations);
  const repositoryExclusions = parseRepositoryExclusionRecords(state.repository_exclusions);
  requireKnownRepositoryExclusionContributors(installations, repositoryExclusions);
  return { installations, repositoryExclusions, schemaVersion: 3 };
}

/** Parse the pre-Repository-Exclusion-Record state shape for the migration boundary only. */
export function parseLegacyInstallationState(source: string): {
  readonly installations: readonly ProjectInstallationManifest[];
  readonly schemaVersion: 2;
} {
  const value = parseInstallationStateYaml(source);
  const state = requireMapping(value, "Installation State");
  requireExactFields(state, ["schema_version", "installations"], "Installation State");
  if (state.schema_version !== INSTALLATION_STATE_LEGACY_SCHEMA_VERSION) {
    throw new Error(
      `Installation State legacy schema_version must be ${INSTALLATION_STATE_LEGACY_SCHEMA_VERSION}`,
    );
  }
  return {
    installations: parseInstallations(state.installations),
    schemaVersion: INSTALLATION_STATE_LEGACY_SCHEMA_VERSION,
  };
}

export function formatInstallationState(state: InstallationState): string {
  if (state.schemaVersion !== INSTALLATION_STATE_SCHEMA_VERSION) {
    throw new Error(`Installation State schema_version must be ${INSTALLATION_STATE_SCHEMA_VERSION}`);
  }
  const temporaryInstallations = parseTemporaryInstallations(
    state.temporaryInstallations.map(temporaryInstallationValue),
  );
  const repositoryExclusions = parseRepositoryExclusionRecords(
    state.repositoryExclusions.map((record) => ({
      target: record.target,
      contributions: record.contributions.map((contribution) => ({
        installation_id: contribution.installationId,
        entries: contribution.entries,
      })),
      entries: record.entries,
    })),
  );
  const intendedTeardowns = parseIntendedTeardowns(
    state.intendedTeardowns.map((teardown) => ({
      hosts: teardown.hosts,
      installation_id: teardown.installationId,
      profile_id: teardown.profileId,
      project: teardown.project,
    })),
  );
  requireDistinctInstalledAndTeardownState(state.installations, intendedTeardowns);
  requireDistinctTemporaryAndOrdinaryIds(state.installations, temporaryInstallations);
  requireKnownRepositoryExclusionContributors(
    state.installations,
    repositoryExclusions,
    temporaryInstallations,
  );
  return stringify({
    schema_version: state.schemaVersion,
    intended_teardowns: [...intendedTeardowns]
      .sort((left, right) => compareCanonicalStrings(left.project, right.project))
      .map((teardown) => ({
        hosts: teardown.hosts,
        installation_id: teardown.installationId,
        profile_id: teardown.profileId,
        project: teardown.project,
      })),
    installations: state.installations.map(manifestValue),
    temporary_installations: [...temporaryInstallations]
      .sort((left, right) =>
        compareCanonicalStrings(left.temporaryInstallationId, right.temporaryInstallationId),
      )
      .map(temporaryInstallationValue),
    repository_exclusions: [...repositoryExclusions]
      .sort((left, right) => compareCanonicalStrings(left.target, right.target))
      .map((record) => ({
        target: record.target,
        contributions: [...record.contributions]
          .sort((left, right) => compareCanonicalStrings(left.installationId, right.installationId))
          .map((contribution) => ({
            installation_id: contribution.installationId,
            entries: sortedEntries(contribution.entries),
          })),
        entries: sortedEntries(record.entries),
      })),
  }, { aliasDuplicateObjects: false });
}

export function parseInstallationMarker(source: string): InstallationMarker {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("Installation Marker is invalid JSON");
  }
  const marker = requireMapping(value, "Installation Marker");
  requireExactFields(marker, ["schema_version", "installation_id"], "Installation Marker");
  if (marker.schema_version !== INSTALLATION_MARKER_SCHEMA_VERSION) {
    throw new Error(`Installation Marker schema_version must be ${INSTALLATION_MARKER_SCHEMA_VERSION}`);
  }
  return {
    installationId: requireString(marker.installation_id, "Installation Marker installation_id"),
    schemaVersion: 1,
  };
}

export function formatInstallationMarker(marker: InstallationMarker): string {
  return `${JSON.stringify(
    {
      schema_version: marker.schemaVersion,
      installation_id: marker.installationId,
    },
    null,
    2,
  )}\n`;
}
