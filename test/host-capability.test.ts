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

import { assertAntigravityProjectCapability } from "../adapters/antigravity.js";
import { assertClaudeProjectCapability } from "../adapters/claude.js";
import { assertCodexProjectCapability } from "../adapters/codex.js";
import { assertGrokProjectCapability, parseGrokInspectDocument } from "../adapters/grok.js";
import { assertOpenCodeProjectCapability } from "../adapters/opencode.js";
import { assertPiProjectCapability } from "../adapters/pi.js";
import {
  capabilityFailure,
  caughtCapabilityFailure,
  isAdapterCapabilityError,
  type AdapterCapabilityAffectedItem,
} from "../adapters/capability.js";
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
    "id: engineering\ncontext: [rules]\nskills: []\n",
  );
  writeFileSync(
    join(application, "config.yaml"),
    `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${project}\n    profile: engineering\n    hosts: [${(typeof host === "string" ? [host] : host).join(", ")}]\n`,
  );
}

function compileOnlyAdapterCapabilityEvidenceKinds(): void {
  // @ts-expect-error Adapter capability evidence stays host/path-only; Installer-only
  // affected-item kinds belong to the Installer boundary, not the Adapter contract.
  const item: AdapterCapabilityAffectedItem = { kind: "installation-id", value: "temp-1" };
  void item;
}

void compileOnlyAdapterCapabilityEvidenceKinds;

describe("Host capability probing", () => {
  test("outdated Codex probing becomes one advisory warning naming the Host and required version", async () => {
    const home = temporaryDirectory("apkit-host-capability-home-");
    const project = temporaryDirectory("apkit-host-capability-project-");
    await writeContextBinding(home, project, "codex");

    const bin = temporaryDirectory("apkit-host-capability-bin-");
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.144.6'\n");
    chmodSync(join(bin, "codex"), 0o755);
    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const installation = desired.installations[0];
    expect(installation?.capabilityWarnings).toEqual([
      {
        host: "codex",
        scope: "host",
        requiredVersion: "0.145.0",
        warning: {
          copyableValues: ["codex"],
          message: "Codex CLI 0.144.6 cannot deliver complete Context through SessionStart hooks (requires 0.145.0+); upgrade Codex before checking status or applying the Profile",
          parts: ["Codex CLI 0.144.6 cannot deliver complete Context through SessionStart hooks (requires 0.145.0+); upgrade Codex before checking status or applying the Profile"],
        },
      },
    ]);
    // Planning never gates on probing: the Host's material is still planned.
    expect(installation?.outputs.length).toBeGreaterThan(0);
  });

  test("registered Antigravity planning keeps project-surface evidence as advisory warning values", async () => {
    const home = temporaryDirectory("apkit-antigravity-surface-home-");
    const project = temporaryDirectory("apkit-antigravity-surface-project-");
    await writeContextBinding(home, project, "antigravity");
    writeFileSync(join(project, ".agents"), "not a directory\n");

    const bin = temporaryDirectory("apkit-antigravity-surface-bin-");
    writeFileSync(join(bin, "agy"), "#!/bin/sh\nprintf '%s\\n' '1.1.13'\n");
    chmodSync(join(bin, "agy"), 0o755);

    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(desired.installations[0]?.capabilityWarnings).toEqual([
      {
        host: "antigravity",
        scope: "project",
        warning: {
          copyableValues: [
            "antigravity",
            join(realpathSync(project), ".agents"),
          ],
          message: expect.stringContaining("Antigravity project surface cannot host Context"),
          parts: expect.any(Array),
        },
      },
    ]);
  });

  test("each Adapter capability boundary emits typed evidence and remains an Error", async () => {
    const project = temporaryDirectory("apkit-adapter-capability-project-");
    const attempts = [
      {
        host: "antigravity" as const,
        run: () => assertAntigravityProjectCapability(project, {
          resolveVersion: async () => "1.1.12",
        }),
      },
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
        host: "opencode" as const,
        run: () => assertOpenCodeProjectCapability(project, {
          resolveVersion: async () => "1.18.22",
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
      parseGrokInspectDocument("{not-json");
    } catch (caught) {
      malformedInspectError = caught;
    }
    expect(isAdapterCapabilityError(malformedInspectError)).toBe(true);
    if (isAdapterCapabilityError(malformedInspectError)) {
      expect(malformedInspectError.message).toBe(
        "Grok inspect --json output is not valid JSON; upgrade Grok Build or fix the CLI before checking status or applying the Profile",
      );
    }
  });

  test("path capability failures preserve legacy messages while adding path evidence", async () => {
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

  test("unexpected Adapter failures remain unclassified at the shared boundary", async () => {
    const project = temporaryDirectory("apkit-unclassified-capability-project-");
    const failures = [
      new Error("injected Antigravity capability probe failure"),
      new Error("injected Claude capability probe failure"),
      new Error("injected Codex capability probe failure"),
      new Error("injected Grok capability probe failure"),
      new Error("injected Pi capability probe failure"),
    ];
    const attempts = [
      {
        failure: failures[0]!,
        run: () =>
          assertAntigravityProjectCapability(project, {
            resolveVersion: async () => {
              throw failures[0];
            },
          }),
      },
      {
        failure: failures[1]!,
        run: () =>
          assertClaudeProjectCapability(project, {
            resolveVersion: async () => {
              throw failures[1];
            },
          }),
      },
      {
        failure: failures[2]!,
        run: () =>
          assertCodexProjectCapability("/tmp", project, {
            requireContext: true,
            resolveVersion: async () => {
              throw failures[2];
            },
          }),
      },
      {
        failure: failures[3]!,
        run: () =>
          assertGrokProjectCapability(project, {
            resolveVersion: async () => {
              throw failures[3];
            },
          }),
      },
      {
        failure: failures[4]!,
        run: () =>
          assertPiProjectCapability(project, {
            resolveVersion: async () => {
              throw failures[4];
            },
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
      expect(error).toBe(attempt.failure);
    }
  });

  test("caught capability failures normalize to typed evidence carrying their phase scope", () => {
    // A typed Adapter failure passes through with its authored scope and floor.
    const typed = capabilityFailure("codex", "project", "occupied", "retry", [
      { kind: "path", value: "/p" },
    ], "occupied; retry");
    expect(caughtCapabilityFailure("codex", "project", typed)).toBe(typed);

    // A foreign error from a phase becomes typed evidence with that phase's
    // scope and the original message, so no unknown failure is scoped downstream.
    const foreign = caughtCapabilityFailure("claude", "host", new Error("injected probe failure"));
    expect(isAdapterCapabilityError(foreign)).toBe(true);
    expect(foreign.scope).toBe("host");
    expect(foreign.message).toBe("injected probe failure");
    expect(foreign.problem.length).toBeGreaterThan(0);
    expect(foreign.requirement).toContain("selected Profile requires");
    expect(foreign.remedy.length).toBeGreaterThan(0);

    const foreignSurface = caughtCapabilityFailure("pi", "project", new Error("injected surface failure"));
    expect(foreignSurface.scope).toBe("project");
    expect(foreignSurface.message).toBe("injected surface failure");
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
    const desired = await buildDesiredState(home, {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const installation = desired.installations[0];
    expect(installation?.capabilityWarnings).toEqual([]);
    expect(installation?.warnings).toHaveLength(1);
    expect(installation?.warnings[0]?.message).toContain("SessionStart hooks are not enabled");
  });
});
