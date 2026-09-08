import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeExecutable } from "../adapters/services/executable.js";
import { classifyFileSystemEntry } from "../adapters/services/project-surface.js";
import {
  compareCoreSemanticVersions,
  normalizeCoreSemanticVersion,
} from "../adapters/services/semantic-version.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("shared Adapter services", () => {
  test("normalizes and compares core semantic versions without Host policy", () => {
    expect(normalizeCoreSemanticVersion("01", "145", "0")).toBe("1.145.0");
    expect(compareCoreSemanticVersions("0.99.0", "0.145.0")).toBe(-1);
    expect(compareCoreSemanticVersions("2.0.64", "2.0.64")).toBe(0);
    expect(compareCoreSemanticVersions("3.0.0", "2.99.99")).toBe(1);
  });

  test("invokes executables and classifies filesystem entries without Host policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-adapter-services-"));
    temporaryDirectories.push(root);
    const directory = join(root, "directory");
    const file = join(root, "file");
    const link = join(root, "link");
    mkdirSync(directory);
    writeFileSync(file, "content\n");
    symlinkSync(file, link);

    expect(await classifyFileSystemEntry(join(root, "missing"))).toBe("missing");
    expect(await classifyFileSystemEntry(directory)).toBe("directory");
    expect(await classifyFileSystemEntry(file)).toBe("file");
    expect(await classifyFileSystemEntry(link)).toBe("symlink");

    const result = await invokeExecutable(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      { env: process.env, timeoutMs: 10_000 },
    );
    expect(result).toEqual({ stderr: "err", stdout: "out" });
  });

  test("rejects with captured output when the child ignores SIGTERM past the deadline, leaving no process behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-adapter-executable-"));
    temporaryDirectories.push(root);
    const pidFile = join(root, "stub.pid");

    let rejection: unknown;
    try {
      await invokeExecutable(
        "sh",
        ["-c", `echo $$ > '${pidFile}'; trap '' TERM; sleep 30`],
        { env: process.env, timeoutMs: 400, cleanupGraceMs: 100 },
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as { code?: unknown }).code).toBe("ETIMEDOUT");
    expect(String((rejection as { stdout?: unknown }).stdout ?? "")).toBe("");
    // The bounded executor must have force-killed the SIGTERM-resistant group
    // before the invocation settled: the recorded leader pid is gone.
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    // The SIGKILLed leader may linger as an unreaped zombie for a few
    // scheduling ticks after resolution; assert it is reaped within a short
    // bounded window rather than asserting the instant of resolution.
    let deadline = Date.now() + 2_000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(alive, "stub leader pid must be gone shortly after invokeExecutable rejects").toBe(false);
  });

  test("rejects with captured output on nonzero exit and on missing executables", async () => {
    const nonzero: { code?: unknown; stdout?: unknown; stderr?: unknown } = {};
    try {
      await invokeExecutable("sh", ["-c", "echo partial-out; echo partial-err >&2; exit 3"], {
        env: process.env,
        timeoutMs: 10_000,
      });
    } catch (error) {
      Object.assign(nonzero, error);
    }
    expect(nonzero.code).toBe(3);
    expect(nonzero.stdout).toBe("partial-out\n");
    expect(nonzero.stderr).toBe("partial-err\n");

    const missing: { code?: unknown; stdout?: unknown; stderr?: unknown } = {};
    try {
      await invokeExecutable("apkit-definitely-not-on-path-8f3c", ["--version"], {
        env: process.env,
        timeoutMs: 10_000,
      });
    } catch (error) {
      Object.assign(missing, error);
    }
    expect(missing.code).toBe("ENOENT");
    expect(missing.stdout).toBe("");
  });
});
