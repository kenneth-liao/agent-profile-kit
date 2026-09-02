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
 * The exhaustive typed Installation State read-failure facts the Installer
 * classifies. Foreign diagnostics (fs and parse errors) stay plain `detail`
 * facts; everything the Installer itself authors is rendered by presentation
 * from these discriminants.
 */
export const STATE_READ_FAILURE_CASES = [
  "legacy-yaml-state-expired",
  "oversize-state",
  "receipt-records-no-outputs",
] as const;

export type StateReadFailureFact =
  | { readonly case: "legacy-yaml-state-expired"; readonly retiredPath: string }
  | { readonly case: "oversize-state"; readonly limitBytes: number }
  | { readonly case: "receipt-records-no-outputs"; readonly project: string };

/**
 * The exhaustive typed Profile Installation ownership-failure facts. The
 * Installer classifies the failure; presentation owns every rendered sentence
 * keyed by the discriminant.
 */
export const OWNERSHIP_FAILURE_CASES = [
  "git-tracked-output",
  "no-ownership-continuity",
  "type-mismatch",
  "unsafe-parent",
  "unreadable-output",
  "unproven",
  "unsupported-entry",
] as const;

export type OwnershipFailureFact =
  | { readonly case: "git-tracked-output"; readonly outputs: readonly string[] }
  | { readonly case: "no-ownership-continuity"; readonly output: string }
  | { readonly case: "type-mismatch"; readonly expected: "directory" | "file"; readonly output: string }
  | { readonly case: "unsafe-parent"; readonly output: string; readonly parent: string }
  | { readonly case: "unreadable-output"; readonly output: string }
  | { readonly case: "unproven" }
  | { readonly case: "unsupported-entry"; readonly member: string; readonly output: string };

/**
 * The exhaustive typed Temporary Profile Installation removal-failure facts.
 * The Installer classifies the failure; presentation owns every rendered
 * sentence keyed by the discriminant.
 */
export const TEMPORARY_REMOVAL_FAILURE_CASES = [
  "git-tracked-output",
  "symlink-output",
  "unsafe-parent",
] as const;

export type TemporaryRemovalFailureFact =
  | { readonly case: "git-tracked-output"; readonly outputs: readonly string[] }
  | { readonly case: "symlink-output"; readonly output: string }
  | { readonly case: "unsafe-parent"; readonly output: string; readonly parent: string };

/** Common evidence every blocker carries. */
interface StructuredBlockerEvidence {
  readonly affectedItems: readonly BlockerAffectedItem[];
}

/**
 * Exhaustive typed blocker evidence, discriminated by `kind`. Every member
 * carries exactly the facts its presentation templates need; foreign fields are
 * `never`, so a partial or cross-contaminated blocker cannot compile. Every
 * field is a typed fact — kind, affected Project, affected paths, affected
 * Agent Host, plus the per-kind non-prose evidence. User-facing sentences do
 * not exist on this type: presentation owns every problem, requirement, and
 * remedy string keyed by {@link BlockerKind}, and runtime normalization still
 * rejects malformed untrusted input loudly.
 */
