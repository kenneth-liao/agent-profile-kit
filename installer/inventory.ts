import { HOST_REGISTRY } from "../adapters/registry.js";
import { compareCanonicalStrings } from "../schemas/canonical.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import { requireProfile } from "./profile-selection.js";
import {
  ingestProjectBindings,
  ingestSelectedWorkspace,
} from "./local-configuration.js";
import type { InstallerToolErrorFact } from "./tool-errors.js";
import { readTemporaryInstallations } from "./installation-state.js";

/** One normalized Project Binding prepared for read-only inventory presentation. */
export interface ProjectInventoryRecord {
  /** Canonical absolute Project root, or null when the configured root cannot resolve. */
  readonly canonicalProject: string | null;
  /** Authored Project spelling retained by Local Configuration. */
  readonly project: string;
  readonly profile: string;
  /** Hosts are already normalized to the canonical supported-Host order. */
  readonly hosts: readonly SupportedHost[];
  /**
   * Typed per-binding normalization problem; null means the configured root
   * resolved cleanly. Presentation owns the sentence; no prose is authored here.
   */
  readonly problem: InstallerToolErrorFact | null;
}

/** One normalized Profile prepared for read-only inventory presentation. */
export interface ProfileInventoryRecord {
  readonly contextModules: number;
  readonly id: string;
  readonly skills: number;
}

/**
 * One focused Profile detail prepared for read-only inspection presentation
 * (US-018, #513). Names keep the authored definition order; no sort policy
 * is applied.
 */
export interface ProfileDetailInventoryRecord {
  readonly context: readonly string[];
  readonly id: string;
  readonly skills: readonly string[];
}

/** One supported Agent Host prepared for read-only inventory presentation. */
export interface HostInventoryRecord {
  readonly host: SupportedHost;
  readonly supportsTemporaryProfileInstallation: boolean;
}

/** One active Temporary Profile Installation prepared for read-only inventory. */
export interface TemporaryInventoryRecord {
  readonly host: SupportedHost;
  readonly profileId: string;
  /** Canonical absolute Project root retained by the temporary receipt. */
  readonly project: string;
  readonly temporaryInstallationId: string;
}

/**
 * Read the canonical supported-Host and Temporary Profile Installation sets.
 * This inventory is capability metadata only: it does not inspect PATH,
 * Host configuration, Project roots, or any other machine state.
 */
export function listHosts(): readonly HostInventoryRecord[] {
  return HOST_REGISTRY.map(({ host, supportsTemporaryProfileInstallation }) => ({
    host,
    supportsTemporaryProfileInstallation,
  }));
}

/**
 * Read Profile selections from the normalized Workspace model. This deliberately
 * stops before Project Binding, Installation State, Git, or Host inspection.
 */
export async function listProfiles(
  home: string,
): Promise<readonly ProfileInventoryRecord[]> {
  const workspace = await ingestSelectedWorkspace(home);
  return [...workspace.profiles.values()]
    .map((profile) => ({
      contextModules: profile.context.length,
      id: profile.id,
      skills: profile.skills.length,
    }))
    .sort((left, right) => compareCanonicalStrings(left.id, right.id));
}

/**
 * Read one Profile's Context Module and Skill names from the normalized
 * Workspace model through the single missing-Profile rejection boundary
 * (US-018, #513). This deliberately stops before Project Binding,
 * Installation State, Git, or Host inspection, so focused inspection is
 * read-only and works independently of installation state. Membership order
 * is the authored definition order.
 */
export async function listProfileDetail(
  home: string,
  profile: string,
): Promise<ProfileDetailInventoryRecord> {
  const workspace = await ingestSelectedWorkspace(home);
  const selected = requireProfile(workspace.profiles, profile);
  return {
    context: [...selected.context],
    id: selected.id,
    skills: [...selected.skills],
  };
}

/**
 * Read Project Bindings from the trusted Local Configuration model.
 * This deliberately stops before lifecycle planning, so it does not inspect
 * Git, Project output, Installation State, or Host capabilities.
 */
export async function listProjectBindings(
  home: string,
): Promise<readonly ProjectInventoryRecord[]> {
  const bindings = await ingestProjectBindings(home);
  return bindings
    .map((binding) => ({
      record: {
        canonicalProject: binding.canonicalProject ?? null,
        hosts: [...binding.hosts],
        problem: binding.problem ?? null,
        profile: binding.profile,
        project: binding.project,
      } satisfies ProjectInventoryRecord,
      sortProject: binding.expandedProject ?? binding.project,
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.sortProject, right.sortProject) ||
      compareCanonicalStrings(left.record.project, right.record.project)
    )
    .map(({ record }) => record);
}

/**
 * Read active Temporary Profile Installations from canonical Installation State.
 * Removed identities and ordinary Profile Installations are lifecycle records,
 * not active temporary inventory.
 */
export async function listTemporaryInstallations(
  home: string,
): Promise<readonly TemporaryInventoryRecord[]> {
  const installations = await readTemporaryInstallations(home);
  return installations
    .map((installation) => ({
      host: Object.keys(installation.hosts)[0]! as SupportedHost,
      profileId: installation.profileId,
      project: installation.project,
      temporaryInstallationId: installation.installationId,
    }))
    .sort((left, right) =>
      compareCanonicalStrings(left.project, right.project) ||
      compareCanonicalStrings(left.temporaryInstallationId, right.temporaryInstallationId)
    );
}
