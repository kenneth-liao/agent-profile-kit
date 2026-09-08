import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { grokAdapter } from "./grok.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import type { CompleteHostAdapter } from "./adapter-contract.js";
import {
  HOST_CATALOG,
  hostCatalogEntryFor,
  type HostCatalogEntry,
  type SupportedHost,
} from "./host-catalog.js";

export {
  HOST_CATALOG,
  SUPPORTED_HOSTS,
  TEMPORARY_INSTALLATION_HOSTS,
  hostCatalogEntryFor,
  isSupportedHost,
  isTemporaryInstallationHost,
  type SupportedHost,
  type TemporaryInstallationHost,
} from "./host-catalog.js";

const COMPLETE_ADAPTERS = {
  antigravity: antigravityAdapter,
  claude: claudeAdapter,
  codex: codexAdapter,
  grok: grokAdapter,
  opencode: opencodeAdapter,
  pi: piAdapter,
} as const satisfies {
  readonly [H in SupportedHost]: CompleteHostAdapter & {
    readonly host: H;
  };
};

export type HostRegistration = HostCatalogEntry & {
  readonly adapter: CompleteHostAdapter;
};

function completeAdapterFor<const H extends SupportedHost>(
  host: H,
): (typeof COMPLETE_ADAPTERS)[H] {
  return COMPLETE_ADAPTERS[host];
}

/**
 * Canonical ordered Host registry. Policy-free metadata stays in HOST_CATALOG;
 * this projection attaches every complete Adapter implementation.
 */
export const HOST_REGISTRY = HOST_CATALOG.map((entry): HostRegistration => ({
  ...entry,
  adapter: completeAdapterFor(entry.host),
}));

const REGISTRATION_BY_HOST = new Map(
  HOST_REGISTRY.map((registration) => [registration.host, registration]),
);

export function hostRegistrationFor(host: SupportedHost): HostRegistration {
  const registration = REGISTRATION_BY_HOST.get(host);
  if (!registration) throw new Error(`Unsupported Agent Host '${String(host)}'`);
  return registration;
}

/** Deterministic multi-Adapter version token recorded on an Installation Manifest. */
export function adapterVersionFor(hosts: readonly SupportedHost[]): string {
  return [...new Set(hosts.map((host) => hostCatalogEntryFor(host).adapterVersion))]
    .sort()
    .join("+");
}

/**
 * Advisory detection of installed supported Agent Hosts on the machine.
 * Evaluates registered Adapters concurrently and returns detected Hosts in
 * canonical SUPPORTED_HOSTS order. Detection is advisory and never throws.
 */
export async function detectInstalledHosts(
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<readonly SupportedHost[]> {
  const detections = await Promise.all(
    HOST_REGISTRY.map(async (entry) => {
      const detected = await entry.adapter.detectHost(options);
      return detected ? entry.host : undefined;
    }),
  );
  return detections.filter((host): host is SupportedHost => host !== undefined);
}

