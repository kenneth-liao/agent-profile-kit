import type { SupportedHost } from "../schemas/local-configuration.js";
import type { BlockerAffectedItemKind } from "../installer/blockers.js";

export interface AdapterCapabilityAffectedItem {
  /** The shared typed blocker affected-item vocabulary (host, path, installation-id). */
  readonly kind: BlockerAffectedItemKind;
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

export function capabilityRequirement(host: SupportedHost): string {
  return `The selected Profile requires ${hostLabel(host)} project delivery`;
}

/** Create the canonical typed evidence for one Adapter capability failure. */
export function capabilityFailure(
  host: SupportedHost,
  problem: string,
  remedy: string,
  affectedItems: readonly AdapterCapabilityAffectedItem[] = [],
  message = `${problem}; ${remedy}`,
): AdapterCapabilityError {
  return new AdapterCapabilityError({
    affectedItems: [{ kind: "host", value: host }, ...affectedItems],
    host,
    message,
    problem,
    remedy,
    requirement: capabilityRequirement(host),
  });
}
