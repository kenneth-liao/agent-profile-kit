import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertClaudeProjectCapability } from "../adapters/claude.js";
import { assertCodexProjectCapability } from "../adapters/codex.js";
import { assertGrokProjectCapability } from "../adapters/grok.js";
import { assertPiProjectCapability } from "../adapters/pi.js";
import { isAdapterCapabilityError } from "../adapters/capability.js";
import {
  isStructuredBlocker,
  normalizeBlocker,
  type StructuredBlockerInput,
} from "../installer/blockers.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { buildDesiredState } from "../installer/project-plan.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { force: true, recursive: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeContextBinding(
  home: string,
  project: string,
  host: string | readonly string[],
): Promise<void> {
  await initializeWorkspace(home);
  const application = join(home, ".agents", "agent-profile-kit");
  const workspace = join(application, "workspace");
  writeFileSync(
    join(workspace, "context", "rules.md"),
    "---\nid: rules\ndependencies: []\n---\nContext rules.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "engineering.yaml"),
    "id: engineering\ncontext: [rules]\nskills: []\nagents: []\nhooks: []\ntools: []\n",
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [${(typeof host === "string" ? [host] : host).join(", ")}]\n`,
  );
}

describe("Host capability blockers", () => {
  test("preserves the Codex preflight message while carrying structured evidence", async () => {
    const home = temporaryDirectory("apkit-host-capability-home-");
    const project = temporaryDirectory("apkit-host-capability-project-");
    await writeContextBinding(home, project, "codex");

    const bin = temporaryDirectory("apkit-host-capability-bin-");
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.144.6'\n");
    chmodSync(join(bin, "codex"), 0o755);
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const desired = await buildDesiredState(home);
      const input = desired.installations[0]?.blockers[0];

      expect(input).toMatchObject({
        affectedItems: [{ kind: "host", value: "codex" }],
        kind: "host-capability",
        message: `${project}: Codex CLI 0.144.6 cannot deliver complete Context through SessionStart hooks (requires 0.145.0+); upgrade Codex before previewing or applying the Profile`,
        problem: "Codex CLI 0.144.6 cannot deliver complete Context through SessionStart hooks (requires 0.145.0+)",
        project: realpathSync(project),
        remedy: "upgrade Codex before previewing or applying the Profile",
        requirement: "The selected Profile requires Codex project delivery",
        scope: "project",
      });
      expect(isStructuredBlocker(normalizeBlocker(input as StructuredBlockerInput))).toBe(true);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("each Adapter capability boundary emits typed evidence and remains an Error", async () => {
    const project = temporaryDirectory("apkit-adapter-capability-project-");
    const attempts = [
      {
        host: "claude" as const,
        run: () => assertClaudeProjectCapability(project, {
          resolveVersion: async () => "2.0.63",
        }),
      },
      {
        host: "codex" as const,
        run: () => assertCodexProjectCapability("/tmp", project, {
          requireContext: true,
          resolveVersion: async () => "0.144.6",
        }),
      },
      {
        host: "grok" as const,
        run: () => assertGrokProjectCapability(project, {
          resolveVersion: async () => "0.1.0",
        }),
      },
      {
        host: "pi" as const,
        run: () => assertPiProjectCapability(project, {
          resolveVersion: async () => "0.82.0",
        }),
      },
    ];

    for (const attempt of attempts) {
      let error: unknown;
      try {
        await attempt.run();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(isAdapterCapabilityError(error)).toBe(true);
      if (!isAdapterCapabilityError(error)) continue;
      expect(error.host).toBe(attempt.host);
      expect(error.affectedItems).toEqual([{ kind: "host", value: attempt.host }]);
      expect(error.problem.length).toBeGreaterThan(0);
      expect(error.requirement).toContain("selected Profile requires");
      expect(error.remedy.length).toBeGreaterThan(0);
    }

    let malformedInspectError: unknown;
    try {
      await assertGrokProjectCapability(project, {
        inspect: async () => {
          throw new Error("Grok inspect --json output is malformed");
        },
        resolveVersion: async () => "0.2.111",
      });
    } catch (caught) {
      malformedInspectError = caught;
    }
    expect(isAdapterCapabilityError(malformedInspectError)).toBe(true);
    if (isAdapterCapabilityError(malformedInspectError)) {
      expect(malformedInspectError.message).toBe("Grok inspect --json output is malformed");
    }
  });

  test("path capability blockers preserve legacy messages while adding path evidence", async () => {
    const attempts = [
      {
        host: "claude" as const,
        path: ".claude",
        expected: "Claude project surface cannot host outputs",
        run: (project: string) => {
          writeFileSync(join(project, ".claude"), "not a directory\n");
          return assertClaudeProjectCapability(project, {
            resolveVersion: async () => "2.0.64",
          });
        },
      },
      {
        host: "grok" as const,
        path: ".grok",
        expected: "Grok project surface cannot host outputs",
        run: (project: string) => {
          writeFileSync(join(project, ".grok"), "not a directory\n");
          return assertGrokProjectCapability(project, {
            inspect: async () => ({ claudeRulesEnabled: true, version: "0.2.111" }),
            resolveVersion: async () => "0.2.111",
          });
        },
      },
      {
        host: "pi" as const,
        path: ".pi",
        expected: "Pi project surface cannot host outputs",
        run: (project: string) => {
          writeFileSync(join(project, ".pi"), "not a directory\n");
          return assertPiProjectCapability(project, {
            resolveVersion: async () => "0.82.1",
          });
        },
      },
    ];

    for (const attempt of attempts) {
      const project = temporaryDirectory(`apkit-${attempt.host}-path-capability-`);
      let error: unknown;
      try {
        await attempt.run(project);
      } catch (caught) {
        error = caught;
      }
      expect(isAdapterCapabilityError(error)).toBe(true);
      if (!isAdapterCapabilityError(error)) continue;
      expect(error.message).toBe(
        `${attempt.expected}: ${join(project, attempt.path)} is a file, not a directory`,
      );
      expect(error.affectedItems).toEqual([
        { kind: "host", value: attempt.host },
        { kind: "path", value: join(project, attempt.path) },
      ]);
    }
  });

  test("warning-adjacent Codex configuration remains non-blocking", async () => {
    const home = temporaryDirectory("apkit-host-warning-home-");
    const project = temporaryDirectory("apkit-host-warning-project-");
    await writeContextBinding(home, project, "codex");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = false\n");

    const bin = temporaryDirectory("apkit-host-warning-bin-");
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.145.0'\n");
    chmodSync(join(bin, "codex"), 0o755);
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      const desired = await buildDesiredState(home);
      const installation = desired.installations[0];
      expect(installation?.blockers).toEqual([]);
      expect(installation?.warnings).toHaveLength(1);
      expect(installation?.warnings[0]).toContain("SessionStart hooks are not enabled");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  test("status topology failures use the same project-scoped structured blocker", async () => {
    const home = temporaryDirectory("apkit-host-topology-home-");
    const project = temporaryDirectory("apkit-host-topology-project-");
    await writeContextBinding(home, project, ["claude", "grok"]);

    const emptyBin = temporaryDirectory("apkit-host-topology-bin-");
    const previousPath = process.env.PATH ?? "";
    process.env.PATH = emptyBin;
    try {
      const desired = await buildDesiredState(home, {
        checkHostCapability: false,
        resolveHostTopology: true,
      });
      const blocker = desired.installations[0]?.blockers.find(
        (candidate) => typeof candidate !== "string" && candidate.kind === "host-capability",
      );
      expect(blocker).toMatchObject({
        affectedItems: [{ kind: "host", value: "grok" }],
        kind: "host-capability",
        message: `${project}: Grok Claude rules compatibility could not be inspected and no applied Context delivery topology is available; restore \`grok inspect --json\` or re-apply before trusting status`,
        project: realpathSync(project),
        problem: "Grok Claude rules compatibility could not be inspected and no applied Context delivery topology is available",
        remedy: "restore `grok inspect --json` or re-apply before trusting status",
        requirement: "The selected Profile requires Grok project delivery",
        scope: "project",
      });
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
