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

import { composeContextEnvelope } from "../adapters/context-envelope.js";
import {
  assertCodexProjectCapability,
  CODEX_ADAPTER_VERSION,
  CODEX_HOST_VERSION,
  CODEX_MINIMUM_CLI_VERSION_FOR_COMPLETE_CONTEXT,
  CODEX_SKILLS_HOST_VERSION,
  parseCodexCliVersion,
  planCodexProject,
} from "../adapters/codex.js";
import { blockerMessage } from "../installer/blockers.js";
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
    const document = JSON.parse(hook.bytes as string) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<Record<string, unknown>> }> };
    };
    expect(document.hooks.SessionStart[0]?.matcher).toBe("startup|clear|compact");
    expect(document.hooks.SessionStart[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    expect(hook.requirements).toContain(
      "Codex SessionStart runs on startup, clear, and compact",
    );
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
    const home = temporaryDirectory("apkit-codex-capability-home-");
    const project = temporaryDirectory("apkit-codex-capability-project-");

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

  test("parses decorated and prerelease Codex versions; rejects mid-text semver only", () => {
    expect(parseCodexCliVersion("codex-cli 0.145.0")).toBe("0.145.0");
    expect(parseCodexCliVersion("0.145.0")).toBe("0.145.0");
    expect(parseCodexCliVersion("codex-cli 0.145.0 (rust-v0.145.0)")).toBe("0.145.0");
    expect(parseCodexCliVersion("codex 0.146.0-alpha.1")).toBe("0.146.0");
    expect(parseCodexCliVersion("warning: checking updates\ncodex-cli 0.145.0\n")).toBe("0.145.0");
    expect(() => parseCodexCliVersion("error: latest release is 0.145.0")).toThrow(
      "Codex CLI version is unreadable",
    );
  });

  test("reports the complete-Context floor before the invocation floor when both are unmet", async () => {
    const home = temporaryDirectory("apkit-codex-dual-floor-home-");
    const project = temporaryDirectory("apkit-codex-dual-floor-project-");

    await expect(
      assertCodexProjectCapability(home, project, {
        requireContext: true,
        requireDisabledModelInvocation: true,
        resolveVersion: async () => "0.98.0",
      }),
    ).rejects.toThrow("cannot deliver complete Context");
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
      "id: engineering\ncontext: [rules]\nskills: []\n",
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
        blockerMessage(blocker).includes("cannot deliver complete Context"),
      )).toBe(true);
      expect(existsSync(join(project, ".agent-profile-kit"))).toBe(false);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("reconciles a genuine v1 Context install to complete Context delivery", async () => {
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
      "id: engineering\ncontext: [rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [codex]\n`,
    );

    // Seed owned project output via a capability-free apply, then rewrite state
    // and hooks to a genuine pre-complete-Context (v1) installation shape.
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const hookPath = join(project, ".codex", "hooks.json");
    const currentHook = JSON.parse(readFileSync(hookPath, "utf8")) as {
      hooks: {
        SessionStart: Array<{
          matcher?: string;
          hooks: Array<Record<string, unknown>>;
        }>;
      };
    };
    // Seed the pre-#138 shape: no complete-delivery limit (version markers also downgraded).
    delete currentHook.hooks.SessionStart[0]!.hooks[0]!.additionalContextLimit;
    const legacyHook = `${JSON.stringify(currentHook, null, 2)}\n`;
    writeFileSync(hookPath, legacyHook);
    const state = await readInstallationState(home);
    await writeInstallationState(home, {
      ...state,
      installations: state.installations.map((installation) => ({
        ...installation,
        adapterVersion: "codex-project-v1",
        hostVersions: { codex: "native-project-sessionstart-v1" },
        outputs: installation.outputs.map((output) =>
          output.path === ".codex/hooks.json"
            ? { ...output, hash: hashBytes(legacyHook) }
            : output,
        ),
      })),
    });

    const corrected = await buildDesiredState(home, { checkHostCapability: false });
    expect(corrected.installations[0]?.adapterVersion).toBe(CODEX_ADAPTER_VERSION);
    expect(corrected.installations[0]?.hostVersions.codex).toBe(CODEX_HOST_VERSION);
    const report = await applyReconciliation(home, corrected.installations);
    expect(report.receipt.items).toContainEqual({
      kind: "update",
      project,
      reason: "desired output changed",
    });
    const installedHook = JSON.parse(readFileSync(hookPath, "utf8")) as {
      hooks: {
        SessionStart: Array<{
          matcher?: string;
          hooks: Array<Record<string, unknown>>;
        }>;
      };
    };
    expect(installedHook.hooks.SessionStart[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    const migrated = await readInstallationState(home);
    expect(migrated.installations[0]?.adapterVersion).toBe(CODEX_ADAPTER_VERSION);
    expect(migrated.installations[0]?.hostVersions.codex).toBe(CODEX_HOST_VERSION);
  });

  test("reconciles a same-version install whose only drift is the resume matcher", async () => {
    // #139 deliberately does not bump CODEX_ADAPTER_VERSION / CODEX_HOST_VERSION:
    // lifecycle policy is not a Host capability. Detection must therefore be pure
    // output-hash drift against current version markers (the real 0.49.0 → 0.49.1 path).
    const home = temporaryDirectory("apkit-codex-resume-matcher-home-");
    const project = temporaryDirectory("apkit-codex-resume-matcher-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "rules.md"),
      "---\nid: rules\ndependencies: []\n---\nResume matcher rules.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "engineering.yaml"),
      "id: engineering\ncontext: [rules]\nskills: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [codex]\n`,
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const state = await readInstallationState(home);
    expect(state.installations[0]?.adapterVersion).toBe(CODEX_ADAPTER_VERSION);
    expect(state.installations[0]?.hostVersions.codex).toBe(CODEX_HOST_VERSION);

    const hookPath = join(project, ".codex", "hooks.json");
    const currentHook = JSON.parse(readFileSync(hookPath, "utf8")) as {
      hooks: {
        SessionStart: Array<{
          matcher?: string;
          hooks: Array<Record<string, unknown>>;
        }>;
      };
    };
    expect(currentHook.hooks.SessionStart[0]?.matcher).toBe("startup|clear|compact");
    expect(currentHook.hooks.SessionStart[0]?.hooks[0]?.additionalContextLimit).toBe(0);
    currentHook.hooks.SessionStart[0]!.matcher = "startup|resume|clear|compact";
    const legacyResumeHook = `${JSON.stringify(currentHook, null, 2)}\n`;
    writeFileSync(hookPath, legacyResumeHook);
    await writeInstallationState(home, {
      ...state,
      installations: state.installations.map((installation) => ({
        ...installation,
        // Keep current version markers so only the hooks.json hash can trigger update.
        outputs: installation.outputs.map((output) =>
          output.path === ".codex/hooks.json"
            ? { ...output, hash: hashBytes(legacyResumeHook) }
            : output,
        ),
      })),
    });

    const corrected = await buildDesiredState(home, { checkHostCapability: false });
    expect(corrected.installations[0]?.adapterVersion).toBe(CODEX_ADAPTER_VERSION);
    expect(corrected.installations[0]?.hostVersions.codex).toBe(CODEX_HOST_VERSION);
    const report = await applyReconciliation(home, corrected.installations);
    expect(report.receipt.items).toContainEqual({
      kind: "update",
      project,
      reason: "desired output changed",
    });
    const installedHook = JSON.parse(readFileSync(hookPath, "utf8")) as {
      hooks: {
        SessionStart: Array<{
          matcher?: string;
          hooks: Array<Record<string, unknown>>;
        }>;
      };
    };
    expect(installedHook.hooks.SessionStart[0]?.matcher).toBe("startup|clear|compact");
    expect(installedHook.hooks.SessionStart[0]?.hooks[0]?.additionalContextLimit).toBe(0);
  });
});
