import { afterAll, describe, expect, test } from "bun:test";
import { OWNERSHIP_STATE_SCHEMA_VERSION } from "../schemas/ownership-state.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatTemporaryInstallationBlockedJson,
  lifecycleExitCode,
} from "../cli/presentation.js";
import {
  AFFECTED_ITEM_KINDS,
  BLOCKER_KINDS,
  blockerMessage,
  isStructuredBlocker,
  normalizeBlocker,
  OUTPUT_OWNERSHIP_CONFLICT,
  type ReconciliationBlocker,
} from "../installer/blockers.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { desiredOutputConflicts, previewReconciliation } from "../installer/reconcile.js";
import { createLifecycleOwnershipInspectionContext } from "../installer/lifecycle-ownership-inspection.js";
import { TemporaryInstallationBlockedError } from "../installer/temporary-installation.js";
import {
  reportBlockers,
} from "./support/reconciliation-report.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function compileOnlyPartialBlocker(): void {
  // @ts-expect-error Structured blockers require every evidence field.
  normalizeBlocker({
    affectedItems: [],
    kind: "occupied-output",
    scope: "global",
  });
}

void compileOnlyPartialBlocker;

const GLOBAL_BLOCKER_INPUT = {
  affectedItems: [{ kind: "host", value: "codex" }],
  kind: "installation-ownership",
  problem: "Generated file ownership cannot be proven",
  remedy: "Remove the conflicting generated files yourself, then retry",
  requirement: "Ownership must be proven before writes",
  scope: "global",
} as const;

