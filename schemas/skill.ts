import { parse } from "yaml";

import {
  parseArtifactDependencies,
  ARTIFACT_ID,
  type ArtifactReference,
} from "./dependencies.js";
import { rejectSchema, type WorkspaceArtifactRejectionReason } from "./schema-rejections.js";

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
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: {
        case: "invalid-model-invocation",
        path,
        key: MODEL_INVOCATION_METADATA_KEY,
      },
    });
  }
  return value;
}

function parseYaml(source: string, detail: WorkspaceArtifactRejectionReason): unknown {
  try {
    return parse(source);
  } catch {
    throw rejectSchema({ schema: "workspace-artifact", detail });
  }
}

function requireMapping(value: unknown, detail: WorkspaceArtifactRejectionReason): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw rejectSchema({ schema: "workspace-artifact", detail });
  }
  return value as Record<string, unknown>;
}

function frontmatter(source: string, path: string): Record<string, unknown> {
  const delimiter = "---\n";
  if (!source.startsWith(delimiter)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "frontmatter-not-open", artifact: "Skill", path },
    });
  }
  const closing = source.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "frontmatter-unclosed", artifact: "Skill", path },
    });
  }
  return requireMapping(
    parseYaml(source.slice(delimiter.length, closing), {
      case: "invalid-yaml",
      artifact: "Skill",
      path,
      section: "frontmatter",
    }),
    {
      case: "not-a-mapping",
      artifact: "Skill",
      path,
      section: "frontmatter",
    },
  );
}

function requireString(
  value: unknown,
  path: string,
  section: string,
  maximum?: number,
): string {
  if (typeof value !== "string" || value.length === 0 || (maximum !== undefined && value.length > maximum)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: {
        case: "invalid-field",
        artifact: "Skill",
        path,
        section,
        ...(maximum === undefined ? {} : { maximum }),
      },
    });
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
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: {
        case: "unknown-fields",
        artifact: "Skill",
        path,
        section: "frontmatter",
        fields: unknown,
      },
    });
  }
  const id = requireString(header.name, path, "name", 64);
  if (!ARTIFACT_ID.test(id)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "invalid-artifact-id", artifact: "Skill", path, section: "name" },
    });
  }
  requireString(header.description, path, "description", 1024);
  if ("license" in header) requireString(header.license, path, "license");
  if ("compatibility" in header) requireString(header.compatibility, path, "compatibility", 500);
  const metadata = "metadata" in header
    ? requireMapping(header.metadata, {
        case: "not-a-mapping",
        artifact: "Skill",
        path,
        section: "metadata",
      })
    : undefined;
  if ("allowed-tools" in header) requireString(header["allowed-tools"], path, "allowed-tools");
  const modelInvocation = parseModelInvocation(metadata, path);

  const parsedSidecar = sidecar === undefined
    ? undefined
    : requireMapping(
        parseYaml(sidecar, {
          case: "invalid-yaml",
          artifact: "Skill",
          path,
          section: "sidecar",
        }),
        { case: "not-a-mapping", artifact: "Skill", path, section: "sidecar" },
      );
  return {
    dependencies: parseArtifactDependencies(parsedSidecar?.dependencies, {
      artifact: "Skill",
      path,
      section: "dependencies",
    }),
    id,
    modelInvocation,
    path: sourcePath,
    ...(parsedSidecar !== undefined
      ? { sidecar: parsedSidecar }
      : {}),
  };
}