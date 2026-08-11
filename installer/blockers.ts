import {
  capabilityRequirement,
  isAdapterCapabilityError,
  type AdapterCapabilityAffectedItem,
} from "../adapters/capability.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import { join } from "node:path";
import {
  compareCanonicalStrings,
  INSTALLATION_MARKER_PATH,
} from "../schemas/installation-manifest.js";

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

interface StructuredBlockerCommon {
  readonly affectedItems: readonly BlockerAffectedItem[];
  /** Typed blocker class; the exhaustive vocabulary is {@link BLOCKER_KINDS}. */
  readonly kind: BlockerKind;
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
export type StructuredReconciliationBlocker =
  | (StructuredBlockerInput & { readonly [STRUCTURED_BLOCKER]: true });

export type ReconciliationBlocker = StructuredReconciliationBlocker;

export type BlockerInput = StructuredBlockerInput;

/** Convert one Adapter capability failure to the shared structured contract. */
export function hostCapabilityBlocker(
  error: unknown,
  host: SupportedHost,
  project: string,
  displayProject?: string,
): StructuredBlockerInput {
  const failure = isAdapterCapabilityError(error) ? error : undefined;
  const message = failure?.message ?? (error instanceof Error ? error.message : String(error));
  return {
    affectedItems: failure === undefined
      ? [{ kind: "host", value: host }]
      : capabilityAffectedItems(failure.affectedItems),
    kind: failure === undefined ? HOST_CAPABILITY_UNCLASSIFIED : HOST_CAPABILITY,
    message: displayProject === undefined
      ? message
      : `${displayProject}: ${message}`,
    problem: failure?.problem ?? "Host capability preflight could not complete",
    project,
    remedy: failure?.remedy ?? "Inspect the underlying error before retrying",
    requirement: failure?.requirement ?? capabilityRequirement(host),
    scope: "project",
  };
}

/**
 * Translate Adapter-owned capability evidence (host/path) into the shared
 * blocker affected-item vocabulary at the boundary where Adapter failures
 * become blocker evidence, rejecting anything outside that vocabulary loudly
 * instead of letting it flow downstream.
 */
function capabilityAffectedItems(
  items: readonly AdapterCapabilityAffectedItem[],
): BlockerAffectedItem[] {
  return items.map((item) => {
    if (!(AFFECTED_ITEM_KINDS as readonly string[]).includes(item.kind)) {
      throw new TypeError(
        `Adapter capability failure carries unknown affected-item kind ${JSON.stringify(item.kind)}`,
      );
    }
    return { kind: item.kind, value: item.value };
  });
}

/** Typed blocker class for a detected Agent Host capability failure. */
export const HOST_CAPABILITY = "host-capability" as const;

/** Typed blocker class for an unclassified Host capability preflight failure. */
export const HOST_CAPABILITY_UNCLASSIFIED = "host-capability-unclassified" as const;

/** Typed blocker class for planned output that conflicts with Git-tracked repository ownership. */
export const OUTPUT_OWNERSHIP_CONFLICT = "output-ownership-conflict" as const;

/** Typed blocker class for unreadable machine-local Installation State. */
export const INSTALLATION_STATE_UNREADABLE = "installation-state-unreadable" as const;

/** Typed blocker class for Git exclusion ownership evidence that does not match recorded state. */
export const REPOSITORY_EXCLUSION_RECORD = "repository-exclusion-record" as const;

/** Typed blocker class for a Git project or repository-local target that cannot be proven. */
export const REPOSITORY_EXCLUSION_TARGET_UNPROVEN = "repository-exclusion-target-unproven" as const;

/** Typed blocker class for a missing recorded exclusion section during intentional-deletion retirement. */
export const REPOSITORY_EXCLUSION_SECTION_MISSING = "repository-exclusion-section-missing" as const;

/** Typed blocker class for unreadable, unsafe, or modified repository-local exclusion state. */
export const REPOSITORY_EXCLUSION_INVALID = "repository-exclusion-invalid" as const;

/** Typed blocker class for planned output whose destination or parent is occupied by unowned material. */
export const OCCUPIED_OUTPUT = "occupied-output" as const;

/** Typed blocker class for a missing, malformed, or foreign Installation Marker. */
export const INSTALLATION_MARKER = "installation-marker" as const;

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
  HOST_CAPABILITY,
  HOST_CAPABILITY_UNCLASSIFIED,
  OUTPUT_OWNERSHIP_CONFLICT,
  INSTALLATION_STATE_UNREADABLE,
  REPOSITORY_EXCLUSION_RECORD,
  REPOSITORY_EXCLUSION_TARGET_UNPROVEN,
  REPOSITORY_EXCLUSION_SECTION_MISSING,
  REPOSITORY_EXCLUSION_INVALID,
  OCCUPIED_OUTPUT,
  INSTALLATION_MARKER,
  INSTALLATION_OWNERSHIP,
  TEMPORARY_INSTALLATION_CONFLICT,
  TEMPORARY_INSTALLATION_REMOVAL,
] as const;

