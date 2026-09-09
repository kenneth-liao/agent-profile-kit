import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../../installer/initialize-workspace.js";
import { buildDesiredState, type DesiredInstallation } from "../../installer/project-plan.js";

const temporaryDirectories: string[] = [];

/** Registers a directory for suite-wide cleanup. */
export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export function cleanupTemporaryDirectories(): void {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
}

export interface DriftedFleetFixture {
  readonly home: string;
  readonly driftedProject: string;
  readonly healthyProject: string;
  /** Desired plan with one drifted generated output and one never-installed Project. */
  readonly desired: readonly DesiredInstallation[];
  readonly driftedOutputPath: string;
  readonly driftedBytes: string;
  /** Local Configuration path, for tests that rebind. */
  readonly configPath: string;
  readonly workspace: string;
}

/**
 * One installed Project with a hand-edited generated file plus one healthy
 * never-installed Project: the confirmation gate must name the first and gate
 * the second.
 */
export async function prepareDriftedFleet(prefix: string): Promise<DriftedFleetFixture> {
  const home = temporaryDirectory(`${prefix}-home-`);
  const driftedProject = realpathSync(temporaryDirectory(`${prefix}-drifted-`));
  const healthyProject = realpathSync(temporaryDirectory(`${prefix}-healthy-`));
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nConfirmation fixture.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext: [team-rules]\nskills: []\n",
  );
  const configPath = join(application, "config.yaml");
  const binding = (project: string): string =>
    `  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`;
  // First apply installs the drifted Project only.
  writeFileSync(configPath, `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${binding(driftedProject)}`);
  const first = await buildDesiredState(home, { checkHostCapability: false });
  const { applyReconciliation } = await import("../../installer/reconcile.js");
  await applyReconciliation(home, first.installations);
  // Hand-edit the installed generated file: proven changed-output drift.
  const driftedOutputPath = join(driftedProject, ".agent-profile-kit", "codex", "context.md");
  const driftedBytes = "hand-edited by the user\n";
  writeFileSync(driftedOutputPath, driftedBytes);
  // The healthy Project joins the fleet afterwards and has never been applied.
  writeFileSync(
    configPath,
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${binding(driftedProject)}${binding(healthyProject)}`,
  );
  const desired = (await buildDesiredState(home, { checkHostCapability: false })).installations;
  return {
    home,
    driftedProject,
    healthyProject,
    desired,
    driftedOutputPath,
    driftedBytes,
    configPath,
    workspace,
  };
}
