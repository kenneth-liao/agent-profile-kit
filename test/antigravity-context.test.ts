import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { isAdapterCapabilityError } from "../adapters/capability.js";
import { parseLocalConfiguration } from "../schemas/local-configuration.js";
import {
  ANTIGRAVITY_CONTEXT_RULES_ROOT,
  ANTIGRAVITY_HOST_VERSION,
  ANTIGRAVITY_MINIMUM_CLI_VERSION,
  ANTIGRAVITY_RULE_CHARACTER_LIMIT,
  assertAntigravityCliVersionSupported,
  assertAntigravityProjectCapability,
  assertAntigravityProjectSurface,
  parseAntigravityCliVersion,
  planAntigravityProject,
  probeAntigravityMachineCapability,
} from "../adapters/antigravity.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Antigravity Context Adapter", () => {
  test("accepts antigravity in canonical Host order", () => {
    const parsed = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: engineering\n    hosts: [pi, antigravity, claude, antigravity]\n",
      "config.yaml",
    );

    expect(parsed.bindings[0]?.hosts).toEqual(["antigravity", "claude", "pi"]);
  });

  test("normalizes agy versions and rejects malformed or too-old capability evidence", async () => {
    expect(parseAntigravityCliVersion("agy 1.1.13")).toBe("1.1.13");
    expect(parseAntigravityCliVersion("agy 1.2.0-alpha.1")).toBe("1.2.0");
    expect(await probeAntigravityMachineCapability({ resolveVersion: async () => "agy 1.1.14" })).toBe("1.1.14");
    expect(() => parseAntigravityCliVersion("agy version unavailable")).toThrow(
      /version is unreadable/i,
    );
    expect(() => assertAntigravityCliVersionSupported("1.1.12")).toThrow(
      new RegExp(`requires ${ANTIGRAVITY_MINIMUM_CLI_VERSION}\\+`),
    );
  });

  test("blocks one oversized Context Module instead of truncating it", async () => {
    let error: unknown;
    try {
      await planAntigravityProject("engineering", [{
        id: "oversized",
        content: "x".repeat(ANTIGRAVITY_RULE_CHARACTER_LIMIT),
      }]);
    } catch (caught) {
      error = caught;
    }

    expect(isAdapterCapabilityError(error)).toBe(true);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/exceeding the 12000-character limit/i);
    expect((error as Error).message).not.toMatch(/truncat/i);
  });

  test("does not invent output or trust guidance for an empty Context plan", async () => {
    const plan = await planAntigravityProject("engineering", []);
    expect(plan.outputs).toEqual([]);
    expect(plan.setupSteps).toEqual([]);
  });

  test("splits total Context above the limit while preserving module boundaries", async () => {
    const modules = [
      { id: "first", content: "a".repeat(7_000) },
      { id: "second", content: "b".repeat(7_000) },
    ];
    const plan = await planAntigravityProject("engineering", modules);

    expect(plan.outputs).toHaveLength(3);
    expect(plan.outputs.every((output) => output.type === "file" && output.bytes.length <= ANTIGRAVITY_RULE_CHARACTER_LIMIT)).toBe(true);
    const first = plan.outputs[1];
    const second = plan.outputs[2];
    if (!first || first.type !== "file" || !second || second.type !== "file") throw new Error("expected module rules");
    expect(first.bytes).toContain(`<!-- Context Module: first -->\n${"a".repeat(7_000)}`);
    expect(second.bytes).toContain(`<!-- Context Module: second -->\n${"b".repeat(7_000)}`);
  });

  test("rejects Antigravity Skill delivery instead of omitting selected Skills", async () => {
    await expect(
      planAntigravityProject("engineering", [], [{
        dependencies: [],
        id: "review-pr",
        modelInvocation: "allowed",
        path: temporaryDirectory("apkit-antigravity-skill-source-"),
      }]),
    ).rejects.toThrow(/Skill delivery is not supported/i);
  });

  test("checks only required Context surfaces and rejects files or symlinks", async () => {
    const project = temporaryDirectory("apkit-antigravity-surface-project-");
    await expect(
      assertAntigravityProjectCapability(project, {
        requireContext: true,
        resolveVersion: async () => "1.1.13",
      }),
    ).resolves.toBeUndefined();

    writeFileSync(join(project, ".agents"), "repository material\n");
    await expect(assertAntigravityProjectSurface(project, { requireContext: true })).rejects.toThrow(
      /\.agents.*file.*directory/i,
    );
    rmSync(join(project, ".agents"));
    mkdirSync(join(project, ".agents"));
    writeFileSync(join(project, ".agents", "rules"), "repository material\n");
    await expect(assertAntigravityProjectSurface(project, { requireContext: true })).rejects.toThrow(
      /\.agents\/rules.*file.*directory/i,
    );
    rmSync(join(project, ".agents", "rules"));
    const target = temporaryDirectory("apkit-antigravity-surface-target-");
    symlinkSync(target, join(project, ".agents", "rules"));
    await expect(assertAntigravityProjectSurface(project, { requireContext: true })).rejects.toThrow(
      /\.agents\/rules.*symlink.*directory/i,
    );

    // A Context-free check does not inspect surfaces that this plan does not need.
    await expect(assertAntigravityProjectSurface(project, { requireContext: false })).resolves.toBeUndefined();
  });

  test("plans Antigravity Context through the ordinary desired-state boundary", async () => {
    const home = temporaryDirectory("apkit-antigravity-desired-home-");
    const project = temporaryDirectory("apkit-antigravity-desired-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "rules.md"),
      "---\nid: rules\ndependencies: []\n---\nKeep repository instructions authoritative.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [antigravity]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    expect(installation?.binding.hosts).toEqual(["antigravity"]);
    expect(installation?.adapterVersion).toBe("antigravity-project-v1");
    expect(installation?.hostVersions.antigravity).toBe(ANTIGRAVITY_HOST_VERSION);
    expect(installation?.outputs.map((output) => output.path)).toEqual([
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-000-envelope.md`,
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-010-rules.md`,
    ]);
  });

  test("normalizes an oversized rule into a structured project Blocker before writes", async () => {
    const home = temporaryDirectory("apkit-antigravity-oversized-home-");
    const project = temporaryDirectory("apkit-antigravity-oversized-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "oversized.md"),
      `---\nid: oversized\ndependencies: []\n---\n${"x".repeat(ANTIGRAVITY_RULE_CHARACTER_LIMIT)}\n`,
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [oversized]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [antigravity]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations[0]?.outputs).toEqual([]);
    expect(desired.installations[0]?.blockers[0]).toMatchObject({
      affectedItems: [
        { kind: "host", value: "antigravity" },
        { kind: "path", value: expect.stringContaining("agent-profile-kit-010-oversized.md") },
      ],
      kind: "host-capability",
      scope: "project",
      problem: expect.stringContaining("exceeding the 12000-character limit"),
    });
  });

  test("plans one always-on envelope and one complete rule per Context Module", async () => {
    const plan = await planAntigravityProject("engineering", [
      { id: "communication", content: "Prefer concise communication.\n" },
      { id: "engineering", content: "Use safe changes.\n" },
    ]);

    expect(plan.host).toBe("antigravity");
    expect(plan.hostVersion).toBe(ANTIGRAVITY_HOST_VERSION);
    expect(plan.outputs.map((output) => output.path)).toEqual([
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-000-envelope.md`,
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-010-communication.md`,
      `${ANTIGRAVITY_CONTEXT_RULES_ROOT}/agent-profile-kit-020-engineering.md`,
    ]);
    expect(plan.setupSteps).toEqual([{
      consequence: "The Profile does not load until the project is trusted.",
      kind: "trust-required",
      message: "Trust the bound project in Antigravity.",
      provenance: "standing",
    }]);

    for (const [index, output] of plan.outputs.entries()) {
      expect(output.type).toBe("file");
      if (output.type !== "file") continue;
      expect(output.bytes.length).toBeLessThanOrEqual(ANTIGRAVITY_RULE_CHARACTER_LIMIT);
      expect(output.bytes).toContain("trigger: always_on");
      if (index === 0) {
        expect(output.bytes).toContain("Profile: engineering");
        expect(output.bytes).toContain("Repository-owned project instructions");
      }
    }

    const communication = plan.outputs[1];
    if (!communication || communication.type !== "file") throw new Error("expected communication rule");
    expect(communication.bytes).toContain("<!-- Context Module: communication -->");
    expect(communication.bytes).toContain("Prefer concise communication.\n<!-- End Context Module: communication -->");
    expect(communication.origins).toEqual([{ id: "communication", type: "context" }]);
  });
});
