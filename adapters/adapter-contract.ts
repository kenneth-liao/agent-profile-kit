import type { ContextModuleSource } from "./context-envelope.js";
import type {
  AdapterDiagnosticWarning,
  AdapterProjectPlan,
} from "./project-plan.js";
import type { AdapterPlanningMaterials } from "./skill-package.js";
import type { SupportedHost } from "./host-catalog.js";
import type { Skill } from "../schemas/skill.js";

/** Minimal prior applied topology evidence available to an Adapter. */
export interface AdapterPreviousInstallation {
  readonly hosts: readonly string[];
  readonly outputs: readonly { readonly path: string }[];
}

/** Complete Project-planning input available to one Host Adapter. */
export interface AdapterProjectInput {
  readonly authoredProject: string;
  readonly checkHostCapability: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly home: string;
  readonly profileId: string;
  /** Prior ownership evidence available for Adapter-owned topology recovery. */
  readonly previousInstallation: AdapterPreviousInstallation | undefined;
  readonly project: string;
  /** Project path relative to its Git worktree root; absent for non-Git Projects. */
  readonly projectRelativeToGitRoot: string | undefined;
  readonly resolvedContexts: readonly ContextModuleSource[];
  readonly resolvedSkills: readonly Skill[];
  readonly resolveHostTopology?: boolean;
  readonly selectedHosts: readonly SupportedHost[];
}

/** Complete normalized inputs that permit safe invocation-scoped projection reuse. */
export interface AdapterProjectionKey {
  readonly host: SupportedHost;
  readonly options: Readonly<Record<string, unknown>>;
  readonly profileId: string;
  readonly resolvedContexts: readonly ContextModuleSource[];
  readonly resolvedSkills: readonly Skill[];
}

/** Generic reuse services supplied by one Installer invocation. */
export interface AdapterInvocationServices {
  readonly materials: AdapterPlanningMaterials;
  planProjection(
    key: AdapterProjectionKey,
    plan: () => Promise<AdapterProjectPlan>,
  ): Promise<AdapterProjectPlan>;
  probeMachineCapability(
    requirements: Readonly<Record<string, boolean>>,
    probe: () => Promise<string>,
  ): Promise<string>;
}

/** Complete Adapter result retained before Installer-specific blocker normalization. */
export interface AdapterProjectResult {
  readonly capabilityFailures: readonly unknown[];
  readonly diagnostics: readonly AdapterDiagnosticWarning[];
  readonly plan: AdapterProjectPlan | undefined;
}

/**
 * One complete Host boundary for ordinary and temporary planning. The Adapter
 * owns capability probing, Project-surface inspection, warnings, topology,
 * Capability Contract selection, output planning, and Host Setup Steps behind
 * this method.
 */
export interface CompleteHostAdapter {
  readonly host: SupportedHost;
  planProject(
    input: AdapterProjectInput,
    services: AdapterInvocationServices,
  ): Promise<AdapterProjectResult>;
}
