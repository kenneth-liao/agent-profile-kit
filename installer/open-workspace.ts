import { ingestSelectedWorkspace } from "./local-configuration.js";
import { InstallerToolError } from "./tool-errors.js";
import {
  runProcess as defaultRunProcess,
  type ExecutorOptions,
  type ProcessResult,
} from "../process/process-executor.js";

const DEFAULT_OPEN_DEADLINE_MS = 5000;

export interface OpenWorkspaceOptions {
  readonly home: string;
  readonly deadlineMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly executable?: string;
  /** Test-only seam to override process execution. */
  readonly runProcess?: (
    options: ExecutorOptions,
    abortSignal?: AbortSignal,
  ) => Promise<ProcessResult>;
}

export interface OpenWorkspaceResult {
  readonly path: string;
}

/**
 * Open the configured Workspace using the system opener.
 * Reuses the existing configuration-resolution boundary to select the canonical
 * Workspace root. Child process execution is bounded and uses direct argv
 * without shell interpolation (ADR-0027).
 */
export async function openWorkspace(
  options: OpenWorkspaceOptions,
): Promise<OpenWorkspaceResult> {
  const workspace = await ingestSelectedWorkspace(options.home);
  const executable = options.executable ?? "open";
  const deadlineMs = options.deadlineMs ?? DEFAULT_OPEN_DEADLINE_MS;
  const executor = options.runProcess ?? defaultRunProcess;

  const result = await executor({
    executable,
    arguments_: [workspace.path],
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    deadlineMs,
    commandLabel: `${executable} ${workspace.path}`,
  });

  if (result.kind === "exit" && result.exitCode === 0) {
    return { path: workspace.path };
  }

  let detail: string;
  switch (result.kind) {
    case "exit":
      detail = result.stderr.trim() || `command failed with exit code ${result.exitCode}`;
      break;
    case "spawn-error":
      detail = result.error.message;
      break;
    case "timeout":
      detail = `opener process timed out after ${deadlineMs}ms`;
      break;
    case "signal":
      detail = `opener process terminated by signal ${result.signal}`;
      break;
    case "output-limit":
      detail = "opener process exceeded per-stream output budget";
      break;
    case "cancelled":
      detail = "opener process was cancelled unexpectedly";
      break;
  }

  throw new InstallerToolError({
    kind: "workspace-open-failed",
    path: workspace.path,
    detail,
    ...(result.cleanupFailed ? { cleanupFailed: true } : {}),
  });
}
