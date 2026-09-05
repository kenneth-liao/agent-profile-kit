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
    const cwdRelativePath = paths.find((path) => containsPath(path, cwd));
    if (cwdRelativePath) return relative(cwd, cwdRelativePath) || ".";
    const physicalCwdRelativePath = paths.find((path) => containsPath(path, displayCwd));
    if (physicalCwdRelativePath) return relative(displayCwd, physicalCwdRelativePath) || ".";
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