/**
 * Uninstall sequential recovery (ticket #496, spec #491 US-008/DEC-006,
 * TEST-005): known Project Blockers skip while healthy Projects proceed; an
 * unexpected write failure stops further work with completed Projects
 * retained, the failed Project restored where possible (explicit when
 * restoration fails), and the rest reported unattempted. Through the highest
 * installer entrypoint with injected failure seams.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeInstall } from "../installer/install-application.js";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";
import { ordinaryReceipts } from "../installer/ownership-state.js";
import { defaultFileSystem } from "../installer/local-configuration-publication.js";
import { executeUninstall } from "../installer/uninstall-application.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-recovery-"));
  temporaryDirectories.push(home);
  return home;
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

/** Three Projects with deterministic preview (canonical) order. */
function orderedProjects(): { readonly parent: string; readonly names: readonly string[] } {
  const parent = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-fleet-"));
  temporaryDirectories.push(parent);
  const names = ["aaa", "mmm", "zzz"] as const;
  for (const name of names) mkdirSync(join(parent, name), { recursive: true });
  return { parent, names };
}

async function installAll(home: string, parent: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await executeInstall(home, {
      profile: "engineering",
      hosts: ["codex"],
      project: join(parent, name),
    });
  }
}

function bindingPresent(home: string, project: string): boolean {
  return readFileSync(configPath(home), "utf8").includes(project);
}

async function receiptPresent(home: string, project: string): Promise<boolean> {
  const state = await readInstallationState(home);
  return ordinaryReceipts(state).some((entry) => entry.project === realpathSync(project));
}

async function firstOutputPath(home: string, project: string): Promise<string> {
  const state = await readInstallationState(home);
  const receipt = ordinaryReceipts(state).find(
    (entry) => entry.project === realpathSync(project),
  );
  if (receipt === undefined || receipt.outputs.length === 0) {
    throw new Error(`no recorded output for ${project}`);
  }
  return join(project, receipt.outputs[0]!.path);
}

