import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

import { openWorkspace } from "../installer/open-workspace.js";
import { localConfigurationPath } from "../installer/local-configuration.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import type { ExecutorOptions, ProcessResult } from "../process/process-executor.js";

const temporaryDirectories: string[] = [];

beforeEach(() => {
  temporaryDirectories.length = 0;
});

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "open-workspace-test-home-")));
  temporaryDirectories.push(home);
  return home;
}

function setupWorkspace(home: string, name = "my-workspace"): string {
  const workspacePath = join(home, name);
  mkdirSync(join(workspacePath, "profiles"), { recursive: true });
  mkdirSync(join(workspacePath, "context"), { recursive: true });
  mkdirSync(join(workspacePath, "skills"), { recursive: true });
  writeFileSync(
    join(workspacePath, "workspace.yaml"),
    stringify({ schema_version: 1 }),
  );
  writeFileSync(
    join(workspacePath, "context", "base.md"),
    "---\nid: base\n---\nBase context\n",
  );
  writeFileSync(
    join(workspacePath, "profiles", "default.yaml"),
    stringify({
      id: "default",
      context: ["base"],
      skills: [],
    }),
  );

  const configPath = localConfigurationPath(home);
  mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
  writeFileSync(
    configPath,
    stringify({
      schema_version: 2,
      workspace: workspacePath,
      bindings: [],
    }),
  );

  return workspacePath;
}

describe("openWorkspace", () => {
  test("resolves configured Workspace and calls opener with canonical path", async () => {
    const home = createHome();
    const workspacePath = setupWorkspace(home);
    const recordedCalls: ExecutorOptions[] = [];

    const mockRunProcess = async (options: ExecutorOptions): Promise<ProcessResult> => {
      recordedCalls.push(options);
      return {
        kind: "exit",
        exitCode: 0,
        signal: null,
        error: null,
        timedOut: false,
        cancelled: false,
        cleanupFailed: false,
        stdout: "",
        stderr: "",
        durationMs: 5,
        commandLabel: options.commandLabel ?? options.executable,
      };
    };

    const result = await openWorkspace({
      home,
      runProcess: mockRunProcess,
    });

    expect(result.path).toBe(workspacePath);
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0]!.executable).toBe("open");
    expect(recordedCalls[0]!.arguments_).toEqual([workspacePath]);
    expect(recordedCalls[0]!.deadlineMs).toBeGreaterThan(0);
  });

  test("rejects when Local Configuration is missing", async () => {
    const home = createHome();

    let thrown: unknown;
    try {
      await openWorkspace({ home });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InstallerToolError);
    expect((thrown as InstallerToolError).fact.kind).toBe("missing-local-configuration");
  });

  test("rejects when Workspace is structurally invalid", async () => {
    const home = createHome();
    const workspacePath = join(home, "broken-workspace");
    mkdirSync(workspacePath, { recursive: true });
    // missing workspace.yaml

    const configPath = localConfigurationPath(home);
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    writeFileSync(
      configPath,
      stringify({
        schema_version: 2,
        workspace: workspacePath,
        bindings: [],
      }),
    );

    let thrown: unknown;
    try {
      await openWorkspace({ home });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InstallerToolError);
    expect((thrown as InstallerToolError).fact.kind).toBe("invalid-workspace");
  });

  test("yields structured recovery when opener executable exits with non-zero code", async () => {
    const home = createHome();
    const workspacePath = setupWorkspace(home);

    const mockRunProcess = async (options: ExecutorOptions): Promise<ProcessResult> => ({
      kind: "exit",
      exitCode: 1,
      signal: null,
      error: null,
      timedOut: false,
      cancelled: false,
      cleanupFailed: false,
      stdout: "",
      stderr: "No application knows how to open path",
      durationMs: 5,
      commandLabel: options.commandLabel ?? options.executable,
    });

    let thrown: unknown;
    try {
      await openWorkspace({
        home,
        runProcess: mockRunProcess,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InstallerToolError);
    const fact = (thrown as InstallerToolError).fact;
    expect(fact.kind).toBe("workspace-open-failed");
    if (fact.kind === "workspace-open-failed") {
      expect(fact.path).toBe(workspacePath);
      expect(fact.detail).toContain("No application knows how to open path");
    }
  });

  test("yields structured recovery when opener executable fails to spawn (ENOENT)", async () => {
    const home = createHome();
    const workspacePath = setupWorkspace(home);

    const spawnError = new Error("spawn open ENOENT");
    const mockRunProcess = async (options: ExecutorOptions): Promise<ProcessResult> => ({
      kind: "spawn-error",
      exitCode: null,
      signal: null,
      error: spawnError,
      timedOut: false,
      cancelled: false,
      cleanupFailed: false,
      stdout: "",
      stderr: "",
      durationMs: 5,
      commandLabel: options.commandLabel ?? options.executable,
    });

    let thrown: unknown;
    try {
      await openWorkspace({
        home,
        runProcess: mockRunProcess,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InstallerToolError);
    const fact = (thrown as InstallerToolError).fact;
    expect(fact.kind).toBe("workspace-open-failed");
    if (fact.kind === "workspace-open-failed") {
      expect(fact.path).toBe(workspacePath);
      expect(fact.detail).toContain("spawn open ENOENT");
    }
  });

  test("yields structured recovery when opener times out", async () => {
    const home = createHome();
    const workspacePath = setupWorkspace(home);

    const mockRunProcess = async (options: ExecutorOptions): Promise<ProcessResult> => ({
      kind: "timeout",
      exitCode: null,
      signal: null,
      error: null,
      timedOut: true,
      cancelled: false,
      cleanupFailed: false,
      stdout: "",
      stderr: "",
      durationMs: 5000,
      commandLabel: options.commandLabel ?? options.executable,
    });

    let thrown: unknown;
    try {
      await openWorkspace({
        home,
        deadlineMs: 5000,
        runProcess: mockRunProcess,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InstallerToolError);
    const fact = (thrown as InstallerToolError).fact;
    expect(fact.kind).toBe("workspace-open-failed");
    if (fact.kind === "workspace-open-failed") {
      expect(fact.path).toBe(workspacePath);
      expect(fact.detail).toContain("timed out after 5000ms");
    }
  });

  test("preserves cleanupFailed evidence when process group cleanup fails", async () => {
    const home = createHome();
    const workspacePath = setupWorkspace(home);

    const mockRunProcess = async (options: ExecutorOptions): Promise<ProcessResult> => ({
      kind: "timeout",
      exitCode: null,
      signal: null,
      error: null,
      timedOut: true,
      cancelled: false,
      cleanupFailed: true,
      stdout: "",
      stderr: "",
      durationMs: 5000,
      commandLabel: options.commandLabel ?? options.executable,
    });

    let thrown: unknown;
    try {
      await openWorkspace({
        home,
        deadlineMs: 5000,
        runProcess: mockRunProcess,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InstallerToolError);
    const fact = (thrown as InstallerToolError).fact;
    expect(fact.kind).toBe("workspace-open-failed");
    if (fact.kind === "workspace-open-failed") {
      expect(fact.path).toBe(workspacePath);
      expect(fact.cleanupFailed).toBe(true);
    }
  });
});
