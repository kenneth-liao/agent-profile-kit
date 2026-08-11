import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState, hashBytes } from "../installer/project-plan.js";
import { ApplyVerificationError, applyReconciliation } from "../installer/reconcile.js";
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
  test("returns the completed receipt when post-commit verification fails", async () => {
    const home = temporaryDirectory("agent-profile-kit-verification-failure-home-");
    const project = temporaryDirectory("agent-profile-kit-verification-failure-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nVerification failure.\n",
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

    let failure: unknown;
    try {
      await applyReconciliation(home, desired.installations, {
        verifyReconciliation: async () => {
          throw new Error("injected verification read failure");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(ApplyVerificationError);
    expect((failure as ApplyVerificationError).message).toContain(
      "Apply committed; post-apply verification failed: injected verification read failure",
    );
    expect((failure as ApplyVerificationError).receipt.items).toContainEqual({
      kind: "addition",
      project,
    });
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(true);
  });

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
    expect(initialReport.receipt.desired.find((entry) => entry.project === third)?.canonicalProject)
      .toBe(initial.installations.find((entry) => entry.binding.project === third)?.binding.canonicalProject);
    expect(initialReport.receipt.items.every((item) => item.kind === "addition")).toBe(true);
    expect(initialReport.resultingState.items.every((item) => item.kind === "current")).toBe(true);
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
              outputOrigins: {
                ...installation.outputOrigins,
                [obsoleteRelative]: [],
              },
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

    expect(report.receipt.items).toContainEqual({
      kind: "update",
      project,
      reason: "desired output changed",
    });
    expect(statSync(join(project, ".agent-profile-kit", "codex", "context.md")).mode & 0o777).toBe(0o600);
    const state = await readInstallationState(home);
    expect(state.installations[0]!.outputs.find((output) => output.path.endsWith("context.md"))?.mode).toBe(0o600);
  });

  test("a missing-output repair remains retryable across output and Installation State publication failures", async () => {
    const home = temporaryDirectory("agent-profile-kit-repair-failure-home-");
    const project = temporaryDirectory("agent-profile-kit-repair-failure-project-");
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nRepair transaction.\n",
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
    const canonicalProject = desired.installations[0]!.binding.canonicalProject;
    const context = join(canonicalProject, ".agent-profile-kit", "codex", "context.md");
    const marker = join(canonicalProject, ".agent-profile-kit", "installation.json");
    const originalMarker = readFileSync(marker, "utf8");
    const originalState = await readInstallationState(home);
    rmSync(context);
    let outputFailureInjected = false;

    await expect(applyReconciliation(home, desired.installations, {
      fileSystem: {
        rename: async (oldPath, newPath) => {
          if (
            !outputFailureInjected &&
            oldPath.toString().startsWith(`${canonicalProject}/.agent-profile-kit-stage-`) &&
            newPath.toString() === context
          ) {
            outputFailureInjected = true;
            throw new Error("injected repair output failure");
          }
          await rename(oldPath, newPath);
        },
      },
    })).rejects.toThrow("injected repair output failure");
    expect(existsSync(context)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe(originalMarker);
    expect(await readInstallationState(home)).toEqual(originalState);
    await expect(applyReconciliation(home, desired.installations)).resolves.toBeDefined();

    rmSync(context);
    let stateFailureInjected = false;
    await expect(applyReconciliation(home, desired.installations, {
      writeInstallationState: async (targetHome, state) => {
        if (!stateFailureInjected) {
          stateFailureInjected = true;
          throw new Error("injected repair state failure");
        }
        await writeInstallationState(targetHome, state);
      },
    })).rejects.toThrow("injected repair state failure");
    expect(existsSync(context)).toBe(false);
    expect(readFileSync(marker, "utf8")).toBe(originalMarker);
    expect(await readInstallationState(home)).toEqual(originalState);

    await expect(applyReconciliation(home, desired.installations)).resolves.toBeDefined();
    expect(readFileSync(context, "utf8")).toContain("Repair transaction.");
  });

  test("surfaces installation-state restore failures after an apply error", async () => {
    const home = temporaryDirectory("agent-profile-kit-state-restore-home-");
    const project = temporaryDirectory("agent-profile-kit-state-restore-project-");
    execFileSync("git", ["init", "-q", project]);
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
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
    );
    const initial = await buildDesiredState(home, { checkHostCapability: false });
    await applyReconciliation(home, initial.installations);
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nUpdated Context.\n",
    );
    const desiredState = await buildDesiredState(home, { checkHostCapability: false });
    const desired = desiredState.installations.map((installation) => ({
      ...installation,
      outputs: installation.outputs.map((output) =>
        output.path.endsWith("context.md")
          ? { ...output, path: ".agent-profile-kit/codex/context-v2.md" }
          : output,
      ),
    }));
    let stateWrites = 0;
    const exclude = join(project, ".git", "info", "exclude");

    await expect(applyReconciliation(home, desired, {
      writeInstallationState: async (targetHome, state) => {
        stateWrites += 1;
        if (stateWrites === 2) throw new Error("injected state restore failure");
        await writeInstallationState(targetHome, state);
        if (stateWrites === 1) writeFileSync(exclude, "concurrent edit\n");
      },
    })).rejects.toThrow(/Installation State restore failed/);
  });
});
