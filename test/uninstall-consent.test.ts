/**
 * Uninstall changed-output consent (ticket #496, spec #491 US-007/DEC-005,
 * TEST-004): deleting independently changed generated output needs explicit
 * `--remove-changed` authorization through the one shared consent loop.
 * Missing consent refuses the whole invocation before any lifecycle write —
 * including a second healthy pending Project. `--auto-confirm` answers the
 * general confirmation only, never deletion consent.
 */
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { runUninstallCommand } from "../cli/uninstall-command.js";
import { APPLY_REPLACEMENT_QUESTION } from "../cli/presentation.js";
import { executeInstall } from "../installer/install-application.js";
import { readInstallationState } from "../installer/installation-state.js";
import { ordinaryReceipts } from "../installer/ownership-state.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-consent-"));
  temporaryDirectories.push(home);
  return home;
}

function projectDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agent-profile-kit-uninstall-consent-project-"));
  temporaryDirectories.push(path);
  return path;
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function writeProfile(home: string, name: string): void {
  mkdirSync(join(workspacePath(home), "context"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  mkdirSync(join(workspacePath(home), "profiles"), { recursive: true });
  writeFileSync(
    join(workspacePath(home), "profiles", `${name}.yaml`),
    `id: ${name}\ncontext:\n  - team-rules\nskills: []\n`,
  );
}

async function setupHome(): Promise<string> {
  const home = isolatedHome();
  await initializeWorkspace(home);
  writeProfile(home, "engineering");
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  return home;
}

interface CapturedStreams {
  readonly output: PassThrough;
  readonly stderr: PassThrough;
  readonly humanText: () => string;
  readonly errorText: () => string;
}

function capturedStreams(): CapturedStreams {
  const chunks: Buffer[] = [];
  const errorChunks: Buffer[] = [];
  const output = new PassThrough();
  const stderr = new PassThrough();
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
  return {
    output,
    stderr,
    humanText: () => Buffer.concat(chunks).toString(),
    errorText: () => Buffer.concat(errorChunks).toString(),
  };
}

function plain(text: string): string {
  return text
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ");
}

function nonInteractiveInput(): PassThrough {
  return new PassThrough();
}

function fakeInteractiveInput(): PassThrough & { isTTY: true } {
  const stream = new PassThrough() as PassThrough & { isTTY: true };
  stream.isTTY = true;
  return stream;
}

async function waitForOutput(
  humanText: () => string,
  fragment: string,
  deadlineMs = 5000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!plain(humanText()).includes(fragment)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for output fragment: ${fragment}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function setupDriftedPair(): Promise<{
  readonly home: string;
  readonly drifted: string;
  readonly healthy: string;
  readonly driftedOutput: string;
}> {
  const home = await setupHome();
  const drifted = projectDirectory();
  const healthy = projectDirectory();
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: drifted });
  await executeInstall(home, { profile: "engineering", hosts: ["codex"], project: healthy });
  const state = await readInstallationState(home);
  const { realpathSync } = await import("node:fs");
  const receipt = ordinaryReceipts(state).find((entry) => entry.project === realpathSync(drifted));
  if (receipt === undefined || receipt.outputs.length === 0) {
    throw new Error("fixture install produced no output");
  }
  const driftedOutput = join(drifted, receipt.outputs[0]!.path);
  appendFileSync(driftedOutput, "\nIndependent user edit.\n");
  return { home, drifted, healthy, driftedOutput };
}

function expectUntouched(home: string, drifted: string, healthy: string, driftedOutput: string): void {
  const config = readFileSync(configPath(home), "utf8");
  expect(config).toContain(drifted);
  expect(config).toContain(healthy);
  expect(existsSync(driftedOutput)).toBe(true);
  expect(readFileSync(driftedOutput, "utf8")).toContain("Independent user edit.");
}

describe("uninstall changed-output consent", () => {
  test("non-interactive deletion of changed output without --remove-changed refuses before any write", async () => {
    const { home, drifted, healthy, driftedOutput } = await setupDriftedPair();
    const streams = capturedStreams();
    const outcome = await runUninstallCommand({
      home,
      arguments: ["--project", drifted, "--auto-confirm"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(outcome.exitCode).toBe(1);
    expect(plain(streams.errorText())).toContain("--remove-changed");
    // The healthy pending Project is untouched too.
    expectUntouched(home, drifted, healthy, driftedOutput);
  });

  test("--json consent refusal carries the unattempted scope without prose", async () => {
    const { home, drifted, healthy, driftedOutput } = await setupDriftedPair();
    const streams = capturedStreams();
    const outcome = await runUninstallCommand({
      home,
      arguments: ["--project", drifted, "--auto-confirm", "--json"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(outcome.exitCode).toBe(1);
    const payload = JSON.parse(streams.humanText()) as {
      schemaVersion: number;
      outcome: string;
      completed: unknown[];
      unattempted: { project: string }[];
    };
    expect(payload.schemaVersion).toBe(15);
    expect(payload.outcome).toBe("error");
    expect(payload.completed).toEqual([]);
    expect(payload.unattempted.map((entry) => entry.project)).toEqual([drifted]);
    expectUntouched(home, drifted, healthy, driftedOutput);
  });

  test("--remove-changed authorizes deletion of changed output", async () => {
    const { home, drifted, healthy, driftedOutput } = await setupDriftedPair();
    const streams = capturedStreams();
    const outcome = await runUninstallCommand({
      home,
      arguments: ["--project", drifted, "--auto-confirm", "--remove-changed"],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input: nonInteractiveInput(),
    });
    expect(outcome.exitCode).toBe(0);
    expect(existsSync(driftedOutput)).toBe(false);
    expect(readFileSync(configPath(home), "utf8")).not.toContain(drifted);
    expect(readFileSync(configPath(home), "utf8")).toContain(healthy);
  });

  test("interactive consent accepts deletion and echoes the runnable equivalent", async () => {
    const { home, drifted, healthy } = await setupDriftedPair();
    const streams = capturedStreams();
    const input = fakeInteractiveInput();
    const pending = runUninstallCommand({
      home,
      arguments: ["--project", drifted],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });
    await waitForOutput(streams.humanText, "Uninstall as listed?");
    input.write("y\n");
    await waitForOutput(streams.humanText, plain(APPLY_REPLACEMENT_QUESTION));
    input.write("y\n");
    const outcome = await pending;
    expect(outcome.exitCode).toBe(0);
    expect(plain(streams.humanText())).toContain("--remove-changed");
    expect(readFileSync(configPath(home), "utf8")).not.toContain(drifted);
    expect(readFileSync(configPath(home), "utf8")).toContain(healthy);
  });

  test("declining interactive consent leaves everything untouched", async () => {
    const { home, drifted, healthy, driftedOutput } = await setupDriftedPair();
    const streams = capturedStreams();
    const input = fakeInteractiveInput();
    const pending = runUninstallCommand({
      home,
      arguments: ["--project", drifted],
      stdout: streams.output as Writable & { isTTY?: boolean },
      stderr: streams.stderr as Writable & { isTTY?: boolean },
      input,
    });
    await waitForOutput(streams.humanText, "Uninstall as listed?");
    input.write("y\n");
    await waitForOutput(streams.humanText, plain(APPLY_REPLACEMENT_QUESTION));
    input.write("n\n");
    const outcome = await pending;
    expect(outcome.exitCode).toBe(1);
    expectUntouched(home, drifted, healthy, driftedOutput);
  });
});
