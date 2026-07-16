import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  LOCAL_CONFIGURATION_FILE,
  parseLocalConfiguration,
  type LocalConfiguration,
  type ParsedProjectBinding,
  type ProjectBinding,
} from "../schemas/local-configuration.js";
import { ingestWorkspace, type Workspace } from "./ingest-workspace.js";
import { validateWorkspaceStructure, workspacePath } from "./workspace.js";

export function localConfigurationPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", LOCAL_CONFIGURATION_FILE);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * Expand an absolute or home-relative machine path. Wildcards and other relative
 * forms are invalid. Shared by Project Binding roots and the optional Workspace path.
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
 * Absence of an authored path selects the fixed default.
 * Returns the canonical (realpath) directory after structural validation when
 * the path must already exist (always for a configured custom path; for the
 * default, callers that need a live Workspace still validate separately).
 */
export async function resolveWorkspaceRoot(
  home: string,
  authored: string | undefined,
  configPath: string,
): Promise<{ readonly authored: string; readonly path: string }> {
  if (authored === undefined) {
    const path = workspacePath(home);
    return { authored: path, path };
  }

  const description = `Local Configuration ${configPath}`;
  const expanded = expandConfiguredPath(authored, home, description, "workspace");
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

async function buildLocalConfiguration(
  parsed: {
    readonly bindings: readonly ParsedProjectBinding[];
    readonly schemaVersion: 1;
    readonly workspace?: string;
  },
  path: string,
  home: string,
  workspace: Workspace,
): Promise<LocalConfiguration> {
  const bindings: ProjectBinding[] = [];
  const roots = new Set<string>();
  for (const [index, binding] of parsed.bindings.entries()) {
    const description = `Local Configuration ${path} bindings[${index}]`;
    const canonicalProject = await normalizeProject(binding.project, home, description);
    if (roots.has(canonicalProject)) {
      throw new Error(
        `${description} project resolves to duplicate canonical root '${canonicalProject}'`,
      );
    }
    roots.add(canonicalProject);
    if (!workspace.profiles.has(binding.profile)) {
      throw new Error(
        `${description} profile '${binding.profile}' does not exist in Workspace ${workspace.path}`,
      );
    }
    bindings.push({ ...binding, canonicalProject });
  }
  return {
    bindings,
    path,
    schemaVersion: parsed.schemaVersion,
    ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }),
  };
}

/**
 * Shared desired-state ingestion boundary: resolve Local Configuration first so
 * validate/preview/apply/status select the same configured Workspace (or the
 * fixed default). `init` reuses `resolveWorkspaceRoot` separately; `uninstall`
 * does not call this path.
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
      throw new Error(`Local Configuration is missing at ${path}; run agent-profile-kit init`);
    }
    throw error;
  }

  const parsed = parseLocalConfiguration(source, path);
  const resolved = await resolveWorkspaceRoot(home, parsed.workspace, path);

  let workspaceRoot = resolved.path;
  if (parsed.workspace === undefined) {
    // Default path: validate structure and normalize to realpath for identity.
    await validateWorkspaceStructure(workspaceRoot);
    workspaceRoot = await realpath(workspaceRoot);
  }

  const workspace = await ingestWorkspace(workspaceRoot);
  const configuration = await buildLocalConfiguration(parsed, path, home, workspace);
  return { configuration, workspace };
}
