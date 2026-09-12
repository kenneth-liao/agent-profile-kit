import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/**
 * The one home for location presentation across every surface (DEC-010):
 * path identity, display scope, and middle eliding that preserves trailing
 * segments. Renderers and formatters both consume this module; it depends on
 * no presentation module, so the document renderer can use it without an
 * import cycle.
 */

export type LocationDisplayScope = "fleet" | "project";

/**
 * One Project as a human view carries it: the canonical directory used for
 * identity and the authored spelling kept for display. `canonicalProject` is
 * null only for an invalid binding that has no resolvable directory.
 */
export interface ViewProjectLocation {
  readonly canonicalProject: string | null;
  readonly project: string;
}

/**
 * One view's chosen human identity for a Project (US-013, DEC-009): the
 * shortest trailing path segments that no other Project *in that view*
 * shares. Call it once per Project reference in the same document so every
 * list, sentence, and receipt line agrees.
 */
export type ProjectIdentityLookup = (project: ViewProjectLocation) => string;

/** The stable, machine-independent display spelling of one Project. */
export function stableProjectDisplay(
  project: ViewProjectLocation,
  cwd = process.cwd(),
  home = homedir(),
): string {
  return displayPath(project.canonicalProject ?? project.project, project.project, "fleet", cwd, home);
}

const RELATIVE_PATH_LABEL = "relative path ";

interface IdentityParts {
  readonly display: string;
  /** Trailing path segments, or undefined when the display is not a location. */
  readonly segments: readonly string[] | undefined;
}

function identityParts(display: string): IdentityParts {
  if (display.startsWith(RELATIVE_PATH_LABEL)) return { display, segments: undefined };
  const body = display.startsWith("~/")
    ? display.slice(2)
    : display.startsWith("/")
    ? display.slice(1)
    : display;
  return {
    display,
    segments: body.length === 0 ? [] : body.split("/").filter((segment) => segment.length > 0),
  };
}

function identityAt(parts: IdentityParts, depth: number): string {
  const segments = parts.segments;
  // A suffix spanning every segment keeps the stable display, including its
  // root marker, so an absolute path never renders as a relative-looking tail.
  if (segments === undefined || depth >= segments.length) return parts.display;
  return segments.slice(-depth).join("/");
}

function shortestUniqueIdentity(parts: IdentityParts, view: readonly IdentityParts[]): string {
  const segments = parts.segments;
  if (segments === undefined || segments.length === 0) return parts.display;
  // A display shared by two records cannot be disambiguated by a suffix; keep
  // the stable display for both instead of inventing an ambiguous label.
  if (view.filter((other) => other.display === parts.display).length > 1) return parts.display;
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const candidate = identityAt(parts, depth);
    const shared = view.some((other) =>
      other.display !== parts.display && identityAt(other, depth) === candidate
    );
    if (!shared) return candidate;
  }
  return parts.display;
}

/**
 * Build one view's identity lookup. Identity is per view, so a view naming a
 * single Project names it by its basename and a Project outside the view can
 * never lengthen a displayed identity (US-013).
 */
export function projectIdentityLookup(
  view: readonly ViewProjectLocation[],
  cwd = process.cwd(),
  home = homedir(),
): ProjectIdentityLookup {
  const parts = view.map((project) => identityParts(stableProjectDisplay(project, cwd, home)));
  const identities = new Map<string, string>(
    parts.map((part) => [part.display, shortestUniqueIdentity(part, parts)]),
  );
  return (project) => {
    const display = stableProjectDisplay(project, cwd, home);
    return identities.get(display) ?? display;
  };
}

/**
 * Split one identity into its path-segment chunks, each ending at a `/`
 * boundary, so a renderer may wrap between segments without dropping a
 * character of the identity.
 */
export function projectIdentityChunks(identity: string): readonly string[] {
  return identity.split(/(?<=\/)/);
}

/**
 * Wrap one identity so it never overflows the measure and never loses a
 * character: lines break at `/` boundaries, and a single segment wider than
 * the measure breaks at the measure instead of overflowing the terminal.
 */
