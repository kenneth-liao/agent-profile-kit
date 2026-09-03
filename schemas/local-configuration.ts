import { parse, stringify } from "yaml";

import {
  isSupportedHost,
  SUPPORTED_HOSTS,
  type SupportedHost,
} from "../adapters/host-catalog.js";
import { ARTIFACT_ID } from "./dependencies.js";
import { rejectSchema, type LocalConfigurationRejectionReason } from "./schema-rejections.js";

export { isSupportedHost, SUPPORTED_HOSTS, type SupportedHost } from "../adapters/host-catalog.js";

export const LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION = 1;
export const LOCAL_CONFIGURATION_SCHEMA_VERSION = 2;
export const LOCAL_CONFIGURATION_FILE = "config.yaml";

/**
 * Local Configuration rejection facts live in `schemas/schema-rejections.ts`
 * — the one canonical home of every portable-schema rejection vocabulary
 * (DEC-020). This module re-exports the Local Configuration cases it throws.
 */
export type { LocalConfigurationRejectionReason } from "./schema-rejections.js";

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

function parseYaml(source: string, path: string): unknown {
  try {
    return parse(source);
  } catch {
    throw rejectSchema({
    schema: "local-configuration",
    detail: { case: "invalid-yaml", path },
  });
  }
}

function requireMapping(value: unknown, reason: LocalConfigurationRejectionReason): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw rejectSchema({ schema: "local-configuration", detail: reason });
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, reason: LocalConfigurationRejectionReason): string {
  if (typeof value !== "string" || value.length === 0) {
    throw rejectSchema({ schema: "local-configuration", detail: reason });
  }
  return value;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  reason: LocalConfigurationRejectionReason,
): void {
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    throw rejectSchema({ schema: "local-configuration", detail: reason });
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
  const value = parseYaml(source, path);
  const mapping = requireMapping(value, { case: "not-a-mapping", path });
  requireExactFields(
    mapping,
    ["schema_version", "bindings", "workspace"],
    { case: "unknown-field", path, fields: unknownFields(mapping, ["schema_version", "bindings", "workspace"]) },
  );
  const schemaVersion = mapping.schema_version;
  if (
    schemaVersion !== LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION &&
    schemaVersion !== LOCAL_CONFIGURATION_SCHEMA_VERSION
  ) {
    throw rejectSchema({
    schema: "local-configuration",
    detail: { case: "unsupported-schema-version", path },
  });
  }

  return { mapping, schemaVersion };
}

function unknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): readonly string[] {
  return Object.keys(value).filter((field) => !allowed.includes(field));
}

function parseWorkspaceSelection(
  mapping: Record<string, unknown>,
  schemaVersion: 1 | 2,
  path: string,
): string | undefined {
  const workspace =
    mapping.workspace === undefined
      ? undefined
      : requireString(mapping.workspace, { case: "invalid-field", path, field: "workspace" });
  if (schemaVersion === LOCAL_CONFIGURATION_SCHEMA_VERSION && workspace === undefined) {
    throw rejectSchema({
    schema: "local-configuration",
    detail: { case: "missing-workspace", path },
  });
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
    throw rejectSchema({
    schema: "local-configuration",
    detail: { case: "bindings-not-array", path },
  });
  }
  const workspace = parseWorkspaceSelection(mapping, schemaVersion, path);

  const bindings = mapping.bindings.map((entry, index) => {
    const binding = requireMapping(entry, { case: "binding-not-mapping", path, index });
    requireExactFields(
      binding,
      ["project", "profile", "hosts"],
      { case: "unknown-binding-field", path, index, fields: unknownFields(binding, ["project", "profile", "hosts"]) },
    );
    const project = requireString(binding.project, { case: "invalid-binding-field", path, index, field: "project" });
    if (typeof binding.profile !== "string" || !ARTIFACT_ID.test(binding.profile)) {
      throw rejectSchema({
      schema: "local-configuration",
      detail: { case: "invalid-binding-profile", path, index },
    });
    }
    const profile = binding.profile;
    if (!Array.isArray(binding.hosts) || binding.hosts.length === 0) {
      throw rejectSchema({
      schema: "local-configuration",
      detail: { case: "hosts-not-array", path, index },
    });
    }
    const hosts = binding.hosts.map((host, hostIndex) => {
      if (!isSupportedHost(host)) {
        throw rejectSchema({
          schema: "local-configuration",
          detail: {
            case: "unsupported-host",
            path,
            index,
            hostIndex,
            host: String(host),
            supportedHosts: SUPPORTED_HOSTS,
          },
        });
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
  const workspace = requireCurrentWorkspaceSelection(parsed, path, migrationCommand);
  return {
    bindings: parsed.bindings,
    schemaVersion: LOCAL_CONFIGURATION_SCHEMA_VERSION,
    workspace,
  };
}

/** Require the current schema and explicit Workspace path without reading bindings. */
export function requireCurrentWorkspaceSelection(
  parsed: ParsedLocalConfigurationSelection,
  path: string,
  migrationCommand: string,
): string {
  if (parsed.schemaVersion !== LOCAL_CONFIGURATION_SCHEMA_VERSION) {
    throw rejectSchema({
      schema: "local-configuration",
      detail: {
        case: "legacy-schema-version",
        path,
        schemaVersion: LEGACY_LOCAL_CONFIGURATION_SCHEMA_VERSION,
        migrationCommand,
      },
    });
  }
  if (parsed.workspace === undefined) {
    throw rejectSchema({
    schema: "local-configuration",
    detail: { case: "missing-workspace", path },
  });
  }
  return parsed.workspace;
}
