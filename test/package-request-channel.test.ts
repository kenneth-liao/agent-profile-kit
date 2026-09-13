import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPackageRequestChannel,
  filedPackageRequests,
  filePackageRequest,
  publishPackageChannelResponse,
  removePackageChannel,
  requestInvocationPackage,
} from "./support/package-request-channel.js";

/**
 * Unit proofs for the invocation-private package request channel: atomic
 * terminal response publication, bounded consumer waits, immediate typed
 * failure delivery (a known preparation failure never spins until timeout),
 * exclusive request filing, and channel removal. The end-to-end lazy
 * preparation proofs live in test/invocation-preparation.test.ts.
 */

const temporaryDirectories: string[] = [];
function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("package request channel", () => {
  test("a published terminal success resolves the waiting consumer with the archive path", async () => {
    const channel = createPackageRequestChannel();
    const pending = requestInvocationPackage(channel.directory, 5_000, 10);
    filePackageRequest(channel.directory);
    publishPackageChannelResponse(channel.directory, {
      status: "prepared",
      archivePath: "/candidate/agent-profile-kit-0.188.0.tgz",
    });
    expect(await pending).toBe("/candidate/agent-profile-kit-0.188.0.tgz");
  });

  test("a published terminal failure resolves immediately into a typed error", async () => {
    const channel = createPackageRequestChannel();
    filePackageRequest(channel.directory);
    publishPackageChannelResponse(channel.directory, {
      status: "failed",
      failure: "fixture preparation failed",
    });
    const startedAt = Date.now();
    await expect(
      requestInvocationPackage(channel.directory, 30_000, 10),
    ).rejects.toThrow(/fixture preparation failed/);
    // The terminal failure was read at once, not polled until the deadline.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("a wait that outlives its deadline fails typed instead of hanging", async () => {
    const channel = createPackageRequestChannel();
    const startedAt = Date.now();
    await expect(
      requestInvocationPackage(channel.directory, 300, 25),
    ).rejects.toThrow(/coordinated wait budget \(300ms\)/);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("a response that is not parseable or complete is a typed failure, never a guess", async () => {
    const channel = createPackageRequestChannel();
    writeFileSync(join(channel.directory, "response.json"), '{"status":"prepared"}');
    await expect(requestInvocationPackage(channel.directory, 1_000, 10)).rejects.toThrow(
      /carries no archive path/,
    );
  });

  test("request files are exclusive and carry no user identity", async () => {
    const channel = createPackageRequestChannel();
    const first = filePackageRequest(channel.directory);
    const second = filePackageRequest(channel.directory);
    // The name carries the process id and a process-local counter only — no
    // user, host, path, or environment values leak into it.
    expect(first).toMatch(/^request-\d+-\d+$/);
    expect(second).toMatch(/^request-\d+-\d+$/);
    expect(second).not.toBe(first);
    expect(filedPackageRequests(channel.directory)).toEqual([first, second]);
  });

  test("channel removal ends every future wait typed, not silently", async () => {
    const channel = createPackageRequestChannel();
    const pending = requestInvocationPackage(channel.directory, 5_000, 10);
    removePackageChannel(channel.directory);
    await expect(pending).rejects.toThrow(/request channel directory is gone/);
  });

  test("the channel directory is private and dies with its owner", async () => {
    const channel = createPackageRequestChannel();
    expect(statSync(channel.directory).mode & 0o077).toBe(0);
    expect(existsSync(channel.directory)).toBe(true);
    removePackageChannel(channel.directory);
    expect(existsSync(channel.directory)).toBe(false);
  });

  test("a response file left over after channel removal cannot be read", async () => {
    const channel = createPackageRequestChannel();
    publishPackageChannelResponse(channel.directory, {
      status: "prepared",
      archivePath: "/candidate/a.tgz",
    });
    expect(readFileSync(join(channel.directory, "response.json"), "utf8")).toContain("prepared");
    // One channel holds one response: publishing twice overwrites atomically.
    publishPackageChannelResponse(channel.directory, {
      status: "failed",
      failure: "replaced",
    });
    await expect(requestInvocationPackage(channel.directory, 1_000, 10)).rejects.toThrow(
      /replaced/,
    );
  });
});
