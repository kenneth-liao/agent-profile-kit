import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertPiCliVersionSupported,
  assertPiProjectCapability,
  PI_ADAPTER_VERSION,
  PI_CONTEXT_PATH,
  PI_HOST_VERSION,
  PI_MINIMUM_CLI_VERSION,
  parsePiCliVersion,
  planPiProject,
} from "../adapters/pi.js";
import { composeContextEnvelope } from "../adapters/context-envelope.js";
import { parseLocalConfiguration } from "../schemas/local-configuration.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { applyReconciliation, previewReconciliation } from "../installer/reconcile.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { readInstallationState } from "../installer/installation-state.js";
import { uninstallApplication } from "../installer/commands.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeContextWorkspace(
  home: string,
  projects: readonly {
    readonly path: string;
    readonly hosts: readonly string[];
    readonly profile?: string;
  }[],
): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nPreserve the project boundary.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
  );
  const bindings = projects
    .map(
      ({ path, hosts, profile = "coding" }) =>
        `  - project: ${path}\n    profile: ${profile}\n    hosts: [${hosts.join(", ")}]`,
    )
    .join("\n");
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${bindings}\n`,
  );
}

describe("Pi Project Binding ingestion", () => {
  test("accepts Pi-only and multi-Host bindings, normalizing order and duplicates", () => {
    const piOnly = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [pi]\n",
      "config.yaml",
    );
    expect(piOnly.bindings[0]?.hosts).toEqual(["pi"]);

    const combined = parseLocalConfiguration(
      "schema_version: 1\nbindings:\n  - project: /tmp/project\n    profile: coding\n    hosts: [pi, codex, pi, claude, codex]\n",
      "config.yaml",
    );
    expect(combined.bindings[0]?.hosts).toEqual(["claude", "codex", "pi"]);
  });
});

describe("Pi Adapter", () => {
  test("plans only the canonical composed Context at Pi's append-system surface", async () => {
    const modules = [{ id: "team-rules", content: "Preserve the project boundary.\n" }];
    const plan = await planPiProject("coding", modules);

    expect(PI_ADAPTER_VERSION).toBe("pi-project-v1");
    expect(plan.host).toBe("pi");
    expect(plan.hostVersion).toBe(PI_HOST_VERSION);
    expect(plan.outputs).toHaveLength(1);
    const output = plan.outputs[0];
    expect(output?.type).toBe("file");
    expect(output?.path).toBe(PI_CONTEXT_PATH);
    if (output?.type !== "file") throw new Error("expected Pi Context file output");
    expect(output.bytes).toBe(composeContextEnvelope("coding", modules));
    expect(output.requirements).toContain("Pi loads project APPEND_SYSTEM.md as additive system Context");

    const contextFree = await planPiProject("coding", []);
    expect(contextFree.outputs).toEqual([]);
  });

  test("Pi-only and multi-Host bindings reconcile Context through one Installation lifecycle", async () => {
    const home = temporaryDirectory("apk-pi-lifecycle-home-");
    const piProject = temporaryDirectory("apk-pi-lifecycle-project-");
    const combinedProject = temporaryDirectory("apk-pi-lifecycle-combined-");
    const trustPath = join(home, ".pi", "agent", "trust.json");
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(trustPath, `{"${piProject}":true}\n`);
    mkdirSync(join(piProject, ".pi"), { recursive: true });
    writeFileSync(join(piProject, ".pi", "settings.json"), "keep native settings\n");
    await writeContextWorkspace(home, [
      { path: piProject, hosts: ["pi"] },
      { path: combinedProject, hosts: ["claude", "pi", "claude"] },
    ]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(2);
    const piDesired = desired.installations.find((installation) => installation.binding.project === piProject);
    expect(piDesired).toBeDefined();
    expect(piDesired!.adapterVersion).toContain(PI_ADAPTER_VERSION);
    expect(piDesired!.hostVersions.pi).toBe(PI_HOST_VERSION);
    expect(piDesired!.outputs.map((output) => output.path)).toEqual([
      PI_CONTEXT_PATH,
    ]);

    const applied = await applyReconciliation(home, desired.installations);
    expect(applied.resultingState.blockers).toEqual([]);
    expect(existsSync(join(piProject, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    expect(existsSync(join(combinedProject, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    expect(existsSync(join(combinedProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);

    const state = await readInstallationState(home);
    expect(state.installations).toHaveLength(2);
    const piManifest = state.installations.find((installation) => installation.project === piDesired!.binding.canonicalProject);
    expect(piManifest?.hosts).toEqual(["pi"]);
    expect(piManifest?.hostVersions.pi).toBe(PI_HOST_VERSION);
    expect(piManifest?.outputs.some((output) => output.path === PI_CONTEXT_PATH)).toBe(true);

    writeFileSync(join(piProject, ".pi", "APPEND_SYSTEM.md"), "drifted\n");
    const status = await previewReconciliation(
      (await buildDesiredState(home, { checkHostCapability: false })).installations,
      state,
    );
    expect(status.items.some((item) => item.project === piProject && item.kind === "drifted output")).toBe(true);

    writeFileSync(join(piProject, ".pi", "APPEND_SYSTEM.md"), String(piDesired?.outputs[0]?.type === "file" ? piDesired.outputs[0].bytes : ""));
    await uninstallApplication(home);
    expect(existsSync(join(piProject, ".pi", "APPEND_SYSTEM.md"))).toBe(false);
    expect(readFileSync(join(piProject, ".pi", "settings.json"), "utf8")).toBe("keep native settings\n");
    expect(readFileSync(trustPath, "utf8")).toBe(`{"${piProject}":true}\n`);
    expect(existsSync(join(combinedProject, ".pi", "APPEND_SYSTEM.md"))).toBe(false);
    expect(existsSync(join(combinedProject, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
  });

  test("Pi Skill selection blocks only its binding before project or Installation State writes", async () => {
    const home = temporaryDirectory("apk-pi-skill-home-");
    const project = temporaryDirectory("apk-pi-skill-project-");
    const unrelatedProject = temporaryDirectory("apk-pi-skill-unrelated-project-");
    await writeContextWorkspace(home, [
      { path: project, hosts: ["pi"] },
      { path: unrelatedProject, hosts: ["claude"], profile: "context-only" },
    ]);
    const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
    const skill = join(workspace, "skills", "review-pr");
    mkdirSync(skill, { recursive: true });
    writeFileSync(
      join(skill, "SKILL.md"),
      "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [review-pr]\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(workspace, "profiles", "context-only.yaml"),
      "id: context-only\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    expect(desired.installations).toHaveLength(2);
    const piInstallation = desired.installations.find(
      (installation) => installation.binding.project === project,
    );
    expect(piInstallation?.blockers.some((blocker) => /Pi Skill delivery is not supported/i.test(blocker))).toBe(true);
    expect(piInstallation?.outputs).toEqual([]);
    const unrelatedInstallation = desired.installations.find(
      (installation) => installation.binding.project === unrelatedProject,
    );
    expect(unrelatedInstallation?.blockers).toEqual([]);
    expect(unrelatedInstallation?.outputs.map((output) => output.path)).toEqual([
      ".claude/rules/agent-profile-kit.md",
    ]);
    expect(existsSync(join(project, ".pi"))).toBe(false);
    expect(existsSync(join(unrelatedProject, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".agents", "agent-profile-kit", "state"))).toBe(false);
  });

  test("requires Pi 0.82.1+, proves project append-system surfaces, and fails closed for Skills", async () => {
    const project = temporaryDirectory("apk-pi-capability-");
    expect(parsePiCliVersion("pi 0.82.1\n")).toBe("0.82.1");
    expect(() => parsePiCliVersion("not-a-version")).toThrow(/unreadable/i);
    expect(PI_MINIMUM_CLI_VERSION).toBe("0.82.1");
    expect(() => assertPiCliVersionSupported("0.82.0")).toThrow(/requires 0\.82\.1\+/i);
    await expect(
      assertPiProjectCapability(project, { resolveVersion: async () => "0.82.1" }),
    ).resolves.toBeUndefined();

    writeFileSync(join(project, ".pi"), "not a directory\n");
    await expect(
      assertPiProjectCapability(project, { resolveVersion: async () => "0.82.1" }),
    ).rejects.toThrow(/\.pi.*file.*directory/i);

    rmSync(join(project, ".pi"));
    mkdirSync(join(project, ".pi", "APPEND_SYSTEM.md"), { recursive: true });
    await expect(
      assertPiProjectCapability(project, { resolveVersion: async () => "0.82.1" }),
    ).rejects.toThrow(/APPEND_SYSTEM\.md.*directory/i);

    expect(existsSync(join(project, ".pi", "APPEND_SYSTEM.md"))).toBe(true);
    await expect(
      assertPiProjectCapability(project, {
        requireSkills: true,
        resolveVersion: async () => "0.82.1",
      }),
    ).rejects.toThrow(/Skill.*successor/i);
    await expect(
      planPiProject(
        "coding",
        [{ id: "team-rules", content: "Context\n" }],
        [{ dependencies: [], id: "review-pr", modelInvocation: "allowed", path: "/workspace/skills/review-pr" }],
      ),
    ).rejects.toThrow(/Skill.*successor/i);
  });
});
