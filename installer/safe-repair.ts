import { withRepositoryExclusion } from "./ownership-state.js";
import type { OwnershipState } from "../schemas/ownership-state.js";

/**
 * Exhaustive typed Safe Repair eligibility boundary (ADR-0022).
 *
 * Every supported Safe Repair class constructs a `SafeRepair` member at its
 * actual decision site and is classified through `safeRepairItemClassification`
 * or `SafeRepairEligibility`. Adding a repair class requires extending this
 * union and every exhaustive consumer, so a repair can never surface through an
 * ad-hoc inline branch. Evidence capture and presentation stay at each class's
 * existing seam; this boundary owns only the class vocabulary and the
 * eligible-versus-Blocker decision shape.
 */
export type SafeRepairClass =
  | "absent-output"
  | "missing-marker"
  | "exclusion-section"
  | "missing-contribution"
  | "stale-contribution";

/**
 * One proven Safe Repair. `missing-contribution` carries the exact entries the
 * active Installation Receipt, Marker, owned roots, live Project, untracked
 * destinations, and Git target independently prove; `stale-contribution` carries
 * the exact stale recorded entries plus the one replacement those proofs derive
 * at the unchanged Git target; `exclusion-section` carries the recorded union a
 * damaged exclude file must be restored to.
 */
export type SafeRepair =
  | { readonly class: "absent-output"; readonly paths: readonly string[] }
  | { readonly class: "missing-marker" }
  | {
      readonly class: "exclusion-section";
      readonly target: string;
      readonly entries: readonly string[];
    }
  | {
      readonly class: "missing-contribution";
      readonly installationId: string;
      readonly target: string;
      readonly entries: readonly string[];
    }
  | {
      readonly class: "stale-contribution";
      readonly installationId: string;
      readonly target: string;
      readonly currentEntries: readonly string[];
      readonly entries: readonly string[];
    };

/** Repository-local exclusion repair classes carried by reconciliation reports. */
export type SafeRepairExclusionRepair = Extract<
  SafeRepair,
  { readonly class: "exclusion-section" | "missing-contribution" | "stale-contribution" }
>;

/** One provably missing receipt-owned Repository Exclusion Contribution. */
export type MissingContributionRepair = Extract<
  SafeRepair,
  { readonly class: "missing-contribution" }
>;

/** One provably stale receipt-owned Repository Exclusion Contribution. */
export type StaleContributionRepair = Extract<
  SafeRepair,
  { readonly class: "stale-contribution" }
>;

/**
 * Eligibility decision for one candidate Safe Repair condition. Ineligible
 * candidates remain typed Blockers at the condition's existing Blocker site.
 * `unreadable-exclusion-bytes` marks a target that could not be read or parsed
 * (including unsafe paths); `incoherent-exclusion-bytes` marks a readable owned
 * section whose entries are not exactly the bytes the recorded contributions
 * prove — the recorded union plus the proven contribution for a missing
 * contribution, or the recorded union itself for a stale contribution;
 * `unchanged-contribution` marks a recorded contribution that already equals
 * the entries its receipt derives, so no stale correction is pending.
 */
export type SafeRepairEligibility<R extends SafeRepair = SafeRepair> =
  | { readonly eligible: true; readonly repair: R }
  | {
      readonly eligible: false;
      readonly cause:
        | "incoherent-exclusion-bytes"
        | "unreadable-exclusion-bytes"
        | "unchanged-contribution";
    };

export interface SafeRepairItemClassification {
  readonly kind: "current" | "repairable missing output" | "update";
  readonly reason?: string;
}

/** Repair classes that surface through a Project state item. */
export type SafeRepairWithProjectItem = Extract<
  SafeRepair,
  { readonly class: "absent-output" | "missing-marker" | "missing-contribution" }
>;

/**
 * Classify one Project-item Safe Repair into its existing Project state item.
 * Exclusion-local classes surface through repository exclusion repairs and the
 * exclusion clause instead of a Project state item.
 */
export function safeRepairItemClassification(
  repair: SafeRepairWithProjectItem,
): SafeRepairItemClassification {
  switch (repair.class) {
    case "absent-output":
      return { kind: "repairable missing output", reason: repair.paths.join(", ") };
    case "missing-marker":
      return { kind: "update", reason: "Installation Marker is missing and repairable" };
    case "missing-contribution":
      return { kind: "current" };
  }
}

export function isMissingContributionRepair(
  repair: SafeRepair,
): repair is Extract<SafeRepair, { readonly class: "missing-contribution" }> {
  return repair.class === "missing-contribution";
}

export function isStaleContributionRepair(
  repair: SafeRepair,
): repair is StaleContributionRepair {
  return repair.class === "stale-contribution";
}

/** Repair classes owned by the contribution pass and the contribution overlay. */
export function isContributionRepair(
  repair: SafeRepair,
): repair is MissingContributionRepair | StaleContributionRepair {
  return repair.class === "missing-contribution" || repair.class === "stale-contribution";
}

/**
 * Overlay proven contribution repairs (missing and stale) onto Installation
 * State so the receipts carry the exact contributions the proofs derive.
 * Byte-level validation in `gitExclusionBlockers` overlays only the missing
 * subset — a stale target's live section must still match the un-overlaid
 * recorded union — while apply's contribution pass stages the missing-only
 * projection as the staged current state and this full projection as the
 * staged next state, then persists the full projection through the ordinary
 * `writeState` call.
 */
export function withProvenSafeRepairs(
  state: OwnershipState,
  repairs: readonly SafeRepairExclusionRepair[],
): OwnershipState {
  return {
    ...state,
    receipts: [
      ...repairs.filter(isMissingContributionRepair),
      ...repairs.filter(isStaleContributionRepair),
    ].reduce(
      (receipts, repair) =>
        withRepositoryExclusion(receipts, repair.installationId, {
          entries: repair.entries,
          target: repair.target,
        }),
      state.receipts,
    ),
  };
}