export type StructuredBlockerInput =
  | (StructuredBlockerEvidence & {
      readonly kind: typeof INSTALLATION_STATE_UNREADABLE;
      /** Installer-classified state-read failure; presentation owns the sentence. */
      readonly stateFailure: StateReadFailureFact;
      readonly scope: "global";
    })
    & { readonly action?: never; readonly detail?: never; readonly failure?: never; readonly occupied?: never; readonly project?: never; readonly remedyKey?: never }
  | (StructuredBlockerEvidence & {
      /** Foreign diagnostic detail fact (for example an fs or parse error message). Never Installer-authored. */
      readonly detail: string;
      readonly kind: typeof INSTALLATION_STATE_UNREADABLE;
      readonly scope: "global";
    })
    & { readonly action?: never; readonly failure?: never; readonly occupied?: never; readonly project?: never; readonly remedyKey?: never; readonly stateFailure?: never }
  | (StructuredBlockerEvidence & {
      readonly kind: typeof OCCUPIED_OUTPUT;
      readonly occupied: OccupiedOutputFact;
      /** Adapter remedy identity; presentation owns the remedy sentence it resolves to. */
      readonly remedyKey?: OutputRemedyKey;
      readonly scope: "project";
    })
    & { readonly action?: never; readonly detail?: never; readonly failure?: never; readonly project: string; readonly stateFailure?: never }
  | (StructuredBlockerEvidence & {
      readonly action: OwnershipBlockerAction;
      readonly failure: OwnershipFailureFact;
      readonly kind: typeof INSTALLATION_OWNERSHIP;
      readonly scope: "project";
    })
    & { readonly detail?: never; readonly occupied?: never; readonly project: string; readonly remedyKey?: never; readonly stateFailure?: never }
  | (StructuredBlockerEvidence & {
      readonly kind: typeof OUTPUT_OWNERSHIP_CONFLICT;
      readonly scope: "project";
    })
    & { readonly action?: never; readonly detail?: never; readonly failure?: never; readonly occupied?: never; readonly project: string; readonly remedyKey?: never; readonly stateFailure?: never }
  | (StructuredBlockerEvidence & {
      readonly kind: typeof TEMPORARY_INSTALLATION_CONFLICT;
      readonly scope: "project";
    })
    & { readonly action?: never; readonly detail?: never; readonly failure?: never; readonly occupied?: never; readonly project: string; readonly remedyKey?: never; readonly stateFailure?: never }
  | (StructuredBlockerEvidence & {
      readonly failure: TemporaryRemovalFailureFact;
      readonly kind: typeof TEMPORARY_INSTALLATION_REMOVAL;
      readonly scope: "project";
    })
    & { readonly action?: never; readonly detail?: never; readonly occupied?: never; readonly project: string; readonly remedyKey?: never; readonly stateFailure?: never };

/** The project-scoped variant of a structured blocker input. */
export type ProjectScopedBlockerInput = Extract<
  StructuredBlockerInput,
  { readonly scope: "project" }
>;

/** The global-scoped variant of a structured blocker input. */
export type GlobalScopedBlockerInput = Extract<
  StructuredBlockerInput,
  { readonly scope: "global" }
>;

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

