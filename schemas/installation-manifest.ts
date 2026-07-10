import { parse, stringify } from "yaml";

import { requireArtifactId } from "./context-profile.js";

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
  readonly schemaVersion: 1;
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
    "outputs",
    "workspace_input_hash",
    "output_hash",
    "git",
  ];
  const unknown = Object.keys(manifest).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    throw new Error(`Installation Manifest does not allow fields: ${unknown.join(", ")}`);
  }
  if (manifest.schema_version !== 1) {
    throw new Error("Installation Manifest schema_version must be 1");
  }
  if (manifest.host_id !== "codex") {
    throw new Error("Installation Manifest host_id must be codex");
  }
  const outputs = requireStringArray(manifest.outputs, "outputs");
  if (outputs.length === 0 || outputs.some((output) => output.startsWith("/") || output.split("/").includes(".."))) {
    throw new Error("Installation Manifest outputs must contain safe relative paths");
  }
  const git = "git" in manifest ? requireGitProvenance(manifest.git) : undefined;
  return {
    adapterVersion: requireString(manifest.adapter_version, "adapter_version"),
    engineVersion: requireString(manifest.engine_version, "engine_version"),
    hostId: "codex",
    hostVersion: requireString(manifest.host_version, "host_version"),
    outputHash: requireHash(manifest.output_hash, "output_hash"),
    outputs,
    profileId: requireString(manifest.profile_id, "profile_id"),
    selectedArtifacts: requireSelectedArtifacts(manifest.selected_artifacts),
    schemaVersion: 1,
    workspaceInputHash: requireHash(
      manifest.workspace_input_hash,
      "workspace_input_hash",
    ),
    ...(git ? { git } : {}),
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
    outputs: manifest.outputs,
    workspace_input_hash: manifest.workspaceInputHash,
    output_hash: manifest.outputHash,
    ...(manifest.git ? { git: manifest.git } : {}),
  };
  return stringify(value);
}
