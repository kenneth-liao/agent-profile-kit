import { parse } from "yaml";

import { ARTIFACT_ID } from "./dependencies.js";
import { rejectSchema, type WorkspaceArtifactRejectionReason } from "./schema-rejections.js";

/** Host-neutral model-invocation policy for a Skill. */
export type ModelInvocationPolicy = "allowed" | "disabled";

/** Namespaced standard metadata key for model-invocation policy. */
export const MODEL_INVOCATION_METADATA_KEY = "agent-profile-kit.model-invocation";

/**
 * The retired Agent Profile Kit-only metadata key for model invocation
 * (spec #593 DEC-007): a Skill carrying it is a violation that names the
 * standard top-level replacement field.
 */
export const RETIRED_MODEL_INVOCATION_METADATA_FIELD =
  `metadata.${MODEL_INVOCATION_METADATA_KEY}`;

/** Standard top-level Agent Skills field that disables model invocation. */
const STANDARD_MODEL_INVOCATION_FIELD = "disable-model-invocation";

/**
 * The retired Agent Profile Kit-only Skill sidecar name (spec #593 DEC-006).
 * A Skill package containing it is a leftover from an earlier release and is
 * one violation with that file's path.
 */
export const SKILL_PACKAGE_SIDECAR = "agent-profile-kit.yaml";

export interface Skill {
  readonly id: string;
  /** Normalized model-invocation policy; absence of the standard field defaults to allowed. */
  readonly modelInvocation: ModelInvocationPolicy;
  readonly path: string;
}

function parseModelInvocation(
  header: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  path: string,
): ModelInvocationPolicy {
  if (metadata !== undefined && MODEL_INVOCATION_METADATA_KEY in metadata) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "leftover-model-invocation-metadata", path },
    });
  }
  const field = header[STANDARD_MODEL_INVOCATION_FIELD];
  if (field === undefined) {
    return "allowed";
  }
  if (typeof field !== "boolean") {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: {
        case: "invalid-model-invocation",
        path,
        key: STANDARD_MODEL_INVOCATION_FIELD,
      },
    });
  }
  return field ? "disabled" : "allowed";
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
): Skill {
  const header = frontmatter(source, path);
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
  const modelInvocation = parseModelInvocation(header, metadata, path);

  return {
    id,
    modelInvocation,
    path: sourcePath,
  };
}