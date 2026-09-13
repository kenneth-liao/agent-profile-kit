import { afterAll, describe, expect, test } from "bun:test";

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  controlledEnvironment,
  controlledPath,
  controlledPtyPath,
  controlledToolPath,
  createHostTrapBin,
  hostileAmbient,
  TRAPPED_HOST_STUBS,
} from "./support/controlled-environment.js";
import {
  expectExitCode,
  runProcess,
  TEST_CHILD_DEADLINE_MS,
} from "../process/process-executor.js";

const temporaryDirectories: string[] = [];

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "agent-profile-kit-ctl-env-")));
  temporaryDirectories.push(path);
  return path;
}

describe("the controlled fixture environment overlay", () => {
  test("composes exactly HOME, the controlled PATH, the scoped TMPDIR, and explicit overrides", () => {
    const environment = controlledEnvironment({
      home: "/tmp/home",
      path: "/tmp/stubs:/tmp/allow",
      environment: { COLUMNS: "60", NO_COLOR: "1" },
    });
    expect(environment.HOME).toBe("/tmp/home");
    expect(environment.PATH).toBe("/tmp/stubs:/tmp/allow");
    expect(environment.COLUMNS).toBe("60");
    expect(environment.NO_COLOR).toBe("1");
    // The runner's ambient entries are never inherited beyond the overlay facts.
    expect(
      Object.keys(environment).filter(
        (key) => !["HOME", "PATH", "TMPDIR", "COLUMNS", "NO_COLOR"].includes(key),
      ),
    ).toEqual([]);
  });

  test("an explicit undefined override deletes the key instead of leaking a value", () => {
    const environment = controlledEnvironment({
      home: "/tmp/home",
      path: "/tmp/allow",
      environment: { NO_COLOR: undefined },
    });
    expect(Object.hasOwn(environment, "NO_COLOR")).toBe(false);
  });

  test("an explicit undefined override also deletes an inherited default such as TMPDIR", () => {
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = "/tmp/scoped-invocation";
      const environment = controlledEnvironment({
        home: "/tmp/home",
        path: "/tmp/allow",
        environment: { TMPDIR: undefined },
      });
      expect(Object.hasOwn(environment, "TMPDIR")).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  test("the invocation's scoped TMPDIR passes through and an explicit TMPDIR wins", () => {
    const saved = process.env.TMPDIR;
    try {
      process.env.TMPDIR = "/tmp/scoped-invocation";
      const inherited = controlledEnvironment({ home: "/tmp/home", path: "/tmp/allow" });
      expect(inherited.TMPDIR).toBe("/tmp/scoped-invocation");

      const overridden = controlledEnvironment({
        home: "/tmp/home",
        path: "/tmp/allow",
        environment: { TMPDIR: "/tmp/fixture-private" },
      });
      expect(overridden.TMPDIR).toBe("/tmp/fixture-private");
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
    }
  });

  test("the controlled PATH contains only the stub bins and the allowlist bin", () => {
    const home = scratch();
    const path = controlledPath(home, { stubBins: ["/tmp/stub-a", "/tmp/stub-b"] });
    const segments = path.split(":");
    expect(segments[0]).toBe("/tmp/stub-a");
    expect(segments[1]).toBe("/tmp/stub-b");
    expect(segments[2]).toBe(join(home, "allow-bin"));
    expect(segments).toHaveLength(3);
    for (const tool of ["git", "sleep", "cat"]) {
      expect(existsSync(join(segments[2]!, tool))).toBe(true);
    }
  });

  test("the PTY allowlist adds sh, stty, and script for PTY-driven seams", () => {
    const home = scratch();
    const allow = controlledPtyPath(home, { stubBins: ["/tmp/stub-a"] }).split(":").at(-1)!;
    for (const tool of ["git", "sleep", "cat", "sh", "stty", "script"]) {
      expect(existsSync(join(allow, tool))).toBe(true);
    }
  });

  test("tool resolution is absolute, real, and honors the canonical packed-CLI node reader", () => {
    const git = controlledToolPath("git");
    expect(git.startsWith("/")).toBe(true);
    expect(existsSync(git)).toBe(true);
    const node = controlledToolPath("node");
    expect(node.startsWith("/")).toBe(true);
    expect(existsSync(node)).toBe(true);
  });

  describe("NODE_BINARY selection is honored, not discarded (INT-fixture-1)", () => {
    /**
     * Resolve `controlledToolPath("node")` in an isolated fresh process with
     * the authored NODE_BINARY, so the module's once-per-process tool cache
     * can never leak across override cases and the observed runtime is the
     * one the child actually imports. Runs through the shared bounded
     * executor (ADR-0027).
     */
    async function resolveNodeInFreshProcess(
      nodeBinary: string,
    ): Promise<{ readonly resolved?: string; readonly error?: string }> {
      const environment = controlledEnvironment({ home: scratch(), path: "/nonexistent" });
      environment.PATH = process.env.PATH; // the child observes the runner's lookup semantics
      environment.NODE_BINARY = nodeBinary;
      const result = await runProcess({
        executable: process.execPath,
        arguments_: [
          "-e",
          `import { controlledToolPath } from ${JSON.stringify(join(import.meta.dir, "support", "controlled-environment.js"))};
           try {
             process.stdout.write(JSON.stringify({ resolved: controlledToolPath("node") }));
           } catch (error) {
             process.stdout.write(JSON.stringify({ error: String((error as Error).message) }));
           }`,
        ],
        environment,
        deadlineMs: TEST_CHILD_DEADLINE_MS,
        commandLabel: "controlled fixture fresh-process node resolution",
      });
      expectExitCode(result, 0);
      return JSON.parse(result.stdout) as { resolved?: string; error?: string };
    }

    test("an alternate valid basename resolves that selected executable, and it runs", async () => {
      // A symlink to the installed Node would not discriminate: the pinned
      // defect resolved the literal `node` realpath, identical under a
      // symlink. An independent copy has its own realpath. The copy source is
      // the canonical reader's own resolution, so no second runtime fact
      // exists.
      const canonical = await resolveNodeInFreshProcess("node");
      expect(canonical.resolved).toBeDefined();
      const home = scratch();
      const alternate = join(home, "apkit-review-alternate-node");
      cpSync(canonical.resolved!, alternate);
      const savedPath = process.env.PATH;
      process.env.PATH = `${home}:${savedPath ?? ""}`;
      try {
        const fresh = await resolveNodeInFreshProcess("apkit-review-alternate-node");
        expect(fresh.error).toBeUndefined();
        expect(fresh.resolved).toBe(realpathSync(alternate));
        // The recorded selection is the observed runtime: executed, the
        // resolved path reports a Node runtime identity.
        const observed = await runProcess({
          executable: fresh.resolved!,
          arguments_: ["-e", "process.stdout.write(`node:${process.versions.node}`)"],
          deadlineMs: TEST_CHILD_DEADLINE_MS,
          commandLabel: "controlled fixture alternate runtime observation",
        });
        expectExitCode(observed, 0);
        expect(observed.stdout).toMatch(/^node:\d+\./);
      } finally {
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
      }
    });

    test("a missing selected basename fails fast and never falls back to literal node", async () => {
      const fresh = await resolveNodeInFreshProcess("definitely-missing-node-review-probe");
      expect(fresh.error).toBeDefined();
      expect(fresh.error).toContain("definitely-missing-node-review-probe");
      expect(fresh.resolved).toBeUndefined();
    });
  });
});

describe("the hostile ambient Host trap fixture", () => {
  test("trap executables record their invocation name and arguments", async () => {
    const home = scratch();
    const traps = createHostTrapBin(home);
    // Trap children run through the shared bounded executor (ADR-0027/0028).
    for (const [name, arguments_] of [
      ["grok", ["inspect", "--json"]],
      ["agy", ["--version"]],
    ] as const) {
      const invocation = await runProcess({
        executable: join(traps.bin, name),
        arguments_: [...arguments_],
        environment: { PATH: traps.bin },
        deadlineMs: TEST_CHILD_DEADLINE_MS,
        commandLabel: `controlled fixture trap probe (${name})`,
      });
      expect(invocation.kind).toBe("exit");
      expect(invocation.exitCode).toBe(1);
    }
    const log = readFileSync(traps.logPath, "utf8").split("\n").filter((line) => line !== "");
    expect(log).toEqual(["grok inspect --json", "agy --version"]);
    expect(TRAPPED_HOST_STUBS).toContain("pi");
  });

  test("the hostile window owns its restoration exactly, including the PATH it found", () => {
    const home = scratch();
    const traps = createHostTrapBin(home);
    const savedPath = process.env.PATH;
    const hostile = hostileAmbient({ trapBin: traps.bin, logPath: traps.logPath });
    expect(process.env.PATH!.startsWith(`${traps.bin}:`)).toBe(true);
    hostile.restore();
    expect(process.env.PATH).toBe(savedPath);
  });

  test("varied values are applied and restored, including keys absent before the window", () => {
    const home = scratch();
    const traps = createHostTrapBin(home);
    const hostile = hostileAmbient({
      trapBin: traps.bin,
      logPath: traps.logPath,
      values: { APKIT_TEST_UNRELATED_PROOF: "varied" },
    });
    expect(process.env.APKIT_TEST_UNRELATED_PROOF).toBe("varied");
    hostile.restore();
    expect(Object.hasOwn(process.env, "APKIT_TEST_UNRELATED_PROOF")).toBe(false);
  });

  test("a fixture that appends the ambient PATH resolves an unselected Host probe into the trap", async () => {
    const home = scratch();
    const traps = createHostTrapBin(home);
    const hostile = hostileAmbient({ trapBin: traps.bin, logPath: traps.logPath });
    try {
      await runProcess({
        executable: "/bin/sh",
        arguments_: ["-c", "command -v opencode >/dev/null && opencode --version || true"],
        environment: { PATH: `/tmp/stub-first:${process.env.PATH ?? ""}`, HOME: home },
        deadlineMs: TEST_CHILD_DEADLINE_MS,
        commandLabel: "controlled fixture leak probe",
      });
      expect(hostile.trapLog().some((line) => line.startsWith("opencode"))).toBe(true);
    } finally {
      hostile.restore();
    }
  });

  test("a hermetic controlled PATH never reaches the traps", async () => {
    const home = scratch();
    const traps = createHostTrapBin(home);
    const hostile = hostileAmbient({ trapBin: traps.bin, logPath: traps.logPath });
    try {
      await runProcess({
        executable: "/bin/sh",
        arguments_: ["-c", "command -v opencode >/dev/null && opencode --version || true"],
        environment: { PATH: `${join(home, "bin")}:${join(home, "allow-bin")}`, HOME: home },
        deadlineMs: TEST_CHILD_DEADLINE_MS,
        commandLabel: "controlled fixture hermetic probe",
      });
      expect(hostile.trapLog()).toEqual([]);
    } finally {
      hostile.restore();
    }
  });
});