import { createHash } from "node:crypto";
import { isAbsolute, join, posix } from "node:path";

import {
  assertCodexProjectCapability,
  planCodexProject,
} from "../adapters/codex.js";
import type { AdapterProjectPlan, ProjectOutputEntryType } from "../adapters/project-plan.js";
import { type ProjectBinding } from "../schemas/local-configuration.js";
import {
  INSTALLATION_MARKER_PATH,
  parseFileMode,
} from "../schemas/installation-manifest.js";
import { hashWorkspaceInputs } from "./hashes.js";
import { ingestApplication } from "./local-configuration.js";
import { resolveProfileDependencies, type ResolvedProfile } from "./resolve-dependencies.js";
import { ENGINE_VERSION } from "./version.js";
import { findGitProject, listGitProjectCheckouts, type GitProject } from "./git.js";
import type { Profile } from "../schemas/context-profile.js";
import type { Workspace } from "./ingest-workspace.js";

export interface DesiredProjectOutput {
  readonly bytes: string;
  readonly consumingHosts: readonly string[];
  readonly hash: string;
  readonly mode: number;
  readonly path: string;
  readonly requirements: readonly string[];
  readonly type: ProjectOutputEntryType;
}

export interface DesiredInstallation {
  readonly binding: ProjectBinding;
  readonly blockers: readonly string[];
  readonly engineVersion: string;
  readonly hostVersion: string;
  readonly gitProject: GitProject | undefined;
  readonly outputs: readonly DesiredProjectOutput[];
  readonly profile: Profile;
  readonly resolvedProfile: ResolvedProfile;
  readonly sourceHash: string;
  readonly warnings: readonly string[];
}

export interface DesiredState {
  readonly bindingCount: number;
  readonly installations: readonly DesiredInstallation[];
  readonly workspace: Workspace;
}

export function hashBytes(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function normalizedOutputPath(path: string): string {
  const slashPath = path.replaceAll("\\", "/");
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//.test(slashPath) ||
    slashPath.startsWith("/") ||
    slashPath.split("/").some((part) => part === "" || part === "." || part === "..") ||
    posix.normalize(slashPath) !== slashPath
  ) {
    throw new Error(`Adapter output path '${path}' must be a normalized project-relative path`);
  }
  return slashPath;
}

function outputDifference(
  left: DesiredProjectOutput,
  right: Omit<DesiredProjectOutput, "consumingHosts">,
): string | undefined {
  if (left.type !== right.type) return "entry type";
  if (left.mode !== right.mode) return "mode";
  if (left.bytes !== right.bytes) return "bytes";
  if (left.requirements.join("\n") !== right.requirements.join("\n")) return "semantic requirements";
  return undefined;
}

function assertNoFileAncestorCollisions(outputs: readonly DesiredProjectOutput[]): void {
  const files = outputs
    .filter((output) => output.type === "file")
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const [index, output] of files.entries()) {
    for (const nested of files.slice(index + 1)) {
      if (nested.path.startsWith(`${output.path}/`)) {
        throw new Error(
          `Adapter output structural collision: file '${output.path}' is an ancestor of '${nested.path}'`,
        );
      }
    }
    if (INSTALLATION_MARKER_PATH.startsWith(`${output.path}/`)) {
      throw new Error(
        `Adapter output structural collision: file '${output.path}' is an ancestor of Installer-owned '${INSTALLATION_MARKER_PATH}'`,
      );
    }
    if (output.path.startsWith(`${INSTALLATION_MARKER_PATH}/`)) {
      throw new Error(
        `Adapter output structural collision: Installer-owned file '${INSTALLATION_MARKER_PATH}' is an ancestor of '${output.path}'`,
      );
    }
  }
}

/** Normalize all Host plans once at the Installer boundary. */
export function normalizeAdapterPlans(
  plans: readonly AdapterProjectPlan[],
): readonly DesiredProjectOutput[] {
  const outputs = new Map<string, DesiredProjectOutput>();
  for (const plan of [...plans].sort((left, right) => left.host.localeCompare(right.host))) {
    for (const proposed of plan.outputs) {
      const path = normalizedOutputPath(proposed.path);
      if (path === INSTALLATION_MARKER_PATH) {
        throw new Error(
          `Adapter output path '${path}' is reserved for the Installer-owned Installation Marker`,
        );
      }
      const requirements = [...new Set(proposed.requirements)].sort();
      const normalized = {
        bytes: proposed.bytes,
        hash: hashBytes(proposed.bytes),
        mode: parseFileMode(proposed.mode, `Adapter output '${path}' mode`),
        path,
        requirements,
        type: proposed.type,
      } as const;
      const existing = outputs.get(path);
      if (!existing) {
        outputs.set(path, { ...normalized, consumingHosts: [plan.host] });
        continue;
      }
      const difference = outputDifference(existing, normalized);
      if (difference) {
        throw new Error(
          `Adapter output collision at '${path}': ${difference} disagrees between consuming Hosts ${[...existing.consumingHosts, plan.host].sort().join(", ")}`,
        );
      }
      outputs.set(path, {
        ...existing,
        consumingHosts: [...new Set([...existing.consumingHosts, plan.host])].sort(),
      });
    }
  }
  const normalized = [...outputs.values()].sort((left, right) => left.path.localeCompare(right.path));
  assertNoFileAncestorCollisions(normalized);
  const unsupported = normalized.find((output) => output.type !== "file");
  if (unsupported) {
    throw new Error(
      `Adapter output '${unsupported.path}' has unsupported entry type '${unsupported.type}'`,
    );
  }
  return normalized;
}

