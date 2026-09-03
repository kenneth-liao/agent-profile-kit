import { lstat } from "node:fs/promises";
import { isSeq, parseDocument } from "yaml";

import {
  defaultFileSystem,
  DEFAULT_LOCK_TIMEOUT_MS,
  hasHeldResidue,
  pathExists,
  publishConfigurationReplacement,
  recoverHeldConfiguration,
  type LocalConfigurationFileSystem,
  withConfigurationLock,
} from "./local-configuration-publication.js";
import {
  canonicalizePathForComparison,
  expandConfiguredPath,
  ingestApplicationModelFromSource,
  localConfigurationPath,
  normalizeProject,
  requireExistingDirectory,
} from "./local-configuration.js";
import { readInstallationState, writeInstallationState } from "./installation-state.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import { MissingProfileError } from "./profile-selection.js";
import {
  asInstallerAuthoredError,
  InstallerToolError,
  type ConfiguredPathOrigin,
} from "./tool-errors.js";

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
  origin: ConfiguredPathOrigin,
): Promise<UnbindTarget> {
  const cwd = options.cwd ?? process.cwd();
  if (options.project === undefined) {
    return {
      requested: cwd,
      canonical: await requireExistingDirectory(cwd, cwd, origin, "project"),
      missing: false,
    };
  }

  const expanded = expandConfiguredPath(options.project, options.home, origin, "project");
  if (await isMissingPath(expanded)) {
    return { requested: options.project, missing: true };
  }
  return {
    requested: options.project,
    canonical: await normalizeProject(options.project, options.home, origin),
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
  readonly fileSystem?: LocalConfigurationFileSystem;
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
      readonly generatedOutputSurvives: boolean;
    }
  | {
      readonly outcome: "removed";
      readonly configurationPath: string;
      readonly requestedProject: string;
      readonly project: string;
      readonly profile: string;
      readonly hosts: readonly string[];
      readonly recovery: "authored-path";
      readonly generatedOutputSurvives: boolean;
    }
  | {
      readonly outcome: "unchanged";
      readonly configurationPath: string;
      readonly requestedProject: string;
      readonly canonicalProject?: string;
    };

/**
 * Retire the active ordinary Installation Receipt naming one canonical Project:
 * the receipt keeps exactly its previously recorded detail but is marked
 * retired, so no active receipt can outlive its binding while a later `apply`
 * keeps the teardown authority it needs to prove and remove the surviving
 * generated output. Temporary receipts and removed-temporary identities are
 * preserved. Serialized against apply and uninstall through the installation
 * lifecycle lock; unbind already holds the Local Configuration lock and no
 * command acquires the two locks in the opposite order.
 *
 * Returns whether an active receipt named the Project — the generated-output
 * survival fact for unbind's next-step guidance, read at the only moment it is
 * still observable.
 */
async function retireActiveReceipt(
  home: string,
  project: string,
): Promise<{ readonly generatedOutputSurvives: boolean }> {
  const state = await readInstallationState(home);
  const retiredIds = new Set(
    state.receipts
      .filter((receipt) => receipt.lifetime === "ordinary" && receipt.project === project)
      .map((receipt) => receipt.installationId),
  );
  if (retiredIds.size === 0) return { generatedOutputSurvives: false };
  const after = {
    ...state,
    receipts: state.receipts.map((receipt) =>
      retiredIds.has(receipt.installationId) ? { ...receipt, retired: true as const } : receipt
    ),
  };
  await writeInstallationState(home, after);
  return { generatedOutputSurvives: true };
}

/**
 * Remove one Project Binding from Local Configuration and retire that Project's
 * active Installation Receipt in the same operation, so no receipt can outlive
 * the binding that created it (DEC-006). Generated output is never reconciled.
 * Existing paths match by canonical identity; a missing path matches only its
 * exact authored spelling already present in Local Configuration.
 */
export async function unbindProject(
  options: UnbindProjectOptions,
): Promise<UnbindProjectResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const configurationPath = localConfigurationPath(options.home);
  const origin: ConfiguredPathOrigin = {
    source: "local-configuration",
    configurationPath,
  };
  const target = await resolveUnbindTarget(options, origin);

  if (!(await pathExists(fileSystem, configurationPath))) {
    if (!(await hasHeldResidue(configurationPath, fileSystem))) {
      throw new InstallerToolError({
        kind: "missing-local-configuration",
        path: configurationPath,
      });
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
          throw new InstallerToolError({
            kind: "missing-local-configuration",
            path: configurationPath,
          });
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
        if (error instanceof MissingProfileError) {
          throw new MissingProfileError(error.profile, error.availableProfiles, true);
        }
        // The hand-edit fallback composes around the typed cause; identity
        // stays a typed field, not text stripped back out of a sentence.
        // Foreign runtime/OS causes normalize as foreign-diagnostic evidence so
        // every cause keeps the presentation-owned recovery clause.
        const cause = asInstallerAuthoredError(error) ??
          new InstallerToolError({
            kind: "foreign-diagnostic",
            detail: error instanceof Error ? error.message : String(error),
          });
        throw new InstallerToolError({ kind: "stale-binding-removal", cause });
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
        // Defensive: the exact snapshot was already parsed as an array.
        throw new Error("Local Configuration bindings must be an array");
      }
      // Retirement and binding publication share one lifecycle-serialized
      // transaction, retired before published: a failure from here on can
      // leave a binding whose receipt is retired (the next apply reconciles
      // it) but never an active receipt outliving its binding. Malformed
      // Installation State fails unbind before any mutation.
      const receiptProject = match.recovery === "canonical"
        ? match.canonicalProject
        : await canonicalizePathForComparison(
            expandConfiguredPath(match.project, options.home, { source: "project-binding" }, "project"),
          );
      return withInstallationLifecycleLock(options.home, "unbind", async () => {
        const original = await readInstallationState(options.home);
        const { generatedOutputSurvives } = await retireActiveReceipt(options.home, receiptProject);
        try {
          const nextSource = removeBindingSource(source, bindingsNode, match.index);
          const sourceStats = await fileSystem.stat(configurationPath);
          const mode = sourceStats.mode & 0o777;
          await publishConfigurationReplacement(
            configurationPath,
            source,
            nextSource,
            mode,
            fileSystem,
            `Local Configuration ${configurationPath}`,
            "unbind",
          );
        } catch (error) {
          // Roll the retirement back so a failed unbind mutates nothing.
          let stateRestoreFailure: unknown;
          try {
            await writeInstallationState(options.home, original);
          } catch (failure) {
            stateRestoreFailure = failure;
          }
          const failureMessage = error instanceof Error ? error.message : String(error);
          if (stateRestoreFailure !== undefined) {
            throw new Error(
              `${failureMessage}\nInstallation State restore failed: ${
                stateRestoreFailure instanceof Error
                  ? stateRestoreFailure.message
                  : String(stateRestoreFailure)
              }`,
            );
          }
          throw error;
        }
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
            generatedOutputSurvives,
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
          generatedOutputSurvives,
        };
      });
    },
  );
}
