import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
} from "../installer/blockers.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";
import { previewReconciliation } from "../installer/reconcile.js";
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
