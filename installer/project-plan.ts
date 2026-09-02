import { createHash } from "node:crypto";
import { isAbsolute, join, posix } from "node:path";

import { adapterVersionFor, hostRegistrationFor } from "../adapters/registry.js";
import type {
  AdapterProjectInput,
  AdapterProjectResult,
} from "../adapters/adapter-contract.js";
import type {
  AdapterDiagnosticWarning,
  AdapterProjectPlan,
  HostSetupStep,
  OutputRemedyKey,
  ProposedDirectoryMember,
  ProposedProjectOutput,
  ProjectOutputEntryType,
} from "../adapters/project-plan.js";
import {
  type ProjectBinding,
  type SupportedHost,
} from "../schemas/local-configuration.js";
import { parseFileMode } from "../schemas/installation-manifest.js";
import type { OwnershipReceipt } from "../schemas/ownership-state.js";
import {
  ARTIFACT_TYPES,
  artifactReferenceKey,
  requireArtifactId,
  type ArtifactReference,
  type ArtifactType,
} from "../schemas/dependencies.js";
import { type ResolvedArtifactFingerprint } from "./hashes.js";
import {
  ingestApplication,
  stateDirectory,
  type ProjectBindingSelection,
} from "./local-configuration.js";
import {
  createLifecyclePlanningContext,
  type LifecyclePlanningContext,
  type LifecyclePlanningInstrumentation,
} from "./lifecycle-planning.js";
import {
  createProjectReadScheduler,
  type ProjectReadScheduler,
} from "./project-scheduler.js";
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
import { isAdapterCapabilityError } from "../adapters/capability.js";

export type { LifecyclePlanningInstrumentation } from "./lifecycle-planning.js";
export type { LifecycleGitInspection } from "./lifecycle-git-inspection.js";

export type OwnedDirectoryMember =
  | {
      readonly hash: string;
      readonly mode: number;
      readonly path: string;
      readonly type: "file";
    }
  | {
      readonly mode: number;
      readonly path: string;
      readonly type: "directory";
    };

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
  readonly remedyKey?: OutputRemedyKey;
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
  readonly remedyKey?: OutputRemedyKey;
  readonly requirements: readonly string[];
  readonly type: "directory";
}

export type DesiredProjectOutput =
  | DesiredProjectDirectoryOutput
  | DesiredProjectFileOutput;

/** Advisory Host capability warning authored from one Adapter's failure evidence. */
export interface HostCapabilityWarning {
  readonly host: SupportedHost;
  readonly warning: AdapterDiagnosticWarning;
}

/**
 * Convert one Adapter capability failure into advisory evidence at the Installer
 * boundary. Probing classifies capability for warning purposes only: it never
 * gates planning, never gates writing, and never produces a Blocker. The
 * Adapter remains the sole author of the warning's wording.
 */
export function capabilityWarning(host: SupportedHost, failure: unknown): HostCapabilityWarning {
  const structured = isAdapterCapabilityError(failure) ? failure : undefined;
  return {
    host,
    warning: {
      copyableValues: structured === undefined
        ? [host]
        : structured.affectedItems.map((item) => item.value),
      message: structured?.message
        ?? (failure instanceof Error ? failure.message : String(failure)),
    },
  };
}

export interface DesiredInstallation {
  readonly adapterVersion: string;
  /** Normalized canonical source fingerprints for every resolved artifact. */
  readonly artifactFingerprints: readonly ResolvedArtifactFingerprint[];
  readonly binding: ProjectBinding;
  /**
   * Advisory Host capability evidence, deduplicated to one warning per Host per
   * invocation across every Project. Probing failures never block a lifecycle.
   */
  readonly capabilityWarnings: readonly HostCapabilityWarning[];
  readonly engineVersion: string;
  readonly gitProject: GitProject | undefined;
  readonly hostVersions: Readonly<Record<string, string>>;
  readonly outputs: readonly DesiredProjectOutput[];
  readonly profile: Profile;
  readonly resolvedProfile: ResolvedProfile;
  readonly sourceHash: string;
  readonly setupSteps: readonly HostSetupStep[];
  /** Adapter-authored warnings retain copyable values beside their message. */
  readonly warnings: readonly AdapterDiagnosticWarning[];
}

