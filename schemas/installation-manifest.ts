import { parse, stringify } from "yaml";

import {
  ARTIFACT_TYPES,
  requireArtifactId,
  type ArtifactReference,
  type ArtifactType,
} from "./dependencies.js";

export interface ResolvedArtifactManifest {
  readonly inclusionReasons: readonly {
    readonly path: readonly ArtifactReference[];
    readonly profile: string;
  }[];
  readonly reference: ArtifactReference;
}

export interface InstallationManifest {
  readonly adapterVersion: string;
  readonly engineVersion: string;
  readonly git?: { readonly commit: string; readonly dirty: boolean };
  readonly hostId: "codex";
  readonly hostVersion: string;
  readonly outputHash: string;
  readonly outputs: readonly string[];
  readonly profileId: string;
  readonly selectedArtifacts: {
    readonly context: readonly string[];
    readonly skills: readonly string[];
  };
  readonly resolvedArtifacts?: readonly ResolvedArtifactManifest[];
  readonly schemaVersion: 1 | 2;
  readonly workspaceInputHash: string;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Installation Manifest ${description} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, description: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Installation Manifest ${description} must be an array of strings`);
  }
  return value;
}

function requireArtifactIdArray(value: unknown, description: string): readonly string[] {
  const ids = requireStringArray(value, description);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Installation Manifest ${description} must not contain an Artifact ID more than once`);
  }
  return ids.map((id) => requireArtifactId(id, `Installation Manifest ${description}`));
}

function requireHash(value: unknown, description: string): string {
  const hash = requireString(value, description);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Installation Manifest ${description} must be a SHA-256 hash`);
  }
  return hash;
}

function requireArtifactType(value: unknown, description: string): ArtifactType {
  if (typeof value !== "string" || !ARTIFACT_TYPES.includes(value as ArtifactType)) {
    throw new Error(`Installation Manifest ${description} type must be one of: ${ARTIFACT_TYPES.join(", ")}`);
  }
  return value as ArtifactType;
}

function requireArtifactReference(value: unknown, description: string): ArtifactReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Installation Manifest ${description} must be a typed Artifact reference`);
  }
  const reference = value as Record<string, unknown>;
  const unknown = Object.keys(reference).filter((field) => field !== "type" && field !== "id");
  if (unknown.length > 0 || !("type" in reference) || !("id" in reference)) {
    throw new Error(`Installation Manifest ${description} must contain only type and id`);
  }
  return {
    id: requireArtifactId(reference.id, `Installation Manifest ${description} id`),
    type: requireArtifactType(reference.type, `Installation Manifest ${description}`),
  };
}

