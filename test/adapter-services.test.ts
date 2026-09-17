import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeExecutable, mapProcessResult, type ExecutableInvocationError } from "../adapters/services/executable.js";
import { executableOnPath } from "../adapters/services/executable-lookup.js";
import { MAX_OUTPUT_BYTES_PER_STREAM, type ProcessOutputLimitResult, type ProcessTimeoutResult } from "../process/process-executor.js";
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
  test("reports an executable present on PATH and absent otherwise", async () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-executable-lookup-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    expect(await executableOnPath("codex", { PATH: root })).toBe(true);
    expect(await executableOnPath("codex", { PATH: join(root, "missing") })).toBe(false);
  });

  test("accepts only executable regular files, following symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-executable-lookup-shape-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(bin, "agy"));
    writeFileSync(join(bin, "not-executable"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const real = join(root, "real-claude");
    writeFileSync(real, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    symlinkSync(real, join(bin, "claude"));

    // A directory named like the Host executable is not an installation.
    expect(await executableOnPath("agy", { PATH: bin })).toBe(false);
    // A non-executable file is not an installation.
    expect(await executableOnPath("not-executable", { PATH: bin })).toBe(false);
    // A symlink to an executable (Homebrew, npm, pip shims) is one.
    expect(await executableOnPath("claude", { PATH: bin })).toBe(true);
  });

  test("fails closed when the lookup budget is exhausted", async () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-executable-lookup-bound-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // An exhausted budget degrades the advisory lookup to not-found instead
    // of blocking the detecting command (PROD-2 on #611): a stalled PATH
    // entry can hold a stat indefinitely, so the search gives up bounded.
    expect(await executableOnPath("codex", { PATH: root }, { timeoutMs: 0 })).toBe(false);
  });

  test("skips empty PATH entries and never leaks the ambient PATH under an override", async () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-executable-lookup-empty-"));
    temporaryDirectories.push(root);
    // An executable file named like a Host sits in the working directory.
    writeFileSync(join(root, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    // POSIX empty entries mean the current directory; detection must not
    // depend on working-directory contents, so empty entries are skipped.
    expect(await executableOnPath("codex", { PATH: `:${join(root, "missing")}:` })).toBe(false);
    // An override environment is the whole search space: the ambient PATH
    // (where this repository's own `bun` and `node` live) cannot leak in.
    expect(await executableOnPath("bun", { PATH: join(root, "missing") })).toBe(false);
  });

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

  test("maps an unclean timeout without captured output, so it cannot become a detected Host", () => {
    // Direct mapping coverage: the executor reported timeout with
    // cleanupFailed and parseable captured output; the Adapter boundary must
    // surface the cleanup failure and expose no output fields to recover.
    const uncleanTimeout: ProcessTimeoutResult = {
      kind: "timeout",
      exitCode: null,
      signal: null,
      error: null,
      timedOut: true,
      cancelled: false,
      cleanupFailed: true,
        cleanupDurationMs: 0,
      stdout: "codex-cli 9.9.9",
      stderr: "partial error",
      durationMs: 10_000,
      commandLabel: "codex --version",
    };
    const rejection = mapProcessResult(uncleanTimeout, 10_000);
    expect(rejection).toBeInstanceOf(Error);
    const error = rejection as ExecutableInvocationError;
    expect(error.code).toBe("ETIMEDOUT");
    expect(error.cleanupFailed).toBe(true);
    expect(error.message).toContain("cleanup failed");
    expect("stdout" in error).toBe(false);
    expect("stderr" in error).toBe(false);

    // A clean timeout keeps its captured output for the existing recovery.
    const cleanTimeout: ProcessTimeoutResult = { ...uncleanTimeout, cleanupFailed: false };
    const cleanRejection = mapProcessResult(cleanTimeout, 10_000) as ExecutableInvocationError;
    expect(cleanRejection.cleanupFailed).toBe(false);
    expect(cleanRejection.stdout).toBe("codex-cli 9.9.9");
    expect(cleanRejection.stderr).toBe("partial error");
  });

  test("maps an output-limit termination to a budget error with the captured prefix", () => {
    const overflow: ProcessOutputLimitResult = {
      kind: "output-limit",
      exitCode: null,
      signal: null,
      error: null,
      timedOut: false,
      cancelled: false,
      cleanupFailed: false,
        cleanupDurationMs: 0,
      stdout: "x".repeat(MAX_OUTPUT_BYTES_PER_STREAM),
      stderr: "",
      durationMs: 120,
      commandLabel: "codex --version",
    };
    const rejection = mapProcessResult(overflow, 10_000) as ExecutableInvocationError;
    expect(rejection.code).toBe("ENOBUFS");
    expect(rejection.cleanupFailed).toBe(false);
    expect(rejection.stdout?.length).toBe(MAX_OUTPUT_BYTES_PER_STREAM);

    const unclean: ProcessOutputLimitResult = { ...overflow, cleanupFailed: true };
    const uncleanRejection = mapProcessResult(unclean, 10_000) as ExecutableInvocationError;
    expect(uncleanRejection.code).toBe("ENOBUFS");
    expect(uncleanRejection.cleanupFailed).toBe(true);
    expect("stdout" in uncleanRejection).toBe(false);
  });

  test("terminates a child that floods stdout or stderr past the per-stream budget", async () => {
    const flood = "head -c 2097152 /dev/zero | tr '\\0' 'x'; /bin/sleep 30";
    const stdoutRejection: ExecutableInvocationError = await invokeExecutable(
      "sh",
      ["-c", flood],
      { env: process.env, timeoutMs: 10_000 },
    ).then(
      () => {
        throw new Error("expected the stdout flood to be rejected");
      },
      (error) => error,
    );
    expect(stdoutRejection.code).toBe("ENOBUFS");
    expect(stdoutRejection.cleanupFailed).toBe(false);
    expect(stdoutRejection.stdout?.length).toBe(MAX_OUTPUT_BYTES_PER_STREAM);

    const stderrRejection: ExecutableInvocationError = await invokeExecutable(
      "sh",
      ["-c", "head -c 2097152 /dev/zero | tr '\\0' 'x' >&2; /bin/sleep 30"],
      { env: process.env, timeoutMs: 10_000 },
    ).then(
      () => {
        throw new Error("expected the stderr flood to be rejected");
      },
      (error) => error,
    );
    expect(stderrRejection.code).toBe("ENOBUFS");
    expect(stderrRejection.stdout).toBe("");
    expect(stderrRejection.stderr?.length).toBe(MAX_OUTPUT_BYTES_PER_STREAM);
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
