import { parse, stringify } from "yaml";

import { requireArtifactId } from "./dependencies.js";

export const LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION = 1;
export const LOCAL_CONFIGURATION_SCHEMA_VERSION = 2;
export const LOCAL_CONFIGURATION_FILE = "config.yaml";

/** Agent Hosts the engine can plan project output for. */
export const SUPPORTED_HOSTS = ["claude", "codex", "grok", "pi"] as const;
export type SupportedHost = (typeof SUPPORTED_HOSTS)[number];

export function isSupportedHost(value: unknown): value is SupportedHost {
  return typeof value === "string" && (SUPPORTED_HOSTS as readonly string[]).includes(value);
}

export interface ProjectBinding {
  /** The canonical absolute project root used for identity and output. */
  readonly canonicalProject: string;
  /** The authored spelling retained for user-facing diagnostics. */
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
}

export interface LocalConfiguration {
  readonly bindings: readonly ProjectBinding[];
  readonly path: string;
  readonly schemaVersion: 2;
  /** The one explicit authored Workspace path selected on this machine. */
  readonly workspace: string;
}

export function createEmptyLocalConfiguration(workspace: string): string {
  return stringify({
    schema_version: LOCAL_CONFIGURATION_SCHEMA_VERSION,
    workspace,
    bindings: [],
  });
}

function parseYaml(source: string, description: string): unknown {
  try {
    return parse(source);
  } catch {
    throw new Error(`${description} is invalid YAML`);
  }
}

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  description: string,
): void {
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    throw new Error(`${description} does not allow fields: ${unknown.join(", ")}`);
  }
}

export interface ParsedProjectBinding {
  readonly hosts: readonly SupportedHost[];
  readonly profile: string;
  readonly project: string;
}

export interface ParsedLocalConfiguration {
  readonly bindings: readonly ParsedProjectBinding[];
  readonly schemaVersion: 1 | 2;
  readonly workspace?: string;
}

export interface ParsedLocalConfigurationSelection {
  readonly schemaVersion: 1 | 2;
  readonly workspace?: string;
}

interface LocalConfigurationHeader {
  readonly mapping: Record<string, unknown>;
  readonly schemaVersion: 1 | 2;
}

export interface ParsedCurrentLocalConfiguration {
  readonly bindings: readonly ParsedProjectBinding[];
  readonly schemaVersion: 2;
  readonly workspace: string;
}

function parseLocalConfigurationHeader(
  source: string,
  path: string,
): LocalConfigurationHeader {
  const value = parseYaml(source, `Local Configuration ${path}`);
  const mapping = requireMapping(value, `Local Configuration ${path}`);
  requireExactFields(
    mapping,
    ["schema_version", "bindings", "workspace"],
    `Local Configuration ${path}`,
  );
  const schemaVersion = mapping.schema_version;
  if (
    schemaVersion !== LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION &&
    schemaVersion !== LOCAL_CONFIGURATION_SCHEMA_VERSION
  ) {
    throw new Error(
      `Local Configuration ${path} schema_version must be ${LOCAL_CONFIGURATION_SCHEMA_VERSION}`,
    );
  }

  return { mapping, schemaVersion };
}

function parseWorkspaceSelection(
  mapping: Record<string, unknown>,
  schemaVersion: 1 | 2,
  path: string,
): string | undefined {
  const workspace =
    mapping.workspace === undefined
      ? undefined
      : requireString(mapping.workspace, `Local Configuration ${path} workspace`);
  if (schemaVersion === LOCAL_CONFIGURATION_SCHEMA_VERSION && workspace === undefined) {
    throw new Error(
      `Local Configuration ${path} workspace is required for schema_version ${LOCAL_CONFIGURATION_SCHEMA_VERSION}; add an explicit Workspace path and retry`,
    );
  }
  return workspace;
}

/** Parse only the selected Workspace location without inspecting Project Bindings. */
export function parseLocalConfigurationSelection(
  source: string,
  path: string,
): ParsedLocalConfigurationSelection {
  const header = parseLocalConfigurationHeader(source, path);
  const workspace = parseWorkspaceSelection(header.mapping, header.schemaVersion, path);
  return {
    schemaVersion: header.schemaVersion,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

/**
 * Parse only the portable shape. Filesystem-dependent normalization belongs to
 * the ingestion boundary in installer/local-configuration.ts.
 */
export function parseLocalConfiguration(source: string, path: string): ParsedLocalConfiguration {
  const { mapping, schemaVersion } = parseLocalConfigurationHeader(source, path);
  if (!Array.isArray(mapping.bindings)) {
    throw new Error(`Local Configuration ${path} bindings must be an array`);
  }
  const workspace = parseWorkspaceSelection(mapping, schemaVersion, path);

  const bindings = mapping.bindings.map((entry, index) => {
    const description = `Local Configuration ${path} bindings[${index}]`;
    const binding = requireMapping(entry, description);
    requireExactFields(binding, ["project", "profile", "hosts"], description);
    const project = requireString(binding.project, `${description} project`);
    const profile = requireArtifactId(binding.profile, `${description} profile`);
    if (!Array.isArray(binding.hosts) || binding.hosts.length === 0) {
      throw new Error(`${description} hosts must be a non-empty array`);
    }
    const hosts = binding.hosts.map((host, hostIndex) => {
      if (!isSupportedHost(host)) {
        throw new Error(
          `${description} hosts[${hostIndex}] unsupported Agent Host '${String(host)}'; supported Hosts: ${SUPPORTED_HOSTS.join(", ")}`,
        );
      }
      return host;
    });
    // Hosts are a set: normalize duplicates and order once so authored
    // permutations are identical at the ingestion boundary.
    const orderedHosts = SUPPORTED_HOSTS.filter((host) => hosts.includes(host));
    return { hosts: orderedHosts, profile, project };
  });

  return {
    bindings,
    schemaVersion,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

export function requireCurrentLocalConfiguration(
  parsed: ParsedLocalConfiguration,
  path: string,
  migrationCommand: string,
): ParsedCurrentLocalConfiguration {
  if (parsed.schemaVersion !== LOCAL_CONFIGURATION_SCHEMA_VERSION) {
    throw new Error(
      `Local Configuration ${path} uses legacy schema_version ${parsed.schemaVersion}; run ${migrationCommand} to migrate it`,
    );
  }
  if (parsed.workspace === undefined) {
    throw new Error(
      `Local Configuration ${path} workspace is required for schema_version ${LOCAL_CONFIGURATION_SCHEMA_VERSION}; add an explicit Workspace path and retry`,
    );
  }
  return {
    bindings: parsed.bindings,
    schemaVersion: LOCAL_CONFIGURATION_SCHEMA_VERSION,
    workspace: parsed.workspace,
  };
}
