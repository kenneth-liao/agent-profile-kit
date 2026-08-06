import {
  adapterCapabilityError,
  isAdapterCapabilityError,
} from "../adapters/capability.js";
import type { SupportedHost } from "../schemas/local-configuration.js";

/** A blocker scope retains the legacy project identity as a separate projection. */
export type BlockerScope = "global" | "project";

export interface BlockerAffectedItem {
  readonly kind: string;
  readonly value: string;
}

interface StructuredBlockerCommon {
  readonly affectedItems: readonly BlockerAffectedItem[];
  /** Typed blocker class; the exhaustive class vocabulary lands with the migration. */
  readonly kind: string;
  readonly message: string;
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;
  readonly scope: BlockerScope;
}

export type StructuredBlockerInput =
  | (StructuredBlockerCommon & {
      readonly project?: never;
      readonly scope: "global";
    })
  | (StructuredBlockerCommon & {
      readonly project: string;
      readonly scope: "project";
    });

export interface LegacyBlocker {
  readonly affectedItems?: never;
  readonly kind?: never;
  readonly message: string;
  /** Canonical project identity; absent only for application-state blockers. */
  readonly project?: string;
  readonly problem?: never;
  readonly remedy?: never;
  readonly requirement?: never;
  readonly scope?: never;
}

const STRUCTURED_BLOCKER: unique symbol = Symbol("structured blocker");

/** A complete structured blocker returned by the normalization boundary. */
export type StructuredReconciliationBlocker =
  | (StructuredBlockerInput & { readonly [STRUCTURED_BLOCKER]: true });

export type ReconciliationBlocker = LegacyBlocker | StructuredReconciliationBlocker;

export type BlockerInput = string | LegacyBlocker | StructuredBlockerInput;

/** Convert one Adapter capability failure to the shared structured contract. */
export function hostCapabilityBlocker(
  error: unknown,
  host: SupportedHost,
  project: string,
  displayProject?: string,
): StructuredBlockerInput {
  const failure = isAdapterCapabilityError(error)
    ? error
    : adapterCapabilityError(host, error instanceof Error ? error.message : String(error));
  return {
    affectedItems: failure.affectedItems,
    kind: "host-capability",
    message: displayProject === undefined
      ? failure.message
      : `${displayProject}: ${failure.message}`,
    problem: failure.problem,
    project,
    remedy: failure.remedy,
    requirement: failure.requirement,
    scope: "project",
  };
}

export function isStructuredBlocker(input: unknown): input is StructuredReconciliationBlocker {
  return input !== null && typeof input === "object" && STRUCTURED_BLOCKER in input;
}

/** Classify untrusted raw input before normalization; consumers use the brand predicate above. */
function isStructuredInput(input: unknown): input is StructuredBlockerInput {
  if (input === null || typeof input !== "object") return false;
  return ["affectedItems", "kind", "problem", "remedy", "requirement", "scope"]
    .some((key) => key in input);
}

function blockerContext(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const details = ["kind", "project", "message", "scope"]
    .flatMap((field) => {
      const value = record[field];
      return typeof value === "string" && value.length > 0
        ? [`${field}=${JSON.stringify(value)}`]
        : [];
    });
  return details.length === 0 ? "" : ` (${details.join(", ")})`;
}

function requireText(
  value: unknown,
  field: string,
  input: unknown,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `Structured blocker ${field} must be a non-empty string${blockerContext(input)}`,
    );
  }
}

function validateStructuredInput(input: StructuredBlockerInput): void {
  requireText(input.message, "message", input);
  requireText(input.kind, "kind", input);
  requireText(input.problem, "problem", input);
  requireText(input.requirement, "requirement", input);
  requireText(input.remedy, "remedy", input);
  if (input.scope !== "global" && input.scope !== "project") {
    throw new TypeError(
      `Structured blocker scope must be 'global' or 'project'${blockerContext(input)}`,
    );
  }
  if (input.scope === "project") requireText(input.project, "project", input);
  if (input.scope === "global" && input.project !== undefined) {
    throw new TypeError(
      `Global structured blockers cannot carry a project${blockerContext(input)}`,
    );
  }
  if (!Array.isArray(input.affectedItems)) {
    throw new TypeError(
      `Structured blocker affectedItems must be an array${blockerContext(input)}`,
    );
  }
  for (const item of input.affectedItems) {
    requireText(item?.kind, "affectedItems.kind", input);
    requireText(item?.value, "affectedItems.value", input);
  }
}

function canonicalStructuredBlocker(input: StructuredBlockerInput): StructuredReconciliationBlocker {
  const affectedItems = Object.freeze(
    input.affectedItems.map((item) => Object.freeze({ kind: item.kind, value: item.value })),
  );
  const common = {
    affectedItems,
    kind: input.kind,
    message: input.message,
    problem: input.problem,
    remedy: input.remedy,
    requirement: input.requirement,
    scope: input.scope,
  };
  if (input.scope === "global") {
    return Object.freeze({
      ...common,
      scope: "global" as const,
      [STRUCTURED_BLOCKER]: true as const,
    });
  }
  return Object.freeze({
    ...common,
    project: input.project,
    scope: "project" as const,
    [STRUCTURED_BLOCKER]: true as const,
  });
}

function scopeMismatch(input: StructuredBlockerInput, fallbackProject: string): never {
  throw new Error(
    `Structured blocker scope does not match its fallback project ${JSON.stringify(fallbackProject)}${blockerContext(input)}`,
  );
}

/**
 * Normalize every blocker at the boundary where it enters a report or error.
 * Legacy messages retain their existing shape; structured inputs cannot omit
 * any evidence field and derive the legacy project projection from scope.
 */
export function normalizeBlocker(
  input: BlockerInput,
  fallbackProject?: string,
): ReconciliationBlocker {
  if (typeof input === "string") {
    return fallbackProject === undefined
      ? { message: input }
      : { message: input, project: fallbackProject };
  }

  if (input === null || typeof input !== "object") {
    throw new TypeError("Blocker input must be a message or blocker object");
  }

  if (!isStructuredInput(input)) {
    if (typeof input.message !== "string") {
      throw new TypeError("Legacy blocker message must be a string");
    }
    if (input.project !== undefined && typeof input.project !== "string") {
      throw new TypeError("Legacy blocker project must be a string");
    }
    const project = input.project ?? fallbackProject;
    return project === undefined
      ? { message: input.message }
      : { message: input.message, project };
  }

  validateStructuredInput(input);
  if (
    input.scope === "project" &&
    fallbackProject !== undefined &&
    input.project !== fallbackProject
  ) {
    scopeMismatch(input, fallbackProject);
  }
  return isStructuredBlocker(input) ? input : canonicalStructuredBlocker(input);
}

export function blockerMessage(input: BlockerInput): string {
  return normalizeBlocker(input).message;
}
