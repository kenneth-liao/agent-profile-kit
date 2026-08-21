/**
 * Policy-free discovery metadata for every supported Agent Host. This module
 * deliberately imports no Adapter implementation so schemas and inventory can
 * consume Host identity without evaluating Host planners.
 */
export const HOST_CATALOG = [
  {
    adapterVersion: "antigravity-project-v2",
    host: "antigravity",
    supportsTemporaryProfileInstallation: false,
  },
  {
    adapterVersion: "claude-project-v1",
    host: "claude",
    supportsTemporaryProfileInstallation: true,
  },
  {
    adapterVersion: "codex-project-v3",
    host: "codex",
    supportsTemporaryProfileInstallation: true,
  },
  {
    adapterVersion: "grok-project-v1",
    host: "grok",
    supportsTemporaryProfileInstallation: false,
  },
  {
    adapterVersion: "pi-project-v2",
    host: "pi",
    supportsTemporaryProfileInstallation: false,
  },
] as const;

export type HostCatalogEntry = (typeof HOST_CATALOG)[number];
export type SupportedHost = HostCatalogEntry["host"];
export type TemporaryInstallationHost = Extract<
  HostCatalogEntry,
  { readonly supportsTemporaryProfileInstallation: true }
>["host"];

export const SUPPORTED_HOSTS = HOST_CATALOG.map((entry) => entry.host) as
  readonly SupportedHost[];
export const TEMPORARY_INSTALLATION_HOSTS = HOST_CATALOG
  .filter((entry) => entry.supportsTemporaryProfileInstallation)
  .map((entry) => entry.host) as readonly TemporaryInstallationHost[];

const CATALOG_BY_HOST = new Map(HOST_CATALOG.map((entry) => [entry.host, entry]));

export function isSupportedHost(value: unknown): value is SupportedHost {
  return typeof value === "string" && CATALOG_BY_HOST.has(value as SupportedHost);
}

export function hostCatalogEntryFor<const H extends SupportedHost>(
  host: H,
): Extract<HostCatalogEntry, { readonly host: H }> {
  const entry = CATALOG_BY_HOST.get(host);
  if (!entry) throw new Error(`Unsupported Agent Host '${String(host)}'`);
  return entry as Extract<HostCatalogEntry, { readonly host: H }>;
}

export function isTemporaryInstallationHost(
  value: string,
): value is TemporaryInstallationHost {
  return isSupportedHost(value) && hostCatalogEntryFor(value).supportsTemporaryProfileInstallation;
}

export const ANTIGRAVITY_ADAPTER_VERSION =
  hostCatalogEntryFor("antigravity").adapterVersion;
export const CLAUDE_ADAPTER_VERSION = hostCatalogEntryFor("claude").adapterVersion;
export const CODEX_ADAPTER_VERSION = hostCatalogEntryFor("codex").adapterVersion;
export const GROK_ADAPTER_VERSION = hostCatalogEntryFor("grok").adapterVersion;
export const PI_ADAPTER_VERSION = hostCatalogEntryFor("pi").adapterVersion;
