import { parse } from "yaml";

import {
  parseArtifactDependencies,
  ARTIFACT_ID,
  type ArtifactReference,
} from "./dependencies.js";

export { requireArtifactId } from "./dependencies.js";
import { rejectSchema, type WorkspaceArtifactRejectionReason } from "./schema-rejections.js";

export interface ContextModule {
  readonly dependencies: readonly ArtifactReference[];
  readonly id: string;
  readonly content: string;
}

export interface Profile {
  readonly id: string;
  readonly context: readonly string[];
  readonly skills: readonly string[];
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  detail: WorkspaceArtifactRejectionReason,
): void {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    throw rejectSchema({ schema: "workspace-artifact", detail });
  }
}

function parseYaml(
  source: string,
  detail: WorkspaceArtifactRejectionReason,
): unknown {
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

function requireStringArray(
  value: unknown,
  path: string,
  field: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "not-array-of-names", path, field },
    });
  }
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || !ARTIFACT_ID.test(entry)) {
      throw rejectSchema({
        schema: "workspace-artifact",
        detail: { case: "invalid-artifact-id", artifact: "Profile", path, section: field },
      });
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "duplicate-name", path, field },
    });
  }
  return ids;
}

export function parseContextModule(source: string, path: string): ContextModule {
  const delimiter = "---\n";
  if (!source.startsWith(delimiter)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "frontmatter-not-open", artifact: "Context Module", path },
    });
  }
  const closing = source.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "frontmatter-unclosed", artifact: "Context Module", path },
    });
  }

  const header = parseYaml(source.slice(delimiter.length, closing), {
    case: "invalid-yaml",
    artifact: "Context Module",
    path,
    section: "frontmatter",
  });
  const mapping = requireMapping(header, {
    case: "not-a-mapping",
    artifact: "Context Module",
    path,
    section: "frontmatter",
  });
  requireExactFields(mapping, ["id", "dependencies"], {
    case: "unknown-fields",
    artifact: "Context Module",
    path,
    fields: Object.keys(mapping).filter((key) => !["id", "dependencies"].includes(key)),
  });
  if (typeof mapping.id !== "string" || !ARTIFACT_ID.test(mapping.id)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "invalid-artifact-id", artifact: "Context Module", path, section: "id" },
    });
  }
  const id = mapping.id;
  const content = source.slice(closing + delimiter.length);
  if (content.length === 0) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "empty-content", path },
    });
  }
  return {
    content,
    dependencies: parseArtifactDependencies(mapping.dependencies, {
      artifact: "Context Module",
      path,
      section: "dependencies",
    }),
    id,
  };
}

export function parseProfile(source: string, path: string): Profile {
  const value = parseYaml(source, { case: "invalid-yaml", artifact: "Profile", path });
  const mapping = requireMapping(value, { case: "not-a-mapping", artifact: "Profile", path });
  const fields = ["id", "context", "skills"] as const;
  const obsoleteFields = ["agents", "hooks", "tools"].filter((field) => field in mapping);
  if (obsoleteFields.length > 0) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "obsolete-fields", path, fields: obsoleteFields },
    });
  }
  requireExactFields(mapping, fields, {
    case: "unknown-fields",
    artifact: "Profile",
    path,
    fields: Object.keys(mapping).filter((key) => !fields.includes(key as (typeof fields)[number])),
  });
  for (const field of fields) {
    if (!(field in mapping)) {
      throw rejectSchema({
        schema: "workspace-artifact",
        detail: { case: "missing-field", path, field },
      });
    }
  }
  if (typeof mapping.id !== "string" || !ARTIFACT_ID.test(mapping.id)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "invalid-artifact-id", artifact: "Profile", path, section: "id" },
    });
  }
  return {
    id: mapping.id,
    context: requireStringArray(mapping.context, path, "context"),
    skills: requireStringArray(mapping.skills, path, "skills"),
  };
}