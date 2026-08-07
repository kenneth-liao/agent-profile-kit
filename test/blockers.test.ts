import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatLifecycleJson,
  formatLifecycleReport,
  formatTemporaryInstallationBlockedJson,
  lifecycleExitCode,
} from "../cli/presentation.js";
import {
  blockerMessage,
  isStructuredBlocker,
  normalizeBlocker,
  OUTPUT_OWNERSHIP_CONFLICT,
} from "../installer/blockers.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { desiredOutputConflicts, previewReconciliation } from "../installer/reconcile.js";
import { TemporaryInstallationBlockedError } from "../installer/temporary-installation.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function compileOnlyPartialBlocker(): void {
  // @ts-expect-error Structured blockers require every evidence field.
  normalizeBlocker({
    affectedItems: [],
    kind: "host-capability",
    message: "Codex CLI is unavailable",
    scope: "global",
  });
}

void compileOnlyPartialBlocker;

describe("shared blocker contract", () => {
  test("normalizes complete structured evidence into a scoped blocker", () => {
    const input = {
      affectedItems: [{ kind: "host", value: "codex" }],
      kind: "host-capability",
      message: "Codex CLI is unavailable",
      problem: "Codex CLI is unavailable",
      remedy: "Install a supported Codex CLI, then retry",
      requirement: "The selected Profile requires Codex project delivery",
      project: "/project-a",
      scope: "project",
    } as const;
    const blocker = normalizeBlocker(input);

    expect(isStructuredBlocker(blocker)).toBe(true);
    expect(blocker).toMatchObject({
      affectedItems: [{ kind: "host", value: "codex" }],
      kind: "host-capability",
      message: "Codex CLI is unavailable",
      problem: "Codex CLI is unavailable",
      remedy: "Install a supported Codex CLI, then retry",
      requirement: "The selected Profile requires Codex project delivery",
      project: "/project-a",
      scope: "project",
    });
    expect(() => normalizeBlocker({ ...input, project: "/project-b" }, "/project-a"))
      .toThrow(/fallback project.*kind="host-capability".*project="\/project-b"/);
  });

  test("keeps legacy message-only blockers unchanged at the boundary", () => {
    const blocker = normalizeBlocker("occupied output", "/project-a");
    expect(isStructuredBlocker(blocker)).toBe(false);
    expect(blocker).toEqual({
      message: "occupied output",
      project: "/project-a",
    });
  });

  test("rejects partially populated structured evidence at runtime", () => {
    expect(() => normalizeBlocker({
      kind: "host-capability",
      message: "Codex CLI is unavailable",
      scope: "global",
    } as never)).toThrow("Structured blocker problem must be a non-empty string");
    expect(() => normalizeBlocker({
      kind: "host-capability",
      message: "Codex CLI is unavailable",
      scope: "global",
    } as never)).toThrow(/kind=\"host-capability\"/);
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
      kind: "host-capability",
      message: "Codex CLI is unavailable",
      problem: "Codex CLI is unavailable",
      remedy: "Install a supported Codex CLI, then retry",
      requirement: "The selected Profile requires Codex project delivery",
      scope: "workspace",
    } as never)).toThrow("Structured blocker scope must be 'global' or 'project'");
  });

  test("rejects malformed legacy blocker objects at runtime", () => {
    expect(() => normalizeBlocker({ project: "/project-a" } as never))
      .toThrow("Legacy blocker message must be a string");
  });

  test("temporary-installation JSON keeps the legacy blocker schema", () => {
    const structured = normalizeBlocker({
      affectedItems: [{ kind: "host", value: "codex" }],
      kind: "host-capability",
      message: "Codex CLI is unavailable",
      problem: "Codex CLI is unavailable",
      remedy: "Install a supported Codex CLI, then retry",
      requirement: "The selected Profile requires Codex project delivery",
      scope: "global",
    });

    expect(formatTemporaryInstallationBlockedJson("install-temp", [blockerMessage(structured)])).toBe(
      formatTemporaryInstallationBlockedJson("install-temp", [structured.message]),
    );
    const structuredError = new TemporaryInstallationBlockedError([blockerMessage(structured)]);
    const legacyError = new TemporaryInstallationBlockedError([structured.message]);
    expect(structuredError.message).toBe(legacyError.message);
  });

  test("reconciliation normalizes structured evidence before public reports", async () => {
    const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-blocker-home-"));
    const project = mkdtempSync(join(tmpdir(), "agent-profile-kit-blocker-project-"));
    temporaryDirectories.push(home, project);
    await initializeWorkspace(home);
    const application = join(home, ".agents", "agent-profile-kit");
    const workspace = join(application, "workspace");
    writeFileSync(
      join(application, "config.yaml"),
      `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: example\n    hosts: [codex]\n`,
    );
    const desired = await buildDesiredState(home, { checkHostCapability: false });
    const installation = desired.installations[0];
    if (!installation) throw new Error("expected one desired installation");
    const canonicalProject = installation.binding.canonicalProject;
    const emptyState = {
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      temporaryInstallations: [],
      schemaVersion: 5,
    } as const;
    const report = await previewReconciliation(
      [{
        ...installation,
        blockers: [{
          affectedItems: [{ kind: "host", value: "codex" }],
          kind: "host-capability",
          message: "Codex CLI is unavailable",
          problem: "Codex CLI is unavailable",
          remedy: "Install a supported Codex CLI, then retry",
          requirement: "The selected Profile requires Codex project delivery",
          project: canonicalProject,
          scope: "project",
        }],
      }],
      emptyState,
    );

    expect(report.blockers[0]).toMatchObject({
      affectedItems: [{ kind: "host", value: "codex" }],
      kind: "host-capability",
      project: canonicalProject,
      scope: "project",
    });
    expect(formatLifecycleReport("preview", report)).toContain(
      "Blocker: Codex CLI is unavailable",
    );
    expect(JSON.parse(formatLifecycleJson("preview", report)).blockers).toEqual([{
      message: "Codex CLI is unavailable",
      project: canonicalProject,
    }]);

    const globalReport = await previewReconciliation(
      [{
        ...installation,
        blockers: [{
          affectedItems: [{ kind: "host", value: "codex" }],
          kind: "host-capability",
          message: "Codex CLI is unavailable",
          problem: "Codex CLI is unavailable",
          remedy: "Install a supported Codex CLI, then retry",
          requirement: "The selected Profile requires Codex project delivery",
          scope: "global",
        }],
      }],
      emptyState,
    );
    expect(globalReport.blockers[0]).toMatchObject({
      kind: "host-capability",
      scope: "global",
    });
    expect(globalReport.blockers[0]?.project).toBeUndefined();

    const mixedReport = await previewReconciliation(
      [{
        ...installation,
        blockers: [
          { message: "Codex CLI is unavailable", project: canonicalProject },
          {
            affectedItems: [{ kind: "host", value: "codex" }],
            kind: "host-capability",
            message: "Codex CLI is unavailable",
            problem: "Codex CLI is unavailable",
            remedy: "Install a supported Codex CLI, then retry",
            requirement: "The selected Profile requires Codex project delivery",
            project: canonicalProject,
            scope: "project",
          },
        ],
      }],
      emptyState,
    );
    expect(mixedReport.blockers).toHaveLength(1);
    expect(isStructuredBlocker(mixedReport.blockers[0])).toBe(true);

    const malformedReport = await previewReconciliation(
      [{
        ...installation,
        blockers: [{
          kind: "host-capability",
          message: "Codex CLI is unavailable",
          scope: "global",
        } as never],
      }],
      emptyState,
    );
    expect(malformedReport.blockers).toEqual([{
      message: expect.stringMatching(/Invalid blocker: .*kind=\"host-capability\"/),
      project: canonicalProject,
    }]);
    expect(lifecycleExitCode(malformedReport)).toBe(2);
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
      "id: coding\ncontext: [team-rules]\nskills: [s01, s02, s03]\nagents: []\nhooks: []\ntools: []\n",
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
      intendedTeardowns: [],
      installations: [],
      repositoryExclusions: [],
      schemaVersion: 5,
      temporaryInstallations: [],
    } as const;
    const report = await previewReconciliation(desired.installations, emptyState);

    expect(report.blockers).toHaveLength(1);
    const blocker = report.blockers[0]!;
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

    // String-only consumers (temporary-installation output, lifecycle JSON) read
    // the legacy message projection; the grouped conflict count must survive so
    // a user fixing one conflict at a time still sees how many remain.
    const conflicts = await desiredOutputConflicts(
      desired.installations[0]!,
      undefined,
      "temporary-installation-id",
    );
    const temporaryMessages = conflicts.map(blockerMessage);
    expect(temporaryMessages).toHaveLength(1);
    expect(temporaryMessages[0]).toBe(
      `${desired.installations[0]!.binding.canonicalProject}/.agent-profile-kit/codex/context.md ` +
      "and 4 more tracked project paths",
    );
    expect(
      JSON.parse(formatTemporaryInstallationBlockedJson("install-temp", temporaryMessages)).blockers,
    ).toEqual([{ message: temporaryMessages[0] }]);
  });
});
