import { lstat, realpath } from "node:fs/promises";
import { isSeq, parseDocument } from "yaml";

import {
  defaultFileSystem,
  DEFAULT_LOCK_TIMEOUT_MS,
  hasHeldResidue,
  pathExists,
  publishConfigurationReplacement,
  recoverHeldConfiguration,
  type BindProjectFileSystem,
  withConfigurationLock,
} from "./bind-project.js";
import {
  expandConfiguredPath,
  localConfigurationPath,
  normalizeProject,
  requireExistingDirectory,
  resolveWorkspaceRoot,
} from "./local-configuration.js";
import { parseLocalConfiguration } from "../schemas/local-configuration.js";
import { ingestWorkspace } from "./ingest-workspace.js";
import { validateWorkspaceStructure, workspacePath } from "./workspace.js";

interface UnbindTarget {
  readonly requested: string;
  readonly canonical?: string;
  readonly missing: boolean;
}

interface UnbindMatch {
  readonly index: number;
  readonly project: string;
  readonly canonicalProject?: string;
  readonly profile: string;
  readonly hosts: readonly string[];
  readonly recovery: "canonical" | "authored-path";
}

interface RangedYamlNode {
  readonly range?: readonly [number, number, number];
}

function removeBindingSource(
  source: string,
  bindingsNode: { readonly flow?: boolean; readonly items: readonly unknown[] },
  index: number,
): string {
  const item = bindingsNode.items[index] as RangedYamlNode | undefined;
  const range = item?.range;
  if (!range) throw new Error("Local Configuration bindings entry has no source range");

  if (bindingsNode.flow) {
    if (bindingsNode.items.length === 1) {
      return source.slice(0, range[0]) + source.slice(range[1]);
    }
    if (index < bindingsNode.items.length - 1) {
      const next = bindingsNode.items[index + 1] as RangedYamlNode;
      if (!next.range) throw new Error("Local Configuration bindings entry has no source range");
      return source.slice(0, range[0]) + source.slice(next.range[0]);
    }
    const previous = bindingsNode.items[index - 1] as RangedYamlNode;
    if (!previous.range) throw new Error("Local Configuration bindings entry has no source range");
    return source.slice(0, previous.range[1]) + source.slice(range[1]);
  }

  const lineStart = source.lastIndexOf("\n", range[0] - 1) + 1;
  const prefix = source.slice(0, lineStart);
  if (bindingsNode.items.length === 1) {
    // Keep the original indentation while restoring an empty sequence value.
    const indentation = source.slice(lineStart, range[0]).replace(/-\s*$/, "");
    const lineEnding = source.slice(range[1] - 2, range[1]) === "\r\n"
      ? 2
      : source[range[1] - 1] === "\n"
        ? 1
        : 0;
    return prefix + indentation + "[]" + source.slice(range[1] - lineEnding);
  }
  return prefix + source.slice(range[1]);
}

