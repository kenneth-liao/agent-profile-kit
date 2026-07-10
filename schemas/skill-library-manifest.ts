import { parse, stringify } from "yaml";

import { requireArtifactId } from "./context-profile.js";

export interface SkillLibraryManifest {
  readonly outputHash: string;
  readonly owner: "agent-profile-kit";
  readonly schemaVersion: 1;
  readonly skills: readonly string[];
  readonly workspaceInputHash: string;
}

function requireHash(value: unknown, description: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Codex Skill Library Manifest ${description} must be a SHA-256 hash`);
  }
  return value;
}

export function parseSkillLibraryManifest(source: string): SkillLibraryManifest {
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    throw new Error("Codex Skill Library Manifest is invalid YAML");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex Skill Library Manifest must be a YAML mapping");
  }
  const manifest = value as Record<string, unknown>;
  const fields = ["schema_version", "owner", "skills", "workspace_input_hash", "output_hash"];
  const unknown = Object.keys(manifest).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    throw new Error(`Codex Skill Library Manifest does not allow fields: ${unknown.join(", ")}`);
  }
  if (manifest.schema_version !== 1 || manifest.owner !== "agent-profile-kit") {
    throw new Error("Codex Skill Library Manifest does not prove Agent Profile Kit ownership");
  }
  if (!Array.isArray(manifest.skills) || manifest.skills.some((id) => typeof id !== "string")) {
    throw new Error("Codex Skill Library Manifest skills must be an array of Artifact IDs");
  }
  const skills = manifest.skills.map((id) =>
    requireArtifactId(id as string, "Codex Skill Library Manifest skills"),
  );
  if (new Set(skills).size !== skills.length) {
    throw new Error("Codex Skill Library Manifest skills must not contain duplicates");
  }
  return {
    outputHash: requireHash(manifest.output_hash, "output_hash"),
    owner: "agent-profile-kit",
    schemaVersion: 1,
    skills,
    workspaceInputHash: requireHash(manifest.workspace_input_hash, "workspace_input_hash"),
  };
}

export function formatSkillLibraryManifest(manifest: SkillLibraryManifest): string {
  return stringify({
    schema_version: manifest.schemaVersion,
    owner: manifest.owner,
    skills: manifest.skills,
    workspace_input_hash: manifest.workspaceInputHash,
    output_hash: manifest.outputHash,
  });
}
