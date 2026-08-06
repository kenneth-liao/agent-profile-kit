import type { SupportedHost } from "../schemas/local-configuration.js";

export interface AdapterCapabilityAffectedItem {
  readonly kind: string;
  readonly value: string;
}

/** Host-specific evidence raised by an Adapter before the Installer boundary. */
export interface AdapterCapabilityFailure {
  readonly affectedItems: readonly AdapterCapabilityAffectedItem[];
  readonly host: SupportedHost;
  readonly message: string;
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;
}

/**
 * Typed Adapter failure that remains an Error for existing callers while
 * carrying the evidence the Installer needs for a structured Blocker.
 */
export class AdapterCapabilityError extends Error implements AdapterCapabilityFailure {
  readonly affectedItems: readonly AdapterCapabilityAffectedItem[];
  readonly host: SupportedHost;
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;

  constructor(failure: AdapterCapabilityFailure) {
    super(failure.message);
    this.name = "AdapterCapabilityError";
    this.affectedItems = failure.affectedItems;
    this.host = failure.host;
    this.problem = failure.problem;
    this.remedy = failure.remedy;
    this.requirement = failure.requirement;
  }
}

export function isAdapterCapabilityError(
  error: unknown,
): error is AdapterCapabilityError {
  return error instanceof AdapterCapabilityError;
}

function hostLabel(host: SupportedHost): string {
  return `${host[0]?.toUpperCase() ?? ""}${host.slice(1)}`;
}

/** Create the default typed evidence for one Adapter capability failure. */
export function adapterCapabilityError(
  host: SupportedHost,
  message: string,
  options: Partial<Omit<AdapterCapabilityFailure, "host" | "message">> = {},
): AdapterCapabilityError {
  const label = hostLabel(host);
  return new AdapterCapabilityError({
    affectedItems: [{ kind: "host", value: host }, ...(options.affectedItems ?? [])],
    host,
    message,
    problem: options.problem ?? `${label} Host capability could not be proven`,
    remedy: options.remedy ?? `Resolve the reported ${label} Host capability issue, then retry`,
    requirement: options.requirement ?? `The selected Profile requires ${label} project delivery`,
  });
}