export function wrapProjectIdentity(identity: string, measure: number): readonly string[] {
  const width = Math.max(1, Math.floor(measure));
  if (identity.length <= width) return [identity];
  const lines: string[] = [];
  let current = "";
  for (const chunk of projectIdentityChunks(identity)) {
    let remainder = chunk;
    while (remainder.length > 0) {
      if (current.length === 0) {
        if (remainder.length <= width) {
          current = remainder;
          remainder = "";
        } else {
          lines.push(remainder.slice(0, width));
          remainder = remainder.slice(width);
        }
        continue;
      }
      if (current.length + remainder.length <= width) {
        current += remainder;
        remainder = "";
        continue;
      }
      lines.push(current);
      current = "";
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length === 0 ? [identity] : lines;
}

export function displayPath(
  canonicalPath: string,
  authoredPath: string = canonicalPath,
  scope: LocationDisplayScope,
  cwd = process.cwd(),
  home = homedir(),
  maxWidth?: number,
): string {
  const displayed = displayPathIdentity(canonicalPath, authoredPath, scope, cwd, home);
  return maxWidth === undefined ? displayed : elideDisplayedPath(displayed, maxWidth);
}

function displayPathIdentity(
  canonicalPath: string,
  authoredPath: string,
  scope: LocationDisplayScope,
  cwd: string,
  home: string,
): string {
  const authoredAbsolute = absoluteAuthoredPath(authoredPath, home);
  const paths = [...new Set([canonicalPath, authoredAbsolute])];
  const displayCwd = existingPathAlias(cwd);
  const displayHome = existingPathAlias(home);
  if (scope === "project") {
    // A Project root is never named by the cwd-relative alias `.` or `..`
    // (US-013): only a location strictly inside the working directory keeps a
    // short relative spelling.
    const descendant = paths.map((path) => relative(cwd, path)).find(isStrictDescendant) ??
      paths.map((path) => relative(displayCwd, path)).find(isStrictDescendant);
    if (descendant !== undefined) return descendant;
  } else if (scope !== "fleet") {
    const exhaustive: never = scope;
    throw new Error(`Unknown location display scope: ${exhaustive}`);
  }
  if (authoredPath === "~" || authoredPath.startsWith("~/")) return authoredPath;
  const homeRelativePath = paths.find((path) => containsPath(home, path)) ??
    paths.find((path) => containsPath(displayHome, path));
  if (homeRelativePath) {
    const displayBase = containsPath(home, homeRelativePath) ? home : displayHome;
    const homeRelative = relative(displayBase, homeRelativePath);
    return homeRelative === "" ? "~" : `~/${homeRelative}`;
  }
  if (isAbsolute(authoredPath)) return authoredPath;
  if (isAbsolute(canonicalPath)) return canonicalPath;
  return `relative path ${JSON.stringify(authoredPath)}`;
}

const PATH_ELLIPSIS = "…";

function elideDisplayedPath(display: string, maxWidth: number): string {
  if (maxWidth <= 0) return PATH_ELLIPSIS;
  if (display.length <= maxWidth) return display;

  const homeRelative = display === "~" || display.startsWith("~/");
  const absolute = display.startsWith("/");
  const body = homeRelative
    ? display.slice(display.startsWith("~/") ? 2 : 1)
    : absolute
    ? display.slice(1)
    : display;
  const segments = body.split("/").filter((segment) => segment.length > 0);

  for (let drop = 1; drop < segments.length; drop += 1) {
    const trailing = segments.slice(drop).join("/");
    const candidate = homeRelative
      ? `~/${PATH_ELLIPSIS}/${trailing}`
      : absolute
      ? `/${PATH_ELLIPSIS}/${trailing}`
      : `${PATH_ELLIPSIS}/${trailing}`;
    if (candidate.length <= maxWidth) return candidate;
  }

  const last = segments.at(-1) ?? display;
  const head = homeRelative ? `~/${PATH_ELLIPSIS}` : absolute ? `/${PATH_ELLIPSIS}` : PATH_ELLIPSIS;
  const budget = maxWidth - head.length;
  if (budget <= 0) return PATH_ELLIPSIS.slice(0, maxWidth);
  if (last.length <= budget) {
    const candidate = `${head}${last}`;
    return candidate.length <= maxWidth ? candidate : PATH_ELLIPSIS.slice(0, maxWidth);
  }
  return `${head}${last.slice(-budget)}`;
}

export function displayProjectPath(
  canonicalProject: string,
  authoredProject: string = canonicalProject,
  scope: LocationDisplayScope,
  cwd = process.cwd(),
  home = homedir(),
  maxWidth?: number,
): string {
  // Keep this project-specific name as the stable presentation API while all
  // location display policy lives in the shared displayPath implementation.
  return displayPath(canonicalProject, authoredProject, scope, cwd, home, maxWidth);
}

/** True when `relativePath` names a location strictly inside its base. */
function isStrictDescendant(relativePath: string): boolean {
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !isAbsolute(relativePath);
}

function containsPath(parent: string, child: string): boolean {
  const childFromParent = relative(parent, child);
  return childFromParent === "" || (
    childFromParent !== ".." &&
    !childFromParent.startsWith("../") &&
    !isAbsolute(childFromParent)
  );
}

function existingPathAlias(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function absoluteAuthoredPath(authoredPath: string, home: string): string {
  return authoredPath === "~"
    ? home
    : authoredPath.startsWith("~/")
      ? join(home, authoredPath.slice(2))
      : authoredPath;
}