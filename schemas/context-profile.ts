import { parse } from "yaml";

import { ARTIFACT_ID } from "./dependencies.js";

export { requireArtifactId } from "./dependencies.js";

/** The separator between folders in one Context Module's path-derived ID. */
export const CONTEXT_ID_SEPARATOR = "/";
export const CONTEXT_DIRECTORY = "context/";
export const CONTEXT_MODULE_EXTENSION = ".md";

/** The one Context path-grammar check shared by every validator and parser. */
export function isValidContextModuleId(value: string): boolean {
  return value.split(CONTEXT_ID_SEPARATOR).every((segment) => ARTIFACT_ID.test(segment));
}

/**
 * Validate one authored Context Module ID: `/`-separated segments, each a
 * valid Artifact ID (spec #593 DEC-004, #600). The path grammar applies to
 * Context Modules only; every other artifact type stays flat.
 */
export function requireContextModuleId(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !isValidContextModuleId(value)
  ) {
    throw rejectSchema({
      schema: "artifact-id",
      detail: { case: "invalid-artifact-id", label, grammar: "context" },
    });
  }
  return value;
}

/**
 * Derive one Context Module's Artifact ID from its Workspace-relative file
 * path: the Context identity boundary (spec #593 DEC-004, #600). A Context
 * Module's ID is its path under `context/` without `.md`, with `/` between
 * folders. Segment validity is the caller's rule (`parseContextModule`), so
 * this stays the pure path-shape derivation shared by ingestion and creation.
 */
export function contextModuleIdFromPath(path: string): string {
  if (
    !path.startsWith(CONTEXT_DIRECTORY) ||
    !path.endsWith(CONTEXT_MODULE_EXTENSION) ||
    path === `${CONTEXT_DIRECTORY}${CONTEXT_MODULE_EXTENSION}`
  ) {
    throw new Error(
      `Context Module path must be '${CONTEXT_DIRECTORY}<id>${CONTEXT_MODULE_EXTENSION}': ${path}`,
    );
  }
  return path.slice(CONTEXT_DIRECTORY.length, -CONTEXT_MODULE_EXTENSION.length);
}

/**
 * The suggested valid rename for one Context Module file whose path segments
 * cannot form a valid Artifact ID: every segment sanitized to a valid
 * Artifact ID (lowercase, invalid characters to `-`, collapsed and trimmed),
 * joined by `/`. Returns undefined when no valid suggestion is derivable.
 * One home so the violation's suggestion cannot drift from the grammar.
 */
export function suggestedContextModulePath(invalidId: string): string | undefined {
  const segments = invalidId
    .split(CONTEXT_ID_SEPARATOR)
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, ""),
    );
  // A segment that cannot become a valid ID (for example `___` sanitizes to
  // nothing) leaves the folder count ambiguous, so no suggestion is offered.
  if (segments.length === 0 || segments.some((segment) => !ARTIFACT_ID.test(segment))) {
    return undefined;
  }
  return `${CONTEXT_DIRECTORY}${segments.join(CONTEXT_ID_SEPARATOR)}${CONTEXT_MODULE_EXTENSION}`;
}
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
  field: "context" | "skills",
): readonly string[] {
  if (!Array.isArray(value)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "not-array-of-names", path, field },
    });
  }
  // Context entries use the path grammar (`/`-separated segments, DEC-004);
  // Skills stay flat. The context branch throws the workspace-artifact detail
  // directly so the path-grammar wording carries the Profile's file path.
  const requireReferenceId =
    field === "context"
      ? (entry: unknown) => {
          if (typeof entry !== "string" || entry.length === 0 || !isValidContextModuleId(entry)) {
            throw rejectSchema({
              schema: "workspace-artifact",
              detail: { case: "invalid-artifact-id", artifact: "Profile", path, section: field },
            });
          }
          return entry;
        }
      : (entry: unknown) => {
          if (typeof entry !== "string" || !ARTIFACT_ID.test(entry)) {
            throw rejectSchema({
              schema: "workspace-artifact",
              detail: { case: "invalid-artifact-id", artifact: "Profile", path, section: field },
            });
          }
          return entry;
        };
  const ids = value.map((entry) => requireReferenceId(entry));
  if (new Set(ids).size !== ids.length) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "duplicate-name", path, field },
    });
  }
  return ids;
}

/**
 * Parse one Context Module whose identity is its path under `context/`
 * (spec #593 DEC-004/005, #600): apkit reads no frontmatter and requires
 * none, so the file's complete bytes are the delivered Context. A path
 * segment that cannot form a valid Artifact ID is one violation suggesting
 * the rename; duplicate IDs are structurally impossible because one path has
 * one file. A zero-byte file is reported (`empty-content`) — the rule predates
 * frontmatter removal and now applies to the delivered bytes exactly: a file
 * with no bytes carries no Context, while any written bytes (including
 * whitespace-only or frontmatter-only files) are delivered as written.
 */
export function parseContextModule(source: string, path: string): ContextModule {
  const id = contextModuleIdFromPath(path);
  if (!isValidContextModuleId(id)) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "context-module-file-name", path, name: id },
    });
  }
  if (source.length === 0) {
    throw rejectSchema({
      schema: "workspace-artifact",
      detail: { case: "empty-content", path },
    });
  }
  return {
    content: source,
    id,
    path,
  };
}


export const PROFILE_DIRECTORY = "profiles/";
export const PROFILE_EXTENSION = ".yaml";

/**
 * Derive one Profile's Artifact ID from its Workspace-relative file path: the
 * Profile identity boundary (spec #593 DEC-014, #598). A Profile's ID is its
 * file name under `profiles/` without `.yaml`. Profile identity stays flat:
 * the path grammar is Context-only (spec #593 DEC-004, #600).
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