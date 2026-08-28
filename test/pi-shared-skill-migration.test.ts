import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
import {
  ApplyBlockedError,
  applyReconciliation,
  manifestFor,
} from "../installer/reconcile.js";
import {
  emptyInstallationState,
  readInstallationState,
  writeInstallationState,
} from "../installer/installation-state.js";
import { uninstallApplication } from "../installer/commands.js";
import { formatInstallationMarker } from "../schemas/installation-manifest.js";
import type {
  DesiredInstallation,
  DesiredProjectDirectoryOutput,
} from "../installer/project-plan.js";
import {
  reportBlockers,
  reportItems,
} from "./support/reconciliation-report.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writePiSkillWorkspace(home: string, project: string): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  const skill = join(workspace, "skills", "review-pr");
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, "SKILL.md"),
    "---\nname: review-pr\ndescription: Review a pull request.\n---\n\n# Review\n",
  );
  writeFileSync(
    join(workspace, "profiles", "skills-only.yaml"),
    "id: skills-only\ncontext: []\nskills: [review-pr]\n",
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: skills-only\n    hosts: [pi]\n`,
  );
}

function writeDesiredDirectory(
  project: string,
  output: DesiredProjectDirectoryOutput,
  path = output.path,
): void {
  const root = join(project, path);
  mkdirSync(root, { recursive: true, mode: output.mode });
  chmodSync(root, output.mode);
  for (const member of output.members) {
    const memberPath = join(root, member.path);
    if (member.type === "directory") {
      mkdirSync(memberPath, { recursive: true, mode: member.mode });
      chmodSync(memberPath, member.mode);
      continue;
    }
    mkdirSync(join(memberPath, ".."), { recursive: true });
    writeFileSync(memberPath, member.bytes, { mode: member.mode });
    chmodSync(memberPath, member.mode);
  }
}

function oldPiManifest(
  installation: DesiredInstallation,
  installationId: string,
  oldPath: string,
): { readonly manifest: ReturnType<typeof manifestFor>; readonly desiredOutput: DesiredProjectDirectoryOutput } {
  const manifest = manifestFor(installation, installationId);
  const sharedPath = ".agents/skills/review-pr";
  const desiredOutput = installation.outputs.find(
    (output): output is DesiredProjectDirectoryOutput => output.path === sharedPath && output.type === "directory",
  );
  if (!desiredOutput) throw new Error("expected shared Skill output");
  const sharedOwned = manifest.outputs.find((output) => output.path === sharedPath);
  if (!sharedOwned) throw new Error("expected shared owned output");
  return {
    desiredOutput,
    manifest: {
      ...manifest,
      hosts: {
        pi: {
          adapterVersion: "pi-project-v1",
          capabilityContract: "native-project-skills-v1",
        },
      },
      outputs: manifest.outputs.map((output) =>
        output.path === sharedPath ? { ...output, path: oldPath } : output,
      ),
    },
  };
}

describe("Pi shared Skill migration", () => {
  test("moves an existing owned Pi Skill package, converges, and uninstalls the migrated output", async () => {
    const home = temporaryDirectory("apk-pi-migration-home-");
    const project = temporaryDirectory("apk-pi-migration-project-");
    await writePiSkillWorkspace(home, project);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected desired Pi installation");
    const oldPath = ".pi/skills/review-pr";
    const oldId = "old-pi-installation";
    const old = oldPiManifest(installation, oldId, oldPath);
    writeDesiredDirectory(project, old.desiredOutput, oldPath);
    mkdirSync(join(project, ".pi", "skills", "unrelated"), { recursive: true });
    writeFileSync(join(project, ".pi", "skills", "unrelated", "README.md"), "keep\n");
    mkdirSync(join(project, ".agent-profile-kit"), { recursive: true });
    writeFileSync(
      join(project, ".agent-profile-kit", "installation.json"),
      formatInstallationMarker({ installationId: oldId, schemaVersion: 1 }),
    );
    await writeInstallationState(home, {
      ...emptyInstallationState(),
      receipts: [old.manifest],
    });

    const migrated = await applyReconciliation(home, desired.installations);
    expect(reportBlockers(migrated.resultingState)).toEqual([]);
    expect(existsSync(join(project, ".pi", "skills", "review-pr"))).toBe(false);
    expect(readFileSync(join(project, ".pi", "skills", "unrelated", "README.md"), "utf8")).toBe("keep\n");
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    const state = await readInstallationState(home);
    expect(state.receipts[0]?.outputs.some((output) => output.path === oldPath)).toBe(false);
    expect(state.receipts[0]?.outputs.some((output) => output.path === ".agents/skills/review-pr")).toBe(true);

    const current = await applyReconciliation(
      home,
      (await buildDesiredState(home, { checkHostCapability: false })).installations,
    );
    expect(reportBlockers(current.resultingState)).toEqual([]);
    expect(reportItems(current.resultingState).every((item) => item.kind === "current")).toBe(true);

    await uninstallApplication(home);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".pi", "skills", "review-pr"))).toBe(false);
    expect(readFileSync(join(home, ".agents", "agent-profile-kit", "config.yaml"), "utf8")).toContain(project);
  });

  test("does not adopt an identical unowned shared destination during migration", async () => {
    const home = temporaryDirectory("apk-pi-migration-occupied-home-");
    const project = temporaryDirectory("apk-pi-migration-occupied-project-");
    await writePiSkillWorkspace(home, project);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected desired Pi installation");
    const oldPath = ".pi/skills/review-pr";
    const oldId = "old-pi-occupied-installation";
    const old = oldPiManifest(installation, oldId, oldPath);
    writeDesiredDirectory(project, old.desiredOutput, oldPath);
    writeDesiredDirectory(project, old.desiredOutput);
    mkdirSync(join(project, ".agent-profile-kit"), { recursive: true });
    writeFileSync(
      join(project, ".agent-profile-kit", "installation.json"),
      formatInstallationMarker({ installationId: oldId, schemaVersion: 1 }),
    );
    await writeInstallationState(home, {
      ...emptyInstallationState(),
      receipts: [old.manifest],
    });
    const statePath = join(home, ".agents", "agent-profile-kit", "state", "manifest.json");
    const beforeState = readFileSync(statePath, "utf8");
    const sharedSkill = join(project, ".agents", "skills", "review-pr", "SKILL.md");

    let caught: unknown;
    try {
      await applyReconciliation(home, desired.installations);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplyBlockedError);
    expect(String(reportBlockers((caught as ApplyBlockedError).report)[0]?.message)).toContain(".agents/skills/review-pr");
    expect(readFileSync(sharedSkill, "utf8")).toContain("name: review-pr");
    expect(existsSync(join(project, oldPath))).toBe(true);
    expect(readFileSync(statePath, "utf8")).toBe(beforeState);
  });

  test("migrates a modified old Pi package by removing the drifted proven old root", async () => {
    const home = temporaryDirectory("apk-pi-migration-drift-home-");
    const project = temporaryDirectory("apk-pi-migration-drift-project-");
    await writePiSkillWorkspace(home, project);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected desired Pi installation");
    const oldPath = ".pi/skills/review-pr";
    const oldId = "old-pi-drift-installation";
    const old = oldPiManifest(installation, oldId, oldPath);
    writeDesiredDirectory(project, old.desiredOutput, oldPath);
    mkdirSync(join(project, ".agent-profile-kit"), { recursive: true });
    writeFileSync(
      join(project, ".agent-profile-kit", "installation.json"),
      formatInstallationMarker({ installationId: oldId, schemaVersion: 1 }),
    );
    await writeInstallationState(home, {
      ...emptyInstallationState(),
      receipts: [old.manifest],
    });
    const statePath = join(home, ".agents", "agent-profile-kit", "state", "manifest.json");
    const beforeState = readFileSync(statePath, "utf8");
    writeFileSync(join(project, oldPath, "SKILL.md"), "user edit\n");

    // The old package is an identity-proven generated output root: its drift is
    // refresh work, so migration removes it instead of blocking on the edit.
    await applyReconciliation(home, desired.installations);

    expect(existsSync(join(project, oldPath))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(true);
    expect((await readInstallationState(home)).receipts[0]?.outputs.some(
      (output) => output.path === oldPath,
    )).toBe(false);
    expect(readFileSync(statePath, "utf8")).not.toBe(beforeState);
  });
});
