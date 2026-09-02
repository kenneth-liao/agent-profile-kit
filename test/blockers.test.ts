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
  isStructuredBlocker,
  normalizeBlocker,
  OUTPUT_OWNERSHIP_CONFLICT,
  type ReconciliationBlocker,
} from "../installer/blockers.js";
import {
  blockerWording,
  describeOwnershipFailure,
  describeTemporaryRemovalFailure,
  humanBlockerWording,
} from "../cli/blocker-wording.js";
import type {
  OwnershipFailureFact,
  TemporaryRemovalFailureFact,
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
  // @ts-expect-error An occupied-output blocker requires its typed occupied fact.
  normalizeBlocker({
    affectedItems: [],
    kind: "occupied-output",
    project: "/project-a",
    scope: "project",
  });
}

void compileOnlyPartialBlocker;

const OWNERSHIP_BLOCKER_INPUT = {
  action: "verify",
  affectedItems: [{ kind: "host", value: "codex" }],
  failure: { case: "unproven" },
  kind: "installation-ownership",
  project: "/project-a",
  scope: "project",
} as const;

const STATE_UNREADABLE_INPUT = {
  affectedItems: [{ kind: "path", value: "/home/state/manifest.json" }],
  detail: "EACCES: permission denied",
  kind: "installation-state-unreadable",
  scope: "global",
} as const;

