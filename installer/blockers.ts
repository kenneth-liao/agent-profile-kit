import { OUTPUT_REMEDY_KEYS, type OutputRemedyKey } from "../adapters/project-plan.js";
import { compareCanonicalStrings } from "../schemas/installation-manifest.js";

/** A blocker scope retains the legacy project identity as a separate projection. */
export type BlockerScope = "global" | "project";

/** The exhaustive kinds of affected-item evidence a blocker can carry. */
export const AFFECTED_ITEM_KINDS = ["host", "path", "installation-id"] as const;

/** Exhaustive typed affected-item kind. */
export type BlockerAffectedItemKind = (typeof AFFECTED_ITEM_KINDS)[number];

export interface BlockerAffectedItem {
  readonly kind: BlockerAffectedItemKind;
  readonly value: string;
}

/** Which lifecycle action an Installation-ownership blocker is preventing. */
export type OwnershipBlockerAction = "remove" | "verify";

/** The exhaustive path-kind facts an occupied planned output can report. */
export type OutputOccupation = "directory" | "file" | "other" | "symlink";

/**
 * Typed evidence for why one planned output destination is occupied. Each case
 * maps to one presentation-owned problem template keyed by the blocker kind;
 * the Installer never authors the sentence.
 */
export type OccupiedOutputFact =
  | { readonly case: "drifted-output" }
  | { readonly case: "occupied-destination"; readonly occupation: OutputOccupation }
  | { readonly case: "occupied-parent"; readonly occupation: OutputOccupation }
  | { readonly case: "unowned-artifact-directory" };

/** The exhaustive typed fact cases an occupied-output blocker can carry. */
export const OCCUPIED_OUTPUT_CASES = [
  "drifted-output",
  "occupied-destination",
  "occupied-parent",
  "unowned-artifact-directory",
] as const;

/**
 * Exhaustive typed blocker evidence. Every field is a typed fact — kind,
 * affected Project, affected paths, affected Agent Host, plus the per-kind
 * non-prose evidence each presentation template needs. User-facing sentences do
 * not exist on this type: presentation owns every problem, requirement, and
 * remedy string keyed by {@link BlockerKind}. Which typed facts each kind
 * requires is enforced at the normalization boundary.
 */
export interface StructuredBlockerInput {
  readonly affectedItems: readonly BlockerAffectedItem[];
  /** Typed blocker class; the exhaustive vocabulary is {@link BLOCKER_KINDS}. */
  readonly kind: BlockerKind;
  /** The affected Project identity; project-scoped blockers require it. */
  readonly project?: string;
  readonly scope: BlockerScope;
  /** occupied-output only: typed evidence for why the destination is occupied. */
  readonly occupied?: OccupiedOutputFact;
  /** occupied-output only: adapter remedy identity; presentation owns the sentence. */
  readonly remedyKey?: OutputRemedyKey;
  /** installation-ownership only: which lifecycle action the blocker is preventing. */
  readonly action?: OwnershipBlockerAction;
  /**
   * Diagnostic detail fact for installation-state-unreadable,
   * installation-ownership, and temporary-installation-removal (for example an
   * fs error message or an ownership-proof reason). Never a composed sentence.
   */
  readonly detail?: string;
}

/** The project-scoped variant of a structured blocker input. */
export type ProjectScopedBlockerInput = StructuredBlockerInput & {
  readonly project: string;
  readonly scope: "project";
};

/** The global-scoped variant of a structured blocker input. */
export type GlobalScopedBlockerInput = StructuredBlockerInput & {
  readonly project?: never;
  readonly scope: "global";
};

const STRUCTURED_BLOCKER: unique symbol = Symbol("structured blocker");

/** A complete structured blocker returned by the normalization boundary. */
export type StructuredReconciliationBlocker = StructuredBlockerInput & {
  readonly [STRUCTURED_BLOCKER]: true;
};

export type ReconciliationBlocker = StructuredReconciliationBlocker;

export type BlockerInput = StructuredBlockerInput;

/** Typed blocker class for planned output that conflicts with Git-tracked repository ownership. */
export const OUTPUT_OWNERSHIP_CONFLICT = "output-ownership-conflict" as const;

/** Typed blocker class for unreadable machine-local Installation State. */
export const INSTALLATION_STATE_UNREADABLE = "installation-state-unreadable" as const;

/** Typed blocker class for planned output whose destination or parent is occupied by unowned material. */
export const OCCUPIED_OUTPUT = "occupied-output" as const;

/** Typed blocker class for Profile Installation ownership that cannot be proven or reconciled. */
export const INSTALLATION_OWNERSHIP = "installation-ownership" as const;

/** Typed blocker class for a Temporary Profile Installation lifetime conflict. */
export const TEMPORARY_INSTALLATION_CONFLICT = "temporary-installation-conflict" as const;

