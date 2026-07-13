import { describe, expect, test } from "bun:test";

import type { AdapterProjectPlan } from "../adapters/project-plan.js";
import { normalizeAdapterPlans } from "../installer/project-plan.js";

function plan(
  host: string,
  output: Partial<AdapterProjectPlan["outputs"][number]> = {},
): AdapterProjectPlan {
  return {
    host,
    hostVersion: `${host}-v1`,
    outputs: [{
      bytes: "shared\n",
      mode: 0o644,
      path: ".agents/shared.txt",
      requirements: ["loads as project Context"],
      type: "file",
      ...output,
    }],
  };
}

describe("Adapter output-plan normalization", () => {
  test("coalesces exactly identical shared output and retains every consuming Host", () => {
    expect(normalizeAdapterPlans([plan("codex"), plan("claude")])).toEqual([
      {
        bytes: "shared\n",
        consumingHosts: ["claude", "codex"],
        hash: "sha256:cf99975aa7995fad86fae7f3b0905143f30a52501944dff26002afc99c3b8419",
        mode: 0o644,
        path: ".agents/shared.txt",
        requirements: ["loads as project Context"],
        type: "file",
      },
    ]);
  });

  test("rejects every same-path disagreement deterministically", () => {
    const disagreements: readonly [string, Partial<AdapterProjectPlan["outputs"][number]>][] = [
      ["entry type", { type: "directory" }],
      ["mode", { mode: 0o755 }],
      ["bytes", { bytes: "different\n" }],
      ["semantic requirements", { requirements: ["different semantics"] }],
    ];

    for (const [difference, output] of disagreements) {
      expect(() => normalizeAdapterPlans([plan("codex"), plan("claude", output)]))
        .toThrow(`Adapter output collision at '.agents/shared.txt': ${difference} disagrees between consuming Hosts claude, codex`);
    }
  });

  test("rejects absolute, root-escaping, and non-normalized output paths", () => {
    for (const path of ["/tmp/output", "../output", "nested/../../output", "nested//output", "nested/./output", "C:\\output"]) {
      expect(() => normalizeAdapterPlans([plan("codex", { path })]))
        .toThrow("must be a normalized project-relative path");
    }
  });

  test("rejects unsupported entry types before they reach filesystem reconciliation", () => {
    expect(() => normalizeAdapterPlans([plan("codex", { type: "directory" })]))
      .toThrow("unsupported entry type 'directory'");
  });

  test("rejects the Installer-owned Installation Marker path", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", { path: ".agent-profile-kit/installation.json" }),
    ])).toThrow("reserved for the Installer-owned Installation Marker");
  });

  test("rejects modes that cannot be persisted as owned-output state", () => {
    for (const mode of [-1, 0.5, 0o1000, Number.NaN]) {
      expect(() => normalizeAdapterPlans([plan("codex", { mode })]))
        .toThrow("mode must be an integer permission mode between 0 and 0777");
    }
  });

  test("rejects cross-Adapter file-ancestor output collisions deterministically", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", { path: "shared" }),
      plan("claude", { path: "shared/nested.txt" }),
    ])).toThrow("file 'shared' is an ancestor of 'shared/nested.txt'");
  });

  test("rejects an Adapter file that is an ancestor of the Installer-owned Marker", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", { path: ".agent-profile-kit" }),
    ])).toThrow("file '.agent-profile-kit' is an ancestor of Installer-owned '.agent-profile-kit/installation.json'");
  });
});
