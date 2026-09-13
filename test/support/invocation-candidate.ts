import type { SuiteMode } from "./suite-supervisor.js";

import { INVOCATION_PACKAGE_CONSUMERS } from "./package-archive.js";

/**
 * One concern: deriving whether a supervised invocation must prepare the
 * invocation package candidate. Need is the intersection of the invocation's
 * mode selection with the explicit consumer registry
 * (`INVOCATION_PACKAGE_CONSUMERS` in `test/support/package-archive.ts`) —
 * never an import-graph inference, so need derivation stays a pure function
 * of the derived selection and the registry. Preparation orchestration lives
 * in the suite supervisor; the consumer seam lives in `package-archive.ts`.
 */

/**
 * Why an invocation must (or must not) prepare a candidate. `consumers` lists
 * the registered consumer files that drove a package need; `evidence` is the
 * truthful record of why preparation does or does not run, including the
 * filter-only case's explicit limit.
 */
export type InvocationPackageNeed =
  | {
      readonly kind: "package";
      readonly consumers: readonly string[];
      readonly evidence: string;
    }
  | {
      readonly kind: "none";
      readonly evidence: string;
    };

export interface InvocationNeedInput {
  readonly mode: SuiteMode;
  /** Required selection, POSIX-relative to the corpus base. */
  readonly selected: readonly string[];
  /** Focused arguments naming corpus files; other arguments are filters. */
  readonly named: readonly string[];
  readonly nameFilterActive: boolean;
  /** Every corpus file before the exclusion policy, for registry validation. */
  readonly inventoryFiles: readonly string[];
  /** Overrides the registry (fixture corpora); defaults to the registry. */
  readonly consumers?: readonly string[];
}

/**
 * Derive one invocation's package need.
 *
 * - Full and stress selections intersect the registry with the derived
 *   required selection.
 * - Focused selections with named corpus files intersect the registry with
 *   those named files only: the runner loads only the given files, so a name
 *   filter supplied beside them cannot reach files it did not name.
 * - Filter-only focused selections (no named corpus files but an active name
 *   filter — for example a bare `-t`) conservatively scan the full required
 *   inventory: the runner searched the whole test root, a name filter cannot
 *   name the files a matching test executes in, and the runner loads matching
 *   files fully — hooks included. Measured on the pinned runner (bun 1.4.0):
 *   a `-t` pattern that matches zero tests neither loads file-scoped
 *   `beforeAll` hooks nor exits green, but a matching `-t` loads its file
 *   fully, so preparation is owed whenever registered consumers remain in the
 *   inventory, stated truthfully in the evidence rather than silently.
 * - Focused selections whose arguments name only files outside the corpus
 *   inventory (for example support fixtures) execute only those given files,
 *   which cannot be registered consumers: need is none, stated truthfully.
 *
 * Every registry entry must name a file in the current corpus inventory
 * (before the exclusion policy, so a policy-excluded consumer such as the
 * fleet file stays valid); an entry matching nothing is a hard error, the
 * same fail-closed rule as the corpus exclusion patterns, so a stale entry
 * cannot silently stop preparing.
 */
export function deriveInvocationPackageNeed(input: InvocationNeedInput): InvocationPackageNeed {
  const consumers = input.consumers ?? INVOCATION_PACKAGE_CONSUMERS;
  const inventory = new Set(input.inventoryFiles);
  const stale = consumers.filter((consumer) => !inventory.has(consumer));
  if (stale.length > 0) {
    throw new Error(
      `invocation package consumer registry entry(ies) match nothing in the current corpus inventory: ${stale.join(", ")}`,
    );
  }
  const selectedConsumers = consumers.filter((consumer) => input.selected.includes(consumer));
  if (input.mode === "focused" && input.named.length > 0) {
    const namedConsumers = consumers.filter((consumer) => input.named.includes(consumer));
    if (namedConsumers.length > 0) {
      return {
        kind: "package",
        consumers: namedConsumers,
        evidence: `focused selection names registered package consumer file(s): ${namedConsumers.join(", ")}`,
      };
    }
    return {
      kind: "none",
      evidence: `focused selection names no registered package consumer file (${input.named.join(", ")})`,
    };
  }
  if (input.mode === "focused") {
    if (input.nameFilterActive) {
      if (selectedConsumers.length > 0) {
        return {
          kind: "package",
          consumers: selectedConsumers,
          evidence: `filter-only focused selection cannot name executed files; prepared because registered package consumer file(s) remain in the inventory: ${selectedConsumers.join(", ")}`,
        };
      }
      return {
        kind: "none",
        evidence: "filter-only focused selection contains no registered package consumer file",
      };
    }
    // Without a name filter the runner executes only the files the arguments
    // named, and none of them is in the corpus inventory, so none can be a
    // registered consumer.
    return {
      kind: "none",
      evidence:
        "focused selection names only files outside the corpus inventory, which the runner alone executes and which cannot be registered package consumers",
    };
  }
  if (selectedConsumers.length > 0) {
    return {
      kind: "package",
      consumers: selectedConsumers,
      evidence: `${input.mode} selection includes registered package consumer file(s): ${selectedConsumers.join(", ")}`,
    };
  }
  return {
    kind: "none",
    evidence: `${input.mode} selection includes no registered package consumer file`,
  };
}