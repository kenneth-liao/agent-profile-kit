import { compareCanonicalStrings } from "../schemas/installation-manifest.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import { ingestProjectBindings } from "./local-configuration.js";

/** One normalized Project Binding prepared for read-only inventory presentation. */
export interface ProjectInventoryRecord {
  /** Canonical absolute Project root, or null when the configured root is missing. */
  readonly canonicalProject: string | null;
  /** Authored Project spelling retained by Local Configuration. */
  readonly project: string;
  readonly profile: string;
  /** Hosts are already normalized to the canonical supported-Host order. */
  readonly hosts: readonly SupportedHost[];
}

/**
 * Read Project Bindings from the trusted Local Configuration model.
 * This deliberately stops before lifecycle planning, so it does not inspect
 * Git, Project output, Installation State, or Host capabilities.
 */
export async function listProjectBindings(
  home: string,
): Promise<readonly ProjectInventoryRecord[]> {
  const { bindings } = await ingestProjectBindings(home, { allowMissingProjects: true });
  return bindings
    .map((binding) => ({
      canonicalProject: binding.canonicalProject ?? null,
      hosts: [...binding.hosts],
      profile: binding.profile,
      project: binding.project,
    }))
    .sort((left, right) =>
      compareCanonicalStrings(
        left.canonicalProject ?? left.project,
        right.canonicalProject ?? right.project,
      ) || compareCanonicalStrings(left.project, right.project)
    );
}
