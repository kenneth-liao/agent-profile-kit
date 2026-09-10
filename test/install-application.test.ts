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
  sameInstallSelection,
} from "../installer/install-application.js";
import { bindProject } from "../installer/bind-project.js";
import { createLifecycleOwnershipInspectionContext } from "../installer/lifecycle-ownership-inspection.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { applyReconciliation } from "../installer/reconcile.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { defaultFileSystem } from "../installer/bind-project.js";
import type { BindProjectFileSystem } from "../installer/bind-project.js";
import {
  ApplyDeclinedError,
  ApplyExecutionError,
  ApplyReviewStaleError,
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
    join(workspace, "profiles", "ops.yaml"),
    "id: ops\ncontext:\n  - team-rules\nskills: []\n",
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

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
      createOwnershipInspection: () => {
        ownershipInspections += 1;
        // Phase-A preflight, apply preflight, and per-Project proof pass; the
        // post-commit verification pass fails, which is exactly
        // ApplyVerificationError.
        if (ownershipInspections >= 4) throw new Error("simulated verification failure");
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

/** Records every Local Configuration write outside lock coordination. */
function spyingConfigurationFileSystem(recorded: string[]): BindProjectFileSystem {
  const record = (path: unknown): void => {
    if (typeof path === "string" && !path.endsWith(".lock")) recorded.push(path);
  };
  return {
    mkdir: (async (...args: Parameters<typeof defaultFileSystem.mkdir>) => {
      record(args[0]);
      return defaultFileSystem.mkdir(...args);
    }) as typeof defaultFileSystem.mkdir,
    readdir: defaultFileSystem.readdir,
    readFile: defaultFileSystem.readFile,
    rename: (async (...args: Parameters<typeof defaultFileSystem.rename>) => {
      record(args[0]);
      record(args[1]);
      return defaultFileSystem.rename(...args);
    }) as typeof defaultFileSystem.rename,
    rm: (async (...args: Parameters<typeof defaultFileSystem.rm>) => {
      record(args[0]);
      return defaultFileSystem.rm(...args);
    }) as typeof defaultFileSystem.rm,
    stat: defaultFileSystem.stat,
    unlink: (async (...args: Parameters<typeof defaultFileSystem.unlink>) => {
      record(args[0]);
      return defaultFileSystem.unlink(...args);
    }) as typeof defaultFileSystem.unlink,
    writeFile: (async (...args: Parameters<typeof defaultFileSystem.writeFile>) => {
      record(args[0]);
      return defaultFileSystem.writeFile(...args);
    }) as typeof defaultFileSystem.writeFile,
  };
}

describe("install consent precedes selection publication", () => {
  test("the consent review observes zero configuration publications and refusal writes nothing", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const installed = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
    });
    expect(installed.binding.outcome).toBe("created");
    const outputPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(outputPath, "hand-edited by the user\n");
    const configurationWrites: string[] = [];
    let consentObservations = 0;

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["claude"],
      project: projectPath,
      bindFileSystem: spyingConfigurationFileSystem(configurationWrites),
      confirmChangedOutputReplacement: async () => {
        consentObservations += 1;
        expect(configurationWrites).toEqual([]);
        return "declined";
      },
    }).then(
      () => { throw new Error("expected install to fail"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InstallExecutionError);
    expect((failure as InstallExecutionError).failure.cause).toBeInstanceOf(ApplyDeclinedError);
    expect(consentObservations).toBe(1);
    expect(configurationWrites).toEqual([]);
    const config = readFileSync(configPath(home), "utf8");
    expect(config).toContain("- codex");
    expect(config).not.toContain("- claude");
    expect(readFileSync(outputPath, "utf8")).toBe("hand-edited by the user\n");
  });
});