/** Typed blocker class for a Temporary Profile Installation that cannot be removed safely. */
export const TEMPORARY_INSTALLATION_REMOVAL = "temporary-installation-removal" as const;

/**
 * The exhaustive typed blocker-class vocabulary. Every emitter must construct
 * its class from these constants; adding a blocker class requires extending
 * this list so the type-level union stays exhaustive.
 */
export const BLOCKER_KINDS = [
  OUTPUT_OWNERSHIP_CONFLICT,
  INSTALLATION_STATE_UNREADABLE,
  OCCUPIED_OUTPUT,
  INSTALLATION_OWNERSHIP,
  TEMPORARY_INSTALLATION_CONFLICT,
  TEMPORARY_INSTALLATION_REMOVAL,
] as const;

/** Exhaustive typed blocker class. */
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

/** Build one complete structured blocker for unreadable Installation State. */
export function installationStateUnreadableBlocker(options: {
  readonly detail: string;
  readonly statePath: string;
}): GlobalScopedBlockerInput {
  return {
    affectedItems: [{ kind: "path", value: options.statePath }],
    detail: options.detail,
    kind: INSTALLATION_STATE_UNREADABLE,
    scope: "global" as const,
  };
}

/** Build one complete structured blocker for a planned output destination that is occupied. */
export function occupiedOutputBlocker(options: {
  readonly occupied: OccupiedOutputFact;
  readonly path: string;
  readonly project: string;
  readonly remedyKey?: OutputRemedyKey;
}): ProjectScopedBlockerInput {
  return {
    affectedItems: [{ kind: "path", value: options.path }],
    kind: OCCUPIED_OUTPUT,
    occupied: options.occupied,
    project: options.project,
    ...(options.remedyKey === undefined ? {} : { remedyKey: options.remedyKey }),
    scope: "project" as const,
  };
}

/** Build one complete structured blocker for unprovable Profile Installation ownership. */
export function installationOwnershipBlocker(options: {
  readonly action: OwnershipBlockerAction;
  readonly detail: string;
  readonly project: string;
}): ProjectScopedBlockerInput {
  return {
    action: options.action,
    affectedItems: [],
    detail: options.detail,
    kind: INSTALLATION_OWNERSHIP,
    project: options.project,
    scope: "project" as const,
  };
}

/** Build one complete structured blocker for a Temporary Profile Installation lifetime conflict. */
export function temporaryInstallationConflictBlocker(options: {
  readonly project: string;
  readonly temporaryInstallationId?: string;
}): ProjectScopedBlockerInput {
  return {
    affectedItems: options.temporaryInstallationId === undefined
      ? []
      : [{ kind: "installation-id", value: options.temporaryInstallationId }],
    kind: TEMPORARY_INSTALLATION_CONFLICT,
    project: options.project,
    scope: "project" as const,
  };
}

/** Build one complete structured blocker for a Temporary Profile Installation that cannot be removed safely. */
export function temporaryInstallationRemovalBlocker(options: {
  readonly detail: string;
  readonly outputs: readonly string[];
  readonly project: string;
}): ProjectScopedBlockerInput {
  return {
    affectedItems: options.outputs.map((output) => ({ kind: "path" as const, value: output })),
    detail: options.detail,
    kind: TEMPORARY_INSTALLATION_REMOVAL,
    project: options.project,
    scope: "project" as const,
  };
}

/**
 * Build one complete structured blocker for every tracked planned path in one
 * Project. Normalized evidence keeps one `path` affected item per conflicting
 * destination so human grouping presents one explanation without discarding
 * per-path machine facts.
 */
export function outputOwnershipConflictBlocker(options: {
  readonly paths: readonly string[];
  readonly project: string;
}): ProjectScopedBlockerInput {
  if (options.paths.length === 0) {
    throw new TypeError("Output ownership conflict requires at least one conflicting path");
  }
  const paths = [...options.paths].sort(compareCanonicalStrings);
  return {
    affectedItems: paths.map((path) => ({ kind: "path", value: path })),
    kind: OUTPUT_OWNERSHIP_CONFLICT,
    project: options.project,
    scope: "project" as const,
  };
}

export function isStructuredBlocker(input: unknown): input is StructuredReconciliationBlocker {
  return input !== null && typeof input === "object" && STRUCTURED_BLOCKER in input;
}

/** Classify untrusted raw input before normalization; consumers use the brand predicate above. */
function isStructuredInput(input: unknown): input is StructuredBlockerInput {
  if (input === null || typeof input !== "object") return false;
  return ["affectedItems", "kind", "scope"].some((key) => key in input);
}

