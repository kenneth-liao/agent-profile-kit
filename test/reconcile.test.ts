import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState, hashBytes } from "../installer/project-plan.js";
import { applyReconciliation } from "../installer/reconcile.js";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

describe("injected project filesystem failures", () => {
  test("rolls back a mid-update failure and reports non-empty completed, failed, and pending sets", async () => {
    const home = temporaryDirectory("agent-profile-kit-injected-home-");
    const first = temporaryDirectory("agent-profile-kit-injected-a-");
    const second = temporaryDirectory("agent-profile-kit-injected-b-");
    const third = temporaryDirectory("agent-profile-kit-injected-c-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nOriginal Context.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${third}\n    profile: coding\n    hosts: [codex]\n  - project: ${second}\n    profile: coding\n    hosts: [codex]\n  - project: ${first}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    const initialReport = await applyReconciliation(home, initial.installations);
    expect(initialReport.desired.find((entry) => entry.project === third)?.canonicalProject)
      .toBe(initial.installations.find((entry) => entry.binding.project === third)?.binding.canonicalProject);
    const obsoleteRelative = ".agent-profile-kit/codex/obsolete.txt";
    const obsolete = join(second, obsoleteRelative);
    const obsoleteBytes = "owned obsolete output\n";
    writeFileSync(obsolete, obsoleteBytes);
    const previousState = await readInstallationState(home);
    await writeInstallationState(home, {
      ...previousState,
      installations: previousState.installations.map((installation) =>
        installation.project === initial.installations.find(
          (entry) => entry.binding.project === second,
        )!.binding.canonicalProject
          ? {
              ...installation,
              outputs: [...installation.outputs, {
                hash: hashBytes(obsoleteBytes),
                mode: 0o644,
                path: obsoleteRelative,
                type: "file" as const,
              }],
            }
          : installation
      ),
    });
    const secondMarker = readFileSync(join(second, ".agent-profile-kit", "installation.json"), "utf8");
    const secondContextPath = join(second, ".agent-profile-kit", "codex", "context.md");
    const secondContext = readFileSync(secondContextPath, "utf8");
    const thirdContextPath = join(third, ".agent-profile-kit", "codex", "context.md");
    const thirdContext = readFileSync(thirdContextPath, "utf8");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated Context.\n",
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const secondCanonical = desired.installations.find(
      (installation) => installation.binding.project === second,
    )!.binding.canonicalProject;
    const secondCanonicalContextPath = join(
      secondCanonical,
      ".agent-profile-kit",
      "codex",
      "context.md",
    );
    let injected = false;

    await expect(applyReconciliation(home, desired.installations, {
      fileSystem: {
        rename: async (oldPath, newPath) => {
          const source = oldPath.toString();
          const destination = newPath.toString();
          if (
            !injected &&
            source.startsWith(`${secondCanonical}/.agent-profile-kit-stage-`) &&
            destination === secondCanonicalContextPath
          ) {
            injected = true;
            throw new Error("injected mid-update failure");
          }
          await rename(oldPath, newPath);
        },
      },
    })).rejects.toThrow(
      `completed projects: ${first}; failed project: ${second}; pending projects: ${third}`,
    );
    expect(readFileSync(join(first, ".agent-profile-kit", "codex", "context.md"), "utf8")).toContain("Updated Context.");
    expect(readFileSync(join(second, ".agent-profile-kit", "installation.json"), "utf8")).toBe(secondMarker);
    expect(readFileSync(secondContextPath, "utf8")).toBe(secondContext);
    expect(readFileSync(obsolete, "utf8")).toBe(obsoleteBytes);
    expect(readFileSync(thirdContextPath, "utf8")).toBe(thirdContext);

    await expect(applyReconciliation(home, desired.installations)).resolves.toBeDefined();
    for (const project of [first, second, third]) {
      expect(readFileSync(join(project, ".agent-profile-kit", "codex", "context.md"), "utf8"))
        .toContain("Updated Context.");
    }
    expect(existsSync(obsolete)).toBe(false);
  });

  test("reconciles a mode-only desired output change", async () => {
    const home = temporaryDirectory("agent-profile-kit-mode-home-");
    const project = temporaryDirectory("agent-profile-kit-mode-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nMode reconciliation.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
    );
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, desired.installations);
    const changed = desired.installations.map((installation) => ({
      ...installation,
      outputs: installation.outputs.map((output) =>
        output.path.endsWith("context.md") ? { ...output, mode: 0o600 } : output
      ),
    }));

    const report = await applyReconciliation(home, changed);

    expect(report.items).toContainEqual({
      kind: "update",
      project,
      reason: "desired output changed",
    });
    expect(statSync(join(project, ".agent-profile-kit", "codex", "context.md")).mode & 0o777).toBe(0o600);
    const state = await readInstallationState(home);
    expect(state.installations[0]!.outputs.find((output) => output.path.endsWith("context.md"))?.mode).toBe(0o600);
  });
});
