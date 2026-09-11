/**
 * Uninstall fleet qualification (ticket #496, spec #491 TEST-002): scope and
 * filter intersections at representative fleet size — 18 Projects across six
 * Hosts with long paths and colliding basenames. Selected scope is removed
 * and forgotten; unselected Projects stay byte-identical; zero matches write
 * nothing. Ticket #497 pins the Profile-source safety: removing every
 * installation of a Profile leaves its canonical Workspace source untouched.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeInstall } from "../installer/install-application.js";
import { readInstallationState } from "../installer/installation-state.js";
import { ordinaryReceipts } from "../installer/ownership-state.js";
import { executeUninstall, previewUninstall } from "../installer/uninstall-application.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { SUPPORTED_HOSTS } from "../schemas/local-configuration.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-fleet-"));
  temporaryDirectories.push(home);
  return home;
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function writeProfiles(home: string): void {
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  for (const name of ["engineering", "docs"]) {
    writeFileSync(
      join(workspacePath(home), "profiles", `${name}.yaml`),
      `id: ${name}\ncontext:\n  - team-rules\nskills: []\n`,
    );
  }
}

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  writeProfiles(home);
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  return home;
}

interface FleetProject {
  readonly directory: string;
  readonly profile: string;
  readonly hosts: readonly string[];
}

async function installFleet(home: string): Promise<readonly FleetProject[]> {
  const parent = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-fleet-projects-"));
  temporaryDirectories.push(parent);
  const fleet: FleetProject[] = [];
  for (let index = 0; index < 18; index += 1) {
    // Colliding basenames in distinct parents plus one long path segment.
    const directory = index === 17
      ? join(parent, `group-b-${"nested-".repeat(8)}deep`, "app")
      : join(parent, `group-${index % 2 === 0 ? "a" : "b"}`, `project-${String(index).padStart(2, "0")}`);
    mkdirSync(directory, { recursive: true });
    const profile = index % 3 === 2 ? "docs" : "engineering";
    const hosts = [SUPPORTED_HOSTS[index % SUPPORTED_HOSTS.length]!] as readonly string[];
    await executeInstall(home, { profile, hosts, project: directory });
    fleet.push({ directory, profile, hosts });
  }
  return fleet;
}

function boundProjects(home: string): string[] {
  const source = readFileSync(configPath(home), "utf8");
  return [...source.matchAll(/- project: (\S+)/g)].map((match) => match[1]!);
}

async function installedProjects(home: string): Promise<string[]> {
  const state = await readInstallationState(home);
  return ordinaryReceipts(state).map((receipt) => receipt.project).sort();
}

describe("uninstall fleet qualification", () => {
  test("scope intersections remove and forget exactly the selected Projects", async () => {
    const home = await setupHome();
    try {
      const fleet = await installFleet(home);
      expect(fleet).toHaveLength(18);
      expect(await installedProjects(home)).toHaveLength(18);
      const canonical = (directory: string): string => realpathSync(directory);

      // --profile intersects the fleet: docs installations go, engineering stays.
      const docs = fleet.filter((entry) => entry.profile === "docs");
      const engineering = fleet.filter((entry) => entry.profile === "engineering");
      expect(docs.length).toBeGreaterThan(0);
      // The canonical Profile source is snapshotted before removal: no
      // filter may delete the Workspace definition it selects by (US-003).
      const docsSourcePath = join(workspacePath(home), "profiles", "docs.yaml");
      const engineeringSourcePath = join(workspacePath(home), "profiles", "engineering.yaml");
      const docsSourceBefore = readFileSync(docsSourcePath, "utf8");
      const engineeringSourceBefore = readFileSync(engineeringSourcePath, "utf8");
      const profilePreview = await previewUninstall(home, { profile: "docs" });
      expect(profilePreview.projects).toHaveLength(docs.length);
      const profileResult = await executeUninstall(home, { profile: "docs" });
      expect(profileResult.failed).toBeUndefined();
      expect(profileResult.completed).toHaveLength(docs.length);
      for (const entry of docs) {
        expect(boundProjects(home)).not.toContain(entry.directory);
      }
      for (const entry of engineering) {
        expect(boundProjects(home)).toContain(entry.directory);
      }
      expect(await installedProjects(home)).toEqual(
        engineering.map((entry) => canonical(entry.directory)).sort(),
      );
      // Removing every installation of a Profile never deletes its
      // canonical Workspace source: full composition only.
      expect(existsSync(docsSourcePath)).toBe(true);
      expect(readFileSync(docsSourcePath, "utf8")).toBe(docsSourceBefore);
      expect(readFileSync(engineeringSourcePath, "utf8")).toBe(engineeringSourceBefore);

      // --project narrows to one installation; everything else is untouched.
      const [single] = engineering;
      const singleResult = await executeUninstall(home, { project: single!.directory });
      expect(singleResult.failed).toBeUndefined();
      expect(singleResult.completed.map((entry) => entry.project)).toEqual([single!.directory]);
      expect(boundProjects(home)).not.toContain(single!.directory);
      expect(await installedProjects(home)).toEqual(
        engineering.slice(1).map((entry) => canonical(entry.directory)).sort(),
      );

      // A zero-match filter writes nothing and reports empty.
      const before = readFileSync(configPath(home), "utf8");
      const zeroPreview = await previewUninstall(home, { profile: "unknown-profile" });
      expect(zeroPreview.projects).toEqual([]);
      const zeroResult = await executeUninstall(home, { profile: "unknown-profile" });
      expect(zeroResult.completed).toEqual([]);
      expect(zeroResult.failed).toBeUndefined();
      expect(readFileSync(configPath(home), "utf8")).toBe(before);

      // --here selects the containing Project from a descendant directory.
      const [here] = engineering.slice(1);
      const descendant = join(here!.directory, "src", "nested");
      mkdirSync(descendant, { recursive: true });
      const herePreview = await previewUninstall(home, { here: true, cwd: descendant });
      expect(herePreview.projects.map((entry) => entry.project)).toEqual([here!.directory]);

      // Unselected Projects keep their generated output on disk.
      for (const entry of engineering.slice(2)) {
        const state = await readInstallationState(home);
        const receipt = ordinaryReceipts(state).find(
          (candidate) => candidate.project === canonical(entry.directory),
        );
        expect(receipt).toBeDefined();
        for (const output of receipt!.outputs) {
          expect(existsSync(join(entry.directory, output.path))).toBe(true);
        }
      }
    } finally {
      for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