function blockerContext(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const details = ["kind", "project", "scope"]
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

/** Prose fields are unrepresentable; their presence is rejected, never ignored. */
const PROHIBITED_PROSE_FIELDS = ["message", "problem", "remedy", "requirement"] as const;

function rejectProseFields(input: unknown): void {
  if (input === null || typeof input !== "object") return;
  const record = input as Record<string, unknown>;
  for (const field of PROHIBITED_PROSE_FIELDS) {
    if (field in record) {
      throw new TypeError(
        `Structured blockers carry typed facts only; "${field}" is presentation-owned wording` +
          `${blockerContext(input)}`,
      );
    }
  }
}

function validateOccupiedFact(value: unknown, input: unknown): asserts value is OccupiedOutputFact {
  if (value === null || typeof value !== "object") {
    throw new TypeError(
      `Structured blocker occupied fact must be an object${blockerContext(input)}`,
    );
  }
  const fact = value as Record<string, unknown>;
  if (!(OCCUPIED_OUTPUT_CASES as readonly string[]).includes(fact.case as string)) {
    throw new TypeError(
      `Unknown structured blocker occupied case ${JSON.stringify(fact.case)}${blockerContext(input)}`,
    );
  }
  if (fact.case === "occupied-destination" || fact.case === "occupied-parent") {
    if (
      typeof fact.occupation !== "string" ||
      !["directory", "file", "other", "symlink"].includes(fact.occupation)
    ) {
      throw new TypeError(
        `Structured blocker occupied fact requires a known occupation` +
          `${blockerContext(input)}`,
      );
    }
  }
}

function validateTypedFacts(input: StructuredBlockerInput): void {
  switch (input.kind) {
    case INSTALLATION_STATE_UNREADABLE:
      requireText(input.detail, "detail", input);
      return;
    case OCCUPIED_OUTPUT:
      validateOccupiedFact(input.occupied, input);
      if (
        input.remedyKey !== undefined &&
        !(OUTPUT_REMEDY_KEYS as readonly string[]).includes(input.remedyKey)
      ) {
        throw new TypeError(
          `Unknown structured blocker remedy key ${JSON.stringify(input.remedyKey)}${blockerContext(input)}`,
        );
      }
      return;
    case INSTALLATION_OWNERSHIP:
      if (input.action !== "remove" && input.action !== "verify") {
        throw new TypeError(
          `Structured blocker ownership action must be 'remove' or 'verify'${blockerContext(input)}`,
        );
      }
      requireText(input.detail, "detail", input);
      return;
    case TEMPORARY_INSTALLATION_REMOVAL:
      requireText(input.detail, "detail", input);
      return;
    case OUTPUT_OWNERSHIP_CONFLICT:
    case TEMPORARY_INSTALLATION_CONFLICT:
      return;
  }
}

function validateStructuredInput(input: StructuredBlockerInput): void {
  rejectProseFields(input);
  requireText(input.kind, "kind", input);
  if (!(BLOCKER_KINDS as readonly string[]).includes(input.kind)) {
    throw new TypeError(
      `Unknown structured blocker kind ${JSON.stringify(input.kind)}${blockerContext(input)}`,
    );
  }
  if (input.scope !== "global" && input.scope !== "project") {
    throw new TypeError(
      `Structured blocker scope must be 'global' or 'project'${blockerContext(input)}`,
    );
  }
  if (input.scope === "project") {
    requireText(input.project, "project", input);
  }
  if (input.scope === "global" && typeof (input as unknown as Record<string, unknown>).project === "string") {
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
    if (!(AFFECTED_ITEM_KINDS as readonly string[]).includes(item.kind)) {
      throw new TypeError(
        `Unknown structured blocker affected-item kind ${JSON.stringify(item.kind)}${blockerContext(input)}`,
      );
    }
  }
  validateTypedFacts(input);
}

function canonicalStructuredBlocker(input: StructuredBlockerInput): StructuredReconciliationBlocker {
  const affectedItems = Object.freeze(
    input.affectedItems.map((item) => Object.freeze({ kind: item.kind, value: item.value })),
  );
  return Object.freeze({
    ...(input.scope === "project" ? { project: input.project } : {}),
    affectedItems,
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    kind: input.kind,
    ...(input.occupied === undefined ? {} : { occupied: Object.freeze({ ...input.occupied }) }),
    ...(input.remedyKey === undefined ? {} : { remedyKey: input.remedyKey }),
    scope: input.scope,
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
 * The blocker contract is exhaustively typed-fact evidence; prose-carrying and
 * message-only blockers cannot be represented, and malformed evidence is
 * rejected loudly rather than degraded to a message.
 */
export function normalizeBlocker(
  input: BlockerInput,
  fallbackProject?: string,
): StructuredReconciliationBlocker {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Blocker input must be a structured blocker object");
  }
  if (!isStructuredInput(input)) {
    throw new TypeError(
      "Legacy message-only blockers are no longer supported; blockers must carry " +
      "complete structured evidence",
    );
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
