/**
 * Uninstall scope resolution (ticket #496, spec #491 US-003/DEC-003):
 * explicit `--here` / `--project` / `--all` scope over recorded Project
 * Bindings, intersected by `--profile`. Selection reads Local Configuration
 * only — never the Workspace — so recovery stays independent of valid
 * source. Zero matches resolve to an empty preview (the command layer
 * reports them truthfully with no writes); conflicting scopes are already
 * rejected by argument parsing and cannot reach this boundary.
 *
 * Ticket #497 pins the Profile-filter composition: `--profile` alone and
 * intersected with every explicit scope kind (`--here`/`--project`/`--all`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { previewUninstall } from "../installer/uninstall-application.js";
import { ProjectTargetError } from "../installer/local-configuration.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-scope-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-project-"));
  temporaryDirectories.push(path);
  return path;
}

function writeBindings(
  home: string,
  bindings: readonly { readonly project: string; readonly profile: string; readonly hosts: readonly string[] }[],
): void {
  const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
  mkdirSync(workspace, { recursive: true });
  const body = bindings
    .map(
      (binding) =>
        `  - project: ${binding.project}\n    profile: ${binding.profile}\n    hosts:\n${binding.hosts
          .map((host) => `      - ${host}\n`)
          .join("")}`,
    )
    .join("");
  writeFileSync(
    join(home, ".agents", "agent-profile-kit", "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n${body}`,
  );
}

async function cleanup(): Promise<void> {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("previewUninstall scope resolution", () => {
  test("--all selects every bound Project", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      const second = projectDirectory();
      writeBindings(home, [
        { project: first, profile: "engineering", hosts: ["codex"] },
        { project: second, profile: "docs", hosts: ["claude"] },
      ]);
      const preview = await previewUninstall(home, { all: true });
      expect(preview.projects.map((entry) => entry.project).sort()).toEqual(
        [first, second].sort(),
      );
      expect(preview.projects.find((entry) => entry.project === first)?.profile).toBe(
        "engineering",
      );
    } finally {
      await cleanup();
    }
  });

  test("--project selects exactly one Project", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      const second = projectDirectory();
      writeBindings(home, [
        { project: first, profile: "engineering", hosts: ["codex"] },
        { project: second, profile: "docs", hosts: ["claude"] },
      ]);
      const preview = await previewUninstall(home, { project: second });
      expect(preview.projects.map((entry) => entry.project)).toEqual([second]);
    } finally {
      await cleanup();
    }
  });

  test("--here selects the containing bound Project", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      const second = projectDirectory();
      writeBindings(home, [
        { project: first, profile: "engineering", hosts: ["codex"] },
        { project: second, profile: "docs", hosts: ["claude"] },
      ]);
      const preview = await previewUninstall(home, { here: true, cwd: second });
      expect(preview.projects.map((entry) => entry.project)).toEqual([second]);
    } finally {
      await cleanup();
    }
  });

  test("--profile alone selects installations using that Profile", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      const second = projectDirectory();
      writeBindings(home, [
        { project: first, profile: "engineering", hosts: ["codex"] },
        { project: second, profile: "docs", hosts: ["claude"] },
      ]);
      const preview = await previewUninstall(home, { profile: "engineering" });
      expect(preview.projects.map((entry) => entry.project)).toEqual([first]);
    } finally {
      await cleanup();
    }
  });

  test("--profile intersects explicit scope instead of replacing it", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      const second = projectDirectory();
      writeBindings(home, [
        { project: first, profile: "engineering", hosts: ["codex"] },
        { project: second, profile: "engineering", hosts: ["claude"] },
      ]);
      const preview = await previewUninstall(home, { project: first, profile: "engineering" });
      expect(preview.projects.map((entry) => entry.project)).toEqual([first]);
      const empty = await previewUninstall(home, { project: first, profile: "docs" });
      expect(empty.projects).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("--profile intersects --here instead of replacing it", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      const second = projectDirectory();
      writeBindings(home, [
        { project: first, profile: "engineering", hosts: ["codex"] },
        { project: second, profile: "docs", hosts: ["claude"] },
      ]);
      const preview = await previewUninstall(home, { here: true, cwd: first, profile: "engineering" });
      expect(preview.projects.map((entry) => entry.project)).toEqual([first]);
      const empty = await previewUninstall(home, { here: true, cwd: first, profile: "docs" });
      expect(empty.projects).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("--profile intersects --all instead of replacing it", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      const second = projectDirectory();
      writeBindings(home, [
        { project: first, profile: "engineering", hosts: ["codex"] },
        { project: second, profile: "docs", hosts: ["claude"] },
      ]);
      const preview = await previewUninstall(home, { all: true, profile: "engineering" });
      expect(preview.projects.map((entry) => entry.project)).toEqual([first]);
      const empty = await previewUninstall(home, { all: true, profile: "unknown-profile" });
      expect(empty.projects).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("zero matches resolve to an empty preview with no writes", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      writeBindings(home, [{ project: first, profile: "engineering", hosts: ["codex"] }]);
      const preview = await previewUninstall(home, { profile: "unknown-profile" });
      expect(preview.projects).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("--project for an unbound directory fails as an uninstall target", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      const other = projectDirectory();
      writeBindings(home, [{ project: first, profile: "engineering", hosts: ["codex"] }]);
      let caught: unknown;
      try {
        await previewUninstall(home, { project: other });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProjectTargetError);
      expect((caught as ProjectTargetError).reason.case).toBe("unbound-target");
      expect((caught as ProjectTargetError).reason.command).toBe("uninstall");
    } finally {
      await cleanup();
    }
  });

  test("absent scope selects nothing, never all Projects", async () => {
    const home = isolatedHome();
    try {
      const first = projectDirectory();
      writeBindings(home, [{ project: first, profile: "engineering", hosts: ["codex"] }]);
      const preview = await previewUninstall(home, {});
      expect(preview.projects).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
