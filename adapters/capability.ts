import type { SupportedHost } from "../schemas/local-configuration.js";
import { flatInlineText, type InlineContent } from "./project-plan.js";

/** The affected-item evidence an Adapter capability failure can carry: a Host or a path. */
export type AdapterCapabilityAffectedItemKind = "host" | "path";

export interface AdapterCapabilityAffectedItem {
  readonly kind: AdapterCapabilityAffectedItemKind;
  readonly value: string;
}

/**
 * Whether one Adapter capability failure is machine-level (a missing or
 * outdated Host CLI) or bound to one Project's surface. The Adapter authors
 * this scope as typed evidence, so the Installer never infers it.
 */
export type AdapterCapabilityScope = "host" | "project";

/** Host-specific evidence raised by an Adapter before the Installer boundary. */
export interface AdapterCapabilityFailure {
  readonly affectedItems: readonly AdapterCapabilityAffectedItem[];
  readonly host: SupportedHost;
  readonly message: string;
  readonly parts: readonly InlineContent[];
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;
  /** Whether the failure is machine-level or bound to one Project's surface. */
  readonly scope: AdapterCapabilityScope;
  /** The normalized Host CLI floor the failure names, when it names one. */
  readonly requiredVersion?: string;
}

/**
 * Typed Adapter failure that remains an Error for existing callers while
 * carrying the evidence the Installer needs for a structured Blocker.
 */
export class AdapterCapabilityError extends Error implements AdapterCapabilityFailure {
  readonly affectedItems: readonly AdapterCapabilityAffectedItem[];
  readonly host: SupportedHost;
  readonly parts: readonly InlineContent[];
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;
  readonly scope: AdapterCapabilityScope;
  readonly requiredVersion?: string;

  constructor(failure: AdapterCapabilityFailure) {
    super(failure.message);
    this.name = "AdapterCapabilityError";
    this.affectedItems = failure.affectedItems;
    this.host = failure.host;
    this.problem = failure.problem;
    this.remedy = failure.remedy;
    this.requirement = failure.requirement;
    this.scope = failure.scope;
    this.parts = failure.parts;
    if (failure.requiredVersion !== undefined) this.requiredVersion = failure.requiredVersion;
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
  scope: AdapterCapabilityScope,
  problem: string,
  remedy: string,
  affectedItems: readonly AdapterCapabilityAffectedItem[] = [],
  parts?: readonly InlineContent[],
): AdapterCapabilityError {
  const allAffected = [{ kind: "host" as const, value: host }, ...affectedItems];
  const authoredParts = parts ?? [`${problem}; ${remedy}`];
  return new AdapterCapabilityError({
    affectedItems: allAffected,
    host,
    message: flatInlineText(authoredParts),
    parts: authoredParts,
    problem,
    remedy,
    requirement: capabilityRequirement(host),
    scope,
  });
}

/**
 * Create the typed evidence for one Host CLI version-floor failure: a
 * machine-level failure whose message names the normalized floor the Adapter
 * requires, so the Installer can keep the strictest floor per Host.
 */
export function versionFloorCapabilityFailure(
  host: SupportedHost,
  problem: string,
  remedy: string,
  requiredVersion: string,
  parts?: readonly InlineContent[],
): AdapterCapabilityError {
  const authoredParts = parts ?? [`${problem}; ${remedy}`];
  return new AdapterCapabilityError({
    affectedItems: [{ kind: "host", value: host }],
    host,
    message: flatInlineText(authoredParts),
    parts: authoredParts,
    problem,
    remedy,
    requirement: capabilityRequirement(host),
    requiredVersion,
    scope: "host",
  });
}

/**
 * Normalize one error caught at a capability phase boundary into typed
 * evidence carrying that phase's scope, so every failure the Installer sees
 * declares whether it is machine-level or bound to one Project's surface.
 * Typed Adapter failures pass through with their authored scope; a foreign
 * error from the phase is wrapped with the phase's scope and keeps its
 * message, so no unknown failure is ever scoped downstream by inference.
 */
export function caughtCapabilityFailure(
  host: SupportedHost,
  scope: AdapterCapabilityScope,
  error: unknown,
): AdapterCapabilityFailure {
  if (isAdapterCapabilityError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return capabilityFailure(
    host,
    scope,
    message,
    scope === "host"
      ? "check the Host CLI works, then retry"
      : "check the Project surface, then retry",
    [{ kind: "host", value: host }],
    [message],
  );
}