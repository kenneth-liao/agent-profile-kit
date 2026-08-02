import { describe, expect, test } from "bun:test";

import type {
  AdapterProjectPlan,
  ProposedProjectOutput,
} from "../adapters/project-plan.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import {
  hashDirectoryMembers,
  normalizeAdapterPlans,
} from "../installer/project-plan.js";

function fileOutput(
  output: Partial<Extract<ProposedProjectOutput, { type: "file" }>> = {},
): Extract<ProposedProjectOutput, { type: "file" }> {
  return {
    bytes: "shared\n",
    mode: 0o644,
    path: ".agents/shared.txt",
    requirements: ["loads as project Context"],
    type: "file",
    ...output,
  };
}

function directoryOutput(
  output: Partial<Extract<ProposedProjectOutput, { type: "directory" }>> = {},
): Extract<ProposedProjectOutput, { type: "directory" }> {
  return {
    members: [
      {
        bytes: "# Skill\n",
        mode: 0o644,
        path: "SKILL.md",
        type: "file",
      },
      {
        mode: 0o755,
        path: "scripts",
        type: "directory",
      },
      {
        bytes: "#!/bin/sh\necho ok\n",
        mode: 0o755,
        path: "scripts/run.sh",
        type: "file",
      },
    ],
    mode: 0o755,
    path: ".agents/skills/demo-skill",
    requirements: ["Host discovers Skill package"],
    type: "directory",
    ...output,
  };
}