describe("install commit serializes cooperating writers", () => {
  test("a cooperating selection writer waits out the commit boundary instead of interleaving", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    let releaseStaging: (() => void) | undefined;
    const stagingGate = new Promise<void>((resolve) => {
      releaseStaging = resolve;
    });
    let stagingEntered = false;
    const gatedOutputs = {
      ...nodeFileSystem,
      writeFile: (async (...args: Parameters<typeof nodeFileSystem.writeFile>) => {
        stagingEntered = true;
        await stagingGate;
        return nodeFileSystem.writeFile(...args);
      }) as typeof nodeFileSystem.writeFile,
    };

    const install = executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
      reconcileFileSystem: gatedOutputs,
    });
    const deadline = Date.now() + 5000;
    while (!stagingEntered) {
      if (Date.now() > deadline) throw new Error("install never reached output staging");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The commit holds the configuration lock across publication and output
    // writes: a cooperating writer fails closed instead of interleaving.
    const competitor = await bindProject({
      home,
      profile: "ops",
      hosts: ["claude"],
      project: projectPath,
      replace: true,
      lockTimeoutMs: 100,
    }).then(
      () => { throw new Error("expected the cooperating writer to wait out the lock"); },
      (error: unknown) => error,
    );
    expect(competitor).toBeInstanceOf(InstallerToolError);
    expect((competitor as InstallerToolError).fact.kind).toBe("configuration-lock-busy");
    releaseStaging!();

    const result = await install;
    expect(result.binding.outcome).toBe("created");
    expect(result.binding.profile).toBe("coding");
    // After release the cooperating writer converges normally.
    const retry = await bindProject({
      home,
      profile: "ops",
      hosts: ["claude"],
      project: projectPath,
      replace: true,
    });
    expect(retry.outcome).toBe("replaced");
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: ops");
  });

  test("a commit-time byte move stops as stale with the selection restored", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const installed = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
    });
    expect(installed.binding.outcome).toBe("created");
    const outputPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    writeFileSync(outputPath, "hand-edited by the user\n");

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
      confirmChangedOutputReplacement: async () => {
        // Move the reviewed bytes after the review but before the commit.
        writeFileSync(outputPath, "moved again before commit\n");
        return "accepted";
      },
    }).then(
      () => { throw new Error("expected install to fail"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(InstallExecutionError);
    const installFailure = failure as InstallExecutionError;
    expect(installFailure.failure.cause).toBeInstanceOf(ApplyReviewStaleError);
    expect(installFailure.failure.selectionRestored).toBe(true);
    expect(installFailure.failure.outputCommitted).toBe(false);
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
    expect(readFileSync(outputPath, "utf8")).toBe("moved again before commit\n");
  });

  test("selection snapshots compare profile, hosts, and authored spelling", () => {
    const selection = { profile: "coding", hosts: ["codex"] as const, authoredProject: "/proj" };
    expect(sameInstallSelection(undefined, undefined)).toBe(true);
    expect(sameInstallSelection(selection, undefined)).toBe(false);
    expect(sameInstallSelection(undefined, selection)).toBe(false);
    expect(sameInstallSelection(selection, { ...selection })).toBe(true);
    expect(sameInstallSelection(selection, { ...selection, profile: "ops" })).toBe(false);
    expect(sameInstallSelection(selection, { ...selection, hosts: ["claude"] as const })).toBe(false);
    expect(sameInstallSelection(selection, { ...selection, authoredProject: "~/proj" })).toBe(false);
  });
});

describe("install recovery resolves home-relative paths against the real home", () => {
  test("restoring a new binding with home-relative Workspace and Project paths succeeds", async () => {
    const home = await setupHome();
    const projectPath = join(home, "proj");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(
      configPath(home),
      `schema_version: 2\nworkspace: ~/.agents/agent-profile-kit/workspace\nbindings: []\n`,
    );
    const failingOutputs = {
      ...nodeFileSystem,
      writeFile: async (): Promise<void> => {
        throw new Error("simulated generated-output write failure");
      },
    };

    const failure = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: "~/proj",
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
  });
});

describe("install excludes lifecycle writers through publication and recovery", () => {
  test("an update cannot commit between selection publication and install recovery", async () => {
    const home = await setupHome();
    const projectPath = projectDirectory();
    const baseline = await executeInstall(home, {
      profile: "coding",
      hosts: ["codex"],
      project: projectPath,
    });
    expect(baseline.binding.outcome).toBe("created");
    const outputPath = join(projectPath, ".agent-profile-kit", "codex", "context.md");
    const installedBytes = readFileSync(outputPath, "utf8");

    async function contendingUpdate(): Promise<unknown> {
      const desired = await buildDesiredState(home);
      return applyReconciliation(home, desired.installations, { lockTimeoutMs: 100 }).then(
        () => { throw new Error("expected the contending update to wait out the lock"); },
        (error: unknown) => error,
      );
    }

    let renames = 0;
    const failingOutputs = {
      ...nodeFileSystem,
      writeFile: async (): Promise<void> => {
        throw new Error("simulated generated-output write failure");
      },
    };
    const gatedConfig: BindProjectFileSystem = {
      ...defaultFileSystem,
      rename: (async (...args: Parameters<typeof defaultFileSystem.rename>) => {
        renames += 1;
        // Rename 1 publishes the requested selection; rename 2 restores the
        // previous one. Both run under the joint boundary, so the ordinary
        // update path (lifecycle lock only) must wait out each of them.
        const contender = await contendingUpdate();
        expect(contender).toBeInstanceOf(InstallerToolError);
        expect((contender as InstallerToolError).fact.kind).toBe("lifecycle-lock-busy");
        return defaultFileSystem.rename(...args);
      }) as typeof defaultFileSystem.rename,
    };

    const failure = await executeInstall(home, {
      profile: "ops",
      hosts: ["claude"],
      project: projectPath,
      bindFileSystem: gatedConfig,
      reconcileFileSystem: failingOutputs,
    }).then(
      () => { throw new Error("expected install to fail"); },
      (error: unknown) => error,
    );

    expect(renames).toBe(2);
    expect(failure).toBeInstanceOf(InstallExecutionError);
    const installFailure = failure as InstallExecutionError;
    expect(installFailure.failure.selectionRestored).toBe(true);
    expect(installFailure.failure.outputCommitted).toBe(false);
    // No split brain: the restored selection matches the durable receipt and
    // the untouched output.
    expect(readFileSync(configPath(home), "utf8")).toContain("profile: coding");
    expect(readFileSync(outputPath, "utf8")).toBe(installedBytes);
    expect(installationsOf(home)).toBe(1);
    // After release the ordinary update path converges on the restored state.
    const desired = await buildDesiredState(home);
    const converged = await applyReconciliation(home, desired.installations, {});
    expect(converged.resultingState.projects.every((project) => project.state.kind === "current")).toBe(true);
  });
});
