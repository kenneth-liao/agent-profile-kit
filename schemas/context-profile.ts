import { parse } from "yaml";

export interface ContextModule {
  readonly id: string;
  readonly content: string;
}

export interface Profile {
  readonly id: string;
  readonly context: readonly string[];
  readonly skills: readonly string[];
  readonly agents: readonly string[];
  readonly hooks: readonly string[];
  readonly tools: readonly string[];
}

const ARTIFACT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function requireArtifactId(value: unknown, description: string): string {
  if (typeof value !== "string" || !ARTIFACT_ID.test(value)) {
    throw new Error(
      `${description} must be a lowercase kebab-case Artifact ID without wildcards`,
    );
  }
  return value;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  description: string,
): void {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
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

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function requireStringArray(
  value: unknown,
  description: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} must be an array of Artifact IDs`);
  }
  const ids = value.map((entry) => requireArtifactId(entry, description));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${description} must not select an Artifact ID more than once`);
  }
  return ids;
}

export function parseContextModule(source: string, path: string): ContextModule {
  const delimiter = "---\n";
  if (!source.startsWith(delimiter)) {
    throw new Error(`Context Module ${path} must start with YAML frontmatter`);
  }
  const closing = source.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw new Error(`Context Module ${path} must close its YAML frontmatter`);
  }

  const header = parseYaml(source.slice(delimiter.length, closing), `Context Module ${path}`);
  const mapping = requireMapping(
    header,
    `Context Module ${path} frontmatter`,
  );
  requireExactFields(mapping, ["id"], `Context Module ${path}`);
  const id = requireArtifactId(mapping.id, `Context Module ${path} id`);
  const content = source.slice(closing + delimiter.length);
  if (content.length === 0) {
    throw new Error(`Context Module ${path} must contain Context`);
  }
  return { id, content };
}

export function parseProfile(source: string, path: string): Profile {
  const value = parseYaml(source, `Profile ${path}`);
  const mapping = requireMapping(value, `Profile ${path}`);
  const fields = ["id", "context", "skills", "agents", "hooks", "tools"] as const;
  requireExactFields(mapping, fields, `Profile ${path}`);
  for (const field of fields) {
    if (!(field in mapping)) {
      throw new Error(`Profile ${path} must contain ${field}`);
    }
  }
  return {
    id: requireArtifactId(mapping.id, `Profile ${path} id`),
    context: requireStringArray(mapping.context, `Profile ${path} context`),
    skills: requireStringArray(mapping.skills, `Profile ${path} skills`),
    agents: requireStringArray(mapping.agents, `Profile ${path} agents`),
    hooks: requireStringArray(mapping.hooks, `Profile ${path} hooks`),
    tools: requireStringArray(mapping.tools, `Profile ${path} tools`),
  };
}