describe("shared blocker contract", () => {
  test("normalizes complete structured evidence into a scoped blocker", () => {
    const input = {
      ...GLOBAL_BLOCKER_INPUT,
      project: "/project-a",
      scope: "project",
    } as const;
    const blocker = normalizeBlocker(input);

    expect(isStructuredBlocker(blocker)).toBe(true);
    expect(blocker).toMatchObject({
      affectedItems: [{ kind: "host", value: "codex" }],
      kind: "installation-ownership",
      message: "Generated file ownership cannot be proven",
      problem: "Generated file ownership cannot be proven",
      remedy: "Remove the conflicting generated files yourself, then retry",
      requirement: "Ownership must be proven before writes",
      project: "/project-a",
      scope: "project",
    });
    expect(() => normalizeBlocker({ ...input, project: "/project-b" }, "/project-a"))
      .toThrow(/fallback project.*kind="installation-ownership".*project="\/project-b"/);
  });

  test("message-only blockers can no longer be represented or normalized", () => {
    // @ts-expect-error The blocker contract is exhaustively structured; message-only blockers no longer exist.
    const legacy: ReconciliationBlocker = { message: "occupied output", project: "/project-a" };
    void legacy;

    expect(() => normalizeBlocker("occupied output" as never))
      .toThrow("Blocker input must be a structured blocker object");
    expect(() => normalizeBlocker({ message: "occupied output", project: "/project-a" } as never))
      .toThrow(/Legacy message-only blockers are no longer supported/);
  });

  test("rejects partially populated structured evidence at runtime", () => {
    expect(() => normalizeBlocker({
      kind: "installation-ownership",
      message: "Ownership cannot be proven",
      scope: "global",
    } as never)).toThrow("Structured blocker problem must be a non-empty string");
    expect(() => normalizeBlocker({
      kind: "installation-ownership",
      message: "Ownership cannot be proven",
      scope: "global",
    } as never)).toThrow(/kind=\"installation-ownership\"/);
    expect(() => normalizeBlocker({
      affectedItems: [],
      message: "Codex CLI is unavailable",
      problem: "Codex CLI is unavailable",
      remedy: "Install a supported Codex CLI, then retry",
      requirement: "The selected Profile requires Codex project delivery",
      scope: "global",
    } as never)).toThrow("Structured blocker kind must be a non-empty string");
  });

  test("rejects an unknown structured blocker scope at runtime", () => {
    expect(() => normalizeBlocker({
      affectedItems: [],
      kind: "installation-ownership",
      message: "Ownership cannot be proven",
      problem: "Ownership cannot be proven",
      remedy: "Remove the conflicting generated files yourself, then retry",
      requirement: "Ownership must be proven before writes",
      scope: "workspace",
    } as never)).toThrow("Structured blocker scope must be 'global' or 'project'");
  });

  test("project-scoped blocker problems cannot duplicate their Project identity", () => {
    expect(() => normalizeBlocker({
      affectedItems: [{ kind: "host", value: "codex" }],
      kind: "installation-ownership",
      problem: "/project-a: ownership cannot be proven",
      project: "/project-a",
      remedy: "Remove the conflicting generated files yourself, then retry",
      requirement: "Ownership must be proven before writes",
      scope: "project",
    })).toThrow("Structured blocker problem must not duplicate its project identity");
  });

  test("unknown blocker and affected-item kinds are rejected at runtime", () => {
    expect(() => normalizeBlocker({
      affectedItems: [],
      kind: "unknown-kind",
      message: "Ownership cannot be proven",
      problem: "Ownership cannot be proven",
      remedy: "Remove the conflicting generated files yourself, then retry",
      requirement: "Ownership must be proven before writes",
      scope: "global",
    } as never)).toThrow(/Unknown structured blocker kind "unknown-kind"/);

    expect(() => normalizeBlocker({
      affectedItems: [{ kind: "unknown-item", value: "codex" }],
      kind: "installation-ownership",
      message: "Ownership cannot be proven",
      problem: "Ownership cannot be proven",
      remedy: "Remove the conflicting generated files yourself, then retry",
      requirement: "Ownership must be proven before writes",
      scope: "global",
    } as never)).toThrow(/Unknown structured blocker affected-item kind "unknown-item"/);
  });

  test("blocker kinds form one exhaustive typed vocabulary", () => {
    expect(BLOCKER_KINDS).toEqual([
      "output-ownership-conflict",
      "installation-state-unreadable",
      "repository-exclusion-contribution",
      "repository-exclusion-target-unproven",
      "repository-exclusion-invalid",
      "occupied-output",
      "installation-ownership",
      "temporary-installation-conflict",
      "temporary-installation-removal",
    ]);
    expect(AFFECTED_ITEM_KINDS).toEqual(["host", "path", "installation-id"]);
  });

  test("the retired repository-exclusion-record kind is rejected, not aliased", () => {
    expect(() => normalizeBlocker({
      affectedItems: [{ kind: "installation-id", value: "install-1" }],
      kind: "repository-exclusion-record",
      problem: "Git exclusion evidence does not match",
      remedy: "Restore Installation State from a known-good backup, then retry",
      requirement: "Git exclusion contributions must match their receipts",
      scope: "global",
    } as never)).toThrow(/Unknown structured blocker kind "repository-exclusion-record"/);
  });

  test("temporary-installation blocked JSON publishes structured evidence at the family schema version", () => {
    const structured = normalizeBlocker(GLOBAL_BLOCKER_INPUT);

    const payload = JSON.parse(
      formatTemporaryInstallationBlockedJson("install-temp", [structured]),
    ) as Record<string, unknown>;
    expect(payload).toEqual({
      schemaVersion: 8,
      command: "install-temp",
      outcome: "blocked",
      blockers: [{
        kind: "installation-ownership",
        scope: "global",
        message: "Generated file ownership cannot be proven",
        problem: "Generated file ownership cannot be proven",
        requirement: "Ownership must be proven before writes",
        remedy: "Remove the conflicting generated files yourself, then retry",
        affectedItems: [{ kind: "host", value: "codex" }],
      }],
    });
  });

  test("TemporaryInstallationBlockedError derives projections from one canonical structured collection", () => {
    const structured = normalizeBlocker(GLOBAL_BLOCKER_INPUT);
    const removal = normalizeBlocker({
      affectedItems: [],
      kind: "temporary-installation-conflict",
      problem: "An installation already owns generated files",
      remedy: "Remove the existing installation, then retry",
      requirement: "A Project hosts at most one Profile Installation at a time",
      project: "/project-a",
      scope: "project",
    });

    // One canonical blocker-input collection; the message projection and
    // Error.message must both derive from it, so they cannot diverge.
    const error = new TemporaryInstallationBlockedError([structured, removal], "/project-a");
    expect(error.blockers).toEqual([
      "Generated file ownership cannot be proven",
      "An installation already owns generated files",
    ]);
    expect(error.structured).toEqual([structured, removal]);
    expect(error.message).toBe(
      "Generated file ownership cannot be proven\nAn installation already owns generated files",
    );
    expect(error.blockers.join("\n")).toBe(error.message);
  });
});

describe("tracked-output ownership conflicts", () => {
  test("real tracked-path conflicts aggregate into one typed project blocker", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-ownership-home-"));
    const project = mkdtempSync(join(tmpdir(), "agent-profile-kit-ownership-project-"));
    temporaryDirectories.push(home, project);
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(workspace, "context", "team-rules.md"),
      "---\nid: team-rules\ndependencies: []\n---\nOwnership conflict.\n",
    );
    writeFileSync(
      join(workspace, "profiles", "coding.yaml"),
      "id: coding\ncontext: [team-rules]\nskills: [s01, s02, s03]\n",
    );
    for (const skill of ["s01", "s02", "s03"]) {
      mkdirSync(join(workspace, "skills", skill), { recursive: true });
      writeFileSync(
        join(workspace, "skills", skill, "SKILL.md"),
        `---\nname: ${skill}\ndescription: Skill ${skill}.\n---\n\n# ${skill}\n`,
      );
    }
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: coding\n    hosts: [codex]\n`,
    );
    execFileSync("git", ["init", "-q", project]);
    execFileSync("git", ["-C", project, "config", "user.email", "tests@example.com"]);
    execFileSync("git", ["-C", project, "config", "user.name", "Agent Profile Kit Tests"]);
    mkdirSync(join(project, ".agent-profile-kit", "codex"), { recursive: true });
    mkdirSync(join(project, ".codex"));
    writeFileSync(
      join(project, ".agent-profile-kit", "codex", "context.md"),
      "tracked context\n",
    );
    writeFileSync(join(project, ".codex", "hooks.json"), "tracked hooks\n");
    for (const skill of ["s01", "s02", "s03"]) {
      mkdirSync(join(project, ".agents", "skills", skill), { recursive: true });
      writeFileSync(
        join(project, ".agents", "skills", skill, "SKILL.md"),
        `tracked ${skill}\n`,
      );
    }
    execFileSync("git", ["-C", project, "add", "."]);
    execFileSync("git", ["-C", project, "commit", "-qm", "track generated paths"]);

    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const emptyState = {
      receipts: [],
      removedTemporaryInstallationIds: [],
      schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
    } as const;
    const report = await previewReconciliation(desired.installations, emptyState);

    expect(reportBlockers(report)).toHaveLength(1);
    const blocker = reportBlockers(report)[0]!;
    expect(isStructuredBlocker(blocker)).toBe(true);
    expect(blocker).toMatchObject({
      kind: OUTPUT_OWNERSHIP_CONFLICT,
      project: desired.installations[0]!.binding.canonicalProject,
      scope: "project",
    });
    expect(blocker.affectedItems).toEqual([
      { kind: "path", value: ".agent-profile-kit/codex/context.md" },
      { kind: "path", value: ".agents/skills/s01" },
      { kind: "path", value: ".agents/skills/s02" },
      { kind: "path", value: ".agents/skills/s03" },
      { kind: "path", value: ".codex/hooks.json" },
    ]);
    expect(blocker.message).toBe(
      `${desired.installations[0]!.binding.canonicalProject}/.agent-profile-kit/codex/context.md ` +
      "and 4 more tracked project paths",
    );
    expect(lifecycleExitCode(report)).toBe(2);

    // String-only human consumers read the legacy message projection; machine
    // consumers read the structured records, including the grouped conflict
    // count in the message so a user fixing one conflict at a time still sees
    // how many remain.
    const conflicts = await desiredOutputConflicts(
      desired.installations[0]!,
      undefined,
      createLifecycleOwnershipInspectionContext(),
    );
    expect(conflicts).toHaveLength(1);
    expect(blockerMessage(conflicts[0]!)).toBe(
      `${desired.installations[0]!.binding.canonicalProject}/.agent-profile-kit/codex/context.md ` +
      "and 4 more tracked project paths",
    );
    const machineBlockers = JSON.parse(
      formatTemporaryInstallationBlockedJson(
        "install-temp",
        conflicts.map((input) => normalizeBlocker(input)),
      ),
    ).blockers as readonly Record<string, unknown>[];
    expect(machineBlockers).toEqual([{
      kind: OUTPUT_OWNERSHIP_CONFLICT,
      scope: "project",
      project: desired.installations[0]!.binding.canonicalProject,
      message:
        `${desired.installations[0]!.binding.canonicalProject}/.agent-profile-kit/codex/context.md ` +
        "and 4 more tracked project paths",
      problem: expect.stringContaining("tracked by Git"),
      requirement: expect.stringContaining("Generated files must be exclusively managed"),
      remedy: expect.stringContaining("keep repository ownership"),
      affectedItems: [
        { kind: "path", value: ".agent-profile-kit/codex/context.md" },
        { kind: "path", value: ".agents/skills/s01" },
        { kind: "path", value: ".agents/skills/s02" },
        { kind: "path", value: ".agents/skills/s03" },
        { kind: "path", value: ".codex/hooks.json" },
      ],
    }]);
  });
});
