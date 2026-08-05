import { readFile } from "node:fs/promises";

import { parseLocalConfigurationSelection } from "../schemas/local-configuration.js";
import { ENGINE_VERSION } from "./version.js";
import {
  canonicalizePathForComparison,
  expandConfiguredPath,
  localConfigurationPath,
} from "./local-configuration.js";
import { stateManifestPath } from "./project-plan.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export interface InfoWorkspaceLocation {
  readonly authored: string;
  readonly canonical: string;
}

export interface ApplicationInfo {
  readonly engineVersion: string;
  readonly installationState: string;
  readonly localConfiguration: string;
  readonly workspace: InfoWorkspaceLocation | null;
}

/** Location facts that remain available even when Local Configuration is absent or invalid. */
export function applicationInfoLocations(home: string): ApplicationInfo {
  return {
    engineVersion: ENGINE_VERSION,
    installationState: stateManifestPath(home),
    localConfiguration: localConfigurationPath(home),
    workspace: null,
  };
}

/**
 * Read only the location-bearing application inputs. This intentionally does
 * not ingest Workspace artifacts, bindings, Host configuration, or Installation
 * State contents.
 */
export async function readApplicationInfo(home: string): Promise<ApplicationInfo> {
  const locations = applicationInfoLocations(home);
  const localConfiguration = locations.localConfiguration;
  let source: string;
  try {
    source = await readFile(localConfiguration, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return locations;
    }
    throw error;
  }

  const parsed = parseLocalConfigurationSelection(source, localConfiguration);
  if (parsed.workspace === undefined) {
    return locations;
  }

  const expanded = expandConfiguredPath(
    parsed.workspace,
    home,
    `Local Configuration ${localConfiguration}`,
    "workspace",
  );
  const canonical = await canonicalizePathForComparison(expanded);
  return {
    ...locations,
    workspace: {
      authored: parsed.workspace,
      canonical,
    },
  };
}