/** Normalize Adapter-authored diagnostics once while preserving their typed values. */
export function appendDiagnosticWarnings(
  warnings: AdapterDiagnosticWarning[],
  diagnostics: readonly AdapterDiagnosticWarning[],
): void {
  for (const diagnostic of diagnostics) {
    warnings.push({
      ...(diagnostic.consequence === undefined ? {} : { consequence: diagnostic.consequence }),
      copyableValues: [...diagnostic.copyableValues],
      message: diagnostic.message,
    });
  }
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

type DirectoryHashMember =
  | {
      readonly mode: number;
      readonly path: string;
      readonly type: "directory";
    }
  | {
      readonly bytes?: string | Uint8Array;
      readonly mode: number;
      readonly path: string;
      readonly type: "file";
    };

function sortedDirectoryHashMembers<T extends DirectoryHashMember>(members: readonly T[]): readonly T[] {
  return [...members].sort((left, right) => left.path.localeCompare(right.path));
}

function writeDirectoryHashMember(
  hash: ReturnType<typeof createHash>,
  member: DirectoryHashMember,
  bytes?: string | Uint8Array,
): void {
  writeFrame(hash, member.type);
  writeFrame(hash, member.path);
  writeFrame(hash, String(member.mode));
  if (member.type === "file") {
    const content = bytes ?? member.bytes;
    if (content === undefined) {
      throw new Error(`Directory member '${member.path}' must provide exact regular-file bytes`);
    }
    writeFrame(hash, content);
  }
}

/** Deterministic content hash for one complete artifact directory. */
export function hashDirectoryMembers(members: readonly DirectoryHashMember[]): string {
  const hash = createHash("sha256");
  for (const member of sortedDirectoryHashMembers(members)) {
    writeDirectoryHashMember(hash, member);
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * Hash one complete on-disk directory while retaining at most one file body.
 * The caller proves entry types without following symlinks before this boundary.
 */
export async function hashDirectoryMembersFromFiles(
  members: readonly DirectoryHashMember[],
  readBytes: (
    member: Extract<DirectoryHashMember, { readonly type: "file" }>,
  ) => Promise<string | Uint8Array>,
): Promise<string> {
  const hash = createHash("sha256");
  for (const member of sortedDirectoryHashMembers(members)) {
    writeDirectoryHashMember(
      hash,
      member,
      member.type === "file" ? await readBytes(member) : undefined,
    );
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

function normalizeProposedOutput(
  proposed: ProposedProjectOutput,
  host: string,
): DesiredProjectOutput {
  const path = normalizedOutputPath(proposed.path);
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
      ...(proposed.remedyKey === undefined ? {} : { remedyKey: proposed.remedyKey }),
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
      ...(proposed.remedyKey === undefined ? {} : { remedyKey: proposed.remedyKey }),
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
      const origins = [...new Map(
        [...existing.origins, ...normalized.origins].map((origin) => [artifactReferenceKey(origin), origin]),
      ).values()].sort((left, right) =>
        artifactReferenceKey(left).localeCompare(artifactReferenceKey(right))
      );
      const requirements = [...new Set([...existing.requirements, ...normalized.requirements])].sort();
      const remedyKey = existing.remedyKey ?? normalized.remedyKey;
      outputs.set(normalized.path, {
        ...existing,
        consumingHosts: hosts,
        origins,
        ...(remedyKey === undefined ? {} : { remedyKey }),
        requirements,
      });
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

/**
 * Route one Host through its canonical registered Adapter and invocation-scoped
 * planning services. Ordinary and temporary lifetimes share this boundary.
 */
export function planRegisteredAdapter(
  host: SupportedHost,
  input: AdapterProjectInput,
  planning: LifecyclePlanningContext,
): Promise<AdapterProjectResult> {
  return hostRegistrationFor(host).adapter.planProject(input, {
    materials: planning.materials,
    planProjection: (key, plan) => planning.planHost(key, plan),
    probeMachineCapability: (requirements, probe) =>
      planning.probeHostCapability({ host, requirements }, probe),
  });
}

export interface BuildDesiredStateOptions {
  /** Project Bindings selected before any per-Project planning or inspection. */
  readonly selection?: ProjectBindingSelection;
  /**
   * When false, skip Host CLI/version/surface capability probing (status and
   * validate). Defaults to true for apply and temporary installation, where a
   * probe failure becomes an advisory warning instead of a Blocker.
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
   * Invocation-scoped bounded scheduler for independent per-Project planning
   * work, shared with reconciliation so one concurrency boundary governs the
   * whole lifecycle. When omitted, one short-lived scheduler is created for
   * planning only.
   */
  readonly scheduler?: ProjectReadScheduler;
  /** Prior Installation Manifests available to Adapters for topology recovery. */
  readonly previousInstallations?: readonly OwnershipReceipt[];
}

export async function buildDesiredState(
  home: string,
  options: BuildDesiredStateOptions = {},
): Promise<DesiredState> {
  const { configuration, workspace } = await ingestApplication(
    home,
    options.selection ?? { kind: "all" },
  );
  // One invocation-scoped planning context. Discarded when this call returns.
  const planning = createLifecyclePlanningContext(
    workspace,
    options.planningInstrumentation ?? {},
  );
  const gitInspection = options.gitInspection ?? createLifecycleGitInspectionContext();
  const scheduler = options.scheduler ?? createProjectReadScheduler();
  const previousByProject = new Map(
    (options.previousInstallations ?? []).map((installation) => [
      installation.project,
      {
        hosts: Object.keys(installation.hosts),
        outputs: installation.outputs,
      },
    ]),
  );
  const bindings = [...configuration.bindings].sort((left, right) =>
    left.canonicalProject.localeCompare(right.canonicalProject)
  );
  const installations = await scheduler.run(bindings.map((binding) => async () => {
    const profile = requireProfile(
      workspace.profiles,
      binding.profile,
    );
    const resolvedProfile = planning.resolveProfile(profile);
    const gitProject = await gitInspection.findGitProject(binding.canonicalProject);
    const { hash: sourceHash, fingerprints: artifactFingerprints } =
      await planning.hashWorkspaceInputs(profile, resolvedProfile);
    const capabilityFailures: { readonly failure: unknown; readonly host: SupportedHost }[] = [];
    const plans: AdapterProjectPlan[] = [];
    const hostVersions: Record<string, string> = {};
    const warnings: AdapterDiagnosticWarning[] = [];
    for (const host of binding.hosts) {
      const result = await planRegisteredAdapter(
        host,
        {
          authoredProject: binding.project,
          checkHostCapability: options.checkHostCapability !== false,
          ...(options.env === undefined ? {} : { env: options.env }),
          home,
          profileId: profile.id,
          previousInstallation: previousByProject.get(binding.canonicalProject),
          project: binding.canonicalProject,
          projectRelativeToGitRoot: gitProject?.relativeProject,
          resolvedContexts: resolvedProfile.contexts,
          resolvedSkills: resolvedProfile.skills,
          selectedHosts: binding.hosts,
        },
        planning,
      );
      for (const failure of result.capabilityFailures) {
        capabilityFailures.push({ failure, host });
      }
      appendDiagnosticWarnings(warnings, result.diagnostics);
      plans.push(result.plan);
      hostVersions[host] = result.plan.hostVersion;
    }
    const outputs = normalizeAdapterPlans(plans);
    assertResolvedOutputOrigins(outputs, resolvedProfile);
    return {
      adapterVersion: adapterVersionFor(binding.hosts),
      artifactFingerprints,
      binding,
      capabilityWarnings: capabilityFailures.map((entry) =>
        capabilityWarning(entry.host, entry.failure)
      ),
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
      warnings,
    };
  }));
  const sortedInstallations = [...installations].sort((left, right) =>
    left.binding.canonicalProject.localeCompare(right.binding.canonicalProject)
  );
  // One warning per identical Host capability failure per invocation (DEC-014):
  // cached machine-level probes fail identically for every Project, so the
  // first Project in canonical order keeps the warning and the rest drop it,
  // independent of how many Projects select the Host. Distinct Project-specific
  // evidence (for example one Project's occupied surface) keeps its warning.
  const warnedCapability = new Set<string>();
  const dedupedInstallations = sortedInstallations.map((installation) => {
    const capabilityWarnings = installation.capabilityWarnings.filter((entry) => {
      const key = `${entry.host}\0${entry.warning.message}`;
      if (warnedCapability.has(key)) return false;
      warnedCapability.add(key);
      return true;
    });
    return capabilityWarnings.length === installation.capabilityWarnings.length
      ? installation
      : { ...installation, capabilityWarnings };
  });
  return {
    bindingCount: configuration.bindings.length,
    installations: dedupedInstallations,
    workspace,
  };
}

export { adapterVersionFor, stateDirectory };

export function stateManifestPath(home: string): string {
  return join(stateDirectory(home), "manifest.json");
}


export function outputPath(project: string, output: { readonly path: string }): string {
  return join(project, output.path);
}