/** Exhaustive typed blocker class. */
export type BlockerKind = (typeof BLOCKER_KINDS)[number];

function globalBlocker(input: {
  readonly affectedItems: readonly BlockerAffectedItem[];
  readonly kind: BlockerKind;
  readonly message: string;
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;
}): GlobalScopedBlockerInput {
  return {
    affectedItems: input.affectedItems,
    kind: input.kind,
    message: input.message,
    problem: input.problem,
    remedy: input.remedy,
    requirement: input.requirement,
    scope: "global" as const,
  };
}

function projectBlocker(input: {
  readonly affectedItems: readonly BlockerAffectedItem[];
  readonly kind: BlockerKind;
  readonly message: string;
  readonly problem: string;
  readonly project: string;
  readonly remedy: string;
  readonly requirement: string;
}): ProjectScopedBlockerInput {
  return {
    affectedItems: input.affectedItems,
    kind: input.kind,
    message: input.message,
    problem: input.problem,
    project: input.project,
    remedy: input.remedy,
    requirement: input.requirement,
    scope: "project" as const,
  };
}

/** Build one complete structured blocker for unreadable Installation State. */
export function installationStateUnreadableBlocker(options: {
  readonly message: string;
  readonly statePath: string;
}): GlobalScopedBlockerInput {
  return globalBlocker({
    affectedItems: [{ kind: "path", value: options.statePath }],
    kind: INSTALLATION_STATE_UNREADABLE,
    message: options.message,
    problem: "Installation State could not be read",
    remedy: "Restore or repair the Installation State file, then retry",
    requirement: "Lifecycle commands require readable Installation State",
  });
}

/** Build one complete structured blocker for Git exclusion ownership evidence that does not match. */
export function repositoryExclusionRecordBlocker(options: {
  readonly affectedItems: readonly BlockerAffectedItem[];
  readonly message: string;
}): GlobalScopedBlockerInput {
  return globalBlocker({
    affectedItems: options.affectedItems,
    kind: REPOSITORY_EXCLUSION_RECORD,
    message: options.message,
    problem:
      "A Repository Exclusion Record does not match its recorded Installation Manifest, " +
      "Installation ID, or the live Git repository-local target",
    remedy:
      "Restore Installation State from a known-good backup so each Repository Exclusion " +
      "Record matches its Installation Manifest, Installation ID, and live Git " +
      "repository-local target, then retry",
    requirement:
      "Repository Exclusion Records must remain the canonical machine-local ownership " +
      "source for Git exclusion contributions",
  });
}

/** Build one complete structured blocker for a recorded Git target that cannot be proven. */
export function repositoryExclusionTargetUnprovenBlocker(options: {
  readonly message: string;
  readonly project: string;
}): GlobalScopedBlockerInput {
  return globalBlocker({
    affectedItems: [{ kind: "path", value: options.project }],
    kind: REPOSITORY_EXCLUSION_TARGET_UNPROVEN,
    message: options.message,
    problem:
      "The Git project or repository-local exclusion target recorded by an Installation " +
      "Manifest could not be proven",
    remedy:
      "Restore the Project root or Git repository at the recorded path, or restore " +
      "Installation State from a known-good backup, then retry",
    requirement:
      "Git exclusion ownership validation requires a provable Project root and live Git " +
      "repository-local exclusion target",
  });
}

