import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One concern: the invocation-private request channel through which a
 * supervised child's package consumer obtains the invocation's prepared
 * candidate. The supervisor owns the channel directory and one watcher; a
 * consumer that actually executes writes one request file and waits, bounded,
 * for the supervisor's single atomically published terminal response — success
 * (the prepared archive path) or failure (the reason). A terminal response is
 * published for every waiting consumer, so a known preparation failure never
 * leaves a consumer polling until timeout. The protocol is file-based, typed
 * at this one boundary, carries no user identity, and owns no persistent
 * state: the directory dies with the invocation.
 */

export const PACKAGE_REQUEST_CHANNEL_ENV = "APKIT_TEST_PACKAGE_REQUEST_CHANNEL";
/** The child's coordinated request-wait deadline, delivered beside the channel. */
export const PACKAGE_REQUEST_WAIT_ENV = "APKIT_TEST_PACKAGE_REQUEST_WAIT_MS";

/** The single response file every waiting consumer polls; atomically replaced. */
const RESPONSE_FILENAME = "response.json";
const REQUESTS_PREFIX = "request-";
const DEFAULT_POLL_INTERVAL_MS = 50;
/** Exclusive-create mode for request files; no group or other access. */
const REQUEST_FILE_MODE = 0o600;

export interface PackageRequestChannel {
  readonly directory: string;
}

/**
 * Create one invocation-private request channel directory (mode 0700). The
 * supervisor owns its lifetime and removes it through bounded cleanup on
 * every exit path; nothing about it is user-facing.
 */
export function createPackageRequestChannel(): PackageRequestChannel {
  // mkdtemp is unique per call, so concurrent channels cannot collide, and is
  // private by default; the directory is hardened explicitly below.
  const directory = mkdtempSync(join(tmpdir(), "agent-profile-kit-package-channel-"));
  chmodSync(directory, 0o700);
  return { directory };
}

/**
 * The terminal response every waiting consumer reads: either the prepared
 * archive path or the preparation failure. Published exactly once, by rename,
 * so no consumer can observe a partially written response.
 */
export interface PackageChannelResponse {
  readonly status: "prepared" | "failed";
  readonly archivePath?: string;
  readonly failure?: string;
}

function responseFor(directory: string): PackageChannelResponse | null {
  const responsePath = join(directory, RESPONSE_FILENAME);
  if (!existsSync(responsePath)) return null;
  const parsed = JSON.parse(readFileSync(responsePath, "utf8")) as PackageChannelResponse;
  if (parsed.status !== "prepared" && parsed.status !== "failed") {
    throw new Error(`the package request channel response is malformed: ${RESPONSE_FILENAME}`);
  }
  if (parsed.status === "prepared" && typeof parsed.archivePath !== "string") {
    throw new Error(`the package request channel response carries no archive path: ${RESPONSE_FILENAME}`);
  }
  if (parsed.status === "failed" && typeof parsed.failure !== "string") {
    throw new Error(`the package request channel response carries no failure: ${RESPONSE_FILENAME}`);
  }
  return parsed;
}

/**
 * Publish the terminal response atomically: a temporary file is written in
 * full and renamed over the response name, so a consumer either sees no
 * response or a complete one. Called exactly once per channel (the
 * preparation is memoized); publishing after channel removal is impossible
 * because the watcher is closed and its preparation settled before removal.
 */
export function publishPackageChannelResponse(
  directory: string,
  response: PackageChannelResponse,
): void {
  const staged = join(directory, `.${RESPONSE_FILENAME}.publishing`);
  writeFileSync(staged, JSON.stringify(response) + "\n", { mode: 0o600 });
  renameSync(staged, join(directory, RESPONSE_FILENAME));
}

let requestCounter = 0;

/**
 * File one consumer's package request, atomically: `open` with the exclusive
 * flag fails if the exact name already exists, so no second writer can clobber
 * it. The name carries the process id and a process-local counter only — no
 * user, machine, or environment identity.
 */
export function filePackageRequest(channelDirectory: string): string {
  const name = `${REQUESTS_PREFIX}${process.pid}-${requestCounter++}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(channelDirectory, name), "wx", REQUEST_FILE_MODE);
  } catch (error) {
    throw new Error(
      `filing the package request '${name}' in '${channelDirectory}' failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return name;
}

/**
 * One consumer's bounded wait for the terminal response. Polls the channel
 * directory until the response is published (success or failure — a known
 * preparation failure resolves into a typed error immediately, never polling
 * until timeout), the deadline passes, or the channel itself disappears. The
 * supervisor supplies the runner budget to both this wait and its watchdog.
 * The owning runner deadline cancels preparation and bounds the entire wait.
 */
export async function requestInvocationPackage(
  channelDirectory: string,
  deadlineMs: number,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): Promise<string> {
  if (deadlineMs <= 0) {
    throw new Error(`the package request wait budget (${deadlineMs}ms) is exhausted before waiting`);
  }
  const requestName = filePackageRequest(channelDirectory);
  const startedAt = Date.now();
  for (;;) {
    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw new Error(
        `no terminal package response arrived within the coordinated wait budget (${deadlineMs}ms) after filing '${requestName}' in the invocation's request channel; preparation may have exceeded the per-test hook budget or the supervisor is gone`,
      );
    }
    if (!existsSync(channelDirectory)) {
      throw new Error(
        "the invocation's request channel directory is gone before a response was published; the supervisor did not own this wait",
      );
    }
    const response = responseFor(channelDirectory);
    if (response !== null) {
      if (response.status === "failed") {
        throw new Error(
          `the invocation's package preparation failed: ${response.failure ?? "unspecified"}`,
        );
      }
      return response.archivePath!;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
  }
}

/** List one channel's filed request names; a vanished directory yields none. */
export function filedPackageRequests(channelDirectory: string): readonly string[] {
  try {
    return readdirSync(channelDirectory)
      .filter((name) => name.startsWith(REQUESTS_PREFIX))
      .sort();
  } catch {
    return [];
  }
}

/** Remove one channel directory synchronously; callers own the bounded wrapper. */
export function removePackageChannel(channelDirectory: string): void {
  rmSync(channelDirectory, { recursive: true, force: true });
}