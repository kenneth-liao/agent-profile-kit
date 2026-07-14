import { parse, stringify } from "yaml";
import { isAbsolute, normalize, win32 } from "node:path";

import {
  ARTIFACT_TYPES,
  requireArtifactId,
  type ArtifactReference,
  type ArtifactType,
} from "./dependencies.js";

export const INSTALLATION_MANIFEST_SCHEMA_VERSION = 2;
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
  readonly inclusionReasons: readonly {
    readonly path: readonly ArtifactReference[];
    readonly profile: string;
  }[];
  readonly reference: ArtifactReference;
}

export interface ProjectInstallationManifest {
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly hosts: readonly string[];
  readonly hostVersions: Readonly<Record<string, string>>;
  readonly installationId: string;
  readonly outputs: readonly OwnedOutput[];
  readonly profileId: string;
  readonly project: string;
  readonly resolvedArtifacts: readonly ResolvedArtifactRecord[];
  readonly schemaVersion: 2;
  readonly selectedContext: readonly string[];
  readonly workspaceInputHash: string;
}

export interface InstallationMarker {
  readonly installationId: string;
  readonly schemaVersion: 1;
}

export interface InstallationState {
  readonly installations: readonly ProjectInstallationManifest[];
  readonly schemaVersion: 2;
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

function parseYaml(source: string, description: string): unknown {
  try {
    return parse(source);
  } catch {
    throw new Error(`${description} is invalid YAML`);
  }
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
    requireExactFields(artifact, ["type", "id", "inclusion_reasons"], description);
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
      inclusionReasons,
      reference: requireArtifactReference(
        { id: artifact.id, type: artifact.type },
        description,
      ),
    };
  });
  const keys = records.map((record) => `${record.reference.type}:${record.reference.id}`);
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
  if (hosts.length === 0 || hosts.some((host) => host !== "codex")) {
    throw new Error("Installation Manifest hosts must contain only supported Host 'codex'");
  }
  return hosts;
}

function parseManifestMapping(value: unknown): ProjectInstallationManifest {
  const manifest = requireMapping(value, "Installation Manifest");
  requireExactFields(
    manifest,
    [
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
      "workspace_input_hash",
      "outputs",
    ],
    "Installation Manifest",
  );
  if (manifest.schema_version !== INSTALLATION_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Installation Manifest schema_version must be ${INSTALLATION_MANIFEST_SCHEMA_VERSION}`,
    );
  }
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
  return {
    adapterVersion: requireString(manifest.adapter_version, "Installation Manifest adapter_version"),
    engineVersion: requireString(manifest.engine_version, "Installation Manifest engine_version"),
    hosts,
    hostVersions,
    installationId: requireString(manifest.installation_id, "Installation Manifest installation_id"),
    outputs: parseOutputs(manifest.outputs),
    profileId: requireArtifactId(manifest.profile_id, "Installation Manifest profile_id"),
    project: requireAbsoluteProject(manifest.project),
    resolvedArtifacts: parseResolvedArtifacts(manifest.resolved_artifacts),
    schemaVersion: 2,
    selectedContext: contextIds,
    workspaceInputHash: requireHash(manifest.workspace_input_hash, "Installation Manifest workspace_input_hash"),
  };
}

function requireAbsoluteProject(value: unknown): string {
  const project = requireString(value, "Installation Manifest project");
  if (!isAbsolute(project) || normalize(project) !== project) {
    throw new Error("Installation Manifest project must be a normalized absolute path");
  }
  return project;
}

export function parseInstallationManifest(source: string): ProjectInstallationManifest {
  return parseManifestMapping(parseYaml(source, "Installation Manifest"));
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
      inclusion_reasons: artifact.inclusionReasons.map((reason) => ({
        profile: reason.profile,
        path: reason.path,
      })),
    })),
    hosts: manifest.hosts,
    host_versions: manifest.hostVersions,
    adapter_version: manifest.adapterVersion,
    engine_version: manifest.engineVersion,
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
  };
}

export function parseInstallationState(source: string): InstallationState {
  const value = parseYaml(source, "Installation State");
  const state = requireMapping(value, "Installation State");
  requireExactFields(state, ["schema_version", "installations"], "Installation State");
  if (state.schema_version !== INSTALLATION_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Installation State schema_version must be ${INSTALLATION_MANIFEST_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(state.installations)) {
    throw new Error("Installation State installations must be an array");
  }
  const installations = state.installations.map(parseManifestMapping);
  const ids = installations.map((installation) => installation.installationId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Installation State must not contain an installation more than once");
  }
  const projects = installations.map((installation) => installation.project);
  if (new Set(projects).size !== projects.length) {
    throw new Error("Installation State must not contain a project more than once");
  }
  return { installations, schemaVersion: 2 };
}

export function formatInstallationState(state: InstallationState): string {
  return stringify({
    schema_version: state.schemaVersion,
    installations: state.installations.map(manifestValue),
  });
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