/** Build one complete structured blocker for a missing recorded exclusion section during retirement. */
export function repositoryExclusionSectionMissingBlocker(options: {
  readonly message: string;
  readonly target: string;
}): GlobalScopedBlockerInput {
  return globalBlocker({
    affectedItems: [{ kind: "path", value: options.target }],
    kind: REPOSITORY_EXCLUSION_SECTION_MISSING,
    message: options.message,
    problem:
      "An intentionally deleted Git project's recorded exclusion section is missing " +
      "from its repository-local exclude file",
    remedy:
      "Restore the recorded Agent Profile Kit exclusion section in the repository-local " +
      "exclude file, then retry",
    requirement:
      "Intentional-deletion retirement requires the recorded Agent Profile Kit exclusion " +
      "section to be present",
  });
}

/** Build one complete structured blocker for unreadable or unsafe repository-local exclusion state. */
export function repositoryExclusionInvalidBlocker(options: {
  readonly message: string;
  readonly target: string;
}): GlobalScopedBlockerInput {
  return globalBlocker({
    affectedItems: [{ kind: "path", value: options.target }],
    kind: REPOSITORY_EXCLUSION_INVALID,
    message: options.message,
    problem: "A repository-local Git exclusion target could not be read or validated safely",
    remedy:
      "Repair the repository-local exclusion file to match the recorded Agent Profile Kit " +
      "ownership, or restore a backup, then retry",
    requirement:
      "Git exclusion preflight fails closed on unreadable, unsafe, or modified " +
      "repository-local exclusion state",
  });
}

/** Build one complete structured blocker for a planned output destination that is occupied. */
export function occupiedOutputBlocker(options: {
  readonly message: string;
  readonly path: string;
  readonly project: string;
}): ProjectScopedBlockerInput {
  return projectBlocker({
    affectedItems: [{ kind: "path", value: options.path }],
    kind: OCCUPIED_OUTPUT,
    message: options.message,
    problem:
      "A planned generated path or one of its parents is occupied by material Agent " +
      "Profile Kit does not own",
    project: options.project,
    remedy:
      "Remove, move, or adopt the occupying material yourself, or change the Project " +
      "Binding or Host selection so Agent Profile Kit does not plan output at that path, " +
      "then retry",
    requirement:
      "Generated output is installed only at new or Agent Profile Kit-owned destinations; " +
      "occupied unowned material is never overwritten or adopted",
  });
}

/** Build one complete structured blocker for a missing, malformed, or foreign Installation Marker. */
export function installationMarkerBlocker(options: {
  readonly message: string;
  readonly project: string;
}): ProjectScopedBlockerInput {
  return projectBlocker({
    affectedItems: [{ kind: "path", value: INSTALLATION_MARKER_PATH }],
    kind: INSTALLATION_MARKER,
    message: options.message,
    problem:
      "The Installation Marker that links this Project to its Installation Manifest is " +
      "missing, malformed, or owned by another installation",
    project: options.project,
    remedy:
      "Restore the Installation Marker linked to this Project's Installation Manifest, or " +
      "remove the unowned generated paths, then retry",
    requirement:
      "The Installation Marker must prove one Manifest-linked installation identity at " +
      "the Project root",
  });
}

/** Build one complete structured blocker for unprovable Profile Installation ownership. */
export function installationOwnershipBlocker(options: {
  readonly message: string;
  readonly project: string;
}): ProjectScopedBlockerInput {
  return projectBlocker({
    affectedItems: [],
    kind: INSTALLATION_OWNERSHIP,
    message: options.message,
    problem:
      "The Profile Installation's owned output could not be proven or reconciled at its " +
      "recorded Project root",
    project: options.project,
    remedy:
      "Move the change into the Workspace, restore the Installation Marker, or delete the " +
      "conflicting generated files yourself, then retry",
    requirement:
      "Agent Profile Kit reconciles or removes only output whose ownership is proven by " +
      "the Installation Manifest, Marker, and recorded hashes",
  });
}

