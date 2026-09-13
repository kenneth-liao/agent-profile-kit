import { describe, expect, test } from "bun:test";

import { INVOCATION_PACKAGE_CONSUMERS } from "./support/package-archive.js";
import {
  deriveInvocationPackageNeed,
  type InvocationNeedInput,
} from "./support/invocation-candidate.js";

/**
 * Pure need-derivation proofs: need is the intersection of the invocation's
 * mode selection with the explicit consumer registry, never an import-graph
 * inference. The real-runner proofs that preparation commands follow this
 * derivation live in test/invocation-preparation.test.ts.
 */

/** A corpus inventory shaped like the real one: test-suffixed files only. */
const CORPUS = [
  "test/cli.test.ts",
  "test/golden-snapshots.test.ts",
  "test/release-boundary.test.ts",
  "test/release-candidate.test.ts",
  "test/fleet-qualification.test.ts",
  "test/package-archive.test.ts",
  "test/corpus-inventory.test.ts",
  "test/pure.test.ts",
] as const;

const need = (overrides: Partial<InvocationNeedInput>): ReturnType<typeof deriveInvocationPackageNeed> =>
  deriveInvocationPackageNeed({
    mode: "full",
    selected: CORPUS,
    named: [],
    nameFilterActive: false,
    inventoryFiles: CORPUS,
    ...overrides,
  });

describe("invocation package need derivation", () => {
  test("a full or stress selection containing a registered consumer needs the package", () => {
    for (const mode of ["full", "stress"] as const) {
      const derived = need({ mode, selected: ["test/cli.test.ts", "test/pure.test.ts"] });
      expect(derived).toEqual({
        kind: "package",
        consumers: ["test/cli.test.ts"],
        evidence: `${mode} selection includes registered package consumer file(s): test/cli.test.ts`,
      });
    }
  });

  test("a focused selection naming a registered consumer needs the package", () => {
    const derived = need({
      mode: "focused",
      selected: CORPUS,
      named: ["test/golden-snapshots.test.ts"],
    });
    if (derived.kind !== "package") {
      throw new Error(`expected package need, got ${derived.kind}: ${derived.evidence}`);
    }
    expect(derived.consumers).toEqual(["test/golden-snapshots.test.ts"]);
    expect(derived.evidence).toContain("focused selection names registered package consumer file(s)");
  });

  test("a focused selection naming only non-consumer files needs nothing", () => {
    const derived = need({
      mode: "focused",
      selected: CORPUS,
      named: ["test/package-archive.test.ts", "test/pure.test.ts"],
    });
    expect(derived).toEqual({
      kind: "none",
      evidence:
        "focused selection names no registered package consumer file (test/package-archive.test.ts, test/pure.test.ts)",
    });
  });

  test("a filter-only focused selection conservatively prepares when consumers remain in the inventory", () => {
    // A `-t` filter cannot name the files a matching test executes in, and a
    // path-less filter reaches consumer files it did not name (measured on
    // the pinned runner: a matching filter loads the file fully, hooks
    // included), so preparation is owed and the evidence states the limit.
    const derived = need({
      mode: "focused",
      selected: CORPUS,
      nameFilterActive: true,
    });
    if (derived.kind !== "package") {
      throw new Error(`expected package need, got ${derived.kind}: ${derived.evidence}`);
    }
    expect(derived.consumers).toEqual([
      "test/cli.test.ts",
      "test/golden-snapshots.test.ts",
      "test/release-boundary.test.ts",
      "test/release-candidate.test.ts",
      "test/fleet-qualification.test.ts",
    ]);
    expect(derived.evidence).toContain("filter-only focused selection cannot name executed files");
    expect(derived.evidence).toContain("test/cli.test.ts");
  });

  test("a filter-only focused selection over a consumer-free inventory needs nothing", () => {
    const derived = need({
      mode: "focused",
      selected: ["test/package-archive.test.ts", "test/pure.test.ts"],
      nameFilterActive: true,
    });
    expect(derived).toEqual({
      kind: "none",
      evidence: "filter-only focused selection contains no registered package consumer file",
    });
  });

  test("a focused selection naming only non-corpus files executes only those files and needs nothing", () => {
    // bun test runs exactly the files its arguments name; a support fixture
    // outside the corpus inventory cannot be a registered consumer, so no
    // preparation is owed and the evidence states that limit truthfully.
    const derived = need({
      mode: "focused",
      selected: CORPUS,
      named: [],
      nameFilterActive: false,
    });
    expect(derived).toEqual({
      kind: "none",
      evidence:
        "focused selection names only files outside the corpus inventory, which the runner alone executes and which cannot be registered package consumers",
    });
  });

  test("a registry entry matching nothing in the inventory is a hard error", () => {
    expect(() =>
      need({ consumers: ["test/cli.test.ts", "test/renamed-away.test.ts"] }),
    ).toThrow(/renamed-away\.test\.ts/);
    expect(() => deriveInvocationPackageNeed({
      mode: "full",
      selected: [],
      named: [],
      nameFilterActive: false,
      inventoryFiles: ["test/pure.test.ts"],
      consumers: [...INVOCATION_PACKAGE_CONSUMERS],
    })).toThrow(/test\/cli\.test\.ts/);
  });

  test("registry entries validate against the raw inventory, so policy-excluded consumers stay valid", () => {
    // The fleet file is excluded from the fast suite yet remains a registered
    // consumer for the canonical fleet selection; validation runs before the
    // exclusion policy, so the entry is valid even though it drives no need.
    const derived = need({
      mode: "full",
      selected: ["test/pure.test.ts"],
      inventoryFiles: ["test/fleet-qualification.test.ts", "test/pure.test.ts"],
      consumers: ["test/fleet-qualification.test.ts"],
    });
    expect(derived).toEqual({
      kind: "none",
      evidence: "full selection includes no registered package consumer file",
    });
  });

  test("an injected consumer list replaces the registry wholesale", () => {
    const derived = need({
      mode: "full",
      selected: ["test/fixture-consumer.test.ts"],
      inventoryFiles: ["test/fixture-consumer.test.ts"],
      consumers: ["test/fixture-consumer.test.ts"],
    });
    if (derived.kind !== "package") {
      throw new Error(`expected package need, got ${derived.kind}: ${derived.evidence}`);
    }
    expect(derived.consumers).toEqual(["test/fixture-consumer.test.ts"]);
  });
});