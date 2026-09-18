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

/**
 * The collected parse of one Profile file (spec #593 DEC-014, #604): every
 * field-level violation is recorded and the `context`/`skills` lists stay
 * readable where they can be, so a Profile's references are checked in the
 * same validation run that reports its field-level problems. The reported ID
 * is always the file name — an authored `id` field is never adopted.
 */
export interface CollectedProfileParse {
  /**
   * The best-effort Profile when at least one list was readable: its ID is
   * the file name, and each list holds the entries that satisfy the list
   * grammar (invalid entries are reported, not carried).
   */
  readonly profile?: Profile;
  /** Every field-level violation, in detection order. */
  readonly violations: readonly WorkspaceArtifactRejectionReason[];
}

/**
 * Collect one Profile's field-level violations instead of stopping at the
 * first: identity, YAML shape, field set, and each list's entries are checked
 * independently, and unreadable YAML/mapping shapes end that file's parse
 * (nothing further is readable). Detection order matches the strict parser's
 * throw order, so a strict re-raise of the first violation is identical.
 */
export function parseProfileCollected(source: string, path: string): CollectedProfileParse {
  const violations: WorkspaceArtifactRejectionReason[] = [];
  const id = profileIdFromPath(path);
  if (!ARTIFACT_ID.test(id)) {
    violations.push({ case: "profile-file-name", path, name: id });
  }
  let value: unknown;
  try {
    value = parse(source);
  } catch {
    return {
      violations: [...violations, { case: "invalid-yaml", artifact: "Profile", path }],
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      violations: [...violations, { case: "not-a-mapping", artifact: "Profile", path }],
    };
  }
  const mapping = value as Record<string, unknown>;
  const fields = ["context", "skills"] as const;
  const obsoleteFields = ["agents", "hooks", "tools"].filter((field) => field in mapping);
  if (obsoleteFields.length > 0) {
    violations.push({ case: "obsolete-fields", path, fields: obsoleteFields });
  }
  // A Profile's ID is its file name (spec #593 DEC-014, #598): an authored
  // `id` field is never read. The violation names the fix — remove the field,
  // and keep the ID that bindings and receipts reference by renaming the file
  // when the authored value differs from the file name.
  if ("id" in mapping) {
    const authored = mapping.id;
    violations.push({
      case: "profile-id-field",
      path,
      ...(typeof authored === "string" ? { id: authored } : {}),
    });
  }
  // The authored `id` key and the obsolete placeholder keys are field-level
  // violation territory above, not unknown fields — the same key must never
  // be reported twice.
  const unknown = Object.keys(mapping).filter(
    (key) =>
      key !== "id" &&
      !obsoleteFields.includes(key) &&
      !fields.includes(key as (typeof fields)[number]),
  );
  if (unknown.length > 0) {
    violations.push({ case: "unknown-fields", artifact: "Profile", path, fields: unknown });
  }
  for (const field of fields) {
    if (!(field in mapping)) {
      violations.push({ case: "missing-field", path, field });
    }
  }
  // Field-level problems are recorded above; the lists stay readable where
  // they can be, so references are checked in the same run (spec #593
  // DEC-009, #604). An unreadable list (missing or not an array) is skipped.
  const context = collectProfileList(mapping, "context", path, violations);
  const skills = collectProfileList(mapping, "skills", path, violations);
  if (context === undefined && skills === undefined) {
    return { violations };
  }
  return {
    violations,
    profile: {
      id,
      context: context ?? [],
      skills: skills ?? [],
      path,
    },
  };
}

/** Collect one list's valid entries; an unreadable list yields undefined. */
function collectProfileList(
  mapping: Record<string, unknown>,
  field: "context" | "skills",
  path: string,
  violations: WorkspaceArtifactRejectionReason[],
): readonly string[] | undefined {
  if (!(field in mapping)) return undefined;
  const value = mapping[field];
  if (!Array.isArray(value)) {
    violations.push({ case: "not-array-of-names", path, field });
    return undefined;
  }
  // Context entries use the path grammar (`/`-separated segments, DEC-004);
  // Skills stay flat. Each invalid entry is one violation naming the file and
  // section; valid entries are still reference-checked.
  const ids: string[] = [];
  for (const entry of value) {
    const valid = field === "context"
      ? typeof entry === "string" && entry.length > 0 && isValidContextModuleId(entry)
      : typeof entry === "string" && ARTIFACT_ID.test(entry);
    if (!valid) {
      violations.push({
        case: "invalid-artifact-id",
        artifact: "Profile",
        path,
        section: field,
      });
      continue;
    }
    ids.push(entry);
  }
  if (new Set(ids).size !== ids.length) {
    violations.push({ case: "duplicate-name", path, field });
  }
  return ids;
}

/**
 * Parse one Profile file, rejecting it on its first field-level violation.
 * The ingest-or-throw composition over {@link parseProfileCollected}: the
 * first collected violation is raised in original error form, so creation
 * and other strict callers keep their exact behavior.
 */
export function parseProfile(source: string, path: string): Profile {
  const collected = parseProfileCollected(source, path);
  if (collected.violations.length === 0 && collected.profile !== undefined) {
    return collected.profile;
  }
  throw rejectSchema({ schema: "workspace-artifact", detail: collected.violations[0]! });
}
