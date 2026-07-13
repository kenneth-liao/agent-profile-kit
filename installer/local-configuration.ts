import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  LOCAL_CONFIGURATION_FILE,
  parseLocalConfiguration,
  type LocalConfiguration,
  type ProjectBinding,
} from "../schemas/local-configuration.js";
import { ingestWorkspace, type Workspace } from "./ingest-workspace.js";

export function localConfigurationPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", LOCAL_CONFIGURATION_FILE);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function expandProjectPath(project: string, home: string, description: string): string {
  if (
    project.includes("*") ||
    project.includes("?") ||
    project.includes("[") ||
    project.includes("]")
  ) {
    throw new Error(`${description} project must be an explicit directory path without wildcards`);
  }
  if (project === "~") return home;
  if (project.startsWith("~/")) return join(home, project.slice(2));
  if (!isAbsolute(project)) {
    throw new Error(`${description} project must be an absolute path or home-relative path beginning with ~/`);
  }
  return project;
}

async function normalizeProject(
  project: string,
  home: string,
  description: string,
): Promise<string> {
  const expanded = expandProjectPath(project, home, description);
  let stats;
  try {
    stats = await stat(expanded);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`${description} project '${project}' must be an existing directory`);
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    throw new Error(`${description} project '${project}' must be an existing directory`);
  }
  return realpath(expanded);
}

export async function ingestLocalConfiguration(
  home: string,
  workspace: Workspace,
): Promise<LocalConfiguration> {
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
  };
}

export async function ingestApplication(home: string): Promise<{
  readonly configuration: LocalConfiguration;
  readonly workspace: Workspace;
}> {
  const workspace = await ingestWorkspace(home);
  return { configuration: await ingestLocalConfiguration(home, workspace), workspace };
}
