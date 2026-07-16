import { parse } from "yaml";

import {
  parseArtifactDependencies,
  requireArtifactId,
  type ArtifactReference,
} from "./dependencies.js";

/** Host-neutral model-invocation policy for a Skill. */
export type ModelInvocationPolicy = "allowed" | "disabled";

/** Namespaced standard metadata key for model-invocation policy. */
export const MODEL_INVOCATION_METADATA_KEY = "agent-profile-kit.model-invocation";

export interface Skill {
  readonly dependencies: readonly ArtifactReference[];
  readonly id: string;
  /** Normalized model-invocation policy; absence of metadata defaults to allowed. */
  readonly modelInvocation: ModelInvocationPolicy;
  readonly path: string;
  readonly sidecar?: Record<string, unknown>;
}

const STANDARD_FIELDS = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
] as const;

function parseModelInvocation(
  metadata: Record<string, unknown> | undefined,
  path: string,
): ModelInvocationPolicy {
  if (metadata === undefined || !(MODEL_INVOCATION_METADATA_KEY in metadata)) {
    return "allowed";
  }
  const value = metadata[MODEL_INVOCATION_METADATA_KEY];
  if (value !== "allowed" && value !== "disabled") {
    throw new Error(
      `Skill ${path} metadata.${MODEL_INVOCATION_METADATA_KEY} must be the string 'allowed' or 'disabled'`,
    );
  }
  return value;
}

function parseYaml(source: string, description: string): unknown {
  try {
    return parse(source);
  } catch {
    throw new Error(`${description} is invalid YAML`);
  }
}

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function frontmatter(source: string, path: string): Record<string, unknown> {
  const delimiter = "---\n";
  if (!source.startsWith(delimiter)) {
    throw new Error(`Skill ${path} must start with YAML frontmatter`);
  }
  const closing = source.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw new Error(`Skill ${path} must close its YAML frontmatter`);
  }
  return requireMapping(
    parseYaml(source.slice(delimiter.length, closing), `Skill ${path} frontmatter`),
    `Skill ${path} frontmatter`,
  );
}

function requireString(value: unknown, description: string, maximum?: number): string {
  if (typeof value !== "string" || value.length === 0 || (maximum !== undefined && value.length > maximum)) {
    throw new Error(`${description} must be a non-empty string${maximum === undefined ? "" : ` no longer than ${maximum} characters`}`);
  }
  return value;
}

export function parseSkill(
  source: string,
  path: string,
  sourcePath: string,
  sidecar?: string,
): Skill {
  const header = frontmatter(source, path);
  const unknown = Object.keys(header).filter(
    (field) => !STANDARD_FIELDS.includes(field as (typeof STANDARD_FIELDS)[number]),
  );
  if (unknown.length > 0) {
    throw new Error(`Skill ${path} frontmatter does not allow fields: ${unknown.join(", ")}`);
  }
  const id = requireString(header.name, `Skill ${path} name`, 64);
  requireArtifactId(id, `Skill ${path} name`);
  requireString(header.description, `Skill ${path} description`, 1024);
  if ("license" in header) requireString(header.license, `Skill ${path} license`);
  if ("compatibility" in header) requireString(header.compatibility, `Skill ${path} compatibility`, 500);
  const metadata = "metadata" in header
    ? requireMapping(header.metadata, `Skill ${path} metadata`)
    : undefined;
  if ("allowed-tools" in header) requireString(header["allowed-tools"], `Skill ${path} allowed-tools`);
  const modelInvocation = parseModelInvocation(metadata, path);

  const parsedSidecar = sidecar === undefined
    ? undefined
    : requireMapping(parseYaml(sidecar, `Skill ${path} sidecar`), `Skill ${path} sidecar`);
  return {
    dependencies: parseArtifactDependencies(parsedSidecar?.dependencies, `Skill ${path} dependencies`),
    id,
    modelInvocation,
    path: sourcePath,
    ...(parsedSidecar !== undefined
      ? { sidecar: parsedSidecar }
      : {}),
  };
}
