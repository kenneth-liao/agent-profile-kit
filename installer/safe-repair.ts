/**
 * Exhaustive typed Safe Repair eligibility boundary (ADR-0022).
 *
 * Every supported Safe Repair class constructs a `SafeRepair` member at its
 * actual decision site and is classified through `safeRepairItemClassification`.
 * Adding a repair class requires extending this union and every exhaustive
 * consumer, so a repair can never surface through an ad-hoc inline branch.
 * Evidence capture and presentation stay at each class's existing seam; this
 * boundary owns only the class vocabulary.
 *
 * Repository-local exclusion bookkeeping is not a Safe Repair class: it is
 * derived, best-effort output that `apply` publishes unconditionally and that
 * can never block or require repair.
 */
export type SafeRepairClass = "absent-output";

/**
 * One proven Safe Repair. Wholly absent recorded output roots are repairable
 * pending work that `apply` restores from the receipt and the Workspace.
 */
export type SafeRepair =
  | { readonly class: "absent-output"; readonly paths: readonly string[] };

export interface SafeRepairItemClassification {
  readonly kind: "current" | "repairable missing output" | "update";
  readonly reason?: string;
}

/** Repair classes that surface through a Project state item. */
export type SafeRepairWithProjectItem = SafeRepair;

/**
 * Classify one Project-item Safe Repair into its existing Project state item.
 */
export function safeRepairItemClassification(
  repair: SafeRepairWithProjectItem,
): SafeRepairItemClassification {
  switch (repair.class) {
    case "absent-output":
      return { kind: "repairable missing output", reason: repair.paths.join(", ") };
  }
}
