import { createHash } from "node:crypto";
import { isAbsolute, join, posix } from "node:path";

import {
  assertClaudeProjectCapability,
  CLAUDE_ADAPTER_VERSION,
  planClaudeProject,
} from "../adapters/claude.js";
import {
  assertCodexProjectCapability,
  CODEX_ADAPTER_VERSION,
  detectCodexProjectConfigurationWarnings,
  planCodexProject,
} from "../adapters/codex.js";
import {
  assertGrokProjectCapability,
  detectGrokProjectConfigurationWarnings,
  GROK_ADAPTER_VERSION,
  grokClaudeRulesTopologyCapabilityError,
  inferGrokClaudeRulesEnabledFromOutputs,
  inspectGrokProject,
  planGrokProject,
  type GrokInspection,
} from "../adapters/grok.js";
import {
  assertPiProjectCapability,
  detectPiSkillSettingsWarnings,
  PI_ADAPTER_VERSION,
  planPiProject,
} from "../adapters/pi.js";
import { skillsRequireDisabledModelInvocation } from "../adapters/skill-package.js";
import type {
  AdapterDiagnosticWarning,
  AdapterProjectPlan,
  HostSetupStep,
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
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";
import {
  ARTIFACT_TYPES,
  artifactReferenceKey,
  requireArtifactId,
  type ArtifactReference,
  type ArtifactType,
} from "../schemas/dependencies.js";
import { type ResolvedArtifactFingerprint } from "./hashes.js";
import { ingestApplication, stateDirectory } from "./local-configuration.js";
import {
  createLifecyclePlanningContext,
  type LifecyclePlanningInstrumentation,
} from "./lifecycle-planning.js";
import {
  createLifecycleGitInspectionContext,
  type LifecycleGitInspection,
} from "./lifecycle-git-inspection.js";
import { requireProfile } from "./profile-selection.js";
import { type ResolvedProfile } from "./resolve-dependencies.js";
import { ENGINE_VERSION } from "./version.js";
import type { GitProject } from "./git.js";
import type { Profile } from "../schemas/context-profile.js";
import type { Workspace } from "./ingest-workspace.js";
import { hostCapabilityBlocker, type BlockerInput } from "./blockers.js";

export type { LifecyclePlanningInstrumentation } from "./lifecycle-planning.js";
export type { LifecycleGitInspection } from "./lifecycle-git-inspection.js";

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
  readonly origins: readonly ArtifactReference[];
  readonly path: string;
  readonly requirements: readonly string[];
  readonly type: "file";
}

export interface DesiredProjectDirectoryOutput {
  readonly consumingHosts: readonly string[];
  readonly hash: string;
  readonly members: readonly DesiredDirectoryMember[];
  readonly mode: number;
  readonly origins: readonly ArtifactReference[];
  readonly path: string;
  readonly requirements: readonly string[];
  readonly type: "directory";
}

export type DesiredProjectOutput =
  | DesiredProjectDirectoryOutput
  | DesiredProjectFileOutput;

export interface DesiredInstallation {
  readonly adapterVersion: string;
  /** Normalized canonical source fingerprints for every resolved artifact. */
  readonly artifactFingerprints: readonly ResolvedArtifactFingerprint[];
  readonly binding: ProjectBinding;
  readonly blockers: readonly BlockerInput[];
  readonly engineVersion: string;
  readonly gitProject: GitProject | undefined;
  readonly hostVersions: Readonly<Record<string, string>>;
  readonly outputs: readonly DesiredProjectOutput[];
  readonly profile: Profile;
  readonly resolvedProfile: ResolvedProfile;
  readonly sourceHash: string;
  readonly setupSteps: readonly HostSetupStep[];
  /** Structured values referenced by adapter-authored warnings. */
  readonly diagnosticValues: readonly string[];
  readonly warnings: readonly string[];
}

/** Normalize Adapter-authored diagnostics into the legacy text and typed value projections. */
export function appendDiagnosticWarnings(
  warnings: string[],
  diagnosticValues: string[],
  diagnostics: readonly AdapterDiagnosticWarning[],
  projectPrefix?: string,
): void {
  for (const diagnostic of diagnostics) {
    warnings.push(
      projectPrefix === undefined
        ? diagnostic.message
        : `${projectPrefix}: ${diagnostic.message}`,
    );
    diagnosticValues.push(...diagnostic.copyableValues);
  }
}

