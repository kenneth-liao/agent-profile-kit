/**
 * Uninstall removal and forgetting (ticket #496, spec #491 US-003/US-008,
 * DEC-006): one per-Project transition removes owned output and forgets the
 * remembered selection only after removal succeeds. A later update does not
 * recreate the removed installation; unselected Projects and canonical
 * Workspace content stay unchanged. End-to-end through the highest
 * installer entrypoints with real Projects.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeInstall } from "../installer/install-application.js";
import { readInstallationState } from "../installer/installation-state.js";
import { ordinaryReceipts } from "../installer/ownership-state.js";
import { applyApplication } from "../installer/commands.js";
import { executeUninstall } from "../installer/uninstall-application.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-removal-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-rt-project-"));
  temporaryDirectories.push(path);
  return path;
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function writeProfile(home: string, name: string): void {
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", `${name}.yaml`),
    `id: ${name}\ncontext:\n  - team-rules\nskills: []\n`,
  );
}

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  writeProfile(home, "engineering");
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  return home;
}

async function receiptOutputPaths(home: string, project: string): Promise<string[]> {
  const state = await readInstallationState(home);
  const canonical = realpathSync(project);
  const receipt = ordinaryReceipts(state).find((entry) => entry.project === canonical);
  if (receipt === undefined) return [];
  return receipt.outputs.map((output) => join(project, output.path));
}

describe("uninstall removal forgets the selection after success", () => {
  test("full removal deletes output, forgets the binding, and update does not recreate it", async () => {
    const home = await setupHome();
    const removed = projectDirectory();
    const kept = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: removed });
      await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: kept });

      const removedOutputs = await receiptOutputPaths(home, removed);
      expect(removedOutputs.length).toBeGreaterThan(0);
      for (const path of removedOutputs) expect(existsSync(path)).toBe(true);

      const result = await executeUninstall(home, { project: removed });

      expect(result.failed).toBeUndefined();
      expect(result.skipped).toEqual([]);
      expect(result.unattempted).toEqual([]);
      expect(result.completed.map((entry) => entry.project)).toEqual([removed]);

      // Output is gone for the removed Project only.
      for (const path of removedOutputs) expect(existsSync(path)).toBe(false);
      const keptOutputs = await receiptOutputPaths(home, kept);
      expect(keptOutputs.length).toBeGreaterThan(0);
      for (const path of keptOutputs) expect(existsSync(path)).toBe(true);

      // The selection is forgotten: Local Configuration no longer names it.
      const config = readFileSync(configPath(home), "utf8");
      expect(config).not.toContain(removed);
      expect(config).toContain(kept);

      // The receipt is gone, so a later update cannot recreate the installation.
      const afterUninstall = await readInstallationState(home);
      expect(
        afterUninstall.receipts.some((entry) => entry.project === realpathSync(removed)),
      ).toBe(false);
      await applyApplication(home, {});
      for (const path of removedOutputs) expect(existsSync(path)).toBe(false);
      const afterUpdate = await readInstallationState(home);
      expect(
        afterUpdate.receipts.some((entry) => entry.project === realpathSync(removed)),
      ).toBe(false);

      // Canonical Workspace content is unchanged.
      expect(
        readFileSync(join(workspacePath(home), "context", "team-rules.md"), "utf8"),
      ).toContain("Always preserve the project boundary.");
    } finally {
      for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("a vanished Project root converges: its receipt is forgotten without staging", async () => {
    const home = await setupHome();
    const removed = projectDirectory();
    const kept = projectDirectory();
    try {
      await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: removed });
      await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: kept });
      const removedCanonical = realpathSync(removed);
      rmSync(removed, { recursive: true, force: true });

      const result = await executeUninstall(home, { project: removed });

      expect(result.failed).toBeUndefined();
      expect(result.completed.map((entry) => entry.project)).toEqual([removed]);
      expect(readFileSync(configPath(home), "utf8")).not.toContain(removed);
      const state = await readInstallationState(home);
      expect(
        state.receipts.some((entry) => entry.project === removedCanonical),
      ).toBe(false);
      // The surviving installation is untouched.
      const keptOutputs = await receiptOutputPaths(home, kept);
      expect(keptOutputs.length).toBeGreaterThan(0);
      for (const path of keptOutputs) expect(existsSync(path)).toBe(true);
    } finally {
      for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