function cleanup(): void {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("uninstall sequential recovery", () => {
  test("a Git-tracked Project skips while healthy Projects proceed", async () => {
    const home = await setupHome();
    const { parent, names } = orderedProjects();
    const [aaa, mmm, zzz] = names.map((name) => join(parent, name)) as [string, string, string];
    try {
      await installAll(home, parent, names);
      // Independently tracked output blocks removal authority for mmm only.
      execFileSync("git", ["-C", mmm, "init", "-q"]);
      const tracked = await firstOutputPath(home, mmm);
      execFileSync("git", ["-C", mmm, "add", "-f", tracked]);

      const result = await executeUninstall(home, { all: true });

      expect(result.failed).toBeUndefined();
      expect(result.unattempted).toEqual([]);
      expect(result.completed.map((entry) => entry.project).sort()).toEqual([aaa, zzz].sort());
      expect(result.skipped.map((entry) => entry.project)).toEqual([mmm]);
      expect(JSON.stringify(result.skipped[0]!.reason)).toContain("git-tracked-output");

      // Skipped Project is fully preserved; completed Projects are gone.
      expect(await receiptPresent(home, mmm)).toBe(true);
      expect(bindingPresent(home, mmm)).toBe(true);
      expect(existsSync(tracked)).toBe(true);
      expect(await receiptPresent(home, aaa)).toBe(false);
      expect(bindingPresent(home, aaa)).toBe(false);
      expect(await receiptPresent(home, zzz)).toBe(false);
      expect(bindingPresent(home, zzz)).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("an unexpected write failure stops work, retains completed, and restores the failed Project", async () => {
    const home = await setupHome();
    const { parent, names } = orderedProjects();
    const [aaa, mmm, zzz] = names.map((name) => join(parent, name)) as [string, string, string];
    try {
      await installAll(home, parent, names);
      const mmmOutput = await firstOutputPath(home, mmm);
      let stateWrites = 0;
      const failingWriteState: typeof writeInstallationState = async (stateHome, state) => {
        stateWrites += 1;
        // The first commit (aaa) succeeds; the second (mmm) faults.
        if (stateWrites === 2) throw new Error("injected Installation State fault");
        return writeInstallationState(stateHome, state);
      };

      const result = await executeUninstall(home, {
        all: true,
        writeInstallationState: failingWriteState,
      });

      expect(result.completed.map((entry) => entry.project)).toEqual([aaa]);
      expect(result.failed?.project).toBe(mmm);
      expect(result.failed?.selectionRestored).toBe(true);
      expect(result.failed?.concurrentSelectionChange).toBe(false);
      expect(result.unattempted.map((entry) => entry.project)).toEqual([zzz]);

      // Completed stays completed; failed is restored; unattempted is untouched.
      expect(await receiptPresent(home, aaa)).toBe(false);
      expect(bindingPresent(home, aaa)).toBe(false);
      expect(await receiptPresent(home, mmm)).toBe(true);
      expect(bindingPresent(home, mmm)).toBe(true);
      expect(existsSync(mmmOutput)).toBe(true);
      expect(await receiptPresent(home, zzz)).toBe(true);
      expect(bindingPresent(home, zzz)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a failed selection restore is explicit", async () => {
    const home = await setupHome();
    const { parent, names } = orderedProjects();
    const [aaa, mmm] = names.slice(0, 2).map((name) => join(parent, name)) as [string, string];
    try {
      await installAll(home, parent, names.slice(0, 2));
      const mmmOutput = await firstOutputPath(home, mmm);
      const alwaysFailingWriteState: typeof writeInstallationState = async () => {
        throw new Error("injected Installation State fault");
      };
      // Fail the binding-restore publication (the second config temp write).
      // Lock files are ignored: only staged replacement temp files count.
      let configPublishes = 0;
      const failingFileSystem = {
        ...defaultFileSystem,
        writeFile: (async (...args: Parameters<typeof defaultFileSystem.writeFile>) => {
          if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
            configPublishes += 1;
            if (configPublishes === 2) throw new Error("injected Local Configuration fault");
          }
          return defaultFileSystem.writeFile(...args);
        }) as typeof defaultFileSystem.writeFile,
      };

      const result = await executeUninstall(home, {
        all: true,
        writeInstallationState: alwaysFailingWriteState,
        bindFileSystem: failingFileSystem,
      });

      // aaa faults on the state write, then its binding restore faults too:
      // the failure is explicit and the remaining Project is unattempted.
      expect(result.completed).toEqual([]);
      expect(result.failed?.project).toBe(aaa);
      expect(result.failed?.selectionRestored).toBe(false);
      expect(result.failed?.restoreError).toContain("injected Local Configuration fault");
      expect(result.unattempted.map((entry) => entry.project)).toEqual([mmm]);
      // The receipt survives (its write never succeeded) while the binding
      // could not be restored; staged output was rolled back.
      expect(await receiptPresent(home, aaa)).toBe(true);
      expect(bindingPresent(home, aaa)).toBe(false);
      expect(existsSync(await firstOutputPath(home, aaa))).toBe(true);
      expect(await receiptPresent(home, mmm)).toBe(true);
      expect(bindingPresent(home, mmm)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("a concurrent selection change stops the Project untouched with its output restored", async () => {
    const home = await setupHome();
    const { parent, names } = orderedProjects();
    const [aaa, mmm] = names.slice(0, 2).map((name) => join(parent, name)) as [string, string];
    try {
      await installAll(home, parent, names.slice(0, 2));
      const aaaOutput = await firstOutputPath(home, aaa);
      // A concurrent writer restates the selection between preview and the
      // joint commit: the commit must leave it untouched and stop.
      let configReads = 0;
      const concurrentFileSystem = {
        ...defaultFileSystem,
        readFile: (async (...args: Parameters<typeof defaultFileSystem.readFile>) => {
          const result = await defaultFileSystem.readFile(...args);
          if (typeof args[0] === "string" && args[0] === configPath(home)) {
            configReads += 1;
            if (configReads === 1) {
              const { parse, stringify } = await import("yaml");
              const parsed = parse(result as string) as {
                readonly bindings: { readonly project: string; profile: string }[];
              };
              parsed.bindings[0]!.profile = "concurrent";
              await defaultFileSystem.writeFile(args[0], stringify(parsed));
              return stringify(parsed);
            }
          }
          return result;
        }) as typeof defaultFileSystem.readFile,
      };

      const result = await executeUninstall(home, {
        all: true,
        bindFileSystem: concurrentFileSystem,
      });

      expect(result.completed).toEqual([]);
      expect(result.failed?.project).toBe(aaa);
      expect(result.failed?.concurrentSelectionChange).toBe(true);
      expect(result.failed?.selectionRestored).toBe(true);
      expect(result.unattempted.map((entry) => entry.project)).toEqual([mmm]);
      // Nothing was overwritten: the concurrent selection stands, staged
      // output was rolled back, and the receipt survives.
      expect(readFileSync(configPath(home), "utf8")).toContain("profile: concurrent");
      expect(existsSync(aaaOutput)).toBe(true);
      expect(await receiptPresent(home, aaa)).toBe(true);
      expect(await receiptPresent(home, mmm)).toBe(true);
      expect(bindingPresent(home, mmm)).toBe(true);
    } finally {
      cleanup();
    }
  });
});
