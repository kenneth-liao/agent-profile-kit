import { compareCanonicalStrings } from "../schemas/installation-manifest.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import { ingestProjectBindings } from "./local-configuration.js";

/** One normalized Project Binding prepared for read-only inventory presentation. */
export interface ProjectInventoryRecord {
  /** Canonical absolute Project root, or null when the configured root cannot resolve. */
  readonly canonicalProject: string | null;
  /** Authored Project spelling retained by Local Configuration. */
  readonly project: string;
  readonly profile: string;
  /** Hosts are already normalized to the canonical supported-Host order. */
  readonly hosts: readonly SupportedHost[];
  /** Per-binding normalization problem; null means the configured root resolved cleanly. */
  readonly problem: string | null;
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
