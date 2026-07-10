import { parse } from "yaml";

export interface InstallationManifest {
  readonly context: readonly string[];
  readonly hostId: "codex";
  readonly outputs: readonly ["context.md"];
  readonly profileId: string;
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
  const fields = ["schema_version", "profile_id", "host_id", "context", "outputs"];
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
  if (outputs.length !== 1 || outputs[0] !== "context.md") {
    throw new Error("Installation Manifest outputs must contain only context.md");
  }
  return {
    context: requireStringArray(manifest.context, "context"),
    hostId: "codex",
    outputs: ["context.md"],
    profileId: requireString(manifest.profile_id, "profile_id"),
  };
}
