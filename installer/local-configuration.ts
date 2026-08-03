import { lstat, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  LOCAL_CONFIGURATION_FILE,
  requireCurrentLocalConfiguration,
  parseLocalConfiguration,
  type LocalConfiguration,
  type ParsedCurrentLocalConfiguration,
  type ParsedLocalConfiguration,
  type ParsedProjectBinding,
  type ProjectBinding,
} from "../schemas/local-configuration.js";
import { ingestWorkspace, type Workspace } from "./ingest-workspace.js";
import { COMMAND_NAME } from "./version.js";
import { requireProfile } from "./profile-selection.js";
import { validateWorkspaceStructure } from "./workspace.js";

export function localConfigurationPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", LOCAL_CONFIGURATION_FILE);
}

export function stateDirectory(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function requireCurrentApplicationConfiguration(
  parsed: ParsedLocalConfiguration,
  path: string,
): ParsedCurrentLocalConfiguration {
  return requireCurrentLocalConfiguration(parsed, path, `${COMMAND_NAME} init`);
}

/**
 * Expand an absolute or home-relative machine path. Wildcards and other relative
 * forms are invalid. Shared by Project Binding roots and the authored Workspace path.
 */
export function expandConfiguredPath(
  value: string,
  home: string,
  description: string,
  field: string,
): string {
  if (
    value.includes("*") ||
    value.includes("?") ||
    value.includes("[") ||
    value.includes("]")
  ) {
    throw new Error(
      `${description} ${field} must be an explicit directory path without wildcards`,
    );
  }
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  if (!isAbsolute(value)) {
    throw new Error(
      `${description} ${field} must be an absolute path or home-relative path beginning with ~/`,
    );
  }
  return value;
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  const relativePath = relative(ancestor, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export async function canonicalizePathForComparison(path: string): Promise<string> {
  const original = resolve(path);
  let candidate = original;
  const suffix: string[] = [];

  while (true) {
    try {
      const canonical = await realpath(candidate);
      return suffix.reduceRight((parent, segment) => join(parent, segment), canonical);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return original;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Keep canonical Workspace source separate from machine-local configuration and
 * disposable installation state, including when either side is reached through
 * a symlink alias or a not-yet-created path.
 */
export async function assertWorkspaceSelectionSeparation(
  home: string,
  destination: string,
  authored: string,
  description: string,
): Promise<void> {
  const reservedPaths = [
    { label: "Local Configuration", path: localConfigurationPath(home) },
    { label: "installation state", path: stateDirectory(home) },
  ] as const;
  const canonicalDestination = await canonicalizePathForComparison(destination);
  const canonicalReservedPaths = await Promise.all(
    reservedPaths.map(async (reserved) => ({
      ...reserved,
      path: await canonicalizePathForComparison(reserved.path),
    })),
  );
  const conflict = canonicalReservedPaths.find(
    (reserved) =>
      isSameOrDescendant(canonicalDestination, reserved.path) ||
      isSameOrDescendant(reserved.path, canonicalDestination),
  );
  if (conflict !== undefined) {
    throw new Error(
      `${description} workspace '${authored}' is reserved for ${conflict.label} at ${conflict.path}`,
    );
  }
}

export async function requireExistingDirectory(
  expanded: string,
  authored: string,
  description: string,
  field: string,
): Promise<string> {
  let entryStats;
  try {
    entryStats = await lstat(expanded);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        `${description} ${field} '${authored}' must be an existing directory`,
      );
    }
    throw error;
  }

  let stats;
  try {
    stats = await stat(expanded);
  } catch (error) {
    if (entryStats.isSymbolicLink() && hasErrorCode(error, "ENOENT")) {
      const recovery =
        field === "workspace"
          ? "restore its target or choose an existing Workspace directory"
          : "restore its target or choose an existing directory";
      throw new Error(
        `${description} ${field} '${authored}' is a dangling symlink; ${recovery}`,
      );
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(
      `${description} ${field} '${authored}' must be an existing directory`,
    );
  }
  return realpath(expanded);
}

/** Canonical absolute directory for a Project Binding root (authored spelling separate). */
export async function normalizeProject(
  project: string,
  home: string,
  description: string,
): Promise<string> {
  const expanded = expandConfiguredPath(project, home, description, "project");
  return requireExistingDirectory(expanded, project, description, "project");
}

/**
 * Resolve the Workspace directory from Local Configuration.
 * The explicit authored path is the only selection input. Returns the canonical
 * (realpath) directory after structural validation.
 */
export async function resolveWorkspaceRoot(
  home: string,
  authored: string,
  configPath: string,
): Promise<{ readonly authored: string; readonly path: string }> {
  const description = `Local Configuration ${configPath}`;
  const expanded = expandConfiguredPath(authored, home, description, "workspace");
  await assertWorkspaceSelectionSeparation(home, expanded, authored, description);
  const canonical = await requireExistingDirectory(
    expanded,
    authored,
    description,
    "workspace",
  );

  try {
    await validateWorkspaceStructure(canonical);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${description} workspace '${authored}' is not a valid Agent Profile Kit Workspace: ${detail}`,
    );
  }

  return { authored, path: canonical };
}

export interface IngestedProjectBinding {
  readonly index: number;
  readonly project: string;
  readonly profile: string;
  readonly hosts: ParsedProjectBinding["hosts"];
  readonly canonicalProject?: string;
  readonly missing: boolean;
}

export interface IngestedApplicationSource {
  readonly bindings: readonly IngestedProjectBinding[];
  readonly schemaVersion: 2;
  readonly workspace: string;
  readonly workspaceModel: Workspace;
}

async function isMissingPath(expanded: string): Promise<boolean> {
  try {
    await lstat(expanded);
    return false;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

async function ingestWorkspaceFromConfiguration(
  home: string,
  authored: string,
  path: string,
): Promise<Workspace> {
  const resolved = await resolveWorkspaceRoot(home, authored, path);
  return ingestWorkspace(resolved.path);
}

/**
 * Trusted Local Configuration + Workspace model from an exact source snapshot.
 * Missing project roots can be retained as explicit recovery candidates for
 * recording commands; all other path, Profile, and duplicate-root invariants
 * remain shared with desired-state ingestion.
 */
export async function ingestApplicationModelFromSource(
  home: string,
  source: string,
  path: string = localConfigurationPath(home),
  options: { readonly allowMissingProjects?: boolean } = {},
): Promise<IngestedApplicationSource> {
  const parsed = requireCurrentApplicationConfiguration(
    parseLocalConfiguration(source, path),
    path,
  );
  const workspaceModel = await ingestWorkspaceFromConfiguration(
    home,
    parsed.workspace,
    path,
  );
  const allowMissingProjects = options.allowMissingProjects ?? false;
  const roots = new Set<string>();
  const missingProjects = new Set<string>();
  const bindings: IngestedProjectBinding[] = [];

  for (const [index, binding] of parsed.bindings.entries()) {
    const description = `Local Configuration ${path} bindings[${index}]`;
    const expanded = expandConfiguredPath(binding.project, home, description, "project");
    let canonicalProject: string | undefined;
    let missing = false;
    try {
      canonicalProject = await requireExistingDirectory(
        expanded,
        binding.project,
        description,
        "project",
      );
    } catch (error) {
      if (!allowMissingProjects || !(await isMissingPath(expanded))) throw error;
      missing = true;
    }

    if (missing) {
      if (missingProjects.has(binding.project)) {
        throw new Error(
          `${description} duplicates missing project path '${binding.project}'`,
        );
      }
      missingProjects.add(binding.project);
    } else {
      if (canonicalProject === undefined) {
        throw new Error(`${description} project could not be normalized`);
      }
      if (roots.has(canonicalProject)) {
        throw new Error(
          `${description} project resolves to duplicate canonical root '${canonicalProject}'`,
        );
      }
      roots.add(canonicalProject);
    }

    requireProfile(workspaceModel.profiles, binding.profile);
    bindings.push({
      index,
      project: binding.project,
      profile: binding.profile,
      hosts: binding.hosts,
      ...(canonicalProject === undefined ? {} : { canonicalProject }),
      missing,
    });
  }

  return {
    bindings,
    schemaVersion: parsed.schemaVersion,
    workspace: parsed.workspace,
    workspaceModel,
  };
}

/**
 * Strict desired-state ingestion. Recording commands may opt into the shared
 * missing-path model above, but normal reconciliation still rejects stale roots.
 */
export async function ingestApplicationFromSource(
  home: string,
  source: string,
  path: string = localConfigurationPath(home),
): Promise<{
  readonly configuration: LocalConfiguration;
  readonly workspace: Workspace;
}> {
  const model = await ingestApplicationModelFromSource(home, source, path);
  return {
    configuration: {
      bindings: model.bindings.map((binding) => ({
        canonicalProject: binding.canonicalProject!,
        project: binding.project,
        profile: binding.profile,
        hosts: binding.hosts,
      })),
      path,
      schemaVersion: model.schemaVersion,
      workspace: model.workspace,
    },
    workspace: model.workspaceModel,
  };
}

/**
 * Shared desired-state ingestion boundary: resolve Local Configuration first so
 * validate/preview/apply/status select the same explicitly configured Workspace.
 * `init` reuses `resolveWorkspaceRoot` separately; `uninstall` does not call
 * this path.
 */
export async function ingestApplication(home: string): Promise<{
  readonly configuration: LocalConfiguration;
  readonly workspace: Workspace;
}> {
  const path = localConfigurationPath(home);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`Local Configuration is missing at ${path}; run ${COMMAND_NAME} init`);
    }
    throw error;
  }

  return ingestApplicationFromSource(home, source, path);
}
