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

export type InfoConfigurationState = "current" | "legacy" | "not-configured";

export interface ApplicationInfoLocations {
  readonly engineVersion: string;
  readonly installationState: string;
  readonly localConfiguration: string;
}

export interface ApplicationInfo extends ApplicationInfoLocations {
  readonly configurationState: InfoConfigurationState;
  readonly workspace: InfoWorkspaceLocation | null;
}

/** Location facts that remain available even when Local Configuration is absent or invalid. */
export function applicationInfoLocations(home: string): ApplicationInfoLocations {
  return {
    engineVersion: ENGINE_VERSION,
    installationState: stateManifestPath(home),
    localConfiguration: localConfigurationPath(home),
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
      return {
        ...locations,
        configurationState: "not-configured",
        workspace: null,
      };
    }
    throw error;
  }

  const parsed = parseLocalConfigurationSelection(source, localConfiguration);
  const configurationState = parsed.schemaVersion === 1 ? "legacy" : "current";
  if (parsed.workspace === undefined) {
    return {
      ...locations,
      configurationState,
      workspace: null,
    };
  }

  const expanded = expandConfiguredPath(
    parsed.workspace,
    home,
    { source: "local-configuration", configurationPath: localConfiguration },
    "workspace",
  );
  const canonical = await canonicalizePathForComparison(expanded);
  return {
    ...locations,
    configurationState,
    workspace: {
      authored: parsed.workspace,
      canonical,
    },
  };
}
