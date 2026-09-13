import { afterAll, describe, expect, test } from "bun:test";

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
    const which = (tool: string) => execFileSync("which", [tool], { encoding: "utf8" }).trim();
    expect(controlledToolPath("git")).toBe(realpathSync(which("git")));
    const node = controlledToolPath("node");
    expect(node.startsWith("/")).toBe(true);
    expect(existsSync(node)).toBe(true);
  });
});

describe("the hostile ambient Host trap fixture", () => {
  test("trap executables record their invocation name and arguments", () => {
    const home = scratch();
    const traps = createHostTrapBin(home);
    spawnSync(join(traps.bin, "grok"), ["inspect", "--json"]);
    spawnSync(join(traps.bin, "agy"), ["--version"]);
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

  test("a fixture that appends the ambient PATH resolves an unselected Host probe into the trap", () => {
    const home = scratch();
    const traps = createHostTrapBin(home);
    const hostile = hostileAmbient({ trapBin: traps.bin, logPath: traps.logPath });
    try {
      spawnSync("/bin/sh", ["-c", "command -v opencode >/dev/null && opencode --version || true"], {
        env: { PATH: `/tmp/stub-first:${process.env.PATH ?? ""}`, HOME: home },
      });
      expect(hostile.trapLog().some((line) => line.startsWith("opencode"))).toBe(true);
    } finally {
      hostile.restore();
    }
  });

  test("a hermetic controlled PATH never reaches the traps", () => {
    const home = scratch();
    const traps = createHostTrapBin(home);
    const hostile = hostileAmbient({ trapBin: traps.bin, logPath: traps.logPath });
    try {
      spawnSync("/bin/sh", ["-c", "command -v opencode >/dev/null && opencode --version || true"], {
        env: { PATH: `${join(home, "bin")}:${join(home, "allow-bin")}`, HOME: home },
      });
      expect(hostile.trapLog()).toEqual([]);
    } finally {
      hostile.restore();
    }
  });
});