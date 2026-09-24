import type { SupportedHost } from "../schemas/local-configuration.js";
import { hostDisplayName } from "./host-catalog.js";
import {
  commandPart,
  flatInlineText,
  type CommandArg,
  type InlineContent,
} from "./project-plan.js";

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

/**
 * The typed cause class of one capability failure (US-007): presentation
 * chooses its screen shape from this fact, never from rendered copy.
 */
export type AdapterCapabilityReason = "missing-executable" | "version-floor";

/** Host-specific evidence raised by an Adapter before the Installer boundary. */
export interface AdapterCapabilityFailure {
  readonly affectedItems: readonly AdapterCapabilityAffectedItem[];
  readonly host: SupportedHost;
  readonly message: string;
  readonly parts: readonly InlineContent[];
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;
  /** Structurally marked sentences when the Adapter supplies atomic parts. */
  readonly problemParts?: readonly InlineContent[];
  readonly remedyParts?: readonly InlineContent[];
  readonly requirementParts?: readonly InlineContent[];
  /** Whether the failure is machine-level or bound to one Project's surface. */
  readonly scope: AdapterCapabilityScope;
  /** The typed cause class, when the Adapter declared one. */
  readonly reason?: AdapterCapabilityReason;
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
  readonly problemParts?: readonly InlineContent[];
  readonly remedyParts?: readonly InlineContent[];
  readonly requirementParts?: readonly InlineContent[];
  readonly scope: AdapterCapabilityScope;
  readonly reason?: AdapterCapabilityReason;
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
    if (failure.reason !== undefined) this.reason = failure.reason;
    if (failure.requiredVersion !== undefined) this.requiredVersion = failure.requiredVersion;
    if (failure.problemParts !== undefined) this.problemParts = failure.problemParts;
    if (failure.remedyParts !== undefined) this.remedyParts = failure.remedyParts;
    if (failure.requirementParts !== undefined) this.requirementParts = failure.requirementParts;
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

/**
 * Authored parts that flatten to exactly the problem are its structured form
 * (US-011, INT-3); otherwise the problem stays plain text and the machine
 * message remains the authored parts.
 */
function inferProblemParts(
  parts: readonly InlineContent[] | undefined,
  problem: string,
): readonly InlineContent[] | undefined {
  return parts !== undefined && flatInlineText(parts) === problem ? parts : undefined;
}

/** Create the canonical typed evidence for one Adapter capability failure. */
export function capabilityFailure(
  host: SupportedHost,
  scope: AdapterCapabilityScope,
  problem: string,
  remedy: string,
  affectedItems: readonly AdapterCapabilityAffectedItem[] = [],
  parts?: readonly InlineContent[],
  remedyParts?: readonly InlineContent[],
): AdapterCapabilityError {
  const allAffected = [{ kind: "host" as const, value: host }, ...affectedItems];
  const authoredParts = parts ?? [`${problem}; ${remedy}`];
  const structuredProblem = inferProblemParts(parts, problem);
  return new AdapterCapabilityError({
    affectedItems: allAffected,
    host,
    message: flatInlineText(authoredParts),
    parts: authoredParts,
    problem,
    ...(structuredProblem === undefined ? {} : { problemParts: structuredProblem }),
    ...(remedyParts === undefined ? {} : { remedyParts }),
    remedy,
    requirement: capabilityRequirement(host),
    scope,
  });
}

/**
 * Create the canonical typed evidence for one missing Host CLI (US-007,
 * review screen 27). The human problem and fix come from the Host catalog
 * displayName (the one name home) and the Adapter's own version-check
 * command, while `machineProblem`/`machineRemedy` keep the Adapter's machine
 * message for JSON byte-identity (DEC-004).
 */
export function missingExecutableFailure(
  host: SupportedHost,
  versionCheck: {
    readonly program: string;
    readonly args: readonly CommandArg[];
  },
  machineProblem: string,
  machineRemedy: string,
): AdapterCapabilityError {
  const name = hostDisplayName(host);
  const problem = `${name} isn't installed, or isn't on your PATH.`;
  const checkText = [versionCheck.program, ...versionCheck.args.map((one) =>
    one.kind === "text" ? one.value : ""
  )].join(" ");
  const remedy = `install ${name}, then check that \`${checkText}\` works.`;
  return new AdapterCapabilityError({
    affectedItems: [{ kind: "host", value: host }],
    host,
    message: `${machineProblem}; ${machineRemedy}`,
    parts: [`${machineProblem}; ${machineRemedy}`],
    problem,
    problemParts: [problem],
    remedy,
    remedyParts: [
      `install ${name}, then check that `,
      commandPart(versionCheck.program, versionCheck.args),
      " works.",
    ],
    requirement: capabilityRequirement(host),
    scope: "host",
    reason: "missing-executable",
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
  remedyParts?: readonly InlineContent[],
): AdapterCapabilityError {
  const authoredParts = parts ?? [`${problem}; ${remedy}`];
  const structuredProblem = inferProblemParts(parts, problem);
  return new AdapterCapabilityError({
    affectedItems: [{ kind: "host", value: host }],
    host,
    message: flatInlineText(authoredParts),
    parts: authoredParts,
    problem,
    ...(structuredProblem === undefined ? {} : { problemParts: structuredProblem }),
    ...(remedyParts === undefined ? {} : { remedyParts }),
    requiredVersion,
    remedy,
    requirement: capabilityRequirement(host),
    scope: "host",
    reason: "version-floor",
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