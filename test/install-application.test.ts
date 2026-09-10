/**
 * Install recovery (ticket #494, spec #491 US-008, DEC-006): faults in
 * configuration, output, or ownership publication restore the failed
 * Project's previous selection/output where possible; failed restoration and
 * failed verification report truthfully with a concrete retry; completed work
 * is retained. Single-Project scope keeps every scenario to one Project.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeInstall,
  InstallExecutionError,
} from "../installer/install-application.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  ApplyExecutionError,
  ApplyVerificationError,
  nodeFileSystem,
} from "../installer/reconcile.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-recovery-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-install-recovery-project-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  const workspace = workspacePath(home);
  mkdirSync(join(workspace, "context"), { recursive: true });
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills: []\n",
  );
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspace}\nbindings: []\n`,
  );
  return home;
}

function installationsOf(home: string): number {
  const statePath = join(home, ".agents", "agent-profile-kit", "state", "manifest.json");
  if (!existsSync(statePath)) return 0;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { receipts: unknown[] };
  return state.receipts.length;
}

describe("install recovery restores the previous selection", () => {
  test("an output-write fault removes the added binding and reports the cause", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const failingOutputs = {
      ...nodeFileSystem,
      writeFile: async (): Promise<void> => {
        throw new Error("simulated generated-output write failure");
      },
    };

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
      reconcileFileSystem: failingOutputs,
    }).then(
      () => { throw new Error("expected install to fail"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InstallExecutionError);
    const installFailure = failure as InstallExecutionError;
    expect(installFailure.failure.cause).toBeInstanceOf(ApplyExecutionError);
    expect(installFailure.failure.selectionRestored).toBe(true);
    expect(installFailure.failure.restoreFailure).toBeUndefined();
    expect(readFileSync(configPath(home), "utf8")).not.toContain("profile: coding");
    expect(existsSync(join(projectPath, ".agent-profile-kit"))).toBe(false);
    expect(installationsOf(home)).toBe(0);
  });

  test("an output fault on a changed installation re-publishes the previous selection", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const installed = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
    });
    expect(installed.binding.outcome).toBe("created");
    const failingOutputs = {
      ...nodeFileSystem,
      writeFile: async (): Promise<void> => {
        throw new Error("simulated generated-output write failure");
      },
    };

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex", "claude"],
      project: projectPath,
      reconcileFileSystem: failingOutputs,
    }).then(
      () => { throw new Error("expected install to fail"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InstallExecutionError);
    expect((failure as InstallExecutionError).failure.selectionRestored).toBe(true);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("profile: coding");
    expect(config).toContain("- codex");
    expect(config).not.toContain("- claude");
  });

  test("an Installation State fault restores the selection", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
      writeInstallationState: async (): Promise<void> => {
        throw new Error("simulated Installation State failure");
      },
    }).then(
      () => { throw new Error("expected install to fail"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InstallExecutionError);
    expect((failure as InstallExecutionError).failure.selectionRestored).toBe(true);
    expect(readFileSync(configPath(home), "utf8")).not.toContain("profile: coding");
  });

  test("a failed restoration is reported explicitly instead of claimed", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const armed = { restoreShouldFail: false };
    const failingOutputs = {
      ...nodeFileSystem,
      writeFile: async (): Promise<void> => {
        armed.restoreShouldFail = true;
        throw new Error("simulated generated-output write failure");
      },
    };
    const { defaultFileSystem } = await import("../installer/bind-project.js");
    const failingConfig = {
      ...defaultFileSystem,
      rename: (async (...args: [string, string]): Promise<void> => {
        if (armed.restoreShouldFail) throw new Error("simulated selection-restore failure");
        return defaultFileSystem.rename(args[0], args[1]);
      }) as typeof defaultFileSystem.rename,
    };

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
      reconcileFileSystem: failingOutputs,
      bindFileSystem: failingConfig,
    }).then(
      () => { throw new Error("expected install to fail"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InstallExecutionError);
    const installFailure = failure as InstallExecutionError;
    expect(installFailure.failure.selectionRestored).toBe(false);
    expect(installFailure.failure.restoreFailure).toBeDefined();
    // The stranded selection stays visible instead of vanishing silently.
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
  });

  test("a post-commit verification failure keeps the committed selection", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    let ownershipInspections = 0;
    const { createLifecycleOwnershipInspectionContext } = await import(
      "../installer/lifecycle-ownership-inspection.js"
    );

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
      createOwnershipInspection: () => {
        ownershipInspections += 1;
        // Preflight and per-Project proof pass; the post-commit verification
        // pass fails, which is exactly ApplyVerificationError.
        if (ownershipInspections >= 3) throw new Error("simulated verification failure");
        return createLifecycleOwnershipInspectionContext();
      },
    }).then(
      () => { throw new Error("expected install to fail"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InstallExecutionError);
    const installFailure = failure as InstallExecutionError;
    expect(installFailure.failure.cause).toBeInstanceOf(ApplyVerificationError);
    expect(installFailure.failure.selectionRestored).toBe(false);
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
  });
});
