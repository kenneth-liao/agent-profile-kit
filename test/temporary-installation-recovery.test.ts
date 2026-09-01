import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installationLifecycleLockPath,
  withInstallationLifecycleLock,
} from "../installer/installation-lifecycle-lock.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { readInstallationState } from "../installer/installation-state.js";
import { nodeFileSystem } from "../installer/reconcile.js";
import {
  installTemporaryProfile,
  removeTemporaryProfile,
  TemporaryInstallationBlockedError,
  TemporaryInstallationRecoverableError,
} from "../installer/temporary-installation.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function statePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state", "manifest.json");
}

function gitRepository(prefix: string): string {
  const repository = temporaryDirectory(prefix);
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(repository, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "commit", "-qm", "fixture"]);
  return realpathSync(repository);
}

function linkedWorktree(primary: string, name: string): string {
  const path = temporaryDirectory(`agent-profile-kit-wt-${name}-`);
  rmSync(path, { recursive: true, force: true });
  execFileSync("git", ["-C", primary, "worktree", "add", "-q", "-b", name, path]);
  return realpathSync(path);
}

async function prepareHome(): Promise<string> {
  const home = temporaryDirectory("agent-profile-kit-temp-recovery-home-");
  await initializeWorkspace(home);
  const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
  rmSync(join(workspace, "profiles", "example.yaml"), { force: true });
  rmSync(join(workspace, "context", "example-context.md"), { force: true });
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspace, "skills", "review-pr"), { recursive: true });
  writeFileSync(
    join(workspace, "skills", "review-pr", "SKILL.md"),
    "---\nname: review-pr\ndescription: Review a pull request.\n---\n\nReview the change carefully.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills:\n  - review-pr\n",
  );
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho \"codex-cli 0.145.0\"\n");
  execFileSync("chmod", ["+x", join(bin, "codex")]);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return home;
}


async function prepareClaudeHome(): Promise<string> {
  const home = temporaryDirectory("agent-profile-kit-temp-claude-home-");
  await initializeWorkspace(home);
  const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
  rmSync(join(workspace, "profiles", "example.yaml"), { force: true });
  rmSync(join(workspace, "context", "example-context.md"), { force: true });
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspace, "skills", "review-pr"), { recursive: true });
  writeFileSync(
    join(workspace, "skills", "review-pr", "SKILL.md"),
    "---\nname: review-pr\ndescription: Review a pull request.\n---\n\nReview the change carefully.\n",
  );
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills:\n  - review-pr\n",
  );
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\necho \"2.1.0 (Claude Code)\"\n");
  execFileSync("chmod", ["+x", join(bin, "claude")]);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return home;
}