async function isMissingPath(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function resolveUnbindTarget(
  options: UnbindProjectOptions,
  description: string,
): Promise<UnbindTarget> {
  const cwd = options.cwd ?? process.cwd();
  if (options.project === undefined) {
    return {
      requested: cwd,
      canonical: await requireExistingDirectory(cwd, cwd, description, "project"),
      missing: false,
    };
  }

  const expanded = expandConfiguredPath(options.project, options.home, description, "project");
  if (await isMissingPath(expanded)) {
    return { requested: options.project, missing: true };
  }
  return {
    requested: options.project,
    canonical: await normalizeProject(options.project, options.home, description),
    missing: false,
  };
}

async function ingestWorkspaceForUnbind(
  home: string,
  parsedWorkspace: string | undefined,
  configurationPath: string,
) {
  const resolved = await resolveWorkspaceRoot(home, parsedWorkspace, configurationPath);
  let root = resolved.path;
  if (parsedWorkspace === undefined) {
    await validateWorkspaceStructure(root);
    root = await realpath(workspacePath(home));
  }
  return ingestWorkspace(root);
}

export interface UnbindProjectOptions {
  readonly home: string;
  /** Authored project path; omit to use cwd. */
  readonly project?: string;
  /** Working directory used when project is omitted. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Test-only filesystem override for snapshot and publication proofs. */
  readonly fileSystem?: BindProjectFileSystem;
  /** Test-only lock wait/stale-empty timeout (ms). */
  readonly lockTimeoutMs?: number;
}

export interface UnbindProjectResult {
  readonly outcome: "removed" | "unchanged";
  readonly configurationPath: string;
  readonly requestedProject: string;
  readonly project?: string;
  readonly canonicalProject?: string;
  readonly profile?: string;
  readonly hosts?: readonly string[];
  readonly recovery?: "canonical" | "authored-path";
}

/**
 * Remove one Project Binding from Local Configuration without reconciling output.
 * Existing paths match by canonical identity; a missing path matches only its
 * exact authored spelling already present in Local Configuration.
 */
export async function unbindProject(
  options: UnbindProjectOptions,
): Promise<UnbindProjectResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const configurationPath = localConfigurationPath(options.home);
  const description = `Local Configuration ${configurationPath}`;
  const target = await resolveUnbindTarget(options, description);

  if (!(await pathExists(fileSystem, configurationPath))) {
    if (!(await hasHeldResidue(configurationPath, fileSystem))) {
      throw new Error(
        `Local Configuration is missing at ${configurationPath}; run agent-profile-kit init`,
      );
    }
  }

  return withConfigurationLock(
    configurationPath,
    fileSystem,
    lockTimeoutMs,
    "unbind",
    async () => {
      await recoverHeldConfiguration(configurationPath, fileSystem);

      let source: string;
      try {
        source = await fileSystem.readFile(configurationPath, "utf8");
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new Error(
            `Local Configuration is missing at ${configurationPath}; run agent-profile-kit init`,
          );
        }
        throw error;
      }

      const parsed = parseLocalConfiguration(source, configurationPath);
      const workspace = await ingestWorkspaceForUnbind(
        options.home,
        parsed.workspace,
        configurationPath,
      );
      const roots = new Set<string>();
      const missingProjects = new Set<string>();
      let match: UnbindMatch | undefined;

      for (const [index, binding] of parsed.bindings.entries()) {
        const bindingDescription = `${description} bindings[${index}]`;
        if (!workspace.profiles.has(binding.profile)) {
          throw new Error(
            `${bindingDescription} profile '${binding.profile}' does not exist in Workspace ${workspace.path}`,
          );
        }
        // Validate path syntax even for the missing-path recovery case.
        const expanded = expandConfiguredPath(
          binding.project,
          options.home,
          bindingDescription,
          "project",
        );
        if (await isMissingPath(expanded)) {
          if (missingProjects.has(binding.project)) {
            throw new Error(
              `${description} has ambiguous exact authored-path matches for '${binding.project}'`,
            );
          }
          missingProjects.add(binding.project);
          if (target.missing && binding.project === options.project) {
            match = {
              index,
              project: binding.project,
              profile: binding.profile,
              hosts: binding.hosts,
              recovery: "authored-path",
            };
          }
          continue;
        }

        const canonicalProject = await normalizeProject(
          binding.project,
          options.home,
          bindingDescription,
        );
        if (roots.has(canonicalProject)) {
          throw new Error(
            `${bindingDescription} project resolves to duplicate canonical root '${canonicalProject}'`,
          );
        }
        roots.add(canonicalProject);
        if (target.canonical === canonicalProject) {
          if (match) {
            throw new Error(
              `${description} has ambiguous canonical matches for '${canonicalProject}'`,
            );
          }
          match = {
            index,
            project: binding.project,
            canonicalProject,
            profile: binding.profile,
            hosts: binding.hosts,
            recovery: "canonical",
          };
        }
      }

      if (!match) {
        return {
          outcome: "unchanged",
          configurationPath,
          requestedProject: target.requested,
          ...(target.canonical === undefined ? {} : { canonicalProject: target.canonical }),
        };
      }

      const document = parseDocument(source);
      const bindingsNode = document.get("bindings");
      if (!isSeq(bindingsNode)) {
        throw new Error(`${description} bindings must be an array`);
      }
      const nextSource = removeBindingSource(source, bindingsNode, match.index);
      const sourceStats = await fileSystem.stat(configurationPath);
      const mode = sourceStats.mode & 0o777;
      await publishConfigurationReplacement(
        configurationPath,
        source,
        nextSource,
        mode,
        fileSystem,
        description,
        "unbind",
      );

      return {
        outcome: "removed",
        configurationPath,
        requestedProject: target.requested,
        project: match.project,
        ...(match.canonicalProject === undefined
          ? {}
          : { canonicalProject: match.canonicalProject }),
        profile: match.profile,
        hosts: match.hosts,
        recovery: match.recovery,
      };
    },
  );
}
