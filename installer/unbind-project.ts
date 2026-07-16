import { lstat } from "node:fs/promises";
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
  ingestApplicationModelFromSource,
  localConfigurationPath,
  normalizeProject,
  requireExistingDirectory,
} from "./local-configuration.js";

interface UnbindTarget {
  readonly requested: string;
  readonly canonical?: string;
  readonly missing: boolean;
}

type UnbindMatch =
  | {
      readonly index: number;
      readonly project: string;
      readonly canonicalProject: string;
      readonly profile: string;
      readonly hosts: readonly string[];
      readonly recovery: "canonical";
    }
  | {
      readonly index: number;
      readonly project: string;
      readonly profile: string;
      readonly hosts: readonly string[];
      readonly recovery: "authored-path";
    };

interface RangedYamlNode {
  readonly range?: readonly [number, number, number];
  readonly commentBefore?: string | null;
}

/**
 * Remove only the selected source range. YAML Document serialization normalizes
 * untouched flow/inline formatting, so byte-range removal is the deliberate
 * preservation path for unbind; its flow, block, CRLF, and mode cases are packed
 * CLI tested below.
 */
function removeBindingSource(
  source: string,
  bindingsNode: {
    readonly flow?: boolean;
    readonly items: readonly unknown[];
    readonly commentBefore?: string | null;
  },
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

  let lineStart = source.lastIndexOf("\n", range[0] - 1) + 1;
  const commentBefore = item.commentBefore ?? (index === 0 ? bindingsNode.commentBefore : undefined);
  if (commentBefore) {
    for (const comment of commentBefore.split(/\r?\n/).reverse()) {
      const previousStart = source.lastIndexOf("\n", lineStart - 2) + 1;
      const previousLine = source
        .slice(previousStart, lineStart)
        .replace(/\r?\n$/, "")
        .trim();
      if (previousLine !== `#${comment}`) break;
      lineStart = previousStart;
    }
  }
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

export type UnbindProjectResult =
  | {
      readonly outcome: "removed";
      readonly configurationPath: string;
      readonly requestedProject: string;
      readonly project: string;
      readonly canonicalProject: string;
      readonly profile: string;
      readonly hosts: readonly string[];
      readonly recovery: "canonical";
    }
  | {
      readonly outcome: "removed";
      readonly configurationPath: string;
      readonly requestedProject: string;
      readonly project: string;
      readonly profile: string;
      readonly hosts: readonly string[];
      readonly recovery: "authored-path";
    }
  | {
      readonly outcome: "unchanged";
      readonly configurationPath: string;
      readonly requestedProject: string;
      readonly canonicalProject?: string;
    };

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

      let model;
      try {
        model = await ingestApplicationModelFromSource(
          options.home,
          source,
          configurationPath,
          { allowMissingProjects: true },
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${detail}; edit Local Configuration directly if this stale or malformed binding must be removed`,
        );
      }

      let match: UnbindMatch | undefined;
      for (const binding of model.bindings) {
        if (binding.missing) {
          if (target.missing && binding.project === options.project) {
            match = {
              index: binding.index,
              project: binding.project,
              profile: binding.profile,
              hosts: binding.hosts,
              recovery: "authored-path",
            };
          }
          continue;
        }
        if (
          target.canonical !== undefined &&
          binding.canonicalProject === target.canonical
        ) {
          match = {
            index: binding.index,
            project: binding.project,
            canonicalProject: binding.canonicalProject,
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

      if (match.recovery === "canonical") {
        return {
          outcome: "removed",
          configurationPath,
          requestedProject: target.requested,
          project: match.project,
          canonicalProject: match.canonicalProject,
          profile: match.profile,
          hosts: match.hosts,
          recovery: "canonical",
        };
      }
      return {
        outcome: "removed",
        configurationPath,
        requestedProject: target.requested,
        project: match.project,
        profile: match.profile,
        hosts: match.hosts,
        recovery: "authored-path",
      };
    },
  );
}
