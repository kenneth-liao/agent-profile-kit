import { createHash } from "node:crypto";
import { isAbsolute, join, posix } from "node:path";

import {
  assertClaudeProjectCapability,
  CLAUDE_ADAPTER_VERSION,
  detectClaudeGlobalSkillOverlaps,
  planClaudeProject,
} from "../adapters/claude.js";
import {
  assertCodexProjectCapability,
  CODEX_ADAPTER_VERSION,
  detectCodexGlobalSkillOverlaps,
  planCodexProject,
} from "../adapters/codex.js";
import { skillsRequireDisabledModelInvocation } from "../adapters/skill-package.js";
import type {
  AdapterProjectPlan,
  ProposedDirectoryMember,
  ProposedProjectOutput,
  ProjectOutputEntryType,
} from "../adapters/project-plan.js";
import {
  type ProjectBinding,
  type SupportedHost,
} from "../schemas/local-configuration.js";
import {
  INSTALLATION_MARKER_PATH,
  parseFileMode,
  type OwnedDirectoryMember,
} from "../schemas/installation-manifest.js";
import { hashWorkspaceInputs } from "./hashes.js";
import { ingestApplication, stateDirectory } from "./local-configuration.js";
import { resolveProfileDependencies, type ResolvedProfile } from "./resolve-dependencies.js";
import { ENGINE_VERSION } from "./version.js";
import { findGitProject, type GitProject } from "./git.js";
import type { Profile } from "../schemas/context-profile.js";
import type { Workspace } from "./ingest-workspace.js";

export interface DesiredDirectoryFileMember {
  readonly bytes: string | Uint8Array;
  readonly hash: string;
  readonly mode: number;
  readonly path: string;
  readonly type: "file";
}

export interface DesiredDirectoryDirectoryMember {
  readonly mode: number;
  readonly path: string;
  readonly type: "directory";
}

export type DesiredDirectoryMember =
  | DesiredDirectoryDirectoryMember
  | DesiredDirectoryFileMember;

export interface DesiredProjectFileOutput {
  readonly bytes: string | Uint8Array;
  readonly consumingHosts: readonly string[];
  readonly hash: string;
  readonly mode: number;
  readonly path: string;
  readonly requirements: readonly string[];
  readonly type: "file";
}

export interface DesiredProjectDirectoryOutput {
  readonly consumingHosts: readonly string[];
  readonly hash: string;
  readonly members: readonly DesiredDirectoryMember[];
  readonly mode: number;
  readonly path: string;
  readonly requirements: readonly string[];
  readonly type: "directory";
}

export type DesiredProjectOutput =
  | DesiredProjectDirectoryOutput
  | DesiredProjectFileOutput;

export interface DesiredInstallation {
  readonly adapterVersion: string;
  readonly binding: ProjectBinding;
  readonly blockers: readonly string[];
  readonly engineVersion: string;
  readonly gitProject: GitProject | undefined;
  readonly hostVersions: Readonly<Record<string, string>>;
  readonly outputs: readonly DesiredProjectOutput[];
  readonly profile: Profile;
  readonly resolvedProfile: ResolvedProfile;
  readonly sourceHash: string;
  readonly warnings: readonly string[];
}

/** Deterministic multi-Adapter version token recorded on the Installation Manifest. */
export function adapterVersionFor(hosts: readonly SupportedHost[]): string {
  const versions = hosts.map((host) => {
    if (host === "claude") return CLAUDE_ADAPTER_VERSION;
    if (host === "codex") return CODEX_ADAPTER_VERSION;
    const exhaustive: never = host;
    throw new Error(`Unsupported Agent Host '${String(exhaustive)}'`);
  });
  return [...new Set(versions)].sort().join("+");
}

export interface DesiredState {
  readonly bindingCount: number;
  readonly installations: readonly DesiredInstallation[];
  readonly workspace: Workspace;
}