function plan(
  host: SupportedHost,
  ...outputs: ProposedProjectOutput[]
): AdapterProjectPlan {
  return {
    host,
    hostVersion: `${host}-v1`,
    outputs: outputs.length > 0 ? outputs : [fileOutput()],
    setupSteps: [],
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

  test("coalesces an identical complete artifact directory across consuming Hosts", () => {
    const members = directoryOutput().members;
    const expectedHash = hashDirectoryMembers(
      members.map((member) =>
        member.type === "file"
          ? { bytes: member.bytes, mode: member.mode, path: member.path, type: member.type }
          : { mode: member.mode, path: member.path, type: member.type },
      ),
    );
    const normalized = normalizeAdapterPlans([
      plan("codex", directoryOutput()),
      plan("claude", directoryOutput()),
    ]);
    expect(normalized).toHaveLength(1);
    const output = normalized[0];
    expect(output).toMatchObject({
      consumingHosts: ["claude", "codex"],
      hash: expectedHash,
      mode: 0o755,
      path: ".agents/skills/demo-skill",
      requirements: ["Host discovers Skill package"],
      type: "directory",
    });
    if (output?.type !== "directory") throw new Error("expected directory output");
    expect(output.members.map((member) => member.path)).toEqual(
      [...output.members.map((member) => member.path)].sort((left, right) => left.localeCompare(right)),
    );
    expect(output.members).toEqual(expect.arrayContaining([
      {
        bytes: "# Skill\n",
        hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        mode: 0o644,
        path: "SKILL.md",
        type: "file",
      },
      {
        mode: 0o755,
        path: "scripts",
        type: "directory",
      },
      {
        bytes: "#!/bin/sh\necho ok\n",
        hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        mode: 0o755,
        path: "scripts/run.sh",
        type: "file",
      },
    ]));
    expect(output.members).toHaveLength(3);
  });

  test("rejects every same-path disagreement deterministically", () => {
    const disagreements: readonly [string, ProposedProjectOutput][] = [
      ["entry type", directoryOutput({ path: ".agents/shared.txt" })],
      ["mode", fileOutput({ mode: 0o755 })],
      ["bytes", fileOutput({ bytes: "different\n" })],
      ["semantic requirements", fileOutput({ requirements: ["different semantics"] })],
    ];

    for (const [difference, output] of disagreements) {
      expect(() => normalizeAdapterPlans([plan("codex", fileOutput()), plan("claude", output)]))
        .toThrow(`Adapter output collision at '.agents/shared.txt': ${difference} disagrees between consuming Hosts claude, codex`);
    }
  });

  test("rejects disagreeing directory members for the same path", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", directoryOutput()),
      plan("claude", directoryOutput({
        members: [
          {
            bytes: "# Different\n",
            mode: 0o644,
            path: "SKILL.md",
            type: "file",
          },
        ],
      })),
    ])).toThrow(
      "Adapter output collision at '.agents/skills/demo-skill': directory members disagrees between consuming Hosts claude, codex",
    );
  });

  test("rejects absolute, root-escaping, and non-normalized output paths", () => {
    for (const path of ["/tmp/output", "../output", "nested/../../output", "nested//output", "nested/./output", "C:\\output"]) {
      expect(() => normalizeAdapterPlans([plan("codex", fileOutput({ path }))]))
        .toThrow("must be a normalized project-relative path");
    }
  });

  test("rejects unsafe or incomplete directory member paths", () => {
    for (const path of ["/tmp/member", "../member", "nested//member", "nested/./member"]) {
      expect(() => normalizeAdapterPlans([plan("codex", directoryOutput({
        members: [{ bytes: "x\n", mode: 0o644, path, type: "file" }],
      }))])).toThrow("must be a normalized project-relative path");
    }
  });

  test("rejects unsupported top-level entry types before they reach filesystem reconciliation", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", { ...(fileOutput() as object), type: "symlink" } as unknown as ProposedProjectOutput),
    ])).toThrow("unsupported entry type 'symlink'");
  });

  test("rejects duplicate directory members", () => {
    expect(() => normalizeAdapterPlans([plan("codex", directoryOutput({
      members: [
        { bytes: "a\n", mode: 0o644, path: "SKILL.md", type: "file" },
        { bytes: "b\n", mode: 0o644, path: "SKILL.md", type: "file" },
      ],
    }))])).toThrow("contains duplicate member path 'SKILL.md'");
  });

  test("rejects file/directory ancestor collisions among directory members", () => {
    expect(() => normalizeAdapterPlans([plan("codex", directoryOutput({
      members: [
        { bytes: "a\n", mode: 0o644, path: "scripts", type: "file" },
        { bytes: "b\n", mode: 0o644, path: "scripts/run.sh", type: "file" },
      ],
    }))])).toThrow("file 'scripts' is an ancestor of 'scripts/run.sh'");
  });

  test("rejects the Installer-owned Installation Marker path", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", fileOutput({ path: ".agent-profile-kit/installation.json" }),
    )])).toThrow("reserved for the Installer-owned Installation Marker");
  });

  test("rejects modes that cannot be persisted as owned-output state", () => {
    for (const mode of [-1, 0.5, 0o1000, Number.NaN]) {
      expect(() => normalizeAdapterPlans([plan("codex", fileOutput({ mode }))]))
        .toThrow("mode must be an integer permission mode between 0 and 0777");
    }
  });

  test("rejects cross-Adapter file-ancestor output collisions deterministically", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", fileOutput({ path: "shared" })),
      plan("claude", fileOutput({ path: "shared/nested.txt" })),
    ])).toThrow("file 'shared' is an ancestor of 'shared/nested.txt'");
  });

  test("rejects a directory that is an ancestor of another top-level output", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", directoryOutput({ path: ".agents/skills" })),
      plan("claude", fileOutput({ path: ".agents/skills/extra.txt" })),
    ])).toThrow("directory '.agents/skills' is an ancestor of '.agents/skills/extra.txt'");
  });

  test("rejects an Adapter file that is an ancestor of the Installer-owned Marker", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", fileOutput({ path: ".agent-profile-kit" })),
    ])).toThrow("file '.agent-profile-kit' is an ancestor of Installer-owned '.agent-profile-kit/installation.json'");
  });

  test("rejects an Adapter directory that would own the Installation Marker path", () => {
    expect(() => normalizeAdapterPlans([
      plan("codex", directoryOutput({ path: ".agent-profile-kit" })),
    ])).toThrow("directory '.agent-profile-kit' is an ancestor of Installer-owned '.agent-profile-kit/installation.json'");
  });
});
