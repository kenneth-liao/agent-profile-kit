import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

import { composeContextEnvelope } from "../adapters/context-envelope.js";
import {
  assertCodexProjectCapability,
  CODEX_MINIMUM_CLI_VERSION_FOR_COMPLETE_CONTEXT,
  CODEX_SKILLS_HOST_VERSION,
  parseCodexCliVersion,
  planCodexProject,
} from "../adapters/codex.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";
import { applyReconciliation } from "../installer/reconcile.js";
import { buildDesiredState, hashBytes } from "../installer/project-plan.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Codex complete Context delivery", () => {
  test("plans a large Context envelope for direct model delivery", async () => {
    const middle = Array.from({ length: 900 }, (_, index) => `middle-${index}`).join("\n");
    const modules = [{ id: "large-rules", content: `BEGIN\n${middle}\nEND\n` }];
    const plan = await planCodexProject("engineering", modules);
    const context = plan.outputs.find(
      (output) => output.type === "file" && output.path === ".agent-profile-kit/codex/context.md",
    );
    const hook = plan.outputs.find(
      (output) => output.type === "file" && output.path === ".codex/hooks.json",
    );

    expect(context?.type).toBe("file");
    if (!context || context.type !== "file") throw new Error("expected Context output");
    expect(context.bytes).toBe(composeContextEnvelope("engineering", modules));
    expect(context.bytes).toContain("BEGIN");
    expect(context.bytes).toContain("middle-450");
    expect(context.bytes).toContain("END");
    expect(context.requirements).toContain("Codex SessionStart delivers complete composed Context");

    expect(hook?.type).toBe("file");
    if (!hook || hook.type !== "file") throw new Error("expected hook output");
    const document = parse(hook.bytes as string) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> };
    };
    expect(document.hooks.SessionStart[0]?.matcher).toBe("startup|resume|clear|compact");
    expect(document.hooks.SessionStart[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(hook.requirements).toContain(
      "Codex SessionStart passes complete additionalContext directly to the model",
    );
  });

  test("keeps Context machinery out of Context-free plans", async () => {
    const plan = await planCodexProject("skills-only", []);

    expect(plan.outputs).toEqual([]);
    expect(plan.setupSteps).toEqual([]);
    expect(plan.hostVersion).toBe(CODEX_SKILLS_HOST_VERSION);
  });

  test("preflights complete Context support only when Context is selected", async () => {
    const home = "/tmp/apkit-codex-capability-home";
    const project = "/tmp/apkit-codex-capability-project";

    expect(CODEX_MINIMUM_CLI_VERSION_FOR_COMPLETE_CONTEXT).toBe("0.145.0");
    await expect(
      assertCodexProjectCapability(home, project, {
        requireContext: true,
        resolveVersion: async () => "0.144.6",
      }),
    ).rejects.toThrow("cannot deliver complete Context");
    await expect(
      assertCodexProjectCapability(home, project, {
        requireContext: true,
        resolveVersion: async () => "0.145.0",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCodexProjectCapability(home, project, {
        requireContext: true,
        resolveVersion: async () => "unreadable",
      }),
    ).rejects.toThrow("version is unreadable");

    let probed = false;
    await expect(
      assertCodexProjectCapability(home, project, {
        resolveVersion: async () => {
          probed = true;
          throw new Error("Skills-only Profiles must not probe Context support");
        },
      }),
    ).resolves.toBeUndefined();
    expect(probed).toBe(false);
  });

  test("rejects version text that only mentions a semver", () => {
    expect(parseCodexCliVersion("codex-cli 0.145.0")).toBe("0.145.0");
    expect(parseCodexCliVersion("0.145.0")).toBe("0.145.0");
    expect(() => parseCodexCliVersion("error: latest release is 0.145.0")).toThrow(
      "Codex CLI version is unreadable",
    );
    expect(() => parseCodexCliVersion("codex-cli 0.145.0-beta.1")).toThrow(
      "Codex CLI version is unreadable",
    );
  });

  test("blocks Context installation before writes when the Codex Host is too old", async () => {
    const home = temporaryDirectory("apkit-codex-context-cap-home-");
    const project = temporaryDirectory("apkit-codex-context-cap-project-");
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    mkdirSync(join(workspace, "context"), { recursive: true });
    mkdirSync(join(workspace, "profiles"), { recursive: true });
    writeFileSync(
      join(workspace, "context", "rules.md"),
      "---\nid: rules\ndependencies: []\n---\nContext rules.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(workspace, "workspace.yaml"),
      "schema_version: 1\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [codex]\n`,
    );
    const bin = temporaryDirectory("apkit-codex-context-cap-bin-");
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.144.6'\n");
    chmodSync(join(bin, "codex"), 0o755);
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const desired = await buildDesiredState(home);
      expect(desired.installations[0]?.blockers.some((blocker) =>
        blocker.includes("cannot deliver complete Context"),
      )).toBe(true);
      expect(existsSync(join(project, ".agent-profile-kit"))).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("reconciles an owned legacy hook to complete Context delivery", async () => {
    const home = temporaryDirectory("apkit-codex-context-migration-home-");
    const project = temporaryDirectory("apkit-codex-context-migration-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "rules.md"),
      "---\nid: rules\ndependencies: []\n---\nMigration rules.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [codex]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const hookPath = join(project, ".codex", "hooks.json");
    const currentHook = JSON.parse(readFileSync(hookPath, "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<Record<string, unknown>> }> };
    };
    delete currentHook.hooks.SessionStart[0]!.hooks[0]!.additionalContextLimit;
    const legacyHook = `${JSON.stringify(currentHook, null, 2)}\n`;
    writeFileSync(hookPath, legacyHook);
    const state = await readInstallationState(home);
    await writeInstallationState(home, {
      ...state,
      installations: state.installations.map((installation) => ({
        ...installation,
        outputs: installation.outputs.map((output) =>
          output.path === ".codex/hooks.json"
            ? { ...output, hash: hashBytes(legacyHook) }
            : output,
        ),
      })),
    });

    const corrected = await buildDesiredState(home, { checkHostCapability: false });
    const report = await applyReconciliation(home, corrected.installations);
    expect(report.receipt.items).toContainEqual({
      kind: "update",
      project,
      reason: "desired output changed",
    });
    const installedHook = JSON.parse(readFileSync(hookPath, "utf8")) as {
      hooks: { SessionStart: Array<{ hooks: Array<Record<string, unknown>> }> };
    };
    expect(installedHook.hooks.SessionStart[0]?.hooks[0]?.additionalContextLimit).toBe(0);
  });
});
