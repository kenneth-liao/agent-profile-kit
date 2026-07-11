import { parse } from "yaml";

import {
  parseArtifactDependencies,
  requireArtifactId,
  type ArtifactReference,
} from "./dependencies.js";

export type AgentFilesystemRequirement = "read-only" | "workspace-write";
export type AgentNetworkRequirement = "disabled" | "enabled";
export type AgentApprovalRequirement = "untrusted" | "on-request" | "never";

export interface ExecutionRequirements {
  readonly approval: AgentApprovalRequirement;
  readonly filesystem: AgentFilesystemRequirement;
  readonly network: AgentNetworkRequirement;
}

export interface Agent {
  readonly dependencies: readonly ArtifactReference[];
  readonly description: string;
  readonly id: string;
  readonly requirements: ExecutionRequirements;
  readonly role: string;
}

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, description: string, maximum?: number): string {
  if (typeof value !== "string" || value.length === 0 || (maximum !== undefined && value.length > maximum)) {
    throw new Error(`${description} must be a non-empty string${maximum === undefined ? "" : ` no longer than ${maximum} characters`}`);
  }
  return value;
}

function requireOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
  description: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${description} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function parseRequirements(value: unknown, path: string): ExecutionRequirements {
  const requirements = requireMapping(value, `Agent ${path} execution_requirements`);
  const fields = ["filesystem", "network", "approval"];
  const unknown = Object.keys(requirements).filter((field) => !fields.includes(field));
  if (unknown.length > 0 || fields.some((field) => !(field in requirements))) {
    throw new Error(`Agent ${path} execution_requirements must contain only filesystem, network, and approval`);
  }
  const filesystem = requireOneOf(requirements.filesystem, ["read-only", "workspace-write"], `Agent ${path} execution_requirements.filesystem`);
  const network = requireOneOf(requirements.network, ["disabled", "enabled"], `Agent ${path} execution_requirements.network`);
  if (filesystem === "read-only" && network === "enabled") {
    throw new Error(`Agent ${path} cannot require enabled network with a read-only filesystem`);
  }
  return {
    approval: requireOneOf(requirements.approval, ["untrusted", "on-request", "never"], `Agent ${path} execution_requirements.approval`),
    filesystem,
    network,
  };
}

export function parseAgent(source: string, path: string): Agent {
  const delimiter = "---\n";
  if (!source.startsWith(delimiter)) {
    throw new Error(`Agent ${path} must start with YAML frontmatter`);
  }
  const closing = source.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw new Error(`Agent ${path} must close its YAML frontmatter`);
  }
  let header: unknown;
  try {
    header = parse(source.slice(delimiter.length, closing));
  } catch {
    throw new Error(`Agent ${path} frontmatter is invalid YAML`);
  }
  const mapping = requireMapping(header, `Agent ${path} frontmatter`);
  const fields = ["id", "description", "dependencies", "execution_requirements"];
  const unknown = Object.keys(mapping).filter((field) => !fields.includes(field));
  if (unknown.length > 0 || !["id", "description", "execution_requirements"].every((field) => field in mapping)) {
    throw new Error(`Agent ${path} frontmatter must contain id, description, and execution_requirements`);
  }
  const role = source.slice(closing + delimiter.length);
  if (role.length === 0) throw new Error(`Agent ${path} must contain its role instructions`);
  return {
    dependencies: parseArtifactDependencies(mapping.dependencies, `Agent ${path} dependencies`),
    description: requireString(mapping.description, `Agent ${path} description`, 1024),
    id: requireArtifactId(mapping.id, `Agent ${path} id`),
    requirements: parseRequirements(mapping.execution_requirements, path),
    role,
  };
}
