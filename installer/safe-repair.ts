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
  | "missing-contribution";

/**
 * One proven Safe Repair. `missing-contribution` carries the exact entries the
 * active Installation Receipt, Marker, owned roots, live Project, untracked
 * destinations, and Git target independently prove; `exclusion-section` carries
 * the recorded union a damaged exclude file must be restored to.
 */
export type SafeRepair =
  | {
      readonly class: "absent-output";
      readonly installationId: string;
      readonly paths: readonly string[];
    }
  | { readonly class: "missing-marker"; readonly installationId: string }
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
    };

/** Repository-local exclusion repair classes carried by reconciliation reports. */
export type SafeRepairExclusionRepair = Extract<
  SafeRepair,
  { readonly class: "exclusion-section" | "missing-contribution" }
>;

/** One provably missing receipt-owned Repository Exclusion Contribution. */
export type MissingContributionRepair = Extract<
  SafeRepair,
  { readonly class: "missing-contribution" }
>;

/**
 * Eligibility decision for one candidate Safe Repair condition. Ineligible
 * candidates remain typed Blockers at the condition's existing Blocker site.
 */
export type SafeRepairEligibility<R extends SafeRepair = SafeRepair> =
  | { readonly eligible: true; readonly repair: R }
  | { readonly eligible: false; readonly cause: "incoherent-exclusion-bytes" };

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

/**
 * Overlay proven missing-contribution repairs onto Installation State so
 * byte-level validation sees the union the receipts independently prove. The
 * overlay is validation-only: apply persists each contribution through the
 * ordinary state write, never through this projection.
 */
export function withProvenSafeRepairs(
  state: OwnershipState,
  repairs: readonly SafeRepairExclusionRepair[],
): OwnershipState {
  return {
    ...state,
    receipts: repairs.filter(isMissingContributionRepair).reduce(
      (receipts, repair) =>
        withRepositoryExclusion(receipts, repair.installationId, {
          entries: repair.entries,
          target: repair.target,
        }),
      state.receipts,
    ),
  };
}
