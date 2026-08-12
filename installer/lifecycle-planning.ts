import {
  composeContextEnvelope,
  type ContextModuleSource,
} from "../adapters/context-envelope.js";
import type {
  AdapterProjectPlan,
  ProposedDirectoryMember,
} from "../adapters/project-plan.js";
import {
  skillPackageMembers,
  type AdapterPlanningMaterials,
} from "../adapters/skill-package.js";
import type { Profile } from "../schemas/context-profile.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import type { Skill } from "../schemas/skill.js";
import {
  hashWorkspaceInputs,
  type WorkspaceInputs,
} from "./hashes.js";
import type { Workspace } from "./ingest-workspace.js";
import {
  resolveProfileDependencies,
  type ResolvedProfile,
} from "./resolve-dependencies.js";

/**
 * Instrumentation fired only when the invocation context performs real work
 * (cache miss). Tests inject counters; production callers omit this.
 */
export interface LifecyclePlanningInstrumentation {
  readonly onComposeContext?: () => void;
  readonly onHashWorkspaceInputs?: () => void;
  readonly onPlanHost?: () => void;
  readonly onProbeHostCapability?: () => void;
  readonly onReadSkillPackage?: () => void;
  readonly onResolveProfile?: () => void;
}

/** Complete trusted machine-level inputs that affect one Host probe result. */
export interface HostCapabilityKey {
  readonly host: SupportedHost;
  readonly requirements: Readonly<Record<string, boolean>>;
}

export interface LifecyclePlanningContext {
  /** Adapter materials that reuse Skill source and composed Context. */
  readonly materials: AdapterPlanningMaterials;
  composeContext(
    profileId: string,
    modules: readonly ContextModuleSource[],
  ): string;
  hashWorkspaceInputs(
    profile: Profile,
    resolvedProfile: ResolvedProfile,
  ): Promise<WorkspaceInputs>;
  planHost(
    key: HostProjectionKey,
    plan: () => Promise<AdapterProjectPlan>,
  ): Promise<AdapterProjectPlan>;
  /**
   * Run one machine-level Host capability probe at most once per unique
   * requirement set per invocation. Both supported and failed probe results are
   * immutable evidence for this command only and are discarded on exit.
   */
  probeHostCapability(
    key: HostCapabilityKey,
    probe: () => Promise<string>,
  ): Promise<string>;
  readSkillPackage(skill: Skill): Promise<readonly ProposedDirectoryMember[]>;
  resolveProfile(profile: Profile): ResolvedProfile;
}

/** Complete trusted inputs that affect one Host projection result. */
export interface HostProjectionKey {
  readonly host: SupportedHost;
  readonly options: Readonly<Record<string, unknown>>;
  readonly profileId: string;
  readonly resolvedContexts: readonly ContextModuleSource[];
  readonly resolvedSkills: readonly Skill[];
}

function skillPackageKey(skill: Skill): string {
  return `${skill.id}\0${skill.path}\0${skill.modelInvocation}`;
}

function contextKey(
  profileId: string,
  modules: readonly ContextModuleSource[],
): string {
  return JSON.stringify({
    modules: modules.map((module) => ({ content: module.content, id: module.id })),
    profileId,
  });
}

function hostProjectionCacheKey(key: HostProjectionKey): string {
  return JSON.stringify({
    host: key.host,
    options: key.options,
    profileId: key.profileId,
    resolvedContexts: key.resolvedContexts.map((module) => ({
      content: module.content,
      id: module.id,
    })),
    resolvedSkills: key.resolvedSkills.map((skill) => ({
      id: skill.id,
      modelInvocation: skill.modelInvocation,
      path: skill.path,
    })),
  });
}

/**
 * Create one invocation-scoped planning context. Discarded when the lifecycle
 * command exits; never persisted or shared across commands.
 */
export function createLifecyclePlanningContext(
  workspace: Workspace,
  instrumentation: LifecyclePlanningInstrumentation = {},
): LifecyclePlanningContext {
  const resolvedProfiles = new Map<string, ResolvedProfile>();
  const workspaceInputs = new Map<string, Promise<WorkspaceInputs>>();
  const skillPackages = new Map<string, Promise<readonly ProposedDirectoryMember[]>>();
  const composedContexts = new Map<string, string>();
  const hostPlans = new Map<string, Promise<AdapterProjectPlan>>();
  const hostCapabilities = new Map<string, Promise<string>>();

  async function readSkillPackage(
    skill: Skill,
  ): Promise<readonly ProposedDirectoryMember[]> {
    const key = skillPackageKey(skill);
    const existing = skillPackages.get(key);
    if (existing) return existing;
    instrumentation.onReadSkillPackage?.();
    const pending = skillPackageMembers(skill);
    skillPackages.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      skillPackages.delete(key);
      throw error;
    }
  }

  function composeContext(
    profileId: string,
    modules: readonly ContextModuleSource[],
  ): string {
    const key = contextKey(profileId, modules);
    const existing = composedContexts.get(key);
    if (existing !== undefined) return existing;
    instrumentation.onComposeContext?.();
    const composed = composeContextEnvelope(profileId, modules);
    composedContexts.set(key, composed);
    return composed;
  }

  function resolveProfile(profile: Profile): ResolvedProfile {
    const existing = resolvedProfiles.get(profile.id);
    if (existing) return existing;
    instrumentation.onResolveProfile?.();
    const resolved = resolveProfileDependencies(
      profile,
      workspace.contexts,
      workspace.skills,
    );
    resolvedProfiles.set(profile.id, resolved);
    return resolved;
  }

  function hashInputs(
    profile: Profile,
    resolvedProfile: ResolvedProfile,
  ): Promise<WorkspaceInputs> {
    const existing = workspaceInputs.get(profile.id);
    if (existing) return existing;
    instrumentation.onHashWorkspaceInputs?.();
    const pending = hashWorkspaceInputs(profile, resolvedProfile, {
      readSkillPackage,
    });
    workspaceInputs.set(profile.id, pending);
    return pending.catch((error) => {
      workspaceInputs.delete(profile.id);
      throw error;
    });
  }

  function planHost(
    key: HostProjectionKey,
    plan: () => Promise<AdapterProjectPlan>,
  ): Promise<AdapterProjectPlan> {
    const cacheKey = hostProjectionCacheKey(key);
    const existing = hostPlans.get(cacheKey);
    if (existing) return existing;
    instrumentation.onPlanHost?.();
    const pending = plan();
    hostPlans.set(cacheKey, pending);
    return pending.catch((error) => {
      hostPlans.delete(cacheKey);
      throw error;
    });
  }

  function probeHostCapability(
    key: HostCapabilityKey,
    probe: () => Promise<string>,
  ): Promise<string> {
    const cacheKey = JSON.stringify({
      host: key.host,
      requirements: key.requirements,
    });
    const existing = hostCapabilities.get(cacheKey);
    if (existing) return existing;
    instrumentation.onProbeHostCapability?.();
    const pending = probe();
    // Unlike planning work, probe failures are retained for the invocation: a
    // missing or outdated Host CLI cannot recover mid-command, and re-probing it
    // for every Project is exactly the waste this boundary eliminates. Both
    // success and failure are immutable machine-level evidence for this command.
    hostCapabilities.set(cacheKey, pending);
    return pending;
  }

  const materials: AdapterPlanningMaterials = {
    composeContext,
    readSkillPackage,
  };

  return {
    composeContext,
    hashWorkspaceInputs: hashInputs,
    materials,
    planHost,
    probeHostCapability,
    readSkillPackage,
    resolveProfile,
  };
}