/** Deterministic multi-Adapter version token recorded on the Installation Manifest. */
export function adapterVersionFor(hosts: readonly SupportedHost[]): string {
  const versions = hosts.map((host) => {
    if (host === "claude") return CLAUDE_ADAPTER_VERSION;
    if (host === "codex") return CODEX_ADAPTER_VERSION;
    if (host === "grok") return GROK_ADAPTER_VERSION;
    if (host === "pi") return PI_ADAPTER_VERSION;
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
  if (!sameOrigins(left.origins, right.origins)) return "source origins";
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

/** Validate canonical Artifact source origins declared by an Adapter plan. */
function normalizeOutputOrigins(
  origins: readonly ArtifactReference[],
  path: string,
): readonly ArtifactReference[] {
  if (!Array.isArray(origins)) {
    throw new Error(`Adapter output '${path}' must declare typed source origins`);
  }
  const normalized = origins.map((origin, index) => {
    const description = `Adapter output '${path}' origin[${index}]`;
    if (typeof origin !== "object" || origin === null || Array.isArray(origin)) {
      throw new Error(`${description} must be a canonical Artifact reference`);
    }
    const reference = origin as ArtifactReference;
    if (!ARTIFACT_TYPES.includes(reference.type as ArtifactType)) {
      throw new Error(`${description} type must be one of: ${ARTIFACT_TYPES.join(", ")}`);
    }
    return {
      id: requireArtifactId(reference.id, `${description} id`),
      type: reference.type,
    };
  });
  const keys = normalized.map(artifactReferenceKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error(
      `Adapter output '${path}' must not declare an Artifact origin more than once`,
    );
  }
  return normalized;
}

function sameOrigins(
  left: readonly ArtifactReference[],
  right: readonly ArtifactReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every((origin, index) => artifactReferenceKey(origin) === artifactReferenceKey(right[index]!))
  );
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
  const origins = normalizeOutputOrigins(proposed.origins, path);
  if (proposed.type === "file") {
    if (typeof proposed.bytes !== "string" && !(proposed.bytes instanceof Uint8Array)) {
      throw new Error(`Adapter output '${path}' must provide exact regular-file bytes`);
    }
    return {
      bytes: proposed.bytes,
      consumingHosts: [host],
      hash: hashBytes(proposed.bytes),
      mode,
      origins,
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
      origins,
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

/**
 * Reject normalized output origins that reference an artifact outside the resolved
 * Profile at the planning boundary, so every Project fails before any write.
 */
export function assertResolvedOutputOrigins(
  outputs: readonly DesiredProjectOutput[],
  resolvedProfile: ResolvedProfile,
): void {
  const resolvedReferences = new Set(
    resolvedProfile.artifacts.map((artifact) =>
      artifactReferenceKey(artifact.reference),
    ),
  );
  for (const output of outputs) {
    for (const origin of output.origins) {
      if (!resolvedReferences.has(artifactReferenceKey(origin))) {
        throw new Error(
          `Adapter output '${output.path}' references artifact '${artifactReferenceKey(origin)}' that is not resolved for Profile '${resolvedProfile.profile.id}'`,
        );
      }
    }
  }
}

export interface BuildDesiredStateOptions {
  /**
   * When false, skip Host CLI/version/surface capability preflight (status and
   * validate). Defaults to true for preview/apply.
   */
  readonly checkHostCapability?: boolean;
  /** Injectable process environment for Host capability probes. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Counts only real planning work (cache misses) inside one invocation. Used by
   * operation-budget tests; production callers omit this.
   */
  readonly planningInstrumentation?: LifecyclePlanningInstrumentation;
  /**
   * Invocation-scoped Git inspection reader shared with reconciliation when the
   * lifecycle command owns one pass. When omitted, one short-lived context is
   * created for desired-state planning only.
   */
  readonly gitInspection?: LifecycleGitInspection;
  /**
   * Prior Installation Manifests used only to preserve applied Grok Context
   * delivery topology when live inspection is unavailable (status).
   */
  readonly previousInstallations?: readonly ProjectInstallationManifest[];
  /**
   * When true, resolve multi-Host Grok Context topology (Claude rules
   * compatibility) without full capability preflight. validate stays probe-free;
   * status sets this so topology is not guessed.
   */
  readonly resolveHostTopology?: boolean;
}

export async function buildDesiredState(
  home: string,
  options: BuildDesiredStateOptions = {},
): Promise<DesiredState> {
  const { configuration, workspace } = await ingestApplication(home);
  // One invocation-scoped planning context. Discarded when this call returns.
  const planning = createLifecyclePlanningContext(
    workspace,
    options.planningInstrumentation ?? {},
  );
  const gitInspection = options.gitInspection ?? createLifecycleGitInspectionContext();
  const previousByProject = new Map(
    (options.previousInstallations ?? []).map((installation) => [
      installation.project,
      installation,
    ]),
  );
  const installations: DesiredInstallation[] = [];
  for (const binding of [...configuration.bindings].sort((left, right) =>
    left.canonicalProject.localeCompare(right.canonicalProject)
  )) {
    const profile = requireProfile(
      workspace.profiles,
      binding.profile,
    );
    const resolvedProfile = planning.resolveProfile(profile);
    if (profile.agents.length > 0 || profile.hooks.length > 0 || profile.tools.length > 0) {
      throw new Error(
        `Profile '${profile.id}' selects unsupported artifact categories; Agents, Hooks, and Tools are not supported in the project-bound slice`,
      );
    }
    const gitProject = await gitInspection.findGitProject(binding.canonicalProject);
    const { hash: sourceHash, fingerprints: artifactFingerprints } =
      await planning.hashWorkspaceInputs(profile, resolvedProfile);
    const blockers: BlockerInput[] = [];
    const plans: AdapterProjectPlan[] = [];
    const hostVersions: Record<string, string> = {};
    const warnings: string[] = [];
    const diagnosticValues: string[] = [];
    const requireDisabledModelInvocation = skillsRequireDisabledModelInvocation(
      resolvedProfile.skills,
    );
    // Capability and planning follow selected categories: Context machinery is optional.
    const requireContext = resolvedProfile.contexts.length > 0;
    const requireSkills = resolvedProfile.skills.length > 0;
    const selectedSkillIds = resolvedProfile.skills.map((skill) => skill.id);
    const capabilityEnvironment = options.env === undefined ? {} : { env: options.env };
    for (const host of binding.hosts) {
      let grokInspection: GrokInspection | undefined;
      if (
        options.checkHostCapability !== false
      ) {
        try {
          if (host === "codex") {
            await assertCodexProjectCapability(home, binding.canonicalProject, {
              ...capabilityEnvironment,
              requireContext,
              requireDisabledModelInvocation,
            });
          } else if (host === "claude") {
            await assertClaudeProjectCapability(binding.canonicalProject, {
              ...capabilityEnvironment,
              requireContext,
              requireDisabledModelInvocation,
            });
          } else if (host === "grok") {
            grokInspection = await assertGrokProjectCapability(binding.canonicalProject, {
              ...capabilityEnvironment,
              home,
              requireContext,
              requireSkills,
              requireDisabledModelInvocation,
            });
          } else if (host === "pi") {
            await assertPiProjectCapability(binding.canonicalProject, {
              ...capabilityEnvironment,
              home,
              requireContext,
              requireDisabledModelInvocation,
              requireSkills,
            });
          }
        } catch (error) {
          blockers.push(
            hostCapabilityBlocker(
              error,
              host,
              binding.canonicalProject,
              binding.project,
            ),
          );
        }
      } else if (host === "grok" && options.resolveHostTopology === true) {
        const needsContextTopology =
          requireContext && binding.hosts.includes("claude");
        if (needsContextTopology) {
          try {
            grokInspection = await inspectGrokProject(binding.canonicalProject, {
              ...capabilityEnvironment,
              home,
            });
          } catch (error) {
            grokInspection = undefined;
          }
        }
      }
      if (host === "pi" && requireSkills) {
        appendDiagnosticWarnings(
          warnings,
          diagnosticValues,
          await detectPiSkillSettingsWarnings({
            home,
            project: binding.canonicalProject,
          }),
          binding.project,
        );
      }
      if (host === "grok" && requireSkills) {
        appendDiagnosticWarnings(
          warnings,
          diagnosticValues,
          await detectGrokProjectConfigurationWarnings(selectedSkillIds, {
            home,
            project: binding.canonicalProject,
          }),
          binding.project,
        );
      }
      if (host === "codex") {
        if (requireContext) {
          appendDiagnosticWarnings(
            warnings,
            diagnosticValues,
            await detectCodexProjectConfigurationWarnings(
              home,
              binding.canonicalProject,
            ),
            binding.project,
          );
        }
        const contextPath = [
          gitProject?.relativeProject ?? "",
          ".agent-profile-kit",
          "codex",
          "context.md",
        ].filter((part) => part.length > 0).join("/");
        const requiresBoundRootLaunch = !gitProject && requireContext;
        const adapterPlan = await planning.planHost(
          {
            host: "codex",
            options: { contextPath, requiresBoundRootLaunch },
            profileId: profile.id,
            resolvedContexts: resolvedProfile.contexts,
            resolvedSkills: resolvedProfile.skills,
          },
          () => planCodexProject(
            profile.id,
            resolvedProfile.contexts,
            resolvedProfile.skills,
            {
              contextPath,
              materials: planning.materials,
              ...(requiresBoundRootLaunch ? { requiresBoundRootLaunch: true } : {}),
            },
          ),
        );
        plans.push(adapterPlan);
        hostVersions.codex = adapterPlan.hostVersion;
        continue;
      }
      if (host === "claude") {
        const adapterPlan = await planning.planHost(
          {
            host: "claude",
            options: {},
            profileId: profile.id,
            resolvedContexts: resolvedProfile.contexts,
            resolvedSkills: resolvedProfile.skills,
          },
          () => planClaudeProject(
            profile.id,
            resolvedProfile.contexts,
            resolvedProfile.skills,
            { materials: planning.materials },
          ),
        );
        plans.push(adapterPlan);
        hostVersions.claude = adapterPlan.hostVersion;
        continue;
      }
      if (host === "grok") {
        const claudeCoSelected = binding.hosts.includes("claude");
        let claudeRulesEnabled = grokInspection?.claudeRulesEnabled;
        // Context delivery topology only matters when the Profile selects Context.
        if (
          requireContext &&
          claudeRulesEnabled === undefined &&
          claudeCoSelected
        ) {
          const previous = previousByProject.get(binding.canonicalProject);
          claudeRulesEnabled = previous
            ? inferGrokClaudeRulesEnabledFromOutputs(
                previous.hosts,
                previous.outputs.map((output) => output.path),
              )
            : undefined;
          if (
            claudeRulesEnabled === undefined &&
            options.resolveHostTopology === true
          ) {
            // Do not invent topology for status when inspection and applied state
            // cannot prove Claude rules compatibility.
            blockers.push(
              hostCapabilityBlocker(
                grokClaudeRulesTopologyCapabilityError(),
                "grok",
                binding.canonicalProject,
                binding.project,
              ),
            );
          }
        }
        // Grok's documented default is enabled when topology is not required
        // (validate / hermetic tests / Context-free Profiles) or when Claude
        // is not co-selected.
        const effectiveClaudeRulesEnabled = claudeRulesEnabled ?? true;
        const adapterPlan = await planning.planHost(
          {
            host: "grok",
            options: {
              claudeCoSelected,
              claudeRulesEnabled: effectiveClaudeRulesEnabled,
            },
            profileId: profile.id,
            resolvedContexts: resolvedProfile.contexts,
            resolvedSkills: resolvedProfile.skills,
          },
          () => planGrokProject(
            profile.id,
            resolvedProfile.contexts,
            resolvedProfile.skills,
            {
              claudeCoSelected,
              claudeRulesEnabled: effectiveClaudeRulesEnabled,
              materials: planning.materials,
            },
          ),
        );
        plans.push(adapterPlan);
        hostVersions.grok = adapterPlan.hostVersion;
        continue;
      }
      if (host === "pi") {
        const adapterPlan = await planning.planHost(
          {
            host: "pi",
            options: {},
            profileId: profile.id,
            resolvedContexts: resolvedProfile.contexts,
            resolvedSkills: resolvedProfile.skills,
          },
          () => planPiProject(
            profile.id,
            resolvedProfile.contexts,
            resolvedProfile.skills,
            { materials: planning.materials },
          ),
        );
        plans.push(adapterPlan);
        hostVersions.pi = adapterPlan.hostVersion;
        continue;
      }
      const exhaustive: never = host;
      throw new Error(`Unsupported Agent Host '${String(exhaustive)}'`);
    }
    const outputs = normalizeAdapterPlans(plans);
    assertResolvedOutputOrigins(outputs, resolvedProfile);
    installations.push({
      adapterVersion: adapterVersionFor(binding.hosts),
      artifactFingerprints,
      binding,
      blockers,
      engineVersion: ENGINE_VERSION,
      gitProject,
      hostVersions,
      outputs,
      profile,
      resolvedProfile,
      setupSteps: plans.flatMap((plan) =>
        plan.setupSteps.map((step) => ({ ...step, host: plan.host }))
      ),
      sourceHash,
      diagnosticValues: [...new Set(diagnosticValues)].sort(),
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