export async function buildDesiredState(
  home: string,
  options: { readonly checkHostCapability?: boolean } = {},
): Promise<DesiredState> {
  const { configuration, workspace } = await ingestApplication(home);
  const installations: DesiredInstallation[] = [];
  const expandedRoots = new Map<string, ProjectBinding>();
  for (const binding of [...configuration.bindings].sort((left, right) =>
    left.canonicalProject.localeCompare(right.canonicalProject)
  )) {
    const profile = workspace.profiles.get(binding.profile);
    if (!profile) {
      throw new Error(
        `Project Binding for '${binding.project}' selects missing Profile '${binding.profile}'`,
      );
    }
    const resolvedProfile = resolveProfileDependencies(
      profile,
      workspace.contexts,
      workspace.skills,
    );
    if (resolvedProfile.skills.length > 0) {
      throw new Error(
        `Profile '${profile.id}' selects Skills, which the Context-only Codex project slice does not support; remove Skills from the Profile before applying`,
      );
    }
    if (profile.agents.length > 0 || profile.hooks.length > 0 || profile.tools.length > 0) {
      throw new Error(
        `Profile '${profile.id}' selects unsupported artifact categories; Agents, Hooks, and Tools are not supported in the Context-only Codex project slice`,
      );
    }
    const gitProject = await findGitProject(binding.canonicalProject);
    const sourceHash = await hashWorkspaceInputs(profile, resolvedProfile);
    const expanded = gitProject
      ? (await listGitProjectCheckouts(gitProject)).map((checkout) => ({
          binding: { ...binding, canonicalProject: checkout.project, project: checkout.project },
          gitProject: checkout,
        }))
      : [{ binding, gitProject: undefined }];
    for (const target of expanded) {
      const existing = expandedRoots.get(target.binding.canonicalProject);
      if (existing) {
        if (
          existing.profile !== target.binding.profile ||
          existing.hosts.join("\n") !== target.binding.hosts.join("\n")
        ) {
          throw new Error(
            `Git worktree expansion maps conflicting Project Bindings to '${target.binding.canonicalProject}'`,
          );
        }
        continue;
      }
      expandedRoots.set(target.binding.canonicalProject, target.binding);
      const blockers: string[] = [];
      if (options.checkHostCapability !== false) {
        try {
          await assertCodexProjectCapability(home, target.binding.canonicalProject);
        } catch (error) {
          blockers.push(
            `${target.binding.project}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const contextPath = [
        target.gitProject?.relativeProject ?? "",
        ".agent-profile-kit",
        "codex",
        "context.md",
      ].filter((part) => part.length > 0).join("/");
      const adapterPlan = planCodexProject(profile.id, resolvedProfile.contexts, { contextPath });
      installations.push({
        binding: target.binding,
        blockers,
        engineVersion: ENGINE_VERSION,
        gitProject: target.gitProject,
        hostVersion: adapterPlan.hostVersion,
        outputs: normalizeAdapterPlans([adapterPlan]),
        profile,
        resolvedProfile,
        sourceHash,
        warnings: target.gitProject
          ? []
          : [`${target.binding.project} is not a Git worktree; Codex must start at the exact bound project root for native Context discovery`],
      });
    }
  }
  return {
    bindingCount: configuration.bindings.length,
    installations: installations.sort((left, right) =>
      left.binding.canonicalProject.localeCompare(right.binding.canonicalProject)
    ),
    workspace,
  };
}

export function stateDirectory(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state");
}

export function stateManifestPath(home: string): string {
  return join(stateDirectory(home), "manifest.yaml");
}

export function markerPath(project: string): string {
  return join(project, ".agent-profile-kit", "installation.json");
}

export function outputPath(project: string, output: { readonly path: string }): string {
  return join(project, output.path);
}