function requireResolvedArtifacts(value: unknown): readonly ResolvedArtifactManifest[] {
  if (!Array.isArray(value)) {
    throw new Error("Installation Manifest resolved_artifacts must be an array");
  }
  const artifacts = value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Installation Manifest resolved_artifacts[${index}] must be a YAML mapping`);
    }
    const artifact = entry as Record<string, unknown>;
    const unknown = Object.keys(artifact).filter(
      (field) => field !== "type" && field !== "id" && field !== "inclusion_reasons",
    );
    if (unknown.length > 0 || !("type" in artifact) || !("id" in artifact) || !("inclusion_reasons" in artifact)) {
      throw new Error(`Installation Manifest resolved_artifacts[${index}] must contain type, id, and inclusion_reasons`);
    }
    if (!Array.isArray(artifact.inclusion_reasons) || artifact.inclusion_reasons.length === 0) {
      throw new Error(`Installation Manifest resolved_artifacts[${index}] inclusion_reasons must be a non-empty array`);
    }
    const inclusionReasons = artifact.inclusion_reasons.map((reason, reasonIndex) => {
      if (typeof reason !== "object" || reason === null || Array.isArray(reason)) {
        throw new Error(`Installation Manifest resolved_artifacts[${index}] inclusion_reasons[${reasonIndex}] must be a YAML mapping`);
      }
      const mapping = reason as Record<string, unknown>;
      const fields = Object.keys(mapping);
      if (fields.length !== 2 || !fields.includes("profile") || !fields.includes("path")) {
        throw new Error(`Installation Manifest resolved_artifacts[${index}] inclusion_reasons[${reasonIndex}] must contain profile and path`);
      }
      if (!Array.isArray(mapping.path)) {
        throw new Error(`Installation Manifest resolved_artifacts[${index}] inclusion_reasons[${reasonIndex}] path must be an array`);
      }
      return {
        path: mapping.path.map((reference, pathIndex) =>
          requireArtifactReference(
            reference,
            `resolved_artifacts[${index}] inclusion_reasons[${reasonIndex}] path[${pathIndex}]`,
          ),
        ),
        profile: requireArtifactId(mapping.profile, `Installation Manifest resolved_artifacts[${index}] inclusion_reasons[${reasonIndex}] profile`),
      };
    });
    return {
      inclusionReasons,
      reference: requireArtifactReference(
        { id: artifact.id, type: artifact.type },
        `resolved_artifacts[${index}]`,
      ),
    };
  });
  const identifiers = artifacts.map(({ reference }) => `${reference.type}:${reference.id}`);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("Installation Manifest resolved_artifacts must not contain an Artifact more than once");
  }
  return artifacts;
}

function requireSelectedArtifacts(value: unknown): InstallationManifest["selectedArtifacts"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Installation Manifest selected_artifacts must be a YAML mapping");
  }
  const selectedArtifacts = value as Record<string, unknown>;
  const unknown = Object.keys(selectedArtifacts).filter(
    (field) => field !== "context" && field !== "skills",
  );
  if (unknown.length > 0 || !("context" in selectedArtifacts)) {
    throw new Error("Installation Manifest selected_artifacts must contain context and optional skills");
  }
  return {
    context: requireStringArray(selectedArtifacts.context, "selected_artifacts.context"),
    skills:
      "skills" in selectedArtifacts
        ? requireArtifactIdArray(selectedArtifacts.skills, "selected_artifacts.skills")
        : [],
  };
}

function requireGitProvenance(
  value: unknown,
): { readonly commit: string; readonly dirty: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Installation Manifest git must be a YAML mapping");
  }
  const git = value as Record<string, unknown>;
  const unknown = Object.keys(git).filter((field) => !["commit", "dirty"].includes(field));
  if (unknown.length > 0 || !("commit" in git) || !("dirty" in git)) {
    throw new Error("Installation Manifest git must contain only commit and dirty");
  }
  if (typeof git.dirty !== "boolean") {
    throw new Error("Installation Manifest git.dirty must be a boolean");
  }
  return { commit: requireString(git.commit, "git.commit"), dirty: git.dirty };
}

export function parseInstallationManifest(source: string): InstallationManifest {
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw new Error("Installation Manifest is invalid YAML");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Installation Manifest must be a YAML mapping");
  }
  const manifest = value as Record<string, unknown>;
  const fields = [
    "schema_version",
    "profile_id",
    "host_id",
    "host_version",
    "adapter_version",
    "engine_version",
    "selected_artifacts",
    "resolved_artifacts",
    "outputs",
    "workspace_input_hash",
    "output_hash",
    "git",
  ];
  const unknown = Object.keys(manifest).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    throw new Error(`Installation Manifest does not allow fields: ${unknown.join(", ")}`);
  }
  if (manifest.schema_version !== 1 && manifest.schema_version !== 2) {
    throw new Error("Installation Manifest schema_version must be 1 or 2");
  }
  if (manifest.host_id !== "codex") {
    throw new Error("Installation Manifest host_id must be codex");
  }
  const outputs = requireStringArray(manifest.outputs, "outputs");
  if (outputs.length === 0 || outputs.some((output) => output.startsWith("/") || output.split("/").includes(".."))) {
    throw new Error("Installation Manifest outputs must contain safe relative paths");
  }
  if (manifest.schema_version === 1 && "resolved_artifacts" in manifest) {
    throw new Error("Installation Manifest schema_version 1 does not allow resolved_artifacts");
  }
  if (manifest.schema_version === 2 && !("resolved_artifacts" in manifest)) {
    throw new Error("Installation Manifest schema_version 2 must contain resolved_artifacts");
  }
  const git = "git" in manifest ? requireGitProvenance(manifest.git) : undefined;
  const resolvedArtifacts = "resolved_artifacts" in manifest
    ? requireResolvedArtifacts(manifest.resolved_artifacts)
    : undefined;
  return {
    adapterVersion: requireString(manifest.adapter_version, "adapter_version"),
    engineVersion: requireString(manifest.engine_version, "engine_version"),
    hostId: "codex",
    hostVersion: requireString(manifest.host_version, "host_version"),
    outputHash: requireHash(manifest.output_hash, "output_hash"),
    outputs,
    profileId: requireString(manifest.profile_id, "profile_id"),
    selectedArtifacts: requireSelectedArtifacts(manifest.selected_artifacts),
    schemaVersion: manifest.schema_version,
    workspaceInputHash: requireHash(
      manifest.workspace_input_hash,
      "workspace_input_hash",
    ),
    ...(git ? { git } : {}),
    ...(resolvedArtifacts ? { resolvedArtifacts } : {}),
  };
}

export function formatInstallationManifest(manifest: InstallationManifest): string {
  const value = {
    schema_version: manifest.schemaVersion,
    profile_id: manifest.profileId,
    host_id: manifest.hostId,
    host_version: manifest.hostVersion,
    adapter_version: manifest.adapterVersion,
    engine_version: manifest.engineVersion,
    selected_artifacts: {
      context: manifest.selectedArtifacts.context,
      skills: manifest.selectedArtifacts.skills,
    },
    ...(manifest.resolvedArtifacts
      ? {
          resolved_artifacts: manifest.resolvedArtifacts.map((artifact) => ({
            type: artifact.reference.type,
            id: artifact.reference.id,
            inclusion_reasons: artifact.inclusionReasons.map((reason) => ({
                profile: reason.profile,
                path: reason.path.map((reference) => ({ type: reference.type, id: reference.id })),
              })),
          })),
        }
      : {}),
    outputs: manifest.outputs,
    workspace_input_hash: manifest.workspaceInputHash,
    output_hash: manifest.outputHash,
    ...(manifest.git ? { git: manifest.git } : {}),
  };
  return stringify(value);
}