/** Build one complete structured blocker for a Temporary Profile Installation lifetime conflict. */
export function temporaryInstallationConflictBlocker(options: {
  readonly message: string;
  readonly project: string;
  readonly temporaryInstallationId?: string;
}): ProjectScopedBlockerInput {
  return projectBlocker({
    affectedItems: options.temporaryInstallationId === undefined
      ? []
      : [{ kind: "installation-id", value: options.temporaryInstallationId }],
    kind: TEMPORARY_INSTALLATION_CONFLICT,
    message: options.message,
    problem:
      "The Project already hosts an installation whose lifetime conflicts with a " +
      "receipt-owned temporary installation",
    project: options.project,
    remedy:
      "Remove the existing ordinary Profile Installation or the active Temporary Profile " +
      "Installation, then retry install-temp",
    requirement:
      "A Project hosts at most one Profile Installation at a time; temporary lifetime is " +
      "receipt-owned under ADR-0015",
  });
}

/** Build one complete structured blocker for a Temporary Profile Installation that cannot be removed safely. */
export function temporaryInstallationRemovalBlocker(options: {
  readonly message: string;
  readonly outputs: readonly string[];
  readonly project: string;
}): ProjectScopedBlockerInput {
  return projectBlocker({
    affectedItems: options.outputs.map((output) => ({ kind: "path" as const, value: output })),
    kind: TEMPORARY_INSTALLATION_REMOVAL,
    message: options.message,
    problem:
      "A Temporary Profile Installation could not be removed because its owned output or " +
      "Installation Marker could not be proven safely",
    project: options.project,
    remedy:
      "Restore the Installation Marker matching the temporary installation identity, or " +
      "remove the owned output yourself after verifying the paths, then retry remove-temp",
    requirement:
      "remove-temp removes only ownership-proven temporary-owned roots and never " +
      "traverses outside recorded project-relative roots",
  });
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
}): StructuredBlockerInput {
  if (options.paths.length === 0) {
    throw new TypeError("Output ownership conflict requires at least one conflicting path");
  }
  const paths = [...options.paths].sort(compareCanonicalStrings);
  const first = join(options.project, paths[0]!);
  return {
    affectedItems: paths.map((path) => ({ kind: "path", value: path })),
    kind: OUTPUT_OWNERSHIP_CONFLICT,
    // The message projection is the human presentation string; machine
    // consumers read the structured evidence. When grouped it stays
    // self-describing so a user fixing one conflict at a time still sees how
    // many remain.
    message: paths.length === 1
      ? `${first} is a tracked project path`
      : `${first} and ${paths.length - 1} more tracked project ` +
        `${paths.length === 2 ? "path" : "paths"}`,
    problem:
      "These generated paths are tracked by Git, so Agent Profile Kit cannot write to them " +
      "without conflicting with repository ownership.",
    remedy:
      "Choose one: keep repository ownership and change the Project Binding or its Host " +
      "selection so Agent Profile Kit does not plan output at these paths, or intentionally " +
      "remove the conflicting paths from repository ownership yourself before retrying. " +
      "Agent Profile Kit will not delete, untrack, adopt, or overwrite repository-owned material.",
    requirement:
      "Generated files must be exclusively managed by Agent Profile Kit; repository-owned " +
      "paths cannot be replaced.",
    project: options.project,
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
    if (!(AFFECTED_ITEM_KINDS as readonly string[]).includes(item.kind)) {
      throw new TypeError(
        `Unknown structured blocker affected-item kind ${JSON.stringify(item.kind)}${blockerContext(input)}`,
      );
    }
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
 * The blocker contract is exhaustively structured; message-only blockers can
 * no longer be represented, and malformed structured evidence is rejected
 * loudly rather than degraded to a message.
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

export function blockerMessage(input: BlockerInput): string {
  return normalizeBlocker(input).message;
}