/** Build one complete structured blocker for an Installer-classified state-read failure. */
export function installationStateUnreadableBlocker(options: {
  readonly stateFailure: StateReadFailureFact;
  readonly statePath: string;
}): GlobalScopedBlockerInput;
/** Build one complete structured blocker for a foreign state-read diagnostic. */
export function installationStateUnreadableBlocker(options: {
  readonly detail: string;
  readonly statePath: string;
}): GlobalScopedBlockerInput;
export function installationStateUnreadableBlocker(options: {
  readonly detail?: string;
  readonly stateFailure?: StateReadFailureFact;
  readonly statePath: string;
}): GlobalScopedBlockerInput {
  const affectedItems = [{ kind: "path" as const, value: options.statePath }];
  if (options.stateFailure !== undefined) {
    return {
      affectedItems,
      kind: INSTALLATION_STATE_UNREADABLE,
      scope: "global" as const,
      stateFailure: options.stateFailure,
    };
  }
  return {
    affectedItems,
    detail: options.detail!,
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
  readonly failure: OwnershipFailureFact;
  readonly project: string;
}): ProjectScopedBlockerInput {
  return {
    action: options.action,
    affectedItems: [],
    failure: options.failure,
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
  readonly failure: TemporaryRemovalFailureFact;
  readonly outputs: readonly string[];
  readonly project: string;
}): ProjectScopedBlockerInput {
  return {
    affectedItems: options.outputs.map((output) => ({ kind: "path" as const, value: output })),
    failure: options.failure,
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

function requireFailureCase(
  value: unknown,
  cases: readonly string[],
  field: string,
  input: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    throw new TypeError(
      `Structured blocker ${field} must be an object${blockerContext(input)}`,
    );
  }
  const fact = value as Record<string, unknown>;
  if (!cases.includes(fact.case as string)) {
    throw new TypeError(
      `Unknown structured blocker ${field} case ${JSON.stringify(fact.case)}${blockerContext(input)}`,
    );
  }
  return fact;
}

function requireTextProperty(
  fact: Record<string, unknown>,
  property: string,
  field: string,
  input: unknown,
): void {
  if (typeof fact[property] !== "string" || (fact[property] as string).length === 0) {
    throw new TypeError(
      `Structured blocker ${field} requires a non-empty ${property}${blockerContext(input)}`,
    );
  }
}

function validateStateReadFailure(
  value: unknown,
  input: unknown,
): asserts value is StateReadFailureFact {
  const fact = requireFailureCase(value, STATE_READ_FAILURE_CASES, "state-read failure", input);
  if (fact.case === "oversize-state") {
    if (typeof fact.limitBytes !== "number" || !Number.isInteger(fact.limitBytes) || fact.limitBytes <= 0) {
      throw new TypeError(
        `Structured blocker state-read failure requires a positive limitBytes${blockerContext(input)}`,
      );
    }
    return;
  }
  requireTextProperty(
    fact,
    fact.case === "legacy-yaml-state-expired" ? "retiredPath" : "project",
    "state-read failure",
    input,
  );
}

function validateOwnershipFailure(
  value: unknown,
  input: unknown,
): asserts value is OwnershipFailureFact {
  const fact = requireFailureCase(value, OWNERSHIP_FAILURE_CASES, "ownership failure", input);
  switch (fact.case) {
    case "git-tracked-output":
      if (
        !Array.isArray(fact.outputs) ||
        fact.outputs.length === 0 ||
        !fact.outputs.every((output) => typeof output === "string" && output.length > 0)
      ) {
        throw new TypeError(
          `Structured blocker ownership failure requires non-empty outputs${blockerContext(input)}`,
        );
      }
      return;
    case "unproven":
      return;
    case "type-mismatch":
      if (fact.expected !== "file" && fact.expected !== "directory") {
        throw new TypeError(
          `Structured blocker ownership failure requires a known expected type${blockerContext(input)}`,
        );
      }
      requireTextProperty(fact, "output", "ownership failure", input);
      return;
    default:
      requireTextProperty(fact, "output", "ownership failure", input);
  }
  if (fact.case === "unsafe-parent") {
    requireTextProperty(fact, "parent", "ownership failure", input);
  }
  if (fact.case === "unsupported-entry") {
    requireTextProperty(fact, "member", "ownership failure", input);
  }
}

function validateTemporaryRemovalFailure(
  value: unknown,
  input: unknown,
): asserts value is TemporaryRemovalFailureFact {
  const fact = requireFailureCase(
    value,
    TEMPORARY_REMOVAL_FAILURE_CASES,
    "temporary-removal failure",
    input,
  );
  if (fact.case === "git-tracked-output") {
    if (
      !Array.isArray(fact.outputs) ||
      fact.outputs.length === 0 ||
      !fact.outputs.every((output) => typeof output === "string" && output.length > 0)
    ) {
      throw new TypeError(
        `Structured blocker temporary-removal failure requires non-empty outputs${blockerContext(input)}`,
      );
    }
    return;
  }
  requireTextProperty(fact, "output", "temporary-removal failure", input);
  if (fact.case === "unsafe-parent") {
    requireTextProperty(fact, "parent", "temporary-removal failure", input);
  }
}

function validateTypedFacts(input: StructuredBlockerInput): void {
  switch (input.kind) {
    case INSTALLATION_STATE_UNREADABLE:
      if (input.stateFailure !== undefined && input.detail !== undefined) {
        throw new TypeError(
          `Structured blocker state-read cause must be either a stateFailure fact or a foreign detail, not both${blockerContext(input)}`,
        );
      }
      if (input.stateFailure === undefined && input.detail === undefined) {
        throw new TypeError(
          `Structured blocker state-read cause requires a stateFailure fact or a foreign detail${blockerContext(input)}`,
        );
      }
      if (input.detail !== undefined) {
        requireText(input.detail, "detail", input);
        return;
      }
      validateStateReadFailure(input.stateFailure, input);
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
      validateOwnershipFailure(input.failure, input);
      return;
    case TEMPORARY_INSTALLATION_REMOVAL:
      validateTemporaryRemovalFailure(input.failure, input);
      return;
    case OUTPUT_OWNERSHIP_CONFLICT:
    case TEMPORARY_INSTALLATION_CONFLICT:
      return;
  }
}

/**
 * Facts each blocker kind must never carry. `project` for the global kind is
 * handled by the dedicated global guard so its rejection message stays stable;
 * everything else is swept here whatever its value.
 */
const FORBIDDEN_BLOCKER_FIELDS: Readonly<Record<BlockerKind, readonly string[]>> = {
  [INSTALLATION_OWNERSHIP]: ["detail", "occupied", "remedyKey", "stateFailure"],
  [INSTALLATION_STATE_UNREADABLE]: ["action", "failure", "occupied", "remedyKey"],
  [OCCUPIED_OUTPUT]: ["action", "detail", "failure", "stateFailure"],
  [OUTPUT_OWNERSHIP_CONFLICT]: ["action", "detail", "failure", "occupied", "remedyKey", "stateFailure"],
  [TEMPORARY_INSTALLATION_CONFLICT]: [
    "action",
    "detail",
    "failure",
    "occupied",
    "remedyKey",
    "stateFailure",
  ],
  [TEMPORARY_INSTALLATION_REMOVAL]: ["action", "detail", "occupied", "remedyKey", "stateFailure"],
};

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
  const blockerKind: string = input.kind;
  if (blockerKind === INSTALLATION_STATE_UNREADABLE && input.scope !== "global") {
    throw new TypeError(
      `Structured blocker kind ${blockerKind} is always global-scoped${blockerContext(input)}`,
    );
  }
  if (blockerKind !== INSTALLATION_STATE_UNREADABLE && input.scope !== "project") {
    throw new TypeError(
      `Structured blocker kind ${blockerKind} is always project-scoped${blockerContext(input)}`,
    );
  }
  if (input.scope === "project") {
    requireText(input.project, "project", input);
  }
  // Cross-kind facts are forbidden on every kind by own-property presence:
  // an explicitly `undefined` contaminant is rejected exactly like a value,
  // so the boundary never silently drops forbidden fields (poka-yoke).
  const record = input as unknown as Record<string, unknown>;
  const hasOwn = (field: string): boolean => Object.prototype.hasOwnProperty.call(record, field);
  if (input.scope === "global" && hasOwn("project")) {
    throw new TypeError(
      `Global structured blockers cannot carry a project${blockerContext(input)}`,
    );
  }
  for (const field of FORBIDDEN_BLOCKER_FIELDS[blockerKind as BlockerKind]) {
    if (hasOwn(field)) {
      throw new TypeError(
        `Structured blocker kind ${blockerKind} must not carry "${field}"${blockerContext(input)}`,
      );
    }
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
  switch (input.kind) {
    case INSTALLATION_STATE_UNREADABLE:
      if ("stateFailure" in input) {
        return Object.freeze({
          affectedItems,
          kind: INSTALLATION_STATE_UNREADABLE,
          scope: "global" as const,
          stateFailure: Object.freeze({ ...input.stateFailure }),
          [STRUCTURED_BLOCKER]: true as const,
        });
      }
      return Object.freeze({
        affectedItems,
        detail: input.detail,
        kind: INSTALLATION_STATE_UNREADABLE,
        scope: "global" as const,
        [STRUCTURED_BLOCKER]: true as const,
      });
    case OCCUPIED_OUTPUT:
      return Object.freeze({
        affectedItems,
        kind: OCCUPIED_OUTPUT,
        occupied: Object.freeze({ ...input.occupied }),
        project: input.project,
        ...(input.remedyKey === undefined ? {} : { remedyKey: input.remedyKey }),
        scope: "project" as const,
        [STRUCTURED_BLOCKER]: true as const,
      });
    case INSTALLATION_OWNERSHIP:
      return Object.freeze({
        action: input.action,
        affectedItems,
        failure: Object.freeze({ ...input.failure }),
        kind: INSTALLATION_OWNERSHIP,
        project: input.project,
        scope: "project" as const,
        [STRUCTURED_BLOCKER]: true as const,
      });
    case TEMPORARY_INSTALLATION_REMOVAL:
      return Object.freeze({
        affectedItems,
        failure: Object.freeze({ ...input.failure }),
        kind: TEMPORARY_INSTALLATION_REMOVAL,
        project: input.project,
        scope: "project" as const,
        [STRUCTURED_BLOCKER]: true as const,
      });
    case OUTPUT_OWNERSHIP_CONFLICT:
    case TEMPORARY_INSTALLATION_CONFLICT:
      return Object.freeze({
        affectedItems,
        kind: input.kind,
        project: input.project,
        scope: "project" as const,
        [STRUCTURED_BLOCKER]: true as const,
      });
  }
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