describe("Temporary Profile Installation recovery", () => {
  test("temporary capability failures project advisory warnings on the receipt", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-capability-warning-");
    writeFileSync(join(home, "bin", "codex"), "#!/bin/sh\necho \"codex-cli 0.144.6\"\n");

    const receipt = await installTemporaryProfile({
      home,
      host: "codex",
      profile: "coding",
      project,
    });
    expect(receipt.completionState).toBe("installed");
    expect(receipt.warnings).toEqual([
      "Codex CLI 0.144.6 cannot deliver complete Context through SessionStart hooks (requires 0.145.0+); upgrade Codex before checking status or applying the Profile",
    ]);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
  });

  test("removal discards modifications inside owned directories and preserves adjacent unowned files", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-dispose-");
    writeFileSync(join(project, "user-notes.md"), "keep me\n");

    const receipt = await installTemporaryProfile({
      home,
      host: "codex",
      profile: "coding",
      project,
    });

    const skillPath = join(project, ".agents", "skills", "review-pr", "SKILL.md");
    writeFileSync(skillPath, "agent edited this skill\n");
    writeFileSync(
      join(project, ".agents", "skills", "review-pr", "agent-extra.md"),
      "unexpected member\n",
    );
    writeFileSync(join(project, ".agent-profile-kit", "codex", "context.md"), "mutated context\n");

    const removed = await removeTemporaryProfile({
      home,
      temporaryInstallationId: receipt.temporaryInstallationId,
    });
    expect(removed.completionState).toBe("removed");
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(readFileSync(join(project, "user-notes.md"), "utf8")).toBe("keep me\n");
    expect(readFileSync(join(project, ".git", "info", "exclude"), "utf8")).not.toContain(
      "# BEGIN Agent Profile Kit generated paths",
    );

    const again = await removeTemporaryProfile({
      home,
      temporaryInstallationId: receipt.temporaryInstallationId,
    });
    expect(again.completionState).toBe("removed");
  });

  test("a byte-identical pre-existing output blocks install-temp before the durable record", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-adopt-");

    // A first install captures the exact published bytes, then cleans up.
    const first = await installTemporaryProfile({
      home,
      host: "codex",
      profile: "coding",
      project,
    });
    const skillBytes = readFileSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"), "utf8");
    await removeTemporaryProfile({ home, temporaryInstallationId: first.temporaryInstallationId });

    // Recreate one planned destination byte-identical to the desired output.
    mkdirSync(join(project, ".agents", "skills", "review-pr"), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"), skillBytes);
    const stateBefore = readFileSync(statePath(home), "utf8");

    // Temporary installs never adopt byte-identical occupied destinations:
    // the durable Receipt precedes publication, so adoption would hand the
    // recovery removal authority over bytes the install never published.
    let blocked: unknown;
    try {
      await installTemporaryProfile({ home, host: "codex", profile: "coding", project });
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(TemporaryInstallationBlockedError);
    expect(readFileSync(statePath(home), "utf8")).toBe(stateBefore);
    expect(readFileSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"), "utf8")).toBe(skillBytes);
  });

  test("a failure after the durable record claims no pre-existing bytes and remove-temp finishes recovery", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-durable-");
    writeFileSync(join(project, "adjacent-user-file.txt"), "user owns this\n");

    let recovered: unknown;
    try {
      await installTemporaryProfile({
        home,
        host: "codex",
        profile: "coding",
        project,
        hooks: {
          onAfterDurableRecord: async () => {
            throw new Error("injected crash after durable record");
          },
        },
      });
    } catch (error) {
      recovered = error;
    }
    expect(recovered).toBeInstanceOf(TemporaryInstallationRecoverableError);
    const identity = (recovered as TemporaryInstallationRecoverableError).temporaryInstallationId;

    // Every planned destination was proven absent at the preflight, so the
    // failure window claims only roots the install itself published. Recovery
    // removes those recorded roots and preserves adjacent unowned files.
    const removed = await removeTemporaryProfile({
      home,
      temporaryInstallationId: identity,
    });
    expect(removed.completionState).toBe("removed");
    expect(existsSync(join(project, "adjacent-user-file.txt"))).toBe(true);
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
  });

  test("failure after outputs are published returns a recoverable identity that remove-temp can finish", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-partial-");

    let failure: unknown;
    try {
      await installTemporaryProfile({
        home,
        host: "codex",
        profile: "coding",
        project,
        hooks: {
          onAfterOutputsPublished: async () => {
            throw new Error("injected state-publication failure after owned outputs");
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TemporaryInstallationRecoverableError);
    const recoverable = failure as TemporaryInstallationRecoverableError;
    expect(recoverable.removalRequired).toBe(true);
    expect(recoverable.temporaryInstallationId.length).toBeGreaterThan(0);
    expect(recoverable.message).toMatch(/requires removal/i);

    const state = await readInstallationState(home);
    const record = state.receipts.find(
      (installation) =>
        installation.installationId === recoverable.temporaryInstallationId,
    );
    expect(record?.lifetime).toBe("temporary");

    const removed = await removeTemporaryProfile({
      home,
      temporaryInstallationId: recoverable.temporaryInstallationId,
    });
    expect(removed.completionState).toBe("removed");
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
  });

  test("failure after exclusion commit returns recoverable identity", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-excl-fail-");

    await expect(
      installTemporaryProfile({
        home,
        host: "codex",
        profile: "coding",
        project,
        hooks: {
          onAfterExclusionCommit: async () => {
            throw new Error("injected repository exclusion boundary failure");
          },
        },
      }),
    ).rejects.toBeInstanceOf(TemporaryInstallationRecoverableError);
  });

  test("filesystem rename failure after durable record is recoverable", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-fs-fail-");
    let renames = 0;

    let failure: unknown;
    try {
      await installTemporaryProfile({
        home,
        host: "codex",
        profile: "coding",
        project,
        hooks: {
          fileSystem: {
            rename: async (from, to) => {
              renames += 1;
              // Fail on the first publication rename of a staged owned path.
              if (
                renames > 0 &&
                String(from).includes(".agent-profile-kit-stage-") &&
                String(to).includes(".agent-profile-kit")
              ) {
                throw new Error("injected filesystem publication failure");
              }
              return nodeFileSystem.rename(from, to);
            },
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TemporaryInstallationRecoverableError);
    const recoverable = failure as TemporaryInstallationRecoverableError;
    await removeTemporaryProfile({
      home,
      temporaryInstallationId: recoverable.temporaryInstallationId,
    });
  });

  test("interrupted remove before terminal state write is finished by retry without orphan stages", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-remove-interrupt-");
    const receipt = await installTemporaryProfile({
      home,
      host: "codex",
      profile: "coding",
      project,
    });

    await expect(
      removeTemporaryProfile({
        home,
        temporaryInstallationId: receipt.temporaryInstallationId,
        hooks: {
          onAfterRootDeletes: async () => {
            throw new Error("injected remove interruption after root deletes");
          },
        },
      }),
    ).rejects.toThrow(/injected remove interruption after root deletes/);

    // Owned outputs already cleaned; no process-private remove stage remains.
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
    const projectEntries = readdirSync(project);
    expect(projectEntries.some((name) => name.startsWith(".agent-profile-kit-remove-"))).toBe(false);
    const mid = await readInstallationState(home);
    expect(
      mid.receipts.find(
        (installation) =>
          installation.installationId === receipt.temporaryInstallationId,
      )?.lifetime,
    ).toBe("temporary");

    const removed = await removeTemporaryProfile({
      home,
      temporaryInstallationId: receipt.temporaryInstallationId,
    });
    expect(removed.completionState).toBe("removed");
    // Adjacent unrelated project content remains.
    expect(existsSync(join(project, "README.md"))).toBe(true);
  });

  test("linked worktrees hold independent temporary installations and contributor-safe exclusion removal", async () => {
    const home = await prepareHome();
    const primary = gitRepository("agent-profile-kit-temp-primary-");
    const first = linkedWorktree(primary, "candidate-a");
    const second = linkedWorktree(primary, "candidate-b");

    const receiptA = await installTemporaryProfile({
      home,
      host: "codex",
      profile: "coding",
      project: first,
    });
    const receiptB = await installTemporaryProfile({
      home,
      host: "codex",
      profile: "coding",
      project: second,
    });
    expect(receiptA.temporaryInstallationId).not.toBe(receiptB.temporaryInstallationId);

    const exclude = readFileSync(join(primary, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("# BEGIN Agent Profile Kit generated paths");

    await removeTemporaryProfile({
      home,
      temporaryInstallationId: receiptA.temporaryInstallationId,
    });
    expect(existsSync(join(second, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);

    const excludeAfter = readFileSync(join(primary, ".git", "info", "exclude"), "utf8");
    expect(excludeAfter).toContain("# BEGIN Agent Profile Kit generated paths");

    await removeTemporaryProfile({
      home,
      temporaryInstallationId: receiptB.temporaryInstallationId,
    });
    expect(readFileSync(join(primary, ".git", "info", "exclude"), "utf8")).not.toContain(
      "# BEGIN Agent Profile Kit generated paths",
    );
  });

  test("second active temporary installation for the same Project is rejected before writes", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-second-");
    await installTemporaryProfile({
      home,
      host: "codex",
      profile: "coding",
      project,
    });

    let failure: unknown;
    try {
      await installTemporaryProfile({
        home,
        host: "codex",
        profile: "coding",
        project,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TemporaryInstallationBlockedError);
    expect((failure as TemporaryInstallationBlockedError).blockers.join("\n")).toMatch(
      /active Temporary Profile Installation already owns generated files/i,
    );
  });

  test("lifecycle lock rejects concurrent install-temp while another operation holds the lock", async () => {
    const home = await prepareHome();
    const project = gitRepository("agent-profile-kit-temp-lock-");

    await withInstallationLifecycleLock(home, "apply", async () => {
      await expect(
        installTemporaryProfile({
          home,
          host: "codex",
          profile: "coding",
          project,
          hooks: { lockTimeoutMs: 80 },
        }),
      ).rejects.toThrow(/Installation lifecycle is busy/i);
    });
  });

  test("kernel exclusive lock serializes contenders so only one body enters at a time", async () => {
    const home = temporaryDirectory("agent-profile-kit-lifecycle-lock-home-");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });

    let active = 0;
    let maxActive = 0;
    const body = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
    };

    await Promise.all([
      withInstallationLifecycleLock(home, "apply", body, { lockTimeoutMs: 2_000 }),
      withInstallationLifecycleLock(home, "install-temp", body, { lockTimeoutMs: 2_000 }),
      withInstallationLifecycleLock(home, "remove-temp", body, { lockTimeoutMs: 2_000 }),
    ]);
    expect(maxActive).toBe(1);
  });

  test("lock handoff: a held exclusive open blocks successors until close, without pathname reclaim", async () => {
    const home = temporaryDirectory("agent-profile-kit-lifecycle-handoff-home-");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
    const lockPath = installationLifecycleLockPath(home);

    // Pre-create a leftover lock *file* (simulates prior dead process residue).
    // Kernel O_EXLOCK cares about open holders, not pathname body identity.
    writeFileSync(lockPath, "stale pathname residue\n");

    let holderEntered = false;
    let contenderSawBusy = false;
    let contenderEnteredAfterRelease = false;

    await withInstallationLifecycleLock(home, "apply", async () => {
      holderEntered = true;
      await expect(
        withInstallationLifecycleLock(home, "install-temp", async () => {
          contenderEnteredAfterRelease = true;
        }, { lockTimeoutMs: 80 }),
      ).rejects.toThrow(/Installation lifecycle is busy/i);
      contenderSawBusy = true;
    });

    await withInstallationLifecycleLock(home, "install-temp", async () => {
      contenderEnteredAfterRelease = true;
    }, { lockTimeoutMs: 500 });

    expect(holderEntered).toBe(true);
    expect(contenderSawBusy).toBe(true);
    expect(contenderEnteredAfterRelease).toBe(true);
  });

  test("injectable openExclusiveLock forces successor handoff races to remain serialized", async () => {
    const home = temporaryDirectory("agent-profile-kit-lifecycle-inject-home-");
    mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });

    // Simulate the old pathname race: between "inspect" and "takeover", ownership
    // changes. With openExclusiveLock as the only acquire primitive, a second open
    // while the first handle is live must fail busy — never enter concurrently.
    let held: { close: () => Promise<void> } | undefined;
    let opens = 0;
    const fileSystem = {
      openExclusiveLock: async () => {
        opens += 1;
        if (opens === 1) {
          held = {
            close: async () => {
              held = undefined;
            },
          };
          return held;
        }
        if (held) {
          const error = new Error("EAGAIN: resource temporarily unavailable") as Error & {
            code?: string;
          };
          error.code = "EAGAIN";
          throw error;
        }
        return {
          close: async () => undefined,
        };
      },
    };

    let active = 0;
    let maxActive = 0;
    const body = async (): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
    };

    await Promise.all([
      withInstallationLifecycleLock(home, "apply", body, {
        fileSystem,
        lockTimeoutMs: 1_000,
      }),
      withInstallationLifecycleLock(home, "install-temp", body, {
        fileSystem,
        lockTimeoutMs: 1_000,
      }),
    ]);
    expect(maxActive).toBe(1);
    expect(opens).toBeGreaterThanOrEqual(2);
  });
});

describe("Temporary Profile Installation Claude Host parity", () => {
  test("installs a Context-and-Skills Profile through the Claude Adapter plan and removes by receipt identity", async () => {
    const home = await prepareClaudeHome();
    const project = gitRepository("agent-profile-kit-temp-claude-");

    const receipt = await installTemporaryProfile({
      home,
      host: "claude",
      profile: "coding",
      project,
    });

    expect(receipt.host).toBe("claude");
    expect(receipt.profileId).toBe("coding");
    expect(receipt.completionState).toBe("installed");
    expect(receipt.adapterVersion).toContain("claude");
    expect(receipt.hostVersion).toMatch(/native-project-unscoped-rules-skills/);
    expect(receipt.outputs).toContain(".claude/rules/agent-profile-kit.md");
    expect(receipt.outputs).toContain(".claude/skills/review-pr");
    expect(receipt.outputs).not.toContain(".agent-profile-kit/installation.json");
    expect(receipt.repositoryExclusion?.entries).toEqual(
      expect.arrayContaining([
        "/.claude/rules/agent-profile-kit.md",
        "/.claude/skills/review-pr",
      ]),
    );
    expect(existsSync(join(project, ".claude", "rules", "agent-profile-kit.md"))).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"))).toBe(true);
    expect(readFileSync(join(project, ".claude", "skills", "review-pr", "SKILL.md"), "utf8"))
      .toContain("Review the change carefully.");
    expect(existsSync(join(project, ".agent-profile-kit", "codex"))).toBe(false);

    const removed = await removeTemporaryProfile({
      home,
      temporaryInstallationId: receipt.temporaryInstallationId,
    });
    expect(removed.completionState).toBe("removed");
    expect(removed.temporaryInstallationId).toBe(receipt.temporaryInstallationId);
    expect(removed.host).toBe("claude");
    expect(existsSync(join(project, ".claude", "rules", "agent-profile-kit.md"))).toBe(false);
    expect(existsSync(join(project, ".claude", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".agent-profile-kit", "installation.json"))).toBe(false);
    expect(readFileSync(join(project, ".git", "info", "exclude"), "utf8")).not.toContain(
      "# BEGIN Agent Profile Kit generated paths",
    );
  });
});
