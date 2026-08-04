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

function isStructuredBlocker(input: BlockerInput): input is StructuredReconciliationBlocker {
  return input !== null && typeof input === "object" && STRUCTURED_BLOCKER in input;
}

function isStructuredInput(input: BlockerInput): input is StructuredBlockerInput {
  if (input === null || typeof input !== "object") return false;
  return ["affectedItems", "kind", "problem", "remedy", "requirement", "scope"]
    .some((key) => key in input);
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Structured blocker ${field} must be a non-empty string`);
  }
}

function validateStructuredInput(input: StructuredBlockerInput): void {
  requireText(input.message, "message");
  requireText(input.kind, "kind");
  requireText(input.problem, "problem");
  requireText(input.requirement, "requirement");
  requireText(input.remedy, "remedy");
  if (input.scope !== "global" && input.scope !== "project") {
    throw new TypeError("Structured blocker scope must be 'global' or 'project'");
  }
  if (input.scope === "project") requireText(input.project, "project");
  if (input.scope === "global" && input.project !== undefined) {
    throw new TypeError("Global structured blockers cannot carry a project");
  }
  if (!Array.isArray(input.affectedItems)) {
    throw new TypeError("Structured blocker affectedItems must be an array");
  }
  for (const item of input.affectedItems) {
    requireText(item?.kind, "affectedItems.kind");
    requireText(item?.value, "affectedItems.value");
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

  if (isStructuredBlocker(input)) {
    validateStructuredInput(input);
    if (input.scope === "global" && fallbackProject !== undefined) {
      throw new Error("Structured blocker scope does not match its fallback project");
    }
    if (input.scope === "project" && fallbackProject !== undefined && input.project !== fallbackProject) {
      throw new Error("Structured blocker scope does not match its fallback project");
    }
    return input;
  }

  validateStructuredInput(input);
  if (input.scope === "global") {
    if (fallbackProject !== undefined) {
      throw new Error("Structured blocker scope does not match its fallback project");
    }
    return canonicalStructuredBlocker(input);
  }

  if (fallbackProject !== undefined && input.project !== fallbackProject) {
    throw new Error("Structured blocker scope does not match its fallback project");
  }
  return canonicalStructuredBlocker(input);
}

export function blockerMessage(input: BlockerInput): string {
  return normalizeBlocker(input).message;
}
