import { parse } from "yaml";

import { ARTIFACT_ID } from "./dependencies.js";

export { requireArtifactId } from "./dependencies.js";
import { rejectSchema, type WorkspaceArtifactRejectionReason } from "./schema-rejections.js";

export interface ContextModule {
  readonly id: string;
  readonly content: string;
  /** Workspace-relative source file this module was parsed from. */
  readonly path: string;
}

export interface Profile {
  readonly id: string;
  readonly context: readonly string[];
  readonly skills: readonly string[];
  /** Workspace-relative source file this Profile was parsed from. */
  readonly path: string;
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
  // `dependencies` remains a tolerated legacy key whose value is never read
  // (spec #593 DEC-006, ADR-0045): Profile lists are the only source of what
  // is installed.
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
    id,
    path,
  };
}

export const PROFILE_DIRECTORY = "profiles/";
export const PROFILE_EXTENSION = ".yaml";

/**
 * Derive one Profile's Artifact ID from its Workspace-relative file path: the
 * Profile identity boundary (spec #593 DEC-014, #598). A Profile's ID is its
 * file name under `profiles/` without `.yaml`.
 */
export function profileIdFromPath(path: string): string {
  if (!path.startsWith(PROFILE_DIRECTORY) || !path.endsWith(PROFILE_EXTENSION)) {
    throw new Error(`Profile path must be '${PROFILE_DIRECTORY}<name>${PROFILE_EXTENSION}': ${path}`);
  }
  return path.slice(PROFILE_DIRECTORY.length, -PROFILE_EXTENSION.length);
}

export function parseProfile(source: string, path: string): Profile {
  // Identity comes from the file name before any content is read: a Profile
  // file name that cannot form a valid Artifact ID is one violation, and a
  // nested folder's derived name (carrying `/`) fails the same rule.
  const id = profileIdFromPath(path);
  if (!ARTIFACT_ID.test(id)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "profile-file-name", path, name: id },
    });
  }
  const value = parseYaml(source, { case: "invalid-yaml", artifact: "Profile", path });
  const mapping = requireMapping(value, { case: "not-a-mapping", artifact: "Profile", path });
  const fields = ["context", "skills"] as const;
  const obsoleteFields = ["agents", "hooks", "tools"].filter((field) => field in mapping);
  if (obsoleteFields.length > 0) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "obsolete-fields", path, fields: obsoleteFields },
    });
  }
  // A Profile's ID is its file name (spec #593 DEC-014, #598): an authored
  // `id` field is never read. The violation names the fix — remove the field,
  // and keep the ID that bindings and receipts reference by renaming the file
  // when the authored value differs from the file name.
  if ("id" in mapping) {
    const authored = mapping.id;
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: {
        case: "profile-id-field",
        path,
        ...(typeof authored === "string" ? { id: authored } : {}),
      },
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
  return {
    id,
    context: requireStringArray(mapping.context, path, "context"),
    skills: requireStringArray(mapping.skills, path, "skills"),
    path,
  };
}