export function hashBytes(source: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function writeFrame(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

function exactBytesEqual(left: string | Uint8Array, right: string | Uint8Array): boolean {
  if (typeof left === "string" && typeof right === "string") return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

/** Deterministic content hash for one complete artifact directory. */
export function hashDirectoryMembers(
  members: readonly {
    readonly bytes?: string | Uint8Array;
    readonly mode: number;
    readonly path: string;
    readonly type: ProjectOutputEntryType;
  }[],
): string {
  const hash = createHash("sha256");
  for (const member of [...members].sort((left, right) => left.path.localeCompare(right.path))) {
    if (member.type === "directory") {
      writeFrame(hash, "directory");
      writeFrame(hash, member.path);
      writeFrame(hash, String(member.mode));
      continue;
    }
    if (member.bytes === undefined) {
      throw new Error(`Directory member '${member.path}' must provide exact regular-file bytes`);
    }
    writeFrame(hash, "file");
    writeFrame(hash, member.path);
    writeFrame(hash, String(member.mode));
    writeFrame(hash, member.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

export function ownedMembersFromDesired(
  members: readonly DesiredDirectoryMember[],
): readonly OwnedDirectoryMember[] {
  return members.map((member) =>
    member.type === "file"
      ? {
          hash: member.hash,
          mode: member.mode,
          path: member.path,
          type: "file" as const,
        }
      : {
          mode: member.mode,
          path: member.path,
          type: "directory" as const,
        },
  );
}

function normalizedOutputPath(path: string, description = "Adapter output path"): string {
  const slashPath = path.replaceAll("\\", "/");
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    /^[A-Za-z]:\//.test(slashPath) ||
    slashPath.startsWith("/") ||
    slashPath.split("/").some((part) => part === "" || part === "." || part === "..") ||
    posix.normalize(slashPath) !== slashPath
  ) {
    throw new Error(`${description} '${path}' must be a normalized project-relative path`);
  }
  return slashPath;
}

function membersEqual(
  left: readonly DesiredDirectoryMember[],
  right: readonly DesiredDirectoryMember[],
): boolean {
  if (left.length !== right.length) return false;
  for (const [index, member] of left.entries()) {
    const other = right[index];
    if (!other || member.type !== other.type || member.path !== other.path || member.mode !== other.mode) {
      return false;
    }
    if (member.type === "file" && other.type === "file" && !exactBytesEqual(member.bytes, other.bytes)) {
      return false;
    }
  }
  return true;
}

function outputDifference(
  left: DesiredProjectOutput,
  right: DesiredProjectOutput,
): string | undefined {
  if (left.type !== right.type) return "entry type";
  if (left.mode !== right.mode) return "mode";
  if (left.requirements.join("\n") !== right.requirements.join("\n")) return "semantic requirements";
  if (left.type === "file" && right.type === "file") {
    if (!exactBytesEqual(left.bytes, right.bytes)) return "bytes";
    return undefined;
  }
  if (left.type === "directory" && right.type === "directory") {
    if (!membersEqual(left.members, right.members)) return "directory members";
    return undefined;
  }
  return "entry type";
}

function assertNoAncestorCollisions(outputs: readonly DesiredProjectOutput[]): void {
  const sorted = [...outputs].sort((left, right) => left.path.localeCompare(right.path));
  for (const [index, output] of sorted.entries()) {
    for (const nested of sorted.slice(index + 1)) {
      if (nested.path.startsWith(`${output.path}/`)) {
        throw new Error(
          `Adapter output structural collision: ${output.type} '${output.path}' is an ancestor of '${nested.path}'`,
        );
      }
    }
    if (INSTALLATION_MARKER_PATH.startsWith(`${output.path}/`)) {
      throw new Error(
        `Adapter output structural collision: ${output.type} '${output.path}' is an ancestor of Installer-owned '${INSTALLATION_MARKER_PATH}'`,
      );
    }
    if (output.path.startsWith(`${INSTALLATION_MARKER_PATH}/`)) {
      throw new Error(
        `Adapter output structural collision: Installer-owned file '${INSTALLATION_MARKER_PATH}' is an ancestor of '${output.path}'`,
      );
    }
  }
}

function assertNoMemberAncestorCollisions(
  members: readonly DesiredDirectoryMember[],
  directoryPath: string,
): void {
  const sorted = [...members].sort((left, right) => left.path.localeCompare(right.path));
  for (const [index, member] of sorted.entries()) {
    if (member.type !== "file") continue;
    for (const nested of sorted.slice(index + 1)) {
      if (nested.path.startsWith(`${member.path}/`)) {
        throw new Error(
          `Adapter output '${directoryPath}' member structural collision: file '${member.path}' is an ancestor of '${nested.path}'`,
        );
      }
    }
  }
}

function normalizeDirectoryMembers(
  members: readonly ProposedDirectoryMember[],
  directoryPath: string,
): readonly DesiredDirectoryMember[] {
  const normalized = new Map<string, DesiredDirectoryMember>();
  for (const proposed of members) {
    const path = normalizedOutputPath(
      proposed.path,
      `Adapter output '${directoryPath}' member path`,
    );
    if (proposed.type === "file") {
      if (typeof proposed.bytes !== "string" && !(proposed.bytes instanceof Uint8Array)) {
        throw new Error(
          `Adapter output '${directoryPath}' member '${path}' must provide exact regular-file bytes`,
        );
      }
      const member: DesiredDirectoryFileMember = {
        bytes: proposed.bytes,
        hash: hashBytes(proposed.bytes),
        mode: parseFileMode(proposed.mode, `Adapter output '${directoryPath}' member '${path}' mode`),
        path,
        type: "file",
      };
      if (normalized.has(path)) {
        throw new Error(
          `Adapter output '${directoryPath}' contains duplicate member path '${path}'`,
        );
      }
      normalized.set(path, member);
      continue;
    }
    if (proposed.type === "directory") {
      const member: DesiredDirectoryDirectoryMember = {
        mode: parseFileMode(proposed.mode, `Adapter output '${directoryPath}' member '${path}' mode`),
        path,
        type: "directory",
      };
      if (normalized.has(path)) {
        throw new Error(
          `Adapter output '${directoryPath}' contains duplicate member path '${path}'`,
        );
      }
      normalized.set(path, member);
      continue;
    }
    throw new Error(
      `Adapter output '${directoryPath}' member '${path}' has unsupported entry type '${(proposed as { type: string }).type}'`,
    );
  }
  // Infer intermediate directories so ownership records the complete tree without
  // requiring Adapters to restate parents that only exist to hold nested files.
  for (const member of [...normalized.values()]) {
    const parts = member.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      const existing = normalized.get(parent);
      if (!existing) {
        normalized.set(parent, { mode: 0o755, path: parent, type: "directory" });
        continue;
      }
      if (existing.type === "file") {
        throw new Error(
          `Adapter output '${directoryPath}' member structural collision: file '${parent}' is an ancestor of '${member.path}'`,
        );
      }
    }
  }
  const list = [...normalized.values()].sort((left, right) => left.path.localeCompare(right.path));
  assertNoMemberAncestorCollisions(list, directoryPath);
  return list;
}

function normalizeProposedOutput(
  proposed: ProposedProjectOutput,
  host: string,
): DesiredProjectOutput {
  const path = normalizedOutputPath(proposed.path);
  if (path === INSTALLATION_MARKER_PATH) {
    throw new Error(
      `Adapter output path '${path}' is reserved for the Installer-owned Installation Marker`,
    );
  }
  const requirements = [...new Set(proposed.requirements)].sort();
  const mode = parseFileMode(proposed.mode, `Adapter output '${path}' mode`);
  if (proposed.type === "file") {
    if (typeof proposed.bytes !== "string" && !(proposed.bytes instanceof Uint8Array)) {
      throw new Error(`Adapter output '${path}' must provide exact regular-file bytes`);
    }
    return {
      bytes: proposed.bytes,
      consumingHosts: [host],
      hash: hashBytes(proposed.bytes),
      mode,
      path,
      requirements,
      type: "file",
    };
  }
  if (proposed.type === "directory") {
    if (!Array.isArray(proposed.members)) {
      throw new Error(
        `Adapter output '${path}' directory must provide a complete members list`,
      );
    }
    const members = normalizeDirectoryMembers(proposed.members, path);
    return {
      consumingHosts: [host],
      hash: hashDirectoryMembers(members),
      members,
      mode,
      path,
      requirements,
      type: "directory",
    };
  }
  throw new Error(
    `Adapter output '${path}' has unsupported entry type '${(proposed as { type: string }).type}'`,
  );
}

/** Normalize all Host plans once at the Installer boundary. */
export function normalizeAdapterPlans(
  plans: readonly AdapterProjectPlan[],
): readonly DesiredProjectOutput[] {
  const outputs = new Map<string, DesiredProjectOutput>();
  for (const plan of [...plans].sort((left, right) => left.host.localeCompare(right.host))) {
    for (const proposed of plan.outputs) {
      const normalized = normalizeProposedOutput(proposed, plan.host);
      const existing = outputs.get(normalized.path);
      if (!existing) {
        outputs.set(normalized.path, normalized);
        continue;
      }
      const difference = outputDifference(existing, normalized);
      if (difference) {
        throw new Error(
          `Adapter output collision at '${normalized.path}': ${difference} disagrees between consuming Hosts ${[...existing.consumingHosts, plan.host].sort().join(", ")}`,
        );
      }
      const hosts = [...new Set([...existing.consumingHosts, plan.host])].sort();
      outputs.set(normalized.path, { ...existing, consumingHosts: hosts });
    }
  }
  const normalized = [...outputs.values()].sort((left, right) => left.path.localeCompare(right.path));
  assertNoAncestorCollisions(normalized);
  return normalized;
}

export async function buildDesiredState(
  home: string,
  options: { readonly checkHostCapability?: boolean } = {},
): Promise<DesiredState> {
  const { configuration, workspace } = await ingestApplication(home);
  const installations: DesiredInstallation[] = [];
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
    if (profile.agents.length > 0 || profile.hooks.length > 0 || profile.tools.length > 0) {
      throw new Error(
        `Profile '${profile.id}' selects unsupported artifact categories; Agents, Hooks, and Tools are not supported in the project-bound slice`,
      );
    }
    const gitProject = await findGitProject(binding.canonicalProject);
    const sourceHash = await hashWorkspaceInputs(profile, resolvedProfile);
    const blockers: string[] = [];
    const plans: AdapterProjectPlan[] = [];
    const hostVersions: Record<string, string> = {};
    const warnings: string[] = [];
    const requireDisabledModelInvocation = skillsRequireDisabledModelInvocation(
      resolvedProfile.skills,
    );
    // Capability and planning follow selected categories: Context machinery is optional.
    const requireContext = resolvedProfile.contexts.length > 0;
    const selectedSkillIds = resolvedProfile.skills.map((skill) => skill.id);
    for (const host of binding.hosts) {
      if (options.checkHostCapability !== false) {
        try {
          if (host === "codex") {
            await assertCodexProjectCapability(home, binding.canonicalProject, {
              requireContext,
              requireDisabledModelInvocation,
            });
          } else if (host === "claude") {
            await assertClaudeProjectCapability(binding.canonicalProject, {
              requireContext,
              requireDisabledModelInvocation,
            });
          }
        } catch (error) {
          blockers.push(
            `${binding.project}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // Global Skill identity overlap is independent of CLI capability probes and must
      // run for status as well as preview/apply so later global delivery is reported.
      if (host === "codex") {
        blockers.push(
          ...(await detectCodexGlobalSkillOverlaps(home, selectedSkillIds, {
            project: binding.canonicalProject,
          })).map((message) => `${binding.project}: ${message}`),
        );
      } else if (host === "claude") {
        blockers.push(
          ...(await detectClaudeGlobalSkillOverlaps(home, selectedSkillIds, {
            project: binding.canonicalProject,
          })).map((message) => `${binding.project}: ${message}`),
        );
      }
      if (host === "codex") {
        const contextPath = [
          gitProject?.relativeProject ?? "",
          ".agent-profile-kit",
          "codex",
          "context.md",
        ].filter((part) => part.length > 0).join("/");
        const adapterPlan = await planCodexProject(
          profile.id,
          resolvedProfile.contexts,
          resolvedProfile.skills,
          { contextPath },
        );
        plans.push(adapterPlan);
        hostVersions.codex = adapterPlan.hostVersion;
        // Context snapshot path is Git-root-relative; Skills-only installs need no launch warning.
        if (!gitProject && requireContext) {
          warnings.push(
            `${binding.project} is not a Git worktree; Codex must start at the exact bound project root for native Context discovery`,
          );
        }
        continue;
      }
      if (host === "claude") {
        const adapterPlan = await planClaudeProject(
          profile.id,
          resolvedProfile.contexts,
          resolvedProfile.skills,
        );
        plans.push(adapterPlan);
        hostVersions.claude = adapterPlan.hostVersion;
        continue;
      }
      const exhaustive: never = host;
      throw new Error(`Unsupported Agent Host '${String(exhaustive)}'`);
    }
    installations.push({
      adapterVersion: adapterVersionFor(binding.hosts),
      binding,
      blockers,
      engineVersion: ENGINE_VERSION,
      gitProject,
      hostVersions,
      outputs: normalizeAdapterPlans(plans),
      profile,
      resolvedProfile,
      sourceHash,
      warnings,
    });
  }
  return {
    bindingCount: configuration.bindings.length,
    installations: installations.sort((left, right) =>
      left.binding.canonicalProject.localeCompare(right.binding.canonicalProject)
    ),
    workspace,
  };
}

export { stateDirectory };

export function stateManifestPath(home: string): string {
  return join(stateDirectory(home), "manifest.yaml");
}

export function markerPath(project: string): string {
  return join(project, ".agent-profile-kit", "installation.json");
}

export function outputPath(project: string, output: { readonly path: string }): string {
  return join(project, output.path);
}