describe("shared blocker contract", () => {
  test("normalizes complete structured evidence into a scoped blocker", () => {
    const blocker = normalizeBlocker(OWNERSHIP_BLOCKER_INPUT);

    expect(isStructuredBlocker(blocker)).toBe(true);
    // Blockers carry typed facts only; every sentence is presentation-owned.
    expect(blocker.kind).toBe("installation-ownership");
    expect(blocker.scope).toBe("project");
    expect(blocker.project).toBe("/project-a");
    expect(blocker.action).toBe("verify");
    expect(blocker.failure).toEqual({ case: "unproven" });
    expect(blocker.affectedItems).toEqual([{ kind: "host", value: "codex" }]);
    expect("problem" in blocker).toBe(false);
    expect("requirement" in blocker).toBe(false);
    expect("remedy" in blocker).toBe(false);
    expect("message" in blocker).toBe(false);
    expect(blockerWording(blocker)).toEqual({
      message: "Cannot verify generated-file ownership: ownership could not be proven",
      problem: "Cannot verify generated-file ownership: ownership could not be proven",
      remedy: "Remove the conflicting generated files yourself after verifying the paths, then retry",
      requirement:
        "Agent Profile Kit syncs or removes only files whose ownership is proven by the " +
        "active installation record at safe paths",
    });
    expect(() =>
      normalizeBlocker({ ...OWNERSHIP_BLOCKER_INPUT, project: "/project-b" }, "/project-a"),
    ).toThrow(/fallback project.*kind="installation-ownership".*project="\/project-b"/);
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
      action: "verify",
      affectedItems: [],
      kind: "installation-ownership",
      project: "/project-a",
      scope: "project",
    } as never)).toThrow("Structured blocker ownership failure must be an object");
    expect(() => normalizeBlocker({
      affectedItems: [],
      detail: "EACCES: permission denied",
      kind: "installation-state-unreadable",
      scope: "project",
    } as never)).toThrow(
      "Structured blocker kind installation-state-unreadable is always global-scoped",
    );
    expect(() => normalizeBlocker({
      affectedItems: [],
      scope: "global",
    } as never)).toThrow("Structured blocker kind must be a non-empty string");
  });

  test("prose fields are rejected: wording is presentation-owned, never carried", () => {
    for (const field of ["problem", "requirement", "remedy", "message"] as const) {
      expect(() => normalizeBlocker({
        ...OWNERSHIP_BLOCKER_INPUT,
        [field]: "a user-facing sentence",
      } as never)).toThrow(
        new RegExp(`Structured blockers carry typed facts only; "${field}" is presentation-owned wording`),
      );
    }
  });

  test("rejects an unknown structured blocker scope at runtime", () => {
    expect(() => normalizeBlocker({
      ...OWNERSHIP_BLOCKER_INPUT,
      scope: "workspace",
    } as never)).toThrow("Structured blocker scope must be 'global' or 'project'");
  });

  test("global blockers cannot carry a project and project blockers must", () => {
    expect(() => normalizeBlocker({
      ...STATE_UNREADABLE_INPUT,
      project: "/project-a",
    } as never)).toThrow("Global structured blockers cannot carry a project");
    expect(() => normalizeBlocker({
      ...STATE_UNREADABLE_INPUT,
      scope: "project",
    } as never)).toThrow(
      "Structured blocker kind installation-state-unreadable is always global-scoped",
    );
  });

  test("unknown blocker and affected-item kinds are rejected at runtime", () => {
    expect(() => normalizeBlocker({
      affectedItems: [],
      kind: "unknown-kind",
      scope: "global",
    } as never)).toThrow(/Unknown structured blocker kind "unknown-kind"/);

    expect(() => normalizeBlocker({
      affectedItems: [{ kind: "unknown-item", value: "codex" }],
      failure: { case: "unproven" },
      kind: "installation-ownership",
      project: "/project-a",
      scope: "project",
    } as never)).toThrow(/Unknown structured blocker affected-item kind "unknown-item"/);
  });

  test("blocker kinds form one exhaustive typed vocabulary", () => {
    expect(BLOCKER_KINDS).toEqual([
      "output-ownership-conflict",
      "installation-state-unreadable",
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
      scope: "global",
    } as never)).toThrow(/Unknown structured blocker kind "repository-exclusion-record"/);

    for (const removedKind of [
      "repository-exclusion-contribution",
      "repository-exclusion-target-unproven",
      "repository-exclusion-invalid",
    ]) {
      expect(() => normalizeBlocker({
        affectedItems: [],
        kind: removedKind,
        scope: "global",
      } as never)).toThrow(new RegExp(`Unknown structured blocker kind "${removedKind}"`));
    }
  });

  test("temporary-installation blocked JSON publishes structured evidence at the family schema version", () => {
    const structured = normalizeBlocker(OWNERSHIP_BLOCKER_INPUT);

    const payload = JSON.parse(
      formatTemporaryInstallationBlockedJson("install-temp", [structured]),
    ) as Record<string, unknown>;
    expect(payload).toEqual({
      schemaVersion: 9,
      command: "install-temp",
      outcome: "blocked",
      blockers: [{
        kind: "installation-ownership",
        scope: "project",
        project: "/project-a",
        message: "Cannot verify generated-file ownership: ownership could not be proven",
        problem: "Cannot verify generated-file ownership: ownership could not be proven",
        requirement:
          "Agent Profile Kit syncs or removes only files whose ownership is proven by the " +
          "active installation record at safe paths",
        remedy: "Remove the conflicting generated files yourself after verifying the paths, then retry",
        affectedItems: [{ kind: "host", value: "codex" }],
      }],
    });
  });

  test("every typed ownership-failure fact composes its carried sentence in presentation", () => {
    const facts: readonly OwnershipFailureFact[] = [
      {
        case: "git-tracked-output",
        outputs: [".codex/hooks.json", ".agents/skills/s01"],
      },
      { case: "no-ownership-continuity", output: ".agent-profile-kit/codex/context.md" },
      { case: "type-mismatch", expected: "directory", output: ".codex/hooks.json" },
      { case: "unsafe-parent", output: ".codex/hooks.json", parent: "/p/.codex" },
      { case: "unreadable-output", output: ".codex/hooks.json" },
      { case: "unproven" },
      { case: "unsupported-entry", member: "scripts/run.sh", output: ".agents/skills/demo-skill" },
    ];
    expect(facts.map((failure) => describeOwnershipFailure(failure))).toEqual([
      "owned output .codex/hooks.json, .agents/skills/s01 is tracked by Git; " +
        "Agent Profile Kit will not delete or untrack repository-owned material",
      "recorded output .agent-profile-kit/codex/context.md does not match the recorded " +
        "installation and no other recorded root proves ownership continuity; restore the " +
        "recorded output or remove the generated files, then retry",
      "owned output .codex/hooks.json is not a directory",
      "owned output .codex/hooks.json has unsafe parent: /p/.codex",
      "owned output .codex/hooks.json could not be inspected",
      "ownership could not be proven",
      "owned output .agents/skills/demo-skill contains an unsupported entry at scripts/run.sh",
    ]);

    const removalFacts: readonly TemporaryRemovalFailureFact[] = [
      { case: "git-tracked-output", outputs: [".codex/hooks.json"] },
      { case: "symlink-output", output: ".codex/hooks.json" },
      { case: "unsafe-parent", output: ".codex/hooks.json", parent: "/p/.codex" },
    ];
    expect(removalFacts.map((failure) => describeTemporaryRemovalFailure(failure))).toEqual([
      "owned output .codex/hooks.json is tracked by Git; " +
        "Agent Profile Kit will not delete or untrack repository-owned material",
      "owned output .codex/hooks.json is a symlink",
      "owned output .codex/hooks.json has unsafe parent: /p/.codex",
    ]);
  });

  test("malformed typed failure facts are rejected at the normalization boundary", () => {
    expect(() => normalizeBlocker({
      ...OWNERSHIP_BLOCKER_INPUT,
      failure: { case: "unknown-failure" },
    } as never)).toThrow(/Unknown structured blocker ownership failure case "unknown-failure"/);
    expect(() => normalizeBlocker({
      ...OWNERSHIP_BLOCKER_INPUT,
      failure: { case: "unsafe-parent", output: ".codex/hooks.json" },
    } as never)).toThrow(
      "Structured blocker ownership failure requires a non-empty parent",
    );
    expect(() => normalizeBlocker({
      ...OWNERSHIP_BLOCKER_INPUT,
      failure: { case: "git-tracked-output", outputs: [] },
    } as never)).toThrow(
      "Structured blocker ownership failure requires non-empty outputs",
    );
    expect(() => normalizeBlocker({
      affectedItems: [{ kind: "path", value: ".codex/hooks.json" }],
      failure: { case: "symlink-output", output: "" },
      kind: "temporary-installation-removal",
      project: "/p",
      scope: "project",
    } as never)).toThrow(
      "Structured blocker temporary-removal failure requires a non-empty output",
    );
  });

  test("TemporaryInstallationBlockedError carries one canonical structured collection", () => {
    const structured = normalizeBlocker(OWNERSHIP_BLOCKER_INPUT);
    const conflict = normalizeBlocker({
      affectedItems: [],
      kind: "temporary-installation-conflict",
      project: "/project-a",
      scope: "project",
    });

    // The error carries typed facts only; presentation owns every sentence.
    const error = new TemporaryInstallationBlockedError([structured, conflict], "/project-a");
    expect(error.structured).toEqual([structured, conflict]);
    expect(error.canonicalProject).toBe("/project-a");
    expect(error.message).toBe("temporary installation blocked: /project-a");
    expect(blockerWording(conflict).problem).toBe(
      "Generated files are already managed through a Project Binding; remove them " +
      "before installing a temporary Profile",
    );
    expect(humanBlockerWording(conflict).problem).toBe(
      "Generated files are already managed through a configured Project; remove them " +
      "before installing a temporary Profile",
    );
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
    expect(blockerWording(blocker).message).toBe(
      `${desired.installations[0]!.binding.canonicalProject}/.agent-profile-kit/codex/context.md ` +
      "and 4 more tracked project paths",
    );
    expect(lifecycleExitCode(report)).toBe(2);

    // The composed message derives from typed facts at the presentation
    // boundary, so both the direct projection and the machine JSON carry the
    // grouped conflict count.
    const conflicts = await desiredOutputConflicts(
      desired.installations[0]!,
      undefined,
      createLifecycleOwnershipInspectionContext(),
    );
    expect(conflicts).toHaveLength(1);
    expect(blockerWording(normalizeBlocker(conflicts[0]!)).message).toBe(
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
